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
 * v2.48.46: COOKIES DISCOVERY SCAN — jab Cookies apni
 * dono jaani-pehchani jaghon (Default/Network/Cookies,
 * Default/Cookies) par NA mile, to profile root ke
 * andar gehrai ≤3 tak bilkul 'Cookies' NAAM ki file
 * dhundo (masalan 'Profile 1/Network/Cookies' — Chrome
 * ke named profiles session wahan rakhte hain). Lock
 * naam wali directories me nahi utarte (CLONE_SKIP_
 * NAMES). Pehli mili jagah (gehrai pehle, phir naam
 * ki tartib) wapas. Kuch na mile to null. `listDir`
 * detector tests ke liye; na ho to asal fs.
 */
function findCookiesRel(profileRoot, detectors = {}) {
  const listDir = typeof detectors.listDir === 'function'
    ? detectors.listDir
    : (rel) => {
      try {
        return fs.readdirSync(rel ? path.join(profileRoot, rel) : profileRoot, { withFileTypes: true })
          .map(e => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }));
      } catch (e) { return null; }
    };
  const queue = [''];
  while (queue.length > 0) {
    const dirRel = queue.shift();
    const depth = dirRel === '' ? 0 : dirRel.split(path.sep).length;
    let entries = null;
    try { entries = listDir(dirRel); } catch (e) { entries = null; }
    if (!Array.isArray(entries)) continue;
    const sorted = entries.slice().sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
    for (const entry of sorted) {
      if (!entry || typeof entry.name !== 'string') continue;
      const rel = dirRel ? path.join(dirRel, entry.name) : entry.name;
      if (entry.isFile && entry.name === 'Cookies') return rel;
      if (entry.isDir && depth + 1 < 3 && !CLONE_SKIP_NAMES.has(entry.name)) queue.push(rel);
    }
  }
  return null;
}

/**
 * Clone ki tarteeb (khalis): profile root me jo buniyadi
 * hisse MAUJUD hain, un ki { rel, kind } fehrist — kram
 * wahi jo CLONE_ESSENTIAL_* me hai. `exists(rel)` aur
 * `isDir(rel)` bulane wale ke diye hue (tests jaali
 * detector de sakte hain); na hon to asal fs se.
 * v2.48.46: dono thahri Cookies jaghon par kuch na ho
 * to discovery scan (findCookiesRel) — mili jagah plan
 * me `viaScan` nishan ke saath cookies entry banti hai
 * (us ke sidecars sameet).
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
  // v2.48.46: Cookies ki koi thahri jagah plan me nahi
  // aur source me maujud bhi nahi — scan se dhundo.
  const planHasCookies = plan.some(p => p.rel.endsWith('Cookies'));
  const stdCookiesExist = [path.join('Default', 'Network', 'Cookies'), path.join('Default', 'Cookies')]
    .some(rel => exists(rel));
  if (!planHasCookies && !stdCookiesExist) {
    const found = findCookiesRel(profileRoot, detectors);
    if (found) {
      plan.push({ rel: found, kind: 'file', viaScan: true });
      for (const side of cookieSidecarsFor(found)) {
        if (exists(side) && !isDir(side)) plan.push({ rel: side, kind: 'file' });
      }
    }
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
 * Lautta hai: { copied: [rel...], missing: [rel...],
 * warnings: [...], cookiesRel } — cookiesRel scan se
 * mili ghair-mamooli Cookies jagah hai (na mili ho to
 * null); thahri jagah par cookiesRel null rehta hai.
 * Cookies ki koi bhi file na mile to error phenkta hai —
 * cookies ke baghair copy bekaar hai aur caller ko ye
 * EMAANDARI se kehna hai. v2.48.46: phenke gaye error
 * par wahi hisaab `err.cloneReport` ban kar chipka
 * rehta hai (ZEROCLICK13: throw function ke ANDAR se
 * hota tha, is liye report gum ho jati thi aur clone
 * log line fail par kabhi banti hi nahi thi); aur
 * error ki ibarat farq batati hai — Cookies source me
 * mili hi nahi (not found) ya plan me thi lekin us ki
 * copy nakam rahi (copy failed: <pehli warning>).
 */
async function buildHeadlessClone(profileRoot, cloneDir) {
  if (!profileRoot || !fs.existsSync(profileRoot)) {
    const err = new Error(`Profile not found at: ${profileRoot}`);
    err.cloneReport = null;
    throw err;
  }
  await fsp.rm(cloneDir, { recursive: true, force: true });
  await fsp.mkdir(cloneDir, { recursive: true });
  const plan = cloneFilePlan(profileRoot);
  const scanned = plan.find(p => p.viaScan && p.rel.endsWith('Cookies'));
  const cookiesRel = scanned ? scanned.rel : null;
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
    // v2.48.46: report error ke saath chipka kar phenko
    // (caller fail par bhi clone log line bana sake),
    // aur ibarat source-missing vs copy-failed ka farq
    // naam se bataye.
    const report = { copied, missing, warnings, cookiesRel };
    const planCookies = plan.filter(p => p.rel.endsWith('Cookies'));
    let message;
    if (planCookies.length === 0) {
      message = 'the profile copy has no Cookies file (not found in the source profile — see the headless-clone line)';
    } else {
      const firstWarning = warnings.find(w => planCookies.some(p => w.startsWith(`${p.rel}:`)));
      const detail = firstWarning ? firstWarning.slice(0, 120) : 'unknown copy error';
      message = `the profile copy has no Cookies file (copy failed: ${detail})`;
    }
    const err = new Error(message);
    err.cloneReport = report;
    throw err;
  }
  return { copied, missing, warnings, cookiesRel };
}

/** Clone mita do (best-effort; kabhi throw nahi). */
async function removeHeadlessClone(cloneDir) {
  if (!cloneDir) return;
  try { await fsp.rm(cloneDir, { recursive: true, force: true }); } catch (e) {}
}

/**
 * v2.48.47 (CDP COOKIE TRANSFER): live browser ke CDP
 * 'Network.getAllCookies' jawab ko headless page ke
 * 'Network.setCookies' ki shakal me badlo (khalis).
 * Sirf setCookies wale fields rehte hain — name, value,
 * domain, path; expires SIRF tab jab > 0 (session
 * cookies par expires bhejna Chrome ko confuse karta
 * hai); httpOnly / secure hamesha (boolean bana kar);
 * sameSite SIRF tab jab wo bilkul 'Strict' | 'Lax' |
 * 'None' ho. getAllCookies ke baaki fields (size,
 * session, priority, sameParty, sourceScheme waghera)
 * gir jate hain. Naam ke baghair wali entry bekaar hai
 * — wo bhi gir jati hai (value khaali ho sakti hai,
 * wo rehti hai). Garbage / na-array input = [].
 */
const SETCOOKIES_SAMESITE = Object.freeze(['Strict', 'Lax', 'None']);

function mapCookiesForSetCookies(cookies) {
  if (!Array.isArray(cookies)) return [];
  const out = [];
  for (const c of cookies) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.name !== 'string' || c.name === '') continue;
    const mapped = {
      name: c.name,
      value: typeof c.value === 'string' ? c.value : String(c.value == null ? '' : c.value),
      domain: typeof c.domain === 'string' ? c.domain : '',
      path: typeof c.path === 'string' && c.path !== '' ? c.path : '/'
    };
    if (Number.isFinite(c.expires) && c.expires > 0) mapped.expires = c.expires;
    mapped.httpOnly = !!c.httpOnly;
    mapped.secure = !!c.secure;
    if (SETCOOKIES_SAMESITE.includes(c.sameSite)) mapped.sameSite = c.sameSite;
    out.push(mapped);
  }
  return out;
}

/**
 * v2.48.47: headless session ka rasta chunno (khalis).
 * 'cdp' SIRF tab jab live browser ka handle maujud ho
 * AUR us se kam az kam ek cookie mili ho — warna
 * 'clone' (purana file-copy rasta, jo apni jagah
 * fallback hai). ZEROCLICK14: run ke dauraan Cookies
 * file EBUSY-locked rehti hai, is liye transfer asal
 * rasta hai aur clone sirf chaara.
 */
function decideSessionPath(input) {
  const o = input && typeof input === 'object' ? input : {};
  const count = Number.isFinite(o.cookieCount) ? Math.floor(o.cookieCount) : 0;
  return o.liveHandle && count > 0 ? 'cdp' : 'clone';
}

/**
 * v2.48.49 (COOKIE-READ V2 — ZEROCLICK16): cookie
 * read ke paanch tareeqon ki tartib — pehle
 * BROWSER-level CDP session ke dono tareeqe, phir
 * PAGE-level CDP session ke dono, aakhir me
 * Puppeteer ka apna page.cookies() API. ZEROCLICK16
 * ne dikhaya: .47/.48 ka akela 'Network.getAllCookies'
 * (browser-level) live browser par 0 deta tha (ya
 * chup-chaap nakam — dono haal 'cookies=0' me ek ho
 * jate the) aur CDP transfer kabhi chuna hi nahi
 * gaya; asal rukawat transfer nahi, READ thi.
 */
const COOKIE_READ_METHODS = Object.freeze(['bStorage', 'bNetwork', 'pStorage', 'pNetwork', 'pageApi']);

/**
 * v2.48.49: paanchon tareeqon ke nateeje jodo
 * (khalis). Input: har tareeqe ke naam par ya to
 * { cookies: [...] } (chal gaya — khaali ho sakta
 * hai) ya { error: '<wajah, <=60 harf>' } (nakam).
 * Gumshuda / kharab entry = nakam hi gina jata hai.
 * Faisla:
 *   - pehla tareeqa jis ne count>0 diya wahi
 *     'chosen' hai, usi ki cookies lautti hain;
 *   - koi >0 nahi lekin kam az kam ek chal gaya —
 *     cookies [] (khaali, lekin nakami NAHI);
 *   - paanchon nakam — cookies null (asal nakami;
 *     dispatcher ise 'cookies=null' bolta hai,
 *     khaali read ke 'cookies=0' se alag).
 * Wapsi: { perMethod: { <naam>: { state:'ok', count,
 * error:null } | { state:'err', count:0, error } },
 * chosen: <naam>|'none', cookies: [...]|null,
 * total: <chosen count> }.
 */
function aggregateCookieRead(results) {
  const src = results && typeof results === 'object' ? results : {};
  const perMethod = {};
  let chosen = 'none';
  let cookies = null;
  let anyOk = false;
  for (const name of COOKIE_READ_METHODS) {
    const r = src[name];
    if (r && Array.isArray(r.cookies)) {
      perMethod[name] = { state: 'ok', count: r.cookies.length, error: null };
      anyOk = true;
      if (chosen === 'none' && r.cookies.length > 0) {
        chosen = name;
        cookies = r.cookies;
      }
    } else {
      const raw = r && typeof r.error === 'string' ? r.error : 'not attempted';
      perMethod[name] = { state: 'err', count: 0, error: raw.replace(/\s+/g, ' ').trim().slice(0, 60) || 'unknown error' };
    }
  }
  if (chosen === 'none' && anyOk) cookies = [];
  return {
    perMethod,
    chosen,
    cookies,
    total: chosen === 'none' ? 0 : perMethod[chosen].count
  };
}

/**
 * v2.48.49: cookieread ki EK log line (khalis) —
 * har tareeqa count deta hai ya sirf 'err' (nakam
 * par wajah line me nahi aati, sirf haal aata hai):
 * '[ROOT] headless-cookieread bStorage=<n|err>
 * bNetwork=<n|err> pStorage=<n|err>
 * pNetwork=<n|err> pageApi=<n|err>
 * chosen=<naam|none> total=<n>'.
 */
function cookieReadLogLine(agg) {
  const a = agg && typeof agg === 'object' && agg.perMethod ? agg : aggregateCookieRead(null);
  const fmt = (name) => {
    const m = a.perMethod[name];
    return m && m.state === 'ok' ? String(Math.max(0, Math.floor(m.count || 0))) : 'err';
  };
  const chosen = COOKIE_READ_METHODS.includes(a.chosen) ? a.chosen : 'none';
  const total = Number.isFinite(a.total) ? Math.max(0, Math.floor(a.total)) : 0;
  return `[ROOT] headless-cookieread bStorage=${fmt('bStorage')} bNetwork=${fmt('bNetwork')} pStorage=${fmt('pStorage')} pNetwork=${fmt('pNetwork')} pageApi=${fmt('pageApi')} chosen=${chosen} total=${total}`;
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
  findCookiesRel,
  cloneFilePlan,
  buildHeadlessClone,
  removeHeadlessClone,
  mapCookiesForSetCookies,
  decideSessionPath,
  COOKIE_READ_METHODS,
  aggregateCookieRead,
  cookieReadLogLine,
  classifyProbeSnapshot,
  createProbeCache,
  launchIsWindowless
};
