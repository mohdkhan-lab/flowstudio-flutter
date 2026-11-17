'use strict';

// v2.48.118 (F1 — ZOOM LATE + RETRY): browser ke menu zoom
// (Ctrl+0, phir Ctrl+'-' × 5 — .116 Z3 wala keyboard rasta)
// ke LAGANE ke faisle ka KHALIS (pure) hisaab. Koi page
// nahi, koi keyboard nahi — is liye unit tests seedha is
// par chalte hain.
//
// Field failure (W10 run, batch_1794935355709, 2026-11-17):
// zoom browser khulne ke ~5 second baad, page ke load
// hote hue lagaya gaya — keystrokes gum ho gaye, engine
// ne '[ROOT] browser-zoom ... zoom=0.5 dpr=1 FAILED' log
// kiya, lekin dobara koshish KABHI nahi ki. Owner ko
// browser hamesha 100% par mila. Is module ka faisla:
// BINDING koshish Flow workspace ke tayyar hone ke BAAD
// hogi, har koshish ke baad devicePixelRatio ka read-back
// hoga, aur dpr ~0.5 (0.48–0.52) na mile to settled pal
// par dobara — kul 3 koshishon tak. Zoom ki nakami kisi
// run ko kabhi nahi rokegi (faisla sirf 'done' / 'retry' /
// 'giveup' deta hai; engine use kabhi throw nahi karta).

const ZOOM_TARGET_SCALE = 0.5;
const ZOOM_MAX_ATTEMPTS = 3;
const ZOOM_RETRY_DELAY_MS = 800;
// Brief ki band: dpr 0.48–0.52 hi 'verified' hai.
const ZOOM_DPR_TOLERANCE = 0.02;

/**
 * Ek read-back dpr target band me hai kya. Naap na mile
 * (null/NaN) to hamesha false — saboot na ho to verified
 * nahi kehte.
 */
function zoomDprInBand(dpr, scale = ZOOM_TARGET_SCALE) {
  const s = Number(scale);
  if (!Number.isFinite(s) || s <= 0) return false;
  if (dpr === null || dpr === undefined) return false;
  const n = Number(dpr);
  return Number.isFinite(n) && Math.abs(n - s) <= ZOOM_DPR_TOLERANCE + 1e-9;
}

/**
 * `attempts` koshishein ho chuki hain aur aakhri read-back
 * `dpr` hai — agla qadam kya ho:
 *   'done'   — dpr band me hai, ruk jao;
 *   'retry'  — band se bahar hai aur koshishein baaki hain;
 *   'giveup' — 3 koshishein poori, aage badho (run rukta
 *              nahi — zoom kabhi generation ko block nahi
 *              karta).
 */
function nextZoomAction(attempts, dpr, scale = ZOOM_TARGET_SCALE) {
  const a = Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0;
  if (zoomDprInBand(dpr, scale)) return 'done';
  if (a >= ZOOM_MAX_ATTEMPTS) return 'giveup';
  return 'retry';
}

/**
 * Project grid me daakhil hone par EK aur koshish banti
 * hai kya: sirf tab jab workspace-ready wali binding
 * koshish ho chuki ho (ensuredOnce), wo nakam rahi ho
 * (verified false), aur ye grid wali koshish pehle na
 * hui ho (reasserted false). Navigation focus reset kar
 * sakti hai — is liye ye ek mauqa aur; us ke baad nahi.
 */
function shouldReapplyZoom(state) {
  if (!state) return false;
  if (!state.ensuredOnce || state.verified) return false;
  return !state.reasserted;
}

/** Ek read-back value ka log roop ('n/a' jab naap na ho). */
function zoomDprText(v) {
  if (v === null || v === undefined) return 'n/a';
  const n = Number(v);
  if (!Number.isFinite(n)) return 'n/a';
  return String(Math.round(n * 1000) / 1000);
}

/**
 * Har koshish ki [ROOT] line:
 *   [ROOT] browser-zoom account=<name> attempt=<n> dpr=<v> verified|FAILED
 */
function zoomAttemptLogLine(accountName, attempt, dpr, scale = ZOOM_TARGET_SCALE) {
  const name = String(accountName == null ? '' : accountName).replace(/\s+/g, ' ').trim() || '-';
  const verdict = zoomDprInBand(dpr, scale) ? 'verified' : 'FAILED';
  return `[ROOT] browser-zoom account=${name} attempt=${attempt} dpr=${zoomDprText(dpr)} ${verdict}`;
}

module.exports = {
  ZOOM_TARGET_SCALE,
  ZOOM_MAX_ATTEMPTS,
  ZOOM_RETRY_DELAY_MS,
  ZOOM_DPR_TOLERANCE,
  zoomDprInBand,
  nextZoomAction,
  shouldReapplyZoom,
  zoomDprText,
  zoomAttemptLogLine
};
