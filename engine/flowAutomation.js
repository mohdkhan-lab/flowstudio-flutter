const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { getChromeExecutablePath } = require('./chromePaths');
const { getAccountProfilePath } = require('./accountStore');
const { checkProfileBusyAsync } = require('./processHelper');
const liveBrowsers = require('./liveBrowsers');
const tileIdentity = require('./tileIdentity');
const stallWatch = require('./stallWatch');
const renderProgressWatch = require('./renderProgressWatch');
const tileState = require('./tileState');
const plainError = require('./plainError');
const browserMode = require('./browserMode');
const windowStyle = require('./windowStyle');
const networkCapture = require('./networkCapture');
const failureEvidence = require('./failureEvidence');
const { FFmpegService } = require('./ffmpegService');
const { sanitizeFilePart } = require('./pathSecurity');
const tagNaming = require('./tagNaming');
const downloadGuard = require('./downloadGuard');
const downloadFetch = require('./downloadFetch');
const { describeUrlShape, formatUrlShape } = require('./urlShape');
const blobHarvest = require('./blobHarvest');
const downloadRouteOrder = require('./downloadRouteOrder');
const editorEnhance = require('./editorEnhance');
const flowContent = require('./flowContent');
const downloadEventMatch = require('./downloadEventMatch');
const mintWindow = require('./mintWindow');
const mintReplay = require('./mintReplay');
const saveGuard = require('./saveGuard');
const stageLock = require('./stageLock');
const headlessHarvest = require('./headlessHarvest');
const cookiesDb = require('./cookiesDb');
const os = require('os');
const downloadTiming = require('./download-timing');
const downloadRoute = require('./download-route');
const downloadVerify = require('./download-verify');
const downloadZeroClick = require('./download-zero-click');
const projectRecovery = require('./project-recovery');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * v2.48.47 (MEDIA-LOAD COMPLETION): capture kitab ke
 * hisaab se ek mainpage address ki pakdi hui body ki
 * haalat (khalis). entry = capture ki mainpage entry
 * (partial / status / knownTotal / declared), held =
 * mainpageBodyForUrl ka jawab ({ buffer } | null).
 *   'complete' — pakdi body ASAL file hai: ya to kul
 *     (knownTotal/declared) us body se cover ho jata
 *     hai, ya aakhri nazar ek mukammal 200 jawab thi
 *     (partial nahi) aur yahi body us ki hai;
 *   'partial'  — body hai lekin mukammal sabit nahi;
 *   'none'     — koi body hi nahi.
 * Aakhri faisla hamesha saveGuard ke darwaze karte
 * hain — ye sirf poll rokne aur status chunne ke liye.
 */
function mediaBodyState(entry, held) {
  const buf = held && held.buffer && held.buffer.length > 0 ? held.buffer : null;
  if (!buf) return 'none';
  if (!entry) return 'partial';
  const total = Math.max(
    Number.isFinite(entry.knownTotal) ? entry.knownTotal : 0,
    Number.isFinite(entry.declared) ? entry.declared : 0
  );
  if (total > 0 && buf.length >= total) return 'complete';
  if (entry.partial === false && Number(entry.status) === 200) return 'complete';
  return 'partial';
}

/**
 * v2.48.47: media-load ki EK log line (khalis) —
 * '[ROOT] mainpage-media-load host=<h> outcome=<o>
 * bytes=<n>'. outcome sirf complete | ended |
 * timeout | error; ajnabi qeemat 'error' banti hai.
 */
function mediaLoadLogLine(info) {
  const o = info && typeof info === 'object' ? info : {};
  const host = o.host ? String(o.host) : 'none';
  const outcome = ['complete', 'ended', 'timeout', 'error'].includes(o.outcome) ? o.outcome : 'error';
  const bytes = Number.isFinite(o.bytes) ? Math.max(0, Math.floor(o.bytes)) : 0;
  // v2.48.50 (MEGA PACK item 1 — TILE-ELEMENT COMPLETION):
  // kaunsa element drive hua — 'tile' (task ki apni tile
  // ka <video>) ya 'hidden' (purana adrishya element).
  // Ajnabi qeemat 'hidden' hi banti hai (purani shakal).
  const el = o.el === 'tile' ? 'tile' : 'hidden';
  return `[ROOT] mainpage-media-load host=${host} outcome=${outcome} bytes=${bytes} el=${el}`;
}

/**
 * v2.48.50 (item 1): tile-element chunav ka faisla
 * (khalis). Tile ka <video> element mile AUR us ke
 * paas apni stream ka koi nishan ho (src/currentSrc
 * maujud, ya duration maloom) to drive TILE se hoga;
 * warna purana hidden element hi chaara hai.
 * probe = _probeMainpageTileVideo ki wapsi
 * { found, hasSrc, duration, currentSrc }.
 */
function mediaLoadElementPick(probe) {
  const p = probe && typeof probe === 'object' ? probe : {};
  if (p.found && (p.hasSrc || (Number.isFinite(p.duration) && p.duration > 0))) return 'tile';
  return 'hidden';
}

/**
 * v2.48.50 (MEGA PACK item 16 — ATTEMPT SUMMARY): har
 * video download attempt ke aakhir me EK line (khalis):
 * '[ROOT] attempt-summary task=<promptIndex>
 * best=<sabse badi nazar ke bytes> assembled=<jodi
 * body ke bytes> mediaTile=<outcome|-> mediaHidden=
 * <outcome|-> probe=<state|-> race=<winner|->
 * saved=<yes|no>'. Saare hisse attempt ke apne darj
 * haal se aate hain — koi vyavhaar-badal nahi.
 */
function attemptSummaryLogLine(info) {
  const o = info && typeof info === 'object' ? info : {};
  const num = (v) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
  const out = (v) => (['complete', 'ended', 'timeout', 'error'].includes(v) ? v : '-');
  const word = (v) => (v ? String(v) : '-');
  // v2.48.52 (ROUTE 1A PACK): netload ka anjaam bhi
  // isi line me — saved / error / rejected, warna '-'
  // (1A is attempt me chala hi nahi).
  const nl = (v) => (['saved', 'error', 'rejected'].includes(v) ? v : '-');
  const taskIdx = Number.isFinite(o.task) ? Math.floor(o.task) : 0;
  return `[ROOT] attempt-summary task=${taskIdx} best=${num(o.best)} assembled=${num(o.assembled)} mediaTile=${out(o.mediaTile)} mediaHidden=${out(o.mediaHidden)} probe=${word(o.probe)} race=${word(o.race)} netload=${nl(o.netload)} saved=${o.saved ? 'yes' : 'no'}`;
}

/**
 * v2.48.57 (PROJECT-TRUTH): Flow ke projects ki sachai —
 * har video SIRF usi project me hoti hai jisme wo bani
 * thi, aur Flow home har project ko uske banne ke
 * date-time se dikhata hai ('Nov 06 - 09:28').
 * Recovery ko wahi project kholna hai — naya ya sab se
 * latest project me dhoondna bekaar hai (ZEROCLICK25:
 * Resume ne ghalat/khaali project khol kar dono tasks
 * FAILED mark kar diye the). Neeche ke teen helpers
 * khalis hain (koi page nahi chhoote):
 *   projectIdOfUrl(url)      -> project id ya ''
 *   parseGalleryDateTime(t)  -> ms ya null
 *   pickGalleryProject(...)  -> { index, source }
 *   galleryEntryDecision(..) -> { kind, index, source }
 * 'existing' (recovery) strategy me kind KABHI 'new'
 * nahi hota — recovery naya project bana hi nahi sakti.
 */
function projectIdOfUrl(url) {
  const m = String(url || '').match(/\/project\/([^/?#]+)/);
  return m ? m[1] : '';
}

const GALLERY_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function parseGalleryDateTime(text, nowMs) {
  const t = String(text || '');
  const m = t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\b[^\d]{0,4}(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  const month = GALLERY_MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const now = new Date(Number(nowMs) || Date.now());
  let year = m[3] ? Number(m[3]) : now.getFullYear();
  let hh = Number(m[4]) % 24;
  const mm = Number(m[5]) % 60;
  if (m[6]) {
    const pm = m[6].toUpperCase() === 'PM';
    if (pm && hh < 12) hh += 12;
    if (!pm && hh === 12) hh = 0;
  }
  let dt = new Date(year, month, Number(m[2]), hh, mm).getTime();
  if (!Number.isFinite(dt)) return null;
  // Saal na diya ho aur tareekh aaj se bahut aage nikle
  // (Dec ka project Jan me dekha) to pichla saal mano.
  if (!m[3] && dt - now.getTime() > 31 * 24 * 3600 * 1000) {
    dt = new Date(year - 1, month, Number(m[2]), hh, mm).getTime();
  }
  return dt;
}

function pickGalleryProject(links, targetMs, nowMs) {
  const list = Array.isArray(links) ? links : [];
  if (!list.length) return { index: -1, source: 'gallery-first' };
  const target = Number(targetMs) || 0;
  if (target > 0) {
    let best = -1;
    let bestDt = -Infinity;
    list.forEach((l, i) => {
      const dt = parseGalleryDateTime(l && l.text, nowMs);
      if (dt === null) return;
      // Gallery ki ghadi minute-resolution ki hai — wahi
      // minute qubool (target + 59.999s tak).
      if (dt <= target + 59999 && dt > bestDt) { bestDt = dt; best = i; }
    });
    if (best >= 0) return { index: best, source: 'gallery-datetime' };
  }
  return { index: 0, source: 'gallery-first' };
}

function galleryEntryDecision(survey, preferFresh, targetMs, nowMs) {
  const s = survey && typeof survey === 'object' ? survey : {};
  const links = Array.isArray(s.links) ? s.links : [];
  if (preferFresh) {
    if (s.hasNewBtn) return { kind: 'new', index: -1, source: null };
    if (links.length) return { kind: 'link', index: 0, source: 'gallery-first' };
    return { kind: 'none', index: -1, source: null };
  }
  // 'existing' (recovery): naya project KABHI nahi —
  // link mile to wahi (date-time wala tarjeeh ke saath),
  // na mile to 'none' (upar wala project-na-khula wala
  // raasta tasks ko parked rakhta hai).
  if (links.length) {
    const pick = pickGalleryProject(links, targetMs, nowMs);
    return { kind: 'link', index: pick.index, source: pick.source };
  }
  return { kind: 'none', index: -1, source: null };
}

/**
 * v2.48.60 (PROJECT REGISTRY): recovery ke ek
 * (account, project) group ke liye ENTRY ka faisla —
 * khalis, koi page/DB nahi chhoota:
 *   1. task par RECORDED project_url ho -> wahi,
 *      source 'recorded' (sab se pakki pehchan).
 *   2. warna registry (dbService.findProjectForTime)
 *      ka qareebi-not-after project -> source
 *      'registry' — engine usi URL par seedha jata
 *      hai, gallery scrape bilkul nahi.
 *   3. warna gallery ka date-time wala raasta
 *      (kind 'gallery' — pool recoveryTargetTime
 *      bhejta hai, faisla galleryEntryDecision ka).
 * registryRow dbService ki mapped shakal
 * (projectUrl) bhi ho sakti hai aur kachi DB shakal
 * (project_url) bhi — dono qubool hain.
 */
function recoveryEntryPlan(recordedUrl, registryRow, targetMs) {
  const rec = String(recordedUrl || '').trim();
  if (rec) return { kind: 'recorded', projectUrl: rec, source: 'recorded' };
  const regUrl = registryRow
    ? String(registryRow.projectUrl || registryRow.project_url || '').trim()
    : '';
  if (regUrl) return { kind: 'registry', projectUrl: regUrl, source: 'registry' };
  // v2.48.70 (ITEM B): teesra argument (group ki sab se
  // purani row ka waqt) diya gaya ho aur wo bhi na ho
  // to row UNMAPPED hai — na recorded URL, na registry,
  // na date-time. Aisi row ke liye koi account NAHI
  // khulta (gallery ka andaza hamesha ke liye khatam).
  // Teesra argument na diya jaye to purana bartav
  // ('gallery') bilkul waisa hi (pinned faisle).
  if (targetMs !== undefined && !(Number(targetMs) > 0)) {
    return { kind: 'unmapped', projectUrl: '', source: null };
  }
  return { kind: 'gallery', projectUrl: '', source: null };
}

/**
 * v2.48.62 (RESOLUTION-CONFIRM FIX): resolution button
 * (360p/720p) CHUNA HUA hai ya nahi — KHALIS faisla, ek
 * jaali snapshot par: { attrs, className, parentClassName }.
 * Purani pehchan barkarar: aria-checked/aria-selected/
 * aria-pressed === 'true', data-state === 'on', ya button
 * ki apni class list me exact 'selected'/'active' token.
 * v2.48.62 ki chaudi pehchan: Flow ka Material toggle
 * haalat wali class (mat-button-toggle-checked waghera)
 * aksar button ki class string ki mukhtalif shakal me ya
 * PARENT wrapper par rakhta hai — is liye /checked|
 * selected|active/i ab button + parent dono ki class
 * string par chalta hai. className SVGAnimatedString
 * bhi ho sakta hai — baseVal se saaf hota hai.
 */
function resolutionBtnSelected(snap) {
  const s = snap && typeof snap === 'object' ? snap : {};
  const attrs = s.attrs && typeof s.attrs === 'object' ? s.attrs : {};
  if (attrs['aria-checked'] === 'true' || attrs['aria-selected'] === 'true'
    || attrs['aria-pressed'] === 'true' || attrs['data-state'] === 'on') return true;
  const clsOf = (c) => {
    if (!c) return '';
    if (typeof c === 'string') return c;
    if (typeof c.baseVal === 'string') return c.baseVal;
    try { return String(c); } catch (e) { return ''; }
  };
  const cls = clsOf(s.className);
  const parentCls = clsOf(s.parentClassName);
  const tokens = cls.split(/\s+/);
  if (tokens.indexOf('selected') >= 0 || tokens.indexOf('active') >= 0) return true;
  return /checked|selected|active/i.test(cls + ' ' + parentCls);
}

/**
 * v2.48.62: readResolutionState ka page-side hissa ek
 * SOURCE string ki shakal me — taaki page ke andar bhi
 * WAHI resolutionBtnSelected chale jo Node me test hota
 * hai (helper ka asal source is string me garam hokar
 * jata hai; andar wala faisla aur test wala faisla ek
 * hi hain). Test is source ko jaali document par chala
 * kar asal bartav parkhta hai.
 */
function resolutionStateSource() {
  return '(() => {\n'
    + 'const resolutionBtnSelected = ' + resolutionBtnSelected.toString() + ';\n'
    + 'const pop = Array.from(document.querySelectorAll(\'.cdk-overlay-pane, .settings-content\')).find(p => p.getClientRects().length > 0) || document.querySelector(\'.settings-content\');\n'
    + 'if (!pop) return { found: false, selected: null };\n'
    + 'const btns = Array.from(pop.querySelectorAll(\'button, [role="radio"], [role="tab"]\'));\n'
    + 'const resBtns = btns.filter(b => [\'360p\', \'720p\'].includes((b.innerText || \'\').trim().toLowerCase()));\n'
    + 'if (!resBtns.length) return { found: false, selected: null };\n'
    + 'const snapOf = (b) => ({\n'
    + '  attrs: {\n'
    + '    \'aria-checked\': b.getAttribute(\'aria-checked\'),\n'
    + '    \'aria-selected\': b.getAttribute(\'aria-selected\'),\n'
    + '    \'aria-pressed\': b.getAttribute(\'aria-pressed\'),\n'
    + '    \'data-state\': b.getAttribute(\'data-state\')\n'
    + '  },\n'
    + '  className: b.className,\n'
    + '  parentClassName: b.parentElement ? b.parentElement.className : \'\'\n'
    + '});\n'
    + 'const sel = resBtns.find(b => resolutionBtnSelected(snapOf(b)));\n'
    + 'return { found: true, selected: sel ? (sel.innerText || \'\').trim().toLowerCase() : null };\n'
    + '})()';
}

/**
 * v2.48.62 (ZC30 TEST FLAG — skipFirstTaskDownload):
 * download ka marhala chhodna hai ya nahi — KHALIS
 * faisla. Flag sirf MCP ke flowstudio_generate_in_app
 * wale ek-run argument se aata hai (settings me
 * mustaqil kabhi nahi bachta — db ki settings_json
 * wali copy se ye hata diya jata hai, taaki Resume
 * use dobara na jaga sake).
 * v2.48.63 (SCOPE FIX — ZC30 wart): .62 me shart
 * `task.promptIndex === 0` thi — lekin promptIndex
 * HAR batch ka apna hota hai, is liye usi run ke
 * aakhri sweep ne dusri batch ki ek purani parked
 * task (account (18) wali) ko bhi galti se skip kar
 * diya. Ab nishani task ki PEHCHAN hai: workerPool
 * batch bante hi settings par us task ki DB id
 * `settings._skipFirstTaskId` laga deta hai, aur
 * sirf WAHI task skip hoti hai (id bhi settings_json
 * me nahi bachta — db.js strip).
 */
function skipFirstDownloadApplies(settings, task) {
  return !!(settings && settings.skipFirstTaskDownload === true
    && settings._skipFirstTaskId != null
    && task && task.taskId != null
    && task.taskId === settings._skipFirstTaskId);
}

/**
 * v2.48.63 (PASSIVE-FIRST — Item A): mainpage-harvest
 * ka pehla, khamosh marhala is task par laagu hai ya
 * nahi — KHALIS faisla. Shartein: task maujood ho,
 * file pehle se save na hui ho, aur us ka render ISI
 * engine session me mukammal hua ho (renderCompletedAt
 * session ke aaghaz ke baad ka ho). Recovery tasks ka
 * render is session me hua hi nahi hota (un par waqt
 * darj hi nahi, ya purana hota hai) — wo is darwaze se
 * bahar rehte hain, kyunke dobara khula project sirf
 * chhota preview deta hai; wahan khamosh intezaar sirf
 * sweep ka waqt khayega.
 */
function passiveClaimApplies(task, sessionStartedAt) {
  return !!(task
    && !task.mediaSaved
    && Number.isFinite(task.renderCompletedAt)
    && Number.isFinite(sessionStartedAt)
    && task.renderCompletedAt >= sessionStartedAt);
}

/**
 * v2.48.64 (TILE-RESIZE TRIGGER): resize wale
 * marhale ka darwaza passive wale se bilkul waisa
 * hi hai — sirf is session me render hue taaza
 * tasks (recovery is se bahar; ZC32 ka pehla
 * parhna generation-phase ka saaf parhna hai).
 * Doosra naam is liye taaki harvest ki tartib aur
 * test dono saaf parhe jaayein; faisla ek hi
 * function karta hai.
 */
const resizeTriggerApplies = passiveClaimApplies;

/**
 * v2.48.65 (RANK-2 POINTER TRIGGER): pointer wale
 * marhale ka darwaza bhi passive wala hi hai —
 * sirf is session me render hue taaza tasks
 * (recovery is se bahar; dobara khula project
 * sirf chhota preview deta hai, wahan dabao bhi
 * bekaar hai). Doosra naam is liye taaki harvest
 * ki tartib aur test dono saaf parhe jaayein;
 * faisla ek hi function karta hai.
 */
const pointerTriggerApplies = passiveClaimApplies;

/**
 * v2.48.65 (BELOW-FLOOR SAMPLE — Item B): rejected
 * ummeedwaar ka diagnostic sample save ho ya nahi
 * — KHALIS faisla. Shartein teeno ek saath: wajah
 * 'below-floor' ho, buffer ka header asal video
 * ka ho (kachra/HTML na ho), aur is session me
 * pehle koi sample save na hua ho (latch khula
 * ho). Ye sirf jaanch ki file hai — task ka save
 * is se kabhi nahi banta.
 */
function belowfloorSampleDecision(reason, headerOk, latchSet) {
  return reason === 'below-floor' && !!headerOk && !latchSet;
}

/**
 * v2.48.70 (ITEM A): duration-tasdeeq fail karne wali
 * body bhi session ka pehla diagnostic sample rakhti
 * hai (wahi latch, wahi BELOWFLOOR-SAMPLE naam) —
 * reject ki wajah ab 'below-floor' ki jagah
 * 'short-duration' / 'unparseable' hoti hai, lekin
 * jaanch ki file isiliye aur bhi zaroori hai.
 */
function failedVerificationSampleDecision(reason, headerOk, latchSet) {
  return (reason === 'short-duration' || reason === 'unparseable') && !!headerOk && !latchSet;
}

/**
 * v2.48.70 (ITEM B): RECOVERY entry par gallery ka
 * 'gallery-first' andaza (sab se pehla/latest project)
 * KHATAM — jab recovery ke paas ek TARGET waqt hai aur
 * date-time wala chunav us se match na kha sake, to
 * pehla project andaze se NAHI khulega: faisla 'none'
 * (entry nakam -> rows parked, kabhi fail nahi).
 * Target hi na ho (targetMs 0) to ye helper purana
 * bartav rakhta hai — aisi recovery pool ab bhejti hi
 * nahi (.70 me wo rows pehle hi 'unmapped' gin kar
 * bina account khole park hoti hain); engine helper
 * ka apna intezaar-wala bartav (X58-WAIT) is se
 * nahi badalta. Fresh run par ye lagta hi nahi.
 */
function recoveryGalleryGuard(decision, targetMs) {
  const d = decision && typeof decision === 'object' ? decision : { kind: 'none', index: -1, source: null };
  if (d.source === 'gallery-first' && Number(targetMs) > 0) {
    return { kind: 'none', index: -1, source: 'gallery-first-blocked' };
  }
  return d;
}

/**
 * v2.48.65 (BELOW-FLOOR SAMPLE — Item B): sample
 * file ka naam — KHALIS. Bunyadi shakl
 * 'BELOWFLOOR-SAMPLE-prompt<n>-<bytes>.mp4'; wahi
 * naam pehle se maujood ho to '-2', '-3', … jodta
 * hai. existsFn(name) -> bool bulane wale ka
 * diya hua jaanch-wala hai (test me nakli, asal
 * me fs.existsSync).
 */
function belowfloorSampleName(n, byteLength, existsFn) {
  const base = `BELOWFLOOR-SAMPLE-prompt${n}-${byteLength}`;
  let name = `${base}.mp4`;
  let k = 2;
  while (typeof existsFn === 'function' && existsFn(name)) {
    name = `${base}-${k}.mp4`;
    k += 1;
  }
  return name;
}

/**
 * v2.48.63 (SETTINGS TASDEEQ — Item B): Flow ki
 * settings pill ke text ko parhna — KHALIS parser.
 * Pill ki shaklein: 'Video · 720p · 8s crop_9_16 x1',
 * 'Video · 360p · 4s crop_9_16 x1', image wali
 * '🍌 Nano Banana 2.1 crop_16_9 x2'. Jo cheez text me
 * na mile wo null rehti hai. Aspect 'crop_9_16' se
 * '9:16' banta hai (aur 'crop_16_9' se '16:9').
 * Lautta hai { isVideo, resolution, durationSec,
 * aspect, count } — isVideo 'Video' lafz mile to
 * true, 'Image'/'Banana' mile to false, warna null.
 */
function parseSettingsPill(text) {
  const out = { isVideo: null, resolution: null, durationSec: null, aspect: null, count: null };
  if (typeof text !== 'string' || !text.trim()) return out;
  const t = text.replace(/\s+/g, ' ').trim();
  if (/\bVideo\b/.test(t)) out.isVideo = true;
  else if (/\bImage\b/.test(t) || t.includes('Banana')) out.isVideo = false;
  const res = t.match(/(\d{3,4})p\b/i);
  if (res) out.resolution = `${res[1]}p`;
  const dur = t.match(/\b(\d+(?:\.\d+)?)s\b/);
  if (dur) {
    const v = Number(dur[1]);
    if (Number.isFinite(v)) out.durationSec = v;
  }
  const asp = t.match(/crop_(\d+)_(\d+)/) || t.match(/\b(\d+):(\d+)\b/);
  if (asp) out.aspect = `${asp[1]}:${asp[2]}`;
  const cnt = t.match(/\bx(\d+)\b/i);
  if (cnt) out.count = `x${cnt[1]}`;
  return out;
}

/**
 * v2.48.63 (SETTINGS TASDEEQ — Item B): mangi hui
 * settings aur pill ki asal haalat ka muqabla —
 * KHALIS faisla. requested = { mode: 'Video'|'Image',
 * resolution: '360p'|null, durationSec: number|null,
 * aspect: '9:16'|null } (null = is run ke liye wo
 * cheez maayne nahi rakhti, muqabla nahi hota). Pill
 * kisi cheez ko rakhta hi na ho to wo bhi ikhtilaf
 * gina jata hai (pill padh sakne ki soorat me).
 * Lautta hai ikhtilaf wale kheton ke naam
 * ('mode'|'resolution'|'duration'|'aspect');
 * khaali fehrist = poora muwafiq.
 */
function settingsPillMismatch(requested, pill) {
  const out = [];
  if (!requested || !pill) return out;
  const wantVideo = requested.mode === 'Video' ? true
    : (requested.mode === 'Image' ? false : null);
  if (wantVideo !== null && pill.isVideo !== wantVideo) out.push('mode');
  if (requested.resolution != null && pill.resolution !== requested.resolution) out.push('resolution');
  if (requested.durationSec != null && pill.durationSec !== requested.durationSec) out.push('duration');
  if (requested.aspect != null && pill.aspect !== requested.aspect) out.push('aspect');
  return out;
}

/**
 * v2.48.59 (OMNI 1.2 FLASH): Omni Flash 1.2 ki qeemat
 * PER-SECOND hai (Google Flow support page, verified
 * 2026-11-06; CREDIT-RATES-OMNI-1.2-2026-11-06.md) —
 * 1.1 ki flat table (4/5/6/7 waghera) se bilkul alag:
 *   360p: sec 1–10 = 1 credit/sec, sec 11–15 = 2/sec
 *   720p: sec 1–10 = 3 credits/sec, sec 11–15 = 6/sec
 * Durations 3–15s (1s steps). Range se bahar ki value
 * sab se qareeb in-range value par clamp hoti hai
 * (engine ki purani fallback aadat — engine ko hamesha
 * ek number chahiye; Dart wali estimate wahan null
 * deti hai kyunke wo sirf dikhane ke liye hai).
 * Khalis helper — getRequiredCredits isi ko bulata hai.
 */
function omni12CreditsPerVideo(seconds, genRes) {
  let secs = Math.round(Number(seconds) || 0);
  if (!Number.isFinite(secs) || secs <= 0) secs = 6;
  if (secs < 3) secs = 3;
  if (secs > 15) secs = 15;
  const base = genRes === '720p' ? 3 : 1;
  const extra = genRes === '720p' ? 6 : 2;
  if (secs <= 10) return secs * base;
  return 10 * base + (secs - 10) * extra;
}

/**
 * v2.48.59 (OMNI 1.2 FLASH): model-naam ki pehchan —
 * version token (pehla \d+\.\d+, masalan '1.2'/'3.1')
 * aur baaki lafz tokens (version hata kar). Flow ke
 * menu ki exact wording yahan se maloom nahi ho sakti
 * — 'Omni 1.2 Flash' bhi ho sakta hai aur 'Omni Flash
 * 1.2' bhi — is liye chunav kabhi ek exact string par
 * nahi, hamesha in tokens par hota hai.
 */
function modelNameParts(name) {
  const raw = String(name == null ? '' : name).toLowerCase();
  const vm = raw.match(/\d+\.\d+/);
  const version = vm ? vm[0] : null;
  const rest = vm ? raw.replace(vm[0], ' ') : raw;
  const words = rest.match(/[a-z]+/g) || [];
  return { version, words };
}

/**
 * v2.48.59: matchModelOption(targetName, itemTexts)
 * -> chune hue item ka index, ya -1. Khalis faisla:
 *  - Target ke paas version ho (masalan 'Omni 1.2
 *    Flash', 'Veo 3.1 Fast') to item tabhi match hai
 *    jab us ka version WAHI ho aur target ke saare
 *    lafz tokens us me hon.
 *  - Target bina version ke ho (legacy 'Omni Flash'
 *    = Omni 1.1) to pehle bina-version wala item,
 *    warna '1.1' version wala — '1.2' jaisa doosra
 *    version KABHI nahi jab 1.1/bina-version maujood
 *    ho (purana includes() yahi galti karta tha:
 *    'omniflash' saaf string 'omniflash12' ke andar
 *    mil jati thi). Kuch aur bache hi na to purani
 *    token-subset fallback (pehla candidate).
 *  - opts.strictVersion (current-selection check ke
 *    liye): doosre version par fallback NAHI — warna
 *    panel par 1.2 chalta hua 1.1 target ko 'pehle se
 *    chuna hua' keh kar chup chaap 1.2 hi rehne deta.
 */
function matchModelOption(targetName, itemTexts, opts) {
  const strict = !!(opts && opts.strictVersion);
  const t = modelNameParts(targetName);
  const items = Array.isArray(itemTexts) ? itemTexts : [];
  if (!t.words.length || !items.length) return -1;
  const parsed = items.map((txt) => modelNameParts(txt));
  const cand = [];
  parsed.forEach((p, i) => {
    if (t.words.every((w) => p.words.includes(w))) cand.push(i);
  });
  if (!cand.length) return -1;
  if (t.version) {
    const hit = cand.find((i) => parsed[i].version === t.version);
    return hit === undefined ? -1 : hit;
  }
  const noVer = cand.find((i) => parsed[i].version === null);
  if (noVer !== undefined) return noVer;
  const v11 = cand.find((i) => parsed[i].version === '1.1');
  if (v11 !== undefined) return v11;
  if (strict) return -1;
  return cand[0];
}

/**
 * v2.48.52 (ROUTE 1A PACK): netload (CDP
 * Network.loadNetworkResource) koshish ki [ROOT]
 * line (khalis). Ek koshish = ek line: kaun sa host,
 * kaun sa range param hata (range|rn|rbuf|none),
 * HTTP status (na mile to '-'), kitne bytes aaye,
 * aur anjaam — saved / rejected:<wajah-chhoti> /
 * error:<wajah-chhoti>. Asal URL ya query kabhi
 * line me nahi jata.
 * input = { host, stripped, status, bytes, result }
 * — result 'saved' | 'rejected:<wajah>' | 'error:<wajah>'.
 */
function netloadLogLine(info) {
  const o = info && typeof info === 'object' ? info : {};
  const host = typeof o.host === 'string' && o.host ? o.host.slice(0, 60) : '-';
  const stripped = o.stripped === 'range' || o.stripped === 'rn' || o.stripped === 'rbuf' ? o.stripped : 'none';
  const status = Number.isFinite(o.status) && o.status > 0 ? String(Math.floor(o.status)) : '-';
  const bytes = Number.isFinite(o.bytes) && o.bytes > 0 ? String(Math.floor(o.bytes)) : '0';
  let result = 'error';
  if (o.result === 'saved') result = 'saved';
  else if (typeof o.result === 'string' && o.result.startsWith('rejected')) result = 'rejected:' + (o.result.slice('rejected'.length).replace(/^:/, '').replace(/\s+/g, '-').slice(0, 24) || 'rejected');
  else if (typeof o.result === 'string' && o.result.startsWith('error')) result = 'error:' + (o.result.slice('error'.length).replace(/^:/, '').replace(/\s+/g, '-').slice(0, 24) || 'error');
  return `[ROOT] mainpage-netload host=${host} stripped=${stripped} status=${status} bytes=${bytes} result=${result}`;
}

/**
 * v2.48.52 (ROUTE 1A PACK): netload ke PROTOCOL
 * nakami ki [ROOT] line (khalis) — loadNetworkResource
 * khud na chala / stream na mili / drain bigda.
 * Ghalti ka paigham ek line me sameet kar
 * (whitespace dabaa kar, zyada se zyada 120 harf)
 * dikhaya jata hai; asal URL line me nahi jata.
 * input = { host, err }
 */
function netloadFailedLogLine(info) {
  const o = info && typeof info === 'object' ? info : {};
  const host = typeof o.host === 'string' && o.host ? o.host.slice(0, 60) : '-';
  const err = String(o.err || 'error').replace(/\s+/g, ' ').trim().slice(0, 120) || 'error';
  return `[ROOT] mainpage-netload failed host=${host} err=${err}`;
}

/**
 * v2.48.52 (ROUTE 1A PACK): CDP IO stream ko poora
 * khaali karo (loadNetworkResource se mila handle) —
 * IO.read baar baar, har tukde ka apna base64Encoded
 * jhanda, EOF par ruk. Natija ek Buffer; stream ka
 * hisaab bigde (data string na ho aur EOF bhi na
 * ho, hadd se zyada tukde/bytes, ya read khud gire)
 * to null — bulane wala use protocol-nakami samajh
 * kar purani completion silsile par girta hai.
 * send fn = (method, params) => Promise.
 */
async function drainNetloadStream(send, handle) {
  if (typeof send !== 'function' || !handle) return null;
  const parts = [];
  let total = 0;
  for (let i = 0; i < 1024; i++) {
    let r;
    try { r = await send('IO.read', { handle }); } catch (e) { return null; }
    if (!r || typeof r !== 'object') return null;
    const data = typeof r.data === 'string' ? r.data : '';
    if (data) {
      const chunk = r.base64Encoded ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8');
      parts.push(chunk);
      total += chunk.length;
      if (total > 64 * 1024 * 1024) return null;
    }
    if (r.eof) return parts.length === 1 ? parts[0] : Buffer.concat(parts);
    if (!data) return null;
  }
  return null;
}

/**
 * v2.48.50 (item 1): tile-drive ki 'element is pal
 * maujud nahi' wapsi ka nishan — bulane wala is par
 * hidden chaara chalata hai; ye koi outcome NAHI hai
 * (koi koshish hui hi nahi, koi line nahi banti).
 */
const TILE_DRIVE_MISSING = Symbol('fs-tile-drive-missing');

/**
 * FlowStudio Lite — Google Flow automation engine (adapted from the audited
 * V2 engine, keeping its proven Flow page knowledge).
 *
 * Differences from V2, by audit mandate:
 *  - The engine NEVER writes account credits/status itself. Every credit
 *    event goes through the injected creditPort (bound to creditService by
 *    the WorkerPool) — audit fix #4.
 *  - hasConfiguredSettings is reset on EVERY browser close and launch, so
 *    generation settings are always re-applied after an account rotation —
 *    audit fix #5.
 *  - Profile locks are only cleaned as files; a genuinely locked profile
 *    reports PROFILE_BUSY and the account is skipped — audit fix #7.
 *  - Download identity is strict: a task may only complete with media from
 *    ITS OWN claimed tile / its own captured video URL. There are no
 *    "latest fresh URL" or "newest tile" fallbacks — audit fix #6.
 *  - Task persistence (complete/fail) is the WorkerPool's job, via the
 *    onTaskCompleted / onTaskFailed callbacks.
 */
class FlowAutomationEngine {
  constructor(callbacks = {}, options = {}) {
    this.onLog = callbacks.onLog || (() => {});
    this.onProgress = callbacks.onProgress || (() => {});
    this.onVideoStarted = callbacks.onVideoStarted || (() => {});
    this.onVideoProgress = callbacks.onVideoProgress || (() => {});
    this.onVideoCompleted = callbacks.onVideoCompleted || (() => {});
    this.onTaskCompleted = callbacks.onTaskCompleted || (() => {});
    this.onTaskFailed = callbacks.onTaskFailed || (() => {});
    // v2.45.0 (download defer): render complete hone par, jab queue
    // me aur prompts baaki hon, monitor download yahin poora karne
    // ke bajaye task ko is callback se pool ko saunpta hai — pool
    // use download-only (needs_check) bana kar apne deferred
    // download drain se niptata hai aur slot agli prompt ke liye
    // foran khaali ho jata hai. Default no-op: purane callers par
    // defer kabhi fire hi nahi hota (wo downloadTaskMedia wala
    // purana inline raasta hi chalate hain).
    this.onTaskDownloadDeferred = callbacks.onTaskDownloadDeferred || (() => {});
    this.onAccountUpdated = callbacks.onAccountUpdated || (() => {});
    // v2.1.0: fired ONCE when a submitted render's tile stays missing
    // and stall recovery begins (the pool turns it into an Activity
    // entry). Optional — older callback sets simply don't get it.
    this.onTaskStalled = callbacks.onTaskStalled || (() => {});
    // v2.4.0: fired when a task's render TILE STATE changes
    // (absent -> generating -> failed/ready …) so the pool can record
    // the story in Activity with its stage. Heartbeat ticks of an
    // unchanged state stay log-only (they would flood the feed).
    this.onTaskHeartbeat = callbacks.onTaskHeartbeat || (() => {});
    // v2.6.0: fired ONCE per frozen episode when a bound, generating
    // tile's progress percentage does not move for the whole stall
    // budget (engine/renderProgressWatch.js) — the pool turns it into
    // an Activity entry with stage 'render-stall'. Optional.
    this.onRenderStall = callbacks.onRenderStall || (() => {});
    // v2.8.0: fired when a task's video link arrives from Flow's
    // BACKEND (network capture — engine/networkCapture.js) and the
    // direct fetch starts. The pool turns it into an Activity entry
    // (stage 'download') so the owner sees the video came without
    // any button/menu. Optional.
    this.onBackendMedia = callbacks.onBackendMedia || (() => {});
    // v2.8.0: the network capture layer for THIS engine's browser
    // session. Listeners attach at launch; ingestion arms at the
    // first submission. Bindings (workflowId -> task -> media URL)
    // arrive through _onBackendMediaBound.
    this.netCapture = new networkCapture.NetworkCapture({
      onMediaBound: (key, url, via) => {
        try { this._onBackendMediaBound(key, url, via); } catch (e) {}
      },
      // v2.48.27 (NET-BIG): ≥200KB ka har network jawab ek line —
      // Download click ke baad file ke bytes kis channel se aate
      // hain, uska shikar. Stage ka andaza: kisi task ka download
      // chal raha ho to 'download-attempt', monitor chal raha ho
      // to 'render-monitor', warna khaali.
      onNetBig: (info) => {
        try {
          let stage = '';
          try {
            let dlActive = false;
            for (const t of this._captureTasks.values()) {
              if (t && t._downloadInProgress) { dlActive = true; break; }
            }
            stage = dlActive ? 'download-attempt'
              : (this._monitorTasks && this._monitorTasks.length ? 'render-monitor' : '');
          } catch (e) {}
          this.log(`[NET-BIG] host=${info.host} path=${info.shape} type=${info.type || 'unknown'} bytes=${info.bytes}${stage ? ` timing=${stage}` : ''}`, 'info');
        } catch (e) {}
      },
      // v2.48.31 (MINT): mint watch ki khabrein — [MINT] lines.
      // Request wali line SIRF tab jab is pal kisi task ki mint
      // khidki (resolution click → pehli flow-content sighting)
      // khuli ho; ginati aur cap tracker (mintWindow) rakhta hai.
      onMintRequest: (entry) => {
        try {
          const tr = this._mintTracker;
          if (!tr || !tr.isOpen()) return;
          const r = tr.noteRequest(entry);
          if (r === 'cap') {
            this.log(`[MINT] req … (mint-window log cap ${mintWindow.DEFAULT_WINDOW_CAP} reached — further requests in this window are counted, not listed)`, 'info');
          } else if (r) {
            this.log(`[MINT] req method=${r.method} host=${r.host} path=${r.path}`, 'info');
          }
        } catch (e) {}
      },
      // Kisi jawab ke Location/body me file ke server address ka
      // nishan — kaunsi API call asal me signed URL laati hai,
      // yehi (B) sawal ka saboot hai.
      onMintCarriesUrl: (info) => {
        try {
          this.log(`[MINT] response-carries-file-url method=${info.method} host=${info.host} path=${info.path}`, 'info');
        } catch (e) {}
      },
      // v2.48.33 (ZEROCLICK): wohi carries wali darkhwast ab
      // replay template ke roop me seekh li gayi hai — khabar
      // me sirf shakal hai (rpcids = backend function ke naam,
      // body ki size, aur is task ke ID ki occurrences ki
      // ginti). Ek task se ek hi dafa (round ke andar wahi
      // call kai jawab de sakti hai; capture khud bhi waisa
      // template dobara nahi bhejta).
      onMintTemplate: (info) => {
        try {
          if (!this._mintLearnedKeys) this._mintLearnedKeys = new Set();
          const k = info.taskKey || '(unknown)';
          if (this._mintLearnedKeys.has(k)) return;
          this._mintLearnedKeys.add(k);
          const rpcids = Array.isArray(info.rpcids) && info.rpcids.length ? info.rpcids.join(',') : '(none)';
          this.log(`[ZEROCLICK] mint-template learned rpcids=${rpcids} bodyBytes=${info.bodyBytes} idsInBody=${info.idsInBody} idsInUrl=${info.idsInUrl}`, 'info');
        } catch (e) {}
      },
      // v2.48.38 (EDITOR-HARVEST PACK): HARVEST-AUDIT —
      // download attempt / editor-khidki ke dauraan har
      // mukammal flow-content jawab ki ek line (asal me
      // promotion hua ya nahi, aur kyun nahi). ZEROCLICK4/5
      // me yehi khabar ghayab thi ke page-harvest kyun nahi
      // chala tha. Sirf hisaab hai — vyavhaar nahi badalta.
      onHarvestAudit: (audit) => {
        try {
          this.log(`[ROOT] harvest-audit ${saveGuard.formatHarvestAudit(audit)}`, 'info');
        } catch (e) {}
      },
      // v2.48.41 (MAIN-PAGE HARVEST PACK): MAINPAGE-AUDIT —
      // render watch / download attempt ke dauraan MAIN
      // page par aane wale har video-jese jawab ki ek
      // line: host, bytes, alamat ki qisam (flow-content
      // | googlevideo), faisla (captured/ignored +
      // wajah) aur timing bucket. Owner ke sawal ka
      // saboot: kya main page khud tile ki stream mangti
      // hai — dawa koi nahi, jo dikhega wahi log hoga.
      onMainpageAudit: (audit) => {
        try {
          this.log(`[ROOT] mainpage-audit ${saveGuard.formatMainpageAudit(audit)} timing=${audit.timing || 'render-watch'}`, 'info');
        } catch (e) {}
      },
      // Immediate zero-click candidate handoff. This runs when the
      // network body is captured, not after the monitor's 60s harvest
      // patience window.
      onMainpageCandidate: (info) => {
        try { this._onMainpageCandidate(info); } catch (e) {}
      },
      // v2.48.50 (item 18 — SEGMENT ASSEMBLY): ek
      // logical stream ke 2+ URL hone ki khabar — sirf
      // ek line, jab group pehli dafa banta hai.
      onSegmentNote: (info) => {
        try {
          this.log(`[ROOT] mainpage-segments urls=${info && Number.isFinite(info.urls) ? Math.floor(info.urls) : 0}`, 'info');
        } catch (e) {}
      },
      // v2.48.52 (ROUTE 1B — FETCH-RANGE-REWRITE):
      // rewrite apni pehli nakami par khud band ho
      // gaya — sirf EK line; run is ke baghair
      // bilkul waisa hi chalta hai.
      onFetchRwDisabled: (info) => {
        try {
          const reason = String((info && info.reason) || 'error').replace(/\s+/g, ' ').trim().slice(0, 60) || 'error';
          this.log(`[ROOT] mainpage-fetchrw disabled reason=${reason}`, 'warn');
        } catch (e) {}
      },
      // v2.48.53 (RPC-BODY SCAN): batchexecute jawab
      // ke andar pehli dafa dikha googlevideo address
      // — sirf host/clen/itag (asal URL kabhi nahi).
      onRpcVideoUrls: (info) => {
        try {
          const items = info && Array.isArray(info.items) ? info.items : [];
          if (!items.length) return;
          const rpcids = info && Array.isArray(info.rpcids) && info.rpcids.length ? info.rpcids.join(',') : '-';
          const clens = items.map(i => (i && Number.isFinite(i.clen)) ? Math.floor(i.clen) : '-').join(',');
          const itags = items.map(i => (i && i.itag) ? String(i.itag) : '-').join(',');
          this.log(`[ROOT] rpc-video-urls rpcid=${rpcids} count=${items.length} clens=${clens} itags=${itags}`, 'info');
        } catch (e) {}
      },
      // v2.48.53 (ROUTE 1B SABOOT): Fetch rewrite asal
      // me kisi darkhwast par laga — kis host par, asal
      // Range kya tha, kaunsa param hata.
      onFetchRwRewrite: (info) => {
        try {
          const host = String((info && info.host) || '').slice(0, 60) || '-';
          const origRange = info && info.origRange ? String(info.origRange).replace(/\s+/g, ' ').slice(0, 40) : 'none';
          const stripped = info && Array.isArray(info.stripped) && info.stripped.length ? info.stripped.join(',') : 'none';
          this.log(`[ROOT] mainpage-fetchrw rewritten host=${host} origRange=${origRange} stripped=${stripped} newRange=bytes=0-`, 'info');
        } catch (e) {}
      },
      // v2.48.53 (FOCUS EMULATION): page ke CDP client
      // par focus-emulation lag gaya / nahi laga.
      onFocusEmulation: (info) => {
        try {
          if (info && info.ok) this.log(`[ROOT] focus-emulation enabled`, 'info');
          else this.log(`[ROOT] focus-emulation failed`, 'warn');
        } catch (e) {}
      },
      // v2.48.62 (GV-REQ LOGGER): har googlevideo playback
      // darkhwast ki EK line — preview (~93KB) aur full
      // (~1.3MB) darkhwastein kahan se aatin hain (redirect
      // source + initiator) is ka saboot ZC30 me yahi dega.
      // Asal signed URL kabhi nahi (fields capture ke
      // gvReqFields se saaf hokar aate hain).
      onGvReq: (f) => {
        try {
          if (!f) return;
          this.log(`[ROOT] gv-req host=${f.host} clen=${f.clen} itag=${f.itag} dur=${f.dur} range=${f.range} from=${f.from} init=${f.init}`, 'info');
        } catch (e) {}
      }
    });
    // v2.48.36 (ROOT PACK — A): download-stage ka tala —
    // capture-session ke hisaab se bandha hua (isi liye
    // stageLockFor): is page/capture par chalne wala har
    // download round (monitor ho ya drain/retry) ek hi
    // kataar se guzarta hai; generation/rendering is se
    // bilkul alag aur parallel rehti hai.
    this._downloadStageLock = stageLock.stageLockFor(this.netCapture);
    // v2.8.0: captureKey -> live engine task (registered by the
    // monitor / download-retry), and captureKey -> {url, via} for
    // bindings that landed before the task object was registered.
    this._captureTasks = new Map();
    this._earlyBackend = new Map();
    // v2.48.63 (PASSIVE-FIRST — Item A): is engine
    // session ka aaghaz — kisi task ka render ISI
    // session me mukammal hua hai ya nahi, is ki
    // pehchan passiveClaimApplies isi se karta hai.
    // Engine har worker / recovery session ke liye
    // naya banta hai (workerPool), is liye constructor
    // ka pal hi session ka aaghaz hai.
    this._sessionStartedAt = Date.now();
    // v2.48.65 (BELOW-FLOOR SAMPLE — Item B): is
    // worker session me below-floor wala diagnostic
    // sample pehle hi save ho chuka hai ya nahi —
    // latch; har session me sirf EK sample (jaanch
    // ke liye ek hi file kaafi hai, folder bharna
    // maqsad nahi).
    this._belowfloorSampleSaved = false;
    // v2.48.63 (SKIP SCOPE — Item C): jin taskIds ka
    // download is session me test-flag se park ho
    // chuka hai — un ke liye SKIPPED wali [ROOT] line
    // sirf EK dafa; us ke baad downloadTaskMedia
    // khamoshi se wahi { skipped:true } natija deta
    // hai (ZC30 me drain/retry ne ~8 dafa wahi line
    // dohrayi thi).
    this._skipParkedTaskIds = new Set();
    // v2.48.13: direct-API pollers (videoId -> poll state). Har
    // submit ke baad ek poller us task ke workflow ki haal-jaanch
    // wali asal API request ko page ke andar se replay karke
    // backend ko seedha poochhta rehta hai — link jawab me aate hi
    // maujood capture-bandish download foran shuru kar deti hai.
    this._apiPolls = new Map();
    // v2.8.0: the "backend par koi video link nahi dikha" line is
    // spoken ONCE per browser session, not once per task.
    this._backendNoteLogged = false;
    // v2.6.0: how long a generating tile's percentage may sit frozen
    // before the watchdog speaks (constructor option so tests can
    // shrink it; production 3 minutes — long enough that a busy Flow
    // day does not cry wolf, short enough that a dead render is
    // named while there is still time to act).
    this.progressStallAfterMs = Number(options.progressStallAfterMs) > 0 ? Number(options.progressStallAfterMs) : renderProgressWatch.DEFAULT_STALL_AFTER_MS;
    // v2.48.0 (deep-audit fix #5): the frozen-% ESCALATION budget —
    // a tile whose % has not moved for this long (production 6
    // minutes) is failed as 'render-frozen' (failover-eligible)
    // instead of waiting silently for the absolute cap.
    this.progressFrozenAfterMs = Number(options.progressFrozenAfterMs) > 0 ? Number(options.progressFrozenAfterMs) : renderProgressWatch.DEFAULT_FROZEN_AFTER_MS;
    // v2.4.0: heartbeat cadence for long waits (constructor option so
    // tests can shrink it; production 30s — the owner's rule is that
    // the log may never sit silent while a paid render is in flight).
    this.heartbeatEveryMs = Number(options.heartbeatEveryMs) > 0 ? Number(options.heartbeatEveryMs) : 30000;
    // v2.4.0: the current monitor window's task list, set by
    // waitForAccountTasks — the recovery scan reads it to know
    // whether a weak-text task is the account's ONLY in-flight task
    // (the one condition under which the order/timing scan fallback
    // may bind a tile by position alone).
    this._monitorTasks = null;
    // v2.1.0 stall-recovery tuning (constructor options exist so tests
    // can shrink the windows; production uses the defaults).
    this.stallTimeoutSecOverride = Number(options.stallTimeoutSec) > 0 ? Number(options.stallTimeoutSec) : null;
    this.recoveryWindowSecOverride = Number(options.recoveryWindowSec) > 0 ? Number(options.recoveryWindowSec) : null;
    this.recoveryScanEveryMs = Number(options.recoveryScanEveryMs) > 0 ? Number(options.recoveryScanEveryMs) : 15000;

    // Credit port: every method is a no-op unless the pool binds it.
    const noopPort = {
      liveBalance: () => {}, exhaustionBanner: () => {}, lowCredits: () => {},
      estimatedCharge: () => {}, signOut: () => {}, ambiguous: () => {}
    };
    this.creditPort = Object.assign({}, noopPort, options.creditPort || {});

    // v2.31.3 (download fix pack): the DOWNLOAD LEDGER port — the
    // pool binds it to dbService so every download round is counted
    // on the task's own database row (durable across restarts) and
    // the 3-round cap can be enforced here, at the one place every
    // download passes through. No-op unless the pool binds it (old
    // callers / tests simply get no cap and no counting).
    //   attempts(taskId, channel)              -> rounds already spent
    //   roundSettled(taskId, ok, err, channel) -> persist the result
    // v2.48.0: channel is 'monitor' (default) or 'drain' — the two
    // channels keep SEPARATE persisted budgets (see downloadFetch
    // roundCapForChannel); this engine reports its current channel,
    // which retryDownloadForTask sets to 'drain' for its rounds.
    const noopDownloadPort = {
      attempts: () => 0,
      roundSettled: () => {}
    };
    this._downloadChannel = 'monitor';
    this.downloadPort = Object.assign({}, noopDownloadPort, options.downloadPort || {});
    // v2.48.60 (PROJECT REGISTRY): PROJECT LEDGER port —
    // pool isey dbService.recordProjectSeen se bandhta
    // hai. Engine har project entry par recordSeen
    // bulata hai; ledger pehli baar ki row par
    // { isNew: true } lautata hai taaki [ROOT]
    // project-registered wali line SIRF nayi row par
    // lage. No-op jab pool na bandhe (purane bulane
    // wale / tests — un ke liye registry khaamosh
    // rehti hai).
    //   recordSeen(accountKey, projectUrl, source)
    //     -> { isNew, row } | null
    const noopProjectPort = {
      recordSeen: () => null
    };
    this.projectPort = Object.assign({}, noopProjectPort, options.projectPort || {});
    // v2.31.3 tuning (constructor options so simulations can shrink
    // the windows; production uses these defaults): one download
    // ROUND gets 150s (v2.48.0: raised from 120s — the 25s media-
    // readiness poll plus the four strategies did not fit honestly
    // inside 120s on a busy page), a native browser
    // download whose file stops growing for 45s is abandoned as
    // stalled, and the post-run watcher sweep fires after 5 minutes.
    this.downloadRoundTimeoutMs = Number(options.downloadRoundTimeoutMs) > 0 ? Number(options.downloadRoundTimeoutMs) : 150000;
    // v2.48.42 (MAIN-PAGE BINDING PACK): viewport
    // trigger ki hadd bandhi intezaar khidki — tile ko
    // nazar me laane ke baad stream ke aane ka intezaar
    // (production 9s) aur pehle naye stream ke baad ka
    // settle (1.2s — doosra aane wala ho to ambiguity
    // pakdi jaye). Constructor options taaki test
    // ghata saken.
    this.mainpageViewportWaitMs = Number(options.mainpageViewportWaitMs) > 0 ? Number(options.mainpageViewportWaitMs) : 9000;
    this.mainpageViewportSettleMs = Number(options.mainpageViewportSettleMs) > 0 ? Number(options.mainpageViewportSettleMs) : 1200;
    // v2.48.57 (PROJECT-TRUTH): gallery-entry ke poll ki
    // muddat (production 1000ms) — constructor option
    // taaki nakli-page test tez chal saken.
    this.galleryEntryPollMs = Number(options.galleryEntryPollMs) > 0 ? Number(options.galleryEntryPollMs) : 1000;
    // v2.48.58 (RECOVERY-NO-CREDIT-GATE change 2):
    // recovery gallery entry se pehle tiles ke render
    // ka intezaar — production me had 15s, poll 500ms.
    // Constructor options taaki test ghata saken.
    this.galleryWaitMs = Number(options.galleryWaitMs) > 0 ? Number(options.galleryWaitMs) : 15000;
    this.galleryWaitPollMs = Number(options.galleryWaitPollMs) > 0 ? Number(options.galleryWaitPollMs) : 500;
    // v2.48.43 (HOVER + PATIENCE PACK): SABR ki khidki
    // — download attempt apne render-complete se itni
    // der (production 60s) main page par stream ka
    // intezaar karta hai (Flow ke previews render ke
    // 15–45s baad apni marzi se aate hain — ZEROCLICK9/
    // 10 ka saboot). Hover trigger ki seedhi: scroll ke
    // baad itni der me stream na aaye to synthetic
    // mouse ishara (hoverGrace), us ke baad itni aur
    // der me na aaye to asal pointer hover (pointer
    // Grace) — pointer baqi intezaar wahi ruka rehta
    // hai. Constructor options taaki test ghata saken.
    this.mainpagePatienceMs = Number(options.mainpagePatienceMs) > 0 ? Number(options.mainpagePatienceMs) : 60000;
    this.mainpageHoverGraceMs = Number(options.mainpageHoverGraceMs) > 0 ? Number(options.mainpageHoverGraceMs) : 4000;
    this.mainpagePointerGraceMs = Number(options.mainpagePointerGraceMs) > 0 ? Number(options.mainpagePointerGraceMs) : 4000;
    // v2.48.44 (HEADLESS HARVEST PACK — OPTION 2):
    // adrishya (bina-window) browser me editor ki
    // playback stream ke mukammal hone ka intezaar
    // (production 30s) aur headless navigation ki hadd
    // (production 45s). Probe ka faisla per-run cache
    // me rehta hai — ek account, ek run, ek probe;
    // naya browser launch (naya run) cache saaf kar
    // deta hai. Constructor options taaki test ghata
    // saken.
    this.headlessHarvestWaitMs = Number(options.headlessHarvestWaitMs) > 0 ? Number(options.headlessHarvestWaitMs) : 30000;
    this.headlessNavTimeoutMs = Number(options.headlessNavTimeoutMs) > 0 ? Number(options.headlessNavTimeoutMs) : 45000;
    // v2.48.47 (MEDIA-LOAD COMPLETION): bandhe hue
    // mainpage address ko usi page ke ek adrishya
    // <video> element se poora load karne ka intezaar
    // (production 30s). Constructor option taaki test
    // ghata saken.
    this.mainpageMediaLoadMs = Number(options.mainpageMediaLoadMs) > 0 ? Number(options.mainpageMediaLoadMs) : 30000;
    this._headlessProbeCache = headlessHarvest.createProbeCache();
    // v2.48.51 (item 2 — combo yaad): jin accounts ke
    // liye probe2 (clone+inject) is RUN me 'logged-in'
    // de chuka hai, un ke account ids — baad ke
    // attempts seedha combo session banate hain, bare
    // transfer probe nahi. Per-run: browser launch par
    // probe cache ke saath saaf.
    this._headlessComboAccounts = new Set();
    this.nativeDownloadStallMs = Number(options.nativeDownloadStallMs) > 0 ? Number(options.nativeDownloadStallMs) : 45000;
    this.watcherSweepDelayMs = Number(options.watcherSweepDelayMs) > 0 ? Number(options.watcherSweepDelayMs) : 300000;
    this._watcherSweepTimer = null;

    this.browser = null;
    this.page = null;
    this.cdpSession = null;
    this.isStopping = false;
    this.isPaused = false;
    this.currentAccount = null;
    // v2.25.0 (parked browser): is THIS engine's generation window
    // currently on the owner's screen? A background launch starts
    // parked off-screen (false); a visible launch starts on screen
    // (true). Only the Show/Hide toggle (setBrowserWindowShown)
    // changes it afterwards — generation never does.
    this.windowShown = false;
    this.currentSettings = {};
    this.headless = !!options.headless;
    // Headless generation (owner's opt-in): TRUE headless Chrome
    // for this engine's launches — separate from `headless` above,
    // which is only the background (parked off-screen) flag despite
    // its name. browserMode.launchPlan combines the two.
    this.headlessGeneration = !!options.headlessGeneration;
    this.workerId = options.workerId || null;
    this.hasConfiguredSettings = false;
    this.claimedTileIndices = new Set();
    // v1.5.0: tile claims are tracked by FINGERPRINT (the tile's
    // normalized prompt aria), never by DOM index — see tileIdentity.js.
    this.claimedTileFingerprints = new Set();
    // v1.7.0: files THIS engine saved during its lifetime — the only
    // files a later save may overwrite. Anything else already sitting
    // in the download folder (an earlier run's videos) is never
    // silently replaced; the save takes a suffixed name instead.
    this.savedThisSession = new Set();
    // v2.32.1: WHO saved each path (abs path -> task key). The
    // pickers' "own path may be reused" exemption is per-TASK: the
    // session-wide set alone cannot tell a re-save of the same task
    // from a different task that merely computed the same file name
    // (shared run tag) — the latter collapsed 5 downloads onto one
    // file, each overwriting the previous (live-proven 2026-10-26).
    this.savedPathOwners = new Map();
    this.consumedVideoUrls = new Set();
    // v2.48.35 (GUARD): is run/session me save hue files ke
    // content hashes ki kitab (hash -> {key, promptIndex}) —
    // saveGuard ka per-run registry. Kisi AUR task jaisi
    // byte-identical file dobara save hone ki koshish yahin
    // pakdi jati hai (ZEROCLICK2 cross-task contamination).
    // Hash kabhi log nahi hota — sirf andarooni hisaab hai.
    this._runSavedContentHashes = new Map();
    // v2.38.0: the browser session's REAL User-Agent, read once per
    // launch and reused by every direct fetch — the cookies a fetch
    // carries come from this same session, so the UA must name the
    // same browser (a hardcoded version string did not).
    this._browserUA = null;
    // v2.48.9: session cookie header for direct fetches, cached
    // per launch (see _sessionCookieHeader) — downloads must not
    // queue behind a busy rendering page for their inputs.
    this._cookieHeaderCache = null;
    // v2.48.12: the current run's download folder, remembered at
    // launch so submitPrompt can register each task for backend
    // capture the moment it is submitted.
    this.currentDownloadDir = null;
    this.capturedVideoUrls = [];
    this.capturedVideoBuffers = new Map();
    this.capturedVideoBytes = 0;
    // v2.48.29 (HTML-POISON): jin bound/captured links ne is run
    // me HTML page diya, wo dobara fetch NAHI hote (FASTTEST3:
    // ek hi asb link 4 dafa, har dafa wahi HTML, ~32s zaaya).
    // Capture state ke saath launch par reset hota hai.
    this._htmlPoisonGuard = downloadFetch.createPoisonGuard();
    this.lastLaunchError = null;
    // v1.1 freeze fix: video-stream capture stays DISARMED until the first
    // prompt of the session is actually submitted (see submitPrompt). The
    // Flow landing/gallery pages stream many large mp4 previews; buffering
    // every one of them through CDP saturated the Electron main loop.
    this.captureArmed = false;

    // --- v2.48.70 + hotfix: NEW DOWNLOAD HELPERS ---
    // Pure-logic modules, no I/O, no prompt-submits. Wired into the
    // download flow below (timing, route, verify, zero-click, recovery).
    this._downloadHelpers = {
      timing: downloadTiming,
      route: downloadRoute,
      verify: downloadVerify,
      zeroClick: downloadZeroClick,
      recovery: projectRecovery
    };
  }

  log(msg, type = 'info', extra = {}) {
    this.onLog({ message: msg, type, timestamp: new Date().toLocaleTimeString(), ...extra });
  }

  updateProgress(data) {
    this.onProgress(data);
  }

  // v2.4.0 (fix: duplicate log lines): pause/resume/stop are logged
  // ONCE, by the WorkerPool — the owner's PC log showed every such
  // event twice (pool line + engine line). The engine methods now
  // change state silently; the pool's single line carries the news
  // (including the "in-flight renders finish first" note for pause).
  pause() {
    this.isPaused = true;
  }

  resume() {
    this.isPaused = false;
  }

  stop() {
    this.isStopping = true;
    this.isPaused = false;
    try { if (this.netCapture) this.netCapture.detach(); } catch (e) {}
    if (this.browser) {
      try {
        const pid = this.browser.process() ? this.browser.process().pid : null;
        if (pid && this.currentAccount) liveBrowsers.unregister(this.currentAccount.id, pid);
      } catch (e) {}
      try { this.browser.close().catch(() => {}); } catch (e) {}
    }
  }

  async launchBrowserForAccount(account, downloadDir) {
    this.lastLaunchError = null;
    // v2.31.3: new work starting on this browser cancels any pending
    // post-run watcher sweep — the watchers are about to be re-armed
    // for the new run and must not be released from under it.
    this.cancelDownloadWatcherSweep();
    // Audit fix #5: a fresh browser launch must always re-apply settings.
    this.hasConfiguredSettings = false;
    // v2.48.9: a fresh launch = a fresh session — drop the cached
    // fetch inputs (cookies / user-agent) of the previous account.
    this._cookieHeaderCache = null;
    this._browserUA = null;
    // v2.48.12: remember where this run's files belong.
    this.currentDownloadDir = downloadDir || null;
    // v2.48.44: naya browser launch = naya run — headless
    // probe ka per-run cache yahin saaf (ek run me ek
    // account ka probe sirf ek dafa hota hai).
    try { if (this._headlessProbeCache) this._headlessProbeCache.clear(); } catch (e) {}
    // v2.48.51 (item 2): combo yaad bhi per-run hai —
    // probe cache ke saath hi saaf.
    try { if (this._headlessComboAccounts) this._headlessComboAccounts.clear(); } catch (e) {}

    const chromePath = getChromeExecutablePath();
    const profilePath = getAccountProfilePath(account.id);

    // Audit fix #7 (v1.4 form): the app never kills the USER'S Chrome.
    // What checkProfileBusyAsync may terminate is only an UNREGISTERED
    // leftover holding one of THIS app's own profiles (see the v1.4
    // ownership rule in processHelper.js) — most importantly the app's
    // own Sign In Chrome lingering invisibly in background mode. A busy
    // result here now means: a registered live launch is using the
    // profile right now, or a holder could not be cleared (its PIDs are
    // in busyCheck.holderPids and in the log line below).
    // Generation deliberately does NOT fall back to a working copy of
    // the profile (unlike the read-only credit check): a live Flow
    // session rotates its session cookies as it works, so running
    // generation on a throwaway copy would strand the rotated tokens in
    // the copy and leave the real profile with stale session state.
    // Skipping the account with a clear reason is the correct behavior.
    // v1.4.1/v1.5.1: generation outranks EVERY other app-owned browser
    // (reclaimLogin) — the owner's standing order is that generation
    // must never wait on an open Chrome. It closes the app's own Sign
    // In window and any running credit check (a check is disposable:
    // its Puppeteer calls simply fail and creditService is untouched);
    // only another live GENERATION on this profile stays protected.
    const busyCheck = await checkProfileBusyAsync(profilePath, account.id, { reclaimLogin: true });
    if (busyCheck.healedBy === 'reclaim' && busyCheck.killedPids) {
      this.log(`Cleaned up a leftover old app Chrome (PID ${busyCheck.killedPids.join(', ')}) that was holding [${account.name}]'s profile — work continues.`, 'info');
    }
    if (busyCheck.busy) {
      this.lastLaunchError = 'PROFILE_BUSY';
      const holderNote = busyCheck.holderInfo && busyCheck.holderInfo.length
        ? ` (${busyCheck.holderInfo.map((h) => `PID ${h.pid}${h.kind ? `, ${h.kind}` : ''}`).join('; ')})`
        : '';
      const why = busyCheck.reason === 'in-use'
        ? `another job is currently running on this account${holderNote}`
        : `the profile is open in some Chrome${busyCheck.holderPids && busyCheck.holderPids.length ? ` (PID ${busyCheck.holderPids.join(', ')})` : ''} and could not be cleared`;
      this.lastBusyDetail = why;
      this.log(`[${account.name}]'s Chrome profile is busy right now — ${why}. Skipping this account for now.`, 'warn');
      return false;
    }
    this.lastBusyDetail = null;

    this.log(`Opening [${account.name}]'s own Chrome profile…`, 'info');

    // Visibility comes from the browserMode launch plan.
    // `this.headless` is the pool's "background requested" flag (the
    // name is historical): background used to mean Puppeteer headless
    // 'new' (v2.4.0 removed that — headless stalled Flow), then an
    // off-screen window MINIMIZED after launch (v2.6.0 removed the
    // minimize — a minimized/occluded window is throttled by Chrome
    // and Flow's renders froze at 1% on the owner's PC). Background
    // now launches the SAME headed Chrome parked off-screen in the
    // NORMAL window state, with the plan's anti-throttling flags and
    // CDP focus emulation (below), so the page keeps rendering and
    // timing exactly as if it were focused on screen. The owner's
    // separate Headless mode opt-in (this.headlessGeneration) is the
    // ONE case where the plan launches true headless Chrome — no
    // window exists at all; see browserMode.launchPlan.
    const plan = browserMode.launchPlan(this.headless, this.headlessGeneration);
    const args = [
      `--user-data-dir=${profilePath}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(plan.startMaximized ? ['--start-maximized'] : plan.extraArgs),
      ...(plan.antiThrottleArgs || []),
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-notifications',
      '--deny-permission-prompts',
      '--disable-popup-blocking',
      '--disable-features=NotificationTriggers,PushMessaging',
      '--mute-audio',
      '--disk-cache-size=104857600',
      '--enforce-webrtc-ip-permission-check'
    ];

    try {
      this.browserDownloadDir = path.join(downloadDir, '.flow-native', this.workerId || account.id);
      if (!fs.existsSync(this.browserDownloadDir)) fs.mkdirSync(this.browserDownloadDir, { recursive: true });
      this.browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: plan.headless,
        defaultViewport: null,
        args,
        ignoreDefaultArgs: ['--enable-automation']
      });
      // v1.4: register as a legitimately live launch (reclaim safety).
      // Kind 'generation' (v1.4.1) — long-running, never watchdogged.
      try {
        const genPid = this.browser.process() ? this.browser.process().pid : null;
        if (genPid) liveBrowsers.register(account.id, genPid, 'generation');
      } catch (e) {}

      // v2.48.25 (E1 — observe-only): browser-level download events.
      // Best-effort and fully detached from the working route: if it
      // fails, the launch continues exactly as before.
      try { await this._attachE1DownloadListener(this.browserDownloadDir || downloadDir); } catch (e) {}

      const pages = await this.browser.pages();
      this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

      this.page.on('dialog', async (dialog) => {
        try {
          this.log(`The browser's own popup was closed automatically: "${dialog.message()}"`, 'info');
          await dialog.dismiss();
        } catch (e) {}
      });

      if (pages.length > 1) {
        for (let i = 1; i < pages.length; i++) {
          try { await pages[i].close(); } catch (e) {}
        }
      }

      // v2.6.0: the window is NEVER minimized any more (see the plan
      // comment above — minimized windows get throttled and Flow's
      // renders froze). bringToFront only makes this page the active
      // TAB inside its own window; for an off-screen window nothing
      // appears on any screen. Focus emulation is enabled further
      // down, once the page CDP session exists.
      try { await this.page.bringToFront(); } catch (e) {}

      await this.page.evaluateOnNewDocument(() => {
        try {
          delete Object.getPrototypeOf(navigator).webdriver;
        } catch (e) {}
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        if (!window.chrome) window.chrome = {};
        window.chrome.runtime = window.chrome.runtime || {};
        if (!navigator.languages || navigator.languages.length === 0) {
          Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        }
      });

      // v2.48.26 (FAST-DL): in-page video-blob registry — the hook
      // is installed before any Flow script runs and only OBSERVES:
      // video blobs the page creates or fetches are recorded in
      // window.__mkBlobRegistry. (v2.48.41: the blob-harvest
      // download route is gone from the attempt path — the hook
      // stays as passive observation only; the video download
      // itself now comes from the main-page stream harvest.)
      try { await this.page.evaluateOnNewDocument(blobHarvest.HOOK_SOURCE); } catch (e) {}

      try {
        this.cdpSession = await this.page.target().createCDPSession();
        // v2.6.0 (background mode): focus emulation — the page keeps
        // reporting itself focused/visible to its own scripts even
        // though its window sits off-screen, so Flow's progress
        // timers and rendering are not throttled the way an occluded
        // page's are. Best-effort: the anti-throttling launch flags
        // (browserMode plan) already cover the window level.
        if (plan.focusEmulation) {
          try { await this.cdpSession.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
        }
        const targetDownloadPath = this.browserDownloadDir || downloadDir;
        if (targetDownloadPath) {
          if (!fs.existsSync(targetDownloadPath)) fs.mkdirSync(targetDownloadPath, { recursive: true });
          await this.cdpSession.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: targetDownloadPath
          });
        }
      } catch (e) {}

      // Intercept video CDN streams loaded by Google Flow. Buffers are keyed
      // by URL; a task may only consume a URL that was extracted from its
      // OWN claimed tile (audit fix #6).
      this.capturedVideoUrls = [];
      this.capturedVideoBuffers = new Map();
      this.capturedVideoBytes = 0;
      // v2.48.26 (FAST-DL): in-page registry entries already saved
      // by the blob harvest on THIS browser — a later task on the
      // same page must never be handed the same bytes again.
      this._fastDlConsumedBlobs = new Set();
      // v2.48.29: naya browser = nayi run-haalat — HTML-poison
      // wala hisaab bhi yahin se saaf (capture state ki tarah).
      this._htmlPoisonGuard = downloadFetch.createPoisonGuard();
      this._fastDlFailedBlobs = new Set();
      this.page.on('response', async (res) => {
        try {
          // v1.1: ignore ALL traffic until a prompt has been submitted —
          // downloads only ever need streams produced by our own tasks,
          // and downloadFromCapturedStream has a direct-fetch fallback.
          if (!this.captureArmed) return;
          const u = res.url();
          const headers = res.headers();
          const ct = (headers['content-type'] || '').toLowerCase();
          const isImage = ct.includes('image/') || u.includes('/asb/') || u.includes('thumbnail');
          const isVideo = !isImage && (
            ct.includes('video/') ||
            (u.includes('.mp4') && !u.includes('.mp4.')) ||
            (u.includes('flow-content.google') && !u.includes('thumbnail') && !u.includes('/asb/'))
          );
          if (isVideo) {
            if (!this.capturedVideoUrls.includes(u)) {
              this.capturedVideoUrls.push(u);
            }
            try {
              // v1.1: never buffer bodies whose declared size is useless
              // to us (small previews) or beyond the store cap — buffering
              // crosses CDP as base64 on the Electron main thread. The URL
              // is still recorded above, so a later direct fetch works.
              const declaredLen = parseInt(headers['content-length'] || '', 10);
              if (Number.isFinite(declaredLen) && (declaredLen < 100000 || declaredLen > 50 * 1024 * 1024)) return;
              if (this.capturedVideoBuffers.has(u)) return;
              const buf = await res.buffer();
              const isJpegOrPng = buf && buf.length > 4 && ((buf[0] === 0xff && buf[1] === 0xd8) || (buf[0] === 0x89 && buf[1] === 0x50));
              if (buf && buf.length > 100000 && !isJpegOrPng) {
                const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;
                while (this.capturedVideoBytes + buf.length > MAX_CAPTURE_BYTES && this.capturedVideoBuffers.size > 0) {
                  const oldestKey = this.capturedVideoBuffers.keys().next().value;
                  const evicted = this.capturedVideoBuffers.get(oldestKey);
                  this.capturedVideoBytes -= (evicted ? evicted.length : 0);
                  this.capturedVideoBuffers.delete(oldestKey);
                }
                if (this.capturedVideoBytes + buf.length <= MAX_CAPTURE_BYTES) {
                  this.capturedVideoBuffers.set(u, buf);
                  this.capturedVideoBytes += buf.length;
                }
              }
            } catch (bErr) {}
          }
        } catch (e) {}
      });

      // v2.8.0: NETWORK CAPTURE — page ki network khabar sunne wale
      // listeners browser ke saath hi lag jate hain, taaki kisi bhi
      // submission ka pehla jawab bhi na choote. Asal ingestion pehle
      // submit par armed hoti hai (beginSubmission) — usse pehle ke
      // project-page ke jawab (purane projects ke links) capture ko
      // ganda nahi karte. Har launch par capture ki haalat saaf.
      try {
        this.netCapture.reset();
        this.netCapture.disarm();
        this._captureTasks.clear();
        this._earlyBackend.clear();
        this._backendNoteLogged = false;
        // v2.48.50 (item 6): pipeline prime ka nishan
        // har naye session ke saath taaza.
        this._pipelinePrimedRun = false;
        this.netCapture.attach(this.page);
        // v2.48.37 (SESSION-WIDE MINT WATCH): page/session
        // tayyar hai — mint watch ab poore session ke liye
        // chalu. Template kisi bhi pal seekha ja sakta hai
        // (round ke andar ya bahar); band account chhodne /
        // sweep / browser band hone par hota hai. ZEROCLICK4
        // me round-gated watch ki wajah se ROOT routes ek
        // bhi dafa chal hi nahi paye the.
        if (typeof this.netCapture.setMintSessionWatch === 'function') {
          this.netCapture.setMintSessionWatch(true);
        }
      } catch (e) {}

      this.currentAccount = account;
      // v2.25.0: the launch plan decides where the window STARTS —
      // background = parked off-screen, visible = on screen.
      this.windowShown = !plan.background;
      // A window that starts PARKED also starts WITHOUT a taskbar
      // button (owner's order): it may reach the screen only
      // through the app's own Show/Hide button. Best-effort Win32
      // styling — a failure here changes nothing about the run.
      if (!this.windowShown && !this.headlessGeneration) {
        this._applyTaskbarStyle(false);
      }
      this.log(`Chrome is ready — [${account.name}]'s profile is open.`, 'success');
      return true;
    } catch (err) {
      this.lastLaunchError = err.message;
      const t = plainError.translateError(err);
      this.log(`Chrome could not open for [${account.name}] — ${t.plain}.`, 'error', { rawError: t.raw });
      return false;
    }
  }

  /**
   * v2.31.3 (download fix pack, ADOPT #2): the 5-MINUTE WATCHER
   * SWEEP. When a generation run ends, the pool schedules ONE timer
   * per worker/browser; when it fires, everything download-related
   * that is still armed on this browser is force-released: the
   * network capture listeners + arming, the video-stream capture
   * (page response handler gate + buffered streams), the task
   * bindings, and the CDP download-folder redirect (set back to the
   * browser default). This protects the owner's OWN later downloads
   * in a parked Chrome: nothing of FlowStudio's may keep watching,
   * capturing or redirecting them. If the browser is already closed
   * the release is a silent no-op; if a new run starts first (a
   * fresh launch), the pending sweep is cancelled at launch.
   */
  scheduleDownloadWatcherSweep() {
    this.cancelDownloadWatcherSweep();
    this._watcherSweepTimer = setTimeout(() => {
      this._watcherSweepTimer = null;
      try { this.releaseDownloadWatchers(); } catch (e) {}
    }, this.watcherSweepDelayMs || 300000);
    // Cleanup nicety only — a pending sweep must never keep the
    // process alive on its own (if the app exits, the browser and
    // its watchers go with it anyway).
    if (this._watcherSweepTimer && this._watcherSweepTimer.unref) this._watcherSweepTimer.unref();
  }

  cancelDownloadWatcherSweep() {
    if (this._watcherSweepTimer) {
      clearTimeout(this._watcherSweepTimer);
      this._watcherSweepTimer = null;
    }
  }

  releaseDownloadWatchers() {
    const hadBrowser = !!(this.browser && this.page && !this.page.isClosed());
    const wasArmed = !!(this.captureArmed || (this.netCapture && this.netCapture.armed));
    try { if (this.netCapture) this.netCapture.disarm(); } catch (e) {}
    // v2.48.37: session mint watch bhi band (worker account chhod raha hai).
    try { if (this.netCapture && typeof this.netCapture.setMintSessionWatch === 'function') this.netCapture.setMintSessionWatch(false); } catch (e) {}
    try { if (this.netCapture) this.netCapture.detach(); } catch (e) {}
    this.captureArmed = false;
    if (this.capturedVideoBuffers) {
      this.capturedVideoBuffers.clear();
      this.capturedVideoBytes = 0;
    }
    this.capturedVideoUrls = [];
    if (this._captureTasks) this._captureTasks.clear();
    if (this._earlyBackend) this._earlyBackend.clear();
    if (hadBrowser && this.cdpSession) {
      // Hand the browser's download behaviour back to Chrome's own
      // default — the manual-download protection this sweep exists
      // for. Best effort: a dead session just throws and is ignored.
      try {
        const p = this.cdpSession.send('Page.setDownloadBehavior', { behavior: 'default' });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) {}
    }
    if (hadBrowser || wasArmed) {
      this.log('Download watchers released — this browser\'s downloads are no longer watched, captured or redirected by FlowStudio.', 'info');
    }
  }

  async closeBrowser() {
    // v2.31.3: the browser is going away — a pending watcher sweep
    // has nothing left to protect and is cancelled.
    this.cancelDownloadWatcherSweep();
    // v2.8.0: capture ke listeners har session ke saath saaf band —
    // koi listener leak nahi, koi purana binding naye session me nahi.
    try { this.netCapture.detach(); } catch (e) {}
    try { this.netCapture.disarm(); } catch (e) {}
    // v2.48.37: session mint watch bhi band.
    try { if (typeof this.netCapture.setMintSessionWatch === 'function') this.netCapture.setMintSessionWatch(false); } catch (e) {}
    if (this._captureTasks) this._captureTasks.clear();
    if (this._earlyBackend) this._earlyBackend.clear();
    if (this.browser) {
      try {
        const pid = this.browser.process() ? this.browser.process().pid : null;
        if (pid && this.currentAccount) liveBrowsers.unregister(this.currentAccount.id, pid);
      } catch (e) {}
      try { await this.browser.close(); } catch (e) {}
      // v2.48.25 (E1): the browser-level session dies with the browser.
      if (this.browserCdpSession) {
        try { await this.browserCdpSession.detach(); } catch (e) {}
        this.browserCdpSession = null;
      }
      this.browser = null;
      this.page = null;
      this.cdpSession = null;
      this.browserDownloadDir = null;
    }
    // Audit fix #5: settings must be re-applied after every rotation / fresh
    // launch, so the configured flag never survives a browser close.
    this.hasConfiguredSettings = false;
    // v2.25.0: no live window survives a close — the next launch
    // re-decides shown/parked from its own plan.
    this.windowShown = false;
    this.captureArmed = false;
    if (this.capturedVideoBuffers) {
      this.capturedVideoBuffers.clear();
      this.capturedVideoBytes = 0;
    }
    this.capturedVideoUrls = [];
    if (this.claimedTileIndices) this.claimedTileIndices.clear();
    if (this.claimedTileFingerprints) this.claimedTileFingerprints.clear();
    if (this.consumedVideoUrls) this.consumedVideoUrls.clear();
    if (this._htmlPoisonGuard) this._htmlPoisonGuard.clear();
  }

  /**
   * This browser's main-process PID (the process that owns the
   * generation window), or null when it cannot be read.
   */
  _browserPid() {
    try {
      const proc = this.browser ? this.browser.process() : null;
      return proc ? proc.pid : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Taskbar button on/off for this engine's window (windowStyle):
   * parked windows carry NO taskbar button, shown windows carry
   * the normal one. Fire-and-forget — the styling is cosmetic OS
   * dressing and must never delay or fail generation work.
   */
  _applyTaskbarStyle(show) {
    if (this.headlessGeneration) return;
    const pid = this._browserPid();
    if (!pid) return;
    try {
      const p = windowStyle.setTaskbarButton(pid, show);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {}
  }

  /**
   * Move this engine's window to explicit bounds via a throwaway
   * CDP session (never this.cdpSession — see setBrowserWindowShown).
   * Pure movement: no shown-state change, no focus change.
   * Returns true when the bounds were applied.
   */
  async _setWindowBounds(bounds) {
    if (!this.browser || !this.page || this.page.isClosed()) return false;
    let session = null;
    try {
      session = await this.page.target().createCDPSession();
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', { windowId, bounds });
      return true;
    } catch (e) {
      this._lastWindowBoundsError = e;
      return false;
    } finally {
      if (session) {
        try { await session.detach(); } catch (e) {}
      }
    }
  }

  /**
   * Equal tiling (pool-driven): resize/reposition this engine's
   * SHOWN window to [bounds]. The pool owns the grid; the engine
   * only moves its own window. A parked or headless engine is
   * never tiled. Returns true when the bounds were applied.
   */
  async applyWindowBounds(bounds) {
    if (this.headlessGeneration) return false;
    if (!this.windowShown) return false;
    if (!bounds) return false;
    const ok = await this._setWindowBounds(bounds);
    if (!ok) {
      const name = this.currentAccount ? this.currentAccount.name : 'Account';
      this.log(`[${name}]'s browser window could not be resized into the shared layout.`, 'warn');
    }
    return ok;
  }

  /**
   * v2.25.0 — PARKED BROWSER Show/Hide (owner-approved design).
   *
   * Moves THIS engine's live generation window between its off-screen
   * park and the owner's screen via CDP Browser.setWindowBounds. Only
   * the window's position/size changes: the browser, the page and any
   * in-flight render are never touched, so showing or hiding can NOT
   * interrupt generation. A throwaway CDP session is used (never
   * this.cdpSession — the prompt-write chain owns that one and drops
   * it when it dies). Returns true when the bounds were applied.
   *
   * [shownBounds] (pool tiling): when showing, the exact bounds to
   * land on — the window's cell in the equal grid of shown windows.
   * Omitted, the window lands on the legacy single-window bounds.
   * Showing also restores the window's taskbar button and parking
   * removes it (windowStyle), so the app's button is the ONLY way
   * a generation window ever reaches the screen.
   */
  async setBrowserWindowShown(shown, shownBounds) {
    if (!this.browser || !this.page || this.page.isClosed()) return false;
    // Headless generation: this run has NO window at all — there is
    // nothing to show or park. Say so plainly and change nothing;
    // the run itself is never touched by the toggle either way.
    if (this.headlessGeneration) {
      const name = this.currentAccount ? this.currentAccount.name : 'Account';
      this.log(`[${name}] is generating in Headless mode — there is no browser window to show or hide in this run.`, 'info');
      return false;
    }
    const target = !!shown;
    try {
      const bounds = target
        ? (shownBounds || browserMode.parkedWindowBounds(true))
        : browserMode.parkedWindowBounds(false);
      const applied = await this._setWindowBounds(bounds);
      if (!applied) {
        const t = plainError.translateError(this._lastWindowBoundsError || new Error('window bounds failed'));
        this.log(`The browser window could not be ${target ? 'shown' : 'hidden'} — ${t.plain}.`, 'warn', { rawError: t.raw });
        return false;
      }
      if (target) {
        // Make this window the focused one on screen; harmless for a
        // parked window, and the page's focus emulation (background
        // mode) keeps its timers honest either way.
        try { await this.page.bringToFront(); } catch (e) {}
      }
      this.windowShown = target;
      this._applyTaskbarStyle(target);
      const name = this.currentAccount ? this.currentAccount.name : 'Account';
      this.log(target
        ? `[${name}]'s browser is now ON screen — generation continues.`
        : `[${name}]'s browser is parked off-screen again — generation continues.`, 'info');
      return true;
    } catch (e) {
      const t = plainError.translateError(e);
      this.log(`The browser window could not be ${target ? 'shown' : 'hidden'} — ${t.plain}.`, 'warn', { rawError: t.raw });
      return false;
    }
  }

  /**
   * v2.48.8: wait until Flow's page shows ANY usable signal (a
   * Google sign-in page, the landing button, the gallery, a
   * project, or the prompt box) instead of sleeping a fixed
   * number of seconds. The old fixed sleeps (4s after navigation,
   * 5s after the landing click, 2.5s after entering the canvas)
   * were paid IN FULL on every browser open — including every
   * mid-run account switch — even when the page was ready in one
   * second. Returns true when a signal was seen before the cap.
   */
  async _waitForFlowSignal(capMs) {
    const deadline = Date.now() + Math.max(0, capMs || 0);
    while (Date.now() < deadline) {
      if (!this.page || this.page.isClosed()) return false;
      try {
        if (this.page.url().includes('accounts.google.com')) return true;
        const seen = await this.page.evaluate(() => {
          if (window.location.pathname.includes('/project/')) return true;
          const btns = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
          if (btns.some(b => { const t = (b.innerText || ''); return t.includes('Create with Google Flow') || t.includes('Try in Google Flow') || t.toLowerCase().includes('new project'); })) return true;
          if (document.querySelector('a[href*="/project/"]')) return true;
          if (document.querySelector('.ProseMirror, div[contenteditable="true"], div[role="textbox"], flow-grid-tile-container')) return true;
          return false;
        });
        if (seen) return true;
      } catch (e) {}
      await sleep(400);
    }
    return false;
  }

  /**
   * Navigate into the Flow project canvas.
   * Returns 'READY' | 'NEED_LOGIN' | 'EXHAUSTED' | 'LOW_CREDITS'.
   */
  /**
   * v2.48.57 (PROJECT-TRUTH change 1): is waqt page jis
   * project me hai us ka saaf URL (…/project/<id> tak,
   * /edit/... hata kar — wahi kaat jo headless editor
   * wala raasta pehle se karta hai). Project me na ho
   * to ''.
   */
  currentProjectUrl() {
    try {
      const u = this.page && !this.page.isClosed() ? (this.page.url() || '') : '';
      if (u.includes('/project/')) return u.split('/edit/')[0];
    } catch (e) {}
    return '';
  }

  /**
   * v2.48.60 (PROJECT REGISTRY): page jis project me
   * hai, us (account, project) jodi ko registry me darj
   * karo — account wahi identity jo tasks
   * assigned_account_id me rakhti hain
   * (this.currentAccount.id). Ye kitab ENTRY ke pal
   * likhi jati hai, koi prompt submit hone se pehle —
   * run beech me mar bhi jaye to project ka record
   * mehfooz rehta hai aur recovery ko har baar saare
   * accounts nahi chaanne padte. [ROOT] wali line SIRF
   * nayi row par lagti hai (ledger ka isNew); dobara
   * entry par sirf last_seen_at aage badhta hai,
   * khaamoshi se. Koi bhi khata yahan run ko NAHI
   * rokta — try/catch me lipta, log-and-continue.
   */
  _registerCurrentProject(source) {
    try {
      const url = this.currentProjectUrl();
      const accountKey = this.currentAccount ? this.currentAccount.id : '';
      if (!url || !accountKey) return;
      const res = this.projectPort.recordSeen(accountKey, url, source);
      if (res && res.isNew) {
        const firstSeen = res.row && Number(res.row.firstSeenAt) > 0 ? Number(res.row.firstSeenAt) : Date.now();
        this.log(`[ROOT] project-registered account=${accountKey} id=${projectIdOfUrl(url)} at=${new Date(firstSeen).toISOString()} source=${source}`, 'info');
      }
    } catch (e) {}
  }

  /**
   * v2.48.57 (PROJECT-TRUTH changes 2+3): gallery se
   * project ke andar jana. Faisla khalis
   * galleryEntryDecision karta hai:
   *  - preferFresh (aam run): pehle New Project, warna
   *    pehla maujood link (bartav bilkul pehle jaisa).
   *  - 'existing' (recovery): SIRF maujood project —
   *    naya project KABHI nahi banta; date-time wala
   *    chunav (targetMs) pehle, warna pehla link.
   * Lautta hai { entered, source } — source sirf
   * recovery ke liye matlab rakhta hai
   * ('gallery-datetime' | 'gallery-first').
   */
  /**
   * v2.48.58 (change 2): gallery ke tiles asal me
   * render hone ka intezaar — kam az kam ek project
   * link YA New Project button dikhe tab tak, had
   * bounded (this.galleryWaitMs). ZEROCLICK26 ki
   * recovery entries me pehla attempt hamesha
   * 'none-found' par zaya hota tha kyunke us pal
   * gallery ke banners hi load ho rahe the, tiles
   * aayi hi nahi thin; doosra attempt ~10s baad
   * kaam karta tha. Lautta hai { links, waitedMs } —
   * links us pal ke project links ki ginti.
   */
  async _waitForGalleryTiles(timeoutMs) {
    const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : (this.galleryWaitMs || 15000);
    const poll = Number(this.galleryWaitPollMs) > 0 ? Number(this.galleryWaitPollMs) : 500;
    const started = Date.now();
    let links = 0;
    for (;;) {
      try {
        const probe = await this.page.evaluate(() => {
          const n = document.querySelectorAll('a[href*="/project/"]').length;
          const hasNew = !!document.querySelector('button.new-project-button') ||
            Array.from(document.querySelectorAll('button, div[role="button"]')).some(b => {
              const txt = (b.innerText || '').toLowerCase();
              const aria = (b.getAttribute('aria-label') || '').toLowerCase();
              return txt.includes('new project') || aria.includes('new project') || txt.includes('create project');
            });
          return { links: n, ready: n > 0 || hasNew };
        });
        links = probe && typeof probe.links === 'number' ? probe.links : 0;
        if (probe && probe.ready) break;
      } catch (e) {}
      if (Date.now() - started >= budget) break;
      await sleep(poll);
    }
    return { links, waitedMs: Date.now() - started };
  }

  async _enterProjectFromGallery(preferFresh, targetMs) {
    let source = null;
    let lastHref = null;
    // v2.48.58 (change 2): SIRF recovery entry pehle
    // gallery ke render ka intezaar karti hai — fresh
    // run ka bartav bilkul pehle jaisa.
    if (!preferFresh) {
      const gw = await this._waitForGalleryTiles(this.galleryWaitMs || 15000);
      this.log(`[ROOT] gallery-wait links=${gw.links} waited=${gw.waitedMs}`, 'info');
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      let survey = null;
      try {
        survey = await this.page.evaluate(() => {
          const newBtn = document.querySelector('button.new-project-button') ||
            Array.from(document.querySelectorAll('button, div[role="button"]')).find(b => {
              const txt = (b.innerText || '').toLowerCase();
              const aria = (b.getAttribute('aria-label') || '').toLowerCase();
              return txt.includes('new project') || aria.includes('new project') || txt.includes('create project');
            });
          const links = Array.from(document.querySelectorAll('a[href*="/project/"]')).map(a => {
            let text = a.innerText || '';
            let node = a;
            for (let i = 0; i < 4 && node; i++) {
              node = node.parentElement || node.parentNode || null;
              if (node && node.innerText && /[A-Za-z]{3}\s+\d{1,2}/.test(node.innerText)) { text = node.innerText; break; }
            }
            return { href: a.getAttribute('href') || '', text: String(text).slice(0, 200) };
          });
          return { hasNewBtn: !!newBtn, links };
        });
      } catch (e) { survey = null; }
      if (!survey || typeof survey !== 'object') survey = { hasNewBtn: false, links: [] };
      let decision = galleryEntryDecision(survey, preferFresh, targetMs, Date.now());
      // v2.48.70 (ITEM B): RECOVERY entry par gallery-first
      // andaza khatam — date-time se chuna hua project hi
      // khulega; andaza lage to entry 'none' (rows parked
      // rehte hain, galat project kabhi nahi khulta).
      if (!preferFresh) {
        const guarded = recoveryGalleryGuard(decision, targetMs);
        if (guarded !== decision) {
          this.log('[ROOT] recovery-entry gallery-first guess refused (v2.48.70) — only a date-time matched project may be opened', 'warn');
        }
        decision = guarded;
      }
      if (decision.source) source = decision.source;
      // v2.48.62 (GALLERY ENTRY LOG): fresh run ka faisla
      // maujooda project par gir jaye to wo sach log me
      // NAAM se aaye — pehle ye fallback bilkul khamosh
      // tha aur kisi ko pata nahi chalta tha ke naya
      // project khula ya purana (zc27 teapot wala sawal).
      if (preferFresh && decision.kind === 'link') {
        this.log(`[ROOT] gallery-entry fresh-fallback index=${decision.index} source=${decision.source || '-'}`, 'info');
      }
      if (decision.kind === 'link' && survey.links[decision.index]) lastHref = survey.links[decision.index].href;
      let actionResult = 'none-found';
      if (decision.kind !== 'none') {
        try {
          const clicked = await this.page.evaluate((args) => {
            if (args.kind === 'new') {
              const b = document.querySelector('button.new-project-button') ||
                Array.from(document.querySelectorAll('button, div[role="button"]')).find(x => {
                  const txt = (x.innerText || '').toLowerCase();
                  const aria = (x.getAttribute('aria-label') || '').toLowerCase();
                  return txt.includes('new project') || aria.includes('new project') || txt.includes('create project');
                });
              if (b) { b.click(); return true; }
              return false;
            }
            const links = Array.from(document.querySelectorAll('a[href*="/project/"]'));
            const a = links[args.index];
            if (a) { a.click(); return true; }
            return false;
          }, { kind: decision.kind, index: decision.index });
          if (clicked) actionResult = decision.kind === 'new' ? 'clicked-new-project-button' : 'clicked-existing-project-link';
        } catch (e) {}
      }
      // v2.48.62 (GALLERY ENTRY LOG): line ab ASAL action
      // bolti hai — New Project par click hua ya maujooda
      // project ke link par, aur kis source se. Pehle dono
      // surat me ek hi dhundli si line chhapti thi, jis se
      // fresh-fallback nazar hi nahi aata tha.
      if (actionResult === 'none-found') {
        this.log(`Attempt ${attempt}/3 to enter the project — no New Project button or project link was found`, 'info');
      } else {
        this.log(`Attempt ${attempt}/3 to enter the project — clicked (action=${actionResult} source=${decision.source || '-'})`, 'info');
      }
      let entered = false;
      for (let w = 0; w < 10; w++) {
        await sleep(this.galleryEntryPollMs || 1000);
        if (this.page.url().includes('/project/')) { entered = true; break; }
      }
      if (entered) return { entered: true, source };
      if (lastHref) {
        const fullUrl = lastHref.startsWith('http') ? lastHref : `https://flow.google.com${lastHref}`;
        this.log('Going in directly via the project link…', 'info');
        try {
          await this.page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await this._waitForFlowSignal(3000);
          if (this.page.url().includes('/project/')) return { entered: true, source };
        } catch (e) {}
      }
    }
    return { entered: false, source };
  }

  async openFlowStudio(settings = {}) {
    this.currentSettings = settings;
    const url = 'https://flow.google.com/';
    this.log(`Opening Flow: ${url}`, 'info');

    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      await this.page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    // v2.48.8: proceed the moment the page shows anything usable
    // (was a blind 4-second sleep on every open).
    await this._waitForFlowSignal(6000);

    // 1. Landing page -> enter the app
    const clickedLanding = await this.page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
      const createBtn = btns.find(b => {
        const txt = (b.innerText || '').trim();
        return txt.includes('Create with Google Flow') || txt.includes('Try in Google Flow');
      });
      if (createBtn) {
        createBtn.click();
        return true;
      }
      return false;
    });

    if (clickedLanding) {
      this.log('Clicked "Create with Google Flow" — the canvas (work area) is opening…', 'info');
      // v2.48.8: proceed as soon as the gallery/project appears
      // (was a blind 5-second sleep).
      await this._waitForFlowSignal(5000);
    }

    // 2. Google Account login check — an explicit signin URL is the only
    // signal allowed to mark the account 'Need Login' (audit fix #3), and
    // even then the credit service preserves the last known balance.
    if (this.page.url().includes('accounts.google.com')) {
      this.log(`[${this.currentAccount ? this.currentAccount.name : 'Account'}] needs a Google login — the account is not signed in.`, 'warn');
      if (!this.headless && !this.headlessGeneration) {
        for (let i = 0; i < 10; i++) {
          await sleep(3000);
          if (!this.page.url().includes('accounts.google.com')) {
            this.log('Login found — moving towards the Flow studio…', 'success');
            break;
          }
        }
      }
      if (this.page.url().includes('accounts.google.com')) {
        this.creditPort.signOut(this.currentAccount ? this.currentAccount.id : null);
        return 'NEED_LOGIN';
      }
    }

    // 3. Projects gallery -> project canvas
    const preferFreshCanvas = settings.canvasStrategy !== 'existing';
    // v2.48.57 (PROJECT-TRUTH change 2): recovery ke paas
    // task ka RECORDED project URL ho to gallery me ghusna
    // hi nahi — seedha usi project par jao aur project id
    // verify karo. Wo project na khule to saaf error —
    // gallery/new-project ki taraf girna KABHI nahi
    // (video sirf usi project me hai; ghalat project me
    // dhoondhna hi ZEROCLICK25 wali galti thi).
    const recordedProjectUrl = typeof settings.projectUrl === 'string' ? settings.projectUrl.trim() : '';
    if (recordedProjectUrl) {
      const wantId = projectIdOfUrl(recordedProjectUrl);
      if (!wantId || !this.page.url().includes(`/project/${wantId}`)) {
        try { await this.page.goto(recordedProjectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) {}
        await this._waitForFlowSignal(5000);
      }
      if (wantId && this.page.url().includes(`/project/${wantId}`)) {
        // v2.48.60 (PROJECT REGISTRY): URL task par
        // darj tha to 'recorded'; pool ne registry se
        // chuna tha (projectUrlSource='registry') to
        // 'registry' — raasta ek hi (seedha goto +
        // id verify), pehchan ka zariya alag darj
        // hota hai.
        const entrySource = settings.projectUrlSource === 'registry' ? 'registry' : 'recorded';
        this.log(`[ROOT] recovery-project url=${recordedProjectUrl} source=${entrySource}`, 'info');
      } else {
        throw new Error(`The recorded Flow project could not be opened (${recordedProjectUrl}) — recovery keeps its tasks pending for a later Resume.`);
      }
    }
    if (!this.page.url().includes('/project/')) {
      this.currentStage = 'Entering Project Canvas';
      this.log('Going into the Flow project from the gallery…', 'info');

      // v2.48.57 (PROJECT-TRUTH changes 2+3): gallery
      // entry ab _enterProjectFromGallery me hai —
      // 'existing' (recovery) naya project KABHI nahi
      // banata; date-time wala chunav (recorded URL na
      // ho to) recoveryTargetTime se hota hai.
      const recoveryTargetMs = preferFreshCanvas ? 0
        : (Number(settings.recoveryTargetTime) || Date.parse(settings.recoveryTargetTime || '') || 0);
      const entry = await this._enterProjectFromGallery(preferFreshCanvas, recoveryTargetMs);

      if (!this.page.url().includes('/project/')) {
        throw new Error(`Could not enter Google Flow project canvas. Page remained on ${this.page.url()}. Ensure the account has accepted Google Flow terms and can create projects.`);
      }

      this.log('The Flow project is open — now at the work area.', 'success');
      if (!preferFreshCanvas) {
        this.log(`[ROOT] recovery-project url=${this.currentProjectUrl()} source=${entry.source || 'gallery-first'}`, 'info');
      }
      // v2.48.8: proceed as soon as tiles or the prompt box are
      // actually there (was a blind 2.5-second sleep).
      try {
        await this.page.waitForSelector('flow-grid-tile-container, .ProseMirror, div[contenteditable="true"]', { timeout: 2500 });
      } catch (e) {}
    }

    // v2.48.60 (PROJECT REGISTRY): page ab project me
    // hai — teeno entry raaste (recorded/registry wala
    // seedha goto, gallery entry, ya pehle se khula
    // project) yahin milte hain. Is jodi ko registry me
    // ENTRY ke pal darj karo, credit gate aur kisi bhi
    // prompt se PEHLE: fresh run = 'fresh-entry',
    // recovery ('existing') = 'recovery-entry'. Run
    // yahan se aage kahin bhi mare, record reh jayega.
    this._registerCurrentProject(preferFreshCanvas ? 'fresh-entry' : 'recovery-entry');

    // Dismiss tutorial/welcome overlay and clean up stale failed tiles
    try {
      await this.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const dismissBtn = btns.find(b => {
          const txt = (b.innerText || '').trim().toLowerCase();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          return txt === 'got it' || txt.includes('got it') || txt === 'get started' || aria.includes('dismiss');
        });
        if (dismissBtn) dismissBtn.click();

        const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
        containers.forEach(c => {
          const txt = (c.innerText || '').toLowerCase();
          if (txt.includes('unusual activity') || txt.includes('failed to generate')) {
            const trash = c.querySelector('button[aria-label*="delete" i], button[aria-label*="trash" i], button[aria-label*="remove" i]');
            if (trash) {
              try { trash.click(); } catch (e) {}
            }
          }
        });
      });
    } catch (e) {}

    // 4. Live credit pre-check — all writes go through the credit port.
    // v2.48.58 (RECOVERY-NO-CREDIT-GATE): download-only
    // recovery (settings.downloadOnly — ye jhanda SIRF
    // workerPool ki recovery ghadi lagati hai) koi
    // credit NAHI kharch karti: video pehle hi ban
    // chuki hai aur us ka paisa kat chuka hai. Is liye
    // wahan balance sirf RECORD hota hai, gate NAHI
    // banta — ZEROCLICK26 me account (22) ke paas sirf
    // 2 credits bache the aur us ki poori recovery
    // (10 parked tasks) LOW_CREDITS par ruk gayi thi,
    // halanke download par ek bhi credit nahi lagna
    // tha. Fresh generation ka gate bilkul pehle
    // jaisa hi rehta hai.
    const downloadOnly = !!(settings && settings.downloadOnly);
    const required = this.getRequiredCredits(settings || this.currentSettings);
    const accId = this.currentAccount ? this.currentAccount.id : null;
    // v1.9.0: name via a guarded local — currentAccount is set by the
    // launch path in every pool flow, but this public method must never
    // die with a misleading TypeError if it is ever absent.
    const accName = this.currentAccount ? this.currentAccount.name : 'Account';
    const liveCredits = await this.readLiveCreditsFromPage();
    if (typeof liveCredits === 'number') {
      this.creditPort.liveBalance(accId, liveCredits);
      if (this.currentAccount) this.currentAccount.credits = liveCredits;
      if (downloadOnly) {
        // v2.48.58: recovery me balance kitna bhi ho
        // (0 bhi), entry rukti NAHI — neeche wali dono
        // gate-shaklein skip; balance upar record ho
        // chuka hai.
        this.log(`[ROOT] recovery-credit-gate bypassed balance=${liveCredits} (download-only, no credits needed)`, 'info');
        this.log(`[${accName}] has ${liveCredits} credits — download-only recovery needs no credits; continuing.`, 'success');
      } else if (liveCredits === 0) {
        this.log(`[${accName}] has 0 credits — no video will be made from this account; moving to the next account.`, 'warn');
        return 'EXHAUSTED';
      } else if (required > 0 && liveCredits < required) {
        // Audit fix #2: low balance is a skip reason, NOT exhaustion.
        this.creditPort.lowCredits(accId, required);
        this.log(`[${accName}] has only ${liveCredits} credits; one video needs ~${required} — skipping this account for this run.`, 'warn');
        return 'LOW_CREDITS';
      } else {
        this.log(`[${accName}] has ${liveCredits} credits (one video ≈ ${required} credits).`, 'success');
      }
    } else {
      // Audit fix #3: an inconclusive read changes nothing.
      this.creditPort.ambiguous(accId);
      const known = Number(this.currentAccount ? this.currentAccount.credits : NaN);
      if (downloadOnly) {
        this.log(`[ROOT] recovery-credit-gate bypassed balance=${isNaN(known) ? 'unknown' : known} (download-only, no credits needed)`, 'info');
      } else if (!isNaN(known) && required > 0 && known < required) {
        this.creditPort.lowCredits(accId, required);
        this.log(`[${accName}]'s last known balance is ${known} credits, which is less than the needed ~${required} — skipping this account.`, 'warn');
        return 'LOW_CREDITS';
      }
    }

    this.log('Waiting for Flow\'s prompt box (prompt bar) to appear — the workspace is getting ready…', 'info');
    try {
      await this.page.waitForSelector('.ProseMirror, div[contenteditable="true"], div[role="textbox"], textarea', { timeout: 30000 });
      this.log('The Flow workspace is ready — prompts can be sent.', 'success');
    } catch (e) {}

    await this.ensureAgentModeDisabled();

    // v2.48.8: the workspace is already proven ready above — only
    // a short settle remains (was a blind 1.2-second sleep).
    await sleep(300);
    return 'READY';
  }

  // UNIVERSAL POPUP / OVERLAY AUTO-DISMISSER
  async dismissAnyBlockingOverlays() {
    if (!this.page || this.page.isClosed()) return false;
    try {
      const dismissed = await this.page.evaluate(() => {
        let actionTaken = false;

        const candidateButtons = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"], span[role="button"]'));
        const dismissKeywords = [
          'got it', 'get started', 'dismiss', 'i understand', 'close', 'accept all',
          'accept', 'agree', 'ok', 'okay', 'skip', 'continue', 'not now', 'no thanks',
          'maybe later', 'done', 'explore', 'understood'
        ];

        for (const btn of candidateButtons) {
          const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();

          if (text.includes('generate') || aria.includes('generate') || text.includes('new project') || text.includes('create')) {
            continue;
          }

          const matches = dismissKeywords.some(kw => text === kw || aria === kw || text.startsWith(kw) || aria.startsWith(kw));
          if (matches) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              btn.click();
              actionTaken = true;
            }
          }
        }

        const closeIconBtns = Array.from(document.querySelectorAll(
          'div[role="dialog"] button[aria-label*="close" i], ' +
          'div[role="dialog"] button[aria-label*="dismiss" i], ' +
          'mat-dialog-container button[aria-label*="close" i], ' +
          '.cdk-overlay-pane button[aria-label*="close" i], ' +
          '[class*="banner"] button[aria-label*="close" i], ' +
          '[class*="toast"] button[aria-label*="close" i], ' +
          '[class*="snackbar"] button[aria-label*="close" i]'
        ));
        for (const cBtn of closeIconBtns) {
          try { cBtn.click(); actionTaken = true; } catch (e) {}
        }

        const orphanBackdrops = document.querySelectorAll('.cdk-overlay-backdrop-showing, .modal-backdrop.show');
        if (orphanBackdrops.length > 0 && !document.querySelector('div[role="dialog"], mat-dialog-container')) {
          orphanBackdrops.forEach(b => b.remove());
          actionTaken = true;
        }

        return actionTaken;
      });

      if (dismissed) {
        this.log('A blocking banner/overlay that appeared on Flow was removed automatically.', 'info');
        await sleep(250);
      }
      return dismissed;
    } catch (e) {
      return false;
    }
  }

  // MODEL, RESOLUTION & DURATION AWARE REQUIRED CREDITS CALCULATOR
  // Real rates only — the owner's own Flow panel screenshots,
  // 2026-10-27 (CREDIT-RATES-REAL-2026-10-27.md); the same table
  // the app shows in lib/services/credit_costs.dart.
  // v2.48.59: Omni Flash 1.2 PER-SECOND hai (Google Flow
  // support page, verified 2026-11-06 —
  // CREDIT-RATES-OMNI-1.2-2026-11-06.md): 360p 1/sec
  // (sec 1–10) phir 2/sec (sec 11–15); 720p 3/sec phir
  // 6/sec. Formula omni12CreditsPerVideo me hai.
  getRequiredCredits(settings) {
    if (!settings || settings.type === 'Image') {
      return 0;
    }

    const duration = (settings.duration || '6s').toLowerCase().replace('s', '').trim();
    const model = (settings.model || '').toLowerCase();
    // The generation resolution follows the Quality setting:
    // '360p' generates at 360p, '720p' at 720p, and '1080p' at
    // 720p (1080p is an enhanced DOWNLOAD of a 720p generation —
    // Flow has no 1080p generation). The real cost of a video
    // depends on this resolution, so the Omni table below is
    // keyed by it.
    const quality = (settings.quality || '360p').toLowerCase();
    const genRes = (quality.includes('720') || quality.includes('1080')) ? '720p' : '360p';
    // v2.4.0: Outputs is LOCKED to x1 (owner's order — the x2/x3/x4
    // select is gone from the UI; nobody re-renders one prompt into
    // several videos from that option). A settings_json saved by an
    // older version may still carry outputsCount > 1 — it is read as
    // x1 here, quietly, everywhere credits are computed.
    const outputsCount = 1;
    let creditsPerOutput;

    if (model.includes('quality')) {
      // Veo rates are FLAT per video: a Veo video is always 8s —
      // Flow offers no Veo duration choice — at 720p.
      creditsPerOutput = 100;
    } else if (model.includes('fast')) {
      creditsPerOutput = 20;
    } else if (model.includes('lite')) {
      creditsPerOutput = 10;
    } else if ((model.includes('omni') || model.includes('flash')) && model.includes('1.2')) {
      // v2.48.59: Omni Flash 1.2 — per-second billing
      // (upar wala note). Ye shakha generic Omni shakha
      // se PEHLE aati hai: 'omni 1.2 flash' bhi aam
      // omni/flash check me phansta tha aur use 1.1 ki
      // flat table mil jati (15s par ghalat '5').
      creditsPerOutput = omni12CreditsPerVideo(parseInt(duration, 10), genRes);
    } else if (model.includes('omni') || model.includes('flash')) {
      // Real Omni rates (owner's panel screenshots, 2026-10-27),
      // keyed by the generation resolution above. The old
      // premiumMode split is GONE: its "premium" row (7/10/12/15)
      // was never a mode price — it was the 720p row — and the
      // "1 credit/second" plain row (4/6/8/10) matched nothing
      // real beyond a single 4s datapoint. The evidenced rates
      // are Ingredients-mode; the same table now applies to every
      // Omni mode — text mode beyond the old 4s=4 datapoint
      // follows this table too, until live evidence says
      // otherwise.
      if (genRes === '720p') {
        if (duration === '4') creditsPerOutput = 7;
        else if (duration === '6') creditsPerOutput = 10;
        else if (duration === '8') creditsPerOutput = 12;
        else if (duration === '10') creditsPerOutput = 15;
        else creditsPerOutput = 10;
      } else {
        if (duration === '4') creditsPerOutput = 4;
        else if (duration === '6') creditsPerOutput = 5;
        else if (duration === '8') creditsPerOutput = 6;
        else if (duration === '10') creditsPerOutput = 7;
        else creditsPerOutput = 5;
      }
    } else if (settings.videoMode === 'Ingredients' || settings.referenceImage || settings.videoMode === 'Frames' || settings.startFrame || settings.endFrame) {
      creditsPerOutput = 20;
    } else {
      creditsPerOutput = 10;
    }

    return creditsPerOutput * outputsCount;
  }

  // READ REAL-TIME CREDITS DIRECTLY FROM GOOGLE FLOW PAGE / SESSION
  // Returns a number, or null when the page cannot confirm a balance.
  async readLiveCreditsFromPage() {
    if (!this.page || this.page.isClosed()) return null;
    try {
      // v2.44.0 (owner's live test 2026-10-29): the OLD order checked
      // the "exhausted banner" FIRST and returned 0 if a
      // '.prompt-warning-button' existed ANYWHERE on the page. That
      // button is not a credits signal — it also appears for unrelated
      // prompt/tile warnings — so every studio open read "0 credits",
      // openFlowStudio returned EXHAUSTED, both accounts were retired
      // before any prompt was submitted, and runs died in seconds
      // with 0 saved (while the real balance was 50). New order:
      // scrape the actual NUMBER first and trust it whenever found
      // (a real "0 credits" text still returns a real 0); only when
      // NO number can be read may credit-specific banner TEXT (never
      // the warning button alone) stand in for a zero.
      const liveCredits = await this.page.evaluate(async () => {
        const targetBtn = document.querySelector('.header-user-button, [aria-label*="Account details" i], [aria-label*="account" i], [aria-label*="Google Account" i], .gb_C');
        if (targetBtn) {
          try {
            targetBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            const panel = document.querySelector('flow-account-panel, [role="dialog"], div[class*="account-panel"], div[class*="profile-menu"]');
            if (panel) {
              const text = panel.innerText || panel.textContent || '';
              const match = text.match(/([\d,]+)\s*(?:Google\s*Flow\s*)?credits/i) || text.match(/credits?:\s*([\d,]+)/i) || text.match(/([\d,]+)\s*cr\b/i);
              const closeBtn = panel.querySelector('.close-btn, button[aria-label*="Close" i]');
              if (closeBtn) {
                closeBtn.click();
              } else if (targetBtn) {
                targetBtn.click();
              }
              if (match) return parseInt(match[1].replace(/,/g, ''), 10);
            }
          } catch (e) {}
        }

        const chips = Array.from(document.querySelectorAll('flow-user-tier-chip'));
        for (const el of chips) {
          const txt = (el.innerText || el.textContent || '').trim();
          const m = txt.match(/^([\d,]{1,7})\s*(?:credits?|cr)$/i) || txt.match(/([\d,]{1,7})\s*(?:Google\s*Flow\s*)?credits?/i);
          if (m) return parseInt(m[1].replace(/,/g, ''), 10);
          const aria = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
          const am = aria.match(/([\d,]{1,7})\s*(?:remaining\s*)?credits?/i);
          if (am) return parseInt(am[1].replace(/,/g, ''), 10);
        }

        return null;
      });
      if (typeof liveCredits === 'number') {
        return liveCredits;
      }

      // No number could be read. Only credit-specific banner TEXT may
      // stand in for a zero — the '.prompt-warning-button' element on
      // its own must never do so again (v2.44.0 note above).
      const isExhaustedBanner = await this.page.evaluate(() => {
        const banner = document.querySelector('.credit-banner-error');
        const bodyText = document.body ? (document.body.innerText || '') : '';
        return !!(banner || bodyText.includes('out of Google Flow credits') || bodyText.includes('Insufficient credits'));
      });
      if (isExhaustedBanner) {
        return 0;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Detects Flow's own out-of-credits state for the current settings.
   * Returns 'EXHAUSTED' | 'LOW_CREDITS' | 'OK'. A page banner routes through
   * creditPort.exhaustionBanner (one of only two zeroing paths, fix #2);
   * a merely-insufficient balance routes through creditPort.lowCredits and
   * keeps the real balance intact.
   */
  async checkCreditsState(settings) {
    try {
      if (settings && settings.type === 'Image') return 'OK';
      if (!this.page || this.page.isClosed()) return 'OK';

      const isExhaustedOnPage = await this.page.evaluate(() => {
        const pageText = (document.body.innerText || '').toLowerCase();
        return (
          pageText.includes('insufficient credits') ||
          pageText.includes('out of credits') ||
          pageText.includes('no credits remaining') ||
          pageText.includes('reached your generation limit') ||
          pageText.includes('daily limit reached')
        );
      });

      const accId = this.currentAccount ? this.currentAccount.id : null;
      if (isExhaustedOnPage) {
        this.creditPort.exhaustionBanner(accId);
        if (this.currentAccount) this.currentAccount.credits = 0;
        return 'EXHAUSTED';
      }

      const requiredCredits = this.getRequiredCredits(settings);
      const live = await this.readLiveCreditsFromPage();
      if (typeof live === 'number') {
        this.creditPort.liveBalance(accId, live);
        if (this.currentAccount) this.currentAccount.credits = live;
        if (live === 0) return 'EXHAUSTED';
        if (requiredCredits > 0 && live < requiredCredits) {
          this.creditPort.lowCredits(accId, requiredCredits);
          return 'LOW_CREDITS';
        }
        return 'OK';
      }

      const accCredits = Number(this.currentAccount ? this.currentAccount.credits : NaN);
      if (!isNaN(accCredits) && requiredCredits > 0 && accCredits < requiredCredits) {
        this.creditPort.lowCredits(accId, requiredCredits);
        return 'LOW_CREDITS';
      }

      return 'OK';
    } catch (e) {
      return 'OK';
    }
  }

  // AUTO-DETECT & DISABLE GOOGLE FLOW "AGENT MODE" CHIP
  async ensureAgentModeDisabled() {
    if (!this.page || this.page.isClosed()) return false;
    try {
      const toggled = await this.page.evaluate(() => {
        const chip = document.querySelector('.agent-mode-chip, button.agent-mode-chip') ||
          Array.from(document.querySelectorAll('button')).find(b => {
            const txt = (b.innerText || '').trim().toLowerCase();
            return txt === 'agent' && (b.className.includes('checked') || b.className.includes('active') || b.getAttribute('aria-pressed') === 'true');
          });

        if (chip && (chip.className.includes('checked') || chip.className.includes('active') || chip.getAttribute('aria-pressed') === 'true')) {
          chip.click();
          return true;
        }
        return false;
      });

      if (toggled) {
        this.log('Flow\'s "Agent Mode" was ON — it has been turned OFF for direct video generation.', 'info');
        await sleep(1000);
      }
      return toggled;
    } catch (e) {
      return false;
    }
  }

  // ATOMIC NATIVE TEXT INSERTION (bypasses keydown triggers for @ mentions / search hijacking)
  async insertNativeText(text) {
    const cleanText = (text || '').replace(/[\r\n]+/g, ' ').trim();
    if (!cleanText) return;

    if (!this.cdpSession && this.page) {
      try {
        this.cdpSession = await this.page.target().createCDPSession();
      } catch (e) {}
    }

    try {
      await this.page.evaluate(() => {
        const searchInput = document.querySelector('input.search-input, input[aria-label*="search" i]');
        if (searchInput && (searchInput.value || document.activeElement === searchInput)) {
          searchInput.value = '';
          searchInput.blur();
        }
        const editor = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
        if (editor) {
          editor.focus();
        }
      });
    } catch (e) {}

    if (this.cdpSession) {
      try {
        await this.cdpSession.send('Input.insertText', { text: cleanText });
        return;
      } catch (e) {
        // v2.24.1: a failed send can mean the CDP session died with an
        // earlier navigation/target change. Drop it so the next method
        // recreates a live one instead of reusing a dead session and
        // silently failing every later insertText in this submission.
        this.cdpSession = null;
        const t = plainError.translateError(e);
        this.log(`A problem came up in the first method of writing the prompt — ${t.plain}. Trying the second method…`, 'warn', { rawError: t.raw });
      }
    }

    const execSuccess = await this.page.evaluate((str) => {
      const editor = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
      if (editor) {
        editor.focus();
        return document.execCommand('insertText', false, str);
      }
      return false;
    }, cleanText);

    if (!execSuccess) {
      await this.page.keyboard.type(cleanText, { delay: 10 });
    }
  }

  // v2.24.1: REAL CLIPBOARD PASTE — the one input path the write chain
  // never tried. Flow's ProseMirror editor is built around paste: a
  // trusted Ctrl+V delivers a genuine paste event carrying clipboard
  // data, which the editor accepts even when CDP insertText,
  // execCommand and synthetic typing are silently dropped (the failure
  // the owner hit on 2026-10-23: every setting applied, the browser
  // reached the prompt step, and no write method landed). Returns true
  // when the paste keys were sent; the caller verifies the DOM text.
  async pastePromptViaClipboard(text) {
    const cleanText = (text || '').replace(/[\r\n]+/g, ' ').trim();
    if (!cleanText || !this.page || this.page.isClosed()) return false;
    try { await this.page.bringToFront(); } catch (e) {}

    // Clipboard permission for the Flow origins (browser-level CDP —
    // without it navigator.clipboard.writeText rejects in Chrome).
    try {
      const browserSession = await this.page.browser().target().createCDPSession();
      for (const origin of ['https://labs.google', 'https://flow.google.com']) {
        try {
          await browserSession.send('Browser.grantPermissions', {
            origin,
            permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
          });
        } catch (e) {}
      }
      try { await browserSession.detach(); } catch (e) {}
    } catch (e) {}

    // Focus the ranked editor with a real mouse click first — the
    // clipboard write needs a focused document, and the paste must
    // land in the editor, not wherever focus happened to be.
    const coords = await this.page.evaluate(() => {
      const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
      if (!el) return null;
      try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
      const r = el.getBoundingClientRect();
      return { x: r.x + Math.min(25, r.width / 4), y: r.y + r.height / 2 };
    }).catch(() => null);
    if (coords) {
      await this.page.mouse.click(coords.x, coords.y);
      await sleep(200);
    }

    const copied = await this.page.evaluate(async (t) => {
      try {
        await navigator.clipboard.writeText(t);
        return true;
      } catch (e) {
        try {
          const ta = document.createElement('textarea');
          ta.value = t;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          return !!ok;
        } catch (e2) { return false; }
      }
    }, cleanText).catch(() => false);
    if (!copied) {
      this.log('Clipboard paste: the prompt could not be copied to the clipboard — moving to the next write method…', 'warn');
      return false;
    }

    await this.page.keyboard.down('Control');
    await this.page.keyboard.press('A');
    await this.page.keyboard.up('Control');
    await this.page.keyboard.down('Control');
    await this.page.keyboard.press('V');
    await this.page.keyboard.up('Control');
    await sleep(300);
    return true;
  }

  // CONFIGURE GENERATION SETTINGS (exact Google Flow UI synchronization)
  async configureGenerationSettings(settings, isRetry = false) {
    try {
      await this.ensureAgentModeDisabled();
      await sleep(1000);

      const modeType = settings.type || 'Video';
      const videoMode = settings.videoMode || 'Text';
      // The generation resolution follows the Quality setting:
      // 360p→360p, 720p→720p, 1080p→720p (1080p is an enhanced
      // DOWNLOAD of a 720p generation — Flow's panel has no
      // 1080p generation button).
      const qualitySetting = (settings.quality || '360p').toLowerCase();
      const genResolution = (qualitySetting.includes('720') || qualitySetting.includes('1080')) ? '720p' : '360p';
      this.log(`Applying Flow settings: Mode=${modeType} | Type=${videoMode} | Model=${settings.model || 'Omni Flash'} | Duration=${settings.duration || '6s'} | Size=${settings.aspectRatio || '9:16'} | Resolution=${genResolution} | Outputs=x1…`, 'info');

      if (videoMode === 'Text') {
        await this.page.evaluate(() => {
          const removeBtns = Array.from(document.querySelectorAll('button')).filter(b => {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            const txt = (b.innerText || '').toLowerCase();
            return aria.includes('remove') || txt.includes('close') || aria.includes('close');
          });
          removeBtns.forEach(b => b.click());
        });
      }

      // 1. Locate and open the Config Pill in the Flow prompt bar
      let pillInfo = await this.page.evaluate(() => {
        const pill = document.querySelector('.settings-trigger-button, button.settings-trigger-button') ||
          Array.from(document.querySelectorAll('button')).find(b => {
            const txt = (b.innerText || '').toLowerCase();
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            return aria.includes('settings trigger') || txt.includes('banana') || txt.includes('veo') || txt.includes('video') || txt.includes('image');
          });

        if (pill) {
          const r = pill.getBoundingClientRect();
          return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, text: pill.innerText };
        }
        return { found: false };
      });

      if (!pillInfo.found) {
        await this.ensureAgentModeDisabled();
        await sleep(800);
        pillInfo = await this.page.evaluate(() => {
          const pill = document.querySelector('.settings-trigger-button, button.settings-trigger-button') ||
            Array.from(document.querySelectorAll('button')).find(b => {
              const txt = (b.innerText || '').toLowerCase();
              const aria = (b.getAttribute('aria-label') || '').toLowerCase();
              return aria.includes('settings trigger') || txt.includes('banana') || txt.includes('veo') || txt.includes('video') || txt.includes('image');
            });
          if (pill) {
            const r = pill.getBoundingClientRect();
            return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, text: pill.innerText };
          }
          return { found: false };
        });
      }

      if (pillInfo.found) {
        this.log(`Clicking Flow's settings pill: "${pillInfo.text.replace(/\n/g, ' ')}"...`, 'info');
        await this.page.mouse.click(pillInfo.x, pillInfo.y);
        await sleep(1000);

        // 2. Select Video vs Image mode inside the settings popover
        this.log(`Changing the mode: [${modeType}]…`, 'info');
        const modeClicked = await this.page.evaluate((targetMode) => {
          const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
          const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
          const m = targetMode.toLowerCase();
          const targetBtn = btns.find(b => {
            const txt = (b.innerText || '').toLowerCase();
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            if (m === 'video') {
              return (txt.includes('video') && !txt.includes('image')) || aria === 'video';
            } else {
              return (txt.includes('image') && !txt.includes('video')) || aria === 'image';
            }
          });

          if (targetBtn) {
            targetBtn.click();
            const r = targetBtn.getBoundingClientRect();
            return { clicked: true, text: targetBtn.innerText, x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
          return { clicked: false };
        }, modeType);

        if (modeClicked.clicked) {
          if (modeClicked.x && modeClicked.y) {
            await this.page.mouse.click(modeClicked.x, modeClicked.y);
          }
          await sleep(800);
        }

        // 3. Select Video Sub-mode (Text vs Ingredients vs Frames)
        if (modeType === 'Video') {
          if (videoMode === 'Ingredients') {
            this.log('Selecting the sub-mode: [Ingredients]…', 'info');
            await this.page.evaluate(() => {
              const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
              const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
              const b = btns.find(btn => (btn.innerText || '').toLowerCase().includes('ingredient'));
              if (b) b.click();
            });
            await sleep(350);
          } else if (videoMode === 'Frames') {
            this.log('Selecting the sub-mode: [Frames]…', 'info');
            await this.page.evaluate(() => {
              const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
              const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
              const b = btns.find(btn => (btn.innerText || '').toLowerCase().includes('frame'));
              if (b) b.click();
            });
            await sleep(350);
          } else {
            await this.page.evaluate(() => {
              const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
              const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
              const btnFrames = btns.find(b => (b.innerText || '').trim().toLowerCase().includes('frames'));
              const btnIngredients = btns.find(b => (b.innerText || '').trim().toLowerCase().includes('ingredients'));
              if (btnFrames && (btnFrames.getAttribute('data-state') === 'on' || btnFrames.className.includes('active'))) btnFrames.click();
              if (btnIngredients && (btnIngredients.getAttribute('data-state') === 'on' || btnIngredients.className.includes('active'))) btnIngredients.click();
            });
            await sleep(200);
          }
        }

        // 3.5 Select AI Model FIRST among the value controls (v1.6.2: changing the model makes Flow reset the duration to that model's default — setting duration before the model is how a 6s request silently became 8s)
        if (settings.model) {
          this.log(`Selecting the AI Model: [${settings.model}]…`, 'info');
          // v2.48.59 (OMNI 1.2 FLASH): chunav ka faisla ab
          // Node par hota hai — khalis matchModelOption
          // helper. Purana saaf-string includes() versioned
          // naamon par tootta tha: target 'Omni 1.2 Flash'
          // (saaf 'omni12flash') Flow ke menu text 'Omni
          // Flash 1.2' ('omniflash12') se match hi nahi
          // hota tha, aur legacy target 'Omni Flash'
          // ('omniflash') ghalti se 'Omni Flash 1.2' ko
          // chun leta tha. Pattern gallery entry (.57)
          // wala hai: survey (dropdown ka current text)
          // -> faisla (strictVersion — 1.2 dikhna 1.1
          // target ke liye 'pehle se chuna hua' NAHI) ->
          // menu survey (item texts) -> faisla -> index
          // par click.
          const currentModelText = await this.page.evaluate(() => {
            const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
            const btns = Array.from(pop.querySelectorAll('button, div[role="button"]'));
            const modelDropdown = btns.find(b => {
              const txt = (b.innerText || '').toLowerCase();
              return txt.includes('omni') || txt.includes('veo') || txt.includes('flash') || txt.includes('banana') || b.getAttribute('aria-haspopup') === 'menu';
            });
            return modelDropdown ? (modelDropdown.innerText || '') : null;
          });
          const alreadySelected = currentModelText !== null
            && matchModelOption(settings.model, [currentModelText], { strictVersion: true }) === 0;
          if (!alreadySelected) {
            const itemTexts = await this.page.evaluate(async () => {
              const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
              const btns = Array.from(pop.querySelectorAll('button, div[role="button"]'));
              const modelDropdown = btns.find(b => {
                const txt = (b.innerText || '').toLowerCase();
                return txt.includes('omni') || txt.includes('veo') || txt.includes('flash') || txt.includes('banana') || b.getAttribute('aria-haspopup') === 'menu';
              });
              if (!modelDropdown) return null;
              modelDropdown.click();
              await new Promise(r => setTimeout(r, 400));
              const menuItems = Array.from(document.querySelectorAll('.cdk-overlay-pane [role="menuitem"], [role="menu"] button, div[role="menu"] div, div[role="listbox"] [role="option"]'));
              return menuItems.map(item => item.innerText || '');
            });
            if (Array.isArray(itemTexts) && itemTexts.length) {
              const pick = matchModelOption(settings.model, itemTexts);
              if (pick >= 0) {
                await this.page.evaluate((idx) => {
                  const menuItems = Array.from(document.querySelectorAll('.cdk-overlay-pane [role="menuitem"], [role="menu"] button, div[role="menu"] div, div[role="listbox"] [role="option"]'));
                  const opt = menuItems[idx];
                  if (opt) opt.click();
                }, pick);
              }
            }
          }
          await sleep(400);
        }

        // 4. Select Aspect Ratio
        const targetAspect = settings.aspectRatio || (modeType === 'Image' ? '1:1' : '9:16');
        this.log(`Selecting the Size (aspect ratio): [${targetAspect}]…`, 'info');
        await this.page.evaluate((aspect) => {
          const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
          const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
          const cleanAspect = aspect.replace(':', '_');
          const targetBtn = btns.find(b => {
            const txt = (b.innerText || '').trim();
            const aria = (b.getAttribute('aria-label') || '').trim();
            return txt.includes(aspect) || txt.includes(cleanAspect) || aria.includes(aspect) || aria.includes(cleanAspect);
          });
          if (targetBtn) targetBtn.click();
        }, targetAspect);
        await sleep(350);

        // 4.5 Select the generation Resolution (v2.40.0): the
        // panel's 360p/720p buttons fix the ORIGINAL quality Flow
        // generates at — and the real credit cost follows it (see
        // getRequiredCredits). This step never ran before, so a
        // panel left on 720p silently generated (and charged)
        // 720p while the app's Quality setting said 360p.
        // Best-effort, like every panel step: if the buttons are
        // not found (Flow panel variants exist), log a warning
        // and continue — never fail a run over this.
        if (modeType === 'Video') {
          this.log(`Selecting the Resolution: [${genResolution}]…`, 'info');
          const readResolutionState = async () => {
            // v2.48.62: page ke andar WAHI khalis helper
            // (resolutionBtnSelected) chalta hai jo Node me
            // test hota hai — us ka source resolutionStateSource
            // me garam hokar jata hai. Chaudi pehchan: haalat
            // wali class button par ho ya us ke parent par.
            return await this.page.evaluate(resolutionStateSource());
          };
          let resState = await readResolutionState();
          if (!resState.found) {
            this.log('The 360p/720p buttons were not found on Flow\'s panel — the generation keeps the resolution the panel already shows.', 'warn');
          } else {
            if (resState.selected !== genResolution) {
              await this.page.evaluate((res) => {
                const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
                const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
                const targetBtn = btns.find(b => (b.innerText || '').trim().toLowerCase() === res);
                if (targetBtn) targetBtn.click();
              }, genResolution);
              await sleep(350);
              resState = await readResolutionState();
            }
            if (resState.selected) {
              this.log(`Resolution confirmed on Flow: [${resState.selected}] (needed [${genResolution}])`, resState.selected === genResolution ? 'success' : 'warn');
            } else {
              // v2.48.62 (FALLBACK): panel ke button par
              // pehchan phir bhi na mile to settings pill ka
              // apna text dekho — wahi pill jo is function
              // ke aakhir me bhi padha jata hai ('Video ·
              // 360p · 4s …'). Us me asal resolution maujood
              // ho to wahi tasdeeq hai; warna purani
              // chetaavni barkarar.
              let pillConfirmed = false;
              try {
                const pillText = await this.page.evaluate(() => {
                  const pill = document.querySelector('.settings-trigger-button, button.settings-trigger-button');
                  return pill ? (pill.innerText || '').replace(/\n/g, ' ').trim() : null;
                });
                if (pillText && pillText.includes(genResolution)) pillConfirmed = true;
              } catch (e) {}
              if (pillConfirmed) {
                this.log(`Resolution confirmed on Flow: [${genResolution}]`, 'success');
              } else {
                this.log('The panel\'s resolution could not be confirmed after selecting — the run continues with the resolution Flow shows.', 'warn');
              }
            }
          }
        }

        // 5. Select Duration
        if (modeType === 'Video') {
          const targetDuration = settings.duration || '6s';
          this.log(`Selecting the Duration: [${targetDuration}]…`, 'info');
          await this.page.evaluate((dur) => {
            const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
            const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
            const targetBtn = btns.find(b => {
              const txt = (b.innerText || '').trim().toLowerCase();
              const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
              return txt === dur.toLowerCase() || aria === dur.toLowerCase();
            });
            if (targetBtn) targetBtn.click();
          }, targetDuration);
          await sleep(350);
        }

        // 6. Select Outputs Count — v2.4.0: always x1 (locked). The
        // step itself stays: a profile Flow used before may remember
        // x2 from an older session, and the click back to x1 is what
        // keeps the credit math honest.
        const targetCount = 'x1';
        this.log(`Selecting the output count: [${targetCount}]…`, 'info');
        await this.page.evaluate((cnt) => {
          const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
          const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
          const targetBtn = btns.find(b => {
            const txt = (b.innerText || '').trim().toLowerCase();
            const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
            return txt === cnt.toLowerCase() || aria === cnt.toLowerCase();
          });
          if (targetBtn) targetBtn.click();
        }, targetCount);
        await sleep(350);

        // 7. Verify the duration ACTUALLY selected (v1.6.2): read the
        // popover's selected duration back; if Flow shows a different
        // value (model-switch reset, a click that landed on a hidden
        // twin), click the right one and re-read. The click alone is
        // never trusted again — the 6s→8s report proved why.
        if (modeType === 'Video') {
          const readSelectedDuration = async () => {
            return await this.page.evaluate(() => {
              const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content');
              if (!pop) return null;
              const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
              const durBtns = btns.filter(b => /^\d+\s*s$/.test((b.innerText || '').trim().toLowerCase()));
              const sel = durBtns.find(b => b.getAttribute('aria-checked') === 'true' || b.getAttribute('aria-selected') === 'true' || b.getAttribute('aria-pressed') === 'true' || b.getAttribute('data-state') === 'on' || b.classList.contains('selected') || b.classList.contains('active'));
              return sel ? (sel.innerText || '').trim().toLowerCase() : null;
            });
          };
          const wantDur = (settings.duration || '6s').toLowerCase();
          let shownDur = await readSelectedDuration();
          for (let attempt = 0; attempt < 2 && shownDur && shownDur !== wantDur; attempt++) {
            this.log(`The duration on Flow shows [${shownDur}], need [${wantDur}] — setting it again...`, 'warn');
            await this.page.evaluate((dur) => {
              const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
              const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
              const targetBtn = btns.find(b => {
                const txt = (b.innerText || '').trim().toLowerCase();
                const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
                return txt === dur.toLowerCase() || aria === dur.toLowerCase();
              });
              if (targetBtn) targetBtn.click();
            }, settings.duration || '6s');
            await sleep(350);
            shownDur = await readSelectedDuration();
          }
          if (shownDur) {
            this.log(`Duration confirmed on Flow: [${shownDur}] (needed [${wantDur}])`, shownDur === wantDur ? 'success' : 'warn');
          }
        }

        // 8. Close popover
        await this.page.keyboard.press('Escape');
        await sleep(600);

        // 9. Verify prompt-bar pill text
        const finalPillText = await this.page.evaluate(() => {
          const pill = document.querySelector('.settings-trigger-button, button.settings-trigger-button');
          return pill ? pill.innerText.replace(/\n/g, ' ').trim() : null;
        });

        if (modeType === 'Video' && finalPillText && (finalPillText.includes('Banana') || finalPillText.startsWith('Image'))) {
          if (!isRetry) {
            this.log(`The settings pill is still stuck on Image (${finalPillText}) — trying again to switch it to Video…`, 'warn');
            return await this.configureGenerationSettings(settings, true);
          } else {
            this.log(`Settings pill par chetaavni: "${finalPillText}".`, 'warn');
          }
        } else {
          this.log(`Saari Flow settings lag gayi aur Flow ke UI me confirm bhi ho gayi: "${finalPillText || modeType}"`, 'success');
        }

        // v2.48.63 (SETTINGS TASDEEQ — Item B): pill ka
        // muqabla MANGI hui settings se — aakhri darwaza.
        // ZC30 ka saboot: taaza account ka panel image
        // mode me 720p/8s par baitha tha; resolution ke
        // button 'not found' par sirf chetaavni aayi, koi
        // Duration-confirmed line nahi aayi, aur run upar
        // wali 'confirm ho gayi' line ke saath 360p/4s ki
        // jagah 720p/8s par chala gaya — 8 ki jagah 20
        // credits jale. Ab: pill PADH sakne par ikhtilaf
        // ho to natija { settingsMismatch } caller tak
        // jata hai aur submitPrompt prompt FIRE kiye
        // bagair SETTINGS_MISMATCH lautata hai (koi
        // credit nahi katta). Pill na padh sakein (null)
        // to purani rawish barkarar — chetaavni ke saath
        // aage. Per-step purani lines bilkul nahi badli;
        // ye un ka badal nahi, aakhri darwaza hai.
        if (modeType === 'Video' && finalPillText) {
          const requestedPill = {
            mode: modeType,
            resolution: genResolution,
            durationSec: parseInt(String(settings.duration || '6s'), 10) || null,
            aspect: targetAspect
          };
          const pillMismatch = settingsPillMismatch(requestedPill, parseSettingsPill(finalPillText));
          if (pillMismatch.length > 0) {
            this.log(`[ROOT] settings-mismatch pill="${finalPillText}" fields=${pillMismatch.join(',')} — run stopped before any submit; no credits spent`, 'error');
            this.log(`Flow's settings panel does not match this run's settings (${pillMismatch.join(', ')}) — the prompt was NOT sent and no credits were spent. This account will be skipped for the rest of the run.`, 'error');
            return { ok: false, settingsMismatch: pillMismatch, pillText: finalPillText };
          }
        }
      } else {
        this.log('No settings pill was found on Flow — work will continue with the default settings.', 'warn');
      }
    } catch (e) {
      const t = plainError.translateError(e);
      this.log(`Settings lagane me ek note: ${t.plain}.`, 'warn', { rawError: t.raw });
    }
  }

  // SUBMIT A SINGLE PROMPT (fire-and-forget: returns once Flow accepts it)
  // Returns { status: 'SUBMITTED' | 'EXHAUSTED' | 'LOW_CREDITS' | 'VIOLATION' | 'STOPPED' | 'SETTINGS_MISMATCH', ... }
  // EXHAUSTED / LOW_CREDITS / SETTINGS_MISMATCH are only ever returned
  // BEFORE the prompt fires, so the pool may safely re-queue the task
  // on another account.
  async submitPrompt(promptText, settings, promptIndex, totalPrompts) {
    if (this.isStopping) return { status: 'STOPPED' };
    // v1.1: from here on, video streams on this page may be results of our
    // own submissions — arm the response capture (see launch handler).
    this.captureArmed = true;

    promptText = (promptText || '').replace(/[\r\n]+/g, ' ').trim();
    // v2.23.0 guard: an empty prompt must fail HERE with its real reason
    // instead of travelling to Flow and surfacing as a misleading
    // "editor did not accept input" error after four write attempts.
    if (!promptText) {
      throw new Error('The prompt text was EMPTY when it reached the engine — there was nothing to write into Flow. Check the Prompts box content for this task.');
    }
    const videoId = `vid_${Date.now()}_${promptIndex + 1}`;
    this.log(`[Prompt ${promptIndex + 1}/${totalPrompts}] Sending to Flow: "${promptText.substring(0, 50)}..."`, 'info');

    if (this.onVideoStarted) {
      this.onVideoStarted({
        id: videoId,
        prompt: promptText,
        promptIndex: promptIndex + 1,
        totalPrompts,
        accountName: this.currentAccount ? this.currentAccount.name : 'Account',
        status: 'Preparing & Submitting...'
      });
    }

    await this.dismissAnyBlockingOverlays();

    if (settings.type !== 'Image') {
      const creditState = await this.checkCreditsState(settings);
      if (creditState === 'EXHAUSTED') {
        this.log(`[${this.currentAccount.name}]'s credits are finished!`, 'warn');
        return { status: 'EXHAUSTED' };
      }
      if (creditState === 'LOW_CREDITS') {
        this.log(`[${this.currentAccount.name}] has too few credits for the selected model.`, 'warn');
        return { status: 'LOW_CREDITS' };
      }
    }

    // 1. Configure settings on the first prompt of this browser session
    // (hasConfiguredSettings is reset on every launch/close — audit fix #5).
    if (!this.hasConfiguredSettings) {
      const cfgRes = await this.configureGenerationSettings(settings);
      if (cfgRes && Array.isArray(cfgRes.settingsMismatch)) {
        // v2.48.63 (SETTINGS TASDEEQ): pre-fire nakami —
        // prompt gaya hi nahi, credit kata hi nahi; pool
        // task ko dusre account par bhej sakta hai.
        return { status: 'SETTINGS_MISMATCH', mismatchFields: cfgRes.settingsMismatch, pillText: cfgRes.pillText || null };
      }
      this.hasConfiguredSettings = true;
    }

    await this.ensureAgentModeDisabled();
    const currentPillText = await this.page.evaluate(() => {
      const pill = document.querySelector('.settings-trigger-button, button.settings-trigger-button');
      return pill ? pill.innerText.replace(/\n/g, ' ').trim() : null;
    });

    const isVideoExpected = (settings.type || 'Video') === 'Video';
    if (isVideoExpected && currentPillText && (currentPillText.includes('Banana') || currentPillText.startsWith('Image'))) {
      this.log(`The Flow workspace has gone back to Image (${currentPillText}) — applying Video mode again…`, 'warn');
      const cfgRes2 = await this.configureGenerationSettings(settings);
      if (cfgRes2 && Array.isArray(cfgRes2.settingsMismatch)) {
        // v2.48.63 (SETTINGS TASDEEQ): dobara lagane ke
        // baad bhi pill mangi hui settings se nahi mili —
        // wohi pre-fire nakami, prompt FIRE nahi hoga.
        return { status: 'SETTINGS_MISMATCH', mismatchFields: cfgRes2.settingsMismatch, pillText: cfgRes2.pillText || null };
      }
    }

    // 2. Focus the ProseMirror prompt box and type the prompt
    this.currentStage = 'Prompt Input';
    // v2.23.1: the failure screenshot (owner's PC, 2026-10-19) shows a
    // perfectly normal Flow page - no overlay, no popover, prompt bar
    // ready - yet no input landed. A background/off-screen window can
    // starve the renderer of real focus, so bring the page to the
    // front before any typing happens.
    try { await this.page.bringToFront(); } catch (e) {}
    this.log('Focusing Flow\'s prompt box…', 'info');

    let tbFound = false;
    try {
      await this.page.waitForFunction(() => {
        const els = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]'));
        return els.some(c => { const r = c.getBoundingClientRect(); return (c.isContentEditable || c.getAttribute('contenteditable') === 'true') && r.width > 30 && r.height > 8 && (c.checkVisibility ? c.checkVisibility() : true); });
      }, { timeout: 15000 });
      tbFound = true;
    } catch (tbErr) {
      tbFound = false;
    }

    if (!tbFound) {
      throw new Error(`Google Flow prompt box ('div.ProseMirror') not found on canvas URL: ${this.page.url()}`);
    }

    await this.page.evaluate(() => {
      const searchInput = document.querySelector('input.search-input, input[aria-label*="search" i]');
      if (searchInput) {
        searchInput.value = '';
        searchInput.blur();
      }
      const clearBtn = document.querySelector('button.clear-button, button[aria-label="Clear prompt"]');
      if (clearBtn) {
        try { clearBtn.click(); } catch (e) {}
      }
    });

    const tbCoords = await this.page.evaluate(() => {
      const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
      if (el) {
        try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
        el.focus();
        const r = el.getBoundingClientRect();
        return { x: r.x + Math.min(25, r.width / 4), y: r.y + r.height / 2 };
      }
      return null;
    });

    if (tbCoords) {
      await this.page.mouse.click(tbCoords.x, tbCoords.y);
      await sleep(150);
    } else {
      const tbHandle = await this.page.$('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror');
      if (tbHandle) await tbHandle.click();
      await sleep(150);
    }

    await this.page.keyboard.down('Control');
    await this.page.keyboard.press('A');
    await this.page.keyboard.up('Control');
    await this.page.keyboard.press('Backspace');
    await sleep(150);

    this.log(`Writing the prompt: "${promptText.substring(0, 50)}..."`, 'info');
    await this.insertNativeText(promptText);
    await sleep(250);

    await this.page.evaluate(() => {
      const searchInput = document.querySelector('input.search-input, input[aria-label*="search" i]');
      if (searchInput && (searchInput.value || document.activeElement === searchInput)) {
        searchInput.value = '';
        searchInput.blur();
      }
    });

    // Verify the prompt actually landed in the editor DOM (multi-layer fallback)
    let domPromptText = await this.page.evaluate(() => {
      const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
      return el ? (el.innerText || el.textContent || '').trim() : '';
    });

    if (!domPromptText || domPromptText.length === 0) {
      // v2.24.1: real clipboard paste (Ctrl+V) — a genuinely different
      // input path from every insert/typing method, and the one
      // ProseMirror is built to accept. Tried early on purpose.
      this.log('Trying clipboard paste (Ctrl+V) into the editor...', 'warn');
      try { await this.pastePromptViaClipboard(promptText); } catch (e) {}
      await sleep(250);
      domPromptText = await this.page.evaluate(() => {
        const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
        return el ? (el.innerText || el.textContent || '').trim() : '';
      });
    }

    if (!domPromptText || domPromptText.length === 0) {
      this.log('The prompt could not be written with the first method — trying the second method (inserting the text directly)…', 'warn');
      if (!this.cdpSession && this.page) {
        try { this.cdpSession = await this.page.target().createCDPSession(); } catch (e) {}
      }
      if (this.cdpSession) {
        try { await this.cdpSession.send('Input.insertText', { text: promptText }); } catch (cdpErr) { this.cdpSession = null; }
      }
      await sleep(250);
      domPromptText = await this.page.evaluate(() => {
        const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
        return el ? (el.innerText || el.textContent || '').trim() : '';
      });
    }

    if (!domPromptText || domPromptText.length === 0) {
      this.log('The second method also did not work — trying the third method…', 'warn');
      await this.page.evaluate((text) => {
        const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
        if (el) {
          el.focus();
          document.execCommand('insertText', false, text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, promptText);
      await sleep(250);
      domPromptText = await this.page.evaluate(() => {
        const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
        return el ? (el.innerText || el.textContent || '').trim() : '';
      });
    }

    if (!domPromptText || domPromptText.length === 0) {
      // v2.23.1: ElementHandle click + type. Puppeteer's own element
      // click scrolls the editor into view, waits for it to be stable,
      // and clicks its centre through the element's own box model -
      // a different input path from raw coordinate mouse events, and
      // the one most likely to satisfy Flow's new prompt bar.
      this.log('Trying direct element click and typing on the editor...', 'warn');
      try { await this.page.bringToFront(); } catch (e) {}
      try {
        const handle = await this.page.evaluateHandle(() => ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })()));
        const elHandle = handle && handle.asElement ? handle.asElement() : null;
        if (elHandle) {
          await elHandle.click();
          await sleep(250);
          await elHandle.type(promptText, { delay: 20 });
        }
      } catch (e) {}
      await sleep(300);
      domPromptText = await this.page.evaluate(() => {
        const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
        return el ? (el.innerText || el.textContent || '').trim() : '';
      });
    }

    if (!domPromptText || domPromptText.length === 0) {
      // v2.22.2: REAL keyboard typing. The CDP insertText and execCommand
      // paths can both report success while the editor ignores them -
      // genuine key events are what a human typist produces, and they
      // were never tried as a primary method. Click the ranked editor,
      // place a real text selection inside it, then type.
      this.log('Trying real keyboard typing into the editor...', 'warn');
      const kbCoords = await this.page.evaluate(() => {
        const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
        if (!el) return null;
        try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
        const r = el.getBoundingClientRect();
        return { x: r.x + Math.min(25, r.width / 4), y: r.y + r.height / 2 };
      });
      if (kbCoords) {
        await this.page.mouse.click(kbCoords.x, kbCoords.y);
        await sleep(200);
      }
      await this.page.evaluate(() => {
        const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
        if (!el) return;
        el.focus();
        try {
          const sel = window.getSelection();
          const range = document.createRange();
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT_NODE);
          const node = walker.nextNode() || el;
          range.setStart(node, 0);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (e) {}
      });
      try { await this.page.keyboard.type(promptText, { delay: 20 }); } catch (e) {}
      await sleep(300);
      domPromptText = await this.page.evaluate(() => {
        const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
        return el ? (el.innerText || el.textContent || '').trim() : '';
      });
    }

    if (!domPromptText || domPromptText.length === 0) {
      // v2.22.1 hardening: after a mode switch Flow can swap in a fresh
      // editor instance, so the node the first attempts focused may be
      // stale. Settle, re-find the VISIBLE editor, click it again and
      // retry the native write once before giving up.
      this.log('The prompt still did not land — retrying once with a fresh focus on the visible editor…', 'warn');
      await sleep(1000);
      const retryCoords = await this.page.evaluate(() => {
        const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
        if (el) {
          try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
          el.focus();
          const r = el.getBoundingClientRect();
          return { x: r.x + Math.min(25, r.width / 4), y: r.y + r.height / 2 };
        }
        return null;
      });
      if (retryCoords) {
        await this.page.mouse.click(retryCoords.x, retryCoords.y);
        await sleep(200);
      }
      await this.insertNativeText(promptText);
      await sleep(300);
      domPromptText = await this.page.evaluate(() => {
        const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
        return el ? (el.innerText || el.textContent || '').trim() : '';
      });
    }

    if (!domPromptText || domPromptText.length === 0) {
      // v2.22.2: capture exactly what the page looks like at this moment,
      // so the next diagnosis comes from evidence, not guesses. A short
      // summary rides inside the error itself (visible in the Activity
      // log), and a full screenshot is saved next to the downloads.
      let diagSummary = '';
      try {
        const diag = await this.page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]'));
          const info = els.map(e => {
            const r = e.getBoundingClientRect();
            return { ce: e.getAttribute('contenteditable'), w: Math.round(r.width), h: Math.round(r.height), vis: e.checkVisibility ? e.checkVisibility() : null, txt: (e.textContent || '').trim().length };
          });
          const ae = document.activeElement;
          return { count: els.length, info, active: ae ? (ae.tagName + '') : 'none', hasFocus: document.hasFocus() };
        });
        diagSummary = ' [diag editors=' + diag.count + ' active=' + diag.active + ' docFocus=' + diag.hasFocus + diag.info.map(i => ' {ce=' + i.ce + ' ' + i.w + 'x' + i.h + ' vis=' + i.vis + ' txt=' + i.txt + '}').join('') + ']';
        try {
          const shotPath = path.join(this.browserDownloadDir || process.cwd(), 'prompt-fail-' + Date.now() + '.png');
          await this.page.screenshot({ path: shotPath });
          this.log('Prompt-write diagnostics:' + diagSummary + ' Screenshot saved: ' + shotPath, 'error');
        } catch (e) {}
      } catch (e) {}
      throw new Error('Could not write prompt into Google Flow ProseMirror editor. Editor DOM did not accept input events.' + diagSummary);
    }

    this.log(`The prompt has been written correctly in Flow's editor (${domPromptText.length} characters).`, 'success');

    // Snapshot existing tiles + captured URLs before firing, so this task can
    // later prove which media belongs to ITS submission (audit fix #6).
    let preExistingTileCount = 0;
    let preExistingAriaLabels = [];
    try {
      const snap = await this.page.evaluate(() => {
        const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
        return {
          count: containers.length,
          labels: containers.map(c => (c.getAttribute('aria-label') || '').toLowerCase().trim()).filter(Boolean)
        };
      });
      preExistingTileCount = snap.count;
      preExistingAriaLabels = snap.labels;
    } catch (e) {}

    const preExistingVideoUrls = new Set(this.capturedVideoUrls || []);

    // v2.8.0: NETWORK CAPTURE armed — generate fire hone se THEEK
    // pehle is submission ki entry capture me banti hai. Submit ke
    // jawab me aane wala workflowId isi entry se bandhega, aur usi
    // ID ke saath aaya media link seedha isi task ka mana jayega
    // (engine/networkCapture.js — pehchan ka sabse mazboot raasta).
    try { this.netCapture.beginSubmission(videoId, Date.now()); } catch (e) {}

    // 3. Fire the generation request (trusted OS-level click)
    this.currentStage = 'Firing Generation';
    this.log('Sending the Generate request to Flow (pressing the video-generation button)…', 'info');
    await sleep(400);

    let submitBtnCoords = null;
    for (let waitBtn = 0; waitBtn < 5; waitBtn++) {
      submitBtnCoords = await this.page.evaluate(() => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        const submitBtn = allBtns.find(b => {
          const txt = (b.innerText || '').trim();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          const cls = String(b.className || '').toLowerCase();
          const isGenIcon = cls.includes('generate-icon-button') || cls.includes('generate');
          const hasArrow = txt.includes('arrow_forward') || txt.includes('arrow_upward') || txt.includes('send');
          const isGenerate = (aria === 'generate' || aria === 'submit' || aria.includes('generation') || aria.includes('generate'));
          const isAddButton = aria.includes('add') || aria.includes('asset') || txt.includes('add_2') || txt === '+';
          return (isGenIcon || hasArrow || isGenerate) && !isAddButton;
        });

        if (submitBtn) {
          const disabled = submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true';
          const r = submitBtn.getBoundingClientRect();
          return { found: true, disabled, x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        return { found: false };
      });

      if (submitBtnCoords && submitBtnCoords.found && !submitBtnCoords.disabled) {
        break;
      }
      await sleep(500);
    }

    if (submitBtnCoords && submitBtnCoords.found) {
      if (submitBtnCoords.disabled) {
        this.log('The send button is still off (disabled) — trying to enable it…', 'warn');
        await this.page.evaluate(() => {
          const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
          if (el) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
        await sleep(500);
      }
      await this.page.mouse.move(submitBtnCoords.x, submitBtnCoords.y, { steps: 5 });
      await sleep(100);
      await this.page.mouse.click(submitBtnCoords.x, submitBtnCoords.y);
      await sleep(350);
    } else {
      this.log('Sending the prompt with the Ctrl+Enter shortcut…', 'info');
      await this.page.keyboard.down('Control');
      await this.page.keyboard.press('Enter');
      await this.page.keyboard.up('Control');
      await sleep(350);
    }

    // 4. Immediate safety / policy violation scan
    // v2.9.0 — SABOOT KA DAYRA (engine/failureEvidence.js): ye scan
    // sirf tab violation maanta hai jab kisi alert/dialog/snackbar me
    // Flow ka ASAL refusal JUMLA mile (word-bounded phrases; akela
    // 'safety'/'policy'/'violat'/'blocked' kabhi kaafi nahi), aur
    // account/credits wala chrome panel — jo credit check khud kholta
    // hai — iske liye kabhi saboot nahi banta. Wajah bhi wahi asal
    // jumla hota hai, poora element ka kata majmua nahi. (Purana scan
    // page ke kisi bhi [class*="error"]/[class*="alert"] hisse par
    // bare-substring se trigger ho jata tha.)
    await sleep(1500);
    const immediateViolation = await this.page.evaluate(({ refusalSources, chromeMarkers }) => {
      const stripLigs = (t) => String(t || '').replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, ' ');
      const findRefusalSnippet = (raw) => {
        const flat = String(raw || '').replace(/\s/g, ' ');
        const low = flat.toLowerCase();
        for (const src of refusalSources) {
          const m = low.match(new RegExp(src, 'i'));
          if (!m) continue;
          let a = Math.max(0, m.index - 90);
          for (let i = m.index - 1; i >= a; i--) { if ('.!?\n'.includes(flat[i])) { a = i + 1; break; } }
          let b = Math.min(flat.length, m.index + m[0].length + 90);
          for (let i = m.index + m[0].length; i < b; i++) { if ('.!?'.includes(flat[i])) { b = i + 1; break; } }
          return flat.slice(a, b).replace(/\s+/g, ' ').trim();
        }
        return null;
      };
      const isAccountChrome = (el, low) => chromeMarkers.some(mk => low.includes(mk)) ||
        (el.closest && !!el.closest('flow-account-panel, [class*="account-panel"], [class*="profile-menu"]'));
      const errorSelectors = [
        'div[role="alert"]',
        'div[role="alertdialog"]',
        'div[role="status"]',
        'snack-bar',
        'mwc-snackbar',
        '[class*="snackbar"]',
        '.toast',
        'div[role="dialog"]',
        'mwc-dialog',
        'flow-dialog'
      ];

      const seen = new Set();
      for (const sel of errorSelectors) {
        const els = Array.from(document.querySelectorAll(sel));
        for (const el of els) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (!(el.offsetWidth > 0 || el.offsetHeight > 0)) continue;
          const raw = el.innerText || '';
          const low = raw.toLowerCase();
          if (isAccountChrome(el, low)) continue;
          const snippet = findRefusalSnippet(stripLigs(raw));
          if (!snippet) continue;
          const dismissBtn = Array.from(el.querySelectorAll('button, [role="button"]')).find(b => {
            const bTxt = (b.innerText || '').toLowerCase().trim();
            return bTxt.includes('got it') || bTxt.includes('dismiss') || bTxt === 'ok' || bTxt.includes('close');
          });
          if (dismissBtn) {
            try { dismissBtn.click(); } catch (e) {}
          }
          return {
            isViolation: true,
            message: snippet.substring(0, 150)
          };
        }
      }

      return null;
    }, { refusalSources: failureEvidence.patternSources(), chromeMarkers: failureEvidence.ACCOUNT_CHROME_MARKERS });

    if (immediateViolation && immediateViolation.isViolation) {
      try { await this.page.keyboard.press('Escape'); } catch (e) {}
      try {
        await this.page.evaluate(() => {
          const clearBtn = document.querySelector('button.clear-button, button[aria-label="Clear prompt"]');
          if (clearBtn) { try { clearBtn.click(); } catch (e) {} }
          const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
          if (el) {
            el.textContent = '';
          }
        });
      } catch (e) {}

      this.log(`[Prompt #${promptIndex + 1}] Google Safety/Policy Violation detected: "${immediateViolation.message}". Skipping prompt safely to protect queue!`, 'warn');

      this.onVideoCompleted({
        id: videoId,
        prompt: promptText,
        accountName: this.currentAccount.name,
        status: `Violation: ${immediateViolation.message}`,
        filePath: null,
        error: immediateViolation.message,
        type: settings.type,
        timestamp: new Date().toLocaleTimeString()
      });

      return {
        status: 'VIOLATION',
        // v2.9.0: reason par wahi label + tile/dialog ka ASAL jumla —
        // label failover ki prompt-level pehchan ke liye hai, jumla
        // imaandari ke liye (phrase ab pakka sabit shuda hai).
        reason: `Google Safety Filter: ${immediateViolation.message}`,
        videoId,
        promptIndex
      };
    }

    this.log(`[Prompt #${promptIndex + 1}] The video-generation request has gone to Flow — now waiting for the render (video generation).`, 'success');

    // 5. Post-submit credit sync — through the credit port only (fix #4).
    // A live re-read wins; otherwise an estimated charge is applied, which
    // by credit-service rule can never zero the balance (fix #2).
    const required = this.getRequiredCredits(settings);
    if (this.currentAccount && required > 0) {
      const accId = this.currentAccount.id;
      const liveCr = await this.readLiveCreditsFromPage();
      if (typeof liveCr === 'number') {
        this.creditPort.liveBalance(accId, liveCr);
        this.currentAccount.credits = liveCr;
        this.log(`[Credits] [${this.currentAccount.name}]'s balance after the charge: ${liveCr} credits.`, 'info');
      } else {
        const res = this.creditPort.estimatedCharge(accId, required);
        if (res && res.account && typeof res.account.credits === 'number') {
          this.currentAccount.credits = res.account.credits;
        }
        this.log(`[Credits] ~${required} credits were deducted from [${this.currentAccount.name}] (estimate — the live balance could not be read immediately).`, 'info');
      }
      if (this.onAccountUpdated) {
        this.onAccountUpdated({ account: this.currentAccount });
      }
    }

    this.onVideoStarted({
      id: videoId,
      prompt: promptText,
      accountName: this.currentAccount.name,
      quality: settings.quality || '360p',
      duration: settings.duration || '6s',
      aspectRatio: settings.aspectRatio || '9:16',
      timestamp: new Date().toLocaleTimeString(),
      status: 'Generating'
    });

    // v1.5.0 BIRTH BINDING: poll briefly for the NEW tile this submission
    // created and bind the task to it by FINGERPRINT right away. The
    // monitor then never has to guess which tile belongs to this task
    // (the old guess-by-index/two-words scheme is what scrambled
    // multi-prompt runs). If the tile is slow to appear, the task still
    // returns SUBMITTED unbound — the monitor's strict scored claim is
    // the fallback.
    const preExistingFingerprints = new Set(
      (preExistingAriaLabels || []).map(l => tileIdentity.tileFingerprint(l, ''))
    );
    // v1.7.0: birth binding must be SCORED, never "first new tile wins".
    // Burst submissions race: a sibling prompt's tile can appear before
    // this task's own, and the old text-blind binding locked this task
    // onto the WRONG video for the entire run — the monitor's
    // fingerprint pass trusts a locked binding, so the error never
    // healed (owner's persistent "prompt mismatch" report). Bind only
    // when the tile's own prompt text STRONGLY matches this prompt;
    // otherwise stay unbound and let the monitor's scored assignment
    // (which compares all tasks against all tiles) decide.
    const promptWordsForBind = tileIdentity.significantWords(promptText || '');
    let lockedTileFingerprint = null;
    try {
      for (let poll = 0; poll < 6 && !lockedTileFingerprint; poll++) {
        const fps = await this.page.evaluate(() => {
          return Array.from(document.querySelectorAll('flow-grid-tile-container'))
            .map(c => (c.getAttribute('aria-label') || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
        });
        for (const fp of fps) {
          if (preExistingFingerprints.has(fp) || this.claimedTileFingerprints.has(fp)) continue;
          if (tileIdentity.isStrongMatch(tileIdentity.scoreTileForPrompt(promptWordsForBind, tileIdentity.significantWords(fp)))) {
            lockedTileFingerprint = fp;
            break;
          }
        }
        if (!lockedTileFingerprint) await sleep(2500);
      }
    } catch (e) {}
    // v2.48.57 (PROJECT-TRUTH change 1): tile link hote
    // hi is task ke project ka URL pakdo — video SIRF
    // isi project me milegi, aur recovery ko yahi pata
    // chahiye. Pool is value ko task ki DB row par
    // record karta hai (setTaskProjectUrl). Tile link
    // na ho to pool apne paas ke mauqe par page ka
    // current project URL hi record kar deta hai (task
    // usi project me submit hua tha).
    let birthProjectUrl = '';
    if (lockedTileFingerprint) {
      this.claimedTileFingerprints.add(lockedTileFingerprint);
      this.log(`[Prompt #${promptIndex + 1}] Linked to its render tile (the tile identification/fingerprint matched).`, 'info');
      birthProjectUrl = this.currentProjectUrl();
      if (birthProjectUrl) {
        this.log(`[ROOT] task-project task=${promptIndex} url=${birthProjectUrl}`, 'info');
      }
    }

    const submittedTask = {
      status: 'SUBMITTED',
      videoId,
      projectUrl: birthProjectUrl,
      // v2.8.0: network capture isi key se is task ko pehchanta hai
      // (videoId hi capture key hai — submit ke pal par tay hua).
      captureKey: videoId,
      promptText,
      promptIndex,
      startTime: Date.now(),
      preExistingTileCount,
      preExistingAriaLabels,
      preExistingFingerprints: [...preExistingFingerprints],
      preExistingVideoUrls,
      lockedTileFingerprint,
      wasObservedGenerating: false,
      completed: false,
      downloaded: false
    };
    // v2.48.12: register for backend capture NOW — at submit
    // time, not when the render monitor starts. Until now a task
    // only entered the capture map inside waitForAccountTasks,
    // i.e. after the WHOLE burst of prompts had been submitted;
    // a backend link that arrived in that gap sat in the early
    // store with no fetch running. Registered from this moment,
    // the instant Flow's backend sends the media link the
    // download starts (see _onBackendMediaBound) — the video
    // does not wait for the monitor to notice anything.
    try {
      if (this.currentDownloadDir) {
        this.registerBackendTask(submittedTask, this.currentDownloadDir, this.currentSettings);
      }
    } catch (e) {}
    // v2.48.13: DIRECT-API POLL bhi isi pal se — page ke tile par
    // nazar rakhne ke bajaye backend ko seedha poochhna shuru.
    try { this._startApiPoll(submittedTask); } catch (e) {}
    return submittedTask;
  }

  /**
   * v1.5.0: resolve a tile's CURRENT DOM index from its fingerprint
   * (normalized aria). Indices shift as new tiles arrive; fingerprints
   * do not. Returns -1 when the tile is not in the grid right now.
   */
  async _resolveTileIndexByFingerprint(fingerprint, page) {
    // v2.48.40: page diya jaye to wahi, warna worker ka
    // apna page. (v2.48.41: background page khatam hai —
    // asal istemal hamesha worker ka apna page hai.)
    const pg = page || this.page;
    if (!fingerprint || !pg || pg.isClosed()) return -1;
    try {
      return await pg.evaluate((fp) => {
        const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
        for (let i = 0; i < containers.length; i++) {
          if (norm(containers[i].getAttribute('aria-label') || '') === fp) return i;
        }
        return -1;
      }, fingerprint);
    } catch (e) {
      return -1;
    }
  }

  /**
   * v1.7.0: THE canonical way to locate a task's tile in the grid.
   * Fingerprint (the tile's normalized prompt aria) first; a remembered
   * DOM index is only a fallback and is interpreted against the ONE
   * canonical tile list (flow-grid-tile-container). The pre-v1.7 media
   * extraction evaluate read from a BROADER selector list
   * (flow-grid-tile-container, flow-video-tile, [role="gridcell"],
   * div[class*="tile"]) than the list its index was computed in — the
   * same index then pointed at a NEIGHBOUR's tile, and the neighbour's
   * fresh video URL passed the own-URL gate (which only excludes
   * pre-existing/consumed URLs). That selector drift is the
   * download/prompt mismatch the owner kept hitting even after tile
   * ASSIGNMENT was fixed in v1.5.0.
   */
  async _resolveTileIndexForTask(task, fallbackIdx, page) {
    // v2.48.40: page diya jaye to wahi, warna apna page
    // (v2.48.41: background page khatam — hamesha apna page).
    const pg = page || this.page;
    if (!pg || pg.isClosed()) return -1;
    const fp = task ? (task.lockedTileFingerprint || null) : null;
    if (fp) {
      const byFp = await this._resolveTileIndexByFingerprint(fp, pg);
      if (byFp >= 0) return byFp;
    }
    return (typeof fallbackIdx === 'number' && fallbackIdx >= 0) ? fallbackIdx : -1;
  }

  /**
   * v1.7.0: read the media URL from THIS task's tile only (located via
   * _resolveTileIndexForTask — canonical list, fingerprint-first).
   *
   * v2.7.0: the read now also tries the video element's `currentSrc`
   * (the URL the element is ACTUALLY playing — Flow sometimes leaves
   * `src` empty and only materializes currentSrc), and a detailed
   * variant reports WHICH attribute produced the URL so the download
   * orchestrator can log the exact route instead of failing silently.
   */
  async _extractTileMediaUrl(task, fallbackIdx, isImage) {
    const d = await this._extractTileMediaUrlDetailed(task, fallbackIdx, isImage);
    return d ? d.url : null;
  }

  async _extractTileMediaUrlDetailed(task, fallbackIdx, isImage) {
    try {
      const idx = await this._resolveTileIndexForTask(task, fallbackIdx);
      if (idx < 0) return null;
      return await this.page.evaluate(({ idx, isImage }) => {
        const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
        const target = containers[idx] || null;
        if (!target) return null;
        const usable = (u) => (u && (u.startsWith('http') || u.startsWith('blob:'))) ? u : null;
        const vid = target.querySelector('video');
        if (vid) {
          const fromSrc = usable(vid.src);
          if (fromSrc) return { url: fromSrc, via: 'video src' };
          const fromCurrent = usable(vid.currentSrc);
          if (fromCurrent) return { url: fromCurrent, via: 'video currentSrc' };
        }
        const src = target.querySelector('source');
        if (src) {
          const fromSource = usable(src.src);
          if (fromSource) return { url: fromSource, via: 'source src' };
        }
        if (isImage) {
          const img = target.querySelector('img');
          if (img) {
            const fromImg = usable(img.src);
            if (fromImg) return { url: fromImg, via: 'img src' };
          }
        }
        return null;
      }, { idx, isImage });
    } catch (e) {
      return null;
    }
  }

  /**
   * v2.47.4 — FAST-PATH ke liye tile ki EK jhalak me do khabrein:
   * (a) tile ka % progress indicator gaya ya abhi hai, aur
   * (b) tile ke <video> element ka src/currentSrc (wahi
   * extraction jo _extractTileMediaUrlDetailed karti hai).
   * % ki pehchan canvas read wali hi hai: tile ke chrome text
   * (us ke apne prompt aria ko hata kar) me 1-2 digit ka "%"
   * mile to video abhi ban raha hai; na mile to % gaya.
   * Tile SIRF task ki apni claimed pehchan se locate hoti hai
   * (_resolveTileIndexForTask — fingerprint-first), kisi aur
   * tile ki khabar kabhi nahi aati. Lautta hai:
   * { pctGone, url|null, via|null, videoWidth, videoHeight,
   * duration, readyState } ya null (tile/page nahi).
   * (v2.48.62: aakhri chaar — tile-media dims, <video> na ho
   * to null.)
   */
  async _readTileMediaState(task, fallbackIdx) {
    try {
      const idx = await this._resolveTileIndexForTask(task, fallbackIdx);
      if (idx < 0) return null;
      return await this.page.evaluate((tileIdx) => {
        const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
        const target = containers[tileIdx] || null;
        if (!target) return null;
        const aria = (target.getAttribute('aria-label') || '').toLowerCase().trim();
        const rawText = (target.innerText || '').toLowerCase();
        const text = aria ? rawText.split(aria).join(' ') : rawText;
        const pctGone = !/\b(\d{1,2})%/.test(text);
        const usable = (u) => (u && (u.startsWith('http') || u.startsWith('blob:'))) ? u : null;
        const vid = target.querySelector('video');
        // v2.48.62 (TILE-MEDIA DIMS): <video> ki asal
        // resolution / duration / readyState bhi har
        // jawab ke saath — log se sabit ho sakega ke
        // ~93KB wala preview chhota transcode hai ya
        // poori file ka kata hua hissa (Gemini §6.5).
        const media = { videoWidth: null, videoHeight: null, duration: null, readyState: null };
        if (vid) {
          if (Number.isFinite(vid.videoWidth) && vid.videoWidth > 0) media.videoWidth = vid.videoWidth;
          if (Number.isFinite(vid.videoHeight) && vid.videoHeight > 0) media.videoHeight = vid.videoHeight;
          if (Number.isFinite(vid.duration)) media.duration = Math.round(vid.duration * 100) / 100;
          if (Number.isFinite(vid.readyState)) media.readyState = vid.readyState;
          const fromSrc = usable(vid.src);
          if (fromSrc) return { pctGone, url: fromSrc, via: 'video src', ...media };
          const fromCurrent = usable(vid.currentSrc);
          if (fromCurrent) return { pctGone, url: fromCurrent, via: 'video currentSrc', ...media };
        }
        const srcEl = target.querySelector('source');
        if (srcEl) {
          const fromSource = usable(srcEl.src);
          if (fromSource) return { pctGone, url: fromSource, via: 'source src', ...media };
        }
        return { pctGone, url: null, via: null, ...media };
      }, idx);
    } catch (e) {
      return null;
    }
  }

  /**
   * v1.8.0 — CHECK-ONLY RECOVERY scan (ZDola logic): find the tile that
   * belongs to a prompt text in the CURRENT project grid, without
   * submitting anything. Scoring is the replica-tested tileIdentity
   * strong-match (containment metric); an exact tie between two tiles
   * returns null (ambiguous — never guess which video is whose).
   * Returns { tileIndex, fingerprint, url|null } or null.
   */
  async _scanGridForPrompt(promptText, isImage = false, opts = {}) {
    if (!this.page || this.page.isClosed()) return null;
    let tiles;
    try {
      tiles = await this.page.evaluate(() => {
        const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
        return containers.map((c, i) => ({
          tileIndex: i,
          aria: c.getAttribute('aria-label') || '',
          hasVideo: !!c.querySelector('video'),
          hasImg: !!c.querySelector('img')
        }));
      });
    } catch (e) {
      return null;
    }
    if (!tiles || tiles.length === 0) return null;

    const promptWords = tileIdentity.significantWords(promptText || '');

    if (promptWords.size > 0) {
      let best = null;
      let bestCount = 0;
      for (const t of tiles) {
        const score = tileIdentity.scoreTileForPrompt(promptWords, tileIdentity.significantWords(t.aria));
        if (!tileIdentity.isStrongMatch(score)) continue;
        if (!best || score.matched > best.score.matched) {
          best = { tileIndex: t.tileIndex, fingerprint: tileIdentity.tileFingerprint(t.aria, ''), score };
          bestCount = 1;
        } else if (score.matched === best.score.matched) {
          bestCount++;
        }
      }
      if (best && bestCount === 1) {
        const url = await this._extractTileMediaUrl(
          { lockedTileFingerprint: best.fingerprint }, best.tileIndex, isImage
        );
        return { tileIndex: best.tileIndex, fingerprint: best.fingerprint, url: url || null };
      }
      if (best) return null; // ambiguous scored tie — never guess
    }

    // v2.4.0: ORDER/TIMING FALLBACK (weak-text prompts only). The
    // caller opts in ONLY when this task is the account's single
    // in-flight submission and supplies the pre-submit snapshot +
    // claimed set. The first tile that is in NEITHER set is the new
    // tile this submission created — text match is impossible for a
    // weak prompt, so position/timing is the identity. Without the
    // opt-in (check-only recovery, multi-task windows) the scan stays
    // scored-only and returns null rather than guess.
    const fb = opts && opts.newTileFallback;
    if (fb && tileIdentity.isWeakTextPrompt(promptWords)) {
      const pre = fb.preExistingFingerprints || new Set();
      const claimed = fb.claimedFingerprints || new Set();
      for (const t of tiles) {
        const fp = tileIdentity.tileFingerprint(t.aria, '');
        if (!fp) continue;
        if (pre.has(fp) || claimed.has(fp)) continue;
        const url = await this._extractTileMediaUrl(
          { lockedTileFingerprint: fp }, t.tileIndex, isImage
        );
        return { tileIndex: t.tileIndex, fingerprint: fp, url: url || null, viaFallback: true };
      }
    }
    return null;
  }

  /**
   * v2.1.0: scroll the project grid's scrollable ancestor through its
   * full height and back, so Flow's virtualized grid MOUNTS tiles that
   * sit below the fold — the plain canvas read (and _scanGridForPrompt)
   * can only see mounted tiles, and a fresh render can sit unmounted
   * while its owner task looks "dropped". Best-effort: any failure just
   * leaves the grid where it was.
   */
  async _sweepGridScroll() {
    if (!this.page || this.page.isClosed()) return;
    try {
      await this.page.evaluate(async () => {
        const tile = document.querySelector('flow-grid-tile-container');
        let el = tile ? tile.parentElement : null;
        for (let i = 0; i < 8 && el; i++) {
          if (el.scrollHeight > el.clientHeight + 10) break;
          el = el.parentElement;
        }
        if (!el) return;
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        const steps = [0.33, 0.66, 1, 0.5, 0];
        for (const f of steps) {
          el.scrollTop = Math.round(max * f);
          await new Promise(r => setTimeout(r, 350));
        }
      });
    } catch (e) {}
  }

  /**
   * v2.1.0 — IN-RUN stall recovery for ONE submitted task: sweep the
   * grid (mount virtualized tiles), then run the same fingerprint scan
   * the boot-time check-only recovery uses. When the task's own tile is
   * found, bind it (locked fingerprint + claimed) so the monitor's
   * normal assignment/ready/download machinery takes over from the
   * next poll. A fingerprint that was already on the grid BEFORE this
   * task was submitted is never claimed — that tile belongs to an
   * older prompt, not to this paid render.
   * Returns true when this task's tile was found and bound.
   */
  async _recoveryScanForTask(task, isImageMode = false) {
    if (!task || !this.page || this.page.isClosed()) return false;
    await this._sweepGridScroll();
    let scan = null;
    try {
      // v2.4.0: a weak-text task ("make a video") can never pass the
      // scored scan. When it is the ONLY unfinished task in the
      // current monitor window, the scan may bind the one tile that
      // is neither in its pre-submit snapshot nor already claimed —
      // the same fenced rule as assignTiles Pass 3.
      const scanOpts = {};
      const window = Array.isArray(this._monitorTasks) ? this._monitorTasks : null;
      if (window) {
        const unfinished = window.filter(t => t && !t.downloaded && !t.completed);
        if (unfinished.length === 1 && unfinished[0] === task) {
          scanOpts.newTileFallback = {
            preExistingFingerprints: task._preExistingFp || new Set(task.preExistingFingerprints || []),
            claimedFingerprints: this.claimedTileFingerprints
          };
        }
      }
      scan = await this._scanGridForPrompt(task.promptText, isImageMode, scanOpts);
    } catch (e) {
      scan = null;
    }
    if (!scan) return false;
    const preExisting = task._preExistingFp || new Set(task.preExistingFingerprints || []);
    if (preExisting.has(scan.fingerprint)) return false;
    if (this.claimedTileFingerprints.has(scan.fingerprint) && task.lockedTileFingerprint !== scan.fingerprint) {
      return false; // another live task already owns this tile
    }
    task.lockedTileFingerprint = scan.fingerprint;
    if (typeof scan.tileIndex === 'number') task.tileIndex = scan.tileIndex;
    this.claimedTileFingerprints.add(scan.fingerprint);
    this.log(`[Prompt #${task.promptIndex + 1}] Recovery scan me is prompt ki tile project me mil gayi — ab usi tile ka render/download aage badhega.`, 'success');
    return true;
  }

  /**
   * v1.8.0 — reconcile ONE recovered task (its prompt may already have
   * been submitted before the app closed). The video is looked up in
   * the open project and downloaded through the SAME identity-strict
   * paths as live tasks; the prompt is NEVER re-submitted here.
   * Returns { found:false } | { found:true, downloaded:boolean }.
   */
  async reconcileRecoveredTask(task, downloadFolder, settings) {
    const isImage = !!(settings && settings.type === 'Image');
    const scan = await this._scanGridForPrompt(task.promptText, isImage);
    if (!scan) return { found: false };
    task.lockedTileFingerprint = scan.fingerprint;
    task.tileIndex = scan.tileIndex;
    if (scan.url) task.completedVideoUrl = scan.url;
    // v2.7.0: recovery bhi ab poori kai-ranneeti wali download se
    // hoti hai (backend pehle, phir stream/tile-src + native UI ke do roop) — tile par
    // URL na ho tab bhi native roop se file aa sakti hai. Prompt
    // yahan KABHI dobara submit nahi hota (check-only usool barkarar).
    let ok = false;
    try { ok = (await this.downloadTaskMedia(task, downloadFolder, settings, scan.tileIndex)).ok; } catch (e) {}
    if (!ok) {
      try { await this._returnToProjectGrid(); } catch (e) {}
    }
    return { found: true, downloaded: !!ok };
  }

  /**
   * v2.32.1: the stable identity of a task for save-path ownership.
   * taskId (the queue row id) is assigned by the pool before any
   * download and survives every retry round and restart rebuild;
   * videoId is the fallback for engine-only task objects.
   */
  _taskKey(task) {
    if (!task) return null;
    return task.taskId || task.id || task.videoId || null;
  }

  /**
   * v2.32.1: the set of paths THIS task may re-save onto — only the
   * files this very task already saved (its earlier download rounds)
   * plus the path recorded on the task object itself. Anything saved
   * by a DIFFERENT task is deliberately absent, so the pickers move
   * this save to a distinct name instead of overwriting a sibling.
   */
  _taskOwnPaths(task) {
    const own = new Set();
    const key = this._taskKey(task);
    if (key && this.savedPathOwners) {
      for (const [p, owner] of this.savedPathOwners) {
        if (owner === key) own.add(p);
      }
    }
    if (task && task._ownSavePath) own.add(task._ownSavePath);
    return own;
  }

  /**
   * v2.32.1: record a completed save — the session set (kept for
   * its other readers) AND the per-task ownership the pickers now
   * consult, plus the path recorded on the task object itself, so
   * a retry of the SAME task lands back on its own file name
   * instead of taking a new suffix on every attempt.
   */
  _recordSavedPath(task, absPath) {
    this.savedThisSession.add(absPath);
    const key = this._taskKey(task);
    if (key) this.savedPathOwners.set(absPath, key);
    if (task) task._ownSavePath = absPath;
  }

  /**
   * v1.7.0: choose a save path that never silently overwrites a file
   * this engine did not itself save (e.g. a previous run's video with
   * the same scene001.mp4 name) — suffix _2, _3, … instead.
   * v2.32.1: the reuse exemption now comes from `ownPaths` — ONLY
   * the saving task's own earlier saves (see _taskOwnPaths). It used
   * to read the session-wide savedThisSession set, which let a
   * different task with the same computed name "reuse" (overwrite)
   * a sibling's file.
   */
  _pickFreeFilePath(downloadFolder, fileName, ownPaths) {
    const own = ownPaths && typeof ownPaths.has === 'function' ? ownPaths : new Set();
    const first = path.join(downloadFolder, fileName);
    if (!fs.existsSync(first) || own.has(first)) return first;
    const ext = path.extname(fileName);
    const base = ext ? fileName.slice(0, -ext.length) : fileName;
    for (let n = 2; n < 1000; n++) {
      const alt = path.join(downloadFolder, `${base}_${n}${ext}`);
      if (!fs.existsSync(alt) || own.has(alt)) return alt;
    }
    return first;
  }

  /**
   * v2.3.0: pick the actual save path for a computed file name. In
   * TAG naming mode the duplicate suffix is the deterministic `-2`,
   * `-3`… (engine/tagNaming.js); every other mode keeps the legacy
   * `_2` picker untouched.
   * v2.32.1: both pickers receive ONLY the saving task's own paths
   * as reusable — never the whole session's (see _taskOwnPaths).
   */
  _resolveSavePath(downloadFolder, fileName, settings, task) {
    const own = this._taskOwnPaths(task);
    if (settings && settings.namingPattern === 'tag') {
      return tagNaming.pickFreeTagPath(downloadFolder, fileName, (p) => fs.existsSync(p), own);
    }
    return this._pickFreeFilePath(downloadFolder, fileName, own);
  }

  // File naming: strictly by prompt index (001-based), as in V2.
  _fileNameForTask(task, settings) {
    const isImageMode = (settings.type === 'Image');
    const fileExt = isImageMode ? 'png' : 'mp4';
    const indexNum = task.promptIndex + 1;
    const paddedIndex = String(indexNum).padStart(3, '0');
    const pattern = settings.namingPattern || 'scene';
    const prefix = sanitizeFilePart(settings.customNamingPrefix, 'scene');

    // v2.3.0 (default): the file is named by the prompt's TAG —
    // `#00-01` -> `00-01.mp4`, `scene3` -> `scene3.mp4`. A task
    // without a usable tag falls back to the scene pattern below.
    if (pattern === 'tag') {
      const fromTag = tagNaming.fileNameForTag(task && task.tag, fileExt);
      if (fromTag) {
        // v2.32.1: when the RUN carries more than one task with
        // this same tag (the pool counts them into
        // settings.tagNameGroups — e.g. one MCP run tag stamped on
        // every prompt), the plain tag name would be IDENTICAL for
        // every task. Each task's file is therefore numbered by its
        // own prompt number: <tag>-1.mp4 … <tag>-5.mp4 — distinct
        // per prompt no matter which download finishes first. A
        // single-task tag group keeps exactly <tag>.mp4, and
        // distinct per-prompt tags are untouched.
        const groups = settings && settings.tagNameGroups;
        if (groups && Number(groups[fromTag]) > 1) {
          return tagNaming.numberedTagFileName(fromTag, (task && task.promptIndex || 0) + 1);
        }
        return fromTag;
      }
    }

    if (pattern === 'numeric') return `${paddedIndex}.${fileExt}`;
    if (pattern === 'clip') return `clip${paddedIndex}.${fileExt}`;
    if (pattern === 'shot') return `shot${paddedIndex}.${fileExt}`;
    if (pattern === 'video') return isImageMode ? `image${paddedIndex}.${fileExt}` : `video${paddedIndex}.${fileExt}`;
    if (pattern === 'custom') return `${prefix}${paddedIndex}.${fileExt}`;
    if (pattern === 'prompt') {
      const clean = (task.promptText || 'prompt').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
      return `${paddedIndex}_${clean}.${fileExt}`;
    }
    return `scene${paddedIndex}.${fileExt}`;
  }

  /**
   * AUDIT FIX #6 — identity gate. A URL may be used for a task ONLY when it
   * was extracted from that task's own claimed tile (task.completedVideoUrl)
   * and it is neither a pre-existing stream nor already consumed by another
   * task. There is deliberately NO "latest fresh URL" fallback.
   */
  _isTaskOwnUrl(task, url) {
    if (!url || typeof url !== 'string') return false;
    if (task.preExistingVideoUrls && task.preExistingVideoUrls.has(url)) return false;
    if (this.consumedVideoUrls && this.consumedVideoUrls.has(url)) return false;
    return true;
  }

  _markTaskUrlConsumed(task, url) {
    if (url) {
      if (!this.consumedVideoUrls) this.consumedVideoUrls = new Set();
      this.consumedVideoUrls.add(url);
    }
  }

  /**
   * v2.48.70 (ITEM A/D): is task ki EXPECTED duration
   * (seconds) — pehle task ki apni kitab (Item D:
   * birth par darj expected_duration_sec, warna usi
   * row ka duration), phir run ke settings. Kuch na
   * mile to 0 (tasdeeq 'no-expectation' par chalegi —
   * header hi darwaza rahega).
   */
  _expectedDurationSec(task, settings) {
    try {
      const t = task && typeof task === 'object' ? task : {};
      const direct = Number(t.expected_duration_sec || t.expectedDurationSec);
      if (Number.isFinite(direct) && direct > 0) return direct;
      const fromRow = downloadFetch.parseDurationSeconds(t.duration);
      if (fromRow > 0) return fromRow;
      const fromSettings = downloadFetch.parseDurationSeconds(settings && settings.duration);
      if (fromSettings > 0) return fromSettings;
    } catch (e) {}
    return 0;
  }

  async _saveBufferForTask(task, downloadFolder, settings, buffer, sourceUrl, raceRoute) {
    if (!fs.existsSync(downloadFolder)) {
      fs.mkdirSync(downloadFolder, { recursive: true });
    }
    // v2.48.30 (POST-CLICK RACE ki hifazat): ek task = EK hi
    // saved file. Race me do raaste (app ka server fetch aur
    // Chrome ka blob download) ek saath khatam ho sakte hain —
    // jo pehle mediaSaved kar gaya, dusre ka save yahin ruk
    // jata hai; dohri file aur dohri kitab-bandhi mumkin hi
    // nahi rehti.
    if (task.mediaSaved) {
      this.log(`[FAST-DL] [Prompt #${task.promptIndex + 1}] A second save was refused — this video is already saved (${task.fileName || 'file'}); no duplicate will be written.`, 'warn');
      return false;
    }
    // v2.48.50 (MEGA PACK item 7 — ROUTE RACE): is
    // attempt me headless aur mainpage raaste PARALLEL
    // chalte hain; file SIRF wahi likhega jo pehle is
    // darwaze par dawa (claim) kare. Ye hissa async
    // hone se pehle ka hai — dawa ek hi pal me bandhta
    // hai, is liye do dawe mumkin nahi. Haar kar nikalne
    // wala apna dawa CHHOD deta hai (releaseRaceClaim —
    // neeche har nakam wapsi par), taaki dusra rasta
    // apne achhe buffer ke saath phir dawa kar sake.
    // raceRoute na diya ho (aam sequential bulawa) to
    // ye hissa bilkul nahi chalta — vyavhaar aaj jaisa.
    const raceClaimedHere = !!(raceRoute && task._raceActive && !task._raceWonBy);
    if (raceRoute && task._raceActive) {
      if (task._raceWonBy && task._raceWonBy !== raceRoute) {
        task._saveRejectedReason = 'route-race';
        return false;
      }
      if (!task._raceWonBy) task._raceWonBy = raceRoute;
    }
    const releaseRaceClaim = () => {
      try {
        if (raceClaimedHere && task._raceWonBy === raceRoute) task._raceWonBy = null;
      } catch (e) {}
    };
    const isImageMode = !!(settings && settings.type === 'Image');
    task._saveRejectedReason = null;
    // v2.48.29 (QUALITY GATE): buffer asal video ho lekin
    // duration ke hisaab se size floor se neeche ho to ye
    // PREVIEW-quality hai — final save KABHI nahi. FASTTEST3
    // (2026-11-02, ffprobe-sabit): tile-src wali preview encode
    // 80,843 bytes / 3.97s (~163 kbps) "safal" save ho gayi thi,
    // asal Original (1.2 MB, ~2.4 Mbps) se ~15 guna halki. Ab
    // aisi file yahin rukti hai: na file banti hai, na success
    // ginati hoti hai — raaste aage chalte hain aur kuch behtar
    // na mile to task park (needs_check) hota hai, bilkul baaki
    // nakam raaston ki tarah. Sirf video tasks par (tasveeron
    // par nahi). Floor ka hisaab downloadFetch ke pure helpers
    // me hai (unit-tested); wajah task._saveRejectedReason me
    // bulane wale ke liye rehti hai.
    if (!isImageMode && buffer && downloadFetch.looksLikeVideoBuffer(buffer)) {
      const floorBytes = downloadFetch.minBytesForDuration(settings && settings.duration);
      if (buffer.length < floorBytes) {
        // v2.48.70 (ITEM A): floor se neeche wale buffer
        // ka faisla ab SIZE se nahi, file ki apni
        // DURATION se hota hai — 2026-11-07 ko sabit
        // hua ke Flow ke chhote encode mukammal
        // full-duration files hote hain (583,688B =
        // 10.0078s; 116,200B = 3.9706s). Tasdeeq pass
        // ho to save hota hai ([ROOT] small-save line
        // ke saath); fail ho (short-duration /
        // unparseable) to purana quality-gate inkaar
        // bilkul waisa hi. .29 wali size-taabeer is
        // pack me duration-proof se badal gayi hai.
        const expectedSec = this._expectedDurationSec(task, settings);
        const verification = saveGuard.bodyVerification({ buffer, headerOk: true, expectedSec });
        // Sirf ASAL duration-match ('ok') hi floor ki
        // jagah le sakta hai — 'no-expectation' (koi
        // expected duration hi nahi) par purana inkaar
        // hi rehta hai: bina kasauti ke chhoti file
        // kabhi seedha save nahi hoti.
        if (verification.ok && verification.reason === 'ok') {
          this.log(`[ROOT] small-save accepted prompt=${task.promptIndex + 1} bytes=${buffer.length} dur=${verification.durationSec}s expected=${expectedSec}s via=${raceRoute || 'sequential'}`, 'success');
        } else {
          const durSec = downloadFetch.parseDurationSeconds(settings && settings.duration);
          const durLabel = durSec ? `${durSec}s` : String((settings && settings.duration) || 'unknown');
          this.log(`[QUALITY-GATE] [Prompt #${task.promptIndex + 1}] preview-quality buffer rejected (${buffer.length} < floor ${floorBytes} for ${durLabel}; verification=${verification.reason}) — routes continue`, 'warn');
          task._saveRejectedReason = 'quality-gate';
          releaseRaceClaim();
          return false;
        }
      }
    }
    // v2.48.35 (CONTENT-HASH GUARD): is run me kisi AUR task
    // ke naam par save hue bytes ke HU-BAHU yehi bytes dobara
    // aaye hain to ye is task ki video ho hi nahi sakti —
    // save reject, file likhi hi nahi jati, raaste aage
    // chalte hain. ZEROCLICK2 (v2.48.34) ka cross-task
    // contamination yahin rukta hai: registry wala rasta
    // Prompt #1 ke bytes Prompt #2 ke naam par de raha tha
    // aur koi jaanch use pakad nahi rahi thi. Apne hi task
    // ki dobara save (race / retry) jaiz hai — faisla
    // saveGuard ke khalis hisaab se hota hai, hash kabhi
    // log nahi hota.
    const bufHash = (!isImageMode && buffer && buffer.length > 0) ? saveGuard.contentHash(buffer) : null;
    if (bufHash) {
      const verdict = saveGuard.checkDuplicate(this._runSavedContentHashes, this._taskKey(task), bufHash);
      if (verdict.duplicate) {
        this.log(`[GUARD] duplicate-content rejected for Prompt #${task.promptIndex + 1} — fetched bytes are identical to Prompt #${verdict.otherPromptIndex + 1}'s saved file`, 'warn');
        task._saveRejectedReason = 'duplicate-content';
        releaseRaceClaim();
        return false;
      }
    }
    // v1.7.0: never silently overwrite a file this engine did not
    // itself save — a previous run's same-named video stays intact
    // and this save takes a suffixed name.
    const finalSavedFilePath = this._resolveSavePath(downloadFolder, this._fileNameForTask(task, settings), settings, task);
    const fileName = path.basename(finalSavedFilePath);
    task.fileName = fileName;
    task.filePath = finalSavedFilePath;

    const fd = fs.openSync(finalSavedFilePath, 'w');
    fs.writeSync(fd, buffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    // Validate the saved file is a real, probeable video (when ffprobe is
    // available). A corrupt payload must not count as a completion.
    if (!isImageMode) {
      const valid = await FFmpegService.verifyVideoFile(finalSavedFilePath, 20000);
      if (!valid) {
        try { fs.unlinkSync(finalSavedFilePath); } catch (e) {}
        this.log(`The saved file ${fileName} failed the video check — this download has been treated as failed.`, 'warn');
        releaseRaceClaim();
        return false;
      }
      // v2.48.30: verify ke intezaar ke dauraan koi dusra
      // rasta (race ka browser download) is task ko pehle hi
      // save kar chuka ho to apni file hata do — dohri
      // kitab-bandhi kabhi nahi.
      if (task.mediaSaved) {
        try { fs.unlinkSync(finalSavedFilePath); } catch (e) {}
        this.log(`[FAST-DL] [Prompt #${task.promptIndex + 1}] This save finished second in the race — the duplicate file was removed; the first save stands.`, 'warn');
        releaseRaceClaim();
        return false;
      }
    }

    const sizeMb = (buffer.length / (1024 * 1024)).toFixed(2);
    this.log(`Video saved: ${fileName} (${sizeMb} MB).`, 'success');
    this._logNetBigWindow(task, task.startTime || 0);

    task.downloaded = true;
    task.completed = true;
    // v2.7.0: mediaSaved hi ASLI success ka nishan hai (fail hue task
    // bhi settled mark ke liye downloaded=true lete hain — ginati ke
    // liye wahi purani galti jhooti success line bana rahi thi).
    task.mediaSaved = true;
    // v2.48.50 (item 7): race jeetne wale save ka asal
    // URL darj — attempt ka aakhri hisaab
    // completedVideoUrl ko isi par seedha karega (haar
    // kar save karne wale raste ne apna URL pehle rakha
    // ho to bhi jeet isi ki hai).
    if (raceRoute && task._raceActive && task._raceWonBy === raceRoute) {
      task._raceSavedUrl = sourceUrl || null;
    }
    this._recordSavedPath(task, finalSavedFilePath);
    // v2.48.35 (GUARD): kamyaab save ki hash-kitab bandhi —
    // is run ke baaki tasks ke liye yahi hisaab duplicate
    // jaanch ka langar hai.
    if (bufHash) saveGuard.recordSave(this._runSavedContentHashes, this._taskKey(task), bufHash, task.promptIndex);
    this._markTaskUrlConsumed(task, sourceUrl);
    if (sourceUrl && this.capturedVideoBuffers && this.capturedVideoBuffers.has(sourceUrl)) {
      this.capturedVideoBytes -= this.capturedVideoBuffers.get(sourceUrl).length;
      this.capturedVideoBuffers.delete(sourceUrl);
    }

    // --- v2.48.70 + hotfix: NEW DOWNLOAD HELPERS ---
    // Verify saved file with duration check (download-verify.js)
    try {
      if (!isImageMode && task.filePath) {
        const fileStats = fs.statSync(task.filePath);
        const verifyResult = this._downloadHelpers.verify.verifySavedFile({
          taskKey: task.taskId || task.videoId || null,
          filePath: task.filePath,
          expectedSec: this._expectedDurationSec(task, settings),
          fileSizeBytes: fileStats.size
        });
        this.log(this._downloadHelpers.verify.saveVerifyLine({
          taskKey: task.taskId || task.videoId || null,
          fileName: task.fileName,
          method: verifyResult.method,
          durationSec: verifyResult.durationSec,
          expectedSec: verifyResult.expectedSec,
          reason: verifyResult.reason,
          ok: verifyResult.ok
        }), 'info');
        if (!verifyResult.ok) {
          this.log(`[ROOT] save-verify rejected task=${task.taskId || task.videoId} — not counting as success`, 'warn');
        }
      }
    } catch (e) {}

    const result = {
      filePath: finalSavedFilePath,
      fileName,
      fileSizeMb: sizeMb + ' MB',
      videoUrl: sourceUrl || ''
    };
    task.result = result;
    this.onTaskCompleted(task, result);

    const elapsed = Math.round((Date.now() - task.startTime) / 1000) + 's';
    this.onVideoCompleted({
      id: task.videoId,
      prompt: task.promptText,
      accountName: this.currentAccount.name,
      videoUrl: `file:///${finalSavedFilePath.replace(/\\/g, '/')}`,
      filePath: finalSavedFilePath,
      downloadFolder: downloadFolder,
      timestamp: new Date().toLocaleTimeString(),
      quality: settings.quality || '360p',
      duration: settings.duration || '6s',
      aspectRatio: settings.aspectRatio || '9:16',
      elapsed: elapsed
    });

    return true;
  }

  /**
   * v2.38.0: per-attempt REAL error record for the direct fetch.
   * downloadFromCapturedStream used to return a bare boolean — the
   * HTTP status / exception that decided the outcome died inside
   * the call, and the Activity detail (built from strategy notes)
   * could only ever say "(the link may have expired)". Now every
   * sub-step appends a plain step record to task._lastFetchSteps,
   * and the strategy notes carry downloadFetch.summarizeFetchSteps'
   * compact line, so the actual cause survives into the Activity
   * detail and the download ledger.
   */
  _noteFetchStep(task, step) {
    if (!task) return;
    if (!Array.isArray(task._lastFetchSteps)) task._lastFetchSteps = [];
    task._lastFetchSteps.push(step);
    if (task._lastFetchSteps.length > 16) task._lastFetchSteps.splice(0, task._lastFetchSteps.length - 16);
  }

  /** Compact summary of the LAST direct-fetch call's failures ('' when none). */
  _fetchSummary(task) {
    try { return downloadFetch.summarizeFetchSteps(task && task._lastFetchSteps); } catch (e) { return ''; }
  }

  /**
   * v2.48.9: the session cookie header for direct fetches, cached
   * per browser launch (45s). downloadFromCapturedStream used to
   * re-read the page's cookies (two CDP calls) on EVERY download —
   * while the page was busy rendering several tiles, those calls
   * queued behind the monitor's own page reads and the download
   * step visibly crawled (measured on the owner's PC: 19–39s from
   * "backend link found" to "file saved" for 2.6–4.3 MB files).
   * Session cookies do not change second-to-second; the cache is
   * dropped at every launch (new account / new session).
   */
  async _sessionCookieHeader(targetUrl) {
    const now = Date.now();
    if (this._cookieHeaderCache && (now - this._cookieHeaderCache.at) < 45000) {
      return this._cookieHeaderCache.header;
    }
    let header = null;
    if (this.page && !this.page.isClosed()) {
      const jar = new Map();
      for (const scope of [null, targetUrl]) {
        try {
          const cs = scope ? await this.page.cookies(scope) : await this.page.cookies();
          for (const c of cs || []) jar.set(`${c.name}@${c.domain || ''}`, c);
        } catch (e) {}
      }
      header = [...jar.values()].map(c => `${c.name}=${c.value}`).join('; ');
    }
    if (header) this._cookieHeaderCache = { header, at: now };
    return header;
  }

  /**
   * v2.48.10: fetch a whole file as PARALLEL byte ranges (the
   * plan comes from downloadFetch.planRanges). Returns the
   * assembled Buffer, or null when ranges are not supported /
   * any chunk fails — the caller then uses the plain GET, so
   * this can only ever make a download faster, never break one.
   * A 1-byte probe (Range: bytes=0-0) learns the total size from
   * Content-Range; chunks then run concurrently because a single
   * connection to the media edge is measurably throttled
   * (~1 MB/s in TEST488/TEST489) while the owner's browser
   * downloads the same file at full speed.
   */
  async _fetchBufferRanged(targetUrl, cookieHeader, userAgent) {
    const baseHeaders = {
      'Cookie': cookieHeader || '',
      'User-Agent': userAgent,
      'Referer': 'https://flow.google.com/'
    };
    const getRange = async (range, timeoutMs) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutMs);
      try {
        return await fetch(targetUrl, {
          headers: { ...baseHeaders, 'Range': range },
          redirect: 'follow',
          signal: ctrl.signal
        });
      } finally {
        clearTimeout(timer);
      }
    };
    let total = 0;
    try {
      const probe = await getRange('bytes=0-0', 15000);
      if (probe.status !== 206) {
        try { await probe.arrayBuffer(); } catch (e) {}
        return null;
      }
      const cr = String(probe.headers.get('content-range') || '');
      const m = /\/(\d+)\s*$/.exec(cr);
      total = m ? parseInt(m[1], 10) : 0;
      try { await probe.arrayBuffer(); } catch (e) {}
    } catch (e) {
      return null;
    }
    if (!total || total < downloadFetch.RANGE_MIN_BYTES) return null;
    const ranges = downloadFetch.planRanges(total, downloadFetch.RANGE_CHUNK_COUNT);
    if (ranges.length < 2) return null;
    const parts = await Promise.all(ranges.map(async (r) => {
      try {
        const resp = await getRange(`bytes=${r.start}-${r.end}`, 60000);
        if (resp.status !== 206) return null;
        const buf = Buffer.from(await resp.arrayBuffer());
        return buf.length === (r.end - r.start + 1) ? buf : null;
      } catch (e) {
        return null;
      }
    }));
    if (parts.some(p => !p)) return null;
    const joined = Buffer.concat(parts);
    return joined.length === total ? joined : null;
  }

  /** The browser session's real User-Agent (cached per engine). */
  async _realUserAgent() {
    if (this._browserUA) return this._browserUA;
    let ua = null;
    try {
      if (this.page && !this.page.isClosed()) {
        ua = await downloadGuard.withTimeout(this.page.evaluate(() => navigator.userAgent), 5000, 'user-agent read');
      }
    } catch (e) { ua = null; }
    this._browserUA = downloadFetch.resolveUserAgent(ua);
    return this._browserUA;
  }

  /**
   * Download path A: the intercepted CDN stream / direct fetch — but ONLY
   * for the URL extracted from this task's own claimed tile.
   */
  async downloadFromCapturedStream(task, downloadFolder, settings) {
    const targetUrl = task.completedVideoUrl;
    if (!this._isTaskOwnUrl(task, targetUrl)) {
      // No identity-proven URL for this task. Never substitute another
      // task's stream (audit fix #6).
      // v2.7.0: v2.6.0 tak ye rasta yahin CHUP-CHAAP mar jata tha — koi
      // log line nahi. Owner ke burst run me chaaron download isiliye
      // "sirf native-menu koshish" jaise dikhe: stream wala rasta ya
      // to URL na milne par yahin ruk gaya, ya neeche fail hua — bina
      // kisi saboot ke. Ab har rukawat ki wajah log hoti hai.
      this.log(`[Prompt #${task.promptIndex + 1}] Direct stream download is not possible: ${!targetUrl
        ? 'no media URL was found on this task\'s tile at all'
        : 'the URL that was found was not proven to be this task\'s own (an old used one, or another tile\'s — stopped for safety)'}.`, 'warn');
      return false;
    }

    this.log(`[Prompt #${task.promptIndex + 1}] The direct download of the video is running — only from this prompt's own video stream…`, 'info');

    // v2.38.0: this call's own error record starts fresh — the
    // strategy note written after the call must describe THIS
    // call's outcome, not an earlier one's.
    task._lastFetchSteps = [];
    let savedBuffer = null;

    // v2.48.29 (HTML-POISON): ye link is run me pehle hi HTML
    // page de chuka hai to dobara network par haath hi NAHI
    // padta — FASTTEST3 me ek hi asb link chaar dafa fetch
    // hokar har dafa wahi HTML laya tha (~32s zaaya). Saare
    // fetch raaste isi function se guzarte hain, is liye
    // darwaza yahin kaafi hai.
    if (targetUrl.startsWith('http') && this._htmlPoisonGuard && this._htmlPoisonGuard.isPoisoned(targetUrl)) {
      this._noteFetchStep(task, { step: 'poison-skip', ok: false, error: 'this link already returned an HTML page in this run — it was not fetched again' });
      this.log(`[Prompt #${task.promptIndex + 1}] This link already returned an HTML page earlier in this run — it will NOT be fetched again. The remaining routes will be tried.`, 'warn');
      return false;
    }

    // v2.48.12: hot paths (backend fetch / background queue) skip
    // the captured buffer too — the owner's standing order is
    // that the file comes from the BACKEND LINK, fetched by the
    // app itself; the buffer is bytes the page streamed for its
    // preview, which land only when the page's own stream
    // finishes. The download-retry path (flag unset) keeps it.
    if (!task._backendHotFetch && this.capturedVideoBuffers && this.capturedVideoBuffers.has(targetUrl)) {
      savedBuffer = this.capturedVideoBuffers.get(targetUrl);
      this._noteFetchStep(task, { step: 'captured-buffer', ok: true });
    }

    // Blob URLs can only be materialized inside the page — and only from
    // this task's own tile, located by FINGERPRINT (v1.5.0; the old raw
    // index pointed at a neighbour's tile after any new submission).
    const blobTileIndex = (!savedBuffer && targetUrl.startsWith('blob:'))
      ? await this._resolveTileIndexByFingerprint(task.lockedTileFingerprint)
      : -1;
    if (!savedBuffer && targetUrl.startsWith('blob:') && blobTileIndex >= 0 && this.page && !this.page.isClosed()) {
      try {
        // v2.30.0: page.evaluate has NO built-in timeout — on a busy
        // renderer this await never came back and the download (and
        // the whole run behind it) stalled. Hard deadline now.
        const base64 = await downloadGuard.withTimeout(this.page.evaluate(async ({ idx }) => {
          const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
          const target = containers[idx];
          if (!target) return null;
          const vid = target.querySelector('video');
          const src = vid ? (vid.src || vid.currentSrc) : null;
          if (!src || !src.startsWith('blob:')) return null;
          try {
            const r = await fetch(src);
            const b = await r.blob();
            return await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = () => resolve(null);
              reader.readAsDataURL(b);
            });
          } catch (e) {
            return null;
          }
        }, { idx: blobTileIndex }), 45000, 'video data read');
        if (base64 && base64.includes('base64,')) {
          savedBuffer = Buffer.from(base64.split('base64,')[1], 'base64');
        } else {
          this._noteFetchStep(task, { step: 'blob-read', ok: false, error: 'the tile\'s blob data could not be read' });
        }
      } catch (e) {
        const t = plainError.translateError(e);
        this._noteFetchStep(task, { step: 'blob-read', ok: false, error: t.raw || t.plain });
        this.log(`Video data nikalne me ek note: ${t.plain}.`, 'warn', { rawError: t.raw });
      }
    }

    const minSizeDl = (settings.type === 'Image') ? 5000 : 50000;
    if (!savedBuffer && targetUrl.startsWith('http')) {
      // v2.10.0: cookie ka scope theek karo. page.cookies() BINA url
      // diye sirf maujooda page (flow.google.com) ke scope ke cookies
      // deta hai — media host (googleusercontent.com) ke cookies usme
      // NAHI aate, aur signed FIFE link bina un cookies ke 403 de
      // sakta hai (owner ke v2.8.0 PC run me captured-stream theek
      // yahin mara: "URL apna tha, lekin file ka data nahi ban
      // paya"). Ab dono scopes ke cookies mila kar bhejte hain, aur
      // server ka HTTP status bhi log hota hai — khamoshi khatam.
      // v2.38.0: the direct fetch is now a small RETRY LOOP, not a
      // single shot. A freshly minted signed (FIFE) link can refuse
      // the very first GET (HTTP 403/404 while the object is still
      // propagating) or the connection can reset — and the SAME
      // account + route then succeeds moments later (the owner's
      // intermittent "download fail" pattern, incl. the first
      // headless run on 2026-10-27). Transient failures now retry
      // inside this call (downloadFetch's schedule) BEFORE the
      // strategy is allowed to die; final failures fall through to
      // the in-browser fetch below, exactly as before. Cookies are
      // rebuilt per attempt and the User-Agent is the browser
      // session's OWN (the cookies and the UA now always describe
      // the same browser — previously the UA was a hardcoded
      // Chrome/133 string). Retrying a FETCH can never resubmit the
      // prompt: this function only ever GETs an existing file.
      const maxFetchAttempts = downloadFetch.NODE_FETCH_MAX_ATTEMPTS;
      for (let fetchTry = 1; fetchTry <= maxFetchAttempts && !savedBuffer && !this.isStopping; fetchTry++) {
        let retry = false;
        try {
          let cookieHeader = task.preCapturedCookieHeader || null;
          if (!cookieHeader) {
            // v2.48.9: cached per launch — no fresh page round
            // trips in the middle of a download (see
            // _sessionCookieHeader).
            cookieHeader = await this._sessionCookieHeader(targetUrl);
          }
          const userAgent = task.preCapturedUserAgent || (await this._realUserAgent());
          // v2.48.10: FIRST attempt only — try the parallel range
          // download before the plain GET (see _fetchBufferRanged).
          // Success skips the plain GET entirely; any failure
          // falls through to it unchanged.
          if (fetchTry === 1) {
            const ranged = await this._fetchBufferRanged(targetUrl, cookieHeader, userAgent);
            if (ranged && ranged.length >= minSizeDl) {
              savedBuffer = ranged;
              this._noteFetchStep(task, { step: 'node-fetch-ranged', ok: true });
              this.log(`[Prompt #${task.promptIndex + 1}] Direct download: the file was fetched in ${downloadFetch.RANGE_CHUNK_COUNT} parallel parts (${(ranged.length / 1048576).toFixed(1)} MB).`, 'info');
            }
          }
          if (savedBuffer) break;
          // v2.30.0: this fetch used to carry NO AbortSignal — a
          // stalled connection could hold the download step (and the
          // render monitor behind it) indefinitely. 60s abort now;
          // the orchestrator-level guard bounds the whole step too.
          const fetchAbort = new AbortController();
          const fetchTimer = setTimeout(() => { try { fetchAbort.abort(); } catch (e) {} }, 60000);
          let resp;
          try {
            resp = await fetch(targetUrl, {
              headers: {
                'Cookie': cookieHeader || '',
                'User-Agent': userAgent,
                'Referer': 'https://flow.google.com/'
              },
              redirect: 'follow',
              signal: fetchAbort.signal
            });
          } finally {
            clearTimeout(fetchTimer);
          }

          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            if (buf.length >= minSizeDl) {
              savedBuffer = buf;
              this._noteFetchStep(task, { step: 'node-fetch', ok: true });
            } else {
              this._noteFetchStep(task, { step: 'node-fetch', ok: false, error: `response was only ${buf.length} bytes` });
              this.log(`[Prompt #${task.promptIndex + 1}] Direct download: a response came from the server but the data was very small (${buf.length} bytes) — not treated as the actual video.`, 'warn');
            }
          } else {
            this._noteFetchStep(task, { step: 'node-fetch', ok: false, status: resp.status });
            retry = downloadFetch.isRetryableStatus(resp.status);
            this.log(`[Prompt #${task.promptIndex + 1}] Direct download: the server refused (HTTP ${resp.status})${retry && fetchTry < maxFetchAttempts ? ' — the direct fetch will be tried again in a moment' : ' — now a fetch from inside the browser will be tried'}.`, 'warn');
          }
        } catch (e) {
          const t = plainError.translateError(e);
          this._noteFetchStep(task, { step: 'node-fetch', ok: false, error: t.raw || t.plain });
          retry = downloadFetch.isRetryableFetchError(e);
          this.log(`A problem came up fetching Prompt #${task.promptIndex + 1}'s video file: ${t.plain}.`, 'warn', { rawError: t.raw });
        }
        if (!savedBuffer && retry && fetchTry < maxFetchAttempts && !this.isStopping) {
          const waitMs = downloadFetch.retryDelayMs(fetchTry);
          this.log(`[Prompt #${task.promptIndex + 1}] Direct download attempt ${fetchTry} of ${maxFetchAttempts} did not succeed — trying the same link once more (download only)…`, 'info');
          if (waitMs > 0) await sleep(waitMs);
        }
      }
    }

    if (!savedBuffer && targetUrl.startsWith('http') && this.page && !this.page.isClosed() && !task._backendHotFetch) {
      // v2.48.9: hot paths (backend fetch / background queue) set
      // _backendHotFetch — they are BACKEND-ONLY by the owner's
      // order and never take this slow in-page route (the whole
      // file as base64 through the page). The download-retry path
      // does not set the flag and keeps this route as a last
      // resort.
      // v2.10.0: IN-PAGE FETCH — wahi link ab browser ke ANDAR se
      // lao. Page ka apna cookie jar, apna connection, apna referer
      // — jo cheez Node wale haath ke fetch me kabhi pakki nahi mil
      // sakti. Blob wale raste ka hi usool, http link ke liye.
      try {
        // v2.30.0: same unbounded-evaluate hazard as the blob read
        // above — this one pulls the whole video inside the page,
        // so it gets a 90s deadline (the orchestrator guard bounds
        // the total step regardless).
        const got = await downloadGuard.withTimeout(this.page.evaluate(async (url) => {
          try {
            const r = await fetch(url, { credentials: 'include' });
            if (!r.ok) return { err: `HTTP ${r.status}` };
            const buf = await r.arrayBuffer();
            if (!buf || buf.byteLength === 0) return { err: 'server se khaali data aaya' };
            let bin = '';
            const bytes = new Uint8Array(buf);
            const CH = 0x8000;
            for (let i = 0; i < bytes.length; i += CH) {
              bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
            }
            return { b64: btoa(bin), size: buf.byteLength };
          } catch (e) {
            return { err: String(e && e.message || e) };
          }
        }, targetUrl), 90000, 'in-browser fetch');
        if (got && got.b64) {
          const buf = Buffer.from(got.b64, 'base64');
          if (buf.length >= minSizeDl) {
            savedBuffer = buf;
            this._noteFetchStep(task, { step: 'page-fetch', ok: true });
            this.log(`[Prompt #${task.promptIndex + 1}] Got the video data from the in-browser fetch (${(buf.length / 1024).toFixed(0)} KB).`, 'info');
          } else {
            this._noteFetchStep(task, { step: 'page-fetch', ok: false, error: `response was only ${buf.length} bytes` });
            this.log(`[Prompt #${task.promptIndex + 1}] The in-browser fetch also brought very small data (${buf.length} bytes).`, 'warn');
          }
        } else if (got && got.err) {
          this._noteFetchStep(task, { step: 'page-fetch', ok: false, error: String(got.err) });
          this.log(`[Prompt #${task.promptIndex + 1}] The in-browser fetch also failed: ${got.err}.`, 'warn');
        } else {
          this._noteFetchStep(task, { step: 'page-fetch', ok: false, error: 'no data came back from the page' });
        }
      } catch (e) {
        const t = plainError.translateError(e);
        this._noteFetchStep(task, { step: 'page-fetch', ok: false, error: t.raw || t.plain });
        this.log(`[Prompt #${task.promptIndex + 1}] The in-browser fetch could not run: ${t.plain}.`, 'warn', { rawError: t.raw });
      }
    }

    // v2.48.15: CONTENT GATE — save se pehle magic bytes. Backend
    // se bandha link kabhi-kabhi asal video nahi hota (TEST492:
    // tile ka poster image) — aisi file save karke ffprobe par
    // marne ke bajaye buffer yahin reject hota hai, wajah ke
    // saath. Sirf video tasks par (image tasks par nahi).
    if (savedBuffer && savedBuffer.length > 10000
      && !(settings && settings.type === 'Image')
      && !downloadFetch.looksLikeVideoBuffer(savedBuffer)) {
      this._noteFetchStep(task, { step: 'content-check', ok: false, error: 'the fetched data is not a video file (no video header — likely an image or an error page)' });
      this.log(`[Prompt #${task.promptIndex + 1}] The data fetched from the link is NOT a video file (it has no video header — probably an image) — it was not saved. The remaining routes will be tried. · fetched: ${savedBuffer.length} bytes, format: ${downloadFetch.classifyBufferMagic(savedBuffer)}, head: ${savedBuffer.subarray(0, 16).toString('hex')}, boxes: ${JSON.stringify(downloadFetch.findBoxOffsets(savedBuffer))}`, 'warn');
      // v2.48.29 (HTML-POISON): data asal me HTML page hai to
      // is link ko is run ke liye zeher-yafta mark kar do —
      // koi bhi stage (backend, tile-src, retry) use dobara
      // fetch NAHI karega. Tasveer (poster) wali rukawat par
      // poison NAHI lagta — wo link kisi aur roop me asal
      // video bhi de sakta hai.
      if (targetUrl && targetUrl.startsWith('http') && downloadFetch.looksLikeHtmlBuffer(savedBuffer)) {
        if (this._htmlPoisonGuard) this._htmlPoisonGuard.poison(targetUrl);
        this.log(`[Prompt #${task.promptIndex + 1}] That link returned an HTML page — it is marked poisoned for this run and will not be fetched again.`, 'warn');
      }
      return false;
    }

    if (savedBuffer && savedBuffer.length > 10000) {
      const savedOk = await this._saveBufferForTask(task, downloadFolder, settings, savedBuffer, targetUrl);
      if (!savedOk) {
        // _saveBufferForTask returns false when the saved file
        // failed the ffprobe video check (it logs the line
        // itself) — ya v2.48.29 se, jab QUALITY GATE ne buffer
        // ko preview-quality keh kar save se PEHLE roka ho.
        // Note me asal wajah hi aaye, is liye wajah alag padhi
        // jati hai.
        if (task._saveRejectedReason === 'quality-gate') {
          this._noteFetchStep(task, { step: 'quality-gate', ok: false, error: 'the fetched video was preview quality (below the size floor for its duration) — not saved as the final file' });
        } else {
          this._noteFetchStep(task, { step: 'save-verify', ok: false, error: 'the saved file failed the video check (ffprobe)' });
        }
      }
      return savedOk;
    }

    // v2.7.0: yahan tak aane ka matlab hai URL apna tha lekin file ka
    // data nahi ban paya (buffer nahi mila / fetch fail / data bahut
    // chhota). Wajah saaf likho — khamoshi hi v2.6.0 ka bug thi.
    // v2.38.0: the line now ends with the per-attempt REAL errors
    // (HTTP status / exception) recorded during this call.
    const failSummary = this._fetchSummary(task);
    this.log(`[Prompt #${task.promptIndex + 1}] The file could not be made from the stream: the video data was not received (no response from the server, or the data was very small)${failSummary ? ` — attempts: ${failSummary}` : ''}.`, 'warn');
    return false;
  }

  /**
   * v1.6.1: get the page back to the project GRID, verifiably. Clicking
   * a tile opens Flow's EDITOR (a routed view) — if the return fails,
   * the render monitor reads an empty canvas forever and every other
   * pending video stalls on the editor screen (the owner's photo:
   * two videos generated, one downloaded, app stuck in the editor).
   * Escalating routes: already-on-grid check → history back → the
   * editor's Done/Back button (matched by visible text as well as
   * aria) → direct navigation to the project URL (the /edit/… tail
   * dropped). Returns true only when grid tiles are actually present.
   */
  async _returnToProjectGrid() {
    if (!this.page || this.page.isClosed()) return false;
    const onGrid = async () => {
      try {
        // v2.10.0: sirf tile ginati kaafi nahi — editor ke andar ki
        // media strip bhi tile component use karti hai. Grid = tiles
        // hain AUR URL /edit/ par nahi hai.
        return await this.page.evaluate(() => !window.location.pathname.includes('/edit/')
          && document.querySelectorAll('flow-grid-tile-container').length > 0);
      } catch (e) { return false; }
    };
    if (await onGrid()) return true;

    try { await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }); } catch (e) {}
    await sleep(1200);
    if (await onGrid()) return true;

    try {
      await this.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const b = btns.find(x => {
          const t = (x.innerText || '').trim().toLowerCase();
          const a = (x.getAttribute('aria-label') || '').toLowerCase();
          return t === 'done' || a.includes('back') || a.includes('done');
        });
        if (b) b.click();
      });
    } catch (e) {}
    await sleep(1200);
    if (await onGrid()) return true;

    try {
      const m = this.page.url().match(/(https:\/\/flow\.google\.com\/project\/[^/]+)/);
      if (m) {
        await this.page.goto(m[1], { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(1500);
      }
    } catch (e) {}
    return await onGrid();
  }

  /**
   * v2.7.0 — NATIVE DOWNLOAD SUITE (Download path B, dobara likha hua).
   *
   * v2.6.0 ka pakka diagnosis (owner ka burst run, 2026-10-14): chaaron
   * renders 100% complete the, lekin chaaron download EK hi pattern se
   * mare — tile click → ~8s → "Download media button not found". Us
   * samay ka matcher sirf ye roop pehchanta tha: aria me 'download
   * media', aria bilkul 'download', text bilkul 'download', ya icon
   * text bilkul 'download'; poll bhi ~7.5s ka hi tha. Flow ka asal
   * button inme se kisi se na mile (aria 'Download video', sirf-icon
   * wala button, ya ⋮ menu ke andar chhupa Download) to rasta wahin
   * mar jata tha — aur us par captured-stream wala rasta pehle se hi
   * bina kisi log ke fail ho chuka hota tha (URL gate par khamosh
   * return), aur editor se grid par wapas aana bhi pakka nahi tha
   * (sirf Escape), jo stream raste ko aur maar deta tha.
   *
   * v2.7.0 me yahan TEEN roop the (hover icon / editor toolbar /
   * ⋮ menu). v2.8.0 — INSPECTION HISSA 2 (signed-in asal project se
   * VERIFIED) ne do ko kaat diya aur teesre ko pakka kiya:
   *   - Tile par HOVER par download button hota hi NAHI (sirf
   *     Favorite, Reuse prompt, More options) — hover roop HATA.
   *   - Tile ke ⋮ menu me download ka label EXACT "Download" hai.
   *   - "Download media" SIRF editor view ki TOP BAR me hai (tile
   *     click → editor khule, top bar load ho); editor ke ⋮ menu me
   *     download NAHI hai. Editor ka player <canvas> hai, <video>
   *     nahi — editor me DOM-src bekaar hai.
   * Ab native UI ke DO roop bache, har roop sirf task ki APNI bound
   * tile par (galat tile ka video kabhi nahi):
   *   A) ⋮ menu ka exact "Download",
   *   B) editor ki top bar ka "Download media" (~15s ka intezaar).
   * Aur ye dono ab sirf FALLBACK hain — pramukh rasta v2.8.0 ka
   * backend network capture hai (downloadTaskMedia ki tartib dekho).
   * Jo selector mile, wo log hota hai. File aate hi ruk jao.
   */

  /**
   * v2.48.25 (E1 — OBSERVE ONLY): browser-level CDP download events.
   *
   * Research (2026-11-02) proved the file arrives through Chrome's
   * own download manager and that this transfer never appears in
   * page-target Network events — the app has only ever configured
   * the PAGE-level Page.setDownloadBehavior and polled the disk.
   * The Browser domain is the documented place where the download
   * manager announces the REAL url it is about to fetch
   * (Browser.downloadWillBegin), but only when download events are
   * explicitly enabled (Browser.setDownloadBehavior eventsEnabled,
   * default false).
   *
   * This listener changes NOTHING about downloads: it sends the
   * same behavior ('allow') and the same download folder the
   * page-level calls already use; the only addition is
   * eventsEnabled: true at browser level. On downloadWillBegin it
   * logs ONE [E1-DL] line with the URL's SHAPE only (scheme, host,
   * redacted path pattern, query KEY names, length) — the full
   * signed URL and its values never reach the log.
   *
   * Defensive by design: any failure logs one warning and the
   * launch/download flow continues exactly as before.
   */
  async _attachE1DownloadListener(downloadPath) {
    try {
      if (!this.browser) return;
      if (this.browserCdpSession) return; // one listener per browser
      const target = typeof this.browser.target === 'function' ? this.browser.target() : null;
      if (!target || typeof target.createCDPSession !== 'function') {
        this.log('[E1-DL] Browser-level download events are not available on this browser target — continuing with the existing page-level download route.', 'warn');
        return;
      }
      const session = await target.createCDPSession();
      this.browserCdpSession = session;
      // v2.48.27 (MENU-FIRST): E1 wala observe-only listener ab
      // sirf log nahi karta — download events ka hisaab bhi rakhta
      // hai, taaki menu route ka save filesystem ke 1s poll ki
      // jagah downloadProgress 'completed' event se foran bandhe
      // (event hi asal completion hai; disk ki jaanch ≤100ms par
      // uski pushti ke liye rehti hai). Vyavhaar phir bhi waisa
      // hi: behavior 'allow', wahi folder — badla sirf intezaar
      // ka tareeka hai.
      if (!this._dlEventState) {
        this._dlEventState = { begins: [], completed: new Map(), waiters: new Set() };
      }
      const dlState = this._dlEventState;
      const onWillBegin = (ev) => {
        try {
          const shape = formatUrlShape(describeUrlShape(ev && ev.url ? ev.url : ''));
          const fname = ev && ev.suggestedFilename ? String(ev.suggestedFilename) : '';
          const guid = ev && ev.guid ? String(ev.guid) : '';
          const hasFrame = ev && ev.frameId ? 'yes' : 'no';
          this.log(`[E1-DL] downloadWillBegin ${shape} suggestedFilename="${fname}" guid=${guid} frameId=${hasFrame}`, 'info');
          if (guid) {
            dlState.begins.push({ guid, suggestedFilename: fname, at: Date.now() });
            if (dlState.begins.length > 50) dlState.begins.splice(0, dlState.begins.length - 50);
          }
          this._notifyDlWaiters();
        } catch (e) {}
      };
      const onProgress = (ev) => {
        try {
          if (!ev || (ev.state !== 'completed' && ev.state !== 'canceled')) return;
          const guid = ev.guid ? String(ev.guid) : '';
          const total = Number.isFinite(ev.totalBytes) ? ev.totalBytes : -1;
          const received = Number.isFinite(ev.receivedBytes) ? ev.receivedBytes : -1;
          this.log(`[E1-DL] downloadProgress guid=${guid} state=${ev.state} received=${received} total=${total}`, 'info');
          if (guid) {
            dlState.completed.set(guid, { state: ev.state, at: Date.now(), receivedBytes: received, totalBytes: total });
          }
          this._notifyDlWaiters();
        } catch (e) {}
      };
      if (typeof session.on === 'function') {
        session.on('Browser.downloadWillBegin', onWillBegin);
        session.on('Browser.downloadProgress', onProgress);
      }
      const targetDownloadPath = downloadPath || this.browserDownloadDir;
      if (targetDownloadPath && !fs.existsSync(targetDownloadPath)) {
        try { fs.mkdirSync(targetDownloadPath, { recursive: true }); } catch (e) {}
      }
      await session.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: targetDownloadPath,
        eventsEnabled: true
      });
      this.log('[E1-DL] Browser-level download events enabled (observe-only) — download behaviour is unchanged.', 'info');
    } catch (e) {
      try { this.browserCdpSession = null; } catch (e2) {}
      try {
        this.log('[E1-DL] Browser-level download events could not be enabled — continuing with the existing page-level download route.', 'warn');
      } catch (e2) {}
    }
  }

  /**
   * v2.48.27: download-event waiters ko jagao (koi download shuru
   * ya mukammal hua). Waiter khud apni shart jaanch kar so jata ya
   * uth jata hai — yahan sirf ghanti bajti hai.
   */
  _notifyDlWaiters() {
    try {
      const st = this._dlEventState;
      if (!st || !st.waiters || st.waiters.size === 0) return;
      const waiters = Array.from(st.waiters);
      st.waiters.clear();
      for (const w of waiters) { try { w(); } catch (e) {} }
    } catch (e) {}
  }

  /**
   * v2.48.27: itne waqt (ms) so jao, lekin koi download event aate
   * hi foran uth jao — menu route ke save ka intezaar isi se
   * event-driven banta hai. Event state na ho to aam neend.
   */
  _dlSleep(ms) {
    const st = this._dlEventState;
    if (!st || !st.waiters) return sleep(ms);
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const wake = () => {
        if (done) return;
        done = true;
        if (timer) { try { clearTimeout(timer); } catch (e) {} }
        try { st.waiters.delete(wake); } catch (e) {}
        resolve();
      };
      timer = setTimeout(wake, Math.max(10, ms));
      if (timer && typeof timer.unref === 'function') timer.unref();
      st.waiters.add(wake);
    });
  }

  /**
   * v2.48.27: `sinceMs` ke baad SHURU hue downloads me se wo jo
   * downloadProgress 'completed' tak pahunch gaya ho — sab se
   * pehla aisa event lautao, warna null.
   * v2.48.30: asal milaan ab engine/downloadEventMatch.js ke
   * KHALIS (pure) hisaab me hai — fileName diya ho to naam ka
   * milaan Chrome ke " (1)" dedup suffix ki riayat ke saath,
   * aur fileSize diya ho to exact byte-size ka milaan bhi
   * chalega. State yahan pehle se maujood hai to event
   * intezaar shuru hone se PEHLE fire hua ho to bhi gina
   * jata hai (FASTTEST4 wala regression yahi tha).
   */
  _dlCompletedSince(sinceMs, fileName, fileSize) {
    try {
      const st = this._dlEventState;
      if (!st || !st.begins || !st.completed) return null;
      return downloadEventMatch.matchCompletedDownload(st, { sinceMs, fileName, fileSize });
    } catch (e) {}
    return null;
  }

  /**
   * v2.48.27 (FAST-DL diagnostic): is pal page ki blob registry
   * me kitni entries hain — menu click ke pal ki ek line ke liye.
   * Sirf GINATI hai; koi extraction NAHI (wo is build ke dayre
   * se bahar hai). Na padh sake to -1.
   */
  async _blobRegistryCount() {
    try {
      if (!this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed())) return -1;
      const n = await this.page.evaluate(() => (window.__mkBlobRegistry || []).length);
      return Number.isFinite(n) ? n : -1;
    } catch (e) { return -1; }
  }

  /**
   * v2.48.27 (NET-BIG): har download ke aakhir me EK summary
   * line — render-complete se save tak har host ke KUL bytes
   * (descending). Click ke baad jo ~1.2MB file taiyaar hoti hai,
   * uske bytes jis host se aaye honge wo is line me sab se upar
   * hoga — wahi Flow-server wala channel hai jise agla build
   * seedha istemal karega. Sirf logging; khidki khaali ho to
   * koi line nahi.
   */
  _logNetBigWindow(task, fallbackSinceMs) {
    try {
      if (!this.netCapture || typeof this.netCapture.netBigWindowSummary !== 'function') return;
      const since = (task && task.renderCompletedAt)
        || (task && task.startTime)
        || fallbackSinceMs || 0;
      const summary = this.netCapture.netBigWindowSummary(since);
      if (summary) this.log(`[NET-BIG] window render→save: ${summary}`, 'info');
    } catch (e) {}
  }

  /** CDP download folder taiyaar + maujooda files ka snapshot. */
  async _nativePrepareWatch(downloadFolder) {
    if (!fs.existsSync(downloadFolder)) {
      try { fs.mkdirSync(downloadFolder, { recursive: true }); } catch (e) {}
    }
    const nativeDownloadFolder = this.browserDownloadDir || downloadFolder;
    try {
      if (!this.cdpSession && this.page) {
        this.cdpSession = await this.page.target().createCDPSession();
      }
      if (this.cdpSession) {
        await this.cdpSession.send('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: nativeDownloadFolder
        });
      }
    } catch (e) {}
    // v1.7.0: watch ONLY this session's native download folder. The
    // shared download folder is written by stream saves (possibly from
    // ANOTHER worker on another account) — a file landing there during
    // this poll used to be grabbed and renamed as THIS task's video.
    const foldersToWatch = [nativeDownloadFolder];
    const existingFilesByFolder = new Map();
    for (const fld of foldersToWatch) {
      try { existingFilesByFolder.set(fld, new Set(fs.readdirSync(fld))); }
      catch (e) { existingFilesByFolder.set(fld, new Set()); }
    }
    return { nativeDownloadFolder, foldersToWatch, existingFilesByFolder };
  }

  /** Resolution wala menu aaye to uska sahi option click karo. */
  async _nativePickResolution(quality) {
    // (Fix list 2026-10-27, item 7): the Settings quality CHOOSES
    // the menu item now. Before, the FIRST resolution-looking item
    // was clicked whatever the setting said — a 1080p request could
    // silently download the 360p preview whenever it was listed
    // first. Flow's own model: the generated video downloads at
    // 360p or 720p ("Original" is the file as generated), and 1080p
    // is the enhance/upscale option in this same menu. When the
    // menu does not offer the requested quality, the closest item
    // is clicked and the substitution is LOGGED, never silent.
    const want = String(quality || '720p').toLowerCase();
    const wantTokens = want.includes('1080') ? ['1080p']
      : want.includes('360') ? ['360p']
      : ['720p', 'original'];
    const findOptions = async () => {
      try {
        return await this.page.evaluate(() => {
          const menuItems = Array.from(document.querySelectorAll('.cdk-overlay-pane button, [role="menuitem"], .mat-mdc-menu-panel button'));
          const out = [];
          for (const b of menuItems) {
            const t = (b.innerText || b.textContent || '').trim().toLowerCase();
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            if (!(t.includes('original') || t.includes('720p') || t.includes('1080p') || t.includes('360p') || aria.includes('original'))) continue;
            const rect = b.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              out.push({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: (b.innerText || b.textContent || '').trim() });
            }
          }
          return out;
        });
      } catch (e) {
        return [];
      }
    };
    const pickFrom = (options) => {
      for (const tok of wantTokens) {
        const hit = options.find(o => o.text.toLowerCase().includes(tok));
        if (hit) return { opt: hit, exact: true };
      }
      return options.length ? { opt: options[0], exact: false } : null;
    };
    let options = [];
    for (let r = 0; r < 6; r++) {
      options = await findOptions();
      if (options.length) break;
      await sleep(400);
    }
    const picked = pickFrom(options);
    if (picked) {
      const optCoords = picked.opt;
      if (!picked.exact) {
        this.log(`Flow's download menu did not offer ${want.toUpperCase()} — downloading "${optCoords.text}" instead (the closest it offered).`, 'warn');
      }
      this.log(`Selecting the resolution: "${optCoords.text}"…`, 'info');
      let clickedAt = Date.now();
      await this.page.mouse.click(optCoords.x, optCoords.y);
      // v2.30.4: click ke baad pakka karo ki menu BAND hua. Owner ke
      // v2.30.3 run (2026-10-25) me editor route par resolution click
      // ke baad bhi menu khula atka raha (screenshot saboot) aur file
      // kabhi nahi aayi — engine 90s tak andha intezaar karta raha.
      // Menu ab bhi khula hai to coordinates TAZE padh kar dobara
      // click karo (kul 3 koshish). Menu band = click lag gaya.
      for (let clickTry = 1; clickTry < 3; clickTry++) {
        await sleep(900);
        const still = await findOptions();
        if (!still.length) break;
        this.log('The resolution menu stayed open after the click — clicking the option again with fresh coordinates…', 'warn');
        const again = pickFrom(still);
        clickedAt = Date.now();
        await this.page.mouse.click(again.opt.x, again.opt.y);
      }
      return { found: true, clickedAt };
    }
    this.log('The resolution menu did not appear — the download may have started directly; waiting for the file…', 'warn');
    return { found: false, clickedAt: 0 };
  }

  /**
   * Ek download click ke baad file ka intezaar, phir jaanch + save +
   * completion (native raste ka aakhri hissa, ab dono roopon
   * ke liye saanjha). File is click se PEHLE ki nahi honi chahiye aur
   * 20KB se badi honi chahiye (v1.7.0 ke niyam barkarar).
   */
  async _nativeAwaitAndSave(task, prep, clickTime, timeoutMs, downloadFolder, settings) {
    const fileName = this._fileNameForTask(task, settings);
    let finalSavedFilePath = path.join(downloadFolder, fileName);
    task.fileName = fileName;
    task.filePath = finalSavedFilePath;

    let newlyDownloadedFile = null;
    const pollStart = Date.now();
    const timeout = Math.max(5000, Number(timeoutMs) || 90000);
    // v2.48.27 (MENU-FIRST): completion ab EVENT-driven hai —
    // browser-level CDP session (v2.48.25 wala) maujood ho to
    // downloadProgress 'completed' hi asal "ho gaya" hai; disk ki
    // jaanch ≤100ms par sirf uski pushti/file-dhoondh ke liye
    // rehti hai, aur event aate hi neend turant toot-ti hai
    // (_dlSleep). CDP session na ho to purana 1s poll bilkul
    // pehle ki tarah (koi badlav nahi).
    const useDlEvents = !!this.browserCdpSession;
    const pollMs = useDlEvents ? 100 : 1000;
    let eventSave = null;
    // v2.31.3 (download fix pack): PROGRESS STALL CHECK — the poll
    // used to see only FINISHED files; a browser download whose
    // bytes simply stopped moving (dead connection, wedged Chrome
    // download) sat invisible until the whole wait timed out.
    // In-progress files (.crdownload / .tmp) are now tracked by
    // size: no growth for the stall window (45s) abandons the wait
    // as a stalled download, the partial is deleted (it must never
    // be treated as the video, nor finish later under another
    // task's watch), and the orchestrator falls through to the
    // next route.
    const stallMs = this.nativeDownloadStallMs || 45000;
    const partials = new Map(); // folder|name -> { size, lastGrowAt, fullPath }
    let stalledPartial = null;
    // v2.48.30: post-click race ka dusra rasta (server fetch)
    // pehle save kar de to ye intezaar foran chhod do —
    // _raceAbandoned wahi nishaan hai, mediaSaved asal sach.
    while (Date.now() - pollStart < timeout && !this.isStopping && !task._raceAbandoned && !task.mediaSaved) {
      await this._dlSleep(pollMs);
      // Is click ke baad shuru hue download ka completed event —
      // mila ho to is iteration ki disk-jaanch usi ki pushti hai.
      const evtDone = useDlEvents ? this._dlCompletedSince(clickTime - 2000) : null;
      for (const fld of prep.foldersToWatch) {
        if (!fs.existsSync(fld)) continue;
        const currentFiles = fs.readdirSync(fld);
        const existing = prep.existingFilesByFolder.get(fld) || new Set();
        const newFiles = currentFiles.filter(f => !existing.has(f));
        const finished = newFiles.find(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp') && !f.endsWith('.htm') && (f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.png') || f.endsWith('.gif')));
        if (finished) {
          const fullPath = path.join(fld, finished);
          // v1.9.0: the file can vanish between readdir and stat
          // (browser cleanup, AV quarantine) — treat as "not ready".
          let stats = null;
          try { stats = fs.statSync(fullPath); } catch (e) { stats = null; }
          if (!stats) continue;
          // v1.7.0: the file must post-date THIS download click.
          if (stats.size > 20000 && stats.mtimeMs >= clickTime - 2000) {
            newlyDownloadedFile = fullPath;
            // v2.48.27: completed event isi file ka hai (naam
            // mile ya event bina-naame ho) to save event-driven
            // bandha — gap wali line me event=yes yahi se aayega.
            if (evtDone && (!evtDone.suggestedFilename || evtDone.suggestedFilename === finished)) {
              eventSave = evtDone;
            }
            break;
          }
        }
        // v2.31.3: watch this folder's in-progress files for growth.
        if (!newlyDownloadedFile && !stalledPartial) {
          const now = Date.now();
          for (const f of newFiles) {
            if (!(f.endsWith('.crdownload') || f.endsWith('.tmp'))) continue;
            const fullPath = path.join(fld, f);
            let st = null;
            try { st = fs.statSync(fullPath); } catch (e) { st = null; }
            if (!st) continue;
            const key = `${fld}|${f}`;
            const seen = partials.get(key);
            if (!seen) {
              partials.set(key, { size: st.size, lastGrowAt: now, fullPath });
              continue;
            }
            if (st.size > seen.size) {
              seen.size = st.size;
              seen.lastGrowAt = now;
              continue;
            }
            if (now - seen.lastGrowAt >= stallMs) {
              stalledPartial = { name: f, fullPath };
              break;
            }
          }
        }
        if (stalledPartial) break;
      }
      if (newlyDownloadedFile) break;
      if (stalledPartial) break;
    }

    if (stalledPartial) {
      this.log(`[Prompt #${task.promptIndex + 1}] The browser download stalled — the file stopped growing, so this wait was abandoned. The partial file was removed and will NOT be treated as the video; the next download route will be tried.`, 'warn');
      try { fs.unlinkSync(stalledPartial.fullPath); } catch (e) {}
    }

    // v2.48.30 (EVENT RECONCILIATION — FASTTEST4 ke event=no
    // ka ilaaj): poll loop me eventSave SIRF usi iteration me
    // bandhta tha jis me file disk par pehli baar dikhe, aur
    // evtDone us iteration ke AAGHAZ me gina jata tha. Chrome
    // file ka rename aksar downloadProgress 'completed' event
    // ke Node tak pahunchne se pehle kar deta hai — file pehle
    // dikh gayi, event us iteration me state me tha hi nahi,
    // loop toot gaya aur save event=no keh kar 1s-poll wala
    // ginne laga, halanke [E1-DL] lines sabit karti hain ke
    // event fire hua tha aur state me darj bhi hua tha (bas
    // ek tick der se). Ab: file mil gayi ho aur eventSave
    // khaali ho to ek mukhtasar (≤1.5s, event-driven) dobara
    // milaan — naam (dedup-suffix riayat ke saath) ya exact
    // size se — taaki jo event asal me is download ka hai wo
    // ginati me aaye, chahe wo intezaar ki aakhri tick ke
    // baad darj hua ho.
    if (newlyDownloadedFile && !eventSave && useDlEvents && !task.mediaSaved) {
      try {
        let foundSize = 0;
        try { foundSize = fs.statSync(newlyDownloadedFile).size; } catch (e) {}
        const foundName = path.basename(newlyDownloadedFile);
        const reconDeadline = Date.now() + 1500;
        while (Date.now() < reconDeadline) {
          const evt = this._dlCompletedSince(clickTime - 2000, foundName, foundSize);
          if (evt) {
            eventSave = evt;
            this.log(`[FAST-DL] [Prompt #${task.promptIndex + 1}] The browser download's completion event was confirmed just after the file landed (name/size match) — this save counts as event-driven.`, 'info');
            break;
          }
          const remain = reconDeadline - Date.now();
          if (remain <= 0) break;
          await this._dlSleep(Math.min(remain, 250));
        }
      } catch (e) {}
    }

    // Return the viewer to the grid either way — VERIFIED (v1.6.1).
    // The old single Escape + aria-only button hunt could leave the
    // page sitting in Flow's editor, where the monitor sees no tiles
    // and every remaining video stalls.
    await this._returnToProjectGrid();

    if (!newlyDownloadedFile) return false;

    // v2.48.30: race ka dusra rasta (server fetch) is dauraan
    // pehle hi save kar chuka ho to yahan kitab-bandhi dobara
    // NAHI hogi — ek task, ek file.
    if (task._raceAbandoned || task.mediaSaved) return false;

    // v1.7.0: never overwrite a file this engine did not save itself
    // (e.g. a previous run's scene001.mp4) — take a suffixed name.
    const freePath = this._resolveSavePath(downloadFolder, fileName, settings, task);
    if (freePath !== finalSavedFilePath) {
      finalSavedFilePath = freePath;
      task.fileName = path.basename(freePath);
      task.filePath = freePath;
    }
    if (newlyDownloadedFile !== finalSavedFilePath) {
      try {
        fs.renameSync(newlyDownloadedFile, finalSavedFilePath);
      } catch (renErr) {
        fs.copyFileSync(newlyDownloadedFile, finalSavedFilePath);
        try { fs.unlinkSync(newlyDownloadedFile); } catch (e) {}
      }
    }

    // Validate before declaring completion.
    const isImageMode = (settings.type === 'Image');
    if (!isImageMode) {
      const valid = await FFmpegService.verifyVideoFile(finalSavedFilePath, 20000);
      if (!valid) {
        try { fs.unlinkSync(finalSavedFilePath); } catch (e) {}
        this.log(`The downloaded file ${task.fileName} failed the video check — this download has been treated as failed.`, 'warn');
        return false;
      }
    }

    // v2.48.30: ffprobe verify ke intezaar ke dauraan race ka
    // server fetch is task ko pehle save kar chuka ho to ye
    // file duplicate hai — hata do, kitab-bandhi ek hi hogi.
    if (task.mediaSaved) {
      try { fs.unlinkSync(finalSavedFilePath); } catch (e) {}
      return false;
    }

    // v2.48.35 (GUARD — browser-download wala rasta bhi):
    // zameen par utri file ka hash is run ki kitab se mila
    // kar dekho — kisi AUR task ki save hue bytes ki hu-bahu
    // copy ho to ye is task ki save NAHI hai: file hatao,
    // haar maano, baaki raaste chalein. Apne hi task ki
    // dobara-utri copy jaiz hai (faisla saveGuard se).
    let nativeHash = null;
    if (!isImageMode) {
      try { nativeHash = saveGuard.contentHash(fs.readFileSync(finalSavedFilePath)); } catch (e) { nativeHash = null; }
      if (nativeHash) {
        const verdict = saveGuard.checkDuplicate(this._runSavedContentHashes, this._taskKey(task), nativeHash);
        if (verdict.duplicate) {
          try { fs.unlinkSync(finalSavedFilePath); } catch (e) {}
          this.log(`[GUARD] duplicate-content rejected for Prompt #${task.promptIndex + 1} — fetched bytes are identical to Prompt #${verdict.otherPromptIndex + 1}'s saved file`, 'warn');
          return false;
        }
      }
    }

    const fileStats = fs.statSync(finalSavedFilePath);
    const sizeMb = (fileStats.size / (1024 * 1024)).toFixed(2);
    this.log(`Video saved: ${task.fileName} (${sizeMb} MB).`, 'success');
    this._logNetBigWindow(task, clickTime);

    // v2.48.27: ye save downloadProgress event se bandha tha ya
    // sirf disk-poll se — gap wali [FAST-DL] line ke liye nishaan.
    task._nativeEventDriven = !!eventSave;
    task._nativeSavedAt = Date.now();

    task.downloaded = true;
    task.completed = true;
    task.mediaSaved = true;
    this._recordSavedPath(task, finalSavedFilePath);
    // v2.48.35 (GUARD): browser-download se utri file ki
    // hash-kitab bandhi bhi wahi registry me — taaki baad
    // wale tasks ki jaanch is save ko bhi pehchane.
    if (nativeHash) saveGuard.recordSave(this._runSavedContentHashes, this._taskKey(task), nativeHash, task.promptIndex);

    const result = {
      filePath: finalSavedFilePath,
      fileName: task.fileName,
      fileSizeMb: sizeMb + ' MB',
      videoUrl: task.completedVideoUrl || ''
    };
    task.result = result;
    this.onTaskCompleted(task, result);

    const elapsed = Math.round((Date.now() - task.startTime) / 1000) + 's';
    this.onVideoCompleted({
      id: task.videoId,
      prompt: task.promptText,
      accountName: this.currentAccount.name,
      videoUrl: `file:///${finalSavedFilePath.replace(/\\/g, '/')}`,
      filePath: finalSavedFilePath,
      downloadFolder: downloadFolder,
      timestamp: new Date().toLocaleTimeString(),
      quality: settings.quality || '360p',
      duration: settings.duration || '6s',
      aspectRatio: settings.aspectRatio || '9:16',
      elapsed: elapsed
    });
    return true;
  }

  /**
   * Editor view ki TOP BAR me "Download media" wala control
   * dhoondho (inspection hissa 2, VERIFIED): "Download media" sirf
   * yahin hota hai — tile click ke baad editor (/project/<id>/edit/
   * <id>) khule aur top bar load ho, tab milta hai. Editor ke ⋮
   * menu me download NAHI hota, wahan talaash bekaar hai. Editor ka
   * player <canvas class="video-canvas"> hai, <video> nahi — isliye
   * editor me DOM se src nikalna bhi bekaar hai; ye roop sirf is
   * button ke liye hai. Overlay (menu) ke andar ke controls yahan
   * nahi ginne jate — wo menu wale roop ki jagah hai.
   */
  async _findEditorDownloadControl(page) {
    // v2.48.40: page diya jaye to wahi, warna apna page
    // (v2.48.41: background page khatam — hamesha apna page).
    const pg = page || this.page;
    try {
      return await pg.evaluate(() => {
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const all = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const b of all) {
          if (b.closest && b.closest('.cdk-overlay-pane')) continue;
          if (!visible(b)) continue;
          const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
          const t = (b.innerText || b.textContent || '').trim().toLowerCase();
          if (aria.includes('download media') || t.includes('download media')) {
            const r = b.getBoundingClientRect();
            return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, how: (aria || t) };
          }
        }
        return { found: false };
      });
    } catch (e) {
      return { found: false };
    }
  }

  /** Tile ke center ke coordinates (hover/click ke liye). */
  async _tileCenterCoords(tileIndex, page) {
    // v2.48.40: page diya jaye to wahi, warna apna page
    // (v2.48.41: background page khatam — hamesha apna page).
    const pg = page || this.page;
    try {
      return await pg.evaluate(({ idx }) => {
        const tiles = Array.from(document.querySelectorAll('flow-grid-tile-container'));
        const target = (typeof idx === 'number') ? tiles[idx] : null;
        if (!target) return { found: false };
        target.scrollIntoView({ behavior: 'instant', block: 'center' });
        const r = target.getBoundingClientRect();
        return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, text: (target.innerText || '').replace(/\n/g, ' ').substring(0, 40) };
      }, { idx: tileIndex });
    } catch (e) {
      return { found: false };
    }
  }

  /**
   * Roop B: tile click → editor view ki TOP BAR ka "Download media"
   * (inspection hissa 2). Tile par hover wala download roop v2.8.0
   * me HATA diya gaya: hover par sirf Favorite, Reuse prompt aur
   * More options (⋮) hote hain — download button hota hi nahi, wo
   * ranneeti kabhi kaam kar hi nahi sakti thi.
   */
  /**
   * v2.10.0: editor khula hai ya nahi — iska faisla URL se hota hai
   * (/edit/ wala rasta) ya "Download media" control ke milne se.
   * v2.8.0 wali grid-tile ginati is kaam ke liye galat thi: editor
   * ke andar ki media strip bhi wahi tile component use karti hai,
   * to editor khulne ke baad bhi "grid par hi raha" padh sakta tha
   * (owner ke v2.8.0 PC run me native-editor theek yahin mara).
   */
  async _inEditorView(page) {
    // v2.48.40: page diya jaye to wahi, warna apna page
    // (v2.48.41: background page khatam — hamesha apna page).
    const pg = page || this.page;
    try {
      const u = pg.url() || '';
      if (u.includes('/edit/')) return true;
    } catch (e) {}
    try {
      const ctl = await this._findEditorDownloadControl(pg);
      if (ctl && ctl.found) return true;
    } catch (e) {}
    return false;
  }

  async _nativeEditorForm(task, prep, downloadFolder, settings, tileIndexHint, attempts) {
    const n = task.promptIndex + 1;
    // Editor pehle se khula hai kya? (kisi pichhli koshish se khul
    // gaya ho to tile dobara click karne ki zaroorat nahi.)
    if (!(await this._inEditorView())) {
      const idx = await this._resolveTileIndexForTask(task, tileIndexHint);
      const coords = idx >= 0 ? await this._tileCenterCoords(idx) : { found: false };
      if (!coords.found) {
        attempts.push({ strategy: 'native-editor', ok: false, note: 'not found on its tile grid at all, the editor could not even open' });
        return false;
      }
      this.log(`[Prompt #${n}] Opening its big view (editor) by clicking on its tile: "${coords.text || ''}"`, 'info');
      // Do koshish: pehla click kabhi tile ke upar wale hisse me
      // atak sakta hai — dusra click tabhi jab URL se pakka ho ki
      // editor abhi bhi nahi khula.
      let opened = false;
      for (let clickTry = 0; clickTry < 2 && !opened; clickTry++) {
        await this.page.mouse.click(coords.x, coords.y);
        await sleep(1500);
        opened = await this._inEditorView();
      }
      if (!opened) {
        attempts.push({ strategy: 'native-editor', ok: false, note: 'even after clicking the tile twice, the editor view did not open (the URL stayed on the grid)' });
        return false;
      }
    }
    // Editor ki top bar ke load hone ka sahi intezaar: "Download
    // media" ke liye ~15 second tak poll.
    let ctl = { found: false };
    for (let r = 0; r < 30; r++) {
      ctl = await this._findEditorDownloadControl();
      if (ctl.found) break;
      await sleep(500);
    }
    if (!ctl.found) {
      this.log(`[Prompt #${n}] Even after waiting 15 seconds, "Download media" was not found on the editor's top bar.`, 'warn');
      attempts.push({ strategy: 'native-editor', ok: false, note: '"Download media" was not found on the editor\'s top bar even after waiting 15s' });
      // v2.6.0 ki galti: yahan sirf Escape dabta tha aur page editor
      // me hi atka reh jata tha — baaki raste grid na hone ki wajah
      // se mar jate the. Ab grid par wapas jaana pakka hai.
      await this._returnToProjectGrid();
      return false;
    }
    this.log(`[Prompt #${n}] Found "Download media" on the editor's top bar (${ctl.how}) — clicking…`, 'info');
    const clickTime = Date.now();
    await this.page.mouse.click(ctl.x, ctl.y);
    const res = await this._nativePickResolution(settings && settings.quality);
    // v2.30.4: editor route ka file-intezaar 90s → 40s. Ye rasta owner
    // ki machine par aaj tak kabhi file nahi laya (v2.8.0, v2.30.3 ke
    // runs) — click lage to 360p ki chhoti file chand seconds me aa
    // jati hai (menu raste par 2–5s lage); 90s ka andha intezaar
    // multi-video run ko "atka hua" dikhata tha.
    const ok = await this._nativeAwaitAndSave(task, prep, res.clickedAt || clickTime, 40000, downloadFolder, settings);
    attempts.push({ strategy: 'native-editor', ok, note: ok ? `the file came from the editor's top bar "Download media" (${ctl.how})` : 'the editor\'s "Download media" was clicked, but no file arrived' });
    if (!ok) this.log(`[Prompt #${n}] No file came from the editor route — the next form will be tried.`, 'warn');
    return ok;
  }

  /** Roop C: ⋮ (more options) menu ke andar ka Download item. */
  async _nativeMenuForm(task, prep, downloadFolder, settings, tileIndexHint, attempts) {
    const n = task.promptIndex + 1;
    const findMoreControl = async (scopeIdx) => {
      try {
        return await this.page.evaluate(({ idx }) => {
          const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const isMore = (b) => {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            const icon = b.querySelector('mat-icon, [data-icon], svg');
            const iconTxt = icon ? (icon.textContent || '').trim().toLowerCase() : '';
            return aria.includes('more options') || aria.includes('more actions') || aria === 'more'
              || iconTxt === 'more_vert' || iconTxt === 'more_horiz';
          };
          let scope = document;
          if (typeof idx === 'number' && idx >= 0) {
            const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
            scope = containers[idx] || null;
            if (!scope) return { found: false };
          }
          const els = Array.from(scope.querySelectorAll('button, [role="button"]'));
          for (const b of els) {
            if (!visible(b)) continue;
            if (b.closest && b.closest('.cdk-overlay-pane')) continue;
            if (isMore(b)) {
              const r = b.getBoundingClientRect();
              return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
          }
          return { found: false };
        }, { idx: scopeIdx });
      } catch (e) {
        return { found: false };
      }
    };

    let more = { found: false };
    // v2.30.4: ⋮ button ki talash ab 3 koshishon tak chalti hai aur
    // nakami LOG hoti hai. v2.30.3 tak ye rasta bina ek bhi log line
    // ke chup-chaap mar jata tha (owner ka 2026-10-25 multi-video
    // run: Prompt #4 par ⋮ us pal nahi mila — grid usi pal Prompt #5
    // ke render se badal raha tha — aur engine seedha dheele editor
    // raste par chala gaya, jahan run atka raha).
    for (let hunt = 0; hunt < 3 && !more.found; hunt++) {
      if (hunt > 0) await sleep(1200);
      let onGrid = false;
      try { onGrid = await this.page.evaluate(() => document.querySelectorAll('flow-grid-tile-container').length > 0); } catch (e) {}
      if (onGrid) {
        const idx = await this._resolveTileIndexForTask(task, tileIndexHint);
        if (idx >= 0) {
          const coords = await this._tileCenterCoords(idx);
          if (coords.found) {
            await this.page.mouse.move(coords.x, coords.y);
            await sleep(900);
          }
          more = await findMoreControl(idx);
        }
      } else {
        // Editor khula hai — uske ⋮ button ko dhoondho (page scope).
        more = await findMoreControl(-1);
      }
    }
    if (!more.found) {
      this.log(`[Prompt #${n}] The ⋮ (more options) button was not found on its tile even after 3 tries — the editor form will be tried.`, 'warn');
      attempts.push({ strategy: 'native-menu', ok: false, note: 'the ⋮ (more options) button was not found even after 3 tries' });
      return false;
    }
    this.log(`[Prompt #${n}] Opening the ⋮ (more options) menu — Download will be searched inside it…`, 'info');
    await this.page.mouse.click(more.x, more.y);
    await sleep(800);

    // Menu ke render hone ka intezaar (~10s poll): overlay ke andar
    // EXACT "Download" wala item (inspection hissa 2, VERIFIED —
    // tile ke ⋮ menu me download ka label sirf "Download" hai;
    // "Download media" wahan NAHI hota, wo sirf editor ki top bar
    // me hai). Isiliye yahan 'download' shamil-wala dhundhla match
    // nahi, exact label hi chalega.
    let item = { found: false };
    for (let r = 0; r < 20; r++) {
      try {
        item = await this.page.evaluate(() => {
          // v2.10.0: matcher SAAF karke pehchanta hai. v2.8.0 ka
          // exact 'download' wala match owner ke PC par mara —
          // asal Material menu item ke andar icon (mat-icon) ka
          // ligature text ("file_download" / "download") label ke
          // saath jud jata hai, to poora text kabhi sirf "download"
          // banta hi nahi. Ab: underscores saaf, har line alag
          // ummeedwaar, aur shabd-ke-taur par 'download' bhi chalega
          // (tile ke ⋮ menu me download wala item EK hi hota hai —
          // inspection se verified poori list).
          const norm = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
          const hasWord = (s, w) => (` ${s} `).includes(` ${w} `);
          const items = Array.from(document.querySelectorAll('.cdk-overlay-pane [role="menuitem"], .cdk-overlay-pane button, .mat-mdc-menu-panel [role="menuitem"], .mat-mdc-menu-panel button, [role="menu"] [role="menuitem"], [role="menu"] button'));
          for (const b of items) {
            const r = b.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) continue;
            const aria = norm(b.getAttribute('aria-label'));
            const raw = String(b.innerText || b.textContent || '');
            const lines = raw.split('\n').map(norm).filter(Boolean);
            const full = norm(raw);
            const iconTxt = norm((b.querySelector('mat-icon') || {}).textContent || '');
            const hit = aria === 'download'
              || lines.some(l => l === 'download')
              || full === 'download'
              || hasWord(full, 'download')
              || iconTxt === 'download' || iconTxt === 'file download';
            if (hit) {
              return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, how: (aria || full || 'download').substring(0, 60) };
            }
          }
          return { found: false };
        });
      } catch (e) { item = { found: false }; }
      if (item.found) break;
      await sleep(500);
    }
    if (!item.found) {
      this.log(`[Prompt #${n}] The ⋮ menu opened, but no Download item was found inside it.`, 'warn');
      // v2.48.29 (MENU-DIAG): menu khula lekin Download nahi
      // mila — andar asal me tha KYA, ye ek line me note kar
      // lo (sirf menu ke label — koi URL nahi). FASTTEST2 aur
      // FASTTEST3 dono me menu lagatar is mor par haara; agli
      // tashkhees isi saboot se hogi. Koi behavior change nahi.
      try {
        const menuTexts = await this.page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('.cdk-overlay-pane [role="menuitem"], .cdk-overlay-pane button, .mat-mdc-menu-panel [role="menuitem"], .mat-mdc-menu-panel button, [role="menu"] [role="menuitem"], [role="menu"] button'));
          const out = [];
          for (const b of items) {
            const r = b.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) continue;
            const t = String(b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 40);
            if (t && !out.includes(t)) out.push(t);
            if (out.length >= 12) break;
          }
          return out;
        });
        this.log(`[MENU-DIAG] [Prompt #${n}] menu items: ${Array.isArray(menuTexts) && menuTexts.length ? menuTexts.join(', ') : '(none visible)'}`, 'warn');
      } catch (e) {}
      attempts.push({ strategy: 'native-menu', ok: false, note: 'the menu opened but it had no Download item' });
      try { await this.page.keyboard.press('Escape'); } catch (e) {}
      await this._returnToProjectGrid();
      return false;
    }
    this.log(`[Prompt #${n}] Found the Download item inside the menu ("${item.how}") — clicking…`, 'info');
    // v2.48.27 (FAST-DL diagnostic): click ke is pal page ki blob
    // registry kitni bhari hai — sirf EK line; click-time
    // extraction is build me NAHI hai (bhavishya ke liye data).
    try {
      const regAtClick = await this._blobRegistryCount();
      this.log(`[FAST-DL] registry at click: ${regAtClick < 0 ? 'unknown' : regAtClick} entries`, 'info');
    } catch (e) {}
    const clickTime = Date.now();
    await this.page.mouse.click(item.x, item.y);
    const res = await this._nativePickResolution(settings && settings.quality);
    // v2.48.31 (MINT-WINDOW): resolution click ke is pal se
    // mint khidki khul gayi — pehli flow-content sighting tak
    // ki har request [MINT] req line banegi, aur sighting par
    // khulasa (beech me kitni requests gayin). Sawal (B): kisi
    // API jawab ke andar signed URL aata hai kya — carries
    // wali [MINT] lines wahi batayengi.
    this._mintOpenWindow(res.clickedAt || clickTime);
    // v2.48.30 (POST-CLICK RACE): seedha intezaar nahi —
    // resolution click ke baad browser download ke intezaar
    // ke saath-saath server channel par bhi nazar rehti hai
    // (taaza flow-content URL dikhte hi parallel fetch).
    const ok = await this._nativeAwaitWithRace(task, prep, res.clickedAt || clickTime, 90000, downloadFolder, settings);
    if (ok) {
      // Owner ka standing rule: render→save gap har video ka ALAG.
      const gapBase = task.renderCompletedAt || clickTime;
      const gapSec = Math.max(0, (Date.now() - gapBase) / 1000).toFixed(1);
      this.log(`[FAST-DL] [Prompt #${n}] menu-first save gap=${gapSec}s event=${task._nativeEventDriven ? 'yes' : 'no'}`, 'success');
    }
    attempts.push({ strategy: 'native-menu', ok, note: ok ? 'the file came from the menu\'s Download item' : 'the menu\'s Download item was clicked, but no file arrived' });
    if (!ok) this.log(`[Prompt #${n}] No file came from the menu route either.`, 'warn');
    return ok;
  }

  /**
   * v2.48.30 (POST-CLICK RACE): _nativeAwaitAndSave ke gird
   * muqabla. Menu ke resolution ("360p Original size") click
   * ke BAAD — jab ke page file ko flow-content.google se
   * mangwa raha hota hai aur blob banne me ~7–15s lagte hain
   * (E1TEST/FASTTEST4 ke log) — browser download ke intezaar
   * ke saath-saath networkCapture par nazar rakho (~200ms
   * poll): is attempt ke APNE click ke baad pehli baar dikha
   * taaza flow-content video URL (pehchan ka langar yahi
   * click hai; flowContent.pickRaceFlowContentUrl — stale /
   * claimed / ajnabi URL hamesha inkaar) milte hi wahi file
   * Node se seedha fetch karo, maujooda mashineri se hi
   * (_serverFetchSave → downloadFromCapturedStream: session
   * cookies + asal UA + content gate + quality gate +
   * _saveBufferForTask).
   *
   * JEET KA FAISLA: jo pehle VERIFIED save de — app fetch ya
   * Chrome ka blob download (asal _nativeAwaitAndSave wali
   * finalization) — wahi jeeta. Haarne wala saaf chhod diya
   * jata hai: task._raceAbandoned nishaan native intezaar ko
   * rokta hai, aur _saveBufferForTask / native finalization
   * dono jagah "task.mediaSaved ho to dusra save NAHI" wala
   * darwaza dohri file aur dohri kitab-bandhi ko namumkin
   * karta hai — finalization hamesha EK hi rehti hai.
   * Click ke baad koi flow-content URL native intezaar ke
   * maujooda budget me na aaye to vyavhaar bilkul v2.48.29
   * jaisa hai (race chup rehti hai).
   */
  async _nativeAwaitWithRace(task, prep, clickTime, timeoutMs, downloadFolder, settings) {
    const n = task.promptIndex + 1;
    task._raceAbandoned = false;
    let settled = false;
    let raceUrl = '';
    const NEVER = new Promise(() => {});

    const nativePromise = this._nativeAwaitAndSave(task, prep, clickTime, timeoutMs, downloadFolder, settings)
      .then(v => { settled = true; return v; }, () => { settled = true; return false; });
    const nativeWin = nativePromise.then(v => (v ? { via: 'browser-download' } : NEVER));

    const serverWin = (async () => {
      const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 90000);
      while (!settled && Date.now() < deadline) {
        await sleep(200);
        if (settled || task.mediaSaved) break;
        let entries = [];
        try {
          entries = (this.netCapture && typeof this.netCapture.recentFlowContentVideos === 'function')
            ? this.netCapture.recentFlowContentVideos(clickTime)
            : [];
        } catch (e) { entries = []; }
        if (!entries || entries.length === 0) continue;
        const pick = flowContent.pickRaceFlowContentUrl(entries, {
          sinceMs: clickTime,
          isClaimed: (u) => {
            // v2.48.35: sirf claimed-set hi nahi — capture me
            // kisi AUR task ke naam bandha URL bhi "claimed"
            // hai (_pickServerFetchUrl wali hi discipline).
            try { return !!((this.netCapture && this.netCapture.isFlowContentClaimed(u)) || this._urlClaimedByOtherTask(u, task.captureKey || task.videoId || null)); } catch (e) { return false; }
          },
          isOwnUrl: (u) => this._isTaskOwnUrl(task, u)
        });
        if (!pick) continue;
        if (pick.ambiguous) {
          this.log(`[FAST-DL] [Prompt #${n}] post-click race: ${pick.count} fresh server addresses appeared after the click and none could be proven to be this task's own — the direct fetch was NOT used; the browser download continues alone.`, 'warn');
          return NEVER;
        }
        raceUrl = pick.url;
        this.log(`[FAST-DL] [Prompt #${n}] post-click race: a fresh server video address appeared after this attempt's own resolution click (click at ${new Date(clickTime).toISOString()}, first seen ${new Date(pick.at).toISOString()} — the click is the ownership anchor) — fetching it in parallel with the browser download…`, 'info');
        // v2.48.31 (MINT-WINDOW): yahi is khidki ki pehli
        // sighting hai — khulasa darj karo (beech ki ginati).
        this._mintNoteSighting(pick.at);
        let okFetch = false;
        try { okFetch = await this._serverFetchSave(task, downloadFolder, settings, { url: pick.url, via: 'post-click-race' }); } catch (e) { okFetch = false; }
        return (okFetch || task.mediaSaved) ? { via: 'server-fetch' } : NEVER;
      }
      return NEVER;
    })();

    const timeoutGuard = sleep(Math.max(5000, Number(timeoutMs) || 90000) + 5000).then(() => ({ via: null }));
    const winner = await Promise.race([nativeWin, serverWin, timeoutGuard]);

    if (winner && winner.via) {
      // Haarne wale ko saaf roko — kitab-bandhi EK hi hogi.
      task._raceAbandoned = true;
      if (raceUrl) {
        const gapBase = task.renderCompletedAt || clickTime;
        const gapSec = Math.max(0, (Date.now() - gapBase) / 1000).toFixed(1);
        this.log(`[FAST-DL] [Prompt #${n}] post-click race via=${winner.via} gap=${gapSec}s`, winner.via === 'server-fetch' ? 'success' : 'info');
      }
      if (winner.via === 'server-fetch') return true;
      return await nativePromise;
    }
    return await nativePromise;
  }

  /**
   * Native UI ke DO roop ek ke baad ek — pehla safal roop jeet
   * (inspection hissa 2, VERIFIED): pehle tile ke ⋮ menu ka exact
   * "Download" (grid se bahar jana hi nahi padta), phir editor ki
   * top bar ka "Download media". Hover wala roop v2.8.0 me gaya —
   * tile par hover karne se download button aata hi NAHI hai.
   */
  async _downloadViaNativeUi(task, downloadFolder, settings, tileIndexHint, attempts, opts = {}) {
    const prep = await this._nativePrepareWatch(downloadFolder);
    // v2.48.27: menu roop agar is round me pehle hi (menu-first)
    // chal chuka ho to yahan dobara NAHI — sirf editor roop.
    const forms = [];
    if (!opts.skipMenuForm) {
      forms.push(() => this._nativeMenuForm(task, prep, downloadFolder, settings, tileIndexHint, attempts));
    }
    forms.push(() => this._nativeEditorForm(task, prep, downloadFolder, settings, tileIndexHint, attempts));
    for (const run of forms) {
      if (this.isStopping) return false;
      let ok = false;
      try { ok = await run(); } catch (e) {
        const t = plainError.translateError(e);
        this.log(`[Prompt #${task.promptIndex + 1}] A problem in one download form — ${t.plain}. The next form will be tried.`, 'warn', { rawError: t.raw });
      }
      if (ok) return true;
    }
    return false;
  }

  /**
   * v2.8.0 — NETWORK CAPTURE ka binding yahan aata hai: kisi task ka
   * media link Flow ke backend (API) ke jawab se bandha. Task agar
   * pehle se register hai (monitor/download-retry chal raha hai) to
   * usi pal TURANT fetch shuru ho jata hai — render monitor ke tile
   * "ready" bolne ka intezaar hi nahi hota. Task abhi register nahi
   * hai (submit aur monitor ke beech ka pal) to link early-store me
   * rehta hai; registration par wahi uthaya jata hai.
   */
  _onBackendMediaBound(key, url, via) {
    if (!key || !url) return;
    const task = this._captureTasks.get(key);
    if (!task) {
      this._earlyBackend.set(key, { url, via });
      return;
    }
    if (task.backendVideoUrl === url) return;
    task.backendVideoUrl = url;
    task.backendUrlVia = via;
    // Agar is pal task ka download orchestrator pehle se chal raha
    // hai, to turant fetch NA chalao (do fetch ek saath ek hi file
    // par ja sakte hain) — link task par bandha reh gaya hai,
    // orchestrator ki backend ranneeti ya download-retry use uthayegi.
    if (task._downloadInProgress) return;
    if (task._backendCtx && !task.downloaded && !task.mediaSaved && !this.isStopping) {
      this._kickBackendFetch(task, task._backendCtx);
    }
  }

  /**
   * v2.8.0: monitor / download-retry kisi task ko backend ke liye
   * register karta hai (download folder + settings ke saath). Pehle
   * se bandha link ho to wahi uthaya jata hai aur fetch turant
   * shuru ho jata hai.
   */

  /**
   * v2.48.13 — DIRECT-API POLL (owner ki demand: "render hote hi
   * link fetch ho jaye"). Passive capture page ke apne jawabon ka
   * intezaar karta hai; ye poller us se aage hai: page khud haal
   * jaanne ke liye jo asal API request bhejta hai (GetWorkflow /
   * List* — capture use template ke roop me yaad rakhta hai), poller
   * USI request ko page ke andar se har 1.5s replay karta hai.
   * Replay ka jawab maujood capture pipeline (ingestResponse) se
   * guzarta hai — pehchan/bandish ke saare usool waise ke waise;
   * link bandhte hi _onBackendMediaBound download foran shuru kar
   * deta hai. Template na mile (page ne abhi koi status call nahi
   * ki) to poller khamoshi se intezaar karta hai — passive capture
   * peeche chal hi raha hota hai. 5 lagatar nakam replays par
   * poller khud band ho jata hai (passive raasta hamesha zinda).
   */
  _startApiPoll(task) {
    const key = task && (task.captureKey || task.videoId) ? (task.captureKey || task.videoId) : null;
    if (!key || this._apiPolls.has(key)) return;
    const state = { stopped: false, fails: 0, timer: null, startedAt: Date.now(), announced: false, tplSeen: false };
    this._apiPolls.set(key, state);
    const loop = async () => {
      if (state.stopped) return;
      try { await this._apiPollTick(task, key, state); } catch (e) {}
      if (!state.stopped) state.timer = setTimeout(loop, 1500);
    };
    state.timer = setTimeout(loop, 1200);
  }

  _stopApiPoll(key) {
    const state = this._apiPolls.get(key);
    if (!state) return;
    state.stopped = true;
    if (state.timer) { try { clearTimeout(state.timer); } catch (e) {} }
    this._apiPolls.delete(key);
  }

  async _apiPollTick(task, key, state) {
    // Band hone ki shartein: engine ruk raha ho, page band ho,
    // link pehle hi bandh gaya ho, ya task ki 20-minute hadd.
    if (this.isStopping || !this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed())) {
      this._stopApiPoll(key); return;
    }
    if (Date.now() - state.startedAt > 20 * 60 * 1000) { this._stopApiPoll(key); return; }
    let bound = null;
    try { bound = this.netCapture.urlForKey(key); } catch (e) {}
    if (bound) { this._stopApiPoll(key); return; }
    let tpl = null;
    try { tpl = this.netCapture.templateForKey(key); } catch (e) {}
    if (!tpl) return; // template abhi nahi — passive capture chal raha hai
    if (!state.tplSeen) {
      state.tplSeen = true;
      this.log(`[Prompt #${(task.promptIndex || 0) + 1}] Direct API check is active — asking Flow's backend directly for this video's link every 1.5s.`, 'info');
    }
    let res = null;
    try {
      res = await downloadGuard.withTimeout(
        this.page.evaluate(async (u, h, b64) => {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const r = await fetch(u, { method: 'POST', headers: h, body: bytes, credentials: 'include' });
          const buf = await r.arrayBuffer();
          const u8 = new Uint8Array(buf);
          let s = '';
          for (let i = 0; i < u8.length; i += 8192) {
            s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
          }
          return { status: r.status, b64: btoa(s) };
        }, tpl.url, tpl.headers, tpl.body.toString('base64')),
        10000, 'direct-api poll');
    } catch (e) { res = null; }
    if (!res || res.status >= 400 || !res.b64) {
      state.fails++;
      if (state.fails >= 5) this._stopApiPoll(key);
      return;
    }
    state.fails = 0;
    try {
      const buf = Buffer.from(res.b64, 'base64');
      if (buf.length > 0) {
        this.netCapture.ingestResponse({ url: tpl.url, contentType: 'application/grpc-web+proto', bodyBuffer: buf, at: Date.now() });
      }
    } catch (e) {}
    try {
      if (this.netCapture.urlForKey(key)) {
        if (!state.announced) {
          state.announced = true;
          this.log('Direct API check: the video link arrived from the backend — download starting now.', 'info');
        }
        this._stopApiPoll(key);
      }
    } catch (e) {}
  }

  registerBackendTask(task, downloadFolder, settings) {
    if (!task) return;
    const key = task.captureKey || task.videoId || null;
    if (!key) return;
    task._backendCtx = { downloadFolder, settings };
    this._captureTasks.set(key, task);
    let bound = null;
    try { bound = this.netCapture.urlForKey(key); } catch (e) {}
    if (!bound && this._earlyBackend.has(key)) bound = this._earlyBackend.get(key);
    if (bound && bound.url && !task.downloaded && !task.mediaSaved) {
      task.backendVideoUrl = bound.url;
      task.backendUrlVia = bound.via;
      if (!this.isStopping) this._kickBackendFetch(task, task._backendCtx);
    }
  }

  /** Ek hi task ka backend fetch ek hi baar chalega — in-flight guard. */
  _kickBackendFetch(task, ctx) {
    if (task._backendFetchPromise) return task._backendFetchPromise;
    const p = this._fetchBackendAndSave(task, ctx).catch(() => false);
    task._backendFetchPromise = p;
    // v2.48.0: an honest IN-FLIGHT flag — the promise object stays
    // referenced after it settles, so "promise exists" cannot tell
    // the v2.48.0 defer rule (defer only while a fetch is really
    // running) what it needs to know.
    task._backendFetchInFlight = true;
    const clearInFlight = () => { task._backendFetchInFlight = false; };
    p.then(clearInFlight, clearInFlight);
    return p;
  }

  /**
   * Immediate zero-click mainpage handoff. A complete googlevideo
   * candidate is offered to the oldest eligible task as soon as capture
   * sees it. Binding still goes through mainpageBindingPlan, and saving
   * still goes through _mainpageCompleteCandidate's normal gates.
   */
  async _onMainpageCandidate(info) {
    const entry = info && info.entry;
    if (!entry || !entry.url || !this.netCapture || this.isStopping) return;
    const tasks = [];
    try {
      for (const task of this._captureTasks.values()) {
        // `completed` means render completion in this engine, not a saved
        // file. Keep rendered-but-unsaved tasks eligible for the immediate
        // network handoff; only mediaSaved closes the handoff permanently.
        if (!task || task.mediaSaved || task._immediateMainpagePromise) continue;
        if (!task._backendCtx) continue;
        tasks.push(task);
      }
    } catch (e) { return; }
    tasks.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
    try { this.log(`[ROOT] immediate-candidate host=${networkCapture.hostOf(entry.url)} tasks=${tasks.length} entryBytes=${entry.bytes || 0}`, 'info'); } catch (e) {}
    for (const task of tasks) {
      const key = task.captureKey || task.videoId || null;
      if (!key) continue;
      let teacherUrl = null;
      try { teacherUrl = this.netCapture.teacherMintUrlForTemplate(null); } catch (e) {}
      if (teacherUrl && teacherUrl === entry.url) continue;
      let pendingOrder = [];
      let pendingOthers = 0;
      try {
        pendingOrder = typeof this.netCapture.mainpagePendingOrder === 'function'
          ? this.netCapture.mainpagePendingOrder() : [];
        pendingOthers = typeof this.netCapture.mainpagePendingOthers === 'function'
          ? this.netCapture.mainpagePendingOthers(key) : 0;
      } catch (e) {}
      const ownStart = Number.isFinite(task.renderCompletedAt) && task.renderCompletedAt > 0
        ? task.renderCompletedAt : (task.startTime || Date.now());
      let plan = null;
      try {
        plan = saveGuard.mainpageBindingPlan({
          candidates: [{ url: entry.url, firstSeenAt: entry.firstSeenAt || entry.at || Date.now(), seq: entry.seq || null }],
          ownKey: key,
          ownStart,
          pendingOrder,
          pendingOthers
        });
      } catch (e) { plan = null; }
      try { this.log(`[ROOT] immediate-plan task=${task.promptIndex || 0} bind=${!!(plan && plan.bind)} reason=${plan && plan.reason || 'none'} pendingOthers=${pendingOthers}`, 'info'); } catch (e) {}
      if (!plan || !plan.bind || plan.url !== entry.url) continue;
      // Immediate backend fetch: bind the captured candidate URL to this task
      // and start the backend download directly (no button, no menu, no waits).
      task.backendVideoUrl = entry.url;
      task.backendUrlVia = 'capture-immediate';
      // Set up the backend context immediately so _kickBackendFetch has
      // the download folder and settings ready; this is the "video banta hi"
      // trigger — the backend download starts the moment the URL is captured.
      const settings = this.currentSettings || {};
      const folder = this.currentDownloadDir;
      task._backendCtx = { downloadFolder: folder, settings };
      const attempts = Array.isArray(task.downloadAttempts) ? task.downloadAttempts : (task.downloadAttempts = []);
      // In-flight guard: if a fetch is already running for this task, return it;
      // the saved promise is used by the existing completion path below.
      const backendFetchPromise = this._kickBackendFetch(task, task._backendCtx);
      // Wait for the immediate backend fetch to settle. If it saved the file,
      // the slow mainpage-harvest path (in-page fetch + harvest) must be skipped.
      let backendOk = false;
      try { backendOk = await backendFetchPromise; } catch (e) { backendOk = false; }
      if (backendOk) return;
      // Fallback: if the backend fetch could not save the file, use the mainpage
      // completion path (in-page fetch, duration verification, then save).
      task._immediateMainpagePromise = Promise.resolve()
        .then(() => this._mainpageCompleteCandidate(task, folder, settings, attempts, entry, {
          captureKey: key,
          bindReason: 'capture-immediate',
          floorBytes: this.netCapture.harvestFloorBytes || 0,
          teacherUrl,
          teacherHash: null,
          timingBucket: () => 'capture-immediate',
          gapSec: () => Math.max(0, (Date.now() - (task.renderCompletedAt || task.startTime || Date.now())) / 1000).toFixed(1),
          tileIndexHint: task.tileIndex
        }))
        .catch(() => 'error')
        .finally(() => { task._immediateMainpagePromise = null; });
      // One candidate is assigned to one task per callback.
      break;
    }
  }

  /**
   * v2.8.0: backend se bandha link seedha fetch karke save karo —
   * wahi authenticated tareeka jo stream download ka hai (page ke
   * session cookies ke saath Node fetch; file save par ffprobe
   * jaanch _saveBufferForTask ke andar hoti hai). FIFE links jaldi
   * expire hote hain, isliye pehli nakami par ek aur koshish.
   * Signed URL khud kabhi log NAHI hota — sirf host ka naam.
   */
  async _fetchBackendAndSave(task, ctx) {
    const url = task.backendVideoUrl;
    if (!url || !ctx) return false;
    const n = (task.promptIndex || 0) + 1;
    if (task.mediaSaved) return true;
    // Pehchan: ye link network capture se bandha hai — yahi is task
    // ka apna hone ka saboot hai (tile wale apna-URL gate se upar
    // ki hifazat: workflowId / currentSrc / kram ki bandish).
    task.completedVideoUrl = url;
    const viaShabd = task.backendUrlVia === 'workflow-id'
      ? 'bound by workflowId identification'
      : (task.backendUrlVia === 'currentSrc' ? 'confirmed from the tile\'s currentSrc' : 'bound by sequence order');
    this.log(`[Prompt #${n}] Got a direct link from the backend (${viaShabd}) — downloading, without any button… · link shape: ${networkCapture.urlShape(url)}`, 'info');
    if (!task._backendNotified) {
      task._backendNotified = true;
      try { this.onBackendMedia(task, { via: task.backendUrlVia || 'workflow-id', host: networkCapture.hostOf(url) }); } catch (e) {}
    }
    // v2.48.9: this is the hot path — backend link only (the flag
    // keeps downloadFromCapturedStream off the slow in-page route;
    // the background queue / download-retry paths still have
    // every route if this cannot save the file).
    task._backendHotFetch = true;
    const fetchStartedAt = Date.now();
    let ok = false;
    // v2.48.73 (SPEED A — CAPTURED BUFFER): koi network
    // fetch se PEHLE networkCapture ki kitab dekho — is
    // URL ki mukammal body aksar pehle hi pakdi ja chuki
    // hoti hai (.72 field run, 2026-11-09 19:45: editor
    // ki flow-content body 4,872,159B entry kitab me thi,
    // phir bhi wahi file ~9.5s ki ranged fetch se dobara
    // utari gayi). Held/assembled body ho aur header
    // video jesa ho to seedha save point par do —
    // mukammaliat ka asal faisla .70 duration gate hi
    // karega (assembled lambai entry ke content-length
    // ke barabar hona zaroori nahi — chunk
    // reconstruction me 4,867,800 vs 4,872,159 jesa
    // farq aam hai). Kitab me body na ho ya gate reject
    // kar de to neeche wala asal fetch rasta hu-bahu
    // chalta hai — us me koi tabdeeli nahi.
    try {
      const heldCap = (this.netCapture && typeof this.netCapture.mainpageBodyForUrl === 'function')
        ? this.netCapture.mainpageBodyForUrl(url) : null;
      if (heldCap && heldCap.buffer && heldCap.buffer.length > 0 && downloadFetch.looksLikeVideoBuffer(heldCap.buffer)) {
        const capOk = await this._saveBufferForTask(task, ctx.downloadFolder, ctx.settings, heldCap.buffer, url, 'captured-buffer');
        if (capOk || task.mediaSaved) {
          ok = true;
          const g = Math.max(0, (Date.now() - (task.renderCompletedAt || task.startTime || Date.now())) / 1000).toFixed(1);
          this.log(`[ROOT] via=captured-buffer gap=${g}s`, 'success');
        }
      }
    } catch (e) { ok = false; }
    if (!ok && !task.mediaSaved) {
      try { ok = await this.downloadFromCapturedStream(task, ctx.downloadFolder, ctx.settings); } catch (e) { ok = false; }
    }
    if (!ok && !task.mediaSaved && !this.isStopping) {
      // v2.38.0: before the second try, if the server REFUSED the
      // backend link (HTTP 403/404 — the signature was not servable
      // yet, or the minted link went stale), do not just re-GET the
      // same string: ask the task's OWN tile for its current URL
      // first. The player's currentSrc is re-signed by Flow as the
      // tile plays, so it is the freshest link available — and it
      // comes from the task's own fingerprint-resolved tile, so the
      // identity gate is the strongest one there is. A different
      // own-URL replaces the fetch target for the second try; the
      // backend URL stays recorded on the task either way.
      const refused = (task._lastFetchSteps || []).some(s => s && !s.ok && (s.status === 403 || s.status === 404));
      if (refused) {
        try {
          const fresh = await this._extractTileMediaUrlDetailed(task, task.tileIndex, !!(ctx.settings && ctx.settings.type === 'Image'));
          if (fresh && fresh.url && fresh.url !== url && this._isTaskOwnUrl(task, fresh.url)) {
            task.completedVideoUrl = fresh.url;
            this.log(`[Prompt #${n}] The backend link was refused — retrying with the fresh link from the tile itself (${fresh.via}).`, 'info');
          }
        } catch (e) {}
      }
      await sleep(1500);
      try { ok = await this.downloadFromCapturedStream(task, ctx.downloadFolder, ctx.settings); } catch (e) { ok = false; }
    }
    if (!ok && !task.mediaSaved) {
      const failSummary = this._fetchSummary(task);
      this.log(`[Prompt #${n}] The backend link had been found, but the file could not be made from it${failSummary ? ` (attempts: ${failSummary})` : ' (the link may have expired)'}. The remaining routes will be tried.`, 'warn');
      // Clear in-flight guard so the download stage can retry the backend route
      task._backendFetchPromise = null;
      task._backendFetchInFlight = false;
    }
    task._backendHotFetch = false;
    if (ok) {
      task._backendFetchMs = Date.now() - fetchStartedAt;
      this.log(`[Prompt #${n}] Backend download finished in ${(task._backendFetchMs / 1000).toFixed(1)}s (file saved + verified).`, 'success');
    }
    return !!ok;
  }

  /**
   * v2.8.0: download ki PEHLI ranneeti — backend. Pehle se bandha
   * link ho (ya turant-fetch chal raha ho) to usi se file lao; na
   * ho to kuch mat karo (caller agle raaston par jayega). Network
   * par is poori run me koi video link dikha hi nahi ho to wo
   * khabar bhi (ek baar) saaf log hoti hai — khamoshi kabhi nahi.
   */
  async _tryBackendDownload(task, downloadFolder, settings, attempts) {
    const key = task.captureKey || task.videoId || null;
    const n = (task.promptIndex || 0) + 1;
    if (task.mediaSaved) return true;
    if (task._backendFetchPromise) {
      // v2.30.0: never re-await a possibly-hung fetch promise
      // forever — bound it, and on timeout drop the reference so
      // the fresh fetch below can start (the stuck one is
      // discarded, its late result ignored).
      let ok = false;
      try { ok = await downloadGuard.withTimeout(task._backendFetchPromise, 120000, 'immediate backend fetch'); } catch (e) { ok = false; }
      attempts.push({ strategy: 'backend-fetch', ok: !!ok, note: ok ? 'as soon as the backend link was found, the file was saved by an immediate fetch' : `the backend link was found, but the immediate fetch could not save the file${this._fetchSummary(task) ? ` — ${this._fetchSummary(task)}` : ''}` });
      if (ok || task.mediaSaved) return true;
      // Turant fetch fail hua — ek baar phir, taze bandhan ke saath.
      task._backendFetchPromise = null;
    }
    let bound = task.backendVideoUrl ? { url: task.backendVideoUrl, via: task.backendUrlVia } : null;
    if (!bound && key) {
      try { bound = this.netCapture.urlForKey(key); } catch (e) { bound = null; }
      if (!bound && this._earlyBackend.has(key)) bound = this._earlyBackend.get(key);
    }
    if (bound && bound.url) {
      task.backendVideoUrl = bound.url;
      task.backendUrlVia = bound.via;
      if (key) this._captureTasks.set(key, task);
      task._backendCtx = { downloadFolder, settings };
      const ok = await this._kickBackendFetch(task, task._backendCtx);
      attempts.push({ strategy: 'backend-fetch', ok: !!ok, note: ok ? 'the link bound from the backend (network) was fetched directly and saved' : `the backend link was found, but no file was made from the fetch${this._fetchSummary(task) ? ` — ${this._fetchSummary(task)}` : ' (the link may have expired)'}` });
      return !!ok;
    }
    const seen = this.netCapture ? this.netCapture.stats.mediaUrlsSeen : 0;
    attempts.push({
      strategy: 'backend-fetch', ok: false,
      note: seen > 0
        ? 'no link was bound on the backend for this task (a total of ' + seen + ' video links were seen on the network, but not a single one identified as this prompt\'s)'
        : 'no video link was seen at all on the backend (network) in this run'
    });
    if (seen === 0 && !this._backendNoteLogged) {
      this._backendNoteLogged = true;
      // v2.10.0: khabar ke saath DIAGNOSTICS bhi — network par kul
      // kitne jawab aaye, unme API kitne, media jawab kitne, aur
      // kin hosts se. Agli baar ka log khud batayega ki sunne wala
      // (capture) zinda tha ya Flow ka data kisi band-na-hone-wale
      // streaming connection se aata hai.
      let diag = '';
      try {
        const snap = this.netCapture.statsSnapshot();
        diag = ` (Network check: ${snap.responsesSeen} responses came in total, API ${snap.apiResponses}, media responses ${snap.mediaResponsesSeen}; hosts: ${snap.topHosts || '—'})`;
        // v2.48.16 DIAGNOSTIC: poora census — API requests (sirf
        // jawab nahi), saare hosts, aur WebSocket ki poori
        // tafseel. TEST493 me API responses 0 the; ye line
        // batayegi ke data asal me kis raaste aata hai.
        const ws = snap.ws || {};
        diag += ` [DIAGNOSTIC — API requests: ${JSON.stringify(snap.apiRequests || {})}; all hosts: ${snap.allHosts || '—'}; WebSockets: ${ws.sockets || 0} opened (${(ws.urls || []).join(', ') || 'none'}), frames in ${ws.framesIn || 0} (${ws.bytesIn || 0} bytes), frames out ${ws.framesOut || 0}, frames carrying a media link: ${ws.mediaFrames || 0}, frames carrying a workflow id: ${ws.workflowFrames || 0}]`;
        // v2.48.17 DIAGNOSTIC-2: request paths + flow ke apne
        // jawabon ke andar ki talash (CDP-wala WebSocket hisaab
        // upar wale [DIAGNOSTIC] me hi aata hai).
        const fb = snap.flowBodies || {};
        diag += ` [DIAGNOSTIC-2 — request paths: ${snap.topPaths || '—'}; flow.google.com bodies scanned: ${fb.scanned || 0}, carrying a media host: ${fb.mediaHostHits || 0}, carrying a workflow id: ${fb.workflowHits || 0}, mentioning aisandbox: ${fb.aisandboxHits || 0}]`;
        // v2.48.18 DIAGNOSTIC-3: sirf batchexecute darwaze ka
        // poora hisaab — requests/rpcids, jawab, padhe gaye
        // bodies, chhoote huon ki wajah, aur andar ke nishan.
        const b = snap.batch || {};
        diag += ` [DIAGNOSTIC-3 — batchexecute requests: ${b.requests || 0} (rpcids: ${JSON.stringify(b.rpcids || {})}), responses: ${b.responses || 0} (content-types: ${JSON.stringify(b.contentTypes || {})}), bodies read: ${b.bodiesFetched || 0}, CDP bodies read: ${b.cdpBodies || 0}, streamed chunks: ${b.streamChunks || 0}, stream-bound: ${b.streamBound || 0}, skipped too-big: ${b.skipTooBig || 0}, skipped buffer-fail: ${b.skipBuffer || 0}; bodies carrying: media host ${b.withMediaHost || 0}, videoplayback ${b.withVideoplayback || 0}, workflow word ${b.withWorkflow || 0}, fife word ${b.withFife || 0}, download word ${b.withDownloadWord || 0}; link shapes inside bodies: ${JSON.stringify(b.urlShapes || {}).slice(0, 500)}]`;
      } catch (e) {}
      this.log(`[Prompt #${n}] No video link was seen on the backend — the UI routes are being tried.${diag}`, 'warn');
    }
    return false;
  }

  /**
   * DOWNLOAD ORCHESTRATOR (v2.8.0 ki tartib): ek task ke liye saari
   * ranneetiyan ek tartib me, har koshish ki saaf log line ke saath.
   * Pehli safal ranneeti par ruk jao. Saari fail hon to
   * { ok:false, attempts } lautta hai — caller (monitor) task ko
   * stage 'download' ke saath fail karta hai; Activity detail me har
   * ranneeti ka natija jata hai.
   *
   * Tartib (v2.8.0 — backend sabse pehle, UI sirf fallback):
   *   1. backend-fetch: network capture se workflowId ki pehchan se
   *      bandha link, seedha fetch (turant-fetch pehle hi chal raha
   *      ho to usi ka natija). Koi button/menu nahi.
   *   2. tile-src / captured-stream: tile ke apne <video>/<source>
   *      element ka src (src / currentSrc) — wahi URL network par
   *      bhi dekha gaya ho to wo backend ki pushti (currentSrc
   *      cross-match) ke saath 'backend-fetch' ginata hai.
   *   3. backend kram (order): kataar ke sabse aage wale task ko
   *      sabse pehle mila bin-bandha link (sirf yahi, download ke
   *      pal par).
   *   4. native UI ke DO roop (inspection hissa 2, VERIFIED):
   *      tile ke ⋮ menu ka exact "Download", phir editor ki top
   *      bar ka "Download media". (Hover par download button hota
   *      hi NAHI — wo ranneeti v2.8.0 me hata di gayi.)
   * Har ranneeti SIRF task ki apni pehchan par chalti hai — galat
   * task ka video kabhi nahi.
   */
  /**
   * v2.41.0 (Fix list C, item 4): download ROUNDS on this engine
   * instance are serialized through a simple promise chain. The
   * render monitor already awaits one task's round before moving
   * to the next, but download-retry (retryDownloadForTask) and a
   * Resume can reach this orchestrator while a monitor round is
   * still running on the SAME page — two rounds driving one grid
   * at once interleave their tile reads, scrolls and menu clicks.
   * The chain guarantees one round at a time per engine, whoever
   * the caller is. It cannot deadlock: nothing inside a round
   * calls back into downloadTaskMedia (the immediate backend fetch
   * is per-task guarded separately and is not a round), and the
   * stored chain never rejects, so one failed round can never
   * stall every later round behind it.
   */
  async downloadTaskMedia(task, downloadFolder, settings, tileIndexHint) {
    // v2.48.62 (ZC30 TEST FLAG — skipFirstTaskDownload):
    // is run ke pehle prompt ka download marhala jaan-
    // boojh kar chhoda gaya hai (ZC30 ka 'first vs latest
    // vs interference' tajurba). Round kataar me dakhil
    // hi NAHI hota: koi download attempt NAHI gina jata
    // (ledger ka roundSettled kabhi nahi chalta), prompt
    // dobara submit NAHI hota, aur task.downloaded ko
    // haath NAHI lagta — natija { ok:false, skipped:true }
    // hai, jise monitor 'download-failed' se alag pehchan
    // kar task ko imaandari se parked (pending +
    // needs_check) rakhta hai.
    if (skipFirstDownloadApplies(settings, task)) {
      // v2.48.63 (Item C — LATCH): pehli dafa line
      // bolti hai aur taskId is session ki kitab me
      // darj ho jata hai; us ke baad ke saare calls
      // (drain, retry, final pass) khamoshi se wahi
      // natija dete hain — koi shor nahi, koi dobara
      // koshish nahi.
      const skipKey = task.taskId;
      if (skipKey != null && this._skipParkedTaskIds.has(skipKey)) {
        return { ok: false, skipped: true, attempts: [] };
      }
      if (skipKey != null) this._skipParkedTaskIds.add(skipKey);
      const n = (task.promptIndex || 0) + 1;
      this.log(`[ROOT] [Prompt #${n}] download SKIPPED by test flag (skipFirstTaskDownload) — task stays parked; prompt NOT resubmitted; no download attempt counted`, 'info');
      return { ok: false, skipped: true, attempts: [] };
    }
    const run = () => this._downloadTaskMediaRound(task, downloadFolder, settings, tileIndexHint);
    const chained = (this._downloadRoundChain || Promise.resolve()).then(run, run);
    this._downloadRoundChain = chained.then(() => undefined, () => undefined);
    return chained;
  }

  async _downloadTaskMediaRound(task, downloadFolder, settings, tileIndexHint) {
    const n = (task.promptIndex || 0) + 1;
    // v2.31.3 (download fix pack, ADOPT #1 + #3): a ROUND is one
    // pass of this orchestrator. Rounds are counted on the task's
    // database row through the download ledger port (durable across
    // runs and restarts) and capped at 3: once the budget is spent
    // the task parks as pending + needs_check and the run moves on
    // — a stuck download can never block or fail the whole run, and
    // a download retry NEVER resubmits the prompt (no credits can
    // be re-spent here; the guard only ever re-runs downloads).
    // An owner Resume / check-only recovery resets the budget to 0
    // (workerPool), and a successful download resets it too.
    // v2.48.0 (deep-audit fix #3): the cap and the counter are PER
    // CHANNEL — rounds this engine runs for the download-retry
    // (drain) draw on the drain's own persisted budget, never on
    // the monitor's, so a spent monitor budget can no longer starve
    // the retry that runs later on a settled page.
    const channel = this._downloadChannel === 'drain' ? 'drain' : 'monitor';
    const ROUND_CAP = downloadFetch.roundCapForChannel(channel);
    const taskId = task && task.taskId;
    let used = 0;
    if (taskId) {
      try { used = Number(this.downloadPort.attempts(taskId, channel)) || 0; } catch (e) { used = 0; }
    }
    if (taskId && used >= ROUND_CAP) {
      this.log(`[Prompt #${n}] This video's download has already been tried ${ROUND_CAP} times — it is parked (pending, check-only) and the run will move on. On the next Resume only its download will be tried again; the prompt will NOT be submitted again.`, 'warn');
      return {
        ok: false,
        capped: true,
        attempts: [{ strategy: 'download-step', ok: false, note: `download tried ${ROUND_CAP} of ${ROUND_CAP} times already — parked until the next Resume (download-only)` }]
      };
    }
    const roundNo = used + 1;
    if (taskId) {
      if (roundNo > 1) {
        this.log(`Download attempt ${roundNo} of ${ROUND_CAP} for Prompt #${n} — trying again (download only, the prompt is NOT generated again).`, 'warn');
      } else {
        this.log(`Download attempt 1 of ${ROUND_CAP} for Prompt #${n} (download only — the prompt is NOT generated again).`, 'info');
      }
    }
    task._downloadInProgress = true;
    let result = null;
    // v2.48.36 (ROOT PACK — A): DOWNLOAD-STAGE SERIALIZATION.
    // Poora download marhala (pehle route se save/aakhri
    // fallback tak) is capture session par ek pal me sirf
    // EK task ka chalta hai — generation/rendering is tale
    // se bahar aur parallel rehti hai. ZEROCLICK3 ki seekh:
    // do tasks ki harkat ek hi page par ulajhne se pehle
    // task ki mint binding download ke pal gum ho jati thi.
    // Kataar ka intezaar 1s se zyada ho to [ROOT] line.
    let stageHandle = null;
    try {
      stageHandle = await this._downloadStageLock.acquire();
      if (stageHandle.waitedMs > 1000) {
        this.log(`[ROOT] [Prompt #${n}] download-stage queued +${(stageHandle.waitedMs / 1000).toFixed(1)}s`, 'info');
      }
      // v2.48.36 (ROOT PACK — D): is round ki duration ka
      // size floor capture ko de do — page-fetch harvest
      // ke darwaze isi par chalte hain.
      try {
        if (this.netCapture) {
          this.netCapture.harvestFloorBytes = downloadFetch.minBytesForDuration(settings && settings.duration);
          // v2.48.70 (ITEM A): expected duration bhi
          // capture ko de do — harvest darwaze floor ki
          // jagah duration-tasdeeq bhi istemal kar sakte
          // hain (networkCapture._verifiedAcceptFor).
          this.netCapture.harvestExpectedDurationSec = this._expectedDurationSec(task, settings);
        }
      } catch (e) {}
      // v2.48.38 (EDITOR-HARVEST PACK): harvest-audit ki
      // khidki — ye round (stage-lock holder) chal raha hai,
      // ye khabar capture ko do; band finally me hota hai.
      try {
        if (this.netCapture && typeof this.netCapture.setDownloadAttempt === 'function') {
          this.netCapture.setDownloadAttempt(task.captureKey || task.videoId || null);
        }
      } catch (e) {}
      // v2.30.0 (2nd-video stall fix): the whole strategy chain runs
      // under downloadGuard — a hard deadline around a step that
      // used to have NO timeout anywhere, so one stuck await froze
      // the render monitor (and every later video) forever.
      // v2.31.3: the deadline is now per ROUND (150s since v2.48.0) and the guard's
      // own blind retry is OFF — rounds are governed by the
      // persisted ledger above, so every retry is counted, logged
      // and capped, never silent and never unbounded.
      result = await downloadGuard.attemptDownload(
        () => this._downloadTaskMediaInner(task, downloadFolder, settings, tileIndexHint),
        {
          timeoutMs: this.downloadRoundTimeoutMs || 150000,
          retries: 0,
          retryDelayMs: 0,
          label: `prompt #${n} download`,
          onTimeout: () => {
            this.log(`[Prompt #${n}] The download step took too long and was cut off (download only — the prompt will NOT be submitted again).`, 'warn');
          }
        }
      );
    } finally {
      task._downloadInProgress = false;
      // v2.48.31 (MINT): round khatam — mint watch band (har
      // rasta/timeout yahin se guzarta hai).
      try { this._mintEndWatch(); } catch (e) {}
      // v2.48.36 (ROOT PACK — D): is task ka harvest ab
      // kisi kaam ka nahi — kitab saaf (agli video ke liye
      // purani body kabhi candidate nahi banti).
      try {
        if (this.netCapture) this.netCapture.evictHarvest(task.captureKey || task.videoId || null);
      } catch (e) {}
      // v2.48.38 (EDITOR-HARVEST PACK): audit khidki bhi
      // band — is round ke baad ke jawab is task ke kabhi
      // nahi ginne jayenge. (v2.48.41: editor-khidki aur
      // background page dono khatam — editor ab kabhi
      // khulta hi nahi, is liye saaf karne ko kuch nahi.)
      try {
        if (this.netCapture) {
          const roundKey = task.captureKey || task.videoId || null;
          if (typeof this.netCapture.clearDownloadAttempt === 'function') this.netCapture.clearDownloadAttempt(roundKey);
        }
      } catch (e) {}
      if (stageHandle) { try { stageHandle.release(); } catch (e) {} }
    }
    // v2.48.40 (CASCADE DIAGNOSTIC — observe-only): is
    // attempt ke aakhir par ek line — is task ki file
    // ka address sab se pehle KAHAN dekha gaya tha aur
    // kya wo kisi editor ke khulne se pehle hi aa chuka
    // tha. Koi faisla is par nahi chalta; ye sirf agli
    // tehqeeq ka saboot hai (preEditorUrl=yes bane to
    // editor khole baghair wala rasta mumkin hai).
    // v2.48.41: editor ab kabhi khulta hi nahi — is liye
    // preEditorUrl address dikhne par hamesha 'yes'
    // rahega aur firstSeen kabhi 'editor-open' nahi
    // banega; line muqable ke liye barkarar hai.
    try {
      if (!(settings && settings.type === 'Image')
        && this.netCapture && typeof this.netCapture.cascadeForKey === 'function') {
        const cKey = task.captureKey || task.videoId || null;
        let cUrl = task.completedVideoUrl || task.backendVideoUrl || null;
        if (!cUrl && cKey) {
          try {
            const bound = this.netCapture.urlForKey(cKey);
            if (bound && bound.url) cUrl = bound.url;
          } catch (e) {}
        }
        const c = this.netCapture.cascadeForKey(cKey, cUrl);
        this.log(`[ROOT] cascade firstSeen=${c.firstSeen} preEditorUrl=${c.preEditorUrl}`, 'info');
      }
    } catch (e) {}
    // Settle the round in the persisted ledger — success resets the
    // budget to 0, failure records the round and its reason (in the
    // SAME channel the round was spent from, v2.48.0).
    if (taskId) {
      try {
        if (result && result.ok) {
          // v2.48.37: kamyaab download ka bandha hua address
          // session ka teacher langar bane (template seekha
          // gaya ho ya na ho) — replay muqabla ab langar ke
          // baghair nahi rahega jab kam se kam ek download
          // ho chuka ho.
          try {
            if (this.netCapture && typeof this.netCapture.noteTeacherUrlForKey === 'function') {
              this.netCapture.noteTeacherUrlForKey(task.captureKey || task.videoId || null);
            }
          } catch (e) {}
          this.downloadPort.roundSettled(taskId, true, '', channel);
        } else {
          const failedNotes = (result && Array.isArray(result.attempts))
            ? result.attempts.filter(a => a && !a.ok && a.note)
            : [];
          const note = result && result.timedOut
            ? `the download step did not finish within ${Math.round((this.downloadRoundTimeoutMs || 150000) / 1000)}s`
            : (failedNotes.length > 0 ? String(failedNotes[failedNotes.length - 1].note) : 'the download did not complete');
          this.downloadPort.roundSettled(taskId, false, note, channel);
        }
      } catch (e) {}
    }
    // v2.48.54 (GEMINI ZIP-REVIEW fix 3): aakhri
    // round bhi fail — is task ki mainpage khidki AB
    // band karo. Pehle khidki sirf save par band
    // hoti thi; fail par wo khuli reh jati aur baad
    // wali tasks ke rpcfeed/binding hisaab me ye
    // PARK ho chuki task hamesha 'pending' ginni
    // jati thi. Asal pending tasks ki reservation
    // barkarar hai — ye band sirf settle ke baad
    // hota hai, aur dobara koshish (Resume/sweep)
    // par khidki phir khul jati hai (noteWindow).
    try {
      if (result && !result.ok && !task.mediaSaved && roundNo >= ROUND_CAP) {
        const wKey = task.captureKey || task.videoId || null;
        if (this.netCapture && wKey && typeof this.netCapture.mainpageMarkWindowDone === 'function') {
          this.netCapture.mainpageMarkWindowDone(wKey);
          this.log(`[ROOT] [Prompt #${n}] mainpage-window-closed reason=attempts-exhausted`, 'info');
        }
      }
    } catch (e) {}
    return result;
  }

  /**
   * v2.41.0 (Fix list C, item 4) — MEDIA READINESS, the step the
   * 2026-10-27 first-try failures were missing. That evening's live
   * Activity records showed three first rounds where EVERY strategy
   * reported the same underlying fact in different words: backend
   * "no video link was seen at all on the backend (network) in this
   * run", tile-src "no media URL was found on the tile", the tile
   * menu "button not found", the editor "Download media not found"
   * — the Flow PAGE had not yet loaded the tile's media when round
   * 1 ran (a busy multi-task page). The retry a minute later
   * succeeded on every route, and all four single-prompt runs that
   * day succeeded first-try. So, before the strategies run: if
   * nothing is captured for this task yet, bring its tile into
   * view, hover it, nudge its <video> to play muted, and poll
   * (1s interval, up to ~25s) until the network capture binds a URL
   * for the task OR the tile's own element reports a src/currentSrc.
   *
   * Budget: this runs INSIDE _downloadTaskMediaInner, hence inside
   * the round's 150s downloadGuard deadline — worst case it spends
   * 25s and leaves at least ~125s for the four strategies. It NEVER
   * fails the round: on timeout (or any error) the strategies run
   * anyway, exactly as before. And when a captured URL already
   * exists — the normal single-task case — it returns immediately,
   * so those runs do not get slower.
   *
   * v2.47.4 (owner-approved FAST PATH): har poll ab tile ki
   * haalat _readTileMediaState se padhta hai. Jis poll me tile
   * ka % GAYA ho aur us ka src maujood ho (downloadFetch.
   * fastFetchUrl ka faisla), ye function { fastUrl, fastVia }
   * lautata hai — caller usi src se TURANT fetch shuru karta
   * hai, capture binding/strategy tartib ka intezaar kiye
   * bina. Capture pehle se bandha ho to wahi purana rasta
   * (ye function kuch nahi lautata, backend strategy usi
   * bandhe link ko leti hai) — signed capture link ki
   * tarjeeh barkarar. Fast-hit na mile to return null aur
   * sab kuch pehle jaisa.
   */
  async _awaitTileMediaReady(task, tileIndexHint, isImage, captureKey, n) {
    try {
      if (isImage) return; // readiness primes <video> media; image runs keep today's flow
      if (!task || task.mediaSaved) return;
      if (!this.page || this.page.isClosed()) return;
      // A link is already in hand from somewhere — skip the wait.
      if (task.backendVideoUrl || task.completedVideoUrl) return;
      if (captureKey && this.netCapture) {
        let bound = null;
        try { bound = this.netCapture.urlForKey(captureKey); } catch (e) {}
        if (bound && bound.url) return;
        if (this._earlyBackend && this._earlyBackend.has(captureKey)) return;
      }
      const idx = await this._resolveTileIndexForTask(task, tileIndexHint);
      if (idx < 0) return; // tile not locatable — the strategies report it, as today
      // v2.48.62 (TILE-MEDIA DIMS): is attempt ki pehli
      // tile-state reading par <video> ki asal shakl ek
      // dafa log me — dims/duration/readyState. Poll kai
      // dafa ghumta hai, line sirf pehli reading par.
      let dimsLogged = false;
      // v2.48.24: 25s -> 8s. TEST499/500 me bandhan ~1s me aa
      // gaya tha; TEST501 me 25s me bhi nahi aaya — lamba
      // intezaar sirf menu wale pakke raaste ko der karta hai.
      const WAIT_MS = 8000;
      const startedAt = Date.now();
      this.log(`[Prompt #${n}] The tile's video has not loaded on the page yet — bringing it into view and waiting for its link before trying the download routes…`, 'info');
      let ready = false;
      let viaReady = '';
      let fastHit = null;
      while (Date.now() - startedAt < WAIT_MS) {
        // Prime the tile: scroll into view, hover, muted play. The
        // player fetching its media is what makes the network
        // capture see (and bind) this task's URL — and what makes
        // the tile element itself report a currentSrc.
        try {
          await this.page.evaluate((tileIdx) => {
            const containers = document.querySelectorAll('flow-grid-tile-container');
            const target = containers[tileIdx] || null;
            if (!target) return;
            try { target.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
            try {
              target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
              target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            } catch (e) {}
            const vid = target.querySelector('video');
            if (vid) {
              try { vid.muted = true; } catch (e) {}
              try { const p = vid.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
            }
          }, idx);
        } catch (e) {}
        if (captureKey && this.netCapture) {
          let bound = null;
          try { bound = this.netCapture.urlForKey(captureKey); } catch (e) {}
          if (bound && bound.url) { ready = true; viaReady = 'the backend link was bound'; break; }
        }
        // v2.47.4: tile ki haalat ki ek jhalak — % gaya + src
        // maujood = FAST-HIT (caller turant fetch karega);
        // sirf src maujood (% abhi hai) = purani ready wali
        // break, rawaj bilkul pehle jaisa.
        const state = await this._readTileMediaState(task, idx);
        // v2.48.62 (TILE-MEDIA DIMS): pehli reading ki
        // ek line (upar wala dimsLogged jhanda).
        if (state && !dimsLogged) {
          dimsLogged = true;
          try {
            const w = state.videoWidth != null ? state.videoWidth : '-';
            const h = state.videoHeight != null ? state.videoHeight : '-';
            const d = state.duration != null ? state.duration : '-';
            const r = state.readyState != null ? state.readyState : '-';
            this.log(`[ROOT] tile-media dims=${w}x${h} dur=${d} ready=${r}`, 'info');
          } catch (e) {}
        }
        if (state && state.url) {
          const fastUrl = downloadFetch.fastFetchUrl(state);
          if (fastUrl) {
            fastHit = { fastUrl, fastVia: state.via };
            ready = true;
            viaReady = `the tile finished (its % is gone) and reports its link (${state.via})`;
            break;
          }
          ready = true; viaReady = `the tile reports its link (${state.via})`; break;
        }
        await sleep(1000);
      }
      const waitedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      if (ready) {
        this.log(`[Prompt #${n}] The tile's video link is ready (${viaReady}, after ~${waitedSec}s) — downloading now.`, 'success');
      } else {
        this.log(`[Prompt #${n}] The tile's video link did not appear within ${Math.round(WAIT_MS / 1000)}s — trying the download routes anyway.`, 'warn');
      }
      // v2.47.4: fast-hit ho to caller ko do, warna null
      // (pehle ye function kuch nahi lautata tha — jin raaston
      // par fast-hit nahi, un ka natija bilkul wahi hai).
      return fastHit;
    } catch (e) {
      // Readiness is a primer, never a gate: any failure just means
      // the strategies run exactly as they did before v2.41.0.
    }
  }

  /**
   * v2.48.35 (CLAIM DISCIPLINE EVERYWHERE): capture ke
   * bandhan (keyByUrl) me ye URL kisi AUR task ke naam hai
   * kya? Faisla saveGuard ke khalis usool se hota hai; ye
   * helper sirf kitab (map) tak pahunch deta hai. Har
   * opportunistic / registry / race wala rasta jo koi
   * URL ummeedwaar banata hai, isi darwaze se guzrega —
   * _pickServerFetchUrl pehle se yahi karta tha, ab
   * registry (blob) wala rasta aur race-pickeron ke
   * isClaimed callback bhi yahi karte hain (ZEROCLICK2:
   * registry ne Prompt #1 ke bandhe hue address ke bytes
   * Prompt #2 ke naam par save kar diye the).
   */
  _urlClaimedByOtherTask(url, captureKey) {
    try {
      if (!url || !this.netCapture || !this.netCapture.keyByUrl) return false;
      return saveGuard.claimedByOtherTask(this.netCapture.keyByUrl.get(url), captureKey || null);
    } catch (e) {
      return false;
    }
  }

  /**
   * v2.48.28: server-fetch ke liye URL chunna — pehchan ke
   * darwaze (audit fix #6 wala usool):
   *   - URL flowContent ke exact matcher se guzra ho (bulane
   *     wala sirf capture ki fehrist deta hai, phir bhi yahan
   *     dobara jaanch hai);
   *   - _isTaskOwnUrl: purana (pre-existing) ya pehle istemal
   *     shuda URL kabhi nahi;
   *   - capture ne use KISI AUR task ke naam kiya ho to kabhi
   *     nahi; ISI task ke naam ho to sab se mazboot (bound);
   *   - is khidki ka AKELA ummeedwaar bhi chalega — ye wahi
   *     kram-wali pehchan hai jo claimByOrder barson se deta
   *     hai, farq sirf itna ke khidki is attempt tak mehdood
   *     hai (v2.48.30: prime khatam — khidki attempt ke
   *     aaghaz se is pal tak ki hai);
   *   - kai ummeedwaar hon to sirf registry candidate ke URL se
   *     exact cross-match wala chalega — warna inkaar (doubt
   *     me galat video lene se behtar hai menu wala rasta).
   * Lautta hai: { url, via } | { ambiguous:true, count } | null.
   * null = is pal koi qabil URL nahi (inkar ki wajah pehle hi
   * filter me chhup gayi — ghalat URL 'usable' me aata hi nahi).
   */
  _pickServerFetchUrl(task, captureKey, entries, registryCandidateUrl) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const usable = [];
    for (const e of entries) {
      const url = e && e.url;
      if (!url || !flowContent.isFlowContentVideoUrl(url, e.type)) continue;
      if (!this._isTaskOwnUrl(task, url)) continue;
      let claimedBy = null;
      try { claimedBy = (this.netCapture && this.netCapture.keyByUrl) ? this.netCapture.keyByUrl.get(url) : null; } catch (err) {}
      if (saveGuard.claimedByOtherTask(claimedBy, captureKey)) continue;
      usable.push({ url, at: (e && e.at) || 0, bound: !!claimedBy });
    }
    if (usable.length === 0) return null;
    const bound = usable.find(u => u.bound);
    if (bound) return { url: bound.url, via: 'capture-bound' };
    if (usable.length === 1) return { url: usable[0].url, via: 'sole-candidate' };
    if (registryCandidateUrl) {
      const hit = usable.find(u => u.url === registryCandidateUrl);
      if (hit) return { url: hit.url, via: 'registry-cross-match' };
    }
    return { ambiguous: true, count: usable.length };
  }

  /**
   * v2.48.28: chune hue asal server URL ko Node se fetch karo —
   * poori mashineri wahi jo downloadFromCapturedStream ki hai
   * (session cookies + asal UA + ranged/plain koshishen +
   * content gate + _saveBufferForTask ki ffprobe pushti).
   * Fetch se pehle URL capture me claim ho jata hai, taaki
   * doosra task use is dauraan na le le.
   */
  async _serverFetchSave(task, downloadFolder, settings, pick) {
    const n = task.promptIndex + 1;
    this.log(`[FAST-DL] [Prompt #${n}] The file's own server address was seen (Flow's CDN flow-content.google, via=${pick.via}) — fetching the file straight from the server…`, 'info');
    try { if (this.netCapture) this.netCapture.claimFlowContentVideo(pick.url); } catch (e) {}
    task.completedVideoUrl = pick.url;
    let ok = false;
    try { ok = await this.downloadFromCapturedStream(task, downloadFolder, settings); } catch (e) { ok = false; }
    if (!ok && !task.mediaSaved) {
      const why = this._fetchSummary(task);
      this.log(`[FAST-DL] [Prompt #${n}] The direct server fetch did not save the file${why ? ` — ${why}` : ''} — it will not be retried in this attempt; the remaining routes will run.`, 'warn');
    }
    return !!(ok || task.mediaSaved);
  }

  /**
   * v2.48.36 (ROOT PACK — D) → v2.48.41 (MAIN-PAGE HARVEST
   * PACK): MAIN page ne khud server se jo mukammal bytes
   * khinche the, capture ne unhe is task ke naam kitab me
   * rakha hai to wohi EXACT file yahin save karo — koi
   * download click nahi, koi menu nahi, koi editor nahi,
   * koi dobara fetch nahi. Ye mainpage-harvest raaste ka
   * pehla (sab se tez) qadam hai. Save wahi
   * _saveBufferForTask se hota hai, is liye quality gate
   * + content-hash guard + ffprobe sab laagu rehte hain.
   * Bytes ek hi dafa istemal hote hain (koshish ke baad
   * kitab se hat jate hain — reject hue bytes dobara
   * candidate nahi bante).
   * Lautta hai: true (save ho gaya) | false.
   */
  async _tryHarvestSave(task, downloadFolder, settings, attempts) {
    try {
      const cap = this.netCapture;
      if (!cap || typeof cap.harvestForKey !== 'function') return false;
      if (!task || task.mediaSaved) return false;
      const captureKey = task.captureKey || task.videoId || null;
      const entry = cap.harvestForKey(captureKey);
      if (!entry || !entry.buffer) return false;
      const n = task.promptIndex + 1;
      try { cap.evictHarvest(captureKey); } catch (e) {}
      // Ye address ab is task ke naam claim bhi kar do —
      // koi aur task use is run me dobara na le
      // (v2.48.42: naam kis task ka hai wo bhi darj —
      // claim-once kitab).
      try {
        if (typeof cap.claimMainpageVideo === 'function') cap.claimMainpageVideo(entry.url, { key: captureKey || null, label: String(n) });
        else cap.claimFlowContentVideo(entry.url);
      } catch (e) {}
      task.completedVideoUrl = entry.url;
      const ok = await this._saveBufferForTask(task, downloadFolder, settings, entry.buffer, entry.url, 'mainpage-harvest');
      // v2.48.50 (item 7): race ki jeet dusre raste ki
      // ho to ye save jeet nahi — khamosh wapsi.
      const raceLostHs = !!(task._raceActive && task._raceWonBy && task._raceWonBy !== 'mainpage-harvest');
      if ((ok || task.mediaSaved) && task._saveRejectedReason !== 'route-race' && !raceLostHs) {
        const gapSec = Math.max(0, (Date.now() - (task.renderCompletedAt || task.startTime || Date.now())) / 1000).toFixed(1);
        try { if (typeof cap.mainpageMarkWindowDone === 'function') cap.mainpageMarkWindowDone(captureKey); } catch (e) {}
        this.log(`[ROOT] via=mainpage-harvest gap=${gapSec}s`, 'success');
        try {
          this.log(`[ROOT] mainpage-audit ${saveGuard.formatMainpageAudit(saveGuard.mainpageAuditOf({ host: networkCapture.hostOf(entry.url), bytes: entry.buffer.length, src: 'flow-content', decision: 'promoted', reason: 'ok', bindReason: 'bound', claimedBy: String(n) }))} timing=${cap && typeof cap._mainpageTimingBucket === 'function' ? cap._mainpageTimingBucket() : 'download-attempt'}`, 'info');
        } catch (e) {}
        attempts.push({ strategy: 'mainpage-harvest', ok: true, note: `the exact file was saved from the complete body the main project page itself had already fetched from Flow's server — no editor, no download click, no menu, no second fetch; render→save gap ${gapSec}s` });
        return true;
      }
      attempts.push({ strategy: 'mainpage-harvest', ok: false, note: `the bytes the main page had fetched did not pass the save checks (${task._saveRejectedReason || 'the video verification failed'})` });
      this.log(`[ROOT] [Prompt #${n}] mainpage-harvest bytes did not pass the save checks`, 'warn');
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * v2.48.36 (ROOT PACK — D): hadd bandhe waqt tak harvest
   * ka intezaar — render-complete ke aas-paas main page ki
   * stream chand second me aa sakti hai (mainpage-harvest
   * yahi bulata hai).
   */
  async _pollHarvestSave(task, downloadFolder, settings, attempts, waitMs) {
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    for (;;) {
      const ok = await this._tryHarvestSave(task, downloadFolder, settings, attempts);
      if (ok || (task && task.mediaSaved)) return true;
      if (Date.now() >= deadline || this.isStopping) return false;
      await sleep(250);
    }
  }

  /**
   * v2.48.41 (MAIN-PAGE HARVEST PACK): ek mainpage address
   * ka POORA fetch MAIN page ke apne JS context se
   * (page.evaluate fetch, credentials sameet) — koi naya
   * page/tab nahi khulta, kuch click nahi hota. Adhoore
   * (googlevideo range) jawab ke liye tareeqe is kram me:
   *   1. asal URL ka seedha GET;
   *   2. wahi GET Range: bytes=0- ke saath;
   *   3. URL ke range-wale hisse hata kar (saveGuard.
   *      fullFetchUrlCandidates) seedha GET, phir
   *      Range: bytes=0- ke saath.
   * Pehla 200 + video-header wala jawab foran wapas;
   * warna sab se bada mila buf apne status ke saath
   * (faisla — partial hai ya nahi — bulane wale ka
   * verdict karega). Kuch na mile to null.
   * Natija: { buf, status } | null.
   */
  async _fetchMainpageFullInPage(url, page) {
    // v2.48.46: fetch ki nakami ab KHAMOSH nahi — har
    // koshish ka aakhri status / bytes / error aur
    // koshishon ki ginti darj rehti hai, aur nakam
    // wapsi (null ya na-qabil-istemal 'best') par EK
    // line log hoti hai. ZEROCLICK13: in-page fetch
    // har live run me fail hua lekin us ke saare catch
    // khaali the — CORS throw hai ya 403/empty, ye
    // naam ab is line se milega. Fetch ka VYAVHAAR
    // bilkul wahi hai (umeedwaar, tartib, waqt, wapsi).
    let lastStatus = null;
    let lastBytes = 0;
    let lastErr = null;
    let tries = 0;
    let failLogged = false;
    const noteErr = (e) => {
      const raw = e && e.message ? String(e.message) : String(e || '');
      const msg = raw.replace(/\s+/g, ' ').trim().slice(0, 160);
      if (msg) lastErr = msg;
    };
    const logFetchFailure = () => {
      if (failLogged || tries === 0) return;
      failLogged = true;
      try {
        if (typeof this.log !== 'function') return;
        let host = 'none';
        try { host = networkCapture.hostOf(url) || 'none'; } catch (e) { host = 'none'; }
        this.log(`[ROOT] mainpage-fetch failed host=${host} lastStatus=${lastStatus == null ? 'none' : lastStatus} lastBytes=${lastBytes} lastErr=${lastErr || 'none'} tries=${tries}`, 'warn');
      } catch (e) {}
    };
    try {
      // v2.48.44: page diya jaye to wahi (headless-harvest
      // apna adrishya page deta hai), warna apna MAIN page.
      const pg = page || this.page;
      if (!pg || pg.isClosed() || !url) return null;
      const candidates = saveGuard.fullFetchUrlCandidates(url);
      let best = null;
      for (const u of candidates) {
        for (const useRange of [false, true]) {
          tries++;
          try {
            const res = await downloadGuard.withTimeout(
              pg.evaluate(async (uu, withRange) => {
                const headers = {};
                if (withRange) headers['Range'] = 'bytes=0-';
                const r = await fetch(uu, { method: 'GET', headers, credentials: 'include' });
                const ab = await r.arrayBuffer();
                const u8 = new Uint8Array(ab);
                let out = '';
                for (let i = 0; i < u8.length; i += 8192) {
                  out += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
                }
                return { status: r.status, b64: btoa(out) };
              }, u, useRange),
              25000, 'mainpage full fetch');
            if (!res || !res.b64) {
              if (res && Number.isFinite(res.status)) lastStatus = res.status;
              continue;
            }
            const buf = Buffer.from(res.b64, 'base64');
            if (Number.isFinite(res.status)) lastStatus = res.status;
            if (buf) lastBytes = buf.length;
            if (!buf || buf.length === 0 || buf.length > 16 * 1024 * 1024) continue;
            if (res.status !== 206 && downloadFetch.looksLikeVideoBuffer(buf)) {
              return { buf, status: res.status };
            }
            if (!best || buf.length > best.buf.length) best = { buf, status: res.status };
          } catch (e) { noteErr(e); }
        }
      }
      // 'best' yahan pahuncha matlab koi jawab kaam ka
      // nahi tha (206 ka tukda ya video-header ke
      // baghair) — nakami naam se darj.
      const usable = !!best && best.status !== 206 && downloadFetch.looksLikeVideoBuffer(best.buf);
      if (!usable) logFetchFailure();
      return best;
    } catch (e) {
      noteErr(e);
      logFetchFailure();
      return null;
    }
  }

  /**
   * v2.48.50 (MEGA PACK item 1 — TILE-ELEMENT COMPLETION):
   * is task ki tile ke apne <video> element ki ek nazar.
   * Tile wohi machinery dhoondti hai jo hover triggers
   * istemal karte hain (_resolveTileIndexForTask —
   * fingerprint pehle, phir hint). Element mil jaye to
   * use window.__fsTileMediaEl par rakh diya jata hai
   * (drive use wahi se uthata hai; element page ka hai —
   * kabhi hataya nahi jata). Wapsi:
   * { found, hasSrc, duration, currentSrc }.
   */
  async _probeMainpageTileVideo(task, tileIndexHint) {
    const none = { found: false, hasSrc: false, duration: -1, currentSrc: '' };
    try {
      const pg = this.page;
      if (!pg || pg.isClosed() || typeof pg.evaluate !== 'function' || !task) return none;
      const idx = await this._resolveTileIndexForTask(task, tileIndexHint);
      if (!Number.isInteger(idx) || idx < 0) return none;
      const info = await pg.evaluate((i) => {
        try {
          const tiles = document.querySelectorAll('flow-grid-tile-container');
          const tile = tiles && tiles[i];
          const vid = tile ? tile.querySelector('video') : null;
          window.__fsTileMediaEl = vid || null;
          if (!vid) return { found: false, hasSrc: false, duration: -1, currentSrc: '' };
          const d = vid.duration;
          return {
            found: true,
            hasSrc: !!(vid.currentSrc || vid.getAttribute('src')),
            duration: Number.isFinite(d) ? d : -1,
            currentSrc: String(vid.currentSrc || '')
          };
        } catch (e) {
          return { found: false, hasSrc: false, duration: -1, currentSrc: '' };
        }
      }, idx);
      return info && typeof info === 'object' ? info : none;
    } catch (e) {
      return none;
    }
  }

  /**
   * v2.48.47 (MEDIA-LOAD COMPLETION — ZEROCLICK14):
   * bandha hua mainpage address usi PROJECT page ke ek
   * <video> element se poora load karo aur mukammal
   * body CDP network capture se uthao. Wajah:
   * flow.google.com ke page-JS ka fetch() googlevideo
   * ki body nahi padh sakta ('Failed to fetch',
   * CORS-class, koi HTTP jawab hi nahi — .46 ki
   * '[ROOT] mainpage-fetch failed' line saboot hai),
   * lekin capture CDP satah ka hai aur us pabandi se
   * bandha nahi — editor-harvest me editor ki playback
   * body hamesha mukammal file thi.
   * v2.48.50 (item 1): element ab PEHLE task ki apni
   * TILE ka <video> hota hai (mediaLoadElementPick) —
   * ZEROCLICK17 ka saboot: tile ke element ne asal me
   * 214,591B kheenche the jabke naya adrishya element
   * 0 bytes laaya tha; jo element pehle se stream se
   * bandha hai wahi aage bhi kheenchta hai. Tile
   * element na mile / na chale to purana adrishya
   * (hidden) element chaara hai (bilkul .47/.48 wala
   * vyavhaar). Tile element ka currentSrc ummeedwaar
   * URL se alag ho tab bhi drive TILE se hi hota hai
   * (us ki stream by-construction isi task ki hai) —
   * lekin drive khud KABHI save nahi karta; bandhan
   * aur faisla capture kitab + saveGuard ke hi rehte
   * hain (readBest hamesha ummeedwaar URL par hi
   * bandha hai). Tile element page ka hai — drive use
   * KABHI DOM se nahi hatata, src nahi badalta; sirf
   * muted karke play karta hai aur aakhir me tab hi
   * pause karta hai jab wo pehle se paused tha.
   * Har ELEMENT-drive bilkul EK line deta hai:
   * '[ROOT] mainpage-media-load host=<h>
   * outcome=<complete|ended|timeout|error> bytes=<n>
   * el=<tile|hidden>'. Wapsi fetch jaisi shakal
   * ({buf,status}) ya null.
   * mediaOpts (v2.48.50): { task, tileIndexHint,
   * forceEl, singleDrive, budgetMs } — task diya ho to
   * har drive task._mpCompleteCycles ginata hai aur
   * nateeja task._mediaElOutcomes me darj hota hai
   * (items 4 + 16); attempt ki kul hadd 4 drives hai.
   */
  async _loadMainpageFullViaMedia(url, mediaOpts = {}) {
    const opts = mediaOpts && typeof mediaOpts === 'object' ? mediaOpts : {};
    const task = opts.task || null;
    // item 4: attempt-wide cycle hadd — 4 element
    // drives ke baad is attempt me aur drive nahi;
    // kitab ki behtareen body bina nayi line ke wapas.
    if (task && (task._mpCompleteCycles || 0) >= 4) {
      try {
        const cap = this.netCapture;
        const held = cap && typeof cap.mainpageBodyForUrl === 'function'
          ? cap.mainpageBodyForUrl(url) : null;
        if (held && held.buffer && held.buffer.length > 0) {
          const entry = typeof cap.mainpageEntries === 'function'
            ? (cap.mainpageEntries().find(e => e && e.url === url) || null) : null;
          const state = mediaBodyState(entry, held);
          return { buf: held.buffer, status: state === 'complete' ? 200 : 206 };
        }
      } catch (e) {}
      return null;
    }
    const noteDrive = (el, outcome) => {
      if (!task) return;
      task._mpCompleteCycles = (task._mpCompleteCycles || 0) + 1;
      if (!task._mediaElOutcomes || typeof task._mediaElOutcomes !== 'object') task._mediaElOutcomes = {};
      task._mediaElOutcomes[el] = outcome;
    };
    // Element chunav: majboor shakal (forceEl) > tile
    // probe (task diya ho) > hidden (purana vyavhaar —
    // task ke baghair bulawa hamesha hidden hi tha).
    let elKind = 'hidden';
    if (opts.forceEl === 'tile' || opts.forceEl === 'hidden') {
      elKind = opts.forceEl;
      if (elKind === 'tile') {
        const probe = await this._probeMainpageTileVideo(task, opts.tileIndexHint);
        if (mediaLoadElementPick(probe) !== 'tile') elKind = 'hidden';
      }
    } else if (task) {
      const probe = await this._probeMainpageTileVideo(task, opts.tileIndexHint);
      elKind = mediaLoadElementPick(probe);
    }
    // Route race (item 7): task pehle hi save ho
    // chuka ho to drive ka poll foran ruk jata hai.
    const shouldAbort = typeof opts.shouldAbort === 'function'
      ? opts.shouldAbort
      : (task ? () => !!task.mediaSaved : null);
    if (elKind === 'tile') {
      const r = await this._driveMainpageMediaLoad(url, 'tile', opts.budgetMs, shouldAbort);
      if (r !== TILE_DRIVE_MISSING) {
        noteDrive('tile', r.outcome);
        return r.best;
      }
      // Tile element drive ke pal DOM se gayab tha —
      // is bulawa me hidden chaara (singleDrive par
      // nahi: wahan EK drive ki hadd hai, item 4).
      if (opts.singleDrive) return null;
      const r2 = await this._driveMainpageMediaLoad(url, 'hidden', opts.budgetMs, shouldAbort);
      noteDrive('hidden', r2.outcome);
      return r2.best;
    }
    const r = await this._driveMainpageMediaLoad(url, 'hidden', opts.budgetMs, shouldAbort);
    noteDrive('hidden', r.outcome);
    return r.best;
  }

  /**
   * Asal element-drive (v2.48.47 ki poll bandish, ab
   * dono element qisam ke liye): poll har 500ms,
   * hadd budgetMs (default this.mainpageMediaLoadMs
   * 30s): rukawat = capture me mukammal body
   * (mediaBodyState 'complete') YA element ka 'ended'
   * + 1.5s settle ke baad behtareen body YA waqt
   * khatam. Wapsi { best, outcome }; tile element
   * drive ke pal gayab ho to TILE_DRIVE_MISSING
   * (bulane wala hidden chaara chalata hai — is
   * surat me koi line NAHI banti, kyunki koshish
   * asal me hui hi nahi).
   * v2.48.50 (item 2 — SEEK V3): duration maloom hote
   * hi seek ka pura kram — ~25%, ~50%, ~75% aur
   * duration−0.15, har seek ~700ms ke waqfe se, sirf
   * tab jab capture abhi adhoora ho; aakhir me 0 par
   * wapas seek + play(). Har quarter ke range jawab
   * network se lane padte hain (.48 ka sirf-aakhir
   * wala seek ZEROCLICK17 me kaafi nahi raha).
   * Duration kabhi maloom na ho to koi seek nahi —
   * vyavhaar .47 jaisa.
   */
  async _driveMainpageMediaLoad(url, elKind, budgetOverrideMs, shouldAbort) {
    const cap = this.netCapture;
    const isTile = elKind === 'tile';
    let outcome = 'error';
    let best = null;
    const readBest = () => {
      try {
        const entry = cap && typeof cap.mainpageEntries === 'function'
          ? cap.mainpageEntries().find(e => e && e.url === url) : null;
        const held = cap && typeof cap.mainpageBodyForUrl === 'function'
          ? cap.mainpageBodyForUrl(url) : null;
        const state = mediaBodyState(entry, held);
        const status = state === 'complete' ? 200
          : (entry && Number.isFinite(entry.status) && entry.status > 0 ? entry.status : 206);
        return { entry, held, state, candidate: held && held.buffer ? { buf: held.buffer, status } : null };
      } catch (e) {
        return { entry: null, held: null, state: 'none', candidate: null };
      }
    };
    const logLine = (oc, bytes) => {
      try {
        let host = 'none';
        try { host = networkCapture.hostOf(url || '') || 'none'; } catch (e) { host = 'none'; }
        this.log(mediaLoadLogLine({ host, outcome: oc, bytes, el: isTile ? 'tile' : 'hidden' }), oc === 'error' ? 'warn' : 'info');
      } catch (e) {}
    };
    let pg = null;
    let started = false;
    let tileWasPaused = false;
    pg = this.page;
    if (!pg || pg.isClosed() || !url || !cap) {
      // Kharab bulawa bhi purani tarah EK line deta hai.
      logLine('error', 0);
      return { best: null, outcome: 'error' };
    }
    if (isTile) {
      // Tile element ko chalao — wo page ka hai: src
      // NAHI badalta, DOM se NAHI hatata; sirf muted +
      // play. Element is pal gayab ho to koi koshish
      // hui hi nahi — khamosh TILE_DRIVE_MISSING.
      let startInfo = null;
      try {
        startInfo = await pg.evaluate(() => {
          try {
            const el = window.__fsTileMediaEl;
            if (!el || !el.isConnected) return { ok: false, wasPaused: false };
            const wasPaused = !!el.paused;
            try { el.muted = true; } catch (e) {}
            const p = el.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
            return { ok: true, wasPaused };
          } catch (e) { return { ok: false, wasPaused: false }; }
        });
      } catch (e) { startInfo = null; }
      if (!startInfo || !startInfo.ok) return TILE_DRIVE_MISSING;
      started = true;
      tileWasPaused = !!startInfo.wasPaused;
    }
    // Element-qisam ke hisaab se poll ke tukde — hidden
    // wale bilkul .47/.48 ke asal evaluate hi hain.
    const readDuration = async () => {
      try {
        return await pg.evaluate(isTile
          ? () => { try { const el = window.__fsTileMediaEl; const d = el ? el.duration : NaN; return Number.isFinite(d) ? d : -1; } catch (e) { return -1; } }
          : () => { try { const el = window.__fsMediaLoadEl; const d = el ? el.duration : NaN; return Number.isFinite(d) ? d : -1; } catch (e) { return -1; } });
      } catch (e) { return -1; }
    };
    const doSeek = async (target) => {
      try {
        await pg.evaluate(isTile
          ? (t) => { try { const el = window.__fsTileMediaEl; if (el) { el.currentTime = t; const p = el.play(); if (p && typeof p.catch === 'function') p.catch(() => {}); } } catch (e) {} return true; }
          : (t) => { try { const el = window.__fsMediaLoadEl; if (el) { el.currentTime = t; const p = el.play(); if (p && typeof p.catch === 'function') p.catch(() => {}); } } catch (e) {} return true; },
        target);
      } catch (e) {}
    };
    const doSeekBack = async () => {
      try {
        await pg.evaluate(isTile
          ? () => { try { const el = window.__fsTileMediaEl; if (el) { el.currentTime = 0; const p = el.play(); if (p && typeof p.catch === 'function') p.catch(() => {}); } } catch (e) {} return true; }
          : () => { try { const el = window.__fsMediaLoadEl; if (el) { el.currentTime = 0; const p = el.play(); if (p && typeof p.catch === 'function') p.catch(() => {}); } } catch (e) {} return true; });
      } catch (e) {}
    };
    const readEnded = async () => {
      if (isTile) {
        try {
          return await pg.evaluate(() => { try { const el = window.__fsTileMediaEl; return !!el && el.ended === true; } catch (e) { return false; } });
        } catch (e) { return false; }
      }
      return pg.evaluate(() => window.__fsMediaLoadEnded === true);
    };
    try {
      if (!isTile) {
        const startedFlag = await pg.evaluate((u) => {
          try {
            const prev = window.__fsMediaLoadEl;
            if (prev) {
              try { prev.pause(); } catch (e) {}
              try { prev.removeAttribute('src'); prev.load(); } catch (e) {}
              try { if (prev.parentNode) prev.parentNode.removeChild(prev); } catch (e) {}
            }
            window.__fsMediaLoadEl = null;
            const el = document.createElement('video');
            el.muted = true;
            try { el.setAttribute('muted', ''); } catch (e) {}
            el.playsInline = true;
            try { el.setAttribute('playsinline', ''); } catch (e) {}
            el.preload = 'auto';
            el.style.cssText = 'position:fixed;left:-9999px;top:0;width:8px;height:8px;opacity:0;pointer-events:none;';
            window.__fsMediaLoadEnded = false;
            el.addEventListener('ended', () => { window.__fsMediaLoadEnded = true; });
            el.src = u;
            (document.body || document.documentElement).appendChild(el);
            window.__fsMediaLoadEl = el;
            const p = el.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
            return 'fs-media-load-started';
          } catch (e) {
            return 'fs-media-load-failed';
          }
        }, url);
        if (startedFlag !== 'fs-media-load-started') {
          // Asal page me element kabhi bana hi nahi (ya
          // bulane wala koi jhootha test page hai) —
          // khamosh haar; fetch chaara neeche chalta hai.
          outcome = 'error';
          return { best: null, outcome };
        }
        started = true;
      }
      const budgetMs = Number.isFinite(budgetOverrideMs) && budgetOverrideMs > 0
        ? Math.max(500, Math.floor(budgetOverrideMs))
        : Math.max(500, this.mainpageMediaLoadMs || 30000);
      const deadline = Date.now() + budgetMs;
      let endedAt = 0;
      // v2.48.50 (SEEK V3): seek kram ki haalat —
      // duration milte hi steps bandhte hain
      // [25%, 50%, 75%, aakhir−0.15], har qadam
      // ~700ms ke waqfe se, aakhir me seek-back.
      let seekPlan = null;
      outcome = 'timeout';
      while (true) {
        const probe = readBest();
        // Behtareen = sab se BADI body jo is dauraan
        // dikhi (.48 se kitab tukde jodti hai, phir
        // bhi koi darmiyani chhoti reading badi ko
        // kabhi nahi dabati).
        if (probe.candidate && (!best || probe.candidate.buf.length > best.buf.length)) best = probe.candidate;
        if (probe.state === 'complete') { best = probe.candidate; outcome = 'complete'; break; }
        // Pakdi hui SAB SE BADI body kul ko cover kar
        // le to bhi mukammal hai (baad ki chhoti
        // seek-chunk kitab me badi ki jagah le chuki
        // ho tab bhi).
        const seenTotal = probe.entry ? Math.max(
          Number.isFinite(probe.entry.knownTotal) ? probe.entry.knownTotal : 0,
          Number.isFinite(probe.entry.declared) ? probe.entry.declared : 0
        ) : 0;
        if (best && seenTotal > 0 && best.buf.length >= seenTotal) {
          best = { buf: best.buf, status: 200 };
          outcome = 'complete';
          break;
        }
        // Item 7 (ROUTE RACE): dusra rasta jeet chuka
        // ho to drive foran band — element ki safai
        // finally me hoti hai.
        if (shouldAbort && shouldAbort()) break;
        // SEEK V3 ka kram (upar wali doc dekho):
        // pehle plan banao (duration pehli dafa
        // maloom hote hi), phir jo qadam waqt par ho
        // wo chalao — sirf tab jab capture abhi
        // adhoora hai (mukammal checks upar guzar
        // chuke hain).
        if (!seekPlan) {
          const dur = await readDuration();
          if (Number.isFinite(dur) && dur > 1) {
            seekPlan = {
              steps: [dur * 0.25, dur * 0.5, dur * 0.75, Math.max(0, dur - 0.15)],
              idx: 0,
              nextAt: 0,
              backDone: false
            };
          }
        }
        if (seekPlan && !seekPlan.backDone && Date.now() >= seekPlan.nextAt) {
          if (seekPlan.idx < seekPlan.steps.length) {
            const target = seekPlan.steps[seekPlan.idx];
            seekPlan.idx += 1;
            await doSeek(target);
            seekPlan.nextAt = Date.now() + 700;
          } else {
            await doSeekBack();
            seekPlan.backDone = true;
          }
        }
        let ended = false;
        try { ended = await readEnded(); } catch (e) { outcome = 'error'; break; }
        if (ended) {
          if (!endedAt) endedAt = Date.now();
          if (Date.now() - endedAt >= 1500) {
            const settle = readBest();
            if (settle.candidate && (!best || settle.candidate.buf.length > best.buf.length)) best = settle.candidate;
            outcome = settle.state === 'complete' ? 'complete' : 'ended';
            if (outcome === 'complete') best = settle.candidate;
            break;
          }
        }
        if (Date.now() >= deadline || this.isStopping) { outcome = 'timeout'; break; }
        await sleep(500);
      }
      return { best, outcome };
    } catch (e) {
      if (outcome !== 'complete' && outcome !== 'ended') outcome = 'error';
      return { best, outcome };
    } finally {
      if (started && pg && !pg.isClosed()) {
        if (isTile) {
          // Tile element page ka hai — hatana/src
          // badalna KABHI nahi; sirf tab pause jab
          // drive se pehle wo khud paused tha.
          try {
            await pg.evaluate((wp) => {
              try {
                const el = window.__fsTileMediaEl;
                if (el && wp) { try { el.pause(); } catch (e) {} }
              } catch (e) {}
              return true;
            }, tileWasPaused);
          } catch (e) {}
        } else {
          try {
            await pg.evaluate(() => {
              try {
                const el = window.__fsMediaLoadEl;
                if (el) {
                  try { el.pause(); } catch (e) {}
                  try { el.removeAttribute('src'); el.load(); } catch (e) {}
                  try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) {}
                }
              } catch (e) {}
              window.__fsMediaLoadEl = null;
              window.__fsMediaLoadEnded = false;
              return true;
            });
          } catch (e) {}
        }
      }
      logLine(outcome, best ? best.buf.length : 0);
    }
  }

  /**
   * v2.48.42 (MAIN-PAGE BINDING PACK): VIEWPORT TRIGGER —
   * is task ki tile ko main project page par sirf
   * scrollIntoView se viewport me lao. Page grid par hi
   * rehta hai; ye CLICK nahi hai, kuch khulta nahi, koi
   * naya tab/page nahi banta — download ke dauraan
   * ijaazat-shuda ek-matra page interaction yahi hai.
   * Flow apne grid tiles ki preview stream aksar sirf
   * tab bhejta hai jab tile nazar ke saamne ho
   * (ZEROCLICK9: pehli koshish me koi stream nahi,
   * retry me tile nazar aate hi stream aa gaya) — is
   * scroll ke baad pehli baar dikha stream is task ke
   * liye bandhta hai (bulane wala faisla karta hai).
   * Lautta hai: true (scroll hua) | false.
   */
  /**
   * v2.48.53 (CLEAN HOVER-EXIT — Gemini brief-2 §5.5
   * rank 2): agli task ki hover watch se pehle
   * pichhli tile se SAAF exit — us ke <video> ko
   * pause, pointer (1,1) par, 300ms saans. Khayal ye
   * hai ke Flow ka ek-waqt-ek active-preview
   * controller pichhli tile par chipka rehta hai to
   * agli tile ki poori stream kabhi nahi aati
   * (ZEROCLICK11–21: dusri task ki stream 0/10).
   * Kuch khulta nahi, click nahi hota. Ye function
   * kabhi throw nahi karta.
   */
  async _exitPrevMainpageHover(task) {
    try {
      const st = this._mpHoverState;
      if (!st) return;
      const myKey = task && (task.captureKey || task.videoId) ? String(task.captureKey || task.videoId) : String(task && Number.isFinite(task.promptIndex) ? task.promptIndex : '');
      if (st.key && myKey && st.key === myKey) return;
      await this._exitMainpageHoverState();
    } catch (e) {}
  }

  /**
   * v2.48.54 (GEMINI ZIP-REVIEW fix 5 — hissa):
   * apni hi tile ka hover bhi harvest khatam hote
   * hi chhodo — agli task ki baari tak pointer wahi
   * chipka na rahe (ZC23 me #1 ke save ke baad ~11s
   * wahi ruka raha tha).
   */
  async _exitOwnMainpageHover(task) {
    try {
      const st = this._mpHoverState;
      if (!st) return;
      const myKey = task && (task.captureKey || task.videoId) ? String(task.captureKey || task.videoId) : String(task && Number.isFinite(task.promptIndex) ? task.promptIndex : '');
      if (!st.key || !myKey || st.key !== myKey) return;
      await this._exitMainpageHoverState();
    } catch (e) {}
  }

  async _exitMainpageHoverState() {
    try {
      const st = this._mpHoverState;
      if (!st) return;
      this._mpHoverState = null;
      if (!this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed())) return;
      try {
        await this.page.evaluate((tileIdx) => {
          try {
            const tiles = document.querySelectorAll('flow-grid-tile-container');
            const el = tiles && tiles[tileIdx];
            // v2.48.55 (Gemini ZIP-fix se liya): sirf
            // pause kafi nahi — grid ke JS handlers me
            // hover haalaat leave isharon se saaf hoti
            // hai; container + <video> dono par bhejo.
            if (el && typeof el.dispatchEvent === 'function') {
              const outOpts = { bubbles: true, cancelable: true, composed: true, view: window };
              const leaveOpts = { bubbles: false, cancelable: true, composed: true, view: window };
              try { el.dispatchEvent(new PointerEvent('pointerout', outOpts)); } catch (e) {}
              try { el.dispatchEvent(new PointerEvent('pointerleave', leaveOpts)); } catch (e) {}
              try { el.dispatchEvent(new MouseEvent('mouseout', outOpts)); } catch (e) {}
              try { el.dispatchEvent(new MouseEvent('mouseleave', leaveOpts)); } catch (e) {}
            }
            const v = el && typeof el.querySelector === 'function' ? el.querySelector('video') : null;
            if (v) {
              if (typeof v.pause === 'function') v.pause();
              if (typeof v.dispatchEvent === 'function') {
                try { v.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, cancelable: true, composed: true, view: window })); } catch (e) {}
                try { v.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, cancelable: true, composed: true, view: window })); } catch (e) {}
              }
            }
          } catch (e) {}
        }, st.idx);
      } catch (e) {}
      try { if (this.page.mouse && typeof this.page.mouse.move === 'function') await this.page.mouse.move(1, 1); } catch (e) {}
      await sleep(300);
      this.log(`[ROOT] mainpage-hover-exit prev=#${(Number.isFinite(st.promptIndex) ? st.promptIndex : 0) + 1}`, 'info');
    } catch (e) {}
  }

  async _scrollMainpageTileIntoView(task, tileIndexHint) {
    try {
      if (!this.page || this.page.isClosed()) return false;
      const idx = await this._resolveTileIndexForTask(task, tileIndexHint);
      if (!Number.isFinite(idx) || idx < 0) return false;
      const r = await this.page.evaluate((tileIdx) => {
        try {
          const tiles = document.querySelectorAll('flow-grid-tile-container');
          const el = tiles && tiles[tileIdx];
          if (!el || typeof el.scrollIntoView !== 'function') return false;
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          // v2.48.55 (Gemini ZIP-fix se liya): scroll
          // wale pal bhi tile ka <video> muted play —
          // player jaage to stream ki guzaarish jaldi
          // aati hai (baaki hover seedhiyon jaisa hi).
          try {
            const vid = el.querySelector('video');
            if (vid) { vid.muted = true; const pr = vid.play(); if (pr && typeof pr.catch === 'function') pr.catch(() => {}); }
          } catch (e) {}
          return true;
        } catch (e) { return false; }
      }, idx);
      return !!r;
    } catch (e) {
      return false;
    }
  }

  /**
   * v2.48.43 (HOVER + PATIENCE PACK): HOVER TRIGGER
   * seedhi ki dusri seedhi — tile par page ke andar
   * se synthetic mouse ishare (mouseover + mouseenter
   * + mousemove) bhejo. OS cursor HILTA nahi, kuch
   * click nahi hota, kuch khulta nahi; page grid par
   * hi rehta hai. Flow ka grid preview loader aksar
   * hover par jaagta hai — scroll akela ZEROCLICK10
   * me teen dafa nakam raha. Lautta hai: true
   * (ishare gaye) | false.
   */
  async _syntheticHoverMainpageTile(task, tileIndexHint) {
    try {
      if (!this.page || this.page.isClosed()) return false;
      const idx = await this._resolveTileIndexForTask(task, tileIndexHint);
      if (!Number.isFinite(idx) || idx < 0) return false;
      const r = await this.page.evaluate((tileIdx) => {
        try {
          const tiles = document.querySelectorAll('flow-grid-tile-container');
          const el = tiles && tiles[tileIdx];
          if (!el || typeof el.dispatchEvent !== 'function') return false;
          const opts = { bubbles: true, cancelable: true, view: window };
          try { el.dispatchEvent(new MouseEvent('mouseover', opts)); } catch (e) {}
          try { el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true, view: window })); } catch (e) {}
          try { el.dispatchEvent(new MouseEvent('mousemove', opts)); } catch (e) {}
          // v2.48.54 (GEMINI ZIP-REVIEW fix 5 — polish):
          // PointerEvent wale ishare bhi (kuch grid
          // handlers sirf yahi sunte hain) + tile ke
          // <video> ko muted play — player apni stream
          // kheenchna shuru kare to capture use dekhta
          // hai. Click kabhi nahi, kuch khulta nahi.
          try { el.dispatchEvent(new PointerEvent('pointerover', opts)); } catch (e) {}
          try { el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, cancelable: true, view: window })); } catch (e) {}
          try { el.dispatchEvent(new PointerEvent('pointermove', opts)); } catch (e) {}
          try {
            const vid = el.querySelector('video');
            if (vid) { vid.muted = true; const pr = vid.play(); if (pr && typeof pr.catch === 'function') pr.catch(() => {}); }
          } catch (e) {}
          return true;
        } catch (e) { return false; }
      }, idx);
      // v2.48.55 (Gemini ZIP-fix se liya): synthetic
      // hover par bhi hover-state darj karo — exit
      // machinery ko is tile ka bhi pata ho (pehle
      // sirf pointer hover par darj hota tha).
      if (r) {
        try {
          this._mpHoverState = {
            key: task && (task.captureKey || task.videoId) ? String(task.captureKey || task.videoId) : String(task && Number.isFinite(task.promptIndex) ? task.promptIndex : ''),
            idx,
            promptIndex: task && Number.isFinite(task.promptIndex) ? task.promptIndex : 0
          };
        } catch (e) {}
      }
      return !!r;
    } catch (e) {
      return false;
    }
  }

  /**
   * v2.48.43 (HOVER + PATIENCE PACK): HOVER TRIGGER
   * seedhi ki aakhri seedhi — page ke mouse ko tile
   * ke WAST par le jaa kar WAHI roke rakho (bulane
   * wala watch khatam hone tak dobara hilata nahi).
   * Ye asal hover hai lekin CLICK kabhi nahi; kuch
   * khulta nahi, page grid par hi rehta hai. Lautta
   * hai: true (pointer tile par hai) | false.
   */
  async _pointerHoverMainpageTile(task, tileIndexHint) {
    try {
      if (!this.page || this.page.isClosed()) return false;
      if (!this.page.mouse || typeof this.page.mouse.move !== 'function') return false;
      const idx = await this._resolveTileIndexForTask(task, tileIndexHint);
      if (!Number.isFinite(idx) || idx < 0) return false;
      const pt = await this.page.evaluate((tileIdx) => {
        try {
          const tiles = document.querySelectorAll('flow-grid-tile-container');
          const el = tiles && tiles[tileIdx];
          if (!el || typeof el.getBoundingClientRect !== 'function') return null;
          // v2.48.55 (Gemini ZIP-fix se liya): rect
          // napne se pehle tile ko phir wast me lao +
          // <video> muted play — rect taza bhi milega,
          // player bhi jaaga rahega.
          try { if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
          try {
            const vid = el.querySelector('video');
            if (vid) { vid.muted = true; const pr = vid.play(); if (pr && typeof pr.catch === 'function') pr.catch(() => {}); }
          } catch (e) {}
          const r = el.getBoundingClientRect();
          if (!r || !(r.width > 0) || !(r.height > 0)) return null;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        } catch (e) { return null; }
      }, idx);
      if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return false;
      // v2.48.54 (fix 5 — polish): kenare se wast tak
      // naram harkat (steps) — teleport par kuch hover
      // handlers jaagte hi nahi.
      await this.page.mouse.move(pt.x, pt.y, { steps: 5 });
      // v2.48.53 (CLEAN HOVER-EXIT): ye tile ab is
      // engine ki 'hover wali tile' hai — agli task ki
      // harvest se pehle _exitPrevMainpageHover isi
      // nishani par saaf exit karega (Gemini brief-2
      // §5.5 rank 2: pichhli tile ka hover/decoder
      // chipka rahe to agli tile upgrade nahi hoti).
      try {
        this._mpHoverState = {
          key: task && (task.captureKey || task.videoId) ? String(task.captureKey || task.videoId) : String(task && Number.isFinite(task.promptIndex) ? task.promptIndex : ''),
          idx,
          promptIndex: task && Number.isFinite(task.promptIndex) ? task.promptIndex : 0
        };
      } catch (e) {}
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * v2.48.65 (RANK-2 POINTER TRIGGER): tile par
   * Puppeteer ke asal (trusted) mouse se DABAO —
   * lekin chhorna TILE SE BAHAR. Gemini brief-3
   * §6.4 Rank 2: pointerdown woh user-intent
   * signal hai jo player asal me sunta ho sakta
   * hai (hover aur resize dono passive ishare
   * falsify ho chuke — ZC31/ZC32). Tile ka
   * CONTAINER nishana hai; <video> child ki
   * maujoodgi shart NAHI (ZC32 me generation
   * attempt ke waqt wo hota hi nahi tha aur
   * resize 'no-video' par skip ho gaya tha).
   * HIFAZAT (sakht): mouse.up() KABHI tile ke
   * upar nahi; .click() kahin nahi; dabao wast
   * par, harkat steps ke saath tile se bahar ke
   * nukte tak (prompt bar ki taraf neeche-wast,
   * warna upar/kenare — jo nukta tile ke rect se
   * margin ke saath saaf bahar ho), phir wahin
   * up. Jo click tile par poora hi na ho wo
   * editor nahi khol sakta (standing rule).
   * Darmiyan me khata aaye to bhi chhorna bahar
   * wale nukte par hi koshish hoti hai; har khata
   * andar dabayi jati hai. Lautta hai:
   * { applied:true, box:'<tile W>x<H>' }
   * | { applied:false, reason:'no-tile'|'error' }.
   */
  async _pressMainpageTile(task, tileIndexHint) {
    let pressed = false;
    let offPt = null;
    try {
      if (!this.page || this.page.isClosed()) return { applied: false, reason: 'no-tile' };
      if (!this.page.mouse || typeof this.page.mouse.move !== 'function'
        || typeof this.page.mouse.down !== 'function'
        || typeof this.page.mouse.up !== 'function') return { applied: false, reason: 'error' };
      const idx = await this._resolveTileIndexForTask(task, tileIndexHint);
      if (!Number.isFinite(idx) || idx < 0) return { applied: false, reason: 'no-tile' };
      const geo = await this.page.evaluate((tileIdx) => {
        try {
          const tiles = document.querySelectorAll('flow-grid-tile-container');
          const el = tiles && tiles[tileIdx];
          if (!el || typeof el.getBoundingClientRect !== 'function') return null;
          try { if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
          const r = el.getBoundingClientRect();
          if (!r || !(r.width > 0) || !(r.height > 0)) return null;
          const vw = window.innerWidth || 0;
          const vh = window.innerHeight || 0;
          // bahar wala nukta: tile ke rect se kam
          // az kam 8px ke margin ke saath saaf
          // bahar — pehle prompt bar ki taraf
          // neeche-wast, phir upar-wast, phir
          // kenare. Koi na mile to dabao hi nahi
          // (chhorna tile par risk nahi lena).
          const cands = [
            { x: Math.round(vw / 2), y: vh - 24 },
            { x: Math.round(vw / 2), y: 24 },
            { x: 24, y: Math.round(vh / 2) },
            { x: vw - 24, y: Math.round(vh / 2) }
          ];
          let off = null;
          for (const c of cands) {
            if (c.x < 0 || c.y < 0 || c.x > vw || c.y > vh) continue;
            if (c.x < r.left - 8 || c.x > r.right + 8 || c.y < r.top - 8 || c.y > r.bottom + 8) { off = c; break; }
          }
          if (!off) return null;
          return {
            cx: r.left + r.width / 2, cy: r.top + r.height / 2,
            ox: off.x, oy: off.y,
            box: `${Math.round(r.width)}x${Math.round(r.height)}`
          };
        } catch (e) { return null; }
      }, idx);
      if (!geo || !Number.isFinite(geo.cx) || !Number.isFinite(geo.cy)
        || !Number.isFinite(geo.ox) || !Number.isFinite(geo.oy)) {
        return { applied: false, reason: 'no-tile' };
      }
      offPt = { x: geo.ox, y: geo.oy };
      await this.page.mouse.move(geo.cx, geo.cy, { steps: 5 });
      await this.page.mouse.down();
      pressed = true;
      await sleep(400);
      await this.page.mouse.move(geo.ox, geo.oy, { steps: 10 });
      await this.page.mouse.up();
      pressed = false;
      return { applied: true, box: geo.box };
    } catch (e) {
      // dabao ke darmiyan khata: chhorna phir bhi
      // bahar wale nukte par hi — button tile ke
      // upar latka na rahe, click poora na ho.
      if (pressed) {
        try {
          if (offPt) await this.page.mouse.move(offPt.x, offPt.y, { steps: 3 });
          await this.page.mouse.up();
        } catch (e2) {}
      }
      return { applied: false, reason: 'error' };
    }
  }

  /**
   * v2.48.64 (TILE-RESIZE TRIGGER): tile ko CSS se
   * BADA karke dikhao — ZC31 ka saboot: tile ka
   * <video> element 360x640 ka preview encode hi
   * rakhta hai, aur Flow ka player encode apne
   * display size ke hisaab se chunta hai (Gemini
   * brief-3 §6.4 Rank 1). Container 720px/1280px,
   * video 100%/100% — sab '!important' ke saath
   * (grid ki apni classes jeet na jayein); position
   * relative + uncha z-index taaki badi tile
   * padosiyon ke neeche kat na jaye. Phir wahi muted
   * play wala ishara jo baaki helpers dete hain.
   * Download phir bhi backend se hi hota hai — ye
   * sirf woh ghanti hai jo server ko asal file
   * bhejne par majboor karti hai; koi click nahi,
   * koi editor nahi.
   * Asal inline styles (cssText) token me save
   * hote hain — _restoreMainpageTile unhe hu-ba-hu
   * wapas rakhta hai. Lautta hai: { applied:true,
   * method:'css', box:'<video client W>x<H>', token }
   * | { applied:false, reason:'no-tile'|'no-video' }.
   */
  async _enlargeMainpageTile(task, tileIndexHint) {
    try {
      if (!this.page || this.page.isClosed()) return { applied: false, reason: 'no-tile' };
      const idx = await this._resolveTileIndexForTask(task, tileIndexHint);
      if (!Number.isFinite(idx) || idx < 0) return { applied: false, reason: 'no-tile' };
      const r = await this.page.evaluate((tileIdx) => {
        try {
          const tiles = document.querySelectorAll('flow-grid-tile-container');
          const el = tiles && tiles[tileIdx];
          if (!el) return { applied: false, reason: 'no-tile' };
          const vid = el.querySelector('video');
          if (!vid) return { applied: false, reason: 'no-video' };
          const token = { tileCss: el.style.cssText || '', vidCss: vid.style.cssText || '' };
          try {
            el.style.setProperty('width', '720px', 'important');
            el.style.setProperty('height', '1280px', 'important');
            el.style.setProperty('position', 'relative', 'important');
            el.style.setProperty('z-index', '9999', 'important');
            vid.style.setProperty('width', '100%', 'important');
            vid.style.setProperty('height', '100%', 'important');
          } catch (e) {}
          try {
            vid.muted = true;
            const pr = vid.play();
            if (pr && typeof pr.catch === 'function') pr.catch(() => {});
          } catch (e) {}
          return { applied: true, method: 'css', box: `${vid.clientWidth || 0}x${vid.clientHeight || 0}`, token };
        } catch (e) { return { applied: false, reason: 'no-tile' }; }
      }, idx);
      return r || { applied: false, reason: 'no-tile' };
    } catch (e) {
      return { applied: false, reason: 'no-tile' };
    }
  }

  /**
   * v2.48.64 (TILE-RESIZE TRIGGER): CSS wale
   * marhale se ~15s tak stream na aaye aur tile ki
   * videoWidth ab bhi <= 360 ho to EK dafa
   * fullscreen wali seedhi — tile ke <video> par
   * requestFullscreen(). Player ko sab se bada
   * display milta hai; encode badalna ho to yahin
   * badlega. Har khata andar hi dabayi jati hai
   * (user-gesture wali pabandi par ye aaram se
   * nakam ho sakta hai — tab watch CSS par hi aage
   * badhta hai). Lautta hai: { entered:true, box }
   * | { entered:false }.
   */
  async _fullscreenMainpageTile(task, tileIndexHint) {
    try {
      if (!this.page || this.page.isClosed()) return { entered: false };
      const idx = await this._resolveTileIndexForTask(task, tileIndexHint);
      if (!Number.isFinite(idx) || idx < 0) return { entered: false };
      const r = await this.page.evaluate(async (tileIdx) => {
        try {
          const tiles = document.querySelectorAll('flow-grid-tile-container');
          const el = tiles && tiles[tileIdx];
          if (!el) return null;
          const vid = el.querySelector('video');
          if (!vid || typeof vid.requestFullscreen !== 'function') return null;
          try { await vid.requestFullscreen(); } catch (e) { return null; }
          try {
            vid.muted = true;
            const pr = vid.play();
            if (pr && typeof pr.catch === 'function') pr.catch(() => {});
          } catch (e) {}
          return { entered: true, box: `${vid.clientWidth || 0}x${vid.clientHeight || 0}` };
        } catch (e) { return null; }
      }, idx);
      return r || { entered: false };
    } catch (e) {
      return { entered: false };
    }
  }

  /**
   * v2.48.64 (TILE-RESIZE TRIGGER): resize wale
   * marhale ki WAPSI — lazmi, har nikaas par. Save
   * hue token ke cssText dono elements par hu-ba-hu
   * wapas, aur is marhale ne fullscreen liya ho to
   * us se nikaas bhi. Ye hover escalation se PEHLE
   * chalta hai taaki baaki saare marhale untouched
   * grid dekhein. Jo stream ek dafa maangi ja chuki
   * ho wo network layer par pakdi rehti hai —
   * restore use nahi rokta.
   */
  async _restoreMainpageTile(task, tileIndexHint, savedStyles, enteredFullscreen) {
    try {
      if (!this.page || this.page.isClosed()) return false;
      const idx = await this._resolveTileIndexForTask(task, tileIndexHint);
      if (!Number.isFinite(idx) || idx < 0) return false;
      const r = await this.page.evaluate((tileIdx, saved, exitFs) => {
        try {
          let ok = false;
          if (exitFs) {
            try {
              if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
                const p = document.exitFullscreen();
                if (p && typeof p.catch === 'function') p.catch(() => {});
                ok = true;
              }
            } catch (e) {}
          }
          const tiles = document.querySelectorAll('flow-grid-tile-container');
          const el = tiles && tiles[tileIdx];
          if (el && saved) {
            try { el.style.cssText = saved.tileCss || ''; ok = true; } catch (e) {}
            const vid = el.querySelector('video');
            if (vid) { try { vid.style.cssText = saved.vidCss || ''; } catch (e) {} }
          }
          return ok;
        } catch (e) { return false; }
      }, idx, savedStyles || null, !!enteredFullscreen);
      return !!r;
    } catch (e) {
      return false;
    }
  }

  /**
   * v2.48.52 (ROUTE 1A PACK): ek task ke netload
   * anjaam ki darj-shudaayi (attempt-summary ke
   * liye). Tartib: saved > rejected > error — ek
   * attempt me kai koshishein hon to sab se acha
   * anjaam hi rehta hai.
   */
  _noteNetloadOutcome(task, kind) {
    try {
      const rank = { error: 1, rejected: 2, saved: 3 };
      const cur = task._mpNetloadOutcome;
      if (!cur || (rank[kind] || 0) > (rank[cur] || 0)) task._mpNetloadOutcome = kind;
    } catch (e) {}
  }

  /**
   * v2.48.52 (ROUTE 1A PACK): Route 1A completion —
   * ummeedwaar URL ki POORI file MAIN page ke apne
   * CDP session se Network.loadNetworkResource ke
   * zariye uthao. Peeche ki soch: in-page fetch()
   * googlevideo par CORS se mar jata hai ('Failed
   * to fetch', koi HTTP jawab hi nahi — zc14..zc20
   * ka saboot) aur tile ka media-load sirf chhota
   * preview tukda kheenchta hai; lekin CDP ka ye
   * hukm page-JS se NAHI, browser ke NETWORK hisse
   * se chalta hai — wahi session, wahi cookies,
   * koi naya browser nahi (captcha deewaar wahan
   * khadi hi nahi hoti), koi click nahi, koi editor
   * nahi. URL tayyari: 'range=' (aur 'rn=' / 'rbuf=')
   * query hisse hatao — chhoti nazar aksar USI poori
   * file ke pate par range mehdood karke aati hai;
   * hissa hata kar maango to server poori file deta
   * hai. Phir resource.stream ko IO.read se poora
   * drain karke ek Buffer.
   * Budget: ek download-attempt me ek task ke liye
   * zyada se zyada 2 netload koshishein (task.
   * _mpNetloadCount); protocol-nakami wala URL
   * (task._mpNetloadProtoFailed) usi attempt me
   * dobara NAHI aazmaya jata — fetch tried-list
   * wali hi nazakat.
   * WAPSI: kamyabi par { buf, status, host,
   * stripped }; kisi bhi nakami par null (bulane
   * wala purani completion silsile par girta hai).
   * Protocol nakami par '[ROOT] mainpage-netload
   * failed' line + summary-outcome 'error' yahin
   * darj hota hai; resource.success === false par
   * per-attempt wali line bhi yahin banti hai
   * (result=error:<netErrorName>). Page hi na ho /
   * band ho to khamosh null — wo koshish hi nahi.
   * Ye function KABHI throw nahi karta.
   */
  async _netloadMainpageFull(task, url) {
    try {
      if (!task || typeof url !== 'string' || !url) return null;
      if (task._mpNetloadProtoFailed && task._mpNetloadProtoFailed.has(url)) return null;
      if (Number.isFinite(task._mpNetloadCount) && task._mpNetloadCount >= 2) return null;
      const page = this.page;
      if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return null;
      task._mpNetloadCount = (Number.isFinite(task._mpNetloadCount) ? task._mpNetloadCount : 0) + 1;
      const host = networkCapture.hostOf(url) || '';
      const prep = networkCapture.rangeStripOf(url);
      const strippedLabel = prep.stripped.length ? prep.stripped[0] : 'none';
      const protoFail = (errMsg, lineResult) => {
        try { if (!task._mpNetloadProtoFailed) task._mpNetloadProtoFailed = new Set(); task._mpNetloadProtoFailed.add(url); } catch (e) {}
        try { this.log(netloadFailedLogLine({ host, err: errMsg }), 'warn'); } catch (e) {}
        if (lineResult) {
          try { this.log(netloadLogLine({ host, stripped: strippedLabel, status: 0, bytes: 0, result: lineResult }), 'warn'); } catch (e) {}
        }
        this._noteNetloadOutcome(task, 'error');
        return null;
      };
      let session = null;
      try {
        session = typeof page.createCDPSession === 'function'
          ? await page.createCDPSession()
          : await page.target().createCDPSession();
      } catch (e) { session = null; }
      if (!session || typeof session.send !== 'function') {
        return protoFail('cdp session unavailable');
      }
      try {
        try { await session.send('Network.enable'); } catch (e) {}
        let frameId = null;
        try {
          const mf = typeof page.mainFrame === 'function' ? page.mainFrame() : null;
          frameId = mf && mf._id ? mf._id : null;
        } catch (e) { frameId = null; }
        if (!frameId) return protoFail('main frame id unavailable');
        let resp = null;
        try {
          resp = await session.send('Network.loadNetworkResource', {
            frameId, url: prep.url,
            options: { disableCache: true, includeCredentials: true }
          });
        } catch (e) {
          return protoFail(e && e.message ? e.message : String(e));
        }
        const resource = resp && resp.resource && typeof resp.resource === 'object' ? resp.resource : null;
        if (!resource || !resource.stream) {
          return protoFail('loadNetworkResource returned no stream');
        }
        if (resource.success === false) {
          const name = typeof resource.netErrorName === 'string' && resource.netErrorName ? resource.netErrorName : 'load-failed';
          try { if (!task._mpNetloadProtoFailed) task._mpNetloadProtoFailed = new Set(); task._mpNetloadProtoFailed.add(url); } catch (e) {}
          try { this.log(netloadLogLine({ host, stripped: strippedLabel, status: Number(resource.httpStatusCode) || 0, bytes: 0, result: 'error:' + name }), 'warn'); } catch (e) {}
          this._noteNetloadOutcome(task, 'error');
          return null;
        }
        const buf = await drainNetloadStream((m, p) => session.send(m, p), resource.stream);
        if (!buf) return protoFail('stream drain failed');
        return { buf, status: Number(resource.httpStatusCode) || 0, host, stripped: strippedLabel };
      } finally {
        try { if (session && typeof session.detach === 'function') await session.detach(); } catch (e) {}
      }
    } catch (e) {
      return null;
    }
  }

  /**
   * v2.48.42: ek BANDHE hue mainpage ummeedwaar ko
   * mukammal karna — kitab me mukammal body ho to wohi,
   * warna usi URL ka POORA fetch MAIN page ke andar se
   * (_fetchMainpageFullInPage); phir saveGuard ke
   * darwaze (teacher-url / content-hash / duplicate)
   * aur save. Yahi .41 wala completion rasta hai, sirf
   * alag function me taaki har bandhan-raasta
   * (bound / first-appearance / viewport-trigger /
   * exclusion) isi ek se guzre. ctx = { captureKey,
   * bindReason, floorBytes, teacherUrl, teacherHash,
   * timingBucket, gapSec }. Jeet par address is task
   * ke naam claim hota hai (claim-once) aur khidki
   * band hoti hai. Lautta hai (v2.48.46): 'saved' |
   * 'rejected' (faisla hua, action save nahi) |
   * 'no-body' (body mili hi nahi — faisle se pehle
   * wapsi; bulane wala isi farq par triedUrls ka
   * zeher-khatma karta hai).
   */
  async _mainpageCompleteCandidate(task, downloadFolder, settings, attempts, entry, ctx) {
    const n = task.promptIndex + 1;
    const cap = this.netCapture;
    const captureKey = ctx.captureKey;
    const floorBytes = ctx.floorBytes;
    const teacherUrl = ctx.teacherUrl;
    const teacherHash = ctx.teacherHash;
    let buf = null;
    let haveBody = false;
    // v2.48.52 (ROUTE 1A PACK): netload se aayi body
    // ka hisaab (host / stripped / status) — is ki
    // [ROOT] line koshish ke aakhri faisle par EK
    // dafa emitNetload se banti hai (protocol nakami
    // ki line helper khud pehle hi chhod deta hai).
    let netloadMeta = null;
    const emitNetload = (result) => {
      if (!netloadMeta) return;
      try {
        this.log(netloadLogLine({ host: netloadMeta.host, stripped: netloadMeta.stripped, status: netloadMeta.status, bytes: netloadMeta.buf.length, result }), 'info');
      } catch (e) {}
      this._noteNetloadOutcome(task, result === 'saved' ? 'saved' : 'rejected');
    };
    // v2.48.52 (ROUTE 1A PACK): bulane wale ne
    // netload ki body pehle se haath me di ho
    // (too-small wala rasta — wahan netload seedha
    // bulaya jata hai taaki chhote pate par in-page
    // fetch kabhi na chale) to wahi body aur wahi
    // hisaab is completion ki body hai — kitab /
    // media / fetch dobara nahi ghumte.
    if (entry._netloadBody && entry._netloadBody.length > 0) {
      buf = entry._netloadBody;
      haveBody = true;
      netloadMeta = entry._netloadMeta || null;
      if (netloadMeta && netloadMeta.status) entry.status = netloadMeta.status;
    }
    // kitab me pehle se pakdi hui body (mukammal ho
    // to) — netload wali body haath me ho to kitab
    // use badal NAHI sakti (wahan is pate ki sirf
    // chhoti nazar rakhi hoti hai).
    try {
      const held = typeof cap.mainpageBodyForUrl === 'function' ? cap.mainpageBodyForUrl(entry.url) : null;
      if (!netloadMeta && held && held.buffer && held.buffer.length > 0) { buf = held.buffer; haveBody = true; }
    } catch (e) {}
    // v2.48.52 (ROUTE 1A PACK — gate fix): is nazar
    // ka MALOOM kul size. partial ka matlab ab
    // 'rakhe bytes < kul size' hai — bytes kul ke
    // barabar hon to body POORI hai, chahe us jawab
    // ka status 206 hi kyon na raha ho; kul na
    // maloom ho to purana rawaiya (status / partial
    // jhanda) bilkul waisa hi.
    const knownTotal = saveGuard.mainpageKnownTotalOf({
      knownTotal: entry.knownTotal, contentRange: entry.contentRange,
      declaredLength: entry.declaredLength, declared: entry.declared, status: entry.status
    });
    if (haveBody && !netloadMeta && entry.partial && entry.src === 'googlevideo') {
      // googlevideo tukda mukammal nahi — mukammal
      // karne ke raste neeche hain (media-load / fetch).
      // v2.48.52: rakhi body kul size tak pahunch
      // gayi ho to wo tukda NAHI rahi — phainkna
      // band, wahi body seedha faisle par jayegi.
      // (netload se aayi body is phaink se bahar
      // hai — wo capture ka tukda hai hi nahi.)
      if (!(knownTotal !== null && buf.length >= knownTotal)) { buf = null; haveBody = false; }
    }
    if (!haveBody) {
      // v2.48.47 (MEDIA-LOAD COMPLETION — ZEROCLICK14):
      // in-page fetch() googlevideo ki body NAHI padh
      // sakta ('Failed to fetch', koi HTTP jawab hi
      // nahi — page-JS par CORS-class inkaar), lekin
      // CDP capture us pabandi se bandha nahi hai
      // (editor-harvest ki promoted body is ka saboot
      // hai). Is liye googlevideo par pehle MEDIA-LOAD
      // (usi page ka adrishya <video> element poori
      // file khinchta hai, body capture se milti hai),
      // fetch aakhri chaara. Baaki (flow-content)
      // addresses par purani tartib: fetch pehle,
      // nakam ho to media-load.
      const isGv = entry.src === 'googlevideo' || networkCapture.isGooglevideoPlaybackUrl(entry.url);
      const applyCompletion = (res) => {
        if (res && res.buf) {
          buf = res.buf;
          haveBody = true;
          entry.status = res.status || entry.status;
          if (res.status === 206) entry.partial = true;
        }
      };
      const tryFetch = async () => { applyCompletion(await this._fetchMainpageFullInPage(entry.url)); };
      // v2.48.50 (item 1): media-load ab task + tile
      // hint ke saath — pehle TILE ka apna element
      // drive hoga, hidden sirf chaara.
      const tryMedia = async () => { applyCompletion(await this._loadMainpageFullViaMedia(entry.url, { task, tileIndexHint: ctx.tileIndexHint })); };
      // v2.48.52 (ROUTE 1A PACK): googlevideo par SAB
      // se pehle NETLOAD — URL ka range param hata
      // kar MAIN page ke apne CDP session se
      // Network.loadNetworkResource; body browser ke
      // network hisse se aati hai (na page-JS fetch
      // ki CORS deewaar, na naya browser, na click,
      // na editor). Nakam ho to purani tartib
      // (media-load, phir fetch) bilkul waisi hi —
      // .52, .51 ka strict superset hai.
      const tryNetload = async () => {
        const res = await this._netloadMainpageFull(task, entry.url);
        if (res && res.buf) { netloadMeta = res; applyCompletion(res); }
      };
      if (isGv) {
        await tryNetload();
        if (!haveBody) await tryMedia();
        if (!haveBody) await tryFetch();
      } else {
        await tryFetch();
        if (!haveBody) await tryMedia();
      }
    }
    if (!haveBody || !buf) {
      // v2.48.46: 'no body' wapsi ab naam se darj —
      // .45 tak ye khamoshi se false laut jati thi
      // (aur URL triedUrls me zeher ban kar reh jata
      // tha). Host naam ke saath line banti hai.
      try {
        this.log(`[ROOT] [Prompt #${n}] mainpage-complete: no body from in-page fetch host=${networkCapture.hostOf(entry.url)}`, 'warn');
      } catch (e) {}
      return 'no-body';
    }
    const verdictFor = (b, statusOverride) => {
      const hash = saveGuard.contentHash(b);
      let dup = false;
      try { dup = !!saveGuard.checkDuplicate(b, captureKey || null).dup; } catch (e) { dup = false; }
      const hdrOk = downloadFetch.looksLikeVideoBuffer(b);
      // v2.48.70 (ITEM A): is body ki duration-tasdeeq
      // task ki expected duration ke khilaf — verdict
      // ke andar size floor ki jagah yahi kasauti hai
      // (teacher/duplicate/partial darwaze bilkul
      // waisay hi pehle chalte hain).
      const verification = saveGuard.bodyVerification({
        buffer: b,
        headerOk: hdrOk,
        expectedSec: this._expectedDurationSec(task, settings)
      });
      return saveGuard.mainpageHarvestVerdict({
        bound: true,
        url: entry.url,
        teacherUrl,
        byteLength: b.length,
        floorBytes,
        headerOk: hdrOk,
        verification,
        // v2.48.52 (gate fix): kul size maloom ho to
        // partial = rakhe bytes kul se kam — status
        // 206 ke bawajood bytes kul ke barabar hon
        // to body POORI ummeedwaar hai. Kul na
        // maloom ho to purana usool (status 206 =
        // partial) bilkul waisa hi. EK hifazat:
        // partial sirf tab jab body asal video ki
        // ho (header durust) — kachra body (HTML
        // error page) 'adhoora video' NAHI hoti;
        // faisle me partial header-darwaze se PEHLE
        // aata hai, is liye kachra wahan fetch-full
        // ki jagah header par hi rukna chahiye
        // (warna har error page ek dobara-fetch
        // mangta — .51 ka rawaiya bhi yahi tha).
        partial: knownTotal !== null ? (hdrOk && b.length < knownTotal) : ((statusOverride || entry.status) === 206 ? true : false),
        status: statusOverride || entry.status,
        contentRange: entry.contentRange,
        declaredLength: entry.declaredLength,
        duplicate: dup,
        hash,
        teacherHash
      });
    };
    let verdict = verdictFor(buf);
    if (verdict.action === 'fetch-full') {
      // kitab wali body adhoori nikli — usi URL ka
      // poora fetch MAIN page ke andar se, phir
      // faisla dobara.
      // v2.48.52: agar ye body NETLOAD se aayi thi
      // to us koshish ka anjaam yahin darj hai
      // (rejected:partial) — purana fetch-full
      // rasta neeche bilkul waisa hi chalta hai.
      // EK pabandi: too-small wale raste ki entry
      // (_noInPageFetch) par in-page fetch kabhi
      // nahi — chhota pata sirf netload / media-load
      // se parkha jata hai (.51 ki hifazat barkarar).
      if (netloadMeta) emitNetload('rejected:partial');
      if (!entry._noInPageFetch) {
        const fetched = await this._fetchMainpageFullInPage(entry.url);
        if (fetched && fetched.buf && fetched.buf.length > 0) {
          buf = fetched.buf;
          verdict = verdictFor(buf, fetched.status);
        }
      }
    }
    if (verdict.action !== 'save') {
      emitNetload('rejected:' + (verdict.reason || 'rejected'));
      // v2.48.65 (BELOW-FLOOR SAMPLE — Item B):
      // below-floor par reject hui ummeedwaar ki
      // bytes ab tak pheink di jati thin — kabhi
      // jaancha hi nahi gaya ke wo adhoora preview
      // rendition hai ya mukammal low-bitrate file
      // (gv-req me us ki dur POORI aati hai). Is
      // session ka PEHLA aisa ummeedwaar (header
      // asal video ka ho to) output folder me
      // SIDE file ke tor par save hota hai taaki
      // MK use ffprobe/frame se khud jaanch sake.
      // SAKHT: ye task ka save NAHI hai —
      // _saveBufferForTask nahi, claim nahi, task
      // state/DB/mediaSaved ko haath nahi; faisla
      // aur bahao bilkul waisa hi, ummeedwaar
      // rejected hi rehta hai. Likhna nakam ho to
      // khamoshi — run par koi asar nahi.
      if (belowfloorSampleDecision(verdict.reason, downloadFetch.looksLikeVideoBuffer(buf), this._belowfloorSampleSaved)
        || failedVerificationSampleDecision(verdict.reason, downloadFetch.looksLikeVideoBuffer(buf), this._belowfloorSampleSaved)) {
        try {
          const sampleName = belowfloorSampleName(n, buf.length, (nm) => fs.existsSync(path.join(downloadFolder, nm)));
          fs.writeFileSync(path.join(downloadFolder, sampleName), buf);
          this._belowfloorSampleSaved = true;
          this.log(`[ROOT] belowfloor-sample saved name=${sampleName} bytes=${buf.length} prompt=${n} (diagnostic only — NOT a task save)`, 'info');
        } catch (e) {}
      }
      this.log(`[ROOT] [Prompt #${n}] mainpage-harvest candidate rejected (${verdict.reason}) — trying the remaining main-page candidates`, 'warn');
      return 'rejected';
    }
    try {
      cap.claimMainpageVideo(entry.url, { key: captureKey || null, label: String(n) });
    } catch (e) {}
    task.completedVideoUrl = entry.url;
    const ok = await this._saveBufferForTask(task, downloadFolder, settings, buf, entry.url, 'mainpage-harvest');
    // v2.48.50 (item 7): race me jeet DUSRE raste ki
    // ho (mera save 'route-race' par ruka ho, ya
    // mediaSaved usi ke save se true hua ho aur dawa
    // usi ke naam ho) to ye jeet is raste ki NAHI hai
    // — 'rejected' hi wapsi hai, warna
    // via=mainpage-harvest ki jhooti line banti.
    const raceLostMp = !!(task._raceActive && task._raceWonBy && task._raceWonBy !== 'mainpage-harvest');
    if ((ok || task.mediaSaved) && task._saveRejectedReason !== 'route-race' && !raceLostMp) {
      emitNetload('saved');
      const g = ctx.gapSec();
      try { if (typeof cap.mainpageMarkWindowDone === 'function') cap.mainpageMarkWindowDone(captureKey); } catch (e) {}
      this.log(`[ROOT] via=mainpage-harvest gap=${g}s`, 'success');
      try {
        const audit = saveGuard.mainpageAuditOf({
          host: networkCapture.hostOf(entry.url), bytes: buf.length,
          src: entry.src === 'googlevideo' ? 'googlevideo' : 'flow-content',
          decision: 'promoted', reason: 'ok',
          bindReason: ctx.bindReason || 'none', claimedBy: String(n)
        });
        this.log(`[ROOT] mainpage-audit ${saveGuard.formatMainpageAudit(audit)} timing=${ctx.timingBucket()}`, 'info');
      } catch (e) {}
      attempts.push({ strategy: 'mainpage-harvest', ok: true, note: `the file was captured from the main project page's own stream (${entry.src}), bound to this video by ${ctx.bindReason || 'binding'}, and completed with a full fetch inside that same page — no editor opened anywhere, no click, no menu; render→save gap ${g}s` });
      return 'saved';
    }
    attempts.push({ strategy: 'mainpage-harvest', ok: false, note: `the main-page stream for this video did not pass the save checks (${task._saveRejectedReason || 'the video verification failed'})` });
    emitNetload('rejected:' + (task._saveRejectedReason || 'save-failed'));
    // v2.48.46: body mili, faisla save tha, lekin save
    // ki jaanch nakam — bulane wale ke liye ye bhi
    // 'rejected' hi hai (URL triedUrls me rehta hai;
    // zeher-khatma sirf 'no-body' par hota hai).
    return 'rejected';
  }

  /**
   * v2.48.47 (CDP COOKIE TRANSFER — ZEROCLICK14):
   * headless session ka DARWAZA. Do raste, ek hi
   * manzil — probe + editor harvest bulane wale
   * (_tryHeadlessHarvest) ke paas rehte hain; ye
   * function sirf LAUNCH deta hai:
   *   ASAL rasta — CDP COOKIE TRANSFER
   *     (_headlessLaunchTransferred): isi worker ke
   *     LIVE browser se CDP 'Network.getAllCookies'
   *     se cookies uthao, headless browser ko bilkul
   *     TAAZI temp userDataDir par kholo aur
   *     navigation se PEHLE 'Network.setCookies' se
   *     cookies bitha do. Wajah: run ke dauraan asal
   *     profile ki 'Default\Network\Cookies' file
   *     generation Chrome ke lock me EBUSY rehti hai
   *     (ZEROCLICK14 ki clone line saboot hai) —
   *     file-copy us pal kabhi jeet hi nahi sakta;
   *     CDP transfer par koi file lock hai hi nahi.
   *   CHAARA — purana FILE-CLONE rasta bilkul waisa
   *     hi (_headlessLaunchCloned): live handle na
   *     ho, cookies 0 aayen, ya transfer nakam ho —
   *     teeno haal me clone hi chalta hai, aur us ki
   *     nakami ki wajeh / strategy note bilkul aaj
   *     jaisi rehti hai.
   * PARTNER TASK 1 (Issue #1, 2026-11-05): .47 tak
   * CDP transfer ki nakami bilkul chup rehti thi —
   * ZEROCLICK15 me saare attempts me sirf clone ka
   * EBUSY bola aur transfer kabhi aazmaya bhi gaya
   * tha ya nahi, ye log se nahi nikal saka. Ab
   * dispatcher rasta chunne se pehle ek
   * 'headless-session path=' line aur transfer nakam
   * ho to us ki wajah ke saath ek 'headless-transfer
   * failed' line deta hai; baaki sab (success line,
   * probe, clone, strategy note) bilkul waisa hi.
   * Safal = { browser, page, capture, cloneDir }
   * (cloneDir dono raaston me wohi temp dir hai jo
   * _headlessCloseSession mitata hai); clone raste
   * ki nakami = us ka throw.
   */
  async _headlessLaunch(account) {
    let cookies = null;
    const liveHandle = !!(this.browser || (this.page && !this.page.isClosed()));
    if (liveHandle) {
      try { cookies = await this._headlessReadLiveCookies(); } catch (e) { cookies = null; }
    }
    const cookieCount = Array.isArray(cookies) ? cookies.length : 0;
    const sessionPath = headlessHarvest.decideSessionPath({ liveHandle, cookieCount });
    // PARTNER TASK 1 (Issue #1, MK tasking + amendment,
    // 2026-11-05): dispatcher khud EK dafa bolta hai —
    // rasta chunne se PEHLE. Is ek line se ek hi live
    // run me teenon haal alag ho jate hain: transfer
    // kabhi aazmaya hi nahi (path=clone), live read ne
    // 0 cookies diye (cookies=0), ya transfer aazmaya
    // gaya aur nakam hua (neeche wali failed line us
    // ki wajah naam se degi). ZEROCLICK15 me ye farq
    // log se nikal hi nahi saka tha.
    // v2.48.49: live handle hote hue read BILKUL nakam
    // (null) ho to line 'cookies=null' bolti hai —
    // khaali read ke 'cookies=0' se alag (ZEROCLICK16
    // me dono haal ek ho jate the). Handle hi na ho
    // to purani shakal (cookies=0) hi rehti hai.
    const cookiesLabel = liveHandle && !Array.isArray(cookies) ? 'null' : String(cookieCount);
    try { this.log(`[ROOT] headless-session path=${sessionPath} liveHandle=${liveHandle} cookies=${cookiesLabel}`); } catch (e) {}
    if (sessionPath === 'cdp') {
      const session = await this._headlessLaunchTransferred(cookies);
      if (session) return session;
      // PARTNER TASK 1: transfer ki nakami ab chup
      // nahi rehti — _headlessLaunchTransferred ne
      // wajah this._lastTransferFailure me rakhi hai;
      // clone par girne se pehle EK line me wahi wajah
      // (whitespace dabaa kar, zyada se zyada 160
      // harf). Safal transfer par ye line kabhi nahi
      // banti; clone raste ki apni lines / strategy
      // note bilkul waisi hi rehti hain.
      const rawReason = this._lastTransferFailure ? String(this._lastTransferFailure) : 'unknown reason';
      const reason = rawReason.replace(/\s+/g, ' ').trim().slice(0, 160) || 'unknown reason';
      try { this.log(`[ROOT] headless-transfer failed (${reason}) — clone fallback will run`); } catch (e) {}
    }
    return this._headlessLaunchCloned(account);
  }

  /**
   * v2.48.47: LIVE browser se is account ki cookies
   * CDP par uthao. v2.48.49 (COOKIE-READ V2 —
   * ZEROCLICK16): akela tareeqa ('Network.getAllCookies'
   * browser-level par) live browser par 0 deta tha —
   * ya chup-chaap nakam hota tha; .48 ki dispatcher
   * line dono haal 'cookies=0' me mila deti thi aur
   * CDP transfer kabhi chuna hi nahi gaya (zc16:
   * 6/6 attempts 'path=clone liveHandle=true
   * cookies=0'). Ab paanch tareeqe TARTIB se
   * aazmaye jate hain (headlessHarvest.
   * COOKIE_READ_METHODS): browser-level CDP
   * 'Storage.getCookies', browser-level
   * 'Network.getAllCookies', page-level CDP
   * 'Storage.getCookies', page-level
   * 'Network.getAllCookies', aakhir me Puppeteer ka
   * page.cookies() API (teen Google/Flow pate).
   * Pehla count>0 wala tareeqa jeet-ta hai; ek
   * tareeqe ki nakami baaki ko nahi rokti; har
   * session finally me detach hota hai. Har read ke
   * baad EK '[ROOT] headless-cookieread …' line
   * (har tareeqe ka count ya 'err', chosen, total).
   * Wapsi: jeeta hua array; koi >0 nahi lekin kam az
   * kam ek tareeqa chal gaya to [] (khaali read);
   * paanchon nakam to null (asal nakami —
   * dispatcher 'cookies=null' bolta hai).
   */
  async _headlessReadLiveCookies() {
    const results = {};
    const noteErr = (key, e) => {
      const raw = e && e.message ? String(e.message) : String(e == null ? 'unknown error' : e);
      results[key] = { error: raw.replace(/\s+/g, ' ').trim().slice(0, 60) || 'unknown error' };
    };
    const noteRes = (key, res) => {
      results[key] = { cookies: res && Array.isArray(res.cookies) ? res.cookies : [] };
    };
    // (a)+(b) BROWSER-level CDP session ke dono
    // tareeqe — session bane to dono usi par, har
    // haal me detach.
    let bSession = null;
    let bErr = null;
    try {
      if (this.browser && typeof this.browser.target === 'function') {
        bSession = await this.browser.target().createCDPSession();
      }
    } catch (e) { bErr = e; }
    if (bSession) {
      try { noteRes('bStorage', await bSession.send('Storage.getCookies')); } catch (e) { noteErr('bStorage', e); }
      try { noteRes('bNetwork', await bSession.send('Network.getAllCookies')); } catch (e) { noteErr('bNetwork', e); }
      try { if (typeof bSession.detach === 'function') await bSession.detach(); } catch (e) {}
    } else {
      noteErr('bStorage', bErr || new Error('no browser CDP session'));
      noteErr('bNetwork', bErr || new Error('no browser CDP session'));
    }
    // (c)+(d) PAGE-level CDP session ke dono
    // tareeqe (createCDPSession ya page.target()) —
    // wahi usool: bane to dono, phir detach.
    const pg = this.page;
    let pSession = null;
    let pErr = null;
    try {
      if (pg && !pg.isClosed()) {
        if (typeof pg.createCDPSession === 'function') pSession = await pg.createCDPSession();
        else if (pg.target && typeof pg.target === 'function') pSession = await pg.target().createCDPSession();
      }
    } catch (e) { pErr = e; }
    if (pSession) {
      try { noteRes('pStorage', await pSession.send('Storage.getCookies')); } catch (e) { noteErr('pStorage', e); }
      try { noteRes('pNetwork', await pSession.send('Network.getAllCookies')); } catch (e) { noteErr('pNetwork', e); }
      try { if (typeof pSession.detach === 'function') await pSession.detach(); } catch (e) {}
    } else {
      noteErr('pStorage', pErr || new Error('no page CDP session'));
      noteErr('pNetwork', pErr || new Error('no page CDP session'));
    }
    // (e) Puppeteer ka apna page.cookies() — CDP
    // raaston se alag satah (Puppeteer-shakal ke
    // cookie objects; mapCookiesForSetCookies unhe
    // bhi sambhalta hai).
    try {
      if (pg && !pg.isClosed() && typeof pg.cookies === 'function') {
        const arr = await pg.cookies('https://flow.google.com/', 'https://www.google.com/', 'https://accounts.google.com/');
        results.pageApi = { cookies: Array.isArray(arr) ? arr : [] };
      } else {
        noteErr('pageApi', new Error('page.cookies unavailable'));
      }
    } catch (e) { noteErr('pageApi', e); }
    const agg = headlessHarvest.aggregateCookieRead(results);
    try { this.log(headlessHarvest.cookieReadLogLine(agg)); } catch (e) {}
    return agg.cookies;
  }

  /**
   * v2.48.47: headless browser TAAZI temp userDataDir
   * par kholo (koi profile clone NAHI) aur cookies
   * CDP 'Network.setCookies' se navigation se pehle
   * bitha do. Launch ke usool clone raste wale hi:
   * wahi HEADLESS_MODE, wahi executable, wahi args,
   * wahi windowless guard (guard nakam = haar —
   * clone rasta apni baari me wahi pinned
   * HEADLESS_NOT_WINDOWLESS error phainkega, taaki
   * note ki shakal na badle). Safal par
   * '[ROOT] headless-transfer cookies=<n> via=cdp'
   * line. Koi bhi nakami = browser band + temp dir
   * mita + null (bulane wala clone par jata hai) —
   * PARTNER TASK 1 ke baad nakami ki wajah
   * this._lastTransferFailure me bhi rehti hai,
   * jise dispatcher ek line me bolta hai.
   */
  async _headlessLaunchTransferred(cookies, userDirOverride) {
    // PARTNER TASK 1 (Issue #1, 2026-11-05): nakami
    // ki wajah ab gum nahi hoti — har nakam wapsi
    // this._lastTransferFailure me apni wajah rakhti
    // hai (dispatcher use 'headless-transfer failed'
    // line me bolta hai). Safal wapsi (session) ki
    // shakal bilkul waisi hi hai.
    // v2.48.50 (Part B — COMBO): userDirOverride diya
    // ho to session USI dir (tolerant clone) par
    // khulta hai; us surat me dir ki malkiyat bulane
    // wale ki hai — nakami par yahan se NAHI mitaya
    // jata (combo khud saaf karta hai); session band
    // hone par aam cloneDir safai hi use mitayegi.
    this._lastTransferFailure = null;
    const fail = (reason) => {
      try { this._lastTransferFailure = reason; } catch (e) {}
      return null;
    };
    const mapped = headlessHarvest.mapCookiesForSetCookies(cookies);
    if (!mapped.length) {
      return fail(`zero mapped cookies (live read returned ${Array.isArray(cookies) ? cookies.length : 0})`);
    }
    let userDir = null;
    let ownsDir = true;
    let browser = null;
    try {
      if (userDirOverride) { userDir = userDirOverride; ownsDir = false; }
      else userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-headless-'));
      const launchOpts = {
        executablePath: getChromeExecutablePath(),
        headless: headlessHarvest.HEADLESS_MODE,
        userDataDir: userDir,
        defaultViewport: { width: 1366, height: 900 },
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-session-crashed-bubble',
          '--hide-crash-restore-bubble',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--disable-notifications',
          '--deny-permission-prompts',
          '--disable-popup-blocking',
          '--disable-features=NotificationTriggers,PushMessaging',
          '--mute-audio',
          '--disk-cache-size=104857600'
        ],
        ignoreDefaultArgs: ['--enable-automation']
      };
      if (!headlessHarvest.launchIsWindowless(launchOpts)) {
        if (ownsDir) await headlessHarvest.removeHeadlessClone(userDir);
        return fail('a windowless (headless) launch is not guaranteed on this platform');
      }
      browser = await puppeteer.launch(launchOpts);
      const pages = await browser.pages();
      const page = pages.length > 0 ? pages[0] : await browser.newPage();
      // Taaki 'navigator.webdriver' na dikhe — clone
      // raste wali hi safai.
      try {
        await page.evaluateOnNewDocument(() => {
          try { delete Object.getPrototypeOf(navigator).webdriver; } catch (e) {}
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
      } catch (e) {}
      // Cookies navigation se PEHLE bithao.
      let cdp = null;
      try {
        if (typeof page.createCDPSession === 'function') cdp = await page.createCDPSession();
        else cdp = await page.target().createCDPSession();
      } catch (e) { cdp = null; }
      if (!cdp) throw new Error('no CDP session on the invisible browser page');
      try { await cdp.send('Network.enable'); } catch (e) {}
      await cdp.send('Network.setCookies', { cookies: mapped });
      try { await cdp.detach(); } catch (e) {}
      // v2.48.50 (Part B): line me ab cookie ke SIRF
      // NAAM bhi (sorted, hadd 300 harf) — qeematein
      // kabhi nahi. Combo ki dobara transfer par bhi
      // yahi line banti hai (wo bhi ek asal transfer
      // hai).
      try { this.log(`[ROOT] headless-transfer cookies=${mapped.length} via=cdp names=${headlessHarvest.cookieNamesForLog(mapped)}`); } catch (e) {}
      const capture = new networkCapture.NetworkCapture({});
      try { capture.attach(page); } catch (e) {}
      // v2.48.50: session par apna rasta + live cookies
      // darj — combo ka trigger (headlessComboApplies)
      // aur us ka setCookies inhi par bandha hai.
      return { browser, page, capture, cloneDir: userDir, via: 'cdp', liveCookies: Array.isArray(cookies) ? cookies : [] };
    } catch (e) {
      try { if (browser) await browser.close(); } catch (ignored) {}
      try { if (userDir && ownsDir) await headlessHarvest.removeHeadlessClone(userDir); } catch (ignored) {}
      // Launch ki nakami, CDP session ki ghair-
      // maujoodgi, setCookies ka inkaar — teeno yahin
      // aate hain; wajah launchFailureReason ki
      // shakal me (message + code) darj hoti hai.
      return fail(headlessHarvest.launchFailureReason(e));
    }
  }

  /**
   * v2.48.44 (HEADLESS HARVEST PACK — OPTION 2): profile
   * ki throwaway COPY par BILKUL BINA-WINDOW Chrome
   * chalao — clone sirf session ke buniyadi hisse leta
   * hai (engine/headlessHarvest), asal profile sirf
   * PADHA jata hai (kabhi khola/likha nahi jata). Launch
   * se pehle windowless darwaza (launchIsWindowless)
   * fail ho to browser banta hi nahi — visible window
   * par girne ka khatra kabhi nahi liya jata.
   * Lautta hai: { browser, page, capture, cloneDir }.
   * v2.48.47: ye ab CHAARA (fallback) hai —
   * _headlessLaunch pehle CDP cookie transfer aazmata
   * hai; ye rasta bilkul waisa hi chalta hai jab
   * transfer mayassar na ho ya nakam ho jaye.
   */
  async _headlessLaunchCloned(account) {
    const profileRoot = getAccountProfilePath(account.id);
    // v2.48.45: launch fail ho to EK dafa taza clone ke
    // saath dobara koshish (neeche loop) — aur har
    // koshish ki asal wajah log/note me (ZEROCLICK12 ka
    // diagnostic gap band).
    for (let launchAttempt = 1; ; launchAttempt++) {
    const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-headless-'));
    let clone = null;
    try {
      clone = await headlessHarvest.buildHeadlessClone(profileRoot, cloneDir);
    } catch (e) {
      // v2.48.46: clone FAIL par bhi us ka hisaab log
      // hota hai — throw ke saath chipka cloneReport
      // (ZEROCLICK13 me ye line sirf kamyabi par banti
      // thi, is liye missing-vs-copy-fail ka farq live
      // run me dikha hi nahi).
      if (e && e.cloneReport) {
        try { this.log(headlessHarvest.cloneLogLine(e.cloneReport)); } catch (ignored) {}
        if (e.cloneReport.cookiesRel) {
          try { this.log(`[ROOT] headless-clone cookies-found-at=${e.cloneReport.cookiesRel}`); } catch (ignored) {}
        }
      }
      await headlessHarvest.removeHeadlessClone(cloneDir);
      throw e;
    }
    // v2.48.45: clone ka hisaab ek line me — copy
    // warnings ab kahin gum nahi hoti.
    try { this.log(headlessHarvest.cloneLogLine(clone)); } catch (e) {}
    // v2.48.46: scan se mili ghair-mamooli Cookies
    // jagah bhi naam se darj.
    if (clone && clone.cookiesRel) {
      try { this.log(`[ROOT] headless-clone cookies-found-at=${clone.cookiesRel}`); } catch (e) {}
    }
    const launchOpts = {
      executablePath: getChromeExecutablePath(),
      headless: headlessHarvest.HEADLESS_MODE,
      userDataDir: cloneDir,
      defaultViewport: { width: 1366, height: 900 },
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--hide-crash-restore-bubble',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-notifications',
        '--deny-permission-prompts',
        '--disable-popup-blocking',
        '--disable-features=NotificationTriggers,PushMessaging',
        '--mute-audio',
        '--disk-cache-size=104857600'
      ],
      ignoreDefaultArgs: ['--enable-automation']
    };
    if (!headlessHarvest.launchIsWindowless(launchOpts)) {
      await headlessHarvest.removeHeadlessClone(cloneDir);
      this.log('[ROOT] headless-harvest aborted — a windowless launch is not guaranteed here, so no browser was started at all', 'warn');
      const err = new Error('a windowless (headless) launch is not guaranteed on this platform');
      err.code = 'HEADLESS_NOT_WINDOWLESS';
      throw err;
    }
    let browser = null;
    try {
      browser = await puppeteer.launch(launchOpts);
    } catch (e) {
      await headlessHarvest.removeHeadlessClone(cloneDir);
      if (launchAttempt === 1) {
        // v2.48.45: pehli launch ki wajah hamesha log
        // hoti hai; phir taza clone ke saath ek retry.
        this.log(`[ROOT] headless-harvest: launch failed (${headlessHarvest.launchFailureReason(e)}) — retrying once with a fresh copy of the session`, 'warn');
        continue;
      }
      throw e;
    }
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    try {
      await page.evaluateOnNewDocument(() => {
        try { delete Object.getPrototypeOf(navigator).webdriver; } catch (e) {}
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
    } catch (e) {}
    const capture = new networkCapture.NetworkCapture({});
    try { capture.attach(page); } catch (e) {}
    // v2.48.50: rasta darj — combo sirf 'cdp' par
    // lagta hai, clone raste par kabhi nahi.
    return { browser, page, capture, cloneDir, via: 'clone' };
    }
  }

  /** Headless session band karo + clone mita do (hamesha, har surat me). */
  async _headlessCloseSession(session) {
    if (!session) return;
    try { if (session.capture) session.capture.detach(); } catch (e) {}
    try { if (session.browser) await session.browser.close(); } catch (e) {}
    try { await headlessHarvest.removeHeadlessClone(session.cloneDir); } catch (e) {}
  }

  /** Headless page ke DOM se probe ke nishan (ek nazar). */
  async _headlessReadProbeDom(page) {
    try {
      return await page.evaluate(() => {
        const vis = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (e) { return false; } };
        const anyVis = (sel) => Array.from(document.querySelectorAll(sel)).some(vis);
        const hasPromptBox = anyVis('.ProseMirror, div[contenteditable="true"], div[role="textbox"]');
        const hasTiles = document.querySelectorAll('flow-grid-tile-container').length > 0;
        const hasAvatar = anyVis('[data-testid*="avatar"], img[alt*="ccount"]');
        let hasSignIn = false;
        for (const el of Array.from(document.querySelectorAll('a, button'))) {
          const t = (el.textContent || '').trim().toLowerCase();
          const href = (el.getAttribute && el.getAttribute('href')) || '';
          if (href.includes('accounts.google.com')) { hasSignIn = true; break; }
          if ((t === 'sign in' || t === 'log in') && vis(el)) { hasSignIn = true; break; }
        }
        const hasCaptcha = !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey]');
        const text = ((document.body && document.body.innerText) || '').slice(0, 6000);
        return { url: window.location.href, hasPromptBox, hasTiles, hasAvatar, hasSignIn, hasCaptcha, text };
      });
    } catch (e) {
      return null;
    }
  }

  /**
   * PROBE ka asal kaam: headless page Flow ke home par
   * jata hai, nishaanon ka chhota intezaar karta hai,
   * aur snapshot ka faisla headlessHarvest ke khalis
   * hisaab se hota hai. Tests _headlessProbeSnapshot
   * ko stub karke asal classifier chalate hain.
   */
  /** Nishaanon ka chhota intezaar — koi nishan dikhe to foran wapsi. */
  async _headlessProbeWait(page, waitMs) {
    const deadline = Date.now() + Math.max(0, waitMs || 0);
    let snap = null;
    for (;;) {
      snap = await this._headlessReadProbeDom(page);
      if (!snap) break;
      if (snap.hasPromptBox || snap.hasTiles || snap.hasAvatar || snap.hasSignIn || snap.hasCaptcha) break;
      if (Date.now() >= deadline || this.isStopping) break;
      await sleep(500);
    }
    return snap;
  }

  async _headlessProbeSnapshot(page) {
    try {
      await page.goto('https://flow.google.com/', { waitUntil: 'domcontentloaded', timeout: this.headlessNavTimeoutMs || 45000 });
    } catch (e) {}
    // v2.48.50 (item 13 — PROBE PATIENCE): 'logged-out'
    // ka faisla ab jaldi nahi hota. Pehli nazar me koi
    // pakka nishan na mile (aur haal 'blocked' bhi na
    // ho — wo deewaar foran wapas hoti hai) to:
    // koshish 2 = network ke thaharne ka intezaar +
    // taaza nazar; koshish 3 = EK reload + taaza
    // nazar. Kul ~10s ki hadd me. Session kabhi kabhi
    // der se jaagta hai (ZEROCLICK17 ke baad ye sabr
    // asal farq ban sakta hai); 'logged-in'/'blocked'
    // pehli nazar par hi pakke hain, un par sabr
    // kabhi nahi lagta.
    let snap = await this._headlessProbeWait(page, 4000);
    if (!snap) return snap;
    const classify = (s) => headlessHarvest.classifyProbeSnapshot(s);
    if (classify(snap) !== 'logged-out' || this.isStopping) return snap;
    try {
      if (page && typeof page.waitForNetworkIdle === 'function') {
        await page.waitForNetworkIdle({ timeout: 3000 });
      }
    } catch (e) {}
    await sleep(500);
    const snap2 = await this._headlessProbeWait(page, 2000);
    if (snap2) snap = snap2;
    if (classify(snap) !== 'logged-out' || this.isStopping) return snap;
    try {
      if (page && typeof page.reload === 'function') {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: this.headlessNavTimeoutMs || 45000 });
      }
    } catch (e) {}
    const snap3 = await this._headlessProbeWait(page, 3000);
    if (snap3) snap = snap3;
    return snap;
  }

  /** Probe: snapshot lo aur faisla wapas karo ('logged-in' sirf pakke nishan par). */
  async _headlessProbeOnce(account, page) {
    const snap = await this._headlessProbeSnapshot(page);
    // v2.48.50 (Part B): aakhri snapshot engine par
    // rakho — probe ki log line url + nishan usi se
    // bharti hai (classify wale hi fields).
    try { this._lastHeadlessProbeSnap = snap || null; } catch (e) {}
    if (!snap) return 'logged-out';
    return headlessHarvest.classifyProbeSnapshot(snap);
  }

  /**
   * Is task ka editor ADRISHYA browser me kholo: pehle
   * wahi project (visible page ka pata), phir
   * fingerprint se tile, phir tile click — bilkul wahi
   * tareeqa jo visible editor kholne ka hai, lekin ye
   * page ek bina-window browser me hai: screen par kuch
   * aa hi nahi sakta. Lautta hai: true (editor khula).
   */
  async _headlessOpenTaskEditor(hpage, task, tileIndexHint) {
    let projectUrl = null;
    try {
      const u = this.page && !this.page.isClosed() ? (this.page.url() || '') : '';
      if (u.includes('/project/')) projectUrl = u.split('/edit/')[0];
    } catch (e) {}
    if (!projectUrl) return false;
    try {
      await hpage.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: this.headlessNavTimeoutMs || 45000 });
    } catch (e) {}
    const deadline = Date.now() + 15000;
    let tileCount = 0;
    for (;;) {
      try { tileCount = await hpage.evaluate(() => document.querySelectorAll('flow-grid-tile-container').length); } catch (e) { tileCount = 0; }
      if (tileCount > 0) break;
      if (Date.now() >= deadline || this.isStopping) return false;
      await sleep(500);
    }
    const idx = await this._resolveTileIndexForTask(task, tileIndexHint, hpage);
    if (!Number.isFinite(idx) || idx < 0) return false;
    const coords = await this._tileCenterCoords(idx, hpage);
    if (!coords || !coords.found) return false;
    for (let clickTry = 0; clickTry < 2; clickTry++) {
      try { await hpage.mouse.click(coords.x, coords.y); } catch (e) {}
      await sleep(1500);
      if (await this._inEditorView(hpage)) return true;
    }
    return await this._inEditorView(hpage);
  }

  /**
   * v2.48.50 (Part B — CLONE+INJECT COMBO): transfer
   * session ke 'logged-out' aane par dusra mauqa:
   *   1. profile ka TOLERANT clone (sirf Cookies ki
   *      kamzori qubool — baaqi har essential ki
   *      nakami par haar, strict wali wajah ke saath);
   *   2. clone ke andar live cookies se bani SYNTHETIC
   *      Cookies DB (item 11) — clone ab 'mukammal'
   *      hai, EBUSY wali kami DB se bhari;
   *   3. wahi CDP transfer (setCookies, navigation se
   *      pehle) lekin userDataDir = CLONE DIR — session
   *      ab profile ki asal haalat (Local State /
   *      storage) ke saath khulta hai;
   *   4. probe2 — us ka faisla lautta hai.
   * Safal par { session, verdict }; kisi bhi qadam ki
   * nakami par { reason } (bulane wala 'headless-combo
   * skipped' line banata hai) — kabhi throw nahi, aur
   * nakami par apna banaya hua sab saaf.
   */
  async _headlessComboSession(account, oldSession) {
    const cookies = oldSession && Array.isArray(oldSession.liveCookies) ? oldSession.liveCookies : null;
    if (!cookies || !cookies.length) return { reason: 'no-live-cookies' };
    const profileRoot = getAccountProfilePath(account.id);
    const comboDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-headless-'));
    let clone = null;
    try {
      clone = await headlessHarvest.buildHeadlessClone(profileRoot, comboDir, { tolerantCookiesOnly: true });
    } catch (e) {
      if (e && e.cloneReport) {
        try { this.log(headlessHarvest.cloneLogLine(e.cloneReport)); } catch (ignored) {}
        if (e.cloneReport.cookiesRel) {
          try { this.log(`[ROOT] headless-clone cookies-found-at=${e.cloneReport.cookiesRel}`); } catch (ignored) {}
        }
      }
      await headlessHarvest.removeHeadlessClone(comboDir);
      return { reason: 'clone-build-failed' };
    }
    try { this.log(headlessHarvest.cloneLogLine(clone)); } catch (e) {}
    if (clone && clone.cookiesRel) {
      try { this.log(`[ROOT] headless-clone cookies-found-at=${clone.cookiesRel}`); } catch (e) {}
    }
    // Item 11: synthetic Cookies DB clone ke andar —
    // parkhi hui (read-back validated) file hi likhi
    // jati hai.
    // v2.48.51 (item 2): DB na bane to combo YAHIN
    // rukta hai — bulane wala '[ROOT] headless-combo
    // skipped reason=cookiesdb-failed' likhta hai aur
    // strategy aaj ki tarah khatam hoti hai.
    // (ZEROCLICK18: DB line aayi hi nahi aur pata hi
    // nahi chala combo chala ya nahi — ab combo chale
    // to 'headless-cookiesdb built' line LAZMI hai.)
    let dbBuilt = false;
    try {
      const dbRes = await cookiesDb.buildCookiesDbFile(cookies, clone, comboDir);
      if (dbRes && dbRes.built) {
        dbBuilt = true;
        this.log(`[ROOT] headless-cookiesdb built cookies=${dbRes.count}`);
      }
    } catch (e) {
      dbBuilt = false;
    }
    if (!dbBuilt) {
      await headlessHarvest.removeHeadlessClone(comboDir);
      return { reason: 'cookiesdb-failed' };
    }
    let session2 = null;
    try { session2 = await this._headlessLaunchTransferred(cookies, comboDir); } catch (e) { session2 = null; }
    if (!session2) {
      await headlessHarvest.removeHeadlessClone(comboDir);
      return { reason: 'combo-launch-failed' };
    }
    let verdict2 = 'logged-out';
    try { verdict2 = await this._headlessProbeOnce(account, session2.page); } catch (e) { verdict2 = 'logged-out'; }
    return { session: session2, verdict: verdict2 };
  }

  /**
   * v2.48.44 (HEADLESS HARVEST PACK — OPTION 2): VIDEO
   * download ka NAYA PEHLA rasta. Tarteeb:
   *   0. per-run probe cache me is account ka reject
   *      pehle se ho to launch/probe dobara NAHI —
   *      wahi thahra hua strategy note, foran aage;
   *      v2.48.51 (item 2): probe2 ne is run me is
   *      account ko clone+inject se 'logged-in' diya
   *      ho to combo-yaad seedha combo session banati
   *      hai (bare transfer probe skip);
   *   1. profile ki copy par bina-window Chrome +
   *      PROBE (ek run me ek account ka ek hi probe):
   *      '[ROOT] headless-probe state=<...> account=<...>';
   *      qubool na ho to PROBE_REJECT_NOTE ke saath
   *      haar — editor khulta hi nahi;
   *   2. qubool ho to usi adrishya browser me is task
   *      ka editor, aur editor ki apni playback stream
   *      capture kitab se (mukammal body pehle; bandha
   *      address ho to editor page ke andar poora
   *      fetch) — saveGuard darwaze (teacher-url yahan,
   *      quality gate + content-hash duplicate
   *      _saveBufferForTask ke andar) guzar kar save.
   * Jeet: '[ROOT] via=headless-harvest gap=<X>s'.
   * Session har surat me band + clone mita hua.
   * Prompt yahan KABHI dobara submit nahi hota.
   */
  async _tryHeadlessHarvest(task, downloadFolder, settings, attempts, captureKey, tileIndexHint) {
    const n = task.promptIndex + 1;
    if (!task || task.mediaSaved) return false;
    const account = this.currentAccount;
    const fail = (note) => {
      attempts.push({ strategy: 'headless-harvest', ok: false, note });
      return false;
    };
    if (!account || !account.id) {
      return fail('no account session is attached to this worker, so the invisible-browser harvest could not run — the main-page routes ran next');
    }
    const label = account.name || account.id;
    const cached = this._headlessProbeCache ? this._headlessProbeCache.get(account.id) : null;
    if (cached && cached !== 'logged-in') {
      return fail(headlessHarvest.PROBE_REJECT_NOTE);
    }
    let session = null;
    // v2.48.51 (item 2 — combo yaad ka rasta): is
    // account ke liye probe2 is RUN me pehle hi
    // 'logged-in' de chuka hai to bare transfer probe
    // dobara NAHI — seedha combo session banao (live
    // cookies uthao, clone+inject, probe2). Probe2 is
    // dafa reject kare to yaad mita do aur rejection
    // probe cache me darj — baad ke attempts cached
    // rejection se hi rukte hain, combo dobara nahi
    // banta. Combo build hi na bane to skipped line +
    // wahi thahri hui haar.
    let presetVerdict = null;
    if (this._headlessComboAccounts && this._headlessComboAccounts.has(account.id)) {
      let liveCookies = null;
      try { liveCookies = await this._headlessReadLiveCookies(); } catch (e) { liveCookies = null; }
      const combo = await this._headlessComboSession(account, { liveCookies: liveCookies || [] }).catch(() => null);
      if (combo && combo.session) {
        session = combo.session;
        presetVerdict = combo.verdict;
        try { task._headlessProbeState = presetVerdict; } catch (e) {}
        const snapM = this._lastHeadlessProbeSnap;
        const blockReasonM = headlessHarvest.probeBlockReason(snapM);
        this.log(headlessHarvest.probe2LogLine({
          state: presetVerdict,
          hasCaptcha: blockReasonM.captcha,
          marker: blockReasonM.marker
        }), presetVerdict === 'logged-in' ? 'success' : 'warn');
        try { if (this._headlessProbeCache) this._headlessProbeCache.set(account.id, presetVerdict); } catch (e) {}
        if (presetVerdict !== 'logged-in') {
          try { this._headlessComboAccounts.delete(account.id); } catch (e) {}
          await this._headlessCloseSession(session);
          return fail(headlessHarvest.PROBE_REJECT_NOTE);
        }
      } else {
        this.log(`[ROOT] headless-combo skipped reason=${combo && combo.reason ? combo.reason : 'combo-failed'}`, 'warn');
        return fail(headlessHarvest.PROBE_REJECT_NOTE);
      }
    }
    if (!session) {
      try {
        session = await this._headlessLaunch(account);
      } catch (e) {
        // v2.48.45: asal wajah (exception message + code)
        // log AUR strategy note dono me — ZEROCLICK12 me
        // launch fail ki wajah kahin record nahi hoti thi.
        this.log(`[ROOT] [Prompt #${n}] headless-harvest: launch failed (${headlessHarvest.launchFailureReason(e)}) — the main-page routes will run`, 'warn');
        return fail(headlessHarvest.launchFailNote(e));
      }
    }
    try {
      let hcap = session.capture;
      let hpage = session.page;
      const setupCapture = () => {
        try { if (hcap) hcap.harvestFloorBytes = downloadFetch.minBytesForDuration(settings && settings.duration); } catch (e) {}
        try { if (hcap) hcap.harvestExpectedDurationSec = this._expectedDurationSec(task, settings); } catch (e) {}
        try { if (hcap) hcap.beginSubmission(captureKey, Date.now()); } catch (e) {}
      };
      setupCapture();
      // v2.48.51 (item 2): combo-yaad wale raste par
      // faisla pehle se tay hai (presetVerdict) — probe
      // dobara nahi, cache me wahi combo faisla darj
      // (upar prelude me set ho chuka hai).
      let verdict = presetVerdict || cached;
      if (!verdict) {
        verdict = await this._headlessProbeOnce(account, hpage);
        try { task._headlessProbeState = verdict; } catch (e) {}
        // v2.48.50 (Part B): probe line ab url + nishan
        // ke saath (probeLogLine — snapshot ke wahi
        // fields jo classifier khata hai).
        // v2.48.51 (item 2): captcha + marker ki
        // tafseel bhi (probeBlockReason — classifier
        // ke faisle se alag, sirf log ke liye).
        const snap = this._lastHeadlessProbeSnap;
        const blockReason = headlessHarvest.probeBlockReason(snap);
        this.log(headlessHarvest.probeLogLine({
          state: verdict, account: label,
          url: snap && snap.url,
          hasSignIn: !!(snap && snap.hasSignIn),
          hasAvatar: !!(snap && snap.hasAvatar),
          hasPromptBox: !!(snap && snap.hasPromptBox),
          hasCaptcha: blockReason.captcha,
          marker: blockReason.marker
        }), verdict === 'logged-in' ? 'success' : 'warn');
        // v2.48.50 (Part B — CLONE+INJECT COMBO, DBSC
        // discriminator): transfer session 'logged-out'
        // aaya ho to EK dusra mauqa — tolerant clone
        // (sirf Cookies ki kamzori qubool) ke UPDir par
        // wahi transferred session, andar synthetic
        // Cookies DB ke saath; probe2 ka faisla hi is
        // attempt ka faisla banta hai. Combo na bane to
        // 'headless-combo skipped' line + aaj wali haar.
        // Probe cache ka set is ke BAAD hai — cache me
        // hamesha aakhri faisla jata hai.
        // v2.48.51 (item 2): trigger ab blocked par bhi
        // (headlessComboApplies), probe2 line me
        // captcha/marker tafseel, aur probe2 'logged-in'
        // de to is RUN ke liye account ki combo-yaad
        // set — baad ke attempts seedha combo banate
        // hain (neeche wala memory rasta).
        if (headlessHarvest.headlessComboApplies({ via: session && session.via, verdict, tried: false })) {
          const combo = await this._headlessComboSession(account, session).catch(() => null);
          if (combo && combo.session) {
            await this._headlessCloseSession(session);
            session = combo.session;
            hcap = session.capture;
            hpage = session.page;
            setupCapture();
            verdict = combo.verdict;
            try { task._headlessProbeState = verdict; } catch (e) {}
            const snap2 = this._lastHeadlessProbeSnap;
            const blockReason2 = headlessHarvest.probeBlockReason(snap2);
            this.log(headlessHarvest.probe2LogLine({
              state: verdict,
              hasCaptcha: blockReason2.captcha,
              marker: blockReason2.marker
            }), verdict === 'logged-in' ? 'success' : 'warn');
            if (verdict === 'logged-in' && this._headlessComboAccounts && !this._headlessComboAccounts.has(account.id)) {
              this._headlessComboAccounts.add(account.id);
              this.log(`[ROOT] headless-mode account=${label} mode=clone-inject (probe2)`);
            }
          } else {
            this.log(`[ROOT] headless-combo skipped reason=${combo && combo.reason ? combo.reason : 'combo-failed'}`, 'warn');
          }
        }
        try { if (this._headlessProbeCache) this._headlessProbeCache.set(account.id, verdict); } catch (e) {}
      }
      if (verdict !== 'logged-in') {
        return fail(headlessHarvest.PROBE_REJECT_NOTE);
      }
      try { if (hcap) hcap.setDownloadAttempt(captureKey); } catch (e) {}
      let editorOpen = false;
      try { editorOpen = await this._headlessOpenTaskEditor(hpage, task, tileIndexHint); } catch (e) { editorOpen = false; }
      if (!editorOpen) {
        this.log(`[ROOT] [Prompt #${n}] headless-harvest: this video's editor did not open in the invisible browser — the main-page routes will run`, 'warn');
        return fail('the copied session was accepted, but this video\'s editor did not open in the invisible browser — the main-page routes ran next');
      }
      let teacherUrl = null;
      try { teacherUrl = this.netCapture ? this.netCapture.teacherMintUrlForTemplate(null) : null; } catch (e) { teacherUrl = null; }
      const gapSec = () => Math.max(0, (Date.now() - (task.renderCompletedAt || task.startTime || Date.now())) / 1000).toFixed(1);
      const win = () => {
        const g = gapSec();
        this.log(`[ROOT] via=headless-harvest gap=${g}s`, 'success');
        attempts.push({ strategy: 'headless-harvest', ok: true, note: `the file was captured from this video's own editor playback stream inside a window-less copy of the account's browser — nothing was opened or shown anywhere; render→save gap ${g}s` });
        return true;
      };
      const saveFromHeadless = async (url, buffer) => {
        if (teacherUrl && url === teacherUrl) {
          this.log(`[ROOT] [Prompt #${n}] headless-harvest: the captured stream address is the previous task's (teacher) — not saving it`, 'warn');
          return 'teacher';
        }
        try { if (hcap) hcap.claimFlowContentVideo(url); } catch (e) {}
        try { if (this.netCapture) this.netCapture.claimFlowContentVideo(url); } catch (e) {}
        task.completedVideoUrl = url;
        const ok = await this._saveBufferForTask(task, downloadFolder, settings, buffer, url, 'headless-harvest');
        // v2.48.50 (item 7): race ki jeet mainpage ki
        // ho to ye save jeet NAHI hai — 'rejected'.
        const raceLostHh = !!(task._raceActive && task._raceWonBy && task._raceWonBy !== 'headless-harvest');
        return ((ok || task.mediaSaved) && task._saveRejectedReason !== 'route-race' && !raceLostHh) ? 'saved' : 'rejected';
      };
      const waitMs = Math.max(1000, this.headlessHarvestWaitMs || 30000);
      const deadline = Date.now() + waitMs;
      const triedFetchUrls = new Set();
      for (;;) {
        if (task.mediaSaved) return true;
        let entry = null;
        try { entry = hcap ? hcap.harvestForKey(captureKey) : null; } catch (e) { entry = null; }
        if (entry && entry.buffer && entry.buffer.length > 0) {
          try { hcap.evictHarvest(captureKey); } catch (e) {}
          const r = await saveFromHeadless(entry.url, entry.buffer);
          if (r === 'saved') return win();
          if (r === 'teacher') {
            return fail('the stream captured in the invisible browser was the previous task\'s file address (teacher) and was not saved — the main-page routes ran next');
          }
          return fail(`the stream captured in the invisible browser did not pass the save checks (${task._saveRejectedReason || 'the video verification failed'}) — the main-page routes ran next`);
        }
        let boundUrl = null;
        try { const b = hcap ? hcap.urlForKey(captureKey) : null; if (b && b.url) boundUrl = b.url; } catch (e) {}
        if (!boundUrl) {
          try {
            const rec = hcap ? hcap.recentFlowContentVideos(Date.now() - waitMs - 60000) : [];
            if (rec && rec.length) boundUrl = rec[rec.length - 1].url;
          } catch (e) {}
        }
        if (boundUrl && !triedFetchUrls.has(boundUrl)) {
          triedFetchUrls.add(boundUrl);
          const fetched = await this._fetchMainpageFullInPage(boundUrl, hpage);
          if (fetched && fetched.buf && fetched.buf.length > 0 && fetched.status !== 206 && downloadFetch.looksLikeVideoBuffer(fetched.buf)) {
            const r = await saveFromHeadless(boundUrl, fetched.buf);
            if (r === 'saved') return win();
            if (r === 'teacher') {
              return fail('the stream captured in the invisible browser was the previous task\'s file address (teacher) and was not saved — the main-page routes ran next');
            }
            return fail(`the stream captured in the invisible browser did not pass the save checks (${task._saveRejectedReason || 'the video verification failed'}) — the main-page routes ran next`);
          }
        }
        if (Date.now() >= deadline || this.isStopping) break;
        await sleep(300);
      }
      this.log(`[ROOT] [Prompt #${n}] headless-harvest: no complete editor stream arrived in the invisible browser within ${Math.round(waitMs / 1000)}s — the main-page routes will run`, 'warn');
      return fail('the copied session was accepted, but the editor playback stream did not complete in the invisible browser in time — the main-page routes ran next');
    } catch (e) {
      return fail('the invisible-browser harvest hit a problem — the main-page routes ran next');
    } finally {
      try { if (session && session.capture) session.capture.clearDownloadAttempt(captureKey); } catch (e) {}
      await this._headlessCloseSession(session);
    }
  }

  /**
   * v2.48.72 (EDITOR-HARVEST PRIMARY — OWNER DECISION
   * 2026-11-09): VIDEO download ka PEHLA rasta. Owner ne
   * .41 wali editor-pabandi KHUD uthayi hai: ab is task
   * ka editor WORKER KE LIVE browser (wahi dikhai dene
   * wala page jis par video bani) me khulta hai aur
   * editor ki apni playback stream capture hoti hai —
   * ZEROCLICK6/7/8 ka wahid rasta jis ne asal bytes
   * bharose se diye the (v2.48.38–.39 EDITOR-HARVEST
   * ka tareeqa, lekin ab headless/bg ki jagah live page
   * par). Editor kholna _headlessOpenTaskEditor wali
   * hi parkhi hui mashineri hai (fingerprint se bandhi
   * tile, ≥4 significant words / ≥0.6 precision / strict
   * win — bandhan bilkul waisa hi); wo pehle headless
   * page par chalti thi, ab live page par chalti hai.
   * Save STREAM CAPTURE se hai (is page ki networkCapture
   * kitab → _saveBufferForTask ka maujud save point,
   * .70 acceptance gate hu-bahu) — editor ke "Download
   * media" button/menu ka click KABHI nahi.
   * Tarteeb:
   *   1. grid se is task ka editor kholo;
   *   2. editor ki playback stream ka intezaar — kitab
   *      me mukammal body ho to wohi; bandha address ho
   *      to editor page ke andar poora fetch
   *      (_fetchMainpageFullInPage); dono quality aayein
   *      to itag 22 (720p) ko 18 (360p) par tarjeeh;
   *      teacher/duplicate darwaze barkarar;
   *   3. jeet ya had-banda timeout (default 120s) — har
   *      surat me page PROJECT GRID par wapas; wapsi
   *      nakam ho to '[ROOT] editor-harvest return-failed'
   *      line aur run aage (crash kabhi nahi).
   * Jeet: '[ROOT] via=editor-harvest gap=<X>s' (render→
   * save gap har video ka alag — owner ki standing
   * reporting rule). Prompt yahan KABHI dobara submit
   * nahi hota (sacred rule barkarar).
   */
  /**
   * Editor ke top bar ka Download wala control — pehle
   * parkha hua "Download media" rasta
   * (_findEditorDownloadControl), phir naye editor UI ka
   * 'download' aria wala ⬇ icon (top bar ke andar hi,
   * overlay ke controls ginne baghair).
   */
  async _findEditorDownloadButton(page) {
    const pg = page || this.page;
    try {
      const ctl = await this._findEditorDownloadControl(pg);
      if (ctl && ctl.found) return ctl;
    } catch (e) {}
    try {
      return await pg.evaluate(() => {
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const all = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const b of all) {
          if (b.closest && b.closest('.cdk-overlay-pane')) continue;
          if (!visible(b)) continue;
          const r = b.getBoundingClientRect();
          if (r.top > 160) continue;
          const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
          const t = (b.innerText || b.textContent || '').trim().toLowerCase();
          if (aria.includes('download') || t === 'download') {
            return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, how: aria || t };
          }
        }
        return { found: false };
      });
    } catch (e) {
      return { found: false };
    }
  }

  /**
   * Khule hue Download menu ki entries — [{text, x, y,
   * upgrade}]. Do darwaze: parkhe hue overlay containers,
   * aur koi bhi dikhai dene wala element jis ke text me
   * quality wale alfaaz hon (naya editor UI custom menu
   * deta hai). Har entry ka text us ki poori ROW ka text
   * hai (label + sub-label), taaki khalis chunav
   * (editorEnhance.pickUpscaledEntry) dono hisse dekh
   * sake; 'upgrade' nishaan row ke text se hi pakda jata
   * hai (4K wali row par Upgrade pill usi row me hota hai).
   */
  async _editorEnhanceMenuItems(page) {
    const pg = page || this.page;
    try {
      return await pg.evaluate(() => {
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const hasQualityWords = (t) => /(upscaled|original size|animated gif)/i.test(t || '');
        const hasQualityToken = (t) => /(\d{3,4}p|4k)/i.test(t || '');
        const clean = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        const rowOf = (el) => {
          let cur = el;
          for (let i = 0; i < 3 && cur; i++) {
            const t = clean(cur);
            if (t && t.length <= 90 && hasQualityWords(t) && hasQualityToken(t)) return cur;
            cur = cur.parentElement;
          }
          return el;
        };
        const out = [];
        const seen = new Set();
        const push = (el) => {
          if (!el || !visible(el)) return;
          const row = rowOf(el);
          const t = clean(row);
          if (!t || t.length > 90 || !hasQualityWords(t)) return;
          const r = row.getBoundingClientRect();
          const key = t.toLowerCase() + '@' + Math.round(r.top);
          if (seen.has(key)) return;
          seen.add(key);
          out.push({ text: t, x: r.x + r.width / 2, y: r.y + r.height / 2, upgrade: /upgrade/i.test(t) });
        };
        document.querySelectorAll('.cdk-overlay-pane button, [role="menuitem"], .mat-mdc-menu-panel button, [role="menu"] button, [role="listbox"] [role="option"]').forEach(push);
        const all = Array.from(document.querySelectorAll('button, [role="button"], li, div, span'));
        for (const el of all) {
          if (!visible(el)) continue;
          const t = clean(el);
          if (!t || t.length > 90 || !hasQualityWords(t)) continue;
          const childMatch = Array.from(el.children).some((c) => hasQualityWords(clean(c)));
          if (!childMatch) push(el);
        }
        return out;
      });
    } catch (e) {
      return [];
    }
  }

  /** Buffer asal me enhanced hai ya nahi — dimensions ki kasauti (temp file par ffprobe). */
  async _bufferMatchesEnhanceTarget(buffer, target, downloadFolder) {
    const tmpDir = this.browserDownloadDir || downloadFolder;
    let tmpPath = null;
    try {
      if (!tmpDir || !buffer || !buffer.length) return false;
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      tmpPath = path.join(tmpDir, `.enhance-probe-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp4`);
      fs.writeFileSync(tmpPath, buffer);
      const dims = await FFmpegService.getVideoDimensions(tmpPath);
      return editorEnhance.dimensionsMatchTarget(dims, target);
    } catch (e) {
      return false;
    } finally {
      if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
    }
  }

  /**
   * v2.48.74 (Item B — ENHANCED DOWNLOAD, owner order
   * 2026-11-09): settings.downloadMode 'enhanced' ho to
   * editor ke Download (⬇) menu se EK STEP UPAR wali
   * "Upscaled" file ki koshish (360p→720p, 720p→1080p;
   * 'Upgrade' paywall wali entry KABHI nahi — chunav ka
   * khalis hisaab engine/editorEnhance me hai, fixture
   * tests ke saath). Editor pehle se khula hai (bulane
   * wala _tryEditorHarvest hai).
   * Aamad ke do darwaze, dono par dimensions ki kasauti
   * lazmi hai (editor ki apni playback stream ORIGINAL
   * hai — wo enhanced keh kar kabhi save nahi hogi):
   *   (a) networkCapture me is click ke BAAD aayi NAYI
   *       stream ki mukammal body → saveFromEditor
   *       (wahi teacher/duplicate darwaze + .70 gate);
   *   (b) browser ka apna download (.flow-native folder
   *       me utri mukammal file — parkha hua native
   *       rasta) → bytes _saveBufferForTask ke usi save
   *       point se (.70 gate hu-bahu).
   * Had-banda intezaar 180s (upscale Flow ke server par
   * banta hai, waqt lag sakta hai). Round ki 150s
   * download ghadi beech me kaat de to ghadi ki haalat
   * task par rehti hai — agla round menu DOBARA nahi
   * kholta, sirf intezaar jodta hai (join).
   * Wapsi: 'enhanced' (enhanced file save hui) |
   * 'saved-other' (intezaar ke dauraan kisi aur raste
   * ne save kar diya) | 'unavailable' (bulane wala
   * original wale intezaar par jata hai).
   * Prompt yahan KABHI dobara submit nahi hota.
   */
  async _tryEditorEnhance(task, page, downloadFolder, settings, attempts, captureKey, saveFromEditor, gapSec) {
    const n = task.promptIndex + 1;
    const cap = this.netCapture;
    const target = task._enhanceTarget
      || editorEnhance.enhanceTargetFor(editorEnhance.nativeQualityOf(settings && settings.quality));
    const joined = !!(task._enhanceDeadline && task._enhanceDeadline > Date.now());
    try {
      if (!joined) {
        const native = editorEnhance.nativeQualityOf(settings && settings.quality);
        task._enhanceTarget = target;
        this.log(`[ROOT] editor-enhance start prompt=${n} native=${native} target=${target} — opening the editor's Download menu`, 'info');
        // Click se pehle ki kitab: jo addresses pehle se
        // maloom hain wo ORIGINAL ke hain — enhanced sirf
        // NAYA address gina jayega.
        const known = new Set();
        try { const e0 = cap.harvestForKey(captureKey); if (e0 && e0.url) known.add(e0.url); } catch (e) {}
        try { const b0 = cap.urlForKey(captureKey); if (b0 && b0.url) known.add(b0.url); } catch (e) {}
        try {
          const rec0 = typeof cap.recentFlowContentVideos === 'function' ? cap.recentFlowContentVideos(Date.now() - 600000) : [];
          for (const r of (rec0 || [])) { if (r && r.url) known.add(r.url); }
        } catch (e) {}
        task._enhanceKnownUrls = known;
        task._enhanceClaimedFiles = new Set();
        task._enhanceStableFiles = new Map();
        try { task._enhancePrep = await this._nativeDownloadPrep(downloadFolder); } catch (e) { task._enhancePrep = null; }
        // Download control: ~15s tak poll (editor top bar
        // ka load waqt — _nativeEditorForm wala sabak).
        let ctl = { found: false };
        for (let r = 0; r < 30; r++) {
          ctl = await this._findEditorDownloadButton(page);
          if (ctl.found) break;
          if (task.mediaSaved || this.isStopping) break;
          await sleep(500);
        }
        if (!ctl.found) {
          this.log(`[ROOT] [Prompt #${n}] editor-enhance: the editor's Download control was not found — the original file will be saved instead`, 'warn');
          attempts.push({ strategy: 'editor-enhance', ok: false, note: 'the editor Download control was not found; the original-quality save ran instead' });
          return 'unavailable';
        }
        task._enhanceClickTime = Date.now();
        await page.mouse.click(ctl.x, ctl.y);
        // Menu + chunav: entries aane tak ~6s poll; chunav
        // khalis hisaab se (target + 'Upscaled', Upgrade
        // wala kabhi nahi).
        let picked = null;
        let menuSeen = false;
        for (let r = 0; r < 12 && !picked; r++) {
          const items = await this._editorEnhanceMenuItems(page);
          if (items.length) {
            menuSeen = true;
            picked = editorEnhance.pickUpscaledEntry(items, target);
            if (picked) break;
          }
          await sleep(500);
        }
        if (!picked) {
          this.log(`[ROOT] [Prompt #${n}] editor-enhance: ${menuSeen ? `the Download menu offered no "${target} Upscaled" entry` : 'the Download menu did not open'} — the original file will be saved instead`, 'warn');
          attempts.push({ strategy: 'editor-enhance', ok: false, note: menuSeen ? `the editor Download menu offered no ${target} Upscaled entry; the original-quality save ran instead` : 'the editor Download menu did not open; the original-quality save ran instead' });
          try { await page.keyboard.press('Escape'); } catch (e) {}
          return 'unavailable';
        }
        this.log(`[ROOT] editor-enhance picked prompt=${n} "${picked.text}" — Flow is preparing the upscaled file`, 'info');
        task._enhancePickedText = picked.text;
        await page.mouse.click(picked.x, picked.y);
        // Menu band hone ki pushti — khula raha to taze
        // coordinates se dobara click (v2.30.4 sabak),
        // kul 3 koshish.
        for (let t = 1; t < 3; t++) {
          await sleep(900);
          const still = await this._editorEnhanceMenuItems(page);
          if (!still.length) break;
          const again = editorEnhance.pickUpscaledEntry(still, target);
          if (!again) break;
          await page.mouse.click(again.x, again.y);
        }
        task._enhanceDeadline = Date.now() + 180000;
      } else {
        this.log(`[ROOT] editor-enhance prompt=${n} — the previous round's preparation watch is still live; joining its wait without opening the menu again`, 'info');
      }
      // ---- Aamad ka intezaar (deadline tak) ----
      const deadline = task._enhanceDeadline || (Date.now() + 180000);
      const prep = task._enhancePrep;
      while (Date.now() < deadline && !this.isStopping) {
        if (task.mediaSaved) return 'saved-other';
        // (a) NAYI stream ki mukammal body.
        try {
          let entry = null;
          try { entry = cap.harvestForKey(captureKey); } catch (e) { entry = null; }
          if (entry && entry.buffer && entry.buffer.length > 0 && entry.url
              && !(task._enhanceKnownUrls && task._enhanceKnownUrls.has(entry.url))) {
            if (await this._bufferMatchesEnhanceTarget(entry.buffer, target, downloadFolder)) {
              try { cap.evictHarvest(captureKey); } catch (e) {}
              const r = await saveFromEditor(entry.url, entry.buffer);
              if (r === 'saved') {
                const g = gapSec();
                this.log(`[ROOT] via=editor-enhance gap=${g}s quality=${target}`, 'success');
                attempts.push({ strategy: 'editor-enhance', ok: true, note: `the enhanced file ("${task._enhancePickedText || (target + ' Upscaled')}") was captured from the new stream the editor's Download menu produced; render→save gap ${g}s` });
                return 'enhanced';
              }
              this.log(`[ROOT] [Prompt #${n}] editor-enhance: the enhanced stream did not pass the save checks (${task._saveRejectedReason || 'the video verification failed'}) — the original file will be saved instead`, 'warn');
              attempts.push({ strategy: 'editor-enhance', ok: false, note: 'the enhanced stream did not pass the save checks; the original-quality save ran instead' });
              return 'unavailable';
            }
            if (task._enhanceKnownUrls) task._enhanceKnownUrls.add(entry.url);
          }
        } catch (e) {}
        try {
          const rec = typeof cap.recentFlowContentVideos === 'function'
            ? cap.recentFlowContentVideos(task._enhanceClickTime || (Date.now() - 180000)) : [];
          for (const r of (rec || [])) {
            if (!r || !r.url || (task._enhanceKnownUrls && task._enhanceKnownUrls.has(r.url))) continue;
            let held = null;
            try { held = typeof cap.mainpageBodyForUrl === 'function' ? cap.mainpageBodyForUrl(r.url) : null; } catch (e) { held = null; }
            if (!held || !held.buffer || !held.buffer.length) continue;
            if (await this._bufferMatchesEnhanceTarget(held.buffer, target, downloadFolder)) {
              const rr = await saveFromEditor(r.url, held.buffer);
              if (rr === 'saved') {
                const g = gapSec();
                this.log(`[ROOT] via=editor-enhance gap=${g}s quality=${target}`, 'success');
                attempts.push({ strategy: 'editor-enhance', ok: true, note: `the enhanced file ("${task._enhancePickedText || (target + ' Upscaled')}") was captured from the new stream the editor's Download menu produced; render→save gap ${g}s` });
                return 'enhanced';
              }
              attempts.push({ strategy: 'editor-enhance', ok: false, note: 'the enhanced stream did not pass the save checks; the original-quality save ran instead' });
              return 'unavailable';
            }
            if (task._enhanceKnownUrls) task._enhanceKnownUrls.add(r.url);
          }
        } catch (e) {}
        // (b) Browser ki utri file (.flow-native folder).
        if (prep && prep.foldersToWatch) {
          for (const fld of prep.foldersToWatch) {
            let names = [];
            try { names = fs.readdirSync(fld); } catch (e) { names = []; }
            const existing = prep.existingFilesByFolder.get(fld) || new Set();
            for (const name of names) {
              if (existing.has(name)) continue;
              if (name.endsWith('.crdownload') || name.endsWith('.tmp') || name.endsWith('.htm')) continue;
              if (!(name.endsWith('.mp4') || name.endsWith('.webm'))) continue;
              const fullPath = path.join(fld, name);
              if (task._enhanceClaimedFiles && task._enhanceClaimedFiles.has(fullPath)) continue;
              let st = null;
              try { st = fs.statSync(fullPath); } catch (e) { st = null; }
              if (!st || st.size <= 20000) continue;
              if (task._enhanceClickTime && st.mtimeMs < task._enhanceClickTime - 2000) continue;
              // File abhi badh rahi ho to ek poll aur ruko
              // (size ki stability) — aadhi file kabhi nahi.
              const stable = task._enhanceStableFiles || (task._enhanceStableFiles = new Map());
              const prev = stable.get(fullPath);
              if (!prev || prev.size !== st.size) { stable.set(fullPath, { size: st.size }); continue; }
              if (task._enhanceClaimedFiles) task._enhanceClaimedFiles.add(fullPath);
              let dims = null;
              try { dims = await FFmpegService.getVideoDimensions(fullPath); } catch (e) { dims = null; }
              if (!editorEnhance.dimensionsMatchTarget(dims, target)) continue;
              let buf = null;
              try { buf = fs.readFileSync(fullPath); } catch (e) { buf = null; }
              if (!buf || !buf.length) continue;
              const okSave = await this._saveBufferForTask(task, downloadFolder, settings, buf, '', 'editor-enhance');
              // Browser wali copy ab duplicate hai — save
              // hua ho ya gate ne roka ho, hata do (kitab
              // saaf; asal file _saveBufferForTask ne apni
              // jagah likh di hai ya bilkul nahi likhi).
              try { fs.unlinkSync(fullPath); } catch (e) {}
              if (okSave && task.mediaSaved) {
                const g = gapSec();
                this.log(`[ROOT] via=editor-enhance gap=${g}s quality=${target}`, 'success');
                attempts.push({ strategy: 'editor-enhance', ok: true, note: `the enhanced file ("${task._enhancePickedText || (target + ' Upscaled')}") arrived as the browser's own download from the editor's Download menu and was saved through the standard save point; render→save gap ${g}s` });
                return 'enhanced';
              }
              if (task.mediaSaved) return 'saved-other';
              this.log(`[ROOT] [Prompt #${n}] editor-enhance: the enhanced download did not pass the save checks (${task._saveRejectedReason || 'the video verification failed'}) — the original file will be saved instead`, 'warn');
              attempts.push({ strategy: 'editor-enhance', ok: false, note: 'the enhanced browser download did not pass the save checks; the original-quality save ran instead' });
              return 'unavailable';
            }
          }
        }
        await sleep(700);
      }
      if (task.mediaSaved) return 'saved-other';
      this.log(`[ROOT] [Prompt #${n}] editor-enhance: no enhanced file arrived within 180s of the menu pick — the original file will be saved instead`, 'warn');
      attempts.push({ strategy: 'editor-enhance', ok: false, note: 'no enhanced file arrived within the 180s bound; the original-quality save ran instead' });
      return 'unavailable';
    } catch (e) {
      try { this.log(`[ROOT] [Prompt #${n}] editor-enhance hit a problem (${(e && e.message) || e}) — the original file will be saved instead`, 'warn'); } catch (e2) {}
      try { attempts.push({ strategy: 'editor-enhance', ok: false, note: 'the enhance attempt hit a problem; the original-quality save ran instead' }); } catch (e2) {}
      return 'unavailable';
    }
  }

  async _tryEditorHarvest(task, downloadFolder, settings, attempts, captureKey, tileIndexHint) {
    const n = task.promptIndex + 1;
    if (!task || task.mediaSaved) return false;
    const fail = (note) => {
      attempts.push({ strategy: 'editor-harvest', ok: false, note });
      return false;
    };
    const page = this.page;
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
      return fail('the worker browser page is not available, so this video\'s editor could not open — no other download route runs; the task parks for the bounded editor retry rounds / recovery');
    }
    const cap = this.netCapture;
    if (!cap || typeof cap.harvestForKey !== 'function') {
      return fail('the network capture book is not available, so the editor playback stream could not be harvested — no other download route runs; the task parks for the bounded editor retry rounds / recovery');
    }
    let outcome = false;
    let failNote = null;
    try {
      this.log(`[ROOT] editor-harvest start prompt=${n} — opening this video's editor in the worker's live browser (owner decision 2026-11-09)`, 'info');
      let editorOpen = false;
      try { editorOpen = await this._headlessOpenTaskEditor(page, task, tileIndexHint); } catch (e) { editorOpen = false; }
      if (!editorOpen) {
        this.log(`[ROOT] [Prompt #${n}] editor-harvest: this video's editor did not open in the worker browser — no other download route runs; the bounded editor retry rounds / recovery will retry the editor`, 'warn');
        failNote = 'this video\'s editor did not open in the worker browser — no other download route runs; the task parks for the bounded editor retry rounds / recovery';
      } else {
        this.log(`[ROOT] editor-harvest opened prompt=${n} — watching the editor's own playback stream`, 'info');
        let teacherUrl = null;
        try { teacherUrl = this.netCapture ? this.netCapture.teacherMintUrlForTemplate(null) : null; } catch (e) { teacherUrl = null; }
        const gapSec = () => Math.max(0, (Date.now() - (task.renderCompletedAt || task.startTime || Date.now())) / 1000).toFixed(1);
        // v2.48.74 (Item B): enhanced ki koshish haar gayi
        // ho aur ORIGINAL yahan save ho to pehle wo line
        // aati hai — enhanced ka waada jhootha na rahe.
        let enhanceUnavailable = false;
        const win = () => {
          const g = gapSec();
          if (enhanceUnavailable) {
            enhanceUnavailable = false;
            this.log(`[ROOT] editor-enhance unavailable — saved original`, 'warn');
          }
          this.log(`[ROOT] via=editor-harvest gap=${g}s`, 'success');
          attempts.push({ strategy: 'editor-harvest', ok: true, note: `the file was captured from this video's own editor playback stream in the worker's live browser — the editor was opened for this task and the stream was captured, no download button or menu was clicked; render→save gap ${g}s` });
          return true;
        };
        const saveFromEditor = async (url, buffer) => {
          if (teacherUrl && url === teacherUrl) {
            this.log(`[ROOT] [Prompt #${n}] editor-harvest: the captured stream address is the previous task's (teacher) — not saving it`, 'warn');
            return 'teacher';
          }
          try { cap.claimFlowContentVideo(url); } catch (e) {}
          task.completedVideoUrl = url;
          const ok = await this._saveBufferForTask(task, downloadFolder, settings, buffer, url, 'editor-harvest');
          const raceLostEh = !!(task._raceActive && task._raceWonBy && task._raceWonBy !== 'editor-harvest');
          return ((ok || task.mediaSaved) && task._saveRejectedReason !== 'route-race' && !raceLostEh) ? 'saved' : 'rejected';
        };
        const itagOf = (u) => {
          const m = /[?&]itag=(\d+)/.exec(u || '');
          return m ? parseInt(m[1], 10) : 0;
        };
        // Mukammal quality pehle: itag 22 (720p) > 18
        // (360p) > baqi sab.
        const qualityRank = (u) => {
          const t = itagOf(u);
          return t === 22 ? 0 : (t === 18 ? 1 : 2);
        };
        const waitMs = Math.max(1000, this.editorHarvestWaitMs || 120000);
        const deadline = Date.now() + waitMs;
        const triedFetchUrls = new Set();
        // v2.48.74 (scope 3b): jin addresses par
        // chalti capture ka intezaar ho raha hai —
        // har pass me dobara log na ho, is liye kitab.
        const inFlightWaitUrls = new Set();
        let settled = false;
        // v2.48.74 (Item B — ENHANCED DOWNLOAD): download
        // mode 'enhanced' ho to original wale intezaar se
        // PEHLE editor ke Download menu se enhanced file
        // ki koshish. Jeet → yahin khatam (settled). Haar
        // → enhanceUnavailable nishaan ke saath neeche
        // wala original intezaar bilkul waisa hi chalta
        // hai; original save par 'editor-enhance
        // unavailable — saved original' line aati hai.
        // Original mode me ye hissa bilkul nahi chalta —
        // .73 ka vyavhaar hu-bahu.
        if (editorEnhance.downloadModeOf(settings) === 'enhanced' && !task.mediaSaved) {
          const enh = await this._tryEditorEnhance(task, page, downloadFolder, settings, attempts, captureKey, saveFromEditor, gapSec);
          if (enh === 'enhanced') {
            outcome = true;
            settled = true;
          } else if (enh === 'saved-other') {
            this.log(`[ROOT] editor-enhance unavailable — saved original`, 'warn');
            outcome = true;
            settled = true;
          } else {
            enhanceUnavailable = true;
          }
        }
        for (;;) {
          // Kisi aur raste ne (backend candidate handoff)
          // is dauraan save kar diya ho to wahi jeet hai.
          if (task.mediaSaved) { outcome = true; settled = true; break; }
          let entry = null;
          try { entry = cap.harvestForKey(captureKey); } catch (e) { entry = null; }
          if (entry && entry.buffer && entry.buffer.length > 0) {
            try { cap.evictHarvest(captureKey); } catch (e) {}
            const r = await saveFromEditor(entry.url, entry.buffer);
            if (r === 'saved') { outcome = win(); settled = true; break; }
            if (r === 'teacher') {
              failNote = 'the stream captured in this video\'s editor was the previous task\'s file address (teacher) and was not saved — no other download route runs; the task parks for the bounded editor retry rounds / recovery';
              settled = true; break;
            }
            failNote = `the stream captured in this video's editor did not pass the save checks (${task._saveRejectedReason || 'the video verification failed'}) — no other download route runs; the task parks for the bounded editor retry rounds / recovery`;
            settled = true; break;
          }
          const candidates = [];
          try { const b = cap.urlForKey(captureKey); if (b && b.url) candidates.push(b.url); } catch (e) {}
          try {
            const rec = typeof cap.recentFlowContentVideos === 'function' ? cap.recentFlowContentVideos(Date.now() - waitMs - 60000) : [];
            for (const r of (rec || [])) { if (r && r.url && !candidates.includes(r.url)) candidates.push(r.url); }
          } catch (e) {}
          candidates.sort((a, b) => qualityRank(a) - qualityRank(b));
          for (const candUrl of candidates) {
            if (triedFetchUrls.has(candUrl)) continue;
            // v2.48.73 (SPEED B — CAPTURED BUFFER PEHLE):
            // editor page ke andar fetch se pehle kitab
            // dekho — is address ki mukammal body pehle
            // se pakdi ho to wahi save karo (.72 field
            // run me in-page fetch 'Failed to fetch' par
            // ~1.7s zaya hua jabke body capture me
            // maujood thi). In-page fetch sirf tab jab
            // kitab me mukammal body na ho.
            let candBuf = null;
            try {
              const heldEh = (typeof cap.mainpageBodyForUrl === 'function') ? cap.mainpageBodyForUrl(candUrl) : null;
              if (heldEh && heldEh.buffer && heldEh.buffer.length > 0 && downloadFetch.looksLikeVideoBuffer(heldEh.buffer)) candBuf = heldEh.buffer;
            } catch (e) { candBuf = null; }
            if (!candBuf) {
              // v2.48.74 (scope 3b — CHALTI CAPTURE SE
              // MAT LADO): is address ki capture abhi
              // stream ho rahi ho (pending, complete
              // nahi) to in-page fetch SHURU hi mat
              // karo — .73 ke field run me fetch usi
              // waqt chala jab body capture me stream
              // ho rahi thi, 'Failed to fetch' par
              // ~3s zaya hua, aur capture 0.8s baad
              // mukammal hokar save ho gayi. Yahan
              // sirf INTEZAAR hai: URL triedFetchUrls
              // me NAHI dala jata, to agli pass me
              // mukammal capture captured-buffer wale
              // raste se save ho jayegi (isi loop ki
              // deadline ke andar). Fetch sirf tab jab
              // na body ho, na capture chal rahi ho.
              let captureInFlight = false;
              try {
                captureInFlight = (typeof cap.mainpageCaptureInFlight === 'function')
                  ? cap.mainpageCaptureInFlight(candUrl) : false;
              } catch (e) { captureInFlight = false; }
              if (editorEnhance.shouldSkipInPageFetch({ haveBuffer: false, captureInFlight })) {
                if (!inFlightWaitUrls.has(candUrl)) {
                  inFlightWaitUrls.add(candUrl);
                  this.log(`[ROOT] editor-harvest prompt=${n}: this video's stream is still arriving in the capture — waiting for it instead of fetching inside the page`, 'info');
                }
                continue;
              }
              triedFetchUrls.add(candUrl);
              this.log(`[ROOT] editor-harvest fetch prompt=${n} itag=${itagOf(candUrl) || '?'} — full fetch inside the editor page`, 'info');
              const fetched = await this._fetchMainpageFullInPage(candUrl, page);
              if (fetched && fetched.buf && fetched.buf.length > 0 && fetched.status !== 206 && downloadFetch.looksLikeVideoBuffer(fetched.buf)) candBuf = fetched.buf;
            }
            if (candBuf) {
              const r = await saveFromEditor(candUrl, candBuf);
              if (r === 'saved') { outcome = win(); settled = true; break; }
              if (r === 'teacher') {
                failNote = 'the stream captured in this video\'s editor was the previous task\'s file address (teacher) and was not saved — no other download route runs; the task parks for the bounded editor retry rounds / recovery';
                settled = true; break;
              }
              failNote = `the stream captured in this video's editor did not pass the save checks (${task._saveRejectedReason || 'the video verification failed'}) — no other download route runs; the task parks for the bounded editor retry rounds / recovery`;
              settled = true; break;
            }
          }
          if (settled) break;
          if (Date.now() >= deadline || this.isStopping) break;
          await sleep(300);
        }
        if (!settled && !task.mediaSaved) {
          this.log(`[ROOT] [Prompt #${n}] editor-harvest: no complete editor stream arrived in the worker browser within ${Math.round(waitMs / 1000)}s — no other download route runs; the bounded editor retry rounds / recovery will retry the editor`, 'warn');
          failNote = 'the editor opened, but its playback stream did not complete in the worker browser in time — no other download route runs; the task parks for the bounded editor retry rounds / recovery';
        }
        if (enhanceUnavailable && task.mediaSaved) {
          // Backend handoff ne is dauraan original save
          // kar diya — enhanced haar ki line yahan bhi
          // lazmi hai (win() wale raste se na aayi ho to).
          enhanceUnavailable = false;
          this.log(`[ROOT] editor-enhance unavailable — saved original`, 'warn');
        }
        if (task.mediaSaved && !outcome) outcome = true;
      }
    } catch (e) {
      failNote = 'the editor harvest hit a problem — no other download route runs; the task parks for the bounded editor retry rounds / recovery';
    } finally {
      // Har surat me page wapas project grid par — agli
      // task/run ki haalat saaf. Wapsi nakam ho to line
      // darj karo, run mat roko.
      let back = false;
      try { back = await this._returnToProjectGrid(); } catch (e) { back = false; }
      if (!back) {
        try {
          const u = (page && page.url ? (page.url() || '') : '');
          const m = u.match(/(https:\/\/flow\.google\.com\/project\/[^/]+)/);
          if (m && typeof page.goto === 'function') {
            await page.goto(m[1], { waitUntil: 'domcontentloaded', timeout: 30000 });
            back = true;
          }
        } catch (e) { back = false; }
      }
      if (!back) {
        this.log(`[ROOT] editor-harvest return-failed prompt=${n} — the project grid could not be restored after the editor attempt; continuing`, 'warn');
      }
    }
    if (!outcome && failNote) return fail(failNote);
    return outcome;
  }

  /**
   * v2.48.41 (MAIN-PAGE HARVEST PACK — OWNER ORDER
   * 2026-11-04): VIDEO download ka PEHLA aur asal rasta.
   * Download SIRF usi project/grid page se hota hai jis
   * par video bani hai — editor kahin bhi nahi khulta
   * (na main tab, na dusra tab, na background page), koi
   * button/menu click nahi hota.
   *
   * v2.48.42 (MAIN-PAGE BINDING PACK): ZEROCLICK9 ne
   * sabit kiya ke streams main page par aate hain —
   * rukawat BANDHAN tha (do unbound stream, koi bandha
   * nahi, engine ne durust inkaar kiya). Ab bandhan
   * QAAIDE se hota hai (saveGuard.mainpageBindingPlan +
   * capture ki khidki/claim kitab):
   *   (a) kitab me is task ke naam pehle se MUKAMMAL
   *       body ho to wohi save (_tryHarvestSave);
   *   (b) tile ki apni <video> alamat ki audit — grid par
   *       is task ki tile me <video> hai kya, us ka src
   *       kis host ka hai ('[ROOT] mainpage-audit …
   *       reason=tile-video-src'); tile-src / urlByKey
   *       wale MAZBOOT bandhe hue ummeedwaar pehle;
   *   (c) BINDING PLAN — v2.48.43 me TARTEEB
   *       (ORDER): ummeedwaaron ki kataar pehli-nazar
   *       + capture tartib se, baqi downloads ki
   *       kataar render-complete ki tartib se; meri
   *       jodi kataar me meri jagah wala ummeedwaar
   *       hai (order); akela bacha unclaimed + akela
   *       baqi download = exclusion (purana fallback);
   *       meri jodi par ASAL bandh-ganth (ek hi pal,
   *       capture tartib bhi alag na kar sake) =
   *       AMBIGUOUS inkaar (koi fetch nahi — ghalat
   *       video miss se bura hai, ZEROCLICK2 sabak).
   *       Ummeedwaar wahi hai jo capture ke darwaze
   *       (kul size >= 500,000, warna video-type) se
   *       guzra ho;
   *   (d) koi bandhne wala na ho to HOVER + PATIENCE
   *       WATCH: tile scrollIntoView se nazar me
   *       (level=scroll), waqt par synthetic mouse
   *       ishare (level=synthetic), phir asal pointer
   *       tile par roke hue (level=pointer) — aur
   *       intezaar render-complete se
   *       mainpagePatienceMs (~60s) tak; intezaar me
   *       bandha stream 'viewport-trigger' kehlata
   *       hai. Kuch khulta nahi, click kabhi nahi —
   *       hover hi wahid naya ishara hai;
   *   (e) bandha ummeedwaar
   *       _mainpageCompleteCandidate se mukammal hota
   *       hai (kitab body ya usi page ke andar poora
   *       fetch; saveGuard darwaze barkarar).
   * Jeet par: '[ROOT] via=mainpage-harvest gap=<X>s' +
   * mainpage-audit 'promoted' line (bindReason +
   * claimedBy ke saath). Kuch na mile to false —
   * attempt EMAANDARI se aage badhta hai (grid-replay),
   * aur wahan bhi na bane to FAIL. Prompt yahan KABHI
   * dobara submit nahi hota.
   */
  /**
   * v2.48.56 (STATE-PROBE): is task ki apni tile ke
   * ANDAR ki haalaat parho — DOM attributes, media
   * element properties, aur framework state (React
   * props/fiber, Angular context) — aur jo bhi
   * googlevideo pate milen, unhe un ke zariye (source)
   * ke saath lautao. SIRF parhna hai: koi click nahi,
   * koi play nahi, kuch khulta nahi; har cheez
   * had-bandi (nodes/depth/budget) ke andar.
   * ZEROCLICK24 ka sabak: page aksar tile ke liye
   * full stream network par bhejti hi nahi — lekin
   * tile ki apni state me us ka pata ho sakta hai.
   * Lautta hai: [{url, source}] (zyada se zyada 40).
   */
  async _probeTileStateUrls(task, tileIndexHint) {
    const pg = this.page;
    if (!pg || pg.isClosed() || typeof pg.evaluate !== 'function') return [];
    const idx = await this._resolveTileIndexForTask(task, tileIndexHint);
    if (!Number.isInteger(idx) || idx < 0) return [];
    let found = [];
    try {
      found = await pg.evaluate((i) => {
        const out = [];
        const seenUrl = new Set();
        const push = (s, source) => {
          try {
            if (typeof s !== 'string' || !s) return;
            const m = s.match(/https?:\/\/[^\s"'<>\\]+googlevideo\.com\/videoplayback[^\s"'<>\\]*/g);
            if (!m) return;
            for (const u of m) {
              if (seenUrl.has(u)) continue;
              seenUrl.add(u);
              if (out.length < 40) out.push({ url: u, source });
            }
          } catch (e) {}
        };
        try {
          const tiles = document.querySelectorAll('flow-grid-tile-container');
          const tile = tiles && tiles[i];
          if (!tile) return out;
          const els = [tile];
          try { const all = tile.querySelectorAll('*'); for (let k = 0; k < all.length && k < 600; k++) els.push(all[k]); } catch (e) {}
          for (const el of els) {
            try {
              if (el.getAttribute) {
                for (const a of ['src', 'href', 'poster', 'data-src', 'data-url']) {
                  const v = el.getAttribute(a);
                  if (v) push(v, 'dom');
                }
              }
              if (el.dataset) { for (const dk of Object.keys(el.dataset)) push(el.dataset[dk], 'dom'); }
              if (el.currentSrc) push(el.currentSrc, 'dom');
              if ((el.tagName === 'VIDEO' || el.tagName === 'IMG' || el.tagName === 'SOURCE') && el.src) push(el.src, 'dom');
            } catch (e) {}
          }
          const SKIP = { stateNode: 1, _owner: 1, _debugOwner: 1, return: 1, alternate: 1, nextEffect: 1, firstEffect: 1, lastEffect: 1 };
          const visited = new Set();
          let budget = 6000;
          const visit = (obj, depth, source) => {
            if (budget-- <= 0 || depth > 6 || obj === null || obj === undefined) return;
            const t = typeof obj;
            if (t === 'string') { push(obj, source); return; }
            if (t !== 'object') return;
            if (visited.has(obj)) return;
            visited.add(obj);
            try { if (obj.nodeType) return; } catch (e) {}
            try {
              const keys = Object.keys(obj);
              for (const k of keys) {
                if (SKIP[k]) continue;
                let v; try { v = obj[k]; } catch (e) { continue; }
                visit(v, depth + 1, source);
                if (budget <= 0) return;
              }
            } catch (e) {}
          };
          for (const el of els.slice(0, 80)) {
            try {
              const keys = Object.keys(el);
              for (const k of keys) {
                if (k.indexOf('__reactProps$') === 0 || k.indexOf('__reactInternalInstance$') === 0) visit(el[k], 0, 'props');
                else if (k.indexOf('__reactFiber$') === 0) visit(el[k], 0, 'fiber');
                else if (k.indexOf('__ngContext__') === 0) visit(el[k], 0, 'ng');
              }
            } catch (e) {}
          }
          return out;
        } catch (e) { return out; }
      }, idx);
    } catch (e) { found = []; }
    return Array.isArray(found) ? found : [];
  }

  async _tryMainpageHarvest(task, downloadFolder, settings, attempts, captureKey, tileIndexHint) {
    const n = task.promptIndex + 1;
    const cap = this.netCapture;
    if (!cap || !task || task.mediaSaved) return false;
    if (typeof cap.mainpageEntries !== 'function') return false;
    const floorBytes = cap.harvestFloorBytes || downloadFetch.minBytesForDuration(settings && settings.duration);
    const gapSec = () => Math.max(0, (Date.now() - (task.renderCompletedAt || task.startTime || Date.now())) / 1000).toFixed(1);
    const timingBucket = () => (typeof cap._mainpageTimingBucket === 'function' ? cap._mainpageTimingBucket() : 'download-attempt');
    const attemptStart = Date.now();
    const windowStart = (Number.isFinite(task.renderCompletedAt) && task.renderCompletedAt > 0)
      ? task.renderCompletedAt : attemptStart;
    // Meri khidki darj karo — render-watch ne pehle hi
    // darj ki ho to sab se pehla aaghaz barkarar rehta
    // hai; retry round khidki aage nahi dhakelta.
    try { if (typeof cap.mainpageNoteWindow === 'function') cap.mainpageNoteWindow(captureKey, windowStart); } catch (e) {}
    let teacherUrl = null;
    try { teacherUrl = cap.teacherMintUrlForTemplate(null); } catch (e) { teacherUrl = null; }
    let teacherHash = null;
    // (b) tile alamat ki audit — sirf ek dafa.
    let tileSrcUrl = null;
    let tileSrcKind = null;
    try {
      const st = await this._readTileMediaState(task, tileIndexHint);
      // v2.48.63 (Item D): tile-media wali line ab HAR
      // attempt ki is pehli reading par yahin se nikalti
      // hai — .62 wali line ready-poll loop ke andar thi
      // (backend link pehle bandh jaye to loop pehli
      // reading se pehle hi toot jata tha; ZC30 ke log
      // me line bilkul ghayab rahi). Shakal purani wali
      // hi hai; <video> na ho to har cheez '-'.
      try {
        const dw = st && st.videoWidth != null ? st.videoWidth : '-';
        const dh = st && st.videoHeight != null ? st.videoHeight : '-';
        const dd = st && st.duration != null ? st.duration : '-';
        const dr = st && st.readyState != null ? st.readyState : '-';
        this.log(`[ROOT] tile-media dims=${dw}x${dh} dur=${dd} ready=${dr}`, 'info');
      } catch (e) {}
      const raw = st && st.url ? st.url : null;
      if (raw && flowContent.isFlowContentVideoUrl(raw)) { tileSrcKind = 'flow-content'; tileSrcUrl = raw; }
      else if (raw && networkCapture.isGooglevideoPlaybackUrl(raw)) { tileSrcKind = 'googlevideo'; tileSrcUrl = raw; }
      const audit = tileSrcUrl
        ? saveGuard.mainpageAuditOf({ host: networkCapture.hostOf(tileSrcUrl), bytes: 0, src: tileSrcKind, decision: 'captured', reason: 'tile-video-src', bindReason: 'none', claimedBy: 'none' })
        : saveGuard.mainpageAuditOf({ host: 'none', bytes: 0, src: 'none', decision: 'ignored', reason: raw ? 'tile-src-not-video-stream' : 'no-tile-video', bindReason: 'none', claimedBy: 'none' });
      this.log(`[ROOT] mainpage-audit ${saveGuard.formatMainpageAudit(audit)} timing=${timingBucket()}`, 'info');
    } catch (e) {}
    const triedUrls = new Set();
    const failOut = () => {
      // v2.48.50 (item 7): race me dusra rasta jeet
      // chuka ho to ye haar ki line/note jhooti hogi —
      // khamoshi se jeet ki wapsi.
      if (task.mediaSaved) return true;
      attempts.push({ strategy: 'mainpage-harvest', ok: false, note: 'no usable stream for this video was seen on the main project page (see the mainpage-audit lines) — no further route runs in the current download order; nothing was opened or clicked' });
      this.log(`[ROOT] [Prompt #${n}] mainpage-harvest: no usable stream for this video on the main project page — no further route runs in the current download order`, 'warn');
      return false;
    };
    // v2.48.45 (BINDCHECK — ZEROCLICK12 addendum):
    // poori-size (>= is duration ki hadd) stream bandhan
    // ke liye parkha jaye aur bandhe NAHI to ek
    // diagnostic line — kis darwaze par ruka, wajah ke
    // saath. ZEROCLICK12 #1: 1,225,554B ki stream apni
    // hi hover watch me aayi, kitab me 'captured' darj
    // hui, phir bhi kabhi bandhi nahi aur wajah kahin
    // record nahi hui — agli live run me ye line asal
    // wajah NAAM se degi. Ek attempt me ek URL+wajah
    // ki jodi sirf ek dafa (watch har 250ms plan
    // dobara banata hai — line baadh nahi banegi).
    // Ye SIRF mushahida hai — bandhan ka vyavhaar
    // bilkul nahi badalta.
    const bindcheckSeen = new Set();
    const logBindcheck = (info) => {
      try {
        if (!info || !info.url || !info.why) return;
        const total = Math.max(0, Math.floor(info.total || 0));
        if (total < floorBytes) return;
        const dedupeKey = `${info.url}|${info.why}`;
        if (bindcheckSeen.has(dedupeKey)) return;
        bindcheckSeen.add(dedupeKey);
        const firstSeen = Number.isFinite(info.firstSeenAt) ? Math.floor(info.firstSeenAt) : 0;
        this.log(`[ROOT] mainpage-bindcheck total=${total} firstSeen=${firstSeen} renderDone=${Math.floor(windowStart)} decision=${info.decision || 'unbound'} why=${info.why}`, 'info');
      } catch (e) {}
    };
    const entryTotal = (e) => Math.max(e.bytes || 0, e.declared || 0, e.knownTotal || 0);
    // Ummeedwaar ikatthe karo — kitab se (teacher /
    // claimed / doosri task ke naam hue / pehle aazmaye
    // hue bahar) + tile-src wala mazboot ummeedwaar.
    const buildCandidates = () => {
      let boundUrl = null;
      try {
        const b = cap.urlForKey(captureKey);
        if (b && b.url) boundUrl = b.url;
      } catch (e) {}
      const annotated = [];
      const seenUrls = new Set();
      // v2.48.50 (item 9): tile ki apni stream (ya
      // render-time pre-bound stream) ke liye fetch ke
      // tried-zeher se chhoot — sirf tab jab pichhla
      // completion nateeja 'no-body' raha ho aur is
      // attempt ke element-drive cycles baqi hon.
      // Fetch ke apne usool bilkul nahi badalte; ye
      // sirf ELEMENT-drive wale raste ko dobara mauqa
      // deta hai.
      const tileTriedExempt = (url) => {
        if (!url) return false;
        const isTileEntry = (!!tileSrcUrl && url === tileSrcUrl)
          || (!!task._preboundMainpageUrl && url === task._preboundMainpageUrl);
        return isTileEntry
          && lastOutcomeByUrl.get(url) === 'no-body'
          && (task._mpCompleteCycles || 0) < 4;
      };
      const pushEntry = (e, bound) => {
        if (!e || !e.url || seenUrls.has(e.url)) return;
        if (triedUrls.has(e.url) && !tileTriedExempt(e.url)) return;
        seenUrls.add(e.url);
        annotated.push({
          url: e.url,
          src: e.src || 'flow-content',
          byteLength: Math.max(e.bytes || 0, e.bodyBytes || 0),
          headerOk: true,
          partial: e.partial !== false && e.src === 'googlevideo' ? true : !!e.partial,
          status: e.status || 0,
          contentRange: e.contentRange || '',
          declaredLength: e.declared || 0,
          // v2.48.52 (gate fix): capture ka maloom kul
          // size bhi entry ke saath — completion ka
          // partial faisla isi par hoga.
          knownTotal: Number.isFinite(e.knownTotal) ? e.knownTotal : null,
          duplicate: false,
          hash: null,
          teacherHash,
          bound: !!bound,
          bodyBytes: e.bodyBytes || 0,
          at: e.at || 0,
          firstSeenAt: Number.isFinite(e.firstSeenAt) ? e.firstSeenAt : (e.at || 0),
          seq: Number.isFinite(e.seq) ? e.seq : null,
          claimedBy: e.claimedBy || null
        });
      };
      for (const e of cap.mainpageEntries()) {
        if (!e || !e.url) continue;
        // v2.48.43: ummeedwaar darwaze se bahar wali
        // entry (chhoti stream / video-type na ho)
        // bandhan ke liye kabhi nahi uth ti.
        if (e.candidate === false) continue;
        // v2.48.45 (BINDCHECK): poori-size stream jo
        // kisi darwaze par ruke — wajah line me darj
        // (vyavhaar wahi; sirf naam milta hai).
        if (teacherUrl && e.url === teacherUrl) {
          logBindcheck({ url: e.url, total: entryTotal(e), firstSeenAt: e.firstSeenAt, why: 'teacher-url' });
          continue;
        }
        let claimed = false;
        try { claimed = cap.isMainpageClaimed(e.url); } catch (err) { claimed = false; }
        if (claimed) {
          logBindcheck({ url: e.url, total: entryTotal(e), firstSeenAt: e.firstSeenAt, why: 'already-claimed' });
          continue;
        }
        if (this._urlClaimedByOtherTask(e.url, captureKey)) {
          logBindcheck({ url: e.url, total: entryTotal(e), firstSeenAt: e.firstSeenAt, why: 'claimed-by-other-task' });
          continue;
        }
        if (triedUrls.has(e.url) && !tileTriedExempt(e.url)) {
          logBindcheck({ url: e.url, total: entryTotal(e), firstSeenAt: e.firstSeenAt, why: 'already-tried-this-attempt' });
          continue;
        }
        const isBound = !!boundUrl && e.url === boundUrl;
        // v2.48.50 (item 5): render ke dauraan pehle se
        // bandha (pre-bound) ummeedwaar bhi tile jaisa
        // mazboot hai — completion usi par foran shuru
        // hota hai, nayi hover watch ka intezaar nahi.
        const isTile = (!!tileSrcUrl && e.url === tileSrcUrl)
          || (!!task._preboundMainpageUrl && e.url === task._preboundMainpageUrl);
        if (!isBound && !isTile) {
          // timing bandish: meri PEHLI nazar mere render
          // se pehle ki hai to ye stream mera nahi ho
          // sakta (kisi aur ki khidki ka hai ya purana).
          const seenAt = Number.isFinite(e.firstSeenAt) ? e.firstSeenAt : (e.at || 0);
          if ((task.startTime || 0) > 0 && seenAt > 0 && seenAt < task.startTime) {
            logBindcheck({ url: e.url, total: entryTotal(e), firstSeenAt: seenAt, why: 'seen-before-task-start' });
            continue;
          }
        }
        pushEntry(e, isBound || isTile);
      }
      if (tileSrcUrl && !seenUrls.has(tileSrcUrl) && !triedUrls.has(tileSrcUrl)
        && !(teacherUrl && tileSrcUrl === teacherUrl)) {
        // tile ke src ki kitab me entry na ho to bhi wo
        // ummeedwaar hai — bandish tile khud hai.
        pushEntry({
          url: tileSrcUrl, src: tileSrcKind, bytes: 0, bodyBytes: 0,
          status: 0, contentRange: '', declared: 0, partial: true,
          at: Date.now(), firstSeenAt: Date.now()
        }, true);
      }
      return annotated;
    };
    const completeWith = (entry, bindReason) => this._mainpageCompleteCandidate(
      task, downloadFolder, settings, attempts, entry,
      // v2.48.50 (item 1): tileIndexHint completion tak
      // jata hai — media-load tile element wahi se
      // dhoondta hai.
      { captureKey, bindReason, floorBytes, teacherUrl, teacherHash, timingBucket, gapSec, tileIndexHint }
    );
    // v2.48.46 (TRIED-URLS POISONING FIX — ZEROCLICK13):
    // pehle har bandha URL completion se PEHLE
    // triedUrls me daal diya jata tha aur 'no-body'
    // nakami par wahan ZEHER ban kar reh jata tha —
    // wahi mukammal-size stream (jo plan ne durust
    // bandha tha) poori koshish ke liye bahar ho jati
    // thi ('already-tried-this-attempt'). Ab hisaab
    // completionTries me rehta hai: 'no-body' par URL
    // triedUrls se NIKAL jata hai taaki watch use ek
    // dafa aur parkh sake; dusri 'no-body' par (ginti
    // 2) triedUrls me rehta hai. 'rejected' / 'saved'
    // par purana vyavhaar hi hai.
    const completionTries = new Map();
    // v2.48.50 (item 9): har URL ka pichhla completion
    // nateeja — tile-element ki tried-list chhoot isi
    // par bandhi hai (sirf 'no-body' ke baad).
    const lastOutcomeByUrl = new Map();
    const completeTracked = async (entry, bindReason) => {
      triedUrls.add(entry.url);
      const count = (completionTries.get(entry.url) || 0) + 1;
      completionTries.set(entry.url, count);
      // v2.48.50 (item 4): completion cycles ab 2 ki
      // jagah 4 — dobara koshish se pehle ~1.5s ka
      // waqfa (stream ko aane ka waqt bhi, aur cycles
      // ki spacing bhi). Pehli koshish par koi waqfa
      // nahi.
      if (count >= 2) await sleep(1500);
      const outcome = await completeWith(entry, bindReason);
      lastOutcomeByUrl.set(entry.url, outcome);
      if (outcome === 'no-body' && count < 4) triedUrls.delete(entry.url);
      return outcome;
    };
    // Binding plan ek dafa chalao (maujooda kitab par):
    // 'saved' | 'ambiguous' | 'none'. v2.48.43: plan
    // ab TARTEEB par hai (saveGuard.mainpageBindingPlan)
    // — ummeedwaaron ki kataar pehli-nazar + capture
    // tartib se, baqi downloads ki kataar render-
    // complete ki tartib se. opts.watchStart diya ho
    // to us pal ke BAAD pehli baar dikha stream bandhe
    // to wajah 'viewport-trigger' kehlata hai (wo
    // MERE hover intezaar me aaya — jodi meri hi hai).
    const tryBindingPlan = async (opts) => {
      const live = buildCandidates().filter(a => !a.bound);
      if (live.length === 0) return 'none';
      const pendingOrder = typeof cap.mainpagePendingOrder === 'function'
        ? cap.mainpagePendingOrder()
        : (typeof cap.mainpageWindowsList === 'function'
          ? cap.mainpageWindowsList().filter(w => !w.done).map(w => ({ key: w.key, start: w.start }))
          : []);
      const pendingOthers = typeof cap.mainpagePendingOthers === 'function' ? cap.mainpagePendingOthers(captureKey) : 0;
      const plan = saveGuard.mainpageBindingPlan({
        candidates: live.map(a => ({ url: a.url, firstSeenAt: a.firstSeenAt, seq: a.seq })),
        ownKey: captureKey,
        ownStart: windowStart,
        pendingOrder,
        pendingOthers
      });
      // v2.48.45 (BINDCHECK): plan ne jo poori-size
      // ummeedwaar NAHI bandha, us ki wajah naam se —
      // kataar me us ki jagah (plan wali hi tartib:
      // firstSeenAt, phir seq) aur meri jagah (myIdx)
      // ke muqable se. Bandha hua ummeedwaar is hisse
      // ko chhuta hi nahi.
      try {
        const sorted = live.slice().sort((a, b) => {
          if (a.firstSeenAt !== b.firstSeenAt) return a.firstSeenAt - b.firstSeenAt;
          const sa = Number.isFinite(a.seq) ? a.seq : null;
          const sb = Number.isFinite(b.seq) ? b.seq : null;
          if (sa !== null && sb !== null) return sa - sb;
          return 0;
        });
        sorted.forEach((a, pos) => {
          const total = Math.max(a.byteLength || 0, a.declaredLength || 0);
          if (plan.bind && plan.url === a.url) return;
          let why = null;
          let decision = 'unbound';
          if (plan.reason === 'ambiguous') { why = 'ambiguous-tie'; decision = 'refused'; }
          else if (plan.bind) why = 'ordinal-pair-was-another-stream';
          else if (Number.isFinite(plan.myIdx) && pos < plan.myIdx) why = 'reserved-for-earlier-pending';
          else if (pendingOthers > 0) why = 'exclusion-blocked-by-pending-download';
          else why = 'no-pair-at-my-position';
          if (why) logBindcheck({ url: a.url, total, firstSeenAt: a.firstSeenAt, decision, why });
        });
      } catch (e) {}
      if (plan.reason === 'ambiguous') {
        this.log(`[ROOT] [Prompt #${n}] mainpage-harvest: ${plan.count} unbound streams seen on the main page and none is bound to this video — not fetching any of them (a wrong video is worse than a miss)`, 'warn');
        return 'ambiguous';
      }
      if (plan.bind && plan.url) {
        const entry = live.find(a => a.url === plan.url);
        if (entry) {
          let bindReason = plan.reason;
          if (opts && Number.isFinite(opts.watchStart) && entry.firstSeenAt >= opts.watchStart) {
            bindReason = 'viewport-trigger';
          }
          const outcome = await completeTracked(entry, bindReason);
          if (outcome === 'saved' || task.mediaSaved) return 'saved';
        }
      }
      return 'none';
    };
    if (this.isStopping) return false;
    // (a) mukammal bandhi hui body — sab se tez jeet.
    try {
      const okBody = await this._tryHarvestSave(task, downloadFolder, settings, attempts);
      if (okBody || task.mediaSaved) return true;
    } catch (e) {}
    // (b) mazboot bandhe hue (urlByKey / tile-src) pehle.
    {
      const strong = buildCandidates().filter(a => a.bound);
      if (strong.length > 0) {
        const pickRes = saveGuard.mainpageEntryPick({ entries: strong, teacherUrl, floorBytes });
        if (pickRes.pick && pickRes.url) {
          const entry = strong[pickRes.index];
          const outcome = await completeTracked(entry, 'bound');
          if (outcome === 'saved' || task.mediaSaved) return true;
        }
      }
    }
    // (c) binding plan — first-appearance / exclusion.
    {
      const r = await tryBindingPlan();
      if (r === 'saved') return true;
      if (r === 'ambiguous') return failOut();
    }
    // (d) HOVER + PATIENCE WATCH (v2.48.43) —
    // ZEROCLICK10 ka saboot: sirf scroll se Flow ka
    // grid preview loader 9s me NAHI jaagta; streams
    // render ke ~15–45s baad apni marzi se aate hain.
    // Ab koshish SABR ke saath chalti hai: tile nazar
    // me (level=scroll), phir synthetic mouse ishare
    // (level=synthetic), phir asal pointer tile par
    // roke hue (level=pointer) — aur poora intezaar
    // render-complete se mainpagePatienceMs tak.
    // Intezaar ke dauraan har pal plan dobara banta
    // hai; MERI jodi wala ummeedwaar dikhte hi foran
    // bandhta hai (mere intezaar me pehli baar dikha
    // ho to wajah 'viewport-trigger', warna plan ki
    // 'order'/'exclusion'). Kuch khulta nahi, click
    // kabhi nahi hota — hover hi wahid naya ishara
    // hai.
    const patienceMs = Number.isFinite(this.mainpagePatienceMs) && this.mainpagePatienceMs > 0
      ? this.mainpagePatienceMs : 60000;
    const floorMs = Number.isFinite(this.mainpageViewportWaitMs) && this.mainpageViewportWaitMs > 0
      ? this.mainpageViewportWaitMs : 9000;
    const hoverGraceMs = Number.isFinite(this.mainpageHoverGraceMs) && this.mainpageHoverGraceMs > 0
      ? this.mainpageHoverGraceMs : 4000;
    const pointerGraceMs = Number.isFinite(this.mainpagePointerGraceMs) && this.mainpagePointerGraceMs > 0
      ? this.mainpagePointerGraceMs : 4000;
    const watchStart = Date.now();
    let watchDeadline = windowStart + patienceMs;
    if (watchDeadline < watchStart + floorMs) watchDeadline = watchStart + floorMs;
    // v2.48.53 (CLEAN HOVER-EXIT): is task ki watch
    // se pehle pichhli tile se saaf exit (pause +
    // pointer bahar + saans) — §5.5 rank 2.
    // v2.48.54 (RPC-BODY FEED — bandha hua helper):
    // .53 me ye mauqa sirf hover watch ke BAAD milta
    // tha; ab wahi mauqa watch se PEHLE bhi ek dafa
    // milta hai — batchexecute jawab me pata pehle se
    // maujood ho to UI trigger ka intezaar hi khatam.
    // Shartein bilkul wahi sakht hain (saveGuard.
    // mainpageRpcBodyPick): khidki + akela ummeedwaar
    // + koi aur pending download nahi + claimed/tried/
    // teacher na ho; shart tootne par sirf 'skipped'
    // line. Lautta hai: true (save ho gaya) | false.
    const tryRpcFeed = async (deadline) => {
      try {
        const rpcSightings = typeof cap.mainpageRpcBodySightings === 'function'
          ? cap.mainpageRpcBodySightings() : [];
        if (rpcSightings.length && !this.isStopping && !task.mediaSaved) {
          const pendingOthersRpc = typeof cap.mainpagePendingOthers === 'function'
            ? cap.mainpagePendingOthers(captureKey) : 0;
          // v2.48.54 (fix 1 ka dusra hissa): jo pate
          // pehle hi kisi task ke naam claimed hain wo
          // ummeedwaar hi nahi — pick ko un ki fehrist
          // bhi do (claim par kitab me consumed darj
          // hona is ke saath dusri hifazat hai).
          const claimedUrls = new Set();
          try {
            if (typeof cap.isMainpageClaimed === 'function') {
              for (const sg of rpcSightings) {
                if (sg && sg.url && cap.isMainpageClaimed(sg.url)) claimedUrls.add(sg.url);
              }
            }
          } catch (e) {}
          const rpcPick = saveGuard.mainpageRpcBodyPick({
            sightings: rpcSightings,
            triedUrls,
            claimedUrls,
            teacherUrl,
            renderDoneAt: Number.isFinite(task.renderCompletedAt) ? task.renderCompletedAt : null,
            attemptDeadline: deadline,
            pendingOthers: pendingOthersRpc
          });
          if (rpcPick && rpcPick.skip) {
            this.log(`[ROOT] [Prompt #${n}] mainpage-rpcfeed skipped reason=${rpcPick.skip}`, 'warn');
            return false;
          }
          if (rpcPick && rpcPick.url) {
            try { if (typeof cap.mainpageMarkRpcBodyConsumed === 'function') cap.mainpageMarkRpcBodyConsumed(rpcPick.url, captureKey || task.captureKey || task.videoId || null); } catch (e) {}
            this.log(`[ROOT] [Prompt #${n}] mainpage-rpcfeed host=${networkCapture.hostOf(rpcPick.url) || ''} clen=${rpcPick.clen}`, 'info');
            const rpcRes = await this._netloadMainpageFull(task, rpcPick.url);
            if (rpcRes && rpcRes.buf && !task.mediaSaved) {
              const rpcEntry = {
                url: rpcPick.url,
                src: 'googlevideo',
                byteLength: rpcRes.buf.length,
                headerOk: true,
                partial: true,
                status: rpcRes.status || 0,
                contentRange: '',
                declaredLength: 0,
                knownTotal: rpcPick.clen,
                duplicate: false,
                hash: null,
                teacherHash,
                bound: true,
                bodyBytes: rpcRes.buf.length,
                at: Date.now(),
                firstSeenAt: rpcPick.firstSeenAt,
                seq: null,
                claimedBy: null,
                _netloadBody: rpcRes.buf,
                _netloadMeta: rpcRes,
                _noInPageFetch: true
              };
              const rpcOutcome = await completeTracked(rpcEntry, 'rpc-body-netload');
              if (rpcOutcome === 'saved' || task.mediaSaved) return true;
            }
          }
        }
      } catch (e) {}
      return false;
    };
    // v2.48.56 (STATE-PROBE): rpcfeed ka behen-qadam —
    // pata kitab se nahi, is task ki APNI TILE ke andar
    // ki haalaat se. Bandhan tile par hai (waqt par
    // nahi), is liye pendingOthers bandish nahi; baaki
    // sakhti saveGuard.mainpageStateProbePick me hai.
    const tryStateProbe = async () => {
      try {
        if (this.isStopping || task.mediaSaved || !this.page) return false;
        const rawProbe = await this._probeTileStateUrls(task, tileIndexHint);
        if (!rawProbe || !rawProbe.length) {
          this.log(`[ROOT] [Prompt #${n}] mainpage-stateprobe found=0 full=0`, 'info');
          return false;
        }
        const probeCands = [];
        const srcCount = {};
        for (const r of rawProbe) {
          if (!r || typeof r.url !== 'string') continue;
          const info = networkCapture.rpcVideoUrlInfo(r.url);
          if (!info) continue;
          const src = typeof r.source === 'string' && r.source ? r.source : 'dom';
          srcCount[src] = (srcCount[src] || 0) + 1;
          probeCands.push({ url: r.url, clen: info.clen, itag: info.itag, source: src });
        }
        const probeFull = probeCands.filter(c => c.clen >= 500000);
        const srcStr = Object.keys(srcCount).map(k => `${k}:${srcCount[k]}`).join(',');
        this.log(`[ROOT] [Prompt #${n}] mainpage-stateprobe found=${probeCands.length} full=${probeFull.length} sources=${srcStr || '-'}`, 'info');
        if (!probeFull.length) return false;
        const claimedUrlsProbe = new Set();
        try {
          if (typeof cap.isMainpageClaimed === 'function') {
            for (const c of probeCands) { if (cap.isMainpageClaimed(c.url)) claimedUrlsProbe.add(c.url); }
          }
        } catch (e) {}
        const probePick = saveGuard.mainpageStateProbePick({
          candidates: probeFull,
          triedUrls,
          claimedUrls: claimedUrlsProbe,
          teacherUrl
        });
        if (probePick && probePick.skip) {
          this.log(`[ROOT] [Prompt #${n}] mainpage-statefeed skipped reason=${probePick.skip}`, 'warn');
          return false;
        }
        if (probePick && probePick.url) {
          try { if (typeof cap.claimMainpageVideo === 'function') cap.claimMainpageVideo(probePick.url, { key: captureKey }); } catch (e) {}
          this.log(`[ROOT] [Prompt #${n}] mainpage-statefeed host=${networkCapture.hostOf(probePick.url) || ''} clen=${probePick.clen} source=${probePick.source}`, 'info');
          const probeRes = await this._netloadMainpageFull(task, probePick.url);
          try { triedUrls.add(probePick.url); } catch (e) {}
          if (probeRes && probeRes.buf && !task.mediaSaved) {
            const probeEntry = {
              url: probePick.url,
              src: 'googlevideo',
              byteLength: probeRes.buf.length,
              headerOk: true,
              partial: true,
              status: probeRes.status || 0,
              contentRange: '',
              declaredLength: 0,
              knownTotal: probePick.clen,
              duplicate: false,
              hash: null,
              teacherHash,
              bound: true,
              bodyBytes: probeRes.buf.length,
              at: Date.now(),
              firstSeenAt: Date.now(),
              seq: null,
              claimedBy: null,
              _netloadBody: probeRes.buf,
              _netloadMeta: probeRes,
              _noInPageFetch: true
            };
            const probeOutcome = await completeTracked(probeEntry, 'state-probe-netload');
            if (probeOutcome === 'saved' || task.mediaSaved) return true;
          }
        }
      } catch (e) {}
      return false;
    };
    // Watch se PEHLE wala mauqa — pata pehle se kitab
    // me ho to hover ka intezaar hi nahi.
    try { if (await tryRpcFeed(watchDeadline)) return true; } catch (e) {}
    try { if (await tryStateProbe()) return true; } catch (e) {}
    // v2.48.63 (PASSIVE-FIRST — Item A): ZC30 ka saboot
    // — download ka pehla marhala ab SIRF SUNTA hai.
    // Is session me render hue task ki poori stream aam
    // tor par render ke chand seconds baad KHUD network
    // par aa jati hai; purana hover-watch (scroll /
    // synthetic / pointer, ~59s tak) page ko chhed kar
    // usi aane ko dusri tiles ke liye rok deta tha —
    // pehli video ka watch dusri ki khidki band kar
    // deta tha. Yahan page ko bilkul NAHI chheda jata
    // (na scroll, na hover, na pointer, na focus):
    // kitab me stream dikhte hi binding plan use isi
    // task se bandh kar save kar deta hai. Download
    // render ke saath hi shuru hota hai (owner ki
    // standing demand) — bas pehla marhala khamosh hai.
    // Khidki (render + 45s) guzar jaye aur stream na
    // aaye to neeche wala purana hover escalation
    // bilkul waisa hi chalta hai. Do-while ki shakal:
    // khidki guzar chuki ho tab bhi binding plan EK
    // dafa lazmi chalta hai — kataar me intezaar ke
    // dauraan pakdi gayi stream bina kisi deri ke isi
    // pal claim ho jati hai.
    if (passiveClaimApplies(task, this._sessionStartedAt)) {
      const passiveUntil = task.renderCompletedAt + 45000;
      const passiveRemainMs = passiveUntil - Date.now();
      if (passiveRemainMs > 1000) {
        this.log(`[ROOT] [Prompt #${n}] mainpage-harvest: passive claim — watching the network only (no hover, no clicks) for up to ${Math.max(1, Math.round(passiveRemainMs / 1000))}s; the full stream is expected to arrive on its own`, 'info');
      }
      let passiveSaved = false;
      let passiveAmbiguous = false;
      do {
        if (this.isStopping) break;
        const pr = await tryBindingPlan({ watchStart });
        if (pr === 'saved' || task.mediaSaved) { passiveSaved = true; break; }
        if (pr === 'ambiguous') { passiveAmbiguous = true; break; }
        if (Date.now() >= passiveUntil) break;
        await sleep(250);
      } while (Date.now() < passiveUntil);
      this.log(`[ROOT] [Prompt #${n}] mainpage-harvest: passive claim finished — saved=${passiveSaved ? 'yes' : 'no'}`, 'info');
      if (passiveAmbiguous) return failOut();
      if (passiveSaved || task.mediaSaved) return true;
    }
    // v2.48.65 (RANK-2 POINTER TRIGGER): passive ke
    // baad wala marhala — tile par ASAL pointerdown,
    // pointerup TILE SE BAHAR. ZC32 ka saboot:
    // resize (CSS bada + fullscreen, 30s) par
    // player ne encode nahi badla aur koi nayi
    // stream network par aayi hi nahi — display
    // size passive ishara hai, player use nahi
    // sunta; resize marhala is liye hata diya
    // gaya. Gemini brief-3 §6.4 Rank 2: asal dabao
    // hi woh user-intent signal hai jo player
    // sunta ho sakta hai. Dabao tile ke wast par
    // ~400ms, phir pointer steps ke saath tile se
    // bahar aur wahin chhorna — click tile par
    // poora hi nahi hota, editor KABHI nahi
    // khulta (standing rule), aur file aaye to
    // phir bhi backend (googlevideo) se hi
    // network layer par pakdi jayegi. Darwaza
    // sirf is session ke taaza renders ke liye
    // (pointerTriggerApplies); recovery bahar.
    if (pointerTriggerApplies(task, this._sessionStartedAt)) {
      const logPointerTileMedia = async () => {
        try {
          const stM = await this._readTileMediaState(task, tileIndexHint);
          const mw = stM && stM.videoWidth != null ? stM.videoWidth : '-';
          const mh = stM && stM.videoHeight != null ? stM.videoHeight : '-';
          const md = stM && stM.duration != null ? stM.duration : '-';
          const mr = stM && stM.readyState != null ? stM.readyState : '-';
          this.log(`[ROOT] tile-media dims=${mw}x${mh} dur=${md} ready=${mr}`, 'info');
        } catch (e) {}
      };
      let prs = null;
      try { prs = await this._pressMainpageTile(task, tileIndexHint); } catch (e) { prs = null; }
      if (!prs || !prs.applied) {
        this.log(`[ROOT] [Prompt #${n}] mainpage-harvest: pointer trigger skipped reason=${(prs && prs.reason) || 'error'}`, 'info');
      } else {
        this.log(`[ROOT] [Prompt #${n}] mainpage-harvest: pointer trigger applied box=${prs.box || '-'} — watching up to 30s for the full stream`, 'info');
        await logPointerTileMedia();
        const pointerDeadline = Date.now() + 30000;
        let pointerSaved = false;
        let pointerAmbiguous = false;
        for (;;) {
          if (this.isStopping) break;
          const pz = await tryBindingPlan({ watchStart });
          if (pz === 'saved' || task.mediaSaved) { pointerSaved = true; break; }
          if (pz === 'ambiguous') { pointerAmbiguous = true; break; }
          if (Date.now() >= pointerDeadline) break;
          await sleep(250);
        }
        this.log(`[ROOT] [Prompt #${n}] mainpage-harvest: pointer finished — saved=${pointerSaved ? 'yes' : 'no'}`, 'info');
        if (pointerAmbiguous) return failOut();
        if (pointerSaved || task.mediaSaved) return true;
      }
    }
    try { await this._exitPrevMainpageHover(task); } catch (e) {}
    const scrolled = await this._scrollMainpageTileIntoView(task, tileIndexHint);
    this.log(`[ROOT] [Prompt #${n}] mainpage-harvest: hover trigger level=scroll (this video's tile ${scrolled ? 'was scrolled' : 'could not be scrolled'} into view on the main page; nothing opened, nothing clicked); watching up to ${Math.max(1, Math.round((watchDeadline - watchStart) / 1000))}s for its stream`, 'info');
    let level = 'scroll';
    const syntheticAt = watchStart + hoverGraceMs;
    const pointerAt = syntheticAt + pointerGraceMs;
    for (;;) {
      if (this.isStopping || task.mediaSaved) break;
      const r = await tryBindingPlan({ watchStart });
      if (r === 'saved') return true;
      if (r === 'ambiguous') return failOut();
      const nowT = Date.now();
      if (nowT >= watchDeadline) break;
      if (level === 'scroll' && nowT >= syntheticAt && syntheticAt < watchDeadline) {
        level = 'synthetic';
        const sent = await this._syntheticHoverMainpageTile(task, tileIndexHint);
        this.log(`[ROOT] [Prompt #${n}] mainpage-harvest: hover trigger level=synthetic (mouseover/mouseenter ${sent ? 'sent to' : 'could not be sent to'} this video's tile; nothing opened, nothing clicked)`, 'info');
        continue;
      }
      if (level === 'synthetic' && nowT >= pointerAt && pointerAt < watchDeadline) {
        level = 'pointer';
        const held = await this._pointerHoverMainpageTile(task, tileIndexHint);
        this.log(`[ROOT] [Prompt #${n}] mainpage-harvest: hover trigger level=pointer (pointer ${held ? 'held over' : 'could not be held over'} this video's tile; nothing opened, nothing clicked)`, 'info');
        continue;
      }
      await sleep(250);
    }
    let newCount = 0;
    try {
      for (const e of cap.mainpageEntries()) {
        if (e && e.url && e.candidate !== false && Number.isFinite(e.firstSeenAt) && e.firstSeenAt >= watchStart) newCount++;
      }
    } catch (e) {}
    this.log(`[ROOT] [Prompt #${n}] mainpage-harvest: hover watch finished — ${newCount} new stream(s) first seen during the watch`, 'info');
    // Intezaar ke dauraan kitab badal sakti hai —
    // bandhi body ka ek aur mauqa, phir plan dobara
    // (exclusion ab laagu ho sakta hai).
    try {
      const okBody = await this._tryHarvestSave(task, downloadFolder, settings, attempts);
      if (okBody || task.mediaSaved) return true;
    } catch (e) {}
    {
      const r = await tryBindingPlan({ watchStart });
      if (r === 'saved') return true;
      if (r === 'ambiguous') return failOut();
    }
    // v2.48.54: rpc-feed mauqa ab bandha hua helper
    // (tryRpcFeed, upar) hai — watch ke baad ki ye
    // jagah barkarar hai, waisa hi mauqa watch se
    // PEHLE bhi milta hai.
    try { if (await tryRpcFeed(watchDeadline)) return true; } catch (e) {}
    try { if (await tryStateProbe()) return true; } catch (e) {}

    // v2.48.49 (TOO-SMALL MEDIA-LOAD MAUQA —
    // ZEROCLICK16): bandhan tak kuch pahuncha hi
    // nahi, lekin is attempt ki khidki me is task ki
    // tile ki ek googlevideo stream SIRF
    // 'stream-too-small' par ruki thi (chhota preview
    // encode — 85,725B / 110,290B) to failOut se
    // pehle usi URL par media-load ko EK mauqa do:
    // adrishya element us pate ko load kare to media
    // stack poori file ke range jawab kheench sakta
    // hai aur .48 ki assembly unhe jod sakti hai.
    // Us ke baad kitab dobara parhi jati hai
    // (mainpageBodyForUrl + mediaBodyState) — body
    // 'complete' ho to wahi bandhi-entry wali
    // completion (saveGuard ke saare darwaze bilkul
    // waisa hi faisla karte hain); warna attempt aaj
    // ki tarah hi khatam hota hai. Trigger ka faisla
    // khalis hai (saveGuard.mainpageTooSmallMediaPick)
    // — bandhan/claim/tried-URL ke usool nahi badle;
    // ye mauqa is attempt me sirf EK dafa chalta hai.
    try {
      const sightings = typeof cap.mainpageTooSmallSightings === 'function'
        ? cap.mainpageTooSmallSightings() : [];
      // v2.48.51 (item 3): pick ab task ki nishani
      // (captureKey + render waqt + attempt ki hadd)
      // ke saath — dusri task ki nazar nahi uthti
      // (ZEROCLICK18 ki rr5 galti); jo nazar uthi wo
      // is task ke naam consumed darj hoti hai.
      const pick = saveGuard.mainpageTooSmallMediaPick({
        sightings,
        taskStart: task.startTime || 0,
        teacherUrl,
        triedUrls,
        captureKey: captureKey || task.captureKey || task.videoId || null,
        renderDoneAt: Number.isFinite(task.renderCompletedAt) ? task.renderCompletedAt : null,
        attemptDeadline: watchDeadline
      });
      if (pick && pick.url && !this.isStopping && !task.mediaSaved) {
        try { if (typeof cap.mainpageMarkTooSmallConsumed === 'function') cap.mainpageMarkTooSmallConsumed(pick.url, captureKey || task.captureKey || task.videoId || null); } catch (e) {}
        // v2.48.52 (ROUTE 1A PACK — too-small par 1A
        // PEHLE): ye nazar ab is task ki pukhta
        // nishani par uthi hai (.51 attribution) —
        // media-load se pehle usi pate par NETLOAD
        // seedha bulaya jata hai: range param hata
        // kar poori file CDP se uthao. Body mil jaye
        // to wo bandhi entry ki shakal me wahi
        // completion leti hai (body haath me di
        // jati hai — _netloadBody; andar kitab /
        // media / fetch dobara nahi ghumte, aur
        // _noInPageFetch is pate par in-page fetch
        // hamesha ke liye rokta hai — .51 ki
        // 'chhota pata kabhi fetch nahi' hifazat
        // barkarar). Body darwaze par ruk jaye
        // ('rejected') to neeche wala media-load
        // mauqa usi file ko dobara nahi ghumayega;
        // netload se body hi na mile to wo mauqa
        // bilkul .51 jaisa chalta hai.
        let nlBodyRejected = false;
        if (!task.mediaSaved) {
          const nlRes = await this._netloadMainpageFull(task, pick.url);
          if (nlRes && nlRes.buf && !task.mediaSaved) {
            const bookEntry0 = typeof cap.mainpageEntries === 'function'
              ? cap.mainpageEntries().find(e => e && e.url === pick.url) : null;
            const nlEntry = {
              url: pick.url,
              src: 'googlevideo',
              byteLength: nlRes.buf.length,
              headerOk: true,
              partial: true,
              status: nlRes.status || 0,
              contentRange: bookEntry0 && bookEntry0.contentRange ? bookEntry0.contentRange : '',
              declaredLength: bookEntry0 && Number.isFinite(bookEntry0.declared) ? bookEntry0.declared : 0,
              knownTotal: bookEntry0 && Number.isFinite(bookEntry0.knownTotal) ? bookEntry0.knownTotal : null,
              duplicate: false,
              hash: null,
              teacherHash,
              bound: true,
              bodyBytes: nlRes.buf.length,
              at: bookEntry0 && Number.isFinite(bookEntry0.at) ? bookEntry0.at : Date.now(),
              firstSeenAt: bookEntry0 && Number.isFinite(bookEntry0.firstSeenAt) ? bookEntry0.firstSeenAt : pick.firstSeenAt,
              seq: bookEntry0 && Number.isFinite(bookEntry0.seq) ? bookEntry0.seq : null,
              claimedBy: null,
              _netloadBody: nlRes.buf,
              _netloadMeta: nlRes,
              _noInPageFetch: true
            };
            const nlOutcome = await completeTracked(nlEntry, 'too-small-netload');
            if (nlOutcome === 'saved' || task.mediaSaved) return true;
            if (nlOutcome === 'rejected') nlBodyRejected = true;
          }
        }
        if (!nlBodyRejected) {
        // v2.48.50 (item 1): ye mauqa bhi usi shared
        // completion se — pehle TILE element, hidden
        // chaara; lekin hadd EK drive ki hi rehti hai
        // (singleDrive — ye aakhri chaara hai, cycle
        // budget ka hissa ginata hai, item 4).
        await this._loadMainpageFullViaMedia(pick.url, { task, tileIndexHint, singleDrive: true });
        const bookEntry = typeof cap.mainpageEntries === 'function'
          ? cap.mainpageEntries().find(e => e && e.url === pick.url) : null;
        const held = typeof cap.mainpageBodyForUrl === 'function'
          ? cap.mainpageBodyForUrl(pick.url) : null;
        if (!task.mediaSaved && mediaBodyState(bookEntry, held) === 'complete' && held && held.buffer && held.buffer.length > 0) {
          // Jodi hui mukammal body ab bandhi entry ki
          // shakal me wahi completion leti hai —
          // partial=false / status=200 is liye ke body
          // asal me mukammal hai (mediaBodyState ne
          // 'complete' kaha hai); andar ke saare
          // darwaze (floor / header / teacher / hash /
          // duplicate) bilkul waisa hi faisla karte
          // hain.
          const entry = {
            url: pick.url,
            src: 'googlevideo',
            byteLength: held.buffer.length,
            headerOk: true,
            partial: false,
            status: 200,
            contentRange: bookEntry && bookEntry.contentRange ? bookEntry.contentRange : '',
            declaredLength: bookEntry && Number.isFinite(bookEntry.declared) ? bookEntry.declared : 0,
            duplicate: false,
            hash: null,
            teacherHash,
            bound: true,
            bodyBytes: held.buffer.length,
            at: bookEntry && Number.isFinite(bookEntry.at) ? bookEntry.at : Date.now(),
            firstSeenAt: bookEntry && Number.isFinite(bookEntry.firstSeenAt) ? bookEntry.firstSeenAt : pick.firstSeenAt,
            seq: bookEntry && Number.isFinite(bookEntry.seq) ? bookEntry.seq : null,
            claimedBy: null
          };
          const outcome = await completeTracked(entry, 'too-small-media-load');
          if (outcome === 'saved' || task.mediaSaved) return true;
        }
        }
      }
    } catch (e) {}
    return failOut();
  }
  /**
   * v2.48.31 (MINT): ek download round ki render→save khidki
   * ke liye enhanced capture chalu karo — capture har request
   * ki saaf shakal darj karega aur file-address le jaane wale
   * jawab [MINT] khabar denge. Tracker isi engine ka hai (har
   * worker ka apna capture + apna tracker). Band round ke
   * aakhir me hota hai (bulane wale ke finally me _mintEndWatch).
   */
  _mintBeginWatch(taskKey) {
    try {
      this._mintTracker = mintWindow.createMintWindow({ cap: mintWindow.DEFAULT_WINDOW_CAP });
      if (this.netCapture && typeof this.netCapture.setMintWatch === 'function') {
        // v2.48.33 (ZEROCLICK): round ka task bhi saath —
        // mint template isi task ke naam seekha jayega.
        this.netCapture.setMintWatch(true, taskKey || null);
      }
    } catch (e) {}
  }

  _mintEndWatch() {
    try {
      if (this.netCapture && typeof this.netCapture.setMintWatch === 'function') {
        this.netCapture.setMintWatch(false);
      }
    } catch (e) {}
    this._mintTracker = null;
  }

  /**
   * v2.48.31 (MINT-WINDOW): resolution click ke pal khidki
   * kholo. Click aur is pal ke beech guzri requests capture ki
   * ring se backfill hoti hain (un par bhi [MINT] req lines
   * banti hain, cap ke andar); us ke baad ki requests
   * onMintRequest callback se seedha aati hain.
   */
  _mintOpenWindow(clickAtMs) {
    try {
      const tr = this._mintTracker;
      if (!tr || !Number.isFinite(clickAtMs) || clickAtMs <= 0) return;
      tr.open(clickAtMs);
      const back = (this.netCapture && typeof this.netCapture.mintRequestsSince === 'function')
        ? this.netCapture.mintRequestsSince(clickAtMs)
        : [];
      for (const e of back) {
        const r = tr.noteRequest(e);
        if (r === 'cap') {
          this.log(`[MINT] req … (mint-window log cap ${mintWindow.DEFAULT_WINDOW_CAP} reached — further requests in this window are counted, not listed)`, 'info');
          break;
        }
        if (r) this.log(`[MINT] req method=${r.method} host=${r.host} path=${r.path}`, 'info');
      }
    } catch (e) {}
  }

  /** v2.48.31 (MINT-WINDOW): pehli flow-content sighting ka khulasa — beech me kitni requests gayin. */
  _mintNoteSighting(atMs) {
    try {
      const tr = this._mintTracker;
      if (!tr) return;
      const s = tr.noteSighting(atMs);
      if (s) {
        this.log(`[MINT] first flow-content sighting after ${s.requestsBefore} request(s) in the mint window (click→sighting ${((s.sightingAt - s.clickAt) / 1000).toFixed(1)}s)`, 'info');
      }
    } catch (e) {}
  }

  /**
   * v2.48.36 (ROOT PACK — B/C ki buniyad): seekhi hui mint
   * call ko HU-BAHU (verbatim — koi tabdeeli nahi; badalne
   * ko id hai hi nahi, ZEROCLICK2 sabit) page ke andar se
   * ek dafa bhejna. Hadd ~8s. Kabhi throw nahi karta:
   * natija { status, buf } — nakami par status 'error'
   * aur khaali buf. Jawab se yahan kuch save/claim NAHI
   * hota — faisla bulane wale ka hai.
   */
  async _fireMintReplay(tpl, pageOverride) {
    // v2.48.40: pageOverride diya jaye to replay usi
    // page ke andar se, warna asal page. (v2.48.41:
    // background page khatam — replay hamesha asal
    // main page se hota hai.)
    const pg = pageOverride || this.page;
    try {
      if (!tpl || !tpl.url || !tpl.body || !pg || pg.isClosed()) {
        return { status: 'error', buf: Buffer.alloc(0) };
      }
      const res = await downloadGuard.withTimeout(
        pg.evaluate(async (u, m, h, b64) => {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const r = await fetch(u, { method: m || 'POST', headers: h, body: bytes, credentials: 'include' });
          const rbuf = await r.arrayBuffer();
          const u8 = new Uint8Array(rbuf);
          let s = '';
          for (let i = 0; i < u8.length; i += 8192) {
            s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
          }
          return { status: r.status, b64: btoa(s) };
        }, tpl.url, tpl.method || 'POST', tpl.headers, tpl.body.toString('base64')),
        8000, 'mint replay');
      if (!res) return { status: 'error', buf: Buffer.alloc(0) };
      let buf = Buffer.alloc(0);
      try { buf = res.b64 ? Buffer.from(res.b64, 'base64') : Buffer.alloc(0); } catch (e) { buf = Buffer.alloc(0); }
      return { status: res.status, buf };
    } catch (e) {
      return { status: 'error', buf: Buffer.alloc(0) };
    }
  }

  /**
   * v2.48.36 (ROOT PACK): ek batchexecute jawab ke buffer
   * se asal flow-content video address nikaalna — sirf
   * andarooni istemal (muqabla/claim/fetch ke liye); ye
   * address kabhi log nahi hote.
   */
  _replayResponseUrls(buf) {
    try {
      if (!buf || buf.length === 0) return [];
      const cap = this.netCapture;
      const scan = networkCapture.scanBatchExecuteBody(buf, cap ? cap.patterns : undefined);
      return (scan.allUrls || []).filter(u => flowContent.isFlowContentVideoUrl(u));
    } catch (e) { return []; }
  }

  /**
   * v2.48.36 (ROOT PACK — B/C ka mushtarak aakhri qadam):
   * verbatim replay ke jawab ke URLs ka faisla aur (jaiz
   * ho to) verified server-fetch save. Usool sakht:
   *   - jawab capture pipeline se bhi guzarta hai (bandish
   *     ki kitab taaza rehti hai — zero-click wala usool);
   *   - faisla saveGuard.replayUrlVerdict (khalis) se:
   *     teacher ka address aaya ho to FETCH KABHI NAHI —
   *     wo is task ki file ho hi nahi sakti;
   *   - akela naya unclaimed address hi claim + fetch
   *     hota hai, aur save ki har jaanch (_serverFetchSave
   *     → content gate + hash guard + ffprobe) barkarar.
   * Natija: { outcome: 'saved'|'teacher'|'none'|
   * 'ambiguous'|'claimed'|'fetch-failed', gapSec? }.
   */
  async _saveFromReplayUrls(task, downloadFolder, settings, urls, via, buf, replayUrl) {
    const cap = this.netCapture;
    const captureKey = task.captureKey || task.videoId || null;
    try {
      if (buf && buf.length > 0 && cap && typeof cap.ingestResponse === 'function') {
        cap.ingestResponse({ url: replayUrl, contentType: 'application/json', bodyBuffer: buf, at: Date.now() });
      }
    } catch (e) {}
    // v2.48.37: muqable ka template ab asar-daar wala
    // (learned warna candidate) — teacher langar usi se.
    const tpl = (cap && typeof cap.replayTemplate === 'function')
      ? cap.replayTemplate().template
      : (cap && cap.mintTemplate ? cap.mintTemplate : null);
    const teacherUrl = cap && typeof cap.teacherMintUrlForTemplate === 'function'
      ? cap.teacherMintUrlForTemplate(tpl) : null;
    const verdict = saveGuard.replayUrlVerdict({
      urls,
      teacherUrl,
      isClaimed: (u) => {
        try {
          return !!((cap && cap.isFlowContentClaimed(u)) || this._urlClaimedByOtherTask(u, captureKey));
        } catch (e) { return false; }
      }
    });
    if (verdict.action !== 'save') {
      return { outcome: verdict.action === 'teacher' ? 'teacher' : verdict.action };
    }
    // v2.48.41: v2.48.39 wala 'replay-fetch skipped' wala
    // shortcut gaya — wo editor-harvest ki promoted body
    // par tha, aur editor-harvest ab hai hi nahi. Grid
    // replay ka address ab hamesha apni verified
    // server-fetch se save hota hai.
    let okFetch = false;
    try { okFetch = await this._serverFetchSave(task, downloadFolder, settings, { url: verdict.url, via }); } catch (e) { okFetch = false; }
    if (okFetch || task.mediaSaved) {
      const gapBase = task.renderCompletedAt || task.startTime || Date.now();
      const gapSec = Math.max(0, (Date.now() - gapBase) / 1000).toFixed(1);
      return { outcome: 'saved', gapSec };
    }
    return { outcome: 'fetch-failed' };
  }

  async _verbatimReplayProbe(task, captureKey) {
    try {
      const cap = this.netCapture;
      if (!cap || cap._verbatimProbeDone) return;
      // v2.48.37: probe bhi asar-daar template par (learned
      // warna candidate) — jaal ab chauda hai.
      const tpl = (typeof cap.replayTemplate === 'function')
        ? cap.replayTemplate().template
        : (cap.mintTemplate ? cap.mintTemplate : null);
      if (!tpl || !tpl.body || !tpl.url) return; // template hi nahi — pehla task khud teacher bane ga
      if (tpl.taskKey && captureKey && tpl.taskKey === captureKey) return; // teacher khud hai
      if (!this.page || this.page.isClosed()) return;
      cap._verbatimProbeDone = true; // nishaan PEHLE — ek session, ek probe
      // v2.48.36: firing ab mushtarak helper se hai (rawaaN
      // bilkul waisa hi — hu-bahu call, ~8s hadd, page ka
      // apna session).
      const { status, buf } = await this._fireMintReplay(tpl);
      let verdict = { carriesUrl: false, urlVsTeacher: 'n/a' };
      try {
        const carries = buf.length > 0 && mintWindow.responseCarriesFileUrl({ bodyText: buf });
        let urls = [];
        let teacherUrl = null;
        if (carries) {
          urls = this._replayResponseUrls(buf);
          // v2.48.36 (ROOT PACK — E): teacher ka address ab
          // capture ki asal kitab se aata hai (seekhne ke
          // pal darj hua mint address) — muqabla tab hi
          // 'n/a' rahega jab wo asal me kabhi darj hi na
          // hua ho (v2.48.35 me bandhe link par nirbhar
          // tha, jo aksar khaali milta tha).
          try {
            teacherUrl = (typeof cap.teacherMintUrlForTemplate === 'function')
              ? cap.teacherMintUrlForTemplate(tpl) : null;
          } catch (e) { teacherUrl = null; }
        }
        verdict = mintReplay.classifyVerbatimProbe({ carriesUrl: carries, urls, teacherUrl });
      } catch (e) {}
      this.log(`[ZEROCLICK] verbatim-probe status=${status} carriesUrl=${verdict.carriesUrl ? 'yes' : 'no'} urlVsTeacher=${verdict.urlVsTeacher}`, 'info');
    } catch (e) {}
  }

  /**
   * v2.48.33 (ZEROCLICK — PROBE, abhi LIVE PROVEN NAHI):
   * seekhi hui mint-call ko bina kisi UI click ke replay
   * karna. Tasalsul: is session ke kisi PEHLE task ke download
   * me jo batchexecute darkhwast file-address le aayi thi,
   * capture ne use template bana kar rakha hai (asal URL +
   * headers + body; teacher task ke ID ki jaghein darj hain).
   * Is task ke render-complete par, direct-viewer se PEHLE:
   * teacher ke ID ki har jagah IS task ka workflowId rakh kar
   * wahi darkhwast page ke andar se (page.evaluate fetch —
   * session page ka apna hai, app cookies kabhi nahi chhuta)
   * bhej do, aur jawab ko wahi pehchan-darwazon se guzaaro.
   *
   * Teen natije, teeno log hote hain (yehi is probe ka saboot
   * hai — H1 banam H2 ka faisla live run se hoga):
   *   (a) jawab me is task ke qabil flow-content address →
   *       verified server-fetch se save, koi UI download
   *       interaction NAHI hua. [ZEROCLICK] replay SUCCESS
   *   (b) jawab aaya lekin file-address nahi → H2 saboot
   *       (call sirf click ke baad hi address laati hai) —
   *       aam direct-viewer rasta chalega.
   *   (c) replay error/timeout (hadd ~8s) → aam rasta.
   * Replay har task par HAD EK dafa; nakami fallback ko 8s
   * se zyada nahi rokti. Download-stage ki haar par prompt
   * dobara KABHI nahi bheja jata (sacred rule barkarar).
   *
   * v2.48.34 (URL reach): pehle live test me template ke
   * body me teacher ki id mili hi nahi (idsInBody=0) — is
   * liye tabdeeli ab body AUR URL dono par alag-alag laagu
   * hoti hai (urlPrimaryId capture seekhne ke pal URL se
   * darj karta hai), aur replay sirf tab rukta hai jab dono
   * jagah kuch na mile. SUCCESS aur skip lines par loc=
   * body|url|both (skip-none par loc=none) yahi batata hai
   * ke id asal me kahan safar karta hai. Tartib, 8s cap,
   * ek-dafa-hadd aur fallback sab bilkul pehle jaise hain.
   */
  async _tryZeroClickReplay(task, downloadFolder, settings, attempts, captureKey) {
    const n = task.promptIndex + 1;
    if (task._zeroClickTried) return false;
    task._zeroClickTried = true;
    if (this.isStopping || task.mediaSaved) return false;
    const cap = this.netCapture;
    const tpl = cap && cap.mintTemplate ? cap.mintTemplate : null;
    if (!tpl || !tpl.body) return false; // pehla task — seekhne wala koi nahi, khamosh aage
    if (tpl.taskKey && captureKey && tpl.taskKey === captureKey) return false; // apna hi template — ye task khud teacher hai
    if (!this.page || this.page.isClosed()) return false;
    // v2.48.34 (URL reach): tabdeeli ki jodi ab body ke
    // primaryId se bhi ban sakti hai aur URL ke urlPrimaryId
    // se bhi — dono jagah alag-alag laagu hoti hain, aur
    // replay sirf tab rukta hai jab DONO jagah kuch na mile.
    // loc wahi batata hai: tabdeeli kahan hui (body|url|both),
    // skip par kahan ho sakti thi (ya none).
    const hasBodyId = !!tpl.primaryId;
    const hasUrlId = !!tpl.urlPrimaryId;
    const locTried = hasBodyId && hasUrlId ? 'both' : hasBodyId ? 'body' : hasUrlId ? 'url' : 'none';
    if (!hasBodyId && !hasUrlId) {
      this.log(`[ZEROCLICK] [Prompt #${n}] replay skipped — the learned mint call carries none of its own task's ids in the body or the url (idsInBody was 0, idsInUrl was 0), so there is nothing to substitute for this task loc=none`, 'info');
      attempts.push({ strategy: 'zero-click', ok: false, note: 'the learned mint-call template carries no substitutable task id — the replay was skipped and the normal routes ran' });
      return false;
    }
    let thisId = null;
    try { thisId = (cap && typeof cap.workflowIdForKey === 'function') ? cap.workflowIdForKey(captureKey) : null; } catch (e) { thisId = null; }
    if (!thisId && task.videoId) thisId = task.videoId;
    if (!thisId) {
      this.log(`[ZEROCLICK] [Prompt #${n}] replay skipped — this task's workflow id is not known yet loc=${locTried}`, 'info');
      attempts.push({ strategy: 'zero-click', ok: false, note: 'this task\'s workflow id was not known at render-complete — the replay was skipped and the normal routes ran' });
      return false;
    }
    const bodySub = hasBodyId ? mintReplay.substituteIds(tpl.body, [[tpl.primaryId, thisId]]) : null;
    const urlSub = hasUrlId ? mintReplay.substituteIdsInUrl(tpl.url, [[tpl.urlPrimaryId, thisId]]) : null;
    const bodyReps = bodySub ? bodySub.replacements : 0;
    const urlReps = urlSub ? urlSub.replacements : 0;
    if (bodyReps === 0 && urlReps === 0) {
      this.log(`[ZEROCLICK] [Prompt #${n}] replay skipped — the learned template holds no replaceable occurrence of its task's id in the body or the url loc=${locTried}`, 'info');
      attempts.push({ strategy: 'zero-click', ok: false, note: 'the learned template held no substitutable id occurrence — the replay was skipped and the normal routes ran' });
      return false;
    }
    const loc = bodyReps > 0 && urlReps > 0 ? 'both' : bodyReps > 0 ? 'body' : 'url';
    const replayUrl = urlSub && urlReps > 0 ? urlSub.url : tpl.url;
    const replayBody = bodySub && bodyReps > 0 ? bodySub.body : tpl.body;
    const gapBase = task.renderCompletedAt || task.startTime || Date.now();
    let res = null;
    let failReason = '';
    try {
      res = await downloadGuard.withTimeout(
        this.page.evaluate(async (u, m, h, b64) => {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const r = await fetch(u, { method: m || 'POST', headers: h, body: bytes, credentials: 'include' });
          const buf = await r.arrayBuffer();
          const u8 = new Uint8Array(buf);
          let s = '';
          for (let i = 0; i < u8.length; i += 8192) {
            s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
          }
          return { status: r.status, b64: btoa(s) };
        }, replayUrl, tpl.method || 'POST', tpl.headers, replayBody.toString('base64')),
        8000, 'zero-click replay');
    } catch (e) {
      failReason = e && e.message ? String(e.message).slice(0, 80) : 'no response';
      res = null;
    }
    if (!res) {
      this.log(`[ZEROCLICK] [Prompt #${n}] replay failed ${failReason || 'no response'} — falling back to the viewer route`, 'warn');
      attempts.push({ strategy: 'zero-click', ok: false, note: `the zero-click replay did not answer (${failReason || 'no response'}) — the normal routes ran as fallback` });
      return false;
    }
    if (res.status >= 400) {
      this.log(`[ZEROCLICK] [Prompt #${n}] replay failed http-${res.status} — falling back to the viewer route`, 'warn');
      attempts.push({ strategy: 'zero-click', ok: false, note: `the zero-click replay was answered http-${res.status} — the normal routes ran as fallback` });
      return false;
    }
    let buf = null;
    try { buf = res.b64 ? Buffer.from(res.b64, 'base64') : Buffer.alloc(0); } catch (e) { buf = Buffer.alloc(0); }
    // Jawab ko maujood capture pipeline se bhi guzaaro
    // (direct-API poll wali hi tarz) — is me bandhe hue
    // koi bhi link aam pehchan-usoolon se hi bandhta hai.
    try {
      if (buf.length > 0 && cap && typeof cap.ingestResponse === 'function') {
        cap.ingestResponse({ url: replayUrl, contentType: 'application/json', bodyBuffer: buf, at: Date.now() });
      }
    } catch (e) {}
    const carries = mintWindow.responseCarriesFileUrl({ bodyText: buf });
    if (!carries) {
      this.log(`[ZEROCLICK] [Prompt #${n}] replay answered without file url (H2 evidence) status=${res.status} bodyBytes=${buf.length}`, 'warn');
      attempts.push({ strategy: 'zero-click', ok: false, note: 'the zero-click replay was answered but carried no file address (H2 evidence — the mint call may only carry the address after a click) — the normal routes ran as fallback' });
      return false;
    }
    // Address jawab ke andar hai — ummeedwaar nikalo aur
    // post-click race wale pehchan-darwaze (taaza / claimed
    // nahi / apna) lagao.
    let candUrls = [];
    try {
      const scan = networkCapture.scanBatchExecuteBody(buf, cap.patterns);
      candUrls = (scan.allUrls || []).filter(u => flowContent.isFlowContentVideoUrl(u));
    } catch (e) { candUrls = []; }
    const entries = candUrls.map(u => ({ url: u, type: '', at: Date.now() }));
    const pick = flowContent.pickRaceFlowContentUrl(entries, {
      sinceMs: gapBase,
      isClaimed: (u) => {
        // v2.48.35: claimed-set ke saath kisi AUR task ke
        // naam bandha URL bhi rukawat hai (wahi discipline).
        try { return !!((cap && cap.isFlowContentClaimed(u)) || this._urlClaimedByOtherTask(u, captureKey)); } catch (e) { return false; }
      },
      isOwnUrl: (u) => this._isTaskOwnUrl(task, u)
    });
    if (!pick || !pick.url) {
      const why = pick && pick.ambiguous ? `${pick.count} fresh candidates appeared and none could be proven to be this task's own` : 'no usable own address could be picked from it';
      this.log(`[ZEROCLICK] [Prompt #${n}] replay response carried the file address host but ${why} — falling back to the viewer route`, 'warn');
      attempts.push({ strategy: 'zero-click', ok: false, note: 'the zero-click replay response carried the file-address host but no single address could be proven to be this task\'s own — the normal routes ran as fallback' });
      return false;
    }
    let okFetch = false;
    try { okFetch = await this._serverFetchSave(task, downloadFolder, settings, { url: pick.url, via: 'zero-click' }); } catch (e) { okFetch = false; }
    if (okFetch || task.mediaSaved) {
      const gapSec = Math.max(0, (Date.now() - gapBase) / 1000).toFixed(1);
      this.log(`[ZEROCLICK] replay SUCCESS via=zero-click gap=${gapSec}s loc=${loc}`, 'success');
      attempts.push({ strategy: 'zero-click', ok: true, note: `the file was fetched straight from Flow's server after the app replayed the learned mint call itself — no UI download click happened for this video; render→save gap ${gapSec}s` });
      return true;
    }
    attempts.push({ strategy: 'zero-click', ok: false, note: 'the zero-click replay produced this task\'s server address but the verified fetch did not save the file — the normal routes ran as fallback' });
    return false;
  }

  /**
   * v2.48.32 (SWITCH — .31 ka DIRECT-PROBE ab PRIMARY rasta):
   * ⋮ menu ke baghair, tile ke bare view (viewer — is app me
   * tile click se khulne wala editor view) ke apne "Download
   * media" button se file ka server address mint karke app ki
   * apni verified server-fetch (_serverFetchSave: quality
   * gate + ffprobe + mediaSaved bachav) se save.
   *
   * LIVE SABOOT (DIRECTTEST1, v2.48.31, 2026-11-03, owner ke
   * PC par engine log): render-complete → viewer khula →
   * button mila ("download media") → click ke ~1.4s baad
   * [MINT] batchexecute jawab file ka address le aaya →
   * app ki parallel fetch ne file save ki; ⋮ menu kabhi
   * khula hi nahi, koi resolution-overlay click nahi hua,
   * koi browser blob download nahi hua. Gap 15.3s tha, jisme
   * ~4.2s probe ki dheeli tartib (pehle 3.5s passive poll,
   * phir ek-shot button scan) me gaya — .32 wahi tartib
   * kas-ta hai:
   *   1. Viewer confirm khula → FORAN button scan (har
   *      ~150ms, kul ~2.5s tak); button milte hi click —
   *      passive poll button se PEHLE nahi chalta.
   *   2. Click ke baad address ka intezaar kul ~6s (poll
   *      ~175ms). ~2.5s par address na aaya ho aur
   *      resolution overlay khula dikhe to us ka Original
   *      entry ek dafa (detour — ⚠️ UNPROVEN, neeche dekho),
   *      phir baaki intezaar jaari.
   *   3. Button ~2.5s me na mile tab hi passive poll (3.5s)
   *      — sirf kholne se address aaye to via=viewer-open.
   * Sub-timing lines (download-attempt ke aaghaz se):
   *   [DIRECT] editor-open at +<s>s · button-clicked at +<s>s
   *   · url-seen at +<s>s — aur aakhir me wahi
   *   [DIRECT] via=<...> gap=<s>s (render→save).
   * Kuch na bane to viewer saaf band karke (Escape + grid
   * wapsi) menu wala rasta (fallback #2) bilkul pehle ki
   * tarah chalta hai. Download-stage ki haar par prompt
   * KABHI dobara nahi bheja jata (sacred rule barkarar).
   */
  /**
   * v2.48.36 (ROOT PACK — B ki seedhi): is task ki tile ko
   * page ki selected/focused state me lana — editor khole
   * BAGHAIR. Tartib: hover (tile ke controls jaagte hain)
   * → tile ke andar koi selection affordance (checkbox /
   * role=checkbox / 'select' naam wala control) ho to
   * wahi click → warna keyboard focus (tile ya us ke
   * pehle focusable ko focus(); click NAHI, is liye
   * editor nahi khulta). Affordance ke click se editor
   * khul jaye to wo khabar alag lautti hai (openedEditor)
   * — bulane wala use route C ke hawale kar deta hai.
   * Koi mehfooz tareeqa na mile to { attempted:false } —
   * bulane wala log karke route chhod deta hai.
   * Natija: { attempted, method?, openedEditor? }.
   */
  async _selectTileWithoutOpening(task, tileIndexHint) {
    try {
      if (!this.page || this.page.isClosed()) return { attempted: false };
      let editorAlready = false;
      try { editorAlready = await this._inEditorView(); } catch (e) { editorAlready = false; }
      if (editorAlready) return { attempted: false, openedEditor: true };
      const idx = await this._resolveTileIndexForTask(task, tileIndexHint);
      const coords = idx >= 0 ? await this._tileCenterCoords(idx) : { found: false };
      if (!coords.found) return { attempted: false };
      try { await this.page.mouse.move(coords.x, coords.y); } catch (e) {}
      await sleep(350);
      const act = await this.page.evaluate(({ idx }) => {
        const tiles = Array.from(document.querySelectorAll('flow-grid-tile-container'));
        const tile = tiles[idx];
        if (!tile) return { method: 'none' };
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const cands = Array.from(tile.querySelectorAll('input[type="checkbox"], [role="checkbox"], button, [role="button"]'));
        for (const el of cands) {
          if (!visible(el)) continue;
          const isCheckbox = (el.getAttribute && el.getAttribute('type') === 'checkbox')
            || (el.getAttribute && el.getAttribute('role') === 'checkbox');
          const label = norm(el.getAttribute && el.getAttribute('aria-label'));
          if (isCheckbox || /select/.test(label)) {
            const r = el.getBoundingClientRect();
            return { method: 'affordance', x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        // Keyboard focus: tile ya us ke andar ke pehle
        // focusable ko focus — click nahi, editor nahi.
        try {
          const focusable = tile.querySelector('a[href], button, [tabindex]') || tile;
          if (focusable) {
            if (focusable.setAttribute && !(focusable.hasAttribute && focusable.hasAttribute('tabindex'))) {
              try { focusable.setAttribute('tabindex', '-1'); } catch (e) {}
            }
            focusable.focus();
            const active = document.activeElement;
            if (active && (active === tile || tile.contains(active))) return { method: 'focus' };
          }
        } catch (e) {}
        return { method: 'none' };
      }, { idx });
      if (!act || act.method === 'none') return { attempted: false };
      if (act.method === 'affordance') {
        try { await this.page.mouse.click(act.x, act.y); } catch (e) {}
        await sleep(250);
        let opened = false;
        try { opened = await this._inEditorView(); } catch (e) { opened = false; }
        if (opened) return { attempted: true, method: 'affordance', openedEditor: true };
      }
      return { attempted: true, method: act.method };
    } catch (e) {
      return { attempted: false };
    }
  }

  /**
   * v2.48.50 (MEGA PACK item 6 — PIPELINING): is task ki
   * completion ke dauraan AGLI pending task ki tile ko
   * viewport me la kar us ke preview element ko muted
   * play karo — bilkul waisa hi in-place playback jo
   * page khud hover par karta hai. Is se agle task ki
   * stream peeche (background) aati rehti hai aur us ki
   * completion apni baari par taaza stream se shuru
   * hoti hai. Bandhan ki hifazat (reserved-for-earlier-
   * pending) bilkul nahi badalti — ye sirf tile ko
   * nazar me rakhna hai, koi bandhan/claim nahi. Run
   * me ek dafa (har naye browser session par nishan
   * taaza hota hai); safal ho to EK line:
   * '[ROOT] mainpage-pipeline task=next-pending'.
   * Best-effort — nakami khamosh hai.
   */
  async _primeNextPendingTile(task) {
    if (this._pipelinePrimedRun) return false;
    const pg = this.page;
    if (!pg || pg.isClosed() || typeof pg.evaluate !== 'function') return false;
    let next = null;
    try {
      for (const t of this._captureTasks.values()) {
        if (t && t !== task && !t.mediaSaved && !t.completed) { next = t; break; }
      }
    } catch (e) {}
    if (!next) return false;
    const idx = await this._resolveTileIndexForTask(next, undefined);
    if (!Number.isInteger(idx) || idx < 0) return false;
    let primed = false;
    try {
      primed = await pg.evaluate((i) => {
        try {
          const tiles = document.querySelectorAll('flow-grid-tile-container');
          const tile = tiles && tiles[i];
          if (!tile) return false;
          try { tile.scrollIntoView({ block: 'center' }); } catch (e) {}
          const vid = tile.querySelector('video');
          // v2.48.55 (Gemini ZIP-fix se liya): <video>
          // abhi bana hi nahi to prime bekaar hai —
          // false lautao taaki one-shot flag is pal par
          // zaya na ho; agli task ke download ke dauraan
          // ye phir bulaya jayega (finishVideoAttempt).
          if (!vid) return false;
          try { vid.muted = true; } catch (e) {}
          const p = vid.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
          return true;
        } catch (e) { return false; }
      }, idx);
    } catch (e) { primed = false; }
    if (primed) {
      this._pipelinePrimedRun = true;
      try { this.log('[ROOT] mainpage-pipeline task=next-pending', 'info'); } catch (e) {}
    }
    return !!primed;
  }

  /**
   * v2.48.36 (ROOT PACK — B: GRID-SELECTION REPLAY):
   * editor khole baghair, sirf tile ko selected/focused
   * karke seekhi hui mint call hu-bahu chalana. Theory
   * (ZEROCLICK3 ke saboot par): call session ke
   * "current" media ka address deti hai — tile ki
   * selection hi wo current state grid par bana sakti
   * hai. Jawab ka address TEACHER ke address jaisa ho
   * to FETCH KABHI NAHI (wo is task ki file nahi) —
   * wahi line is theory ka faisla hai:
   *   [ROOT] grid-replay returned teacher url — context
   *   is not tile-selection
   * Alag address aaye to claim + verified server-fetch:
   *   [ROOT] via=grid-replay gap=<N>s
   * Template na ho (pehla task) ya ye task khud teacher
   * ho to khamoshi se skip — viewer route wahi seekhta
   * hai jo aaj seekhta hai.
   * Natija: { done, editorOpen }.
   */
  async _tryGridReplay(task, downloadFolder, settings, attempts, captureKey, tileIndexHint) {
    const n = task.promptIndex + 1;
    if (task._gridReplayTried) return { done: false, editorOpen: false };
    task._gridReplayTried = true;
    const cap = this.netCapture;
    // v2.48.37: route ab candidate template par bhi
    // chalta hai (learned hamesha pehle) — jawab ka
    // URL + teacher-muqabla + hash guard hi exactness
    // ka darwaza hai, template ka darja nahi.
    const tpl = (cap && typeof cap.replayTemplate === 'function')
      ? cap.replayTemplate().template
      : (cap && cap.mintTemplate ? cap.mintTemplate : null);
    if (!tpl || !tpl.body || !tpl.url) return { done: false, editorOpen: false }; // pehla task — seekhne wala koi nahi
    if (tpl.taskKey && captureKey && tpl.taskKey === captureKey) return { done: false, editorOpen: false }; // apna hi template — ye task khud teacher hai
    if (!this.page || this.page.isClosed() || this.isStopping || task.mediaSaved) return { done: false, editorOpen: false };

    const sel = await this._selectTileWithoutOpening(task, tileIndexHint);
    if (!sel || !sel.attempted) {
      this.log(`[ROOT] [Prompt #${n}] grid-replay skipped — no safe way to select this tile without opening the editor was found`, 'info');
      attempts.push({ strategy: 'grid-replay', ok: false, note: 'no safe way to select this task\'s tile without opening the editor was found — the grid replay was skipped and the normal routes ran' });
      return { done: false, editorOpen: false };
    }
    if (sel.openedEditor) {
      this.log(`[ROOT] [Prompt #${n}] grid-replay selection opened the editor instead — the replay will be tried from the editor context`, 'info');
      attempts.push({ strategy: 'grid-replay', ok: false, note: 'selecting the tile opened its editor instead — the replay continues from the editor context route' });
      return { done: false, editorOpen: true };
    }
    const { status, buf } = await this._fireMintReplay(tpl);
    if (status === 'error' || (typeof status === 'number' && status >= 400)) {
      attempts.push({ strategy: 'grid-replay', ok: false, note: `the grid-selection replay was not answered (${status === 'error' ? 'no response' : `http-${status}`}) — the normal routes ran as fallback` });
      return { done: false, editorOpen: false };
    }
    const urls = this._replayResponseUrls(buf);
    if (!(buf.length > 0 && mintWindow.responseCarriesFileUrl({ bodyText: buf })) || urls.length === 0) {
      this.log(`[ROOT] [Prompt #${n}] grid-replay answered without file url`, 'info');
      attempts.push({ strategy: 'grid-replay', ok: false, note: 'the grid-selection replay was answered but carried no file address — the normal routes ran as fallback' });
      return { done: false, editorOpen: false };
    }
    const res = await this._saveFromReplayUrls(task, downloadFolder, settings, urls, 'grid-replay', buf, tpl.url);
    if (res.outcome === 'teacher') {
      this.log(`[ROOT] grid-replay returned teacher url — context is not tile-selection`, 'warn');
      attempts.push({ strategy: 'grid-replay', ok: false, note: 'the grid-selection replay returned the previous task\'s file address — tile selection does not set the download context, and the address was NOT fetched' });
      return { done: false, editorOpen: false };
    }
    if (res.outcome === 'saved') {
      this.log(`[ROOT] via=grid-replay gap=${res.gapSec}s`, 'success');
      attempts.push({ strategy: 'grid-replay', ok: true, note: `the file was fetched straight from Flow's server after selecting this video's tile on the grid and replaying the learned mint call — no editor, no download-button click, no menu; render→save gap ${res.gapSec}s` });
      return { done: true, editorOpen: false };
    }
    attempts.push({ strategy: 'grid-replay', ok: false, note: `the grid-selection replay produced an address that could not be saved (${res.outcome}) — the normal routes ran as fallback` });
    return { done: false, editorOpen: false };
  }

  async _downloadTaskMediaInner(task, downloadFolder, settings, tileIndexHint) {
    const attempts = [];
    task.downloadAttempts = attempts;
    const n = task.promptIndex + 1;
    const isImage = !!(settings && settings.type === 'Image');
    const captureKey = task.captureKey || task.videoId || null;
    // v2.48.32 (SWITCH): is download attempt ka aaghaz —
    // direct route ki sub-timing lines ([DIRECT] … at +<s>s)
    // isi pal se gini jati hain.
    const attemptStartedAt = Date.now();

    // --- v2.48.70 + hotfix: NEW DOWNLOAD HELPERS ---
    // Zero-click: record start (must be engine source, not manual/button/menu).
    try {
      this._downloadHelpers.zeroClick.recordZeroClickStart(task.taskId || task.videoId || null, 'engine');
    } catch (e) {}
    // Timing gate: check if download may proceed (render complete, claimed url, etc.)
    try {
      const timingGate = this._downloadHelpers.timing.downloadTimingGate({
        taskKey: task.taskId || task.videoId || null,
        renderCompletedAt: task.renderCompletedAt || null,
        sessionStartedAt: this._sessionStartedAt,
        claimedUrl: task.completedVideoUrl || task.backendVideoUrl || null,
        now: Date.now()
      });
      if (timingGate.action === 'wait') {
        this.log(`[ROOT] [Prompt #${n}] timing gate: ${timingGate.detail} — waiting for render/claimed URL`, 'info');
      }
    } catch (e) {}
    // Store render completion time for timing tracking
    try {
      this._downloadHelpers.route.storeRenderCompleted(task.taskKey || task.videoId || null, task.renderCompletedAt || Date.now());
    } catch (e) {}

    // v2.48.31 (MINT): is round ki render→save khidki ke liye
    // enhanced capture chalu (sirf video) — band bulane wale
    // ke finally me hota hai (_mintEndWatch).
    // v2.48.33 (ZEROCLICK): captureKey bhi saath — mint
    // template is task ke naam seekha jayega.
    if (!isImage) this._mintBeginWatch(captureKey);

    // v2.48.37 (TEMPLATE-STATE LINE): har attempt ke
    // aaghaz par ek line — is pal replay routes (B/C) ke
    // liye template maujood hai ya nahi (learned /
    // candidate / none) aur teacher langar maloom hai
    // ya nahi. ZEROCLICK4 me ROOT routes khamoshi se
    // skip ho gaye the; ab log khud wajah batayega.
    if (!isImage) {
      try {
        const cap = this.netCapture;
        if (cap && typeof cap.templateState === 'function') {
          const st = cap.templateState();
          this.log(`[ROOT] [Prompt #${n}] template-state template=${st.template} teacherUrl=${st.teacherUrl}`, 'info');
        }
      } catch (e) {}
    }

    if (!fs.existsSync(downloadFolder)) {
      try { fs.mkdirSync(downloadFolder, { recursive: true }); } catch (e) {}
    }

    // Ranneeti-tartib ka ek-matra sach (tests wahi jaanchte hain):
    task.downloadRouteOrder = downloadRouteOrder.DOWNLOAD_ROUTE_ORDER.slice();

    // --- v2.48.35 (VERBATIM PROBE — OBSERVE-ONLY): quick-
    // check se bhi PEHLE, session me had ek dafa, sirf tab
    // jab template maujood ho aur ye task teacher na ho.
    // Seekhi hui mint-call hu-bahu bhejna hai (koi tabdeeli
    // nahi — ZEROCLICK2 ne sabit kiya badalne ko id hai hi
    // nahi); jawab se kuch save/claim NAHI hota, sirf ek
    // [ZEROCLICK] verbatim-probe line banti hai. Andar se
    // har nakami nigal li jati hai — tartib nahi rukti. ---
    if (!isImage) {
      try { await this._verbatimReplayProbe(task, captureKey); } catch (e) {}
    }

    // --- v2.48.41 (MAIN-PAGE HARVEST PACK) →
    // v2.48.44 (HEADLESS HARVEST PACK — OWNER SEQUENCE
    // 2026-11-04) → v2.48.72 (EDITOR-HARVEST PRIMARY —
    // OWNER DECISION 2026-11-09: editor-pabandi owner
    // ne khud uthayi; tartib editor-harvest →
    // mainpage-harvest → grid-replay hui aur headless
    // attempt kram se bahar hua) → v2.48.73 (EDITOR-
    // ONLY — OWNER DECISION 2026-11-09: tartib ab
    // SIRF editor-harvest hai; mainpage/grid bhi kram
    // se bahar — neeche wala .44/.72 bayan tareekh
    // hai, maujooda tartib downloadRouteOrder.js me
    // hai aur neeche wala loop usi array par chalta
    // hai): VIDEO ki tartib .44 ke waqt teen qadam thi:
    //   1. headless-harvest — profile ki copy par
    //      BILKUL BINA-WINDOW Chrome me is task ka
    //      editor + us ki playback stream (probe-first:
    //      copied session qubool na ho to editor khule
    //      baghair haar; screen par kuch aa hi nahi
    //      sakta kyunki window banti hi nahi);
    //   2. mainpage-harvest — main page ki apni stream
    //      kitab se is task ki file: pehle se pakdi hui
    //      mukammal body, warna usi page ke apne JS
    //      context se poora fetch (range jawab ko bhi
    //      wahi poora karta hai);
    //   3. grid-replay — seekhi hui mint call ka hu-bahu
    //      (verbatim) replay grid page se; teacher ka
    //      address aaye to fetch kabhi nahi.
    // Teeno haar jayein to attempt EMAANDARI se FAIL
    // hota hai — editor-harvest (visible + background),
    // replay-context, direct-viewer, ⋮ menu, blob-
    // harvest, backend-fetch aur tile-src sab video ke
    // attempt path se HAMESHA ke liye bahar hain; koi
    // fallback kuch nahi dikhata. Retry rounds phir yahi
    // teen raaste aazmate hain. Prompt dobara KABHI
    // submit nahi hota (sacred rule barkarar).
    // IMAGE tasks is hisse ko chhute hi nahi — un ki
    // purani tartib (backend → kram-bandhan → readiness
    // → tile-src → native UI) neeche bilkul waisi hi
    // chalti hai. ---
    if (!isImage) {
      // v2.48.50 (MEGA PACK): is attempt ke hisaab ki
      // safaai — completion cycles / element outcomes /
      // probe haal / race dawa har attempt me taaza.
      task._mpCompleteCycles = 0;
      task._mediaElOutcomes = {};
      task._headlessProbeState = null;
      task._raceActive = false;
      task._raceWonBy = null;
      task._raceSavedUrl = null;
      // v2.48.52 (ROUTE 1A PACK): netload ka hisaab
      // bhi har attempt me taaza — koshish-ginti
      // (budget 2), protocol-nakam URLon ki fehrist
      // (usi attempt me dobara nahi), aur summary ke
      // liye darj anjaam.
      task._mpNetloadCount = 0;
      task._mpNetloadProtoFailed = new Set();
      task._mpNetloadOutcome = null;
      // Items 16 + 4: attempt ka aakhri hisaab EK jagah
      // se — census line, cycles line (sirf jab cycles
      // chale hon), aur attempt-summary line. Har
      // video wapsi (jeet ya haar) yahi se guzregi.
      const finishVideoAttempt = (result) => {
        try {
          this.log(`[Prompt #${n}] Download census (whole run): ${JSON.stringify(this.netCapture.downloadCensusSummary()).slice(0, 400)}`, 'info');
        } catch (e) {}
        try {
          if ((task._mpCompleteCycles || 0) > 0) {
            this.log(`[ROOT] mainpage-complete cycles=${task._mpCompleteCycles}`, 'info');
          }
        } catch (e) {}
        try {
          let best = 0;
          let bestUrl = null;
          const capNow = this.netCapture;
          if (capNow && typeof capNow.mainpageEntries === 'function') {
            for (const e of capNow.mainpageEntries()) {
              if (!e || !e.url) continue;
              const t = Math.max(e.bytes || 0, e.declared || 0, e.knownTotal || 0);
              if (t > best) { best = t; bestUrl = e.url; }
            }
          }
          let assembled = 0;
          if (bestUrl && capNow && typeof capNow.mainpageBodyForUrl === 'function') {
            const held = capNow.mainpageBodyForUrl(bestUrl);
            if (held && held.buffer) assembled = held.buffer.length;
          }
          const outcomes = task._mediaElOutcomes || {};
          this.log(attemptSummaryLogLine({
            task: task.promptIndex,
            best,
            assembled,
            mediaTile: outcomes.tile,
            mediaHidden: outcomes.hidden,
            probe: task._headlessProbeState,
            race: task._raceWonBy || null,
            // v2.48.52 (ROUTE 1A PACK): is attempt ke
            // netload anjaam ki ek-jhalak.
            netload: task._mpNetloadOutcome || null,
            saved: !!task.mediaSaved
          }), 'info');
        } catch (e) {}
        return result;
      };
      // Item 6 (PIPELINING): is task ki completion ke
      // dauraan agli pending task ki tile viewport me
      // chalti rahe — us ki stream peeche se aati
      // rahegi (run me ek dafa, best-effort).
      try { await this._primeNextPendingTile(task); } catch (e) {}
      // v2.48.50 (item 7 — ROUTE RACE) [v2.48.72 me
      // SUPERSEDED — race khatam, tartib ab sequential
      // editor → mainpage hai; neeche wala bayan sirf
      // tareekh hai]: headless aur
      // mainpage ab EK SAATH chalte hain (pehle
      // tartib thi: headless, phir mainpage). Jo rasta
      // pehle saveGuard-passing save kare wahi jeet-ta
      // hai — dawa (claim) _saveBufferForTask ke race
      // darwaze par bandhta hai, is liye dusri copy
      // kabhi nahi banti; haarne wala saaf rukta hai
      // (headless session finally me band hota hai,
      // media drives mediaSaved par poll rok deti
      // hain, watch loop bhi wahi dekhta hai). Route
      // ORDER ka dawa (downloadRouteOrder) nahi badla
      // — ye sirf intezaar ka overlap hai, dawa hamesha
      // sequential save par bandhta hai. Grid-replay
      // dono ke baad hi aata hai, pehle jaisa.
      // v2.48.70 (REAL FIX): backend-fetch FIRST — the fastest route.
      // The backend link arrives via network capture (_onBackendMediaBound)
      // and _fetchBackendAndSave runs immediately. If it succeeded, skip
      // the headless+mainpage race entirely. If it failed, the in-flight
      // guard is cleared (see _fetchBackendAndSave) so we can retry here.
      if (task.backendVideoUrl && !task.mediaSaved && !this.isStopping) {
        try {
          const okBackend = await this._tryBackendDownload(task, downloadFolder, settings, attempts);
          if (okBackend) return finishVideoAttempt({ ok: true, strategy: 'backend-fetch', attempts });
        } catch (e) {
          attempts.push({ strategy: 'backend-fetch', ok: false, note: 'backend route hit a problem — the editor route ran next' });
        }
        if (task.mediaSaved) return finishVideoAttempt({ ok: true, strategy: 'backend-fetch', attempts });
      }
      // v2.48.73 (EDITOR-ONLY — OWNER DECISION
      // 2026-11-09): tartib ab task.downloadRouteOrder
      // par chalti hai aur us me SIRF 'editor-harvest'
      // hai — grid par video ka backend link milta hi
      // nahi (owner ki sabit haqeeqat), is liye final
      // video ka download sirf editor khol kar hoga.
      // Loop order-array se chalta hai taaki wahid
      // sachai (downloadRouteOrder.js) hi faisla kare
      // kaunsi ranneeti chalegi; baaki raaston ka code
      // repo me rehta hai lekin kram me na hone se
      // kabhi aazmaya nahi jata. Editor rounds (round-
      // cap khaata) haar jayein to task apni wajah ke
      // saath PARK hota hai aur recovery bhi yahi
      // editor rasta dobara aazmati hai (recovery isi
      // function se guzarti hai). Prompt KABHI dobara
      // submit nahi hota (sacred rule barkarar).
      for (const route of (task.downloadRouteOrder || [])) {
        if (task.mediaSaved || this.isStopping) break;
        if (route === 'editor-harvest') {
          try {
            await this._tryEditorHarvest(task, downloadFolder, settings, attempts, captureKey, tileIndexHint);
          } catch (e) {
            attempts.push({ strategy: 'editor-harvest', ok: false, note: 'the editor harvest hit a problem — no other download route runs; the task parks for the bounded editor retry rounds / recovery' });
          }
        } else if (route === 'mainpage-harvest') {
          try {
            await this._tryMainpageHarvest(task, downloadFolder, settings, attempts, captureKey, tileIndexHint);
          } catch (e) {
            attempts.push({ strategy: 'mainpage-harvest', ok: false, note: 'the main-page harvest hit a problem — the next route in the order ran next' });
          } finally {
            // v2.48.54 (fix 5 — hissa): mainpage marhala
            // khatam — is task ka hover isi pal chhodo.
            try { await this._exitOwnMainpageHover(task); } catch (e) {}
          }
        } else if (route === 'grid-replay') {
          try {
            const g = await this._tryGridReplay(task, downloadFolder, settings, attempts, captureKey, tileIndexHint);
            if (g && g.done) {
              // v2.48.42: is task ka download mukammal —
              // bandhan khidki band (exclusion hisaab ke
              // liye ye task ab 'baqi' nahi).
              try { if (typeof this.netCapture.mainpageMarkWindowDone === 'function') this.netCapture.mainpageMarkWindowDone(captureKey); } catch (e) {}
              return finishVideoAttempt({ ok: true, strategy: 'grid-replay', attempts });
            }
          } catch (e) {
            attempts.push({ strategy: 'grid-replay', ok: false, note: 'the grid replay hit a problem' });
          }
        }
        if (task.mediaSaved) {
          if (task._raceSavedUrl) task.completedVideoUrl = task._raceSavedUrl;
          const won = attempts.filter(a => a.ok).pop();
          return finishVideoAttempt({ ok: true, strategy: won ? won.strategy : route, attempts });
        }
      }
      // EMAANDAR FAIL: is ke baad koi rasta nahi bacha.
      this.log(`[ROOT] [Prompt #${n}] Download failed honestly: this video's editor playback stream did not produce its file, and the editor route is the only download route. The prompt was NOT resubmitted — the task parks for recovery, which retries the same editor route.`, 'warn');
      return finishVideoAttempt({ ok: false, attempts });
    }

    // --- IMAGE tasks ki purani tartib (v2.48.41 me
    // bilkul barkarar): backend pehle, phir kram-
    // bandhan, readiness, tile-src, native UI. Video
    // yahan kabhi nahi pahunchta (upar wapas ja chuka
    // hota hai), is liye menuFirstTried hamesha false
    // hai — image ka menu roop native UI ke andar apni
    // purani jagah chalta hai. ---
    let menuFirstTried = false;

    try {
      const okBackend = await this._tryBackendDownload(task, downloadFolder, settings, attempts);
      if (okBackend) return { ok: true, strategy: 'backend-fetch', attempts };
    } catch (e) {
      attempts.push({ strategy: 'backend-fetch', ok: false, note: 'a problem came up in the backend route — the remaining routes will be tried' });
    }
    if (task.mediaSaved) return { ok: true, strategy: 'backend-fetch', attempts };

    // --- backend KRAM se bandhan (v2.48.15 se yahan, pehle) ---
    if (captureKey) {
      let ord = null;
      try { ord = this.netCapture.claimByOrder(captureKey, Date.now()); } catch (e) { ord = null; }
      if (ord && ord.url) {
        task.backendVideoUrl = ord.url;
        task.backendUrlVia = 'order';
        this._captureTasks.set(captureKey, task);
        task._backendCtx = { downloadFolder, settings };
        const ok = await this._kickBackendFetch(task, task._backendCtx);
        attempts.push({ strategy: 'backend-fetch', ok: !!ok, note: ok ? 'the unbound link found on the backend was treated as this task\'s by sequence order and saved' : `the backend link bound by sequence could not be fetched${this._fetchSummary(task) ? ` — ${this._fetchSummary(task)}` : ''}` });
        if (ok) return { ok: true, strategy: 'backend-fetch', attempts };
      }
    }

    // v2.41.0 (Fix list C, item 4): MEDIA READINESS — on a busy
    // multi-task page the tile's media may not have loaded yet, and
    // every strategy below then fails for that one reason (proven
    // from the 2026-10-27 Activity records). Bounded (~25s) inside
    // this round's 150s guard; skipped entirely when a captured URL
    // already exists; never fails the round. (v2.48.15: ab ye
    // backend raaston ke BAAD chalti hai — upar dekho.)
    const readiness = await this._awaitTileMediaReady(task, tileIndexHint, isImage, captureKey, n);

    // --- v2.48.21: READINESS KE BAAD BACKEND EK AUR BAAR ---
    // TEST498 (v2.48.20, log-sabit): render-complete wala
    // batchexecute jawab attempt shuru hone ke ~1 second BAAD
    // mukammal hota hai — attempt ke pehle backend check ko
    // 'koi link nahi' milta hai, phir tile-readiness usi
    // bandhan par ~1s me bahar aati hai ('the backend link was
    // bound'), lekin tartib aage badh kar tile/menu par chali
    // jati thi aur bandha hua link kabhi fetch hi nahi hota
    // tha. Ab readiness ke foran baad backend wala rasta ek
    // aur baar chalega — bandha link hoga to wahi fetch hoga,
    // tile/menu sirf tab jab ye bhi na bane.
    if (!task.mediaSaved && captureKey) {
      let boundNow = null;
      try { boundNow = this.netCapture.urlForKey(captureKey); } catch (e) { boundNow = null; }
      if (boundNow && boundNow.url) {
        try {
          const okBackend2 = await this._tryBackendDownload(task, downloadFolder, settings, attempts);
          if (okBackend2) return { ok: true, strategy: 'backend-fetch', attempts };
        } catch (e) {
          attempts.push({ strategy: 'backend-fetch', ok: false, note: 'the backend route retried after the tile wait hit a problem — the remaining routes will be tried' });
        }
        if (task.mediaSaved) return { ok: true, strategy: 'backend-fetch', attempts };
      }
    }

    // --- v2.47.4 FAST PATH (owner-approved): ye sirf ek IZAAFA ---
    // pehli koshish hai, purani tartib ki JAGAH nahi. Readiness
    // poll ne tile ka % gaya + us ka apna src maujood dekha to
    // wahi src yahin, isi pal fetch hota hai — capture binding
    // aur strategy tartib ke intezaar ke bina. Usool barkarar:
    // (1) fetch SIRF task ki apni claimed tile ke src se
    // (_isTaskOwnUrl ka darwaza yahan bhi, aur
    // downloadFromCapturedStream ke andar bhi);
    // (2) complete SIRF save + ffprobe verify ke baad (wahi
    // _saveBufferForTask wala rasta);
    // (3) capture ka bandha signed link pehle se maujood ho
    // (backendVideoUrl / turant fetch chal raha ho) to fast
    // path haath hi nahi lagata — usi ki tarjeeh barkarar;
    // (4) MANDATORY FALLBACK (owner): fast koshish kisi bhi
    // mor par fail ho — src bad/empty nikle, fetch error aaye,
    // file verify na ho — to neeche wali PURANI tartib
    // (Ranneeti 1-4) bilkul pehle ki tarah chalti hai, aur
    // park (needs_check) sirf us ke baad hota hai. Prompt
    // dobara submit KABHI nahi hota — ye sab sirf download hai.
    if (readiness && readiness.fastUrl && !task.mediaSaved && !task.backendVideoUrl && !task._backendFetchPromise) {
      const fastUrl = readiness.fastUrl;
      if (!this._isTaskOwnUrl(task, fastUrl)) {
        attempts.push({ strategy: 'tile-src-fast', ok: false, note: 'a URL was found on the tile but it was not proven to be this task\'s own (old, or another tile\'s) — stopped for safety; the full existing routes now run as fallback' });
        this.log(`[Prompt #${n}] The fast route's URL was not proven to be this task's own — it was NOT downloaded, for safety. The full existing routes will run now.`, 'warn');
      } else {
        // Cross-match ki kitab-bandhi, Ranneeti 2 wali hi: tile
        // ka URL network par bhi dekha gaya ho to pehchan dono
        // taraf se bandh do.
        let crossMatched = false;
        if (captureKey && this.netCapture) {
          try {
            if (this.netCapture.hasSighting(fastUrl)) {
              crossMatched = !!this.netCapture.claimByCurrentSrc(captureKey, fastUrl, Date.now());
            }
          } catch (e) {}
        }
        task.completedVideoUrl = fastUrl;
        this.log(`[Prompt #${n}] Fast route: the tile's % is gone and its own link is in hand — fetching the file right now${crossMatched ? ' (the link is also confirmed from the backend)' : ''}, without waiting for the binding routes…`, 'info');
        let okFast = false;
        try { okFast = await this.downloadFromCapturedStream(task, downloadFolder, settings); } catch (e) { okFast = false; }
        attempts.push({ strategy: 'tile-src-fast', ok: !!(okFast || task.mediaSaved), note: okFast ? 'the file was saved by the fast route (the tile\'s own src, fetched the moment its % finished)' : `the fast fetch could not save the file${this._fetchSummary(task) ? ` — ${this._fetchSummary(task)}` : ''} — the full existing routes now run as fallback` });
        if (okFast || task.mediaSaved) return { ok: true, strategy: 'tile-src-fast', attempts };
        this.log(`[Prompt #${n}] The fast route did not save the file — now running the full existing download routes for the same video (fallback).`, 'warn');
      }
    }

    // --- Ranneeti 2: apni stream / tile ka src ---
    // (Ranneeti 1 — backend — v2.48.15 se is function ke AAGHAZ
    // me chalti hai, tile-readiness se bhi pehle.)
    let url = (task.completedVideoUrl && task.completedVideoUrl !== task.backendVideoUrl && this._isTaskOwnUrl(task, task.completedVideoUrl))
      ? task.completedVideoUrl : null;
    let via = url ? 'stream found earlier' : null;
    if (!url) {
      const got = await this._extractTileMediaUrlDetailed(task, tileIndexHint, isImage);
      if (got && got.url) {
        if (this._isTaskOwnUrl(task, got.url)) {
          url = got.url;
          via = got.via;
        } else {
          attempts.push({ strategy: 'tile-src', ok: false, note: 'a URL was found on the tile but it was not proven to be this task\'s own (old, or another tile\'s) — stopped for safety' });
          this.log(`[Prompt #${n}] The URL found on the tile was not proven to be this task's own — it was NOT downloaded, for safety.`, 'warn');
        }
      }
    }
    if (url) {
      // v2.8.0 cross-match: tile par mila URL agar network capture
      // ne bhi dekha tha, to use is task se bandh do — pehchan dono
      // taraf se pakki (backend ki pushti), fetch backend ginata hai.
      let crossMatched = false;
      if (captureKey) {
        try {
          if (this.netCapture.hasSighting(url)) {
            crossMatched = !!this.netCapture.claimByCurrentSrc(captureKey, url, Date.now());
          }
        } catch (e) {}
      }
      task.completedVideoUrl = url;
      const fromBuffer = !!(this.capturedVideoBuffers && this.capturedVideoBuffers.has(url));
      const stratName = crossMatched ? 'backend-fetch' : (fromBuffer ? 'captured-stream' : 'tile-src');
      this.log(`[Prompt #${n}] Download strategy: ${crossMatched ? 'the tile\'s URL has been confirmed from the backend (network)' : (fromBuffer ? 'video stream captured in between' : `URL found from the tile's element (${via})`)} — downloading the file…`, 'info');
      let ok = false;
      try { ok = await this.downloadFromCapturedStream(task, downloadFolder, settings); } catch (e) { ok = false; }
      attempts.push({ strategy: stratName, ok, note: ok ? 'the file was saved by this route' : `the URL was the task's own, but the file data could not be made${this._fetchSummary(task) ? ` — ${this._fetchSummary(task)}` : ''}` });
      if (ok) return { ok: true, strategy: stratName, attempts };
    } else {
      this.log(`[Prompt #${n}] No media URL of this task was found on the tile — direct stream download is not possible; now the remaining routes will be tried.`, 'warn');
      attempts.push({ strategy: 'tile-src', ok: false, note: 'no media URL was found on the tile' });
    }

    // --- Ranneeti 4: native UI (ab sirf editor roop — ⋮ menu
    // v2.48.27 se round ke aaghaz me menu-first ho chuka hai;
    // image tasks par menu roop yahin purani tartib se chalta hai) ---
    // (Kram-bandhan bhi v2.48.15 se aaghaz me chalta hai.)
    const okNative = await this._downloadViaNativeUi(task, downloadFolder, settings, tileIndexHint, attempts, { skipMenuForm: menuFirstTried });
    if (okNative) {
      const won = attempts.filter(a => a.ok).pop();
      // v2.48.24: file UI raaste se aayi — poori run ke media
      // responses ki ginti is pal sahi hai (asal download sameet).
      try {
        this.log(`[Prompt #${n}] Download census (whole run): ${JSON.stringify(this.netCapture.downloadCensusSummary()).slice(0, 400)}`, 'info');
      } catch (e) {}
      return { ok: true, strategy: won ? won.strategy : 'native', attempts };
    }
    return { ok: false, attempts };
  }

  /**
   * v2.7.0 — SIRF-DOWNLOAD DOBARA KOSHISH (download-retry): prompt
   * DOBARA submit NAHI hota, credits NAHI katte. Usi account ke khule
   * project me task ki tile dobara dhoondhi jati hai (pehle bandhi
   * hui pehchan/fingerprint se, phir poora grid scan karke) aur mil
   * jaye to download ki saari ranneetiyan sirf usi tile par chalti
   * hain. Lautta hai: { status:'downloaded' } |
   * { status:'tile-missing' } | { status:'download-failed', attempts }.
   */
  async retryDownloadForTask(task, downloadFolder, settings) {
    const isImage = !!(settings && settings.type === 'Image');
    const n = (task.promptIndex || 0) + 1;
    // v2.48.63 (Item C — DRAIN STAND-DOWN): test-flag
    // se park hui task ke liye retry bhi yahin khamoshi
    // se settle — na grid scan, na strategies. Pool
    // 'skipped' natije ko is run ke liye settle samajh
    // kar task ko pending + needs_check hi rehne deta
    // hai (agla Resume bina flag ke sirf download
    // karega). .62 me ye raasta har dafa poora scan +
    // downloadTaskMedia tak jata tha aur wahi SKIPPED
    // line baar baar dohraya karta tha.
    if (skipFirstDownloadApplies(settings, task)) {
      return { status: 'skipped', attempts: [] };
    }
    // v2.8.0: sabse pehle BACKEND — isi session me is task se bandha
    // link ho (ya kataar/kram se bandh sake) to bina grid khoje
    // seedha fetch. Register bhi yahi hota hai, taaki is pal ke baad
    // aane wala binding turant fetch chala sake.
    this.registerBackendTask(task, downloadFolder, settings);
    const backendAttempts = [];
    let backendOk = false;
    // v2.48.41 (MAIN-PAGE HARVEST PACK): VIDEO ke liye
    // backend-first qadam bhi gaya — bandha hua backend
    // link (lh3 wala, hamesha HTML poision sabit hua)
    // fetch karna video ke raaston me nahi raha; video
    // ki retry wahi tartib chalati hai jo cascade ki hai
    // (v2.48.44 se: headless-harvest + mainpage-harvest
    // + grid-replay — neeche downloadTaskMedia se). Register
    // barkarar hai — bandhan ki kitab mainpage-harvest
    // ke ummeedwaaron ko bandhti hai. IMAGE ke liye
    // backend-first bilkul pehle jaisa hai.
    if (isImage) {
      try { backendOk = await this._tryBackendDownload(task, downloadFolder, settings, backendAttempts); } catch (e) { backendOk = false; }
    }
    if (backendOk || task.mediaSaved) {
      task.downloadAttempts = (task.downloadAttempts || []).concat(backendAttempts);
      return { status: 'downloaded', attempts: task.downloadAttempts };
    }
    try { await this._returnToProjectGrid(); } catch (e) {}

    let found = false;
    if (task.lockedTileFingerprint) {
      const idx = await this._resolveTileIndexByFingerprint(task.lockedTileFingerprint);
      if (idx >= 0) { task.tileIndex = idx; found = true; }
    }
    if (!found) {
      found = await this._recoveryScanForTask(task, isImage);
    }
    if (!found) {
      // Virtualized grid: sweep karke ek aur baar talaash.
      await this._sweepGridScroll();
      if (task.lockedTileFingerprint) {
        const idx = await this._resolveTileIndexByFingerprint(task.lockedTileFingerprint);
        if (idx >= 0) { task.tileIndex = idx; found = true; }
      }
      if (!found) found = await this._recoveryScanForTask(task, isImage);
    }
    if (!found) {
      this.log(`[Prompt #${n}] Download-retry: even after scanning the whole project, this prompt's tile was NOT found — the video does not seem to exist there.`, 'warn');
      return { status: 'tile-missing', attempts: backendAttempts.concat(task.downloadAttempts || []) };
    }
    this.log(`[Prompt #${n}] Download-retry: the tile was found in the project — now ONLY all the download strategies will run again (no new submit/charge).`, 'info');
    // v2.48.0 (deep-audit fix #3): rounds spent from HERE draw on
    // the DRAIN channel's own persisted budget — never the monitor's.
    const prevChannel = this._downloadChannel;
    this._downloadChannel = 'drain';
    let dl;
    try {
      dl = await this.downloadTaskMedia(task, downloadFolder, settings, task.tileIndex);
    } finally {
      this._downloadChannel = prevChannel || 'monitor';
    }
    // v2.48.63 (Item C): skipped bhi apni pehchan ke
    // saath upar jata hai — 'download-failed' me ghul
    // jaye to pool use dobara koshish ke qabil samajh
    // kar cycle chala deta tha.
    if (dl.skipped) {
      return { status: 'skipped', attempts: backendAttempts.concat(dl.attempts) };
    }
    return dl.ok
      ? { status: 'downloaded', attempts: backendAttempts.concat(dl.attempts) }
      // v2.31.3: capped = the persisted download budget (this
      // channel's) is spent — the pool must not loop another retry
      // this run; the task simply stays parked (pending + needs_check).
      : { status: 'download-failed', capped: !!dl.capped, attempts: backendAttempts.concat(dl.attempts) };
  }

  /**
   * Monitor submitted tasks until each renders complete, then download.
   *
   * AUDIT FIX #6: a task may only CLAIM a tile whose text/aria matches the
   * task's own prompt (and which no other task has claimed). V2's fallbacks
   * ("any generating tile", "any ready tile after 20s") are removed: if a
   * task's tile cannot be identified, the task FAILS with a clear reason
   * instead of ever completing with another prompt's video.
   */
  async waitForAccountTasks(accountTasks, downloadFolder, settings, returnOnAnyComplete = false) {
    if (!accountTasks || accountTasks.length === 0) return;

    const isImageMode = (settings.type === 'Image');
    const pendingTasks = accountTasks.filter(t => !t.downloaded);
    if (pendingTasks.length === 0) return;

    // v2.4.0: remember the window — _recoveryScanForTask reads it to
    // decide whether a weak-text task is this account's ONLY
    // in-flight task (the order/timing fallback's fence).
    this._monitorTasks = accountTasks;

    // v2.8.0: BACKEND capture ke liye har task register karo — kisi
    // task ka link backend se bandhte hi turant fetch yahin se shuru
    // hoga (tile ke "ready" hone ka intezaar kiye bina).
    for (const t of pendingTasks) {
      try { this.registerBackendTask(t, downloadFolder, settings); } catch (e) {}
    }

    this.log(`[${this.currentAccount.name}] has ${pendingTasks.length} videos generating — watching the render progress…`, 'info');

    // v2.1.0: the base video wait went 360s -> 600s (owner's PC test:
    // Flow was simply slow; the old budget failed a paid render).
    const maxWaitSec = (isImageMode ? 120 : 600) + (pendingTasks.length * 60);
    let effectiveMaxWaitSec = maxWaitSec;
    let timeoutSweeps = 0; // final recovery sweeps already spent at the deadline
    const startMonitorTime = Date.now();
    // v2.1.0 stall recovery windows (engine/stallWatch.js decides; the
    // state lives on each task so it survives across the pool's
    // repeated monitor calls for the same window).
    const stallTimeoutSec = this.stallTimeoutSecOverride || (isImageMode ? 45 : 120);
    const recoveryWindowMs = (this.recoveryWindowSecOverride || (isImageMode ? 120 : 600)) * 1000;
    // v2.30.3 (no-hang watchdog): an ABSOLUTE per-task cap, counted
    // from the task's own submission time. The deadline + recovery
    // machinery below is generous by design (a paid render gets
    // every chance), but each of its extensions used to be able to
    // outlive the others — most concretely, a task parked "in
    // recovery" while any sibling tile showed progress could extend
    // the monitor forever (the owner's stuck "Working..." run,
    // 2026-10-25). The cap sits above every legitimate path —
    // base wait + one full recovery window + 10 minutes of slack
    // for downloads/sweeps — and any task still unsettled past it
    // is failed with a concrete watchdog reason in the per-task
    // loop, so this monitor ALWAYS returns.
    // v2.48.0 (deep-audit fix #6): the stacked budgets are now
    // themselves capped — no per-task attempt on one account may
    // exceed 1200s (20 minutes) in total, however the layers add
    // up. On 31 Oct a single bad window's tasks stretched to the
    // full stacked ~31 minutes; 20 minutes is still far above any
    // legitimate render+download path.
    const stackedCapSec = maxWaitSec + (recoveryWindowMs / 1000) + 600;
    const absoluteCapSec = Math.min(stackedCapSec, 1200);
    let lastReportedPercentage = {};
    // v1.5.0: when a task ends in failure, free its tile claim so a
    // sibling task is never starved by a dead binding.
    const releaseTileClaim = (task) => {
      if (task && task.lockedTileFingerprint && this.claimedTileFingerprints) {
        this.claimedTileFingerprints.delete(task.lockedTileFingerprint);
      }
    };
    // v1.1: monitor errors used to be swallowed by `catch { break; }`,
    // which turned any persistent page error into a silent infinite
    // "Running…" from the pool's point of view. Count consecutive errors;
    // a few are tolerated (page hiccups), then fail VISIBLY.
    let consecutiveMonitorErrors = 0;

    while (!this.isStopping) {
      const allSettled = accountTasks.every(t => t.downloaded || t.completed);
      if (allSettled) {
        // v2.7.0 (FIX 2): ye line ab SACH bolti hai — ginati sirf un
        // tasks ki hai jinki file asal me save hui (task.mediaSaved).
        // Pehle ye line tab bhi chhap jati thi jab SAare download fail
        // hue hon, kyunki fail hue task bhi settled mark ke liye
        // downloaded=true lete hain — owner ke burst run me ek bhi
        // file save nahi hui thi aur line ne "saare download bhi ho
        // gaye" keh diya tha.
        const savedCount = accountTasks.filter(t => t.mediaSaved).length;
        const failedTasks = accountTasks.filter(t => t.failed);
        if (failedTasks.length === 0 && savedCount === accountTasks.length) {
          this.log(`[${this.currentAccount.name}] ke saare ${accountTasks.length} video ban gaye aur download bhi ho gaye!`, 'success');
        } else {
          const stages = [...new Set(failedTasks.map(t => t.failureStage || 'generation'))].join(', ');
          this.log(`Work finished on [${this.currentAccount.name}]: out of ${accountTasks.length} prompts, ${savedCount} videos were downloaded, ${failedTasks.length} failed${failedTasks.length ? ` (stage: ${stages})` : ''} — the reasons for the failed ones are in the lines above.`, failedTasks.length ? 'warn' : 'success');
        }
        break;
      }

      if (returnOnAnyComplete && accountTasks.some(t => t.downloaded || t.completed)) {
        break;
      }

      if ((Date.now() - startMonitorTime) > effectiveMaxWaitSec * 1000) {
        // v2.1.0: the deadline is NOT an instant fail any more. First a
        // FINAL recovery sweep per unfinished task (scroll the grid so
        // virtualized tiles mount, then the fingerprint scan). If any
        // task's own tile turns up, the deadline extends by 3 minutes
        // and normal monitoring resumes — a paid render is only failed
        // when two full sweeps found nothing for it.
        let rescuedAny = false;
        if (timeoutSweeps < 2) {
          timeoutSweeps++;
          this.log(`[${this.currentAccount.name}] The render time has become long — before failing, scanning the whole project once properly (sweep ${timeoutSweeps}/2)…`, 'warn');
          for (const t of accountTasks) {
            if (t.downloaded || t.completed) continue;
            if (stallWatch.isInRecovery(t)) continue; // its own window governs it
            const found = await this._recoveryScanForTask(t, isImageMode);
            if (found) rescuedAny = true;
          }
        }
        if (rescuedAny) {
          effectiveMaxWaitSec = ((Date.now() - startMonitorTime) / 1000) + 180;
          this.log(`Some tiles were found in the scan — the wait has been extended by 3 more minutes for their download.`, 'info');
        } else {
          // Fail whatever is unfinished — EXCEPT a task still inside
          // its own stall-recovery window: its give-up moment (in the
          // per-task loop below) is what ends it, never this deadline.
          // v2.30.3: the exemption now also requires time LEFT in the
          // window (recoveryRemainingMs) — an expired recovery no
          // longer keeps this branch extending the deadline by +30s
          // per pass forever; the task is failed right here with the
          // recovery-exhausted reason.
          let stillRecovering = false;
          let failedAny = false;
          for (const t of accountTasks) {
            if (t.downloaded || t.completed) continue;
            const wasInRecovery = stallWatch.isInRecovery(t);
            if (wasInRecovery && stallWatch.recoveryRemainingMs(t, Date.now(), recoveryWindowMs) > 0) { stillRecovering = true; continue; }
            failedAny = true;
            t.completed = true;
            t.downloaded = true;
            t.failed = true;
            releaseTileClaim(t);
            stallWatch.clearStall(t);
            this.onTaskFailed(t, wasInRecovery
              ? `Generation tile for this prompt could not be identified even after ${stallWatch.formatDuration(recoveryWindowMs / 1000)} of in-project recovery search (dropped or rejected by Flow)`
              : 'Render timed out before this prompt\'s video could be identified and downloaded (in-project recovery search included)');
            this.onVideoCompleted({
              id: t.videoId,
              prompt: t.promptText,
              accountName: this.currentAccount.name,
              status: 'Failed (Render timeout)',
              filePath: null,
              error: 'Render timed out',
              type: settings.type,
              timestamp: new Date().toLocaleTimeString()
            });
          }
          if (failedAny) {
            this.log(`[${this.currentAccount.name}] The render wait is over — the incomplete work has been marked failed (nothing was found in the recovery scan either).`, 'warn');
          }
          if (stillRecovering) {
            effectiveMaxWaitSec = ((Date.now() - startMonitorTime) / 1000) + 30;
          } else {
            break;
          }
        }
      }

      // v2.48.8: 1-second monitor poll (was 2s) — a finished video
      // is noticed up to a second sooner; the render wait itself
      // is Flow's, this only removes the app's own notice lag.
      await sleep(1000);

      if (!this.page || this.page.isClosed()) break;

      try {
        await this.dismissAnyBlockingOverlays();

        // v1.5.0: Flow virtualizes long grids — only mounted tiles are
        // readable. Park the grid scroll at the top (newest tiles live
        // there) before every read so fresh tiles are always in the DOM.
        try {
          await this.page.evaluate(() => {
            const tile = document.querySelector('flow-grid-tile-container');
            let el = tile ? tile.parentElement : null;
            for (let i = 0; i < 8 && el; i++) {
              if (el.scrollHeight > el.clientHeight + 10) { el.scrollTop = 0; break; }
              el = el.parentElement;
            }
          });
        } catch (e) {}

        const isCaptcha = await this.page.evaluate(() => {
          const bodyText = (document.body.innerText || '').toLowerCase();
          const url = window.location.href.toLowerCase();
          return url.includes('challenge') || url.includes('recaptcha') || bodyText.includes("verify it's you") || bodyText.includes('unusual traffic');
        });
        if (isCaptcha) {
          this.log('Google has shown a human verification (Captcha)! Solve it in the open Chrome window — generation will stay paused until then.', 'error', { isCaptcha: true });
        }

        const canvasState = await this.page.evaluate((refusalSources) => {
          // v2.9.0: failure ki pehchan failureEvidence ke pakke
          // refusal JUMLO se hi hogi (sources bahar se aate hain —
          // ek hi source of truth). Ye helper tile ke chrome text me
          // mile asal jumle ka chhota snippet lautata hai, warna null.
          const findRefusalSnippet = (scanText) => {
            const flat = String(scanText || '').replace(/\s/g, ' ');
            const low = flat.toLowerCase();
            for (const src of refusalSources) {
              const m = low.match(new RegExp(src, 'i'));
              if (!m) continue;
              let a = Math.max(0, m.index - 90);
              for (let i = m.index - 1; i >= a; i--) { if ('.!?\n'.includes(flat[i])) { a = i + 1; break; } }
              let b = Math.min(flat.length, m.index + m[0].length + 90);
              for (let i = m.index + m[0].length; i < b; i++) { if ('.!?'.includes(flat[i])) { b = i + 1; break; } }
              return flat.slice(a, b).replace(/\s+/g, ' ').trim();
            }
            return null;
          };
          // Icon-font ke ligature naam (movie_filter_auto, play_circle
          // jaisi snake_case tokens) content NAHI hain — scan se pehle
          // saaf, warna koi icon naam hi jhootha saboot ban sakta hai.
          const stripLigs = (t) => String(t || '').replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, ' ');
          const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
          if (containers.length > 0) {
            return containers.map((c, idx) => {
              const promptAria = (c.getAttribute('aria-label') || '').toLowerCase().trim();
              const rawText = (c.innerText || '').toLowerCase();
              // v1.5.0: failure phrases are scanned ONLY in the tile's
              // CHROME text — the tile text with its own prompt (the
              // aria) stripped out. A prompt that merely contains words
              // like "blocked" or "failed" must not mark its OWN tile
              // as failed (a real multi-prompt error source), and any
              // icon (play/download/etc.) must not count as an "error
              // icon" — only a mat-icon whose ligature name IS an
              // error/warning glyph counts.
              const text = promptAria ? rawText.split(promptAria).join(' ') : rawText;
              const pctMatch = text.match(/\b(\d{1,2})%/);
              const hasErrorIcon = Array.from(c.querySelectorAll('mat-icon, i'))
                .some(el => /^(error|warning|priority_high|report)$/.test((el.textContent || '').trim().toLowerCase()));
              // v2.9.0: fail ka saboot SIRF is tile ke chrome text se —
              // ligature-saaf scan text par pakka refusal jumla mile
              // tabhi 'safety' fail; akela 'safety'/'policy'/'violat'
              // shabd (jo pehle bare substring se trigger hota tha)
              // kabhi kaafi nahi. Error icon akela mile to tile fail
              // hai lekin wajah apusht — kind 'tile-error' (blanket
              // "Safety Filter" label NAHI, warna failover use
              // prompt-level bana kar retry hamesha ke liye band kar
              // deta tha).
              const scanText = stripLigs(text);
              const refusalSnippet = findRefusalSnippet(scanText);
              const isUnusualActivity = /\bunusual activity\b/.test(scanText) || /\bnot been charged\b/.test(scanText);
              const isSafetyFailed = !!refusalSnippet;
              const failureKind = refusalSnippet ? 'safety' : (isUnusualActivity ? 'unusual' : (hasErrorIcon ? 'tile-error' : null));
              const isFailed = isSafetyFailed || isUnusualActivity || hasErrorIcon;

              const isGenerating = !!pctMatch;
              const hasVideo = !!c.querySelector('video');
              const hasImg = !!c.querySelector('img');
              const hasResolutionBadge = text.includes('360p') || text.includes('720p') || text.includes('1080p') || text.includes('100%') || text.includes('2k') || text.includes('4k');
              const hasDuration = /\b0:0\d\b|\b\d+s\b/.test(text);
              const isReady = !isGenerating && !isFailed && (hasResolutionBadge || hasVideo || hasDuration || hasImg);

              return {
                tileIndex: idx,
                promptAria,
                text,
                percentage: pctMatch ? `${pctMatch[1]}%` : (isReady ? '100%' : null),
                isGenerating,
                isFailed,
                isSafetyFailed,
                failureKind,
                failureReason: refusalSnippet,
                isUnusualActivity,
                isReady
              };
            });
          }

          const hotbarBtns = Array.from(document.querySelectorAll('button[flowhotbarbutton][aria-label="More options"]'));
          return hotbarBtns.map((btn, idx) => {
            let cur = btn;
            for (let s = 0; s < 8; s++) {
              if (!cur.parentElement) break;
              cur = cur.parentElement;
              if (cur.className && typeof cur.className === 'string' && (cur.className.includes('card') || cur.className.includes('tile') || cur.className.includes('node') || cur.className.includes('virtual-item'))) {
                break;
              }
            }

            const cardAria = (cur.getAttribute('aria-label') || '').toLowerCase().trim();
            const rawCardText = (cur.innerText || '').toLowerCase();
            // v1.5.0: same chrome-text rule as the grid branch — the
            // card's own prompt text never counts as a failure signal.
            // v2.9.0: failure evidence yahan bhi wahi sakht usool —
            // ligature-saaf text par pakka refusal jumla hi 'safety'
            // fail hai; error icon akela 'tile-error'.
            const text = cardAria ? rawCardText.split(cardAria).join(' ') : rawCardText;
            const pctMatch = text.match(/\b(\d{1,2})%/);
            const hasErrorIcon = Array.from(cur.querySelectorAll('mat-icon, i'))
              .some(el => /^(error|warning|priority_high|report)$/.test((el.textContent || '').trim().toLowerCase()));
            const scanText = stripLigs(text);
            const refusalSnippet = findRefusalSnippet(scanText);
            const isUnusualActivity = /\bunusual activity\b/.test(scanText) || /\bnot been charged\b/.test(scanText);
            const isSafetyFailed = !!refusalSnippet;
            const failureKind = refusalSnippet ? 'safety' : (isUnusualActivity ? 'unusual' : (hasErrorIcon ? 'tile-error' : null));
            const isFailed = isSafetyFailed || isUnusualActivity || hasErrorIcon;
            const isGenerating = !!pctMatch;
            const hasResolutionBadge = text.includes('360p') || text.includes('720p') || text.includes('1080p') || text.includes('100%');
            return {
              tileIndex: idx,
              promptAria: (cur.getAttribute('aria-label') || '').toLowerCase().trim(),
              text,
              percentage: pctMatch ? `${pctMatch[1]}%` : (hasResolutionBadge ? '100%' : null),
              isGenerating,
              isFailed,
              isSafetyFailed,
              failureKind,
              failureReason: refusalSnippet,
              isUnusualActivity,
              isReady: !isGenerating && !isFailed && hasResolutionBadge
            };
          });
        }, failureEvidence.patternSources());

        // v1.6.1 self-heal: an empty canvas on an EDITOR page means a
        // download excursion never made it back to the grid. Go back
        // and re-read next poll instead of idling on the editor until
        // the render timeout (the owner's "stuck here" photo).
        if (canvasState.length === 0 && this.page.url().includes('/edit/')) {
          this.log('The page is stuck inside Flow\'s editor, not on the project\'s tile area (grid) — going back to the grid…', 'warn');
          await this._returnToProjectGrid();
          continue;
        }

        // v2.9.0 — MODAL SCAN KA DAYRA BADLA (yahi scan owner ke
        // 2026-10-15 wale jhoothe fail ki jad tha): pehle ye scan
        // page ke KISI BHI dialog ke POORE text par bare substring
        // ('policy'/'terms'/'safety') se trigger hota tha — aur
        // credit check khud account/credits wala [role="dialog"]
        // panel kholta hai, jiske footer me "Privacy Policy / Terms
        // of Service" hota hai. Nateeja: panel ka pehla 150-char kata
        // majmua "Google Safety Filter: …" ban kar har fresh task ko
        // maar deta tha. AB: (1) account/credits chrome hamesha
        // skip; (2) trigger sirf failureEvidence ka asal refusal
        // JUMLA; (3) wajah wahi jumle ka snippet — poora dialog kabhi
        // nahi; (4) neeche ye sirf EK task (sabse purana
        // not-yet-generating) ko fail karega, poori kataar ko nahi.
        const modalViolation = await this.page.evaluate(({ refusalSources, chromeMarkers }) => {
          const stripLigs = (t) => String(t || '').replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, ' ');
          const findRefusalSnippet = (raw) => {
            const flat = String(raw || '').replace(/\s/g, ' ');
            const low = flat.toLowerCase();
            for (const src of refusalSources) {
              const m = low.match(new RegExp(src, 'i'));
              if (!m) continue;
              let a = Math.max(0, m.index - 90);
              for (let i = m.index - 1; i >= a; i--) { if ('.!?\n'.includes(flat[i])) { a = i + 1; break; } }
              let b = Math.min(flat.length, m.index + m[0].length + 90);
              for (let i = m.index + m[0].length; i < b; i++) { if ('.!?'.includes(flat[i])) { b = i + 1; break; } }
              return flat.slice(a, b).replace(/\s+/g, ' ').trim();
            }
            return null;
          };
          const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], div[role="alertdialog"], mwc-dialog, div[role="alert"], [class*="snackbar"], mwc-snackbar'));
          for (const d of dialogs) {
            if (!(d.offsetWidth > 0 || d.offsetHeight > 0)) continue;
            const raw = d.innerText || '';
            const low = raw.toLowerCase();
            if (chromeMarkers.some(mk => low.includes(mk))) continue;
            if (d.closest && d.closest('flow-account-panel, [class*="account-panel"], [class*="profile-menu"]')) continue;
            const snippet = findRefusalSnippet(stripLigs(raw));
            if (!snippet) continue;
            const btn = Array.from(d.querySelectorAll('button, [role="button"]')).find(b => {
              const bTxt = (b.innerText || '').toLowerCase().trim();
              return bTxt.includes('got it') || bTxt.includes('dismiss') || bTxt === 'ok' || bTxt.includes('close');
            });
            if (btn) try { btn.click(); } catch (e) {}
            return snippet.substring(0, 150);
          }
          return null;
        }, { refusalSources: failureEvidence.patternSources(), chromeMarkers: failureEvidence.ACCOUNT_CHROME_MARKERS });

        // Ek refusal dialog = EK prompt ki wajah (submissions
        // tartib se hote hain). Sirf sabse purana aisa task jo abhi
        // generating dekha hi nahi gaya — wahi is poll ka shikaar
        // banta hai; baaki tasks apni tile ke saboot par jeete hain.
        const modalVictim = modalViolation
          ? (accountTasks.find(t => !t.completed && !t.failed && !t.downloaded && !t.wasObservedGenerating) || null)
          : null;

        // The full canvas read succeeded — reset the monitor error streak.
        consecutiveMonitorErrors = 0;

        // v1.5.0: identity assignment for this poll. Each tile gets a
        // fingerprint + significant-word set; assignTiles binds every
        // pending task to AT MOST one tile (and every tile to at most
        // one task) using locked fingerprints first and strict scored
        // claims second — see tileIdentity.js for the rules. This
        // replaces the old index-tracking + two-word guessing that
        // scrambled multi-prompt runs.
        const tileDescriptors = canvasState.map(t => ({
          ...t,
          fingerprint: tileIdentity.tileFingerprint(t.promptAria, t.text),
          words: tileIdentity.significantWords(`${t.promptAria} ${t.text}`)
        }));
        const taskViews = accountTasks.filter(t => !t.downloaded).map(t => {
          if (!t._promptWords) t._promptWords = tileIdentity.significantWords(t.promptText || '');
          if (!t._preExistingFp) t._preExistingFp = new Set(t.preExistingFingerprints || []);
          return {
            key: t.videoId,
            promptWords: t._promptWords,
            preExistingFingerprints: t._preExistingFp,
            lockedFingerprint: t.lockedTileFingerprint || null
          };
        });
        const tileAssignments = tileIdentity.assignTiles(taskViews, tileDescriptors, this.claimedTileFingerprints);

        if (modalViolation && modalVictim) {
          try { await this.page.keyboard.press('Escape'); } catch (e) {}
          try {
            await this.page.evaluate(() => {
              const clearBtn = document.querySelector('button.clear-button, button[aria-label="Clear prompt"]');
              if (clearBtn) { try { clearBtn.click(); } catch (e) {} }
              const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
              if (el) { el.textContent = ''; }
            });
          } catch (e) {}
        }

        for (const task of accountTasks) {
          if (task.downloaded) continue;

          const elapsedSec = (Date.now() - task.startTime) / 1000;
          let bestTile = null;

          // v2.30.3 (no-hang watchdog): absolute per-task cap (see
          // absoluteCapSec above). Whatever state this task is in —
          // tile generating, tile missing, recovery, captcha wait —
          // past the cap it is failed HERE with a concrete reason,
          // so no combination of the monitor's generous extensions
          // can keep the run (or the app's card) waiting forever.
          // A task whose download is actively running is exempt:
          // the download guard already bounds that step.
          if (elapsedSec > absoluteCapSec && !task._downloadInProgress) {
            task.completed = true;
            task.downloaded = true;
            task.failed = true;
            releaseTileClaim(task);
            stallWatch.clearStall(task);
            const capReason = `Generation watchdog: this prompt was still unfinished ${stallWatch.formatDuration(elapsedSec)} after it was submitted — past the absolute per-task limit of ${stallWatch.formatDuration(absoluteCapSec)}. It has been marked failed so the queue can end; the video may still exist in the Flow project.`;
            this.log(`[Prompt #${task.promptIndex + 1}] ${capReason}`, 'warn');
            this.onTaskFailed(task, capReason);
            this.onVideoCompleted({
              id: task.videoId,
              prompt: task.promptText,
              accountName: this.currentAccount.name,
              status: 'Failed (Watchdog timeout)',
              filePath: null,
              error: 'Watchdog timeout',
              type: settings.type,
              timestamp: new Date().toLocaleTimeString()
            });
            continue;
          }

          if (modalViolation && modalVictim && task === modalVictim) {
            task.completed = true;
            task.downloaded = true;
            task.failed = true;
            releaseTileClaim(task);
            this.onTaskFailed(task, `Google Safety Filter: ${modalViolation}`);
            this.log(`[Prompt #${task.promptIndex + 1}] A Google safety policy message came up: "${modalViolation}" — this prompt will not move ahead; the queue is moving on.`, 'warn');
            this.onVideoCompleted({
              id: task.videoId,
              prompt: task.promptText,
              accountName: this.currentAccount.name,
              status: `Policy Violation: ${modalViolation}`,
              filePath: null,
              error: modalViolation,
              type: settings.type,
              timestamp: new Date().toLocaleTimeString()
            });
            continue;
          }

          // v1.5.0: this task's tile for this poll comes ONLY from the
          // fingerprint assignment computed above — never from a
          // remembered DOM index (indices shift as new tiles arrive)
          // and never from a loose text guess.
          bestTile = tileAssignments.get(task.videoId) || null;
          if (bestTile && task.lockedTileFingerprint !== bestTile.fingerprint) {
            task.lockedTileFingerprint = bestTile.fingerprint;
            this.claimedTileFingerprints.add(bestTile.fingerprint);
          }

          // v2.4.0 — TILE STATE + HEARTBEAT (fixes 2 & 3: the owner's
          // 4-minute silence). Every poll, each unfinished task's tile
          // condition is CLASSIFIED (engine/tileState.js): generating /
          // failed / ready / absent. A state CHANGE is narrated at
          // once (and reported via onTaskHeartbeat so Activity gets
          // the story with its stage) — a Flow-side failure is seen
          // the poll it appears, never after the 10-minute window.
          // An UNCHANGED state still earns a heartbeat line every
          // heartbeatEveryMs (30s), so while a paid render is in
          // flight the log can never sit silent, and the owner can
          // always see how long it has been and what is being waited
          // for. Separately, ~60s of total absence triggers one early
          // recovery scan instead of waiting for the 120s stall mark.
          {
            const nowMs = Date.now();
            const stateNow = tileState.classifyTaskTile({
              tile: bestTile,
              anyGenerating: tileDescriptors.some(t => t.isGenerating)
            });
            const facts = {
              promptIndex: task.promptIndex,
              elapsedSec,
              percentage: bestTile ? bestTile.percentage : null
            };
            if (task._tileState !== stateNow) {
              const prevState = task._tileState;
              task._tileState = stateNow;
              task._lastHeartbeatAt = nowMs;
              if (stateNow !== 'absent' || prevState !== undefined) {
                this.log(tileState.describeState(stateNow, facts), stateNow === 'failed' ? 'warn' : 'info');
              }
              try {
                this.onTaskHeartbeat(task, {
                  state: stateNow,
                  elapsedSec: Math.round(elapsedSec),
                  percentage: facts.percentage,
                  accountName: this.currentAccount.name
                });
              } catch (e) {}
            } else if (nowMs - (task._lastHeartbeatAt || 0) >= this.heartbeatEveryMs) {
              task._lastHeartbeatAt = nowMs;
              this.log(tileState.describeState(stateNow, facts), 'info');
              try {
                this.onVideoProgress({ id: task.videoId, elapsedSec: Math.round(elapsedSec), state: stateNow });
              } catch (e) {}
            }
            if (stateNow === 'absent' && elapsedSec >= 60 && !task._absentWarned) {
              task._absentWarned = true;
              task._lastRecoveryScanAt = nowMs;
              await this._recoveryScanForTask(task, isImageMode);
            }
          }

          // v2.6.0 — RENDER PROGRESS WATCHDOG (engine/
          // renderProgressWatch.js). A third kind of stall the older
          // guards cannot see: the tile EXISTS and is 'generating',
          // but its percentage never moves (owner's PC, 2026-10-14:
          // both renders sat at 1% for 8+ minutes in Background
          // mode). The watchdog fires ONCE per frozen episode — a Log
          // line here, an Activity entry (stage 'render-stall') via
          // onRenderStall — naming the last percentage, how long it
          // has been frozen and the plain possible causes. It fails
          // nothing by itself: the monitor deadline + final recovery
          // sweeps further down remain what ends a truly dead render,
          // and this frozen time counts toward that same wait.
          {
            // stateNow lives inside the heartbeat block above, so the
            // state is classified again here (pure + cheap).
            const wdState = tileState.classifyTaskTile({
              tile: bestTile,
              anyGenerating: tileDescriptors.some(t => t.isGenerating)
            });
            const progAct = renderProgressWatch.observeProgress(task, {
              state: wdState,
              percentage: bestTile ? bestTile.percentage : null,
              tileText: bestTile ? bestTile.text : '',
              now: Date.now(),
              stallAfterMs: this.progressStallAfterMs,
              frozenAfterMs: this.progressFrozenAfterMs
            });
            if (progAct.type === 'frozen') {
              // v2.48.0 (deep-audit fix #5): ESCALATION — the tile
              // exists but its % has not moved for the full frozen
              // budget (6 min). No more silent waiting: the task is
              // failed HERE with the distinct 'render-frozen' reason
              // (failover.js classifies it account-level, so the pool
              // may try the prompt on another account). The guards
              // below skip a completed task, so the rest of this
              // iteration is inert for it.
              const frozenReason = `Render frozen (render-frozen): this prompt's tile is present in the project, but its progress has not moved at all for ${stallWatch.formatDuration(progAct.stuckForSec)}${progAct.lastPct ? ` (stuck at ${progAct.lastPct})` : ''} — the render is treated as dead on this account and the task has been marked failed instead of waiting silently for the overall limit.`;
              task.completed = true;
              task.downloaded = true;
              task.failed = true;
              releaseTileClaim(task);
              stallWatch.clearStall(task);
              renderProgressWatch.clearProgress(task);
              this.log(`[Prompt #${task.promptIndex + 1}] ${frozenReason}`, 'warn');
              this.onTaskFailed(task, frozenReason);
              this.onVideoCompleted({
                id: task.videoId,
                prompt: task.promptText,
                accountName: this.currentAccount.name,
                status: 'Failed (Render frozen)',
                filePath: null,
                error: 'Render frozen',
                type: settings.type,
                timestamp: new Date().toLocaleTimeString()
              });
            }
            if (progAct.type === 'stalled') {
              const frozenFor = stallWatch.formatDuration(progAct.stuckForSec);
              const pctNote = progAct.lastPct
                ? `Last progress: ${progAct.lastPct} — no change since then.`
                : 'Flow has not shown any progress % yet.';
              const hintNote = progAct.queueHint ? ` ${progAct.queueHint}.` : '';
              this.log(`[Prompt #${task.promptIndex + 1}] ⚠ The render seems STUCK — progress has not moved at all for ${frozenFor}. ${pctNote}${hintNote} The task is NOT being failed yet: the total wait clock is running; if progress starts moving again, everything will move ahead as usual.`, 'warn');
              try {
                this.onRenderStall(task, {
                  accountName: this.currentAccount.name,
                  elapsedSec: Math.round(elapsedSec),
                  stuckForSec: progAct.stuckForSec,
                  lastPct: progAct.lastPct,
                  queueHint: progAct.queueHint,
                  background: !!this.headless || !!this.headlessGeneration
                });
              } catch (e) {}
            }
          }

          // v2.1.0 — STALL RECOVERY (replaces the old anti-stall hard
          // fail). A submitted render whose tile has not been identified
          // is NOT failed on the first stall sighting: its credits are
          // already charged, and on the owner's PC (2026-10-14) the
          // tile simply arrived late — the old guard failed the paid
          // render outright. stallWatch decides (its state lives on the
          // task, so it survives the pool's repeated monitor calls):
          // recovery start -> periodic grid sweeps + fingerprint scans
          // + progress logs -> recovered, or give-up only after the
          // whole recovery window passes with no tile.
          const anyActive = tileDescriptors.some(t => t.isGenerating);
          {
            const stallAct = stallWatch.observeStall(task, {
              stalled: !bestTile && !anyActive && elapsedSec > stallTimeoutSec && !task.wasObservedGenerating && !task.completed,
              hasTile: !!bestTile,
              now: Date.now(),
              recoveryWindowMs,
              progressEveryMs: 30000
            });
            if (stallAct.type === 'recovery-started') {
              this.log(`[Prompt #${task.promptIndex + 1}] This prompt's video has not appeared in Flow yet — but its credits have already been deducted, so it is NOT being failed. Searching for the tile in the project and waiting will continue (at most ~${Math.round(recoveryWindowMs / 60000)} minutes).`, 'warn');
              task._lastRecoveryScanAt = Date.now();
              await this._recoveryScanForTask(task, isImageMode);
              try {
                this.onTaskStalled(task, {
                  accountName: this.currentAccount.name,
                  recoveryWindowSec: Math.round(recoveryWindowMs / 1000),
                  stallAfterSec: Math.round(elapsedSec)
                });
              } catch (e) {}
            } else if (stallAct.type === 'recovery-progress') {
              if (stallAct.logDue) {
                this.log(`[Prompt #${task.promptIndex + 1}] The render wait is continuing — ${stallWatch.formatDuration(stallAct.recoveryForSec)} have passed, the tile has still not been found. The project is being scanned again; since credits were already deducted, the wait will be completed fully.`, 'info');
              }
              if (!task._lastRecoveryScanAt || Date.now() - task._lastRecoveryScanAt >= this.recoveryScanEveryMs) {
                task._lastRecoveryScanAt = Date.now();
                await this._recoveryScanForTask(task, isImageMode);
              }
            } else if (stallAct.type === 'recovered') {
              this.log(`[Prompt #${task.promptIndex + 1}] Tile found! The render is visible again (after a wait of ${stallWatch.formatDuration(stallAct.recoveryForSec)}) — its further progress will now be watched.`, 'success');
            } else if (stallAct.type === 'give-up') {
              this.log(`[Prompt #${task.promptIndex + 1}] Even after the full recovery attempt (${stallWatch.formatDuration(stallAct.recoveryForSec)}), this prompt's tile was not found in the Flow project — Flow may have dropped or rejected the render. The task is being marked failed.`, 'warn');
              task.completed = true;
              task.downloaded = true;
              task.failed = true;
              releaseTileClaim(task);
              stallWatch.clearStall(task);
              this.onTaskFailed(task, `Generation tile for this prompt could not be identified even after ${stallWatch.formatDuration(recoveryWindowMs / 1000)} of in-project recovery search (dropped or rejected by Flow)`);
              this.onVideoCompleted({
                id: task.videoId,
                prompt: task.promptText,
                accountName: this.currentAccount.name,
                status: 'Failed (Dropped by Flow)',
                filePath: null,
                error: 'Generation tile not created',
                type: settings.type,
                timestamp: new Date().toLocaleTimeString()
              });
              continue;
            }
          }

          if (bestTile) {
            this.claimedTileIndices.add(bestTile.tileIndex); // legacy bookkeeping only
            if (bestTile.isGenerating) {
              task.wasObservedGenerating = true;
            }

            if (bestTile.isFailed) {
              const isUnusual = bestTile.isUnusualActivity || (bestTile.text && bestTile.text.includes('unusual activity'));

              if (isUnusual && !task.unusualActivityRetried) {
                task.unusualActivityRetried = true;
                this.log(`[Prompt #${task.promptIndex + 1}] Google Flow gave an "unusual activity" message — waiting 8 seconds and trying the tile again…`, 'warn');
                await sleep(8000);

                // v1.7.0: locate by fingerprint-first resolver, and
                // NEVER fall back to "the first button on the tile" —
                // that mystery click could hit download/edit/menu and
                // corrupt the run (or worse). Only a clearly-labelled
                // retry/regenerate button may be clicked.
                const retryIdx = await this._resolveTileIndexForTask(task, bestTile.tileIndex);
                const retried = await this.page.evaluate(({ idx }) => {
                  const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
                  const container = (typeof idx === 'number' && containers[idx]) ? containers[idx] : null;
                  if (!container) return false;
                  const btns = Array.from(container.querySelectorAll('button'));
                  const retryBtn = btns.find(b => {
                    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                    const txt = (b.innerText || '').toLowerCase();
                    return aria.includes('retry') || aria.includes('regenerate') || aria.includes('refresh') ||
                      txt.includes('refresh') || txt.includes('replay') || txt.includes('autorenew');
                  });
                  if (retryBtn) {
                    retryBtn.click();
                    return true;
                  }
                  return false;
                }, { idx: retryIdx });

                if (retried) {
                  this.log(`[Prompt #${task.promptIndex + 1}] Pressed the Retry button on the tile — now waiting for the render again…`, 'info');
                  await sleep(3000);
                  continue;
                }
              }

              task.completed = true;
              task.downloaded = true;
              task.failed = true;
              releaseTileClaim(task);
              // v2.9.0: wajah ka dayra tile tak bandha hai —
              //  · refusal jumla sabit hua (failureKind 'safety') to
              //    wajah wahi ASAL jumla hai (label ke saath, taaki
              //    failover use prompt-level pehchane);
              //  · sirf error icon mila (wajah apusht) to imaandaar
              //    wording — blanket "Google Safety / Policy Filter"
              //    NAHI, kyunki wo label is fail ko prompt-level bana
              //    kar dobara koshish hamesha ke liye band kar deta
              //    tha, jabke ye fail generation-level rehna chahiye.
              const failureReason = isUnusual
                ? 'Google Flow: Unusual Activity (Cooldown / Delay required)'
                : (bestTile.failureKind === 'safety' && bestTile.failureReason)
                  ? `Google Safety Filter: ${bestTile.failureReason}`
                  : 'Flow showed an error on the tile, but no clear reason sentence was found on the tile';
              if (isUnusual) task.status = 'Unusual Activity';

              this.onTaskFailed(task, failureReason);
              this.log(`[Prompt #${task.promptIndex + 1}] ${failureReason}. Advancing queue cleanly...`, 'warn');

              try {
                await this.page.keyboard.press('Escape');
                await this.page.evaluate(() => {
                  const btns = Array.from(document.querySelectorAll('button'));
                  const dismiss = btns.find(b => {
                    const t = (b.innerText || '').toLowerCase();
                    return t.includes('got it') || t.includes('dismiss') || t.includes('close') || t.includes('ok');
                  });
                  if (dismiss) dismiss.click();
                  const el = ((() => { const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]')); const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true'); const pool = ed.length ? ed : all; const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); }); const list = vis.length ? vis : pool; if (!list.length) return null; const named = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || '')); if (named) return named; return list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]; })());
                  if (el) { el.textContent = ''; }
                });
              } catch (e) {}

              this.onVideoCompleted({
                id: task.videoId,
                prompt: task.promptText,
                accountName: this.currentAccount.name,
                status: failureReason,
                filePath: null,
                error: failureReason,
                type: settings.type,
                timestamp: new Date().toLocaleTimeString()
              });
              continue;
            }

            if (bestTile.percentage && bestTile.isGenerating) {
              if (lastReportedPercentage[task.videoId] !== bestTile.percentage) {
                lastReportedPercentage[task.videoId] = bestTile.percentage;
                // v2.7.0 (FIX 3): yahan ki purani "Video ban raha hai:
                // X%…" wali LOG line band kar di gayi hai — progress ki
                // EK hi awaaz rahegi (upar wali tileState narration /
                // heartbeat). Owner ke log me har % update DO lines me
                // aa raha tha. onVideoProgress (UI ke liye) barkarar hai.
                this.onVideoProgress({
                  id: task.videoId,
                  percentage: bestTile.percentage,
                  prompt: task.promptText,
                  accountName: this.currentAccount.name,
                  elapsedSec: elapsedSec
                });
              }
              // v2.48.50 (item 5 — RENDER-TIME PRE-BIND):
              // tile ki apni stream render ke dauraan hi
              // is duration ke floor tak pahunch jaye to
              // use is task ke naam pehle se bandha
              // (pre-bound) darj kar do — render-complete
              // par completion usi par foran shuru hoga,
              // nayi hover watch ke intezaar ke baghair.
              // Ye sirf ek NISHAN hai
              // (task._preboundMainpageUrl) — claim,
              // bandhan ka faisla aur saveGuard ke
              // darwaze bilkul nahi badalte; buildCandidates
              // use tile-jaisa mazboot ummeedwaar manta
              // hai. Ek task par sirf ek dafa.
              if (!task._preboundMainpageUrl && !task.mediaSaved) {
                try {
                  const tileUrl = bestTile.mediaUrl || bestTile.videoSrc || null;
                  if (tileUrl && networkCapture.isGooglevideoPlaybackUrl(tileUrl)
                    && this.netCapture && typeof this.netCapture.mainpageEntries === 'function') {
                    const ent = this.netCapture.mainpageEntries().find(e => e && e.url === tileUrl);
                    const tot = ent ? Math.max(ent.bytes || 0, ent.declared || 0, ent.knownTotal || 0) : 0;
                    const floor = downloadFetch.minBytesForDuration(settings && settings.duration);
                    if (ent && tot >= floor) {
                      task._preboundMainpageUrl = tileUrl;
                      this.log(`[ROOT] mainpage-prebind total=${Math.floor(tot)}`, 'info');
                    }
                  }
                } catch (e) {}
              }
            }

            // True completion: percentage gone AND a video/badge is present,
            // and the task was observed generating or 25s+ elapsed.
            if (bestTile.isReady && (task.wasObservedGenerating || elapsedSec >= 25)) {
              task.completed = true;
              // v2.48.26 (FAST-DL): the render→save gap is measured
              // from THIS moment, and the blob harvest anchors its
              // freshness on it (see blobHarvest.freshnessCutoff).
              if (!task.renderCompletedAt) {
                task.renderCompletedAt = Date.now();
                // v2.48.37: capture ko render-poora khabar —
                // session watch me round ke bahar seekha gaya
                // template isi task ke naam hoga (nisbat ka
                // sab se taza langar).
                try {
                  if (this.netCapture && typeof this.netCapture.noteRenderCompleted === 'function') {
                    this.netCapture.noteRenderCompleted(task.captureKey || task.videoId || null);
                  }
                } catch (e) {}
              }
              this.onVideoProgress({
                id: task.videoId,
                state: 'downloading',
                prompt: task.promptText,
                accountName: this.currentAccount.name,
                elapsedSec: elapsedSec
              });

              // v2.48.3 (4-Slot Sliding Window + Safe Download):
              // Capture target media URL and session cookies/User-Agent immediately while page is available
              let targetUrl = task.completedVideoUrl || task.backendVideoUrl || bestTile.mediaUrl || bestTile.videoSrc;
              const urlAlreadyKnown = !!targetUrl;
              if (!targetUrl && this.page && !this.page.isClosed()) {
                try {
                  const extracted = await this._extractTileMediaUrlDetailed(task, bestTile.tileIndex, !!(settings && settings.type === 'Image'));
                  if (extracted && extracted.url) targetUrl = extracted.url;
                } catch (e) {}
              }
              if (targetUrl) {
                task.completedVideoUrl = targetUrl;
              }

              // v2.48.7 — the owner's 5-SECOND RULE: when a video
              // reaches 100%, its download must start from the
              // direct backend link within about 5 seconds. So in
              // the sliding-window (defer) path, when the backend
              // link is ALREADY captured, hand the task to the
              // download queue IMMEDIATELY — no cookie/UA
              // pre-capture round trips on the worker first (the
              // download reads the session cookies itself at fetch
              // time if it needs them; the page is still open on
              // this same browser). Pre-capture still runs when
              // the URL had to be extracted fresh, and in the
              // single-task path.
              const skipPreCapture = returnOnAnyComplete && urlAlreadyKnown;
              if (!skipPreCapture && this.page && !this.page.isClosed()) {
                try {
                  const jar = new Map();
                  for (const scope of [null, targetUrl]) {
                    try {
                      const cs = scope ? await this.page.cookies(scope) : await this.page.cookies();
                      for (const c of cs || []) jar.set(`${c.name}@${c.domain || ''}`, c);
                    } catch (e) {}
                  }
                  task.preCapturedCookieHeader = [...jar.values()].map(c => `${c.name}=${c.value}`).join('; ');
                  task.preCapturedUserAgent = await this._realUserAgent();
                } catch (e) {}
              }

              if (task._backendFetchPromise && !task.mediaSaved && !returnOnAnyComplete) {
                // v2.48.6: in the sliding-window path the worker no
                // longer waits here (it used to hold the next
                // prompt for up to 3s per finished video) — the
                // background download pipeline gives the in-flight
                // backend fetch its window there, parallel to the
                // next render. Only the single-task path still
                // waits on the worker.
                try { await downloadGuard.withTimeout(task._backendFetchPromise, 120000, 'immediate backend fetch'); } catch (e) {}
              }
              if (task.mediaSaved) {
                this.log(`[Prompt #${task.promptIndex + 1}] The video has already been downloaded from the backend — no need for the remaining download attempts.`, 'success');
                if (returnOnAnyComplete) return;
                continue;
              }

              // v2.48.3: 4-SLOT SLIDING WINDOW PIPELINE
              // If there are more prompts waiting in queue (returnOnAnyComplete), hand off this completed video
              // to the sequential background download queue and return immediately so the worker submits the next prompt!
              if (returnOnAnyComplete) {
                task.completed = true;
                task.downloadEnqueued = true;
                task.deferredDownload = true;
                this.claimedTileIndices.add(bestTile.tileIndex);
                this.log(`[Prompt #${task.promptIndex + 1}] Video generated on [${this.currentAccount.name}] — handed to the background download queue so the next prompt can start immediately!`, 'success');
                try {
                  this.onTaskDownloadDeferred(task, {
                    targetUrl: task.completedVideoUrl,
                    cookieHeader: task.preCapturedCookieHeader,
                    userAgent: task.preCapturedUserAgent
                  });
                } catch (e) {}
                return;
              }
              this.log(`[Prompt #${task.promptIndex + 1}] The video has been generated on [${this.currentAccount.name}] — now it will be downloaded.`, 'success');

              // v2.8.0: download ab backend-first orchestrator hai
              // (downloadTaskMedia): sabse pehle network capture se
              // bandha backend link, phir task ki apni stream / tile
              // ka src, aakhir me Flow ke Download UI ke do roop
              // (⋮ menu ka "Download", editor ka "Download media") —
              // har koshish ki log line ke saath. (v1.7.0 ki
              // pehchan-hifazat barkarar: har ranneeti sirf is task
              // ki apni pehchan par.)
              let dl = { ok: false, attempts: [] };
              try {
                dl = await this.downloadTaskMedia(task, downloadFolder, settings, bestTile.tileIndex);
              } catch (dlErr) {
                const t = plainError.translateError(dlErr);
                this.log(`[Prompt #${task.promptIndex + 1}] A problem came up in the download attempt — ${t.plain}.`, 'warn', { rawError: t.raw });
              }

              if (dl.skipped) {
                // v2.48.62 (ZC30 TEST FLAG): render mukammal
                // hai, download jaan-boojh kar chhoda gaya —
                // task NA downloaded hai NA failed. Monitor
                // yahin settle karta hai (completed), aur
                // pool ki download-deferred kitab row ko
                // pending + needs_check park kar deti hai
                // (download-only Resume ke liye) — wahi
                // imaandaar haalat jo ek deferred download
                // ki hoti hai. onTaskFailed NAHI bulaya
                // jata: ye nakami hai hi nahi.
                task.completed = true;
                task.downloadSkipped = true;
                try {
                  this.onTaskDownloadDeferred(task, {
                    targetUrl: task.completedVideoUrl,
                    cookieHeader: task.preCapturedCookieHeader,
                    userAgent: task.preCapturedUserAgent
                  });
                } catch (e) {}
              } else if (!dl.ok && !task.downloaded) {
                task.downloaded = true;
                task.failed = true;
                // v2.7.0 (FIX 2): stage LAZMI hai — render pura hua
                // tha, sirf SAVE fail hua. Pool is stage ko dekh kar
                // task ko needs_check (sirf-download retry) banata
                // hai: prompt DOBARA submit NAHI hota, credits dobara
                // NAHI katte. (Pehle yahi fail failover/same-account
                // retry me ja kar charon prompts dobara fire kar deta
                // tha — owner ke credits do baar kate the.)
                task.failureStage = 'download';
                releaseTileClaim(task);
                this.onTaskFailed(task, 'Download failed: the video had been generated on Flow, but no download route could save its file — only the download will be retried; the prompt will NOT be submitted again');
                this.onVideoCompleted({
                  id: task.videoId,
                  prompt: task.promptText,
                  accountName: this.currentAccount.name,
                  status: 'Download failed',
                  filePath: null,
                  error: 'The video had been generated, but its file could not be saved — only the download will happen again.',
                  type: settings.type,
                  timestamp: new Date().toLocaleTimeString()
                });
              }

              if (task.downloaded || task.completed) {
                this.claimedTileIndices.add(bestTile.tileIndex);
              }

              if (returnOnAnyComplete && (task.downloaded || task.completed)) {
                return;
              }
            }
          }
        }
      } catch (e) {
        // v1.1: never swallow a monitor error silently. Tolerate up to 2
        // consecutive errors (the loop sleeps 2s at the top), then fail the
        // unfinished tasks with the concrete reason and stop monitoring —
        // the pool can then rotate/finish instead of hanging forever.
        consecutiveMonitorErrors++;
        if (consecutiveMonitorErrors < 3) {
          // v2.4.0: the raw JS error never stands alone in the log —
          // plain explanation visible, technical text in rawError
          // (Copy Log carries it for diagnosis).
          const t = plainError.translateError(e);
          this.log(`A small problem came up while watching the render — ${t.plain}. Watching again…`, 'warn', { rawError: t.raw });
          continue;
        }
        {
          const t = plainError.translateError(e);
          this.log(`Watching the render keeps failing — ${t.plain}. Marking the incomplete tasks as failed…`, 'error', { rawError: t.raw });
        }
        for (const t of accountTasks) {
          if (!t.downloaded && !t.completed) {
            t.completed = true;
            t.downloaded = true;
            t.failed = true;
            releaseTileClaim(t);
            this.onTaskFailed(t, `Render monitor error: ${e.message}`);
            this.onVideoCompleted({
              id: t.videoId,
              prompt: t.promptText,
              accountName: this.currentAccount.name,
              status: 'Failed (Monitor error)',
              filePath: null,
              error: `Render monitor error: ${e.message}`,
              type: settings.type,
              timestamp: new Date().toLocaleTimeString()
            });
          }
        }
        break;
      }
    }
  }
}

module.exports = { FlowAutomationEngine, mediaBodyState, mediaLoadLogLine, mediaLoadElementPick, attemptSummaryLogLine, netloadLogLine, netloadFailedLogLine, drainNetloadStream, projectIdOfUrl, parseGalleryDateTime, pickGalleryProject, galleryEntryDecision, recoveryEntryPlan, resolutionBtnSelected, resolutionStateSource, skipFirstDownloadApplies, passiveClaimApplies, resizeTriggerApplies, pointerTriggerApplies, belowfloorSampleDecision, belowfloorSampleName, failedVerificationSampleDecision, recoveryGalleryGuard, parseSettingsPill, settingsPillMismatch, omni12CreditsPerVideo, modelNameParts, matchModelOption };
