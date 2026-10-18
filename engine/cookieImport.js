'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { getChromeExecutablePath } = require('./chromePaths');
const { checkProfileBusyAsync, killProcessesByPid } = require('./processHelper');
const liveBrowsers = require('./liveBrowsers');
const { dbService } = require('./db');
const { parseCookieText } = require('./cookieParser');
const {
  addAccount,
  getAccounts,
  getAccountProfilePath,
  fetchRealCredits
} = require('./accountStore');
const { classifyOutcome } = require('./accountHealth');
const { getCookieStore } = require('./cookieStore');
const { recordActivity } = require('./activityStore');

/**
 * FlowStudio Lite — cookie-file import + automatic check (v2.0.0).
 *
 * The owner drops a cookie file (Netscape cookies.txt or a JSON export);
 * the account is created, the Google cookies are injected into ITS OWN
 * dedicated Chrome profile, and the EXISTING live verification
 * (fetchRealCredits) decides the true status — credits and status are
 * written only by creditService through that path, exactly like a manual
 * Sign In + Sync. An account is NEVER marked logged-in on the strength of
 * the file alone:
 *   - studio opens + credits read  -> Ready with the real balance
 *   - Google bounces to sign-in    -> 'Need Login' + a visible card reason
 *   - inconclusive page            -> nothing is claimed; the card says so
 *
 * v2.0.0 (owner's explicit order — this REVERSES the v1.2 "never stored"
 * rule): the PARSED Google cookies are also saved in the app data folder
 * (engine/cookieStore.js, one file per account) so they can be re-checked
 * later from the card's 🍪 Re-check button without the original file.
 * Cookie VALUES are still never logged, printed, or sent to the renderer.
 *
 * The automatic check's result is CLASSIFIED with the same health classes
 * as Verify All (live / low / exhausted / need-login / unconfirmed /
 * unknown) and surfaced on the account row as the 🍪 indicator chip:
 *   Checking… -> Live / Ready / Fail — <plain reason>.
 * HONESTY RULE: Google's device-bound sessions (DBSC) mean a cookie file
 * copied from another device is often rejected — when that happens the
 * chip says Fail with the real reason. It never shows a fake Live.
 *
 * Bounded by design (the v1.1 freeze lesson): one injection pass, one
 * verification pass, per-cookie failures counted. v2.1.0 adds exactly
 * ONE bounded re-verification when the first look is inconclusive
 * (unconfirmed/unknown) — the same single retry Verify All runs; no
 * open-ended retry loops.
 */

/**
 * Map a finished cookie check to the indicator state shown on the row.
 * state: 'live' | 'ready' | 'fail'. reason: short plain-language cause
 * (shown in the chip / card message — never contains cookie data).
 */
function cookieCheckState(outcome, fetchResult, freshAccount) {
  switch (outcome) {
    case 'live':
      return { state: 'live', outcome, reason: '' };
    case 'low':
      return { state: 'ready', outcome, reason: 'Login OK, credits are low' };
    case 'exhausted':
      return { state: 'live', outcome, reason: 'Login OK, credits are 0' };
    case 'need-login':
      return { state: 'fail', outcome, reason: 'Google rejected the session — cookie dead/expired (DBSC)' };
    case 'unconfirmed':
      // v2.1.0: this state is now only reachable AFTER the automatic
      // second look (see runCookieCheckCore) — the wording says so.
      return { state: 'fail', outcome, reason: 'Sign-out not confirmed after two checks — press Re-check' };
    default:
      if (fetchResult && fetchResult.chromeOpen) {
        return { state: 'fail', outcome: 'unknown', reason: 'Chrome profile is busy — close the window and Re-check' };
      }
      return { state: 'fail', outcome: 'unknown', reason: 'The check could not complete (network / page load)' };
  }
}

function emitPhase(onPhase, accountId, phase, check) {
  if (typeof onPhase !== 'function') return;
  try {
    onPhase({ accountId, phase, state: check ? check.state : null, outcome: check ? check.outcome : null, reason: check ? check.reason : '' });
  } catch (e) {}
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Inject the parsed cookies into the account's fresh profile (one bounded
 * pass), then let Chrome persist them by visiting Flow and closing
 * gracefully. Returns { injected, failed }.
 */
async function injectCookiesIntoProfile(accountId, cookies) {
  const chromePath = getChromeExecutablePath(dbService.getSetting('chrome_path', ''));
  if (!chromePath || !fs.existsSync(chromePath)) {
    throw new Error(`Google Chrome was not found (looked for: ${chromePath || 'no path'}). Install Google Chrome, then import again.`);
  }
  const profilePath = getAccountProfilePath(accountId);

  let browser = null;
  let injectPid = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: chromePath,
      userDataDir: profilePath,
      defaultViewport: { width: 1280, height: 800 },
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800'
      ],
      ignoreDefaultArgs: ['--enable-automation']
    });
    // v1.4: register as a legitimately live launch (reclaim safety).
    // Kind 'check' (v1.4.1) — short-lived, watchdog-protected.
    try { injectPid = browser.process() ? browser.process().pid : null; } catch (e) {}
    if (injectPid) liveBrowsers.register(accountId, injectPid, 'check');

    const page = await browser.newPage();

    // Inject BEFORE navigation (CDP Network.setCookie per cookie). Done one
    // by one so a single stale/expired entry cannot sink the whole file.
    let injected = 0;
    let failed = 0;
    for (const cookie of cookies) {
      try {
        await page.setCookie(cookie);
        injected++;
      } catch (e) {
        failed++; // e.g. already-expired cookie — Chrome refuses it; fine.
      }
    }
    if (injected === 0) {
      throw new Error('Chrome refused every cookie in this file (they may all be expired). Export fresh cookies from the signed-in browser and retry.');
    }

    // Visit Flow once so the session is exercised and Chrome flushes the
    // cookie store into the profile on close.
    try {
      await page.goto('https://flow.google.com/', { waitUntil: 'domcontentloaded', timeout: 35000 });
      await sleep(2500);
    } catch (e) { /* navigation trouble does not undo the injection */ }

    // v1.4.1: bounded close (same hang guard as the credit check) —
    // if close() never settles, terminate OUR import browser by PID.
    let closedOk = false;
    try {
      await Promise.race([
        browser.close().then(() => { closedOk = true; }),
        sleep(5000)
      ]);
    } catch (e) { closedOk = true; }
    if (!closedOk && injectPid) {
      try { await killProcessesByPid([injectPid]); } catch (e) {}
    }
    browser = null;
    await sleep(400);
    return { injected, failed };
  } finally {
    if (injectPid) liveBrowsers.unregister(accountId, injectPid);
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
}

/**
 * v2.1.0: the cookie check's verification core, with the fetch and the
 * account read INJECTED so the retry classification is unit-testable
 * without a browser.
 *
 * FIX (owner's PC test, 2026-10-14): his cookie account showed FAIL on
 * the first automatic check ("Pehli baar sign-out dikha") and LIVE on
 * the manual re-check minutes later — a first-strike sign-out sighting
 * is often just Flow's landing bounce, not a dead session. Verify All
 * already retries an inconclusive outcome once inside the same pass;
 * the cookie check now does the same: on 'unconfirmed' (first-strike
 * sign-out) or 'unknown' (page/network hiccup) it waits briefly and
 * checks ONE more time before reporting anything. A busy Chrome
 * profile is NOT retried (waiting cannot fix that). The final outcome
 * is whatever the LAST look says — LIVE if it comes live, Fail with
 * the plain reason otherwise. The two-strike rule itself is untouched:
 * a second explicit sign-out still lands on 'Need Login' through
 * creditService, exactly as before.
 */
async function runCookieCheckCore({ fetchOnce, getAccount, retryDelayMs = 2000, onRetry } = {}) {
  if (typeof fetchOnce !== 'function' || typeof getAccount !== 'function') {
    throw new Error('runCookieCheckCore requires { fetchOnce, getAccount }');
  }
  const attempt = async () => {
    let res = null;
    try {
      res = await fetchOnce();
    } catch (e) {
      res = { success: false, error: e.message };
    }
    const updated = getAccount();
    return { res: res || {}, updated, outcome: classifyOutcome(res || {}, updated) };
  };

  let last = await attempt();
  let attempts = 1;
  let retried = false;
  const retryable = (last.outcome === 'unconfirmed' || last.outcome === 'unknown')
    && !(last.res && last.res.chromeOpen);
  if (retryable) {
    retried = true;
    if (typeof onRetry === 'function') {
      try { onRetry(last.outcome); } catch (e) {}
    }
    if (retryDelayMs > 0) await sleep(retryDelayMs);
    last = await attempt();
    attempts = 2;
  }
  const check = cookieCheckState(last.outcome, last.res, last.updated);
  return { res: last.res, updated: last.updated, outcome: last.outcome, check, attempts, retried };
}

/**
 * Shared tail of a cookie check: run the authoritative live verification
 * (with the v2.1.0 one-time auto-retry on an inconclusive first look),
 * update the 🍪 indicator (phase event + account row's has_cookies flag
 * is set by callers), write the Activity entry, and build the result
 * object. `res` semantics mirror fetchRealCredits.
 */
async function finishCookieCheck(accountId, accountName, onPhase) {
  const { res, updated, check, attempts } = await runCookieCheckCore({
    fetchOnce: () => fetchRealCredits(accountId),
    getAccount: () => dbService.getAccount(accountId),
    onRetry: (firstOutcome) => {
      // Keep the chip on "Checking…" — the verdict is not final yet.
      emitPhase(onPhase, accountId, 'checking', null);
      recordActivity({
        category: 'login', level: 'info', accountId, accountName,
        stage: 'cookie-check',
        message: `🍪 Cookie check: ${accountName} — first check not certain (${firstOutcome === 'unconfirmed' ? 'sign-out seen' : 'page/network not confirmed'}), checking again automatically…`,
        detail: 'Seeing the sign-in page the first time Flow opens is often just a landing bounce, not a dead session. That is why the same live check is run once more before a final FAIL/Live verdict — the same rule as Verify All.'
      });
    }
  });
  emitPhase(onPhase, accountId, 'done', check);

  if (check.state === 'live' || check.state === 'ready') {
    recordActivity({
      category: 'login', level: 'success', accountId, accountName,
      stage: 'cookie-check',
      message: `🍪 Cookie check: ${accountName} — LIVE${typeof (updated && updated.credits) === 'number' ? ` (${updated.credits} credits)` : ''}${check.reason ? ` · ${check.reason}` : ''}`,
      detail: `Google Flow opened with the cookie file's session and the login was confirmed${attempts > 1 ? ' (on the second attempt)' : ''}. The live credit number shows on the account line — that is the real balance.`
    });
  } else {
    recordActivity({
      category: 'errors', level: 'error', accountId, accountName,
      stage: 'cookie-check',
      reason: check.reason,
      detail: attempts > 1
        ? 'The cookie check ran twice — this is the final result both times. If the cookie was copied from another device, Google\'s device-bound session (DBSC) often rejects it; signing in on this account with Sign In is the only certain way.'
        : 'Final result of the cookie check. If the cookie was copied from another device, Google\'s device-bound session (DBSC) often rejects it; signing in on this account with Sign In is the only certain way.',
      message: `🍪 Cookie check FAIL: ${accountName} — ${check.reason}`
    });
  }
  return { res, updated, check, attempts };
}

/**
 * Shared tail of every cookie import (file OR pasted text), from an
 * already-parsed cookie set: create the account, save the cookies,
 * inject, and run the automatic check. Parse failures happen BEFORE
 * this is called, so bad input never leaves a junk account behind.
 */
async function finishCookieImport({ parsed, name, onPhase, fileName = '' }) {
  const fail = (error, extra = {}) => ({ success: false, error, fileName, accounts: getAccounts(), ...extra });
  const { account } = addAccount(name);
  const accountId = account.id;

  const busy = await checkProfileBusyAsync(getAccountProfilePath(accountId), accountId);
  if (busy.busy) {
    return fail('This account\'s Chrome profile is busy right now. Close that Chrome window and import again.', { account });
  }

  // v2.0.0: save the parsed cookies per-account (owner's order) so the
  // account can be re-checked later without the original file. Values
  // stay inside the data folder — never logged anywhere.
  try {
    getCookieStore().save(accountId, parsed.cookies);
    dbService.updateAccountFields(accountId, { hasCookies: 1 });
  } catch (e) { /* saving is best-effort; the import itself continues */ }

  emitPhase(onPhase, accountId, 'checking', null);
  recordActivity({ category: 'login', level: 'info', accountId, accountName: name, message: `🍪 Cookie check started: ${name}` });

  try {
    await injectCookiesIntoProfile(accountId, parsed.cookies);
  } catch (e) {
    const check = { state: 'fail', outcome: 'unknown', reason: 'Chrome did not accept the cookies (all may be expired)' };
    emitPhase(onPhase, accountId, 'done', check);
    recordActivity({ category: 'errors', level: 'error', accountId, accountName: name, message: `🍪 Cookie check FAIL: ${name} — ${check.reason}` });
    return fail(`Cookie import failed: ${e.message}`, { account: dbService.getAccount(accountId), check });
  }

  // Authoritative verification — the same live check a manual Sync runs.
  // creditService applies every outcome; nothing is claimed from the file.
  const { res, updated, check } = await finishCookieCheck(accountId, name, onPhase);

  if (res && res.explicitSignedOut) {
    return fail(
      'Login failed — Google rejected this session. Press "Sign In" on this line.',
      { account: updated, cookiesRejected: true, check }
    );
  }
  if (res && res.success && updated && (updated.status === 'Ready' || updated.status === 'Exhausted')) {
    return {
      success: true,
      verified: true,
      // v2.1.0 FIX (stale card note): NO credit count in this note. The
      // note stays on the card while the live balance keeps changing
      // (the owner's card said "50 Flow credits available" after the
      // balance had already dropped to 40). The card's live number is
      // the only count that is ever shown.
      message: updated.status === 'Exhausted'
        ? 'Login confirmed. Credits are finished (Exhausted) — the live number shows on the line.'
        : 'Login confirmed. The live credit number shows on the line.',
      account: updated,
      accounts: getAccounts(),
      fileName,
      check
    };
  }
  if (res && res.success && res.unknown) {
    return fail(
      'Cookies imported, but login is not confirmed yet. Press "Sync" on this line to check again.',
      { account: updated, unverified: true, check }
    );
  }
  if (res && res.chromeOpen) {
    return fail(res.error || 'Chrome is open for this profile. Close it and press Sync on the card.', { account: updated, check });
  }
  return fail((res && res.error) || 'Login could not be verified after the cookie import. Press "Sync" on this line to check again.', { account: updated, check });
}

/**
 * Import ONE cookie file. Parse failures happen BEFORE any account is
 * created, so a bad file never leaves a junk account behind.
 * label: the user's email/nickname for single import, or the filename
 * (minus extension) for bulk imports.
 * onPhase({ accountId, phase, state, outcome, reason }) reports the
 * automatic check live so the row's 🍪 chip can show Checking… -> result.
 */
async function importAccountFromCookieFile({ filePath, label, onPhase } = {}) {
  const fileName = filePath ? path.basename(filePath) : '';
  const fail = (error, extra = {}) => ({ success: false, error, fileName, accounts: getAccounts(), ...extra });

  if (!filePath || typeof filePath !== 'string') {
    return fail('No cookie file was selected.');
  }

  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return fail(`Could not read the cookie file: ${e.message}`);
  }

  let parsed;
  try {
    parsed = parseCookieText(text);
  } catch (e) {
    return fail(e.message);
  }

  const name = (label && String(label).trim()) || fileName.replace(/\.[^.]*$/, '') || 'Cookie Account';
  return finishCookieImport({ parsed, name, onPhase, fileName });
}

/**
 * v2.2.0: import from PASTED cookie text (the cookie modal's
 * "📋 Cookies Paste Karo" path). The exact same parser, store,
 * injection and automatic check as the file path — only the source of
 * the text differs. A parse failure returns BEFORE any account exists,
 * so the modal can show the error inline and the user can fix the
 * paste and retry. Cookie values are never logged here either.
 */
async function importAccountFromCookieText({ text, label, onPhase } = {}) {
  const fail = (error, extra = {}) => ({ success: false, error, fileName: '', accounts: getAccounts(), ...extra });

  if (typeof text !== 'string' || !text.trim()) {
    return fail('Paste the cookies text first (Netscape cookies.txt or JSON format).');
  }
  if (text.length > 2 * 1024 * 1024) {
    return fail('The pasted text is too large (over 2 MB). Paste only the cookies part.');
  }

  let parsed;
  try {
    parsed = parseCookieText(text);
  } catch (e) {
    return fail(e.message);
  }

  const name = (label && String(label).trim()) || 'Cookie Account';
  return finishCookieImport({ parsed, name, onPhase, fileName: '' });
}

/**
 * Re-check an account whose cookies were saved earlier (the card's
 * 🍪 Re-check button): re-inject the SAVED cookies into the profile and
 * run the same automatic check. Honest results only — a saved cookie
 * that Google has since killed honestly reports Fail with the reason.
 */
async function recheckAccountCookies(accountId, onPhase) {
  const account = dbService.getAccount(accountId);
  if (!account) return { success: false, error: 'Account not found.' };
  const name = account.googleName || account.name || 'Account';

  const saved = getCookieStore().load(accountId);
  if (!saved || saved.length === 0) {
    return { success: false, error: 'No saved cookies found for this account. Add it again from a cookie file.', account };
  }

  const busy = await checkProfileBusyAsync(getAccountProfilePath(accountId), accountId);
  if (busy.busy) {
    return { success: false, error: 'Profile is busy — close this account\'s Chrome window and try again.', account };
  }

  emitPhase(onPhase, accountId, 'checking', null);
  recordActivity({ category: 'login', level: 'info', accountId, accountName: name, message: `🍪 Cookie re-check started: ${name}` });

  try {
    await injectCookiesIntoProfile(accountId, saved);
  } catch (e) {
    const check = { state: 'fail', outcome: 'unknown', reason: 'Chrome did not accept the saved cookies' };
    emitPhase(onPhase, accountId, 'done', check);
    recordActivity({ category: 'errors', level: 'error', accountId, accountName: name, message: `🍪 Cookie re-check FAIL: ${name} — ${check.reason}` });
    return { success: false, error: `Cookie re-check failed: ${e.message}`, account: dbService.getAccount(accountId), check };
  }

  const { updated, check } = await finishCookieCheck(accountId, name, onPhase);
  return {
    success: check.state === 'live' || check.state === 'ready',
    account: updated,
    accounts: getAccounts(),
    check,
    message: check.state === 'fail' ? `Cookie check fail — ${check.reason}` : undefined
  };
}

/**
 * Bulk import: files run SEQUENTIALLY (one headless Chrome at a time — no
 * launch storms), each labelled by its filename minus extension. One bad
 * file never stops the rest.
 */
async function importAccountsFromCookieFiles(filePaths, onPhase) {
  const results = [];
  const list = Array.isArray(filePaths) ? filePaths : [];
  for (const filePath of list) {
    const label = path.basename(String(filePath)).replace(/\.[^.]*$/, '');
    try {
      const res = await importAccountFromCookieFile({ filePath, label, onPhase });
      results.push({
        file: path.basename(String(filePath)),
        success: !!res.success,
        message: res.message || null,
        error: res.error || null,
        accountId: res.account ? res.account.id : null,
        check: res.check || null
      });
    } catch (e) {
      results.push({ file: path.basename(String(filePath)), success: false, error: e.message, accountId: null, check: null });
    }
  }
  return {
    success: true,
    totalFiles: list.length,
    importedCount: results.filter(r => r.success).length,
    results,
    accounts: getAccounts()
  };
}

module.exports = { importAccountFromCookieFile, importAccountFromCookieText, importAccountsFromCookieFiles, recheckAccountCookies, cookieCheckState, runCookieCheckCore };
