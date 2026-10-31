const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// Environment setup - Persist data in user's AppData directory so all accounts, cookies, and database are kept
const appDataRoot = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'google-flow-studio-lite')
  : path.join(__dirname);

const appDataDataDir = path.join(appDataRoot, 'data');
const appDataProfilesDir = path.join(appDataRoot, 'profiles');
const localDataDir = path.join(__dirname, 'data');
const localProfilesDir = path.join(__dirname, 'profiles');

try {
  if (!fs.existsSync(appDataDataDir)) {
    fs.mkdirSync(appDataDataDir, { recursive: true });
  }
  if (!fs.existsSync(appDataProfilesDir)) {
    fs.mkdirSync(appDataProfilesDir, { recursive: true });
  }

  const appDataDb = path.join(appDataDataDir, 'flow_studio_lite.db');
  const localDb = path.join(localDataDir, 'flow_studio_lite.db');
  if (!fs.existsSync(appDataDb) && fs.existsSync(localDb)) {
    fs.copyFileSync(localDb, appDataDb);
    console.log('[FlowStudio Engine] Migrated database to AppData');
  }

  if (fs.existsSync(localProfilesDir)) {
    const entries = fs.readdirSync(localProfilesDir);
    for (const entry of entries) {
      const src = path.join(localProfilesDir, entry);
      const dest = path.join(appDataProfilesDir, entry);
      if (!fs.existsSync(dest)) {
        try { fs.cpSync(src, dest, { recursive: true, force: false }); } catch (_) {}
      }
    }
  }
} catch (e) {
  console.warn('[Data Init Warning]:', e.message);
}

process.env.FLOW_LITE_DATA_DIR = appDataDataDir;
process.env.FLOW_LITE_PROFILES_DIR = appDataProfilesDir;

// Engine imports
const { dbService } = require('./engine/db');
const {
  getAccounts,
  addAccount,
  deleteAccount,
  fetchRealCredits,
  refreshAllAccountCredits,
  getInstalledChromeProfiles,
  importFromInstalledChrome,
  openLoginWindow,
  completeLoginCheck,
} = require('./engine/accountStore');
const {
  importAccountFromCookieFile,
  importAccountFromCookieText,
  importAccountsFromCookieFiles,
  recheckAccountCookies,
  checkImportedAccount,
} = require('./engine/cookieImport');
const { WorkerPool } = require('./engine/workerPool');
const browserMode = require('./engine/browserMode');
const promptParser = require('./engine/promptParser');
const historyOrigin = require('./engine/historyOrigin');
const projectFolder = require('./engine/projectFolder');
const sequenceReport = require('./engine/sequenceReport');
const { recordActivity, getActivityStore } = require('./engine/activityStore');
const mcp = require('./mcp_server');
const { getStats } = require('./engine/usageStats');
const { parseCookieText } = require('./engine/cookieParser');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// v2.22.1: duplicate-cookie guard + live "Checking…" account line.
//
// (a) The engine's cookie import creates a brand-new account on EVERY
// import, so importing the same cookies twice piled up duplicate lines.
// The bridge now fingerprints the identity cookies of each import; a
// repeat import re-checks the EXISTING account instead of adding a copy.
// (b) The engine creates the account row first and then streams check
// phases — the bridge forwards those phases as account-updated events so
// the sidebar line appears immediately with a CHECKING chip and flips to
// its real Live/Fail result in the same line (the old app's behaviour).
// ---------------------------------------------------------------------------
const fingerprintFile = () => path.join(process.env.FLOW_LITE_DATA_DIR || __dirname, 'cookie-fingerprints.json');

function loadFingerprints() {
  try {
    return JSON.parse(fs.readFileSync(fingerprintFile(), 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function saveFingerprints(map) {
  try {
    fs.writeFileSync(fingerprintFile(), JSON.stringify(map, null, 2));
  } catch (e) {}
}

function cookieFingerprint(text) {
  try {
    const parsed = parseCookieText(text);
    const identityNames = new Set(['SID', 'SSID', 'SAPISID', 'HSID', '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID']);
    const parts = (parsed.cookies || [])
      .filter(c => identityNames.has(c.name) && String(c.value || '').length > 8)
      .map(c => `${c.name}=${c.value}`)
      .sort();
    if (parts.length === 0) return null;
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
  } catch (e) {
    return null;
  }
}

function makePhaseBroadcaster() {
  return (phase) => {
    broadcastEvent('cookie-phase', phase);
    try {
      if (phase && phase.accountId) {
        const acc = dbService.getAccount(phase.accountId);
        if (acc) {
          const shown = phase.phase === 'checking' ? { ...acc, status: 'Checking…' } : acc;
          broadcastEvent('account-updated', { account: shown });
        }
      }
    } catch (e) {}
  };
}

// If a freshly checked account turns out to be the SAME Google account as
// an older line (same email), remove the older duplicate and keep the new
// one (its cookies were just verified live).
function mergeDuplicateByEmail(newAccount) {
  try {
    if (!newAccount || !newAccount.email) return;
    const email = String(newAccount.email).trim().toLowerCase();
    if (!email) return;
    const others = dbService.getAccounts().filter(a =>
      a.id !== newAccount.id && a.email && String(a.email).trim().toLowerCase() === email);
    for (const dup of others) {
      deleteAccount(dup.id);
      const map = loadFingerprints();
      let changed = false;
      for (const [fp, accId] of Object.entries(map)) {
        if (accId === dup.id) { map[fp] = newAccount.id; changed = true; }
      }
      if (changed) saveFingerprints(map);
      broadcastEvent('automation-log', {
        message: `Duplicate removed: "${dup.name}" was the same Google account as "${newAccount.name}".`,
        level: 'warning',
      });
    }
  } catch (e) {}
}

const PORT = 48190;
// The app version this bridge ships with — bumped with every release,
// alongside pubspec.yaml / package.json / installer.iss / the Dart
// defaults. /api/status reports it and the update check compares
// GitHub's latest tag against it.
const APP_VERSION = '2.47.5';
let activeWorkerPool = null;
// v2.33.0: the composition of the most recent run ({ taskIds,
// downloadFolder, settings }), captured through the pool's
// onRunStart. The missing-scene redo route reads it to compute
// what is missing and to send redo work back into the SAME folder
// (the project folder, when the run had one). Same-folder runs
// union their task ids, so the completeness view always covers
// the whole project rather than only the last batch.
let lastRunInfo = null;
const sseClients = new Set();

function broadcastEvent(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------
// v2.31.4: latest-release lookup for the MCP "update the app" tool.
// This mirrors the Dart updater in SettingsProvider.checkForUpdates
// EXACTLY — same GitHub releases source, same headers, same 10s
// timeout, same version comparison, same "first .exe asset" pick —
// so the MCP check/install can never disagree with Settings →
// Updates about whether an update exists. The download + silent
// install themselves stay on the Dart side (it owns the installer
// launch); the bridge only signals it over SSE (see /api/update/*).
// ---------------------------------------------------------------------------
function isNewerVersion(latest, current) {
  const parts = (v) => String(v || '').replace(/^v/, '').split('.')
    .map((p) => parseInt(p.replace(/[^0-9]/g, ''), 10) || 0);
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < a.length || i < b.length; i++) {
    const av = i < a.length ? a[i] : 0;
    const bv = i < b.length ? b[i] : 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      'https://api.github.com/repos/mohdkhan-lab/flowstudio-flutter/releases/latest',
      { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'FlowStudioLite' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`GitHub answered ${res.statusCode}`));
          }
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const tag = String(data.tag_name || '');
            let asset = null;
            if (Array.isArray(data.assets)) {
              for (const a of data.assets) {
                const name = String((a && a.name) || '');
                if (name.toLowerCase().endsWith('.exe')) {
                  asset = {
                    name,
                    downloadUrl: String(a.browser_download_url || ''),
                    sizeBytes: Number(a.size) || 0,
                  };
                  break;
                }
              }
            }
            resolve({ tag, asset });
          } catch (e) {
            reject(new Error('GitHub returned an unreadable response'));
          }
        });
      }
    );
    req.setTimeout(10000, () => req.destroy(new Error('the update check timed out after 10s')));
    req.on('error', (e) => reject(new Error(`could not reach GitHub (${e.message})`)));
  });
}

async function startBridge() {
  await dbService.ensureInit();
  console.log(`[FlowStudio Engine] Database initialized. Running on port ${PORT}...`);
  // v2.31.0: start the MCP server at boot when the connector is on.
  try {
    if (mcp.mcpEnabled(dbService)) {
      mcp.startMcpServer({ dbService, broadcastEvent });
    }
  } catch (e) {
    console.warn('[FlowStudio MCP] Boot start failed:', e.message);
  }

  // v2.33.0: ONE pool factory for fresh generation starts AND the
  // missing-scene redo, so a redo run emits exactly the same events
  // (logs with the Simple/Details split, task updates, completions,
  // progress, parked-browser changes) as a fresh run — the app
  // cannot tell them apart, and neither can the Activity history.
  // onRunStart is wired here too: it records the run's composition
  // into lastRunInfo, which the redo route reads.
  function buildPool({ parallelBrowsers, accountIds, getSettingsHint } = {}) {
    // v2.22.0 fix: browser visibility comes from the engine's own
    // 'browser_background' setting — the SAME key the original
    // Electron main.js uses ('1' or unset = background ON, '0' =
    // visible). The WorkerPool "headless" option is the background
    // flag (headed Chrome parked off-screen, never true headless).
    const backgroundSetting = dbService.getSetting('browser_background', '1');
    return new WorkerPool({
      concurrency: parallelBrowsers || 1,
      headless: backgroundSetting !== '0',
      // Headless generation (owner's opt-in): TRUE headless Chrome
      // for generation workers — wins over the background/visible
      // choice above inside browserMode.launchPlan. Default OFF;
      // only the exact '1' enables it.
      headlessGeneration: browserMode.resolveHeadlessGenerationEnabled(
        dbService.getSetting(browserMode.HEADLESS_SETTING_KEY, '0')
      ),
      liveOnly: dbService.getSetting('live_only_accounts', '0') === '1',
      // v2.29.0 (checkbox truth): the sidebar's ticked account
      // IDs from the generate request — the pool may use ONLY
      // these. Absent (old callers) = no restriction.
      allowedAccountIds: Array.isArray(accountIds) ? accountIds : null,
      // v2.28.0: the engine's log() passes ONE OBJECT
      // ({ message, type, timestamp, ...extra }) — the old wiring
      // treated it as (msg, type) strings, so the whole object
      // became the SSE message (the app printed the raw dump and
      // the level was lost). Accept the object form, stay tolerant
      // of a plain string.
      // v2.29.0 (Simple/Details split): pool lines are DETAIL by
      // default — the Activity "Simple" view hides them. Only
      // milestone lines stay simple: run completions, downloads /
      // saves, sync completions, and every error or warning.
      // Bridge-originated automation-log broadcasts carry no
      // detail flag at all, which the app reads as simple.
      onLog: (entry) => {
        const m = (entry && typeof entry === 'object') ? (entry.message ?? String(entry)) : String(entry ?? '');
        const lvl = (entry && typeof entry === 'object' && entry.type) ? entry.type : 'info';
        const lowLevel = lvl === 'error' || lvl === 'warn' || lvl === 'warning';
        const text = String(m).toLowerCase();
        const milestone = lowLevel ||
          text.includes('all work is complete') ||
          text.includes('generation queue finished') ||
          text.includes('download complete') ||
          text.includes('downloaded') ||
          text.includes('saved as') ||
          text.includes('sync complete');
        broadcastEvent('automation-log', { message: m, level: lvl, detail: !milestone });
      },
      onProgress: (data) => broadcastEvent('automation-progress', data),
      // v2.30.1: forward the pool's per-task updates — this
      // callback was never wired, so WorkerPool.onTaskUpdate
      // defaulted to a no-op and every per-task failure (with
      // its concrete reason) was silently dropped; the app's
      // cards then span as RENDERING past the end of the run.
      onTaskUpdate: (data) => broadcastEvent('task-updated', data),
      onVideoCompleted: (data) => broadcastEvent('video-completed', data),
      // v2.30.3: forward the engine's live render progress
      // (tile percentage + elapsed). This callback was never
      // wired either — the pool relayed it to a no-op, so the
      // app never saw a percentage and a rendering card could
      // only sit on "Working…". The app also uses these events
      // as the run's heartbeat for its no-response watchdog.
      onVideoProgress: (data) => broadcastEvent('video-progress', data),
      onAccountUpdated: (data) => broadcastEvent('account-updated', data),
      // v2.25.0 (parked browser): the pool announces which accounts
      // have a live generation browser (+ window shown/parked) —
      // the sidebar renders ACTIVE + the Show/Hide toggle from it.
      onActiveBrowsersChanged: (list) => broadcastEvent('active-browsers', { accounts: list }),
      // v2.33.0: capture the run's composition for the sequence
      // check + the missing-scene redo. A run into the SAME folder
      // (a redo, or the next batch of the same project) unions its
      // task ids into the recorded run, so the completeness view
      // covers the whole project; a run into a different folder
      // starts a fresh record.
      onRunStart: (info) => {
        if (lastRunInfo && lastRunInfo.downloadFolder === info.downloadFolder) {
          const merged = new Set([...lastRunInfo.taskIds, ...(info.taskIds || [])]);
          lastRunInfo = { ...lastRunInfo, taskIds: [...merged] };
        } else {
          let hint = {};
          try { hint = (typeof getSettingsHint === 'function' ? getSettingsHint() : null) || {}; } catch (e) {}
          lastRunInfo = {
            taskIds: [...(info.taskIds || [])],
            downloadFolder: info.downloadFolder,
            settings: hint
          };
        }
      }
    });
  }

  const server = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = reqUrl.pathname;

    // 1. SSE Events endpoint
    if (pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('\n');
      sseClients.add(res);

      // v2.25.0 (parked browser): a (re)connecting UI gets the CURRENT
      // active-browser snapshot at once, so the sidebar's ACTIVE text
      // is right even if it missed the change events while away.
      try {
        const snap = activeWorkerPool ? activeWorkerPool.getActiveBrowsers() : [];
        res.write(`event: active-browsers\ndata: ${JSON.stringify({ accounts: snap })}\n\n`);
      } catch (e) {}

      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // Helper to read JSON body
    const readBody = () => new Promise((resolve) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          resolve({});
        }
      });
    });

    const sendJson = (statusCode, data) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    try {
      // 2. Health & Status
      if (pathname === '/api/status' && req.method === 'GET') {
        return sendJson(200, { ok: true, version: APP_VERSION, workers: activeWorkerPool ? 1 : 0 });
      }

      // 3. Settings Endpoints
      if (pathname === '/api/settings' && req.method === 'GET') {
        const keys = [
          'appearance', 'theme', 'default_model', 'default_duration', 'default_aspect',
          'default_naming', 'default_quality', 'custom_tags', 'download_folder', 'chrome_path',
          'browser_background', 'show_browsers', 'preview_autoplay', 'auto_verify_start', 'auto_check_updates',
          // Headless generation opt-in (Settings → Automation) —
          // the app reads it back so the toggle shows the truth.
          'headless_generation',
          'social_links', 'live_only_accounts', 'history_cleared',
          // (Fix list 2026-10-27, items 1+2): the recorded BASE
          // output folder (History's tree root + the app's output
          // folder truth) and the History page's own list of video
          // files the owner picked from elsewhere on his PC.
          'download_base_folder', 'history_local_files',
          // v2.29.0: the sidebar's source-numbering aliases
          // (account id -> { alias, source }) and the persisted
          // parallel-browsers count.
          'account_aliases', 'parallel_browsers',
          // v2.31.0: MCP connector on/off (the token itself is only
          // ever served by the /api/mcp/* endpoints below).
          'mcp_enabled'
        ];
        const settings = {};
        for (const k of keys) {
          settings[k] = dbService.getSetting(k, null);
        }
        return sendJson(200, { ok: true, settings });
      }

      if (pathname === '/api/settings' && req.method === 'POST') {
        const body = await readBody();
        if (body.settings && typeof body.settings === 'object') {
          for (const [k, v] of Object.entries(body.settings)) {
            dbService.setSetting(k, v);
          }
        } else if (body.key) {
          dbService.setSetting(body.key, body.value);
        }
        return sendJson(200, { ok: true });
      }

      // 3b. v2.31.0: MCP connector management (local UI only — this
      // bridge listens on 127.0.0.1, so the full token served by
      // /api/mcp/config never leaves the owner's PC).
      if (pathname === '/api/mcp/status' && req.method === 'GET') {
        return sendJson(200, { ok: true, mcp: mcp.getStatus(dbService) });
      }

      if (pathname === '/api/mcp/enable' && req.method === 'POST') {
        const body = await readBody();
        const enabled = !!body.enabled;
        dbService.setSetting('mcp_enabled', enabled ? '1' : '0');
        if (enabled) {
          mcp.startMcpServer({ dbService, broadcastEvent });
        } else {
          mcp.stopMcpServer();
        }
        broadcastEvent('automation-log', {
          message: enabled ? '🔌 MCP • Muse connector started (port 48191)' : '🔌 MCP • Muse connector stopped',
          level: 'info',
        });
        return sendJson(200, { ok: true, mcp: mcp.getStatus(dbService) });
      }

      if (pathname === '/api/mcp/regenerate-token' && req.method === 'POST') {
        mcp.regenerateToken(dbService);
        broadcastEvent('automation-log', { message: '🔌 MCP • New access token generated — Muse must use the new config', level: 'warning' });
        return sendJson(200, { ok: true, mcp: mcp.getStatus(dbService) });
      }

      if (pathname === '/api/mcp/config' && req.method === 'GET') {
        const status = mcp.getStatus(dbService);
        const token = mcp.ensureToken(dbService);
        return sendJson(200, {
          ok: true,
          config: {
            mcpServers: {
              flowstudio: {
                url: status.url,
                headers: { Authorization: `Bearer ${token}` },
              },
            },
          },
        });
      }

      // 3c. v2.31.4: app update check + install trigger (MCP tool
      // backend). CHECK answers from the same GitHub releases source
      // as Settings → Updates. INSTALL is only a *request*: it guards
      // (no active run, a newer release with a Setup file must
      // exist), then signals the Dart app over the existing SSE
      // channel — 'mcp-update-request' — and the app's own updater
      // (SettingsProvider) downloads the Setup and runs it silently,
      // exactly as if the owner had pressed the buttons. This bridge
      // never downloads or launches an installer itself.
      if (pathname === '/api/update/check' && req.method === 'GET') {
        try {
          const rel = await fetchLatestRelease();
          return sendJson(200, {
            ok: true,
            currentVersion: `v${APP_VERSION}`,
            latestVersion: rel.tag,
            updateAvailable: !!rel.tag && isNewerVersion(rel.tag, APP_VERSION),
            setupFile: rel.asset ? rel.asset.name : '',
            sizeBytes: rel.asset ? rel.asset.sizeBytes : 0,
          });
        } catch (e) {
          return sendJson(200, { ok: false, error: `Update check failed — ${e.message}` });
        }
      }

      if (pathname === '/api/update/install' && req.method === 'POST') {
        if (activeWorkerPool) {
          return sendJson(200, { ok: false, error: 'A generation run is active — the app update can only start when no video is generating.' });
        }
        let rel;
        try {
          rel = await fetchLatestRelease();
        } catch (e) {
          return sendJson(200, { ok: false, error: `Update check failed — ${e.message}` });
        }
        if (!rel.tag || !isNewerVersion(rel.tag, APP_VERSION)) {
          return sendJson(200, { ok: false, error: `Already on the latest version (v${APP_VERSION}) — nothing to install.` });
        }
        if (!rel.asset || !rel.asset.downloadUrl) {
          return sendJson(200, { ok: false, error: `Release ${rel.tag} has no Setup file attached — cannot install it.` });
        }
        broadcastEvent('automation-log', {
          message: `🔌 MCP • Muse started the app update to ${rel.tag}`,
          level: 'info',
        });
        broadcastEvent('mcp-update-request', { latestVersion: rel.tag });
        return sendJson(200, {
          ok: true,
          started: true,
          currentVersion: `v${APP_VERSION}`,
          latestVersion: rel.tag,
          note: 'The app is downloading the update itself and will close to install it.',
        });
      }

      // 4. Usage Stats
      if (pathname === '/api/stats' && req.method === 'GET') {
        let stats = { total: 0 };
        try {
          stats = getStats(dbService) || { total: 0 };
        } catch (e) {}
        const accounts = dbService.getAccounts ? dbService.getAccounts() : [];
        return sendJson(200, { ok: true, stats, accountCount: accounts.length });
      }

      // 5. Open external link
      if (pathname === '/api/open-url' && req.method === 'POST') {
        const body = await readBody();
        if (body.url) {
          exec(`start "" "${body.url}"`);
        }
        return sendJson(200, { ok: true });
      }

      // 6. Accounts
      if (pathname === '/api/accounts' && req.method === 'GET') {
        const accounts = dbService.getAccounts();
        return sendJson(200, { ok: true, accounts });
      }

      if (pathname === '/api/accounts/add' && req.method === 'POST') {
        const body = await readBody();
        const acc = addAccount(body.name || '', body.email || '');
        broadcastEvent('account-updated', { account: acc });
        broadcastEvent('automation-log', { message: `Account added: ${acc.name}`, level: 'info' });
        return sendJson(200, { ok: true, account: acc });
      }

      if (pathname === '/api/accounts/delete' && req.method === 'POST') {
        const body = await readBody();
        deleteAccount(body.id);
        broadcastEvent('automation-log', { message: `Account deleted`, level: 'info' });
        return sendJson(200, { ok: true });
      }

      if (pathname === '/api/accounts/delete-selected' && req.method === 'POST') {
        const body = await readBody();
        if (Array.isArray(body.ids)) {
          for (const id of body.ids) {
            deleteAccount(id);
          }
          broadcastEvent('automation-log', { message: `Deleted ${body.ids.length} account(s)`, level: 'warning' });
        }
        return sendJson(200, { ok: true });
      }

      if (pathname === '/api/accounts/sync-all' && req.method === 'POST') {
        broadcastEvent('automation-log', { message: 'Verifying and syncing all accounts...', level: 'info' });
        const results = await refreshAllAccountCredits((update) => {
          broadcastEvent('automation-log', { message: update.message, level: 'info' });
        });
        const accounts = dbService.getAccounts();
        // v2.29.0 (bulk sync refresh): push every account's FRESH
        // state so the sidebar's credits/chips update in place — the
        // app no longer needs a restart to show post-sync numbers.
        for (const acc of accounts) {
          broadcastEvent('account-updated', { account: acc });
        }
        return sendJson(200, { ok: true, accounts, results });
      }

      if (pathname === '/api/accounts/sync-selected' && req.method === 'POST') {
        const body = await readBody();
        const ids = Array.isArray(body.ids) ? body.ids : [];
        broadcastEvent('automation-log', { message: `Syncing ${ids.length} selected account(s)...`, level: 'info' });
        for (const id of ids) {
          try {
            await fetchRealCredits(id);
            const acc = dbService.getAccount(id);
            if (acc) broadcastEvent('account-updated', { account: acc });
          } catch (e) {
            broadcastEvent('automation-log', { message: `Sync failed for account ${id}: ${e.message}`, level: 'error' });
          }
        }
        const accounts = dbService.getAccounts();
        return sendJson(200, { ok: true, accounts });
      }

      if (pathname === '/api/accounts/open-chrome' && req.method === 'POST') {
        const body = await readBody();
        try {
          const resOpen = await openLoginWindow(body.id);
          broadcastEvent('automation-log', { message: `Chrome opened for account.`, level: 'info' });
          return sendJson(200, { ok: true, result: resOpen });
        } catch (e) {
          return sendJson(500, { ok: false, error: e.message });
        }
      }

      // v2.29.0 (direct Gmail login): the popup's "+ Add Account"
      // card creates the account through the engine's login route
      // and IMMEDIATELY opens the real Google sign-in window — there
      // is no name/email/credits form anywhere. openLoginWindow's own
      // callback fires when the sign-in is detected and again when
      // the window closes (after its live credit sync); both push the
      // account's REAL name/email/credits to the UI.
      if (pathname === '/api/accounts/start-login' && req.method === 'POST') {
        try {
          const created = addAccount('', '');
          const acc = (created && created.account) ? created.account : created;
          broadcastEvent('account-updated', { account: acc });
          broadcastEvent('automation-log', { message: 'Sign-in window opened — finish the Google login in Chrome; the account details fill in automatically.', level: 'info' });
          const resOpen = await openLoginWindow(acc.id, (result) => {
            try {
              const fresh = (result && result.account) || dbService.getAccount(acc.id);
              if (fresh) broadcastEvent('account-updated', { account: fresh });
            } catch (e) {}
          });
          if (resOpen && resOpen.success === false) {
            broadcastEvent('automation-log', { message: `Sign-in window could not open: ${resOpen.error || 'unknown error'}`, level: 'error' });
            return sendJson(200, { ok: true, account: acc, loginWindow: resOpen });
          }
          return sendJson(200, { ok: true, account: acc });
        } catch (e) {
          return sendJson(500, { ok: false, error: e.message });
        }
      }

      // v2.25.0 (parked browser): Show/Hide toggle for a GENERATING
      // account's working browser. Only the window's bounds move —
      // generation is never interrupted. Accounts that are not
      // generating keep using /api/accounts/open-chrome as before.
      if (pathname === '/api/accounts/toggle-browser' && req.method === 'POST') {
        const body = await readBody();
        if (!activeWorkerPool) {
          return sendJson(400, { ok: false, error: 'No generation is running right now.' });
        }
        try {
          const result = await activeWorkerPool.toggleBrowserWindow(body.id);
          if (!result.ok) {
            return sendJson(400, { ok: false, error: result.error || 'The browser window could not be toggled.' });
          }
          return sendJson(200, { ok: true, windowShown: result.windowShown });
        } catch (e) {
          return sendJson(500, { ok: false, error: e.message });
        }
      }

      // v2.25.0 (parked browser): the current [{ id, windowShown }]
      // list of accounts with a live generation browser (the same
      // payload the 'active-browsers' SSE event carries).
      if (pathname === '/api/generation/active-browsers' && req.method === 'GET') {
        const accounts = activeWorkerPool ? activeWorkerPool.getActiveBrowsers() : [];
        return sendJson(200, { ok: true, accounts });
      }

      if (pathname === '/api/accounts/complete-login' && req.method === 'POST') {
        const body = await readBody();
        const resCheck = await completeLoginCheck(body.id);
        const accounts = dbService.getAccounts();
        return sendJson(200, { ok: true, result: resCheck, accounts });
      }

      // 7. Chrome Profiles Detection & Import
      if (pathname === '/api/chrome-profiles' && req.method === 'GET') {
        const profiles = getInstalledChromeProfiles();
        return sendJson(200, { ok: true, profiles });
      }

      if (pathname === '/api/chrome-profiles/import' && req.method === 'POST') {
        const body = await readBody();
        const acc = await importFromInstalledChrome(body.dirName);
        broadcastEvent('automation-log', { message: `Imported Chrome Profile: ${acc.name} (${acc.credits} credits)`, level: 'success' });
        return sendJson(200, { ok: true, account: acc });
      }

      // 8. Cookie Import (File & Text)
      if (pathname === '/api/cookies/import-file' && req.method === 'POST') {
        const body = await readBody();
        const onPhase = makePhaseBroadcaster();
        // v2.30.2 (bulk add): the app's batch flow imports with
        // deferVerify — the account is ADDED now and its check runs
        // in phase 2 (/api/cookies/check) once every file is in.
        const deferVerify = body.deferVerify === true;

        // v2.22.1 duplicate guard: same cookies again → re-check the
        // existing account, never add a second copy of it.
        let fp = null;
        try { fp = cookieFingerprint(fs.readFileSync(body.filePath, 'utf8')); } catch (e) {}
        if (fp) {
          const existingId = loadFingerprints()[fp];
          const existingAcc = existingId ? dbService.getAccount(existingId) : null;
          if (existingAcc && deferVerify) {
            // Deferred: no re-check inside the add — the existing
            // account joins the batch's phase-2 check list instead.
            return sendJson(200, { ok: true, account: existingAcc, duplicate: true, needsCheck: true, message: 'These cookies were already imported — the existing account will be re-checked with the batch.' });
          }
          if (existingAcc) {
            const re = await recheckAccountCookies(existingId, onPhase);
            if (re && re.account) {
              broadcastEvent('account-updated', { account: re.account });
              broadcastEvent('automation-log', { message: 'These cookies were already imported — the existing account was re-checked instead of adding a duplicate.', level: 'info' });
              return sendJson(200, { ok: true, account: re.account, duplicate: true, message: 'These cookies were already imported — the existing account was re-checked instead of adding a duplicate.' });
            }
            // Recheck not possible → fall through to a fresh import.
          }
        }

        const res = await importAccountFromCookieFile({
          filePath: body.filePath,
          label: body.label,
          onPhase,
          deferCheck: deferVerify,
        });
        if (res.account) {
          if (fp) {
            const map = loadFingerprints();
            map[fp] = res.account.id;
            saveFingerprints(map);
          }
          mergeDuplicateByEmail(res.account);
        }
        if (res.success && res.account && res.deferred) {
          broadcastEvent('account-updated', { account: res.account });
          broadcastEvent('automation-log', { message: `Account added from cookie file: ${res.account.name} — check queued (runs after all files are added)`, level: 'info' });
          return sendJson(200, { ok: true, account: res.account, deferred: true, message: res.message });
        }
        if (res.success && res.account) {
          broadcastEvent('account-updated', { account: res.account });
          broadcastEvent('automation-log', { message: `Imported Account from cookie file: ${res.account.name}`, level: 'success' });
          return sendJson(200, { ok: true, account: res.account, message: res.message });
        } else {
          broadcastEvent('automation-log', { message: `Cookie Import failed: ${res.error || 'Failed to verify cookies'}`, level: 'error' });
          return sendJson(400, { ok: false, error: res.error || 'Cookie verification failed' });
        }
      }

      if (pathname === '/api/cookies/import-text' && req.method === 'POST') {
        const body = await readBody();
        const onPhase = makePhaseBroadcaster();
        // v2.30.2 (bulk add): same deferVerify contract as the file
        // path above.
        const deferVerify = body.deferVerify === true;

        // v2.22.1 duplicate guard (same as the file path above).
        const fp = typeof body.text === 'string' ? cookieFingerprint(body.text) : null;
        if (fp) {
          const existingId = loadFingerprints()[fp];
          const existingAcc = existingId ? dbService.getAccount(existingId) : null;
          if (existingAcc && deferVerify) {
            return sendJson(200, { ok: true, account: existingAcc, duplicate: true, needsCheck: true, message: 'These cookies were already imported — the existing account will be re-checked with the batch.' });
          }
          if (existingAcc) {
            const re = await recheckAccountCookies(existingId, onPhase);
            if (re && re.account) {
              broadcastEvent('account-updated', { account: re.account });
              broadcastEvent('automation-log', { message: 'These cookies were already imported — the existing account was re-checked instead of adding a duplicate.', level: 'info' });
              return sendJson(200, { ok: true, account: re.account, duplicate: true, message: 'These cookies were already imported — the existing account was re-checked instead of adding a duplicate.' });
            }
          }
        }

        const res = await importAccountFromCookieText({
          text: body.text,
          label: body.label || 'Cookie Account',
          onPhase,
          deferCheck: deferVerify,
        });
        if (res.account) {
          if (fp) {
            const map = loadFingerprints();
            map[fp] = res.account.id;
            saveFingerprints(map);
          }
          mergeDuplicateByEmail(res.account);
        }
        if (res.success && res.account && res.deferred) {
          broadcastEvent('account-updated', { account: res.account });
          broadcastEvent('automation-log', { message: `Account added from cookies: ${res.account.name} — check queued (runs after all files are added)`, level: 'info' });
          return sendJson(200, { ok: true, account: res.account, deferred: true, message: res.message });
        }
        if (res.success && res.account) {
          broadcastEvent('account-updated', { account: res.account });
          broadcastEvent('automation-log', { message: `Imported Account from cookies: ${res.account.name}`, level: 'success' });
          return sendJson(200, { ok: true, account: res.account, message: res.message });
        } else {
          broadcastEvent('automation-log', { message: `Cookie Import failed: ${res.error || 'Failed to verify cookies'}`, level: 'error' });
          return sendJson(400, { ok: false, error: res.error || 'Cookie verification failed' });
        }
      }

      // 8a2. v2.30.2 (bulk cookie add — PHASE 2): check the accounts
      // a batch import deferred. Runs each account's own deferred
      // check (checkImportedAccount — the import's verification tail)
      // sequentially, exactly like sync-selected drives per-account
      // syncs. Every phase/final state rides the same
      // account-updated events the sidebar already consumes, so each
      // line flips Waiting → Checking… → Live/Fail as ITS result
      // lands.
      if (pathname === '/api/cookies/check' && req.method === 'POST') {
        const body = await readBody();
        const ids = Array.isArray(body.ids)
          ? body.ids.filter(x => typeof x === 'string' && x.length > 0)
          : [];
        const onPhase = makePhaseBroadcaster();
        const results = [];
        for (const id of ids) {
          try {
            const re = await checkImportedAccount(id, onPhase);
            if (re && re.account) {
              broadcastEvent('account-updated', { account: re.account });
              mergeDuplicateByEmail(re.account);
              if (re.success) {
                broadcastEvent('automation-log', { message: `🍪 Cookie check LIVE: ${re.account.name}`, level: 'success' });
              } else {
                broadcastEvent('automation-log', { message: `🍪 Cookie check FAIL: ${re.account.name} — ${re.error || 'check failed'}`, level: 'error' });
              }
            }
            results.push({
              id,
              success: !!(re && re.success),
              error: re && re.success ? null : ((re && re.error) || 'Check failed'),
            });
          } catch (e) {
            results.push({ id, success: false, error: e.message });
          }
        }
        return sendJson(200, { ok: true, results });
      }

      // 8b. v2.27.0 (History view): list / open the real video files in
      // the configured output folder.
      // v2.30.0 (SINGLE SOURCE OF TRUTH): the one resolver every
      // reader uses. The bug this fixes: a generation run saves into
      // the folder the APP sends (config.downloadFolder — the app's
      // own default, e.g. C:\FlowStudio\Videos), while this endpoint
      // read ONLY the engine 'download_folder' setting, which nothing
      // had ever written — so History listed the fallback
      // <data dir>\downloads (empty) while the real videos sat in
      // the app's folder. Generation start now PERSISTS the folder
      // it actually saves into (see /api/generation/start), so this
      // resolver always names the folder the last run used.
      const outputDir = () => dbService.getSetting('download_folder', path.join(process.env.FLOW_LITE_DATA_DIR, 'downloads'));
      // (Fix list 2026-10-27, item 1): the BASE output folder — the
      // root of the output tree. 'download_folder' moves into the
      // latest run's project subfolder (see /api/generation/start),
      // so the base is recorded separately on every start; installs
      // that predate the key fall back to the current folder, which
      // is exactly what History listed before projects existed.
      const outputBaseDir = () => dbService.getSetting('download_base_folder', '') || outputDir();
      const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm']);

      // (Fix list 2026-10-27, item 1): resolve a caller-supplied
      // file reference to an absolute path inside the output tree.
      // Accepts a bare file NAME (the base folder — or, for names
      // that only exist there, the legacy current folder) or ONE
      // project-qualified form "Project/file.mp4": the project
      // segment must survive the project sanitiser unchanged (so it
      // can only ever name a direct child folder of the base) and
      // the file segment is basename-confined. Anything else —
      // deeper paths, traversal, non-video names — returns null.
      const resolveOutputRef = (raw) => {
        try {
          const base = outputBaseDir();
          const parts = String(raw || '').split(/[\\/]+/).filter(p => p && p !== '.');
          let dir = null;
          let name = '';
          if (parts.length === 1) {
            name = parts[0];
            dir = fs.existsSync(path.join(base, name)) ? base : outputDir();
          } else if (parts.length === 2) {
            const proj = projectFolder.sanitizeProjectName(parts[0]);
            if (!proj || proj !== parts[0]) return null;
            dir = path.join(base, proj);
            name = parts[1];
          } else {
            return null;
          }
          name = path.basename(name);
          if (!name || !VIDEO_EXTS.has(path.extname(name).toLowerCase())) return null;
          const full = path.join(dir, name);
          return (fs.existsSync(full) && fs.statSync(full).isFile()) ? full : null;
        } catch (e) { return null; }
      };

      if (pathname === '/api/output-files' && req.method === 'GET') {
        const dir = outputBaseDir();
        let files = [];
        try {
          if (fs.existsSync(dir)) {
            // (Fix list 2026-10-27, item 1): the listing covers the
            // WHOLE output tree — the base folder's own videos
            // (project '') plus every immediate subfolder's videos
            // with their project name — so History can group by
            // project. Before, only ONE folder was listed (the
            // base, or whichever project subfolder 'download_folder'
            // currently pointed into) and the rest of the tree was
            // invisible on the History page. Each file carries
            // `project` ('' for base files) and `rel`, the
            // base-relative reference the path endpoints accept.
            const scan = (folder, project) => {
              let names = [];
              try { names = fs.readdirSync(folder); } catch (e) { return; }
              for (const name of names) {
                if (!VIDEO_EXTS.has(path.extname(name).toLowerCase())) continue;
                try {
                  const st = fs.statSync(path.join(folder, name));
                  if (!st.isFile()) continue;
                  files.push({
                    name,
                    size: st.size,
                    mtime: st.mtimeMs,
                    project,
                    rel: project ? `${project}/${name}` : name,
                  });
                } catch (e) {}
              }
            };
            scan(dir, '');
            let subdirs = [];
            try {
              subdirs = fs.readdirSync(dir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
            } catch (e) {}
            for (const sub of subdirs) scan(path.join(dir, sub), sub);
            files.sort((a, b) => b.mtime - a.mtime);
          }
        } catch (e) {}
        // v2.34.0 (Problem 7): every file carries its ORIGIN —
        // "flow" when a queue_tasks record proves this app
        // generated it, "local" otherwise — so the History page
        // can badge the two apart instead of mixing them. The
        // evidence is the engine's own download records; a local
        // file never gets a fabricated record (engine/historyOrigin).
        try {
          const records = dbService.getGeneratedFileRecords() || [];
          files = historyOrigin.withOrigins(files, dir, records);
        } catch (e) {
          files = files.map(f => ({ ...f, origin: 'local' }));
        }
        return sendJson(200, { ok: true, files, folder: dir });
      }

      if (pathname === '/api/open-file' && req.method === 'POST') {
        const body = await readBody();
        // Path-confined: a bare file NAME inside the output folder,
        // or one project-qualified "Project/name" reference into
        // the tree — no traversal (see resolveOutputRef).
        const full = resolveOutputRef(body.name);
        if (!full) {
          return sendJson(404, { ok: false, error: 'File not found in the output folder.' });
        }
        exec(`start "" "${full.replace(/"/g, '')}"`);
        return sendJson(200, { ok: true });
      }

      // v2.29.0 (in-app player): resolve one output file's absolute
      // path so the app can play it INSIDE FlowStudio. Same strict
      // confinement as /api/open-file — never an arbitrary path from
      // the caller (bare names and project-qualified references
      // only, see resolveOutputRef).
      if (pathname === '/api/output-file-path' && req.method === 'POST') {
        const body = await readBody();
        const full = resolveOutputRef(body.name);
        if (!full) {
          return sendJson(404, { ok: false, error: 'File not found in the output folder.' });
        }
        return sendJson(200, { ok: true, path: full });
      }

      // v2.41.0 (Fix list C, item 2): return one output file's BYTES
      // (base64) so the MCP connector can fetch a generated video
      // off this PC. Same strict confinement as /api/open-file —
      // resolveOutputRef accepts only a bare file name or one
      // project-qualified "Project/name" reference inside the
      // outputs base folder, so traversal, absolute paths and drive
      // switches can never resolve. A hard 64 MB cap refuses
      // oversized files with a clear error — data is never
      // truncated.
      if (pathname === '/api/output-file-content' && req.method === 'POST') {
        const body = await readBody();
        const full = resolveOutputRef(body.name);
        if (!full) {
          return sendJson(404, { ok: false, error: 'not found' });
        }
        let st;
        try { st = fs.statSync(full); } catch (e) {
          return sendJson(404, { ok: false, error: 'not found' });
        }
        const CAP_BYTES = 64 * 1024 * 1024;
        if (st.size > CAP_BYTES) {
          return sendJson(200, {
            ok: false,
            error: `This file is ${(st.size / (1024 * 1024)).toFixed(1)} MB — over the 64 MB download cap, so it was not sent (nothing is ever truncated). Open it from the output folder on this PC instead.`,
          });
        }
        const mimeByExt = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
        let data;
        try { data = fs.readFileSync(full); } catch (e) {
          return sendJson(404, { ok: false, error: 'not found' });
        }
        // Report the name in the same base-relative form
        // /api/output-files uses ("Project/name" or a bare name).
        let rel = path.relative(outputBaseDir(), full).split(path.sep).join('/');
        if (!rel || rel.startsWith('..')) rel = path.basename(full);
        return sendJson(200, {
          ok: true,
          name: rel,
          sizeBytes: st.size,
          mime: mimeByExt[path.extname(full).toLowerCase()] || 'application/octet-stream',
          dataBase64: data.toString('base64'),
        });
      }

      if (pathname === '/api/open-output-folder' && req.method === 'POST') {
        // The OUTPUT folder is the tree root (the base) — after a
        // project run 'download_folder' points into that project's
        // subfolder, which is not what this button promises.
        const dir = outputBaseDir();
        try {
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        } catch (e) {}
        exec(`start "" "${String(dir).replace(/"/g, '')}"`);
        return sendJson(200, { ok: true });
      }

      // 9. Generation Controls
      // v2.32.2: start a run FROM THE APP SCREEN (MCP tool backend).
      // Unlike /api/generation/start this route NEVER touches the
      // engine: it validates, then asks the Dart app over the existing
      // SSE channel — 'mcp-ui-generate-request' — and the app itself
      // puts the prompts into its Prompts box and presses its own
      // Generate button, so the owner watches the run in the app's
      // Progress section. If the app screen is not connected (no SSE
      // listener) the request cannot be taken and this is a clean
      // refusal — there is deliberately NO engine fallback here.
      if (pathname === '/api/generation/start-ui' && req.method === 'POST') {
        const body = await readBody();
        const prompts = Array.isArray(body.prompts)
          ? body.prompts.filter((p) => typeof p === 'string' && p.trim())
          : [];
        if (prompts.length === 0) {
          return sendJson(400, { ok: false, error: 'prompts must be a non-empty array of non-empty strings' });
        }
        if (activeWorkerPool) {
          return sendJson(400, { ok: false, error: 'A generation run is already active — wait for it to finish before starting a run from the app screen.' });
        }
        if (sseClients.size === 0) {
          return sendJson(400, { ok: false, error: 'The FlowStudio app screen is not connected — open FlowStudio on its main screen, then try again.' });
        }
        const tag = typeof body.tag === 'string' ? body.tag.trim() : '';
        // v2.41.0 (Fix list C, item 1): a project rides along so the
        // app can set its Project field from it before the run starts
        // (lib/main.dart handles it beside the tag). Absent/empty
        // leaves the app's field exactly as it was.
        const project = typeof body.project === 'string' ? body.project.trim() : '';
        broadcastEvent('automation-log', {
          message: `🔌 MCP • Muse started a run from the app screen (${prompts.length} prompts)`,
          level: 'info',
        });
        broadcastEvent('mcp-ui-generate-request', { prompts, tag, project });
        return sendJson(200, { ok: true, started: true, prompts: prompts.length });
      }

      if (pathname === '/api/generation/start' && req.method === 'POST') {
        const config = await readBody();
        if (activeWorkerPool) {
          return sendJson(400, { ok: false, error: 'A generation run is already active' });
        }

        const downloadDir = config.downloadFolder || dbService.getSetting('download_folder', path.join(process.env.FLOW_LITE_DATA_DIR, 'downloads'));
        // v2.33.0 (project folders): a run may carry a project name —
        // its downloads then land in that project's own subfolder of
        // the output folder, never mixed with the general downloads.
        // The EFFECTIVE folder rides the exact same single-source-of-
        // truth below, so the output endpoints enumerate the project
        // folder while it is the most recent run's folder. The name
        // is sanitised to one safe folder name (engine/projectFolder).
        const projectName = projectFolder.sanitizeProjectName(config.project);
        const effectiveDir = projectName ? path.join(downloadDir, projectName) : downloadDir;
        try {
          if (!fs.existsSync(effectiveDir)) fs.mkdirSync(effectiveDir, { recursive: true });
        } catch (e) {}
        // v2.30.0 (single source of truth): record the folder this
        // run is ACTUALLY saving into, so /api/output-files,
        // /api/open-file, /api/output-file-path and
        // /api/open-output-folder enumerate exactly that folder —
        // never a stale setting or the empty fallback again.
        try { dbService.setSetting('download_folder', effectiveDir); } catch (e) {}
        // (Fix list 2026-10-27, item 1): also record the BASE output
        // folder — the folder the app sent, before the project
        // subfolder was joined onto it. History's project listing
        // needs the tree root: 'download_folder' alone points INTO
        // the latest project subfolder after a project run, which
        // hid every other project (and the base files) from History.
        try { dbService.setSetting('download_base_folder', downloadDir); } catch (e) {}
        if (projectName) {
          broadcastEvent('automation-log', {
            message: `Project folder: "${projectName}" — this run's videos will save into their own folder inside the output folder.`,
            level: 'info'
          });
        }

        // v2.33.0: the pool comes from the shared factory (fresh
        // starts and the missing-scene redo get identical wiring).
        // The settings hint is read lazily — onRunStart fires during
        // runQueue, after `settings` below exists.
        const pool = buildPool({
          parallelBrowsers: config.parallelBrowsers || 1,
          accountIds: Array.isArray(config.accountIds) ? config.accountIds : null,
          getSettingsHint: () => settings
        });

        activeWorkerPool = pool;
        broadcastEvent('automation-log', {
          message: `Generation started: ${config.prompts ? config.prompts.length : 0} prompt(s) • ${config.parallelBrowsers || 1} worker(s) in parallel`,
          level: 'info'
        });

        // v2.23.0 diagnostic: record the exact character count of every
        // prompt AS RECEIVED by the bridge, so a prompt that arrives
        // empty is visible in the Activity log itself (the engine's own
        // log line only shows the first 50 characters, which made an
        // empty prompt indistinguishable from a masked one).
        try {
          const counts = (config.prompts || []).map(p => typeof p === 'string' ? p.length : ((p && (p.text || p.prompt) || '').length));
          broadcastEvent('automation-log', { message: `Prompts received by the engine: ${counts.length} prompt(s), characters: [${counts.join(', ')}]`, level: 'info' });
        } catch (e) {}

        // Format prompt items for runQueue.
        // v2.23.2 FIX: the engine's dbService.createBatchTasks reads the
        // item shape { text, tag, index } (index 0-based) — the SAME shape
        // the original Electron main.js passes. The bridge used to emit
        // { prompt_text, prompt_index, prompt_tag }, which createBatchTasks
        // does not read, so every task row was saved with an EMPTY
        // prompt_text and the worker always received an empty prompt
        // (proven live 2026-10-20: bridge logged characters: [6] while the
        // worker failed with "prompt text was EMPTY"). Emit the engine's
        // native shape here.
        const formattedPrompts = (config.prompts || []).map((p, idx) => {
          if (typeof p === 'string') {
            // v2.29.0 (naming truth): a prompt that OPENS with its
            // own tag ("#11-01 …") carries THAT tag — it is what the
            // tag-naming engine saves the file as, and what the
            // Progress card already promises on screen. The run's
            // selected tag is only the fallback for untagged prompts.
            // v2.33.0: the lead now comes from the shared prompt
            // parser — EVERY label family ("Scene 1:", "PROMPT_001:",
            // "1.", "#00-01", …) reaches the task identity, exactly
            // as the app's own parser assigns it. Before, only a
            // leading "#" token was recognised here, so a scene-
            // labelled paste arriving as strings saved fallback
            // names. (A hashtag WORD like "#stormwatch" is not a
            // label any more — digits are required.)
            // v2.34.0 (Problem 5): the label is IDENTITY ONLY — the
            // text handed to Flow is splitLabelPrefix's CLEAN text,
            // so a string prompt's label never rides into the
            // submitted words either.
            const parts = promptParser.splitLabelPrefix(p);
            return { text: parts.text, index: idx, tag: parts.label || config.tag || '' };
          }
          // v2.34.0 (Problem 5): the object path is cleaned the same
          // way — an item whose text still carries its label (an
          // older client, a raw caller) is stripped here, so the
          // task's stored prompt_text is always the clean text Flow
          // will receive. The item's own tag wins; a marker found
          // in the text only fills a missing tag.
          const rawText = p.text || p.prompt || '';
          const parts = promptParser.splitLabelPrefix(rawText);
          return {
            text: parts.text,
            index: Number.isInteger(p.index) ? p.index : idx,
            tag: p.tag || parts.label || config.tag || ''
          };
        });

        // v2.29.0 (naming truth): the engine's file naming reads
        // settings.namingPattern — the bridge used to send only a
        // 'naming' key the engine never reads, so every file fell
        // back to scene001-style names while the UI promised tag
        // names. The selected pattern + tag now reach the engine.
        const namingPattern = config.namingPattern || dbService.getSetting('default_naming', 'tag');
        const settings = {
          model: config.model || dbService.getSetting('default_model', 'Omni Flash'),
          duration: config.duration || dbService.getSetting('default_duration', '4s'),
          aspectRatio: config.aspectRatio || dbService.getSetting('default_aspect', '9:16'),
          quality: config.quality || '720p',
          naming: namingPattern,
          namingPattern: namingPattern,
          customNamingPrefix: config.tag || '',
          // v2.33.0: persisted in every task's settings_json, so a
          // later resume/redo restores the project with the run.
          project: projectName || '',
        };

        // Start asynchronously via runQueue (into the project
        // subfolder when this run carries a project name).
        pool.runQueue(formattedPrompts, settings, effectiveDir).catch(err => {
          broadcastEvent('automation-log', { message: `Generation error: ${err.message}`, level: 'error' });
        }).finally(() => {
          activeWorkerPool = null;
          broadcastEvent('automation-log', { message: 'Generation queue finished.', level: 'success' });
        });

        return sendJson(200, { ok: true });
      }

      // v2.33.0 (missing-scene redo): make ONLY the scenes the last
      // run is missing, into the SAME folder (the project folder
      // when the run had one). The split is sequenceReport.planRedo:
      // scenes whose task is still 'pending' — above all the
      // download-failed ones (pending + needs_check) — re-enter AS
      // THEMSELVES, so the check-only recovery downloads the
      // already-made video and NO new charge can happen; scenes
      // whose generation failed are recreated as fresh rows carrying
      // their ORIGINAL text, tag and index, so the redone scene
      // lands on its own number. Nothing else is re-run, ever.
      if (pathname === '/api/generation/redo-missing' && req.method === 'POST') {
        const body = await readBody();
        if (activeWorkerPool) {
          return sendJson(400, { ok: false, error: 'A generation run is already active' });
        }
        if (!lastRunInfo || !Array.isArray(lastRunInfo.taskIds) || lastRunInfo.taskIds.length === 0) {
          return sendJson(400, { ok: false, error: 'No run to check yet — run a generation first, then Redo Missing knows what to look for.' });
        }
        const rows = lastRunInfo.taskIds
          .map(id => { try { return dbService.getTask(id); } catch (e) { return null; } })
          .filter(Boolean);
        const namingMode = (lastRunInfo.settings && lastRunInfo.settings.namingPattern === 'tag') ? 'tag' : 'other';
        const report = sequenceReport.buildSequenceReport(rows, {
          exists: (p) => fs.existsSync(p),
          namingMode
        });
        if (report.missing.length === 0) {
          return sendJson(200, {
            ok: true,
            started: false,
            missing: 0,
            message: `Nothing is missing — all ${report.total} scene(s) of the last run are saved.`
          });
        }
        const plan = sequenceReport.planRedo(rows, report);
        const redoTasks = [];
        for (const id of plan.existingTaskIds) {
          const row = dbService.getTask(id);
          if (row) redoTasks.push(row);
        }
        if (plan.recreateItems.length > 0) {
          const newBatchId = `batch_${Date.now()}`;
          const created = dbService.createBatchTasks(newBatchId, plan.recreateItems, lastRunInfo.settings || {});
          for (const row of created) redoTasks.push(row);
        }
        if (redoTasks.length === 0) {
          return sendJson(400, { ok: false, error: 'The missing scenes could not be prepared for a redo.' });
        }
        const pool = buildPool({
          parallelBrowsers: body.parallelBrowsers || 1,
          accountIds: Array.isArray(body.accountIds) ? body.accountIds : null,
          getSettingsHint: () => lastRunInfo ? lastRunInfo.settings : {}
        });
        activeWorkerPool = pool;
        broadcastEvent('automation-log', {
          message: `Redo Missing: making only the ${report.missing.length} missing scene(s) — ${report.missing.map(mn => mn.tag).join(', ')}. Scenes that only failed to download will be downloaded again with NO new charge.`,
          level: 'info'
        });
        // Settings stay null on purpose: runQueue's resume branch
        // restores them from the tasks' own settings_json (project
        // folder, naming pattern and all).
        pool.runQueue([], null, lastRunInfo.downloadFolder, { existingTasks: redoTasks }).catch(err => {
          broadcastEvent('automation-log', { message: `Generation error: ${err.message}`, level: 'error' });
        }).finally(() => {
          activeWorkerPool = null;
          broadcastEvent('automation-log', { message: 'Generation queue finished.', level: 'success' });
        });
        return sendJson(200, { ok: true, started: true, missing: report.missing.length });
      }

      if (pathname === '/api/generation/pause' && req.method === 'POST') {
        if (activeWorkerPool) {
          activeWorkerPool.pause();
          broadcastEvent('automation-log', { message: 'Generation paused by user.', level: 'warning' });
        }
        return sendJson(200, { ok: true });
      }

      if (pathname === '/api/generation/resume' && req.method === 'POST') {
        if (activeWorkerPool) {
          activeWorkerPool.resume();
          broadcastEvent('automation-log', { message: 'Generation resumed.', level: 'info' });
        }
        return sendJson(200, { ok: true });
      }

      if (pathname === '/api/generation/stop' && req.method === 'POST') {
        if (activeWorkerPool) {
          await activeWorkerPool.stop();
          activeWorkerPool = null;
          broadcastEvent('automation-log', { message: 'Generation stopped.', level: 'warning' });
        }
        return sendJson(200, { ok: true });
      }

      // v2.41.0 (Fix list C, item 3): let the app record one of ITS
      // OWN steps (an app update, say) into the same Activity store
      // the engine writes to, so the record survives in one place.
      // Category is pinned to 'system' — this route exists for
      // app-side lifecycle events, not generation bookkeeping.
      if (pathname === '/api/activity/log' && req.method === 'POST') {
        const body = await readBody();
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message) {
          return sendJson(400, { ok: false, error: 'message is required' });
        }
        const level = ['info', 'success', 'warn', 'warning', 'error'].includes(body.level) ? body.level : 'info';
        try { recordActivity({ message, category: 'system', level }); } catch (e) {}
        return sendJson(200, { ok: true });
      }

      // v2.41.0 (Fix list C, item 3): clean engine shutdown, called
      // by the app right before it installs an update. This process
      // hosts BOTH the bridge API and the MCP server, and it is the
      // Flutter app's child — a child the app historically never
      // stopped on its update path (it exit()ed directly, and
      // dispose(), the only engine kill, never ran). On Windows the
      // child then outlived the app, kept both ports, and held the
      // install folder's files against the Inno installer — the
      // relaunched app's health check was answered by the OLD
      // process, so every in-app update "came back" on the old
      // version. Here the engine closes itself properly; the app
      // still kills the child as a guarantee and waits for the
      // health endpoint to stop answering before installing.
      if (pathname === '/api/engine/shutdown' && req.method === 'POST') {
        sendJson(200, { ok: true, note: 'Engine shutting down.' });
        setTimeout(() => {
          try { recordActivity({ message: 'Engine shutting down for an app update.', category: 'system', level: 'info' }); } catch (e) {}
          try { mcp.stopMcpServer(); } catch (e) {}
          try { server.close(); } catch (e) {}
          process.exit(0);
        }, 200);
        return;
      }

      // 10. Recent Activity & Logs
      if (pathname === '/api/activity' && req.method === 'GET') {
        // v2.32.0 repair: this route used to read
        // dbService.getRecentActivity, which does not exist — it
        // silently answered an empty list forever. The real Activity
        // data lives in the activity store (the same store the
        // engine records generation, login, credit and error events
        // into). Entries come back newest-first; ?limit= (default
        // 100, max 500) and ?category= (generation | credits |
        // login | errors | system | all) narrow the list.
        const limitRaw = parseInt(reqUrl.searchParams.get('limit') || '', 10);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 100;
        const category = reqUrl.searchParams.get('category') || 'all';
        let activities = [];
        try {
          activities = getActivityStore().list({ category, limit });
        } catch (e) {}
        return sendJson(200, { ok: true, activities });
      }

      // Default 404
      sendJson(404, { error: 'Not Found' });
    } catch (err) {
      console.error('[FlowStudio Engine Error]', err);
      sendJson(500, { ok: false, error: err.message });
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[FlowStudio Engine Bridge] Listening on http://127.0.0.1:${PORT}`);
  });
}

startBridge().catch(err => {
  console.error('[FlowStudio Bridge Fatal]', err);
});
