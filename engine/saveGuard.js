'use strict';

// v2.48.35 (GUARD): cross-task contamination ke khilaf KHALIS
// (pure) faisla-layer — koi I/O nahi, sirf crypto hash + hisaab,
// is liye unit tests seedha is par chalte hain (mintReplay.js /
// blobHarvest.js wali hi tarz).
//
// SABOOT (ZEROCLICK2, v2.48.34, owner ke PC par engine log +
// asal files se MK-verified, 2026-11-03): 2-prompt run me
// Prompt #2 ki download koshish ne Prompt #1 ki file ko hi
// Prompt #2 ke naam par save kar diya (registry opportunistic
// save, gap=0.3s) — dono files byte-identical (1,216,989B)
// theen aur #2 ke frame me laal ball thi, neeli car nahi. Run
// ne phir bhi "all 2 saved" ki jhooti kamyabi di. Wajah: koi
// bhi rasta ye nahi jaanchta tha ke jo bytes save ho rahe
// hain, wo is run me KISI AUR task ke naam par pehle hi save
// ho chuke hain.
//
// Ye module wahi jaanch deta hai:
//   contentHash(buffer)      — bytes ki pehchan (sha256 hex).
//                              Hash kabhi LOG nahi hota — ye
//                              sirf engine ki andarooni kitab
//                              hai (shape-only discipline).
//   checkDuplicate(reg, key, hash)
//                            — is run me ye hash kisi AUR task
//                              ke naam darj hai to duplicate
//                              (reject); apne hi task ke naam
//                              ho to re-save jaiz (allow); pehli
//                              dafa ho to allow.
//   recordSave(reg, key, hash, promptIndex)
//                            — kamyaab save ki kitab-bandhi.
//   claimedByOtherTask(ownerKey, taskKey)
//                            — claim discipline ka khalis
//                              usool: bandha hua URL kisi AUR
//                              task ke naam ho to is task ke
//                              liye kabhi qabil nahi.

const crypto = require('crypto');

/** Bytes ki pehchan (sha256 hex); khaali/ghalat input par null. */
function contentHash(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } catch (e) {
    return null;
  }
}

/**
 * Is run ki saved-hash kitab (Map<hash, {key, promptIndex}>)
 * me is hash ka faisla:
 *   { duplicate:false }                                  — save jaiz hai
 *   { duplicate:true, otherKey, otherPromptIndex }       — ye bytes
 *     kisi AUR task ke naam pehle hi save ho chuke hain; reject.
 * Registry / key / hash me se kuch bhi ghayab ho to allow —
 * guard apni hi khami par kisi save ko nahi rokta (baaki
 * pehchan-darwaze apni jagah barkarar hain).
 */
function checkDuplicate(registry, taskKey, hash) {
  try {
    if (!registry || typeof registry.get !== 'function') return { duplicate: false };
    if (!taskKey || !hash) return { duplicate: false };
    const owner = registry.get(hash);
    if (!owner) return { duplicate: false };
    if (owner.key === taskKey) return { duplicate: false };
    return {
      duplicate: true,
      otherKey: owner.key,
      otherPromptIndex: Number.isInteger(owner.promptIndex) ? owner.promptIndex : -1
    };
  } catch (e) {
    return { duplicate: false };
  }
}

/**
 * Ek kamyaab save ki kitab-bandhi. Pehla malik hi rehta hai —
 * ek hash par dusri kitab-bandhi use badal nahi sakti (guard
 * se guzar kar dusra task wahan pahunch hi nahi sakta, aur
 * race me apne hi task ki dobara bandhi bekaar hai).
 */
function recordSave(registry, taskKey, hash, promptIndex) {
  try {
    if (!registry || typeof registry.set !== 'function' || typeof registry.has !== 'function') return;
    if (!taskKey || !hash) return;
    if (registry.has(hash)) return;
    registry.set(hash, {
      key: taskKey,
      promptIndex: Number.isInteger(promptIndex) ? promptIndex : -1
    });
  } catch (e) {}
}

/**
 * Claim discipline ka khalis usool (_pickServerFetchUrl wali
 * hi pehchan): URL pehle se bandha (claimed) ho AUR bandhan
 * is task ka na ho → ye URL is task ka ho hi nahi sakta.
 * Bandhan na ho, ya is task ka apna ho → inkaar nahi.
 */
function claimedByOtherTask(ownerKey, taskKey) {
  return !!ownerKey && ownerKey !== taskKey;
}

// ---------------------------------------------------------------------------
// v2.48.36 (ROOT PACK — D): PAGE-FETCH HARVEST ke darwaze.
//
// Page khud editor ke preview/playback par asal server file
// (flow-content.google/video/*) ke bytes khinchta hai — wohi
// bytes exact server file hain. Capture unhe yaad rakhe ya
// na rakhe, is ka faisla yahan hota hai (khalis hisaab):
//   harvestGenericGates — bandhan (binding) se pehle wale
//     aam darwaze: body maujood, size hadd ke andar, MP4
//     header theek, duration ke size floor se upar.
//   harvestCandidateVerdict — wohi + bandhan lazmi: URL
//     kisi task ke naam bandha hi na ho to candidate kabhi
//     nahi (galat task ki file uthane ka khatra yahin
//     rukta hai).
// ---------------------------------------------------------------------------

/** Harvest me rakhi ja sakne wali sab se badi body (~8MB). */
const HARVEST_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Bandhan se pehle ke aam darwaze. input =
 * { byteLength, floorBytes, headerOk, maxBytes }.
 * Natija { ok, reason } — reason: 'empty' | 'too-big' |
 * 'bad-header' | 'below-floor' | 'ok'.
 */
function harvestGenericGates(input) {
  const o = input && typeof input === 'object' ? input : {};
  const len = Number.isFinite(o.byteLength) ? Math.floor(o.byteLength) : 0;
  if (len <= 0) return { ok: false, reason: 'empty' };
  const max = Number.isFinite(o.maxBytes) && o.maxBytes > 0 ? o.maxBytes : HARVEST_MAX_BYTES;
  if (len > max) return { ok: false, reason: 'too-big' };
  if (!o.headerOk) return { ok: false, reason: 'bad-header' };
  const floor = Number.isFinite(o.floorBytes) ? Math.floor(o.floorBytes) : 0;
  if (floor > 0 && len < floor) return { ok: false, reason: 'below-floor' };
  return { ok: true, reason: 'ok' };
}

/**
 * Ek bandhe hue task ke liye harvest candidate ka faisla.
 * input = harvestGenericGates wala + { bound } — URL is
 * task ke naam bandha hai kya. Bandhan na ho to sab se
 * pehla inkaar 'unbound' hai.
 * Natija { accept, reason }.
 */
function harvestCandidateVerdict(input) {
  const o = input && typeof input === 'object' ? input : {};
  if (!o.bound) return { accept: false, reason: 'unbound' };
  const g = harvestGenericGates(o);
  return { accept: g.ok, reason: g.reason };
}

// ---------------------------------------------------------------------------
// v2.48.36 (ROOT PACK — B/C): VERBATIM REPLAY ke jawab ke
// URLs par faisla. Seekhi hui mint call hu-bahu chalane par
// jawab jo flow-content address laata hai, wo ya to TEACHER
// (pichhle task) ka hota hai — tab use FETCH KABHI NAHI
// karna (context is task ka set nahi hua) — ya is task ka
// naya address hota hai — tab claim + verified fetch jaiz
// hai. Faisla yahan, khalis:
//   input = { urls, teacherUrl, isClaimed(url) }
//   natija = { action, url, freshCount }
//     'none'      — jawab me koi flow-content address nahi
//     'teacher'   — sirf teacher ka address aaya (fetch NAHI)
//     'ambiguous' — teacher se alag ek se zyada (koi nahi)
//     'claimed'   — akela naya address pehle se claimed hai
//     'save'      — akela naya, unclaimed address: url diya
// ---------------------------------------------------------------------------
function replayUrlVerdict(input) {
  const o = input && typeof input === 'object' ? input : {};
  const urls = Array.isArray(o.urls) ? o.urls.filter(u => typeof u === 'string' && u) : [];
  if (urls.length === 0) return { action: 'none', url: null, freshCount: 0 };
  const teacherUrl = typeof o.teacherUrl === 'string' && o.teacherUrl ? o.teacherUrl : null;
  const fresh = [...new Set(urls.filter(u => u !== teacherUrl))];
  if (fresh.length === 0) return { action: 'teacher', url: null, freshCount: 0 };
  if (fresh.length > 1) return { action: 'ambiguous', url: null, freshCount: fresh.length };
  let claimed = false;
  if (typeof o.isClaimed === 'function') {
    try { claimed = !!o.isClaimed(fresh[0]); } catch (e) { claimed = false; }
  }
  if (claimed) return { action: 'claimed', url: null, freshCount: 1 };
  return { action: 'save', url: fresh[0], freshCount: 1 };
}

/**
 * v2.48.37: TEMPLATE-STATE ka khalis hisaab — har download
 * attempt ke aaghaz par engine ek [ROOT] template-state
 * line likhta hai, taaki log khud bataye ke routes B/C
 * (grid/editor replay) is pal chal sakte hain ya nahi aur
 * kyun. Faisla sirf maujoodgi par hai:
 *   input = { learned, candidate, teacherUrl }
 *     learned   — carrying-response se seekha template hai
 *     candidate — rpcids=as29s wali sabse taza darkhwast
 *                 (jawab pakda gaya ho ya na ho)
 *     teacherUrl — session ka darj-shuda teacher address
 *                  (asal URL yahan sirf haan/na me badalta
 *                  hai — qeemat is hisaab se bahar kabhi
 *                  nahi jati)
 *   natija = { template: 'learned'|'candidate'|'none',
 *              teacherUrl: 'known'|'unknown' }
 * Learned hamesha candidate se upar hai (jawab-seekha
 * saboot darkhwast-andaze se pakka hai).
 */
function templateStateOf(input) {
  const o = input && typeof input === 'object' ? input : {};
  const template = o.learned ? 'learned' : (o.candidate ? 'candidate' : 'none');
  const teacherUrl = (typeof o.teacherUrl === 'string' && o.teacherUrl) ? 'known' : 'unknown';
  return { template, teacherUrl };
}

// ---------------------------------------------------------------------------
// v2.48.38 (EDITOR-HARVEST PACK): editor ke playback fetch
// par faisle + harvest-audit ka hisaab — sab khalis.
//
// SABOOT (ZEROCLICK5, v2.48.37, owner ke PC par engine log,
// 2026-11-03): dono verbatim replay raaste teacher URL par
// HAAR gaye ('grid-replay returned teacher url' aur
// 'replay-context returned teacher url') — mint call
// session ke LAST-MINTED media ka hi address deti hai,
// tile/editor context use nahi badalta. Lekin usi log me
// ek aur darwaza dikha: Prompt #2 ke editor-open khidki
// me, Download button dabne se PEHLE, ek flow-content GET
// 1,231,422 bytes ka hua (≈ usi task ki file size) —
// editor apni playback ke liye file KHUD mangta hai. Un
// bytes ko usi khidki me pakadna hi bacha hua zero-click
// rasta hai ('editor-harvest').
// ---------------------------------------------------------------------------

/**
 * Ek flow-content jawab ADHOORA (partial) hai kya?
 * Nishan: HTTP 206, Content-Range header maujood, declared
 * Content-Length se chhoti asal body, ya duration ke size
 * floor se neeche ki body (chhota tukda asal file nahi ho
 * sakta). input = { status, contentRange, byteLength,
 * declaredLength, floorBytes }.
 */
function isPartialHarvestResponse(input) {
  const o = input && typeof input === 'object' ? input : {};
  if (Number(o.status) === 206) return true;
  if (typeof o.contentRange === 'string' && o.contentRange.trim() !== '') return true;
  const len = Number.isFinite(o.byteLength) ? Math.floor(o.byteLength) : 0;
  const declared = Number.isFinite(o.declaredLength) ? Math.floor(o.declaredLength) : 0;
  if (declared > 0 && len > 0 && len < declared) return true;
  const floor = Number.isFinite(o.floorBytes) ? Math.floor(o.floorBytes) : 0;
  if (floor > 0 && len > 0 && len < floor) return true;
  return false;
}

/**
 * EDITOR-HARVEST ke ek ummeedwaar ka faisla. Nisbat
 * SANRACHNA (structural) par hai: jawab SIRF tab qabil hai
 * jab wo IS task ke editor ke khule hone ki khidki ke
 * ANDAR dekha gaya ho (inWindow) — khidki ke bahar ka
 * jawab kabhi nahi, chahe baaki sab theek ho. Teacher ka
 * address (url barabar) ya teacher ke bytes (hash barabar
 * / duplicate nishaan) hamesha inkaar hain. Adhoora jawab
 * inkaar nahi — usi URL ka poora fetch page ke andar se
 * hota hai (action 'fetch-full').
 * input = { inWindow, url, teacherUrl, byteLength,
 *   floorBytes, headerOk, status, contentRange,
 *   declaredLength, partial, duplicate, hash, teacherHash }
 * natija = { accept, action, reason } — action:
 *   'save' | 'fetch-full' | 'reject'; reason 'ok' ho ya
 *   haar ki qisam: 'outside-window' | 'no-url' |
 *   'teacher-url' | 'duplicate-content' | 'partial' |
 *   'empty' | 'too-big' | 'bad-header' | 'below-floor'.
 */
function editorHarvestVerdict(input) {
  const o = input && typeof input === 'object' ? input : {};
  if (!o.inWindow) return { accept: false, action: 'reject', reason: 'outside-window' };
  const url = typeof o.url === 'string' && o.url ? o.url : null;
  if (!url) return { accept: false, action: 'reject', reason: 'no-url' };
  if (typeof o.teacherUrl === 'string' && o.teacherUrl && url === o.teacherUrl) {
    return { accept: false, action: 'reject', reason: 'teacher-url' };
  }
  if (o.duplicate) return { accept: false, action: 'reject', reason: 'duplicate-content' };
  if (o.hash && o.teacherHash && o.hash === o.teacherHash) {
    return { accept: false, action: 'reject', reason: 'duplicate-content' };
  }
  const partial = typeof o.partial === 'boolean' ? o.partial : isPartialHarvestResponse(o);
  if (partial) return { accept: false, action: 'fetch-full', reason: 'partial' };
  const g = harvestGenericGates(o);
  if (!g.ok) return { accept: false, action: 'reject', reason: g.reason };
  return { accept: true, action: 'save', reason: 'ok' };
}

/**
 * v2.48.39 (HARVEST-FIRST SPEED FIX): replay-context ke
 * address ko FAST-DL fetch par bhejne se PEHLE ka faisla —
 * is task ki editor-khidki ki kitab me koi aisa jawab
 * pehle se PROMOTED hai kya jo seedha save ke qabil ho
 * (mukammal, guard-pass)? Ho to replay fetch BILKUL nahi
 * chalega — wahi body editor-harvest ke raste save hogi.
 *
 * SABOOT (ZEROCLICK6, v2.48.38, owner ke PC par engine
 * log, 2026-11-03): Prompt #2 par harvest-audit ne jawab
 * ko promoted darj kar diya tha (22:57:00.9), phir bhi
 * replay-context ka address FAST-DL fetch par gaya aur
 * ~8.7s zaya hue (node-fetch 403 ×3, page-fetch fail) —
 * editor-harvest ne aakhir wahi promoted body save ki
 * (22:57:11.8). Ye faisla wahi zaya waqt kaat-ta hai.
 *
 * Usool sakht:
 *   - sirf woh jawab jo editorHarvestVerdict par action
 *     'save' de (mukammal + teacher nahi + duplicate
 *     nahi + darwaze pass);
 *   - ADHOORA jawab (action 'fetch-full') is skip ke
 *     liye KABHI qabil nahi — wo editor-harvest route ke
 *     apne fetch-full raste se hi jayega (yahan skip
 *     karne se wo rasta bhi ruk jata aur replay fetch
 *     bhi — ulta nuqsan);
 *   - tarjeeh editor-harvest route wali hi: sab se taza
 *     mukammal jawab pehle.
 * input = { entries, teacherUrl, floorBytes } — entries
 *   editorHarvestVerdict ke hisaab wale hisse hain:
 *   { url, byteLength, headerOk, partial, status,
 *     contentRange, declaredLength, duplicate, hash,
 *     teacherHash } (kitab ki asal entry se engine banata
 *     hai; inWindow hamesha sach — kitab me khidki ke
 *     bahar ka jawab hota hi nahi).
 * natija = { skip, index, url, verdict } — skip sach ho
 *   to index entries me us jawab ki jagah hai.
 */
function promotedEditorHarvestPick(input) {
  const o = input && typeof input === 'object' ? input : {};
  const entries = Array.isArray(o.entries) ? o.entries : [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] && typeof entries[i] === 'object' ? entries[i] : {};
    if (e.partial) continue;
    const v = editorHarvestVerdict({
      inWindow: true,
      url: e.url,
      teacherUrl: o.teacherUrl,
      byteLength: e.byteLength,
      floorBytes: o.floorBytes,
      headerOk: e.headerOk,
      partial: typeof e.partial === 'boolean' ? e.partial : undefined,
      status: e.status,
      contentRange: e.contentRange,
      declaredLength: e.declaredLength,
      duplicate: !!e.duplicate,
      hash: e.hash,
      teacherHash: e.teacherHash
    });
    if (v.action === 'save') return { skip: true, index: i, url: e.url || null, verdict: v };
  }
  return { skip: false, index: -1, url: null, verdict: null };
}

/**
 * HARVEST-AUDIT ka hisaab: ek mukammal flow-content jawab
 * ka ek-line khulasa — kitne bytes, body mili ya nahi,
 * hash ke pehle 8 harf (poora hash kabhi log nahi —
 * shape-only discipline), teacher se muqabla (hash se
 * pakka, warna URL se; dono na hon to 'n/a'), aur faisla
 * (kitab me promotion hua ya inkaar) apni wajah ke saath.
 * input = { byteLength, bodyOk, hash, teacherHash, url,
 *   teacherUrl, promoted, reason }
 * natija = { bytes, body, hash, vsTeacher, decision,
 *   reason } — hash 'n/a' jab body hi na mili ho.
 */
function harvestAuditOf(input) {
  const o = input && typeof input === 'object' ? input : {};
  const bytes = Number.isFinite(o.byteLength) ? Math.max(0, Math.floor(o.byteLength)) : 0;
  const body = o.bodyOk && bytes > 0 ? 'ok' : 'fail';
  const hash = body === 'ok' && typeof o.hash === 'string' && o.hash
    ? o.hash.slice(0, 8) : 'n/a';
  let vsTeacher = 'n/a';
  if (body === 'ok' && o.hash && o.teacherHash) {
    vsTeacher = o.hash === o.teacherHash ? 'same' : 'different';
  } else if (typeof o.url === 'string' && o.url && typeof o.teacherUrl === 'string' && o.teacherUrl) {
    vsTeacher = o.url === o.teacherUrl ? 'same' : 'different';
  }
  return {
    bytes,
    body,
    hash,
    vsTeacher,
    decision: o.promoted ? 'promoted' : 'rejected',
    reason: typeof o.reason === 'string' && o.reason ? o.reason : (o.promoted ? 'ok' : 'unknown')
  };
}

/** Harvest-audit natije ki ek-line shakal (bina '[ROOT] harvest-audit' prefix ke). */
function formatHarvestAudit(audit) {
  const a = audit && typeof audit === 'object' ? audit : {};
  return `bytes=${Number.isFinite(a.bytes) ? a.bytes : 0} body=${a.body || 'fail'} hash=${a.hash || 'n/a'} vsTeacher=${a.vsTeacher || 'n/a'} decision=${a.decision || 'rejected'} reason=${a.reason || 'unknown'}`;
}

// ---------------------------------------------------------------------------
// v2.48.40 (INVISIBLE HARVEST PACK): CASCADE DIAGNOSTIC ka
// khalis hisaab — sirf mushahida (observe-only), koi
// vyavhaar is par nirbhar NAHI karta. Sawal: is task ki
// file ka address (ya us ki stream) sab se PEHLE kahan
// dekha gaya — aur kya wo kisi editor (dikha hua ya
// background) ke khulne se PEHLE hi kisi jawab me aa
// chuka tha? Agar haan, to aane wala koi rasta editor
// khole baghair bhi chal sakta hai — ye line usi sawal
// ka saboot jama karti hai.
//   input = { observation, editorOpenedAt }
//     observation    — capture ki pehli-nazar kitab se:
//                      { at, kind } | null; kind =
//                      'project-data' (project/API jawab
//                      ke andar aaya address) |
//                      'mint-response' (mint batchexecute
//                      jawab le aaya) | 'stream-get'
//                      (flow-content stream wala jawab
//                      khud).
//     editorOpenedAt — is task ke liye pehla editor
//                      khulne ka pal (ms); kabhi na khula
//                      ho to null.
//   natija = { firstSeen, preEditorUrl }
//     firstSeen — 'project-data' | 'editor-open' |
//       'mint-response' | 'stream-get' | 'none'.
//       Stream wala jawab PEHLI dafa editor khulne ke
//       BAAD dikha ho to us ka naam 'editor-open' hai
//       (wo editor ki apni playback thi); editor se
//       pehle dikha ho to 'stream-get' hi rehta hai.
//     preEditorUrl — 'yes' jab sab se pehli nazar kisi
//       bhi editor ke khulne se pehle ki ho (ya editor
//       is attempt me khula hi na ho aur address dikha
//       ho); warna 'no'.
// ---------------------------------------------------------------------------
function cascadeVerdict(input) {
  const o = input && typeof input === 'object' ? input : {};
  const obs = o.observation && typeof o.observation === 'object' ? o.observation : null;
  const editorAt = Number.isFinite(o.editorOpenedAt) ? o.editorOpenedAt : null;
  if (!obs || !Number.isFinite(obs.at) || typeof obs.kind !== 'string' || !obs.kind) {
    return { firstSeen: 'none', preEditorUrl: 'no' };
  }
  const beforeEditor = editorAt === null || obs.at < editorAt;
  let firstSeen = obs.kind;
  if (!beforeEditor && obs.kind === 'stream-get') firstSeen = 'editor-open';
  return { firstSeen, preEditorUrl: beforeEditor ? 'yes' : 'no' };
}

module.exports = { contentHash, checkDuplicate, recordSave, claimedByOtherTask, HARVEST_MAX_BYTES, harvestGenericGates, harvestCandidateVerdict, replayUrlVerdict, templateStateOf, isPartialHarvestResponse, editorHarvestVerdict, promotedEditorHarvestPick, harvestAuditOf, formatHarvestAudit, cascadeVerdict };
