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

module.exports = { contentHash, checkDuplicate, recordSave, claimedByOtherTask };
