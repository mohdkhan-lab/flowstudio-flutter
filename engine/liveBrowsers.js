'use strict';

/**
 * FlowStudio Lite — live browser registry (v1.4; kinds + timestamps v1.4.1).
 *
 * Every Chrome the app launches on an account profile registers its main
 * PID here for as long as it is legitimately running, and unregisters
 * when it closes. Three kinds exist, because they deserve different
 * treatment when something else wants the profile:
 *   'login'      — the interactive Sign In window the user opens by
 *                  hand. Generation may close it (v1.4.1): it is the
 *                  app's own window, the session is saved in the
 *                  profile, and the user's standing order is that
 *                  generation must never wait on an open Chrome.
 *   'check'      — short Puppeteer passes (credit Sync, cookie import).
 *                  They finish in well under a minute; one still
 *                  registered after CHECK_WATCHDOG_MS is hung (its
 *                  browser.close() never settled) and is reclaimed.
 *   'generation' — a worker's Flow browser. Can legitimately run for
 *                  many minutes; never reclaimed while registered.
 *
 * The reclaim rule itself lives in processHelper.checkProfileBusyAsync:
 * a chrome.exe referencing an app profile path that is NOT registered
 * here can only be a leftover of this app (the user's personal Chrome
 * never opens the app's profiles directory), so it is terminated and
 * the caller proceeds. A registered process is protected according to
 * its kind, above.
 *
 * In-memory only: if the app restarts, the registry starts empty and
 * any survivor of the previous run is, by definition, a leftover.
 */

const CHECK_WATCHDOG_MS = 180000; // 3 minutes — a 'check' older than this is hung

const byAccount = new Map(); // accountId -> Map(pid -> { kind, since })

function register(accountId, pid, kind) {
  if (!accountId || !Number.isFinite(pid) || pid <= 0) return;
  let m = byAccount.get(accountId);
  if (!m) { m = new Map(); byAccount.set(accountId, m); }
  m.set(pid, { kind: kind || 'automation', since: Date.now() });
}

function unregister(accountId, pid) {
  const m = byAccount.get(accountId);
  if (!m) return;
  m.delete(pid);
  if (m.size === 0) byAccount.delete(accountId);
}

function getRegisteredPids(accountId) {
  const m = byAccount.get(accountId);
  return m ? new Set(m.keys()) : new Set();
}

/** Registered entries for an account: [{ pid, kind, since }]. */
function getEntries(accountId) {
  const m = byAccount.get(accountId);
  if (!m) return [];
  return [...m.entries()].map(([pid, v]) => ({ pid, kind: v.kind, since: v.since }));
}

function isRegistered(accountId, pid) {
  const m = byAccount.get(accountId);
  return !!(m && m.has(pid));
}

/** All registered login-window processes: [{ accountId, pid }]. */
function listLoginProcesses() {
  const out = [];
  for (const [accountId, m] of byAccount.entries()) {
    for (const [pid, v] of m.entries()) {
      if (v.kind === 'login') out.push({ accountId, pid });
    }
  }
  return out;
}

module.exports = {
  register,
  unregister,
  getRegisteredPids,
  getEntries,
  isRegistered,
  listLoginProcesses,
  CHECK_WATCHDOG_MS
};
