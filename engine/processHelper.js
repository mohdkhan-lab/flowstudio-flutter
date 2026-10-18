const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const liveBrowsers = require('./liveBrowsers');

/**
 * FlowStudio Lite — profile lock handling.
 *
 * AUDIT FIX #7 (updated v1.3): the V2 app ran a PowerShell taskkill over
 * every chrome.exe whose command line matched the profile path, which
 * could terminate the USER'S interactive Chrome session. That rule still
 * stands for interactive Chrome: a chrome.exe WITHOUT automation markers
 * is never touched, ever.
 *
 * v1.2.1: file presence alone proved to be a FALSE busy signal on Windows —
 * a leftover lock file can survive (or resist deletion) after every Chrome
 * window is closed, so Sync refused to run even though no browser held the
 * profile. checkProfileBusyAsync therefore cross-checks reality: when a
 * lock survives cleanup it asks the OS (win32: PowerShell CIM) whether a
 * live chrome.exe actually references this profile directory.
 *
 * v1.3: the owner kept hitting "Chrome is open for this profile" with NO
 * window visible. Two mechanisms produce that on Windows:
 *   (a) the app's OWN headless check Chrome (Puppeteer) can outlive the
 *       app — e.g. the app was closed or crashed mid-Sync — and keeps the
 *       profile's ProcessSingleton while staying invisible;
 *   (b) Chrome "background mode" keeps an interactive chrome.exe alive
 *       after its window closes (addressed separately: app profiles get
 *       background mode disabled — see profilePrefs.js).
 * v1.3's orphan cleanup only reclaimed automation-marked processes.
 *
 * v1.4 (DEEP AUDIT, 2026-10-11): the audit proved mechanism (b) is the
 * owner's actual blocker — the app's OWN Sign In window, spawned before
 * the background-mode fix existed, is still running invisibly in
 * background mode, holding the profile AND its Cookies DB. It carries
 * NO automation markers, so every defence treated it as the user's
 * untouchable Chrome, Sync's working-copy fallback died on the locked
 * Cookies file, and even Sign In was refused by the lock heuristic —
 * the corpse blocked its own cure. The v1.4 rule is therefore based on
 * OWNERSHIP, not markers: a chrome.exe whose command line references a
 * profile inside this app's profiles/ directory was launched by this
 * app (the user's personal Chrome never opens those paths). If such a
 * process is NOT in the live-launch registry (liveBrowsers.js), it is a
 * leftover of this app and checkProfileBusyAsync RECLAIMS the profile:
 * terminate it, clean the locks, proceed. A process that IS registered
 * is a browser the app is actively using — busy, with reason 'in-use'.
 * Nothing outside profiles/ is ever terminated.
 */

const LOCK_FILE_NAMES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
const PROCESS_CHECK_TIMEOUT_MS = 8000;
const KILL_TIMEOUT_MS = 4000;
const ORPHAN_SETTLE_MS = 300;
const RECLAIM_SETTLE_MS = 400;

// v1.4 (deep audit): profiles live ONLY under the app's own profiles/
// directory, and the ONLY Chrome instances that ever open those paths
// are launched by this app (Puppeteer checks/generation, cookie import,
// the interactive Sign In window). The user's personal Chrome uses the
// standard Chrome User Data directory and never references these paths.
// APP_PROFILES_ROOT is the boundary that makes reclaim safe.
const APP_PROFILES_ROOT = path.join(__dirname, '..', 'profiles');

// Flags that appear in the command line of the app's Puppeteer/utility
// Chrome launches (fetchRealCredits, cookie import, generation) and
// NEVER in an interactive Chrome the user opened by hand.
const AUTOMATION_MARKERS = ['--remote-debugging-pipe', '--remote-debugging-port', '--headless'];

function collectProfileDirs(profilePath) {
  const dirs = [profilePath, path.join(profilePath, 'Default')];
  try {
    if (fs.existsSync(profilePath)) {
      for (const sub of fs.readdirSync(profilePath)) {
        if (sub.startsWith('Profile')) {
          dirs.push(path.join(profilePath, sub));
        }
      }
    }
  } catch (e) {}
  return dirs;
}

/**
 * Best-effort removal of stale Chromium lock files.
 * Returns { removed: string[], remaining: string[] } — any lock file still
 * present in `remaining` means a live Chrome instance likely holds the
 * profile (or permissions prevent cleanup).
 */
function cleanStaleProfileLocks(profilePath) {
  const result = { removed: [], remaining: [] };
  if (!profilePath || typeof profilePath !== 'string') return result;

  for (const dir of collectProfileDirs(profilePath)) {
    if (!fs.existsSync(dir)) continue;
    for (const name of LOCK_FILE_NAMES) {
      const p = path.join(dir, name);
      let exists = false;
      try { exists = fs.existsSync(p) || !!fs.lstatSync(p); } catch (e) { exists = false; }
      if (!exists) continue;
      try {
        fs.unlinkSync(p);
        result.removed.push(p);
      } catch (err) {
        result.remaining.push(p);
      }
    }
  }
  return result;
}

/**
 * A profile is "busy" when its lock files survive a cleanup attempt, which
 * means a real Chrome instance is using it right now. Callers must skip the
 * account (report "profile busy") rather than fight the lock.
 *
 * Synchronous, lock-heuristic only — kept for the one caller that must
 * answer synchronously (the interactive Sign In spawn). Callers that can
 * await should use checkProfileBusyAsync, which self-heals stale locks,
 * clears the app's own orphaned automation processes, and confirms real
 * holders with the OS process list.
 */
function checkProfileBusy(profilePath) {
  const { remaining } = cleanStaleProfileLocks(profilePath);
  return { busy: remaining.length > 0, locks: remaining };
}

function normalizePathForMatch(p) {
  return String(p || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

/**
 * True when a command line references the profile directory as a COMPLETE
 * path token — the character after the path must be a quote, whitespace,
 * or end-of-string, so profile "acc_1" never matches a command line for
 * profile "acc_12". (Plain substring matching would be dangerous here:
 * the orphan cleanup below acts on what this matcher approves.)
 */
function commandLineReferencesProfile(commandLine, profilePath) {
  const line = normalizePathForMatch(commandLine);
  const target = normalizePathForMatch(profilePath);
  if (!line || !target) return false;
  let idx = line.indexOf(target);
  while (idx !== -1) {
    const after = line.charAt(idx + target.length);
    if (after === '' || after === '"' || after === "'" || after === ' ' || after === '\t') return true;
    idx = line.indexOf(target, idx + 1);
  }
  return false;
}

/**
 * Pure matcher (exported for tests): from a process list
 * [{ pid, commandLine }], return ONLY the processes that are the app's
 * own orphaned automation Chrome for THIS profile — the command line must
 * reference this exact profile AND carry at least one automation marker.
 * An interactive Chrome for the same profile (no markers) and automation
 * Chrome for OTHER profiles are never returned.
 */
function findOrphanAutomationProcesses(profilePath, processes) {
  if (!profilePath || !Array.isArray(processes)) return [];
  return processes.filter((proc) => {
    if (!proc || typeof proc.commandLine !== 'string') return false;
    if (!commandLineReferencesProfile(proc.commandLine, profilePath)) return false;
    const line = proc.commandLine.toLowerCase();
    return AUTOMATION_MARKERS.some((marker) => line.includes(marker));
  });
}

/**
 * List running chrome.exe processes with their command lines (win32 only).
 * Resolves an array of { pid, commandLine }, or null when NO query route
 * works (non-Windows, tools missing, error, timeout) — callers then fall
 * back to the lock heuristic instead of hanging. Read-only.
 *
 * v1.4: two routes — PowerShell CIM first (v1.2.1's only route proved
 * fragile as a single point of failure), WMIC as fallback.
 */
function listChromeProcessesViaPowerShell() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress'
        ],
        { timeout: PROCESS_CHECK_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err) { done(null); return; }
          try {
            const raw = String(stdout || '').trim();
            if (!raw) { done([]); return; }
            const parsed = JSON.parse(raw);
            const rows = Array.isArray(parsed) ? parsed : [parsed];
            done(rows
              .filter((r) => r && typeof r.CommandLine === 'string')
              .map((r) => ({ pid: Number(r.ProcessId), commandLine: r.CommandLine })));
          } catch (e) {
            done(null);
          }
        }
      );
    } catch (e) {
      done(null);
    }
  });
}

function listChromeProcessesViaWmic() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      execFile(
        'wmic.exe',
        ['process', 'where', "name='chrome.exe'", 'get', 'ProcessId,CommandLine', '/format:list'],
        { timeout: PROCESS_CHECK_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err) { done(null); return; }
          try {
            const text = String(stdout || '');
            const out = [];
            let current = {};
            for (const line of text.split(/\r?\n/)) {
              const t = line.trim();
              if (t.startsWith('CommandLine=')) current.commandLine = t.slice('CommandLine='.length);
              else if (t.startsWith('ProcessId=')) {
                current.pid = Number(t.slice('ProcessId='.length));
                if (typeof current.commandLine === 'string' && Number.isFinite(current.pid)) {
                  out.push({ pid: current.pid, commandLine: current.commandLine });
                }
                current = {};
              }
            }
            done(out);
          } catch (e) {
            done(null);
          }
        }
      );
    } catch (e) {
      done(null);
    }
  });
}

async function listChromeProcesses() {
  if (process.platform !== 'win32') return null;
  const viaPs = await listChromeProcessesViaPowerShell();
  if (viaPs !== null) return viaPs;
  return listChromeProcessesViaWmic();
}

/**
 * Pure partition (exported for tests) — v1.4 ownership rule.
 * From a process list [{ pid, commandLine }], split the processes that
 * reference THIS profile into:
 *   live    — pid is in the app's live-launch registry for the account:
 *             a browser the app is actively using right now. NEVER kill.
 *   reclaim — references the profile but is NOT registered: by
 *             construction a leftover of this app (see header). Safe —
 *             and necessary — to terminate so the profile frees up.
 * Processes not referencing the profile are ignored entirely.
 */
function partitionHolders(profilePath, processes, registeredPids) {
  const live = [];
  const reclaim = [];
  if (!profilePath || !Array.isArray(processes)) return { live, reclaim };
  const registered = registeredPids instanceof Set ? registeredPids : new Set(registeredPids || []);
  for (const proc of processes) {
    if (!proc || typeof proc.commandLine !== 'string') continue;
    if (!commandLineReferencesProfile(proc.commandLine, profilePath)) continue;
    if (registered.has(Number(proc.pid))) live.push(proc);
    else reclaim.push(proc);
  }
  return { live, reclaim };
}

/**
 * Pure classifier (exported for tests) — v1.4.1. Like partitionHolders,
 * but kind-aware: it decides, for each chrome.exe referencing THIS
 * profile, whether it is protected (live) or reclaimable, using the
 * registry entries [{ pid, kind, since }]:
 *   no entry                     -> reclaim (leftover of this app)
 *   kind 'login'/'check' + reclaimLogin -> reclaim (v1.5.1: generation
 *                                  outranks EVERY app-owned browser
 *                                  except another generation — it closes
 *                                  the app's own Sign In window AND any
 *                                  running credit check and carries on;
 *                                  the owner's standing order)
 *   kind 'check'/'automation' older than the watchdog -> reclaim (a
 *                                  short check that never finished is
 *                                  hung; its close never settled)
 *   anything else                -> live (protected: a check inside its
 *                                  budget for non-generation callers,
 *                                  or a generation in progress)
 * Returns { live: [{pid, kind}], reclaim: [{pid, kind}] }.
 */
function classifyHolders(profilePath, processes, entries, options = {}, now = Date.now()) {
  const live = [];
  const reclaim = [];
  if (!profilePath || !Array.isArray(processes)) return { live, reclaim };
  const byPid = new Map((entries || []).map((e) => [Number(e.pid), e]));
  for (const proc of processes) {
    if (!proc || typeof proc.commandLine !== 'string') continue;
    if (!commandLineReferencesProfile(proc.commandLine, profilePath)) continue;
    const pid = Number(proc.pid);
    const entry = byPid.get(pid);
    if (!entry) { reclaim.push({ pid, kind: null }); continue; }
    if ((entry.kind === 'login' || entry.kind === 'check') && options.reclaimLogin) { reclaim.push({ pid, kind: entry.kind }); continue; }
    if ((entry.kind === 'check' || entry.kind === 'automation')
      && now - (entry.since || 0) > liveBrowsers.CHECK_WATCHDOG_MS) {
      reclaim.push({ pid, kind: entry.kind });
      continue;
    }
    live.push({ pid, kind: entry.kind });
  }
  return { live, reclaim };
}

/** True when profilePath sits inside the app's own profiles/ root. */
function isAppProfilePath(profilePath) {
  if (!profilePath) return false;
  const root = normalizePathForMatch(APP_PROFILES_ROOT);
  const target = normalizePathForMatch(profilePath);
  return target === root || target.startsWith(root + '\\');
}

/**
 * Terminate processes by pid (win32: taskkill /F). Used EXCLUSIVELY for
 * processes approved by partitionHolders' reclaim rule (or the legacy
 * marker matcher) — the caller is responsible for that scoping.
 * Best-effort: resolves the pids that were actually terminated.
 */
function killProcessesByPid(pids) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !Array.isArray(pids) || pids.length === 0) {
      resolve([]);
      return;
    }
    const killed = [];
    let pending = pids.length;
    const stepDone = () => { pending--; if (pending === 0) resolve(killed); };
    for (const pid of pids) {
      if (!Number.isFinite(pid) || pid <= 0) { stepDone(); continue; }
      try {
        execFile(
          'taskkill.exe',
          ['/PID', String(pid), '/F'],
          { timeout: KILL_TIMEOUT_MS, windowsHide: true },
          (err) => {
            if (!err) killed.push(pid);
            stepDone();
          }
        );
      } catch (e) {
        stepDone();
      }
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cross-check whether a live chrome.exe process actually references this
 * profile directory (win32 only — the app's target platform; Chrome is
 * launched with --user-data-dir=<profilePath>, so a real holder's command
 * line contains the exact path).
 *
 * Resolves:
 *   true  — a chrome.exe command line references the profile path
 *   false — the query ran fine and NO chrome.exe references the profile
 *   null  — the check could not run (non-Windows, PowerShell missing,
 *           error, or timeout): callers fall back to the lock heuristic
 *           instead of hanging.
 */
async function findProfileProcessHolder(profilePath) {
  if (!profilePath) return null;
  const processes = await listChromeProcesses();
  if (processes === null) return null;
  return processes.some((proc) => commandLineReferencesProfile(proc.commandLine, profilePath));
}

/**
 * Async, reality-checked busy test (v1.2.1 origin; v1.4 ownership rule).
 * Steps:
 *  1. Stale-lock cleanup (unlink attempt). Nothing left -> NOT busy; the
 *     caller just proceeds — a leftover lock from a closed/crashed
 *     Chrome no longer forces another click.
 *  2. A lock survived -> ask the OS for the chrome.exe list and split
 *     the holders of THIS profile with partitionHolders:
 *       no holders at all      -> NOT busy (the lock file is stale even
 *                                 if the OS would not let us delete it;
 *                                 Chrome arbitrates the singleton when
 *                                 it launches).
 *       unregistered holders   -> RECLAIM (app profiles only): they are
 *                                 this app's own leftovers by construction
 *                                 (see the header) — most importantly the
 *                                 app's Sign In Chrome lingering invisibly
 *                                 in background mode. Terminate them,
 *                                 wait, clean locks, re-list once:
 *                                 cleared -> NOT busy, healedBy 'reclaim'
 *                                 (+ killedPids) so callers can log it;
 *                                 registered holders remaining -> busy,
 *                                 reason 'in-use'; kill failed -> busy,
 *                                 reason 'reclaim-failed' (+ holderPids).
 *       only registered holders -> busy, reason 'in-use' (a check or a
 *                                 generation is genuinely running on
 *                                 this account right now).
 *       process list unavailable -> busy via the lock heuristic, the
 *                                 pre-v1.2.1 behavior; read-only callers
 *                                 still have the working-copy fallback.
 * Bounded by design: at most 2 process queries + 1 kill pass per call.
 * Result shape: { busy, locks } plus diagnostics (healedBy, killedPids,
 * reason, holderPids, confirmedBy). Callers pass accountId so the live
 * registry can be consulted; without it, nothing counts as registered.
 */
async function checkProfileBusyAsync(profilePath, accountId, options = {}) {
  const first = cleanStaleProfileLocks(profilePath);
  if (first.remaining.length === 0) {
    return { busy: false, locks: [], healed: first.removed.length > 0, confirmedBy: 'lock-cleanup' };
  }

  const processes = await listChromeProcesses();
  if (processes === null) {
    return { busy: true, locks: first.remaining, confirmedBy: 'lock-heuristic' };
  }

  const entries = accountId ? liveBrowsers.getEntries(accountId) : [];
  const parts = classifyHolders(profilePath, processes, entries, options);

  if (parts.live.length === 0 && parts.reclaim.length === 0) {
    const retry = cleanStaleProfileLocks(profilePath);
    return {
      busy: false,
      locks: retry.remaining,
      healed: retry.removed.length > 0,
      staleLocksIgnored: retry.remaining.length > 0,
      confirmedBy: 'process-none'
    };
  }

  // RECLAIM: everything classifyHolders marked reclaimable is either a
  // leftover of this app or a holder the caller explicitly outranks
  // (generation vs the app's own Sign In window; a hung check past its
  // watchdog) — terminate exactly those and re-check once.
  if (parts.reclaim.length > 0 && isAppProfilePath(profilePath)) {
    const killed = await killProcessesByPid(parts.reclaim.map((p) => p.pid));
    if (killed.length > 0) {
      // v1.6.0: unregister the killed PIDs immediately. A login window's
      // close handler checks its registration to tell "the user closed
      // me" (run the auto-sync) apart from "a reclaim closed me" (the
      // reclaiming flow is doing its own work — stay out of its way).
      // Without this, a reclaimed login window's death would trigger an
      // auto-sync that murders the window/process that replaced it.
      if (accountId) {
        for (const pid of killed) {
          try { liveBrowsers.unregister(accountId, pid); } catch (e) {}
        }
      }
      await sleep(RECLAIM_SETTLE_MS);
      const afterKill = cleanStaleProfileLocks(profilePath);
      const processesAfter = await listChromeProcesses();
      if (processesAfter !== null) {
        const after = classifyHolders(profilePath, processesAfter, entries, options);
        if (after.live.length === 0 && after.reclaim.length === 0) {
          return {
            busy: false,
            locks: afterKill.remaining,
            healed: true,
            healedBy: 'reclaim',
            killedPids: killed,
            staleLocksIgnored: afterKill.remaining.length > 0,
            confirmedBy: 'process'
          };
        }
        if (after.live.length > 0) {
          return {
            busy: true,
            locks: afterKill.remaining,
            reason: 'in-use',
            holderPids: after.live.map((p) => p.pid),
            holderInfo: after.live,
            killedPids: killed,
            confirmedBy: 'process'
          };
        }
        return {
          busy: true,
          locks: afterKill.remaining,
          reason: 'reclaim-failed',
          holderPids: after.reclaim.map((p) => p.pid),
          holderInfo: after.reclaim,
          killedPids: killed,
          confirmedBy: 'process'
        };
      }
      // Re-list failed after a successful kill — locks are the only
      // evidence left; if they are gone, proceed.
      if (afterKill.remaining.length === 0) {
        return {
          busy: false,
          locks: [],
          healed: true,
          healedBy: 'reclaim',
          killedPids: killed,
          confirmedBy: 'process'
        };
      }
    }
    // The kill pass did not clear the way.
    if (parts.live.length > 0) {
      return {
        busy: true,
        locks: first.remaining,
        reason: 'in-use',
        holderPids: parts.live.map((p) => p.pid),
        holderInfo: parts.live,
        confirmedBy: 'process'
      };
    }
    return {
      busy: true,
      locks: first.remaining,
      reason: 'reclaim-failed',
      holderPids: parts.reclaim.map((p) => p.pid),
      holderInfo: parts.reclaim,
      confirmedBy: 'process'
    };
  }

  // Only protected live launches hold the profile (or reclaim is not
  // permitted for this path): genuinely busy right now.
  return {
    busy: true,
    locks: first.remaining,
    reason: parts.live.length > 0 ? 'in-use' : 'held',
    holderPids: (parts.live.length > 0 ? parts.live : parts.reclaim).map((p) => p.pid),
    holderInfo: parts.live.length > 0 ? parts.live : parts.reclaim,
    confirmedBy: 'process'
  };
}

module.exports = {
  cleanStaleProfileLocks,
  checkProfileBusy,
  checkProfileBusyAsync,
  findProfileProcessHolder,
  listChromeProcesses,
  killProcessesByPid,
  findOrphanAutomationProcesses,
  partitionHolders,
  classifyHolders,
  isAppProfilePath,
  commandLineReferencesProfile,
  AUTOMATION_MARKERS,
  LOCK_FILE_NAMES
};
