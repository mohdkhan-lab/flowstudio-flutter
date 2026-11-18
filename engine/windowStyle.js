'use strict';

/**
 * FlowStudio Lite — Win32 window dressing for generation Chromes.
 *
 * Two jobs the CDP window-bounds calls cannot do:
 *
 * 1) TASKBAR BUTTON (owner's order, 2026-10-27): a parked
 *    (off-screen) generation window still gets a Windows taskbar
 *    button, and clicking that button restores the window to its
 *    off-screen park — it looks broken. The owner wants a
 *    generation browser to exist on his screen ONLY through the
 *    app's own Chrome Show/Hide button. The documented Win32 cure
 *    is the window's extended style: add WS_EX_TOOLWINDOW and
 *    remove WS_EX_APPWINDOW while parked (the shell then shows no
 *    taskbar button), and restore the normal APPWINDOW style when
 *    the app shows the window. Applied per Chrome process through
 *    PowerShell + user32 P/Invoke — the same execFile PowerShell
 *    route processHelper already uses for process queries.
 *
 * 2) WORK AREA: the primary display's work area (screen minus
 *    taskbar) for the pool's equal tiling of shown windows, read
 *    from System.Windows.Forms — the real size, never a guess.
 *
 * Everything here is best-effort and Windows-only: on any other
 * platform, or on any failure, the functions resolve false/null
 * and the caller carries on with the plain CDP behaviour. Nothing
 * in this module may ever break a launch, a run, or a Show/Hide.
 */

const { execFile } = require('child_process');

// Generous for a first-run Add-Type compile; still bounded so a
// wedged PowerShell can never stall a run.
const WINDOW_STYLE_TIMEOUT_MS = 15000;

const IS_WIN32 = process.platform === 'win32';

function runPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: timeoutMs || WINDOW_STYLE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) { done(null); return; }
          done(String(stdout || '').trim());
        }
      );
    } catch (e) {
      done(null);
    }
  });
}

// The C# shim: find the top-level Chrome window(s) of ONE browser
// process (class Chrome_WidgetWin_1 — the browser window class)
// and flip their taskbar style. The hide direction also does a
// hide/show cycle: the shell only re-evaluates a window's taskbar
// button after such a cycle, and for a parked (off-screen) window
// the cycle is invisible. The show direction relies on
// SWP_FRAMECHANGED plus the caller's own CDP bounds move, so a
// window the owner just asked to see never flickers.
const TASKBAR_CSHARP = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TaskbarWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static int Apply(uint targetPid, bool show) {
    int count = 0;
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid != targetPid) return true;
      StringBuilder sb = new StringBuilder(256);
      GetClassName(h, sb, 256);
      if (sb.ToString() != "Chrome_WidgetWin_1") return true;
      int style = GetWindowLong(h, -20);
      int next = show ? ((style & ~0x00000080) | 0x00040000)
                      : ((style | 0x00000080) & ~0x00040000);
      if (next != style) SetWindowLong(h, -20, next);
      if (!show) { ShowWindow(h, 0); ShowWindow(h, 5); }
      SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x0020 | 0x0001 | 0x0002 | 0x0004);
      count++;
      return true;
    }, IntPtr.Zero);
    return count;
  }
}
`;

/**
 * Show or hide the taskbar button of the Chrome window belonging
 * to [pid] (a generation browser's main process). Resolves true
 * when at least one window was adjusted. Never rejects.
 */
async function setTaskbarButton(pid, show) {
  if (!IS_WIN32) return false;
  const targetPid = Number(pid);
  if (!Number.isFinite(targetPid) || targetPid <= 0) return false;
  const script =
    `Add-Type -TypeDefinition @'\n${TASKBAR_CSHARP}'@ -Language CSharp; ` +
    `[TaskbarWin]::Apply(${targetPid}, ${show ? '$true' : '$false'})`;
  const out = await runPowerShell(script);
  const n = parseInt(out, 10);
  return Number.isFinite(n) && n > 0;
}

/**
 * The primary display's work area { left, top, width, height }
 * (the screen minus the taskbar), or null when it cannot be read.
 * Never rejects.
 */
async function getWorkArea() {
  if (!IS_WIN32) return null;
  const script =
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    '$a = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; ' +
    '"{0},{1},{2},{3}" -f $a.X, $a.Y, $a.Width, $a.Height';
  const out = await runPowerShell(script, 8000);
  if (!out) return null;
  const parts = out.split(',').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [left, top, width, height] = parts;
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

// ---------------------------------------------------------------------
// PUBLIC v1.0.6 — THE APP'S OWN WINDOW PHASES (owner's order): the
// app opens as a SMALL fixed panel, centered, while the splash /
// entry gate is up, and only takes its real studio size (1280x800,
// resizable) once the entry check passes and the main screen opens.
// Signing out returns it to the small panel. The runner creates
// the window small; this shim performs the phase switches
// afterwards, on the Flutter runner window of the app process (the
// bridge's parent pid). Sizes in the plan are LOGICAL pixels; the
// shim converts with the window's own DPI.
//
// PUBLIC v1.0.7 (C1 + C2): the gate panel is now 640x520 (a wide,
// low card, the competitor shape the owner re-sent). And the phase
// switch is BULLETPROOFED after the v1.0.6 field failure — the
// studio stayed squeezed inside the small window for a whole
// session. Two causes, both fixed here and in the bridge:
//   (1) the shim looked the window up by pid ONLY and its failure
//       was silent — an engine adopted from a previous app run
//       (its parent pid is dead) could never move the new app's
//       window. The shim now falls back to finding the one
//       FLUTTER_RUNNER window by class, whatever process owns it.
//   (2) nobody ever checked the result. Apply now READS THE
//       WINDOW BACK (rect + style) after moving it, and
//       setAppWindowPhase retries (up to 3 attempts) until the
//       read-back matches the plan, reporting { applied, verified }
//       so the bridge can log the truth and re-enforce the phase
//       on the next entry-status answer until it verifies.
// ---------------------------------------------------------------------
const APP_WINDOW_PHASES = {
  gate: { width: 640, height: 520, resizable: false },
  studio: { width: 1280, height: 800, resizable: true }
};

/* Pure: the phase plan, or null for an unknown phase. */
function appWindowPhasePlan(phase) {
  const plan = APP_WINDOW_PHASES[phase];
  if (!plan) return null;
  return { width: plan.width, height: plan.height, resizable: plan.resizable };
}

/* Pure: parse the shim's read-back line
   "<found>,<widthPx>,<heightPx>,<dpi>,<resizable01>". Anything
   unreadable parses as "not found". */
function parsePhaseReadback(out) {
  const empty = { found: false, width: 0, height: 0, dpi: 96, resizable: false };
  if (typeof out !== 'string') return empty;
  const parts = out.split(',').map((p) => parseInt(p, 10));
  if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) return empty;
  if (parts[0] !== 1) return empty;
  return {
    found: true,
    width: parts[1],
    height: parts[2],
    dpi: parts[3] > 0 ? parts[3] : 96,
    resizable: parts[4] === 1
  };
}

/* Pure: does a read-back prove the window is in [plan]? Sizes are
   compared in PHYSICAL pixels (the plan is logical; the window's
   own DPI converts) with a few pixels of tolerance for frame
   rounding; the resizable style must match exactly. */
function appWindowPhaseVerified(plan, readback) {
  if (!plan || !readback || !readback.found) return false;
  const scale = (readback.dpi || 96) / 96;
  const wantW = Math.round(plan.width * scale);
  const wantH = Math.round(plan.height * scale);
  return Math.abs(readback.width - wantW) <= 6 &&
    Math.abs(readback.height - wantH) <= 6 &&
    readback.resizable === plan.resizable;
}

const APP_PHASE_CSHARP = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AppPhaseWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, ref RECT rect, uint flags);
  static string ClassOf(IntPtr h) {
    StringBuilder sb = new StringBuilder(256);
    GetClassName(h, sb, 256);
    return sb.ToString();
  }
  /* The app's runner window: by owning pid first (the FLUTTER class
     preferred, any visible window of that pid as fallback); if the
     pid owns nothing — an adopted engine's dead parent — the one
     FLUTTER_RUNNER window on the desktop, whoever owns it. */
  public static IntPtr FindWindow(uint targetPid) {
    IntPtr found = IntPtr.Zero;
    IntPtr fallback = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid != targetPid) return true;
      if (ClassOf(h) == "FLUTTER_RUNNER_WIN32_WINDOW") { found = h; return false; }
      if (fallback == IntPtr.Zero && IsWindowVisible(h)) fallback = h;
      return true;
    }, IntPtr.Zero);
    if (found != IntPtr.Zero) return found;
    if (fallback != IntPtr.Zero) return fallback;
    IntPtr any = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (ClassOf(h) == "FLUTTER_RUNNER_WIN32_WINDOW") { any = h; return false; }
      return true;
    }, IntPtr.Zero);
    return any;
  }
  static string ReadBack(IntPtr hwnd) {
    RECT r;
    if (!GetWindowRect(hwnd, out r)) return "0,0,0,96,0";
    int style = GetWindowLong(hwnd, -16);
    int resizable = (style & 0x00040000) != 0 ? 1 : 0;
    uint dpi = 96;
    try { uint d = GetDpiForWindow(hwnd); if (d > 0) dpi = d; } catch {}
    return "1," + (r.Right - r.Left) + "," + (r.Bottom - r.Top) + "," + dpi + "," + resizable;
  }
  public static string Apply(uint targetPid, int logicalW, int logicalH, bool resizable) {
    IntPtr hwnd = FindWindow(targetPid);
    if (hwnd == IntPtr.Zero) return "0,0,0,96,0";
    if (IsZoomed(hwnd)) ShowWindow(hwnd, 9);
    int style = GetWindowLong(hwnd, -16);
    int next = resizable ? (style | 0x00040000 | 0x00010000)
                         : (style & ~0x00040000 & ~0x00010000);
    if (next != style) SetWindowLong(hwnd, -16, next);
    uint dpi = 96;
    try { uint d = GetDpiForWindow(hwnd); if (d > 0) dpi = d; } catch {}
    int cx = (int)Math.Round(logicalW * dpi / 96.0);
    int cy = (int)Math.Round(logicalH * dpi / 96.0);
    RECT wa = new RECT();
    int wx = 0, wy = 0;
    if (SystemParametersInfo(0x0030, 0, ref wa, 0)) {
      wx = wa.Left + Math.Max(0, ((wa.Right - wa.Left) - cx) / 2);
      wy = wa.Top + Math.Max(0, ((wa.Bottom - wa.Top) - cy) / 2);
    }
    SetWindowPos(hwnd, IntPtr.Zero, wx, wy, cx, cy, 0x0004 | 0x0020);
    return ReadBack(hwnd);
  }
}
`;

/**
 * Move the APP's own window into a phase: 'gate' (640x520 fixed,
 * centered) or 'studio' (1280x800 resizable, centered). v1.0.7:
 * each attempt APPLIES and then READS THE WINDOW BACK; the call
 * retries (up to 3 attempts) until the read-back matches the plan
 * and resolves a result object — { applied, verified, attempts,
 * width, height, dpi, resizable } (sizes = the last read-back, in
 * physical pixels). Never rejects; off Windows or on bad input
 * the result is { applied: false, verified: false, attempts: 0 }.
 * [opts.applyOnce] / [opts.sleep] exist for the test harness.
 */
async function setAppWindowPhase(pid, phase, opts) {
  const fail = { applied: false, verified: false, attempts: 0, width: 0, height: 0, dpi: 96, resizable: false };
  const plan = appWindowPhasePlan(phase);
  if (!plan) return fail;
  const options = opts || {};
  const applyOnce = typeof options.applyOnce === 'function'
    ? options.applyOnce
    : null;
  if (!applyOnce && !IS_WIN32) return fail;
  const targetPid = Number(pid);
  if (!applyOnce && (!Number.isFinite(targetPid) || targetPid <= 0)) return fail;
  const maxAttempts = Number.isInteger(options.attempts) && options.attempts > 0
    ? options.attempts
    : 3;
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((r) => setTimeout(r, ms));
  const runApply = applyOnce || (async () => {
    const script =
      `Add-Type -TypeDefinition @'\n${APP_PHASE_CSHARP}'@ -Language CSharp; ` +
      `[AppPhaseWin]::Apply(${targetPid}, ${plan.width}, ${plan.height}, ${plan.resizable ? '$true' : '$false'})`;
    return runPowerShell(script);
  });
  let last = fail;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const out = await runApply();
    const rb = parsePhaseReadback(out);
    last = {
      applied: rb.found,
      verified: appWindowPhaseVerified(plan, rb),
      attempts: attempt,
      width: rb.width,
      height: rb.height,
      dpi: rb.dpi,
      resizable: rb.resizable
    };
    if (last.verified) return last;
    if (attempt < maxAttempts) await sleep(350);
  }
  return last;
}

module.exports = {
  setTaskbarButton,
  getWorkArea,
  APP_WINDOW_PHASES,
  appWindowPhasePlan,
  parsePhaseReadback,
  appWindowPhaseVerified,
  setAppWindowPhase
};
