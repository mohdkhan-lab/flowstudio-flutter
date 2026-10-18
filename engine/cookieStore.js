'use strict';

const fs = require('fs');
const path = require('path');
const { assertAccountId } = require('./pathSecurity');

/**
 * FlowStudio Lite — per-account SAVED cookies (v2.0.0, owner's order).
 *
 * v1.2 deliberately never stored cookie files. The owner has now
 * explicitly ordered the opposite ("sabhi accounts ki cookies save kar
 * lo, aur koi un cookies ko check karega"): when an account is added
 * from a cookie file, the parsed Google cookies are saved in the app's
 * data folder — one JSON file per account, data/cookies/<accountId>.json
 * — so the app can re-inject and RE-CHECK them later (the 🍪 Re-check
 * button) without asking for the file again.
 *
 * Rules that do NOT bend:
 *  - Cookie values are NEVER logged, printed, put in an activity entry,
 *    or returned to the renderer. This module exposes only save / load /
 *    has / delete and a COUNT — callers that need the values (the
 *    injector) get them via load() inside the main process only.
 *  - Only the already-filtered Google cookies (cookieParser output) are
 *    saved — the raw dropped file is never copied wholesale.
 *  - Deleting an account deletes its saved cookies (accountStore calls
 *    deleteAccountCookies).
 *
 * The base directory is injected for tests; production uses
 * <dbService data dir>/cookies.
 */
function createCookieStore(baseDir) {
  if (!baseDir || typeof baseDir !== 'string') {
    throw new Error('createCookieStore requires a base directory');
  }
  const dir = path.resolve(baseDir);

  function fileFor(accountId) {
    assertAccountId(accountId);
    return path.join(dir, `${accountId}.json`);
  }

  return {
    getDir() { return dir; },

    /** Save the parsed cookie params for an account. Returns the count saved. */
    save(accountId, cookies) {
      const file = fileFor(accountId);
      const list = Array.isArray(cookies) ? cookies : [];
      // Store only the CDP cookie fields — nothing else from the source file.
      const clean = list.map(c => {
        const out = {
          name: String(c.name || ''),
          value: String(c.value === undefined || c.value === null ? '' : c.value),
          domain: String(c.domain || ''),
          path: c.path ? String(c.path) : '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly
        };
        if (typeof c.expires === 'number' && Number.isFinite(c.expires) && c.expires > 0) out.expires = Math.floor(c.expires);
        if (c.sameSite) out.sameSite = String(c.sameSite);
        return out;
      }).filter(c => c.name && c.domain);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp_${process.pid}_${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), cookies: clean }), 'utf8');
      fs.renameSync(tmp, file);
      return clean.length;
    },

    /** Load the saved cookies for an account; null when none are saved. */
    load(accountId) {
      const file = fileFor(accountId);
      if (!fs.existsSync(file)) return null;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || !Array.isArray(parsed.cookies)) return null;
        return parsed.cookies;
      } catch (e) {
        return null; // a corrupt save reads as "no cookies" — re-import fixes it
      }
    },

    hasSaved(accountId) {
      try {
        return fs.existsSync(fileFor(accountId));
      } catch (e) {
        return false;
      }
    },

    savedCount(accountId) {
      const list = this.load(accountId);
      return list ? list.length : 0;
    },

    deleteSaved(accountId) {
      try {
        const file = fileFor(accountId);
        if (fs.existsSync(file)) fs.unlinkSync(file);
        return true;
      } catch (e) {
        return false;
      }
    }
  };
}

// Production singleton: <data dir>/cookies.
let _defaultStore = null;
function getCookieStore() {
  if (!_defaultStore) {
    const { dbService } = require('./db');
    _defaultStore = createCookieStore(path.join(dbService.getDataDir(), 'cookies'));
  }
  return _defaultStore;
}

module.exports = { createCookieStore, getCookieStore };
