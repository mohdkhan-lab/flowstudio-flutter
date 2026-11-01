'use strict';

/**
 * v2.48.4: in-app Funnel keeper for the MCP remote route.
 * v2.48.5: the same chain logic now also backs the Settings →
 * CONNECTION card — GET /api/mcp/connection-status reads it and the
 * 1-Click Connect button runs repairChain() on demand.
 *
 * The failure this fixes (seen live 2026-10-28 and again 2026-10-31 →
 * 2026-11-01): the app and its MCP server were perfectly healthy on
 * the owner's PC — the local/private route answered — but the public
 * Tailscale Funnel that carries Muse's authenticated calls had
 * silently dropped, so every remote call died with an empty reply.
 * Restarting the PC did NOT bring it back: the Funnel assertion from
 * the original manual setup was simply gone.
 *
 * The chain repair uses the same commands the v2.42.0 watchdog proved
 * on the owner's PC:
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
const https = require('https');
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

function parseStatusJson(out) {
  try {
    const parsed = JSON.parse(out.slice(0, out.lastIndexOf('}') + 1));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (e) {}
  return null;
}

/**
 * Read-only view of the remote chain. Never changes anything.
 * Returns { supported, exeFound, backendRunning, funnelAsserted,
 * dnsName } — dnsName is this PC's Tailscale name (no trailing dot),
 * from which the public Funnel URL is built.
 */
async function inspectChain(port) {
  const chain = {
    supported: process.platform === 'win32',
    exeFound: false,
    backendRunning: false,
    funnelAsserted: false,
    dnsName: '',
  };
  if (!chain.supported) return chain;
  const exe = await findTailscaleExe();
  if (!exe) return chain;
  chain.exeFound = true;
  const status = await run(exe, ['status', '--json']);
  const parsed = parseStatusJson(status.out);
  if (parsed) {
    chain.backendRunning = parsed.BackendState === 'Running';
    const dns = parsed.Self && typeof parsed.Self.DNSName === 'string' ? parsed.Self.DNSName : '';
    chain.dnsName = dns.replace(/\.$/, '');
  }
  const funnel = await run(exe, ['funnel', 'status']);
  chain.funnelAsserted = funnel.out.includes(String(port));
  return chain;
}

/**
 * inspectChain + repair: `tailscale up` when the backend is down,
 * Funnel re-assert when the port is missing, then a fresh verify.
 * `actions` names what was actually done.
 */
async function repairChain(port) {
  const actions = [];
  let chain = await inspectChain(port);
  if (!chain.supported || !chain.exeFound) {
    return { ...chain, actions };
  }
  const exe = await findTailscaleExe();
  if (!chain.backendRunning) {
    await run(exe, ['up'], 30000);
    actions.push('tailscale-up');
  }
  if (!chain.funnelAsserted) {
    await run(exe, ['funnel', '--bg', `http://localhost:${port}`], 30000);
    actions.push('funnel-assert');
  }
  if (actions.length > 0) {
    chain = await inspectChain(port);
  }
  return { ...chain, actions };
}

/**
 * End-to-end proof: call this PC's own public Funnel URL with the
 * real MCP token, exactly like Muse's client does from outside.
 * Resolves { ok, detail } — ok only on an HTTP 200 JSON-RPC answer.
 */
function selfTestFunnelUrl(dnsName, token, port) {
  return new Promise((resolve) => {
    if (!dnsName) return resolve({ ok: false, detail: 'No Tailscale name found for this PC' });
    const host = String(dnsName).replace(/\.$/, '');
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'FlowStudio self-test', version: '1' } },
    });
    let req;
    try {
      req = https.request(
        {
          host,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${token}`,
          },
          timeout: 12000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let ok = res.statusCode === 200;
            if (ok) {
              try { ok = JSON.parse(text).result !== undefined; } catch (e) { ok = false; }
            }
            resolve({ ok, detail: ok ? `Public route answered (https://${host}/mcp)` : `Public route answered HTTP ${res.statusCode}` });
          });
          res.on('error', (e) => resolve({ ok: false, detail: `Public route error: ${e.message}` }));
        }
      );
    } catch (e) {
      return resolve({ ok: false, detail: `Public route error: ${e.message}` });
    }
    req.on('timeout', () => {
      try { req.destroy(); } catch (e) {}
      resolve({ ok: false, detail: 'Public route timed out' });
    });
    req.on('error', (e) => resolve({ ok: false, detail: `Public route error: ${e.message}` }));
    req.write(body);
    req.end();
    // `port` is accepted for symmetry with the chain helpers; the
    // Funnel URL itself is always the standard HTTPS endpoint.
    void port;
  });
}

function createFunnelKeeper({ port, log } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  let timer = null;
  let interval = null;
  let checking = false;
  let lastState = 'unknown';
  let stopped = false;
  let snapshot = null;
  let snapshotAt = 0;

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
      const before = await inspectChain(port);
      snapshot = before;
      snapshotAt = Date.now();
      if (!before.exeFound) {
        setState('no-tailscale', '🌐 Remote route: Tailscale was not found on this PC, so the remote connection cannot be checked.', 'warning');
        return;
      }
      if (before.backendRunning && before.funnelAsserted) {
        setState('ok', lastState === 'restored' || lastState === 'down' || lastState === 'backend-restarted'
          ? '🌐 Remote route is healthy again (Tailscale Funnel is serving the app).'
          : null);
        return;
      }
      const after = await repairChain(port);
      snapshot = { ...after };
      snapshotAt = Date.now();
      if (!after.backendRunning && after.actions.includes('tailscale-up')) {
        setState('backend-restarted', '🌐 Remote route: the Tailscale connection was down — restarted it automatically.', 'warning');
      }
      if (after.funnelAsserted) {
        setState('restored', '🌐 Remote route was down (Tailscale Funnel had dropped) — restored automatically. Muse can connect again.', 'success');
      } else {
        setState('down', '🌐 Remote route is still down: the Tailscale Funnel could not be restored automatically.', 'warning');
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
    /** Last inspected chain + when it was taken (ms epoch, 0 = never). */
    getSnapshot() {
      return { chain: snapshot, at: snapshotAt };
    },
    /** Fresh read-only inspection; updates the snapshot. */
    async refresh() {
      const chain = await inspectChain(port);
      snapshot = chain;
      snapshotAt = Date.now();
      return chain;
    },
    /** Full repair on demand (the 1-Click Connect button). */
    async repairNow() {
      const chain = await repairChain(port);
      snapshot = { ...chain };
      snapshotAt = Date.now();
      return chain;
    },
    // Exposed for tests.
    _check: check,
  };
}

module.exports = { createFunnelKeeper, findTailscaleExe, inspectChain, repairChain, selfTestFunnelUrl };
