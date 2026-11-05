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
// v2.48.41 (MAIN-PAGE HARVEST PACK): wahi faisle ab MAIN
// PAGE ke jawabon par laagu hain — owner order (2026-11-04,
// ZEROCLICK8 eye-verdict): editor kahin bhi nahi khulega
// (na main tab, na dusra tab, na background tab); download
// usi project/grid page se pakda jayega jis par video
// banti hai. Is liye 'editor-harvest' verdict/pick ka
// naam aur bandish badal kar 'mainpage-harvest' kar di
// gayi hai — bandish ab editor-khidki nahi, task se
// bandha hua main-page jawab hai (bound).
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
// editor apni playback ke liye file KHUD mangta hai.
// v2.48.40 me ye bytes background page se pakde gaye,
// lekin owner ne editor ko dusre tab me chalte DEKHA aur
// radd kar diya — ab yehi sawaal main page par hai:
// ZEROCLICK8 ke log me download attempt #1 ke dauraan,
// kisi editor ke khulne se PEHLE, main page par ek
// googlevideo videoplayback jawab 224,692 bytes ka aaya
// tha — main page shayad tile ki stream khud mangti hai.
// 'mainpage-audit' lineain isi sawal ka saboot jama
// karti hain; dawa koi nahi, jo dikhega wahi log hoga.
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
 * MAINPAGE-HARVEST ke ek ummeedwaar ka faisla (v2.48.41).
 * Nisbat SANRACHNA (structural) par hai: jawab SIRF tab
 * qabil hai jab wo MAIN project page par is task se
 * BANDHA hua dekha gaya ho (bound — fingerprint/timing
 * bandish capture ki kitab se, ya tile ke apne <video>
 * src se) — unbound jawab kabhi nahi, chahe baaki sab
 * theek ho. Teacher ka address (url barabar) ya teacher
 * ke bytes (hash barabar / duplicate nishaan) hamesha
 * inkaar hain. Adhoora jawab inkaar nahi — usi URL ka
 * poora fetch MAIN page ke andar se hota hai (action
 * 'fetch-full').
 * input = { bound, url, teacherUrl, byteLength,
 *   floorBytes, headerOk, status, contentRange,
 *   declaredLength, partial, duplicate, hash, teacherHash }
 * natija = { accept, action, reason } — action:
 *   'save' | 'fetch-full' | 'reject'; reason 'ok' ho ya
 *   haar ki qisam: 'unbound' | 'no-url' |
 *   'teacher-url' | 'duplicate-content' | 'partial' |
 *   'empty' | 'too-big' | 'bad-header' | 'below-floor'.
 */
function mainpageHarvestVerdict(input) {
  const o = input && typeof input === 'object' ? input : {};
  if (!o.bound) return { accept: false, action: 'reject', reason: 'unbound' };
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
 * v2.48.41 (MAIN-PAGE HARVEST PACK): MAIN page ki kitab
 * (capture.mainpageEntries) se is task ke liye sab se
 * pakka ummeedwaar chunna. Tarjeeh ka tartib:
 *   1. bandha hua (bound) + mukammal jawab (action
 *      'save' — body pehle se kitab me hai);
 *   2. koi bhi mukammal jawab (bound naheen to bhi
 *      timing bandish render-complete ke baad wali hai —
 *      engine use sirf tab chunega jab kitab use is
 *      task se jodti ho; yahan faisla sirf darwazon ka
 *      hai);
 *   3. bandha hua adhoora jawab (action 'fetch-full' —
 *      poora fetch main page ke andar se hoga);
 *   4. koi bhi adhoora jawab.
 * Har darje ke andar sab se TAZA jawab pehle. Teacher
 * (url ya hash barabar), duplicate aur darwaza-fail
 * jawab har darje se bahar hain.
 * input = { entries, teacherUrl, floorBytes } — entries
 *   mainpageHarvestVerdict ke hisaab wale hisse hain:
 *   { url, src, byteLength, headerOk, partial, status,
 *     contentRange, declaredLength, duplicate, hash,
 *     teacherHash, bound } (kitab ki asal entry se
 *   engine banata hai).
 * natija = { pick, index, url, verdict } — pick sach ho
 *   to index entries me us jawab ki jagah hai aur
 *   verdict usi par mainpageHarvestVerdict ka natija
 *   hai (action 'save' ya 'fetch-full').
 */
function mainpageEntryPick(input) {
  const o = input && typeof input === 'object' ? input : {};
  const entries = Array.isArray(o.entries) ? o.entries : [];
  const tiers = [
    (e, v) => e.bound && v.action === 'save',
    (e, v) => v.action === 'save',
    (e, v) => e.bound && v.action === 'fetch-full',
    (e, v) => v.action === 'fetch-full'
  ];
  for (const inTier of tiers) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] && typeof entries[i] === 'object' ? entries[i] : {};
      // Faisla yahan bound:true rakh kar hota hai —
      // bandish ka darja (bound banam timing) is pick
      // ki apni tarjeeh hai (tiers); verdict sirf
      // andarooni darwaze (teacher/duplicate/partial/
      // size/header) gin-ta hai. Asal save se pehle
      // engine apni bandish (fingerprint/timing) phir
      // laagu karta hai.
      const v = mainpageHarvestVerdict({
        bound: true,
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
      if ((v.action === 'save' || v.action === 'fetch-full') && inTier(e, v)) {
        return { pick: true, index: i, url: e.url || null, verdict: v };
      }
    }
  }
  return { pick: false, index: -1, url: null, verdict: null };
}

/**
 * v2.48.41 (MAIN-PAGE HARVEST PACK): ADHOORE jawab ke URL
 * se POORA fetch karne ke ummeedwaar URLs — pehle asal
 * URL, phir (agar URL me range-wale hisse hon to) un ke
 * baghair wala saaf URL. googlevideo videoplayback URLs
 * kabhi kabhi 'range' jese hisse le kar aate hain jo
 * jawab ko tukde tak mehdood kar dete hain; saaf URL
 * aksar poori file deta hai. Sirf range-ish hisse
 * (range, rstart, rend) hat te hain — dastakhat (sig)
 * aur baaki hisse kabhi nahi chhute, warna URL mar
 * jayega. Natija hamesha kam az kam [asalUrl] hai.
 */
function fullFetchUrlCandidates(url) {
  const raw = typeof url === 'string' && url ? url : null;
  if (!raw) return [];
  const out = [raw];
  try {
    const u = new URL(raw);
    let changed = false;
    for (const p of ['range', 'rstart', 'rend']) {
      if (u.searchParams.has(p)) { u.searchParams.delete(p); changed = true; }
    }
    if (changed) {
      const cleaned = u.toString();
      if (cleaned && cleaned !== raw) out.push(cleaned);
    }
  } catch (e) {}
  return out;
}

/**
 * v2.48.41 (MAIN-PAGE HARVEST PACK): MAINPAGE-AUDIT ka
 * hisaab — main project page par dekhe gaye har
 * video-jese jawab ki ek line: kis host se, kitne
 * bytes, alamat kis qisam ki (src: flow-content |
 * googlevideo | none), faisla (promoted — is task ki
 * file ban kar save hua | captured — kitab me pakda
 * gaya | ignored — hisaab se bahar raha) aur wajah.
 * Timing bucket (render-watch | download-attempt)
 * engine alag se jodta hai. Asal URL yahan kabhi nahi
 * aata — shape-only discipline barkarar.
 * input = { host, bytes, src, decision, reason }
 * natija = { host, bytes, src, decision, reason } —
 *   host 'none' jab koi URL hi na ho (masalan tile par
 *   <video> hi nahi mila).
 */
function mainpageAuditOf(input) {
  const o = input && typeof input === 'object' ? input : {};
  const host = typeof o.host === 'string' && o.host ? o.host : 'none';
  const bytes = Number.isFinite(o.bytes) ? Math.max(0, Math.floor(o.bytes)) : 0;
  const src = o.src === 'flow-content' || o.src === 'googlevideo' ? o.src : 'none';
  const decision = o.decision === 'promoted' || o.decision === 'captured' || o.decision === 'ignored'
    ? o.decision : 'ignored';
  const reason = typeof o.reason === 'string' && o.reason ? o.reason : 'unknown';
  const out = { host, bytes, src, decision, reason };
  // v2.48.42: binding ka saboot — jab diya jaye to barkarar
  // rehta hai (purane caller bina in ke chalte rehte hain
  // aur un ki lines bilkul waisi hi rehti hain jaisi .41
  // me thi).
  if (typeof o.bindReason === 'string' && o.bindReason) out.bindReason = o.bindReason;
  if (typeof o.claimedBy === 'string' && o.claimedBy) out.claimedBy = o.claimedBy;
  // v2.48.48: googlevideo body-store ka nateeja — jab
  // diya jaye to 'yes' ya 'no:<wajah>' ban kar rehta
  // hai (capture kitab ka store is se pehle khamosh
  // tha: tukda na rakha jaye tab bhi audit sirf
  // 'captured' kehta tha).
  if (o.bodyStored === 'yes') out.stored = 'yes';
  else if (o.bodyStored === 'no') out.stored = `no:${typeof o.bodyStoreReason === 'string' && o.bodyStoreReason ? o.bodyStoreReason : 'unknown'}`;
  return out;
}

/** Mainpage-audit natije ki ek-line shakal (bina '[ROOT] mainpage-audit' prefix ke). */
function formatMainpageAudit(audit) {
  const a = audit && typeof audit === 'object' ? audit : {};
  let line = `host=${a.host || 'none'} bytes=${Number.isFinite(a.bytes) ? a.bytes : 0} src=${a.src || 'none'} decision=${a.decision || 'ignored'} reason=${a.reason || 'unknown'}`;
  // v2.48.42: bindReason/claimedBy sirf tab jab maujood hon.
  if (a.bindReason) line += ` bindReason=${a.bindReason}`;
  if (a.claimedBy) line += ` claimedBy=${a.claimedBy}`;
  // v2.48.48: stored hamesha fields ke AAKHIR me,
  // sirf tab jab maujood ho.
  if (a.stored) line += ` stored=${a.stored}`;
  return line;
}

/**
 * v2.48.43 (HOVER + PATIENCE PACK): UMMEEDWAAR DARWAZA —
 * main page par dikha har stream asal video ka
 * ummeedwaar NAHI hota. ZEROCLICK10 ka saboot: render-
 * watch par 87,478 bytes ki ek chhoti googlevideo hit
 * aayi — poori video ~1.2MB ki hoti hai; itni chhoti
 * stream file ho hi nahi sakti. Qaaida:
 *   - kul size MALOOM ho: ummeedwaar sirf tab jab kul
 *     size >= MAINPAGE_MIN_CANDIDATE_BYTES (500,000);
 *     is se chhota = 'stream-too-small' — kitab me
 *     ummeedwaar kabhi nahi banta.
 *   - kul size NA maloom ho: ummeedwaar sirf tab jab
 *     host googlevideo / flow-content ho AUR content-
 *     type video/* ho (content-type hi na diya gaya
 *     ho to host hi kafi hai — asal CDP raaste par
 *     type hamesha aata hai).
 *   - v2.48.52: kul na maloom ho aur aaye bytes
 *     (input.bytes) bhi hadd se chhote hon to
 *     googlevideo nazar phir bhi 'stream-too-small'
 *     hai (neeche function me tafseel).
 * input = { knownTotal, src, contentType, bytes }
 * natija = { candidate, reason } — reason 'ok' |
 *   'stream-too-small' | 'not-video-candidate'.
 */
const MAINPAGE_MIN_CANDIDATE_BYTES = 500000;
function mainpageCandidateGate(input) {
  const o = input && typeof input === 'object' ? input : {};
  if (Number.isFinite(o.knownTotal)) {
    return o.knownTotal >= MAINPAGE_MIN_CANDIDATE_BYTES
      ? { candidate: true, reason: 'ok' }
      : { candidate: false, reason: 'stream-too-small' };
  }
  const videoHost = o.src === 'googlevideo' || o.src === 'flow-content';
  const type = typeof o.contentType === 'string' ? o.contentType.toLowerCase() : null;
  const typeOk = type === null || type.startsWith('video/');
  if (!(videoHost && typeOk)) {
    return { candidate: false, reason: 'not-video-candidate' };
  }
  // v2.48.52 (ROUTE 1A PACK — gate fix): host/type
  // darwaza paar karne ke BAAD — kul size na maloom
  // ho aur ab tak asal me aaye bytes (transferred)
  // bhi hadd se chhote hon to googlevideo nazar
  // ummeedwaar NAHI banti — wo too-small yaad ke
  // liye hai, jahan engine use Route 1A (netload)
  // se parkhta hai. 'stream-too-small' inkaar ab
  // sirf tab: kul size hadd se chhota ho (upar), YA
  // kul na maloom ho aur aaye bytes hadd se chhote
  // hon (ye wala). bytes input hi na diya gaya ho
  // to purana host/type faisla bilkul waisa hi
  // (purane bulane wale/tests barkarar);
  // flow-content par ye usool laagu nahi (body-fail
  // wali entry wahan jaan-boojh kar rehti hai taaki
  // engine page-context fetch aazma sake).
  if (o.src === 'googlevideo' && Number.isFinite(o.bytes) && o.bytes < MAINPAGE_MIN_CANDIDATE_BYTES) {
    return { candidate: false, reason: 'stream-too-small' };
  }
  return { candidate: true, reason: 'ok' };
}

/**
 * v2.48.52 (ROUTE 1A PACK — gate fix): ek mainpage
 * nazar/entry ka MALOOM kul size (known total), ya
 * null jab koi bharose-mand kul size hai hi nahi.
 * Bharose ki tartib:
 *   1. capture ka apna knownTotal (wahan hisaab pehle
 *      se durust bandha hai);
 *   2. Content-Range ke aakhir wala kul ('bytes
 *      0-210942/1193958' -> 1193958);
 *   3. declaredLength / declared — LEKIN sirf jab
 *      status 206 na ho: 206 jawab ki Content-Length
 *      usi TUKE ki size hoti hai, kul ki nahi (wahi
 *      purani ghalti jis se adhoora jawab 'poora'
 *      samjha jata tha). 206 par CR ke baghair kul
 *      maloom hi nahi — null.
 * input = { knownTotal, contentRange, declaredLength,
 *   declared, status }.
 */
function mainpageKnownTotalOf(input) {
  const o = input && typeof input === 'object' ? input : {};
  if (Number.isFinite(o.knownTotal) && o.knownTotal > 0) return Math.floor(o.knownTotal);
  const cr = typeof o.contentRange === 'string' ? o.contentRange : '';
  const m = cr.match(/\/(\d+)\s*$/);
  if (m) {
    const t = parseInt(m[1], 10);
    if (Number.isFinite(t) && t > 0) return t;
  }
  if (Number(o.status) !== 206) {
    for (const v of [o.declaredLength, o.declared]) {
      if (Number.isFinite(v) && v > 0) return Math.floor(v);
    }
  }
  return null;
}

/**
 * v2.48.49 (TOO-SMALL MEDIA-LOAD MAUQA — ZEROCLICK16):
 * failOut se pehle media-load ko EK mauqa dene ka
 * trigger (khalis). ZEROCLICK16: is run full-size
 * stream aayi hi nahi — sirf too-small previews
 * (85,725B / 110,290B) aayin, is liye koi ummeedwaar
 * bandha hi nahi aur completion (media-load +
 * assembly) kabhi engage hi nahi hua. Lekin wahi
 * chhota preview URL aksar usi file ka pata hota
 * hai — adrishya <video> element us URL ko load
 * kare to media stack poori file ke range jawab
 * kheench sakta hai (aur .48 ki assembly unhe jod
 * sakti hai). Trigger ki shartein (saari ek saath):
 *   - nazar capture ki too-small yaad me darj ho
 *     (networkCapture.mainpageTooSmallSightings —
 *     entry/umeedwaar wahan bhi NAHI banti);
 *   - src googlevideo ho;
 *   - ignore ki wajah SIRF 'stream-too-small' ho
 *     (koi aur wajah = mauqa nahi);
 *   - URL khaali na ho, teacher ka na ho, is
 *     attempt me pehle aazmaya hua na ho;
 *   - pehli nazar is task ke aaghaz se pehle ki na
 *     ho (bandhan wali hi timing bandish — kisi aur
 *     ki purani stream meri nahi ho sakti).
 * input = { sightings, taskStart, teacherUrl,
 *   triedUrls (Set ya array) }
 * natija = { url, firstSeenAt } (sab se pehli
 *   nazar wala) ya null.
 * v2.48.51 (item 3 — task nishani): ZEROCLICK18 me
 * #2 ke completion ne #1 ki rr5 nazar utha li —
 * yaad me task ki nishani hi nahi thi. Ab pick SIRF
 * wahi nazar deta hai jo MANGNE wali task ki ho:
 *   - nazar par captureKey darj ho to wo task ke
 *     captureKey ke BARABAR hona chahiye;
 *   - captureKey null ho (koi khidki khuli nahi
 *     thi) to waqt ki khidki: firstSeenAt task ke
 *     renderDoneAt − 5s se pehle ka na ho aur
 *     attempt ki aakhri hadd (attemptDeadline) ke
 *     baad ka na ho — ye do haddain input me hon
 *     tab hi laagu (purane bulane wale bina hadd ke
 *     aaj wala bartao rakhte hain);
 *   - jo nazar kisi AUR task ke pick ne consumed
 *     kar li ho (consumedBy) wo dobara nahi uthti.
 * Input me mazeed: captureKey, renderDoneAt,
 * attemptDeadline. Natije me sighting ka captureKey
 * bhi lautta hai.
 */
function mainpageTooSmallMediaPick(input) {
  const o = input && typeof input === 'object' ? input : {};
  const list = Array.isArray(o.sightings) ? o.sightings : [];
  const taskStart = Number.isFinite(o.taskStart) ? o.taskStart : 0;
  const teacherUrl = typeof o.teacherUrl === 'string' && o.teacherUrl ? o.teacherUrl : null;
  const tried = o.triedUrls instanceof Set
    ? o.triedUrls
    : new Set(Array.isArray(o.triedUrls) ? o.triedUrls : []);
  const wantKey = typeof o.captureKey === 'string' && o.captureKey ? o.captureKey : null;
  const renderDoneAt = Number.isFinite(o.renderDoneAt) ? o.renderDoneAt : null;
  const deadline = Number.isFinite(o.attemptDeadline) ? o.attemptDeadline : null;
  let best = null;
  for (const s of list) {
    if (!s || typeof s.url !== 'string' || !s.url) continue;
    if (s.reason !== 'stream-too-small') continue;
    if (s.src !== 'googlevideo') continue;
    if (teacherUrl && s.url === teacherUrl) continue;
    if (tried.has(s.url)) continue;
    const seenAt = Number.isFinite(s.firstSeenAt) ? s.firstSeenAt
      : (Number.isFinite(s.at) ? s.at : 0);
    if (taskStart > 0 && seenAt > 0 && seenAt < taskStart) continue;
    // v2.48.51 (item 3): task ki nishani — dusri
    // task ki nazar meri nahi.
    if (s.consumedBy && s.consumedBy !== wantKey) continue;
    const sKey = typeof s.captureKey === 'string' && s.captureKey ? s.captureKey : null;
    if (sKey) {
      if (!wantKey || sKey !== wantKey) continue;
    } else {
      if (renderDoneAt !== null && seenAt > 0 && seenAt < renderDoneAt - 5000) continue;
      if (deadline !== null && seenAt > 0 && seenAt > deadline) continue;
    }
    if (!best || seenAt < best.firstSeenAt) best = { url: s.url, firstSeenAt: seenAt, captureKey: sKey };
  }
  return best;
}

/**
 * v2.48.42 (MAIN-PAGE BINDING PACK) → v2.48.43 (HOVER +
 * PATIENCE PACK): BINDING PLAN.
 * ZEROCLICK9 ka rukawat bandhan tha; .42 ka khidki-
 * taqseem (window partition) ZEROCLICK10 me nakam raha:
 * download renderon ke saath uljhe hue the, preview
 * streams render ke 10–45s baad aate hain, aur ek poori
 * stream baad-render wali dusri task ki khidki me gir
 * kar pehli task ke liye zaya ho gayi. Ab asal qaaida
 * TARTEEB (ORDER) hai:
 *   - ummeedwaar streams ki kataar pehli-nazar ki
 *     tarteeb se (firstSeenAt; barabar pal par capture
 *     ka seq — pakadne ki asal tarteeb — faisla karta
 *     hai);
 *   - baqi (pending) downloads ki kataar un ke
 *     render-complete ki tarteeb se;
 *   - MERI jodi kataar me MERI jagah wala ummeedwaar
 *     hai (pehla baqi download ↔ pehla ummeedwaar,
 *     dusra ↔ dusra, …) — koshish hamesha tartib wale
 *     sab se pehle baqi download ki hoti hai (1 worker
 *     par attempts tartib se hi chalte hain), is liye
 *     mera ummeedwaar wahi hai jo is tartib me mera
 *     hissa hai.
 *   - EXCLUSION (purana fallback barkarar): meri jodi
 *     na bane lekin kitab me bilkul ek ummeedwaar ho
 *     aur koi aur baqi download na ho — wo mera.
 *   - AMBIGUOUS sirf ASAL bandh-ganth (genuine tie)
 *     par: MERI jodi wala ummeedwaar aur us ke baad
 *     wala ek hi pal pehli baar dikhe hon aur capture
 *     tartib (seq) bhi unhe alag na kar sake — tab koi
 *     nahi uthega (ghalat video miss se bura hai —
 *     ZEROCLICK2 sabak; aakhri hifazat saveGuard ke
 *     hash/duplicate darwaze aur sequence check hain:
 *     ek hi bytes do naamon par = ERROR, khamosh jeet
 *     kabhi nahi).
 * input = {
 *   candidates: [{ url, firstSeenAt, seq }],  // unclaimed,
 *     // teacher se alag, mazboot-bandhe hue bahar,
 *     // ummeedwaar-darwaza pass kiye hue
 *   ownKey,                               // meri task
 *   ownStart,                             // mera
 *     // render-complete (pendingOrder me meri entry
 *     // na mile to meri jagah is se tay hogi)
 *   pendingOrder: [{ key, start }],       // baqi
 *     // downloads, render-complete ki tartib me
 *     // (jo bhi tartib di jaye, andar sort hota hai)
 *   pendingOthers                         // aur kitne
 *     // baqi unbound downloads (exclusion shart)
 * }
 * natija = { bind, reason, url, count }:
 *   reason 'order' | 'exclusion' | 'ambiguous' |
 *     'none'; bind sirf pehli do par. count =
 *     ummeedwaaron ki kul tadaad.
 */
function mainpageBindingPlan(input) {
  const o = input && typeof input === 'object' ? input : {};
  const seqOf = (c) => (Number.isFinite(c.seq) ? c.seq : null);
  const candidates = (Array.isArray(o.candidates) ? o.candidates : [])
    .filter(c => c && typeof c.url === 'string' && c.url && Number.isFinite(c.firstSeenAt))
    .slice()
    .sort((a, b) => {
      if (a.firstSeenAt !== b.firstSeenAt) return a.firstSeenAt - b.firstSeenAt;
      const sa = seqOf(a); const sb = seqOf(b);
      if (sa !== null && sb !== null) return sa - sb;
      return 0;
    });
  const pendingOthers = Number.isFinite(o.pendingOthers) ? Math.max(0, Math.floor(o.pendingOthers)) : 0;
  const order = (Array.isArray(o.pendingOrder) ? o.pendingOrder : [])
    .filter(w => w && w.key != null && Number.isFinite(w.start))
    .slice()
    .sort((a, b) => a.start - b.start);
  // Meri jagah: darj kataar me mera number; entry na
  // mile to mera render-complete jin se pehle hai, main
  // un se pehle — wahi meri jagah.
  let myIdx = o.ownKey != null ? order.findIndex(w => String(w.key) === String(o.ownKey)) : -1;
  if (myIdx < 0) {
    const ownStart = Number.isFinite(o.ownStart) ? o.ownStart : Number.POSITIVE_INFINITY;
    myIdx = order.filter(w => w.start <= ownStart).length;
  }
  const count = candidates.length;
  // v2.48.45 (BINDCHECK): myIdx natije me bhi jata hai
  // — engine ki bindcheck line har ummeedwaar ki
  // kataar-jagah isi se naam deti hai (vyavhaar par
  // koi asar nahi; sirf ek aur field).
  if (count === 0) return { bind: false, reason: 'none', url: null, count: 0, myIdx };
  // Do ummeedwaar asal me be-tarteeb (tie) kab hain:
  // ek hi pal pehli nazar AUR capture tartib bhi
  // alag na kar sake (seq dono ka na ho ya barabar).
  const tied = (a, b) => {
    if (!a || !b || a.firstSeenAt !== b.firstSeenAt) return false;
    const sa = seqOf(a); const sb = seqOf(b);
    return !(sa !== null && sb !== null && sa !== sb);
  };
  if (myIdx < count) {
    const mine = candidates[myIdx];
    const next = candidates[myIdx + 1] || null;
    if (next && tied(mine, next)) {
      return { bind: false, reason: 'ambiguous', url: null, count, myIdx };
    }
    return { bind: true, reason: 'order', url: mine.url, count, myIdx };
  }
  // Exclusion fallback: tartib me meri jodi nahi,
  // lekin kitab me akela ummeedwaar aur koi aur baqi
  // download nahi — wo akela mera.
  if (count === 1 && pendingOthers === 0) {
    return { bind: true, reason: 'exclusion', url: candidates[0].url, count, myIdx };
  }
  return { bind: false, reason: 'none', url: null, count, myIdx };
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
// v2.48.41: editor ab kabhi khulta hi nahi, is liye
// asal chalne me editorOpenedAt hamesha null rehta hai
// aur firstSeen kabhi 'editor-open' nahi banta —
// hisaab waisa hi rakha hai taaki purane logon se
// muqabla ho sake.
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

module.exports = { contentHash, checkDuplicate, recordSave, claimedByOtherTask, HARVEST_MAX_BYTES, harvestGenericGates, harvestCandidateVerdict, replayUrlVerdict, templateStateOf, isPartialHarvestResponse, mainpageHarvestVerdict, mainpageEntryPick, mainpageBindingPlan, MAINPAGE_MIN_CANDIDATE_BYTES, mainpageCandidateGate, mainpageKnownTotalOf, mainpageTooSmallMediaPick, fullFetchUrlCandidates, harvestAuditOf, formatHarvestAudit, mainpageAuditOf, formatMainpageAudit, cascadeVerdict };
