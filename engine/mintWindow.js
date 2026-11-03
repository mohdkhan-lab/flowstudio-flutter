'use strict';

// v2.48.31 (MINT-WINDOW): "mint window" ka KHALIS (pure) hisaab —
// koi I/O nahi, koi browser nahi, is liye unit tests seedha is
// par chalte hain (downloadEventMatch.js wali hi tarz).
//
// SAWAAL (owner, 2026-11-03): menu ke ⋮ → Download → resolution
// click ke BAAD file ka asal server address (flow-content.google
// /video/*) ~6 second me "mint" hota hai (FASTTEST5). Click aur
// pehli sighting ke BEECH kaunsi network requests jati hain —
// kya un me se kisi API jawab ke ANDAR hi signed URL aata hai,
// jise koi bhavishya version bina UI ghumaye replay karke le
// sake? Is module ke teen hisse wahi saboot jama karte hain:
//   1. sanitizeRequestEntry — har request ki SURAKSHIT shakal
//      (method + host + saaf path; query ki sirf KEYS, values
//      KABHI nahi — signature/token log me jana mana hai).
//   2. responseCarriesFileUrl — kisi jawab ke Location header
//      ya body text me file-address ka host chhupa hai kya
//      (sirf haan/na; asal URL kabhi wapas nahi jata).
//   3. createMintWindow — click par khulne wali ginati-khidki:
//      sighting tak ki requests ginti hai aur log ke qabil
//      entries ek cap tak deti hai (khidki band hote hi
//      khulasa: click ke baad kul kitni requests gayin).

const FILE_URL_MARKER = 'flow-content.google';
const DEFAULT_WINDOW_CAP = 40;
const MAX_BODY_SCAN_BYTES = 1024 * 1024;
const MAX_QUERY_KEYS = 6;

/**
 * Path ke hisse (segment) ko '*' karna hai kya — wahi usool jo
 * networkCapture.urlShape ka hai: lamba hissa, ya digits+akshar
 * mila hua darmiyani hissa, pehchan/token jaisa hota hai; chhote
 * aam alfaaz (video, data, batchexecute) waise ke waise rehte
 * hain taaki rasta pehchana ja sake.
 */
function isTokenishSegment(seg) {
  let d = String(seg || '');
  try { d = decodeURIComponent(d); } catch (e) {}
  if (d.length > 14) return true;
  if (d.length > 8 && /[0-9]/.test(d) && /[a-zA-Z]/.test(d)) return true;
  return false;
}

/** Pathname ki saaf shakal: token-numa hisse '*', baaki asal. */
function sanitizePathname(pathname) {
  const segs = String(pathname || '').split('/').filter(Boolean)
    .map(s => (isTokenishSegment(s) ? '*' : s));
  return '/' + segs.join('/');
}

/**
 * Ek request ki log-qabil shakal: { method, host, path, at }.
 * path me query ki sirf KEYS shamil hain (`?rpcids,bl` jaisi) —
 * values kabhi nahi (un me signature/auth ho sakta hai). Host
 * na mile (data:/blob:/galat URL) to null — aisi request is
 * shikar ke kaam ki nahi.
 */
function sanitizeRequestEntry(input) {
  try {
    if (!input || !input.url) return null;
    let u;
    try { u = new URL(String(input.url)); } catch (e) { return null; }
    const host = (u.hostname || '').toLowerCase();
    if (!host) return null;
    let path = sanitizePathname(u.pathname);
    const keys = [];
    try {
      for (const k of u.searchParams.keys()) {
        if (k && !keys.includes(k) && keys.length < MAX_QUERY_KEYS) keys.push(k);
      }
    } catch (e) {}
    if (keys.length) path += `?${keys.join(',')}`;
    const method = String(input.method || 'GET').toUpperCase().slice(0, 12) || 'GET';
    const at = Number.isFinite(input.at) ? input.at : 0;
    return { method, host, path, at };
  } catch (e) {
    return null;
  }
}

/**
 * Kisi jawab me file ke server address ka host chhupa hai kya?
 * input = { location, bodyText } — location redirect header ki
 * qeemat; bodyText string ya Buffer (latin1 me padha jata hai;
 * JSON-escaped roop me bhi host bilkul aise hi dikhta hai kyunke
 * '.' escape nahi hota). Sirf pehle MAX_BODY_SCAN_BYTES dekhe
 * jate hain. Natija sirf haan/na — asal URL kabhi nahi lautta.
 */
function responseCarriesFileUrl(input) {
  try {
    if (!input) return false;
    if (typeof input.location === 'string' && input.location) {
      if (input.location.toLowerCase().includes(FILE_URL_MARKER)) return true;
    }
    let text = '';
    if (typeof input.bodyText === 'string') {
      text = input.bodyText.slice(0, MAX_BODY_SCAN_BYTES);
    } else if (input.bodyText && typeof input.bodyText === 'object' && typeof input.bodyText.length === 'number') {
      try {
        text = Buffer.from(input.bodyText).toString('latin1', 0, MAX_BODY_SCAN_BYTES);
      } catch (e) { text = ''; }
    }
    if (!text) return false;
    return text.toLowerCase().includes(FILE_URL_MARKER);
  } catch (e) {
    return false;
  }
}

/**
 * Ginati-khidki: open(clickAt) se noteSighting(at) tak.
 * noteRequest(entry) ka natija:
 *   - khidki band ya sighting ho chuki → null (ginati bhi nahi);
 *   - ginati cap ke andar → wahi entry (bulane wala log kare);
 *   - ginati cap se pehli baar aage → 'cap' (bulane wala EK
 *     overflow line log kare);
 *   - us ke baad → null (ginati phir bhi badhti hai, taaki
 *     khulase ki kul ginti sahi rahe).
 * noteSighting(at) khidki band karke khulasa deta hai:
 *   { clickAt, sightingAt, requestsBefore } — dusri baar null.
 */
function createMintWindow(opts) {
  const o = opts || {};
  const cap = Number.isFinite(o.cap) && o.cap > 0 ? Math.floor(o.cap) : DEFAULT_WINDOW_CAP;
  let openState = false;
  let sighted = false;
  let clickAt = 0;
  let count = 0;
  let capAnnounced = false;
  return {
    open(atMs) {
      openState = true;
      sighted = false;
      clickAt = Number.isFinite(atMs) ? atMs : 0;
      count = 0;
      capAnnounced = false;
    },
    close() { openState = false; },
    isOpen() { return openState && !sighted; },
    requestCount() { return count; },
    noteRequest(entry) {
      if (!openState || sighted || !entry) return null;
      count++;
      if (count <= cap) return entry;
      if (!capAnnounced) { capAnnounced = true; return 'cap'; }
      return null;
    },
    noteSighting(atMs) {
      if (!openState || sighted) return null;
      sighted = true;
      openState = false;
      return {
        clickAt,
        sightingAt: Number.isFinite(atMs) ? atMs : 0,
        requestsBefore: count
      };
    }
  };
}

module.exports = {
  FILE_URL_MARKER,
  DEFAULT_WINDOW_CAP,
  MAX_BODY_SCAN_BYTES,
  sanitizeRequestEntry,
  responseCarriesFileUrl,
  createMintWindow
};
