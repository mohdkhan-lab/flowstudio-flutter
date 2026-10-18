const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const { getChromeExecutablePath, getChromeUserDataDir } = require('./chromePaths');
const { checkProfileBusyAsync, killProcessesByPid } = require('./processHelper');
const liveBrowsers = require('./liveBrowsers');
const { ensureBackgroundModeOff } = require('./profilePrefs');
const { buildProfileWorkingCopy, removeProfileWorkingCopy } = require('./profileCopy');
const { dbService } = require('./db');
const { getCreditService } = require('./creditService');
const { assertAccountId, assertChromeProfileDirName } = require('./pathSecurity');
const { recordActivity } = require('./activityStore');
const { getCookieStore } = require('./cookieStore');

/**
 * FlowStudio Lite — account storage.
 *
 * One dedicated Chrome profile per account under profiles/<id>; login once
 * and the session is saved forever. Accounts live ONLY in SQLite (dbService)
 * — there is no accounts.json mirror (audit fix #4). Credit balances and
 * account status are written exclusively through creditService; this module
 * only writes identity/profile fields via targeted single-row updates.
 */

const PROFILES_DIR = process.env.FLOW_LITE_PROFILES_DIR
  ? path.resolve(process.env.FLOW_LITE_PROFILES_DIR)
  : path.join(__dirname, '..', 'profiles');
if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

function getAccounts() {
  const list = dbService.getAccounts();
  return Array.isArray(list) ? list : [];
}

function getAccountProfilePath(accountId) {
  assertAccountId(accountId);
  const profilePath = path.join(PROFILES_DIR, accountId);
  if (!fs.existsSync(profilePath)) {
    fs.mkdirSync(profilePath, { recursive: true });
  }
  return profilePath;
}

function addAccount(customName, customEmail) {
  const accounts = getAccounts();
  const id = `acc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const name = customName && customName.trim() ? customName.trim() : `Google Account ${accounts.length + 1}`;
  // v2.2.0: the Add modal's OPTIONAL email (the owner may type it, or
  // leave it empty — the real Google identity still comes from the
  // live login/sync, never from what was typed here).
  const email = customEmail && String(customEmail).trim() ? String(customEmail).trim() : '';

  const accountDir = path.join(PROFILES_DIR, id);
  if (!fs.existsSync(accountDir)) {
    fs.mkdirSync(accountDir, { recursive: true });
  }
  // v1.3: app-owned profiles never keep Chrome alive in the background —
  // closing the Sign In window must fully release the profile.
  ensureBackgroundModeOff(accountDir);

  const created = dbService.insertAccount({
    id,
    name,
    email,
    googleName: name,
    dirName: id,
    selected: true,
    status: 'Need Login',
    credits: null,
    proxyUrl: ''
  });
  return { account: created, accounts: getAccounts() };
}

function deleteAccount(id) {
  assertAccountId(id);
  dbService.deleteAccount(id);
  const accountDir = path.join(PROFILES_DIR, id);
  if (fs.existsSync(accountDir)) {
    try { fs.rmSync(accountDir, { recursive: true, force: true }); } catch (e) {}
  }
  // v2.0.0: saved cookies die with the account.
  try { getCookieStore().deleteSaved(id); } catch (e) {}
  return getAccounts();
}

/**
 * Open a REAL interactive Chrome window (no automation flags) on the
 * account's dedicated profile so the user can sign in once. A Preferences
 * poll detects the signed-in email; on window close a live credit sync runs.
 */
async function openLoginWindow(accountId, onLoggedInCallback) {
  assertAccountId(accountId);
  const chromePath = getChromeExecutablePath(dbService.getSetting('chrome_path', ''));
  const profilePath = getAccountProfilePath(accountId);

  // v1.1: fail VISIBLY when Chrome cannot be found — previously a bad path
  // made spawn() fail asynchronously and the error went only to the
  // console, so the user clicked Sign In and "nothing happened".
  if (!chromePath || !fs.existsSync(chromePath)) {
    return { success: false, error: `Google Chrome was not found (looked for: ${chromePath || 'no path'}). Install Google Chrome, then click Sign In again.` };
  }

  // v1.4 (deep audit): the reclaim-aware async check. The old SYNC lock
  // heuristic let the app's own leftover Sign In Chrome (invisible, in
  // background mode) refuse every later Sign In — the corpse blocked its
  // own cure. The async check terminates such unregistered leftovers of
  // this app's profiles and proceeds; it only refuses when a browser
  // the app is actively using holds the profile right now.
  // v1.6.0 (owner's standing order: "koi open ha to us ka koi farak
  // nahi pada, ye barabar chalta raha"): Sign In NEVER waits on another
  // app-owned browser. A Sign In window already open for this account
  // is closed and replaced by a fresh one; a running credit check is
  // closed too. Only a live GENERATION on this profile still blocks
  // (two Flow sessions in one profile would corrupt each other).
  const busy = await checkProfileBusyAsync(profilePath, accountId, { reclaimLogin: true });
  if (busy.healedBy === 'reclaim' && busy.killedPids) {
    console.log(`[Login] Cleared ${busy.killedPids.length} app Chrome process(es) (PID ${busy.killedPids.join(', ')}) that were holding this account's profile — Sign In aage badha.`);
  }
  if (busy.busy) {
    if (busy.reason === 'in-use') {
      return { success: false, profileBusy: true, error: 'A video is generating on this account right now. Press Sign In once it finishes.' };
    }
    const pidNote = busy.holderPids && busy.holderPids.length ? ` (PID ${busy.holderPids.join(', ')})` : '';
    return { success: false, profileBusy: true, error: `An old Chrome${pidNote} is holding this profile and could not be cleared automatically. End that chrome.exe in Task Manager (Ctrl+Shift+Esc), then press Sign In.` };
  }

  // v1.3: the busy check passed, so no Chrome holds this profile right
  // now — safe to pin background mode OFF before the window opens, so
  // closing it later fully exits Chrome instead of lingering invisibly.
  ensureBackgroundModeOff(profilePath);

  const args = [
    `--user-data-dir=${profilePath}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://flow.google.com/'
  ];

  try {
    const proc = spawn(chromePath, args, { detached: false });
    // v1.4: register the Sign In window so the reclaim logic knows this
    // Chrome is legitimately live (and so app-quit can close it instead
    // of leaving another invisible leftover behind).
    liveBrowsers.register(accountId, proc.pid, 'login');
    let pollInterval = null;
    let pollCount = 0;
    let spawnFailed = false;

    const checkLoginStatus = () => {
      try {
        const prefPath = path.join(profilePath, 'Default', 'Preferences');
        if (fs.existsSync(prefPath)) {
          const prefData = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
          const info = prefData.account_info;
          if (Array.isArray(info) && info.length > 0 && info[0].email) {
            const accInfo = info[0];
            const res = getCreditService().applyLoginDetected(accountId, {
              email: accInfo.email,
              googleName: accInfo.given_name || accInfo.full_name || accInfo.email.split('@')[0]
            });
            if (onLoggedInCallback) {
              onLoggedInCallback({ success: true, account: res.account, accounts: getAccounts() });
            }
            return true;
          }
        }
      } catch (e) {}
      return false;
    };

    pollInterval = setInterval(() => {
      pollCount++;
      if (pollCount > 120) { // stop polling after ~5 minutes
        clearInterval(pollInterval);
        return;
      }
      if (checkLoginStatus()) clearInterval(pollInterval);
    }, 2500);

    proc.on('close', async () => {
      // v1.6.0: if this window's registration is already gone, it was
      // closed BY A RECLAIM (v1.5.1+/v1.6 flows unregister killed PIDs)
      // — the reclaiming flow is doing its own work, so this handler
      // must NOT auto-sync (its check could kill the window/process
      // that just replaced this one). A normal user close is still
      // registered at this point and auto-syncs as before.
      const wasRegistered = liveBrowsers.isRegistered(accountId, proc.pid);
      liveBrowsers.unregister(accountId, proc.pid);
      if (pollInterval) clearInterval(pollInterval);
      if (!wasRegistered) return;
      if (spawnFailed) return; // the error was already surfaced; don't mask it with a "success"
      // Chrome closed -> profile locks are free; sync live credits now.
      try {
        const res = await fetchRealCredits(accountId);
        if (onLoggedInCallback) {
          onLoggedInCallback({
            success: true,
            account: (res && res.account) || dbService.getAccount(accountId),
            accounts: getAccounts()
          });
        }
      } catch (e) {
        if (onLoggedInCallback) {
          onLoggedInCallback({ success: true, account: dbService.getAccount(accountId), accounts: getAccounts() });
        }
      }
    });

    proc.on('error', (err) => {
      liveBrowsers.unregister(accountId, proc.pid);
      // v1.1: surface spawn failures on the account card, not just console.
      spawnFailed = true;
      console.error('Chrome spawn error:', err);
      if (pollInterval) clearInterval(pollInterval);
      if (onLoggedInCallback) {
        onLoggedInCallback({ success: false, accountId, error: `Could not open Chrome: ${err.message}` });
      }
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * List the Google Chrome profiles installed on this PC (from Local State),
 * for the 1-click import feature.
 */
function getInstalledChromeProfiles() {
  const chromeUserData = getChromeUserDataDir();
  const localStatePath = path.join(chromeUserData, 'Local State');
  if (!fs.existsSync(localStatePath)) return [];

  try {
    const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
    const infoCache = localState.profile ? localState.profile.info_cache : {};
    const profiles = [];

    for (const [dirName, p] of Object.entries(infoCache)) {
      let email = p.user_name || p.email || '';
      let gaiaName = p.gaia_name || p.gaia_given_name || '';

      if (!email) {
        try {
          const prefPath = path.join(chromeUserData, dirName, 'Preferences');
          if (fs.existsSync(prefPath)) {
            const pref = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
            if (pref.account_info && Array.isArray(pref.account_info) && pref.account_info[0]) {
              email = pref.account_info[0].email || '';
              if (!gaiaName) gaiaName = pref.account_info[0].full_name || '';
            }
          }
        } catch (pe) {}
      }

      profiles.push({ dirName, name: p.name || dirName, email, gaiaName: gaiaName || p.name || dirName });
    }
    return profiles;
  } catch (err) {
    console.error('[Error reading Chrome profiles]:', err.message);
    return [];
  }
}

/**
 * 1-click import: copy an installed Chrome profile's session files into a
 * dedicated Lite profile so the account arrives already signed in.
 */
async function importFromInstalledChrome(srcProfileDirName, destAccountId) {
  assertChromeProfileDirName(srcProfileDirName);
  if (destAccountId) assertAccountId(destAccountId);
  await dbService.ensureInit();

  const chromeUserData = getChromeUserDataDir();
  const srcDir = path.join(chromeUserData, srcProfileDirName);
  if (!fs.existsSync(srcDir)) {
    throw new Error(`Chrome profile "${srcProfileDirName}" not found at: ${srcDir}`);
  }

  const profiles = getInstalledChromeProfiles();
  const matched = profiles.find(p => p.dirName === srcProfileDirName);

  let accounts = getAccounts();
  let acc = null;
  if (destAccountId) acc = accounts.find(a => a.id === destAccountId);
  if (!acc && matched && matched.email) {
    acc = accounts.find(a => a.email && a.email.toLowerCase().trim() === matched.email.toLowerCase().trim());
    if (acc) destAccountId = acc.id;
  }
  if (!acc && matched && matched.dirName) {
    acc = accounts.find(a => a.chromeProfileDir === matched.dirName);
    if (acc) destAccountId = acc.id;
  }
  if (!acc) {
    const uniqueId = `acc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const displayName = matched
      ? (matched.gaiaName || (matched.email ? matched.email.split('@')[0] : `Google Account ${accounts.length + 1}`))
      : `Google Account ${accounts.length + 1}`;
    const accountDir = path.join(PROFILES_DIR, uniqueId);
    if (!fs.existsSync(accountDir)) fs.mkdirSync(accountDir, { recursive: true });
    acc = dbService.insertAccount({
      id: uniqueId,
      name: displayName,
      email: (matched && matched.email) || '',
      googleName: (matched && (matched.gaiaName || matched.name)) || displayName,
      dirName: uniqueId,
      selected: true,
      status: 'Need Login', // proven by the first Sync; credits stay unknown (null) until then
      credits: null,
      proxyUrl: '',
      chromeProfileDir: srcProfileDirName,
      lastChecked: 'Imported from Chrome'
    });
    accounts = getAccounts();
    destAccountId = acc.id;
  }

  const destDir = path.join(PROFILES_DIR, destAccountId, 'Default');
  const destRoot = path.join(PROFILES_DIR, destAccountId);

  const busy = await checkProfileBusyAsync(destRoot, destAccountId);
  if (busy.busy) {
    return { success: false, profileBusy: true, error: 'Target profile is open in Chrome. Close it and import again.', accounts: getAccounts() };
  }
  fs.mkdirSync(destDir, { recursive: true });

  // Local State is required so cookie decryption succeeds for this Windows user.
  const srcLocalState = path.join(chromeUserData, 'Local State');
  if (fs.existsSync(srcLocalState)) {
    try { fs.copyFileSync(srcLocalState, path.join(destRoot, 'Local State')); } catch (e) {}
  }

  const itemsToCopy = ['Network/Cookies', 'Cookies', 'Login Data', 'Web Data', 'Preferences', 'Secure Preferences'];
  let cookiesLocked = false;
  for (const item of itemsToCopy) {
    const s = path.join(srcDir, item);
    const d = path.join(destDir, item);
    if (fs.existsSync(s)) {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      try {
        fs.copyFileSync(s, d);
      } catch (e) {
        if ((e.code === 'EBUSY' || (e.message && e.message.includes('busy or locked'))) && item.includes('Cookies')) {
          cookiesLocked = true;
        }
        console.warn(`[Copy warning for ${item}]:`, e.message);
      }
    }
  }

  // v1.3: the imported Preferences may carry the user's main-Chrome
  // background-mode setting; app-owned profiles always run with it OFF.
  ensureBackgroundModeOff(destRoot);

  if (acc) {
    const fields = { lastChecked: cookiesLocked ? 'Imported from Chrome (Cookies Locked)' : 'Imported from Chrome' };
    if (matched) {
      if (matched.email) fields.email = matched.email;
      if (matched.gaiaName || matched.name) fields.googleName = matched.gaiaName || matched.name;
      fields.chromeProfileDir = srcProfileDirName;
    }
    dbService.updateAccountFields(acc.id, fields);
    acc = dbService.getAccount(acc.id);
  }

  if (acc) {
    recordActivity({
      category: 'login', level: 'info', accountId: acc.id,
      accountName: acc.googleName || acc.name,
      message: `Chrome profile import: ${acc.googleName || acc.name}${cookiesLocked ? ' (cookies were locked — verify with Sync)' : ''}`
    });
  }
  return { success: true, account: acc, accounts: getAccounts(), cookiesLocked };
}

async function importAllInstalledChromeProfiles() {
  await dbService.ensureInit();
  const profiles = getInstalledChromeProfiles();
  if (!profiles || profiles.length === 0) {
    return { success: false, error: 'No Google Chrome profiles detected on this machine.', totalFound: 0, importedCount: 0, accounts: getAccounts() };
  }

  const results = [];
  for (const prof of profiles) {
    try {
      const res = await importFromInstalledChrome(prof.dirName);
      results.push({ dirName: prof.dirName, email: prof.email, name: prof.gaiaName || prof.name, success: res.success, cookiesLocked: res.cookiesLocked, account: res.account, error: res.error });
    } catch (err) {
      results.push({ dirName: prof.dirName, email: prof.email, name: prof.gaiaName || prof.name, success: false, error: err.message });
    }
  }

  return {
    success: true,
    totalFound: profiles.length,
    importedCount: results.filter(r => r.success).length,
    results,
    accounts: getAccounts()
  };
}

/**
 * v1.4.1: close a Puppeteer check browser with a hard bound. On an
 * unresponsive page browser.close() can hang forever — and a hung close
 * would leave the browser holding the profile AND its registry entry
 * forever, blocking every later Sync/Generate as "in use". If the close
 * does not settle in 5s, terminate OUR check browser by PID instead.
 */
async function closeCheckBrowser(browser, pid) {
  if (!browser) return;
  let closed = false;
  try {
    await Promise.race([
      browser.close().then(() => { closed = true; }),
      new Promise((r) => setTimeout(r, 5000))
    ]);
  } catch (e) { closed = true; }
  if (!closed && pid) {
    try { await killProcessesByPid([pid]); } catch (e) {}
  }
}

const activeCreditFetches = new Map();

/**
 * Fetch the REAL credit balance from the live Google Flow page (headless
 * visit on the account's own profile). Concurrent calls for the same
 * account are deduped. All credit/status outcomes are applied through
 * creditService — audit fixes #2/#3:
 *  - explicit signin redirect  -> 'Need Login', balance PRESERVED
 *  - live numeric balance      -> balance + Ready/Exhausted
 *  - inconclusive page          -> NOTHING changes ('unknown')
 */
async function fetchRealCredits(accountId) {
  assertAccountId(accountId);
  if (activeCreditFetches.has(accountId)) {
    return activeCreditFetches.get(accountId);
  }

  const fetchPromise = (async () => {
    await dbService.ensureInit();
    const creditService = getCreditService();
    const target = dbService.getAccount(accountId);
    if (!target) return { success: false, error: 'Account not found', accounts: getAccounts() };

    const chromePath = getChromeExecutablePath(dbService.getSetting('chrome_path', ''));
    const profilePath = getAccountProfilePath(accountId);

    // v1.6.0: Sync also never waits on an app-owned browser — if the
    // account's Sign In window is open (the normal "I've logged in —
    // Done" moment included) or another check is running, the check
    // reclaims the profile and proceeds on the REAL profile instead of
    // dying on a locked working copy. Only a live generation blocks.
    const busy = await checkProfileBusyAsync(profilePath, accountId, { reclaimLogin: true });
    if (busy.healedBy === 'reclaim' && busy.killedPids) {
      console.log(`[Credits] Cleared ${busy.killedPids.length} leftover app Chrome process(es) (PID ${busy.killedPids.join(', ')}) that were holding ${target.name}'s profile.`);
    }

    // v1.3 — busy is no longer a dead end for this READ-ONLY check. The
    // async check above already self-healed stale locks and cleared the
    // app's own orphaned automation Chrome; if the profile is STILL busy,
    // a real interactive Chrome (untouchable by policy) holds it. Sync
    // then runs against a throwaway WORKING COPY of the profile and the
    // copy is deleted afterwards — see profileCopy.js for why reads are
    // safe on a copy while generation must never use one. Only when the
    // copy itself cannot be built (e.g. the Cookies DB is locked even
    // for reading) do we surface the honest busy message.
    let effectiveProfilePath = profilePath;
    let workingCopyDir = null;
    if (busy.busy) {
      try {
        workingCopyDir = path.join(dbService.getDataDir(), 'temp-profile-work', accountId);
        await buildProfileWorkingCopy(profilePath, workingCopyDir);
        effectiveProfilePath = workingCopyDir;
      } catch (copyErr) {
        console.warn(`[Credits] Working-copy fallback failed for ${target.name}:`, copyErr.message);
        workingCopyDir = null;
        return {
          success: false,
          chromeOpen: true,
          error: busy.reason === 'in-use'
            ? 'Another job is running on this account (Sync or generation). Press Sync again once it finishes.'
            : 'Google Chrome is currently open for this profile. Please close that Chrome window, then click Sync again.',
          accounts: getAccounts()
        };
      }
    }

    try {
      return await runLiveCheck(effectiveProfilePath, workingCopyDir !== null);
    } finally {
      if (workingCopyDir) await removeProfileWorkingCopy(workingCopyDir);
    }

    async function runLiveCheck(userDataDir, isWorkingCopy) {
    let browser = null;
    let checkPid = null;
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        executablePath: chromePath,
        userDataDir,
        defaultViewport: { width: 1920, height: 1080 },
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1920,1080'
        ],
        ignoreDefaultArgs: ['--enable-automation']
      });
      // v1.4: register this check browser as legitimately live so the
      // reclaim logic never mistakes it for a leftover. Kind 'check'
      // (v1.4.1) — short-lived, watchdog-protected.
      try { checkPid = browser.process() ? browser.process().pid : null; } catch (e) {}
      if (checkPid) liveBrowsers.register(accountId, checkPid, 'check');

      const page = await browser.newPage();
      await page.goto('https://flow.google.com/', { waitUntil: 'domcontentloaded', timeout: 35000 });
      await new Promise(r => setTimeout(r, 4000));

      let curUrl = page.url();

      // Landing page -> enter the studio
      if (curUrl.includes('/about')) {
        try {
          const clicked = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
            const createBtn = btns.find(b => {
              const txt = (b.innerText || b.textContent || '').trim();
              return txt.includes('Create with Google Flow') || txt.includes('Try in Google Flow') || txt.includes('Get started') || txt.includes('Launch Flow');
            });
            if (createBtn) { createBtn.click(); return true; }
            return false;
          });
          if (clicked) {
            await new Promise(r => setTimeout(r, 5000));
            curUrl = page.url();
          }
        } catch (e) {}
      }

      // Explicit sign-in redirect — the ONLY sign-out signal (fix #3),
      // now TWO-STRIKE (v1.8.0, ZDola double-confirm): the first
      // observation marks the account 'Unconfirmed'; only a second
      // explicit redirect inside 24h confirms 'Need Login'. The balance
      // is preserved either way.
      if (curUrl.includes('accounts.google.com') || curUrl.includes('/signin')) {
        await closeCheckBrowser(browser, checkPid);
        browser = null;
        const res = creditService.applySignOutObservation(accountId);
        const accName = res.account ? (res.account.googleName || res.account.name) : 'Account';
        recordActivity({
          category: 'login',
          level: res.outcome === 'need-login' ? 'error' : 'warn',
          accountId, accountName: accName,
          message: res.outcome === 'need-login'
            ? `Sign-out confirmed: ${accName} — Need Login (two strikes)`
            : `Sign-out seen (strike 1): ${accName} — Unconfirmed, balance is safe`
        });
        return {
          success: false,
          explicitSignedOut: true,
          signOutConfirmed: res.outcome === 'need-login',
          error: res.outcome === 'need-login'
            ? 'Google login required. Please click "Sign In" on the account card to log in.'
            : 'Google login could not be confirmed (first sign-out seen). Sync once more to confirm, or click "Sign In" if you know this account is logged out.',
          account: res.account,
          accounts: getAccounts()
        };
      }

      const result = await page.evaluate(async () => {
        try {
          let panelEmail = null;
          let panelName = null;
          let parsedCredits = null;

          const targetBtn = document.querySelector('.header-user-button, [aria-label*="Account details" i], [aria-label*="account" i], [aria-label*="Google Account" i], .gb_C');
          if (targetBtn) {
            try {
              targetBtn.click();
              await new Promise(r => setTimeout(r, 1200));
              const panel = document.querySelector('flow-account-panel, [role="dialog"], div[class*="account-panel"], div[class*="profile-menu"]');
              if (panel) {
                const text = panel.innerText || panel.textContent || '';
                const match = text.match(/([\d,]+)\s*(?:Google\s*Flow\s*)?credits/i) || text.match(/credits?:\s*([\d,]+)/i) || text.match(/([\d,]+)\s*cr\b/i);
                const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
                const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
                panelName = (lines.length > 1 && lines[1] !== 'close') ? lines[1] : null;
                if (emailMatch) panelEmail = emailMatch[1];
                const closeBtn = panel.querySelector('.close-btn, button[aria-label*="Close" i]');
                if (closeBtn) closeBtn.click(); else if (targetBtn) targetBtn.click();
                if (match) parsedCredits = parseInt(match[1].replace(/,/g, ''), 10);
              }
            } catch (e) {}
          }

          if (parsedCredits === null) {
            const tierChips = Array.from(document.querySelectorAll('flow-user-tier-chip'));
            for (const el of tierChips) {
              const txt = (el.innerText || el.textContent || '').trim();
              const m = txt.match(/^([\d,]{1,7})\s*(?:credits?|cr)$/i) || txt.match(/([\d,]{1,7})\s*(?:Google\s*Flow\s*)?credits?/i);
              if (m) { parsedCredits = parseInt(m[1].replace(/,/g, ''), 10); break; }
              const aria = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
              const am = aria.match(/([\d,]{1,7})\s*(?:remaining\s*)?credits?/i);
              if (am) { parsedCredits = parseInt(am[1].replace(/,/g, ''), 10); break; }
            }
          }

          const bodyText = document.body ? (document.body.innerText || '') : '';
          const bannerError = document.querySelector('.credit-banner-error, .prompt-warning-button');
          const exhaustedBanner = !!(bannerError || bodyText.includes('out of Google Flow credits') || bodyText.includes('Insufficient credits'));
          if (exhaustedBanner) parsedCredits = 0;

          const wiz = window.WIZ_global_data || {};
          const userEmail = panelEmail || wiz.oPEP7c || null;

          return {
            confirmedLogin: !!(targetBtn || userEmail || parsedCredits !== null),
            email: userEmail,
            name: panelName || (userEmail ? userEmail.split('@')[0] : null),
            credits: parsedCredits,
            exhaustedBanner
          };
        } catch (e) {
          return { confirmedLogin: false, error: e.message };
        }
      });

      await closeCheckBrowser(browser, checkPid);
      browser = null;

      if (typeof result.credits === 'number') {
        // Authoritative live read (0 included — banner or panel).
        const prevAcc = dbService.getAccount(accountId);
        const res = creditService.applyLiveBalance(accountId, result.credits);
        if (!prevAcc || prevAcc.credits !== result.credits) {
          const accName = (res.account && (res.account.googleName || res.account.name)) || 'Account';
          recordActivity({
            category: 'credits', level: 'info', accountId, accountName: accName,
            message: `Live balance: ${accName} — ${result.credits} credits${prevAcc && typeof prevAcc.credits === 'number' ? ` (previously ${prevAcc.credits})` : ''}`
          });
        }
        if (result.email || result.name) {
          dbService.updateAccountFields(accountId, {
            ...(result.email ? { email: result.email } : {}),
            ...(result.name ? { googleName: result.name } : {})
          });
        }
        return { success: true, account: dbService.getAccount(accountId) || res.account, accounts: getAccounts() };
      }

      if (result.confirmedLogin) {
        const res = creditService.applyLoginDetected(accountId, {
          email: result.email || undefined,
          googleName: result.name || undefined
        });
        recordActivity({
          category: 'login', level: 'success', accountId,
          accountName: (res.account && (res.account.googleName || res.account.name)) || 'Account',
          message: `Login confirm: ${(res.account && (res.account.googleName || res.account.name)) || 'Account'}${result.email ? ` (${result.email})` : ''}`
        });
        return { success: true, account: res.account, accounts: getAccounts() };
      }

      // Inconclusive — audit fix #3: status and balance stay untouched.
      const res = creditService.applyAmbiguousCheck(accountId);
      return { success: true, unknown: true, account: res.account, accounts: getAccounts() };
    } catch (err) {
      if (browser) {
        await closeCheckBrowser(browser, checkPid);
      }
      if (err.message && (err.message.includes('ProcessSingleton') || err.message.includes('Lock file can not be created'))) {
        return {
          success: false,
          chromeOpen: true,
          error: 'Google Chrome is currently open for this profile. Please close the opened Chrome window, then click Sync again.',
          accounts: getAccounts()
        };
      }
      // Working-copy path: a launch-stage failure of the COPY (locked or
      // corrupt session files) means the check genuinely could not run —
      // report the honest busy state instead of a raw launch error.
      if (isWorkingCopy && /Failed to launch|ProcessSingleton|Lock file|spawn|ENOENT/i.test(err.message || '')) {
        return {
          success: false,
          chromeOpen: true,
          error: 'Google Chrome is currently open for this profile. Please close that Chrome window, then click Sync again.',
          accounts: getAccounts()
        };
      }
      return { success: false, error: err.message, accounts: getAccounts() };
    } finally {
      if (checkPid) liveBrowsers.unregister(accountId, checkPid);
    }
    }
  })().finally(() => {
    activeCreditFetches.delete(accountId);
  });

  activeCreditFetches.set(accountId, fetchPromise);
  return fetchPromise;
}

/**
 * v1.1 — Manual login completion ("I've logged in — Done" button).
 *
 * The auto-detection in openLoginWindow polls the profile's Preferences
 * for account_info and silently gives up after ~5 minutes; if Chrome
 * hasn't flushed that file yet (or writes identity elsewhere), a user who
 * DID log in was stranded with no feedback. This function lets the user
 * declare "I'm done" and re-checks authoritatively:
 *   1. Preferences account_info (cheap, works when Chrome already wrote it)
 *   2. fetchRealCredits headless pass (confirms signed-in state on the
 *      live Flow page and syncs the balance; explicit sign-in redirect is
 *      reported as "not logged in yet")
 * Always returns a human-readable message for the account card.
 */
async function completeLoginCheck(accountId) {
  assertAccountId(accountId);
  await dbService.ensureInit();
  const acc = dbService.getAccount(accountId);
  if (!acc) {
    return { success: false, error: 'Account not found.', accounts: getAccounts() };
  }

  // 1) Cheap path: the profile already records a signed-in Google account.
  try {
    const profilePath = getAccountProfilePath(accountId);
    const prefPath = path.join(profilePath, 'Default', 'Preferences');
    if (fs.existsSync(prefPath)) {
      const prefData = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
      const info = prefData.account_info;
      if (Array.isArray(info) && info.length > 0 && info[0].email) {
        const res = getCreditService().applyLoginDetected(accountId, {
          email: info[0].email,
          googleName: info[0].given_name || info[0].full_name || info[0].email.split('@')[0]
        });
        // Best-effort credit sync (fails harmlessly if the login Chrome
        // window is still open — the login itself is already confirmed).
        let syncNote = '';
        try {
          const sync = await fetchRealCredits(accountId);
          if (!sync || !sync.success) syncNote = ' Credits will sync on the next Sync click.';
        } catch (e) { syncNote = ' Credits will sync on the next Sync click.'; }
        return {
          success: true,
          message: `Login confirmed for ${info[0].email}.${syncNote}`,
          account: dbService.getAccount(accountId) || res.account,
          accounts: getAccounts()
        };
      }
    }
  } catch (e) { /* fall through to the authoritative check */ }

  // 2) Authoritative path: open the profile headlessly and look at Flow.
  const res = await fetchRealCredits(accountId);
  const updated = dbService.getAccount(accountId);
  if (res && res.success) {
    return {
      success: true,
      message: `Login confirmed${updated && updated.email ? ` for ${updated.email}` : ''} — credits synced.`,
      account: updated,
      accounts: getAccounts()
    };
  }
  if (res && res.explicitSignedOut) {
    return {
      success: false,
      error: 'Google is not signed in on this profile yet. Click Sign In, finish the Google login in the Chrome window, then press "I\'ve logged in — Done" again.',
      account: updated,
      accounts: getAccounts()
    };
  }
  if (res && res.chromeOpen) {
    return {
      success: false,
      error: 'Chrome is still open for this profile and no signed-in account was found yet. Finish logging in, close that Chrome window, then press "I\'ve logged in — Done" again.',
      account: updated,
      accounts: getAccounts()
    };
  }
  return {
    success: false,
    error: (res && res.error) || 'Could not confirm the login yet. Make sure you finished signing in to Google in the Chrome window, then press "I\'ve logged in — Done" again.',
    account: updated,
    accounts: getAccounts()
  };
}

/**
 * v1.8.0: Sync All is now the ZDola-style VERIFY PASS (accountHealth):
 * bounded-concurrency live checks, one automatic retry for accounts a
 * check could not confirm, two-strike sign-out confirmation, and a
 * classified summary the UI can show (live / low / exhausted /
 * need-login / unconfirmed / unknown).
 */
async function refreshAllAccountCredits(onProgress) {
  const { verifyAllAccounts } = require('./accountHealth');
  const { summary } = await verifyAllAccounts({
    fetchCredits: (id) => fetchRealCredits(id),
    getAccount: (id) => dbService.getAccount(id),
    listAccounts: () => getAccounts()
  }, {
    concurrency: 3,
    onProgress: typeof onProgress === 'function' ? onProgress : null
  });
  return { accounts: getAccounts(), summary };
}

module.exports = {
  getAccounts,
  addAccount,
  deleteAccount,
  openLoginWindow,
  completeLoginCheck,
  getAccountProfilePath,
  fetchRealCredits,
  refreshAllAccountCredits,
  getInstalledChromeProfiles,
  importFromInstalledChrome,
  importAllInstalledChromeProfiles,
  PROFILES_DIR
};
