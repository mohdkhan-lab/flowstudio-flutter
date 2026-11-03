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
// bound id for the replay step. v2.48.34 adds the URL side:
// findIdOccurrencesInText / substituteIdsInUrl, and the
// learn wiring recording urlPrimaryId + idsInUrl (the live
// test's body held no id at all — the URL is the next place
// the id can travel).
// Usage: node test_js/run_mint_replay_tests.js

const {
  findIdOccurrences,
  countOccurrences,
  substituteIds,
  findIdOccurrencesInText,
  substituteIdsInUrl,
  classifyVerbatimProbe
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

// --- findIdOccurrencesInText / substituteIdsInUrl: URL wala hisaab (v2.48.34) ---
{
  const url = `https://flow.google.com/x?rpcids=AbCdEf&a=${TEACHER}&b=${TEACHER}`;
  const occ = findIdOccurrencesInText(url, [TEACHER]);
  eq('UFIND one id entry', occ.length, 1);
  eq('UFIND id echoed', occ[0].id, TEACHER);
  eq('UFIND two occurrences', occ[0].offsets.length, 2);
  eq('UFIND first offset', occ[0].offsets[0], url.indexOf(TEACHER));
  eq('UFIND second offset', occ[0].offsets[1], url.indexOf(TEACHER, occ[0].offsets[0] + 1));
  eq('UCOUNT totals occurrences', countOccurrences(occ), 2);
  eq('UFIND absent id gives no entry', findIdOccurrencesInText(url, [STUDENT]).length, 0);
  eq('UFIND duplicate ids deduped', findIdOccurrencesInText(url, [TEACHER, TEACHER]).length, 1);
  eq('UFIND empty id skipped', findIdOccurrencesInText(url, ['']).length, 0);
  eq('UFIND empty list', findIdOccurrencesInText(url, []).length, 0);
  eq('UFIND null text', findIdOccurrencesInText(null, [TEACHER]).length, 0);
  eq('UFIND empty text', findIdOccurrencesInText('', [TEACHER]).length, 0);
  eq('UFIND needle longer than text', findIdOccurrencesInText('ab', [TEACHER]).length, 0);

  const r = substituteIdsInUrl(url, [[TEACHER, STUDENT]]);
  eq('USUB replacements counted', r.replacements, 2);
  eq('USUB result has student twice', r.url.split(STUDENT).length - 1, 2);
  ok('USUB teacher fully gone', !r.url.includes(TEACHER));

  // Alag lambai: chhota -> lamba, sahi jagah par.
  const grow = substituteIdsInUrl('https://h/x?id=ID&z=1', [['ID', 'LONGER-ID']]);
  eq('USUB length grows correctly', grow.url, 'https://h/x?id=LONGER-ID&z=1');
  eq('USUB growth replacements', grow.replacements, 1);
  const shrink = substituteIdsInUrl('https://h/x?id=LONGER-ID', [['LONGER-ID', 'ID']]);
  eq('USUB length shrinks correctly', shrink.url, 'https://h/x?id=ID');

  // '$' wale pattern lafz-ba-lafz: regex hota to '$&' apna
  // khaas matlab le aata — yahan seedha badlaav hota hai.
  const dollar = substituteIdsInUrl('https://h/x?id=ID', [['ID', 'A$&B']]);
  eq('USUB dollar sequence stays literal', dollar.url, 'https://h/x?id=A$&B');

  // No-id / bekaar jodiyan.
  eq('USUB no pairs is null', substituteIdsInUrl(url, []), null);
  eq('USUB null pairs is null', substituteIdsInUrl(url, null), null);
  eq('USUB same-id pair is null', substituteIdsInUrl(url, [[TEACHER, TEACHER]]), null);
  eq('USUB empty from is null', substituteIdsInUrl(url, [['', STUDENT]]), null);
  eq('USUB empty to is null', substituteIdsInUrl(url, [[TEACHER, '']]), null);
  eq('USUB empty url is null', substituteIdsInUrl('', [[TEACHER, STUDENT]]), null);
  eq('USUB non-string url is null', substituteIdsInUrl(null, [[TEACHER, STUDENT]]), null);

  // ID URL me hai hi nahi: natija banta hai lekin 0 badlaav.
  const none = substituteIdsInUrl(url, [[STUDENT, 'cccccccc-9999-8888-7777-666666666666']]);
  eq('USUB absent id replaces 0', none.replacements, 0);
  eq('USUB absent id url unchanged', none.url, url);

  // Do jodiyan tartib se: pehli ka natija dusri ka medaan.
  const two = substituteIdsInUrl(`https://h/x?a=${TEACHER}&b=${STUDENT}`,
    [[TEACHER, 'tttttttt-0000-0000-0000-000000000000'], [STUDENT, 'ssssssss-0000-0000-0000-000000000000']]);
  eq('USUB two pairs both applied', two.replacements, 2);
  ok('USUB two pairs result clean', !two.url.includes(TEACHER) && !two.url.includes(STUDENT));
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
  eq('LEARN callback idsInUrl is 0 when the url holds no id', learned.idsInUrl, 0);
  eq('LEARN template urlPrimaryId is null when the url holds no id', nc.mintTemplate.urlPrimaryId, null);
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
  eq('LEARN no-id idsInUrl is 0', learned.idsInUrl, 0);
  eq('LEARN no-id urlPrimaryId is null', nc3.mintTemplate.urlPrimaryId, null);

  // v2.48.34: ID sirf URL me ho (body khaali) — ZEROCLICK
  // live test wali asal surat. Template banta hai, body
  // primaryId null rehta hai, urlPrimaryId teacher ka ID,
  // khabar me idsInBody=0 / idsInUrl=1, aur ID ki qeemat
  // khabar me kabhi nahi.
  const nc5 = new NetworkCapture({ onMintTemplate: (i) => { learned = i; } });
  nc5.beginSubmission('task-5', Date.now());
  nc5._bindId(TEACHER, Date.now());
  nc5.setMintWatch(true, 'task-5');
  const URL_WITH_ID = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=AbCdEf&media=${TEACHER}`;
  nc5._checkMintCarries('POST', URL_WITH_ID, null, 'see https://flow-content.google/video/xyz',
    { url: URL_WITH_ID, method: 'POST', headers: {}, body: Buffer.from('f.req=[[["AbCdEf","[]"]]]') });
  ok('LEARN url-only template stored', !!nc5.mintTemplate);
  eq('LEARN url-only body primaryId is null', nc5.mintTemplate.primaryId, null);
  eq('LEARN url-only urlPrimaryId is the task id', nc5.mintTemplate.urlPrimaryId, TEACHER);
  eq('LEARN url-only idsInBody is 0', learned.idsInBody, 0);
  eq('LEARN url-only idsInUrl counts the url occurrence', learned.idsInUrl, 1);
  ok('LEARN url-only callback never carries the id itself', !JSON.stringify(learned).includes(TEACHER));

  // v2.48.34: ID body AUR url dono me — dono ginti alag,
  // dono primary darj.
  const nc6 = new NetworkCapture({ onMintTemplate: (i) => { learned = i; } });
  nc6.beginSubmission('task-6', Date.now());
  nc6._bindId(STUDENT, Date.now());
  nc6.setMintWatch(true, 'task-6');
  const URL_BOTH = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=AbCdEf&m=${STUDENT}&n=${STUDENT}`;
  nc6._checkMintCarries('POST', URL_BOTH, null, 'see https://flow-content.google/video/xyz',
    { url: URL_BOTH, method: 'POST', headers: {}, body: Buffer.from(`f.req=[[["AbCdEf","[\\"${STUDENT}\\"]"]]]`) });
  ok('LEARN both template stored', !!nc6.mintTemplate);
  eq('LEARN both primaryId is the task id', nc6.mintTemplate.primaryId, STUDENT);
  eq('LEARN both urlPrimaryId is the task id', nc6.mintTemplate.urlPrimaryId, STUDENT);
  eq('LEARN both idsInBody counts the body occurrence', learned.idsInBody, 1);
  eq('LEARN both idsInUrl counts both url occurrences', learned.idsInUrl, 2);

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

// ---------------------------------------------------------------------------
// v2.48.35: classifyVerbatimProbe — hu-bahu (verbatim) replay
// ke jawab ki warg-bandi. Jawab address le aaye aur wo
// TEACHER ka hi ho → 'same' (call context-bound nahi);
// alag address → 'different' (context-bound ka saboot);
// address hi na aaye ya muqabla mumkin na ho → 'n/a'.
// ---------------------------------------------------------------------------
{
  const T = 'https://flow-content.google/video/teacher-media';
  const O = 'https://flow-content.google/video/other-media';

  let v = classifyVerbatimProbe({ carriesUrl: false, urls: [], teacherUrl: T });
  eq('PROBE no url carried — carriesUrl', v.carriesUrl, false);
  eq('PROBE no url carried — verdict', v.urlVsTeacher, 'n/a');

  v = classifyVerbatimProbe({ carriesUrl: true, urls: [T], teacherUrl: T });
  eq('PROBE teacher url back — carriesUrl', v.carriesUrl, true);
  eq('PROBE teacher url back — verdict same', v.urlVsTeacher, 'same');

  v = classifyVerbatimProbe({ carriesUrl: true, urls: [O], teacherUrl: T });
  eq('PROBE different url back — verdict different', v.urlVsTeacher, 'different');

  v = classifyVerbatimProbe({ carriesUrl: true, urls: [O, T], teacherUrl: T });
  eq('PROBE teacher among several — verdict same', v.urlVsTeacher, 'same');

  v = classifyVerbatimProbe({ carriesUrl: true, urls: [O], teacherUrl: null });
  eq('PROBE teacher url unknown — verdict n/a', v.urlVsTeacher, 'n/a');

  v = classifyVerbatimProbe({ carriesUrl: true, urls: [], teacherUrl: T });
  eq('PROBE carried host but no url extracted — verdict n/a', v.urlVsTeacher, 'n/a');

  v = classifyVerbatimProbe(null);
  eq('PROBE garbage input — carriesUrl', v.carriesUrl, false);
  eq('PROBE garbage input — verdict', v.urlVsTeacher, 'n/a');

  v = classifyVerbatimProbe({});
  eq('PROBE empty input — verdict', v.urlVsTeacher, 'n/a');
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed ? 1 : 0);
