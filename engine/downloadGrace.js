'use strict';

// v2.48.118 (F2 — DOWNLOAD GRACE): download attempt ke
// EMAANDAR FAIL verdict se pehle ki 10-second mohlat ka
// KHALIS (pure) faisla. Koi CDP nahi, koi disk nahi —
// unit tests seedha is par chalte hain. Asal intezaar
// aur save engine (flowAutomation) me hai; yahan sirf
// ye tay hota hai ke intezaar ka natija kya hai.
//
// Field failure (W10 run, Prompt #1, 2026-11-17): engine
// ne 22:41:15.7 par 'Download failed honestly' likh diya
// aur sirf ~1.6 second BAAD (22:41:16.8) browser ki apni
// blob download mukammal hui aur file save ho gayi —
// verdict ek in-flight download se race kar raha tha.
// Ab verdict se pehle ye mohlat: is task ka koi browser
// download (E1-DL observer ki kitab — downloadEventMatch)
// window ke andar mukammal ho jaye, ya is dauraan task
// kisi aur in-flight raste se save ho jaye, to attempt
// SAVED hai; kuch na aaye to fail bilkul pehle jaisa.

const { matchCompletedDownload, stripDedupSuffix } = require('./downloadEventMatch');

const GRACE_WINDOW_MS = 10000;
const GRACE_POLL_MS = 500;

/**
 * Ek task ke liye E1-DL milaan ki shartein:
 *   sinceMs    — is pal se pehle SHURU hue downloads is
 *                task ke nahi hain (attempt ka aaghaz);
 *   fileName   — ummeed ka naam (Flow ka suggested naam
 *                pehle se maloom ho tab; warna khaali —
 *                milaan bina-naame pehle-mukammal par);
 *   claimedBytes — task ki bandhi flow-content file ka
 *                size, maloom ho tab (exact size milaan);
 *                warna 0 = size shart nahi.
 */
function graceMatchOptions(task) {
  const t = task || {};
  return {
    sinceMs: Number.isFinite(t.startedAtMs) ? t.startedAtMs : 0,
    fileName: t.expectedName ? String(t.expectedName) : '',
    fileSize: Number.isFinite(t.claimedBytes) && t.claimedBytes > 0 ? t.claimedBytes : 0
  };
}

/**
 * Mohlat ka faisla ek pal par:
 *   state       — E1-DL kitab { begins, completed }
 *                 (downloadEventMatch wali shakal; null
 *                 ho to event wala rasta band, lekin
 *                 mediaSaved wala saboot phir bhi chalta
 *                 hai);
 *   task        — { startedAtMs, expectedName,
 *                 claimedBytes, mediaSaved };
 *   nowMs       — is pal ka waqt;
 *   graceStartMs — mohlat kab shuru hui.
 * Lautta hai { action, via, match, waitedMs }:
 *   'saved' — mediaSaved pehle se sach (via
 *             'already-saved') ya is task ka download
 *             event mukammal (via 'event', match ke
 *             saath);
 *   'fail'  — window poora, kuch nahi aaya;
 *   'wait'  — abhi window baaki hai.
 * Ghalat-task ke events kabhi nahi bandhte: milaan
 * downloadEventMatch ki sharton (sinceMs ke baad shuru,
 * naam/size diye hon to unhi ka milaan) se hota hai.
 */
function decideGrace(state, task, nowMs, graceStartMs) {
  const t = task || {};
  const start = Number.isFinite(graceStartMs)
    ? graceStartMs
    : (Number.isFinite(nowMs) ? nowMs : 0);
  const now = Number.isFinite(nowMs) ? nowMs : start;
  const waitedMs = Math.max(0, now - start);
  if (t.mediaSaved) {
    return { action: 'saved', via: 'already-saved', match: null, waitedMs };
  }
  let match = null;
  if (state) {
    try { match = matchCompletedDownload(state, graceMatchOptions(t)); } catch (e) { match = null; }
  }
  if (match) {
    return { action: 'saved', via: 'event', match, waitedMs };
  }
  if (waitedMs >= GRACE_WINDOW_MS) {
    return { action: 'fail', via: 'timeout', match: null, waitedMs: GRACE_WINDOW_MS };
  }
  return { action: 'wait', via: 'pending', match: null, waitedMs };
}

/**
 * Watch snapshot se ek naam (us ke Chrome dedup roopon
 * samet — 'Name (1).mp4' bhi) bahar karo, taaki jo file
 * mohlat ke dauraan utri hai use aam save rasta 'nayi
 * file' maan kar utha sake. existingFilesByFolder =
 * Map<folder, Set<name>> (_nativePrepareWatch wali
 * shakal). Kaatay gaye naamon ki ginti lautti hai.
 */
function snapshotExcluding(existingFilesByFolder, fileName) {
  if (!existingFilesByFolder || typeof existingFilesByFolder.forEach !== 'function' || !fileName) return 0;
  const wanted = stripDedupSuffix(String(fileName));
  let removed = 0;
  existingFilesByFolder.forEach((set) => {
    if (!set || typeof set.forEach !== 'function' || typeof set.delete !== 'function') return;
    const drop = [];
    set.forEach((name) => {
      if (stripDedupSuffix(String(name)) === wanted) drop.push(name);
    });
    for (const name of drop) { set.delete(name); removed++; }
  });
  return removed;
}

/** waited=<s> ka roop: 10000 → '10', 1600 → '1.6'. */
function graceWaitedText(waitedMs) {
  const s = Math.max(0, Number(waitedMs) || 0) / 1000;
  const r = Math.round(s * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/**
 * Mohlat ki [ROOT] line:
 *   [ROOT] download-grace task=<id> waited=<s> result=saved|none
 */
function downloadGraceLogLine(taskLabel, waitedMs, result) {
  const label = (taskLabel === null || taskLabel === undefined || taskLabel === '') ? '-' : String(taskLabel);
  return `[ROOT] download-grace task=${label} waited=${graceWaitedText(waitedMs)} result=${result === 'saved' ? 'saved' : 'none'}`;
}

module.exports = {
  GRACE_WINDOW_MS,
  GRACE_POLL_MS,
  graceMatchOptions,
  decideGrace,
  snapshotExcluding,
  graceWaitedText,
  downloadGraceLogLine
};
