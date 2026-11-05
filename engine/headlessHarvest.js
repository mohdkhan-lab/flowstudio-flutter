'use strict';

// ---------------------------------------------------------------------------
// HEADLESS HARVEST (v2.48.44 — OPTION 2, owner sequence 2026-11-04)
//
// ZEROCLICK9/10/11 ke baad main-page family (Option 1) khatam
// hua: grid hover sirf ~91–128KB ki preview stream laata hai,
// asal ~1.2MB file grid par kabhi load hi nahi hoti. Option 3
// (visible/background editor-harvest) owner ki tarteeb me SAB
// SE AAKHRI chaara hai — is pack me NAHI hai.
//
// Ye pack Option 2 hai: account ke Chrome profile ki ek
// THROWAWAY COPY par BILKUL BINA-WINDOW (headless) Chrome —
// screen par kuch aa hi nahi sakta kyunki window banti hi
// nahi. Us adrishya browser me task ka editor khulta hai aur
// editor ki apni playback stream (sabit-shuda bytes ka
// zariya) pakdi jati hai.
//
// ⚠️ SABOOT-DAR SABOOT (design ki buniyad):
//  - Headless is app me v2.4.0 me ek dafa FAIL ho chuka hai
//    (generation context, purani architecture) — is liye ye
//    rasta PROBE-FIRST hai: copied session pehle ek chhote
//    se jaanch (probe) se guzregi; qubool na ho to rasta
//    mehenga editor khole baghair, EMAANDARI se haar maan
//    kar aage badhega.
//  - Flow sessions per-account Chrome profiles me rehti
//    hain, aur ek profile ek hi waqt do jagah nahi khul
//    sakti; generation ke dauraan session badalta bhi
//    rehta hai (cookie rotation). Is liye clone SIRF
//    session ke buniyadi hisse leta hai, asal profile ko
//    kabhi kholta/likhta nahi, aur clone har koshish ke
//    baad mita diya jata hai.
//
// Is module me sirf KHALIS / testable hisaab hai: clone ki
// file-tarteeb, probe ke snapshot ka faisla, per-run probe
// cache, aur windowless-launch ka darwaza. Asal browser
// chalana engine (flowAutomation) ka kaam hai.
// ---------------------------------------------------------------------------

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { LOCK_FILE_NAMES } = require('./processHelper');

/** Puppeteer ka windowless mode — launch plan isi par bandha hai. */
const HEADLESS_MODE = 'new';

/**
 * Activity strategy text — probe reject par headless-harvest
 * ki haar ki SAF, THAHRI hui ibarat (tests isi ko pin karte
 * hain; engine bhi yahi istemal karta hai).
 */
const PROBE_REJECT_NOTE = 'headless-harvest: failed (the copied session was not accepted in the invisible browser — see the headless-probe line)';

/**
 * Clone me sirf ye hisse jayenge (profile root ke relative).
 *  - 'Local State'          — cookie decryption ki kunji
 *                             (profile ke User Data root par).
 *  - 'Default/Network/Cookies' + 'Default/Cookies'
 *                           — session cookies (jo bhi maujud ho).
 *  - 'Default/Local Storage' / 'Default/Session Storage'
 *                           — Flow ki session haalat (directories).
 *  - 'Default/Preferences'  — profile ki buniyadi tarjeehain.
 * Lock files kabhi nahi (wohi 'busy' haalat dobara bana
 * dengi), cache kabhi nahi (bekaar wazan).
 */
const CLONE_ESSENTIAL_FILES = Object.freeze([
  'Local State',
  path.join('Default', 'Network', 'Cookies'),
  path.join('Default', 'Cookies'),
  path.join('Default', 'Preferences')
]);
const CLONE_ESSENTIAL_DIRS = Object.freeze([
  path.join('Default', 'Local Storage'),
  path.join('Default', 'Session Storage')
]);

const CLONE_SKIP_NAMES = new Set([...LOCK_FILE_NAMES]);

/**
 * v2.48.45: Cookies SQLite ke saathi hisse — asal DB ke
 * saath -wal/-journal bhi copy hon to copied DB apne
 * aakhri committed haal me khulti hai (warna aakhri
 * writes wal me reh kar kho sakti hain).
 */
const COOKIE_SIDECAR_SUFFIXES = Object.freeze(['-wal', '-journal']);

/** Ek Cookies file ke sidecar relative paths (khaali = Cookies nahi). */
function cookieSidecarsFor(rel) {
  if (!rel || !rel.endsWith('Cookies')) return [];
  return COOKIE_SIDECAR_SUFFIXES.map(sfx => rel + sfx);
}

/**
 * v2.48.45: NAZUK (critical) session files — Local State
 * aur Cookies (+ unke sidecars). In ki copy par retry
 * chalta hai: asal profile visible worker ke Chrome me
 * khula ho sakta hai, aur ek pal ka EBUSY/EPERM/EACCES
 * copy ko gira sakta hai.
 */
function isCriticalCloneRel(rel) {
  if (!rel) return false;
  if (rel === 'Local State') return true;
  if (rel.endsWith('Cookies')) return true;
  return COOKIE_SIDECAR_SUFFIXES.some(sfx => rel.endsWith('Cookies' + sfx));
}

const RETRYABLE_COPY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const CRITICAL_COPY_ATTEMPTS = 3;
const CRITICAL_COPY_DELAY_MS = 400;

function isRetryableCopyError(err) {
  return !!(err && RETRYABLE_COPY_CODES.has(err.code));
}

/**
 * Ek file copy karo; nazuk lock-wale codes (EBUSY /
 * EPERM / EACCES) par bounded retry (~400ms ke waqfe
 * ke saath, default 3 koshishen). Aakhri error waisa
 * hi phenkta hai — caller use warning bana sakta hai.
 * Tests ke liye copyFile/sleep ghusaye ja sakte hain.
 */
async function copyFileWithRetry(src, dest, opts = {}) {
  const attempts = Math.max(1, opts.attempts || CRITICAL_COPY_ATTEMPTS);
  const delayMs = opts.delayMs != null ? opts.delayMs : CRITICAL_COPY_DELAY_MS;
  const copyFn = opts.copyFile || fsp.copyFile;
  const sleep = opts.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      await copyFn(src, dest);
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetryableCopyError(err) || i === attempts - 1) throw err;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

/**
 * v2.48.45: launch fail ki ASAL wajah, chhoti aur saaf
 * suthri — exception ka message (~200 harf tak kata
 * hua, whitespace dabaa hua) + code ho to [CODE].
 * ZEROCLICK12 me yahi wajah kahin record nahi hoti thi.
 */
function launchFailureReason(err) {
  const raw = err && err.message ? String(err.message) : String(err || 'unknown error');
  const msg = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
  const code = err && err.code ? String(err.code) : '';
  return code ? `${msg} [${code}]` : msg;
}

/** Launch-fail ki strategy note (Activity) — wajah ke saath. */
function launchFailNote(err) {
  return `headless-harvest: launch failed (${launchFailureReason(err)}) — the main-page routes ran next`;
}

/**
 * v2.48.45: clone ke nateeje ki ek line — kya copy
 * hua, kya reh gaya, aur pehli (zyada se zyada 3)
 * warnings. v2.48.44 me ye warnings kahin dikhti hi
 * nahi thi.
 */
function cloneLogLine(result) {
  const copied = result && Array.isArray(result.copied) ? result.copied : [];
  const missing = result && Array.isArray(result.missing) ? result.missing : [];
  const warnings = result && Array.isArray(result.warnings) ? result.warnings : [];
  const miss = missing.length ? missing.join(', ') : 'none';
  const warn = warnings.length ? warnings.slice(0, 3).join(' | ') : 'none';
  return `[ROOT] headless-clone copied=${copied.length} missing=${miss} warnings=${warn}`;
}

/**
 * Clone ki tarteeb (khalis): profile root me jo buniyadi
 * hisse MAUJUD hain, un ki { rel, kind } fehrist — kram
 * wahi jo CLONE_ESSENTIAL_* me hai. `exists(rel)` aur
 * `isDir(rel)` bulane wale ke diye hue (tests jaali
 * detector de sakte hain); na hon to asal fs se.
 */
function cloneFilePlan(profileRoot, detectors = {}) {
  const exists = typeof detectors.exists === 'function'
    ? detectors.exists
    : (rel) => fs.existsSync(path.join(profileRoot, rel));
  const isDir = typeof detectors.isDir === 'function'
    ? detectors.isDir
    : (rel) => {
      try { return fs.statSync(path.join(profileRoot, rel)).isDirectory(); } catch (e) { return false; }
    };
  const plan = [];
  for (const rel of CLONE_ESSENTIAL_FILES) {
    if (exists(rel) && !isDir(rel)) {
      plan.push({ rel, kind: 'file' });
      // v2.48.45: Cookies ke saath us ke SQLite sidecars
      // bhi (jo maujud hon) — copied DB consistent rahe.
      for (const side of cookieSidecarsFor(rel)) {
        if (exists(side) && !isDir(side)) plan.push({ rel: side, kind: 'file' });
      }
    }
  }
  for (const rel of CLONE_ESSENTIAL_DIRS) {
    if (exists(rel) && isDir(rel)) plan.push({ rel, kind: 'dir' });
  }
  return plan;
}

async function copyDirEssentials(srcDir, destDir, copied, warnings) {
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (CLONE_SKIP_NAMES.has(entry.name)) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await fsp.mkdir(dest, { recursive: true });
      await copyDirEssentials(src, dest, copied, warnings);
    } else if (entry.isFile()) {
      try {
        await fsp.copyFile(src, dest);
        copied.push(dest);
      } catch (err) {
        warnings.push(`${entry.name}: ${err.message}`);
      }
    }
  }
}

/**
 * Profile root se cloneDir me sirf session ke buniyadi
 * hisse copy karo. Asal profile SIRF padha jata hai —
 * kabhi khola nahi jata, kabhi likha nahi jata, koi lock
 * file copy nahi hoti. cloneDir pehle se maujud ho to
 * pehle saaf (rm) karke taza banta hai.
 * Lautta hai: { copied: [rel...], missing: [rel...], warnings: [...] }.
 * Cookies ki koi bhi file na mile to error phenkta hai —
 * cookies ke baghair copy bekaar hai aur caller ko ye
 * EMAANDARI se kehna hai.
 */
async function buildHeadlessClone(profileRoot, cloneDir) {
  if (!profileRoot || !fs.existsSync(profileRoot)) {
    throw new Error(`Profile not found at: ${profileRoot}`);
  }
  await fsp.rm(cloneDir, { recursive: true, force: true });
  await fsp.mkdir(cloneDir, { recursive: true });
  const plan = cloneFilePlan(profileRoot);
  const copied = [];
  const missing = [];
  const warnings = [];
  for (const item of plan) {
    const src = path.join(profileRoot, item.rel);
    const dest = path.join(cloneDir, item.rel);
    try {
      if (item.kind === 'file') {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        // v2.48.45: nazuk session files (Local State,
        // Cookies + sidecars) par EBUSY/EPERM/EACCES
        // retry — asal profile visible Chrome me khula
        // ho sakta hai. Phir bhi fail ho to warning hi
        // rehta hai (neeche wala hasCookies darwaza
        // Cookies ke baghair copy ko inkaar karta hai).
        if (isCriticalCloneRel(item.rel)) {
          await copyFileWithRetry(src, dest);
        } else {
          await fsp.copyFile(src, dest);
        }
        copied.push(item.rel);
      } else {
        await fsp.mkdir(dest, { recursive: true });
        const inner = [];
        await copyDirEssentials(src, dest, inner, warnings);
        copied.push(item.rel);
      }
    } catch (err) {
      warnings.push(`${item.rel}: ${err.message}`);
    }
  }
  for (const rel of [...CLONE_ESSENTIAL_FILES, ...CLONE_ESSENTIAL_DIRS]) {
    if (!copied.includes(rel) && !plan.some(p => p.rel === rel)) missing.push(rel);
  }
  const hasCookies = copied.some(rel => rel.endsWith('Cookies'));
  if (!hasCookies) {
    throw new Error('the profile copy has no Cookies file — the copied session cannot work');
  }
  return { copied, missing, warnings };
}

/** Clone mita do (best-effort; kabhi throw nahi). */
async function removeHeadlessClone(cloneDir) {
  if (!cloneDir) return;
  try { await fsp.rm(cloneDir, { recursive: true, force: true }); } catch (e) {}
}

/**
 * Probe ke snapshot ka faisla (khalis). Snapshot engine
 * headless page se ikattha karta hai:
 *   { url, hasPromptBox, hasTiles, hasAvatar, hasSignIn,
 *     hasCaptcha, text }
 * (text = page ke matan ka chhota sa tukda, lowercase
 * jaanch yahin hoti hai.)
 * Faisla:
 *   'blocked'   — verification / unusual-traffic /
 *                 DBSC-jese inkaar ke nishan (ye sab se
 *                 pehle — sign-in dikhe tab bhi blocked
 *                 hi mana jayega);
 *   'logged-out'— sign-in ki deewaar, ya koi pehchan
 *                 wala nishan hi nahi (hifazati pehlu:
 *                 anjaan haalat = qubool NAHI);
 *   'logged-in' — prompt box / gallery tiles / account
 *                 avatar me se koi ek maujud.
 */
const BLOCKED_TEXT_MARKERS = Object.freeze([
  'unusual traffic',
  'verify your identity',
  'confirm you are not a robot',
  'confirm you\'re not a robot',
  'are you a robot',
  'may not be secure',
  'suspicious activity',
  'automated queries',
  'check your browser'
]);

function classifyProbeSnapshot(snapshot) {
  const s = snapshot || {};
  const text = String(s.text || '').toLowerCase();
  const url = String(s.url || '').toLowerCase();
  if (s.hasCaptcha) return 'blocked';
  for (const marker of BLOCKED_TEXT_MARKERS) {
    if (text.includes(marker)) return 'blocked';
  }
  if (url.includes('accounts.google.com') || url.includes('servicelogin')) return 'logged-out';
  if (s.hasSignIn) return 'logged-out';
  if (s.hasPromptBox || s.hasTiles || s.hasAvatar) return 'logged-in';
  return 'logged-out';
}

/**
 * Per-run probe cache: ek account ka probe ek run me
 * SIRF ek dafa. Engine har naye run (naya browser launch)
 * par cache saaf kar deta hai.
 */
function createProbeCache() {
  const map = new Map();
  return {
    get(accountId) { return map.get(accountId) || null; },
    set(accountId, verdict) { if (accountId && verdict) map.set(accountId, verdict); },
    has(accountId) { return map.has(accountId); },
    clear() { map.clear(); },
    get size() { return map.size; }
  };
}

/**
 * Windowless-launch darwaza (khalis): di gayi launch
 * haalat asal me bina-window hai ya nahi. Puppeteer ka
 * headless 'new' ya true hi qubool hai — false /
 * undefined (headed par girne wala) kabhi nahi. Ye
 * darwaza fail ho to engine rasta SHURU hi nahi karega
 * (koi visible window banne ka khatra kabhi nahi liya
 * jata).
 */
function launchIsWindowless(launchOpts) {
  if (!launchOpts) return false;
  const h = launchOpts.headless;
  return h === true || h === HEADLESS_MODE;
}

module.exports = {
  HEADLESS_MODE,
  PROBE_REJECT_NOTE,
  CLONE_ESSENTIAL_FILES,
  CLONE_ESSENTIAL_DIRS,
  BLOCKED_TEXT_MARKERS,
  COOKIE_SIDECAR_SUFFIXES,
  CRITICAL_COPY_ATTEMPTS,
  CRITICAL_COPY_DELAY_MS,
  cookieSidecarsFor,
  isCriticalCloneRel,
  isRetryableCopyError,
  copyFileWithRetry,
  launchFailureReason,
  launchFailNote,
  cloneLogLine,
  cloneFilePlan,
  buildHeadlessClone,
  removeHeadlessClone,
  classifyProbeSnapshot,
  createProbeCache,
  launchIsWindowless
};
