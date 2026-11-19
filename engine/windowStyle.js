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

module.exports = {
  setTaskbarButton,
  getWorkArea
};
