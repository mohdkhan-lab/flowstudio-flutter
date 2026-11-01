'use strict';

/**
 * v2.48.4: in-app Funnel keeper for the MCP remote route.
 *
 * The failure this fixes (seen live 2026-10-28 and again 2026-10-31 →
 * 2026-11-01): the app and its MCP server were perfectly healthy on
 * the owner's PC — the local/private route answered — but the public
 * Tailscale Funnel that carries Muse's authenticated calls had
 * silently dropped, so every remote call died with an empty reply.
 * Restarting the PC did NOT bring it back: the Funnel assertion from
 * the original manual setup was simply gone.
 *
 * While the app is open, this keeper re-checks the chain every few
 * minutes and repairs what it can, using the same commands the
 * v2.42.0 watchdog proved on the owner's PC:
 *   - Tailscale backend not Running → `tailscale up`
 *   - Funnel status has no entry for the MCP port →
 *     `tailscale funnel --bg http://localhost:<port>` (--bg stores
 *     the assertion in the Tailscale daemon, so it also survives
 *     later reboots — no window, no scheduled task, no autostart.)
 *
 * Scope, deliberately narrow (owner order 2026-10-29 stands): this
 * runs ONLY inside the engine, i.e. only while the owner has the app
 * open himself. It never starts the app, never registers a task, and
 * never touches the Run key. Windows-only; best-effort throughout —
 * a failure is logged once per state change and never breaks the
 * engine.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 8000;

function run(command, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: `${stdout || ''}\n${stderr || ''}` });
        }
      );
    } catch (e) {
      resolve({ code: 1, out: '' });
    }
  });
}

async function findTailscaleExe() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    path.join(programFiles, 'Tailscale', 'tailscale.exe'),
    path.join(programFilesX86, 'Tailscale', 'tailscale.exe'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (e) {}
  }
  const where = await run('where', ['tailscale.exe'], 8000);
  const first = where.out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first || null;
}

function createFunnelKeeper({ port, log } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  let timer = null;
  let interval = null;
  let checking = false;
  let lastState = 'unknown';
  let stopped = false;

  function setState(state, message, level = 'info') {
    if (state === lastState) return;
    lastState = state;
    if (message) {
      try { say(message, level); } catch (e) {}
    }
  }

  async function check() {
    if (checking || stopped || process.platform !== 'win32') return;
    checking = true;
    try {
      const exe = await findTailscaleExe();
      if (!exe) {
        setState('no-tailscale', '🌐 Remote route: Tailscale was not found on this PC, so the remote connection cannot be checked.', 'warning');
        return;
      }

      // 1. Backend must be Running.
      const status = await run(exe, ['status', '--json']);
      let backendRunning = false;
      try {
        const parsed = JSON.parse(status.out.slice(0, status.out.lastIndexOf('}') + 1));
        backendRunning = parsed && parsed.BackendState === 'Running';
      } catch (e) {
        backendRunning = false;
      }
      if (!backendRunning) {
        await run(exe, ['up'], 30000);
        setState('backend-restarted', '🌐 Remote route: the Tailscale connection was down — restarted it automatically.', 'warning');
        // Fall through and check the funnel in the same pass.
      }

      // 2. Funnel must assert the MCP port.
      const funnel = await run(exe, ['funnel', 'status']);
      if (funnel.out.includes(String(port))) {
        setState('ok', lastState === 'restored' || lastState === 'down'
          ? '🌐 Remote route is healthy again (Tailscale Funnel is serving the app).'
          : null);
        return;
      }
      const assert = await run(exe, ['funnel', '--bg', `http://localhost:${port}`], 30000);
      const verify = await run(exe, ['funnel', 'status']);
      if (verify.out.includes(String(port))) {
        setState('restored', '🌐 Remote route was down (Tailscale Funnel had dropped) — restored automatically. Muse can connect again.', 'success');
      } else {
        setState('down', `🌐 Remote route is still down: the Tailscale Funnel could not be restored automatically. (${(assert.out || '').trim().split(/\r?\n/)[0] || 'no detail'})`, 'warning');
      }
    } catch (e) {
      // The keeper must never break the engine; stay silent beyond a
      // console line and try again on the next cycle.
      console.warn('[FlowStudio FunnelKeeper]', e.message);
    } finally {
      checking = false;
    }
  }

  return {
    start() {
      if (process.platform !== 'win32' || timer || interval) return;
      timer = setTimeout(() => { check(); }, FIRST_CHECK_DELAY_MS);
      if (timer.unref) timer.unref();
      interval = setInterval(() => { check(); }, CHECK_INTERVAL_MS);
      if (interval.unref) interval.unref();
    },
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (interval) { clearInterval(interval); interval = null; }
    },
    getState() {
      return lastState;
    },
    // Exposed for tests.
    _check: check,
  };
}

module.exports = { createFunnelKeeper, findTailscaleExe };
