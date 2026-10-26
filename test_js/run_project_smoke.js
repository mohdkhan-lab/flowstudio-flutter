'use strict';

// v2.33.0 bridge smoke (Problems 2-4 integration): boot the REAL
// bridge on a throwaway APPDATA (stub DB, no accounts), then verify
//  - /api/status reports 2.33.0
//  - redo-missing with no run yet -> 400
//  - a start with a project name creates the project subfolder,
//    stores the per-prompt labels as task tags, persists the
//    project in settings_json, and points download_folder at the
//    project subfolder
//  - redo-missing afterwards finds both scenes missing (they never
//    ran — no accounts) and starts a redo of the EXISTING tasks
// Usage: node test_js/run_project_smoke.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const BASE = 'http://127.0.0.1:48190';

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

async function waitStatus(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await req('GET', '/api/status');
      if (r.status === 200) return r.data;
    } catch (e) {}
    await sleep(300);
  }
  return null;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-smoke-'));
  const appData = path.join(tmp, 'appdata');
  const outDir = path.join(tmp, 'out');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const child = spawn('node', ['engine_bridge.js'], {
    cwd: REPO,
    env: { ...process.env, APPDATA: appData },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bridgeLog = '';
  child.stdout.on('data', d => { bridgeLog += d; });
  child.stderr.on('data', d => { bridgeLog += d; });

  try {
    const status = await waitStatus();
    check('bridge boots', !!status, bridgeLog.slice(-400));
    check('status version is 2.33.0', status && status.version === '2.33.0', JSON.stringify(status));

    const redoEarly = await req('POST', '/api/generation/redo-missing', {});
    check('redo before any run -> 400', redoEarly.status === 400, JSON.stringify(redoEarly.data));

    const start = await req('POST', '/api/generation/start', {
      prompts: [
        { text: '#00-01 A lighthouse in a storm', index: 0, tag: '#00-01' },
        { text: 'Scene 2: A calm valley at dawn', index: 1, tag: 'Scene 2' },
      ],
      downloadFolder: outDir,
      parallelBrowsers: 1,
      duration: '4s',
      aspectRatio: '9:16',
      quality: '720p',
      tag: '',
      accountIds: [],
      model: 'Omni Flash',
      namingPattern: 'tag',
      project: 'My Film',
    });
    check('start accepted', start.status === 200 && start.data && start.data.ok === true, JSON.stringify(start.data));

    // The run has no accounts -> it ends NoAccounts quickly; the DB
    // persists on a 2s debounce, so give it a moment before reading.
    await sleep(3500);
    const projDir = path.join(outDir, 'My Film');
    check('project subfolder created', fs.existsSync(projDir));

    const dbPath = path.join(appData, 'google-flow-studio-lite', 'data', 'flow_studio_lite.db');
    check('stub DB exists', fs.existsSync(dbPath), dbPath);
    if (fs.existsSync(dbPath)) {
      const initSqlJs = require('sql.js');
      const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
      const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
      const db = new SQL.Database(fs.readFileSync(dbPath));
      // NOTE: the bridge migrates the repo's local dev DB into a
      // fresh APPDATA, so old task rows may sit alongside — select
      // only THIS smoke's rows, by their unique prompt texts.
      const rows = db.exec("SELECT prompt_tag, settings_json FROM queue_tasks WHERE prompt_text LIKE '#00-01%' OR prompt_text LIKE 'Scene 2:%' ORDER BY prompt_index");
      const tasks = rows.length ? rows[0].values : [];
      check('two task rows', tasks.length === 2, `got ${tasks.length}`);
      check('task 1 tag is its hash label', tasks.length === 2 && tasks[0][0] === '#00-01', JSON.stringify(tasks[0]));
      check('task 2 tag is its scene label', tasks.length === 2 && tasks[1][0] === 'Scene 2', JSON.stringify(tasks[1]));
      check('project persisted in settings_json',
        tasks.length === 2 && tasks.every(r => String(r[1]).includes('"project":"My Film"')),
        tasks.length ? String(tasks[0][1]).slice(0, 200) : 'no rows');
      const setRows = db.exec("SELECT value FROM app_settings WHERE key = 'download_folder'");
      const dl = setRows.length && setRows[0].values.length ? String(setRows[0].values[0][0]) : '';
      check('download_folder points at the project subfolder', dl === projDir, dl);
      db.close();
    }

    const redo = await req('POST', '/api/generation/redo-missing', { accountIds: [] });
    check('redo answers ok', redo.status === 200 && redo.data && redo.data.ok === true, JSON.stringify(redo.data));
    check('redo started for the 2 un-run scenes', redo.data && redo.data.started === true && redo.data.missing === 2, JSON.stringify(redo.data));
    await sleep(2500);
    const after = await req('GET', '/api/status');
    check('redo run settled (no active pool)', after.data && after.data.workers === 0, JSON.stringify(after.data));
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('SMOKE ERROR', e);
  process.exit(1);
});
