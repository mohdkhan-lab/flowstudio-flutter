'use strict';

// v2.48.36 (ROOT PACK — A): download-stage ka promise-mutex —
// KHALIS (pure) tala, koi I/O nahi, is liye unit tests seedha
// is par chalte hain (saveGuard.js / mintReplay.js wali tarz).
//
// SABOOT (ZEROCLICK3, v2.48.35, owner ke PC par engine log):
// do tasks ek saath generate ho rahe hon to PEHLE task ki
// mint binding download ke pal gum ho jati hai — viewer
// route at=pick reason=no-url-in-window par harta hai,
// halanke usi khidki me [MINT] response-carries-file-url
// fire hua tha. Wajah: dusre task ki render/monitor harkat
// aur pehle ke download marhale ek hi page + ek hi capture
// par aapas me ulajhte hain. Generation/rendering parallel
// rehna chahiye (wohi asal speed hai), lekin DOWNLOAD ka
// marhala — pehle route se save/aakhri fallback tak — ek
// pal me sirf EK task ka hona chahiye.
//
// Tala capture-session ke hisaab se bandha hai
// (stageLockFor): jis capture par do engine hisse bhi kaam
// kar rahe hon (monitor round + drain/retry round), un
// sab ko EK hi tala milta hai.
//
// Usool:
//   - acquire() usi tartib me khulta hai jis tartib me
//     bulaya gaya tha (FIFO kataar);
//   - release() idempotent hai (dobara bulane par kuch
//     nahi hota);
//   - kataar kabhi reject nahi hoti — ek holder ki nakami
//     (withLock ke andar throw) agle ko nahi rok sakti;
//   - acquire() ka natija { waitedMs, release } — waitedMs
//     wohi waqt hai jo kataar me guzra (engine >1s par
//     [ROOT] line deta hai).

/**
 * Ek naya stage tala. nowFn ikhtiyari ghari hai (tests ke
 * liye) — har acquire apni kataar-ghari usi se napta hai.
 */
function createStageLock() {
  let tail = Promise.resolve();
  async function acquire(nowFn) {
    const now = typeof nowFn === 'function' ? nowFn : () => Date.now();
    const startedAt = now();
    let open = null;
    const gate = new Promise((resolve) => { open = resolve; });
    const prev = tail;
    // Kataar ki dum: pichhle ke gate khulne ke baad hi apna
    // number. Gate sirf resolve hota hai — dum kabhi reject
    // nahi hoti, is liye ek kharab holder poori kataar ko
    // kabhi nahi rok sakta.
    tail = prev.then(() => gate);
    try { await prev; } catch (e) {}
    const waitedMs = Math.max(0, now() - startedAt);
    let released = false;
    return {
      waitedMs,
      release() {
        if (released) return;
        released = true;
        try { open(); } catch (e) {}
      }
    };
  }
  /** fn ko tale ke andar chalao — haar/throw par bhi tala khulta hai. */
  async function withLock(fn, nowFn) {
    const handle = await acquire(nowFn);
    try {
      return await fn(handle);
    } finally {
      handle.release();
    }
  }
  return { acquire, withLock };
}

// Capture-session -> tala. WeakMap: session khatam ho to
// tala khud saaf (koi leak nahi). Ek hi capture object ko
// hamesha EK hi tala — yahi "per capture session" ka matlab
// hai, chahe use kitne hi engine hisse istemal kar rahe hon.
const _locksByCapture = new WeakMap();

function stageLockFor(capture) {
  if (!capture || (typeof capture !== 'object' && typeof capture !== 'function')) {
    return createStageLock();
  }
  let lock = _locksByCapture.get(capture);
  if (!lock) {
    lock = createStageLock();
    _locksByCapture.set(capture, lock);
  }
  return lock;
}

module.exports = { createStageLock, stageLockFor };
