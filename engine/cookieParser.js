'use strict';

/**
 * FlowStudio Lite — cookie file parser (v1.2, ZDola-style import).
 *
 * Pure text -> Puppeteer/CDP cookie params. No I/O, no logging of values.
 *
 * Supported inputs (auto-detected by CONTENT, not extension):
 *  - Netscape cookies.txt: tab-separated lines
 *      domain \t subdomain-flag \t path \t secure \t expires \t name \t value
 *    Lines starting with '#' are comments, EXCEPT '#HttpOnly_' which is a
 *    real cookie line with the httpOnly flag set.
 *  - JSON array of cookie objects (EditThisCookie / "Get cookies.txt" JSON
 *    export style): { domain, name, value, path, expirationDate, secure,
 *    httpOnly, session, sameSite }.
 *  - JSON object with a "cookies" array in the same shape.
 *
 * Only cookies relevant to Google sign-in are kept: domains on google.com
 * (any subdomain, incl. accounts.google.com and flow.google.com) or
 * labs.google (Flow's parent surface, incl. subdomains).
 *
 * Conversion to Puppeteer params:
 *  - expires is epoch SECONDS; session cookies (Netscape expires 0, or
 *    JSON session:true / no expirationDate) omit `expires` entirely.
 *  - sameSite is mapped best-effort ('no_restriction' -> 'None', etc.) and
 *    omitted when unspecified.
 */

const GOOGLE_ROOTS = ['google.com', 'labs.google'];

function isGoogleCookieDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  const d = domain.trim().toLowerCase().replace(/^\.+/, '');
  if (!d) return false;
  return GOOGLE_ROOTS.some(root => d === root || d.endsWith('.' + root));
}

function mapSameSite(raw) {
  if (!raw || typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'strict') return 'Strict';
  if (v === 'lax') return 'Lax';
  if (v === 'none' || v === 'no_restriction') return 'None';
  return undefined; // 'unspecified' and anything unknown: omit
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return !!v;
}

// ---------------------------------------------------------------- Netscape

function parseNetscape(text) {
  const cookies = [];
  let total = 0;
  const lines = String(text).split(/\r?\n/);
  for (let rawLine of lines) {
    let line = rawLine;
    if (!line || !line.trim()) continue;
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true;
      line = line.slice('#HttpOnly_'.length);
    } else if (line.startsWith('#')) {
      continue; // comment line
    }
    const fields = line.split('\t');
    if (fields.length < 7) continue; // not a cookie line
    total++;
    const [domain, , cookiePath, secure, expiresRaw, name, ...valueParts] = fields;
    const value = valueParts.join('\t');
    if (!name) continue;
    const cookie = {
      name,
      value: value === undefined ? '' : value,
      domain,
      path: cookiePath || '/',
      secure: toBool(secure),
      httpOnly
    };
    const expires = Number(expiresRaw);
    if (Number.isFinite(expires) && expires > 0) cookie.expires = Math.floor(expires);
    cookies.push(cookie);
  }
  return { cookies, total };
}

// -------------------------------------------------------------------- JSON

function jsonEntryToCookie(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const name = typeof entry.name === 'string' ? entry.name : '';
  if (!name) return null;

  let domain = typeof entry.domain === 'string' ? entry.domain : '';
  if (!domain && typeof entry.url === 'string' && entry.url) {
    try { domain = new URL(entry.url).hostname; } catch (e) { domain = ''; }
  }
  if (!domain) return null;

  const cookie = {
    name,
    value: entry.value === undefined || entry.value === null ? '' : String(entry.value),
    domain,
    path: typeof entry.path === 'string' && entry.path ? entry.path : '/',
    secure: toBool(entry.secure),
    httpOnly: toBool(entry.httpOnly)
  };

  const sameSite = mapSameSite(entry.sameSite);
  if (sameSite) cookie.sameSite = sameSite;

  const isSession = entry.session === true;
  const expRaw = entry.expirationDate !== undefined ? entry.expirationDate
    : (entry.expires !== undefined ? entry.expires : entry.expiry);
  const exp = Number(expRaw);
  if (!isSession && Number.isFinite(exp) && exp > 0) {
    cookie.expires = Math.floor(exp);
  }
  return cookie;
}

function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('This file looks like JSON but could not be parsed. Export the cookies again and retry.');
  }
  let entries = null;
  if (Array.isArray(data)) entries = data;
  else if (data && Array.isArray(data.cookies)) entries = data.cookies;
  if (!entries) {
    throw new Error('Unrecognized cookie file: expected a JSON array of cookies or an object with a "cookies" array.');
  }
  const cookies = [];
  for (const entry of entries) {
    const c = jsonEntryToCookie(entry);
    if (c) cookies.push(c);
  }
  return { cookies, total: entries.length };
}

// -------------------------------------------------------------------- main

/**
 * Parse cookie file text into Puppeteer-ready Google cookies.
 * Returns { cookies, format, totalParsed, keptCount }.
 * Throws an Error with a human-readable message on garbage input, on files
 * with no cookies at all, and on files with no Google sign-in cookies.
 */
function parseCookieText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('The cookie file is empty.');
  }
  const trimmed = text.trim();
  let parsed;
  let format;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    parsed = parseJson(trimmed);
    format = 'json';
  } else {
    parsed = parseNetscape(text);
    format = 'netscape';
    if (parsed.cookies.length === 0) {
      throw new Error('No cookies could be read from this file. Use a Netscape cookies.txt export or a JSON cookie export.');
    }
  }

  const kept = parsed.cookies.filter(c => isGoogleCookieDomain(c.domain));
  if (kept.length === 0) {
    throw new Error('No Google cookies found in this file (google.com / labs.google). Make sure the file holds the cookies of a signed-in Google account.');
  }
  return { cookies: kept, format, totalParsed: parsed.total, keptCount: kept.length };
}

module.exports = { parseCookieText, isGoogleCookieDomain, mapSameSite };
