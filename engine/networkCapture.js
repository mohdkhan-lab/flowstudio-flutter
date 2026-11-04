'use strict';

const flowContent = require('./flowContent');
const mintWindow = require('./mintWindow');
const mintReplay = require('./mintReplay');
const saveGuard = require('./saveGuard');
const downloadFetch = require('./downloadFetch');

/**
 * FlowStudio Lite — NETWORK CAPTURE LAYER (v2.8.0).
 *
 * KYUN: v2.7.0 tak download Flow ke UI par nirbhar tha — tile ka
 * button, toolbar, menu. Owner ke PC par wo raaste baar-baar mare
 * (button ka roop badal jata hai, menu kabhi khulta hi nahi), jabke
 * video asal me Flow ke peeche ke hisse (backend/API) se aata hai.
 * Owner ka hukm (2026-10-14): "video banta hi backend sa direct
 * fetch karaka download ka la". Ye layer wahi karti hai: worker ke
 * page ki network khabar sunti hai, har generation ko uski
 * workflowId se pehchanti hai, aur jaise hi backend ke jawab me us
 * generation ka media link aata hai, use USI task se bandh deti hai
 * — engine usi pal seedha fetch kar deta hai. Koi button nahi, koi
 * menu nahi.
 *
 * PATTERNS KA SABOOT: ~/workspace/flowstudio-lite/FLOW-INSPECTION.md
 * hissa 1 (2026-10-14, asal page + asal JS bundle se VERIFIED):
 *   - API host: aisandbox-pa.googleapis.com (gRPC-style proto;
 *     FlowService.StreamGenerateContent streaming hai, GetWorkflow
 *     adi isi par hain) + streaming host
 *     aisandbox-pa-webchannel.clients6.google.com.
 *   - Har generation ki pehchan = workflowId.
 *   - Media = FIFE URLs: *.googleusercontent.com par, AKSAR BINA
 *     .mp4 extension ke, signed + jaldi expire — isliye milte hi
 *     turant fetch lazmi hai.
 * Isiliye neeche ke CAPTURE_PATTERNS me: API hosts ke saare
 * responses ki body scan hoti hai — JSON deep-walk KE SAATH raw text
 * scan bhi (grpc-web ke binary frames me URL/ID plain text ke roop
 * me dikh sakta hai; sirf JSON.parse par nirbhar nahi rehna).
 *
 * PEHCHAN (identity) ka tartib, mazboot se kamzor ki taraf:
 *   1. workflowId — submit ke aas-paas ke request/response se nikla
 *      ID jis task se bandha, usi ID ke saath aaya media URL usi
 *      task ka (sabse mazboot).
 *   2. Tile ke video currentSrc se cross-match — network par dekha
 *      hua bin-bandha URL jab kisi task ki apni tile par bhi dikhe.
 *   3. Kram (order) — sabse pehle intezaar kar rahe task ko sabse
 *      pehle mila bin-bandha URL, SIRF download ke pal par, aur
 *      SIRF usi task ko jo kataar me sabse aage hai.
 * Doubt ho to URL "unclaimed" rehta hai — galat task ko galat video
 * KABHI nahi (tile identity wali hifazat yahan bhi qaim hai). Ek URL
 * jo task ke submit se PEHLE dekha gaya ho, us task ko kabhi nahi
 * bandhta (purane projects ke links isi se bachte hain).
 *
 * Ye module aadha pure hai: ingest* functions ko request/response
 * ka saar (url, content-type, body buffer, samay) diya jata hai —
 * Puppeteer ki wiring sirf attach() me hai, taaki saari pehchan
 * wali logic bina browser ke test ho sake (tests/smoke.js).
 */

const CAPTURE_PATTERNS = {
  // --- FLOW-INSPECTION.md hissa 1 se VERIFIED ---
  apiHosts: ['aisandbox-pa.googleapis.com'],
  webchannelHosts: ['aisandbox-pa-webchannel.clients6.google.com'],
  // FIFE media host: is host ka koi bhi URL (subdomain koi bhi ho)
  // media candidate hai — extension hona zaroori NAHI.
  mediaHosts: ['googleusercontent.com'],
  // JSON/proto fields jinke andar generation ki pehchan (ID) aati hai.
  idFieldNames: ['workflowId', 'workflow_id', 'workflowID'],
  // --- Generic (Flow-specific nahi; har jagah ke media links) ---
  mediaExtensions: ['.mp4', '.webm', '.mov'],
  // --- v2.48.13: ACTIVE DIRECT-API POLL ke patterns ---
  // Page khud haal jaanne ke liye jo status-shaped calls karta hai
  // (GetWorkflow / List* / Search* / BatchGet*), unhi ka ASAL
  // request (URL + headers + body) capture yaad rakhta hai; engine
  // phir usi request ko page ke andar se baar-baar replay karke
  // backend ko SEEDHA poochhta hai — tile/DOM ka intezaar nahi.
  // Generate wali call (StreamGenerateContent) template KABHI nahi
  // banti (use replay karna doosri generation fire kar dega).
  statusMethodHints: ['getworkflow', 'getsceneworkflow', 'batchget', 'listworkflows', 'listuserworkflows', 'listprojectworkflows', 'searchprojectworkflows', 'searchuserworkflows', 'searchworkflows'],
  generateMethodHints: ['streamgeneratecontent'],
  // Replay me sirf yahi headers bheje jate hain (cookie page ke
  // fetch par credentials:'include' se khud lagti hai).
  replayHeaderNames: ['content-type', 'x-grpc-web', 'x-user-agent', 'authorization', 'x-goog-api-key', 'x-goog-authuser'],
  maxTemplateBodyBytes: 256 * 1024,
  // Latest-template fallback kitni purani ho sakti hai (project
  // khulne ki List call aur submit ke beech settings ka waqt
  // lagta hai; request ki shakal itni der me nahi badalti —
  // auth cookies me hoti hai, body me nahi).
  templateMaxAgeMs: 120000,
  // --- Haddein ---
  idMinLength: 6,
  maxBodyScanBytes: 8 * 1024 * 1024,
  // Submit se kitni der pehle aaya ID bhi usi submission ka mana ja
  // sakta hai (ghadi ki chhoti harkat / request pehle nikal jana).
  bindSlackMs: 5000
};

function urlPathLower(url) {
  try { return new URL(String(url || '')).pathname.toLowerCase(); } catch (e) { return String(url || '').toLowerCase(); }
}

/** Generation fire karne wali API call hai kya (template ke liye HARAM). */
function isGenerateApiUrl(url, patterns = CAPTURE_PATTERNS) {
  if (!isApiUrl(url, patterns)) return false;
  const p = urlPathLower(url);
  return patterns.generateMethodHints.some(h => p.includes(h));
}

/**
 * Haal-jaanch (status) wali API call hai kya — GetWorkflow, List,
 * Search ya BatchGet wali me se koi; generate wali kabhi nahi.
 */
function isStatusApiUrl(url, patterns = CAPTURE_PATTERNS) {
  if (!isApiUrl(url, patterns)) return false;
  if (isGenerateApiUrl(url, patterns)) return false;
  const p = urlPathLower(url);
  return patterns.statusMethodHints.some(h => p.includes(h));
}

/** Replay ke liye sirf whitelist headers (chhote naam, string values). */
function pickReplayHeaders(headers, patterns = CAPTURE_PATTERNS) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  const want = new Set(patterns.replayHeaderNames.map(s => s.toLowerCase()));
  for (const [k, v] of Object.entries(headers)) {
    const lk = String(k).toLowerCase();
    if (want.has(lk) && typeof v === 'string' && v) out[lk] = v;
  }
  return out;
}

/**
 * v2.48.16 DIAGNOSTIC: ek WebSocket frame ke payload me media
 * URL ya workflow ID ka nishan hai kya? Payload string ya Buffer
 * ho sakta hai; sirf pehle 256KB dekhe jate hain, asal data
 * kahin save nahi hota — natija sirf do haan/na.
 */
function scanFramePayload(payload, patterns) {
  let text = '';
  try {
    if (typeof payload === 'string') text = payload.slice(0, 256 * 1024);
    else if (payload && typeof payload === 'object' && typeof payload.length === 'number') {
      text = Buffer.from(payload).toString('utf8', 0, 256 * 1024);
    }
  } catch (e) { return { hasMedia: false, hasWorkflow: false }; }
  if (!text) return { hasMedia: false, hasWorkflow: false };
  const urls = extractUrlsFromText(text, patterns || CAPTURE_PATTERNS);
  const hasMedia = urls.some(u => isMediaUrl(u, patterns || CAPTURE_PATTERNS));
  const hasWorkflow = extractWorkflowIdsFromText(text, patterns || CAPTURE_PATTERNS).length > 0;
  return { hasMedia, hasWorkflow };
}

/**
 * v2.48.17 DIAGNOSTIC-2: ek URL ki pehchan sirf host+path se
 * (query kabhi nahi — us me pehchan/token ho sakte hain).
 * Request paths ki ginti ke liye: kaun sa endpoint asal me
 * bulaya gaya, yehi sawal hai.
 */
function pathKeyOf(url) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname;
  } catch (e) { return null; }
}

/**
 * v2.48.18 DIAGNOSTIC-3: Flow ki maujooda web app apni saari
 * generation baat-cheet EK hi darwaze se karti hai —
 * flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute
 * (TEST495 me ek chhoti run me 36 calls; purani aisandbox API
 * par 0). Ye helper usi darwaze ko pehchanta hai.
 */
const BATCHEXECUTE_PATH = 'flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute';
function isBatchExecuteUrl(url) {
  return pathKeyOf(url) === BATCHEXECUTE_PATH;
}

/**
 * v2.48.19: JSON ke band-lipte (escaped) text ki ek parat kholo.
 * batchexecute ke jawab dohari lipat me aate hain — andar ka
 * payload ek JSON string hota hai jiske andar ke quotes/slashes
 * escaped hote hain. Purana extractor is lipat ko padh hi nahi
 * sakta tha (local test se sabit: envelope/escaped bodies me
 * use NA id mili NA media URL).
 */
function unescapeJsonText(text) {
  return String(text)
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

const BARE_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * v2.48.19: batchexecute body ka khaas scan — har parat par
 * aam scan + URL/ID extraction + bare-UUID pehchan, phir ek
 * parat khol kar dobara. adhiktam 4 paratein.
 */
function scanBatchExecuteBody(buf, patterns = CAPTURE_PATTERNS) {
  const ids = new Set();
  const mediaUrls = new Set();
  const allUrls = new Set();
  let text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf || '');
  for (let pass = 0; pass < 4; pass++) {
    try {
      const found = scanBodyForCapture(Buffer.from(text, 'latin1'), patterns);
      for (const id of found.ids) ids.add(id);
      for (const u of found.mediaUrls) mediaUrls.add(u);
    } catch (e) {}
    for (const u of extractUrlsFromText(text, patterns)) {
      allUrls.add(u);
      if (isMediaUrl(u, patterns)) mediaUrls.add(u);
    }
    for (const id of extractWorkflowIdsFromText(text, patterns)) ids.add(id);
    for (const m of (text.match(BARE_UUID_RE) || [])) ids.add(m);
    const next = unescapeJsonText(text);
    if (next === text) break;
    text = next;
  }
  return { ids: [...ids], mediaUrls: [...mediaUrls], allUrls: [...allUrls] };
}

/**
 * v2.48.22: ek URL ki SAFE shakal — host + aam rasta; lambe/
 * token-numa hisse '*' ban jate hain, query (signature) kabhi
 * shamil nahi. Sirf pehchan/ginti ke liye — asal link kabhi
 * log nahi hota.
 */
function urlShape(url) {
  try {
    const u = new URL(String(url || ''));
    const segs = u.pathname.split('/').filter(Boolean).map((s) => {
      let d = s;
      try { d = decodeURIComponent(s); } catch (e) {}
      if (d.length > 14 || (/[0-9]/.test(d) && /[a-zA-Z]/.test(d) && d.length > 8)) return '*';
      return d;
    });
    return u.hostname + '/' + segs.join('/');
  } catch (e) { return 'unparsable'; }
}

/**
 * v2.48.19: CDP Network.getResponseBody ka jawab asal Buffer me.
 */
function decodeCdpBody(body, base64Encoded) {
  if (typeof body !== 'string' || !body) return null;
  try {
    return base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
  } catch (e) { return null; }
}

/**
 * batchexecute URL ke query se rpcids (kaunsi backend function
 * bulayi gayi — ye function ke NAAM hain, koi raaz nahi).
 */
function rpcidsOf(url) {
  try {
    const raw = new URL(url).searchParams.get('rpcids');
    if (!raw) return [];
    return raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
  } catch (e) { return []; }
}

function hostOf(url) {
  try { return new URL(String(url || '')).hostname.toLowerCase(); } catch (e) { return ''; }
}

/**
 * v2.48.41 (MAIN-PAGE HARVEST PACK): googlevideo
 * videoplayback wale jawab ki pehchan — host
 * googlevideo.com ho ya us ka koi subdomain
 * (rr<N>---sn-*.googlevideo.com waghera), aur path
 * '/videoplayback' se shuru ho. Ye wohi stream hai
 * jo tile/editor playback ke liye aati hai; main page
 * par dikhe to mainpage kitab me darj hoti hai.
 */
function isGooglevideoPlaybackUrl(url) {
  try {
    const u = new URL(String(url || ''));
    const h = u.hostname.toLowerCase();
    if (h !== 'googlevideo.com' && !h.endsWith('.googlevideo.com')) return false;
    return u.pathname.startsWith('/videoplayback');
  } catch (e) { return false; }
}

/**
 * v2.48.27 (NET-BIG): bade jawabon ki pehchan — file ke bytes click
 * ke baad asal me KIS channel se aate hain, ye shikar isi se hoga.
 * Usool: encoded (wire) size YA declared content-length, jo bhi
 * 200 KB ki hadd tak pahunche — ek bhi kaafi hai, kyunki kabhi
 * content-length ghayab hota hai aur kabhi transfer beech me
 * rukta hai (encoded chhota reh jata hai lekin irada bada tha).
 */
const NET_BIG_THRESHOLD_BYTES = 200000;

function isNetBigResponse(encodedBytes, declaredBytes) {
  const enc = Number(encodedBytes);
  const dec = Number(declaredBytes);
  if (Number.isFinite(enc) && enc >= NET_BIG_THRESHOLD_BYTES) return true;
  if (Number.isFinite(dec) && dec >= NET_BIG_THRESHOLD_BYTES) return true;
  return false;
}

/** CDP headers object se case-bekhabar header ki qeemat. */
function headerValueOf(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const want = String(name || '').toLowerCase();
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === want) return String(headers[k] || '');
  }
  return '';
}

/**
 * v2.48.27 (NET-BIG window): ek waqt-khidki (sinceMs se aage) ke
 * andar har host ke KUL bytes, ghate kram (descending) me —
 * 'host=bytes host=bytes …'. Render→save khidki par ye lagane se
 * wo host sab se upar aata hai jis se file ke asal bytes aaye
 * honge — wahi Flow-server channel hai jis ka shikar hai.
 * Khidki khaali ho to '' (koi line nahi banti).
 */
function summarizeNetBigWindow(entries, sinceMs) {
  const totals = new Map();
  if (Array.isArray(entries)) {
    for (const e of entries) {
      if (!e || !e.host || !(e.bytes > 0)) continue;
      if (Number.isFinite(sinceMs) && e.at < sinceMs) continue;
      totals.set(e.host, (totals.get(e.host) || 0) + e.bytes);
    }
  }
  return Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([h, b]) => `${h}=${b}`)
    .join(' ');
}

function hostMatches(host, suffix) {
  return host === suffix || host.endsWith('.' + suffix);
}

function isApiUrl(url, patterns = CAPTURE_PATTERNS) {
  const h = hostOf(url);
  if (!h) return false;
  return patterns.apiHosts.some(s => hostMatches(h, s))
    || patterns.webchannelHosts.some(s => hostMatches(h, s));
}

function isMediaHostUrl(url, patterns = CAPTURE_PATTERNS) {
  const h = hostOf(url);
  if (!h) return false;
  return patterns.mediaHosts.some(s => hostMatches(h, s));
}

/** Ek URL media link hai kya — FIFE host, ya video extension wala. */
function isMediaUrl(url, patterns = CAPTURE_PATTERNS) {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (isMediaHostUrl(url, patterns)) return true;
  let pathname = '';
  try { pathname = new URL(url).pathname.toLowerCase(); } catch (e) { return false; }
  return patterns.mediaExtensions.some(ext => pathname.includes(ext));
}

/**
 * Kisi bhi text (JSON string, grpc-web binary frame ka latin1 roop,
 * request URL/postData) me se saare http(s) URLs nikalo. JSON ke
 * escaped slashes (https:\/\/) bhi sambhalte hain. URLs ke aakhir
 * me chipke hue frame ke nishan (quotes, brackets, control chars)
 * kaat diye jate hain.
 */
function extractUrlsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const cleaned = text.replace(/\\\//g, '/');
  const out = [];
  const seen = new Set();
  const re = /https?:\/\/[^\s"'<>\[\]{}|\\^`]+/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    let u = m[0];
    u = u.replace(/[\x00-\x20]+$/g, '').replace(/[.,;:!?)]+$/g, '');
    if (u.length < 12) continue;
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

/** Configured ID field naamo se workflowId-jaise values nikalo (text roop). */
function extractWorkflowIdsFromText(text, patterns = CAPTURE_PATTERNS) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const field of patterns.idFieldNames) {
    const re = new RegExp('"' + field + '"\\s*:\\s*"([^"]{' + patterns.idMinLength + ',})"', 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
    }
  }
  // Request URL / query roop: ?workflowId=... ya /workflow/<id>
  const urlRe = /workflow[_]?id=([A-Za-z0-9_-]{6,})/gi;
  let m2;
  while ((m2 = urlRe.exec(text)) !== null) {
    if (!seen.has(m2[1])) { seen.add(m2[1]); out.push(m2[1]); }
  }
  return out;
}

/**
 * JSON value ki deep-walk jaanch: media URL wali saari string
 * values + configured ID fields ke values. Field ka NAAM kuch bhi
 * ho — media URL apni shakal (host/extension) se pehchana jata hai,
 * isiliye inspection me field-naam badalte rehne se ye nahi tootta.
 */
function scanJsonValue(value, patterns = CAPTURE_PATTERNS, acc, depth) {
  const a = acc || { ids: [], mediaUrls: [] };
  const d = depth || 0;
  if (d > 12 || value === null || value === undefined) return a;
  if (typeof value === 'string') {
    if (isMediaUrl(value, patterns) && !a.mediaUrls.includes(value)) a.mediaUrls.push(value);
    return a;
  }
  if (Array.isArray(value)) {
    for (const v of value) scanJsonValue(v, patterns, a, d + 1);
    return a;
  }
  if (typeof value === 'object') {
    const idFields = new Set(patterns.idFieldNames.map(s => s.toLowerCase()));
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && idFields.has(k.toLowerCase()) && v.length >= patterns.idMinLength) {
        if (!a.ids.includes(v)) a.ids.push(v);
      }
      scanJsonValue(v, patterns, a, d + 1);
    }
  }
  return a;
}

/**
 * Ek response body (Buffer) ki poori jaanch: JSON.parse ki koshish
 * (deep-walk) + raw text scan (URLs + IDs) — dono ka sangam.
 * grpc-web binary frames ke liye body ko latin1 padha jata hai:
 * ASCII hisse (URL, ID) byte-faithful bach jate hain.
 */
function scanBodyForCapture(bodyBuffer, patterns = CAPTURE_PATTERNS) {
  const out = { ids: [], mediaUrls: [] };
  if (!bodyBuffer || bodyBuffer.length === 0) return out;
  const latin = bodyBuffer.toString('latin1');
  // Raw text scan — binary frames me bhi yahi kaam karta hai.
  for (const u of extractUrlsFromText(latin)) {
    if (isMediaUrl(u, patterns) && !out.mediaUrls.includes(u)) out.mediaUrls.push(u);
  }
  for (const id of extractWorkflowIdsFromText(latin, patterns)) {
    if (!out.ids.includes(id)) out.ids.push(id);
  }
  // JSON deep-walk — utf8 roop par parse ki koshish.
  try {
    const parsed = JSON.parse(bodyBuffer.toString('utf8'));
    const walked = scanJsonValue(parsed, patterns);
    for (const u of walked.mediaUrls) if (!out.mediaUrls.includes(u)) out.mediaUrls.push(u);
    for (const id of walked.ids) if (!out.ids.includes(id)) out.ids.push(id);
  } catch (e) { /* JSON nahi tha — raw scan hi kaafi hai */ }
  return out;
}

class NetworkCapture {
  constructor(opts = {}) {
    this.patterns = opts.patterns || CAPTURE_PATTERNS;
    this.onMediaBound = typeof opts.onMediaBound === 'function' ? opts.onMediaBound : (() => {});
    // v2.48.27 (NET-BIG): bade (≥200KB) jawabon ki khabar engine ko
    // — engine use [NET-BIG] line me badalta hai. Callback na ho
    // to shikar khamoshi se band rehta hai (koi vyavhaar-badal nahi).
    this.onNetBig = typeof opts.onNetBig === 'function' ? opts.onNetBig : null;
    // v2.48.31 (MINT): mint watch ke callbacks — engine inhe
    // [MINT] lines me badalta hai. Na hon to watch khamosh hai.
    this.onMintRequest = typeof opts.onMintRequest === 'function' ? opts.onMintRequest : null;
    this.onMintCarriesUrl = typeof opts.onMintCarriesUrl === 'function' ? opts.onMintCarriesUrl : null;
    // v2.48.33 (ZEROCLICK): mint-call ka replay template seekh
    // lene ki khabar — engine use [ZEROCLICK] line me badalta
    // hai (sirf shakal: rpcids + body size + ID ginti; asal
    // URL/ID/body kabhi callback se bahar nahi jata).
    this.onMintTemplate = typeof opts.onMintTemplate === 'function' ? opts.onMintTemplate : null;
    // v2.48.38 (EDITOR-HARVEST PACK): harvest-audit ki khabar
    // — engine use [ROOT] harvest-audit line me badalta hai
    // (sirf hisaab: bytes/body/hash-8/vsTeacher/faisla/wajah;
    // asal URL ya poora hash kabhi bahar nahi jata). Callback
    // na ho to audit khamosh hai (vyavhaar nahi badalta).
    this.onHarvestAudit = typeof opts.onHarvestAudit === 'function' ? opts.onHarvestAudit : null;
    // v2.48.41 (MAIN-PAGE HARVEST PACK): mainpage-audit ki
    // khabar — engine use [ROOT] mainpage-audit line me
    // badalta hai (sirf hisaab: host/bytes/src-qisam/
    // faisla/wajah/timing-bucket; asal URL kabhi bahar
    // nahi jata). Callback na ho to audit khamosh hai.
    this.onMainpageAudit = typeof opts.onMainpageAudit === 'function' ? opts.onMainpageAudit : null;
    this._page = null;
    this._reqHandler = null;
    this._resHandler = null;
    this.armed = false;
    this.reset();
  }

  reset() {
    this.submissions = [];       // [{ key, at, id|null }] — kram me
    this.keyById = new Map();     // workflowId -> taskKey
    this.urlByKey = new Map();    // taskKey -> { url, via, at }
    this.keyByUrl = new Map();    // url -> taskKey
    this.sightings = new Map();   // url -> { firstSeenAt, source, claimedBy }
    // v2.48.13: status-request templates (direct-API poll ke liye)
    this.statusTemplates = new Map(); // workflowId -> { url, method, headers, body, at }
    this.latestStatusTemplate = null; // sabse taza status template (koi bhi ID)
    // v2.10.0: diagnostics — listener zinda hai ya andha, iska
    // saboot. Owner ke v2.8.0 PC run me mediaUrlsSeen poori run 0
    // raha, lekin ye pata hi nahi chala ki listener ne jawab dekhe
    // bhi the ya nahi. Ab har jawab (armed ho ya na ho) ginata hai,
    // aur sirf HOST ke naam bante hain (URL/query kabhi nahi).
    this.hostCounts = new Map(); // hostname -> count (sirf naam)
    this.stats = {
      responsesSeen: 0, mediaResponsesSeen: 0,
      apiResponses: 0, bodiesScanned: 0,
      mediaUrlsSeen: 0, idsSeen: 0,
      boundById: 0, boundByCurrentSrc: 0, boundByOrder: 0
    };
    // v2.48.16 DIAGNOSTIC: TEST493 (2026-11-01) me pure run ke
    // dauraan API responses = 0 mile — Flow ka data shayad ek
    // lambi streaming line (WebSocket / webchannel) se aata hai
    // jise ye engine sunta hi nahi tha. Ab: (a) API REQUESTS bhi
    // gine jate hain (sirf jawab nahi), (b) har WebSocket ka
    // khulna, uske frames ki ginti, aur frames ke ANDAR media
    // URL / workflow ID ke nishan gine jate hain (frame ka asal
    // data kabhi save nahi hota — sirf haan/na aur size).
    this.apiRequestCounts = new Map(); // method -> count (API hosts par)
    this.wsStats = {
      sockets: 0, urls: [], framesIn: 0, framesOut: 0,
      bytesIn: 0, mediaFrames: 0, workflowFrames: 0
    };
    // v2.48.17 DIAGNOSTIC-2: har request ka host+path hisaab
    // (query nahi) aur flow.google.com ke apne jawabon ke andar
    // ki substring talash. Pehla batayega ke generation ki calls
    // asal me kin endpoints par gayin (same-host RPC? webchannel?);
    // dusra batayega ke link un bodies me chhupa to nahi tha.
    this.pathCounts = new Map(); // host+path -> count
    this.flowBodyStats = { scanned: 0, mediaHostHits: 0, workflowHits: 0, aisandboxHits: 0 };
    this._cdpClient = null;
    // v2.48.18 DIAGNOSTIC-3: sirf batchexecute darwaze ka hisaab —
    // kitni requests gayin (kis rpcid ke saath), kitne jawab aaye,
    // unke bodies kitne padhe gaye aur kitne kyun chhoote, aur
    // padhe gaye bodies me kin alfaz ke nishan mile.
    this.batchStats = {
      requests: 0, rpcids: {}, responses: 0, bodiesFetched: 0,
      skipContentType: 0, skipTooBig: 0, skipBuffer: 0, contentTypes: {},
      withMediaHost: 0, withVideoplayback: 0, withWorkflow: 0,
      withFife: 0, withDownloadWord: 0, cdpBodies: 0,
      streamChunks: 0, streamBound: 0, urlShapes: {}
    };
    this._cdpBatch = new Map(); // CDP requestId -> { rpcids, at, text, bound }
    this.downloadCensus = new Map(); // v2.48.24: shape -> { n, bytes } (media-host / asb responses, poori run)
    this._cdpDlShape = new Map(); // CDP requestId -> shape
    this._cdpBigShape = new Map(); // v2.48.27: CDP requestId -> { shape, host, type, declared } (NET-BIG shikar)
    this.netBigWindow = []; // v2.48.27: [{ host, bytes, at }] — har mukammal jawab ka behtareen size (window summary ke liye)
    // v2.48.28 (SERVER-FIRST): flow-content.google ke asal video
    // jawab — poora URL sirf YAAD me rehta hai (sightings ki
    // tarah; log me kabhi nahi — wahan sirf shakal jati hai),
    // taaki engine use isi attempt me seedha server se fetch kar
    // sake. claimed = kisi task ne le liya (doosra phir nahi lega).
    this.flowContentVideos = []; // [{ url, type, at }] — taaza peeche, hadd 50
    this.flowContentClaimed = new Set(); // url -> kisi task ke naam ho chuka
    // v2.48.31 (MINT): mint watch — sirf download round ke
    // dauraan chalu (engine setMintWatch bulata hai). mintRequests
    // me har request ki saaf shakal (method/host/path — query ki
    // sirf keys) rehti hai, hadd 600; _mintCarriesSeen ek watch
    // ke andar ek hi (method|host|path) ki carries-khabar ko
    // dobara nahi ugne deta.
    this.mintWatch = false;
    this.mintRequests = []; // [{ method, host, path, at }]
    this._mintCarriesSeen = new Set();
    // v2.48.33 (ZEROCLICK): seekha hua mint-call template —
    // status templates (v2.48.13) wali hi hifazat: asal URL
    // (query sameet) + method + whitelist headers + raw body
    // bytes SIRF is object me rehte hain (log me kabhi nahi),
    // taaki engine agle task par usi darkhwast ko is task ke
    // ID ke saath replay kar sake. _mintTaskKey woh task hai
    // jis ke download round me watch chalu hai (seekhne wale
    // task ki pehchan). Template roundon ke paar rehta hai —
    // sirf reset() (naya session) use saaf karta hai.
    this.mintTemplate = null; // { url, method, headers, body, at, taskKey, primaryId, ids, idOccurrences, urlPrimaryId, urlIds, urlIdOccurrences, teacherUrl, learnContext }
    this._mintTaskKey = null;
    // v2.48.37 (SESSION-WIDE MINT WATCH): watch ke ab DO
    // maalik hain — SESSION (worker ka page tayyar hote hi
    // engine setMintSessionWatch(true) bulata hai; account
    // chhodne / run khatam par band) aur ROUND (ek download
    // round ki khidki — setMintWatch ka purana istemal).
    // this.mintWatch ASAR-daar haalat hai (dono me se koi
    // ek bhi chalu to watch chalu). ZEROCLICK4 ki seekh:
    // template sirf round ke andar seekha jata tha, aur
    // pehle download karne wale task ke round me kabhi
    // kabhi koi mint jawab aata hi nahi (Flow ke page ke
    // paas us media ka address pehle se hota hai) — to
    // template us pal tak ghayab rehta tha jab tak koi
    // agla task bacha hi nahi hota tha.
    this._mintSessionOn = false;
    this._mintRoundOn = false;
    // Round ke bahar seekhne par template ki nisbat: sab
    // se aakhir me render-poora hua task (engine
    // noteRenderCompleted se khabar deta hai); wo bhi na
    // ho to sab se taza monitored (submitted) task.
    this._mintLastRenderKey = null;
    // v2.48.37 (CANDIDATE TEMPLATE): sab se taza
    // batchexecute darkhwast jis ke rpcids me 'as29s'
    // hai — jawab file-address le aaya ho ya NAHI, ye
    // darkhwast kitab me rehti hai. Carrying-jawab wala
    // seekha template (mintTemplate) hamesha is par
    // bhaari hai; candidate sirf tab kaam aata hai jab
    // seekha template abhi bana hi na ho. Hifazat wahi
    // (whitelist headers, body size hadd, asal data
    // sirf is object me — log me kabhi nahi).
    this.mintCandidateTemplate = null; // { url, method, headers, body, at, taskKey: null, source: 'candidate' }
    // v2.48.36 (ROOT PACK — E): teacher task ka ASAL mint
    // hua flow-content URL — sirf is capture ki yaad me
    // rehta hai (kabhi log nahi), taaki verbatim replay ke
    // jawab ka same/different muqabla hamesha ho sake
    // (v2.48.35 me teacher ka URL capture ke paas maujood
    // hote hue bhi muqabla 'n/a' nikal sakta tha kyunke
    // probe bandhe hue link ko hi dhoondta tha — mint ke
    // pal ka address wahan darj hi nahi hota tha).
    this.mintTeacherUrl = null;
    // v2.48.36 (ROOT PACK — D): PAGE-FETCH HARVEST — page
    // khud (editor preview/playback par) asal server file
    // ke bytes khinchta hai; wohi bytes CDP getResponseBody
    // se yaad rakh liye jate hain, lekin SIRF tab jab
    // saveGuard ke darwaze (bandhan + size floor + MP4
    // header) guzar jayen. Ek task ke naam ek hi body,
    // hadd ~8MB; task ke round ke aakhir par evict.
    this.harvestBodies = new Map(); // captureKey -> { url, buffer, at }
    this._harvestByUrl = new Map(); // url -> { buffer, at } (bandhan se pehle aayi body; hadd 2)
    this._harvestPending = new Map(); // CDP requestId -> { url, declared, status, contentRange }
    // _downloadAttemptKey = stage-lock tale chal raha
    // download attempt (engine round ke aaghaz/aakhir par
    // khabar deta hai) — harvest-audit sirf is khidki me
    // chalta hai (v2.48.41: editor-khidki khatam hai,
    // kyunke editor ab kabhi khulta hi nahi).
    this._downloadAttemptKey = null;
    // v2.48.40 (INVISIBLE HARVEST PACK): CASCADE kitab —
    // har media address ki SAB SE PEHLI nazar (pal +
    // qisam: project-data | mint-response | stream-get;
    // sirf pehli nazar rehti hai, baad wali use badal
    // nahi sakti). Sirf mushahida hai — koi faisla is
    // par nahi chalta. v2.48.41: editor kabhi khulta
    // nahi, is liye cascade ka editorOpenedAt hamesha
    // null rehta hai.
    this._urlFirstSeen = new Map(); // url -> { at, kind } (hadd 300)
    // v2.48.41 (MAIN-PAGE HARVEST PACK): MAIN PAGE ki
    // video kitab — asal worker page par dekhe gaye har
    // video-jese jawab (flow-content.google video jawab
    // + *.googlevideo.com/videoplayback) ki ek entry:
    // { url, src, host, bytes, at, timing, status,
    //   contentRange, declared, partial }. Asal URL sirf
    // yaad me rehta hai (log me kabhi nahi — wahan host/
    // bytes/qisam hi jata hai). googlevideo ke tukde
    // (range jawab) _mainpageBodies me rehte hain (hadd
    // 2, ~8MB tak); flow-content ki mukammal body
    // purani harvest kitab (harvestBodies/_harvestByUrl)
    // me hi rehti hai. mainpageClaimed = kisi task ke
    // naam ho chuka address (doosra phir nahi lega).
    this.mainpageVideos = []; // taaza peeche, hadd 50
    this.mainpageClaimed = new Set(); // url
    // v2.48.42 (MAIN-PAGE BINDING PACK): bandhan ki
    // kitab — kaun sa address KIS task ke naam hua
    // (key = captureKey, label = log wala task#), aur
    // har task ki apni khidki (render-complete ka pal)
    // jis ke andar pehli baar dikha stream usi ka
    // bandhta hai. Dono run ke andar attempts aur
    // download-retry rounds ke paar rehte hain.
    this.mainpageClaimedBy = new Map(); // url -> { key, label }
    // v2.48.43: mainpage kitab ki capture tartib —
    // har NAYI entry ko ek badhta number (seq) milta
    // hai; pehli-nazar ke ek hi pal par bhi asal
    // pakadne ki tarteeb is se rehti hai (tarteeb
    // bandhan ka faisla-kun).
    this._mainpageSeq = 0;
    this.mainpageWindows = new Map(); // captureKey -> { start, done }
    this._mainpagePending = new Map(); // CDP requestId -> { url, src, declared, status, contentRange }
    this._mainpageBodies = new Map(); // url -> { buffer, at } (googlevideo tukde)
    // Engine har download round me apni duration ka size
    // floor yahan rakh deta hai (downloadFetch wala hisaab);
    // 0 = floor nahi (aam darwaze hi laagu).
    this.harvestFloorBytes = 0;
  }

  arm() { this.armed = true; }
  disarm() { this.armed = false; }

  /**
   * Page par network sunna chalu karo. Listener hamesha launch ke
   * saath lagte hain (taaki submit se pehle ka ek bhi jawab na
   * choote); asal ingestion `armed` hone par hi hoti hai — pehle
   * submit se pehle ke project-page ke jawab (purane projects ke
   * thumbnails/videos) capture ko ganda nahi karte.
   */
  attach(page) {
    this.detach();
    if (!page || typeof page.on !== 'function') return false;
    this._page = page;
    this._reqHandler = (req) => {
      // v2.48.16 DIAGNOSTIC: API requests ki ginti armed hone se
      // pehle bhi (sirf host+method ka hisaab, koi data nahi) —
      // TEST493 me API responses 0 the; ab ye bhi pata chalega
      // ke API requests gaye bhi the ya nahi.
      try {
        if (isApiUrl(req.url(), this.patterns)) {
          const m = req.method() || 'GET';
          this.apiRequestCounts.set(m, (this.apiRequestCounts.get(m) || 0) + 1);
        }
      } catch (e) {}
      // v2.48.17 DIAGNOSTIC-2: har request ka host+path hisaab.
      try {
        const k = pathKeyOf(req.url());
        if (k) this.pathCounts.set(k, (this.pathCounts.get(k) || 0) + 1);
      } catch (e) {}
      // v2.48.31 (MINT): mint watch chalu ho to is request ki
      // saaf shakal bhi darj karo (armed se pehle bhi — download
      // round ke dauraan capture armed hi hota hai, lekin mint
      // ginati click ke pal se pakki honi chahiye).
      try {
        let m = 'GET';
        try { m = req.method() || 'GET'; } catch (e) {}
        this._noteMintRequest({ method: m, url: req.url(), at: Date.now() });
      } catch (e) {}
      // v2.48.18 DIAGNOSTIC-3: batchexecute requests + rpcid naam.
      try {
        if (isBatchExecuteUrl(req.url())) {
          this.batchStats.requests++;
          for (const r of rpcidsOf(req.url())) {
            this.batchStats.rpcids[r] = (this.batchStats.rpcids[r] || 0) + 1;
          }
          // v2.48.23: REQUEST ke andar ka payload bhi scan karo
          // (TEST500: jawab-bodies ki link-shapes ginti khaali
          // aayi, lekin bandhan kahin se to hua — darkhwast ke
          // payload ek aur jagah hai jahan pehchan ke nishan
          // ho sakte hain). Sirf armed par; nishan wahi pipeline.
          if (this.armed) {
            let post = null;
            try { post = req.postData() || null; } catch (e) {}
            if (post) {
              const extra = scanBatchExecuteBody(Buffer.from(post, 'utf8'), this.patterns);
              const at = Date.now();
              for (const id of extra.ids) this._bindId(id, at);
              for (const u of extra.mediaUrls) this._sightUrl(u, 'api-body', at, extra.ids);
              for (const u of (extra.allUrls || [])) {
                const shape = urlShape(u);
                if (this.batchStats.urlShapes[shape] !== undefined || Object.keys(this.batchStats.urlShapes).length < 24) {
                  this.batchStats.urlShapes[shape] = (this.batchStats.urlShapes[shape] || 0) + 1;
                }
              }
            }
          }
        }
      } catch (e) {}
      // v2.48.15: status-shaped API requests ka TEMPLATE armed
      // hone se pehle bhi record hota hai (project khulte hi page
      // List/Search calls bhejta hai — wahi direct-API poll ka
      // beej hain; pehchan ki bandish templates par nahi, URL
      // bandhne par lagti hai, is liye ye mehfooz hai). Baaki
      // saari ingestion pehle ki tarah sirf armed par.
      if (!this.armed && !isStatusApiUrl(req.url(), this.patterns)) return;
      try {
        let post = null;
        try { post = req.postData() || null; } catch (e) {}
        // v2.48.13: asal body bytes (protobuf/binary ke liye
        // postDataBuffer; na mile to text roop ka Buffer).
        let postBuf = null;
        try { postBuf = typeof req.postDataBuffer === 'function' ? req.postDataBuffer() : null; } catch (e) {}
        if (!postBuf && post) { try { postBuf = Buffer.from(post, 'utf8'); } catch (e) {} }
        let method = 'GET';
        try { method = req.method() || 'GET'; } catch (e) {}
        let headers = {};
        try { headers = req.headers() || {}; } catch (e) {}
        this.ingestRequest({ url: req.url(), postDataText: post, postDataBuffer: postBuf, method, headers, at: Date.now() });
      } catch (e) {}
    };
    this._resHandler = async (res) => {
      // v2.10.0: ginati armed se pehle — listener ki zindagi ka
      // saboot har haal me banta hai (ingestion armed par hi hoti
      // hai, ginati hamesha).
      try {
        const u0 = res.url();
        this.stats.responsesSeen++;
        const h0 = hostOf(u0);
        if (h0 && this.hostCounts.size < 40) {
          this.hostCounts.set(h0, (this.hostCounts.get(h0) || 0) + 1);
        }
        if (isMediaUrl(u0, this.patterns)) this.stats.mediaResponsesSeen++;
      } catch (e) {}
      if (!this.armed) return;
      try {
        const url = res.url();
        let headers = {};
        try { headers = res.headers() || {}; } catch (e) {}
        const ct = String(headers['content-type'] || '').toLowerCase();
        // v2.48.31 (MINT): is jawab ka method (carries-khabar ke
        // liye) aur redirect Location me file-address ki jaanch.
        let resMethod = 'GET';
        try { const rq = res.request(); if (rq) resMethod = rq.method() || 'GET'; } catch (e) {}
        try {
          if (this.mintWatch) this._checkMintCarries(resMethod, url, headers['location'], null);
        } catch (e) {}
        const api = isApiUrl(url, this.patterns);
        // Media response (page ne khud file khinchi — tile playback
        // adi): URL ki sighting note karo, body NAHI padho (badi
        // hoti hai; asal fetch engine ka kaam hai).
        if (isMediaUrl(url, this.patterns)) {
          this.ingestResponse({ url, contentType: ct, bodyBuffer: null, at: Date.now() });
        }
        // v2.48.17 DIAGNOSTIC-2: flow.google.com ke gRPC/protobuf
        // type jawabon ke bodies bhi padho — agar generation ka
        // data same-host gRPC-web se aata hai to uska body JSON
        // nahi hota, aur purani shart use hamesha chhod deti thi.
        const isFlowRpc = hostOf(url) === 'flow.google.com'
          && /(grpc|protobuf|octet-stream|text\/plain)/.test(ct);
        // v2.48.18 DIAGNOSTIC-3: batchexecute ke jawab har haal
        // me padho (content-type jo bhi ho) — aur jo na padha
        // jaye uski wajah bhi gin lo.
        const batch = isBatchExecuteUrl(url);
        if (batch) {
          this.batchStats.responses++;
          const ctKey = (ct.split(';')[0] || '(none)').trim();
          this.batchStats.contentTypes[ctKey] = (this.batchStats.contentTypes[ctKey] || 0) + 1;
        }
        if (!api && !ct.includes('json') && !isFlowRpc && !batch) return;
        const declared = parseInt(headers['content-length'] || '', 10);
        if (Number.isFinite(declared) && declared > this.patterns.maxBodyScanBytes) {
          if (batch) this.batchStats.skipTooBig++;
          return;
        }
        let buf = null;
        try { buf = await res.buffer(); } catch (e) { if (batch) this.batchStats.skipBuffer++; return; }
        if (!buf || buf.length === 0 || buf.length > this.patterns.maxBodyScanBytes) {
          if (batch) this.batchStats.skipBuffer++;
          return;
        }
        if (batch) this.batchStats.bodiesFetched++;
        // v2.48.31 (MINT): padhe gaye body me file ke server
        // address ka nishan hai kya (sirf haan/na darj hota hai).
        // v2.48.33 (ZEROCLICK): batchexecute jawab ho to asal
        // darkhwast (is response ka apna request) ka template
        // bhi banao — carries sabit hone par wahi seekha
        // jayega. Body bytes wahi tareeka jo ingestRequest ka
        // hai (postDataBuffer pehle, warna text ka Buffer);
        // headers sirf whitelist wale.
        try {
          if (this.mintWatch) {
            let reqTemplate = null;
            if (batch) {
              try {
                const rq = res.request();
                if (rq) {
                  let postBuf = null;
                  try { postBuf = typeof rq.postDataBuffer === 'function' ? rq.postDataBuffer() : null; } catch (e2) {}
                  if (!postBuf) {
                    try { const pd = rq.postData(); if (pd) postBuf = Buffer.from(pd, 'utf8'); } catch (e2) {}
                  }
                  let hdrs = {};
                  try { hdrs = rq.headers() || {}; } catch (e2) {}
                  reqTemplate = { url, method: resMethod, headers: pickReplayHeaders(hdrs, this.patterns), body: postBuf };
                }
              } catch (e2) { reqTemplate = null; }
            }
            this._checkMintCarries(resMethod, url, null, buf, reqTemplate);
          }
        } catch (e) {}
        this.ingestResponse({ url, contentType: ct, bodyBuffer: buf, at: Date.now() });
      } catch (e) {}
    };
    page.on('request', this._reqHandler);
    page.on('response', this._resHandler);
    // v2.48.17 DIAGNOSTIC-2: WebSocket nigrani CDP se. (v2.48.16
    // wala page.on('websocket') Playwright ka tareeka tha —
    // engine Puppeteer hai, wo listener kabhi chal hi nahi
    // sakta tha; uska '0 sockets' natija bekaar tha. CDP ke
    // Network.webSocket* events Puppeteer me asal tareeka hain.)
    this._attachCdpWebSockets(page);
    return true;
  }

  /**
   * CDP session se WebSocket ka khulna aur frames ginna.
   * Best-effort: session na bane to baaki capture pehle ki
   * tarah chalta hai. Frame ka asal data save nahi hota —
   * sirf scanFramePayload ke haan/na nishan.
   */
  async _attachCdpWebSockets(page) {
    try {
      const client = await page.target().createCDPSession();
      await client.send('Network.enable');
      this._cdpClient = client;
      client.on('Network.webSocketCreated', (e) => {
        try {
          this.wsStats.sockets++;
          const k = pathKeyOf(e && e.url);
          if (k && this.wsStats.urls.length < 5 && !this.wsStats.urls.includes(k)) {
            this.wsStats.urls.push(k);
          }
        } catch (err) {}
      });
      client.on('Network.webSocketFrameReceived', (e) => {
        try {
          this.wsStats.framesIn++;
          const resp = e && e.response;
          const data = resp && resp.payloadData;
          if (typeof data === 'string' && data) {
            this.wsStats.bytesIn += data.length;
            const payload = resp.opcode === 2 ? Buffer.from(data, 'base64') : data;
            const scan = scanFramePayload(payload, this.patterns);
            if (scan.hasMedia) this.wsStats.mediaFrames++;
            if (scan.hasWorkflow) this.wsStats.workflowFrames++;
          }
        } catch (err) {}
      });
      client.on('Network.webSocketFrameSent', () => {
        try { this.wsStats.framesOut++; } catch (err) {}
      });
      // v2.48.19: batchexecute bodies CDP se — Puppeteer ka
      // res.buffer() streaming/long-poll jawabon par fail hota
      // hai (TEST496: 2 buffer-fail, kai jawab in-flight reh
      // gaye). CDP ka Network.getResponseBody loadingFinished
      // ke baad har jawab ka body de deta hai. Body wahi purani
      // ingest pipeline me jata hai (pehchan ke usool same).
      client.on('Network.requestWillBeSent', (e) => {
        try {
          if (e && e.request && isBatchExecuteUrl(e.request.url)) {
            this._cdpBatch.set(e.requestId, {
              rpcids: rpcidsOf(e.request.url), at: Date.now(), method: e.request.method || 'GET',
              // v2.48.33 (ZEROCLICK): asal darkhwast ki shakal
              // bhi yaad rakho — is request ka jawab file-address
              // le aaye to yahi mint template banta hai (headers
              // sirf whitelist wale, status-template wali tarz;
              // cookie CDP se kabhi nahi uthayi jati — replay
              // page ke apne session se hota hai).
              reqUrl: e.request.url,
              reqHeaders: pickReplayHeaders(e.request.headers || {}, this.patterns),
              reqPostData: typeof e.request.postData === 'string' ? e.request.postData : null
            });
            // v2.48.37 (CANDIDATE TEMPLATE): jawab ka
            // intezaar kiye baghair — rpcids me as29s
            // wali darkhwast usi pal candidate ban jati
            // hai (ZEROCLICK4 me carrying jawab aaya hi
            // nahi tha, lekin darkhwast zaroor gayi thi).
            try { this._noteMintCandidate(this._reqTemplateFromCdpMeta(this._cdpBatch.get(e.requestId))); } catch (err) {}
          }
        } catch (err) {}
      });
      client.on('Network.loadingFailed', (e) => {
        try { if (e) { this._cdpBatch.delete(e.requestId); this._cdpDlShape.delete(e.requestId); this._cdpBigShape.delete(e.requestId); this._harvestPending.delete(e.requestId); this._mainpagePending.delete(e.requestId); } } catch (err) {}
      });
      // v2.48.24: DOWNLOAD CENSUS — media-host / asb wale tamam
      // responses ki shakal + kul size, poori run (menu wale
      // download sameet). Asal download link kis khandan ka
      // hai, yehi batayega.
      client.on('Network.responseReceived', (e) => {
        try {
          if (!e || !e.response || !e.response.url) return;
          const u = e.response.url;
          if (isMediaHostUrl(u) || u.includes('/asb/')) {
            this._cdpDlShape.set(e.requestId, urlShape(u));
          }
          // v2.48.27 (NET-BIG): HAR jawab ki shakal/nau/declared
          // size note karo — loadingFinished par encoded size ke
          // saath mila kar ≥200KB walon ki ek line engine ko
          // jayegi, aur har jawab window hisaab me bhi jayega.
          // Map had me rahe: purane adhoore hisse girte rahen
          // (loadingFinished/Failed par saaf to hota hi hai).
          {
            if (this._cdpBigShape.size > 2000) {
              const firstKey = this._cdpBigShape.keys().next().value;
              this._cdpBigShape.delete(firstKey);
            }
            const rawType = headerValueOf(e.response.headers, 'content-type');
            const declared = parseInt(headerValueOf(e.response.headers, 'content-length') || '', 10);
            this._cdpBigShape.set(e.requestId, {
              shape: urlShape(u),
              host: hostOf(u),
              type: (rawType.split(';')[0] || '').trim().toLowerCase(),
              declared: Number.isFinite(declared) ? declared : 0
            });
            // v2.48.28 (SERVER-FIRST): asal server wala video
            // jawab (flow-content.google, video/*) poore URL ke
            // saath yaad rakho — engine ka server-first rasta
            // isi attempt me use seedha fetch karega. Pehchan
            // flowContent ke exact-host matcher se hi hoti hai.
            if (flowContent.isFlowContentVideoUrl(u, rawType)) {
              this._recordFlowContentVideo(u, (rawType.split(';')[0] || '').trim().toLowerCase(), Date.now());
              // v2.48.40 (CASCADE): stream wala jawab khud
              // — 'stream-get' wali pehli nazar.
              this._noteUrlFirstSeen(u, 'stream-get', Date.now());
              // v2.48.36 (ROOT PACK — D): harvest ummeedwaar —
              // loadingFinished par is jawab ka body CDP se
              // uthaya jayega (best-effort). Map had me rahe.
              if (this._harvestPending.size > 20) {
                const firstKey = this._harvestPending.keys().next().value;
                this._harvestPending.delete(firstKey);
              }
              this._harvestPending.set(e.requestId, {
                url: u,
                declared: Number.isFinite(declared) ? declared : 0,
                // v2.48.38: adhoore (partial) jawab ki pehchan
                // ke nishan — status (206) aur Content-Range.
                status: Number.isFinite(e.response.status) ? e.response.status : 0,
                contentRange: headerValueOf(e.response.headers, 'content-range') || ''
              });
              // v2.48.41 (MAIN-PAGE HARVEST PACK): wahi jawab
              // main page ki kitab me bhi darj hoga —
              // loadingFinished par wahi body jo harvest
              // pipeline uthayegi.
              if (this._mainpagePending.size > 20) {
                const firstKey = this._mainpagePending.keys().next().value;
                this._mainpagePending.delete(firstKey);
              }
              this._mainpagePending.set(e.requestId, {
                url: u,
                src: 'flow-content',
                declared: Number.isFinite(declared) ? declared : 0,
                status: Number.isFinite(e.response.status) ? e.response.status : 0,
                contentRange: headerValueOf(e.response.headers, 'content-range') || '',
                // v2.48.43: ummeedwaar darwaze ke liye
                // jawab ki asal type.
                contentType: (rawType.split(';')[0] || '').trim().toLowerCase()
              });
            }
            // v2.48.41 (MAIN-PAGE HARVEST PACK): googlevideo
            // videoplayback jawab bhi MAIN page ki kitab me —
            // ye aksar range (adhoora) jawab hota hai; body
            // loadingFinished par tukde ki shakal me uthaya
            // jayega. ZEROCLICK8 ka saboot: download attempt
            // ke dauraan main page par 224,692 bytes ka aisa
            // hi ek jawab aaya tha, kisi editor ke khulne se
            // pehle.
            if (isGooglevideoPlaybackUrl(u)) {
              this._noteUrlFirstSeen(u, 'stream-get', Date.now());
              if (this._mainpagePending.size > 20) {
                const firstKey = this._mainpagePending.keys().next().value;
                this._mainpagePending.delete(firstKey);
              }
              const gdeclared = parseInt(headerValueOf(e.response.headers, 'content-length') || '', 10);
              this._mainpagePending.set(e.requestId, {
                url: u,
                src: 'googlevideo',
                declared: Number.isFinite(gdeclared) ? gdeclared : 0,
                status: Number.isFinite(e.response.status) ? e.response.status : 0,
                contentRange: headerValueOf(e.response.headers, 'content-range') || '',
                // v2.48.43: ummeedwaar darwaze ke liye
                // jawab ki asal type.
                contentType: (rawType.split(';')[0] || '').trim().toLowerCase()
              });
            }
          }
        } catch (err) {}
      });
      // v2.48.20: STREAMING jawab ko beech me se padho.
      // TEST496/497 ka saboot: 31 batchexecute requests ke
      // muqable sirf 7 jawab 'complete' hote hain — asal status
      // data ek aise jawab me behta hai jo run ke dauraan kabhi
      // khatam hi nahi hota, is liye na res.buffer() use pakad
      // sakta hai na getResponseBody. Network.dataReceived har
      // tukda (chunk) aate hi de deta hai — usi par scan chalega.
      client.on('Network.dataReceived', (e) => {
        try {
          if (!e || !this._cdpBatch.has(e.requestId) || typeof e.data !== 'string' || !e.data) return;
          const buf = Buffer.from(e.data, 'base64');
          if (buf.length) this._ingestStreamChunk(e.requestId, buf, Date.now());
        } catch (err) {}
      });
      client.on('Network.loadingFinished', async (e) => {
        let bigInfo = null;
        let encBytes = 0;
        let bodyBytes = 0;
        try {
          if (e && this._cdpDlShape.has(e.requestId)) {
            this.recordDownloadResponse(this._cdpDlShape.get(e.requestId), e.encodedDataLength || 0);
            this._cdpDlShape.delete(e.requestId);
          }
          if (e && this._cdpBigShape.has(e.requestId)) {
            bigInfo = this._cdpBigShape.get(e.requestId);
            this._cdpBigShape.delete(e.requestId);
            encBytes = e.encodedDataLength || 0;
          }
          if (e && this._cdpBatch.has(e.requestId)) {
            const batchMeta = this._cdpBatch.get(e.requestId);
            this._cdpBatch.delete(e.requestId);
            if (this.armed) {
              const res = await client.send('Network.getResponseBody', { requestId: e.requestId });
              const buf = decodeCdpBody(res && res.body, res && res.base64Encoded);
              if (buf && buf.length > 0 && buf.length <= this.patterns.maxBodyScanBytes * 4) {
                bodyBytes = buf.length;
                this.batchStats.cdpBodies++;
                // v2.48.31 (MINT): CDP se mile batchexecute body
                // me bhi file-address ki jaanch (wahi darwaza jo
                // [MINT] sawal ka markaz hai).
                // v2.48.33 (ZEROCLICK): asal darkhwast ka template
                // bhi saath do — carries sabit ho to wahi seekha
                // jayega.
                try {
                  if (this.mintWatch) {
                    this._checkMintCarries((batchMeta && batchMeta.method) || 'POST', 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute', null, buf, this._reqTemplateFromCdpMeta(batchMeta));
                  }
                } catch (err) {}
                this.ingestResponse({
                  url: 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute',
                  contentType: 'application/json',
                  bodyBuffer: buf,
                  at: Date.now()
                });
              }
            }
          }
          // v2.48.36 (ROOT PACK — D): PAGE-FETCH HARVEST —
          // page ne khud jo flow-content jawab khincha tha,
          // us ka body ab CDP se uthao (best-effort: na mile
          // to koi candidate nahi, kabhi blocker nahi, kabhi
          // error nahi). Rakha sirf saveGuard ke darwazon se
          // guzarne par jata hai (_retainHarvestBody).
          let mainpageFcBody = null;
          if (e && this._harvestPending.has(e.requestId)) {
            const pend = this._harvestPending.get(e.requestId);
            this._harvestPending.delete(e.requestId);
            let hbuf = null;
            try {
              const hres = await client.send('Network.getResponseBody', { requestId: e.requestId });
              hbuf = decodeCdpBody(hres && hres.body, hres && hres.base64Encoded);
            } catch (herr) { hbuf = null; }
            mainpageFcBody = hbuf;
            let retained = false;
            if (hbuf && hbuf.length > 0) {
              retained = this._retainHarvestBody(pend.url, hbuf, Date.now());
            }
            // HARVEST-AUDIT (v2.48.38; v2.48.41 me khidki
            // sirf download attempt ki hai): har mukammal
            // flow-content jawab par ek line — promotion
            // asal me hua ya nahi, aur kyun nahi. Koi
            // vyavhaar-badal nahi — sirf hisaab/khabar.
            try { this._emitHarvestAudit(pend, hbuf, retained); } catch (herr) {}
          }
          // v2.48.41 (MAIN-PAGE HARVEST PACK): MAIN page ke
          // video-jese jawab ki kitab + MAINPAGE-AUDIT.
          // flow-content ke liye body upar wali harvest
          // pipeline se guzar chuka hai (wahi hbuf);
          // googlevideo ke liye tukda yahin uthaya jata hai
          // (asal file aksar range jawab me aati hai —
          // tukda kitab me rehta hai, poora fetch engine
          // main page ke andar se karega).
          if (e && this._mainpagePending.has(e.requestId)) {
            const mpend = this._mainpagePending.get(e.requestId);
            this._mainpagePending.delete(e.requestId);
            let mbuf = null;
            if (mpend.src === 'googlevideo') {
              try {
                const mres = await client.send('Network.getResponseBody', { requestId: e.requestId });
                mbuf = decodeCdpBody(mres && mres.body, mres && mres.base64Encoded);
              } catch (merr) { mbuf = null; }
            } else {
              mbuf = mainpageFcBody;
            }
            try { this._recordMainpageSighting(mpend, mbuf, e.encodedDataLength || 0, Date.now()); } catch (merr) {}
          }
        } catch (err) {}
        // v2.48.27 (NET-BIG): faisla + khidki-hisaab — size ki
        // tarjeeh: asal body (jo uplabdh ho) > declared
        // content-length > encoded wire size. Bada jawab ho to
        // engine ko EK line; HAR jawab (chhota bhi) khidki me
        // jama hota hai, taaki download ke aakhir me render→save
        // khidki ka host-wise kul nikal sake. Koi vyavhaar-badal
        // nahi — sirf shikar.
        try {
          if (bigInfo) {
            const bestBytes = bodyBytes > 0 ? bodyBytes
              : (bigInfo.declared > 0 ? bigInfo.declared : encBytes);
            if (bestBytes > 0) this._recordNetBigWindow(bigInfo.host, bestBytes, Date.now());
            if (this.onNetBig && isNetBigResponse(Math.max(encBytes, bodyBytes), bigInfo.declared)) {
              this.onNetBig({
                host: bigInfo.host,
                shape: bigInfo.shape,
                type: bigInfo.type,
                bytes: Math.max(encBytes, bodyBytes, bigInfo.declared || 0),
                encodedBytes: encBytes,
                declaredBytes: bigInfo.declared || 0,
                at: Date.now()
              });
            }
          }
        } catch (err) {}
      });
    } catch (err) {}
  }

  /** Listeners saaf band karo — koi leak nahi (har session ke saath). */
  detach() {
    if (this._page) {
      try { if (this._reqHandler) this._page.removeListener('request', this._reqHandler); } catch (e) {}
      try { if (this._resHandler) this._page.removeListener('response', this._resHandler); } catch (e) {}
    }
    this._page = null;
    this._reqHandler = null;
    this._resHandler = null;
  }

  /**
   * Ek submission ki shuruaat — generate fire hone se THEEK pehle
   * engine bulata hai. Isi pal se capture armed bhi ho jata hai.
   */
  beginSubmission(key, at) {
    this.arm();
    const t = Number.isFinite(at) ? at : Date.now();
    this.submissions.push({ key, at: t, id: null });
    return key;
  }

  _submissionForKey(key) {
    return this.submissions.find(s => s.key === key) || null;
  }

  /**
   * Ek workflowId ko sabse pehle bina-ID wale submission se bandho
   * jo is ID ke dikhne se pehle fire hua tha (chhoti slack ke
   * saath). Bandh jaye to taskKey, warna null.
   */
  _bindId(id, at) {
    if (!id || this.keyById.has(id)) return this.keyById.get(id) || null;
    const slack = this.patterns.bindSlackMs;
    const cand = this.submissions.find(s => !s.id && s.at <= at + slack);
    if (!cand) return null;
    cand.id = id;
    this.keyById.set(id, cand.key);
    return cand.key;
  }

  _bindUrlToKey(key, url, via, at) {
    if (!key || !url) return false;
    if (this.keyByUrl.has(url)) return this.keyByUrl.get(url) === key;
    if (this.urlByKey.has(key)) return false;
    const sub = this._submissionForKey(key);
    // Hifazat: jo URL is task ke submit se pehle dekha gaya tha, wo
    // is task ka ho hi nahi sakta (purane project ka link hai).
    const sight = this.sightings.get(url);
    if (sub && sight && sight.firstSeenAt < sub.at - this.patterns.bindSlackMs) return false;
    this.urlByKey.set(key, { url, via, at: Number.isFinite(at) ? at : Date.now() });
    this.keyByUrl.set(url, key);
    // v2.48.36 (ROOT PACK — E): teacher task ka asal
    // flow-content address bandhan ke pal bhi pakad lo —
    // seekhne ke pal jawab ke andar se na mila ho to yahi
    // uski jagah lega, taaki replay muqabla kabhi 'n/a'
    // na bane jab address asal me maloom hai.
    // v2.48.37: langar ab TEMPLATE KE BAGHAIR bhi bandhta
    // hai — kisi bhi task ka flow-content address bandhte
    // hi wo session ka sab se taza mint kehlata hai
    // (last-wins). Wajah: ZEROCLICK4 me template aakhir
    // tak ghayab raha, lekin bandhe hue address maujood
    // the — muqable ko langar phir bhi milna chahiye tha.
    try {
      if (flowContent.isFlowContentVideoUrl(url)) {
        this.mintTeacherUrl = url;
        if (this.mintTemplate && this.mintTemplate.taskKey === key
          && !this.mintTemplate.teacherUrl) {
          this.mintTemplate.teacherUrl = url;
        }
      }
    } catch (e) {}
    if (sight) sight.claimedBy = key;
    if (via === 'workflow-id') this.stats.boundById++;
    else if (via === 'currentSrc') this.stats.boundByCurrentSrc++;
    else if (via === 'order') this.stats.boundByOrder++;
    try { this.onMediaBound(key, url, via); } catch (e) {}
    return true;
  }

  _sightUrl(url, source, at, coIds) {
    if (!url || !isMediaUrl(url, this.patterns)) return;
    const t = Number.isFinite(at) ? at : Date.now();
    // v2.48.40 (CASCADE): API/project jawab ke ANDAR
    // aaya address — 'project-data' wali pehli nazar.
    if (source === 'api-body' || source === 'json-body') {
      this._noteUrlFirstSeen(url, 'project-data', t);
    }
    if (!this.sightings.has(url)) {
      this.sightings.set(url, { firstSeenAt: t, source, claimedBy: null });
      this.stats.mediaUrlsSeen++;
    }
    if (this.keyByUrl.has(url)) return; // pehle se bandha hua
    // Isi jawab ke saath aaya workflowId — sabse mazboot pehchan.
    for (const id of (coIds || [])) {
      const key = this.keyById.get(id) || this._bindId(id, t);
      if (key) { this._bindUrlToKey(key, url, 'workflow-id', t); return; }
    }
  }

  /** Ek request ki khabar (URL + postData ka text roop). */
  ingestRequest(evt) {
    if (!evt || !evt.url) return { ids: [] };
    const at = Number.isFinite(evt.at) ? evt.at : Date.now();
    const ids = new Set();
    for (const id of extractWorkflowIdsFromText(String(evt.url), this.patterns)) ids.add(id);
    if (evt.postDataText) {
      for (const id of extractWorkflowIdsFromText(String(evt.postDataText), this.patterns)) ids.add(id);
      for (const u of extractUrlsFromText(String(evt.postDataText))) {
        if (isMediaUrl(u, this.patterns)) this._sightUrl(u, 'request', at, [...ids]);
      }
    }
    // Binary body (protobuf) ka latin1 roop — ID text wahan bhi
    // aksar plain dikh jata hai.
    if (evt.postDataBuffer && evt.postDataBuffer.length > 0) {
      const bodyText = evt.postDataBuffer.toString('latin1');
      for (const id of extractWorkflowIdsFromText(bodyText, this.patterns)) ids.add(id);
    }
    for (const id of ids) { this.stats.idsSeen++; this._bindId(id, at); }
    // v2.48.37 (CANDIDATE TEMPLATE): Puppeteer wale
    // raste se bhi wahi darj — CDP session na bane to
    // bhi candidate kitab na ruke (headers whitelist
    // se guzar kar; asal faisla _noteMintCandidate ka).
    if (evt.postDataBuffer && evt.postDataBuffer.length > 0 && isBatchExecuteUrl(evt.url)) {
      this._noteMintCandidate({
        url: evt.url,
        method: String(evt.method || 'POST').toUpperCase(),
        headers: pickReplayHeaders(evt.headers, this.patterns),
        body: evt.postDataBuffer
      });
    }
    // v2.48.13: STATUS TEMPLATE yaad rakho — status-shaped API
    // request (asal URL + whitelist headers + asal body bytes).
    // Engine isay replay karke backend ko seedha poochhta hai.
    // Generate wali call isStatusApiUrl se khud-bakhud bahar hai.
    const templateIds = [];
    if (evt.postDataBuffer && evt.postDataBuffer.length > 0
      && evt.postDataBuffer.length <= this.patterns.maxTemplateBodyBytes
      && isStatusApiUrl(evt.url, this.patterns)) {
      const tpl = {
        url: evt.url,
        method: String(evt.method || 'POST').toUpperCase(),
        headers: pickReplayHeaders(evt.headers, this.patterns),
        body: Buffer.from(evt.postDataBuffer),
        at
      };
      this.latestStatusTemplate = tpl;
      for (const id of ids) { this.statusTemplates.set(id, tpl); templateIds.push(id); }
    }
    return { ids: [...ids], templateIds };
  }

  /**
   * v2.48.13: is task ke liye replay template — pehle usi ke apne
   * workflowId wala (sabse pakka), warna is submission ke baad ka
   * sabse taza status template (project ki list-wali call bhi is
   * task ki video ka link apne jawab me la sakti hai; bandish hamesha
   * maujood pehchan ke usoolon se hi hoti hai — galat task ko URL
   * kabhi nahi milta).
   */
  templateForKey(key) {
    const sub = this._submissionForKey(key);
    if (!sub) return null;
    if (sub.id && this.statusTemplates.has(sub.id)) return this.statusTemplates.get(sub.id);
    if (this.latestStatusTemplate
      && this.latestStatusTemplate.at >= sub.at - (this.patterns.templateMaxAgeMs || 120000)) {
      return this.latestStatusTemplate;
    }
    return null;
  }

  /** v2.48.24: download census me ek response ka entry. */
  recordDownloadResponse(shape, bytes) {
    if (!shape) return;
    const cur = this.downloadCensus.get(shape) || { n: 0, bytes: 0 };
    cur.n++;
    cur.bytes += Math.max(0, bytes | 0);
    this.downloadCensus.set(shape, cur);
  }

  /** v2.48.24: census ka chhota khulasa (log ke liye). */
  downloadCensusSummary() {
    const out = {};
    for (const [shape, v] of this.downloadCensus.entries()) out[shape] = `${v.n}x/${v.bytes}B`;
    return out;
  }

  /** v2.48.27 (NET-BIG): ek mukammal jawab ka behtareen size khidki me darj karo. */
  _recordNetBigWindow(host, bytes, at) {
    if (!host || !(bytes > 0)) return;
    this.netBigWindow.push({ host, bytes, at: Number.isFinite(at) ? at : Date.now() });
    if (this.netBigWindow.length > 5000) {
      this.netBigWindow.splice(0, this.netBigWindow.length - 5000);
    }
  }

  /**
   * v2.48.27 (NET-BIG): `sinceMs` (aam taur par render-complete)
   * se is pal tak har host ke kul bytes, descending —
   * 'host=bytes host=bytes …'. Khaali ho to ''.
   */
  netBigWindowSummary(sinceMs) {
    return summarizeNetBigWindow(this.netBigWindow, sinceMs);
  }

  /**
   * v2.48.28 (SERVER-FIRST): ek asal server video jawab yaad
   * rakho. Pehchan yahan dobara bhi hoti hai (matcher) — galat
   * shakal ka URL is fehrist me ghus hi nahi sakta. Ek hi URL
   * dobara dikhe to uska waqt taaza ho jata hai (nayi entry nahi).
   */
  _recordFlowContentVideo(url, type, at) {
    if (!flowContent.isFlowContentVideoUrl(url, type)) return;
    const t = Number.isFinite(at) ? at : Date.now();
    const normType = String(type || '').split(';')[0].trim().toLowerCase();
    const existing = this.flowContentVideos.find(e => e.url === url);
    if (existing) { existing.at = t; if (normType) existing.type = normType; return; }
    this.flowContentVideos.push({ url, type: normType, at: t });
    if (this.flowContentVideos.length > 50) {
      this.flowContentVideos.splice(0, this.flowContentVideos.length - 50);
    }
  }

  /**
   * v2.48.28 (SERVER-FIRST): `sinceMs` se is pal tak dekhe gaye
   * woh server video jawab jo abhi kisi task ke naam nahi hue —
   * purane se naye ki taraf. Engine in par apne pehchan-darwaze
   * (task ka apna hona) laga kar hi koi URL chunta hai.
   */
  recentFlowContentVideos(sinceMs) {
    const since = Number.isFinite(sinceMs) ? sinceMs : 0;
    return this.flowContentVideos
      .filter(e => e.at >= since && !this.flowContentClaimed.has(e.url))
      .sort((a, b) => a.at - b.at)
      .map(e => ({ url: e.url, type: e.type, at: e.at }));
  }

  /** v2.48.28: is URL ko ek task ke naam kar do (doosra nahi lega). */
  claimFlowContentVideo(url) {
    if (!url || this.flowContentClaimed.has(url)) return false;
    this.flowContentClaimed.add(url);
    return true;
  }

  /** v2.48.28: URL pehle hi kisi task ke naam ho chuka hai kya? */
  isFlowContentClaimed(url) {
    return !!url && this.flowContentClaimed.has(url);
  }

  /**
   * v2.48.36 (ROOT PACK — D): page ke khinche hue ek
   * flow-content jawab ke body ko harvest kitab me rakho.
   * Darwaze saveGuard ke khalis hisaab se hain:
   *   - URL pehle se kisi task ke naam bandha ho to bandhan
   *     ke saath poora faisla (harvestCandidateVerdict) —
   *     pass ho to us task ke naam ek body (pehli wali hi
   *     rehti hai);
   *   - bandhan abhi na hua ho to aam darwaze
   *     (harvestGenericGates) guzarne par body URL ke naam
   *     pakdi rehti hai (hadd 2) — bandhan bante hi
   *     harvestForKey use asal task ke naam kar deta hai,
   *     wahan faisla dobara poora chalta hai.
   * Koi bhi nakami = koi candidate nahi (khamoshi se).
   */
  _retainHarvestBody(url, buffer, at) {
    try {
      if (!url || !Buffer.isBuffer(buffer) || buffer.length === 0) return false;
      const t = Number.isFinite(at) ? at : Date.now();
      const headerOk = downloadFetch.looksLikeVideoBuffer(buffer);
      const floor = this.harvestFloorBytes || 0;
      const key = this.keyByUrl.get(url) || null;
      if (key) {
        const v = saveGuard.harvestCandidateVerdict({
          bound: true, byteLength: buffer.length, floorBytes: floor, headerOk
        });
        if (!v.accept) return false;
        if (!this.harvestBodies.has(key)) {
          this.harvestBodies.set(key, { url, buffer, at: t });
        }
        return true;
      }
      const g = saveGuard.harvestGenericGates({
        byteLength: buffer.length, floorBytes: floor, headerOk
      });
      if (!g.ok) return false;
      if (!this._harvestByUrl.has(url) && this._harvestByUrl.size >= 2) {
        const firstKey = this._harvestByUrl.keys().next().value;
        this._harvestByUrl.delete(firstKey);
      }
      if (!this._harvestByUrl.has(url)) {
        this._harvestByUrl.set(url, { buffer, at: t });
      }
      return true;
    } catch (e) { return false; }
  }

  /**
   * v2.48.36 (ROOT PACK — D): is task ke liye rakha hua
   * page-fetch body ({ url, buffer, at }) ya null. URL ke
   * naam pakdi body bandhan banne par yahin task ke naam
   * ho jati hai (faisla dobara poora chalta hai — bandhan
   * ke baghair kabhi nahi milti).
   */
  harvestForKey(key) {
    try {
      if (!key) return null;
      if (this.harvestBodies.has(key)) return this.harvestBodies.get(key);
      const bound = this.urlByKey.get(key);
      if (!bound || !bound.url) return null;
      const held = this._harvestByUrl.get(bound.url);
      if (!held) return null;
      this._harvestByUrl.delete(bound.url);
      const v = saveGuard.harvestCandidateVerdict({
        bound: true,
        byteLength: held.buffer.length,
        floorBytes: this.harvestFloorBytes || 0,
        headerOk: downloadFetch.looksLikeVideoBuffer(held.buffer)
      });
      if (!v.accept) return null;
      const entry = { url: bound.url, buffer: held.buffer, at: held.at };
      this.harvestBodies.set(key, entry);
      return entry;
    } catch (e) { return null; }
  }

  /** v2.48.36 (ROOT PACK — D): task ka harvest saaf karo (round ke aakhir par engine bulata hai). */
  evictHarvest(key) {
    try { if (key) this.harvestBodies.delete(key); } catch (e) {}
  }

  /**
   * v2.48.38 (EDITOR-HARVEST PACK): engine ki khabar — ek
   * download attempt (stage-lock holder) shuru / khatam.
   * Harvest-audit sirf is khidki me chalta hai: kisi task
   * ka download attempt chal raha ho. (v2.48.41: editor-
   * khidki khatam — editor ab kabhi khulta hi nahi.)
   */
  setDownloadAttempt(key) {
    try {
      this._downloadAttemptKey = key || null;
    } catch (e) {}
  }

  /** v2.48.38: download attempt khatam — audit ki khidki band. */
  clearDownloadAttempt(key) {
    try {
      if (!key || this._downloadAttemptKey === key) this._downloadAttemptKey = null;
    } catch (e) {}
  }

  /**
   * v2.48.40 (INVISIBLE HARVEST PACK — CASCADE): ek
   * address ki sab se pehli nazar darj karo. Sirf PEHLI
   * nazar rehti hai — baad ki nazar use badal nahi
   * sakti (warna 'sab se pehle kahan' ka matlab hi
   * khatam ho jayega). kind: 'project-data' |
   * 'mint-response' | 'stream-get'. Asal address sirf
   * is kitab ki kunji hai — log me kabhi nahi jata.
   */
  _noteUrlFirstSeen(url, kind, at) {
    try {
      if (!url || typeof kind !== 'string' || !kind) return;
      if (this._urlFirstSeen.has(url)) return;
      if (this._urlFirstSeen.size >= 300) {
        const firstKey = this._urlFirstSeen.keys().next().value;
        this._urlFirstSeen.delete(firstKey);
      }
      this._urlFirstSeen.set(url, { at: Number.isFinite(at) ? at : Date.now(), kind });
    } catch (e) {}
  }

  /**
   * v2.48.40 (CASCADE): is task/address ka cascade
   * faisla — faisla saveGuard.cascadeVerdict (khalis)
   * se; yahan sirf kitab se khabar ikatthi hoti hai.
   * Address na mila ho to bhi ek saaf jawab ('none').
   */
  cascadeForKey(key, url) {
    try {
      const obs = url ? (this._urlFirstSeen.get(url) || null) : null;
      // v2.48.41: editor kabhi khulta hi nahi — editorAt
      // hamesha null (firstSeen kabhi 'editor-open' nahi
      // banta; preEditorUrl address dikhne par 'yes').
      return saveGuard.cascadeVerdict({ observation: obs, editorOpenedAt: null });
    } catch (e) {
      return { firstSeen: 'none', preEditorUrl: 'no' };
    }
  }

  /**
   * v2.48.38 (EDITOR-HARVEST PACK): harvest-audit ki ek
   * khabar engine ko — sirf tab jab audit ki khidki khuli
   * ho (download attempt chal raha ho; v2.48.41 se
   * editor-khidki khatam hai). Faisla
   * saveGuard.harvestAuditOf (khalis) se: promotion asal
   * _retainHarvestBody darj se aata hai; inkaar ki wajah
   * gates ke hisaab se dobara gin kar di jati hai
   * (body-fail sab se pehle).
   */
  _emitHarvestAudit(pend, buffer, promoted) {
    try {
      if (!this.onHarvestAudit) return;
      if (!this._downloadAttemptKey) return;
      const bodyOk = !!(buffer && buffer.length > 0);
      let reason = 'ok';
      if (!bodyOk) reason = 'body-fail';
      else if (!promoted) {
        let teacherUrl = null;
        try { teacherUrl = this.teacherMintUrlForTemplate(null); } catch (e) { teacherUrl = null; }
        if (teacherUrl && pend && pend.url === teacherUrl) reason = 'teacher-url';
        else {
          const g = saveGuard.harvestGenericGates({
            byteLength: buffer.length,
            floorBytes: this.harvestFloorBytes || 0,
            headerOk: downloadFetch.looksLikeVideoBuffer(buffer)
          });
          reason = g.ok ? 'unbound' : g.reason;
        }
      }
      let teacherUrl = null;
      try { teacherUrl = this.teacherMintUrlForTemplate(null); } catch (e) { teacherUrl = null; }
      const audit = saveGuard.harvestAuditOf({
        byteLength: bodyOk ? buffer.length : 0,
        bodyOk,
        hash: bodyOk ? saveGuard.contentHash(buffer) : null,
        url: pend ? pend.url : null,
        teacherUrl,
        promoted: !!promoted,
        reason
      });
      try { this.onHarvestAudit(audit); } catch (e) {}
    } catch (e) {}
  }

  /** v2.48.41: is pal ka timing bucket — attempt chal raha ho to 'download-attempt', warna 'render-watch'. */
  _mainpageTimingBucket() {
    return this._downloadAttemptKey ? 'download-attempt' : 'render-watch';
  }

  /**
   * v2.48.41 (MAIN-PAGE HARVEST PACK): MAIN page par
   * mukammal hue ek video-jese jawab ko mainpage kitab
   * me darj karo + MAINPAGE-AUDIT ki khabar do. Audit
   * sirf render-watch / download-attempt ki khidkiyon
   * me chalti hai (armed ho ya attempt chal raha ho) —
   * un ke bahar jawab kitab me bhi nahi jata (purane
   * projects ki streams kitab gandi na karen).
   * Faisla (decision):
   *   - 'captured' — jawab kitab me pakda gaya:
   *     flow-content ki mukammal body harvest kitab me
   *     hai (reason 'ok'); googlevideo ka tukda kitab
   *     me hai (reason 'partial-stream' — poora fetch
   *     engine main page ke andar se karega);
   *   - 'ignored' — teacher-url (teacher ka address
   *     kitab me KABHI nahi jata — wo pichhli file
   *     hai), body-fail (CDP body mili hi nahi — entry
   *     phir bhi rehti hai taaki engine page-context
   *     fetch aazma sake), already-claimed (kisi aur
   *     task ke naam ho chuka).
   * Entry: { url, src, host, bytes, bodyBytes, at,
   *   timing, status, contentRange, declared, partial }
   * — bytes behtareen kul size hai (body / content-
   * range kul / declared / encoded me se sab se bada);
   * asal URL sirf yaad me, log me kabhi nahi.
   */
  _recordMainpageSighting(pend, buffer, encodedBytes, at) {
    try {
      if (!pend || !pend.url) return;
      if (!this.armed && !this._downloadAttemptKey) return;
      const now = Number.isFinite(at) ? at : Date.now();
      const bucket = this._mainpageTimingBucket();
      const bodyLen = buffer && buffer.length ? buffer.length : 0;
      const cr = typeof pend.contentRange === 'string' ? pend.contentRange : '';
      let total = 0;
      const m = cr.match(/\/(\d+)\s*$/);
      if (m) total = parseInt(m[1], 10) || 0;
      const bytes = Math.max(bodyLen, total, pend.declared || 0, encodedBytes || 0);
      const partial = saveGuard.isPartialHarvestResponse({
        status: pend.status, contentRange: cr,
        byteLength: bodyLen > 0 ? bodyLen : bytes,
        declaredLength: total > 0 ? total : (pend.declared || 0),
        floorBytes: this.harvestFloorBytes || 0
      });
      const emit = (decision, reason) => {
        if (!this.onMainpageAudit) return;
        try {
          const a = saveGuard.mainpageAuditOf({
            host: hostOf(pend.url), bytes, src: pend.src, decision, reason,
            // v2.48.42: kitab me darj ke pal bandhan ka
            // haal — pakda gaya stream abhi kisi ka nahi
            // bandha (bindReason=none); naam ho chuka ho
            // to us task ka label.
            bindReason: 'none',
            claimedBy: this.mainpageClaimedByLabel(pend.url) || 'none'
          });
          a.timing = bucket;
          a.partial = partial;
          this.onMainpageAudit(a);
        } catch (e) {}
      };
      let teacherUrl = null;
      try { teacherUrl = this.teacherMintUrlForTemplate(null); } catch (e) { teacherUrl = null; }
      if (teacherUrl && pend.url === teacherUrl) { emit('ignored', 'teacher-url'); return; }
      // v2.48.43 (HOVER + PATIENCE PACK): UMMEEDWAAR
      // DARWAZA — kul size ka behtareen pata: Content-
      // Range ka kul, warna mukammal (na-adhoore) jawab
      // ki asal body hi kul hai. Us ke baghair kul na
      // maloom. Darwaza (saveGuard.mainpageCandidateGate):
      // maloom kul hadd se chhota ho to ye stream
      // ummeedwaar KABHI nahi banta — kitab me darj hi
      // nahi hota, audit 'ignored / stream-too-small'
      // (ZEROCLICK10 ki 87,478-byte wali hit isi me
      // rukti hai).
      const knownTotal = total > 0 ? total : (bodyLen > 0 && !partial ? bodyLen : null);
      const gate = saveGuard.mainpageCandidateGate({
        knownTotal,
        src: pend.src === 'googlevideo' ? 'googlevideo' : 'flow-content',
        contentType: typeof pend.contentType === 'string' && pend.contentType ? pend.contentType : null
      });
      if (!gate.candidate && gate.reason === 'stream-too-small') { emit('ignored', 'stream-too-small'); return; }
      // v2.48.42: PEHLI nazar ka pal — dobara dikhne par
      // entry taaza hoti hai (at aage badhta hai) lekin
      // firstSeenAt sab se pehle wala hi rehta hai;
      // bandhan ka faisla isi par hota hai. v2.48.43:
      // capture tartib (seq) bhi pehli nazar ki hi
      // rehti hai.
      const prevIdx = this.mainpageVideos.findIndex(e => e.url === pend.url);
      const prevEntry = prevIdx >= 0 ? this.mainpageVideos[prevIdx] : null;
      const entry = {
        url: pend.url,
        src: pend.src === 'googlevideo' ? 'googlevideo' : 'flow-content',
        host: hostOf(pend.url),
        bytes,
        bodyBytes: bodyLen,
        at: now,
        firstSeenAt: prevEntry ? (Number.isFinite(prevEntry.firstSeenAt) ? prevEntry.firstSeenAt : prevEntry.at) : now,
        seq: prevEntry && Number.isFinite(prevEntry.seq) ? prevEntry.seq : ++this._mainpageSeq,
        claimedBy: this.mainpageClaimedByLabel(pend.url) || null,
        timing: bucket,
        status: Number.isFinite(pend.status) ? pend.status : 0,
        contentRange: cr,
        declared: total > 0 ? total : (pend.declared || 0),
        knownTotal,
        contentType: typeof pend.contentType === 'string' && pend.contentType ? pend.contentType : null,
        candidate: gate.candidate,
        partial
      };
      if (prevIdx >= 0) this.mainpageVideos.splice(prevIdx, 1);
      this.mainpageVideos.push(entry);
      while (this.mainpageVideos.length > 50) this.mainpageVideos.shift();
      // googlevideo tukda kitab me — hadd 2, size hadd
      // wahi purani (HARVEST_MAX_BYTES); header video ka
      // na ho to tukda kabhi nahi rakha jata.
      if (entry.src === 'googlevideo' && bodyLen > 0 && bodyLen <= saveGuard.HARVEST_MAX_BYTES
        && downloadFetch.looksLikeVideoBuffer(buffer)) {
        if (!this._mainpageBodies.has(pend.url) && this._mainpageBodies.size >= 2) {
          const firstKey = this._mainpageBodies.keys().next().value;
          this._mainpageBodies.delete(firstKey);
        }
        this._mainpageBodies.set(pend.url, { buffer, at: now });
      }
      // v2.48.43: darwaza na pass karne wali entry
      // kitab me rehti hai (dobara nazar ka hisaab)
      // lekin ummeedwaar nahi — audit 'ignored'.
      if (!gate.candidate) { emit('ignored', gate.reason); return; }
      if (this.isMainpageClaimed(pend.url)) { emit('ignored', 'already-claimed'); return; }
      if (bodyLen === 0) { emit('ignored', 'body-fail'); return; }
      emit('captured', partial ? 'partial-stream' : 'ok');
    } catch (e) {}
  }

  /** v2.48.41: mainpage kitab ki nakal (purane se naye ki taraf; buffer kabhi andar nahi). */
  mainpageEntries() {
    try {
      // v2.48.42: claimedBy hamesha taza — entry darj
      // hone ke BAAD naam hua ho to bhi dikhe.
      return this.mainpageVideos.map(e => ({
        ...e,
        firstSeenAt: Number.isFinite(e.firstSeenAt) ? e.firstSeenAt : e.at,
        claimedBy: this.mainpageClaimedByLabel(e.url) || e.claimedBy || null
      }));
    } catch (e) { return []; }
  }

  /**
   * v2.48.41: kisi mainpage address ke liye pehle se
   * pakdi hui body/tukda — googlevideo ke liye
   * _mainpageBodies se, flow-content ke liye purani
   * harvest kitab (_harvestByUrl) se. Kuch na ho to
   * null. Natija: { buffer, at }.
   */
  mainpageBodyForUrl(url) {
    try {
      if (!url) return null;
      const held = this._mainpageBodies.get(url);
      if (held && held.buffer && held.buffer.length > 0) return held;
      const byUrl = this._harvestByUrl.get(url);
      if (byUrl && byUrl.buffer && byUrl.buffer.length > 0) return byUrl;
      return null;
    } catch (e) { return null; }
  }

  /**
   * v2.48.41: mainpage address kisi task ke naam karo (flow-content wali purani kitab me bhi nishaan).
   * v2.48.42: claim = { key, label } diya jaye to naam
   * kis task ka hai wo bhi darj hota hai (claim-once:
   * pehla naam hi rehta hai, doosra kabhi nahi chadhta).
   */
  claimMainpageVideo(url, claim) {
    try {
      if (!url) return;
      this.mainpageClaimed.add(url);
      this.flowContentClaimed.add(url);
      if (claim && (claim.key != null || claim.label != null) && !this.mainpageClaimedBy.has(url)) {
        this.mainpageClaimedBy.set(url, {
          key: claim.key != null ? String(claim.key) : null,
          label: claim.label != null ? String(claim.label) : null
        });
      }
    } catch (e) {}
  }

  /** v2.48.42: is address ko kis task ke key ne naam kiya (nahi to null). */
  mainpageClaimedKey(url) {
    try {
      const info = url ? this.mainpageClaimedBy.get(url) : null;
      return info && info.key ? info.key : null;
    } catch (e) { return null; }
  }

  /** v2.48.42: is address ke naam ka log-label (task#) — nahi to null. */
  mainpageClaimedByLabel(url) {
    try {
      const info = url ? this.mainpageClaimedBy.get(url) : null;
      return info && info.label ? info.label : null;
    } catch (e) { return null; }
  }

  /**
   * v2.48.42: ek task ki khidki darj karo (us ke
   * render-complete ka pal). Sab se pehle wala aaghaz
   * hi rehta hai — retry round khidki ko aage nahi
   * dhakelta. Purani khidkiyan (6 ghante se zyada)
   * saaf hoti rehti hain taaki kitab na bhare.
   */
  mainpageNoteWindow(key, start) {
    try {
      if (!key) return;
      const t = Number.isFinite(start) ? start : Date.now();
      const prev = this.mainpageWindows.get(key);
      if (!prev) this.mainpageWindows.set(key, { start: t, done: false });
      else if (t < prev.start) prev.start = t;
      for (const [k, w] of this.mainpageWindows) {
        if (k !== key && Number.isFinite(w.start) && t - w.start > 6 * 60 * 60 * 1000) {
          this.mainpageWindows.delete(k);
        }
      }
      while (this.mainpageWindows.size > 100) {
        this.mainpageWindows.delete(this.mainpageWindows.keys().next().value);
      }
    } catch (e) {}
  }

  /** v2.48.42: is task ka download mukammal — khidki band. */
  mainpageMarkWindowDone(key) {
    try {
      if (!key) return;
      const w = this.mainpageWindows.get(key);
      if (w) w.done = true;
      else this.mainpageWindows.set(key, { start: 0, done: true });
    } catch (e) {}
  }

  /** v2.48.42: saari darj khidkiyon ki nakal: [{ key, start, done }] (aaghaz ki tartib me). */
  mainpageWindowsList() {
    try {
      return Array.from(this.mainpageWindows.entries())
        .map(([key, w]) => ({ key, start: w.start, done: !!w.done }))
        .sort((a, b) => a.start - b.start);
    } catch (e) { return []; }
  }

  /**
   * v2.48.43: TARTEEB bandhan ke liye baqi downloads
   * ki kataar — jo khidkiyan abhi mukammal (done)
   * nahi, un ke render-complete (start) ki tartib
   * me: [{ key, start }]. Pehla = sab se pehle
   * render hua baqi download.
   */
  mainpagePendingOrder() {
    try {
      return Array.from(this.mainpageWindows.entries())
        .filter(([, w]) => w && !w.done)
        .map(([key, w]) => ({ key, start: w.start }))
        .sort((a, b) => a.start - b.start);
    } catch (e) { return []; }
  }

  /**
   * v2.48.42: MERI khidki ke alawa aur kitni khidkiyan
   * abhi unbound (koi stream un ke naam nahi) aur
   * na-mukammal (download baqi) hain — exclusion
   * bandhan ki shart ka hisaab.
   */
  mainpagePendingOthers(ownKey) {
    try {
      let count = 0;
      for (const [key, w] of this.mainpageWindows) {
        if (key === ownKey || w.done) continue;
        let bound = false;
        for (const info of this.mainpageClaimedBy.values()) {
          if (info && info.key === key) { bound = true; break; }
        }
        if (!bound) count++;
      }
      return count;
    } catch (e) { return 0; }
  }

  /** v2.48.41: ye mainpage address pehle se kisi ke naam hai kya? */
  isMainpageClaimed(url) {
    try {
      return !!url && (this.mainpageClaimed.has(url) || this.flowContentClaimed.has(url));
    } catch (e) { return false; }
  }

  /**
   * v2.48.36 (ROOT PACK — E): is template ke TEACHER task
   * ka asal mint hua flow-content URL — pehle template par
   * seekhne ke pal darj hua, warna task ke bandhe hue link
   * se, warna capture ki apni kitab (mintTeacherUrl) se.
   * Teeno na hon to hi null — yani same/different muqabla
   * ab sirf tab 'n/a' hoga jab teacher ka address asal me
   * kabhi darj hi na hua ho. URL kabhi log nahi hota.
   */
  teacherMintUrlForTemplate(tpl) {
    try {
      const t = tpl || this.mintTemplate;
      if (t && t.teacherUrl) return t.teacherUrl;
      if (t && t.taskKey) {
        const bound = this.urlByKey.get(t.taskKey);
        if (bound && bound.url && flowContent.isFlowContentVideoUrl(bound.url)) return bound.url;
      }
      return this.mintTeacherUrl || null;
    } catch (e) { return null; }
  }

  /**
   * v2.48.31 (MINT): mint watch chalu/band — v2.48.37 se
   * ye ROUND wali kamaan hai. Round chalu karne par ring
   * aur carries-dedupe saaf hote hain (har download round
   * apni taaza khidki rakhta hai). Round band hone par
   * watch sirf tab band hoti hai jab SESSION wali kamaan
   * bhi band ho — warna session bhar jaari rehti hai
   * (yahi ZEROCLICK4 ka asal fix hai: seekhna ab kisi ek
   * round ki qismat par nahi chhoda gaya). Watch (asar-
   * daar) band ho to na koi request darj hoti hai, na
   * carries-khabar — baaki capture bilkul pehle ki tarah.
   */
  setMintWatch(on, taskKey) {
    const v = !!on;
    if (v) {
      if (!this._mintRoundOn) {
        // Naye round ki kitab taaza (ring + dedupe) —
        // session watch pehle se chalu ho tab bhi round
        // ki khidki apni saaf shuruaat rakhti hai.
        this.mintRequests = [];
        this._mintCarriesSeen = new Set();
      }
      this._mintRoundOn = true;
      // v2.48.33 (ZEROCLICK): is round ka task — carries wala
      // jawab aaye to mint template ISI task ke naam seekha
      // jata hai (us ke apne ID body me dhoondhe jate hain).
      this._mintTaskKey = taskKey || null;
      this.mintWatch = true;
    } else {
      this._mintRoundOn = false;
      // Pehchan saaf (template rehta hai — wo session bhar
      // ke liye seekha gaya hai).
      this._mintTaskKey = null;
      this.mintWatch = !!this._mintSessionOn;
    }
  }

  /**
   * v2.48.37 (SESSION-WIDE MINT WATCH): session wali
   * kamaan. Engine worker ka page tayyar hote hi (capture
   * attach hone par) chalu karta hai aur account chhodne
   * / run khatam hone par band. Is se mint template kisi
   * bhi pal seekha ja sakta hai — round ke andar ho ya
   * bahar. Band karne par asal watch sirf tab band hoti
   * hai jab koi round bhi na chal raha ho.
   */
  setMintSessionWatch(on) {
    const v = !!on;
    this._mintSessionOn = v;
    if (v) {
      this.mintWatch = true;
    } else {
      this.mintWatch = !!this._mintRoundOn;
    }
  }

  /**
   * v2.48.37: engine ka khabar-naama — is page par is
   * task ka render poora hua. Round ke bahar seekha gaya
   * template isi task ke naam hota hai (sab se aakhri
   * render-poora task hi wo media hai jis ka mint jawab
   * is pal aana sab se zyada maqool hai).
   */
  noteRenderCompleted(key) {
    if (key) {
      this._mintLastRenderKey = key;
      // v2.48.42: yahi pal is task ki bandhan-khidki ka
      // aaghaz hai (engine task.renderCompletedAt yahi
      // pal rakhta hai — dono ek hi ghari).
      this.mainpageNoteWindow(key, Date.now());
    }
  }

  /**
   * v2.48.37: is pal seekha jane wala template kis task
   * ke naam hoga — pehle round ka task (sab se pakka),
   * warna sab se aakhri render-poora task, warna sab se
   * taza monitored (submitted) task, warna koi nahi.
   */
  _mintAttributionKey() {
    if (this._mintTaskKey) return this._mintTaskKey;
    if (this._mintLastRenderKey) return this._mintLastRenderKey;
    if (Array.isArray(this.submissions) && this.submissions.length) {
      return this.submissions[this.submissions.length - 1].key || null;
    }
    return null;
  }

  /** v2.48.31 (MINT): `sinceMs` ke baad darj requests (mint khidki ke backfill ke liye). */
  mintRequestsSince(sinceMs) {
    const since = Number.isFinite(sinceMs) ? sinceMs : 0;
    return this.mintRequests.filter(e => e.at >= since);
  }

  /**
   * v2.48.31 (MINT): ek request ki saaf shakal darj karo —
   * sirf watch chalu ho tab. Asal URL/query values kabhi save
   * nahi hote (sanitizeRequestEntry sirf keys rakhta hai).
   */
  _noteMintRequest(reqLike) {
    if (!this.mintWatch) return;
    try {
      const entry = mintWindow.sanitizeRequestEntry(reqLike);
      if (!entry) return;
      this.mintRequests.push(entry);
      if (this.mintRequests.length > 600) {
        this.mintRequests.splice(0, this.mintRequests.length - 600);
      }
      if (this.onMintRequest) { try { this.onMintRequest(entry); } catch (e) {} }
    } catch (e) {}
  }

  /**
   * v2.48.31 (MINT): ek jawab file ke server address ko le
   * ja raha tha — engine ko khabar do, lekin ek watch me ek
   * (method|host|path) sirf EK baar (wahi API baar-baar jawab
   * de to log na bhare).
   */
  _noteMintCarries(info) {
    if (!this.mintWatch || !info) return;
    try {
      const key = `${info.method}|${info.host}|${info.path}`;
      if (this._mintCarriesSeen.has(key)) return;
      this._mintCarriesSeen.add(key);
      if (this.onMintCarriesUrl) { try { this.onMintCarriesUrl(info); } catch (e) {} }
    } catch (e) {}
  }

  /** v2.48.31 (MINT): ek jawab ki Location/body jaanch — file-address mile to carries-khabar. */
  _checkMintCarries(method, url, location, bodyText, reqTemplate) {
    if (!this.mintWatch) return;
    try {
      if (!mintWindow.responseCarriesFileUrl({ location, bodyText })) return;
      // v2.48.40 (CASCADE): ye jawab ek MINT jawab hai —
      // us ke le aaya address 'mint-response' wali pehli
      // nazar hai (Location wali surat me wahi address).
      try {
        if (location && flowContent.isFlowContentVideoUrl(location)) {
          this._noteUrlFirstSeen(location, 'mint-response', Date.now());
        }
      } catch (e) {}
      const entry = mintWindow.sanitizeRequestEntry({ method, url, at: Date.now() });
      if (entry) this._noteMintCarries({ method: entry.method, host: entry.host, path: entry.path });
      // v2.48.33 (ZEROCLICK): yahi woh darkhwast hai jis ka
      // jawab file-address le aaya — use replay template ke
      // roop me seekh lo (asal darkhwast saath aayi ho tab hi;
      // Location-wali khabar par template nahi banta).
      if (reqTemplate) {
        // v2.48.36 (ROOT PACK — E): is jawab ke andar ke
        // asal flow-content address bhi template ke saath
        // darj karo (sirf yaad me — kabhi log nahi) —
        // teacher ka yahi address aage ke har replay
        // muqable ka langar hai.
        try {
          let carriedUrls = [];
          if (bodyText) {
            const buf = Buffer.isBuffer(bodyText) ? bodyText : Buffer.from(String(bodyText), 'latin1');
            const scan = scanBatchExecuteBody(buf, this.patterns);
            carriedUrls = (scan.allUrls || []).filter(u => flowContent.isFlowContentVideoUrl(u));
          }
          reqTemplate.carriedUrls = carriedUrls;
        } catch (e) { reqTemplate.carriedUrls = []; }
        // v2.48.40 (CASCADE): is mint jawab ke le aaye
        // har address ki 'mint-response' pehli nazar.
        try {
          for (const cu of (reqTemplate.carriedUrls || [])) {
            this._noteUrlFirstSeen(cu, 'mint-response', Date.now());
          }
        } catch (e) {}
        this._learnMintTemplate(reqTemplate);
      }
    } catch (e) {}
  }

  /** v2.48.33 (ZEROCLICK): CDP meta (requestWillBeSent) se replay template ki shakal. */
  _reqTemplateFromCdpMeta(meta) {
    if (!meta || !meta.reqUrl) return null;
    return {
      url: meta.reqUrl,
      method: meta.method || 'POST',
      headers: meta.reqHeaders || {},
      body: meta.reqPostData ? Buffer.from(meta.reqPostData, 'utf8') : null
    };
  }

  /**
   * v2.48.33 (ZEROCLICK): mint-call ko replay template ke roop
   * me seekhna — status templates (v2.48.13) wali hi hifazat:
   *   - sirf batchexecute darkhwast; body size ki hadd wahi
   *     (patterns.maxTemplateBodyBytes) jo status templates
   *     ki hai;
   *   - is round ke task (_mintTaskKey) ke jaane hue ID(s)
   *     body me dhoondhe jate hain (mintReplay ke khalis
   *     hisaab se) — offsets aur primaryId (pehla mila ID)
   *     darj hote hain, taaki replay ke pal teacher ke ID ki
   *     jagah agle task ka ID rakha ja sake;
   *   - v2.48.34: wohi ID(s) ab darkhwast ke poore URL me
   *     bhi dhoondhe jate hain — urlIdOccurrences aur
   *     urlPrimaryId (URL me pehla mila ID) alag darj hote
   *     hain. ZEROCLICK live test (2026-11-03) me body me
   *     koi id NAHI mili thi (170-byte body, idsInBody=0);
   *     id asal me kahan safar karta hai, yehi agli jaanch
   *     hai — is liye URL ki ginti (idsInUrl) bhi khabar me
   *     jati hai, shakal hi, id ki qeemat kabhi nahi;
   *   - ID body me na mile to bhi template banta hai lekin
   *     primaryId null rehta hai — idsInBody=0 wali khabar
   *     khud ek saboot hai (call shayad per-media replayable
   *     nahi), aur replay us haal me khud ruk jayega;
   *   - bilkul waisa hi template (wahi task + wahi body)
   *     dobara aaye to khabar dobara nahi (round ke andar
   *     wahi call kai baar jawab de sakti hai).
   * Callback me sirf shakal jati hai — rpcids (function ke
   * naam), body ki size, aur ID occurrences ki GINTI. Asal
   * URL/headers/body/ID kabhi bahar nahi jate.
   */
  _learnMintTemplate(reqTemplate) {
    try {
      if (!reqTemplate || !reqTemplate.url || !Buffer.isBuffer(reqTemplate.body)) return;
      if (!isBatchExecuteUrl(reqTemplate.url)) return;
      const body = reqTemplate.body;
      if (body.length === 0 || body.length > this.patterns.maxTemplateBodyBytes) return;
      // v2.48.37: nisbat ab _mintAttributionKey se — round
      // ke andar round ka task, round ke bahar sab se
      // aakhri render-poora (ya monitored) task. Session
      // watch ki wajah se seekhna ab kisi bhi pal ho
      // sakta hai; learnContext wahi farq darj rakhta
      // hai (andarooni kitab — log me nahi jata).
      const inRound = !!this._mintTaskKey;
      const key = this._mintAttributionKey();
      // Is task ke jaane hue ID(s): submission par bandha
      // workflowId sab se pehle, phir keyById me is key ke
      // naam ke baaki IDs. Sirf idMinLength se lambe wale.
      const ids = [];
      if (key) {
        const sub = this._submissionForKey(key);
        if (sub && sub.id) ids.push(sub.id);
        for (const [id, k] of this.keyById) {
          if (k === key && !ids.includes(id)) ids.push(id);
        }
      }
      const usableIds = ids.filter(id => typeof id === 'string' && id.length >= this.patterns.idMinLength);
      const occurrences = mintReplay.findIdOccurrences(body, usableIds);
      const primaryId = occurrences.length ? occurrences[0].id : null;
      // v2.48.34: wohi jaane hue ID(s) ab darkhwast ke poore
      // URL string me bhi — body me id na milne ki surat me
      // replay ka dusra (aur shayad asal) rasta yahi hai.
      const urlOccurrences = mintReplay.findIdOccurrencesInText(String(reqTemplate.url || ''), usableIds);
      const urlPrimaryId = urlOccurrences.length ? urlOccurrences[0].id : null;
      // v2.48.36 (ROOT PACK — E): teacher ka asal mint hua
      // address — pehle is jawab ke andar se (carriedUrls),
      // warna is task ke bandhe hue link se. Sirf yaad me
      // rehta hai, kabhi log nahi hota.
      let teacherUrl = null;
      if (Array.isArray(reqTemplate.carriedUrls)) {
        const fc = reqTemplate.carriedUrls.filter(u => flowContent.isFlowContentVideoUrl(u));
        if (fc.length) teacherUrl = fc[0];
      }
      if (!teacherUrl && key) {
        const bound = this.urlByKey.get(key);
        if (bound && bound.url && flowContent.isFlowContentVideoUrl(bound.url)) teacherUrl = bound.url;
      }
      if (this.mintTemplate && this.mintTemplate.taskKey === key
        && Buffer.isBuffer(this.mintTemplate.body) && this.mintTemplate.body.equals(body)) {
        // Wahi template pehle se hai — khabar dobara nahi,
        // lekin teacher ka address is dafa mila ho aur
        // pehle ghayab raha ho to kitab poori kar do.
        // v2.48.37: session langar (mintTeacherUrl) ab
        // sab se TAZA mint par rehta hai (last-wins) —
        // muqabla hamesha sab se haaliya purani video se
        // hona chahiye, sab se pehli se nahi.
        if (teacherUrl) {
          if (!this.mintTemplate.teacherUrl) this.mintTemplate.teacherUrl = teacherUrl;
          this.mintTeacherUrl = teacherUrl;
        }
        return;
      }
      this.mintTemplate = {
        url: reqTemplate.url,
        method: String(reqTemplate.method || 'POST').toUpperCase(),
        headers: reqTemplate.headers || {},
        body: Buffer.from(body),
        at: Date.now(),
        taskKey: key,
        primaryId,
        ids: occurrences.map(o => o.id),
        idOccurrences: occurrences,
        urlPrimaryId,
        urlIds: urlOccurrences.map(o => o.id),
        urlIdOccurrences: urlOccurrences,
        teacherUrl,
        learnContext: inRound ? 'round' : 'session'
      };
      // v2.48.37: session langar sab se taza mint par (last-wins).
      if (teacherUrl) this.mintTeacherUrl = teacherUrl;
      if (this.onMintTemplate) {
        try {
          this.onMintTemplate({
            taskKey: key,
            rpcids: rpcidsOf(reqTemplate.url),
            bodyBytes: body.length,
            idsInBody: mintReplay.countOccurrences(occurrences),
            idsInUrl: mintReplay.countOccurrences(urlOccurrences)
          });
        } catch (e) {}
      }
    } catch (e) {}
  }

  /**
   * v2.48.37 (CANDIDATE TEMPLATE): ek batchexecute
   * darkhwast ko candidate template ke roop me darj
   * karo — sirf tab jab us ke rpcids me 'as29s' ho (har
   * dekhi gayi mint darkhwast me yahi rpcid raha hai).
   * Jawab ka intezaar NAHI hota: darkhwast dikhte hi
   * kitab me aa jati hai, sab se taza wali hi rehti hai
   * (latest wins). Hifazat seekhe template wali hi hai:
   * batchexecute URL, body size ki wahi hadd, asal URL/
   * headers/body sirf is object me (log me kabhi nahi).
   * Watch ki haalat se is ka koi lena-dena nahi — ye
   * session bhar ka safety-net hai, is liye hi woh pal
   * bhi pakad leta hai jab carrying jawab kabhi aaya
   * hi na ho (ZEROCLICK4).
   */
  _noteMintCandidate(tpl) {
    try {
      if (!tpl || !tpl.url || !Buffer.isBuffer(tpl.body)) return false;
      if (!isBatchExecuteUrl(tpl.url)) return false;
      if (!rpcidsOf(tpl.url).includes('as29s')) return false;
      if (tpl.body.length === 0 || tpl.body.length > this.patterns.maxTemplateBodyBytes) return false;
      this.mintCandidateTemplate = {
        url: tpl.url,
        method: String(tpl.method || 'POST').toUpperCase(),
        headers: tpl.headers || {},
        body: Buffer.from(tpl.body),
        at: Date.now(),
        taskKey: null,
        source: 'candidate'
      };
      return true;
    } catch (e) { return false; }
  }

  /** v2.48.37: is pal ka template darja — 'learned' | 'candidate' | 'none'. */
  mintTemplateSource() {
    if (this.mintTemplate) return 'learned';
    if (this.mintCandidateTemplate) return 'candidate';
    return 'none';
  }

  /**
   * v2.48.37: replay routes (B/C + verbatim probe) ke
   * liye qabil template — seekha hua hamesha pehle,
   * warna candidate. Natija { template, source }.
   */
  replayTemplate() {
    return {
      template: this.mintTemplate || this.mintCandidateTemplate || null,
      source: this.mintTemplateSource()
    };
  }

  /**
   * v2.48.37: [ROOT] template-state line ka hisaab
   * (saveGuard.templateStateOf — khalis). Teacher
   * address ki maujoodgi teacherMintUrlForTemplate se
   * aati hai (template ke baghair bhi bandha/langar
   * wala address gina jata hai).
   */
  templateState() {
    let teacherUrl = null;
    try { teacherUrl = this.teacherMintUrlForTemplate(null); } catch (e) { teacherUrl = null; }
    return saveGuard.templateStateOf({
      learned: !!this.mintTemplate,
      candidate: !!this.mintCandidateTemplate,
      teacherUrl
    });
  }

  /**
   * v2.48.37: engine ki khabar — is task ka download
   * kamyaab hua; us ke bandhe hue flow-content address
   * ko session ka taza teacher langar bana do (template
   * seekha gaya ho ya na ho). Address sirf yaad me
   * rehta hai, kabhi log nahi hota.
   */
  noteTeacherUrlForKey(key) {
    try {
      if (!key) return;
      const bound = this.urlByKey.get(key);
      if (bound && bound.url && flowContent.isFlowContentVideoUrl(bound.url)) {
        this.mintTeacherUrl = bound.url;
      }
    } catch (e) {}
  }

  /**
   * v2.48.33 (ZEROCLICK): is task (captureKey) ka bandha hua
   * workflowId — replay ke pal agle task ki pehchan yahi se
   * aati hai. Na bandha ho to null (replay ruk jata hai).
   */
  workflowIdForKey(key) {
    if (!key) return null;
    const sub = this._submissionForKey(key);
    return sub && sub.id ? sub.id : null;
  }

  /**
   * v2.48.20: streaming batchexecute jawab ka ek tukda.
   * Poora jama-shuda text har tukde par dobara scan hota hai
   * taaki tukdon ki sarhad par kata URL bhi mil jaye. Pehchan
   * ke nishan backend ke sach ('api-body') gine jate hain.
   */
  _ingestStreamChunk(requestId, chunkBuf, at) {
    const meta = this._cdpBatch.get(requestId);
    if (!meta) return [];
    this.batchStats.streamChunks++;
    meta.text = (meta.text || '') + chunkBuf.toString('latin1');
    if (meta.text.length > 2 * 1024 * 1024) meta.text = meta.text.slice(-1024 * 1024);
    // v2.48.31 (MINT): behta (streaming) jawab kabhi khatam hi
    // nahi hota — uske jama-shuda text me file-address dikhe to
    // wahi carries-khabar hai (dedupe ki wajah se ek hi baar).
    // v2.48.33 (ZEROCLICK): is darkhwast ka template bhi saath.
    try {
      if (this.mintWatch) {
        this._checkMintCarries(meta.method || 'POST', 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute', null, meta.text, this._reqTemplateFromCdpMeta(meta));
      }
    } catch (e) {}
    if (!this.armed) return [];
    const found = scanBatchExecuteBody(Buffer.from(meta.text, 'latin1'), this.patterns);
    const newly = [];
    for (const id of found.ids) { const b = this._bindId(id, at); if (b) newly.push(b); }
    for (const u of found.mediaUrls) {
      const b = this._sightUrl(u, 'api-body', at, found.ids);
      if (b) newly.push(b);
    }
    if (newly.length && !meta.bound) { meta.bound = true; this.batchStats.streamBound++; }
    return [...new Set(newly)];
  }

  /** Ek response ki khabar: URL + (jab mile) body buffer. */
  ingestResponse(evt) {
    if (!evt || !evt.url) return { ids: [], mediaUrls: [] };
    const at = Number.isFinite(evt.at) ? evt.at : Date.now();
    const api = isApiUrl(evt.url, this.patterns);
    if (api) this.stats.apiResponses++;
    if (isMediaUrl(evt.url, this.patterns)) {
      this._sightUrl(evt.url, 'response-url', at, []);
    }
    let found = { ids: [], mediaUrls: [] };
    if (evt.bodyBuffer && evt.bodyBuffer.length > 0) {
      this.stats.bodiesScanned++;
      // v2.48.17 DIAGNOSTIC-2: flow.google.com ke jawabon ke
      // andar ki substring talash (sirf ginti; data save nahi).
      if (hostOf(evt.url) === 'flow.google.com') {
        try {
          const text = evt.bodyBuffer.toString('latin1');
          this.flowBodyStats.scanned++;
          if (text.includes('googleusercontent')) this.flowBodyStats.mediaHostHits++;
          if (text.includes('workflowId') || text.includes('workflow_id')) this.flowBodyStats.workflowHits++;
          if (text.includes('aisandbox')) this.flowBodyStats.aisandboxHits++;
          // v2.48.18 DIAGNOSTIC-3: batchexecute bodies ki alag
          // ginti — link kis roop me aata hai, yehi sawal hai.
          if (isBatchExecuteUrl(evt.url)) {
            if (text.includes('googleusercontent')) this.batchStats.withMediaHost++;
            if (text.includes('videoplayback')) this.batchStats.withVideoplayback++;
            if (text.toLowerCase().includes('workflow')) this.batchStats.withWorkflow++;
            if (text.toLowerCase().includes('fife')) this.batchStats.withFife++;
            if (text.toLowerCase().includes('download')) this.batchStats.withDownloadWord++;
          }
        } catch (e) {}
      }
      found = scanBodyForCapture(evt.bodyBuffer, this.patterns);
      // v2.48.19: batchexecute bodies par khaas lipat-khol scan
      // bhi — aam scan un par andha hai (upar scanBatchExecuteBody
      // dekho). Is se mile nishan backend ke sach maane jate hain
      // ('api-body') kyunke ye Flow ke apne backend jawab hain.
      if (isBatchExecuteUrl(evt.url)) {
        try {
          const extra = scanBatchExecuteBody(evt.bodyBuffer, this.patterns);
          for (const id of extra.ids) if (!found.ids.includes(id)) found.ids.push(id);
          for (const u of extra.mediaUrls) if (!found.mediaUrls.includes(u)) found.mediaUrls.push(u);
          // v2.48.22: jawab ke ANDAR ke saaray links ki shaklon
          // ki ginti (asal link kabhi record nahi) — asal video
          // URL kis shakal me aata hai, ye census batayega.
          for (const u of (extra.allUrls || [])) {
            const shape = urlShape(u);
            if (this.batchStats.urlShapes[shape] !== undefined || Object.keys(this.batchStats.urlShapes).length < 24) {
              this.batchStats.urlShapes[shape] = (this.batchStats.urlShapes[shape] || 0) + 1;
            }
          }
        } catch (e) {}
      }
      // v2.48.23: baaki (non-batchexecute) bodies ke links ki
      // shaklon ki ginti bhi — TEST500 ka bandhan kisi aisi hi
      // body se hua lagta hai (batchexecute census khaali thi).
      if (!isBatchExecuteUrl(evt.url)) {
        try {
          const rawText = evt.bodyBuffer.toString('latin1');
          for (const u of extractUrlsFromText(rawText, this.patterns)) {
            const shape = urlShape(u);
            if (this.batchStats.urlShapes[shape] !== undefined || Object.keys(this.batchStats.urlShapes).length < 24) {
              this.batchStats.urlShapes[shape] = (this.batchStats.urlShapes[shape] || 0) + 1;
            }
          }
        } catch (e) {}
      }
      for (const id of found.ids) { this.stats.idsSeen++; this._bindId(id, at); }
      for (const u of found.mediaUrls) {
        this._sightUrl(u, (api || isBatchExecuteUrl(evt.url)) ? 'api-body' : 'json-body', at, found.ids);
      }
    }
    return found;
  }

  /** Is task ke liye bandha hua backend URL (ya null). */
  urlForKey(key) {
    return this.urlByKey.get(key) || null;
  }

  /** Network par ye URL dekha gaya tha kya (bandha ho ya na ho)? */
  hasSighting(url) {
    return !!url && this.sightings.has(url);
  }

  /**
   * Pehchan raasta 2 — currentSrc cross-match: task ki apni tile
   * par dikha URL agar network par bhi dekha gaya tha (bin-bandha),
   * to wahi is task ka hai.
   */
  claimByCurrentSrc(key, url, at) {
    if (!key || !url) return null;
    // Bina submission record wali key network ki koi cheez nahi le
    // sakti (recovery ke purane task isi se bachte hain — unki
    // pehchan sirf unki apni tile hai).
    if (!this._submissionForKey(key)) return null;
    if (this.urlByKey.has(key)) return this.urlByKey.get(key);
    if (!this.sightings.has(url)) return null;
    if (this.keyByUrl.has(url)) return null;
    if (this._bindUrlToKey(key, url, 'currentSrc', at)) return this.urlByKey.get(key);
    return null;
  }

  /**
   * Pehchan raasta 3 — kram: SIRF kataar ke sabse aage intezaar kar
   * raha task hi sabse pehle mila bin-bandha URL (jo uske submit ke
   * baad dekha gaya ho) le sakta hai. Engine ise SIRF download ke
   * pal par bulata hai.
   */
  claimByOrder(key, at) {
    if (!key) return null;
    if (this.urlByKey.has(key)) return this.urlByKey.get(key);
    const waiting = this.submissions.filter(s => !this.urlByKey.has(s.key));
    if (!waiting.length || waiting[0].key !== key) return null;
    const sub = waiting[0];
    let best = null;
    for (const [url, sight] of this.sightings.entries()) {
      if (sight.claimedBy || this.keyByUrl.has(url)) continue;
      if (sight.firstSeenAt < sub.at - this.patterns.bindSlackMs) continue;
      // v2.48.15: SIRF backend ke jawab ke ANDAR aaye URLs —
      // 'api-body'/'json-body' wale. Page ke apne media responses
      // ('response-url') is liye bahar hain: un me tile ke POSTER /
      // thumbnail images bhi googleusercontent par hi aate hain,
      // aur TEST492 (2026-11-01) me kram-bandish ne teeno tasks ko
      // asal video ke bajaye wahi poster-type URLs de diye — fetch
      // har baar save-verify (ffprobe) par mara, asal file phir
      // ⋮ menu se aayi. Backend-body wala URL asal media link
      // hone ka kagzi saboot rakhta hai; poster nahi rakhta.
      if (sight.source !== 'api-body' && sight.source !== 'json-body') continue;
      if (!best || sight.firstSeenAt < best.sight.firstSeenAt) best = { url, sight };
    }
    if (!best) return null;
    if (this._bindUrlToKey(key, best.url, 'order', at)) return this.urlByKey.get(key);
    return null;
  }

  statsSnapshot() {
    const topHosts = [...this.hostCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([h, c]) => `${h}×${c}`)
      .join(', ');
    const allHosts = [...this.hostCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([h, c]) => `${h}×${c}`)
      .join(', ');
    const topPaths = [...this.pathCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([h, c]) => `${h}×${c}`)
      .join(', ');
    return {
      ...this.stats, topHosts, allHosts, topPaths,
      apiRequests: Object.fromEntries(this.apiRequestCounts),
      flowBodies: { ...this.flowBodyStats },
      batch: {
        ...this.batchStats,
        rpcids: { ...this.batchStats.rpcids },
        contentTypes: { ...this.batchStats.contentTypes }
      },
      ws: { ...this.wsStats, urls: [...this.wsStats.urls] },
      submissions: this.submissions.length, bound: this.urlByKey.size,
      unclaimed: [...this.sightings.values()].filter(s => !s.claimedBy).length
    };
  }
}

module.exports = { NetworkCapture, CAPTURE_PATTERNS, hostOf, pathKeyOf, isBatchExecuteUrl, rpcidsOf, scanBatchExecuteBody, decodeCdpBody, unescapeJsonText, urlShape, isApiUrl, isMediaHostUrl, isMediaUrl, isGenerateApiUrl, isStatusApiUrl, pickReplayHeaders, extractUrlsFromText, extractWorkflowIdsFromText, scanJsonValue, scanBodyForCapture, scanFramePayload, NET_BIG_THRESHOLD_BYTES, isNetBigResponse, headerValueOf, summarizeNetBigWindow, isGooglevideoPlaybackUrl };
