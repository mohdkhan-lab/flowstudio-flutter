'use strict';

// ---------------------------------------------------------------------------
// COOKIES DB (v2.48.50 — MEGA PACK item 11: SYNTHETIC COOKIES DB)
//
// ZEROCLICK17 ka saboot: CDP cookie transfer ne 21 cookies taazi
// temp-dir browser me bitha diye, phir bhi probe 'logged-out' bola —
// session profile se bandha lagta hai (DBSC / Local State / storage).
// Clone+inject combo (Part B) usi transfer ko ek TOLERANT clone par
// chalata hai, lekin clone ki asal kamzori yahi hai: live profile ki
// Cookies file poori run EBUSY-locked rehti hai, is liye copy nakam
// hoti hai aur clone 'incomplete' rehta hai.
//
// Ye module usi kami ko live CDP read se bharta hai: 21 cookies se
// ek ASLI Chromium-format SQLite 'Cookies' file banata hai —
// standard `cookies` table, value PLAIN `value` column me,
// `encrypted_value` KHALI (Chrome plaintext par gir jata hai jab
// encrypted khali ho — ye is ka apna fallback hai). Koi nayi
// dependency nahi: sql.js app me pehle se bundled hai (engine/db.js
// wahi istemal karta hai) aur wasm bhi wahi se milta hai.
//
// Har bani hui DB pehle APNE hi reader se dobara khol kar parkhi
// jati hai (row count + name/host/value mila kar) — parkhi hui na
// ho to file NAHI likhi jati (caller 'skipped' log karta hai).
// ---------------------------------------------------------------------------

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const initSqlJs = require('sql.js');

/** Chrome epoch (1601-01-01) aur unix epoch (1970-01-01) ka farq, seconds me. */
const CHROME_EPOCH_OFFSET_SEC = 11644473600;

let wasmBinary = null;
try {
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  wasmBinary = fs.existsSync(wasmPath) ? fs.readFileSync(wasmPath) : null;
} catch (e) {
  const fallback = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  wasmBinary = fs.existsSync(fallback) ? fs.readFileSync(fallback) : null;
}

let sqlPromise = null;
function loadSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs(wasmBinary ? { wasmBinary } : {});
  }
  return sqlPromise;
}

/**
 * CDP unix-epoch expires (seconds, float ho sakta hai) →
 * Chrome-epoch microseconds. Session cookie (expires <= 0 /
 * na ho) par 0.
 */
function chromeExpiresUtc(unixExpires) {
  const e = Number(unixExpires);
  if (!Number.isFinite(e) || e <= 0) return 0;
  return Math.round((e + CHROME_EPOCH_OFFSET_SEC) * 1000000);
}

/** Abhi ka pal Chrome-epoch microseconds me (creation/last-access ke liye). */
function chromeNowUtc(nowMs) {
  const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
  return Math.round((ms / 1000 + CHROME_EPOCH_OFFSET_SEC) * 1000000);
}

/** CDP sameSite ('None'|'Lax'|'Strict'|na ho) → DB ki qeemat (0|1|2|-1). */
function sameSiteDbValue(sameSite) {
  if (sameSite === 'None') return 0;
  if (sameSite === 'Lax') return 1;
  if (sameSite === 'Strict') return 2;
  return -1;
}

/**
 * Ek CDP cookie (getAllCookies / page.cookies ki shakal) →
 * cookies table ki row (khalis). Naam ya domain na ho to
 * null (aisi cookie DB me bekaar hai). `nowMs` sirf test
 * ke liye diya jata hai.
 */
function cookieRowFor(cookie, nowMs) {
  if (!cookie || typeof cookie !== 'object') return null;
  const name = typeof cookie.name === 'string' ? cookie.name : '';
  const domain = typeof cookie.domain === 'string' ? cookie.domain : '';
  if (!name || !domain) return null;
  const persistent = Number.isFinite(Number(cookie.expires)) && Number(cookie.expires) > 0;
  const now = chromeNowUtc(nowMs);
  return {
    host_key: domain,
    name,
    value: typeof cookie.value === 'string' ? cookie.value : String(cookie.value == null ? '' : cookie.value),
    path: typeof cookie.path === 'string' && cookie.path !== '' ? cookie.path : '/',
    expires_utc: persistent ? chromeExpiresUtc(cookie.expires) : 0,
    is_secure: cookie.secure ? 1 : 0,
    is_httponly: cookie.httpOnly ? 1 : 0,
    last_access_utc: now,
    has_expires: persistent ? 1 : 0,
    is_persistent: persistent ? 1 : 0,
    priority: 1,
    creation_utc: now,
    source_scheme: cookie.secure ? 2 : 1,
    source_port: -1,
    last_update_utc: now,
    samesite: sameSiteDbValue(cookie.sameSite)
  };
}

const COOKIES_SCHEMA = `
CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
INSERT INTO meta VALUES('version', '10');
CREATE TABLE cookies(
  host_key TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  path TEXT NOT NULL,
  expires_utc INTEGER NOT NULL,
  is_secure INTEGER NOT NULL,
  is_httponly INTEGER NOT NULL,
  last_access_utc INTEGER NOT NULL,
  has_expires INTEGER NOT NULL DEFAULT 1,
  is_persistent INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 1,
  encrypted_value BLOB DEFAULT '',
  creation_utc INTEGER NOT NULL,
  source_scheme INTEGER NOT NULL DEFAULT 0,
  source_port INTEGER NOT NULL DEFAULT -1,
  last_update_utc INTEGER NOT NULL,
  source_type INTEGER NOT NULL DEFAULT 0,
  has_cross_site_ancestor INTEGER NOT NULL DEFAULT 1,
  samesite INTEGER NOT NULL DEFAULT -1
);
CREATE INDEX cookies_host_key_index ON cookies(host_key);
`;

/**
 * Cookies ki fehrist se poori DB ka Buffer banao aur use
 * apne hi reader se parkho (rows wapas padh kar name/host/
 * value mila kar). Parkh nakam ho to throw — caller file
 * kabhi nahi likhega.
 * Lautta hai: { buffer, rows } (rows = cookieRowFor ki
 * saaf fehrist jo asal me DB me gayi).
 */
async function buildCookiesDbBuffer(cookies) {
  const rows = [];
  for (const c of Array.isArray(cookies) ? cookies : []) {
    const row = cookieRowFor(c);
    if (row) rows.push(row);
  }
  if (rows.length === 0) {
    const err = new Error('no mappable cookies for the synthetic Cookies DB');
    err.code = 'COOKIESDB_EMPTY';
    throw err;
  }
  const SQL = await loadSql();
  const db = new SQL.Database();
  try {
    db.run(COOKIES_SCHEMA);
    const stmt = db.prepare(
      'INSERT INTO cookies (host_key, name, value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, encrypted_value, creation_utc, source_scheme, source_port, last_update_utc, samesite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    try {
      for (const r of rows) {
        stmt.run([
          r.host_key, r.name, r.value, r.path, r.expires_utc,
          r.is_secure, r.is_httponly, r.last_access_utc, r.has_expires,
          r.is_persistent, r.priority, new Uint8Array(0), r.creation_utc,
          r.source_scheme, r.source_port, r.last_update_utc, r.samesite
        ]);
      }
    } finally {
      stmt.free();
    }
    const buffer = Buffer.from(db.export());
    // PARKH: bani hui file dobara khol kar rows mila lo —
    // jo andar gaya wahi bahar aana chahiye.
    const back = await readCookiesDbRows(buffer);
    if (back.length !== rows.length) {
      const err = new Error(`synthetic Cookies DB failed validation (wrote ${rows.length}, read back ${back.length})`);
      err.code = 'COOKIESDB_INVALID';
      throw err;
    }
    const keyOf = (r) => `${r.host_key}|${r.name}|${r.value}`;
    const backKeys = new Set(back.map(keyOf));
    for (const r of rows) {
      if (!backKeys.has(keyOf(r))) {
        const err = new Error('synthetic Cookies DB failed validation (a row did not survive the round trip)');
        err.code = 'COOKIESDB_INVALID';
        throw err;
      }
    }
    return { buffer, rows };
  } finally {
    try { db.close(); } catch (e) {}
  }
}

/** Ek Cookies DB buffer se rows padho (validation + tests ke liye). */
async function readCookiesDbRows(buffer) {
  const SQL = await loadSql();
  const db = new SQL.Database(new Uint8Array(buffer));
  try {
    const res = db.exec('SELECT host_key, name, value, path, expires_utc, is_secure, is_httponly, has_expires, is_persistent, samesite FROM cookies ORDER BY host_key ASC, name ASC');
    if (!res || !res.length) return [];
    const cols = res[0].columns;
    return res[0].values.map(vals => {
      const row = {};
      cols.forEach((c, i) => { row[c] = vals[i]; });
      return row;
    });
  } finally {
    try { db.close(); } catch (e) {}
  }
}

/**
 * Clone dir ke andar Cookies DB likh do. Jagah: clone
 * report ki cookiesRel (scan se mili jagah) ho to wahi,
 * warna thahri 'Default/Network/Cookies'.
 * Lautta hai: { built:true, count, path } ya
 * { built:false, reason } — kabhi throw nahi.
 */
async function buildCookiesDbFile(cookies, cloneReport, cloneDir) {
  try {
    if (!cloneDir) return { built: false, reason: 'no-clone-dir' };
    const rel = cloneReport && typeof cloneReport.cookiesRel === 'string' && cloneReport.cookiesRel
      ? cloneReport.cookiesRel
      : path.join('Default', 'Network', 'Cookies');
    const dest = path.join(cloneDir, ...rel.split(/[\\/]/).filter(Boolean));
    const { buffer, rows } = await buildCookiesDbBuffer(cookies);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buffer);
    return { built: true, count: rows.length, path: dest };
  } catch (e) {
    return { built: false, reason: String((e && e.message) || e || 'unknown').replace(/\s+/g, ' ').slice(0, 80) };
  }
}

module.exports = {
  CHROME_EPOCH_OFFSET_SEC,
  chromeExpiresUtc,
  chromeNowUtc,
  sameSiteDbValue,
  cookieRowFor,
  buildCookiesDbBuffer,
  readCookiesDbRows,
  buildCookiesDbFile
};
