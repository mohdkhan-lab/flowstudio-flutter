'use strict';

// ---------------------------------------------------------------------------
// v2.48.83 (STREAM-FIRST DOWNLOAD — OWNER ORDER 2026-11-10):
// render-complete par SAB SE PEHLA download rasta. Owner ke
// alfaaz ka saar (.81 field test ke baad): "video bante hi
// turant download hona chahiye — 14.9s ka gap bilkul nahi
// chahiye, milliseconds ka time bhi nahi lagna chahiye."
//
// Code se sabit haqeeqat (.81 field log, 2026-11-10
// 15:01–15:02, NSR15-D3-81TEST):
//   - Render-complete ke pal hi (menu click se ~2.5s PEHLE)
//     page khud asal file ki poori stream wire par mangti
//     hai: '[ROOT] gv-req … itag=18 dur=10.054 range=none
//     from=flow.google.com/asb/* status=302' — asb 302 ka
//     nishana googlevideo ka full-duration encode (itag 18
//     = 360p, itag 22 = 720p) hota hai.
//   - Capture usi stream ko apni mainpage kitab me
//     ummeedwaar banata hai (networkCapture ki
//     _recordMainpageSighting + saveGuard ka candidate
//     gate) — lekin .81 tak attempt ki tartib us
//     ummeedwaar ka intezaar hi nahi karti thi: tile-menu
//     foran chal jata tha, aur asal file ka pata (mint)
//     menu ke CLICK se banta tha (~2.5s click ka intezaar
//     + ~5.5s mint ka intezaar + ~2s fetch = 14.9s gap).
//   - Verbatim-probe is ka jawab NAHI hai: wo seekhi hui
//     mint darkhwast hu-bahu dohraya hai (observe-only)
//     aur us ka jawab 'carriesUrl=no' deta hai kyunki
//     click se pehle is task ke liye kuch mint hua hi
//     nahi hota (ZEROCLICK2/5 ki falsification barkarar).
//     Mint substitution replay TEACHER ki file deta hai —
//     is pack me wo KABHI nahi chalaya jata.
//
// Is liye ye rasta: attempt ki shuruaat me bandhi hadd
// (STREAM_FIRST_WAIT_MS) tak capture kitab par nazar —
// is task ke naam bandhne wala pehla claimable
// full-duration stream (googlevideo itag 18/22 jiska dur
// task ki duration ke aas-paas ho, ya bandhan-prapt
// flow-content ummeedwaar) usi pal dawa (claim) hokar
// aam save point / FAST-DL fetch machinery se save hota
// hai. Koi click nahi, koi editor nahi, koi mint nahi.
// Hadd ke andar koi stream na mile to tartib bilkul
// purani: tile-menu → editor-harvest.
//
// Ye file KHALIS hisaab hai (koi capture/engine haalat
// nahi chhooti) — engine (flowAutomation ka
// _tryStreamFirstDownload) kitab + dawa/zeher ki
// fehristein yahan deta hai, faisla yahin hota hai,
// bandhan ka faisla saveGuard.mainpageBindingPlan ka
// hi rehta hai (tartib/khidki wali wahi bandish jo
// mainpage raaste par lagti hai).
// ---------------------------------------------------------------------------

const saveGuard = require('./saveGuard');

/** Bandha intezaar: render-complete ke baad claimable stream ke liye. */
const STREAM_FIRST_WAIT_MS = 3000;
/** Intezaar ke dauraan kitab dekhne ki muddat. */
const STREAM_FIRST_POLL_MS = 150;
/** Poori file wale googlevideo encode (itag 15 = chhota preview, kabhi nahi). */
const FULL_STREAM_ITAGS = Object.freeze(['18', '22']);

/**
 * Ek googlevideo videoplayback URL ke query se itag/dur
 * (khalis). googlevideo URL na ho to null. dur maujood
 * na ho / parkha na ja sake to dur null rehta hai —
 * andaze se duration kabhi nahi banta.
 */
function streamUrlInfo(url) {
  try {
    if (typeof url !== 'string' || !url) return null;
    const u = new URL(url);
    const host = (u.hostname || '').toLowerCase();
    if (!host.endsWith('googlevideo.com')) return null;
    if (!u.pathname.includes('videoplayback')) return null;
    const itag = u.searchParams.get('itag') || '';
    const rawDur = u.searchParams.get('dur');
    let dur = null;
    if (rawDur !== null && rawDur !== '') {
      const parsed = Number(rawDur);
      if (Number.isFinite(parsed) && parsed > 0) dur = parsed;
    }
    return { itag, dur };
  } catch (e) { return null; }
}

/**
 * Stream ki elaan-shuda duration task ki expected
 * duration ke aas-paas hai kya (khalis). Kasauti wahi
 * hai jo save point ki bodyVerification lagti hai —
 * DURATION_MATCH_RATIO (0.85) — lekin pehchan ke liye
 * do-tarfa: dur expected ke 0.85 guna se kam ya us ke
 * ulta-ratio se zyada ho to ye is task ki file nahi
 * ho sakti (preview encode aksar yahin pakda jata
 * hai). Expected hi na ho to kasauti nahi lagti
 * (bodyVerification ki 'no-expectation' wali hi
 * soch) — pehchan phir bandhan + save-gate par rehti
 * hai.
 */
function streamDurationMatches(dur, expectedSec) {
  const d = Number(dur);
  const exp = Number(expectedSec);
  if (!Number.isFinite(exp) || exp <= 0) return true;
  if (!Number.isFinite(d) || d <= 0) return false;
  const ratio = saveGuard.DURATION_MATCH_RATIO || 0.85;
  return d >= exp * ratio && d <= exp / ratio;
}

/**
 * Stream-first ka dawa-faisla (khalis).
 * input = {
 *   entries,        // networkCapture.mainpageEntries() ki shakal
 *   ownKey,         // is task ka captureKey
 *   ownStart,       // is task ka render-complete pal (ms)
 *   pendingOrder,   // networkCapture.mainpagePendingOrder()
 *   pendingOthers,  // networkCapture.mainpagePendingOthers(ownKey)
 *   expectedDurationSec,
 *   teacherUrl,     // teacher ka mint address (kabhi dawa nahi)
 *   excludedUrls,   // Set/array: zeher-yafta + dusre task ke dawa wale
 * }
 * natija = { url, entry, reason } ya null.
 *
 * Darwaze (sab ek saath):
 *   - entry capture ke candidate gate se guzra ho
 *     (entry.candidate === true — kul size hadd se
 *     upar; chhote preview wahan hi ruk jate hain);
 *   - teacher ka address kabhi nahi; excluded (zeher /
 *     dusre ke dawa wala) kabhi nahi;
 *   - googlevideo ho to itag 18/22 (poori file wala
 *     encode) AUR dur expected ke aas-paas;
 *     flow-content ho to itag/dur ki shart nahi (us ki
 *     pehchan bandhan + save point ki duration
 *     tasdeeq se banti hai — mainpage raaste ki hi
 *     bandish);
 *   - bandhan saveGuard.mainpageBindingPlan se —
 *     kataar me meri jagah wala ummeedwaar hi mera;
 *     be-tarteebi (ambiguity) par dawa NAHI.
 */
function streamFirstEntryPick(input) {
  const o = input && typeof input === 'object' ? input : {};
  const entries = Array.isArray(o.entries) ? o.entries : [];
  const excluded = new Set();
  try {
    if (o.excludedUrls) {
      for (const u of o.excludedUrls) { if (typeof u === 'string' && u) excluded.add(u); }
    }
  } catch (e) {}
  const teacherUrl = typeof o.teacherUrl === 'string' && o.teacherUrl ? o.teacherUrl : null;
  const expectedSec = Number(o.expectedDurationSec) || 0;
  const eligible = [];
  for (const e of entries) {
    if (!e || typeof e.url !== 'string' || !e.url) continue;
    if (e.candidate !== true) continue;
    if (teacherUrl && e.url === teacherUrl) continue;
    if (excluded.has(e.url)) continue;
    if (e.src === 'googlevideo') {
      const info = streamUrlInfo(e.url);
      if (!info) continue;
      if (!FULL_STREAM_ITAGS.includes(info.itag)) continue;
      if (info.dur === null) continue;
      if (!streamDurationMatches(info.dur, expectedSec)) continue;
    } else if (e.src !== 'flow-content') {
      continue;
    }
    if (!Number.isFinite(e.firstSeenAt)) continue;
    eligible.push(e);
  }
  if (eligible.length === 0) return null;
  const plan = saveGuard.mainpageBindingPlan({
    candidates: eligible.map(e => ({ url: e.url, firstSeenAt: e.firstSeenAt, seq: e.seq })),
    ownKey: o.ownKey != null ? o.ownKey : null,
    ownStart: Number.isFinite(o.ownStart) ? o.ownStart : 0,
    pendingOrder: Array.isArray(o.pendingOrder) ? o.pendingOrder : [],
    pendingOthers: Number.isFinite(o.pendingOthers) ? o.pendingOthers : 0
  });
  if (!plan || !plan.bind || !plan.url) return null;
  const entry = eligible.find(e => e.url === plan.url) || null;
  return { url: plan.url, entry, reason: plan.reason || 'order' };
}

module.exports = {
  STREAM_FIRST_WAIT_MS,
  STREAM_FIRST_POLL_MS,
  FULL_STREAM_ITAGS,
  streamUrlInfo,
  streamDurationMatches,
  streamFirstEntryPick
};
