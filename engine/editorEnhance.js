'use strict';

// ---------------------------------------------------------------------------
// EDITOR ENHANCE — khalis hisaab (pure helpers, v2.48.74 Item B).
//
// Owner ka download niyam (2026-10-27 se, 2026-11-09 ko phir pakka):
// generation ki quality hi ORIGINAL hoti hai; editor ke Download
// menu me "Upscaled" wala chuna jaye to file EK STEP UPAR milti hai
// (360p → 720p Upscaled, 720p → 1080p Upscaled). Us se upar wali
// koi bhi quality (4K) 'Upgrade' paywall ke peeche hai — use KABHI
// nahi chhuna. Ye file sirf faisla karti hai: kaunsi entry chunni
// hai. DOM talaash/click flowAutomation me hai; faisla yahan hai
// taaki fixture menus par unit test ho sake.
// ---------------------------------------------------------------------------

/**
 * Settings ki quality se asal GENERATION (native) quality.
 * Engine ka maujooda niyam (flowAutomation credit/settings hisaab):
 * '360p' → 360p par generation; '720p' aur '1080p' dono 720p par
 * generate hote hain (1080p Flow me generation hoti hi nahi — wo
 * enhanced download hai).
 */
function nativeQualityOf(quality) {
  const q = String(quality || '').toLowerCase();
  if (q.includes('360')) return '360p';
  return '720p';
}

/** Native quality se ek step upar wali enhanced quality. */
function enhanceTargetFor(nativeQuality) {
  return nativeQuality === '360p' ? '720p' : '1080p';
}

/**
 * Menu entries me se chunni hui "Upscaled" entry.
 * entries: [{ text, upgrade }] — text = entry ka poora dikhai dene
 * wala text (label + sub-label, kisi bhi case me); upgrade = entry
 * par 'Upgrade' paywall ka nishaan (alag pill/button ya text).
 * Chunav ke niyam (sab lazmi):
 *   - text me target quality ho ('720p' / '1080p');
 *   - text me 'upscaled' ho ('Original size' kabhi nahi);
 *   - entry par Upgrade ka nishaan NA ho (paywall kabhi nahi).
 * Koi entry na mile to null — bulane wala original-quality
 * fallback par jata hai, andaza laga kar koi aur entry NAHI
 * chunta (v2.30.4 ki seekh: menu ka pehla milta-julta item
 * chup-chaap chunna galat file de sakta hai).
 */
function pickUpscaledEntry(entries, targetQuality) {
  const target = String(targetQuality || '').toLowerCase();
  if (!target || !Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (!entry) continue;
    const text = String(entry.text || '').toLowerCase();
    if (!text.includes(target)) continue;
    if (!text.includes('upscaled')) continue;
    if (entry.upgrade) continue;
    if (text.includes('upgrade')) continue;
    return entry;
  }
  return null;
}

/** Run settings se download mode — 'enhanced' ya default 'original'. */
function downloadModeOf(settings) {
  const m = String((settings && settings.downloadMode) || '').toLowerCase();
  return m === 'enhanced' ? 'enhanced' : 'original';
}

/**
 * Enhanced file ki pehchan uske asal dimensions se: chhoti side
 * (min(width, height)) target ke barabar honi chahiye (2px ki
 * riayat — encode kabhi 1-2px idhar-udhar ho sakta hai). Native
 * file is kasauti par hamesha fail hogi (720p ka min-side 720 <
 * 1078), is liye editor ki apni playback stream (original) kabhi
 * enhanced keh kar save nahi ho sakti. Dimensions na milen
 * (probe fail) to jawab false — saboot ke baghair dawa nahi.
 */
/**
 * v2.48.74 (scope 3b — IN-FLIGHT CAPTURE): editor-
 * harvest me in-page fetch kab SHURU karna hai.
 * Kitab me mukammal body ho to fetch ka sawal hi
 * nahi (captured-buffer jeet-ta hai); body na ho
 * lekin is address ki capture ABHI CHAL rahi ho
 * (streaming, complete nahi) to bhi fetch NAHI —
 * chalti capture se ladna .73 ke field run me
 * 'Failed to fetch' par ~3s zaya kar gaya tha,
 * aur capture ke mukammal hote hi wahi body kitab
 * se save ho jati hai. Fetch SIRF tab jab na body
 * ho, na capture chal rahi ho.
 */
function shouldSkipInPageFetch(input) {
  const o = input || {};
  if (o.haveBuffer) return true;
  return o.captureInFlight === true;
}

function dimensionsMatchTarget(dimensions, targetQuality) {
  if (!dimensions || !(dimensions.width > 0) || !(dimensions.height > 0)) return false;
  const target = String(targetQuality || '').toLowerCase();
  const targetMinSide = target.includes('1080') ? 1080 : (target.includes('720') ? 720 : 0);
  if (!targetMinSide) return false;
  const minSide = Math.min(dimensions.width, dimensions.height);
  return minSide >= targetMinSide - 2;
}

module.exports = {
  nativeQualityOf,
  enhanceTargetFor,
  pickUpscaledEntry,
  downloadModeOf,
  dimensionsMatchTarget,
  shouldSkipInPageFetch
};
