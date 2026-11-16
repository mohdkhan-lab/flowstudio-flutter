'use strict';

// ---------------------------------------------------------------------------
// v2.48.107 (Fix D) — OUTPUT FOLDER GUARD (khalis hisaab).
//
// Haadsa (2026-11-12): app ka download_base_folder ek bache
// hue smoke-temp folder par atka reh gaya tha
// (C:\Users\mohda\AppData\Local\Temp\fs-smoke-*\out) aur har
// save KHAMOSHI se wahan jata raha — owner ko pata hi nahi
// chala ke videos Downloads me nahi, ek aisi jagah ja rahi
// hain jo OS kabhi bhi saaf kar sakta hai. Upar se MCP
// update_settings use theek bhi nahi kar sakta tha
// ('download_base_folder' MCP ki key fehrist me hi nahi thi).
//
// Usool:
//   - Asar-daar (effective) output folder kabhi bhi OS ke
//     temp hisse me ya smoke/temp pattern wali jagah NAHI
//     hoga. Stored value aisi nikle to faisla: aakhri
//     maloom ACHHA folder (last known good), warna user ke
//     Downloads, warna app ke data dir ki downloads.
//   - Faisla hamesha ek object me wapas aata hai jisme
//     tempDetected + fellBack saaf likha hota hai — bulane
//     wala (bridge) usi par zor-daar warning log karta hai.
//     Khamoshi se tabdeeli KABHI nahi.
//   - Ye module koi I/O nahi karta: raaste sirf parkhe
//     jate hain; banana/persist karna bridge ka kaam hai.
// ---------------------------------------------------------------------------

const path = require('path');

/** Muqable ke liye raaste ki ek shakal: slash ek jaise, chhote harf, aakhri slash nahi. */
function normalizeForMatch(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Koi raasta temp/smoke jaisa hai kya? Kasautiyan:
 *   - kisi bhi hisse ka naam 'temp' ya 'tmp' ho
 *     (…\Temp\…, /tmp/…, C:\tmp\…);
 *   - naam me 'fs-smoke' ho (smoke-run ke bache hue folder);
 *   - diye gaye OS temp roots (os.tmpdir()) ke andar ho.
 * Ek aam folder jiska koi hissa 'temp' se SHURU hota ho
 * ('temp-projects') is me NAHI aata — poora hissa chahiye.
 * CHHOOT (exemptRoots): koi raasta exempt roots ke andar
 * ho to woh temp-jaisa NAHI mana jata — bridge app ka apna
 * data dir exempt karta hai, kyunke data tree ek jaiz save
 * jagah hai (aakhri chaara khud <data dir>/downloads hai)
 * aur project smoke harness apna poora data dir jaan-boojh
 * kar temp root ke neeche chalata hai.
 */
function isTempLikeFolder(p, tmpRoots, exemptRoots) {
  if (typeof p !== 'string' || !p.trim()) return false;
  const n = normalizeForMatch(p.trim());
  if (!n) return false;
  const exRoots = Array.isArray(exemptRoots) ? exemptRoots : [];
  for (const ex of exRoots) {
    if (typeof ex !== 'string' || !ex.trim()) continue;
    const e = normalizeForMatch(ex.trim());
    if (e && (n === e || n.startsWith(e + '/'))) return false;
  }
  if (n.includes('fs-smoke')) return true;
  const segments = n.split('/').filter(Boolean);
  if (segments.includes('temp') || segments.includes('tmp')) return true;
  const roots = Array.isArray(tmpRoots) ? tmpRoots : [];
  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim()) continue;
    const r = normalizeForMatch(root.trim());
    if (r && (n === r || n.startsWith(r + '/'))) return true;
  }
  return false;
}

/**
 * Asar-daar output folder ka faisla.
 * input = {
 *   stored,    // settings wali value (base folder ki)
 *   lastGood,  // aakhri maloom achha folder (persist shuda)
 *   homeDir,   // user ka home (Downloads is ke neeche)
 *   dataDir,   // app ka data dir (aakhri chaara: downloads)
 *   tmpRoots,  // [os.tmpdir()] waghera
 * }
 * natija = { folder, source, tempDetected, fellBack }
 *   source: 'stored' | 'last-good' | 'home-downloads' | 'data-downloads'
 * folder hamesha ghair-khali hota hai jab homeDir ya
 * dataDir me se koi ek bhi diya gaya ho.
 */
function resolveOutputFolder(input) {
  const o = input && typeof input === 'object' ? input : {};
  const stored = typeof o.stored === 'string' ? o.stored.trim() : '';
  const lastGood = typeof o.lastGood === 'string' ? o.lastGood.trim() : '';
  const tmpRoots = Array.isArray(o.tmpRoots) ? o.tmpRoots : [];
  const exemptRoots = (typeof o.dataDir === 'string' && o.dataDir.trim()) ? [o.dataDir.trim()] : [];
  // Sandbox stand-down: app ka DATA DIR hi temp root ke
  // andar ho to ye process ek phenk-dene-wala (throwaway)
  // sandbox hai (project smoke harness apna poora data dir
  // jaan-boojh kar os.tmpdir() ke neeche chalata hai) — wahan
  // koi asal install bachaane ko hai hi nahi, aur user ke
  // asal Downloads par swap karna test files wahan leak
  // karega. Aisi surat me guard poori tarah peeche hat jata
  // hai aur stored value joon ki toon rehti hai.
  if (exemptRoots.length && stored && isTempLikeFolder(exemptRoots[0], tmpRoots)) {
    return { folder: stored, source: 'stored', tempDetected: false, fellBack: false };
  }
  const tempDetected = !!stored && isTempLikeFolder(stored, tmpRoots, exemptRoots);
  if (stored && !tempDetected) {
    return { folder: stored, source: 'stored', tempDetected: false, fellBack: false };
  }
  if (lastGood && !isTempLikeFolder(lastGood, tmpRoots, exemptRoots)) {
    return { folder: lastGood, source: 'last-good', tempDetected, fellBack: true };
  }
  if (typeof o.homeDir === 'string' && o.homeDir.trim()) {
    return { folder: path.join(o.homeDir.trim(), 'Downloads'), source: 'home-downloads', tempDetected, fellBack: true };
  }
  if (typeof o.dataDir === 'string' && o.dataDir.trim()) {
    return { folder: path.join(o.dataDir.trim(), 'downloads'), source: 'data-downloads', tempDetected, fellBack: true };
  }
  return { folder: stored, source: 'stored', tempDetected, fellBack: false };
}

module.exports = { isTempLikeFolder, resolveOutputFolder, normalizeForMatch };
