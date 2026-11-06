'use strict';

// v2.48.36 (ROOT PACK) + v2.48.41 (MAIN-PAGE HARVEST
// PACK): jad par hamla — featureon ke khalis faisle aur
// capture wiring:
//   A. stageLock — download-stage ka promise-mutex:
//      kataar tartib se khulti hai, throw par bhi agla
//      nahi rukta, waitedMs kataar ka waqt deta hai, aur
//      stageLockFor ek hi capture ko hamesha ek hi tala.
//   D. harvest darwaze (saveGuard.harvestGenericGates /
//      harvestCandidateVerdict): unbound = inkaar, floor
//      se neeche = inkaar, header kharab = inkaar, theek
//      = qubool; aur NetworkCapture ki kitab — bandhan ke
//      saath retain, bandhan se pehle aayi body ka
//      promotion, evict.
//   B/C. replayUrlVerdict — verbatim replay ke jawab ka
//      faisla: teacher ka address = 'teacher' (fetch
//      kabhi nahi), akela naya = 'save', kai naye =
//      'ambiguous', claimed = 'claimed', khaali = 'none'.
//   E. teacher URL kitab: template seekhne ke pal asal
//      mint address darj hota hai (warna bandhe link se),
//      aur teacherMintUrlForTemplate use hamesha deta
//      hai jab wo asal me darj hua ho — muqabla 'n/a'
//      sirf tab jab address kabhi darj hi na hua ho.
// Usage: node test_js/run_root_pack_tests.js

const { createStageLock, stageLockFor } = require('../engine/stageLock');
const {
  HARVEST_MAX_BYTES,
  harvestGenericGates,
  harvestCandidateVerdict,
  replayUrlVerdict,
  templateStateOf,
  contentHash,
  isPartialHarvestResponse,
  mainpageHarvestVerdict,
  mainpageEntryPick,
  mainpageBindingPlan,
  MAINPAGE_MIN_CANDIDATE_BYTES,
  mainpageCandidateGate,
  mainpageKnownTotalOf,
  mainpageTooSmallMediaPick,
  fullFetchUrlCandidates,
  mainpageAuditOf,
  formatMainpageAudit,
  harvestAuditOf,
  formatHarvestAudit,
  cascadeVerdict
} = require('../engine/saveGuard');
const { classifyVerbatimProbe } = require('../engine/mintReplay');
const { NetworkCapture, isGooglevideoPlaybackUrl, parseContentRangeOffset, uncoveredChunkPieces, assembleMainpageChunks, segmentKeyOf, rangeStripOf, fetchRwRewrite, rpcVideoUrlInfo } = require('../engine/networkCapture');
const { DOWNLOAD_ROUTE_ORDER } = require('../engine/downloadRouteOrder');
const { FlowAutomationEngine, mediaBodyState, mediaLoadLogLine, mediaLoadElementPick, attemptSummaryLogLine, netloadLogLine, netloadFailedLogLine, drainNetloadStream, projectIdOfUrl, parseGalleryDateTime, pickGalleryProject, galleryEntryDecision, omni12CreditsPerVideo, modelNameParts, matchModelOption } = require('../engine/flowAutomation');
const headlessHarvest = require('../engine/headlessHarvest');
const cookiesDb = require('../engine/cookiesDb');

let passed = 0;
let failed = 0;
function eq(name, got, want) {
  if (got === want) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}
function ok(name, cond) {
  eq(name, !!cond, true);
}

const FC_TEACHER = 'https://flow-content.google/video/teacher-media?Expires=999&KeyName=k&Signature=s';
const FC_FRESH = 'https://flow-content.google/video/fresh-media?Expires=999&KeyName=k&Signature=s';
const FC_FRESH2 = 'https://flow-content.google/video/fresh-media-2?Expires=999&KeyName=k&Signature=s';
const BATCH_URL = 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=AbCdEf&f.sid=123';
const TEACHER_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

/** Ek jaali lekin header-theek MP4 buffer (offset 4 par 'ftyp'). */
function mp4Buffer(bytes) {
  const b = Buffer.alloc(Math.max(16, bytes || 1024));
  b.writeUInt32BE(b.length, 0);
  b.write('ftypisom', 4, 'ascii');
  return b;
}

async function main() {
  // ---------------------------------------------------------------------------
  // A. stageLock — tartib, throw par release, waitedMs, per-capture
  // ---------------------------------------------------------------------------
  {
    const lock = createStageLock();
    const events = [];
    let releaseA = null;
    const gateA = new Promise((res) => { releaseA = res; });
    const pA = lock.withLock(async () => { events.push('A-in'); await gateA; events.push('A-out'); });
    const pB = lock.withLock(async () => { events.push('B-in'); events.push('B-out'); });
    // Ek tick do — A andar hai, B kataar me (andar NAHI gaya).
    await new Promise((res) => setImmediate(res));
    eq('LOCK second holder waits while first holds', events.join(','), 'A-in');
    releaseA();
    await Promise.all([pA, pB]);
    eq('LOCK serialization order is FIFO', events.join(','), 'A-in,A-out,B-in,B-out');
  }
  {
    const lock = createStageLock();
    let threw = false;
    try {
      await lock.withLock(async () => { throw new Error('boom'); });
    } catch (e) { threw = true; }
    ok('LOCK withLock propagates the throw', threw);
    let ran = false;
    await lock.withLock(async () => { ran = true; });
    ok('LOCK next holder runs after a throw (release on throw)', ran);
  }
  {
    const lock = createStageLock();
    let t = 1000;
    const nowFn = () => t;
    const h1 = await lock.acquire(nowFn);
    eq('LOCK first acquire waits zero', h1.waitedMs, 0);
    const p2 = lock.acquire(nowFn);
    t = 3500;
    h1.release();
    const h2 = await p2;
    eq('LOCK waitedMs measures the queue wait', h2.waitedMs, 2500);
    h2.release();
    h2.release(); // dobara release — kuch nahi hona chahiye
    const h3 = await lock.acquire(nowFn);
    ok('LOCK double release is harmless', !!h3);
    h3.release();
  }
  {
    const capA = {};
    const capB = {};
    ok('LOCK stageLockFor same capture — same lock', stageLockFor(capA) === stageLockFor(capA));
    ok('LOCK stageLockFor other capture — other lock', stageLockFor(capA) !== stageLockFor(capB));
    ok('LOCK stageLockFor non-object — a fresh lock, no throw', !!stageLockFor(null));
    ok('LOCK stageLockFor undefined — a fresh lock, no throw', !!stageLockFor(undefined));
  }

  // ---------------------------------------------------------------------------
  // D. harvest darwaze — khalis faisle
  // ---------------------------------------------------------------------------
  {
    const floor = 200 * 1024;
    eq('HARVEST unbound candidate rejected', harvestCandidateVerdict({ bound: false, byteLength: 500000, floorBytes: floor, headerOk: true }).accept, false);
    eq('HARVEST unbound reason', harvestCandidateVerdict({ bound: false, byteLength: 500000, floorBytes: floor, headerOk: true }).reason, 'unbound');
    eq('HARVEST below-floor candidate rejected', harvestCandidateVerdict({ bound: true, byteLength: floor - 1, floorBytes: floor, headerOk: true }).accept, false);
    eq('HARVEST below-floor reason', harvestCandidateVerdict({ bound: true, byteLength: floor - 1, floorBytes: floor, headerOk: true }).reason, 'below-floor');
    eq('HARVEST bad-header candidate rejected', harvestCandidateVerdict({ bound: true, byteLength: 500000, floorBytes: floor, headerOk: false }).accept, false);
    eq('HARVEST bad-header reason', harvestCandidateVerdict({ bound: true, byteLength: 500000, floorBytes: floor, headerOk: false }).reason, 'bad-header');
    eq('HARVEST too-big candidate rejected', harvestCandidateVerdict({ bound: true, byteLength: HARVEST_MAX_BYTES + 1, floorBytes: floor, headerOk: true }).reason, 'too-big');
    eq('HARVEST empty candidate rejected', harvestCandidateVerdict({ bound: true, byteLength: 0, floorBytes: 0, headerOk: true }).reason, 'empty');
    eq('HARVEST good candidate accepted', harvestCandidateVerdict({ bound: true, byteLength: 500000, floorBytes: floor, headerOk: true }).accept, true);
    eq('HARVEST exact-floor candidate accepted', harvestCandidateVerdict({ bound: true, byteLength: floor, floorBytes: floor, headerOk: true }).accept, true);
    eq('HARVEST no-floor (0) small-but-headed accepted', harvestCandidateVerdict({ bound: true, byteLength: 5000, floorBytes: 0, headerOk: true }).accept, true);
    // Generic gates (bandhan se pehle wali surat) — wahi darwaze, bandhan ke baghair.
    eq('HARVEST generic gates good', harvestGenericGates({ byteLength: 500000, floorBytes: floor, headerOk: true }).ok, true);
    eq('HARVEST generic gates below-floor', harvestGenericGates({ byteLength: 10, floorBytes: floor, headerOk: true }).reason, 'below-floor');
    eq('HARVEST generic gates garbage input', harvestGenericGates(null).reason, 'empty');
    eq('HARVEST verdict garbage input is unbound-first', harvestCandidateVerdict(null).reason, 'unbound');
  }

  // ---------------------------------------------------------------------------
  // D. NetworkCapture harvest kitab — retain / promotion / evict
  // ---------------------------------------------------------------------------
  {
    const nc = new NetworkCapture({});
    nc.beginSubmission('task-h', Date.now());
    nc._bindId(TEACHER_ID, Date.now());
    nc._bindUrlToKey('task-h', FC_FRESH, 'workflow-id', Date.now());
    // Bandhan maujood — theek body retain hoti hai aur milti hai.
    eq('HARVEST-NC bound good body retained', nc._retainHarvestBody(FC_FRESH, mp4Buffer(600000), Date.now()), true);
    const got = nc.harvestForKey('task-h');
    ok('HARVEST-NC harvestForKey returns the entry', !!got);
    eq('HARVEST-NC entry url is the bound url', got && got.url, FC_FRESH);
    eq('HARVEST-NC entry bytes are the page bytes', got && got.buffer.length, 600000);
    // Evict ke baad kuch nahi.
    nc.evictHarvest('task-h');
    eq('HARVEST-NC evicted entry is gone', nc.harvestForKey('task-h'), null);
    // Header kharab — retain hi nahi hoti.
    eq('HARVEST-NC bad-header body not retained', nc._retainHarvestBody(FC_FRESH, Buffer.from('<html>not a video at all</html>'), Date.now()), false);
    eq('HARVEST-NC bad-header leaves no candidate', nc.harvestForKey('task-h'), null);
    // Floor se neeche — retain nahi hoti.
    nc.harvestFloorBytes = 700000;
    eq('HARVEST-NC below-floor body not retained', nc._retainHarvestBody(FC_FRESH, mp4Buffer(600000), Date.now()), false);
    eq('HARVEST-NC below-floor leaves no candidate', nc.harvestForKey('task-h'), null);
    nc.harvestFloorBytes = 0;
  }
  {
    // Bandhan se PEHLE aayi body: URL ke naam pakdi rehti
    // hai; bandhan bante hi task ki ho jati hai. Us se
    // pehle harvestForKey use NAHI deta (unbound surat
    // me candidate kabhi nahi).
    const nc = new NetworkCapture({});
    nc.beginSubmission('task-u', Date.now());
    nc._bindId(TEACHER_ID, Date.now());
    eq('HARVEST-NC unbound good body held by url', nc._retainHarvestBody(FC_FRESH, mp4Buffer(600000), Date.now()), true);
    eq('HARVEST-NC unbound body is not a candidate yet', nc.harvestForKey('task-u'), null);
    nc._bindUrlToKey('task-u', FC_FRESH, 'workflow-id', Date.now());
    const got = nc.harvestForKey('task-u');
    ok('HARVEST-NC held body promotes on binding', !!got);
    eq('HARVEST-NC promoted entry bytes', got && got.buffer.length, 600000);
    // Anjaan key par kabhi kuch nahi.
    eq('HARVEST-NC unknown key gets nothing', nc.harvestForKey('task-nope'), null);
    eq('HARVEST-NC null key gets nothing', nc.harvestForKey(null), null);
  }

  // ---------------------------------------------------------------------------
  // B/C. replayUrlVerdict — jawab ke address ka faisla
  // ---------------------------------------------------------------------------
  {
    eq('REPLAY no urls — none', replayUrlVerdict({ urls: [], teacherUrl: FC_TEACHER }).action, 'none');
    eq('REPLAY garbage input — none', replayUrlVerdict(null).action, 'none');
    // Sirf teacher ka address: fetch kabhi nahi.
    const t = replayUrlVerdict({ urls: [FC_TEACHER], teacherUrl: FC_TEACHER });
    eq('REPLAY teacher-only — teacher (never fetched)', t.action, 'teacher');
    eq('REPLAY teacher-only — no url handed out', t.url, null);
    // Teacher ke saath ek naya: naya wala hi save hoga.
    const s = replayUrlVerdict({ urls: [FC_TEACHER, FC_FRESH], teacherUrl: FC_TEACHER });
    eq('REPLAY teacher + fresh — save', s.action, 'save');
    eq('REPLAY teacher + fresh — the fresh url', s.url, FC_FRESH);
    // Do naye: shak — koi nahi.
    eq('REPLAY two fresh — ambiguous', replayUrlVerdict({ urls: [FC_FRESH, FC_FRESH2], teacherUrl: FC_TEACHER }).action, 'ambiguous');
    // Ek naya lekin claimed: nahi.
    eq('REPLAY fresh but claimed — claimed', replayUrlVerdict({ urls: [FC_FRESH], teacherUrl: FC_TEACHER, isClaimed: () => true }).action, 'claimed');
    eq('REPLAY fresh unclaimed — save', replayUrlVerdict({ urls: [FC_FRESH], teacherUrl: FC_TEACHER, isClaimed: () => false }).action, 'save');
    // Teacher ka address maloom hi na ho: akela address save.
    eq('REPLAY no teacher recorded — lone url saves', replayUrlVerdict({ urls: [FC_FRESH], teacherUrl: null }).action, 'save');
    // Wahi naya address dobara aaye (jawab me do jagah): dedupe — save.
    eq('REPLAY duplicated fresh — save (deduped)', replayUrlVerdict({ urls: [FC_FRESH, FC_FRESH], teacherUrl: FC_TEACHER }).action, 'save');
  }

  // ---------------------------------------------------------------------------
  // E. teacher URL kitab — seekhne ke pal darj; muqabla kabhi 'n/a' nahi
  // jab address asal me darj hua ho
  // ---------------------------------------------------------------------------
  {
    const nc = new NetworkCapture({});
    nc.beginSubmission('task-t', Date.now());
    nc._bindId(TEACHER_ID, Date.now());
    nc.setMintWatch(true, 'task-t');
    const reqBody = Buffer.from('f.req=[["AbCdEf","[]"]]', 'utf8');
    const bodyText = `prefix ${FC_TEACHER} suffix`;
    nc._checkMintCarries('POST', BATCH_URL, null, bodyText,
      { url: BATCH_URL, method: 'POST', headers: {}, body: reqBody });
    ok('TEACHER template learned', !!nc.mintTemplate);
    eq('TEACHER minted url recorded at learn time', nc.mintTemplate.teacherUrl, FC_TEACHER);
    eq('TEACHER teacherMintUrlForTemplate returns it', nc.teacherMintUrlForTemplate(), FC_TEACHER);
    // Muqabla: wahi address dobara aaye to 'same', alag aaye to 'different' — 'n/a' nahi.
    eq('TEACHER probe classify same (no n/a)', classifyVerbatimProbe({ carriesUrl: true, urls: [FC_TEACHER], teacherUrl: nc.teacherMintUrlForTemplate() }).urlVsTeacher, 'same');
    eq('TEACHER probe classify different (no n/a)', classifyVerbatimProbe({ carriesUrl: true, urls: [FC_FRESH], teacherUrl: nc.teacherMintUrlForTemplate() }).urlVsTeacher, 'different');
    ok('TEACHER template callback shape never carries the url', !JSON.stringify(nc.mintTemplate.primaryId || '').includes('flow-content'));
  }
  {
    // Seekhne ke pal jawab ke andar address extraction se
    // na mile, lekin task ka bandha link pehle se maujood
    // ho — kitab wahan se poori hoti hai.
    const nc = new NetworkCapture({});
    nc.beginSubmission('task-b', Date.now());
    nc._bindId(TEACHER_ID, Date.now());
    nc._bindUrlToKey('task-b', FC_TEACHER, 'workflow-id', Date.now());
    nc.setMintWatch(true, 'task-b');
    nc._learnMintTemplate({ url: BATCH_URL, method: 'POST', headers: {}, body: Buffer.from('f.req=[["AbCdEf","[]"]]') });
    ok('TEACHER fallback template learned', !!nc.mintTemplate);
    eq('TEACHER url falls back to the bound link', nc.teacherMintUrlForTemplate(), FC_TEACHER);
  }
  {
    // Kuch darj hi na hua ho to imaandari se null (muqabla tab 'n/a' banta hai).
    const nc = new NetworkCapture({});
    eq('TEACHER nothing recorded — null', nc.teacherMintUrlForTemplate(), null);
  }

  // ---------------------------------------------------------------------------
  // F. v2.48.37 — SESSION-WIDE MINT WATCH ka sulah-naama:
  // round ka band hona session watch ko NAHI bandta;
  // session ka band hona chal rahe round ko NAHI bandta;
  // dono band hon tab hi asal watch band hoti hai.
  // ---------------------------------------------------------------------------
  {
    const nc = new NetworkCapture({});
    eq('WATCH fresh capture — off', nc.mintWatch, false);
    nc.setMintSessionWatch(true);
    eq('WATCH session arm — on', nc.mintWatch, true);
    nc.setMintWatch(true, 'task-w'); // round begin
    eq('WATCH round begin over session — on', nc.mintWatch, true);
    nc.setMintWatch(false); // round end
    eq('WATCH round end does NOT disarm session watch', nc.mintWatch, true);
    nc.setMintWatch(true, 'task-w2');
    nc.setMintSessionWatch(false); // session disarm mid-round
    eq('WATCH session disarm does NOT kill a live round', nc.mintWatch, true);
    nc.setMintWatch(false);
    eq('WATCH both owners off — off', nc.mintWatch, false);
  }
  {
    // Session ke baghair purana round-only vyavhaar bilkul waisa hi.
    const nc = new NetworkCapture({});
    nc.setMintWatch(true, 'task-r');
    eq('WATCH round-only begin — on', nc.mintWatch, true);
    nc.setMintWatch(false);
    eq('WATCH round-only end — off', nc.mintWatch, false);
    // Round begin par kitab (ring) taaza hoti hai — session
    // chalu ho tab bhi.
    nc.setMintSessionWatch(true);
    nc._noteMintRequest({ method: 'POST', url: BATCH_URL });
    ok('WATCH session-on request is noted', nc.mintRequests.length >= 1);
    nc.setMintWatch(true, 'task-r2');
    eq('WATCH round begin resets the ring', nc.mintRequests.length, 0);
    nc.setMintWatch(false);
    nc.setMintSessionWatch(false);
  }
  {
    // Round ke BAHAR seekhna: session watch + render-poora
    // nisbat. Template session context ke saath banta hai.
    const nc = new NetworkCapture({});
    nc.setMintSessionWatch(true);
    nc.beginSubmission('task-s', Date.now());
    nc._bindId(TEACHER_ID, Date.now());
    nc.noteRenderCompleted('task-s');
    const reqBody = Buffer.from('f.req=[["as29s","[]"]]', 'utf8');
    nc._checkMintCarries('POST', BATCH_URL, null, `prefix ${FC_TEACHER} suffix`,
      { url: BATCH_URL, method: 'POST', headers: {}, body: reqBody });
    ok('WATCH session learn — template learned outside a round', !!nc.mintTemplate);
    eq('WATCH session learn — attributed to the render-completed task', nc.mintTemplate && nc.mintTemplate.taskKey, 'task-s');
    eq('WATCH session learn — learnContext is session', nc.mintTemplate && nc.mintTemplate.learnContext, 'session');
    // Nisbat ka dusra darja: render khabar na ho to sab se
    // taza monitored (submitted) task.
    const nc2 = new NetworkCapture({});
    nc2.setMintSessionWatch(true);
    nc2.beginSubmission('task-m', Date.now());
    eq('WATCH attribution falls back to latest submission', nc2._mintAttributionKey(), 'task-m');
    // Aur round ke andar nisbat round ke task ki hi rehti hai.
    const nc3 = new NetworkCapture({});
    nc3.beginSubmission('task-q', Date.now());
    nc3.noteRenderCompleted('task-q');
    nc3.setMintWatch(true, 'task-round');
    eq('WATCH attribution prefers the round task', nc3._mintAttributionKey(), 'task-round');
    nc3.setMintWatch(false);
  }

  // ---------------------------------------------------------------------------
  // G. v2.48.37 — CANDIDATE TEMPLATE: sirf rpcids me
  // 'as29s' wali darkhwast; sab se taza jeet-ti hai;
  // seekha template hamesha candidate se bhaari.
  // ---------------------------------------------------------------------------
  const CAND_URL_1 = 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=as29s&f.sid=111';
  const CAND_URL_2 = 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=as29s,zz99&f.sid=222';
  const OTHER_URL = 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=AbCdEf&f.sid=333';
  {
    const nc = new NetworkCapture({});
    eq('CAND no template at start — source none', nc.mintTemplateSource(), 'none');
    // rpcids me as29s NAHI — candidate nahi banta.
    eq('CAND non-as29s rpcids rejected', nc._noteMintCandidate({ url: OTHER_URL, method: 'POST', headers: {}, body: Buffer.from('x=1') }), false);
    eq('CAND rejection leaves no candidate', nc.mintCandidateTemplate, null);
    // batchexecute hi nahi — nahi banta.
    eq('CAND non-batchexecute rejected', nc._noteMintCandidate({ url: 'https://flow.google.com/other?rpcids=as29s', method: 'POST', headers: {}, body: Buffer.from('x=1') }), false);
    // Khaali body / hadd se badi body — nahi banti.
    eq('CAND empty body rejected', nc._noteMintCandidate({ url: CAND_URL_1, method: 'POST', headers: {}, body: Buffer.alloc(0) }), false);
    eq('CAND oversize body rejected', nc._noteMintCandidate({ url: CAND_URL_1, method: 'POST', headers: {}, body: Buffer.alloc(256 * 1024 + 1) }), false);
    // Theek darkhwast — candidate banta hai.
    eq('CAND as29s request accepted', nc._noteMintCandidate({ url: CAND_URL_1, method: 'POST', headers: {}, body: Buffer.from('f.req=one') }), true);
    ok('CAND candidate stored', !!nc.mintCandidateTemplate);
    eq('CAND source is candidate', nc.mintTemplateSource(), 'candidate');
    eq('CAND replay template is the candidate', nc.replayTemplate().template, nc.mintCandidateTemplate);
    eq('CAND replay template source', nc.replayTemplate().source, 'candidate');
    // Sab se taza jeet-ti hai.
    eq('CAND second request accepted', nc._noteMintCandidate({ url: CAND_URL_2, method: 'POST', headers: {}, body: Buffer.from('f.req=two') }), true);
    eq('CAND latest wins', nc.mintCandidateTemplate.url, CAND_URL_2);
    // ingestRequest (Puppeteer) wale raste se bhi darj hota hai.
    const ncP = new NetworkCapture({});
    ncP.ingestRequest({ url: CAND_URL_1, method: 'POST', headers: {}, postDataBuffer: Buffer.from('f.req=via-ingest'), at: Date.now() });
    ok('CAND noted via ingestRequest too', !!ncP.mintCandidateTemplate);
    // Seekha template candidate ko peeche chhod deta hai.
    nc.setMintSessionWatch(true);
    nc.beginSubmission('task-l', Date.now());
    nc._bindId(TEACHER_ID, Date.now());
    nc.noteRenderCompleted('task-l');
    nc._checkMintCarries('POST', BATCH_URL, null, `prefix ${FC_FRESH} suffix`,
      { url: BATCH_URL, method: 'POST', headers: {}, body: Buffer.from('f.req=[["AbCdEf","[]"]]') });
    ok('CAND learned template exists alongside candidate', !!nc.mintTemplate);
    eq('CAND learned beats candidate — source', nc.mintTemplateSource(), 'learned');
    eq('CAND learned beats candidate — replay template', nc.replayTemplate().template, nc.mintTemplate);
  }

  // ---------------------------------------------------------------------------
  // H. v2.48.37 — TEMPLATE-STATE (khalis + capture kitab):
  // template ke baghair bhi bandha address langar banta
  // hai; state line ka hisaab har surat me saaf.
  // ---------------------------------------------------------------------------
  {
    eq('STATE garbage — none/unknown', JSON.stringify(templateStateOf(null)), JSON.stringify({ template: 'none', teacherUrl: 'unknown' }));
    eq('STATE empty — none/unknown', JSON.stringify(templateStateOf({})), JSON.stringify({ template: 'none', teacherUrl: 'unknown' }));
    eq('STATE candidate only', JSON.stringify(templateStateOf({ candidate: true })), JSON.stringify({ template: 'candidate', teacherUrl: 'unknown' }));
    eq('STATE learned beats candidate', JSON.stringify(templateStateOf({ learned: true, candidate: true })), JSON.stringify({ template: 'learned', teacherUrl: 'unknown' }));
    eq('STATE teacher known', JSON.stringify(templateStateOf({ teacherUrl: FC_TEACHER })), JSON.stringify({ template: 'none', teacherUrl: 'known' }));
    eq('STATE empty-string teacher is unknown', templateStateOf({ teacherUrl: '' }).teacherUrl, 'unknown');
  }
  {
    const nc = new NetworkCapture({});
    eq('STATE-NC fresh — none/unknown', JSON.stringify(nc.templateState()), JSON.stringify({ template: 'none', teacherUrl: 'unknown' }));
    // Item 3: koi template NAHI, lekin ek task ka
    // flow-content address bandh gaya — langar maujood.
    nc.beginSubmission('task-a', Date.now());
    nc._bindId(TEACHER_ID, Date.now());
    nc._bindUrlToKey('task-a', FC_TEACHER, 'workflow-id', Date.now());
    eq('STATE-NC bound url anchors teacher without any template', nc.mintTeacherUrl, FC_TEACHER);
    eq('STATE-NC state — none/known', JSON.stringify(nc.templateState()), JSON.stringify({ template: 'none', teacherUrl: 'known' }));
    eq('STATE-NC teacherMintUrlForTemplate uses the anchor', nc.teacherMintUrlForTemplate(), FC_TEACHER);
    // Engine ki kamyaabi-khabar (noteTeacherUrlForKey) bhi
    // wahi langar pakka karti hai.
    nc.mintTeacherUrl = null;
    nc.noteTeacherUrlForKey('task-a');
    eq('STATE-NC noteTeacherUrlForKey restores the anchor', nc.mintTeacherUrl, FC_TEACHER);
    nc.noteTeacherUrlForKey('task-nope');
    eq('STATE-NC unknown key leaves the anchor untouched', nc.mintTeacherUrl, FC_TEACHER);
    // Candidate aate hi state candidate/known.
    nc._noteMintCandidate({ url: CAND_URL_1, method: 'POST', headers: {}, body: Buffer.from('f.req=one') });
    eq('STATE-NC candidate — candidate/known', JSON.stringify(nc.templateState()), JSON.stringify({ template: 'candidate', teacherUrl: 'known' }));
  }

  // ---------------------------------------------------------------------------
  // I. v2.48.41 — MAIN-PAGE HARVEST PACK (owner order
  // 2026-11-04, ZEROCLICK8 eye-verdict ke baad):
  //   (a) tartib: video ke sirf do raaste — mainpage-
  //       harvest pehle, grid-replay dusra; editor/
  //       menu/viewer/backend sab gayab;
  //   (b) mainpageHarvestVerdict: unbound = inkaar,
  //       teacher (url/hash) = inkaar, duplicate =
  //       inkaar, theek bandha jawab = save;
  //   (c) capture ki mainpage kitab: main page ke
  //       flow-content + googlevideo jawab darj hote
  //       hain (asal CDP wiring se bhi), teacher kabhi
  //       nahi, audit har jawab par (khidki ke andar);
  //   (d) adhoora jawab (206 / Content-Range / floor
  //       se neeche) inkaar nahi — 'fetch-full';
  //   (e) mainpage-audit ka hisaab + poora-fetch URL
  //       ummeedwaar (range hisse saaf) + purani
  //       harvest-audit barkarar.
  // ---------------------------------------------------------------------------
  // --- I/J/K ke jaali karagar: CDP client + Puppeteer page ---
  function fakeCdpClient(getBody) {
    const client = {
      handlers: {},
      sent: [],
      detached: false,
      on(ev, fn) { client.handlers[ev] = fn; },
      async send(method, params) {
        client.sent.push({ method, params });
        if (method === 'Network.getResponseBody') return getBody ? getBody(params) : { body: '', base64Encoded: false };
        return {};
      },
      async detach() { client.detached = true; }
    };
    return client;
  }
  function fakePage(name, opts = {}) {
    const page = {
      name,
      _url: opts.url || 'https://flow.google.com/project/test-project',
      _closed: false,
      gotoCalls: [],
      bringToFrontCalls: 0,
      closeCalls: 0,
      _ctx: opts.context || null,
      _browser: opts.browser || null,
      _cdp: opts.cdpClient || null,
      url() { return page._url; },
      isClosed() { return page._closed; },
      async goto(u) { page.gotoCalls.push(u); page._url = u; },
      async bringToFront() { page.bringToFrontCalls++; },
      async close() { page.closeCalls++; page._closed = true; },
      on() {},
      async evaluate() { return typeof opts.evaluateResult === 'function' ? opts.evaluateResult() : (opts.evaluateResult !== undefined ? opts.evaluateResult : 3); },
      async evaluateOnNewDocument() {},
      target() { return { createCDPSession: async () => page._cdp || fakeCdpClient() }; },
      browserContext() { return page._ctx; },
      browser() { return page._browser; },
      mouse: { click: async () => {} }
    };
    return page;
  }
  const GV_URL = 'https://rr2---sn-abc123.googlevideo.com/videoplayback?expire=999&id=xyz&itag=18&source=youtube';
  const FC_FRESH3 = 'https://flow-content.google/video/fresh-media-3?Expires=999&KeyName=k&Signature=s';
  {
    // (a) tartib — sirf do raaste, baaki sab gayab
    eq('MP-ORDER order is exactly headless-harvest then mainpage-harvest then grid-replay', JSON.stringify(DOWNLOAD_ROUTE_ORDER), JSON.stringify(['headless-harvest', 'mainpage-harvest', 'grid-replay']));
    for (const banned of ['editor-harvest', 'replay-context', 'direct-viewer', 'native-menu', 'native-editor', 'blob-harvest', 'backend-fetch', 'backend-order', 'tile-readiness', 'tile-src', 'quick-check']) {
      ok(`MP-ORDER ${banned} is absent from the order`, !DOWNLOAD_ROUTE_ORDER.includes(banned));
    }
    // googlevideo pehchan
    ok('MP googlevideo matcher accepts a real playback url', isGooglevideoPlaybackUrl(GV_URL));
    eq('MP googlevideo matcher rejects the flow-content host', isGooglevideoPlaybackUrl(FC_FRESH), false);
    eq('MP googlevideo matcher rejects a look-alike host', isGooglevideoPlaybackUrl('https://googlevideo.com.evil.com/videoplayback?x=1'), false);
    eq('MP googlevideo matcher rejects a non-playback path', isGooglevideoPlaybackUrl('https://rr1.googlevideo.com/other?x=1'), false);
  }
  {
    // (b) bandish + teacher + duplicate darwaze
    const teacherBuf = mp4Buffer(600000);
    const freshBuf = mp4Buffer(600000);
    freshBuf[100] = 0xAB; // bytes alag — hash alag
    const tHash = contentHash(teacherBuf);
    const fHash = contentHash(freshBuf);
    eq('MP unbound verdict rejected', mainpageHarvestVerdict({ bound: false, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 600000, floorBytes: 200 * 1024, headerOk: true }).reason, 'unbound');
    const dup = mainpageHarvestVerdict({ bound: true, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 600000, floorBytes: 200 * 1024, headerOk: true, hash: tHash, teacherHash: tHash });
    eq('MP teacher-identical bytes rejected', dup.accept, false);
    eq('MP teacher-identical reason is duplicate-content', dup.reason, 'duplicate-content');
    eq('MP duplicate flag rejected as duplicate-content', mainpageHarvestVerdict({ bound: true, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 600000, floorBytes: 200 * 1024, headerOk: true, duplicate: true }).reason, 'duplicate-content');
    eq('MP teacher url rejected', mainpageHarvestVerdict({ bound: true, url: FC_TEACHER, teacherUrl: FC_TEACHER, byteLength: 600000, floorBytes: 200 * 1024, headerOk: true }).reason, 'teacher-url');
    const good = mainpageHarvestVerdict({ bound: true, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 600000, floorBytes: 200 * 1024, headerOk: true, hash: fHash, teacherHash: tHash });
    eq('MP fresh complete bound bytes accepted', good.accept, true);
    eq('MP fresh complete action is save', good.action, 'save');
    eq('MP bad-header verdict is body reject', mainpageHarvestVerdict({ bound: true, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 600000, floorBytes: 200 * 1024, headerOk: false, status: 200 }).reason, 'bad-header');
    eq('MP missing url verdict', mainpageHarvestVerdict({ bound: true, url: null, teacherUrl: FC_TEACHER, byteLength: 600000, headerOk: true }).reason, 'no-url');
  }
  {
    // (c) mainpage kitab — seedha darj (khidki, teacher,
    // googlevideo tukda, claim, body-fail)
    const audits = [];
    const nc = new NetworkCapture({ onMainpageAudit: (a) => audits.push(a) });
    const buf = mp4Buffer(600000);
    // Khidki band (na armed, na attempt) — kuch darj nahi.
    nc._recordMainpageSighting({ url: FC_FRESH, src: 'flow-content', declared: 600000, status: 200, contentRange: '' }, buf, 600000, Date.now());
    eq('MP-NC outside any window — nothing recorded', nc.mainpageEntries().length, 0);
    eq('MP-NC outside any window — no audit', audits.length, 0);
    nc.arm();
    nc._recordMainpageSighting({ url: FC_FRESH, src: 'flow-content', declared: 600000, status: 200, contentRange: '' }, buf, 600000, Date.now());
    eq('MP-NC flow-content sighting recorded', nc.mainpageEntries().length, 1);
    const e1 = nc.mainpageEntries()[0];
    eq('MP-NC entry src is flow-content', e1.src, 'flow-content');
    eq('MP-NC entry host is flow-content.google', e1.host, 'flow-content.google');
    eq('MP-NC entry bytes', e1.bytes, 600000);
    eq('MP-NC complete entry is not partial', e1.partial, false);
    eq('MP-NC entry timing is render-watch', e1.timing, 'render-watch');
    eq('MP-NC audit captured/ok', audits.length === 1 && audits[0].decision, 'captured');
    eq('MP-NC audit reason ok', audits[0].reason, 'ok');
    // Attempt ki khidki — timing bucket badal jata hai.
    nc.setDownloadAttempt('task-mp');
    nc._recordMainpageSighting({ url: FC_FRESH2, src: 'flow-content', declared: 600000, status: 200, contentRange: '' }, buf, 600000, Date.now());
    eq('MP-NC attempt-window timing is download-attempt', nc.mainpageEntries()[1].timing, 'download-attempt');
    nc.clearDownloadAttempt('task-mp');
    // Teacher ka address kitab me KABHI nahi jata.
    const auditsT = [];
    const ncT = new NetworkCapture({ onMainpageAudit: (a) => auditsT.push(a) });
    ncT.arm();
    ncT.mintTeacherUrl = FC_TEACHER;
    ncT._recordMainpageSighting({ url: FC_TEACHER, src: 'flow-content', declared: 600000, status: 200, contentRange: '' }, buf, 600000, Date.now());
    eq('MP-NC teacher url never recorded', ncT.mainpageEntries().length, 0);
    eq('MP-NC teacher audit is ignored/teacher-url', auditsT.length === 1 && auditsT[0].decision === 'ignored' && auditsT[0].reason === 'teacher-url', true);
    // googlevideo adhoora jawab — tukda kitab me, kul
    // size content-range se, audit partial-stream.
    const chunk = mp4Buffer(224692);
    nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000' }, chunk, 224692, Date.now());
    const gv = nc.mainpageEntries().find(e => e.src === 'googlevideo');
    ok('MP-NC googlevideo sighting recorded', !!gv);
    eq('MP-NC googlevideo entry is partial', gv && gv.partial, true);
    eq('MP-NC googlevideo entry bytes come from the content-range total', gv && gv.bytes, 1250000);
    const gvAudit = audits[audits.length - 1];
    eq('MP-NC googlevideo audit is captured/partial-stream', gvAudit.decision === 'captured' && gvAudit.reason === 'partial-stream', true);
    const heldChunk = nc.mainpageBodyForUrl(GV_URL);
    eq('MP-NC googlevideo chunk is retained for the route', heldChunk && heldChunk.buffer.length, 224692);
    // Claim ke baad wahi address dobara — audit
    // already-claimed, aur isMainpageClaimed sach.
    nc.claimMainpageVideo(GV_URL);
    eq('MP-NC claimed url reports claimed', nc.isMainpageClaimed(GV_URL), true);
    nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000' }, chunk, 224692, Date.now());
    eq('MP-NC re-sighting of a claimed url audits already-claimed', audits[audits.length - 1].reason, 'already-claimed');
    // Body hi na mile — entry phir bhi (engine page-
    // context fetch aazmayega), audit body-fail.
    const before = nc.mainpageEntries().length;
    nc._recordMainpageSighting({ url: FC_FRESH3, src: 'flow-content', declared: 600000, status: 200, contentRange: '' }, null, 0, Date.now());
    eq('MP-NC body-fail sighting still leaves an entry', nc.mainpageEntries().length, before + 1);
    eq('MP-NC body-fail audit is ignored/body-fail', audits[audits.length - 1].decision === 'ignored' && audits[audits.length - 1].reason === 'body-fail', true);
  }
  {
    // (c2) asal CDP wiring: MAIN page ke jawab khud
    // kitab + audit tak pahunchte hain.
    const audits = [];
    const nc = new NetworkCapture({ onMainpageAudit: (a) => audits.push(a) });
    const fcBody = mp4Buffer(600000);
    const gvChunk = mp4Buffer(224692);
    const client = fakeCdpClient((params) => {
      if (params && params.requestId === 'fc-1') return { body: fcBody.toString('base64'), base64Encoded: true };
      if (params && params.requestId === 'gv-1') return { body: gvChunk.toString('base64'), base64Encoded: true };
      return { body: '', base64Encoded: false };
    });
    const page = fakePage('main-cdp', { cdpClient: client });
    nc.attach(page);
    await new Promise((r) => setTimeout(r, 25));
    nc.arm();
    client.handlers['Network.responseReceived']({
      requestId: 'fc-1',
      response: { url: FC_FRESH, status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(fcBody.length) } }
    });
    await client.handlers['Network.loadingFinished']({ requestId: 'fc-1', encodedDataLength: fcBody.length });
    eq('MP-CDP flow-content response lands in the mainpage book', nc.mainpageEntries().length, 1);
    eq('MP-CDP flow-content entry src', nc.mainpageEntries()[0].src, 'flow-content');
    ok('MP-CDP flow-content audit captured', audits.some(a => a.src === 'flow-content' && a.decision === 'captured'));
    client.handlers['Network.responseReceived']({
      requestId: 'gv-1',
      response: { url: GV_URL, status: 206, headers: { 'content-type': 'video/mp4', 'content-length': '224692', 'content-range': 'bytes 0-224691/1250000' } }
    });
    await client.handlers['Network.loadingFinished']({ requestId: 'gv-1', encodedDataLength: 224692 });
    eq('MP-CDP googlevideo response lands in the mainpage book', nc.mainpageEntries().length, 2);
    const gv = nc.mainpageEntries().find(e => e.src === 'googlevideo');
    eq('MP-CDP googlevideo entry is partial with the range total', gv && gv.partial === true && gv.bytes === 1250000, true);
    ok('MP-CDP googlevideo audit captured/partial-stream', audits.some(a => a.src === 'googlevideo' && a.decision === 'captured' && a.reason === 'partial-stream'));
    nc.detach();
  }
  {
    // (d) adhoora jawab — poora fetch ka hukm, inkaar nahi
    eq('MP-PARTIAL 206 is partial', isPartialHarvestResponse({ status: 206, byteLength: 600000 }), true);
    eq('MP-PARTIAL content-range is partial', isPartialHarvestResponse({ status: 200, contentRange: 'bytes 0-99/600000', byteLength: 100 }), true);
    eq('MP-PARTIAL declared se chhota is partial', isPartialHarvestResponse({ status: 200, byteLength: 300000, declaredLength: 600000 }), true);
    eq('MP-PARTIAL floor se neeche is partial', isPartialHarvestResponse({ status: 200, byteLength: 100000, floorBytes: 200 * 1024 }), true);
    eq('MP-PARTIAL mukammal jawab partial nahi', isPartialHarvestResponse({ status: 200, byteLength: 600000, declaredLength: 600000, floorBytes: 200 * 1024 }), false);
    const v206 = mainpageHarvestVerdict({ bound: true, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 300000, floorBytes: 200 * 1024, headerOk: true, status: 206 });
    eq('MP-PARTIAL 206 verdict action is fetch-full', v206.action, 'fetch-full');
    eq('MP-PARTIAL 206 verdict is not an accept', v206.accept, false);
    eq('MP-PARTIAL content-range verdict action is fetch-full', mainpageHarvestVerdict({ bound: true, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 100, floorBytes: 200 * 1024, headerOk: true, contentRange: 'bytes 0-99/600000' }).action, 'fetch-full');
    eq('MP-PARTIAL below-floor verdict action is fetch-full', mainpageHarvestVerdict({ bound: true, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 100000, floorBytes: 200 * 1024, headerOk: true, status: 200 }).action, 'fetch-full');
  }
  {
    // (e) mainpage-audit hisaab + poora-fetch URL
    // ummeedwaar + purani harvest-audit barkarar
    const a = mainpageAuditOf({ host: 'rr2---sn-abc123.googlevideo.com', bytes: 224692, src: 'googlevideo', decision: 'captured', reason: 'partial-stream' });
    eq('MP-AUDIT host passes through', a.host, 'rr2---sn-abc123.googlevideo.com');
    eq('MP-AUDIT bytes pass through', a.bytes, 224692);
    const line = formatMainpageAudit(a);
    ok('MP-AUDIT line carries every field', line.includes('host=rr2---sn-abc123.googlevideo.com') && line.includes('bytes=224692') && line.includes('src=googlevideo') && line.includes('decision=captured') && line.includes('reason=partial-stream'));
    eq('MP-AUDIT bad src normalizes to none', mainpageAuditOf({ src: 'weird' }).src, 'none');
    eq('MP-AUDIT bad decision normalizes to ignored', mainpageAuditOf({ decision: 'won' }).decision, 'ignored');
    eq('MP-AUDIT no host normalizes to none', mainpageAuditOf({}).host, 'none');
    eq('MP-FETCHURL no range params — single candidate', JSON.stringify(fullFetchUrlCandidates('https://h/videoplayback?a=1&b=2')), JSON.stringify(['https://h/videoplayback?a=1&b=2']));
    const cands = fullFetchUrlCandidates('https://h/videoplayback?range=0-99&itag=18&sig=zzz');
    eq('MP-FETCHURL range param yields a cleaned second candidate', cands.length, 2);
    ok('MP-FETCHURL cleaned candidate drops range, keeps itag and sig', cands[1].includes('itag=18') && cands[1].includes('sig=zzz') && !cands[1].includes('range='));
    eq('MP-FETCHURL empty input — no candidates', JSON.stringify(fullFetchUrlCandidates(null)), JSON.stringify([]));
    // Purani harvest-audit (page-fetch wali) barkarar:
    const buf = mp4Buffer(600000);
    const other = mp4Buffer(600000);
    other[100] = 0xAB;
    const h = contentHash(buf);
    const aSame = harvestAuditOf({ byteLength: buf.length, bodyOk: true, hash: h, teacherHash: h, promoted: true, reason: 'ok' });
    eq('HA-AUDIT same-hash vsTeacher is same', aSame.vsTeacher, 'same');
    eq('HA-AUDIT promoted decision', aSame.decision, 'promoted');
    eq('HA-AUDIT hash is first 8 only', aSame.hash, h.slice(0, 8));
    eq('HA-AUDIT different-hash vsTeacher is different', harvestAuditOf({ byteLength: buf.length, bodyOk: true, hash: contentHash(other), teacherHash: h, promoted: false, reason: 'unbound' }).vsTeacher, 'different');
    const aFail = harvestAuditOf({ byteLength: 0, bodyOk: false, promoted: false, reason: 'body-fail' });
    eq('HA-AUDIT body-fail body field', aFail.body, 'fail');
    eq('HA-AUDIT body-fail hash is n/a', aFail.hash, 'n/a');
    const hline = formatHarvestAudit(aSame);
    ok('HA-AUDIT line carries every field', hline.includes(`bytes=${buf.length}`) && hline.includes('body=ok') && hline.includes(`hash=${h.slice(0, 8)}`) && hline.includes('vsTeacher=same') && hline.includes('decision=promoted') && hline.includes('reason=ok'));
    ok('HA-AUDIT line never carries the full hash', !hline.includes(h));
    // Capture ki harvest-audit sirf attempt khidki me
    // bolti hai — bahar khamosh (editor-khidki gayi).
    const nc = new NetworkCapture({});
    let heard = 0;
    nc.onHarvestAudit = () => { heard++; };
    nc._emitHarvestAudit({ url: FC_FRESH }, buf, true);
    eq('HA-AUDIT silent outside a download attempt', heard, 0);
    nc.setDownloadAttempt('task-a');
    nc._emitHarvestAudit({ url: FC_FRESH }, buf, true);
    eq('HA-AUDIT speaks during a download attempt', heard, 1);
    nc.clearDownloadAttempt('task-a');
    nc._emitHarvestAudit({ url: FC_FRESH }, buf, true);
    eq('HA-AUDIT silent after the attempt ends', heard, 1);
  }

  // ---------------------------------------------------------------------------
  // J. v2.48.41 — mainpageEntryPick (saveGuard, khalis):
  // mainpage kitab se sab se pakka ummeedwaar:
  //   bandha+mukammal > koi mukammal > bandha+adhoora
  //   > koi adhoora; teacher/duplicate/kharab-header
  //   kabhi nahi; har darje me sab se taza pehle.
  // ---------------------------------------------------------------------------
  {
    const floor = 200 * 1024;
    const teacherBuf = mp4Buffer(600000);
    const freshBuf = mp4Buffer(600000);
    freshBuf[100] = 0xAB;
    const tHash = contentHash(teacherBuf);
    const fHash = contentHash(freshBuf);
    const completeBound = { url: FC_FRESH, bound: true, byteLength: 600000, headerOk: true, partial: false, status: 200, hash: fHash, teacherHash: tHash };
    const completeFree = { url: FC_FRESH, bound: false, byteLength: 600000, headerOk: true, partial: false, status: 200, hash: fHash, teacherHash: tHash };
    const partialBound = { url: FC_FRESH2, bound: true, byteLength: 100000, headerOk: true, partial: true, status: 206, contentRange: 'bytes 0-99999/600000' };
    const partialFree = { url: FC_FRESH2, bound: false, byteLength: 100000, headerOk: true, partial: true, status: 206, contentRange: 'bytes 0-99999/600000' };

    const pickA = mainpageEntryPick({ entries: [completeBound], teacherUrl: FC_TEACHER, floorBytes: floor });
    eq('PICK bound complete — picked', pickA.pick, true);
    eq('PICK bound complete — url', pickA.url, FC_FRESH);
    eq('PICK bound complete — verdict save', pickA.verdict && pickA.verdict.action, 'save');
    eq('PICK unbound complete alone — picked (save)', mainpageEntryPick({ entries: [completeFree], teacherUrl: FC_TEACHER, floorBytes: floor }).verdict.action, 'save');
    eq('PICK bound partial alone — picked (fetch-full)', mainpageEntryPick({ entries: [partialBound], teacherUrl: FC_TEACHER, floorBytes: floor }).verdict.action, 'fetch-full');
    eq('PICK unbound partial alone — picked (fetch-full)', mainpageEntryPick({ entries: [partialFree], teacherUrl: FC_TEACHER, floorBytes: floor }).verdict.action, 'fetch-full');
    // Darja: mukammal (chahe unbound) adhoore bandhe
    // se upar hai — save fetch-full se pehle.
    const pickPref = mainpageEntryPick({ entries: [partialBound, completeFree], teacherUrl: FC_TEACHER, floorBytes: floor });
    eq('PICK a complete body beats a bound partial', pickPref.url, FC_FRESH);
    // Do mukammal — sab se taza jeet-ta hai.
    const newer = { url: FC_FRESH2, bound: true, byteLength: 600000, headerOk: true, partial: false, status: 200, hash: fHash, teacherHash: tHash };
    eq('PICK newest complete wins', mainpageEntryPick({ entries: [completeBound, newer], teacherUrl: FC_TEACHER, floorBytes: floor }).url, FC_FRESH2);
    // Gande ummeedwaar kabhi nahi.
    eq('PICK teacher url — no pick', mainpageEntryPick({ entries: [{ url: FC_TEACHER, bound: true, byteLength: 600000, headerOk: true, partial: false, status: 200 }], teacherUrl: FC_TEACHER, floorBytes: floor }).pick, false);
    eq('PICK teacher-identical bytes — no pick', mainpageEntryPick({ entries: [{ url: FC_FRESH, bound: true, byteLength: 600000, headerOk: true, partial: false, status: 200, hash: tHash, teacherHash: tHash }], teacherUrl: FC_TEACHER, floorBytes: floor }).pick, false);
    eq('PICK duplicate-flagged — no pick', mainpageEntryPick({ entries: [{ url: FC_FRESH, bound: true, byteLength: 600000, headerOk: true, partial: false, status: 200, duplicate: true }], teacherUrl: FC_TEACHER, floorBytes: floor }).pick, false);
    eq('PICK header-broken — no pick', mainpageEntryPick({ entries: [{ url: FC_FRESH, bound: true, byteLength: 600000, headerOk: false, partial: false, status: 200 }], teacherUrl: FC_TEACHER, floorBytes: floor }).pick, false);
    eq('PICK empty book — no pick', mainpageEntryPick({ entries: [], teacherUrl: FC_TEACHER, floorBytes: floor }).pick, false);
    eq('PICK garbage input — no pick', mainpageEntryPick(null).pick, false);
  }

  // ---------------------------------------------------------------------------
  // K. v2.48.41 — ENGINE ki satah + asal raaste:
  //   (a) editor/bg/viewer/menu route functions engine
  //       aur capture dono se GAYAB hain — koi rasta
  //       kabhi fire hi nahi ho sakta;
  //   (b) main page par koi stream na ho to attempt
  //       EMAANDARI se FAIL (koi fallback nahi khulta);
  //   (c) bandhi hui mukammal body mainpage-harvest se
  //       save hoti hai — via=mainpage-harvest line ke
  //       saath, bg flag ke baghair;
  //   (d) googlevideo adhoora jawab usi MAIN page ke
  //       andar poora fetch ho kar save hota hai.
  // ---------------------------------------------------------------------------
  {
    // (a) satah — gayab functions
    const eng = new FlowAutomationEngine({ onLog: () => {} });
    eq('MP-ENG mainpage route exists', typeof eng._tryMainpageHarvest, 'function');
    eq('MP-ENG mainpage full-fetch helper exists', typeof eng._fetchMainpageFullInPage, 'function');
    eq('MP-ENG grid-replay is kept', typeof eng._tryGridReplay, 'function');
    for (const gone of ['_tryEditorHarvest', '_tryEditorHarvestInner', '_tryEditorContextReplay', '_openHarvestEditor', '_createBackgroundPage', '_closeBgEditorSession', '_bgHarvestActiveFor', '_tryDirectViewerDownload', '_openTileViewer', '_tryMenuFirstDownload', '_opportunisticServerCheck', '_tryBlobHarvestDownload', '_fetchEditorHarvestFullInPage', '_savePromotedHarvestInstead']) {
      eq(`MP-ENG ${gone} is gone`, typeof eng[gone], 'undefined');
    }
    eq('MP-ENG no background session state remains', eng._bgEditorSession, undefined);
    eq('MP-ENG capture has no background attach', typeof eng.netCapture.attachBackgroundPage, 'undefined');
    eq('MP-ENG capture has no editor window book', typeof eng.netCapture.beginEditorWindow, 'undefined');
    eq('MP-ENG capture has no editor harvest book', typeof eng.netCapture.editorHarvestEntriesForKey, 'undefined');
    eq('MP-ENG capture has the mainpage book', typeof eng.netCapture.mainpageEntries, 'function');
  }
  {
    // (b) EMAANDAR FAIL — main page par kuch nahi mila
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpagePatienceMs: 600, mainpageViewportWaitMs: 200, mainpageHoverGraceMs: 100, mainpagePointerGraceMs: 100 });
    eng.page = fakePage('main-mp-fail');
    eng._readTileMediaState = async () => null;
    const task = { promptIndex: 0, captureKey: 'k-mp-fail', videoId: 'k-mp-fail', startTime: Date.now(), renderCompletedAt: Date.now() };
    const res = await eng._downloadTaskMediaInner(task, '/tmp', { duration: '10s' }, 0);
    eq('MP-FAIL inner returns not-ok', res.ok, false);
    eq('MP-FAIL the task route order is the three-step order', JSON.stringify(task.downloadRouteOrder), JSON.stringify(['headless-harvest', 'mainpage-harvest', 'grid-replay']));
    ok('MP-FAIL attempts carry mainpage-harvest', res.attempts.some(a => a.strategy === 'mainpage-harvest'));
    ok('MP-FAIL attempts carry no banned strategy', !res.attempts.some(a => ['editor-harvest', 'replay-context', 'direct-viewer', 'native-menu', 'native-editor', 'blob-harvest', 'backend-fetch', 'backend-order', 'tile-src', 'tile-src-fast', 'quick-check'].includes(a.strategy)));
    ok('MP-FAIL the honest-fail line was logged', logs.some(m => m.includes('Download failed honestly')));
    ok('MP-FAIL the tile audit line logged src=none', logs.some(m => m.includes('[ROOT] mainpage-audit') && m.includes('src=none')));
    ok('MP-FAIL no bg flag anywhere in the log', !logs.some(m => m.includes('bg=')));
  }
  {
    // (c) bandhi hui mukammal body — seedha save
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) });
    eng.page = fakePage('main-mp-win');
    eng._readTileMediaState = async () => null;
    const nc = eng.netCapture;
    nc.harvestBodies.set('k-mp-win', { url: FC_FRESH, buffer: mp4Buffer(600000), at: Date.now() });
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const task = { promptIndex: 0, captureKey: 'k-mp-win', videoId: 'k-mp-win', startTime: Date.now() - 1000, renderCompletedAt: Date.now() - 500 };
    const attempts = [];
    const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, attempts, 'k-mp-win', 0);
    eq('MP-WIN the retained main-page body saves', okSave, true);
    ok('MP-WIN the win line is via=mainpage-harvest', logs.some(m => m.includes('[ROOT] via=mainpage-harvest gap=')));
    ok('MP-WIN the promoted audit line was logged', logs.some(m => m.includes('[ROOT] mainpage-audit') && m.includes('decision=promoted')));
    ok('MP-WIN the attempt strategy is mainpage-harvest', attempts.some(a => a.strategy === 'mainpage-harvest' && a.ok));
    ok('MP-WIN no bg flag in the win lines', !logs.some(m => m.includes('bg=')));
  }
  {
    // (d) googlevideo adhoora jawab — MAIN page ke
    // andar poora fetch, phir save
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) });
    const full = mp4Buffer(1250000);
    eng.page = fakePage('main-mp-gv', { evaluateResult: { status: 200, b64: full.toString('base64') } });
    eng._readTileMediaState = async () => null;
    const nc = eng.netCapture;
    nc.arm();
    nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000' }, mp4Buffer(224692), 224692, Date.now());
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const task = { promptIndex: 0, captureKey: 'k-mp-gv', videoId: 'k-mp-gv', startTime: Date.now() - 1000, renderCompletedAt: Date.now() - 500 };
    const attempts = [];
    const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, attempts, 'k-mp-gv', 0);
    eq('MP-GV the completed googlevideo stream saves', okSave, true);
    ok('MP-GV the capture audit saw the partial stream first', logs.some(m => m.includes('[ROOT] mainpage-audit') && m.includes('src=googlevideo') && m.includes('reason=partial-stream')));
    ok('MP-GV the win line is via=mainpage-harvest', logs.some(m => m.includes('[ROOT] via=mainpage-harvest gap=')));
    ok('MP-GV the promoted audit names googlevideo', logs.some(m => m.includes('[ROOT] mainpage-audit') && m.includes('decision=promoted') && m.includes('src=googlevideo')));
    ok('MP-GV the attempt strategy is mainpage-harvest', attempts.some(a => a.strategy === 'mainpage-harvest' && a.ok));
  }

  // ---------------------------------------------------------------------------
  // L. CASCADE (v2.48.40 se, v2.48.41 me barkarar):
  // khalis hisaab waisa hi hai; capture ki kitab me
  // editor ab kabhi khulta hi nahi, is liye asal
  // chalne me firstSeen kabhi 'editor-open' nahi
  // banta aur address dikhne par preEditorUrl=yes
  // rehta hai.
  // ---------------------------------------------------------------------------
  {
    eq('CS project-data before any editor — firstSeen', cascadeVerdict({ observation: { at: 1000, kind: 'project-data' }, editorOpenedAt: 2000 }).firstSeen, 'project-data');
    eq('CS stream first seen inside an editor would be editor-open (pure math)', cascadeVerdict({ observation: { at: 3000, kind: 'stream-get' }, editorOpenedAt: 2000 }).firstSeen, 'editor-open');
    eq('CS no editor ever opened — preEditorUrl yes', cascadeVerdict({ observation: { at: 1000, kind: 'project-data' }, editorOpenedAt: null }).preEditorUrl, 'yes');
    eq('CS nothing seen — firstSeen none', cascadeVerdict({ observation: null, editorOpenedAt: null }).firstSeen, 'none');
    eq('CS garbage input — none/no', JSON.stringify(cascadeVerdict(null)), JSON.stringify({ firstSeen: 'none', preEditorUrl: 'no' }));
    // Capture kitab: sirf PEHLI nazar rehti hai; editor
    // na hone se stream-get apna naam barkarar rakhta hai.
    const nc = new NetworkCapture({});
    nc._noteUrlFirstSeen(FC_FRESH, 'project-data', 1000);
    nc._noteUrlFirstSeen(FC_FRESH, 'stream-get', 500);
    eq('CS NC the first sighting wins over later ones', nc._urlFirstSeen.get(FC_FRESH).kind, 'project-data');
    const c1 = nc.cascadeForKey('k-cs', FC_FRESH);
    eq('CS NC project-data — firstSeen', c1.firstSeen, 'project-data');
    eq('CS NC project-data — preEditorUrl yes (no editor exists)', c1.preEditorUrl, 'yes');
    nc._noteUrlFirstSeen(FC_FRESH2, 'stream-get', 1500);
    const c2 = nc.cascadeForKey('k-cs', FC_FRESH2);
    eq('CS NC main-page stream stays stream-get', c2.firstSeen, 'stream-get');
    eq('CS NC main-page stream — preEditorUrl yes', c2.preEditorUrl, 'yes');
    eq('CS NC unseen url — firstSeen none', nc.cascadeForKey('k-cs', FC_FRESH3).firstSeen, 'none');
  }

  // ---------------------------------------------------------------------------
  // M. v2.48.42 — MAIN-PAGE BINDING PACK → v2.48.43
  // HOVER + PATIENCE PACK:
  //   (a) mainpageBindingPlan (khalis) — v2.48.43 me
  //       TARTEEB (ORDER): ummeedwaaron ki kataar
  //       pehli-nazar + capture seq se, baqi downloads
  //       ki kataar render-complete se; meri jodi
  //       kataar me meri jagah wala; exclusion
  //       fallback barkarar; ambiguity sirf ASAL
  //       bandh-ganth (ek pal + seq bhi alag na kare)
  //       par. (.42 ki khidki-taqseem ZEROCLICK10 me
  //       nakam rahi — us ke test yahin naye qaaide se
  //       badle gaye hain.)
  //   (b) capture kitab: firstSeenAt pehli nazar par
  //       rukta hai, claim-once label, khidkiyan +
  //       pendingOthers hisaab;
  //   (c) audit lines me bindReason/claimedBy (aur un
  //       ke baghair .41 wali shakal barkarar);
  //   (d) ENGINE: order save (padosi stream ko haath
  //       nahi), hover-watch ke baad completion fetch
  //       + save, exclusion save, claimed stream
  //       doosri task ko kabhi nahi;
  //   (e) v2.48.43 HOV test alag section N me hain.
  // ---------------------------------------------------------------------------
  {
    const PO = [{ key: 'k1', start: 1000 }, { key: 'k2', start: 2000 }];
    const cand = (url, t, seq) => ({ url, firstSeenAt: t, seq });
    // ORDER (ZEROCLICK10 wala asal manzar): akela
    // stream baad-render wale sibling ki khidki ke
    // pal par aaya — purani taqseem use sibling ka
    // bana kar pehle task ke liye zaya karti thi;
    // tarteeb use sab se pehle baqi download (k1)
    // ko deti hai.
    const pOrd = mainpageBindingPlan({ candidates: [cand('u-late', 2500, 1)], ownKey: 'k1', ownStart: 1000, pendingOrder: PO, pendingOthers: 1 });
    eq('BIND-PLAN order binds the only stream to the earliest pending', pOrd.bind, true);
    eq('BIND-PLAN order reason', pOrd.reason, 'order');
    eq('BIND-PLAN order picks the stream', pOrd.url, 'u-late');
    // tartib ki dusri jodi: k2 ke liye kataar ka
    // dusra ummeedwaar (pehla k1 ke hisse ka hai).
    const pOrd2 = mainpageBindingPlan({ candidates: [cand('u-first', 1500, 1), cand('u-second', 2500, 2)], ownKey: 'k2', ownStart: 2000, pendingOrder: PO, pendingOthers: 1 });
    eq('BIND-PLAN ordinal second pair binds', pOrd2.bind, true);
    eq('BIND-PLAN ordinal second pair picks the second stream', pOrd2.url, 'u-second');
    // kataar ka pehla ummeedwaar pehle baqi download
    // ke hisse ka hai — k2 use nahi le sakta.
    const pHead = mainpageBindingPlan({ candidates: [cand('u-first', 1500, 1)], ownKey: 'k2', ownStart: 2000, pendingOrder: PO, pendingOthers: 1 });
    eq('BIND-PLAN head stream stays reserved for the earlier pending task', pHead.bind, false);
    eq('BIND-PLAN head-reserved reason is none', pHead.reason, 'none');
    // ek hi pal par do — capture seq tarteeb alag
    // karta hai (input be-tarteeb diya gaya hai).
    const pSeq = mainpageBindingPlan({ candidates: [cand('u-b', 3000, 2), cand('u-a', 3000, 1)], ownKey: 'k1', ownStart: 1000, pendingOrder: [PO[0]], pendingOthers: 0 });
    eq('BIND-PLAN capture seq breaks a same-moment tie', pSeq.bind, true);
    eq('BIND-PLAN seq tie-break picks the earlier capture', pSeq.url, 'u-a');
    // ASAL bandh-ganth: ek hi pal, seq bhi nahi —
    // koi nahi uthega.
    const pTie = mainpageBindingPlan({ candidates: [{ url: 'u-a', firstSeenAt: 3000 }, { url: 'u-b', firstSeenAt: 3000 }], ownKey: 'k1', ownStart: 1000, pendingOrder: [PO[0]], pendingOthers: 0 });
    eq('BIND-PLAN genuine tie is ambiguous', pTie.reason, 'ambiguous');
    eq('BIND-PLAN genuine tie binds nothing', pTie.bind, false);
    eq('BIND-PLAN genuine tie count is 2', pTie.count, 2);
    // meri jodi ke BAAD wali bandh-ganth mujhe nahi
    // rokti (meri jodi agle se saaf alag hai).
    const pTieAfter = mainpageBindingPlan({ candidates: [cand('u-a', 3000, 1), { url: 'u-b', firstSeenAt: 4000 }, { url: 'u-c', firstSeenAt: 4000 }], ownKey: 'k1', ownStart: 1000, pendingOrder: [PO[0]], pendingOthers: 0 });
    eq('BIND-PLAN a tie beyond my pair does not block me', pTieAfter.bind, true);
    eq('BIND-PLAN tie-beyond picks my pair', pTieAfter.url, 'u-a');
    // exclusion fallback: tartib kataar me meri
    // jagah hi nahi (kataar me sirf pehle se bandhi
    // hui ek aur khidki hai), kitab me akela
    // ummeedwaar, aur koi baqi download nahi.
    const pEx = mainpageBindingPlan({ candidates: [cand('u-early', 500, 1)], ownKey: 'k-me', ownStart: 2000, pendingOrder: [{ key: 'k-x', start: 900 }], pendingOthers: 0 });
    eq('BIND-PLAN exclusion binds', pEx.bind, true);
    eq('BIND-PLAN exclusion reason', pEx.reason, 'exclusion');
    // exclusion band: doosra download baqi ho to nahi
    const pExPend = mainpageBindingPlan({ candidates: [cand('u-early', 500, 1)], ownKey: 'k-me', ownStart: 2000, pendingOrder: [{ key: 'k-x', start: 900 }], pendingOthers: 1 });
    eq('BIND-PLAN exclusion blocked while another download pends', pExPend.bind, false);
    // claim-once tarteeb ke saath: pehli jodi bandhne
    // ke baad wo ummeedwaar kataar se bahar hai —
    // agli task ki plan use kabhi nahi deti; kataar
    // aage badhti hai aur dusri task dusra leti hai.
    const pClaim1 = mainpageBindingPlan({ candidates: [cand('u-s1', 100, 1), cand('u-s2', 200, 2)], ownKey: 'k1', ownStart: 1000, pendingOrder: PO, pendingOthers: 1 });
    eq('BIND-PLAN claim-once setup — first task takes the first stream', pClaim1.url, 'u-s1');
    const pClaim2 = mainpageBindingPlan({ candidates: [cand('u-s2', 200, 2)], ownKey: 'k2', ownStart: 2000, pendingOrder: [PO[1]], pendingOthers: 0 });
    eq('BIND-PLAN claimed stream is never re-offered', pClaim2.url, 'u-s2');
    eq('BIND-PLAN second task still pairs in order', pClaim2.reason, 'order');
    // khaali kitab / ghalat input
    eq('BIND-PLAN empty book is none', mainpageBindingPlan({ candidates: [], ownKey: 'k2', ownStart: 2000, pendingOrder: PO, pendingOthers: 0 }).reason, 'none');
    eq('BIND-PLAN garbage input is none', mainpageBindingPlan(null).reason, 'none');
  }
  {
    // (b) capture kitab — firstSeenAt, claim, khidkiyan
    const nc = new NetworkCapture({});
    nc.arm();
    const t1 = Date.now() - 5000;
    nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000' }, mp4Buffer(224692), 224692, t1);
    nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000' }, mp4Buffer(224692), 224692, t1 + 900);
    const e1 = nc.mainpageEntries().find(x => x.url === GV_URL);
    eq('BIND-NC firstSeenAt survives a re-sighting', e1.firstSeenAt, t1);
    eq('BIND-NC last-seen still advances', e1.at, t1 + 900);
    nc.mainpageNoteWindow('k-w1', t1 + 1000);
    nc.mainpageNoteWindow('k-w1', t1 + 500);
    nc.mainpageNoteWindow('k-w1', t1 + 1500);
    eq('BIND-NC window keeps its earliest start', nc.mainpageWindowsList().find(w => w.key === 'k-w1').start, t1 + 500);
    nc.mainpageNoteWindow('k-w2', t1 + 2000);
    eq('BIND-NC pendingOthers counts the unbound other', nc.mainpagePendingOthers('k-w1'), 1);
    nc.claimMainpageVideo(FC_FRESH, { key: 'k-w2', label: '2' });
    eq('BIND-NC a claimed window is no longer pending', nc.mainpagePendingOthers('k-w1'), 0);
    eq('BIND-NC claim label recorded', nc.mainpageClaimedByLabel(FC_FRESH), '2');
    eq('BIND-NC claim key recorded', nc.mainpageClaimedKey(FC_FRESH), 'k-w2');
    nc.claimMainpageVideo(FC_FRESH, { key: 'k-w9', label: '9' });
    eq('BIND-NC claim-once — second claim never overwrites', nc.mainpageClaimedByLabel(FC_FRESH), '2');
    nc.mainpageNoteWindow('k-w3', t1 + 3000);
    eq('BIND-NC a fresh window pends again', nc.mainpagePendingOthers('k-w1'), 1);
    nc.mainpageMarkWindowDone('k-w3');
    eq('BIND-NC a done window is no longer pending', nc.mainpagePendingOthers('k-w1'), 0);
    nc.mainpageNoteWindow('k-w3', t1 + 4000);
    eq('BIND-NC a re-noted done window pends again (.54 fix-3 saathi)', nc.mainpagePendingOthers('k-w1'), 1);
    nc.mainpageMarkWindowDone('k-w3');
    const nc2 = new NetworkCapture({});
    nc2.noteRenderCompleted('k-rc');
    eq('BIND-NC render-complete registers the window', nc2.mainpageWindowsList().length, 1);
    eq('BIND-NC audit fields ride the sighting audit', (() => {
      const audits = [];
      const nc3 = new NetworkCapture({});
      nc3.onMainpageAudit = (a) => audits.push(a);
      nc3.arm();
      nc3._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000' }, mp4Buffer(224692), 224692, Date.now());
      return audits.length === 1 && audits[0].bindReason === 'none' && audits[0].claimedBy === 'none';
    })(), true);
  }
  {
    // (c) audit line ki shakal
    const aB = mainpageAuditOf({ host: 'h.googlevideo.com', bytes: 5, src: 'googlevideo', decision: 'captured', reason: 'partial-stream', bindReason: 'exclusion', claimedBy: '2' });
    eq('BIND-AUDIT bindReason passes through', aB.bindReason, 'exclusion');
    eq('BIND-AUDIT claimedBy passes through', aB.claimedBy, '2');
    const lineB = formatMainpageAudit(aB);
    ok('BIND-AUDIT line carries bindReason + claimedBy', lineB.includes('bindReason=exclusion') && lineB.includes('claimedBy=2'));
    const lineOld = formatMainpageAudit(mainpageAuditOf({ host: 'h.googlevideo.com', bytes: 5, src: 'googlevideo', decision: 'captured', reason: 'partial-stream' }));
    ok('BIND-AUDIT line without binding fields keeps the .41 shape', !lineOld.includes('bindReason='));
  }
  {
    // (d1) ENGINE first-appearance — padosi task ka
    // stream kitab me hai, mera bhi; mera bandhta hai,
    // padosi ka haath nahi lagta.
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 200, mainpageViewportSettleMs: 100 });
    const full = mp4Buffer(1250000); full[100] = 0xCD;
    eng.page = fakePage('main-bind-fa', { evaluateResult: { status: 200, b64: full.toString('base64') } });
    eng._readTileMediaState = async () => null;
    const nc = eng.netCapture;
    nc.arm();
    const now = Date.now();
    nc.mainpageNoteWindow('k-bind-other', now - 2000);
    const GV_OTHER = 'https://rr9---sn-zzz999.googlevideo.com/videoplayback?expire=999&id=other&itag=18';
    nc._recordMainpageSighting({ url: GV_OTHER, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000' }, mp4Buffer(224692), 224692, now - 1500);
    nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000' }, mp4Buffer(224692), 224692, now - 100);
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const task = { promptIndex: 0, captureKey: 'k-bind-mine', videoId: 'k-bind-mine', startTime: now - 3000, renderCompletedAt: now - 500 };
    const attempts = [];
    const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, attempts, 'k-bind-mine', 0);
    eq('BIND-ENG first-appearance stream saves', okSave, true);
    ok('BIND-ENG promoted audit carries bindReason=order', logs.some(m => m.includes('decision=promoted') && m.includes('bindReason=order')));
    ok('BIND-ENG promoted audit carries claimedBy=1', logs.some(m => m.includes('decision=promoted') && m.includes('claimedBy=1')));
    eq('BIND-ENG my stream is claimed', nc.isMainpageClaimed(GV_URL), true);
    eq('BIND-ENG the earlier task stream stays unclaimed', nc.isMainpageClaimed(GV_OTHER), false);
    eq('BIND-ENG claim label is my task', nc.mainpageClaimedByLabel(GV_URL), '1');
  }
  {
    // (d2) ENGINE viewport-trigger — kitab khaali hai;
    // tile nazar me aane ke baad stream aata hai,
    // completion fetch usi page ke andar, phir save.
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 3000, mainpageViewportSettleMs: 300 });
    const full = mp4Buffer(1250000); full[100] = 0xCE;
    eng.page = fakePage('main-bind-vp', { evaluateResult: { status: 200, b64: full.toString('base64') } });
    eng._readTileMediaState = async () => null;
    const nc = eng.netCapture;
    nc.arm();
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const task = { promptIndex: 0, captureKey: 'k-bind-vp', videoId: 'k-bind-vp', startTime: Date.now() - 3000, renderCompletedAt: Date.now() - 500 };
    const attempts = [];
    const p = eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, attempts, 'k-bind-vp', 0);
    setTimeout(() => {
      nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000' }, mp4Buffer(224692), 224692, Date.now());
    }, 500);
    const okSave = await p;
    eq('BIND-ENG viewport-trigger stream saves after the completion fetch', okSave, true);
    ok('BIND-ENG hover trigger was logged', logs.some(m => m.includes('hover trigger level=scroll')));
    ok('BIND-ENG promoted audit carries bindReason=viewport-trigger', logs.some(m => m.includes('decision=promoted') && m.includes('bindReason=viewport-trigger')));
    ok('BIND-ENG win line is via=mainpage-harvest', logs.some(m => m.includes('[ROOT] via=mainpage-harvest gap=')));
    ok('BIND-ENG the attempt strategy is mainpage-harvest', attempts.some(a => a.strategy === 'mainpage-harvest' && a.ok));
  }
  {
    // (d3) ENGINE exclusion — tartib kataar me ek
    // aur khidki mujh se pehle hai lekin wo apna
    // stream pehle hi naam kar chuki hai (is liye
    // koi aur baqi UNBOUND download nahi); kitab me
    // akela bacha stream exclusion se bandhta hai.
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 200, mainpageViewportSettleMs: 100, mainpagePatienceMs: 800 });
    const full = mp4Buffer(1250000); full[100] = 0xCF;
    eng.page = fakePage('main-bind-ex', { evaluateResult: { status: 200, b64: full.toString('base64') } });
    eng._readTileMediaState = async () => null;
    const nc = eng.netCapture;
    nc.arm();
    const now = Date.now();
    nc.mainpageNoteWindow('k-ex-other', now - 2500);
    nc.claimMainpageVideo(FC_FRESH2, { key: 'k-ex-other', label: '9' });
    nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000' }, mp4Buffer(224692), 224692, now - 3000);
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const task = { promptIndex: 0, captureKey: 'k-bind-ex', videoId: 'k-bind-ex', startTime: now - 4000, renderCompletedAt: now - 500 };
    const attempts = [];
    const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, attempts, 'k-bind-ex', 0);
    eq('BIND-ENG exclusion stream saves', okSave, true);
    ok('BIND-ENG promoted audit carries bindReason=exclusion', logs.some(m => m.includes('decision=promoted') && m.includes('bindReason=exclusion')));
  }
  {
    // (d4) ENGINE order — kitab me do stream alag
    // alag pal par: v2.48.43 ki tarteeb pehle ko
    // bandhti hai (sirf wahi fetch hota hai), dusra
    // kitab me bila-naam rehta hai. (.42 me yahi
    // manzar ambiguity inkaar tha — khidki-taqseem
    // ZEROCLICK10 me nakam hone par qaaida badla.)
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 200, mainpageViewportSettleMs: 100, mainpagePatienceMs: 800 });
    eng.page = fakePage('main-bind-amb');
    eng._readTileMediaState = async () => null;
    const fetchedUrls = [];
    eng._fetchMainpageFullInPage = async (u) => { fetchedUrls.push(u); return { buf: mp4Buffer(1250000), status: 200 }; };
    const nc = eng.netCapture;
    nc.arm();
    const now = Date.now();
    const GV_A = 'https://rr1---sn-aaa111.googlevideo.com/videoplayback?expire=999&id=a&itag=18';
    const GV_B = 'https://rr3---sn-bbb222.googlevideo.com/videoplayback?expire=999&id=b&itag=18';
    nc._recordMainpageSighting({ url: GV_A, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000' }, mp4Buffer(224692), 224692, now - 200);
    nc._recordMainpageSighting({ url: GV_B, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000' }, mp4Buffer(224692), 224692, now - 100);
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const task = { promptIndex: 0, captureKey: 'k-bind-amb', videoId: 'k-bind-amb', startTime: now - 3000, renderCompletedAt: now - 500 };
    const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-bind-amb', 0);
    eq('BIND-ENG order attempt saves', okSave, true);
    eq('BIND-ENG order saved the earliest stream', task.completedVideoUrl, GV_A);
    ok('BIND-ENG order fetched only the earliest stream', fetchedUrls.length > 0 && fetchedUrls.every(u => u === GV_A));
    ok('BIND-ENG promoted audit carries bindReason=order', logs.some(m => m.includes('decision=promoted') && m.includes('bindReason=order')));
    eq('BIND-ENG the later stream stays unclaimed', nc.isMainpageClaimed(GV_B), false);
  }
  {
    // (d5) ENGINE claim-once — pehli task ke naam hua
    // stream doosri task ki retry ko kabhi nahi milta.
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 200, mainpageViewportSettleMs: 100, mainpagePatienceMs: 800, mainpageHoverGraceMs: 100, mainpagePointerGraceMs: 100 });
    const full = mp4Buffer(1250000);
    eng.page = fakePage('main-bind-once', { evaluateResult: { status: 200, b64: full.toString('base64') } });
    eng._readTileMediaState = async () => null;
    const nc = eng.netCapture;
    nc.arm();
    const now = Date.now();
    nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000' }, mp4Buffer(224692), 224692, now - 100);
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const t1 = { promptIndex: 0, captureKey: 'k-once-1', videoId: 'k-once-1', startTime: now - 3000, renderCompletedAt: now - 500 };
    const ok1 = await eng._tryMainpageHarvest(t1, '/tmp', { duration: '10s' }, [], 'k-once-1', 0);
    eq('BIND-ENG first task claims and saves', ok1, true);
    eq('BIND-ENG claim label after the first save', nc.mainpageClaimedByLabel(GV_URL), '1');
    const t2 = { promptIndex: 1, captureKey: 'k-once-2', videoId: 'k-once-2', startTime: now - 3000, renderCompletedAt: now - 50 };
    const ok2 = await eng._tryMainpageHarvest(t2, '/tmp', { duration: '10s' }, [], 'k-once-2', 0);
    eq('BIND-ENG claimed stream is never offered to the second task', ok2, false);
    eq('BIND-ENG claim label is still the first task', nc.mainpageClaimedByLabel(GV_URL), '1');
  }
  {
    // (d6) ENGINE hover watch — intezaar me do stream
    // tartib se aate hain: v2.48.43 me PEHLA mere
    // intezaar me aaya hai, is liye wahi bandhta hai
    // (viewport-trigger); dusra kitab me bila-naam
    // rehta hai. (.42 ka do-naye-inkaar wala qaaida
    // tarteeb bandhan ke saath badal gaya.)
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 3000, mainpageViewportSettleMs: 1500, mainpagePatienceMs: 5000, mainpageHoverGraceMs: 200, mainpagePointerGraceMs: 200 });
    eng.page = fakePage('main-bind-vp2');
    eng._readTileMediaState = async () => null;
    const fetchedUrls = [];
    eng._fetchMainpageFullInPage = async (u) => { fetchedUrls.push(u); return { buf: mp4Buffer(1250000), status: 200 }; };
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const nc = eng.netCapture;
    nc.arm();
    const GV_C = 'https://rr5---sn-ccc333.googlevideo.com/videoplayback?expire=999&id=c&itag=18';
    const GV_D = 'https://rr7---sn-ddd444.googlevideo.com/videoplayback?expire=999&id=d&itag=18';
    const task = { promptIndex: 0, captureKey: 'k-bind-vp2', videoId: 'k-bind-vp2', startTime: Date.now() - 3000, renderCompletedAt: Date.now() - 500 };
    const p = eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-bind-vp2', 0);
    setTimeout(() => { nc._recordMainpageSighting({ url: GV_C, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000' }, mp4Buffer(224692), 224692, Date.now()); }, 400);
    setTimeout(() => { nc._recordMainpageSighting({ url: GV_D, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000' }, mp4Buffer(224692), 224692, Date.now()); }, 900);
    const okSave = await p;
    eq('BIND-ENG first stream in the hover watch saves', okSave, true);
    eq('BIND-ENG the watch saved the first arrival', task.completedVideoUrl, GV_C);
    ok('BIND-ENG the watch fetched only the first arrival', fetchedUrls.length > 0 && fetchedUrls.every(u => u === GV_C));
    ok('BIND-ENG promoted audit carries bindReason=viewport-trigger', logs.some(m => m.includes('decision=promoted') && m.includes('bindReason=viewport-trigger')));
    eq('BIND-ENG the later watch stream stays unclaimed', nc.isMainpageClaimed(GV_D), false);
  }

  // ---------------------------------------------------------------------------
  // N. v2.48.43 — HOVER + PATIENCE PACK:
  //   (a) ummeedwaar darwaza (khalis): maloom kul
  //       size ki hadd, na-maloom par host + video
  //       type ki shart;
  //   (b) capture wiring: chhoti stream kitab me
  //       aati hi nahi (audit stream-too-small), seq
  //       tartib, candidate nishaan;
  //   (c) ENGINE: filter (chhoti kabhi fetch nahi),
  //       synthetic-hover jodi, pointer-hover jodi,
  //       sabr ki khidki me der se aaya stream,
  //       uljhe renderon me tarteeb jodi (ZEROCLICK10
  //       ka asal manzar).
  // ---------------------------------------------------------------------------
  {
    // (a) darwaza — khalis hisaab
    eq('HOV-GATE threshold is 500000', MAINPAGE_MIN_CANDIDATE_BYTES, 500000);
    eq('HOV-GATE 87478 total is too small', mainpageCandidateGate({ knownTotal: 87478, src: 'googlevideo', contentType: 'video/mp4' }).candidate, false);
    eq('HOV-GATE too-small reason', mainpageCandidateGate({ knownTotal: 87478, src: 'googlevideo', contentType: 'video/mp4' }).reason, 'stream-too-small');
    eq('HOV-GATE exactly at the threshold passes', mainpageCandidateGate({ knownTotal: 500000, src: 'googlevideo', contentType: 'video/mp4' }).candidate, true);
    eq('HOV-GATE 1213784 total passes', mainpageCandidateGate({ knownTotal: 1213784, src: 'googlevideo', contentType: 'video/mp4' }).candidate, true);
    eq('HOV-GATE unknown total + googlevideo + video type passes', mainpageCandidateGate({ knownTotal: null, src: 'googlevideo', contentType: 'video/mp4' }).candidate, true);
    eq('HOV-GATE unknown total + flow-content + video type passes', mainpageCandidateGate({ knownTotal: null, src: 'flow-content', contentType: 'video/mp4' }).candidate, true);
    eq('HOV-GATE unknown total + non-video type fails', mainpageCandidateGate({ knownTotal: null, src: 'googlevideo', contentType: 'text/html' }).candidate, false);
    eq('HOV-GATE non-video reason', mainpageCandidateGate({ knownTotal: null, src: 'googlevideo', contentType: 'text/html' }).reason, 'not-video-candidate');
    eq('HOV-GATE unknown total + wrong host fails', mainpageCandidateGate({ knownTotal: null, src: 'none', contentType: 'video/mp4' }).candidate, false);
  }
  {
    // (b) capture wiring — darwaza, seq, candidate
    const audits = [];
    const nc = new NetworkCapture({});
    nc.onMainpageAudit = (a) => audits.push(a);
    nc.arm();
    const GV_SMALL = 'https://rr1---sn-small1.googlevideo.com/videoplayback?expire=999&id=small&itag=18';
    nc._recordMainpageSighting({ url: GV_SMALL, src: 'googlevideo', declared: 87478, status: 206, contentRange: 'bytes 0-87477/87478', contentType: 'video/mp4' }, mp4Buffer(87478), 87478, Date.now());
    eq('HOV-NC the 87KB stream never enters the book', nc.mainpageEntries().some(e => e.url === GV_SMALL), false);
    ok('HOV-NC small stream audit is ignored/stream-too-small', audits.some(a => a.decision === 'ignored' && a.reason === 'stream-too-small'));
    nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000', contentType: 'video/mp4' }, mp4Buffer(224692), 224692, Date.now());
    const eBig = nc.mainpageEntries().find(e => e.url === GV_URL);
    eq('HOV-NC the 1.2MB stream is a candidate', eBig.candidate, true);
    ok('HOV-NC first candidate carries seq 1', eBig.seq === 1);
    nc._recordMainpageSighting({ url: FC_FRESH, src: 'flow-content', declared: 0, status: 200, contentRange: '', contentType: 'video/mp4' }, mp4Buffer(600000), 600000, Date.now());
    const eFc = nc.mainpageEntries().find(e => e.url === FC_FRESH);
    eq('HOV-NC a complete flow-content body is a candidate', eFc.candidate, true);
    ok('HOV-NC second new entry carries a later seq', eFc.seq > eBig.seq);
    nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000', contentType: 'video/mp4' }, mp4Buffer(224692), 224692, Date.now());
    eq('HOV-NC a re-sighting keeps its first seq', nc.mainpageEntries().find(e => e.url === GV_URL).seq, eBig.seq);
    const GV_UNK = 'https://rr4---sn-unk444.googlevideo.com/videoplayback?expire=999&id=unk&itag=18';
    nc._recordMainpageSighting({ url: GV_UNK, src: 'googlevideo', declared: 0, status: 206, contentRange: '', contentType: 'video/mp4' }, mp4Buffer(100000), 100000, Date.now());
    // v2.48.52 (gate fix — PIN JAAN-BOOJH KAR BADLA):
    // kul size na maloom + aaye bytes hadd se chhote
    // (100,000 < 500,000) — .51 tak ye nazar kitab me
    // ummeedwaar ENTRY banti thi; ab wo too-small
    // yaad me jati hai (wahan se Route 1A use
    // attribution ke saath parkhega), kitab me entry
    // NAHI banti.
    eq('HOV-NC unknown-total small-bytes stream stays out of the book (.52)', nc.mainpageEntries().some(e => e.url === GV_UNK), false);
    ok('HOV-NC unknown-total small-bytes lands in too-small memory (.52)', nc.mainpageTooSmallSightings().some(s => s.url === GV_UNK && s.reason === 'stream-too-small'));
    const GV_HTML = 'https://rr6---sn-html66.googlevideo.com/videoplayback?expire=999&id=html&itag=18';
    nc._recordMainpageSighting({ url: GV_HTML, src: 'googlevideo', declared: 0, status: 206, contentRange: '', contentType: 'text/html' }, mp4Buffer(100000), 100000, Date.now());
    eq('HOV-NC unknown-total non-video is not a candidate', nc.mainpageEntries().find(e => e.url === GV_HTML).candidate, false);
    ok('HOV-NC non-video audit reason logged', audits.some(a => a.decision === 'ignored' && a.reason === 'not-video-candidate'));
  }
  {
    // (c1) ENGINE filter — kitab me sirf chhoti
    // stream: attempt fail, fetch ZERO; phir asal
    // stream aane par wahi attempt-raasta use save
    // karta hai (chhoti ko haath nahi lagta).
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 200, mainpagePatienceMs: 700, mainpageHoverGraceMs: 100, mainpagePointerGraceMs: 100 });
    eng.page = fakePage('main-hov-filter');
    eng._readTileMediaState = async () => null;
    let fetchCalls = 0;
    eng._fetchMainpageFullInPage = async () => { fetchCalls++; return { buf: mp4Buffer(1213784), status: 200 }; };
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const nc = eng.netCapture;
    nc.arm();
    const GV_SMALL = 'https://rr1---sn-small1.googlevideo.com/videoplayback?expire=999&id=small&itag=18';
    nc._recordMainpageSighting({ url: GV_SMALL, src: 'googlevideo', declared: 87478, status: 206, contentRange: 'bytes 0-87477/87478', contentType: 'video/mp4' }, mp4Buffer(87478), 87478, Date.now());
    ok('HOV-ENG the engine log carries the stream-too-small audit', logs.some(m => m.includes('[ROOT] mainpage-audit') && m.includes('reason=stream-too-small')));
    const task = { promptIndex: 0, captureKey: 'k-hov-filter', videoId: 'k-hov-filter', startTime: Date.now() - 3000, renderCompletedAt: Date.now() - 500 };
    const okSmall = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-hov-filter', 0);
    eq('HOV-ENG a too-small stream alone saves nothing', okSmall, false);
    eq('HOV-ENG a too-small stream is never fetched', fetchCalls, 0);
    const GV_BIG = 'https://rr2---sn-big222.googlevideo.com/videoplayback?expire=999&id=big&itag=18';
    nc._recordMainpageSighting({ url: GV_BIG, src: 'googlevideo', declared: 230769, status: 206, contentRange: 'bytes 0-230768/1213784', contentType: 'video/mp4' }, mp4Buffer(230769), 230769, Date.now());
    const okBig = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-hov-filter', 0);
    eq('HOV-ENG the real stream saves on the retry', okBig, true);
    eq('HOV-ENG the saved file is the big stream', task.completedVideoUrl, GV_BIG);
  }
  {
    // (c2) ENGINE synthetic-hover jodi — scroll par
    // kuch nahi; synthetic ishare ke baad stream
    // aata hai aur bandhta hai (viewport-trigger).
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 200, mainpagePatienceMs: 5000, mainpageHoverGraceMs: 150, mainpagePointerGraceMs: 10000 });
    const full = mp4Buffer(1250000); full[100] = 0xD1;
    eng.page = fakePage('main-hov-syn', { evaluateResult: { status: 200, b64: full.toString('base64') } });
    eng._readTileMediaState = async () => null;
    const nc = eng.netCapture;
    nc.arm();
    let syntheticCalled = false;
    eng._syntheticHoverMainpageTile = async () => {
      syntheticCalled = true;
      setTimeout(() => { nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000', contentType: 'video/mp4' }, mp4Buffer(224692), 224692, Date.now()); }, 100);
      return true;
    };
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const task = { promptIndex: 0, captureKey: 'k-hov-syn', videoId: 'k-hov-syn', startTime: Date.now() - 3000, renderCompletedAt: Date.now() - 500 };
    const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-hov-syn', 0);
    eq('HOV-ENG synthetic-hover stream saves', okSave, true);
    eq('HOV-ENG the synthetic hover actually fired', syntheticCalled, true);
    ok('HOV-ENG level=synthetic was logged', logs.some(m => m.includes('hover trigger level=synthetic')));
    ok('HOV-ENG promoted audit carries bindReason=viewport-trigger', logs.some(m => m.includes('decision=promoted') && m.includes('bindReason=viewport-trigger')));
  }
  {
    // (c3) ENGINE pointer-hover jodi — synthetic par
    // bhi kuch nahi; asal pointer tile par rukne ke
    // baad stream aata hai aur bandhta hai.
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 200, mainpagePatienceMs: 5000, mainpageHoverGraceMs: 150, mainpagePointerGraceMs: 150 });
    const full = mp4Buffer(1250000); full[100] = 0xD2;
    eng.page = fakePage('main-hov-ptr', { evaluateResult: { status: 200, b64: full.toString('base64') } });
    eng._readTileMediaState = async () => null;
    const nc = eng.netCapture;
    nc.arm();
    let pointerCalled = false;
    eng._syntheticHoverMainpageTile = async () => true;
    eng._pointerHoverMainpageTile = async () => {
      pointerCalled = true;
      setTimeout(() => { nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000', contentType: 'video/mp4' }, mp4Buffer(224692), 224692, Date.now()); }, 100);
      return true;
    };
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const task = { promptIndex: 0, captureKey: 'k-hov-ptr', videoId: 'k-hov-ptr', startTime: Date.now() - 3000, renderCompletedAt: Date.now() - 500 };
    const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-hov-ptr', 0);
    eq('HOV-ENG pointer-hover stream saves', okSave, true);
    eq('HOV-ENG the pointer hover actually fired', pointerCalled, true);
    ok('HOV-ENG level=pointer was logged', logs.some(m => m.includes('hover trigger level=pointer')));
    ok('HOV-ENG promoted audit carries bindReason=viewport-trigger', logs.some(m => m.includes('decision=promoted') && m.includes('bindReason=viewport-trigger')));
  }
  {
    // (c4) ENGINE sabr — patience ki khidki (12s)
    // me DER se aaya stream (10s par) bhi bandhta
    // hai; watch jodi milte hi foran khatam hota
    // hai (poori khidki nahi rukta).
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 200, mainpagePatienceMs: 12000, mainpageHoverGraceMs: 150, mainpagePointerGraceMs: 150 });
    const full = mp4Buffer(1250000); full[100] = 0xD3;
    eng.page = fakePage('main-hov-patience', { evaluateResult: { status: 200, b64: full.toString('base64') } });
    eng._readTileMediaState = async () => null;
    const nc = eng.netCapture;
    nc.arm();
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const task = { promptIndex: 0, captureKey: 'k-hov-patience', videoId: 'k-hov-patience', startTime: Date.now() - 3000, renderCompletedAt: Date.now() - 500 };
    const t0 = Date.now();
    const p = eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-hov-patience', 0);
    setTimeout(() => { nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000', contentType: 'video/mp4' }, mp4Buffer(224692), 224692, Date.now()); }, 10000);
    const okSave = await p;
    const elapsed = Date.now() - t0;
    eq('HOV-ENG a late stream inside the patience window saves', okSave, true);
    ok('HOV-ENG the watch really waited for it (past the old scroll-only wait)', elapsed >= 9000);
    ok('HOV-ENG the watch exited on pairing, not at the deadline', elapsed < 12000);
    ok('HOV-ENG the patience budget was logged', logs.some(m => m.includes('hover trigger level=scroll') && m.includes('watching up to')));
    ok('HOV-ENG the pointer level was reached during the long watch', logs.some(m => m.includes('hover trigger level=pointer')));
  }
  {
    // (c5) ENGINE tarteeb — ZEROCLICK10 ka asal
    // manzar: main pehle render hua, sibling baad
    // me; akeli poori stream sibling ke render ke
    // BAAD aayi (purani khidki-taqseem use sibling
    // ki bana kar mere liye zaya karti thi). Ab wo
    // sab se pehle baqi download — mujhe — milti
    // hai (bindReason=order).
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 200, mainpagePatienceMs: 800, mainpageHoverGraceMs: 100, mainpagePointerGraceMs: 100 });
    const full = mp4Buffer(1213784); full[100] = 0xD4;
    eng.page = fakePage('main-hov-zc', { evaluateResult: { status: 200, b64: full.toString('base64') } });
    eng._readTileMediaState = async () => null;
    const nc = eng.netCapture;
    nc.arm();
    const now = Date.now();
    nc.mainpageNoteWindow('k-zc-sib', now - 1000);
    nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 230769, status: 206, contentRange: 'bytes 0-230768/1213784', contentType: 'video/mp4' }, mp4Buffer(230769), 230769, now - 100);
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const task = { promptIndex: 0, captureKey: 'k-zc-me', videoId: 'k-zc-me', startTime: now - 4000, renderCompletedAt: now - 2000 };
    const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-zc-me', 0);
    eq('HOV-ENG interleaved-render stream saves for the earliest pending task', okSave, true);
    eq('HOV-ENG the saved file is that stream', task.completedVideoUrl, GV_URL);
    ok('HOV-ENG promoted audit carries bindReason=order', logs.some(m => m.includes('decision=promoted') && m.includes('bindReason=order')));
    eq('HOV-ENG the stream is claimed by my task', nc.mainpageClaimedKey(GV_URL), 'k-zc-me');
  }
  {
    // (c6) v2.48.45 — BINDCHECK DIAGNOSTIC
    // (ZEROCLICK12 addendum): poori-size stream
    // bandhan par parkha jaye aur bandhe NAHI to
    // '[ROOT] mainpage-bindcheck' line wajah NAAM se
    // deti hai. Bandhan ka vyavhaar bilkul nahi
    // badla — ye test har darwaze par line ki
    // maujoodgi + sahi wajah jaanchte hain, aur ye
    // bhi ke inkaar barkarar hai (fetch ZERO).
    const GV_BC = 'https://rr5---sn-qxaelnes.googlevideo.com/videoplayback?expire=999&id=bc12&itag=18';
    const bcEngine = (logs) => {
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 200, mainpagePatienceMs: 700, mainpageHoverGraceMs: 100, mainpagePointerGraceMs: 100 });
      eng.page = fakePage('main-bindcheck');
      eng._readTileMediaState = async () => null;
      eng._fetchMainpageFullInPage = async () => ({ buf: mp4Buffer(1225554), status: 200 });
      eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
      eng.netCapture.arm();
      return eng;
    };
    const bcRecord = (nc, url, at) => nc._recordMainpageSighting(
      { url, src: 'googlevideo', declared: 242544, status: 206, contentRange: 'bytes 0-242543/1225554', contentType: 'video/mp4' },
      mp4Buffer(242544), 242544, at || Date.now());
    // plan ka myIdx field (bindcheck ki buniyad).
    eq('BINDCHECK plan reports myIdx for the second pending', mainpageBindingPlan({ candidates: [{ url: 'u-x', firstSeenAt: 3000, seq: 1 }], ownKey: 'k2', ownStart: 2000, pendingOrder: [{ key: 'k1', start: 1000 }, { key: 'k2', start: 2000 }], pendingOthers: 1 }).myIdx, 1);
    eq('BINDCHECK plan reports myIdx 0 for the first pending', mainpageBindingPlan({ candidates: [{ url: 'u-x', firstSeenAt: 3000, seq: 1 }], ownKey: 'k1', ownStart: 1000, pendingOrder: [{ key: 'k1', start: 1000 }, { key: 'k2', start: 2000 }], pendingOthers: 1 }).myIdx, 0);
    {
      // darwaza 1: stream kisi AUR task ke naam
      // (keyByUrl) — mere liye hamesha ruka, wajah
      // claimed-by-other-task.
      const logs = [];
      const eng = bcEngine(logs);
      const nc = eng.netCapture;
      bcRecord(nc, GV_BC);
      nc.keyByUrl.set(GV_BC, 'k-other-task');
      const task = { promptIndex: 0, captureKey: 'k-bc-claim', videoId: 'k-bc-claim', startTime: Date.now() - 3000, renderCompletedAt: Date.now() - 500 };
      const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-bc-claim', 0);
      eq('BINDCHECK a stream claimed by another task still saves nothing', okSave, false);
      ok('BINDCHECK the bindcheck line names claimed-by-other-task', logs.some(m => m.includes('[ROOT] mainpage-bindcheck') && m.includes('total=1225554') && m.includes('why=claimed-by-other-task')));
      ok('BINDCHECK the bindcheck line carries firstSeen and renderDone', logs.some(m => m.includes('[ROOT] mainpage-bindcheck') && m.includes('firstSeen=') && m.includes('renderDone=')));
    }
    {
      // darwaza 2: akela stream kataar me mujh se
      // PEHLE wale baqi download ke hisse ka hai —
      // wajah reserved-for-earlier-pending.
      const logs = [];
      const eng = bcEngine(logs);
      const nc = eng.netCapture;
      const now = Date.now();
      nc.mainpageNoteWindow('k-bc-earlier', now - 5000);
      bcRecord(nc, GV_BC, now - 100);
      const task = { promptIndex: 1, captureKey: 'k-bc-res', videoId: 'k-bc-res', startTime: now - 4000, renderCompletedAt: now - 2000 };
      const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-bc-res', 0);
      eq('BINDCHECK the earlier pending task keeps its reservation', okSave, false);
      ok('BINDCHECK the bindcheck line names reserved-for-earlier-pending', logs.some(m => m.includes('[ROOT] mainpage-bindcheck') && m.includes('why=reserved-for-earlier-pending')));
    }
    {
      // darwaza 3: stream meri task ke aaghaz se
      // PEHLE pehli dafa dikha tha — wajah
      // seen-before-task-start.
      const logs = [];
      const eng = bcEngine(logs);
      const nc = eng.netCapture;
      const now = Date.now();
      bcRecord(nc, GV_BC, now - 10000);
      const task = { promptIndex: 0, captureKey: 'k-bc-early', videoId: 'k-bc-early', startTime: now - 5000, renderCompletedAt: now - 500 };
      const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-bc-early', 0);
      eq('BINDCHECK a stream first seen before my start saves nothing', okSave, false);
      ok('BINDCHECK the bindcheck line names seen-before-task-start', logs.some(m => m.includes('[ROOT] mainpage-bindcheck') && m.includes('why=seen-before-task-start')));
    }
    {
      // darwaza 4: ASAL bandh-ganth — do poori
      // streams, ek hi pal, capture tartib bhi
      // nahi (seq hataya gaya) — inkaar barkarar,
      // wajah ambiguous-tie, fetch ZERO.
      const logs = [];
      const eng = bcEngine(logs);
      const nc = eng.netCapture;
      const GV_BC2 = 'https://rr6---sn-bc2222.googlevideo.com/videoplayback?expire=999&id=bc22&itag=18';
      let fetchCalls = 0;
      eng._fetchMainpageFullInPage = async () => { fetchCalls++; return { buf: mp4Buffer(1225554), status: 200 }; };
      const now = Date.now();
      bcRecord(nc, GV_BC, now - 1000);
      bcRecord(nc, GV_BC2, now - 900);
      for (const e of nc.mainpageVideos) {
        if (e.url === GV_BC || e.url === GV_BC2) { e.firstSeenAt = now - 1000; e.seq = null; }
      }
      const task = { promptIndex: 0, captureKey: 'k-bc-tie', videoId: 'k-bc-tie', startTime: now - 10000, renderCompletedAt: now - 2000 };
      const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-bc-tie', 0);
      eq('BINDCHECK a genuine tie still refuses', okSave, false);
      eq('BINDCHECK a genuine tie fetches nothing', fetchCalls, 0);
      ok('BINDCHECK the bindcheck line names ambiguous-tie as refused', logs.some(m => m.includes('[ROOT] mainpage-bindcheck') && m.includes('decision=refused') && m.includes('why=ambiguous-tie')));
    }
  }

  // ---------------------------------------------------------------------------
  // O. v2.48.44 — HEADLESS HARVEST PACK (OPTION 2):
  //   (a) clone tarteeb: sirf session ke buniyadi hisse,
  //       lock kabhi nahi, asal profile bilkul na-badla,
  //       clone koshish ke baad mit jata hai; cookies na
  //       hon to copy bekaar — error;
  //   (b) probe faisla: logged-in / logged-out / blocked
  //       fixtures — blocked sab par bhaari, anjaan
  //       haalat = qubool NAHI;
  //   (c) probe cache: ek account, ek run, ek faisla;
  //   (d) windowless darwaza: headed launch kabhi
  //       qubool nahi; probe-reject ki ibarat pin ki hui;
  //   (e) ENGINE: probe reject → wahi thahra strategy
  //       note, editor khulta hi NAHI, aur dusri dafa
  //       launch/probe bilkul nahi (cache);
  //   (f) ENGINE: probe qubool + editor stream ki
  //       mukammal body → save, via=headless-harvest
  //       line, session band;
  //   (g) ENGINE: stream waqt par na aaye to haar, aur
  //       cascade ki tartib headless → mainpage → grid
  //       (fall-through), probe phir bhi ek hi dafa.
  //   (h) v2.48.45 — LAUNCH DIAGNOSTICS + CLONE
  //       HARDENING (ZEROCLICK12): launch fail ki
  //       strategy note + warn line me ASAL wajah
  //       (message + code); clone log line (copied /
  //       missing / warnings); Cookies ke SQLite
  //       sidecars (-wal/-journal) plan + copy me;
  //       nazuk files ki copy EBUSY par retry.
  // ---------------------------------------------------------------------------
  {
    const fsx = require('fs');
    const osx = require('os');
    const pathx = require('path');
    const { cloneFilePlan, buildHeadlessClone, removeHeadlessClone } = headlessHarvest;
    // Khalis tarteeb — jaali detectors ke saath.
    const planPure = cloneFilePlan('/nowhere', {
      exists: (rel) => ['Local State', pathx.join('Default', 'Cookies')].includes(rel),
      isDir: () => false
    });
    eq('HH-CLONE pure plan picks only existing essentials', planPure.length, 2);
    ok('HH-CLONE pure plan has Local State', planPure.some(p => p.rel === 'Local State'));
    // Asal jaali profile.
    const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'hh-prof-'));
    const cloneDir = pathx.join(osx.tmpdir(), `hh-clone-${Date.now()}`);
    const w = (rel, content) => { const p = pathx.join(root, rel); fsx.mkdirSync(pathx.dirname(p), { recursive: true }); fsx.writeFileSync(p, content); };
    w('Local State', '{"os_crypt":{}}');
    w(pathx.join('Default', 'Network', 'Cookies'), 'COOKIES-DB');
    w(pathx.join('Default', 'Preferences'), '{"p":1}');
    w(pathx.join('Default', 'Local Storage', 'leveldb', '000003.log'), 'LS-DATA');
    w(pathx.join('Default', 'Session Storage', '000003.log'), 'SS-DATA');
    w(pathx.join('Default', 'Cache', 'cache-data'), 'CACHE-BULK');
    w('SingletonLock', 'lock');
    const plan = cloneFilePlan(root);
    ok('HH-CLONE plan includes Local State', plan.some(p => p.rel === 'Local State'));
    ok('HH-CLONE plan includes Network Cookies', plan.some(p => p.rel === pathx.join('Default', 'Network', 'Cookies')));
    ok('HH-CLONE plan includes Local Storage as a dir', plan.some(p => p.rel === pathx.join('Default', 'Local Storage') && p.kind === 'dir'));
    ok('HH-CLONE plan never includes the lock file', !plan.some(p => p.rel.includes('Singleton')));
    await buildHeadlessClone(root, cloneDir);
    eq('HH-CLONE cookies copied', fsx.readFileSync(pathx.join(cloneDir, 'Default', 'Network', 'Cookies'), 'utf8'), 'COOKIES-DB');
    eq('HH-CLONE local state copied', fsx.readFileSync(pathx.join(cloneDir, 'Local State'), 'utf8'), '{"os_crypt":{}}');
    eq('HH-CLONE preferences copied', fsx.readFileSync(pathx.join(cloneDir, 'Default', 'Preferences'), 'utf8'), '{"p":1}');
    eq('HH-CLONE local storage content copied', fsx.readFileSync(pathx.join(cloneDir, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'utf8'), 'LS-DATA');
    eq('HH-CLONE session storage content copied', fsx.readFileSync(pathx.join(cloneDir, 'Default', 'Session Storage', '000003.log'), 'utf8'), 'SS-DATA');
    ok('HH-CLONE lock file is never copied', !fsx.existsSync(pathx.join(cloneDir, 'SingletonLock')));
    ok('HH-CLONE cache bulk is never copied', !fsx.existsSync(pathx.join(cloneDir, 'Default', 'Cache')));
    eq('HH-CLONE source profile is untouched', fsx.readFileSync(pathx.join(root, 'Default', 'Network', 'Cookies'), 'utf8'), 'COOKIES-DB');
    ok('HH-CLONE source keeps its own lock file', fsx.existsSync(pathx.join(root, 'SingletonLock')));
    await removeHeadlessClone(cloneDir);
    ok('HH-CLONE clone dir is deleted after the attempt', !fsx.existsSync(cloneDir));
    // Cookies ke baghair copy bekaar — error laazmi.
    const bareRoot = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'hh-bare-'));
    fsx.writeFileSync(pathx.join(bareRoot, 'Local State'), '{}');
    let threw = false;
    try { await buildHeadlessClone(bareRoot, pathx.join(osx.tmpdir(), `hh-bare-clone-${Date.now()}`)); } catch (e) { threw = true; }
    ok('HH-CLONE a copy without Cookies is refused', threw);
    fsx.rmSync(root, { recursive: true, force: true });
    fsx.rmSync(bareRoot, { recursive: true, force: true });
  }
  {
    const { classifyProbeSnapshot } = headlessHarvest;
    eq('HH-PROBE prompt box means logged-in', classifyProbeSnapshot({ url: 'https://flow.google.com/', hasPromptBox: true }), 'logged-in');
    eq('HH-PROBE gallery tiles mean logged-in', classifyProbeSnapshot({ url: 'https://flow.google.com/', hasTiles: true }), 'logged-in');
    eq('HH-PROBE avatar means logged-in', classifyProbeSnapshot({ url: 'https://flow.google.com/', hasAvatar: true }), 'logged-in');
    eq('HH-PROBE sign-in wall means logged-out', classifyProbeSnapshot({ url: 'https://flow.google.com/', hasSignIn: true }), 'logged-out');
    eq('HH-PROBE google accounts url means logged-out', classifyProbeSnapshot({ url: 'https://accounts.google.com/ServiceLogin' }), 'logged-out');
    eq('HH-PROBE unusual traffic is blocked', classifyProbeSnapshot({ url: 'https://flow.google.com/', text: 'Our systems have detected unusual traffic from your computer network' }), 'blocked');
    eq('HH-PROBE captcha is blocked even with a prompt box', classifyProbeSnapshot({ url: 'https://flow.google.com/', hasCaptcha: true, hasPromptBox: true }), 'blocked');
    eq('HH-PROBE blocked beats logged-in markers', classifyProbeSnapshot({ url: 'https://flow.google.com/', hasPromptBox: true, text: 'please verify your identity to continue' }), 'blocked');
    eq('HH-PROBE sign-in beats tiles', classifyProbeSnapshot({ url: 'https://flow.google.com/', hasSignIn: true, hasTiles: true }), 'logged-out');
    eq('HH-PROBE an unknown page is not accepted', classifyProbeSnapshot({ url: 'https://flow.google.com/' }), 'logged-out');
    eq('HH-PROBE garbage input is not accepted', classifyProbeSnapshot(null), 'logged-out');
  }
  {
    const cache = headlessHarvest.createProbeCache();
    eq('HH-CACHE empty get is null', cache.get('acc-1'), null);
    cache.set('acc-1', 'logged-out');
    eq('HH-CACHE verdict stored per account', cache.get('acc-1'), 'logged-out');
    eq('HH-CACHE another account is unaffected', cache.get('acc-2'), null);
    cache.clear();
    eq('HH-CACHE clear empties the run cache', cache.get('acc-1'), null);
    eq('HH-GUARD headless new is windowless', headlessHarvest.launchIsWindowless({ headless: 'new' }), true);
    eq('HH-GUARD headless true is windowless', headlessHarvest.launchIsWindowless({ headless: true }), true);
    eq('HH-GUARD headless false is NOT windowless', headlessHarvest.launchIsWindowless({ headless: false }), false);
    eq('HH-GUARD a missing headless flag is NOT windowless', headlessHarvest.launchIsWindowless({}), false);
    eq('HH-GUARD garbage is NOT windowless', headlessHarvest.launchIsWindowless(null), false);
    eq('HH-GUARD the pack mode constant is new', headlessHarvest.HEADLESS_MODE, 'new');
    eq('HH-GUARD the probe-reject note is the pinned strategy text', headlessHarvest.PROBE_REJECT_NOTE, 'headless-harvest: failed (the copied session was not accepted in the invisible browser — see the headless-probe line)');
  }
  function stubHeadlessSession(eng, opts = {}) {
    const state = { launchCount: 0, probeCount: 0, editorOpened: false, closed: false, snapshot: opts.snapshot };
    const stubCap = {
      harvestFloorBytes: 0,
      harvestForKey: opts.harvestForKey || (() => null),
      urlForKey: () => null,
      recentFlowContentVideos: () => [],
      beginSubmission() {}, arm() {}, setDownloadAttempt() {}, clearDownloadAttempt() {},
      evictHarvest() {}, claimFlowContentVideo() {}, detach() {}
    };
    eng._headlessLaunch = async () => {
      state.launchCount++;
      return {
        browser: { close: async () => { state.closed = true; } },
        page: fakePage('headless-stub'),
        capture: stubCap,
        cloneDir: null
      };
    };
    eng._headlessProbeSnapshot = async () => { state.probeCount++; return state.snapshot; };
    eng._headlessOpenTaskEditor = async () => { state.editorOpened = true; return opts.editorOpen !== false; };
    return state;
  }
  {
    // (e) probe reject — editor NAHI khulta, dusri
    // dafa launch/probe bhi NAHI (cache), note wahi
    // thahra hua.
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { headlessHarvestWaitMs: 300 });
    eq('HH-ENG the headless route exists', typeof eng._tryHeadlessHarvest, 'function');
    eng.currentAccount = { id: 'acc-hh-reject', name: 'HH Reject' };
    eng.page = fakePage('main-hh-reject');
    const st = stubHeadlessSession(eng, { snapshot: { url: 'https://flow.google.com/', hasSignIn: true } });
    const task = { promptIndex: 0, captureKey: 'k-hh-reject', videoId: 'k-hh-reject', startTime: Date.now(), renderCompletedAt: Date.now() };
    const attempts1 = [];
    const r1 = await eng._tryHeadlessHarvest(task, '/tmp', { duration: '10s' }, attempts1, 'k-hh-reject', 0);
    eq('HH-REJECT the route fails', r1, false);
    eq('HH-REJECT the strategy note is the exact pinned text', attempts1.length === 1 && attempts1[0].note, headlessHarvest.PROBE_REJECT_NOTE);
    eq('HH-REJECT the strategy is headless-harvest', attempts1.length === 1 && attempts1[0].strategy, 'headless-harvest');
    ok('HH-REJECT the probe line was logged', logs.some(m => m.includes('[ROOT] headless-probe state=logged-out account=HH Reject')));
    eq('HH-REJECT the editor was never opened', st.editorOpened, false);
    eq('HH-REJECT the session was closed', st.closed, true);
    const attempts2 = [];
    const r2 = await eng._tryHeadlessHarvest(task, '/tmp', { duration: '10s' }, attempts2, 'k-hh-reject', 0);
    eq('HH-REJECT the second task also fails from cache', r2, false);
    eq('HH-REJECT the second note is the same pinned text', attempts2.length === 1 && attempts2[0].note, headlessHarvest.PROBE_REJECT_NOTE);
    eq('HH-REJECT no second launch happened', st.launchCount, 1);
    eq('HH-REJECT no second probe happened', st.probeCount, 1);
  }
  {
    // (f) probe qubool + mukammal body — save jeet.
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { headlessHarvestWaitMs: 2000 });
    eng.currentAccount = { id: 'acc-hh-win', name: 'HH Win' };
    eng.page = fakePage('main-hh-win');
    const st = stubHeadlessSession(eng, {
      snapshot: { url: 'https://flow.google.com/', hasPromptBox: true },
      harvestForKey: () => ({ url: FC_FRESH, buffer: mp4Buffer(600000), at: Date.now() })
    });
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const task = { promptIndex: 0, captureKey: 'k-hh-win', videoId: 'k-hh-win', startTime: Date.now() - 1000, renderCompletedAt: Date.now() - 500 };
    const attempts = [];
    const r = await eng._tryHeadlessHarvest(task, '/tmp', { duration: '10s' }, attempts, 'k-hh-win', 0);
    eq('HH-WIN the route saves', r, true);
    eq('HH-WIN the task is marked saved', task.mediaSaved, true);
    eq('HH-WIN the saved url is the editor stream', task.completedVideoUrl, FC_FRESH);
    ok('HH-WIN the probe line says logged-in', logs.some(m => m.includes('[ROOT] headless-probe state=logged-in account=HH Win')));
    ok('HH-WIN the win line is via=headless-harvest', logs.some(m => m.includes('[ROOT] via=headless-harvest gap=')));
    ok('HH-WIN the attempt strategy is headless-harvest ok', attempts.some(a => a.strategy === 'headless-harvest' && a.ok));
    eq('HH-WIN the session was closed after the win', st.closed, true);
  }
  {
    // (g) stream waqt par NAHI — haar, aur cascade
    // ki tartib headless → mainpage → grid (probe
    // cache ki wajah se phir bhi ek hi dafa).
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { headlessHarvestWaitMs: 300, mainpagePatienceMs: 600, mainpageViewportWaitMs: 200, mainpageHoverGraceMs: 100, mainpagePointerGraceMs: 100 });
    eng.currentAccount = { id: 'acc-hh-fall', name: 'HH Fall' };
    eng.page = fakePage('main-hh-fall');
    eng._readTileMediaState = async () => null;
    const st = stubHeadlessSession(eng, { snapshot: { url: 'https://flow.google.com/', hasPromptBox: true } });
    const task = { promptIndex: 0, captureKey: 'k-hh-fall', videoId: 'k-hh-fall', startTime: Date.now(), renderCompletedAt: Date.now() };
    const attempts0 = [];
    const r0 = await eng._tryHeadlessHarvest(task, '/tmp', { duration: '10s' }, attempts0, 'k-hh-fall', 0);
    eq('HH-FALL the route fails when no stream completes', r0, false);
    ok('HH-FALL the timeout was logged honestly', logs.some(m => m.includes('headless-harvest: no complete editor stream arrived')));
    const res = await eng._downloadTaskMediaInner(task, '/tmp', { duration: '10s' }, 0);
    eq('HH-FALL the cascade still fails honestly overall', res.ok, false);
    const seq = res.attempts.map(a => a.strategy);
    // v2.48.50 (item 7 — ROUTE RACE): headless aur
    // mainpage ab EK SAATH chalte hain — attempts ki
    // tartib khatam hone ki tartib hai, shuru hone ki
    // nahi; is liye yahan sirf maujoodgi parkhi jati
    // hai (route ORDER ka dawa task.downloadRouteOrder
    // par neeche waisa hi pin hai).
    ok('HH-FALL headless ran in the cascade', seq.indexOf('headless-harvest') >= 0);
    // grid-replay template na hone par khamoshi se skip
    // hota hai (koi attempt entry nahi) — entry ho to
    // mainpage ke BAAD hi hoga, aur haar ki line teeno
    // raaston ka naam leti hai.
    ok('HH-FALL mainpage ran, and any grid-replay attempt came after it', seq.indexOf('mainpage-harvest') >= 0 && (seq.indexOf('grid-replay') === -1 || seq.indexOf('mainpage-harvest') < seq.indexOf('grid-replay')));
    ok('HH-FALL the honest-fail line names all three routes', logs.some(m => m.includes('Download failed honestly') && m.includes('invisible-browser harvest') && m.includes('grid replay')));
    eq('HH-FALL the probe still ran only once across rounds', st.probeCount, 1);
    eq('HH-FALL the task route order is the three-step order', JSON.stringify(task.downloadRouteOrder), JSON.stringify(['headless-harvest', 'mainpage-harvest', 'grid-replay']));
  }
  {
    // (h) v2.48.45 — LAUNCH DIAGNOSTICS + CLONE HARDENING.
    const fsx = require('fs');
    const osx = require('os');
    const pathx = require('path');
    const { cloneFilePlan, buildHeadlessClone, removeHeadlessClone, copyFileWithRetry, cloneLogLine, launchFailNote, launchFailureReason } = headlessHarvest;
    // (i) ENGINE: _headlessLaunch phenke to strategy
    // note AUR warn line dono me asal wajah (message +
    // code) — ZEROCLICK12 ki gum-shuda wajah ab nahi.
    {
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { headlessHarvestWaitMs: 300 });
      eng.currentAccount = { id: 'acc-hh-launchfail', name: 'HH LaunchFail' };
      eng.page = fakePage('main-hh-launchfail');
      const boom = new Error('Profile not found at: C:\\Users\\prof');
      boom.code = 'ENOENT';
      eng._headlessLaunch = async () => { throw boom; };
      const task = { promptIndex: 0, captureKey: 'k-hh-lf', videoId: 'k-hh-lf', startTime: Date.now(), renderCompletedAt: Date.now() };
      const attempts = [];
      const r = await eng._tryHeadlessHarvest(task, '/tmp', { duration: '10s' }, attempts, 'k-hh-lf', 0);
      eq('HH-LAUNCHFAIL the route fails', r, false);
      ok('HH-LAUNCHFAIL the note carries the underlying error message', attempts.length === 1 && attempts[0].note.includes('Profile not found at:'));
      ok('HH-LAUNCHFAIL the note carries the error code', attempts.length === 1 && attempts[0].note.includes('[ENOENT]'));
      ok('HH-LAUNCHFAIL the note uses the launch-failed shape', attempts.length === 1 && attempts[0].note.startsWith('headless-harvest: launch failed ('));
      ok('HH-LAUNCHFAIL the warn log carries the reason too', logs.some(m => m.includes('headless-harvest: launch failed (') && m.includes('Profile not found at:')));
    }
    // Wajah saaf-suthri: code na ho to sirf message;
    // lamba message ~200 harf par kata.
    eq('HH-REASON a message without a code stays bare', launchFailureReason(new Error('plain boom')), 'plain boom');
    ok('HH-REASON a long message is truncated to ~200 chars', launchFailureReason(new Error('x'.repeat(500))).length <= 200);
    eq('HH-REASON the note shape is pinned', launchFailNote(new Error('kaboom')), 'headless-harvest: launch failed (kaboom) — the main-page routes ran next');
    // (ii) Clone log line.
    eq('HH-CLONELOG a clean clone line', cloneLogLine({ copied: ['a', 'b', 'c'], missing: [], warnings: [] }), '[ROOT] headless-clone copied=3 missing=none warnings=none');
    eq('HH-CLONELOG missing and warnings are listed, warnings capped at 3', cloneLogLine({ copied: ['a'], missing: ['Default/Cookies'], warnings: ['w1', 'w2', 'w3', 'w4'] }), '[ROOT] headless-clone copied=1 missing=Default/Cookies warnings=w1 | w2 | w3');
    eq('HH-CLONELOG garbage input still yields a line', cloneLogLine(null), '[ROOT] headless-clone copied=0 missing=none warnings=none');
    // (iii) Sidecars — khalis tarteeb + asal copy.
    const planSide = cloneFilePlan('/nowhere', {
      exists: (rel) => [pathx.join('Default', 'Network', 'Cookies'), pathx.join('Default', 'Network', 'Cookies') + '-wal', pathx.join('Default', 'Cookies'), pathx.join('Default', 'Cookies') + '-journal'].includes(rel),
      isDir: () => false
    });
    ok('HH-SIDECAR the plan includes the Network Cookies -wal', planSide.some(p => p.rel === pathx.join('Default', 'Network', 'Cookies') + '-wal'));
    ok('HH-SIDECAR the plan includes the plain Cookies -journal', planSide.some(p => p.rel === pathx.join('Default', 'Cookies') + '-journal'));
    eq('HH-SIDECAR sidecars only ride along with their Cookies file', planSide.length, 4);
    {
      const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'hh-side-'));
      const cloneDir = pathx.join(osx.tmpdir(), `hh-side-clone-${Date.now()}`);
      const w = (rel, content) => { const p = pathx.join(root, rel); fsx.mkdirSync(pathx.dirname(p), { recursive: true }); fsx.writeFileSync(p, content); };
      w('Local State', '{}');
      w(pathx.join('Default', 'Network', 'Cookies'), 'COOKIES-DB');
      w(pathx.join('Default', 'Network', 'Cookies') + '-wal', 'WAL-DATA');
      w(pathx.join('Default', 'Network', 'Cookies') + '-journal', 'JOURNAL-DATA');
      const res = await buildHeadlessClone(root, cloneDir);
      eq('HH-SIDECAR the -wal file is copied', fsx.readFileSync(pathx.join(cloneDir, 'Default', 'Network', 'Cookies') + '-wal', 'utf8'), 'WAL-DATA');
      eq('HH-SIDECAR the -journal file is copied', fsx.readFileSync(pathx.join(cloneDir, 'Default', 'Network', 'Cookies') + '-journal', 'utf8'), 'JOURNAL-DATA');
      ok('HH-SIDECAR the clone result counts the sidecars as copied', res.copied.some(r => r.endsWith('Cookies-wal')) && res.copied.some(r => r.endsWith('Cookies-journal')));
      ok('HH-SIDECAR the clone log line counts them too', cloneLogLine(res).startsWith(`[ROOT] headless-clone copied=${res.copied.length}`));
      await removeHeadlessClone(cloneDir);
      fsx.rmSync(root, { recursive: true, force: true });
    }
    // (iv) EBUSY retry — jaali copy function ke saath.
    {
      let calls = 0;
      const flaky = async () => { calls++; if (calls < 3) { const e = new Error('resource busy'); e.code = 'EBUSY'; throw e; } };
      await copyFileWithRetry('src', 'dest', { copyFile: flaky, sleep: async () => {} });
      eq('HH-RETRY an EBUSY copy succeeds on the third attempt', calls, 3);
      let calls2 = 0;
      const locked = async () => { calls2++; const e = new Error('still busy'); e.code = 'EBUSY'; throw e; };
      let threw2 = false;
      try { await copyFileWithRetry('src', 'dest', { copyFile: locked, sleep: async () => {} }); } catch (e) { threw2 = e.code === 'EBUSY'; }
      ok('HH-RETRY a copy that stays busy throws after the bounded attempts', threw2);
      eq('HH-RETRY the attempts are bounded at 3', calls2, 3);
      let calls3 = 0;
      const gone = async () => { calls3++; const e = new Error('no such file'); e.code = 'ENOENT'; throw e; };
      let threw3 = false;
      try { await copyFileWithRetry('src', 'dest', { copyFile: gone, sleep: async () => {} }); } catch (e) { threw3 = e.code === 'ENOENT'; }
      ok('HH-RETRY a non-retryable error throws at once', threw3 && calls3 === 1);
    }
  }

  // ---------------------------------------------------------------------------
  // P. v2.48.46 — FETCH DIAGNOSTICS + TRIED-URLS POISONING
  //    FIX + CLONE FAILURE REPORT / COOKIES DISCOVERY
  //    (ZEROCLICK13):
  //   (a) clone throw: err.cloneReport chipka hua;
  //       ibarat not-found vs copy-failed ka farq
  //       naam se batati hai;
  //   (b) cookies discovery scan: 'Profile 1/Network/
  //       Cookies' milta hai (+ sidecar), gehrai >3
  //       wala aur lock-naam dir wala NAHI milta;
  //       khalis listDir detector se bhi;
  //   (c) fetch diagnostics: nakam in-page fetch ki
  //       EK line (host/status/bytes/error/tries);
  //       kamyab fetch par koi line nahi;
  //   (d) completion ke teen nateeje seedha
  //       _mainpageCompleteCandidate se: 'no-body' /
  //       'rejected' / 'saved';
  //   (e) triedUrls zeher-khatma ENGINE ki satah par:
  //       pehli no-body par URL ek dafa aur parkha
  //       jata hai (fetch kul 2), dusri par tried
  //       rehta hai; verdict-rejected par fetch
  //       sirf EK dafa (hamesha tried).
  // ---------------------------------------------------------------------------
  {
    const fsx = require('fs');
    const osx = require('os');
    const pathx = require('path');
    const { buildHeadlessClone, removeHeadlessClone, cloneFilePlan, findCookiesRel, cloneLogLine } = headlessHarvest;
    // (a1) source me Cookies hai hi nahi — not-found.
    {
      const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'hh46-miss-'));
      fsx.writeFileSync(pathx.join(root, 'Local State'), '{}');
      let err = null;
      try { await buildHeadlessClone(root, pathx.join(osx.tmpdir(), `hh46-miss-clone-${Date.now()}`)); } catch (e) { err = e; }
      ok('HH46-MISS the no-Cookies clone still throws', !!err);
      eq('HH46-MISS the message says not found in the source profile', err && err.message, 'the profile copy has no Cookies file (not found in the source profile — see the headless-clone line)');
      ok('HH46-MISS the error carries the clone report', !!err && !!err.cloneReport);
      ok('HH46-MISS the report lists what was copied', !!err && err.cloneReport.copied.includes('Local State'));
      ok('HH46-MISS the report lists both Cookies paths as missing', !!err && err.cloneReport.missing.includes(pathx.join('Default', 'Network', 'Cookies')) && err.cloneReport.missing.includes(pathx.join('Default', 'Cookies')));
      ok('HH46-MISS the report warnings are an array', !!err && Array.isArray(err.cloneReport.warnings));
      eq('HH46-MISS the report cookiesRel is null on the standard layout', err && err.cloneReport.cookiesRel, null);
      ok('HH46-MISS the clone log line renders from the failure report', !!err && cloneLogLine(err.cloneReport).startsWith('[ROOT] headless-clone copied='));
      fsx.rmSync(root, { recursive: true, force: true });
    }
    // (a2) Cookies plan me hai, copy nakam — copy-failed.
    {
      const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'hh46-fail-'));
      const cloneDir = pathx.join(osx.tmpdir(), `hh46-fail-clone-${Date.now()}`);
      const w = (rel, content) => { const p = pathx.join(root, rel); fsx.mkdirSync(pathx.dirname(p), { recursive: true }); fsx.writeFileSync(p, content); };
      w('Local State', '{}');
      w(pathx.join('Default', 'Network', 'Cookies'), 'COOKIES-DB');
      const realCopyFile = fsx.promises.copyFile;
      fsx.promises.copyFile = async (src, dest) => {
        if (String(src).endsWith('Cookies')) { const e = new Error('simulated copy boom'); e.code = 'EIO'; throw e; }
        return realCopyFile(src, dest);
      };
      let err = null;
      try { await buildHeadlessClone(root, cloneDir); } catch (e) { err = e; } finally { fsx.promises.copyFile = realCopyFile; }
      ok('HH46-FAIL the failed-copy clone throws', !!err);
      ok('HH46-FAIL the message says copy failed', !!err && err.message.startsWith('the profile copy has no Cookies file (copy failed:'));
      ok('HH46-FAIL the message carries the first copy warning', !!err && err.message.includes('simulated copy boom'));
      ok('HH46-FAIL the report warning names the Cookies copy', !!err && err.cloneReport.warnings.some(x => x.includes('Cookies') && x.includes('simulated copy boom')));
      ok('HH46-FAIL the Cookies file is not in the copied list', !!err && !err.cloneReport.copied.some(r => r.endsWith('Cookies')));
      ok('HH46-FAIL Local State still copied', !!err && err.cloneReport.copied.includes('Local State'));
      await removeHeadlessClone(cloneDir);
      fsx.rmSync(root, { recursive: true, force: true });
    }
    // (b1) discovery scan — asal profile tree.
    {
      const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'hh46-scan-'));
      const cloneDir = pathx.join(osx.tmpdir(), `hh46-scan-clone-${Date.now()}`);
      const w = (rel, content) => { const p = pathx.join(root, rel); fsx.mkdirSync(pathx.dirname(p), { recursive: true }); fsx.writeFileSync(p, content); };
      w('Local State', '{}');
      w(pathx.join('Profile 1', 'Network', 'Cookies'), 'P1-COOKIES');
      w(pathx.join('Profile 1', 'Network', 'Cookies') + '-wal', 'P1-WAL');
      w(pathx.join('Deep', 'A', 'B', 'Cookies'), 'TOO-DEEP');
      const foundRel = pathx.join('Profile 1', 'Network', 'Cookies');
      eq('HH46-SCAN the scan finds the Profile 1 cookies', findCookiesRel(root), foundRel);
      const plan = cloneFilePlan(root);
      ok('HH46-SCAN the plan carries the scanned cookies entry', plan.some(p => p.rel === foundRel && p.viaScan === true));
      ok('HH46-SCAN the plan carries the scanned sidecar too', plan.some(p => p.rel === foundRel + '-wal'));
      const res = await buildHeadlessClone(root, cloneDir);
      eq('HH46-SCAN the scanned cookies are copied', fsx.readFileSync(pathx.join(cloneDir, foundRel), 'utf8'), 'P1-COOKIES');
      eq('HH46-SCAN the result reports where the cookies were found', res.cookiesRel, foundRel);
      await removeHeadlessClone(cloneDir);
      fsx.rmSync(root, { recursive: true, force: true });
    }
    // (b2) gehrai >3 wala aur lock-naam dir wala NAHI.
    {
      const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'hh46-deep-'));
      const w = (rel, content) => { const p = pathx.join(root, rel); fsx.mkdirSync(pathx.dirname(p), { recursive: true }); fsx.writeFileSync(p, content); };
      w('Local State', '{}');
      w(pathx.join('Deep', 'A', 'B', 'Cookies'), 'TOO-DEEP');
      w(pathx.join('lockfile', 'Cookies'), 'LOCKED-AWAY');
      eq('HH46-SCAN a depth-4 or locked-away cookies file is not found', findCookiesRel(root), null);
      fsx.rmSync(root, { recursive: true, force: true });
    }
    // (b3) khalis scan — jaali listDir detector.
    {
      const plan = cloneFilePlan('/nowhere', {
        exists: () => false,
        isDir: () => false,
        listDir: (rel) => {
          if (rel === '') return [{ name: 'Profile 9', isDir: true, isFile: false }];
          if (rel === 'Profile 9') return [{ name: 'Cookies', isDir: false, isFile: true }];
          return null;
        }
      });
      ok('HH46-SCAN the pure plan uses the injected scan', plan.some(p => p.rel === pathx.join('Profile 9', 'Cookies') && p.viaScan === true));
    }
  }
  {
    // (c) FETCH DIAGNOSTICS — nakam fetch ki ek line.
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, {});
    eng.page = fakePage('main-fetch-diag', { evaluateResult: { status: 403, b64: Buffer.from('<html>forbidden</html>').toString('base64') } });
    const best = await eng._fetchMainpageFullInPage(GV_URL);
    ok('FETCHDIAG an unusable best is still returned as before', !!best && best.status === 403);
    ok('FETCHDIAG the failure line names host and status', logs.some(m => m.includes('[ROOT] mainpage-fetch failed') && m.includes('host=rr2---sn-abc123.googlevideo.com') && m.includes('lastStatus=403')));
    ok('FETCHDIAG the failure line counts the tries', logs.some(m => m.includes('[ROOT] mainpage-fetch failed') && /tries=[1-9]/.test(m)));
    eq('FETCHDIAG the failure line comes exactly once', logs.filter(m => m.includes('[ROOT] mainpage-fetch failed')).length, 1);
  }
  {
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, {});
    eng.page = fakePage('main-fetch-throw', { evaluateResult: () => { throw new Error('CORS blocked by policy'); } });
    const none = await eng._fetchMainpageFullInPage(GV_URL);
    eq('FETCHDIAG a throwing fetch still returns null', none, null);
    ok('FETCHDIAG the failure line names the error', logs.some(m => m.includes('[ROOT] mainpage-fetch failed') && m.includes('lastStatus=none') && m.includes('CORS blocked by policy')));
  }
  {
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, {});
    const full = mp4Buffer(1250000);
    eng.page = fakePage('main-fetch-ok', { evaluateResult: { status: 200, b64: full.toString('base64') } });
    const good = await eng._fetchMainpageFullInPage(GV_URL);
    ok('FETCHDIAG a usable fetch returns the buffer', !!good && good.status === 200 && good.buf.length === 1250000);
    ok('FETCHDIAG a usable fetch logs no failure line', !logs.some(m => m.includes('[ROOT] mainpage-fetch failed')));
  }
  {
    // (d) COMPLETION KE TEEN NATEEJE — seedha
    // _mainpageCompleteCandidate, jaali fetch ke saath.
    const mkCtx = () => ({ captureKey: 'k-kinds', bindReason: 'order', floorBytes: 500000, teacherUrl: null, teacherHash: null, timingBucket: () => 'download-attempt', gapSec: () => '0.5' });
    const mkEntry = () => ({ url: GV_URL, src: 'googlevideo', partial: true, status: 206, contentRange: '', declaredLength: 0 });
    {
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, {});
      eng._fetchMainpageFullInPage = async () => null;
      const kind = await eng._mainpageCompleteCandidate({ promptIndex: 0 }, '/tmp', { duration: '10s' }, [], mkEntry(), mkCtx());
      eq('KINDS a fetch that yields nothing is no-body', kind, 'no-body');
      ok('KINDS the no-body line names the host', logs.some(m => m.includes('[ROOT] [Prompt #1] mainpage-complete: no body from in-page fetch') && m.includes('host=rr2---sn-abc123.googlevideo.com')));
    }
    {
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, {});
      eng._fetchMainpageFullInPage = async () => ({ buf: Buffer.from('<html><body>not a video</body></html>'), status: 200 });
      const kind = await eng._mainpageCompleteCandidate({ promptIndex: 0 }, '/tmp', { duration: '10s' }, [], mkEntry(), mkCtx());
      eq('KINDS a verdict that is not save is rejected', kind, 'rejected');
      ok('KINDS the rejection is logged as before', logs.some(m => m.includes('mainpage-harvest candidate rejected')));
    }
    {
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, {});
      const full = mp4Buffer(1250000); full[200] = 0x46;
      eng._fetchMainpageFullInPage = async () => ({ buf: full, status: 200 });
      eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
      const attempts = [];
      const kind = await eng._mainpageCompleteCandidate({ promptIndex: 0 }, '/tmp', { duration: '10s' }, attempts, mkEntry(), mkCtx());
      eq('KINDS a saved completion is saved', kind, 'saved');
      ok('KINDS the save is recorded in the attempts', attempts.some(a => a.strategy === 'mainpage-harvest' && a.ok));
    }
  }
  {
    // (e1) TRIED-URLS — pehli no-body par URL zeher
    // NAHI banta: watch use ek dafa aur parakhta hai
    // (fetch kul 2 dafa); dusri no-body ke baad wo
    // tried rehta hai (aur fetch NAHI hota).
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 200, mainpagePatienceMs: 700, mainpageHoverGraceMs: 100, mainpagePointerGraceMs: 100 });
    eng.page = fakePage('main-tried-nobody');
    eng._readTileMediaState = async () => null;
    let fetchCalls = 0;
    eng._fetchMainpageFullInPage = async () => { fetchCalls++; return null; };
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const nc = eng.netCapture;
    nc.arm();
    nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000', contentType: 'video/mp4' }, mp4Buffer(224692), 224692, Date.now());
    const task = { promptIndex: 0, captureKey: 'k-tried-nobody', videoId: 'k-tried-nobody', startTime: Date.now() - 3000, renderCompletedAt: Date.now() - 500 };
    const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-tried-nobody', 0);
    eq('TRIED a no-body stream still saves nothing', okSave, false);
    // v2.48.50 (item 4): cycles ab 4 hain — pehli
    // no-body par URL free hona barkarar hai (warna
    // dusri completion hoti hi nahi), aur kul
    // completions hadd ke andar rehti hain (watch ki
    // hadd is setup me 3 par rok deti hai; cycle-cap
    // 4 se zyada kabhi nahi).
    ok('TRIED the stream is completed more than the old twice (first no-body frees it)', fetchCalls >= 3);
    ok('TRIED completions stay bounded by the cycle cap of 4', fetchCalls <= 4);
    ok('TRIED both no-body completions are logged', logs.filter(m => m.includes('mainpage-complete: no body')).length >= 2);
  }
  {
    // (e2) TRIED-URLS — verdict-rejected URL hamesha
    // tried rehta hai: poori koshish me fetch sirf
    // EK dafa hota hai.
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 200, mainpagePatienceMs: 700, mainpageHoverGraceMs: 100, mainpagePointerGraceMs: 100 });
    eng.page = fakePage('main-tried-rejected');
    eng._readTileMediaState = async () => null;
    let fetchCalls = 0;
    eng._fetchMainpageFullInPage = async () => { fetchCalls++; return { buf: Buffer.from('<html><body>not a video</body></html>'), status: 200 }; };
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const nc = eng.netCapture;
    nc.arm();
    nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000', contentType: 'video/mp4' }, mp4Buffer(224692), 224692, Date.now());
    const task = { promptIndex: 0, captureKey: 'k-tried-rejected', videoId: 'k-tried-rejected', startTime: Date.now() - 3000, renderCompletedAt: Date.now() - 500 };
    const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-tried-rejected', 0);
    eq('TRIED a rejected stream saves nothing', okSave, false);
    eq('TRIED a rejected stream is fetched exactly once', fetchCalls, 1);
  }

  // ---------------------------------------------------------------------------
  // Q. v2.48.47 — CDP COOKIE TRANSFER + MEDIA-LOAD
  // COMPLETION PACK (ZEROCLICK14):
  //   (a) mapCookiesForSetCookies — getAllCookies ka
  //       jawab setCookies ki shakal me: expires>0 hi
  //       rehta hai, sameSite sirf Strict|Lax|None,
  //       baaki saare fields girte hain;
  //   (b) decideSessionPath — 'cdp' sirf live handle
  //       + cookies>0 par, warna 'clone';
  //   (c) _headlessReadLiveCookies (browser-level ->
  //       page-level -> haar) aur _headlessLaunch ka
  //       dispatch: transfer safal = clone kabhi
  //       nahi, transfer nakam/cookies-khaali = clone;
  //   (d) mediaBodyState / mediaLoadLogLine (khalis);
  //   (e) completion ki TARTIB: googlevideo par
  //       media-load pehle, flow-content par fetch
  //       pehle (dusra sirf pehle ke nakam hone par);
  //   (f) media-load ki asal wiring — jaali page jo
  //       sentinel lautaye + capture kitab me
  //       mukammal body = outcome=complete; 'ended'
  //       par behtareen adhoori body; sentinel na
  //       mile to saaf no-op (outcome=error).
  // ---------------------------------------------------------------------------
  {
    // (a) cookie mapping
    const full = headlessHarvest.mapCookiesForSetCookies([
      { name: 'SID', value: 'abc', domain: '.google.com', path: '/', expires: 1893456000, httpOnly: true, secure: true, sameSite: 'Lax', size: 42, session: false, priority: 'Medium', sameParty: false, sourceScheme: 'Secure', sourcePort: 443 }
    ]);
    eq('Q-MAP one cookie maps', full.length, 1);
    eq('Q-MAP only the setCookies fields survive', JSON.stringify(Object.keys(full[0]).sort()), JSON.stringify(['domain', 'expires', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'value']));
    eq('Q-MAP name/value/domain kept', `${full[0].name}|${full[0].value}|${full[0].domain}`, 'SID|abc|.google.com');
    eq('Q-MAP positive expires kept', full[0].expires, 1893456000);
    eq('Q-MAP sameSite Lax kept', full[0].sameSite, 'Lax');
    eq('Q-MAP httpOnly/secure kept', `${full[0].httpOnly}|${full[0].secure}`, 'true|true');
    const sess = headlessHarvest.mapCookiesForSetCookies([
      { name: 'A', value: '1', domain: 'x', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Strict' },
      { name: 'B', value: '2', domain: 'x', path: '/', expires: 0, sameSite: 'None' },
      { name: 'C', value: '', domain: 'x', sameSite: 'strict' },
      { name: 'D', value: '4', domain: 'x', sameSite: 'unspecified' },
      { value: 'no-name', domain: 'x' },
      'garbage',
      null
    ]);
    eq('Q-MAP nameless and garbage entries drop', sess.length, 4);
    ok('Q-MAP session expires (-1) is dropped', !('expires' in sess[0]));
    eq('Q-MAP sameSite Strict kept', sess[0].sameSite, 'Strict');
    ok('Q-MAP zero expires is dropped', !('expires' in sess[1]));
    eq('Q-MAP sameSite None kept', sess[1].sameSite, 'None');
    eq('Q-MAP empty value is kept', sess[2].value, '');
    ok('Q-MAP lowercase sameSite is dropped', !('sameSite' in sess[2]));
    ok('Q-MAP unspecified sameSite is dropped', !('sameSite' in sess[3]));
    eq('Q-MAP missing path becomes /', sess[2].path, '/');
    eq('Q-MAP garbage input maps to empty', JSON.stringify(headlessHarvest.mapCookiesForSetCookies(null)), '[]');
    eq('Q-MAP non-array input maps to empty', JSON.stringify(headlessHarvest.mapCookiesForSetCookies('cookies')), '[]');
  }
  {
    // (b) rasta chunna
    eq('Q-PATH live handle plus cookies is cdp', headlessHarvest.decideSessionPath({ liveHandle: true, cookieCount: 12 }), 'cdp');
    eq('Q-PATH zero cookies falls back to clone', headlessHarvest.decideSessionPath({ liveHandle: true, cookieCount: 0 }), 'clone');
    eq('Q-PATH no live handle is clone even with cookies', headlessHarvest.decideSessionPath({ liveHandle: false, cookieCount: 12 }), 'clone');
    eq('Q-PATH empty input is clone', headlessHarvest.decideSessionPath({}), 'clone');
    eq('Q-PATH garbage input is clone', headlessHarvest.decideSessionPath(null), 'clone');
  }
  {
    // (c1) live cookies padhna — browser-level session
    const eng = new FlowAutomationEngine({ onLog: () => {} });
    const cdp = {
      sent: [], detached: false,
      async send(m) { this.sent.push(m); if (m === 'Network.getAllCookies') return { cookies: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }] }; return {}; },
      async detach() { this.detached = true; }
    };
    eng.browser = { target: () => ({ createCDPSession: async () => cdp }) };
    eng.page = null;
    const cookies = await eng._headlessReadLiveCookies();
    eq('Q-CDP browser-level read returns the cookies', cookies.length, 2);
    ok('Q-CDP getAllCookies was among the calls', cdp.sent.includes('Network.getAllCookies'));
    eq('Q-CDP the read session is detached', cdp.detached, true);
  }
  {
    // (c2) page-level chaara + nakami par null
    const eng = new FlowAutomationEngine({ onLog: () => {} });
    eng.browser = null;
    const cdp = {
      async send(m) { if (m === 'Network.getAllCookies') return { cookies: [{ name: 'P', value: '9' }] }; return {}; },
      async detach() {}
    };
    eng.page = fakePage('q-cdp-page', { cdpClient: cdp });
    const cookies = await eng._headlessReadLiveCookies();
    eq('Q-CDP page-level read returns the cookies', cookies.length, 1);
    const engBad = new FlowAutomationEngine({ onLog: () => {} });
    engBad.browser = { target: () => ({ createCDPSession: async () => ({ async send() { throw new Error('no session'); }, async detach() {} }) }) };
    engBad.page = null;
    eq('Q-CDP a failing read returns null', await engBad._headlessReadLiveCookies(), null);
    const engNone = new FlowAutomationEngine({ onLog: () => {} });
    engNone.browser = null;
    engNone.page = null;
    eq('Q-CDP no handle at all returns null', await engNone._headlessReadLiveCookies(), null);
  }
  {
    // (c3) dispatch — transfer pehle, clone chaara
    const eng = new FlowAutomationEngine({ onLog: () => {} });
    const cdp = {
      async send(m) { if (m === 'Network.getAllCookies') return { cookies: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }] }; return {}; },
      async detach() {}
    };
    eng.browser = { target: () => ({ createCDPSession: async () => cdp }) };
    eng.page = null;
    let transferredWith = null;
    let clonedCalls = 0;
    eng._headlessLaunchTransferred = async (cookies) => { transferredWith = cookies; return { browser: {}, page: {}, capture: null, cloneDir: '/tmp/q' }; };
    eng._headlessLaunchCloned = async () => { clonedCalls++; return null; };
    const sess = await eng._headlessLaunch({ id: 'acct-q' });
    ok('Q-DISPATCH cdp path wins when live cookies exist', !!sess && Array.isArray(transferredWith) && transferredWith.length === 2);
    eq('Q-DISPATCH clone is not called on cdp success', clonedCalls, 0);
    eng._headlessLaunchTransferred = async () => null;
    await eng._headlessLaunch({ id: 'acct-q' });
    eq('Q-DISPATCH a failed transfer falls back to clone', clonedCalls, 1);
    const engEmpty = new FlowAutomationEngine({ onLog: () => {} });
    engEmpty.browser = { target: () => ({ createCDPSession: async () => ({ async send() { return { cookies: [] }; }, async detach() {} }) }) };
    engEmpty.page = null;
    let emptyTransferred = 0;
    let emptyCloned = 0;
    engEmpty._headlessLaunchTransferred = async () => { emptyTransferred++; return { browser: {} }; };
    engEmpty._headlessLaunchCloned = async () => { emptyCloned++; return null; };
    await engEmpty._headlessLaunch({ id: 'acct-q' });
    eq('Q-DISPATCH zero cookies never tries the transfer', emptyTransferred, 0);
    eq('Q-DISPATCH zero cookies goes straight to clone', emptyCloned, 1);
    const engCold = new FlowAutomationEngine({ onLog: () => {} });
    engCold.browser = null;
    engCold.page = null;
    let coldCloned = 0;
    engCold._headlessLaunchTransferred = async () => ({ browser: {} });
    engCold._headlessLaunchCloned = async () => { coldCloned++; return null; };
    await engCold._headlessLaunch({ id: 'acct-q' });
    eq('Q-DISPATCH no live browser goes straight to clone', coldCloned, 1);
  }
  {
    // (d) khalis media hisaab
    eq('Q-STATE no body is none', mediaBodyState({ knownTotal: 100, partial: true, status: 206 }, null), 'none');
    eq('Q-STATE an empty buffer is none', mediaBodyState({ knownTotal: 100, partial: true, status: 206 }, { buffer: Buffer.alloc(0) }), 'none');
    eq('Q-STATE a body covering knownTotal is complete', mediaBodyState({ knownTotal: 1000, declared: 0, partial: true, status: 206 }, { buffer: Buffer.alloc(1000) }), 'complete');
    eq('Q-STATE a body covering declared is complete', mediaBodyState({ knownTotal: 0, declared: 500, partial: true, status: 206 }, { buffer: Buffer.alloc(640) }), 'complete');
    eq('Q-STATE a non-partial 200 is complete', mediaBodyState({ knownTotal: 0, declared: 0, partial: false, status: 200 }, { buffer: Buffer.alloc(10) }), 'complete');
    eq('Q-STATE a short chunk is partial', mediaBodyState({ knownTotal: 1000, declared: 1000, partial: true, status: 206 }, { buffer: Buffer.alloc(300) }), 'partial');
    eq('Q-STATE no entry is partial', mediaBodyState(null, { buffer: Buffer.alloc(10) }), 'partial');
    eq('Q-LINE a complete line formats', mediaLoadLogLine({ host: 'rr4---sn-x.googlevideo.com', outcome: 'complete', bytes: 1201680 }), '[ROOT] mainpage-media-load host=rr4---sn-x.googlevideo.com outcome=complete bytes=1201680 el=hidden');
    eq('Q-LINE an unknown outcome coerces to error', mediaLoadLogLine({ host: 'h', outcome: 'weird', bytes: -3 }), '[ROOT] mainpage-media-load host=h outcome=error bytes=0 el=hidden');
    eq('Q-LINE garbage input is safe', mediaLoadLogLine(null), '[ROOT] mainpage-media-load host=none outcome=error bytes=0 el=hidden');
  }
  {
    // (e) completion ki tartib
    const mkCtx = (key) => ({ captureKey: key, bindReason: 'order', floorBytes: 500000, teacherUrl: null, teacherHash: null, timingBucket: () => 'download-attempt', gapSec: () => '0.5' });
    const gvEntry = { url: GV_URL, src: 'googlevideo', status: 206, partial: true, contentRange: 'bytes 0-224691/1250000', declared: 1250000 };
    const full = mp4Buffer(1250000);
    {
      // googlevideo: media pehle — fetch bilkul nahi
      const eng = new FlowAutomationEngine({ onLog: () => {} });
      let mediaCalls = 0;
      let fetchCalls = 0;
      eng._loadMainpageFullViaMedia = async () => { mediaCalls++; return { buf: full, status: 200 }; };
      eng._fetchMainpageFullInPage = async () => { fetchCalls++; return null; };
      eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
      const r = await eng._mainpageCompleteCandidate({ promptIndex: 0 }, '/tmp', { duration: '10s' }, [], gvEntry, mkCtx('k-q-gv-media'));
      eq('Q-ORDER googlevideo saved via media first', r, 'saved');
      eq('Q-ORDER googlevideo media called once', mediaCalls, 1);
      eq('Q-ORDER googlevideo fetch never called', fetchCalls, 0);
    }
    {
      // googlevideo: media nakam — fetch chaara
      const eng = new FlowAutomationEngine({ onLog: () => {} });
      let mediaCalls = 0;
      let fetchCalls = 0;
      eng._loadMainpageFullViaMedia = async () => { mediaCalls++; return null; };
      eng._fetchMainpageFullInPage = async () => { fetchCalls++; return { buf: full, status: 200 }; };
      eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
      const r = await eng._mainpageCompleteCandidate({ promptIndex: 0 }, '/tmp', { duration: '10s' }, [], gvEntry, mkCtx('k-q-gv-fetch'));
      eq('Q-ORDER googlevideo falls back to fetch and saves', r, 'saved');
      eq('Q-ORDER googlevideo media tried once before fetch', mediaCalls, 1);
      eq('Q-ORDER googlevideo fetch tried once after media', fetchCalls, 1);
    }
    {
      // flow-content: fetch pehle — media bilkul nahi
      const eng = new FlowAutomationEngine({ onLog: () => {} });
      let mediaCalls = 0;
      let fetchCalls = 0;
      eng._loadMainpageFullViaMedia = async () => { mediaCalls++; return { buf: full, status: 200 }; };
      eng._fetchMainpageFullInPage = async () => { fetchCalls++; return { buf: full, status: 200 }; };
      eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
      const fcEntry = { url: FC_FRESH, src: 'flow-content', status: 206, partial: true, contentRange: 'bytes 0-99/600000', declared: 600000 };
      const r = await eng._mainpageCompleteCandidate({ promptIndex: 0 }, '/tmp', { duration: '10s' }, [], fcEntry, mkCtx('k-q-fc-fetch'));
      eq('Q-ORDER flow-content saved via fetch first', r, 'saved');
      eq('Q-ORDER flow-content fetch called once', fetchCalls, 1);
      eq('Q-ORDER flow-content media never called', mediaCalls, 0);
    }
    {
      // flow-content: fetch nakam — media dusra
      const eng = new FlowAutomationEngine({ onLog: () => {} });
      let mediaCalls = 0;
      let fetchCalls = 0;
      eng._loadMainpageFullViaMedia = async () => { mediaCalls++; return { buf: full, status: 200 }; };
      eng._fetchMainpageFullInPage = async () => { fetchCalls++; return null; };
      eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
      const fcEntry = { url: FC_FRESH, src: 'flow-content', status: 206, partial: true, contentRange: 'bytes 0-99/600000', declared: 600000 };
      const r = await eng._mainpageCompleteCandidate({ promptIndex: 0 }, '/tmp', { duration: '10s' }, [], fcEntry, mkCtx('k-q-fc-media'));
      eq('Q-ORDER flow-content falls back to media and saves', r, 'saved');
      eq('Q-ORDER flow-content media tried once after fetch', mediaCalls, 1);
    }
  }
  {
    // (f) media-load ki asal wiring
    const mediaPage = (ended) => ({
      _closed: false,
      isClosed() { return this._closed; },
      async evaluate(fn) {
        const src = String(fn);
        if (src.includes('fs-media-load-started')) return 'fs-media-load-started';
        if (src.includes('__fsMediaLoadEnded === true')) return ended;
        return true;
      }
    });
    {
      // mukammal body capture me — outcome=complete
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageMediaLoadMs: 4000 });
      eng.page = mediaPage(false);
      const full = mp4Buffer(1250000);
      const nc = eng.netCapture;
      nc.arm();
      nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 1250000, status: 200, contentType: 'video/mp4' }, full, 1250000, Date.now());
      const res = await eng._loadMainpageFullViaMedia(GV_URL);
      ok('Q-MEDIA a complete captured body returns', !!res && res.buf.length === 1250000);
      eq('Q-MEDIA a complete body reports status 200', res && res.status, 200);
      ok('Q-MEDIA exactly one line, outcome=complete', logs.filter(m => m.includes('mainpage-media-load')).length === 1 && logs.some(m => m.includes('outcome=complete') && m.includes('bytes=1250000')));
    }
    {
      // element 'ended' — behtareen adhoori body
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageMediaLoadMs: 6000 });
      eng.page = mediaPage(true);
      const nc = eng.netCapture;
      nc.arm();
      nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000', contentType: 'video/mp4' }, mp4Buffer(224692), 224692, Date.now());
      const res = await eng._loadMainpageFullViaMedia(GV_URL);
      ok('Q-MEDIA ended returns the best partial body', !!res && res.buf.length === 224692);
      eq('Q-MEDIA a partial body keeps status 206', res && res.status, 206);
      ok('Q-MEDIA the line says outcome=ended', logs.some(m => m.includes('mainpage-media-load') && m.includes('outcome=ended') && m.includes('bytes=224692')));
    }
    {
      // sentinel na mile — saaf no-op, ek line
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageMediaLoadMs: 1000 });
      eng.page = fakePage('main-q-media-fake');
      const res = await eng._loadMainpageFullViaMedia(GV_URL);
      eq('Q-MEDIA a non-browser page is a clean no-op', res, null);
      ok('Q-MEDIA the no-op logs exactly one outcome=error line', logs.filter(m => m.includes('mainpage-media-load')).length === 1 && logs.some(m => m.includes('outcome=error')));
    }
    {
      // kuch capture hi na ho — timeout
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageMediaLoadMs: 1200 });
      eng.page = mediaPage(false);
      const res = await eng._loadMainpageFullViaMedia(GV_URL);
      eq('Q-MEDIA nothing captured returns null', res, null);
      ok('Q-MEDIA the line says outcome=timeout', logs.some(m => m.includes('mainpage-media-load') && m.includes('outcome=timeout')));
    }
  }

  // ---------------------------------------------------------------------------
  // R. PARTNER TASK 1 (Issue #1, MK tasking + amendment,
  //    2026-11-05) — headless-session ki do nayi lines
  //    (ZEROCLICK15: transfer ki nakami chup rehti thi,
  //    sirf clone ka EBUSY bolta tha):
  //   (a) dispatcher har bulawa par EK 'headless-session
  //       path=<cdp|clone> liveHandle=<..> cookies=<n>'
  //       line — rasta chunne se PEHLE;
  //   (b) transfer nakam ho to clone par girne se PEHLE
  //       EK 'headless-transfer failed (<wajah>)' line —
  //       wajah _headlessLaunchTransferred ki rakhi hui
  //       this._lastTransferFailure (whitespace dabaa
  //       kar, zyada se zyada 160 harf); wajah na mile
  //       to 'unknown reason';
  //   (c) safal transfer par, aur path=clone par, failed
  //       line kabhi nahi banti.
  // ---------------------------------------------------------------------------
  {
    const cdpWith = (cookies) => ({
      async send(m) { if (m === 'Network.getAllCookies') return { cookies }; return {}; },
      async detach() {}
    });
    {
      // (a)+(c) cdp safal — session line ek, failed line koi nahi
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) });
      eng.browser = { target: () => ({ createCDPSession: async () => cdpWith([{ name: 'A', value: '1' }, { name: 'B', value: '2' }]) }) };
      eng.page = null;
      let cloned = 0;
      eng._headlessLaunchTransferred = async () => ({ browser: {}, page: {}, capture: null, cloneDir: '/tmp/r' });
      eng._headlessLaunchCloned = async () => { cloned++; return null; };
      const sess = await eng._headlessLaunch({ id: 'acct-r' });
      ok('R-DISPATCH cdp success returns the session', !!sess);
      eq('R-DISPATCH clone untouched on success', cloned, 0);
      eq('R-LINE session line appears exactly once', logs.filter(m => m.includes('headless-session path=')).length, 1);
      ok('R-LINE session line names cdp, live handle and cookie count', logs.some(m => m === '[ROOT] headless-session path=cdp liveHandle=true cookies=2'));
      eq('R-LINE no transfer-failed line on success', logs.filter(m => m.includes('headless-transfer failed')).length, 0);
    }
    {
      // (b) transfer nakam, wajah maujud — line clone SE PEHLE
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) });
      eng.browser = { target: () => ({ createCDPSession: async () => cdpWith([{ name: 'A', value: '1' }]) }) };
      eng.page = null;
      eng._headlessLaunchTransferred = async function () { this._lastTransferFailure = 'Network.setCookies rejected: invalid cookie'; return null; };
      eng._headlessLaunchCloned = async () => { logs.push('CLONE-RAN'); return null; };
      await eng._headlessLaunch({ id: 'acct-r' });
      eq('R-LINE failed line appears exactly once', logs.filter(m => m.includes('headless-transfer failed')).length, 1);
      ok('R-LINE failed line carries the reason verbatim', logs.some(m => m === '[ROOT] headless-transfer failed (Network.setCookies rejected: invalid cookie) — clone fallback will run'));
      ok('R-LINE failed line is logged before the clone runs', logs.findIndex(m => m.includes('headless-transfer failed')) >= 0 && logs.findIndex(m => m.includes('headless-transfer failed')) < logs.indexOf('CLONE-RAN'));
    }
    {
      // (b2) wajah gum (purana bare-null andaaz) — phir bhi ek line
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) });
      eng.browser = { target: () => ({ createCDPSession: async () => cdpWith([{ name: 'A', value: '1' }]) }) };
      eng.page = null;
      let cloned = 0;
      eng._headlessLaunchTransferred = async () => null;
      eng._headlessLaunchCloned = async () => { cloned++; return null; };
      await eng._headlessLaunch({ id: 'acct-r' });
      ok('R-LINE a reason-less failure still names itself unknown', logs.some(m => m === '[ROOT] headless-transfer failed (unknown reason) — clone fallback will run'));
      eq('R-DISPATCH a reason-less failure still falls back', cloned, 1);
    }
    {
      // (b3) wajah ki safai — whitespace dabta hai, 160 harf ki hadd
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) });
      eng.browser = { target: () => ({ createCDPSession: async () => cdpWith([{ name: 'A', value: '1' }]) }) };
      eng.page = null;
      eng._headlessLaunchTransferred = async function () { this._lastTransferFailure = 'bad\n cookie\t' + 'x'.repeat(300); return null; };
      eng._headlessLaunchCloned = async () => null;
      await eng._headlessLaunch({ id: 'acct-r' });
      const line = logs.find(m => m.includes('headless-transfer failed'));
      ok('R-LINE the failed line exists for a messy reason', !!line);
      ok('R-LINE the reason is whitespace-collapsed', !!line && !line.includes('\n') && !line.includes('\t'));
      const reasonPart = line ? line.slice(line.indexOf('(') + 1, line.lastIndexOf(') — clone fallback')) : '';
      ok('R-LINE the reason is capped at 160 chars', reasonPart.length > 0 && reasonPart.length <= 160);
    }
    {
      // asal transferred, nakami ki qisam 1: mapped cookies zero
      // (live read me cookie hai lekin naam wala koi nahi —
      // Chrome bilkul nahi chalta, dispatch asal function se)
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) });
      eng.browser = {};
      eng.page = null;
      eng._headlessReadLiveCookies = async () => [{ value: 'nameless' }];
      let cloned = 0;
      eng._headlessLaunchCloned = async () => { cloned++; return null; };
      await eng._headlessLaunch({ id: 'acct-r' });
      ok('R-LINE session line counted the raw read', logs.some(m => m === '[ROOT] headless-session path=cdp liveHandle=true cookies=1'));
      ok('R-CLASS zero mapped cookies names itself', logs.some(m => m.includes('headless-transfer failed (zero mapped cookies')));
      eq('R-CLASS zero mapped falls back to clone', cloned, 1);
    }
    {
      // asal transferred, nakami ki qisam 2: windowless guard ka
      // inkaar (guard ko test ke liye band kiya gaya; launch
      // bilkul nahi hota, temp dir banta aur mit jata hai)
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) });
      eng.browser = {};
      eng.page = null;
      eng._headlessReadLiveCookies = async () => [{ name: 'A', value: '1', domain: '.google.com', path: '/' }];
      let cloned = 0;
      eng._headlessLaunchCloned = async () => { cloned++; return null; };
      const origGuard = headlessHarvest.launchIsWindowless;
      headlessHarvest.launchIsWindowless = () => false;
      try {
        await eng._headlessLaunch({ id: 'acct-r' });
      } finally {
        headlessHarvest.launchIsWindowless = origGuard;
      }
      ok('R-CLASS guard refusal names the windowless reason', logs.some(m => m.includes('headless-transfer failed (a windowless (headless) launch is not guaranteed')));
      eq('R-CLASS guard refusal falls back to clone', cloned, 1);
    }
    {
      // (a) path=clone — session line clone ki, transfer kabhi
      // nahi aazmaya jata, failed line koi nahi
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) });
      eng.browser = null;
      eng.page = null;
      let transferred = 0;
      let cloned = 0;
      eng._headlessLaunchTransferred = async () => { transferred++; return { browser: {} }; };
      eng._headlessLaunchCloned = async () => { cloned++; return null; };
      await eng._headlessLaunch({ id: 'acct-r' });
      ok('R-LINE clone session line is exact', logs.some(m => m === '[ROOT] headless-session path=clone liveHandle=false cookies=0'));
      eq('R-DISPATCH transfer never tried on the clone path', transferred, 0);
      eq('R-LINE no transfer-failed line on the clone path', logs.filter(m => m.includes('headless-transfer failed')).length, 0);
      eq('R-DISPATCH clone ran once', cloned, 1);
    }
  }

  // ---------------------------------------------------------------------------
  // S. v2.48.48 — CHUNK STORE + STORE-OUTCOME + MEDIA-LOAD V2 SEEK
  //    (ZEROCLICK15: poori-size stream aayi aur bandhi, lekin
  //    kitab fi-URL ek hi body rakhti thi aur header darwaza
  //    offset>0 wale range tukde hamesha gira deta tha —
  //    completion ke paas kabhi jodi hui body thi hi nahi;
  //    aur media-load ka element sirf buffer-shuda preview
  //    chala kar 'ended' ho jata tha, naya traffic zero):
  //   (a) parseContentRangeOffset (khalis)
  //   (b) chunk store + assembly — header darwaza sirf
  //       offset 0 par; lagi-hui dod; khaali jagah par
  //       rukawat; overlap pehle-rakha-jeeta; fi-URL cap;
  //       URL-hadd (2) barkarar; dobara nazar cap nahi khaati
  //   (c) store-outcome — entry ke fields + audit ki
  //       'stored=' pucchh (yes / no:header / no:size / no:empty)
  //   (d) media-load v2 seek — duration maloom ho to
  //       seek-to-end ek dafa + seek-back; na ho to koi seek nahi
  // ---------------------------------------------------------------------------
  {
    // (a) offset hisaab (khalis)
    eq('S-OFFSET range start parses', parseContentRangeOffset('bytes 500000-999999/1250000'), 500000);
    eq('S-OFFSET zero range is 0', parseContentRangeOffset('bytes 0-224691/1250000'), 0);
    eq('S-OFFSET absent range is 0', parseContentRangeOffset(''), 0);
    eq('S-OFFSET null range is 0', parseContentRangeOffset(null), 0);
    eq('S-OFFSET malformed range is 0', parseContentRangeOffset('items 5-9/20'), 0);
    eq('S-OFFSET star total still parses the start', parseContentRangeOffset('bytes 42-99/*'), 42);
  }
  {
    // (b0) assembly (khalis) — lagi-hui / khaali / overlap
    const cA = { offset: 0, buffer: Buffer.alloc(100, 0x41) };
    const cB = { offset: 100, buffer: Buffer.alloc(100, 0x42) };
    const joined = assembleMainpageChunks([cA, cB]);
    eq('S-ASM contiguous chunks join fully', joined && joined.length, 200);
    ok('S-ASM joined bytes keep their sides', !!joined && joined[0] === 0x41 && joined[150] === 0x42);
    const gapped = assembleMainpageChunks([cA, { offset: 200, buffer: Buffer.alloc(100, 0x43) }]);
    eq('S-ASM a gap stops the run at the gap', gapped && gapped.length, 100);
    eq('S-ASM no zero-start chunk means no body', assembleMainpageChunks([{ offset: 100, buffer: Buffer.alloc(10, 0x44) }]), null);
    const overlap = assembleMainpageChunks([
      { offset: 0, buffer: Buffer.alloc(100, 0x41) },
      { offset: 50, buffer: Buffer.alloc(100, 0x42) }
    ]);
    eq('S-ASM overlap extends only past the covered part', overlap && overlap.length, 150);
    ok('S-ASM first-stored wins the overlap', !!overlap && overlap[75] === 0x41 && overlap[120] === 0x42);
    const sameSpot = assembleMainpageChunks([
      { offset: 0, buffer: Buffer.alloc(100, 0x41) },
      { offset: 0, buffer: Buffer.alloc(100, 0x42) }
    ]);
    ok('S-ASM a same-offset re-store never overwrites', !!sameSpot && sameSpot.length === 100 && sameSpot[10] === 0x41);
    const pieces = uncoveredChunkPieces(50, Buffer.alloc(100, 0x42), [cA]);
    eq('S-PIECES only the uncovered tail is new', pieces.length === 1 && pieces[0].offset, 100);
    eq('S-PIECES a fully covered chunk adds nothing', uncoveredChunkPieces(0, Buffer.alloc(50, 0x41), [cA]).length, 0);
  }
  {
    // (b1) + (c) asal kitab — tukde jodte hain, header
    // darwaza offset>0 par nahi lagta, nateeja entry +
    // audit par bolta hai.
    const audits = [];
    const nc = new NetworkCapture({ onMainpageAudit: (a) => audits.push(a) });
    nc.arm();
    const GV_S = 'https://rr9---sn-testcase.googlevideo.com/videoplayback?expire=999&id=s1';
    nc._recordMainpageSighting({ url: GV_S, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000', contentType: 'video/mp4' }, mp4Buffer(224692), 224692, Date.now());
    let e = nc.mainpageEntries().find(x => x.url === GV_S);
    eq('S-STORE first chunk stored=yes', e && e.bodyStored, 'yes');
    eq('S-STORE stored chunk audit carries stored=yes', audits[audits.length - 1].stored, 'yes');
    ok('S-STORE audit line ends with stored=yes', formatMainpageAudit(audits[audits.length - 1]).endsWith(' stored=yes'));
    eq('S-STORE held body is the first chunk', (nc.mainpageBodyForUrl(GV_S) || {}).buffer?.length, 224692);
    // dusra tukda — header NAHI hai (0x07 bhara hua),
    // lekin offset>0 hai is liye darwaza nahi lagta.
    nc._recordMainpageSighting({ url: GV_S, src: 'googlevideo', declared: 300000, status: 206, contentRange: 'bytes 224692-524691/1250000', contentType: 'video/mp4' }, Buffer.alloc(300000, 0x07), 300000, Date.now());
    e = nc.mainpageEntries().find(x => x.url === GV_S);
    eq('S-STORE a headerless tail chunk is stored too', e && e.bodyStored, 'yes');
    const held2 = nc.mainpageBodyForUrl(GV_S);
    eq('S-STORE assembled body spans both chunks', held2 && held2.buffer.length, 524692);
    ok('S-STORE assembled bytes join at the seam', !!held2 && held2.buffer[224691] === 0 && held2.buffer[224692] === 0x07);
    // khaali jagah ke paar wala tukda — rakha jata hai
    // lekin dod wahi rukti hai.
    nc._recordMainpageSighting({ url: GV_S, src: 'googlevideo', declared: 100000, status: 206, contentRange: 'bytes 600000-699999/1250000', contentType: 'video/mp4' }, Buffer.alloc(100000, 0x09), 100000, Date.now());
    eq('S-STORE the assembled run still stops at the gap', (nc.mainpageBodyForUrl(GV_S) || {}).buffer?.length, 524692);
  }
  {
    // (c) na-rakhne ki teenon wajhein, naam ke saath
    const audits = [];
    const nc = new NetworkCapture({ onMainpageAudit: (a) => audits.push(a) });
    nc.arm();
    const GV_H = 'https://rr9---sn-testcase.googlevideo.com/videoplayback?expire=999&id=s2';
    nc._recordMainpageSighting({ url: GV_H, src: 'googlevideo', declared: 224692, status: 206, contentRange: 'bytes 0-224691/1250000', contentType: 'video/mp4' }, Buffer.alloc(224692, 0x05), 224692, Date.now());
    let e = nc.mainpageEntries().find(x => x.url === GV_H);
    eq('S-OUTCOME a headerless first chunk is not stored', e && e.bodyStored, 'no');
    eq('S-OUTCOME its reason is header', e && e.bodyStoreReason, 'header');
    ok('S-OUTCOME audit line ends with stored=no:header', formatMainpageAudit(audits[audits.length - 1]).endsWith(' stored=no:header'));
    eq('S-OUTCOME nothing is held after a header rejection', nc.mainpageBodyForUrl(GV_H), null);
    const GV_BIG = 'https://rr9---sn-testcase.googlevideo.com/videoplayback?expire=999&id=s3';
    nc._recordMainpageSighting({ url: GV_BIG, src: 'googlevideo', declared: 8388609, status: 206, contentRange: 'bytes 0-8388608/8388609', contentType: 'video/mp4' }, mp4Buffer(8388609), 8388609, Date.now());
    e = nc.mainpageEntries().find(x => x.url === GV_BIG);
    eq('S-OUTCOME an oversize body reason is size', e && e.bodyStoreReason, 'size');
    ok('S-OUTCOME audit line ends with stored=no:size', formatMainpageAudit(audits[audits.length - 1]).endsWith(' stored=no:size'));
    const GV_E = 'https://rr9---sn-testcase.googlevideo.com/videoplayback?expire=999&id=s4';
    nc._recordMainpageSighting({ url: GV_E, src: 'googlevideo', declared: 1250000, status: 206, contentRange: 'bytes 0-0/1250000', contentType: 'video/mp4' }, null, 0, Date.now());
    e = nc.mainpageEntries().find(x => x.url === GV_E);
    eq('S-OUTCOME an empty body reason is empty', e && e.bodyStoreReason, 'empty');
    ok('S-OUTCOME audit line ends with stored=no:empty', formatMainpageAudit(audits[audits.length - 1]).endsWith(' stored=no:empty'));
    // saveGuard ki khalis shakal — bina store-info ke
    // purani line bilkul waisi hi rehti hai.
    eq('S-OUTCOME auditOf maps yes', mainpageAuditOf({ bodyStored: 'yes' }).stored, 'yes');
    eq('S-OUTCOME auditOf maps no+reason', mainpageAuditOf({ bodyStored: 'no', bodyStoreReason: 'header' }).stored, 'no:header');
    eq('S-OUTCOME auditOf without store info has no stored field', 'stored' in mainpageAuditOf({ host: 'h' }), false);
    ok('S-OUTCOME a line without store info gains no suffix', !formatMainpageAudit(mainpageAuditOf({ host: 'h', bytes: 1, src: 'googlevideo', decision: 'captured', reason: 'ok' })).includes('stored='));
  }
  {
    // (b2) fi-URL cap + dobara nazar + URL-hadd (2)
    const nc = new NetworkCapture({});
    nc.arm();
    const GV_C = 'https://rr9---sn-testcase.googlevideo.com/videoplayback?expire=999&id=s5';
    const chunk4 = mp4Buffer(4194304);
    nc._recordMainpageSighting({ url: GV_C, src: 'googlevideo', declared: 4194304, status: 206, contentRange: 'bytes 0-4194303/12582912', contentType: 'video/mp4' }, chunk4, 4194304, Date.now());
    // wahi tukda dobara — cap do dafa nahi khata.
    nc._recordMainpageSighting({ url: GV_C, src: 'googlevideo', declared: 4194304, status: 206, contentRange: 'bytes 0-4194303/12582912', contentType: 'video/mp4' }, chunk4, 4194304, Date.now());
    nc._recordMainpageSighting({ url: GV_C, src: 'googlevideo', declared: 4194304, status: 206, contentRange: 'bytes 4194304-8388607/12582912', contentType: 'video/mp4' }, Buffer.alloc(4194304, 0x03), 4194304, Date.now());
    let e = nc.mainpageEntries().find(x => x.url === GV_C);
    eq('S-CAP a re-sighting does not double-count the cap', e && e.bodyStored, 'yes');
    eq('S-CAP two unique chunks fill exactly to the cap', (nc.mainpageBodyForUrl(GV_C) || {}).buffer?.length, 8388608);
    nc._recordMainpageSighting({ url: GV_C, src: 'googlevideo', declared: 100000, status: 206, contentRange: 'bytes 8388608-8488607/12582912', contentType: 'video/mp4' }, Buffer.alloc(100000, 0x04), 100000, Date.now());
    e = nc.mainpageEntries().find(x => x.url === GV_C);
    eq('S-CAP a chunk past the per-URL cap is size', e && e.bodyStoreReason, 'size');
    // URL-hadd: teesra URL pehle ko nikal deta hai.
    const nc2 = new NetworkCapture({});
    nc2.arm();
    const mk = (id) => `https://rr9---sn-testcase.googlevideo.com/videoplayback?expire=999&id=${id}`;
    for (const id of ['u1', 'u2', 'u3']) {
      nc2._recordMainpageSighting({ url: mk(id), src: 'googlevideo', declared: 100000, status: 206, contentRange: 'bytes 0-99999/1000000', contentType: 'video/mp4' }, mp4Buffer(100000), 100000, Date.now());
    }
    eq('S-CAP the two-URL cap evicts the oldest URL whole', nc2.mainpageBodyForUrl(mk('u1')), null);
    ok('S-CAP the newer URLs survive eviction', !!nc2.mainpageBodyForUrl(mk('u2')) && !!nc2.mainpageBodyForUrl(mk('u3')));
  }
  {
    // (d) media-load seek — v2.48.48 me v2 (sirf
    // aakhir), v2.48.50 (item 2) me SEEK V3: 25/50/75%
    // + duration−0.15, phir seek-back.
    const seekPage = (duration) => {
      const srcs = [];
      const calls = [];
      return {
        srcs,
        calls,
        _closed: false,
        isClosed() { return this._closed; },
        async evaluate(fn, arg) {
          const src = String(fn);
          srcs.push(src);
          calls.push({ src, arg });
          if (src.includes('fs-media-load-started')) return 'fs-media-load-started';
          if (src.includes('__fsMediaLoadEnded === true')) return false;
          if (src.includes('el.duration')) return duration;
          return true;
        }
      };
    };
    {
      // duration maloom (4s) — chaar seeks tartib se
      // [1, 2, 3, 3.85], phir EK seek-back; phir bhi
      // bilkul ek hi media-load line.
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageMediaLoadMs: 5200 });
      const page = seekPage(4);
      eng.page = page;
      const res = await eng._loadMainpageFullViaMedia(GV_URL);
      eq('S-SEEK nothing captured still returns null', res, null);
      const seeks = page.calls.map((c, i) => [c, i]).filter(([c]) => c.src.includes('el.currentTime = t'));
      const backs = page.calls.map((c, i) => [c, i]).filter(([c]) => c.src.includes('el.currentTime = 0'));
      eq('S-SEEK v3 performs four seeks (25/50/75/end)', seeks.length, 4);
      eq('S-SEEK v3 seek targets are the quarter points', JSON.stringify(seeks.map(([c]) => c.arg)), JSON.stringify([1, 2, 3, 3.85]));
      eq('S-SEEK seek-back happens exactly once', backs.length, 1);
      ok('S-SEEK the last seek comes before seek-back', seeks.length === 4 && backs.length === 1 && seeks[3][1] < backs[0][1]);
      ok('S-SEEK still exactly one media-load line (timeout)', logs.filter(m => m.includes('mainpage-media-load')).length === 1 && logs.some(m => m.includes('outcome=timeout')));
    }
    {
      // duration kabhi maloom nahi — koi seek nahi,
      // vyavhaar .47 jaisa (timeout).
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageMediaLoadMs: 1300 });
      const page = seekPage(-1);
      eng.page = page;
      const res = await eng._loadMainpageFullViaMedia(GV_URL);
      eq('S-SEEK no duration still returns null', res, null);
      eq('S-SEEK no duration means no seek evaluates at all', page.srcs.filter(s => s.includes('el.currentTime')).length, 0);
    }
  }

  // ---------------------------------------------------------------------------
  // T. v2.48.49 — COOKIE-READ V2 + TOO-SMALL MEDIA-LOAD
  //    MAUQA (ZEROCLICK16: har attempt 'headless-session
  //    path=clone liveHandle=true cookies=0' — live
  //    handle tha lekin akela Network.getAllCookies
  //    read 0 deta tha (ya chup nakam — .48 null ko
  //    bhi 0 hi chhaapti thi), CDP transfer kabhi
  //    chuna hi nahi gaya; mainpage par full stream
  //    aayi hi nahi, sirf too-small previews, is liye
  //    completion kabhi engage nahi hua):
  //   (a) aggregateCookieRead (khalis) — pehla >0
  //       jeet-ta hai, ek ki nakami baaki nahi rokti,
  //       saare nakam = null, saare khaali-chale =
  //       [], gumshuda entry = err;
  //   (b) cookieReadLogLine (khalis) — har tareeqa
  //       count ya 'err', chosen, total;
  //   (c) ENGINE read — browser Storage nakam par
  //       Network phir bhi chalta hai; page-level
  //       Storage jeet; pageApi aakhri chaara;
  //       session detach;
  //   (d) dispatcher — read null par 'cookies=null',
  //       khaali read par 'cookies=0';
  //   (e) mapCookiesForSetCookies — Puppeteer-shakal
  //       (page.cookies) cookies ki bardasht;
  //   (f) mainpageTooSmallMediaPick (khalis) —
  //       too-small + URL = chunav; URL na ho / wajah
  //       aur ho / flow-content / teacher / tried /
  //       task se pehle ki nazar = koi chunav nahi;
  //       sab se pehli nazar jeet-ti hai;
  //   (g) capture — too-small nazar halki yaad me
  //       darj, kitab (entries) me NAHI; dobara nazar
  //       par firstSeenAt wahi;
  //   (h) ENGINE mainpage — too-small URL par
  //       media-load bilkul EK dafa; element poori
  //       file kheench le to jodi body verdict se
  //       save; kuch na aaye to attempt aaj jaisa
  //       fail; koi too-small nazar hi na ho to
  //       media-load kabhi nahi.
  // ---------------------------------------------------------------------------
  {
    // (a) jod — khalis
    const agg1 = headlessHarvest.aggregateCookieRead({
      bStorage: { cookies: [] },
      bNetwork: { cookies: [{ name: 'A' }, { name: 'B' }] },
      pStorage: { cookies: [{ name: 'C' }, { name: 'D' }, { name: 'E' }] },
      pNetwork: { error: 'boom' },
      pageApi: { cookies: [] }
    });
    eq('T-AGG the first positive method wins', agg1.chosen, 'bNetwork');
    eq('T-AGG total is the winning count', agg1.total, 2);
    eq('T-AGG cookies are the winning array', agg1.cookies.length, 2);
    eq('T-AGG a later error does not undo the win', agg1.perMethod.pNetwork.state, 'err');
    const agg2 = headlessHarvest.aggregateCookieRead({
      bStorage: { cookies: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] },
      bNetwork: { cookies: [{ name: 'D' }] }
    });
    eq('T-AGG storage wins when it is positive first', agg2.chosen, 'bStorage');
    eq('T-AGG unattempted methods record as err', agg2.perMethod.pageApi.state, 'err');
    const agg3 = headlessHarvest.aggregateCookieRead({
      bStorage: { error: 'x' }, bNetwork: { error: 'y' }, pStorage: { error: 'z' },
      pNetwork: { error: 'w' }, pageApi: { error: 'v' }
    });
    eq('T-AGG all-error returns null cookies', agg3.cookies, null);
    eq('T-AGG all-error chooses none', agg3.chosen, 'none');
    eq('T-AGG all-error total is zero', agg3.total, 0);
    const agg4 = headlessHarvest.aggregateCookieRead({
      bStorage: { cookies: [] }, bNetwork: { error: 'y' }, pStorage: { cookies: [] },
      pNetwork: { cookies: [] }, pageApi: { cookies: [] }
    });
    ok('T-AGG all-empty-but-ran returns an empty array', Array.isArray(agg4.cookies) && agg4.cookies.length === 0);
    eq('T-AGG all-empty chooses none', agg4.chosen, 'none');
    const agg5 = headlessHarvest.aggregateCookieRead({
      bStorage: { error: 'storage blew up' }, bNetwork: { error: 'network blew up' },
      pStorage: { cookies: [{ name: 'P' }] }, pNetwork: { cookies: [] }, pageApi: { error: 'no api' }
    });
    eq('T-AGG an early error does not stop later methods', agg5.chosen, 'pStorage');
    eq('T-AGG garbage input is all-error null', headlessHarvest.aggregateCookieRead(null).cookies, null);
    eq('T-AGG long error text is capped at 60 chars', headlessHarvest.aggregateCookieRead({ bStorage: { error: 'e'.repeat(200) } }).perMethod.bStorage.error.length, 60);
  }
  {
    // (b) line ki shakal — khalis
    const agg = headlessHarvest.aggregateCookieRead({
      bStorage: { error: 'x' },
      bNetwork: { cookies: [{ name: 'A' }, { name: 'B' }] },
      pStorage: { cookies: [] },
      pNetwork: { error: 'y' },
      pageApi: { error: 'z' }
    });
    eq('T-LINE the cookieread line formats exactly', headlessHarvest.cookieReadLogLine(agg), '[ROOT] headless-cookieread bStorage=err bNetwork=2 pStorage=0 pNetwork=err pageApi=err chosen=bNetwork total=2');
    eq('T-LINE an all-error line formats exactly', headlessHarvest.cookieReadLogLine(headlessHarvest.aggregateCookieRead({})), '[ROOT] headless-cookieread bStorage=err bNetwork=err pStorage=err pNetwork=err pageApi=err chosen=none total=0');
    eq('T-LINE garbage input is safe', headlessHarvest.cookieReadLogLine(null), '[ROOT] headless-cookieread bStorage=err bNetwork=err pStorage=err pNetwork=err pageApi=err chosen=none total=0');
  }
  {
    // (c1) ENGINE — browser Storage nakam, Network
    // phir bhi chalta hai; line darj; detach hota hai
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) });
    const sent = [];
    let detached = false;
    const cdp = {
      async send(m) {
        sent.push(m);
        if (m === 'Storage.getCookies') throw new Error('storage denied');
        if (m === 'Network.getAllCookies') return { cookies: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }] };
        return {};
      },
      async detach() { detached = true; }
    };
    eng.browser = { target: () => ({ createCDPSession: async () => cdp }) };
    eng.page = null;
    const cookies = await eng._headlessReadLiveCookies();
    eq('T-READ network still runs after storage fails', cookies.length, 2);
    ok('T-READ both browser methods were attempted in order', sent[0] === 'Storage.getCookies' && sent[1] === 'Network.getAllCookies');
    eq('T-READ the browser session is detached', detached, true);
    ok('T-READ the cookieread line names the outcome', logs.some(m => m === '[ROOT] headless-cookieread bStorage=err bNetwork=2 pStorage=err pNetwork=err pageApi=err chosen=bNetwork total=2'));
  }
  {
    // (c2) ENGINE — page-level Storage jeet-ta hai
    // (browser hi nahi); pageApi maujud nahi = err
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) });
    eng.browser = null;
    const cdp = {
      async send(m) {
        if (m === 'Storage.getCookies') return { cookies: [{ name: 'P', value: '9' }] };
        if (m === 'Network.getAllCookies') return { cookies: [{ name: 'P', value: '9' }, { name: 'Q', value: '8' }] };
        return {};
      },
      async detach() {}
    };
    eng.page = fakePage('t-cdp-page', { cdpClient: cdp });
    const cookies = await eng._headlessReadLiveCookies();
    eq('T-READ page-level storage wins first', cookies.length, 1);
    ok('T-READ the line shows the page-level win', logs.some(m => m.includes('pStorage=1') && m.includes('chosen=pStorage') && m.includes('pageApi=err')));
  }
  {
    // (c3) ENGINE — CDP dono satahon par nakam,
    // Puppeteer page.cookies() aakhri chaara jeet-ta
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) });
    eng.browser = { target: () => ({ createCDPSession: async () => { throw new Error('no browser session'); } }) };
    const page = fakePage('t-api-page', {});
    page.target = () => ({ createCDPSession: async () => { throw new Error('no page session'); } });
    page.cookies = async () => ([
      { name: 'A', value: '1', domain: '.google.com', path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax' },
      { name: 'B', value: '2', domain: '.google.com', path: '/', expires: 1893456000, secure: false, httpOnly: false },
      { name: 'C', value: '3', domain: 'flow.google.com', path: '/' }
    ]);
    eng.page = page;
    const cookies = await eng._headlessReadLiveCookies();
    eq('T-READ the puppeteer api is the last resort', cookies.length, 3);
    ok('T-READ the line shows the pageApi win', logs.some(m => m.includes('pageApi=3') && m.includes('chosen=pageApi') && m.includes('total=3')));
  }
  {
    // (c4) ENGINE — paanchon nakam = null; paanchon
    // chale lekin khaali = [] (null NAHI)
    const engBad = new FlowAutomationEngine({ onLog: () => {} });
    engBad.browser = { target: () => ({ createCDPSession: async () => ({ async send() { throw new Error('dead'); }, async detach() {} }) }) };
    engBad.page = null;
    eq('T-READ a totally failed read returns null', await engBad._headlessReadLiveCookies(), null);
    const engEmpty = new FlowAutomationEngine({ onLog: () => {} });
    engEmpty.browser = { target: () => ({ createCDPSession: async () => ({ async send() { return { cookies: [] }; }, async detach() {} }) }) };
    engEmpty.page = null;
    const empty = await engEmpty._headlessReadLiveCookies();
    ok('T-READ an all-empty read returns an empty array, not null', Array.isArray(empty) && empty.length === 0);
  }
  {
    // (d) dispatcher — null banaam 0 ki chhaap
    const mkEng = (readResult) => {
      const logs = [];
      const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) });
      eng.browser = {};
      eng.page = null;
      eng._headlessReadLiveCookies = async () => readResult;
      eng._headlessLaunchTransferred = async () => ({ browser: {} });
      eng._headlessLaunchCloned = async () => null;
      return { logs, eng };
    };
    {
      const { logs, eng } = mkEng(null);
      await eng._headlessLaunch({ id: 'acct-t' });
      ok('T-DISP a null read prints cookies=null', logs.some(m => m === '[ROOT] headless-session path=clone liveHandle=true cookies=null'));
      ok('T-DISP a null read still gets its cookieread-free clone path', !logs.some(m => m.includes('headless-transfer failed')));
    }
    {
      const { logs, eng } = mkEng([]);
      await eng._headlessLaunch({ id: 'acct-t' });
      ok('T-DISP an empty read prints cookies=0', logs.some(m => m === '[ROOT] headless-session path=clone liveHandle=true cookies=0'));
    }
  }
  {
    // (e) mapper — Puppeteer-shakal ki bardasht
    const mapped = headlessHarvest.mapCookiesForSetCookies([
      { name: 'A', value: '1', domain: '.google.com', path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax' },
      { name: 'B', value: '2', domain: '.google.com', path: '/', expires: 1893456000.5, secure: false, httpOnly: false },
      { name: 'C', value: '3', domain: 'flow.google.com', path: '/' }
    ]);
    eq('T-MAP puppeteer cookies all map', mapped.length, 3);
    ok('T-MAP puppeteer session expires (-1) is dropped', !('expires' in mapped[0]));
    eq('T-MAP puppeteer sameSite Lax is kept', mapped[0].sameSite, 'Lax');
    eq('T-MAP puppeteer float expires is kept', mapped[1].expires, 1893456000.5);
    ok('T-MAP a missing sameSite stays missing', !('sameSite' in mapped[2]));
  }
  {
    // (f) trigger — khalis
    const S1 = 'https://rr5---sn-ts1.googlevideo.com/videoplayback?expire=999&id=ts1&itag=18';
    const S2 = 'https://rr4---sn-ts2.googlevideo.com/videoplayback?expire=999&id=ts2&itag=18';
    const base = { taskStart: 1000, teacherUrl: null, triedUrls: new Set() };
    const pick = mainpageTooSmallMediaPick({ ...base, sightings: [{ url: S1, src: 'googlevideo', reason: 'stream-too-small', firstSeenAt: 2000 }] });
    ok('T-PICK a too-small googlevideo sighting is picked', !!pick && pick.url === S1);
    eq('T-PICK a sighting without a URL is not picked', mainpageTooSmallMediaPick({ ...base, sightings: [{ src: 'googlevideo', reason: 'stream-too-small', firstSeenAt: 2000 }] }), null);
    eq('T-PICK an empty URL is not picked', mainpageTooSmallMediaPick({ ...base, sightings: [{ url: '', src: 'googlevideo', reason: 'stream-too-small', firstSeenAt: 2000 }] }), null);
    eq('T-PICK a different ignore reason is not picked', mainpageTooSmallMediaPick({ ...base, sightings: [{ url: S1, src: 'googlevideo', reason: 'not-video-candidate', firstSeenAt: 2000 }] }), null);
    eq('T-PICK a flow-content sighting is not picked', mainpageTooSmallMediaPick({ ...base, sightings: [{ url: S1, src: 'flow-content', reason: 'stream-too-small', firstSeenAt: 2000 }] }), null);
    eq('T-PICK the teacher URL is not picked', mainpageTooSmallMediaPick({ ...base, teacherUrl: S1, sightings: [{ url: S1, src: 'googlevideo', reason: 'stream-too-small', firstSeenAt: 2000 }] }), null);
    eq('T-PICK an already-tried URL is not picked', mainpageTooSmallMediaPick({ ...base, triedUrls: new Set([S1]), sightings: [{ url: S1, src: 'googlevideo', reason: 'stream-too-small', firstSeenAt: 2000 }] }), null);
    eq('T-PICK a sighting from before the task started is not picked', mainpageTooSmallMediaPick({ ...base, sightings: [{ url: S1, src: 'googlevideo', reason: 'stream-too-small', firstSeenAt: 500 }] }), null);
    const pick2 = mainpageTooSmallMediaPick({ ...base, sightings: [
      { url: S2, src: 'googlevideo', reason: 'stream-too-small', firstSeenAt: 3000 },
      { url: S1, src: 'googlevideo', reason: 'stream-too-small', firstSeenAt: 2000 }
    ] });
    ok('T-PICK the earliest sighting wins', !!pick2 && pick2.url === S1);
    eq('T-PICK garbage input picks nothing', mainpageTooSmallMediaPick(null), null);
    eq('T-PICK no sightings picks nothing', mainpageTooSmallMediaPick({ ...base, sightings: [] }), null);
  }
  {
    // (g) capture — yaad darj hoti hai, kitab nahi
    const nc = new NetworkCapture({});
    nc.arm();
    const GV_TS = 'https://rr3---sn-tsmall.googlevideo.com/videoplayback?expire=999&id=tsm&itag=18';
    const t0 = Date.now();
    nc._recordMainpageSighting({ url: GV_TS, src: 'googlevideo', declared: 85725, status: 206, contentRange: 'bytes 0-85724/85725', contentType: 'video/mp4' }, mp4Buffer(85725), 85725, t0);
    const mem = nc.mainpageTooSmallSightings();
    eq('T-CAP the too-small sighting is remembered', mem.length, 1);
    ok('T-CAP the memory carries url, reason and first seen', mem.length === 1 && mem[0].url === GV_TS && mem[0].reason === 'stream-too-small' && mem[0].firstSeenAt === t0);
    eq('T-CAP the sighting still never enters the book', nc.mainpageEntries().some(e => e.url === GV_TS), false);
    nc._recordMainpageSighting({ url: GV_TS, src: 'googlevideo', declared: 85725, status: 206, contentRange: 'bytes 0-85724/85725', contentType: 'video/mp4' }, mp4Buffer(85725), 85725, t0 + 5000);
    const mem2 = nc.mainpageTooSmallSightings();
    eq('T-CAP a re-sighting stays one memory entry', mem2.length, 1);
    eq('T-CAP a re-sighting keeps the first firstSeenAt', mem2[0].firstSeenAt, t0);
  }
  {
    // (h1) ENGINE — media-load EK dafa; element
    // poori file kheench le to save verdict se hota
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 200, mainpagePatienceMs: 700, mainpageHoverGraceMs: 100, mainpagePointerGraceMs: 100 });
    eng.page = fakePage('main-ts-save');
    eng._readTileMediaState = async () => null;
    const nc = eng.netCapture;
    nc.arm();
    const GV_TS = 'https://rr5---sn-tssave.googlevideo.com/videoplayback?expire=999&id=tss&itag=18';
    nc._recordMainpageSighting({ url: GV_TS, src: 'googlevideo', declared: 85725, status: 206, contentRange: 'bytes 0-85724/85725', contentType: 'video/mp4' }, mp4Buffer(85725), 85725, Date.now());
    let mediaCalls = 0;
    eng._loadMainpageFullViaMedia = async (url) => {
      mediaCalls++;
      // adrishya element ne poori file kheench li —
      // asal zindagi me yahi nazar capture me aati hai
      nc._recordMainpageSighting({ url, src: 'googlevideo', declared: 1250000, status: 200, contentRange: '', contentType: 'video/mp4' }, mp4Buffer(1250000), 1250000, Date.now());
      return { buf: mp4Buffer(1250000), status: 200 };
    };
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const task = { promptIndex: 0, captureKey: 'k-ts-save', videoId: 'k-ts-save', startTime: Date.now() - 3000, renderCompletedAt: Date.now() - 500 };
    const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-ts-save', 0);
    eq('T-ENG a completed too-small URL saves the task', okSave, true);
    eq('T-ENG media-load ran exactly once for it', mediaCalls, 1);
    eq('T-ENG the saved file is the too-small URL itself', task.completedVideoUrl, GV_TS);
  }
  {
    // (h2) ENGINE — media-load chala, kuch na aaya:
    // attempt bilkul aaj jaisa fail, media EK dafa
    const eng = new FlowAutomationEngine({ onLog: () => {} }, { mainpageViewportWaitMs: 200, mainpagePatienceMs: 700, mainpageHoverGraceMs: 100, mainpagePointerGraceMs: 100 });
    eng.page = fakePage('main-ts-fail');
    eng._readTileMediaState = async () => null;
    const nc = eng.netCapture;
    nc.arm();
    const GV_TS = 'https://rr5---sn-tsfail.googlevideo.com/videoplayback?expire=999&id=tsf&itag=18';
    nc._recordMainpageSighting({ url: GV_TS, src: 'googlevideo', declared: 110290, status: 206, contentRange: 'bytes 0-110289/110290', contentType: 'video/mp4' }, mp4Buffer(110290), 110290, Date.now());
    let mediaCalls = 0;
    eng._loadMainpageFullViaMedia = async () => { mediaCalls++; return null; };
    const task = { promptIndex: 0, captureKey: 'k-ts-fail', videoId: 'k-ts-fail', startTime: Date.now() - 3000, renderCompletedAt: Date.now() - 500 };
    const okFail = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-ts-fail', 0);
    eq('T-ENG an unproductive media-load still fails the attempt', okFail, false);
    eq('T-ENG media-load still ran exactly once', mediaCalls, 1);
  }
  {
    // (h3) ENGINE — too-small nazar hi nahi (sirf
    // not-video-candidate entry): media-load kabhi
    // nahi chalta
    const eng = new FlowAutomationEngine({ onLog: () => {} }, { mainpageViewportWaitMs: 200, mainpagePatienceMs: 700, mainpageHoverGraceMs: 100, mainpagePointerGraceMs: 100 });
    eng.page = fakePage('main-ts-none');
    eng._readTileMediaState = async () => null;
    const nc = eng.netCapture;
    nc.arm();
    const GV_HTML = 'https://rr6---sn-tshtml.googlevideo.com/videoplayback?expire=999&id=tsh&itag=18';
    nc._recordMainpageSighting({ url: GV_HTML, src: 'googlevideo', declared: 0, status: 206, contentRange: '', contentType: 'text/html' }, mp4Buffer(100000), 100000, Date.now());
    let mediaCalls = 0;
    eng._loadMainpageFullViaMedia = async () => { mediaCalls++; return null; };
    const task = { promptIndex: 0, captureKey: 'k-ts-none', videoId: 'k-ts-none', startTime: Date.now() - 3000, renderCompletedAt: Date.now() - 500 };
    const okNone = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-ts-none', 0);
    eq('T-ENG no too-small sighting fails as before', okNone, false);
    eq('T-ENG media-load never runs without the trigger', mediaCalls, 0);
  }

  // ---------------------------------------------------------------------------
  // U. v2.48.50 — MEGA PACK (18 items, owner order
  //    2026-11-05: "ek saath 15-20 features dalo"):
  //   (a) media-load log line el=tile / el=hidden
  //       (khalis) + tile-first chunav (khalis);
  //   (b) asal tile drive — element kabhi nahi
  //       hat-ta, line el=tile ke saath;
  //   (c) cycles — wrapper attempt-wide hadd 4,
  //       outcomes task par darj;
  //   (d) probe line (khalis) + transfer names
  //       (khalis: sirf naam, sorted, truncated);
  //   (e) tolerant clone faisla (khalis) + asal
  //       clone par tolerant wapsi / strict throw;
  //   (f) combo trigger (khalis);
  //   (g) synthetic Cookies DB — build + read-back
  //       parkh + file likhna;
  //   (h) probe sabr (item 13) — reload wali teesri
  //       koshish; blocked foran;
  //   (i) segment kunji (khalis) + assembly union +
  //       onSegmentNote; cache nazar (item 3) entry
  //       par fromCache + stored=yes;
  //   (j) attempt-summary line (khalis);
  //   (k) route-race save darwaza — dusre ke dawe
  //       par 'route-race' inkaar; nakami par dawa
  //       chhoot jata hai.
  // ---------------------------------------------------------------------------
  {
    // (a) line + chunav — khalis
    eq('U-LINE el=tile formats', mediaLoadLogLine({ host: 'h', outcome: 'ended', bytes: 10, el: 'tile' }), '[ROOT] mainpage-media-load host=h outcome=ended bytes=10 el=tile');
    eq('U-LINE el=hidden formats', mediaLoadLogLine({ host: 'h', outcome: 'complete', bytes: 5, el: 'hidden' }), '[ROOT] mainpage-media-load host=h outcome=complete bytes=5 el=hidden');
    eq('U-LINE an unknown el coerces to hidden', mediaLoadLogLine({ host: 'h', outcome: 'complete', bytes: 5, el: 'weird' }), '[ROOT] mainpage-media-load host=h outcome=complete bytes=5 el=hidden');
    eq('U-PICK a tile with src is picked', mediaLoadElementPick({ found: true, hasSrc: true, duration: -1 }), 'tile');
    eq('U-PICK a tile with duration is picked', mediaLoadElementPick({ found: true, hasSrc: false, duration: 9.5 }), 'tile');
    eq('U-PICK a tile with neither src nor duration falls back', mediaLoadElementPick({ found: true, hasSrc: false, duration: -1 }), 'hidden');
    eq('U-PICK no tile element falls back', mediaLoadElementPick({ found: false, hasSrc: true, duration: 5 }), 'hidden');
    eq('U-PICK garbage falls back', mediaLoadElementPick(null), 'hidden');
  }
  {
    // (b) asal tile drive — jaali page jo tile
    // element ke evaluate pehchanta hai.
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageMediaLoadMs: 3000 });
    const srcs = [];
    eng.page = {
      _closed: false,
      isClosed() { return this._closed; },
      async evaluate(fn) {
        const src = String(fn);
        srcs.push(src);
        if (src.includes('__fsTileMediaEl') && src.includes('wasPaused')) return { ok: true, wasPaused: true };
        return true;
      }
    };
    const nc = eng.netCapture;
    nc.arm();
    nc._recordMainpageSighting({ url: GV_URL, src: 'googlevideo', declared: 1250000, status: 200, contentType: 'video/mp4' }, mp4Buffer(1250000), 1250000, Date.now());
    const res = await eng._driveMainpageMediaLoad(GV_URL, 'tile', null, null);
    ok('U-TILE a complete captured body returns via the tile drive', !!res && !!res.best && res.best.buf.length === 1250000);
    eq('U-TILE the outcome is complete', res && res.outcome, 'complete');
    ok('U-TILE the line says el=tile', logs.some(m => m.includes('mainpage-media-load') && m.includes('el=tile') && m.includes('outcome=complete')));
    ok('U-TILE the tile element is never removed (no removeAttribute evaluate)', !srcs.some(s => s.includes('removeAttribute')));
    ok('U-TILE no hidden element was created', !srcs.some(s => s.includes('fs-media-load-started')));
  }
  {
    // (c) cycles — drive stub: har bulawa ginata
    // hai; hadd 4 ke baad drive NAHI chalta.
    const eng = new FlowAutomationEngine({ onLog: () => {} }, {});
    let drives = 0;
    const seenEls = [];
    eng._driveMainpageMediaLoad = async (url, el) => { drives++; seenEls.push(el); return { best: null, outcome: 'timeout' }; };
    eng._probeMainpageTileVideo = async () => ({ found: true, hasSrc: true, duration: 5, currentSrc: GV_URL });
    const task = { promptIndex: 0 };
    for (let i = 0; i < 5; i++) await eng._loadMainpageFullViaMedia(GV_URL, { task, tileIndexHint: 0 });
    eq('U-CYCLE drives stop at the attempt cap of 4', drives, 4);
    eq('U-CYCLE the task cycle count is 4', task._mpCompleteCycles, 4);
    eq('U-CYCLE every drive chose the tile element', JSON.stringify(seenEls), JSON.stringify(['tile', 'tile', 'tile', 'tile']));
    eq('U-CYCLE the tile outcome is recorded on the task', task._mediaElOutcomes && task._mediaElOutcomes.tile, 'timeout');
  }
  {
    // (d) probe line + transfer names — khalis
    // v2.48.51 (item 2): line ke aakhir me captcha +
    // marker tafseel (bina marker = 'marker=-').
    eq('U-PROBE the line formats with url and markers', headlessHarvest.probeLogLine({ state: 'logged-out', account: 'acc', url: 'https://flow.google.com/project/abc?x=1', hasSignIn: true, hasAvatar: false, hasPromptBox: false }),
      '[ROOT] headless-probe state=logged-out account=acc url=flow.google.com/project/abc signIn=true avatar=false promptBox=false captcha=false marker=-');
    eq('U-PROBE a missing url is none', headlessHarvest.probeLogLine({ state: 'blocked', account: 'a' }),
      '[ROOT] headless-probe state=blocked account=a url=none signIn=false avatar=false promptBox=false captcha=false marker=-');
    const longUrl = 'https://flow.google.com/' + 'p'.repeat(200);
    ok('U-PROBE the url is capped at 80 chars', headlessHarvest.probeLogLine({ state: 'logged-out', account: 'a', url: longUrl }).includes(`url=${('flow.google.com/' + 'p'.repeat(200)).slice(0, 80)} `));
    eq('U-NAMES names are deduped and sorted', headlessHarvest.cookieNamesForLog([{ name: 'B' }, { name: 'A' }, { name: 'B' }, { name: 'C' }]), 'A,B,C');
    eq('U-NAMES values never appear', headlessHarvest.cookieNamesForLog([{ name: 'SID', value: 'SECRET-VALUE' }]), 'SID');
    eq('U-NAMES empty is none', headlessHarvest.cookieNamesForLog([]), 'none');
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `cookie-name-${String(i).padStart(3, '0')}` }));
    ok('U-NAMES the list is truncated at 300 chars', headlessHarvest.cookieNamesForLog(many).length <= 300);
  }
  {
    // (e) tolerant clone — khalis faisla
    const plan = [{ rel: 'Local State' }, { rel: 'Default/Network/Cookies' }, { rel: 'Default/Network/Cookies-wal' }, { rel: 'Default/Preferences' }];
    const decOk = headlessHarvest.tolerantCloneDecision({ plan, copied: ['Local State', 'Default/Preferences'], missing: [] });
    eq('U-CLONE only-cookies-failed is tolerable', decOk.ok, true);
    eq('U-CLONE the failed list names the cookies files', JSON.stringify(decOk.failed), JSON.stringify(['Default/Network/Cookies', 'Default/Network/Cookies-wal']));
    const decBad = headlessHarvest.tolerantCloneDecision({ plan, copied: ['Default/Network/Cookies'], missing: [] });
    eq('U-CLONE another essential failing blocks tolerance', decBad.ok, false);
    eq('U-CLONE the blocking list names it', JSON.stringify(decBad.blocking), JSON.stringify(['Local State', 'Default/Preferences']));
    eq('U-CLONE garbage input blocks nothing falsely', headlessHarvest.tolerantCloneDecision(null).ok, true);
    eq('U-CLONE a cookies rel is recognised by basename', headlessHarvest.isCookiesCloneRel('Default\\Network\\Cookies-journal'), true);
    eq('U-CLONE a non-cookies rel is not', headlessHarvest.isCookiesCloneRel('Default/Preferences'), false);
  }
  {
    // (e2) asal clone — Cookies bilkul na ho:
    // strict phenkta hai, tolerant report deta hai.
    const fsx = require('fs');
    const osx = require('os');
    const pathx = require('path');
    const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'fs-u-clone-'));
    const profile = pathx.join(root, 'profile');
    fsx.mkdirSync(pathx.join(profile, 'Default', 'Local Storage'), { recursive: true });
    fsx.mkdirSync(pathx.join(profile, 'Default', 'Session Storage'), { recursive: true });
    fsx.writeFileSync(pathx.join(profile, 'Local State'), '{}');
    fsx.writeFileSync(pathx.join(profile, 'Default', 'Preferences'), '{}');
    let strictThrew = false;
    try { await headlessHarvest.buildHeadlessClone(profile, pathx.join(root, 'c1')); } catch (e) { strictThrew = /Cookies/.test(e.message); }
    eq('U-CLONE strict mode still throws without Cookies', strictThrew, true);
    const tol = await headlessHarvest.buildHeadlessClone(profile, pathx.join(root, 'c2'), { tolerantCookiesOnly: true });
    ok('U-CLONE tolerant mode returns the clone report', !!tol && tol.tolerantCookies === true);
    ok('U-CLONE the tolerant clone holds the other essentials', !!tol && tol.copied.some(r => r.endsWith('Local State')));
    await headlessHarvest.removeHeadlessClone(root);
  }
  {
    // (f) combo trigger — khalis
    eq('U-COMBO cdp + logged-out + untried fires', headlessHarvest.headlessComboApplies({ via: 'cdp', verdict: 'logged-out', tried: false }), true);
    // v2.48.51 (item 2): blocked bhi ab trigger hai
    // (ZEROCLICK18 — .50 me 'never fires' pin tha).
    eq('U-COMBO blocked now fires', headlessHarvest.headlessComboApplies({ via: 'cdp', verdict: 'blocked', tried: false }), true);
    eq('U-COMBO the clone path never fires', headlessHarvest.headlessComboApplies({ via: 'clone', verdict: 'logged-out', tried: false }), false);
    eq('U-COMBO an already-tried combo never refires', headlessHarvest.headlessComboApplies({ via: 'cdp', verdict: 'logged-out', tried: true }), false);
    eq('U-COMBO logged-in never fires', headlessHarvest.headlessComboApplies({ via: 'cdp', verdict: 'logged-in', tried: false }), false);
    eq('U-COMBO garbage never fires', headlessHarvest.headlessComboApplies(null), false);
  }
  {
    // (g) synthetic Cookies DB — build + parkh
    const sample = [
      { name: 'SID', value: 'v1', domain: '.google.com', path: '/', expires: 1893456000, secure: true, httpOnly: true, sameSite: 'Lax' },
      { name: 'HSID', value: 'v2', domain: '.google.com', path: '/', expires: -1, secure: true, httpOnly: true },
      { name: 'flow', value: 'v3', domain: 'flow.google.com', path: '/', secure: false, httpOnly: false, sameSite: 'None' }
    ];
    const built = await cookiesDb.buildCookiesDbBuffer(sample);
    eq('U-DB all cookies were written', built.rows.length, 3);
    const back = await cookiesDb.readCookiesDbRows(built.buffer);
    eq('U-DB the read-back row count matches', back.length, 3);
    const sid = back.find(r => r.name === 'SID');
    eq('U-DB expires converts to the Chrome epoch', sid && sid.expires_utc, Math.round((1893456000 + 11644473600) * 1000000));
    eq('U-DB a persistent cookie has_expires=1', sid && sid.has_expires, 1);
    eq('U-DB Lax maps to samesite 1', sid && sid.samesite, 1);
    const hsid = back.find(r => r.name === 'HSID');
    eq('U-DB a session cookie has expires_utc 0', hsid && hsid.expires_utc, 0);
    eq('U-DB a session cookie is not persistent', hsid && hsid.is_persistent, 0);
    eq('U-DB a nameless or domainless cookie is dropped', cookiesDb.cookieRowFor({ name: 'X', value: '1' }), null);
    eq('U-DB samesite mapping', JSON.stringify([cookiesDb.sameSiteDbValue('None'), cookiesDb.sameSiteDbValue('Lax'), cookiesDb.sameSiteDbValue('Strict'), cookiesDb.sameSiteDbValue('x')]), JSON.stringify([0, 1, 2, -1]));
    const fsx = require('fs');
    const osx = require('os');
    const pathx = require('path');
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'fs-u-db-'));
    const wrote = await cookiesDb.buildCookiesDbFile(sample, null, dir);
    ok('U-DB the file is written into the clone', wrote.built === true && wrote.count === 3 && fsx.existsSync(pathx.join(dir, 'Default', 'Network', 'Cookies')));
    const wrote2 = await cookiesDb.buildCookiesDbFile(sample, { cookiesRel: 'Default/Cookies' }, dir);
    ok('U-DB a scan cookiesRel is honoured', wrote2.built === true && fsx.existsSync(pathx.join(dir, 'Default', 'Cookies')));
    const empty = await cookiesDb.buildCookiesDbFile([], null, dir);
    eq('U-DB no cookies means not built', empty.built, false);
    fsx.rmSync(dir, { recursive: true, force: true });
  }
  {
    // (h) probe sabr — jaali page: sign-in deewaar
    // do nazar, reload ke baad prompt box.
    const eng = new FlowAutomationEngine({ onLog: () => {} });
    const snaps = [
      { url: 'https://flow.google.com/', hasSignIn: true },
      { url: 'https://flow.google.com/', hasSignIn: true },
      { url: 'https://flow.google.com/', hasPromptBox: true }
    ];
    let evals = 0;
    let reloads = 0;
    eng._headlessReadProbeDom = async () => snaps[Math.min(evals++, snaps.length - 1)];
    const page = {
      async goto() {},
      async reload() { reloads++; },
      async waitForNetworkIdle() {}
    };
    const snap = await eng._headlessProbeSnapshot(page);
    ok('U-PROBE-PATIENCE the third look (after one reload) finds the session', !!snap && snap.hasPromptBox === true);
    eq('U-PROBE-PATIENCE exactly one reload happened', reloads, 1);
    const eng2 = new FlowAutomationEngine({ onLog: () => {} });
    let evals2 = 0;
    let reloads2 = 0;
    eng2._headlessReadProbeDom = async () => { evals2++; return { url: 'https://flow.google.com/', hasCaptcha: true }; };
    const snap2 = await eng2._headlessProbeSnapshot({ async goto() {}, async reload() { reloads2++; }, async waitForNetworkIdle() {} });
    ok('U-PROBE-PATIENCE blocked returns immediately', !!snap2 && snap2.hasCaptcha === true && reloads2 === 0 && evals2 === 1);
  }
  {
    // (i) segment kunji + assembly + cache nazar
    const U1 = 'https://rr1---sn-a.googlevideo.com/videoplayback?expire=111&id=seg1&itag=18';
    const U2 = 'https://rr2---sn-b.googlevideo.com/videoplayback?expire=222&id=seg1&itag=18&range=500000-999999';
    eq('U-SEG the same id on another host shares the key', segmentKeyOf(U1), segmentKeyOf(U2));
    ok('U-SEG a different id is a different stream', segmentKeyOf(U1) !== segmentKeyOf(U1.replace('id=seg1', 'id=seg2')));
    eq('U-SEG no id means no key', segmentKeyOf('https://rr1---sn-a.googlevideo.com/videoplayback?itag=18'), null);
    eq('U-SEG a non-googlevideo url has no key', segmentKeyOf('https://lh3.googleusercontent.com/x'), null);
    const notes = [];
    const nc = new NetworkCapture({ onSegmentNote: (i) => notes.push(i) });
    nc.arm();
    nc._recordMainpageSighting({ url: U1, src: 'googlevideo', declared: 500000, status: 206, contentRange: 'bytes 0-499999/1000000', contentType: 'video/mp4' }, mp4Buffer(500000), 500000, Date.now());
    nc._recordMainpageSighting({ url: U2, src: 'googlevideo', declared: 500000, status: 206, contentRange: 'bytes 500000-999999/1000000', contentType: 'video/mp4' }, Buffer.alloc(500000, 0x07), 500000, Date.now());
    eq('U-SEG the group note fired once with urls=2', notes.length === 1 && notes[0].urls, 2);
    const heldU = nc.mainpageBodyForUrl(U1);
    eq('U-SEG the union assembles across both urls', heldU && heldU.buffer.length, 1000000);
    ok('U-SEG the seam bytes join correctly', !!heldU && heldU.buffer[499999] === 0 && heldU.buffer[500000] === 0x07);
    // item 3: cache se aayi nazar — entry par nishan
    // + store aam raste se hi (stored=yes).
    const nc2 = new NetworkCapture({});
    nc2.arm();
    const UC = 'https://rr3---sn-c.googlevideo.com/videoplayback?expire=999&id=cache1&itag=18';
    nc2._recordMainpageSighting({ url: UC, src: 'googlevideo', declared: 600000, status: 200, contentRange: '', contentType: 'video/mp4', fromCache: true }, mp4Buffer(600000), 600000, Date.now());
    const eC = nc2.mainpageEntries().find(x => x.url === UC);
    eq('U-CACHE a cache-served sighting is marked fromCache', eC && eC.fromCache, true);
    eq('U-CACHE a cache-served body is stored like any other', eC && eC.bodyStored, 'yes');
  }
  {
    // (j) attempt-summary — khalis
    // v2.48.52 (PIN BADLA, jaan-boojh kar): line me
    // ab netload=<saved|error|rejected|-> bhi hai
    // (Route 1A ka anjaam isi ek line me).
    eq('U-SUMMARY the line formats fully', attemptSummaryLogLine({ task: 2, best: 1197606, assembled: 214591, mediaTile: 'ended', mediaHidden: undefined, probe: 'logged-out', race: null, saved: false }),
      '[ROOT] attempt-summary task=2 best=1197606 assembled=214591 mediaTile=ended mediaHidden=- probe=logged-out race=- netload=- saved=no');
    eq('U-SUMMARY garbage is safe', attemptSummaryLogLine(null),
      '[ROOT] attempt-summary task=0 best=0 assembled=0 mediaTile=- mediaHidden=- probe=- race=- netload=- saved=no');
  }
  {
    // (k) route-race save darwaza
    const eng = new FlowAutomationEngine({ onLog: () => {} }, {});
    const taskA = { promptIndex: 0, _raceActive: true, _raceWonBy: 'headless-harvest' };
    const rA = await eng._saveBufferForTask(taskA, '/tmp', { duration: '10s', type: 'Video' }, mp4Buffer(600000), 'https://x', 'mainpage-harvest');
    eq('U-RACE the losing route is refused', rA, false);
    eq('U-RACE the refusal reason is route-race', taskA._saveRejectedReason, 'route-race');
    const taskB = { promptIndex: 0, _raceActive: true, _raceWonBy: null };
    const rB = await eng._saveBufferForTask(taskB, '/tmp', { duration: '10s', type: 'Video' }, mp4Buffer(1000), 'https://x', 'headless-harvest');
    eq('U-RACE a quality-rejected save still fails', rB, false);
    eq('U-RACE its reason is the quality gate, not the race', taskB._saveRejectedReason, 'quality-gate');
    eq('U-RACE a failed claim is released for the other route', taskB._raceWonBy, null);
  }

  // ---------------------------------------------------------------------------
  // V. v2.48.51 — LAST PACK (owner decision 2026-11-05,
  //    ZEROCLICK18 ke baad ke teen fix):
  //   (a) sweep mode — parked row kabhi fail nahi:
  //       not-found -> pending + needs_check barkarar,
  //       failTask NAHI; restart mode ka purana
  //       (not-found -> fail) pin v2.48.57 (PROJECT-
  //       TRUTH change 4) me ULAT gaya — restart mode
  //       bhi ab park karta hai (neeche wala hissa +
  //       X57 block); account ghayab par bhi sweep
  //       park rakhta hai; sweep line me kept= (pin);
  //   (b) probe tafseel — probeBlockReason (khalis):
  //       captcha flag, pehla marker, kuch na ho to
  //       null; classify ke purane faisle bilkul
  //       waisa hi (fixtures); probe2 line format;
  //   (c) combo engine — blocked par combo chalta
  //       hai; probe2 logged-in -> headless-mode line
  //       + combo yaad; dusra task seedha combo (bare
  //       launch/probe NAHI); probe2 reject -> yaad
  //       NAHI, cached rejection dobara combo NAHI
  //       banata; cookiesdb na bane -> combo
  //       'cookiesdb-failed' par rukta hai aur engine
  //       skipped line wahi naam leti hai;
  //   (d) too-small nishani — capture: khuli khidki
  //       ka captureKey nazar par darj; pick: apni
  //       khidki ki nazar uthti hai, dusri ki NAHI,
  //       consumed dobara NAHI, null-key waqt-khidki
  //       ke andar uthti hai bahar NAHI.
  // ---------------------------------------------------------------------------
  {
    // (a) sweep mode — asal WorkerPool, jaali db +
    // jaali engine (prototype par stub).
    const { WorkerPool } = require('../engine/workerPool');
    const { dbService } = require('../engine/db');
    const savedDb = {
      getAccount: dbService.getAccount,
      failTask: dbService.failTask,
      setTaskNeedsCheck: dbService.setTaskNeedsCheck,
      getTask: dbService.getTask,
      completeTask: dbService.completeTask
    };
    const savedEng = {
      launch: FlowAutomationEngine.prototype.launchBrowserForAccount,
      open: FlowAutomationEngine.prototype.openFlowStudio,
      reconcile: FlowAutomationEngine.prototype.reconcileRecoveredTask,
      close: FlowAutomationEngine.prototype.closeBrowser,
      sweepFn: FlowAutomationEngine.prototype.scheduleDownloadWatcherSweep
    };
    const dbState = new Map();
    const failCalls = [];
    const updates = [];
    dbService.getAccount = (id) => (id === 'acc-v' ? { id: 'acc-v', name: 'V Acc', googleName: 'V Acc' } : null);
    dbService.failTask = (id) => { failCalls.push(id); const r = dbState.get(id); if (r) r.status = 'failed'; };
    dbService.setTaskNeedsCheck = (id, v) => { const r = dbState.get(id); if (r) r.needsCheck = v; };
    dbService.getTask = (id) => dbState.get(id) || null;
    dbService.completeTask = () => {};
    let reconcileResult = { found: false };
    FlowAutomationEngine.prototype.launchBrowserForAccount = async () => true;
    FlowAutomationEngine.prototype.openFlowStudio = async () => 'READY';
    FlowAutomationEngine.prototype.reconcileRecoveredTask = async () => reconcileResult;
    FlowAutomationEngine.prototype.closeBrowser = async () => {};
    FlowAutomationEngine.prototype.scheduleDownloadWatcherSweep = () => {};
    const pool = new WorkerPool({ onLog: () => {}, onTaskUpdate: (u) => updates.push(u) });
    const mkRow = (id, acc) => ({ id, assigned_account_id: acc, prompt_index: 0, prompt_text: 'v prompt', prompt_tag: '' });
    // sweep + not-found -> parked
    dbState.set('t-park-1', { status: 'pending', needsCheck: 1 });
    await pool._reconcileNeedsCheck([mkRow('t-park-1', 'acc-v')], '/tmp', {}, { sweepMode: true });
    eq('V-SWEEP a not-found parked row is never failed in sweep mode', failCalls.length, 0);
    eq('V-SWEEP the row stays pending in sweep mode', dbState.get('t-park-1').status, 'pending');
    eq('V-SWEEP needs_check is restored to parked (1)', dbState.get('t-park-1').needsCheck, 1);
    ok('V-SWEEP the UI update says pending', updates.some(u => u.taskId === 't-park-1' && u.status === 'pending'));
    // v2.48.57 (PROJECT-TRUTH change 4): restart mode +
    // not-found -> PARKED (purana fail wala pin ulta —
    // recovery ab kisi bhi mode me fail nahi karti)
    dbState.set('t-park-2', { status: 'pending', needsCheck: 1 });
    await pool._reconcileNeedsCheck([mkRow('t-park-2', 'acc-v')], '/tmp', {});
    eq('V-SWEEP restart mode no longer fails a not-found row (v2.48.57)', failCalls.length, 0);
    eq('V-SWEEP restart mode keeps needs_check parked (v2.48.57)', dbState.get('t-park-2').needsCheck, 1);
    ok('V-SWEEP restart-mode UI update says pending (v2.48.57)', updates.some(u => u.taskId === 't-park-2' && u.status === 'pending'));
    // sweep + account ghayab -> parked, fail NAHI
    failCalls.length = 0;
    dbState.set('t-park-3', { status: 'pending', needsCheck: 1 });
    await pool._reconcileNeedsCheck([mkRow('t-park-3', 'acc-gone')], '/tmp', {}, { sweepMode: true });
    eq('V-SWEEP a missing account never fails the row in sweep mode', failCalls.length, 0);
    eq('V-SWEEP the missing-account row keeps needs_check', dbState.get('t-park-3').needsCheck, 1);
    // sweep + found lekin download nahi -> parked (pehle se tha, pin)
    reconcileResult = { found: true, downloaded: false };
    dbState.set('t-park-4', { status: 'pending', needsCheck: 1 });
    await pool._reconcileNeedsCheck([mkRow('t-park-4', 'acc-v')], '/tmp', {}, { sweepMode: true });
    eq('V-SWEEP found-but-not-downloaded still parks in sweep mode', dbState.get('t-park-4').needsCheck, 1);
    eq('V-SWEEP found-but-not-downloaded is not failed either', failCalls.length, 0);
    reconcileResult = { found: false };
    // line format + bulane walon ki wiring (source pin)
    const wpSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'engine', 'workerPool.js'), 'utf8');
    ok('V-SWEEP the sweep line carries kept=', wpSrc.includes('[ROOT] resume-sweep tasks=${parked.length} saved=${saved} kept=${kept}'));
    ok('V-SWEEP the sweep caller passes sweepMode', wpSrc.includes('_reconcileNeedsCheck(parked, downloadFolder, settings, { sweepMode: true })'));
    ok('V-SWEEP the restart caller stays 3-arg', wpSrc.includes('await this._reconcileNeedsCheck(checkRows, downloadFolder, settings);'));
    // stubs wapas
    dbService.getAccount = savedDb.getAccount;
    dbService.failTask = savedDb.failTask;
    dbService.setTaskNeedsCheck = savedDb.setTaskNeedsCheck;
    dbService.getTask = savedDb.getTask;
    dbService.completeTask = savedDb.completeTask;
    FlowAutomationEngine.prototype.launchBrowserForAccount = savedEng.launch;
    FlowAutomationEngine.prototype.openFlowStudio = savedEng.open;
    FlowAutomationEngine.prototype.reconcileRecoveredTask = savedEng.reconcile;
    FlowAutomationEngine.prototype.closeBrowser = savedEng.close;
    FlowAutomationEngine.prototype.scheduleDownloadWatcherSweep = savedEng.sweepFn;
  }
  {
    // (b) probe tafseel — khalis
    eq('V-PROBE captcha is reported', JSON.stringify(headlessHarvest.probeBlockReason({ hasCaptcha: true })), JSON.stringify({ captcha: true, marker: null }));
    eq('V-PROBE the first matched marker is reported', headlessHarvest.probeBlockReason({ text: 'Sorry, unusual traffic detected. Please verify your identity' }).marker, 'unusual traffic');
    eq('V-PROBE no block sign means a null marker', headlessHarvest.probeBlockReason({ text: 'hello', hasPromptBox: true }).marker, null);
    eq('V-PROBE garbage is safe', JSON.stringify(headlessHarvest.probeBlockReason(null)), JSON.stringify({ captcha: false, marker: null }));
    eq('V-PROBE classify captcha stays blocked', headlessHarvest.classifyProbeSnapshot({ hasCaptcha: true }), 'blocked');
    eq('V-PROBE classify marker text stays blocked', headlessHarvest.classifyProbeSnapshot({ text: 'Please verify your identity to continue' }), 'blocked');
    eq('V-PROBE classify sign-in stays logged-out', headlessHarvest.classifyProbeSnapshot({ url: 'https://flow.google.com/', hasSignIn: true }), 'logged-out');
    eq('V-PROBE classify prompt box stays logged-in', headlessHarvest.classifyProbeSnapshot({ url: 'https://flow.google.com/', hasPromptBox: true }), 'logged-in');
    eq('V-PROBE classify google accounts url stays logged-out', headlessHarvest.classifyProbeSnapshot({ url: 'https://accounts.google.com/ServiceLogin' }), 'logged-out');
    eq('V-PROBE classify empty stays logged-out', headlessHarvest.classifyProbeSnapshot({}), 'logged-out');
    eq('V-PROBE the probe2 line formats with detail', headlessHarvest.probe2LogLine({ state: 'blocked', hasCaptcha: false, marker: 'unusual traffic' }), '[ROOT] headless-probe2 state=blocked via=clone-inject captcha=false marker=unusual traffic');
    eq('V-PROBE the probe2 line uses - when there is no marker', headlessHarvest.probe2LogLine({ state: 'logged-in' }), '[ROOT] headless-probe2 state=logged-in via=clone-inject captcha=false marker=-');
    eq('V-PROBE the probe line carries captcha and marker', headlessHarvest.probeLogLine({ state: 'blocked', account: 'a', url: 'https://flow.google.com/', hasSignIn: true, hasCaptcha: true, marker: 'unusual traffic' }), '[ROOT] headless-probe state=blocked account=a url=flow.google.com/ signIn=true avatar=false promptBox=false captcha=true marker=unusual traffic');
  }
  {
    // (c1) blocked probe -> combo -> probe2
    // logged-in: jeet + mode line + yaad set.
    // (c2) dusra task seedha combo (bare launch /
    // probe dobara NAHI).
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { headlessHarvestWaitMs: 2000 });
    eng.currentAccount = { id: 'acc-v-combo', name: 'V Combo' };
    eng.page = fakePage('main-v-combo');
    const st = stubHeadlessSession(eng, {
      snapshot: { url: 'https://flow.google.com/', text: 'We detected unusual traffic from your network', hasSignIn: true }
    });
    const rawLaunch = eng._headlessLaunch;
    eng._headlessLaunch = async () => { const s = await rawLaunch(); s.via = 'cdp'; s.liveCookies = [{ name: 'SID', value: 'x', domain: '.google.com', path: '/' }]; return s; };
    const comboCap = {
      harvestFloorBytes: 0,
      harvestForKey: () => ({ url: FC_FRESH, buffer: mp4Buffer(600000), at: Date.now() }),
      urlForKey: () => null,
      recentFlowContentVideos: () => [],
      beginSubmission() {}, arm() {}, setDownloadAttempt() {}, clearDownloadAttempt() {},
      evictHarvest() {}, claimFlowContentVideo() {}, detach() {}
    };
    let comboCalls = 0;
    eng._headlessComboSession = async () => {
      comboCalls++;
      eng._lastHeadlessProbeSnap = { url: 'https://flow.google.com/', hasPromptBox: true };
      return { session: { browser: { close: async () => {} }, page: fakePage('combo-v1'), capture: comboCap, cloneDir: null, via: 'cdp' }, verdict: 'logged-in' };
    };
    eng._headlessReadLiveCookies = async () => [{ name: 'SID', value: 'x', domain: '.google.com', path: '/' }];
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const task1 = { promptIndex: 0, captureKey: 'k-v-combo-1', videoId: 'k-v-combo-1', startTime: Date.now() - 1000, renderCompletedAt: Date.now() - 500 };
    const r1 = await eng._tryHeadlessHarvest(task1, '/tmp', { duration: '10s' }, [], 'k-v-combo-1', 0);
    eq('V-COMBO a blocked probe still reaches the combo and saves', r1, true);
    eq('V-COMBO the combo ran exactly once', comboCalls, 1);
    ok('V-COMBO the probe line says blocked with the marker', logs.some(m => m.includes('[ROOT] headless-probe state=blocked account=V Combo') && m.includes('marker=unusual traffic')));
    ok('V-COMBO the probe2 line is logged with detail', logs.some(m => m.includes('[ROOT] headless-probe2 state=logged-in via=clone-inject captcha=false marker=-')));
    ok('V-COMBO the headless-mode memory line is logged once', logs.filter(m => m.includes('[ROOT] headless-mode account=V Combo mode=clone-inject (probe2)')).length === 1);
    eq('V-COMBO the combo memory holds the account', eng._headlessComboAccounts.has('acc-v-combo'), true);
    const task2 = { promptIndex: 1, captureKey: 'k-v-combo-2', videoId: 'k-v-combo-2', startTime: Date.now() - 1000, renderCompletedAt: Date.now() - 500 };
    const r2 = await eng._tryHeadlessHarvest(task2, '/tmp', { duration: '10s' }, [], 'k-v-combo-2', 0);
    eq('V-COMBO the second task saves through the remembered combo', r2, true);
    eq('V-COMBO the bare launch never ran again', st.launchCount, 1);
    eq('V-COMBO the bare probe never ran again', st.probeCount, 1);
    eq('V-COMBO the combo rebuilt for the second task', comboCalls, 2);
    eq('V-COMBO the memory line still appears only once', logs.filter(m => m.includes('[ROOT] headless-mode account=V Combo mode=clone-inject (probe2)')).length, 1);
  }
  {
    // (c3) probe2 reject — yaad NAHI banti, cached
    // rejection par dusra task combo NAHI banata.
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { headlessHarvestWaitMs: 300 });
    eng.currentAccount = { id: 'acc-v-rej', name: 'V Rej' };
    eng.page = fakePage('main-v-rej');
    const st = stubHeadlessSession(eng, { snapshot: { url: 'https://accounts.google.com/ServiceLogin', hasSignIn: true } });
    const rawLaunch = eng._headlessLaunch;
    eng._headlessLaunch = async () => { const s = await rawLaunch(); s.via = 'cdp'; s.liveCookies = [{ name: 'SID', value: 'x' }]; return s; };
    let comboCalls = 0;
    eng._headlessComboSession = async () => {
      comboCalls++;
      eng._lastHeadlessProbeSnap = { url: 'https://flow.google.com/', hasSignIn: true };
      return { session: { browser: { close: async () => {} }, page: fakePage('combo-vrej'), capture: { harvestFloorBytes: 0, beginSubmission() {}, setDownloadAttempt() {}, clearDownloadAttempt() {}, evictHarvest() {}, claimFlowContentVideo() {}, detach() {} }, cloneDir: null, via: 'cdp' }, verdict: 'logged-out' };
    };
    const t1 = { promptIndex: 0, captureKey: 'k-v-rej-1', videoId: 'k-v-rej-1', startTime: Date.now(), renderCompletedAt: Date.now() };
    const a1 = [];
    const r1 = await eng._tryHeadlessHarvest(t1, '/tmp', { duration: '10s' }, a1, 'k-v-rej-1', 0);
    eq('V-COMBO a rejected probe2 fails the route', r1, false);
    eq('V-COMBO the note is the pinned reject text', a1.length === 1 && a1[0].note, headlessHarvest.PROBE_REJECT_NOTE);
    eq('V-COMBO no memory is set on a probe2 rejection', eng._headlessComboAccounts.has('acc-v-rej'), false);
    ok('V-COMBO no headless-mode line on rejection', !logs.some(m => m.includes('headless-mode account=')));
    const t2 = { promptIndex: 1, captureKey: 'k-v-rej-2', videoId: 'k-v-rej-2', startTime: Date.now(), renderCompletedAt: Date.now() };
    const a2 = [];
    const r2 = await eng._tryHeadlessHarvest(t2, '/tmp', { duration: '10s' }, a2, 'k-v-rej-2', 0);
    eq('V-COMBO the second task fails from the cached rejection', r2, false);
    eq('V-COMBO the combo is not rebuilt after a rejection', comboCalls, 1);
    eq('V-COMBO no second launch after a rejection', st.launchCount, 1);
  }
  {
    // (c4) cookiesdb — asal _headlessComboSession:
    // saari cookies bekaar (domain hi nahi) -> DB
    // banti hi nahi -> combo 'cookiesdb-failed'.
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, {});
    const { getAccountProfilePath } = require('../engine/accountStore');
    const profPath = getAccountProfilePath('acc_v_nodb');
    const res = await eng._headlessComboSession({ id: 'acc_v_nodb', name: 'V NoDb' }, { liveCookies: [{ name: 'X', value: '1' }] });
    eq('V-DB an unbuildable cookies DB fails the combo as cookiesdb-failed', res && res.reason, 'cookiesdb-failed');
    ok('V-DB no cookiesdb built line appears', !logs.some(m => m.includes('headless-cookiesdb built')));
    try { require('fs').rmSync(profPath, { recursive: true, force: true }); } catch (e) {}
    // (c5) engine taraf skipped line wahi naam leti hai
    const logs2 = [];
    const eng2 = new FlowAutomationEngine({ onLog: (e) => logs2.push(e.message) }, { headlessHarvestWaitMs: 300 });
    eng2.currentAccount = { id: 'acc-v-skip', name: 'V Skip' };
    eng2.page = fakePage('main-v-skip');
    stubHeadlessSession(eng2, { snapshot: { url: 'https://flow.google.com/', hasSignIn: true } });
    const rawLaunch2 = eng2._headlessLaunch;
    eng2._headlessLaunch = async () => { const s = await rawLaunch2(); s.via = 'cdp'; return s; };
    eng2._headlessComboSession = async () => ({ reason: 'cookiesdb-failed' });
    const t = { promptIndex: 0, captureKey: 'k-v-skip', videoId: 'k-v-skip', startTime: Date.now(), renderCompletedAt: Date.now() };
    const at = [];
    const r = await eng2._tryHeadlessHarvest(t, '/tmp', { duration: '10s' }, at, 'k-v-skip', 0);
    eq('V-DB a cookiesdb-failed combo fails the route as rejected', r, false);
    ok('V-DB the skipped line names cookiesdb-failed', logs2.some(m => m.includes('[ROOT] headless-combo skipped reason=cookiesdb-failed')));
  }
  {
    // (d) too-small nishani — capture + pick
    const nc = new NetworkCapture({});
    nc.arm();
    const T0 = 1800000000000;
    nc.mainpageNoteWindow('key-a', T0);
    const GV_A = 'https://rr5---sn-a.googlevideo.com/videoplayback?expire=999&id=att-a&itag=18';
    nc._recordMainpageSighting({ url: GV_A, src: 'googlevideo', declared: 85725, status: 206, contentRange: 'bytes 0-85724/85725', contentType: 'video/mp4' }, mp4Buffer(85725), 85725, T0 + 1000);
    let mem = nc.mainpageTooSmallSightings();
    eq('V-ATTR a sighting inside an open window carries its captureKey', mem.length === 1 && mem[0].captureKey, 'key-a');
    nc.mainpageNoteWindow('key-b', T0 + 10000);
    const GV_B = 'https://rr5---sn-b.googlevideo.com/videoplayback?expire=999&id=att-b&itag=18';
    nc._recordMainpageSighting({ url: GV_B, src: 'googlevideo', declared: 85725, status: 206, contentRange: 'bytes 0-85724/85725', contentType: 'video/mp4' }, mp4Buffer(85725), 85725, T0 + 11000);
    mem = nc.mainpageTooSmallSightings();
    eq('V-ATTR a later sighting belongs to the newest open window', (mem.find(m => m.url === GV_B) || {}).captureKey, 'key-b');
    const nc2 = new NetworkCapture({});
    nc2.arm();
    const GV_N = 'https://rr5---sn-n.googlevideo.com/videoplayback?expire=999&id=att-n&itag=18';
    nc2._recordMainpageSighting({ url: GV_N, src: 'googlevideo', declared: 85725, status: 206, contentRange: 'bytes 0-85724/85725', contentType: 'video/mp4' }, mp4Buffer(85725), 85725, T0);
    eq('V-ATTR no open window means a null captureKey', nc2.mainpageTooSmallSightings()[0].captureKey, null);
    const sight = (url, captureKey, firstSeenAt, consumedBy) => ({ url, src: 'googlevideo', reason: 'stream-too-small', firstSeenAt, captureKey: captureKey || null, consumedBy: consumedBy || null });
    const own = mainpageTooSmallMediaPick({ sightings: [sight(GV_A, 'key-a', T0 + 1000)], taskStart: T0 - 5000, teacherUrl: null, triedUrls: new Set(), captureKey: 'key-a', renderDoneAt: T0, attemptDeadline: T0 + 60000 });
    eq('V-ATTR the own-window sighting is picked', own && own.url, GV_A);
    const other = mainpageTooSmallMediaPick({ sightings: [sight(GV_A, 'key-a', T0 + 1000)], taskStart: T0 - 5000, teacherUrl: null, triedUrls: new Set(), captureKey: 'key-b', renderDoneAt: T0 + 10000, attemptDeadline: T0 + 70000 });
    eq('V-ATTR another task sighting is not picked', other, null);
    const consumed = mainpageTooSmallMediaPick({ sightings: [sight(GV_A, 'key-a', T0 + 1000, 'key-a')], taskStart: T0 - 5000, teacherUrl: null, triedUrls: new Set(), captureKey: 'key-b', renderDoneAt: T0 + 10000, attemptDeadline: T0 + 70000 });
    eq('V-ATTR a consumed sighting is not re-picked for another task', consumed, null);
    const nullIn = mainpageTooSmallMediaPick({ sightings: [sight(GV_N, null, T0 + 2000)], taskStart: T0 - 5000, teacherUrl: null, triedUrls: new Set(), captureKey: 'key-b', renderDoneAt: T0, attemptDeadline: T0 + 60000 });
    eq('V-ATTR a null-key sighting inside the time window is picked', nullIn && nullIn.url, GV_N);
    const nullOut = mainpageTooSmallMediaPick({ sightings: [sight(GV_N, null, T0 - 20000)], taskStart: T0 - 60000, teacherUrl: null, triedUrls: new Set(), captureKey: 'key-b', renderDoneAt: T0, attemptDeadline: T0 + 60000 });
    eq('V-ATTR a null-key sighting before the time window is not picked', nullOut, null);
    nc.mainpageMarkTooSmallConsumed(GV_A, 'key-a');
    eq('V-ATTR the consumed mark lands on the sighting', (nc.mainpageTooSmallSightings().find(m => m.url === GV_A) || {}).consumedBy, 'key-a');
  }

  // ---------------------------------------------------------------------------
  // W. v2.48.52 — ROUTE 1A PACK (Gemini wala rasta):
  //   (a) rangeStripOf — range/rn/rbuf saaf, tartib
  //       barkarar, kharab URL mehfooz;
  //   (b) drainNetloadStream — IO.read ka poora
  //       drain (base64 + raw, EOF, kharab hisaab);
  //   (c) mainpageKnownTotalOf — kul size ke usool
  //       (CR jeet-ta hai, 206 par declared nazar-
  //       andaaz);
  //   (d) darwaza (gate) — bytes wala naya usool;
  //   (e) netload [ROOT] lines + summary ka
  //       netload= hissa — khalis;
  //   (f) ENGINE: netload kamyab → save seedha usi
  //       buffer par, media/fetch ZERO; protocol
  //       nakami → purani silsila (media) chalti hai
  //       aur wahi URL dobara netload NAHI hota;
  //       budget 2 ke baad khamoshi; success=false
  //       par per-attempt error line;
  //   (g) faisla (verdict) partial ke teen roop —
  //       206 + bytes==kul → POORA (bina fetch ke
  //       save), 206 + bytes<kul → fetch-full wala
  //       rawaiya, kul na maloom → .51 jaisa hi;
  //   (h) ENGINE too-small rasta: netload pehle —
  //       jeet to fetch/media ZERO ke saath save;
  //   (i) ROUTE 1B (fetchRwRewrite + capture ka
  //       Fetch-domain hisaab): rewrite durust,
  //       continue EK dafa, nakami par khud-band
  //       (self-disable) + ek khabar.
  // ---------------------------------------------------------------------------
  {
    // (a) range saaf — khalis
    const rs1 = rangeStripOf('https://rr1---sn-x.googlevideo.com/videoplayback?expire=999&id=a&range=0-100&itag=18');
    eq('W-STRIP range param is removed', rs1.url.includes('range='), false);
    ok('W-STRIP the other params keep their order', rs1.url.includes('expire=999&id=a&itag=18'));
    eq('W-STRIP stripped names the param', JSON.stringify(rs1.stripped), JSON.stringify(['range']));
    const rs2 = rangeStripOf('https://rr1---sn-x.googlevideo.com/videoplayback?id=a&rn=5&rbuf=9&itag=18');
    eq('W-STRIP rn and rbuf are removed too', JSON.stringify(rs2.stripped), JSON.stringify(['rn', 'rbuf']));
    eq('W-STRIP rn/rbuf leave no trace', rs2.url.includes('rn=') || rs2.url.includes('rbuf='), false);
    const plain = 'https://rr1---sn-x.googlevideo.com/videoplayback?expire=999&id=a&itag=18';
    const rs3 = rangeStripOf(plain);
    eq('W-STRIP no range params means the url is untouched', rs3.url, plain);
    eq('W-STRIP no range params means stripped is empty', rs3.stripped.length, 0);
    eq('W-STRIP a garbage url is returned as-is', rangeStripOf('not a url').url, 'not a url');
    eq('W-STRIP a null url is safe', rangeStripOf(null).url, null);
  }
  {
    // (b) IO drain — khalis
    const sendChunks = (reads) => {
      let i = 0;
      return async (method, params) => {
        if (method !== 'IO.read') return {};
        const r = reads[i++];
        if (r instanceof Error) throw r;
        return r;
      };
    };
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const d1 = await drainNetloadStream(sendChunks([
      { data: b64('hello '), base64Encoded: true, eof: false },
      { data: b64('world'), base64Encoded: true, eof: true }
    ]), 'h1');
    eq('W-DRAIN base64 chunks join in order', d1 && d1.toString('utf8'), 'hello world');
    const d2 = await drainNetloadStream(sendChunks([
      { data: 'ab', base64Encoded: false, eof: false },
      { data: 'cd', eof: true }
    ]), 'h1');
    eq('W-DRAIN raw chunks join in order', d2 && d2.toString('utf8'), 'abcd');
    const d3 = await drainNetloadStream(sendChunks([
      { data: b64('one-shot'), base64Encoded: true, eof: true }
    ]), 'h1');
    eq('W-DRAIN data and eof in one read still count', d3 && d3.toString('utf8'), 'one-shot');
    eq('W-DRAIN empty data without eof is a broken stream', await drainNetloadStream(sendChunks([{ data: '', base64Encoded: true, eof: false }]), 'h1'), null);
    eq('W-DRAIN a throwing read is a broken stream', await drainNetloadStream(sendChunks([new Error('io gone')]), 'h1'), null);
    eq('W-DRAIN a missing handle is a broken stream', await drainNetloadStream(sendChunks([]), null), null);
  }
  {
    // (c) kul size ke usool — khalis
    eq('W-TOTAL the recorded total wins', mainpageKnownTotalOf({ knownTotal: 1193958, contentRange: 'bytes 0-1/500', status: 206 }), 1193958);
    eq('W-TOTAL content-range gives the total', mainpageKnownTotalOf({ contentRange: 'bytes 0-210942/1193958', status: 206 }), 1193958);
    eq('W-TOTAL declared counts on a 200', mainpageKnownTotalOf({ declaredLength: 600000, status: 200 }), 600000);
    eq('W-TOTAL declared is ignored on a 206 without a range total', mainpageKnownTotalOf({ declaredLength: 224692, status: 206, contentRange: '' }), null);
    eq('W-TOTAL nothing known is null', mainpageKnownTotalOf({}), null);
    eq('W-TOTAL garbage is null', mainpageKnownTotalOf(null), null);
  }
  {
    // (d) darwaza — bytes wala usool
    eq('W-GATE small bytes with a big known total still pass', mainpageCandidateGate({ knownTotal: 1193958, bytes: 210943, src: 'googlevideo', contentType: 'video/mp4' }).candidate, true);
    const gSmall = mainpageCandidateGate({ knownTotal: null, bytes: 95816, src: 'googlevideo', contentType: 'video/mp4' });
    eq('W-GATE unknown total with small bytes is refused (.52)', gSmall.candidate, false);
    eq('W-GATE unknown total with small bytes says stream-too-small', gSmall.reason, 'stream-too-small');
    eq('W-GATE the bytes rule does not touch flow-content', mainpageCandidateGate({ knownTotal: null, bytes: 95816, src: 'flow-content', contentType: 'video/mp4' }).candidate, true);
    eq('W-GATE no bytes input keeps the legacy pass', mainpageCandidateGate({ knownTotal: null, src: 'googlevideo', contentType: 'video/mp4' }).candidate, true);
    eq('W-GATE small bytes with a small total stays too-small', mainpageCandidateGate({ knownTotal: 87478, bytes: 87478, src: 'googlevideo', contentType: 'video/mp4' }).reason, 'stream-too-small');
    eq('W-GATE a non-video type still says not-video-candidate', mainpageCandidateGate({ knownTotal: null, bytes: 95816, src: 'googlevideo', contentType: 'text/html' }).reason, 'not-video-candidate');
  }
  {
    // (e) netload lines + summary hissa — khalis
    eq('W-LINE the saved line formats fully', netloadLogLine({ host: 'rr5---sn-x.googlevideo.com', stripped: 'range', status: 200, bytes: 1193958, result: 'saved' }),
      '[ROOT] mainpage-netload host=rr5---sn-x.googlevideo.com stripped=range status=200 bytes=1193958 result=saved');
    eq('W-LINE a rejected line carries the short reason', netloadLogLine({ host: 'rr5---sn-x.googlevideo.com', stripped: 'none', status: 206, bytes: 500, result: 'rejected:partial' }),
      '[ROOT] mainpage-netload host=rr5---sn-x.googlevideo.com stripped=none status=206 bytes=500 result=rejected:partial');
    eq('W-LINE garbage is safe', netloadLogLine(null),
      '[ROOT] mainpage-netload host=- stripped=none status=- bytes=0 result=error');
    const failLine = netloadFailedLogLine({ host: 'rr5---sn-x.googlevideo.com', err: 'Protocol error\n(Network.loadNetworkResource):   ' + 'x'.repeat(300) });
    ok('W-LINE the failed line collapses whitespace', !failLine.includes('\n') && failLine.startsWith('[ROOT] mainpage-netload failed host=rr5---sn-x.googlevideo.com err=Protocol error (Network.loadNetworkResource): '));
    ok('W-LINE the failed line caps the message at 120 chars', failLine.split(' err=')[1].length <= 120);
    ok('W-LINE the summary carries a saved netload', attemptSummaryLogLine({ task: 1, netload: 'saved', saved: true }).includes('netload=saved'));
    ok('W-LINE the summary carries an error netload', attemptSummaryLogLine({ task: 1, netload: 'error', saved: false }).includes('netload=error'));
    eq('W-LINE a bogus summary netload becomes a dash', attemptSummaryLogLine({ task: 1, netload: 'bogus', saved: false }).includes('netload=-'), true);
  }
  // (f)/(g)/(h) ke jaali karagar — netload wala CDP session
  function fakeNetloadSession(opts = {}) {
    const chunks = opts.chunks || [];
    let readIdx = 0;
    const client = {
      handlers: {},
      sent: [],
      detached: false,
      on(ev, fn) { client.handlers[ev] = fn; },
      async send(method, params) {
        client.sent.push({ method, params });
        if (method === 'Network.loadNetworkResource') {
          if (opts.loadError) throw new Error(opts.loadError);
          if (opts.noResource) return {};
          return { resource: { success: opts.success !== false, httpStatusCode: opts.status || 200, stream: 'stream-1', netErrorName: opts.netErrorName } };
        }
        if (method === 'IO.read') {
          const c = chunks[readIdx++];
          if (!c) return { data: '', base64Encoded: true, eof: true };
          return { data: c.toString('base64'), base64Encoded: true, eof: readIdx >= chunks.length };
        }
        return {};
      },
      async detach() { client.detached = true; }
    };
    return client;
  }
  const mkCtxW = () => ({ captureKey: 'k-w', bindReason: 'bound', floorBytes: 200 * 1024, teacherUrl: null, teacherHash: null, timingBucket: () => 'download-attempt', gapSec: () => '0.5' });
  {
    // (f1) netload kamyab → save usi buffer par
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, {});
    const fullBuf = mp4Buffer(1193958); fullBuf[300] = 0x51;
    const third = Math.floor(fullBuf.length / 3);
    const session = fakeNetloadSession({ chunks: [fullBuf.subarray(0, third), fullBuf.subarray(third, third * 2), fullBuf.subarray(third * 2)], status: 200 });
    const page = fakePage('main-w-netload', { cdpClient: session });
    page.mainFrame = () => ({ _id: 'frame-1' });
    eng.page = page;
    let mediaCalls = 0;
    let fetchCalls = 0;
    let savedBuf = null;
    eng._loadMainpageFullViaMedia = async () => { mediaCalls++; return null; };
    eng._fetchMainpageFullInPage = async () => { fetchCalls++; return null; };
    eng._saveBufferForTask = async (t, folder, settings, buf) => { savedBuf = buf; t.mediaSaved = true; return true; };
    const W_URL = 'https://rr2---sn-abc123.googlevideo.com/videoplayback?expire=999&id=xyz&itag=18&range=0-210942';
    const task = { promptIndex: 0, _mpNetloadCount: 0, _mpNetloadProtoFailed: new Set(), _mpNetloadOutcome: null };
    const entry = { url: W_URL, src: 'googlevideo', partial: true, status: 206, contentRange: 'bytes 0-210942/1193958', declaredLength: 210943, knownTotal: 1193958 };
    const kind = await eng._mainpageCompleteCandidate(task, '/tmp', { duration: '10s' }, [], entry, mkCtxW());
    eq('W-NET a netload completion saves', kind, 'saved');
    ok('W-NET the saved buffer is the exact drained stream', !!savedBuf && savedBuf.equals(fullBuf));
    eq('W-NET media-load never ran', mediaCalls, 0);
    eq('W-NET in-page fetch never ran', fetchCalls, 0);
    ok('W-NET the netload line reports the save', logs.some(m => m === '[ROOT] mainpage-netload host=rr2---sn-abc123.googlevideo.com stripped=range status=200 bytes=1193958 result=saved'));
    const loadCall = session.sent.find(s => s.method === 'Network.loadNetworkResource');
    ok('W-NET the loaded url had its range stripped', !!loadCall && !loadCall.params.url.includes('range=') && loadCall.params.url.includes('id=xyz'));
    ok('W-NET the load asked for credentials on the main frame', !!loadCall && loadCall.params.frameId === 'frame-1' && loadCall.params.options.includeCredentials === true && loadCall.params.options.disableCache === true);
    eq('W-NET the task outcome is saved for the summary', task._mpNetloadOutcome, 'saved');
  }
  {
    // (f2) protocol nakami → purani silsila + dobara nahi
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, {});
    const session = fakeNetloadSession({ loadError: 'Protocol error (Network.loadNetworkResource): Not supported' });
    const page = fakePage('main-w-netfail', { cdpClient: session });
    page.mainFrame = () => ({ _id: 'frame-1' });
    eng.page = page;
    const fullBuf = mp4Buffer(600000); fullBuf[300] = 0x52;
    let mediaCalls = 0;
    eng._loadMainpageFullViaMedia = async () => { mediaCalls++; return { buf: fullBuf, status: 200 }; };
    eng._fetchMainpageFullInPage = async () => null;
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const task = { promptIndex: 0, _mpNetloadCount: 0, _mpNetloadProtoFailed: new Set(), _mpNetloadOutcome: null };
    const mkE = () => ({ url: GV_URL, src: 'googlevideo', partial: true, status: 206, contentRange: '', declaredLength: 0 });
    const kind1 = await eng._mainpageCompleteCandidate(task, '/tmp', { duration: '10s' }, [], mkE(), mkCtxW());
    eq('W-FALL a protocol failure still saves via the legacy chain', kind1, 'saved');
    eq('W-FALL media-load ran as the fallback', mediaCalls, 1);
    ok('W-FALL the failed line names the protocol error', logs.some(m => m.includes('[ROOT] mainpage-netload failed host=rr2---sn-abc123.googlevideo.com err=Protocol error (Network.loadNetworkResource): Not supported')));
    // summary ka netload= hissa SIRF 1A ka anjaam
    // hai — purani silsile ki jeet use 'saved' nahi
    // banati (jeet saved=yes + via line se dikhti
    // hai); 1A ka sach yahan 'error' hi hai.
    eq('W-FALL the task outcome keeps the netload error (the save was the legacy chain)', task._mpNetloadOutcome, 'error');
    const kind2 = await eng._mainpageCompleteCandidate(task, '/tmp', { duration: '10s' }, [], mkE(), mkCtxW());
    eq('W-FALL the retry still completes via media', kind2, 'saved');
    eq('W-FALL the protocol-failed url is never netloaded twice in one attempt', session.sent.filter(s => s.method === 'Network.loadNetworkResource').length, 1);
  }
  {
    // (f3) budget + success=false
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, {});
    const session = fakeNetloadSession({ success: false, status: 0, netErrorName: 'net::ERR_FAILED' });
    const page = fakePage('main-w-budget', { cdpClient: session });
    page.mainFrame = () => ({ _id: 'frame-1' });
    eng.page = page;
    const taskFull = { promptIndex: 0, _mpNetloadCount: 2, _mpNetloadProtoFailed: new Set(), _mpNetloadOutcome: null };
    eq('W-BUDGET a spent budget loads nothing', await eng._netloadMainpageFull(taskFull, GV_URL), null);
    eq('W-BUDGET a spent budget sends nothing', session.sent.filter(s => s.method === 'Network.loadNetworkResource').length, 0);
    const task = { promptIndex: 0, _mpNetloadCount: 0, _mpNetloadProtoFailed: new Set(), _mpNetloadOutcome: null };
    eq('W-BUDGET a refused load returns null', await eng._netloadMainpageFull(task, GV_URL), null);
    ok('W-BUDGET a refused load logs the per-attempt error line', logs.some(m => m.includes('[ROOT] mainpage-netload host=rr2---sn-abc123.googlevideo.com') && m.includes('result=error:net::ERR_FAILED')));
    ok('W-BUDGET a refused url joins the protocol-failed set', task._mpNetloadProtoFailed.has(GV_URL));
    eq('W-BUDGET the outcome is error', task._mpNetloadOutcome, 'error');
  }
  {
    // (g1) 206 + rakhe bytes kul ke barabar → POORA, bina kisi fetch ke
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, {});
    const nc = eng.netCapture;
    nc.arm();
    const U206 = 'https://rr7---sn-full206.googlevideo.com/videoplayback?expire=999&id=f206&itag=18';
    const body206 = mp4Buffer(600000); body206[300] = 0x53;
    nc._recordMainpageSighting({ url: U206, src: 'googlevideo', declared: 600000, status: 206, contentRange: 'bytes 0-599999/600000', contentType: 'video/mp4' }, body206, 600000, Date.now());
    let mediaCalls = 0;
    let fetchCalls = 0;
    eng._loadMainpageFullViaMedia = async () => { mediaCalls++; return null; };
    eng._fetchMainpageFullInPage = async () => { fetchCalls++; return null; };
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const entry = { url: U206, src: 'googlevideo', partial: true, status: 206, contentRange: 'bytes 0-599999/600000', declaredLength: 600000, knownTotal: 600000 };
    const kind = await eng._mainpageCompleteCandidate({ promptIndex: 0 }, '/tmp', { duration: '10s' }, [], entry, mkCtxW());
    eq('W-VERDICT a 206 body at the full total saves as complete (.52)', kind, 'saved');
    eq('W-VERDICT no completion mechanism ran for it', mediaCalls + fetchCalls, 0);
  }
  {
    // (g2) 206 + bytes kul se kam → fetch-full wala rawaiya barkarar
    const eng = new FlowAutomationEngine({ onLog: () => {} }, {});
    let fetchCalls = 0;
    eng._loadMainpageFullViaMedia = async () => null;
    eng._fetchMainpageFullInPage = async () => { fetchCalls++; return { buf: mp4Buffer(224692), status: 206 }; };
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const entry = { url: GV_URL, src: 'googlevideo', partial: true, status: 206, contentRange: 'bytes 0-224691/1250000', declaredLength: 224692, knownTotal: 1250000 };
    const kind = await eng._mainpageCompleteCandidate({ promptIndex: 0 }, '/tmp', { duration: '10s' }, [], entry, mkCtxW());
    eq('W-VERDICT a genuinely partial body is rejected after the full-fetch remedy', kind, 'rejected');
    eq('W-VERDICT the remedy fetched (completion + one remedy fetch)', fetchCalls, 2);
  }
  {
    // (g3) kul na maloom → .51 wala rawaiya (206 = partial = fetch-full)
    const eng = new FlowAutomationEngine({ onLog: () => {} }, {});
    let fetchCalls = 0;
    eng._loadMainpageFullViaMedia = async () => null;
    eng._fetchMainpageFullInPage = async () => { fetchCalls++; return { buf: mp4Buffer(600000), status: 206 }; };
    eng._saveBufferForTask = async (t) => { t.mediaSaved = true; return true; };
    const entry = { url: GV_URL, src: 'googlevideo', partial: true, status: 206, contentRange: '', declaredLength: 0 };
    const kind = await eng._mainpageCompleteCandidate({ promptIndex: 0 }, '/tmp', { duration: '10s' }, [], entry, mkCtxW());
    eq('W-VERDICT unknown total keeps the legacy 206-is-partial rejection', kind, 'rejected');
    eq('W-VERDICT unknown total fetched like .51 (completion + remedy)', fetchCalls, 2);
  }
  {
    // (h) too-small rasta — netload pehle, fetch/media ZERO
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) }, { mainpageViewportWaitMs: 200, mainpagePatienceMs: 700, mainpageHoverGraceMs: 100, mainpagePointerGraceMs: 100 });
    const fullBuf = mp4Buffer(1250000); fullBuf[300] = 0x54;
    const session = fakeNetloadSession({ chunks: [fullBuf], status: 200 });
    const page = fakePage('main-w-ts', { cdpClient: session });
    page.mainFrame = () => ({ _id: 'frame-1' });
    eng.page = page;
    eng._readTileMediaState = async () => null;
    const nc = eng.netCapture;
    nc.arm();
    const GV_TS2 = 'https://rr5---sn-tsnet.googlevideo.com/videoplayback?expire=999&id=tsn&itag=18';
    nc._recordMainpageSighting({ url: GV_TS2, src: 'googlevideo', declared: 85725, status: 206, contentRange: 'bytes 0-85724/85725', contentType: 'video/mp4' }, mp4Buffer(85725), 85725, Date.now());
    let mediaCalls = 0;
    let fetchCalls = 0;
    let savedBuf = null;
    eng._loadMainpageFullViaMedia = async () => { mediaCalls++; return null; };
    eng._fetchMainpageFullInPage = async () => { fetchCalls++; return null; };
    eng._saveBufferForTask = async (t, folder, settings, buf) => { savedBuf = buf; t.mediaSaved = true; return true; };
    const task = { promptIndex: 0, captureKey: 'k-w-ts', videoId: 'k-w-ts', startTime: Date.now() - 3000, renderCompletedAt: Date.now() - 500 };
    const okSave = await eng._tryMainpageHarvest(task, '/tmp', { duration: '10s' }, [], 'k-w-ts', 0);
    eq('W-TS the too-small url saves via netload', okSave, true);
    eq('W-TS the saved file is the too-small url itself', task.completedVideoUrl, GV_TS2);
    ok('W-TS the saved buffer is the netload buffer', !!savedBuf && savedBuf.equals(fullBuf));
    eq('W-TS media-load never ran for it', mediaCalls, 0);
    eq('W-TS in-page fetch never ran for it', fetchCalls, 0);
    ok('W-TS the netload line reports the save', logs.some(m => m.includes('[ROOT] mainpage-netload') && m.includes('result=saved')));
  }
  {
    // (i) ROUTE 1B — rewrite khalis + capture hisaab
    const rw1 = fetchRwRewrite('https://rr1---sn-x.googlevideo.com/videoplayback?expire=999&id=a&range=0-50&itag=18', { 'User-Agent': 'UA', Range: 'bytes=0-50' });
    ok('W-RW a paused playback request is rewritten', !!rw1 && !rw1.url.includes('range=') && rw1.url.includes('id=a'));
    eq('W-RW the rewrite sets one full-range header', JSON.stringify(rw1.headers.filter(h => h.name.toLowerCase() === 'range')), JSON.stringify([{ name: 'Range', value: 'bytes=0-' }]));
    ok('W-RW the other headers survive', rw1.headers.some(h => h.name === 'User-Agent' && h.value === 'UA'));
    eq('W-RW a request already asking for everything is left alone', fetchRwRewrite('https://rr1---sn-x.googlevideo.com/videoplayback?id=a&itag=18', { range: 'bytes=0-' }), null);
    eq('W-RW a non-playback url is never rewritten', fetchRwRewrite('https://flow-content.google/video/abc?x=1', {}), null);
    const flush = () => new Promise(r => setTimeout(r, 15));
    const mkRwClient = (failOn) => {
      const client = { handlers: {}, sent: [], on(ev, fn) { client.handlers[ev] = fn; },
        async send(method, params) { client.sent.push({ method, params }); if (failOn && failOn(method)) throw new Error('boom ' + method); return {}; },
        async detach() {} };
      return client;
    };
    const disabledNotes = [];
    const capW = new NetworkCapture({ onFetchRwDisabled: (info) => disabledNotes.push(info) });
    const clientW = mkRwClient(null);
    await capW._armFetchRw(clientW);
    const enableCall = clientW.sent.find(s => s.method === 'Fetch.enable');
    ok('W-RW interception is scoped to googlevideo playback at request stage', !!enableCall && enableCall.params.patterns[0].urlPattern === '*googlevideo.com/videoplayback*' && enableCall.params.patterns[0].requestStage === 'Request');
    clientW.handlers['Fetch.requestPaused']({ requestId: 'r1', request: { url: 'https://rr1---sn-x.googlevideo.com/videoplayback?expire=999&id=a&range=0-50&itag=18', headers: { 'User-Agent': 'UA', Range: 'bytes=0-50' } } });
    await flush();
    const conts1 = clientW.sent.filter(s => s.method === 'Fetch.continueRequest' && s.params.requestId === 'r1');
    eq('W-RW the paused request is continued exactly once', conts1.length, 1);
    ok('W-RW the continue carries the rewritten url and range', !!conts1[0] && !conts1[0].params.url.includes('range=') && conts1[0].params.headers.some(h => h.name === 'Range' && h.value === 'bytes=0-'));
    clientW.handlers['Fetch.requestPaused']({ requestId: 'r2', request: { url: 'https://flow.google.com/project/x', headers: {} } });
    await flush();
    const conts2 = clientW.sent.filter(s => s.method === 'Fetch.continueRequest' && s.params.requestId === 'r2');
    eq('W-RW an unrelated paused request is continued exactly once, unmodified', conts2.length === 1 && conts2[0].params.url === undefined ? 1 : 0, 1);
    eq('W-RW nothing disabled on the happy path', disabledNotes.length, 0);
    // nakami: continue bigde to khud-band + EK khabar
    const disabledNotes2 = [];
    const capW2 = new NetworkCapture({ onFetchRwDisabled: (info) => disabledNotes2.push(info) });
    const clientW2 = mkRwClient((m) => m === 'Fetch.continueRequest');
    await capW2._armFetchRw(clientW2);
    clientW2.handlers['Fetch.requestPaused']({ requestId: 'r9', request: { url: 'https://rr1---sn-x.googlevideo.com/videoplayback?id=a&range=0-50', headers: {} } });
    await flush();
    eq('W-RW a failing continue disables interception with one note', disabledNotes2.length, 1);
    eq('W-RW the disable reason names the continue failure', disabledNotes2[0] && disabledNotes2[0].reason, 'continue-failed');
    ok('W-RW Fetch.disable was sent on disable', clientW2.sent.some(s => s.method === 'Fetch.disable'));
    // enable hi bigde to bhi wahi ek khabar
    const disabledNotes3 = [];
    const capW3 = new NetworkCapture({ onFetchRwDisabled: (info) => disabledNotes3.push(info) });
    const clientW3 = mkRwClient((m) => m === 'Fetch.enable');
    await capW3._armFetchRw(clientW3);
    eq('W-RW a failing enable disables with one note', disabledNotes3.length, 1);
    eq('W-RW the enable failure reason is named', disabledNotes3[0] && disabledNotes3[0].reason, 'enable-failed');
  }

  // -------------------------------------------------------------------------
  // v2.48.53 (X — RPC-BODY SCAN + 1B SABOOT + FOCUS): rpcVideoUrlInfo
  // (khalis), _noteRpcVideoUrls (dedupe + pehli-nazar ki khabar + kitab),
  // Fetch rewrite ki khabar (asal badlaav par hi), focus-emulation arm.
  // -------------------------------------------------------------------------
  {
    const full = 'https://rr3---sn-qxaelnls.googlevideo.com/videoplayback?expire=999&id=abc&itag=18&clen=1193629&dur=4.032';
    const prev = 'https://rr4---sn-u1qxac-5i.googlevideo.com/videoplayback?expire=999&id=def&itag=18&clen=98237';
    const infoF = rpcVideoUrlInfo(full);
    eq('X-INFO full url clen parsed', infoF && infoF.clen, 1193629);
    eq('X-INFO full url itag parsed', infoF && infoF.itag, '18');
    eq('X-INFO preview url clen parsed', (rpcVideoUrlInfo(prev) || {}).clen, 98237);
    eq('X-INFO non-googlevideo is null', rpcVideoUrlInfo('https://flow.google.com/project/x'), null);
    eq('X-INFO missing clen stays null', (rpcVideoUrlInfo('https://rr1---sn-x.googlevideo.com/videoplayback?id=a&itag=18') || {}).clen, null);
    eq('X-INFO garbage is null', rpcVideoUrlInfo('not a url'), null);

    const notes = [];
    const capX = new NetworkCapture({ onRpcVideoUrls: (info) => notes.push(info) });
    const added1 = capX._noteRpcVideoUrls([full, prev, 'https://flow.google.com/x'], ['jwpduf'], 100000);
    eq('X-NOTE two googlevideo urls recorded', added1, 2);
    eq('X-NOTE one note for the body', notes.length, 1);
    eq('X-NOTE note carries both clens', notes[0] && notes[0].items.map(i => i.clen).join(','), '1193629,98237');
    eq('X-NOTE note carries the rpcid', notes[0] && notes[0].rpcids.join(','), 'jwpduf');
    const added2 = capX._noteRpcVideoUrls([full], ['jwpduf'], 100500);
    eq('X-NOTE a repeat url is not recorded again', added2, 0);
    eq('X-NOTE no second note for a repeat', notes.length, 1);
    const sights = capX.mainpageRpcBodySightings();
    eq('X-NOTE sightings list holds both', sights.length, 2);
    eq('X-NOTE first sighting keeps first-seen time', sights[0] && sights[0].firstSeenAt, 100000);
    capX.mainpageMarkRpcBodyConsumed(full, 'task-key-1');
    eq('X-NOTE consume marks the sighting', (capX.mainpageRpcBodySightings().find(s => s.url === full) || {}).consumedBy, 'task-key-1');
    sights[0].consumedBy = 'mutated-copy';
    eq('X-NOTE sightings copies do not leak inside', (capX.mainpageRpcBodySightings().find(s => s.url === prev) || {}).consumedBy, null);

    // v2.48.54 (fix 2): repeat nazar par lastSeenAt taza hoti
    // hai, pehli nazar ka waqt barkarar rehta hai; (fix 1)
    // claim par bhi rpc kitab me consumed darj hota hai.
    const capY = new NetworkCapture({});
    capY._noteRpcVideoUrls([full], ['abc'], 200000);
    capY._noteRpcVideoUrls([full], ['abc'], 206000);
    const ySights = capY.mainpageRpcBodySightings();
    eq('X-NOTE54 repeat keeps one sighting', ySights.length, 1);
    eq('X-NOTE54 first-seen preserved on repeat', ySights[0] && ySights[0].firstSeenAt, 200000);
    eq('X-NOTE54 last-seen refreshed on repeat', ySights[0] && ySights[0].lastSeenAt, 206000);
    capY.claimMainpageVideo(full, { key: 'task-key-9', label: '9' });
    eq('X-NOTE54 claim marks the rpc sighting consumed', (capY.mainpageRpcBodySightings().find(sg => sg.url === full) || {}).consumedBy, 'task-key-9');

    // Fetch rewrite ki khabar: sirf asal badlaav par, host/origRange/stripped ke saath.
    const flushX = () => new Promise(r => setTimeout(r, 15));
    const rwNotes = [];
    const capR = new NetworkCapture({ onFetchRwRewrite: (info) => rwNotes.push(info) });
    const sentR = [];
    const handlersR = {};
    const clientR = {
      sent: sentR,
      handlers: handlersR,
      on: (ev, fn) => { handlersR[ev] = fn; },
      send: (method, params) => { sentR.push({ method, params }); return Promise.resolve({}); }
    };
    await capR._armFetchRw(clientR);
    handlersR['Fetch.requestPaused']({ requestId: 'x1', request: { url: 'https://rr1---sn-x.googlevideo.com/videoplayback?expire=999&id=a&range=0-50&itag=18', headers: { Range: 'bytes=0-50' } } });
    await flushX();
    eq('X-RW one rewrite note for a changed request', rwNotes.length, 1);
    eq('X-RW note names the host', rwNotes[0] && rwNotes[0].host, 'rr1---sn-x.googlevideo.com');
    eq('X-RW note names the original range', rwNotes[0] && rwNotes[0].origRange, 'bytes=0-50');
    eq('X-RW note names the stripped param', rwNotes[0] && rwNotes[0].stripped.join(','), 'range');
    handlersR['Fetch.requestPaused']({ requestId: 'x2', request: { url: 'https://rr1---sn-x.googlevideo.com/videoplayback?expire=999&id=a&itag=18', headers: { Range: 'bytes=0-' } } });
    await flushX();
    eq('X-RW no note when nothing changes', rwNotes.length, 1);

    // Focus emulation: ek client par ek dafa, nakami par bhi ek khabar.
    const emuNotes = [];
    const capE = new NetworkCapture({ onFocusEmulation: (info) => emuNotes.push(info) });
    const emuSent = [];
    const clientE = { send: (m, p) => { emuSent.push({ m, p }); return Promise.resolve({}); }, on: () => {} };
    await capE._armFocusEmulation(clientE);
    eq('X-EMU enable sent once', emuSent.filter(s => s.m === 'Emulation.setFocusEmulationEnabled').length, 1);
    eq('X-EMU ok note fired', emuNotes.length === 1 && emuNotes[0].ok, true);
    await capE._armFocusEmulation(clientE);
    eq('X-EMU same client is not armed twice', emuSent.length, 1);
    const emuNotes2 = [];
    const capE2 = new NetworkCapture({ onFocusEmulation: (info) => emuNotes2.push(info) });
    const clientBad = { send: () => Promise.reject(new Error('no emulation')), on: () => {} };
    await capE2._armFocusEmulation(clientBad);
    eq('X-EMU failure note fired', emuNotes2.length === 1 && emuNotes2[0].ok, false);

    // v2.48.56 (X56): tile-state probe — DOM src +
    // React fiber props se pate nikalna (nakli page).
    {
      const engProbe = new FlowAutomationEngine({ onLog: () => {} }, {});
      engProbe._resolveTileIndexForTask = async () => 0;
      const prevU = 'https://rr9---sn.googlevideo.com/videoplayback?expire=9&id=pv&itag=18&clen=110000';
      const fullU = 'https://rr8---sn.googlevideo.com/videoplayback?expire=9&id=fl&itag=18&clen=1250000';
      const vidEl = { tagName: 'VIDEO', src: prevU, getAttribute: () => null, dataset: {} };
      const tileEl = {
        tagName: 'DIV', getAttribute: () => null, dataset: {},
        querySelectorAll: (sel) => (sel === '*' ? [vidEl] : []),
        '__reactFiber$abc': { memoizedProps: { media: { playbackUrl: fullU } }, child: null, sibling: null }
      };
      engProbe.page = {
        isClosed: () => false,
        evaluate: async (fn, arg) => {
          const prevDoc = global.document;
          global.document = { querySelectorAll: () => [tileEl] };
          try { return await fn(arg); } finally { global.document = prevDoc; }
        }
      };
      const probeOut = await engProbe._probeTileStateUrls({ promptIndex: 0 }, undefined);
      eq('X56-PROBE do pate mile', probeOut.length, 2);
      eq('X56-PROBE dom wala preview mila', (probeOut.find(p => p.url === prevU) || {}).source, 'dom');
      eq('X56-PROBE fiber wala poora mila', (probeOut.find(p => p.url === fullU) || {}).source, 'fiber');
      const probeEmpty = await engProbe._probeTileStateUrls({ promptIndex: 0 }, undefined);
      eq('X56-PROBE dobara bhi utne hi (dedupe page ke andar)', probeEmpty.length, 2);
    }

    // v2.48.55 (X55 — Gemini ZIP-fix ke achhe points):
    // (1) nazar par captureKey ki mohar + string-claim.
    const capZ = new NetworkCapture({});
    capZ.mainpageWindows.set('k-z1', { start: 400000, done: false });
    capZ._noteRpcVideoUrls([full], ['abc'], 400500);
    const zSight = capZ.mainpageRpcBodySightings().find(sg => sg.url === full);
    eq('X55-NOTE sighting stamped with the active window key', zSight && zSight.captureKey, 'k-z1');
    const capW = new NetworkCapture({});
    capW._noteRpcVideoUrls([prev], ['abc'], 500000);
    eq('X55-NOTE no window means no stamp', (capW.mainpageRpcBodySightings().find(sg => sg.url === prev) || {}).captureKey, null);
    capW.mainpageWindows.set('k-w9', { start: 501000, done: false });
    capW._noteRpcVideoUrls([prev], ['abc'], 505000);
    const wSight = capW.mainpageRpcBodySightings().find(sg => sg.url === prev);
    eq('X55-NOTE repeat fills a missing stamp', wSight && wSight.captureKey, 'k-w9');
    capW.claimMainpageVideo(prev, 'k-string-task');
    eq('X55-NOTE a plain-string claim is recorded as-is', (capW.mainpageRpcBodySightings().find(sg => sg.url === prev) || {}).consumedBy, 'k-string-task');

    // (2) CDP Network.loadingFinished preserves batchMeta.reqUrl query string (?rpcids=...)
    const cdpRpcNotes = [];
    const capCdp = new NetworkCapture({ onRpcVideoUrls: (info) => cdpRpcNotes.push(info) });
    capCdp.arm();
    const cdpHandlers = {};
    const cdpClient = {
      on: (ev, fn) => { cdpHandlers[ev] = fn; },
      send: async (m) => {
        if (m === 'Network.getResponseBody') {
          return {
            body: ')]}\'\n[["wrb.fr","jwpduf","[\"https://rr3---sn-qxaelnls.googlevideo.com/videoplayback?expire=999&id=cdp1&itag=18&clen=1350000\"]"]]',
            base64Encoded: false
          };
        }
        return {};
      }
    };
    const fakeCdpPage = fakePage('cdp-batch', { cdpClient });
    await capCdp._attachCdpWebSockets(fakeCdpPage);
    cdpHandlers['Network.requestWillBeSent']({
      requestId: 'req-batch-1',
      request: {
        url: 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=jwpduf&source-path=%2F',
        method: 'POST',
        postData: 'f.req=test'
      }
    });
    cdpHandlers['Network.responseReceived']({
      requestId: 'req-batch-1',
      response: {
        url: 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=jwpduf&source-path=%2F',
        status: 200,
        mimeType: 'application/json',
        headers: {}
      }
    });
    cdpHandlers['Network.loadingFinished']({ requestId: 'req-batch-1', encodedDataLength: 200 });
    await flushX();
    eq('X55 CDP batchexecute loadingFinished emits rpc video note', cdpRpcNotes.length, 1);
    eq('X55 CDP batchexecute preserves rpcids from reqUrl', cdpRpcNotes[0] && cdpRpcNotes[0].rpcids.join(','), 'jwpduf');

    // (3) _primeNextPendingTile does NOT burn one-shot flag when <video> is not mounted yet
    const engPrime = new FlowAutomationEngine({ onLog: () => {} }, {});
    let primeHasVid = false;
    let vidPlayed = 0;
    engPrime._resolveTileIndexForTask = async () => 1;
    engPrime.page = {
      isClosed: () => false,
      evaluate: async (fn, arg) => {
        const prevDoc = global.document;
        global.document = {
          querySelectorAll: () => [
            {},
            {
              scrollIntoView: () => {},
              querySelector: (sel) => (sel === 'video' && primeHasVid)
                ? { muted: false, play: () => { vidPlayed++; return Promise.resolve(); } }
                : null
            }
          ]
        };
        try { return await fn(arg); } finally { global.document = prevDoc; }
      }
    };
    const tPrime1 = { promptIndex: 0, status: 'completed', mediaSaved: true };
    const tPrime2 = { promptIndex: 1, status: 'generating', mediaSaved: false, completed: false, promptText: 'Prompt two' };
    engPrime._captureTasks.set('k1', tPrime1);
    engPrime._captureTasks.set('k2', tPrime2);
    const p1 = await engPrime._primeNextPendingTile(tPrime1);
    eq('X55 prime returns false when tile has no <video> yet', p1, false);
    eq('X55 one-shot flag is not burned when <video> is missing', !!engPrime._pipelinePrimedRun, false);
    primeHasVid = true;
    const p2 = await engPrime._primeNextPendingTile(tPrime1);
    eq('X55 prime returns true once <video> exists on the tile', p2, true);
    eq('X55 one-shot flag is set after real prime', engPrime._pipelinePrimedRun, true);
    eq('X55 prime called vid.play() on the next tile', vidPlayed, 1);
  }

  // ---------------------------------------------------------------------------
  // X57. v2.48.57 (PROJECT-TRUTH): video SIRF apne
  //      project me hoti hai —
  //   (a) recovery grouping: recorded project_url wala
  //       group seedha usi URL par khulta hai (har
  //       (account, project) group par browser ek
  //       baar); bina URL wali rows EK gallery pass
  //       leti hain sab se purani row ke waqt ke saath;
  //   (b) gallery entry: 'existing' (recovery) NEW
  //       PROJECT kabhi nahi banata — faisla khalis
  //       galleryEntryDecision + nakli page par amal;
  //       date-time chunav sab se qareeb wala (baad ka
  //       na ho) project leta hai;
  //   (c) recovery me not-found -> parked, failTask
  //       NAHI (restart mode bhi — change 4);
  //   (d) setTaskProjectUrl ka asal DB round-trip
  //       (alag process, throwaway data dir).
  // ---------------------------------------------------------------------------
  {
    const { WorkerPool } = require('../engine/workerPool');
    const { dbService } = require('../engine/db');
    const savedDb = {
      getAccount: dbService.getAccount,
      failTask: dbService.failTask,
      setTaskNeedsCheck: dbService.setTaskNeedsCheck,
      getTask: dbService.getTask,
      completeTask: dbService.completeTask
    };
    const savedEng = {
      launch: FlowAutomationEngine.prototype.launchBrowserForAccount,
      open: FlowAutomationEngine.prototype.openFlowStudio,
      reconcile: FlowAutomationEngine.prototype.reconcileRecoveredTask,
      close: FlowAutomationEngine.prototype.closeBrowser,
      sweepFn: FlowAutomationEngine.prototype.scheduleDownloadWatcherSweep
    };
    const dbState = new Map();
    const failCalls = [];
    const openCalls = [];
    const updates = [];
    dbService.getAccount = (id) => (id === 'acc-x' ? { id: 'acc-x', name: 'X Acc', googleName: 'X Acc' } : null);
    dbService.failTask = (id) => { failCalls.push(id); const r = dbState.get(id); if (r) r.status = 'failed'; };
    dbService.setTaskNeedsCheck = (id, v) => { const r = dbState.get(id); if (r) r.needsCheck = v; };
    dbService.getTask = (id) => dbState.get(id) || null;
    dbService.completeTask = () => {};
    FlowAutomationEngine.prototype.launchBrowserForAccount = async () => true;
    FlowAutomationEngine.prototype.openFlowStudio = async (settings) => { openCalls.push(settings || {}); return 'READY'; };
    FlowAutomationEngine.prototype.reconcileRecoveredTask = async () => ({ found: false });
    FlowAutomationEngine.prototype.closeBrowser = async () => {};
    FlowAutomationEngine.prototype.scheduleDownloadWatcherSweep = () => {};
    const pool = new WorkerPool({ onLog: () => {}, onTaskUpdate: (u) => updates.push(u) });
    const U1 = 'https://flow.google.com/project/x57-proj-one';
    const U2 = 'https://flow.google.com/project/x57-proj-two';
    const mkRow = (id, url, created) => ({ id, assigned_account_id: 'acc-x', prompt_index: 0, prompt_text: 'x57 prompt', prompt_tag: '', project_url: url, created_at: created });
    const rows = [
      mkRow('x57-r1', U1, '2026-11-06 10:05:00'),
      mkRow('x57-r2', U1, '2026-11-06 10:05:05'),
      mkRow('x57-r3', '', '2026-11-06 09:17:00'),
      mkRow('x57-r4', U2, '2026-11-06 08:13:00')
    ];
    for (const r of rows) dbState.set(r.id, { status: 'pending', needsCheck: 1 });
    await pool._reconcileNeedsCheck(rows, '/tmp', {});
    eq('X57-GROUP one gallery/recorded entry per (account, project) group', openCalls.length, 3);
    eq('X57-GROUP the recorded U1 group opens its URL exactly once', openCalls.filter(c => c.projectUrl === U1).length, 1);
    eq('X57-GROUP the recorded U2 group opens its URL exactly once', openCalls.filter(c => c.projectUrl === U2).length, 1);
    const galleryCall = openCalls.find(c => !c.projectUrl);
    ok('X57-GROUP the unrecorded rows get one gallery pass', !!galleryCall);
    eq('X57-GROUP the gallery pass carries the oldest row time', galleryCall && galleryCall.recoveryTargetTime, Date.parse('2026-11-06T09:17:00Z'));
    eq('X57-GROUP recorded beats gallery (no recorded group falls back to a target time)', openCalls.filter(c => c.projectUrl).every(c => c.recoveryTargetTime === undefined), true);
    // (c) not-found in restart-mode recovery -> parked
    eq('X57-PARK failTask is never called in recovery', failCalls.length, 0);
    eq('X57-PARK every row stays pending', rows.every(r => dbState.get(r.id).status === 'pending'), true);
    eq('X57-PARK every row keeps needs_check', rows.every(r => dbState.get(r.id).needsCheck === 1), true);
    ok('X57-PARK the UI updates say pending', rows.every(r => updates.some(u => u.taskId === r.id && u.status === 'pending')));
    dbService.getAccount = savedDb.getAccount;
    dbService.failTask = savedDb.failTask;
    dbService.setTaskNeedsCheck = savedDb.setTaskNeedsCheck;
    dbService.getTask = savedDb.getTask;
    dbService.completeTask = savedDb.completeTask;
    FlowAutomationEngine.prototype.launchBrowserForAccount = savedEng.launch;
    FlowAutomationEngine.prototype.openFlowStudio = savedEng.open;
    FlowAutomationEngine.prototype.reconcileRecoveredTask = savedEng.reconcile;
    FlowAutomationEngine.prototype.closeBrowser = savedEng.close;
    FlowAutomationEngine.prototype.scheduleDownloadWatcherSweep = savedEng.sweepFn;
  }
  {
    // (b) khalis faisle
    const NOW = new Date(2026, 10, 6, 12, 0).getTime();
    eq('X57-ID project id comes out of a full edit URL', projectIdOfUrl('https://flow.google.com/project/abc-123/edit/xyz'), 'abc-123');
    eq('X57-ID a gallery URL has no project id', projectIdOfUrl('https://flow.google.com/'), '');
    eq('X57-DT the Flow gallery datetime parses', parseGalleryDateTime('Nov 06 - 09:28', NOW), new Date(2026, 10, 6, 9, 28).getTime());
    eq('X57-DT garbage text gives null', parseGalleryDateTime('some tile caption', NOW), null);
    const gLinks = [
      { href: '/project/new', text: 'Nov 06 - 10:10' },
      { href: '/project/mid', text: 'Nov 06 - 09:28' },
      { href: '/project/old', text: 'Nov 06 - 09:17' }
    ];
    const pickNear = pickGalleryProject(gLinks, new Date(2026, 10, 6, 9, 20).getTime(), NOW);
    eq('X57-PICK the nearest not-after project wins', pickNear.index, 2);
    eq('X57-PICK its source is gallery-datetime', pickNear.source, 'gallery-datetime');
    const pickEarly = pickGalleryProject(gLinks, new Date(2026, 10, 6, 8, 0).getTime(), NOW);
    eq('X57-PICK nothing not-after means the first link', pickEarly.index, 0);
    eq('X57-PICK its source is gallery-first', pickEarly.source, 'gallery-first');
    eq('X57-DEC existing with a New Project button but no links never creates', galleryEntryDecision({ hasNewBtn: true, links: [] }, false, 0, NOW).kind, 'none');
    eq('X57-DEC existing with links enters a link', galleryEntryDecision({ hasNewBtn: true, links: gLinks }, false, 0, NOW).kind, 'link');
    eq('X57-DEC fresh still prefers New Project', galleryEntryDecision({ hasNewBtn: true, links: gLinks }, true, 0, NOW).kind, 'new');
    eq('X57-DEC fresh without a button falls back to the first link', galleryEntryDecision({ hasNewBtn: false, links: gLinks }, true, 0, NOW).index, 0);
    eq('X57-DEC garbage survey is a safe none', galleryEntryDecision(null, false, 0, NOW).kind, 'none');
  }
  {
    // (b2) nakli page par asal entry — recovery me
    // New Project wala button maujood hote hue bhi
    // click NAHI hota; date-time wala link khulta hai.
    const engG = new FlowAutomationEngine({ onLog: () => {} }, { galleryEntryPollMs: 1 });
    let clickedNew = 0;
    const clickedLinks = [];
    let currentUrl = 'https://flow.google.com/';
    const newBtn = { innerText: 'New project', getAttribute: () => '', click: () => { clickedNew++; } };
    const mkLink = (href, label) => ({
      innerText: '',
      getAttribute: (n) => (n === 'href' ? href : ''),
      parentElement: { innerText: label },
      click: () => { clickedLinks.push(href); currentUrl = `https://flow.google.com${href}`; }
    });
    let fakeLinks = [mkLink('/project/p-new', 'Nov 06 - 10:10'), mkLink('/project/p-old', 'Nov 06 - 09:17')];
    engG.page = {
      isClosed: () => false,
      url: () => currentUrl,
      goto: async (u) => { currentUrl = u; },
      evaluate: async (fn, arg) => {
        const prevDoc = global.document;
        global.document = {
          querySelector: () => null,
          querySelectorAll: (sel) => (String(sel).includes('/project/') ? fakeLinks : [newBtn])
        };
        try { return await fn(arg); } finally { global.document = prevDoc; }
      }
    };
    const entry = await engG._enterProjectFromGallery(false, new Date(2026, 10, 6, 9, 20).getTime());
    eq('X57-PAGE recovery entered a project', entry.entered, true);
    eq('X57-PAGE the datetime-matched project was the one opened', JSON.stringify(clickedLinks), JSON.stringify(['/project/p-old']));
    eq('X57-PAGE the entry source is gallery-datetime', entry.source, 'gallery-datetime');
    eq('X57-PAGE the New Project button was never clicked', clickedNew, 0);
    // gallery khaali: koi link nahi, sirf New Project
    fakeLinks = [];
    clickedLinks.length = 0;
    currentUrl = 'https://flow.google.com/';
    const entryNone = await engG._enterProjectFromGallery(false, 0);
    eq('X57-PAGE an empty gallery cannot be entered in recovery', entryNone.entered, false);
    eq('X57-PAGE New Project is still never clicked', clickedNew, 0);
  }
  {
    // (d) asal DB round-trip — alag process, throwaway
    // data dir (is suite ki apni DB ko haath nahi).
    const { execFileSync } = require('child_process');
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-x57-db-'));
    const dbPath = JSON.stringify(path.join(__dirname, '..', 'engine', 'db.js'));
    const script = `(async () => {
      const { dbService } = require(${dbPath});
      await dbService.ensureInit();
      const rows = dbService.createBatchTasks('b-x57', ['x57 round trip prompt'], {});
      const id = rows[0].id;
      const before = dbService.getTask(id);
      dbService.setTaskProjectUrl(id, 'https://flow.google.com/project/x57-rt');
      const after = dbService.getTask(id);
      console.log(JSON.stringify({ before: before.project_url || '', after: after.project_url || '' }));
    })().catch(e => { console.error(e && e.stack || e); process.exit(1); });`;
    let rt = null;
    try {
      const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, FLOW_LITE_DATA_DIR: tmpDir }, encoding: 'utf8' });
      rt = JSON.parse(out.trim().split('\n').filter(Boolean).pop());
    } catch (e) { rt = null; }
    ok('X57-DB the round-trip child ran', !!rt);
    eq('X57-DB a fresh task row has an empty project_url', rt && rt.before, '');
    eq('X57-DB setTaskProjectUrl round-trips', rt && rt.after, 'https://flow.google.com/project/x57-rt');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // X58. v2.48.58 (RECOVERY-NO-CREDIT-GATE):
  //   (a) openFlowStudio ka credit gate download-only
  //       recovery (settings.downloadOnly) par NAHI
  //       rukta — balance 2 (LOW) ho ya 0 (EXHAUSTED)
  //       ho, entry READY milti hai aur bypass wali
  //       [ROOT] line log hoti hai; BINA flag ke wahi
  //       balance aaj ki tarah LOW_CREDITS / EXHAUSTED
  //       hi deta hai (fresh run ka gate bilkul waisa
  //       hi).
  //   (b) workerPool ki recovery ghadi har open call
  //       par downloadOnly flag lagati hai.
  //   (c) gallery-wait: recovery entry attempt 1 se
  //       PEHLE gallery tiles ke render ka intezaar
  //       karti hai — der se aane wala link bhi pehle
  //       hi attempt me khul jata hai; helper had ke
  //       andar saaf timeout bhi hota hai.
  // ---------------------------------------------------------------------------
  {
    const gateLogs = [];
    const mkGateEng = (live) => {
      const eng = new FlowAutomationEngine({ onLog: (e) => gateLogs.push((e && e.message) || '') });
      let cur = 'https://flow.google.com/';
      eng.page = {
        isClosed: () => false,
        url: () => cur,
        goto: async (u) => { cur = u; },
        evaluate: async () => false,
        waitForSelector: async () => {}
      };
      eng._waitForFlowSignal = async () => true;
      eng.ensureAgentModeDisabled = async () => {};
      eng.readLiveCreditsFromPage = async () => live;
      eng.currentAccount = { id: 'acc-x58', name: 'X58 Acc', credits: 99 };
      return eng;
    };
    const gateSettings = { duration: '4s', model: 'Omni Flash', quality: '360p', canvasStrategy: 'existing', projectUrl: 'https://flow.google.com/project/x58-proj' };
    eq('X58-GATE no flag: low balance still returns LOW_CREDITS', await mkGateEng(2).openFlowStudio({ ...gateSettings }), 'LOW_CREDITS');
    gateLogs.length = 0;
    eq('X58-GATE recovery flag: low balance still enters (READY)', await mkGateEng(2).openFlowStudio({ ...gateSettings, downloadOnly: true }), 'READY');
    ok('X58-GATE the bypass [ROOT] line was logged with the balance', gateLogs.some(m => m.includes('[ROOT] recovery-credit-gate bypassed balance=2')));
    eq('X58-GATE no flag: zero balance still returns EXHAUSTED', await mkGateEng(0).openFlowStudio({ ...gateSettings }), 'EXHAUSTED');
    eq('X58-GATE recovery flag: zero balance still enters (READY)', await mkGateEng(0).openFlowStudio({ ...gateSettings, downloadOnly: true }), 'READY');
    eq('X58-GATE no flag: enough balance still enters (READY)', await mkGateEng(10).openFlowStudio({ ...gateSettings }), 'READY');
  }
  {
    // (b) pool ki recovery ghadi — flag har call par
    const { WorkerPool } = require('../engine/workerPool');
    const { dbService } = require('../engine/db');
    const savedDb58 = {
      getAccount: dbService.getAccount,
      setTaskNeedsCheck: dbService.setTaskNeedsCheck,
      getTask: dbService.getTask,
      completeTask: dbService.completeTask
    };
    const savedEng58 = {
      launch: FlowAutomationEngine.prototype.launchBrowserForAccount,
      open: FlowAutomationEngine.prototype.openFlowStudio,
      reconcile: FlowAutomationEngine.prototype.reconcileRecoveredTask,
      close: FlowAutomationEngine.prototype.closeBrowser,
      sweepFn: FlowAutomationEngine.prototype.scheduleDownloadWatcherSweep
    };
    const openCalls58 = [];
    dbService.getAccount = (id) => (id === 'acc-x58' ? { id: 'acc-x58', name: 'X58 Acc', googleName: 'X58 Acc' } : null);
    dbService.setTaskNeedsCheck = () => {};
    dbService.getTask = () => null;
    dbService.completeTask = () => {};
    FlowAutomationEngine.prototype.launchBrowserForAccount = async () => true;
    FlowAutomationEngine.prototype.openFlowStudio = async (settings) => { openCalls58.push(settings || {}); return 'READY'; };
    FlowAutomationEngine.prototype.reconcileRecoveredTask = async () => ({ found: false });
    FlowAutomationEngine.prototype.closeBrowser = async () => {};
    FlowAutomationEngine.prototype.scheduleDownloadWatcherSweep = () => {};
    const pool58 = new WorkerPool({ onLog: () => {}, onTaskUpdate: () => {} });
    const rows58 = [
      { id: 'x58-r1', assigned_account_id: 'acc-x58', prompt_index: 0, prompt_text: 'x58 prompt', prompt_tag: '', project_url: 'https://flow.google.com/project/x58-proj', created_at: '2026-11-06 10:05:00' },
      { id: 'x58-r2', assigned_account_id: 'acc-x58', prompt_index: 1, prompt_text: 'x58 prompt 2', prompt_tag: '', project_url: '', created_at: '2026-11-06 09:17:00' }
    ];
    await pool58._reconcileNeedsCheck(rows58, '/tmp', {});
    eq('X58-FLAG recovery opens one call per (account, project) group', openCalls58.length, 2);
    ok('X58-FLAG every recovery open carries downloadOnly', openCalls58.every(c => c.downloadOnly === true));
    ok('X58-FLAG every recovery open stays on the existing strategy', openCalls58.every(c => c.canvasStrategy === 'existing'));
    dbService.getAccount = savedDb58.getAccount;
    dbService.setTaskNeedsCheck = savedDb58.setTaskNeedsCheck;
    dbService.getTask = savedDb58.getTask;
    dbService.completeTask = savedDb58.completeTask;
    FlowAutomationEngine.prototype.launchBrowserForAccount = savedEng58.launch;
    FlowAutomationEngine.prototype.openFlowStudio = savedEng58.open;
    FlowAutomationEngine.prototype.reconcileRecoveredTask = savedEng58.reconcile;
    FlowAutomationEngine.prototype.closeBrowser = savedEng58.close;
    FlowAutomationEngine.prototype.scheduleDownloadWatcherSweep = savedEng58.sweepFn;
  }
  {
    // (c) gallery-wait — link der se aata hai
    const waitLogs = [];
    const engW = new FlowAutomationEngine({ onLog: (e) => waitLogs.push((e && e.message) || '') }, { galleryEntryPollMs: 1, galleryWaitMs: 3000, galleryWaitPollMs: 5 });
    let currentUrl = 'https://flow.google.com/';
    const clickedLinks = [];
    const mkLateLink = (href, label) => ({
      innerText: '',
      getAttribute: (n) => (n === 'href' ? href : ''),
      parentElement: { innerText: label },
      click: () => { clickedLinks.push(href); currentUrl = `https://flow.google.com${href}`; }
    });
    let fakeLinks = [];
    engW.page = {
      isClosed: () => false,
      url: () => currentUrl,
      goto: async (u) => { currentUrl = u; },
      evaluate: async (fn, arg) => {
        const prevDoc = global.document;
        global.document = {
          querySelector: () => null,
          querySelectorAll: (sel) => (String(sel).includes('/project/') ? fakeLinks : [])
        };
        try { return await fn(arg); } finally { global.document = prevDoc; }
      }
    };
    setTimeout(() => { fakeLinks = [mkLateLink('/project/p-late', 'Nov 06 - 10:10')]; }, 60);
    const lateEntry = await engW._enterProjectFromGallery(false, 0);
    eq('X58-WAIT the late-appearing project still gets entered', lateEntry.entered, true);
    eq('X58-WAIT it was entered on the first attempt', waitLogs.filter(m => m.includes('Attempt 1/3')).length === 1 && !waitLogs.some(m => m.includes('Attempt 2/3')), true);
    ok('X58-WAIT the gallery-wait [ROOT] line reports the link', waitLogs.some(m => m.includes('[ROOT] gallery-wait links=1')));
    eq('X58-WAIT the late link is the one that opened', JSON.stringify(clickedLinks), JSON.stringify(['/project/p-late']));
    // helper ka saaf timeout: link kabhi nahi aata
    const engT = new FlowAutomationEngine({ onLog: () => {} }, { galleryWaitMs: 80, galleryWaitPollMs: 5 });
    engT.page = {
      isClosed: () => false,
      url: () => 'https://flow.google.com/',
      goto: async () => {},
      evaluate: async (fn, arg) => {
        const prevDoc = global.document;
        global.document = { querySelector: () => null, querySelectorAll: () => [] };
        try { return await fn(arg); } finally { global.document = prevDoc; }
      }
    };
    const gwTimeout = await engT._waitForGalleryTiles(80);
    eq('X58-WAIT the helper times out with zero links', gwTimeout.links, 0);
    ok('X58-WAIT the helper timeout stays bounded', gwTimeout.waitedMs >= 50 && gwTimeout.waitedMs < 2000);
  }

  // X59. v2.48.59 (OMNI 1.2 FLASH): naya model
  // 'Omni 1.2 Flash' — per-second credit formula
  // (Google support page, 2026-11-06) aur version-
  // aware model matcher. Purana saaf-string
  // includes() do tarah tootta tha: 'Omni 1.2 Flash'
  // Flow ke 'Omni Flash 1.2' se match nahi hota tha,
  // aur legacy 'Omni Flash' ghalti se 1.2 chun leta
  // tha. Matcher kabhi exact string par nahi —
  // version token + lafz tokens par faisla hota hai.
  {
    const menu59 = ['Omni Flash 1.1', 'Omni Flash 1.2', 'Veo 3.1 Lite', 'Veo 3.1 Fast', 'Veo 3.1 Quality'];
    eq('X59-MATCH the 1.2 target picks the 1.2 item', matchModelOption('Omni 1.2 Flash', menu59), 1);
    eq('X59-MATCH the legacy target picks 1.1, never 1.2', matchModelOption('Omni Flash', menu59), 0);
    eq('X59-MATCH the explicit 1.1 target picks the 1.1 item', matchModelOption('Omni 1.1 Flash', menu59), 0);
    eq('X59-MATCH Veo Lite picks its own item', matchModelOption('Veo 3.1 Lite', menu59), 2);
    eq('X59-MATCH Veo Fast picks its own item', matchModelOption('Veo 3.1 Fast', menu59), 3);
    eq('X59-MATCH Veo Quality picks its own item', matchModelOption('Veo 3.1 Quality', menu59), 4);
    eq('X59-MATCH app-order wording matches too', matchModelOption('Omni 1.2 Flash', ['Omni 1.2 Flash', 'Omni Flash 1.1']), 0);
    eq('X59-MATCH an unknown model matches nothing', matchModelOption('Imagen 3', menu59), -1);
    eq('X59-MATCH only-1.2 menu falls back for the legacy target', matchModelOption('Omni Flash', ['Omni Flash 1.2']), 0);
    // current-selection check (strictVersion): panel
    // par 1.2 dikhna 1.1 target ke liye 'pehle se
    // chuna hua' NAHI hai — warna run chup chaap
    // ghalat model par chalta rehta.
    eq('X59-CUR 1.2 showing is not the legacy target', matchModelOption('Omni Flash', ['Omni Flash 1.2'], { strictVersion: true }), -1);
    eq('X59-CUR 1.1 showing is the legacy target', matchModelOption('Omni Flash', ['Omni Flash 1.1'], { strictVersion: true }), 0);
    eq('X59-CUR plain showing is the legacy target', matchModelOption('Omni Flash', ['Omni Flash'], { strictVersion: true }), 0);
    eq('X59-CUR 1.2 showing is the 1.2 target', matchModelOption('Omni 1.2 Flash', ['Omni Flash 1.2'], { strictVersion: true }), 0);
    eq('X59-CUR 1.1 showing is not the 1.2 target', matchModelOption('Omni 1.2 Flash', ['Omni Flash 1.1'], { strictVersion: true }), -1);
    eq('X59-PARTS version and words split out', JSON.stringify(modelNameParts('Omni 1.2 Flash')), JSON.stringify({ version: '1.2', words: ['omni', 'flash'] }));
  }
  {
    // Rate formula — khalis helper par seedha.
    eq('X59-RATE 1.2 360p 4s = 4', omni12CreditsPerVideo(4, '360p'), 4);
    eq('X59-RATE 1.2 360p 8s = 8', omni12CreditsPerVideo(8, '360p'), 8);
    eq('X59-RATE 1.2 360p 10s = 10', omni12CreditsPerVideo(10, '360p'), 10);
    eq('X59-RATE 1.2 360p 11s = 12 (extra rate starts)', omni12CreditsPerVideo(11, '360p'), 12);
    eq('X59-RATE 1.2 360p 15s = 20', omni12CreditsPerVideo(15, '360p'), 20);
    eq('X59-RATE 1.2 720p 4s = 12', omni12CreditsPerVideo(4, '720p'), 12);
    eq('X59-RATE 1.2 720p 8s = 24', omni12CreditsPerVideo(8, '720p'), 24);
    eq('X59-RATE 1.2 720p 10s = 30', omni12CreditsPerVideo(10, '720p'), 30);
    eq('X59-RATE 1.2 720p 15s = 60', omni12CreditsPerVideo(15, '720p'), 60);
    eq('X59-RATE above-range clamps to 15s', omni12CreditsPerVideo(20, '360p'), 20);
    eq('X59-RATE below-range clamps to 3s', omni12CreditsPerVideo(2, '360p'), 3);
    // Engine ki asal kitab — getRequiredCredits.
    const grc = FlowAutomationEngine.prototype.getRequiredCredits;
    eq('X59-RATE engine 1.2 360p 15s = 20', grc.call({}, { model: 'Omni 1.2 Flash', duration: '15s', quality: '360p' }), 20);
    eq('X59-RATE engine 1.2 720p 15s = 60', grc.call({}, { model: 'Omni 1.2 Flash', duration: '15s', quality: '720p' }), 60);
    eq('X59-RATE engine 1.2 360p 4s = 4', grc.call({}, { model: 'Omni 1.2 Flash', duration: '4s', quality: '360p' }), 4);
    eq('X59-RATE engine 1.1 360p 10s unchanged = 7', grc.call({}, { model: 'Omni Flash', duration: '10s', quality: '360p' }), 7);
    eq('X59-RATE engine 1.1 720p 10s unchanged = 15', grc.call({}, { model: 'Omni Flash', duration: '10s', quality: '720p' }), 15);
    eq('X59-RATE engine non-1.2 at 15s keeps the old fallback', grc.call({}, { model: 'Omni Flash', duration: '15s', quality: '360p' }), 5);
  }

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.log(`FAIL  suite crashed — ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
