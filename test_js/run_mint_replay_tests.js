'use strict';

// v2.48.33 (ZEROCLICK): the pure id-substitution logic in
// engine/mintReplay.js (occurrence finding with byte offsets,
// total counting, byte-level substitution — multiple
// occurrences, different-length ids, the no-id case) plus the
// NetworkCapture mint-template LEARN wiring: a batchexecute
// response that carries the file host teaches the template
// (only while the mint watch is on, only with the round's
// task key), the learned line carries shape only, an identical
// re-learn stays silent, and workflowIdForKey reports the
// bound id for the replay step.
// Usage: node test_js/run_mint_replay_tests.js

const {
  findIdOccurrences,
  countOccurrences,
  substituteIds
} = require('../engine/mintReplay');
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

const TEACHER = 'aaaaaaaa-1111-2222-3333-444444444444';
const STUDENT = 'bbbbbbbb-5555-6666-7777-888888888888';

// --- findIdOccurrences: offsets, multiples, misses ---
{
  const body = Buffer.from(`{"a":"${TEACHER}","b":"x${TEACHER}y"}`, 'utf8');
  const occ = findIdOccurrences(body, [TEACHER]);
  eq('FIND one id entry', occ.length, 1);
  eq('FIND id echoed', occ[0].id, TEACHER);
  eq('FIND two occurrences', occ[0].offsets.length, 2);
  eq('FIND first offset', occ[0].offsets[0], body.indexOf(TEACHER));
  eq('FIND second offset', occ[0].offsets[1], body.indexOf(TEACHER, occ[0].offsets[0] + 1));
  eq('COUNT totals occurrences', countOccurrences(occ), 2);

  eq('FIND absent id gives no entry', findIdOccurrences(body, [STUDENT]).length, 0);
  eq('FIND duplicate ids deduped', findIdOccurrences(body, [TEACHER, TEACHER]).length, 1);
  eq('FIND empty id skipped', findIdOccurrences(body, ['']).length, 0);
  eq('FIND empty list', findIdOccurrences(body, []).length, 0);
  eq('FIND null body', findIdOccurrences(null, [TEACHER]).length, 0);
  eq('FIND needle longer than body', findIdOccurrences(Buffer.from('ab'), [TEACHER]).length, 0);
  eq('COUNT of nothing is 0', countOccurrences([]), 0);
  eq('COUNT of null is 0', countOccurrences(null), 0);

  // Do IDs ek saath: dono ki alag fehrist, tartib wahi jo di gayi.
  const both = findIdOccurrences(Buffer.from(`${STUDENT}|${TEACHER}|${STUDENT}`), [TEACHER, STUDENT]);
  eq('FIND both ids found', both.length, 2);
  eq('FIND order follows input', both[0].id, TEACHER);
  eq('FIND student occurs twice', both[1].offsets.length, 2);
  eq('COUNT across ids', countOccurrences(both), 3);
}

// --- substituteIds: correctness ---
{
  const body = Buffer.from(`{"id":"${TEACHER}","again":"${TEACHER}"}`, 'utf8');
  const r = substituteIds(body, [[TEACHER, STUDENT]]);
  eq('SUB replacements counted', r.replacements, 2);
  eq('SUB result has student twice', r.body.toString('utf8').split(STUDENT).length - 1, 2);
  ok('SUB teacher fully gone', !r.body.toString('utf8').includes(TEACHER));

  // Alag lambai: chhota -> lamba aur lamba -> chhota, dono sahi.
  const short = substituteIds(Buffer.from('xIDyIDz'), [['ID', 'LONGER-ID']]);
  eq('SUB length grows correctly', short.body.toString('utf8'), 'xLONGER-IDyLONGER-IDz');
  eq('SUB growth replacements', short.replacements, 2);
  const shrink = substituteIds(Buffer.from('xLONGER-IDy'), [['LONGER-ID', 'ID']]);
  eq('SUB length shrinks correctly', shrink.body.toString('utf8'), 'xIDy');

  // No-id / bekaar jodiyan.
  eq('SUB no pairs is null', substituteIds(body, []), null);
  eq('SUB null pairs is null', substituteIds(body, null), null);
  eq('SUB same-id pair is null', substituteIds(body, [[TEACHER, TEACHER]]), null);
  eq('SUB empty from is null', substituteIds(body, [['', STUDENT]]), null);
  eq('SUB empty to is null', substituteIds(body, [[TEACHER, '']]), null);
  eq('SUB non-buffer body is null', substituteIds('text', [[TEACHER, STUDENT]]), null);

  // ID body me hai hi nahi: natija banta hai lekin 0 badlaav.
  const none = substituteIds(body, [[STUDENT, 'cccccccc-9999-8888-7777-666666666666']]);
  eq('SUB absent id replaces 0', none.replacements, 0);
  ok('SUB absent id body unchanged', none.body.equals(body));

  // Aadha kata hua (partial) match kabhi nahi badalta.
  const partial = substituteIds(Buffer.from(`pre${TEACHER.slice(0, 20)}`), [[TEACHER, STUDENT]]);
  eq('SUB partial match untouched', partial.replacements, 0);
}

// --- NetworkCapture: mint template seekhna ---
{
  const BATCH_URL = 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=AbCdEf&f.sid=123';
  let learned = null;
  let learnedCount = 0;
  const nc = new NetworkCapture({
    onMintTemplate: (info) => { learned = info; learnedCount++; }
  });
  // Task bandho taaki us ka workflowId capture ko maloom ho.
  nc.beginSubmission('task-1', Date.now());
  const subKey = 'task-1';
  nc._bindId(TEACHER, Date.now());
  eq('LEARN workflowIdForKey reports the bound id', nc.workflowIdForKey(subKey), TEACHER);
  eq('LEARN workflowIdForKey unknown key is null', nc.workflowIdForKey('nope'), null);
  eq('LEARN workflowIdForKey null key is null', nc.workflowIdForKey(null), null);

  const reqBody = Buffer.from(`f.req=[[["AbCdEf","[\\"${TEACHER}\\",\\"${TEACHER}\\"]"]]]`, 'utf8');
  const tpl = {
    url: BATCH_URL, method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: reqBody
  };

  // Watch OFF: carries bhi ho to seekhna nahi hota.
  nc._checkMintCarries('POST', BATCH_URL, null, 'see https://flow-content.google/video/xyz', tpl);
  eq('LEARN watch off learns nothing', nc.mintTemplate, null);
  eq('LEARN watch off fires no callback', learnedCount, 0);

  // Watch ON (is task ke naam): template banta hai.
  nc.setMintWatch(true, subKey);
  nc._checkMintCarries('POST', BATCH_URL, null, 'see https://flow-content.google/video/xyz', tpl);
  ok('LEARN template stored', !!nc.mintTemplate);
  eq('LEARN template url kept whole', nc.mintTemplate.url, BATCH_URL);
  eq('LEARN template method', nc.mintTemplate.method, 'POST');
  eq('LEARN template taskKey', nc.mintTemplate.taskKey, subKey);
  eq('LEARN template primaryId is the task id', nc.mintTemplate.primaryId, TEACHER);
  eq('LEARN callback fired once', learnedCount, 1);
  eq('LEARN callback taskKey', learned.taskKey, subKey);
  eq('LEARN callback bodyBytes', learned.bodyBytes, reqBody.length);
  eq('LEARN callback idsInBody counts both occurrences', learned.idsInBody, 2);
  ok('LEARN callback rpcids listed', Array.isArray(learned.rpcids) && learned.rpcids.includes('AbCdEf'));
  ok('LEARN callback never carries the id itself', !JSON.stringify(learned).includes(TEACHER));

  // Bilkul wahi template dobara: khabar dobara nahi.
  nc._checkMintCarries('POST', BATCH_URL, null, 'see https://flow-content.google/video/xyz', tpl);
  eq('LEARN identical template stays silent', learnedCount, 1);

  // Carries NA ho to (template saath ho tab bhi) kuch nahi seekhta.
  const nc2 = new NetworkCapture({ onMintTemplate: () => { learnedCount++; } });
  nc2.beginSubmission('task-2', Date.now());
  nc2._bindId(STUDENT, Date.now());
  nc2.setMintWatch(true, 'task-2');
  nc2._checkMintCarries('POST', BATCH_URL, null, 'no file address in this response', tpl);
  eq('LEARN no-carries learns nothing', nc2.mintTemplate, null);

  // Template hi na aaya ho (Location wali khabar) to bhi nahi.
  nc2._checkMintCarries('POST', BATCH_URL, 'https://flow-content.google/video/xyz', null, null);
  eq('LEARN location-only learns nothing', nc2.mintTemplate, null);

  // ID body me na mile: template banta hai, primaryId null,
  // idsInBody 0 — yahi H2 taraf ka pehla saboot hoga.
  const nc3 = new NetworkCapture({ onMintTemplate: (i) => { learned = i; } });
  nc3.beginSubmission('task-3', Date.now());
  nc3._bindId(STUDENT, Date.now());
  nc3.setMintWatch(true, 'task-3');
  nc3._checkMintCarries('POST', BATCH_URL, null, 'see https://flow-content.google/video/xyz',
    { url: BATCH_URL, method: 'POST', headers: {}, body: Buffer.from('f.req=[[["AbCdEf","[]"]]]') });
  ok('LEARN no-id template still stored', !!nc3.mintTemplate);
  eq('LEARN no-id primaryId is null', nc3.mintTemplate.primaryId, null);
  eq('LEARN no-id idsInBody is 0', learned.idsInBody, 0);

  // Batchexecute na ho to template nahi banta (status-call
  // wali shakal is seekhne se bahar hai).
  const nc4 = new NetworkCapture({});
  nc4.beginSubmission('task-4', Date.now());
  nc4._bindId(TEACHER, Date.now());
  nc4.setMintWatch(true, 'task-4');
  nc4._checkMintCarries('POST', 'https://flow.google.com/other/path', null, 'see https://flow-content.google/video/xyz',
    { url: 'https://flow.google.com/other/path', method: 'POST', headers: {}, body: reqBody });
  eq('LEARN non-batchexecute learns nothing', nc4.mintTemplate, null);

  // Watch band hone par task ki pehchan saaf, template rehta hai.
  nc.setMintWatch(false);
  eq('LEARN watch off clears the round task key', nc._mintTaskKey, null);
  ok('LEARN template survives watch off', !!nc.mintTemplate);
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed ? 1 : 0);
