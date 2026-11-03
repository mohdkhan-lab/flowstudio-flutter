'use strict';

// v2.48.35 (GUARD): cross-task contamination ke khilaf KHALIS
// (pure) faisla-layer — koi I/O nahi, sirf crypto hash + hisaab,
// is liye unit tests seedha is par chalte hain (mintReplay.js /
// blobHarvest.js wali hi tarz).
//
// SABOOT (ZEROCLICK2, v2.48.34, owner ke PC par engine log +
// asal files se MK-verified, 2026-11-03): 2-prompt run me
// Prompt #2 ki download koshish ne Prompt #1 ki file ko hi
// Prompt #2 ke naam par save kar diya (registry opportunistic
// save, gap=0.3s) — dono files byte-identical (1,216,989B)
// theen aur #2 ke frame me laal ball thi, neeli car nahi. Run
// ne phir bhi "all 2 saved" ki jhooti kamyabi di. Wajah: koi
// bhi rasta ye nahi jaanchta tha ke jo bytes save ho rahe
// hain, wo is run me KISI AUR task ke naam par pehle hi save
// ho chuke hain.
//
// Ye module wahi jaanch deta hai:
//   contentHash(buffer)      — bytes ki pehchan (sha256 hex).
//                              Hash kabhi LOG nahi hota — ye
//                              sirf engine ki andarooni kitab
//                              hai (shape-only discipline).
//   checkDuplicate(reg, key, hash)
//                            — is run me ye hash kisi AUR task
//                              ke naam darj hai to duplicate
//                              (reject); apne hi task ke naam
//                              ho to re-save jaiz (allow); pehli
//                              dafa ho to allow.
//   recordSave(reg, key, hash, promptIndex)
//                            — kamyaab save ki kitab-bandhi.
//   claimedByOtherTask(ownerKey, taskKey)
//                            — claim discipline ka khalis
//                              usool: bandha hua URL kisi AUR
//                              task ke naam ho to is task ke
//                              liye kabhi qabil nahi.

const crypto = require('crypto');

/** Bytes ki pehchan (sha256 hex); khaali/ghalat input par null. */
function contentHash(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } catch (e) {
    return null;
  }
}

/**
 * Is run ki saved-hash kitab (Map<hash, {key, promptIndex}>)
 * me is hash ka faisla:
 *   { duplicate:false }                                  — save jaiz hai
 *   { duplicate:true, otherKey, otherPromptIndex }       — ye bytes
 *     kisi AUR task ke naam pehle hi save ho chuke hain; reject.
 * Registry / key / hash me se kuch bhi ghayab ho to allow —
 * guard apni hi khami par kisi save ko nahi rokta (baaki
 * pehchan-darwaze apni jagah barkarar hain).
 */
function checkDuplicate(registry, taskKey, hash) {
  try {
    if (!registry || typeof registry.get !== 'function') return { duplicate: false };
    if (!taskKey || !hash) return { duplicate: false };
    const owner = registry.get(hash);
    if (!owner) return { duplicate: false };
    if (owner.key === taskKey) return { duplicate: false };
    return {
      duplicate: true,
      otherKey: owner.key,
      otherPromptIndex: Number.isInteger(owner.promptIndex) ? owner.promptIndex : -1
    };
  } catch (e) {
    return { duplicate: false };
  }
}

/**
 * Ek kamyaab save ki kitab-bandhi. Pehla malik hi rehta hai —
 * ek hash par dusri kitab-bandhi use badal nahi sakti (guard
 * se guzar kar dusra task wahan pahunch hi nahi sakta, aur
 * race me apne hi task ki dobara bandhi bekaar hai).
 */
function recordSave(registry, taskKey, hash, promptIndex) {
  try {
    if (!registry || typeof registry.set !== 'function' || typeof registry.has !== 'function') return;
    if (!taskKey || !hash) return;
    if (registry.has(hash)) return;
    registry.set(hash, {
      key: taskKey,
      promptIndex: Number.isInteger(promptIndex) ? promptIndex : -1
    });
  } catch (e) {}
}

/**
 * Claim discipline ka khalis usool (_pickServerFetchUrl wali
 * hi pehchan): URL pehle se bandha (claimed) ho AUR bandhan
 * is task ka na ho → ye URL is task ka ho hi nahi sakta.
 * Bandhan na ho, ya is task ka apna ho → inkaar nahi.
 */
function claimedByOtherTask(ownerKey, taskKey) {
  return !!ownerKey && ownerKey !== taskKey;
}

// ---------------------------------------------------------------------------
// v2.48.36 (ROOT PACK — D): PAGE-FETCH HARVEST ke darwaze.
//
// Page khud editor ke preview/playback par asal server file
// (flow-content.google/video/*) ke bytes khinchta hai — wohi
// bytes exact server file hain. Capture unhe yaad rakhe ya
// na rakhe, is ka faisla yahan hota hai (khalis hisaab):
//   harvestGenericGates — bandhan (binding) se pehle wale
//     aam darwaze: body maujood, size hadd ke andar, MP4
//     header theek, duration ke size floor se upar.
//   harvestCandidateVerdict — wohi + bandhan lazmi: URL
//     kisi task ke naam bandha hi na ho to candidate kabhi
//     nahi (galat task ki file uthane ka khatra yahin
//     rukta hai).
// ---------------------------------------------------------------------------

/** Harvest me rakhi ja sakne wali sab se badi body (~8MB). */
const HARVEST_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Bandhan se pehle ke aam darwaze. input =
 * { byteLength, floorBytes, headerOk, maxBytes }.
 * Natija { ok, reason } — reason: 'empty' | 'too-big' |
 * 'bad-header' | 'below-floor' | 'ok'.
 */
function harvestGenericGates(input) {
  const o = input && typeof input === 'object' ? input : {};
  const len = Number.isFinite(o.byteLength) ? Math.floor(o.byteLength) : 0;
  if (len <= 0) return { ok: false, reason: 'empty' };
  const max = Number.isFinite(o.maxBytes) && o.maxBytes > 0 ? o.maxBytes : HARVEST_MAX_BYTES;
  if (len > max) return { ok: false, reason: 'too-big' };
  if (!o.headerOk) return { ok: false, reason: 'bad-header' };
  const floor = Number.isFinite(o.floorBytes) ? Math.floor(o.floorBytes) : 0;
  if (floor > 0 && len < floor) return { ok: false, reason: 'below-floor' };
  return { ok: true, reason: 'ok' };
}

/**
 * Ek bandhe hue task ke liye harvest candidate ka faisla.
 * input = harvestGenericGates wala + { bound } — URL is
 * task ke naam bandha hai kya. Bandhan na ho to sab se
 * pehla inkaar 'unbound' hai.
 * Natija { accept, reason }.
 */
function harvestCandidateVerdict(input) {
  const o = input && typeof input === 'object' ? input : {};
  if (!o.bound) return { accept: false, reason: 'unbound' };
  const g = harvestGenericGates(o);
  return { accept: g.ok, reason: g.reason };
}

// ---------------------------------------------------------------------------
// v2.48.36 (ROOT PACK — B/C): VERBATIM REPLAY ke jawab ke
// URLs par faisla. Seekhi hui mint call hu-bahu chalane par
// jawab jo flow-content address laata hai, wo ya to TEACHER
// (pichhle task) ka hota hai — tab use FETCH KABHI NAHI
// karna (context is task ka set nahi hua) — ya is task ka
// naya address hota hai — tab claim + verified fetch jaiz
// hai. Faisla yahan, khalis:
//   input = { urls, teacherUrl, isClaimed(url) }
//   natija = { action, url, freshCount }
//     'none'      — jawab me koi flow-content address nahi
//     'teacher'   — sirf teacher ka address aaya (fetch NAHI)
//     'ambiguous' — teacher se alag ek se zyada (koi nahi)
//     'claimed'   — akela naya address pehle se claimed hai
//     'save'      — akela naya, unclaimed address: url diya
// ---------------------------------------------------------------------------
function replayUrlVerdict(input) {
  const o = input && typeof input === 'object' ? input : {};
  const urls = Array.isArray(o.urls) ? o.urls.filter(u => typeof u === 'string' && u) : [];
  if (urls.length === 0) return { action: 'none', url: null, freshCount: 0 };
  const teacherUrl = typeof o.teacherUrl === 'string' && o.teacherUrl ? o.teacherUrl : null;
  const fresh = [...new Set(urls.filter(u => u !== teacherUrl))];
  if (fresh.length === 0) return { action: 'teacher', url: null, freshCount: 0 };
  if (fresh.length > 1) return { action: 'ambiguous', url: null, freshCount: fresh.length };
  let claimed = false;
  if (typeof o.isClaimed === 'function') {
    try { claimed = !!o.isClaimed(fresh[0]); } catch (e) { claimed = false; }
  }
  if (claimed) return { action: 'claimed', url: null, freshCount: 1 };
  return { action: 'save', url: fresh[0], freshCount: 1 };
}

module.exports = { contentHash, checkDuplicate, recordSave, claimedByOtherTask, HARVEST_MAX_BYTES, harvestGenericGates, harvestCandidateVerdict, replayUrlVerdict };
