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
  replayUrlVerdict
} = require('../engine/saveGuard');
const { classifyVerbatimProbe } = require('../engine/mintReplay');
const { NetworkCapture } = require('../engine/networkCapture');

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

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.log(`FAIL  suite crashed — ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
