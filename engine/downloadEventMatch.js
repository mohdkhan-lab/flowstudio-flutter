'use strict';

// v2.48.30 (EVENT-MATCH): browser-level download events
// (Browser.downloadWillBegin / downloadProgress, v2.48.25 ka
// E1 session) ki haalat ko ek khatam-shuda download se jodne
// ka KHALIS (pure) hisaab — koi CDP nahi, koi disk nahi, is
// liye unit tests seedha is par chalte hain.
//
// FASTTEST4 (2026-11-02, v2.48.29, owner ke PC ke engine log
// se sabit) me file menu-blob route se bilkul sahi save hui,
// lekin [FAST-DL] line ne event=no kaha. Wajah flowAutomation
// ke poll loop ki bandish thi: eventSave SIRF usi iteration
// me bandhta tha jis me file disk par pehli baar dikhe, aur
// evtDone us iteration ke AAGHAZ me gina jata tha — Chrome
// file ka rename downloadProgress 'completed' event ki
// Node-delivery se pehle kar de to event us iteration me
// dikhai hi nahi deta tha, loop toot jata tha, aur dobara
// milaan (reconciliation) kabhi hota hi nahi tha. Is module
// ka kaam wahi milaan hai: waqt ki khidki + naam (Chrome ke
// " (1)" dedup suffix ki riayat ke saath) + exact size —
// taaki save ke baad ka ek mukhtasar reconciliation bhi
// event ko pakad sake, chahe event intezaar shuru hone se
// PEHLE fire ho chuka ho (wo haalat state me pehle se
// maujood hoti hai — yahan koi "naya event" shart nahi hai).

/**
 * Chrome ke dedup suffix ko hatao: "name (1).mp4" → "name.mp4",
 * "name (12).mp4" → "name.mp4". Suffix na ho to naam jaisa hai.
 */
function stripDedupSuffix(fileName) {
  const name = String(fileName || '');
  return name.replace(/ \(\d+\)(\.[^.]+)$/, '$1').replace(/ \(\d+\)$/, '');
}

/**
 * Ek download record complete ginna hai kya: state 'completed'
 * ho (canceled kabhi nahi).
 */
function isCompletedRecord(rec) {
  return !!rec && rec.state === 'completed';
}

/**
 * state = { begins: [{guid, suggestedFilename, at}],
 *           completed: Map<guid, {state, at, receivedBytes, totalBytes}> }
 * opts  = { sinceMs, fileName?, fileSize? }
 *
 * sinceMs ke baad SHURU hue downloads me se pehla COMPLETED
 * wala lautao — lekin jab fileName/fileSize diye gaye hon to
 * milaan unhi se hoga:
 *   1. naam exact mile → wahi;
 *   2. naam dedup-suffix hata kar mile (disk par " (1)" wala
 *      naam ho ya suggested me ho) → wahi;
 *   3. size exact mile (totalBytes, ya total na ho to
 *      receivedBytes) aur aisa ummeedwaar AKELA ho → wahi;
 *   4. fileName/fileSize dono na hon → pehla completed
 *      (purana _dlCompletedSince wala vyavhaar).
 * Kuch na mile to null. Lautta hai:
 *   { guid, suggestedFilename, at, receivedBytes, totalBytes }
 */
function matchCompletedDownload(state, opts) {
  if (!state || !Array.isArray(state.begins) || !state.completed) return null;
  const o = opts || {};
  const sinceMs = Number.isFinite(o.sinceMs) ? o.sinceMs : 0;
  const fileName = o.fileName ? String(o.fileName) : '';
  const fileSize = Number.isFinite(o.fileSize) && o.fileSize > 0 ? o.fileSize : 0;

  const done = [];
  for (const b of state.begins) {
    if (!b || !b.guid || !Number.isFinite(b.at) || b.at < sinceMs) continue;
    const c = typeof state.completed.get === 'function' ? state.completed.get(b.guid) : state.completed[b.guid];
    if (!isCompletedRecord(c)) continue;
    done.push({
      guid: b.guid,
      suggestedFilename: b.suggestedFilename || '',
      at: c.at,
      receivedBytes: Number.isFinite(c.receivedBytes) ? c.receivedBytes : -1,
      totalBytes: Number.isFinite(c.totalBytes) ? c.totalBytes : -1
    });
  }
  if (done.length === 0) return null;

  if (fileName) {
    const exact = done.find(d => d.suggestedFilename === fileName);
    if (exact) return exact;
    const wanted = stripDedupSuffix(fileName);
    const tolerant = done.find(d => d.suggestedFilename && stripDedupSuffix(d.suggestedFilename) === wanted);
    if (tolerant) return tolerant;
  }
  if (fileSize) {
    const bySize = done.filter(d => d.totalBytes === fileSize || (d.totalBytes <= 0 && d.receivedBytes === fileSize));
    if (bySize.length === 1) return bySize[0];
    if (bySize.length > 1) return null; // shak — ghalat event se jodna mana hai
  }
  if (!fileName && !fileSize) return done[0];
  return null;
}

module.exports = { stripDedupSuffix, isCompletedRecord, matchCompletedDownload };
