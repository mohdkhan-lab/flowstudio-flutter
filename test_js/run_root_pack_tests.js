'use strict';

// v2.48.36 (ROOT PACK): jad par hamla — paanchon feature ke
// khalis faisle aur capture wiring:
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
  editorHarvestVerdict,
  promotedEditorHarvestPick,
  harvestAuditOf,
  formatHarvestAudit,
  cascadeVerdict
} = require('../engine/saveGuard');
const { classifyVerbatimProbe } = require('../engine/mintReplay');
const { NetworkCapture } = require('../engine/networkCapture');
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
  // I. v2.48.38 — EDITOR-HARVEST PACK:
  //   (a) tartib: editor-harvest replay-context ke baad
  //       aur direct-viewer se pehle hai;
  //   (b) teacher-identical bytes (hash barabar / duplicate
  //       nishaan / teacher URL) hamesha reject;
  //   (c) nisbat sanrachna se: jawab SIRF is task ke apne
  //       editor ke khule hone ki khidki ke andar ka ho —
  //       khidki se pehle/baad ka ya doosre task ki khidki
  //       ka jawab kabhi candidate nahi;
  //   (d) adhoora jawab (206 / Content-Range / declared se
  //       chhota / floor se neeche) inkaar nahi — usi URL
  //       ka page-context poora fetch (action 'fetch-full');
  //   (e) harvest-audit ka hisaab: bytes/body/hash-8/
  //       vsTeacher/decision/reason.
  // ---------------------------------------------------------------------------
  {
    // (a) tartib
    eq('EH-ORDER replay-context is third', DOWNLOAD_ROUTE_ORDER[2], 'replay-context');
    eq('EH-ORDER editor-harvest is fourth', DOWNLOAD_ROUTE_ORDER[3], 'editor-harvest');
    eq('EH-ORDER direct-viewer is fifth', DOWNLOAD_ROUTE_ORDER[4], 'direct-viewer');
    ok('EH-ORDER editor-harvest sits between replay-context and direct-viewer',
      DOWNLOAD_ROUTE_ORDER.indexOf('editor-harvest') === DOWNLOAD_ROUTE_ORDER.indexOf('replay-context') + 1
      && DOWNLOAD_ROUTE_ORDER.indexOf('direct-viewer') === DOWNLOAD_ROUTE_ORDER.indexOf('editor-harvest') + 1);
  }
  {
    // (b) teacher-identical bytes / teacher URL / duplicate
    const teacherBuf = mp4Buffer(600000);
    const freshBuf = mp4Buffer(600000);
    freshBuf[100] = 0xAB; // bytes alag — hash alag
    const tHash = contentHash(teacherBuf);
    const fHash = contentHash(freshBuf);
    const dup = editorHarvestVerdict({ inWindow: true, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 600000, floorBytes: 200 * 1024, headerOk: true, hash: tHash, teacherHash: tHash });
    eq('EH teacher-identical bytes rejected', dup.accept, false);
    eq('EH teacher-identical reason is duplicate-content', dup.reason, 'duplicate-content');
    eq('EH duplicate flag rejected as duplicate-content', editorHarvestVerdict({ inWindow: true, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 600000, floorBytes: 200 * 1024, headerOk: true, duplicate: true }).reason, 'duplicate-content');
    eq('EH teacher url rejected', editorHarvestVerdict({ inWindow: true, url: FC_TEACHER, teacherUrl: FC_TEACHER, byteLength: 600000, floorBytes: 200 * 1024, headerOk: true }).reason, 'teacher-url');
    const good = editorHarvestVerdict({ inWindow: true, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 600000, floorBytes: 200 * 1024, headerOk: true, hash: fHash, teacherHash: tHash });
    eq('EH fresh complete bytes accepted', good.accept, true);
    eq('EH fresh complete action is save', good.action, 'save');
    // Capture ki kitab me bhi teacher ka address kabhi darj nahi hota.
    const nc = new NetworkCapture({});
    nc.mintTeacherUrl = FC_TEACHER;
    nc.beginEditorWindow('task-eh');
    eq('EH-NC teacher url never recorded in the window', nc._recordEditorHarvest(FC_TEACHER, mp4Buffer(600000), { status: 200 }, Date.now()), false);
    eq('EH-NC teacher url leaves no candidate', nc.editorHarvestEntriesForKey('task-eh').length, 0);
    nc.endEditorWindow('task-eh');
  }
  {
    // (c) sanrachna wali nisbat — khidki ke bahar kabhi nahi
    eq('EH outside-window verdict rejected', editorHarvestVerdict({ inWindow: false, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 600000, floorBytes: 200 * 1024, headerOk: true }).reason, 'outside-window');
    const nc = new NetworkCapture({});
    // Koi khidki hi nahi — darj nahi hota.
    eq('EH-NC no window — not recorded', nc._recordEditorHarvest(FC_FRESH, mp4Buffer(600000), { status: 200 }, Date.now()), false);
    eq('EH-NC no window — no entries', nc.editorHarvestEntriesForKey('task-eh').length, 0);
    // Apni khidki ke andar — darj hota hai, apne hi naam par milta hai.
    nc.beginEditorWindow('task-eh');
    eq('EH-NC inside own window — recorded', nc._recordEditorHarvest(FC_FRESH, mp4Buffer(600000), { status: 200 }, Date.now()), true);
    eq('EH-NC own entries visible', nc.editorHarvestEntriesForKey('task-eh').length, 1);
    eq('EH-NC other task sees nothing', nc.editorHarvestEntriesForKey('task-other').length, 0);
    // Khidki band — us ke baad ka jawab darj nahi hota.
    nc.endEditorWindow('task-eh');
    eq('EH-NC after window closed — not recorded', nc._recordEditorHarvest(FC_FRESH2, mp4Buffer(600000), { status: 200 }, Date.now()), false);
    eq('EH-NC closed window keeps only the in-window entry', nc.editorHarvestEntriesForKey('task-eh').length, 1);
    // Khidki band hone ke baad NAYI khidki purane jawab
    // saaf karti hai (wo is khidki ke andar ke nahi the).
    nc.beginEditorWindow('task-eh');
    eq('EH-NC a fresh window after close starts empty', nc.editorHarvestEntriesForKey('task-eh').length, 0);
    // Lekin khuli khidki ko 'dobara kholna' (route C →
    // editor-harvest ka mushtarak editor reuse) darj
    // jawab barkarar rakhta hai.
    eq('EH-NC fresh window records again', nc._recordEditorHarvest(FC_FRESH, mp4Buffer(600000), { status: 200 }, Date.now()), true);
    nc.beginEditorWindow('task-eh');
    eq('EH-NC re-beginning the same open window keeps its entries', nc.editorHarvestEntriesForKey('task-eh').length, 1);
    nc.endEditorWindow('task-eh');
  }
  {
    // (d) adhoora jawab — poora fetch ka hukm, inkaar nahi
    eq('EH-PARTIAL 206 is partial', isPartialHarvestResponse({ status: 206, byteLength: 600000 }), true);
    eq('EH-PARTIAL content-range is partial', isPartialHarvestResponse({ status: 200, contentRange: 'bytes 0-99/600000', byteLength: 100 }), true);
    eq('EH-PARTIAL declared se chhota is partial', isPartialHarvestResponse({ status: 200, byteLength: 300000, declaredLength: 600000 }), true);
    eq('EH-PARTIAL floor se neeche is partial', isPartialHarvestResponse({ status: 200, byteLength: 100000, floorBytes: 200 * 1024 }), true);
    eq('EH-PARTIAL mukammal jawab partial nahi', isPartialHarvestResponse({ status: 200, byteLength: 600000, declaredLength: 600000, floorBytes: 200 * 1024 }), false);
    const v206 = editorHarvestVerdict({ inWindow: true, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 300000, floorBytes: 200 * 1024, headerOk: true, status: 206 });
    eq('EH-PARTIAL 206 verdict action is fetch-full', v206.action, 'fetch-full');
    eq('EH-PARTIAL 206 verdict is not an accept', v206.accept, false);
    eq('EH-PARTIAL content-range verdict action is fetch-full', editorHarvestVerdict({ inWindow: true, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 100, floorBytes: 200 * 1024, headerOk: true, contentRange: 'bytes 0-99/600000' }).action, 'fetch-full');
    eq('EH-PARTIAL below-floor verdict action is fetch-full', editorHarvestVerdict({ inWindow: true, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 100000, floorBytes: 200 * 1024, headerOk: true, status: 200 }).action, 'fetch-full');
    // Capture adhoore jawab ko partial nishaan ke saath
    // darj karta hai, taaki engine usi URL ka poora fetch
    // kar sake.
    const nc = new NetworkCapture({});
    nc.beginEditorWindow('task-p');
    eq('EH-NC partial response recorded', nc._recordEditorHarvest(FC_FRESH, mp4Buffer(100000), { status: 206, contentRange: 'bytes 0-99999/600000', declared: 600000 }, Date.now()), true);
    const entries = nc.editorHarvestEntriesForKey('task-p');
    eq('EH-NC partial entry carries the partial mark', entries.length === 1 && entries[0].partial, true);
    eq('EH-NC partial entry keeps its url for the full fetch', entries.length === 1 && entries[0].url, FC_FRESH);
    nc.endEditorWindow('task-p');
    // Baaki darwaze: header kharab / khaali / url hi nahi.
    eq('EH bad-header verdict is body reject', editorHarvestVerdict({ inWindow: true, url: FC_FRESH, teacherUrl: FC_TEACHER, byteLength: 600000, floorBytes: 200 * 1024, headerOk: false, status: 200 }).reason, 'bad-header');
    eq('EH missing url verdict', editorHarvestVerdict({ inWindow: true, url: null, teacherUrl: FC_TEACHER, byteLength: 600000, headerOk: true }).reason, 'no-url');
  }
  {
    // (e) harvest-audit ka hisaab
    const buf = mp4Buffer(600000);
    const other = mp4Buffer(600000);
    other[100] = 0xAB;
    const h = contentHash(buf);
    const aSame = harvestAuditOf({ byteLength: buf.length, bodyOk: true, hash: h, teacherHash: h, promoted: true, reason: 'ok' });
    eq('EH-AUDIT same-hash vsTeacher is same', aSame.vsTeacher, 'same');
    eq('EH-AUDIT promoted decision', aSame.decision, 'promoted');
    eq('EH-AUDIT hash is first 8 only', aSame.hash, h.slice(0, 8));
    eq('EH-AUDIT different-hash vsTeacher is different', harvestAuditOf({ byteLength: buf.length, bodyOk: true, hash: contentHash(other), teacherHash: h, promoted: false, reason: 'unbound' }).vsTeacher, 'different');
    eq('EH-AUDIT url se muqabla — same', harvestAuditOf({ byteLength: 10, bodyOk: true, url: FC_TEACHER, teacherUrl: FC_TEACHER, promoted: false, reason: 'teacher-url' }).vsTeacher, 'same');
    const aFail = harvestAuditOf({ byteLength: 0, bodyOk: false, promoted: false, reason: 'body-fail' });
    eq('EH-AUDIT body-fail body field', aFail.body, 'fail');
    eq('EH-AUDIT body-fail hash is n/a', aFail.hash, 'n/a');
    eq('EH-AUDIT no teacher info — vsTeacher n/a', harvestAuditOf({ byteLength: 10, bodyOk: true, promoted: true }).vsTeacher, 'n/a');
    const line = formatHarvestAudit(aSame);
    ok('EH-AUDIT line carries every field', line.includes(`bytes=${buf.length}`) && line.includes('body=ok') && line.includes(`hash=${h.slice(0, 8)}`) && line.includes('vsTeacher=same') && line.includes('decision=promoted') && line.includes('reason=ok'));
    ok('EH-AUDIT line never carries the full hash', !line.includes(h));
    // Capture audit sirf khidki (attempt/editor) me bolta
    // hai — bahar khamosh.
    const nc = new NetworkCapture({});
    let heard = 0;
    nc.onHarvestAudit = () => { heard++; };
    nc._emitHarvestAudit({ url: FC_FRESH }, buf, true);
    eq('EH-AUDIT silent outside any window', heard, 0);
    nc.setDownloadAttempt('task-a');
    nc._emitHarvestAudit({ url: FC_FRESH }, buf, true);
    eq('EH-AUDIT speaks during a download attempt', heard, 1);
    nc.clearDownloadAttempt('task-a');
    nc._emitHarvestAudit({ url: FC_FRESH }, buf, true);
    eq('EH-AUDIT silent after the attempt ends', heard, 1);
    nc.beginEditorWindow('task-a');
    nc._emitHarvestAudit({ url: FC_FRESH }, null, false);
    eq('EH-AUDIT speaks while an editor is open (body-fail included)', heard, 2);
    nc.endEditorWindow('task-a');
  }

  // ---------------------------------------------------------------------------
  // J. v2.48.39 — HARVEST-FIRST SPEED FIX ka faisla
  // (saveGuard.promotedEditorHarvestPick — khalis):
  // replay-context ka address FAST-DL fetch par bhejne
  // se PEHLE, is task ki editor-khidki me PROMOTED
  // mukammal body maujood ho to fetch skip hota hai aur
  // wohi body save hoti hai.
  //   (a) promoted mukammal body → skip, wohi ummeedwaar;
  //   (b) sirf adhoora jawab → skip NAHI (wo editor-
  //       harvest ke apne fetch-full raste ka hai);
  //   (c) teacher-identical / duplicate → skip NAHI;
  //   (d) kitab khaali → skip NAHI.
  // ---------------------------------------------------------------------------
  {
    const floor = 200 * 1024;
    const teacherBuf = mp4Buffer(600000);
    const freshBuf = mp4Buffer(600000);
    freshBuf[100] = 0xAB;
    const tHash = contentHash(teacherBuf);
    const fHash = contentHash(freshBuf);
    const completeEntry = { url: FC_FRESH, byteLength: 600000, floorBytes: floor, headerOk: true, partial: false, status: 200, hash: fHash, teacherHash: tHash };

    // (a) promoted mukammal body — skip, aur chuna gaya
    // ummeedwaar wohi hai (usi ka URL/index engine save
    // karega).
    const pickA = promotedEditorHarvestPick({ entries: [completeEntry], teacherUrl: FC_TEACHER, floorBytes: floor });
    eq('HF (a) promoted complete body — skip', pickA.skip, true);
    eq('HF (a) picked entry is the harvest body (url)', pickA.url, FC_FRESH);
    eq('HF (a) picked entry index', pickA.index, 0);
    eq('HF (a) picked verdict action is save', pickA.verdict && pickA.verdict.action, 'save');
    // Kitab (NetworkCapture) se asal raasta: khidki me
    // darj mukammal jawab ko engine-wali annotation ke
    // baad bhi wahi ummeedwaar chuna jata hai.
    const nc = new NetworkCapture({});
    nc.beginEditorWindow('task-hf');
    eq('HF (a) NC window records the playback body', nc._recordEditorHarvest(FC_FRESH, freshBuf, { status: 200 }, Date.now()), true);
    const book = nc.editorHarvestEntriesForKey('task-hf');
    const annotated = book.map(e => ({
      url: e.url, byteLength: e.buffer.length, headerOk: true,
      partial: !!e.partial, status: e.status, contentRange: e.contentRange,
      duplicate: false, hash: contentHash(e.buffer), teacherHash: tHash
    }));
    const pickBook = promotedEditorHarvestPick({ entries: annotated, teacherUrl: FC_TEACHER, floorBytes: floor });
    eq('HF (a) NC book entry — skip', pickBook.skip, true);
    eq('HF (a) NC book picked body is the recorded one', book[pickBook.index] && book[pickBook.index].buffer === freshBuf, true);
    nc.endEditorWindow('task-hf');
    // Tarjeeh: sab se taza mukammal jeet-ta hai; adhoora
    // sab se taza ho tab bhi purana mukammal hi chuna
    // jata hai (adhoora is skip ka ummeedwaar hi nahi).
    const older = { url: FC_FRESH, byteLength: 600000, headerOk: true, partial: false, status: 200, hash: fHash, teacherHash: tHash };
    const newerPartial = { url: FC_FRESH2, byteLength: 100000, headerOk: true, partial: true, status: 206, contentRange: 'bytes 0-99999/600000' };
    const pickPref = promotedEditorHarvestPick({ entries: [older, newerPartial], teacherUrl: FC_TEACHER, floorBytes: floor });
    eq('HF (a) newest partial does not shadow an older complete body', pickPref.skip && pickPref.url, FC_FRESH);

    // (b) sirf adhoora jawab — skip NAHI. Nishaan chahe
    // partial jhande se aaye ya 206/Content-Range se
    // (faisla fetch-full banta hai, save nahi).
    eq('HF (b) partial-flagged entry — no skip', promotedEditorHarvestPick({ entries: [{ url: FC_FRESH, byteLength: 100000, headerOk: true, partial: true, status: 206, contentRange: 'bytes 0-99999/600000' }], teacherUrl: FC_TEACHER, floorBytes: floor }).skip, false);
    eq('HF (b) 206 without the flag — no skip', promotedEditorHarvestPick({ entries: [{ url: FC_FRESH, byteLength: 600000, headerOk: true, status: 206 }], teacherUrl: FC_TEACHER, floorBytes: floor }).skip, false);
    eq('HF (b) below-floor entry — no skip', promotedEditorHarvestPick({ entries: [{ url: FC_FRESH, byteLength: 100000, headerOk: true, partial: false, status: 200 }], teacherUrl: FC_TEACHER, floorBytes: floor }).skip, false);
    // Kitab me darj asal adhoora jawab bhi skip nahi deta.
    const ncP = new NetworkCapture({});
    ncP.beginEditorWindow('task-hfp');
    ncP._recordEditorHarvest(FC_FRESH, mp4Buffer(100000), { status: 206, contentRange: 'bytes 0-99999/600000', declared: 600000 }, Date.now());
    const bookP = ncP.editorHarvestEntriesForKey('task-hfp');
    const annotatedP = bookP.map(e => ({ url: e.url, byteLength: e.buffer.length, headerOk: true, partial: !!e.partial, status: e.status, contentRange: e.contentRange, duplicate: false }));
    eq('HF (b) NC partial-only book — no skip', promotedEditorHarvestPick({ entries: annotatedP, teacherUrl: FC_TEACHER, floorBytes: floor }).skip, false);
    ncP.endEditorWindow('task-hfp');

    // (c) teacher-identical — skip NAHI (hash barabar,
    // duplicate nishaan, ya teacher ka apna URL).
    eq('HF (c) teacher-identical bytes — no skip', promotedEditorHarvestPick({ entries: [{ url: FC_FRESH, byteLength: 600000, headerOk: true, partial: false, status: 200, hash: tHash, teacherHash: tHash }], teacherUrl: FC_TEACHER, floorBytes: floor }).skip, false);
    eq('HF (c) duplicate-flagged entry — no skip', promotedEditorHarvestPick({ entries: [{ url: FC_FRESH, byteLength: 600000, headerOk: true, partial: false, status: 200, duplicate: true }], teacherUrl: FC_TEACHER, floorBytes: floor }).skip, false);
    eq('HF (c) teacher url entry — no skip', promotedEditorHarvestPick({ entries: [{ url: FC_TEACHER, byteLength: 600000, headerOk: true, partial: false, status: 200 }], teacherUrl: FC_TEACHER, floorBytes: floor }).skip, false);
    // Teacher-identical sab se taza ho aur purana saaf
    // mukammal bhi ho — saaf wala hi chuna jata hai,
    // ganda kabhi nahi.
    const pickC = promotedEditorHarvestPick({ entries: [completeEntry, { url: FC_FRESH2, byteLength: 600000, headerOk: true, partial: false, status: 200, hash: tHash, teacherHash: tHash }], teacherUrl: FC_TEACHER, floorBytes: floor });
    eq('HF (c) clean older body still picked over a dirty newer one', pickC.skip && pickC.url, FC_FRESH);

    // (d) kitab khaali / kharab input — skip NAHI.
    eq('HF (d) no entries — no skip', promotedEditorHarvestPick({ entries: [], teacherUrl: FC_TEACHER, floorBytes: floor }).skip, false);
    eq('HF (d) garbage input — no skip', promotedEditorHarvestPick(null).skip, false);
    eq('HF (d) missing entries field — no skip', promotedEditorHarvestPick({ teacherUrl: FC_TEACHER }).skip, false);
    eq('HF (d) header-broken entry — no skip', promotedEditorHarvestPick({ entries: [{ url: FC_FRESH, byteLength: 600000, headerOk: false, partial: false, status: 200 }], teacherUrl: FC_TEACHER, floorBytes: floor }).skip, false);
  }

  // ---------------------------------------------------------------------------
  // K. v2.48.40 — INVISIBLE HARVEST PACK:
  //   (a) editor-harvest ka editor BACKGROUND page par
  //       mangta hai — asal page kabhi navigate nahi
  //       hota aur front par hi rehta hai (CDP
  //       background target; warna context.newPage +
  //       asal page foran wapas front par);
  //   (b) background page nakam ho to
  //       '[ROOT] editor-harvest bg-failed <reason>' ke
  //       saath purana dikha-hua editor fallback —
  //       download kabhi peeche nahi jata;
  //   (c) background page har koshish ke baad band
  //       hota hai — kamyaabi par bhi, haar par bhi —
  //       aur us ka CDP session bhi detach hota hai;
  //   (d) cascade ka hisaab (saveGuard.cascadeVerdict +
  //       capture ki kitab): editor khulne se pehle
  //       kisi jawab me aaya address → preEditorUrl=yes
  //       aur sahi firstSeen; stream pehli dafa editor
  //       ke andar dikhe to firstSeen=editor-open.
  // ---------------------------------------------------------------------------
  // --- K ke jaali karagar: CDP client + Puppeteer page ---
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
  {
    // (a1) CDP background target — tab bandle hi nahi
    // hota: asal page na navigate, na re-front.
    const eng = new FlowAutomationEngine({ onLog: () => {} });
    const pages = [];
    const bgPage = fakePage('bg-a1');
    const ctx = {
      pages: async () => pages.slice(),
      newPage: async () => { throw new Error('newPage must not be used when the CDP background target works'); }
    };
    const mainPage = fakePage('main-a1', { context: ctx });
    pages.push(mainPage);
    bgPage._ctx = ctx;
    const browserSession = {
      sent: [],
      async send(method, params) {
        browserSession.sent.push({ method, params });
        if (method === 'Target.createTarget') pages.push(bgPage);
        return {};
      },
      async detach() {}
    };
    const fakeBrowser = { target: () => ({ createCDPSession: async () => browserSession }) };
    mainPage._browser = fakeBrowser;
    eng.page = mainPage;
    eng.browser = fakeBrowser;
    const created = await eng._createBackgroundPage();
    eq('IH (a) CDP background target returns the new page', created, bgPage);
    const ct = browserSession.sent.find(s => s.method === 'Target.createTarget');
    ok('IH (a) createTarget was asked for a BACKGROUND target', !!ct && !!ct.params && ct.params.background === true);
    eq('IH (a) the main page was never navigated', mainPage.gotoCalls.length, 0);
    eq('IH (a) the main page url is untouched', mainPage.url(), 'https://flow.google.com/project/test-project');
    eq('IH (a) the main page never had to be brought back to front', mainPage.bringToFrontCalls, 0);
  }
  {
    // (a2) CDP rasta na ho to context.newPage — aur
    // asal page FORAN wapas front par (wohi rehta hai
    // jo owner dekhta hai); navigate kabhi nahi hota.
    const eng = new FlowAutomationEngine({ onLog: () => {} });
    const bgPage = fakePage('bg-a2');
    let newPageCalls = 0;
    const ctx = {
      pages: async () => [],
      newPage: async () => { newPageCalls++; return bgPage; }
    };
    const mainPage = fakePage('main-a2', { context: ctx });
    eng.page = mainPage;
    eng.browser = {};
    const created = await eng._createBackgroundPage();
    eq('IH (a) fallback creates the page in the same context', created, bgPage);
    eq('IH (a) fallback newPage called once', newPageCalls, 1);
    eq('IH (a) fallback restores the main page to front at once', mainPage.bringToFrontCalls, 1);
    eq('IH (a) fallback never navigates the main page', mainPage.gotoCalls.length, 0);
  }
  {
    // (a3) poora harvest-editor rasta: capture bg page
    // par lagta hai, viewer bg page par khulta hai,
    // asal page bilkul waisa hi rehta hai.
    const eng = new FlowAutomationEngine({ onLog: () => {} });
    const mainPage = fakePage('main-a3');
    const bgPage = fakePage('bg-a3');
    eng.page = mainPage;
    eng._createBackgroundPage = async () => bgPage;
    let attachedPage = null;
    eng.netCapture.attachBackgroundPage = async (p) => { attachedPage = p; return true; };
    eng.netCapture.detachBackgroundPage = async () => {};
    let viewerPage = 'unset';
    eng._openTileViewer = async (task, hint, tag, pageOverride) => {
      viewerPage = pageOverride;
      return { opened: true, alreadyOpen: false, tileMissing: false, anchor: Date.now() };
    };
    const res = await eng._openHarvestEditor({ promptIndex: 0, captureKey: 'k-ih-a' }, 0, 'k-ih-a');
    eq('IH (a) the harvest editor opens', res.editorOpen, true);
    eq('IH (a) the harvest editor is the background one', res.bg, true);
    eq('IH (a) capture attached to the background page', attachedPage, bgPage);
    eq('IH (a) the tile viewer opened on the background page', viewerPage, bgPage);
    eq('IH (a) the background page navigated to the project', bgPage.gotoCalls.length, 1);
    eq('IH (a) the main page stayed on the grid, never navigated', mainPage.gotoCalls.length, 0);
    ok('IH (a) the background session is live for the task', eng._bgHarvestActiveFor('k-ih-a'));
    await eng._closeBgEditorSession();
    // Page-parameter wale helpers asal me diye gaye
    // page ko hi padhte hain (asal page ko nahi).
    const engP = new FlowAutomationEngine({ onLog: () => {} });
    engP.page = fakePage('main-a4', { evaluateResult: { found: false } });
    const bgEditor = fakePage('bg-a4', { url: 'https://flow.google.com/project/test-project/edit/xyz', evaluateResult: { found: false } });
    eq('IH (a) inEditorView reads the GIVEN page (editor url)', await engP._inEditorView(bgEditor), true);
    eq('IH (a) inEditorView on the main page stays on the grid', await engP._inEditorView(), false);
  }
  {
    // (b1) background page hi na bane → bg-failed line
    // + purana (asal page wala) editor fallback.
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) });
    eng.page = fakePage('main-b1');
    eng._createBackgroundPage = async () => { throw new Error('boom'); };
    let fallbackPageArg = 'unset';
    eng._openTileViewer = async (task, hint, tag, pageOverride) => {
      fallbackPageArg = pageOverride;
      return { opened: true, alreadyOpen: false, tileMissing: false, anchor: Date.now() };
    };
    const res = await eng._openHarvestEditor({ promptIndex: 0, captureKey: 'k-ih-b' }, 0, 'k-ih-b');
    eq('IH (b) the fallback still opens an editor', res.editorOpen, true);
    eq('IH (b) the fallback editor is not the background one', res.bg, false);
    eq('IH (b) the fallback opens the viewer on the main page (no override)', fallbackPageArg, undefined);
    ok('IH (b) the bg-failed line was logged with its reason', logs.some(m => m.includes('[ROOT] editor-harvest bg-failed page-create-failed')));
  }
  {
    // (b2) capture attach nakam → nakam background
    // page band hota hai, session nahi rehta, aur
    // bg-failed ke saath purana rasta chalta hai.
    const logs = [];
    const eng = new FlowAutomationEngine({ onLog: (e) => logs.push(e.message) });
    eng.page = fakePage('main-b2');
    const bgPage = fakePage('bg-b2');
    eng._createBackgroundPage = async () => bgPage;
    eng.netCapture.attachBackgroundPage = async () => false;
    eng.netCapture.detachBackgroundPage = async () => {};
    eng._openTileViewer = async () => ({ opened: true, alreadyOpen: false, tileMissing: false, anchor: Date.now() });
    const res = await eng._openHarvestEditor({ promptIndex: 0, captureKey: 'k-ih-b2' }, 0, 'k-ih-b2');
    eq('IH (b) attach failure still opens the fallback editor', res.editorOpen, true);
    eq('IH (b) attach failure is not the background route', res.bg, false);
    ok('IH (b) attach failure logged bg-failed capture-attach-failed', logs.some(m => m.includes('[ROOT] editor-harvest bg-failed capture-attach-failed')));
    eq('IH (b) the failed background page was closed, not left open', bgPage.closeCalls, 1);
    eq('IH (b) no background session is left behind', eng._bgEditorSession, null);
  }
  {
    // (c1) harvest wrapper: background page kamyaabi
    // par bhi band, haar par bhi band — aur capture
    // session bhi detach hota hai.
    for (const innerResult of [{ done: true, editorOpen: true }, { done: false, editorOpen: true }]) {
      const eng = new FlowAutomationEngine({ onLog: () => {} });
      eng.page = fakePage('main-c1');
      const bgPage = fakePage('bg-c1');
      let detachCalls = 0;
      eng.netCapture.detachBackgroundPage = async () => { detachCalls++; };
      eng._bgEditorSession = { page: bgPage, key: 'k-ih-c', at: Date.now() };
      eng._tryEditorHarvestInner = async () => innerResult;
      const out = await eng._tryEditorHarvest({ promptIndex: 0 }, '/tmp', {}, [], 'k-ih-c', 0, {});
      eq(`IH (c) the harvest result passes through (done=${innerResult.done})`, out.done, innerResult.done);
      eq(`IH (c) the background page is closed after the attempt (done=${innerResult.done})`, bgPage.closeCalls, 1);
      eq(`IH (c) the background capture is detached after the attempt (done=${innerResult.done})`, detachCalls, 1);
      eq(`IH (c) no background session remains (done=${innerResult.done})`, eng._bgEditorSession, null);
    }
    const engIdle = new FlowAutomationEngine({ onLog: () => {} });
    await engIdle._closeBgEditorSession();
    eq('IH (c) closing with no session is a no-op', engIdle._bgEditorSession, null);
  }
  {
    // (c2) capture ki asal wiring: background page ki
    // stream wohi editor-khidki kitab me jati hai, aur
    // detach par session band hota hai.
    const nc = new NetworkCapture({});
    const body = mp4Buffer(600000);
    const client = fakeCdpClient(() => ({ body: body.toString('base64'), base64Encoded: true }));
    const bgPage = fakePage('bg-c2', { cdpClient: client });
    eq('IH (c) NC background attach succeeds', await nc.attachBackgroundPage(bgPage), true);
    ok('IH (c) NC background session enabled Network', client.sent.some(s => s.method === 'Network.enable'));
    nc.beginEditorWindow('k-ih-c2');
    client.handlers['Network.responseReceived']({
      requestId: 'bg-1',
      response: { url: FC_FRESH, status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) } }
    });
    await client.handlers['Network.loadingFinished']({ requestId: 'bg-1', encodedDataLength: body.length });
    const entries = nc.editorHarvestEntriesForKey('k-ih-c2');
    eq('IH (c) NC background stream lands in the task editor book', entries.length, 1);
    eq('IH (c) NC background entry keeps the exact bytes', entries.length === 1 ? entries[0].buffer.length : 0, body.length);
    // Wahi stream cascade me 'editor-open' hai (editor
    // khulne ke BAAD pehli dafa dikhi).
    const casc = nc.cascadeForKey('k-ih-c2', FC_FRESH);
    eq('IH (d) NC stream first seen inside the editor window is editor-open', casc.firstSeen, 'editor-open');
    eq('IH (d) NC stream inside the editor is not pre-editor', casc.preEditorUrl, 'no');
    nc.endEditorWindow('k-ih-c2');
    await nc.detachBackgroundPage();
    eq('IH (c) NC background session detached', client.detached, true);
    const ncBad = new NetworkCapture({});
    const badPage = { target: () => { throw new Error('no target'); } };
    eq('IH (c) NC background attach failure is false, not a throw', await ncBad.attachBackgroundPage(badPage), false);
  }
  {
    // (d) cascade ka khalis hisaab — har qisam, dono
    // jawaab.
    eq('IH (d) project-data before the editor — firstSeen', cascadeVerdict({ observation: { at: 1000, kind: 'project-data' }, editorOpenedAt: 2000 }).firstSeen, 'project-data');
    eq('IH (d) project-data before the editor — preEditorUrl', cascadeVerdict({ observation: { at: 1000, kind: 'project-data' }, editorOpenedAt: 2000 }).preEditorUrl, 'yes');
    eq('IH (d) mint-response before the editor — firstSeen', cascadeVerdict({ observation: { at: 1000, kind: 'mint-response' }, editorOpenedAt: 2000 }).firstSeen, 'mint-response');
    eq('IH (d) mint-response before the editor — preEditorUrl', cascadeVerdict({ observation: { at: 1000, kind: 'mint-response' }, editorOpenedAt: 2000 }).preEditorUrl, 'yes');
    eq('IH (d) stream before the editor stays stream-get', cascadeVerdict({ observation: { at: 1000, kind: 'stream-get' }, editorOpenedAt: 2000 }).firstSeen, 'stream-get');
    eq('IH (d) stream before the editor — preEditorUrl', cascadeVerdict({ observation: { at: 1000, kind: 'stream-get' }, editorOpenedAt: 2000 }).preEditorUrl, 'yes');
    eq('IH (d) stream first seen inside the editor is editor-open', cascadeVerdict({ observation: { at: 3000, kind: 'stream-get' }, editorOpenedAt: 2000 }).firstSeen, 'editor-open');
    eq('IH (d) stream inside the editor — preEditorUrl no', cascadeVerdict({ observation: { at: 3000, kind: 'stream-get' }, editorOpenedAt: 2000 }).preEditorUrl, 'no');
    eq('IH (d) mint-response after the editor keeps its label', cascadeVerdict({ observation: { at: 3000, kind: 'mint-response' }, editorOpenedAt: 2000 }).firstSeen, 'mint-response');
    eq('IH (d) mint-response after the editor — preEditorUrl no', cascadeVerdict({ observation: { at: 3000, kind: 'mint-response' }, editorOpenedAt: 2000 }).preEditorUrl, 'no');
    eq('IH (d) project-data after the editor — preEditorUrl no', cascadeVerdict({ observation: { at: 3000, kind: 'project-data' }, editorOpenedAt: 2000 }).preEditorUrl, 'no');
    eq('IH (d) nothing seen — firstSeen none', cascadeVerdict({ observation: null, editorOpenedAt: 2000 }).firstSeen, 'none');
    eq('IH (d) nothing seen — preEditorUrl no', cascadeVerdict({ observation: null, editorOpenedAt: 2000 }).preEditorUrl, 'no');
    eq('IH (d) no editor ever opened — preEditorUrl yes', cascadeVerdict({ observation: { at: 1000, kind: 'project-data' }, editorOpenedAt: null }).preEditorUrl, 'yes');
    eq('IH (d) garbage input — none/no', JSON.stringify(cascadeVerdict(null)), JSON.stringify({ firstSeen: 'none', preEditorUrl: 'no' }));
    // Capture kitab: sirf PEHLI nazar rehti hai, aur
    // naya attempt editor-ghadi taaza karta hai.
    const nc = new NetworkCapture({});
    nc._noteUrlFirstSeen(FC_FRESH, 'project-data', 1000);
    nc._noteUrlFirstSeen(FC_FRESH, 'stream-get', 500);
    eq('IH (d) NC the first sighting wins over later ones', nc._urlFirstSeen.get(FC_FRESH).kind, 'project-data');
    nc._editorOpenedAtByKey.set('k-ih-d', 2000);
    const c1 = nc.cascadeForKey('k-ih-d', FC_FRESH);
    eq('IH (d) NC pre-editor project-data — firstSeen', c1.firstSeen, 'project-data');
    eq('IH (d) NC pre-editor project-data — preEditorUrl', c1.preEditorUrl, 'yes');
    eq('IH (d) NC unseen url — firstSeen none', nc.cascadeForKey('k-ih-d', FC_FRESH2).firstSeen, 'none');
    nc.setDownloadAttempt('k-ih-d');
    eq('IH (d) NC a fresh attempt clears the editor clock', nc._editorOpenedAtByKey.has('k-ih-d'), false);
  }

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.log(`FAIL  suite crashed — ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
