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
  fullFetchUrlCandidates,
  mainpageAuditOf,
  formatMainpageAudit,
  harvestAuditOf,
  formatHarvestAudit,
  cascadeVerdict
} = require('../engine/saveGuard');
const { classifyVerbatimProbe } = require('../engine/mintReplay');
const { NetworkCapture, isGooglevideoPlaybackUrl } = require('../engine/networkCapture');
const { DOWNLOAD_ROUTE_ORDER } = require('../engine/downloadRouteOrder');
const { FlowAutomationEngine } = require('../engine/flowAutomation');

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
    eq('MP-ORDER order is exactly mainpage-harvest then grid-replay', JSON.stringify(DOWNLOAD_ROUTE_ORDER), JSON.stringify(['mainpage-harvest', 'grid-replay']));
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
    eq('MP-FAIL the task route order is the two-step order', JSON.stringify(task.downloadRouteOrder), JSON.stringify(['mainpage-harvest', 'grid-replay']));
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
    const eUnk = nc.mainpageEntries().find(e => e.url === GV_UNK);
    eq('HOV-NC unknown-total video stream is a candidate', eUnk.candidate, true);
    eq('HOV-NC unknown-total stays unknown', eUnk.knownTotal, null);
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

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.log(`FAIL  suite crashed — ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
