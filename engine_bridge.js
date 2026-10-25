const http = require('http');
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
const { recordActivity } = require('./engine/activityStore');
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
let activeWorkerPool = null;
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

async function startBridge() {
  await dbService.ensureInit();
  console.log(`[FlowStudio Engine] Database initialized. Running on port ${PORT}...`);

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
        return sendJson(200, { ok: true, version: '2.30.2', workers: activeWorkerPool ? 1 : 0 });
      }

      // 3. Settings Endpoints
      if (pathname === '/api/settings' && req.method === 'GET') {
        const keys = [
          'appearance', 'theme', 'default_model', 'default_duration', 'default_aspect',
          'default_naming', 'default_quality', 'custom_tags', 'download_folder', 'chrome_path',
          'browser_background', 'show_browsers', 'preview_autoplay', 'auto_verify_start', 'auto_check_updates',
          'social_links', 'live_only_accounts', 'history_cleared',
          // v2.29.0: the sidebar's source-numbering aliases
          // (account id -> { alias, source }) and the persisted
          // parallel-browsers count.
          'account_aliases', 'parallel_browsers'
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
      const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm']);

      if (pathname === '/api/output-files' && req.method === 'GET') {
        const dir = outputDir();
        let files = [];
        try {
          if (fs.existsSync(dir)) {
            files = fs.readdirSync(dir)
              .filter(name => VIDEO_EXTS.has(path.extname(name).toLowerCase()))
              .map(name => {
                try {
                  const st = fs.statSync(path.join(dir, name));
                  if (!st.isFile()) return null;
                  return { name, size: st.size, mtime: st.mtimeMs };
                } catch (e) { return null; }
              })
              .filter(Boolean)
              .sort((a, b) => b.mtime - a.mtime);
          }
        } catch (e) {}
        return sendJson(200, { ok: true, files, folder: dir });
      }

      if (pathname === '/api/open-file' && req.method === 'POST') {
        const body = await readBody();
        // Path-confined: only a bare file NAME inside the output
        // folder can be opened — no separators, no traversal.
        const name = path.basename(String(body.name || ''));
        if (!name || !VIDEO_EXTS.has(path.extname(name).toLowerCase())) {
          return sendJson(400, { ok: false, error: 'Invalid file name.' });
        }
        const full = path.join(outputDir(), name);
        if (!fs.existsSync(full)) {
          return sendJson(404, { ok: false, error: 'File not found in the output folder.' });
        }
        exec(`start "" "${full.replace(/"/g, '')}"`);
        return sendJson(200, { ok: true });
      }

      // v2.29.0 (in-app player): resolve one output file's absolute
      // path so the app can play it INSIDE FlowStudio. Same strict
      // confinement as /api/open-file — a bare file NAME inside the
      // output folder only, never a path from the caller.
      if (pathname === '/api/output-file-path' && req.method === 'POST') {
        const body = await readBody();
        const name = path.basename(String(body.name || ''));
        if (!name || !VIDEO_EXTS.has(path.extname(name).toLowerCase())) {
          return sendJson(400, { ok: false, error: 'Invalid file name.' });
        }
        const full = path.join(outputDir(), name);
        if (!fs.existsSync(full)) {
          return sendJson(404, { ok: false, error: 'File not found in the output folder.' });
        }
        return sendJson(200, { ok: true, path: full });
      }

      if (pathname === '/api/open-output-folder' && req.method === 'POST') {
        const dir = outputDir();
        try {
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        } catch (e) {}
        exec(`start "" "${String(dir).replace(/"/g, '')}"`);
        return sendJson(200, { ok: true });
      }

      // 9. Generation Controls
      if (pathname === '/api/generation/start' && req.method === 'POST') {
        const config = await readBody();
        if (activeWorkerPool) {
          return sendJson(400, { ok: false, error: 'A generation run is already active' });
        }

        const downloadDir = config.downloadFolder || dbService.getSetting('download_folder', path.join(process.env.FLOW_LITE_DATA_DIR, 'downloads'));
        try {
          if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
        } catch (e) {}
        // v2.30.0 (single source of truth): record the folder this
        // run is ACTUALLY saving into, so /api/output-files,
        // /api/open-file, /api/output-file-path and
        // /api/open-output-folder enumerate exactly that folder —
        // never a stale setting or the empty fallback again.
        try { dbService.setSetting('download_folder', downloadDir); } catch (e) {}

        // v2.22.0 fix: browser visibility comes from the engine's own
        // 'browser_background' setting — the SAME key the original
        // Electron main.js uses ('1' or unset = background ON, '0' =
        // visible). The WorkerPool "headless" option is the background
        // flag (headed Chrome parked off-screen, never true headless).
        // The old bridge read the unrelated 'show_browsers' key and
        // inverted it, so the UI toggle did the opposite of its label.
        const backgroundSetting = dbService.getSetting('browser_background', '1');
        const headless = backgroundSetting !== '0';

        const pool = new WorkerPool({
          concurrency: config.parallelBrowsers || 1,
          headless: headless,
          liveOnly: dbService.getSetting('live_only_accounts', '0') === '1',
          // v2.29.0 (checkbox truth): the sidebar's ticked account
          // IDs from the generate request — the pool may use ONLY
          // these. Absent (old callers) = no restriction.
          allowedAccountIds: Array.isArray(config.accountIds) ? config.accountIds : null,
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
          onAccountUpdated: (data) => broadcastEvent('account-updated', data),
          // v2.25.0 (parked browser): the pool announces which accounts
          // have a live generation browser (+ window shown/parked) —
          // the sidebar renders ACTIVE + the Show/Hide toggle from it.
          onActiveBrowsersChanged: (list) => broadcastEvent('active-browsers', { accounts: list }),
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
            const lead = p.trimStart().startsWith('#')
              ? p.trimStart().split(/\s+/)[0]
              : '';
            return { text: p, index: idx, tag: lead || config.tag || '' };
          }
          return {
            text: p.text || p.prompt || '',
            index: Number.isInteger(p.index) ? p.index : idx,
            tag: p.tag || config.tag || ''
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
        };

        // Start asynchronously via runQueue
        pool.runQueue(formattedPrompts, settings, downloadDir).catch(err => {
          broadcastEvent('automation-log', { message: `Generation error: ${err.message}`, level: 'error' });
        }).finally(() => {
          activeWorkerPool = null;
          broadcastEvent('automation-log', { message: 'Generation queue finished.', level: 'success' });
        });

        return sendJson(200, { ok: true });
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

      // 10. Recent Activity & Logs
      if (pathname === '/api/activity' && req.method === 'GET') {
        const activities = dbService.getRecentActivity ? dbService.getRecentActivity(100) : [];
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
