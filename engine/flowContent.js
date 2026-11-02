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

module.exports = { FLOW_CONTENT_HOST, isFlowContentHost, isFlowContentVideoUrl };
