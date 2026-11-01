'use strict';

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

function hostOf(url) {
  try { return new URL(String(url || '')).hostname.toLowerCase(); } catch (e) { return ''; }
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
        const api = isApiUrl(url, this.patterns);
        // Media response (page ne khud file khinchi — tile playback
        // adi): URL ki sighting note karo, body NAHI padho (badi
        // hoti hai; asal fetch engine ka kaam hai).
        if (isMediaUrl(url, this.patterns)) {
          this.ingestResponse({ url, contentType: ct, bodyBuffer: null, at: Date.now() });
        }
        if (!api && !ct.includes('json')) return;
        const declared = parseInt(headers['content-length'] || '', 10);
        if (Number.isFinite(declared) && declared > this.patterns.maxBodyScanBytes) return;
        let buf = null;
        try { buf = await res.buffer(); } catch (e) { return; }
        if (!buf || buf.length === 0 || buf.length > this.patterns.maxBodyScanBytes) return;
        this.ingestResponse({ url, contentType: ct, bodyBuffer: buf, at: Date.now() });
      } catch (e) {}
    };
    page.on('request', this._reqHandler);
    page.on('response', this._resHandler);
    // v2.48.16 DIAGNOSTIC: WebSocket sunna — Flow ki generation
    // ki khabar (aur shayad media link) ek lambi streaming line
    // se aati ho to uska saboot yahin milega: socket ka host+path
    // (query nahi), frames ki ginti, aur frames ke andar media
    // URL / workflow ID ke nishan. Asal frame data kabhi save
    // nahi hota.
    try {
      page.on('websocket', (ws) => {
        try {
          this.wsStats.sockets++;
          let hostPath = 'ws';
          try { const p = new URL(ws.url()); hostPath = p.hostname + p.pathname; } catch (e) {}
          if (this.wsStats.urls.length < 5 && !this.wsStats.urls.includes(hostPath)) {
            this.wsStats.urls.push(hostPath);
          }
          ws.on('framereceived', (frame) => {
            try {
              this.wsStats.framesIn++;
              const payload = frame && frame.payload;
              if (payload) {
                this.wsStats.bytesIn += payload.length || 0;
                const scan = scanFramePayload(payload, this.patterns);
                if (scan.hasMedia) this.wsStats.mediaFrames++;
                if (scan.hasWorkflow) this.wsStats.workflowFrames++;
              }
            } catch (e) {}
          });
          ws.on('framesent', () => { try { this.wsStats.framesOut++; } catch (e) {} });
        } catch (e) {}
      });
    } catch (e) {}
    return true;
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
      found = scanBodyForCapture(evt.bodyBuffer, this.patterns);
      for (const id of found.ids) { this.stats.idsSeen++; this._bindId(id, at); }
      for (const u of found.mediaUrls) {
        this._sightUrl(u, api ? 'api-body' : 'json-body', at, found.ids);
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
    return {
      ...this.stats, topHosts, allHosts,
      apiRequests: Object.fromEntries(this.apiRequestCounts),
      ws: { ...this.wsStats, urls: [...this.wsStats.urls] },
      submissions: this.submissions.length, bound: this.urlByKey.size,
      unclaimed: [...this.sightings.values()].filter(s => !s.claimedBy).length
    };
  }
}

module.exports = { NetworkCapture, CAPTURE_PATTERNS, hostOf, isApiUrl, isMediaHostUrl, isMediaUrl, isGenerateApiUrl, isStatusApiUrl, pickReplayHeaders, extractUrlsFromText, extractWorkflowIdsFromText, scanJsonValue, scanBodyForCapture, scanFramePayload };
