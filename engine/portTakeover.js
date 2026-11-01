'use strict';

/**
 * v2.48.4: stale-engine port takeover.
 *
 * The failure this fixes (seen live 2026-11-01): an OLD engine process
 * (v2.30.3, from a second copy of the app the owner still had on his
 * PC) was holding the bridge port 48190. The current app's health
 * check was answered by that stale engine, so the new app adopted it —
 * the window showed the new version badge while every answer (and the
 * Activity history) came from the old engine, and the MCP port's state
 * no longer matched the app on screen.
 *
 * The bridge now checks BEFORE it listens: if another engine answers
 * /api/status on the bridge port with a DIFFERENT version, the process
 * owning the port is stopped and this engine takes the port over. If
 * the answering engine is the SAME version, this process exits
 * quietly — a healthy copy is already serving and the app adopts it,
 * exactly as before.
 *
 * Windows-only process lookup (netstat + taskkill); on other
 * platforms the probe still runs and only the kill step is skipped.
 * Everything here is best-effort: any failure leaves the previous
 * behaviour (attempt to listen, log the error) intact.
 */

const http = require('http');
const { execFile } = require('child_process');

function probeStatus(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let req;
    try {
      req = http.get(
        { host: '127.0.0.1', port, path: '/api/status', timeout: timeoutMs },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              done(parsed && typeof parsed.version === 'string' ? parsed.version : null);
            } catch (e) {
              done(null);
            }
          });
          res.on('error', () => done(null));
        }
      );
    } catch (e) {
      return done(null);
    }
    req.on('timeout', () => {
      try { req.destroy(); } catch (e) {}
      done(null);
    });
    req.on('error', () => done(null));
  });
}

function runQuiet(command, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout) => resolve(error && !stdout ? '' : String(stdout || ''))
      );
    } catch (e) {
      resolve('');
    }
  });
}

/** PID of the process LISTENING on `port` (Windows netstat), or null. */
async function findPidOnPort(port) {
  if (process.platform !== 'win32') return null;
  const out = await runQuiet('netstat', ['-ano', '-p', 'tcp']);
  if (!out) return null;
  const needle = `:${port}`;
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    // TCP  127.0.0.1:48190  0.0.0.0:0  LISTENING  12345
    if (parts.length >= 5 && parts[0] === 'TCP' && parts[1].endsWith(needle) && parts[3] === 'LISTENING') {
      const pid = parseInt(parts[4], 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  }
  return null;
}

async function killPid(pid) {
  if (!pid || pid === process.pid) return false;
  if (process.platform === 'win32') {
    const out = await runQuiet('taskkill', ['/F', '/PID', String(pid)]);
    return out.toLowerCase().includes('success') || out.toLowerCase().includes(String(pid));
  }
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch (e) {
    return false;
  }
}

/** Kill whoever LISTENS on `port` (never this process). Returns true if a kill was issued. */
async function killPidOnPort(port, exceptPid) {
  const pid = await findPidOnPort(port);
  if (!pid || pid === exceptPid || pid === process.pid) return false;
  return killPid(pid);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decide who owns the bridge port before this engine listens.
 * Returns:
 *   'free'         — nobody answers; safe to listen.
 *   'same-version' — a healthy engine of THIS version already serves;
 *                    the caller should exit quietly and let the app
 *                    adopt the running engine.
 *   'took-over'    — a stale engine of another version was stopped;
 *                    `staleVersion` names it. Safe to listen.
 *   'blocked'      — something answers but could not be replaced;
 *                    the caller falls back to the old behaviour
 *                    (listen attempt, error logged).
 */
async function ensureBridgePort({ port, ownVersion, log } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  const answering = await probeStatus(port);
  if (!answering) return { outcome: 'free', staleVersion: null };
  if (answering === ownVersion) return { outcome: 'same-version', staleVersion: answering };

  say(`[FlowStudio Engine] Port ${port} is held by a stale engine v${answering} — replacing it with v${ownVersion}.`);
  const killed = await killPidOnPort(port, process.pid);
  if (killed) {
    for (let i = 0; i < 24; i++) {
      await sleep(250);
      if (!(await probeStatus(port, 600))) {
        return { outcome: 'took-over', staleVersion: answering };
      }
    }
  } else {
    // No PID could be found (non-Windows, or netstat shape changed):
    // give the other engine a moment — it may be mid-shutdown already.
    await sleep(1000);
    if (!(await probeStatus(port, 600))) {
      return { outcome: 'took-over', staleVersion: answering };
    }
  }
  return { outcome: 'blocked', staleVersion: answering };
}

module.exports = {
  probeStatus,
  findPidOnPort,
  killPid,
  killPidOnPort,
  ensureBridgePort,
};
