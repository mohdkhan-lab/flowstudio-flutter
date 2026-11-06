'use strict';

// v2.48.28 (SERVER-FIRST): Flow ke signed CDN host ki pehchan —
// sirf shakal (shape) ki jaanch, koi I/O nahi, kabhi throw nahi.
//
// FASTTEST2 (v2.48.27, owner ke PC par engine-log sabit,
// 2026-11-02 21:27): file asal me Flow ke server
// `flow-content.google/video/*` se aati hai (video/mp4,
// 1,201,697 bytes; window summary me sab se bada host). Page tile
// ke saath harkat ke dauraan khud ye fetch karta hai. Agar engine
// yahi URL pakad le to file seedha server se uth sakti hai — menu,
// blob, download manager, teeno ke baghair.
//
// HIFAZAT: host ka EXACT match lazmi hai. `flow-content.google.
// evil.com`, `flow-content.google@evil.com` jaisi naklein URL
// parser ke hostname par hi mar jati hain — yahan koi suffix /
// endsWith wala dheela match NAHI hai. Rasta (path) `/video/` se
// shuru hona chahiye (FASTTEST2 me dekhi asal shakal), aur jab
// content-type diya jaye to wo video/* hona chahiye.

const FLOW_CONTENT_HOST = 'flow-content.google';

/** Host bilkul flow-content.google hai kya (nakal kabhi nahi). */
function isFlowContentHost(host) {
  return String(host || '').trim().toLowerCase() === FLOW_CONTENT_HOST;
}

/**
 * URL Flow ke server wala asal video address hai kya?
 * contentType ikhtiyari (optional) hai: diya jaye (khaali na ho)
 * to video/* hona lazmi hai; na diya jaye to sirf host+path
 * ki jaanch hoti hai.
 */
function isFlowContentVideoUrl(url, contentType) {
  try {
    if (!url || typeof url !== 'string') return false;
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    // URL parser hostname ko lowercase karta hai aur userinfo ko
    // alag rakhta hai — exact barabari hi naklon ko rokti hai.
    if (u.hostname !== FLOW_CONTENT_HOST) return false;
    if (!/^\/video\/.+/.test(u.pathname)) return false;
    if (contentType !== undefined && contentType !== null && String(contentType).trim() !== '') {
      const ct = String(contentType).split(';')[0].trim().toLowerCase();
      if (!ct.startsWith('video/')) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * v2.48.30 (POST-CLICK RACE): menu ke resolution click ke
 * BAAD dikhne wala TAAZA flow-content URL chunna — KHALIS
 * (pure) hisaab, unit tests seedha is par chalte hain.
 *
 * entries = networkCapture.recentFlowContentVideos(...) ki
 * shakal: [{ url, type, at }] (purane se naye ki taraf).
 * opts = {
 *   sinceMs,             // is attempt ke resolution-click ka waqt
 *   isClaimed(url),      // capture me pehle se kisi ke naam hai?
 *   isOwnUrl(url)        // engine ki pehchan: task ka apna / purana nahi
 * }
 *
 * Usool (pehchan ka langar SIRF yahi click hai — FASTTEST2 aur
 * FASTTEST4 dono me sabit: flow-content fetch hamesha menu ke
 * Download→resolution click ke BAAD aata hai):
 *   - entry ka `at` sinceMs se pehle ka ho → PURANA (stale),
 *     is click se pehle ka fetch is task ka saboot nahi — inkaar;
 *   - URL matcher (exact host + /video/ + video type) se na
 *     guzre → inkaar;
 *   - pehle se claimed/consumed ho → inkaar;
 *   - isOwnUrl diya gaya ho aur jhooth kahe → inkaar (purana
 *     ya pehle istemal-shuda address kabhi nahi);
 *   - usable AKELA ho → { url, at, via:'post-click' };
 *   - usable KAI hon → { ambiguous:true, count } — shak me
 *     ghalat video uthane se behtar hai race hi na ho.
 * Kuch usable na ho to null.
 */
function pickRaceFlowContentUrl(entries, opts) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const o = opts || {};
  const sinceMs = Number.isFinite(o.sinceMs) ? o.sinceMs : 0;
  const isClaimed = typeof o.isClaimed === 'function' ? o.isClaimed : () => false;
  const isOwnUrl = typeof o.isOwnUrl === 'function' ? o.isOwnUrl : null;
  const usable = [];
  for (const e of entries) {
    if (!e || !e.url) continue;
    if (!Number.isFinite(e.at) || e.at < sinceMs) continue; // stale — click se pehle ka
    if (!isFlowContentVideoUrl(e.url, e.type)) continue;
    let claimed = false;
    try { claimed = !!isClaimed(e.url); } catch (err) { claimed = false; }
    if (claimed) continue;
    if (isOwnUrl) {
      let own = false;
      try { own = !!isOwnUrl(e.url); } catch (err) { own = false; }
      if (!own) continue;
    }
    usable.push({ url: e.url, at: e.at });
  }
  if (usable.length === 0) return null;
  if (usable.length === 1) return { url: usable[0].url, at: usable[0].at, via: 'post-click' };
  return { ambiguous: true, count: usable.length };
}

module.exports = { FLOW_CONTENT_HOST, isFlowContentHost, isFlowContentVideoUrl, pickRaceFlowContentUrl };
