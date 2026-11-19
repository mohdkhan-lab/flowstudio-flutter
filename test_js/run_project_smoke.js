'use strict';

// Bridge smoke (v2.33.0 Problems 2-4 integration; v2.34.0 updated):
// boot the REAL bridge on a throwaway APPDATA (stub DB, no
// accounts), then verify
//  - /api/status reports the current version
//  - redo-missing with no run yet -> 400
//  - a start with a project name creates the project subfolder,
//    stores the per-prompt labels as task tags, persists the
//    project in settings_json, and points download_folder at the
//    project subfolder
//  - v2.34.0 (Problem 5): the stored prompt_text is CLEAN — the
//    label lives only in prompt_tag, never in the submitted text
//  - v2.34.0 (Problem 7): /api/output-files badges a stray local
//    file dropped into the folder as origin "local"
//  - redo-missing afterwards finds both scenes missing (they never
//    ran — no accounts) and starts a redo of the EXISTING tasks
// Usage: node test_js/run_project_smoke.js
//
// v2.48.83 (P2 — SMOKE ISOLATION, field incident 2026-11-10):
// this smoke runs ONLY against the isolated bridge child it
// spawns itself (throwaway APPDATA, loopback port 48290). The
// old version trusted WHATEVER answered on 48290 — run on a
// machine where the live app was already up, its child died
// (EADDRINUSE), every call landed on the LIVE bridge, and its
// start call rewrote the live app's download_folder to a
// fs-smoke temp dir and spent real accounts' credits. Now: a
// pre-flight probe refuses to run if anything already serves
// the port, and a post-boot liveness check proves the
// answering bridge is the spawned child before any mutating
// call is made. test_js/run_smoke_guard_tests.js pins both.
//
// PUBLIC v1.0.1 — KNOWN BLIND SPOT (the v1.0.0 field failure):
// this smoke spawns the bridge ITSELF and drives it over HTTP;
// it never launches the Flutter app, so it structurally cannot
// catch a bug in WHO starts the engine. v1.0.0 shipped with the
// entry gate polling a port nobody listened on — the engine's
// only spawn trigger (AccountsProvider's constructor) lived
// behind the gate — and this smoke passed 30/30 throughout.
// The gate-starts-its-own-engine path is therefore pinned
// STATICALLY in the root pack (X125: EntryProvider's constructor
// calls ensureEngineRunning, controls gated on entry.loaded,
// the 20s watchdog + Retry, engine-start.log, gate timeouts).
// A green smoke here proves the ENGINE is healthy; the X125
// pins prove the APP asks it to start.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const BASE = 'http://127.0.0.1:48290';

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
  try { data = await res.json(); } catch (e) { }
  return { status: res.status, data };
}

// v2.48.83 (P2): one short status probe, used BEFORE spawning
// anything — if a bridge already serves the port, this machine
// has a live instance and the smoke must not run at all.
async function probeStatus(timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(BASE + '/api/status', { signal: ctrl.signal });
    clearTimeout(t);
    let data = null;
    try { data = await res.json(); } catch (e) { }
    return { status: res.status, data };
  } catch (e) {
    return null;
  }
}

// v2.48.83 (P2): hard refusal — exit code 2, no checks run,
// and above all NO mutating call has been or will be made.
function refuse(reason) {
  console.error(`SMOKE REFUSED: ${reason}`);
  console.error('The smoke runs ONLY against the isolated bridge it spawns itself (throwaway APPDATA on 127.0.0.1:48290). It never attaches to an already-running instance: doing so would mutate that instance\'s real settings (the 2026-11-10 incident left the live app\'s download folder pointing at a fs-smoke temp dir) and could spend real accounts\' credits. Close the live app / free port 48290, then re-run.');
  process.exit(2);
}

async function waitStatus(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await req('GET', '/api/status');
      if (r.status === 200) return r.data;
    } catch (e) { }
    await sleep(300);
  }
  return null;
}

async function main() {
  // v2.48.83 (P2): PRE-FLIGHT — if anything already answers
  // on 48290, a bridge is already running on this machine
  // (most likely the LIVE app). Refuse before spawning or
  // sending anything at all.
  const pre = await probeStatus();
  if (pre && pre.status === 200) {
    refuse(`a FlowStudio bridge is already serving on ${BASE} (version ${pre.data && pre.data.version}) before the smoke spawned anything — a live instance appears to be running.`);
  }

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
    // v2.48.83 (P2): CHILD-IDENTITY PROOF — before ANY
    // mutating call, prove the answering bridge is the
    // child spawned above. If the child died (classically
    // EADDRINUSE because something else holds the port)
    // yet something answered, that something is a foreign
    // bridge and every call from here would mutate IT.
    await sleep(800);
    if (child.exitCode !== null) {
      refuse(`the spawned bridge exited (code ${child.exitCode}) yet something answers on ${BASE} — a foreign bridge holds the port. Bridge log tail: ${bridgeLog.slice(-300)}`);
    }
    check('status version is 1.0.10', status && status.version === '1.0.10', JSON.stringify(status));

    // PUBLIC v1.0.0: ENTRY GATE — a fresh install (throwaway
    // APPDATA, no credential stored) must be CLOSED, a garbage
    // key must be refused, and — when the operator's key file is
    // on this machine — a real generated key must open the gate
    // and the Settings removal must close it again.
    // PUBLIC v1.0.2: Door A is CONFIGURED now (the Firebase
    // backend is live) — the status must say so honestly. The
    // smoke does NOT attempt a real sign-in (no test account
    // exists); the Firebase request shapes are pinned with fake
    // fetch in the root pack (X127), and a real sign-in is a
    // field check.
    const entry0 = await req('GET', '/api/entry/status');
    check('entry gate closed on a fresh install',
      entry0.status === 200 && entry0.data && entry0.data.entry && entry0.data.entry.allowed === false,
      JSON.stringify(entry0.data));
    check('entry gate: Door A configured (Firebase backend live)',
      entry0.data && entry0.data.doorA && entry0.data.doorA.configured === true,
      JSON.stringify(entry0.data && entry0.data.doorA));
    check('entry gate: status carries the FS machine ID (v1.0.4)',
      entry0.data && /^FS-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(entry0.data.machineId || ''),
      JSON.stringify(entry0.data && entry0.data.machineId));
    const badKey = await req('POST', '/api/entry/activate-key', { key: 'not-a-key' });
    check('entry gate: a garbage key is refused',
      badKey.status === 200 && badKey.data && badKey.data.ok === false,
      JSON.stringify(badKey.data));
    // v1.0.6: a well-formed but unknown SHORT key goes down the
    // redeem path and is refused too (key-not-found once the new
    // function is deployed; a mapped refusal before it).
    const badShort = await req('POST', '/api/entry/activate-key', { key: 'FS-0000-0000-0000' });
    check('entry gate: an unknown short key is refused',
      badShort.status === 200 && badShort.data && badShort.data.ok === false,
      JSON.stringify(badShort.data));
    // v1.0.8 (F2): the window-phase route is GONE — the window
    // is one size from the runner and nothing resizes it. The
    // route must not answer any more.
    const phase = await req('POST', '/api/entry/window-phase', { phase: 'gate' });
    check('entry gate: the window-phase route is gone (v1.0.8 F2)',
      phase.status === 404,
      JSON.stringify(phase.data));
    // v1.0.5: the key fetch with no pending sign-in refuses
    // honestly — no key is ever invented locally.
    const myKey = await req('POST', '/api/entry/my-key', {});
    check('entry gate: my-key without a sign-in refuses honestly',
      myKey.status === 200 && myKey.data && myKey.data.ok === false && myKey.data.reason === 'no-account',
      JSON.stringify(myKey.data));
    const fsKeyPath = process.env.FS_LICENSE_PRIVATE_KEY ||
      path.join(os.homedir(), 'workspace', 'license-keys', 'flowstudio-license-private.pem');
    if (fs.existsSync(fsKeyPath)) {
      const { spawnSync } = require('child_process');
      const gen = spawnSync('node', ['tools/make_license_key.js', '--plan', 'Smoke', '--days', '30'],
        { cwd: REPO, encoding: 'utf8', env: { ...process.env, FS_LICENSE_PRIVATE_KEY: fsKeyPath } });
      const keyLine = (gen.stdout || '').split('\n').map(l => l.trim())
        .find(l => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(l));
      check('entry gate: key generator produced a key', !!keyLine, (gen.stderr || ''));
      if (keyLine) {
        const act = await req('POST', '/api/entry/activate-key', { key: keyLine });
        check('entry gate: a generated key activates',
          act.status === 200 && act.data && act.data.ok === true && act.data.entry && act.data.entry.allowed === true,
          JSON.stringify(act.data));
        const entry1 = await req('GET', '/api/entry/status');
        check('entry gate: status shows the plan line after activation',
          entry1.data && entry1.data.entry && entry1.data.entry.allowed === true &&
          typeof entry1.data.entry.statusText === 'string' && entry1.data.entry.statusText.includes('Smoke'),
          JSON.stringify(entry1.data && entry1.data.entry));
        const rm = await req('POST', '/api/entry/remove-key', {});
        check('entry gate: removing the key closes the gate again',
          rm.status === 200 && rm.data && rm.data.entry && rm.data.entry.allowed === false,
          JSON.stringify(rm.data));
      }
    } else {
      console.log('NOTE  entry gate: no operator key file on this machine — signed-key round trip skipped (X124 pins cover the key logic)');
    }

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

    const dbPath = path.join(appData, 'flowstudio', 'data', 'flow_studio.db');
    check('stub DB exists', fs.existsSync(dbPath), dbPath);
    if (fs.existsSync(dbPath)) {
      const initSqlJs = require('sql.js');
      const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
      const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
      const db = new SQL.Database(fs.readFileSync(dbPath));
      // NOTE: the bridge migrates the repo's local dev DB into a
      // fresh APPDATA, so old task rows may sit alongside — select
      // only THIS smoke's rows, by their unique prompt texts.
      const rows = db.exec("SELECT prompt_text, prompt_tag, settings_json FROM queue_tasks WHERE prompt_text IN ('A lighthouse in a storm', 'A calm valley at dawn') ORDER BY prompt_index");
      const tasks = rows.length ? rows[0].values : [];
      check('two task rows', tasks.length === 2, `got ${tasks.length}`);
      // v2.34.0 (Problem 5): stored text is the CLEAN body — the
      // start payload above carried label-ful texts on the object
      // path ("#00-01 A lighthouse in a storm" with tag "#00-01",
      // "Scene 2: A calm valley at dawn" with tag "Scene 2"), and
      // neither label may survive into prompt_text.
      check('task 1 stored text is label-free', tasks.length === 2 && tasks[0][0] === 'A lighthouse in a storm', JSON.stringify(tasks[0]));
      check('task 2 stored text is label-free', tasks.length === 2 && tasks[1][0] === 'A calm valley at dawn', JSON.stringify(tasks[1]));
      check('task 1 tag is its hash label', tasks.length === 2 && tasks[0][1] === '#00-01', JSON.stringify(tasks[0]));
      check('task 2 tag is its scene label', tasks.length === 2 && tasks[1][1] === 'Scene 2', JSON.stringify(tasks[1]));
      check('project persisted in settings_json',
        tasks.length === 2 && tasks.every(r => String(r[2]).includes('"project":"My Film"')),
        tasks.length ? String(tasks[0][2]).slice(0, 200) : 'no rows');
      const setRows = db.exec("SELECT value FROM app_settings WHERE key = 'download_folder'");
      const dl = setRows.length && setRows[0].values.length ? String(setRows[0].values[0][0]) : '';
      check('download_folder points at the project subfolder', dl === projDir, dl);
      db.close();
    }

    // v2.34.0 (Problem 7): a stray local file dropped into the
    // project folder must be listed with origin "local" (no DB
    // record exists for it; nothing may fabricate one).
    fs.writeFileSync(path.join(projDir, 'stray-local.mp4'), 'not a real video');
    // (Fix list 2026-10-27, item 1): a file in the BASE folder too —
    // the listing must cover the whole tree (base + project
    // subfolders) now that download_folder points INTO the project.
    fs.writeFileSync(path.join(outDir, 'root-clip.mp4'), 'not a real video');
    const listing = await req('GET', '/api/output-files');
    const stray = (((listing.data || {}).files) || []).find(f => f.name === 'stray-local.mp4');
    check('output-files lists the stray file', !!stray, JSON.stringify(listing.data).slice(0, 300));
    check('stray file origin is local', !!stray && stray.origin === 'local', JSON.stringify(stray));
    check('project file carries project + rel',
      !!stray && stray.project === 'My Film' && stray.rel === 'My Film/stray-local.mp4',
      JSON.stringify(stray));
    const root = (((listing.data || {}).files) || []).find(f => f.name === 'root-clip.mp4');
    check('output-files lists base-folder files too',
      !!root && root.project === '' && root.rel === 'root-clip.mp4', JSON.stringify(root));
    const rp = await req('POST', '/api/output-file-path', { name: 'My Film/stray-local.mp4' });
    check('output-file-path resolves a project file',
      rp.status === 200 && rp.data && rp.data.path === path.join(projDir, 'stray-local.mp4'),
      JSON.stringify(rp.data));
    const rpBad = await req('POST', '/api/output-file-path', { name: '../secret.mp4' });
    check('output-file-path refuses traversal', rpBad.status === 404, JSON.stringify(rpBad.data));

    const redo = await req('POST', '/api/generation/redo-missing', { accountIds: [] });
    check('redo answers ok', redo.status === 200 && redo.data && redo.data.ok === true, JSON.stringify(redo.data));
    check('redo started for the 2 un-run scenes', redo.data && redo.data.started === true && redo.data.missing === 2, JSON.stringify(redo.data));
    await sleep(2500);
    const after = await req('GET', '/api/status');
    check('redo run settled (no active pool)', after.data && after.data.workers === 0, JSON.stringify(after.data));

    // v2.48.0 (deep-audit fix #1): resume with NO active pool and
    // nothing pending a download-only check must answer honestly —
    // resumed:false + reason 'nothing-to-resume' — never the old
    // bare { ok: true } that implied a restart had happened.
    const resume = await req('POST', '/api/generation/resume', {});
    check('resume with nothing pending answers honestly',
      resume.status === 200 && resume.data && resume.data.resumed === false && resume.data.reason === 'nothing-to-resume',
      JSON.stringify(resume.data));
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
