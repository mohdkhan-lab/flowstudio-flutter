'use strict';

// v2.48.83 (P2 — SMOKE ISOLATION): guard tests for
// test_js/run_project_smoke.js, written after the
// 2026-11-10 field incident in which a smoke run attached
// to a LIVE app bridge (the port was already held), rewrote
// the live app's download_folder to a fs-smoke temp dir
// and spent real accounts' credits.
//
// Phase 1: a dummy "live" bridge occupies 48190. The
//   smoke must REFUSE — exit code 2 with 'SMOKE REFUSED',
//   naming the foreign bridge's version — and must send
//   NO mutating request at all (no POST of any kind).
// Phase 2: with the port free, the real smoke must still
//   run hermetically against its own spawned child and
//   pass end to end.
// Usage: node test_js/run_smoke_guard_tests.js
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = 48190;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function runSmoke() {
  return new Promise((resolve) => {
    const child = spawn('node', ['test_js/run_project_smoke.js'], { cwd: REPO });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { } }, 90000);
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, out }); });
  });
}

async function main() {
  // ---------- Phase 1: a live bridge already holds the port ----------
  const seen = [];
  const sockets = new Set();
  const dummy = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '0.0.0-live', workers: 1 }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }
  });
  dummy.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve, reject) => {
    dummy.once('error', reject);
    dummy.listen(PORT, '127.0.0.1', resolve);
  });

  const refused = await runSmoke();
  check('guard: the smoke refuses when a bridge already serves the port',
    refused.code === 2, `exit=${refused.code}\n${refused.out.slice(-500)}`);
  check('guard: the refusal says why (SMOKE REFUSED)',
    refused.out.includes('SMOKE REFUSED'));
  check('guard: the refusal names the foreign bridge version it saw',
    refused.out.includes('0.0.0-live'));
  check('guard: the foreign bridge received NO POST (nothing was mutated)',
    seen.every(r => r.startsWith('GET ')), JSON.stringify(seen));
  check('guard: the foreign bridge only ever saw status probes',
    seen.length >= 1 && seen.every(r => r === 'GET /api/status'), JSON.stringify(seen));

  await new Promise((resolve) => {
    dummy.close(() => resolve());
    for (const s of sockets) s.destroy();
  });
  await sleep(500);

  // ---------- Phase 2: port free — the hermetic path still works ----------
  const okRun = await runSmoke();
  check('guard: with the port free the smoke runs against its own child and passes',
    okRun.code === 0 && okRun.out.includes('0 failed'),
    `exit=${okRun.code}\n${okRun.out.slice(-400)}`);

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('GUARD ERROR', e);
  process.exit(1);
});
