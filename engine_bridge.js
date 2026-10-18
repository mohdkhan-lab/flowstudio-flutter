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
        return sendJson(200, { ok: true, version: '2.22.1', workers: activeWorkerPool ? 1 : 0 });
      }

      // 3. Settings Endpoints
      if (pathname === '/api/settings' && req.method === 'GET') {
        const keys = [
          'appearance', 'default_model', 'default_duration', 'default_aspect',
          'default_naming', 'default_quality', 'custom_tags', 'download_folder', 'chrome_path',
          'browser_background', 'show_browsers', 'preview_autoplay', 'auto_verify_start', 'auto_check_updates',
          'social_links', 'live_only_accounts'
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

        // v2.22.1 duplicate guard: same cookies again → re-check the
        // existing account, never add a second copy of it.
        let fp = null;
        try { fp = cookieFingerprint(fs.readFileSync(body.filePath, 'utf8')); } catch (e) {}
        if (fp) {
          const existingId = loadFingerprints()[fp];
          if (existingId && dbService.getAccount(existingId)) {
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
        });
        if (res.account) {
          if (fp) {
            const map = loadFingerprints();
            map[fp] = res.account.id;
            saveFingerprints(map);
          }
          mergeDuplicateByEmail(res.account);
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

        // v2.22.1 duplicate guard (same as the file path above).
        const fp = typeof body.text === 'string' ? cookieFingerprint(body.text) : null;
        if (fp) {
          const existingId = loadFingerprints()[fp];
          if (existingId && dbService.getAccount(existingId)) {
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
        });
        if (res.account) {
          if (fp) {
            const map = loadFingerprints();
            map[fp] = res.account.id;
            saveFingerprints(map);
          }
          mergeDuplicateByEmail(res.account);
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
          onLog: (msg, type) => broadcastEvent('automation-log', { message: msg, level: type }),
          onProgress: (data) => broadcastEvent('automation-progress', data),
          onVideoCompleted: (data) => broadcastEvent('video-completed', data),
          onAccountUpdated: (data) => broadcastEvent('account-updated', data),
        });

        activeWorkerPool = pool;
        broadcastEvent('automation-log', {
          message: `Generation started: ${config.prompts ? config.prompts.length : 0} prompt(s) • ${config.parallelBrowsers || 1} worker(s) in parallel`,
          level: 'info'
        });

        // Format prompt items for runQueue
        const formattedPrompts = (config.prompts || []).map((p, idx) => {
          if (typeof p === 'string') {
            return { prompt_text: p, prompt_index: idx + 1, prompt_tag: config.tag || '' };
          }
          return {
            prompt_text: p.text || '',
            prompt_index: p.index || (idx + 1),
            prompt_tag: p.tag || config.tag || ''
          };
        });

        const settings = {
          model: config.model || dbService.getSetting('default_model', 'Omni Flash'),
          duration: config.duration || dbService.getSetting('default_duration', '4s'),
          aspectRatio: config.aspectRatio || dbService.getSetting('default_aspect', '9:16'),
          quality: config.quality || '720p',
          naming: dbService.getSetting('default_naming', 'tag'),
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
