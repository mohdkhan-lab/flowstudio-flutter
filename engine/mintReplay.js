'use strict';

// v2.48.33 (ZEROCLICK): mint-call replay ka KHALIS (pure) hisaab —
// koi I/O nahi, koi browser nahi, is liye unit tests seedha is
// par chalte hain (mintWindow.js / downloadEventMatch.js wali
// hi tarz).
//
// SABOOT (DIRECTTEST1/2, v2.48.31/.32, owner ke PC par engine
// log se sabit): file ka asal server address (flow-content
// .google/video/*) ek POST flow.google.com/_/*/data/batchexecute
// ke JAWAAB ke andar aata hai — viewer ke "Download media"
// button click ke ~1.4–2.4s baad. Owner ka agla sawal: wo click
// bhi kyun? Agar wahi batchexecute darkhwast app khud bhej de
// (page ke session se, bina kisi UI click ke) to kya jawab me
// naye video ka address aa jayega?
//   H1: darkhwast ek "is media ka download URL do" wali call
//       hai — replay chalegi, address mil jayega.
//   H2: darkhwast sirf ek haal/list wali call hai jo address
//       tabhi laati hai jab click pehle hi server par
//       "download darkhwasta" darj kar chuka ho — replay khaali
//       aayegi.
// Ye module usi aazmaish ke do khalis hisse rakhta hai:
//   1. findIdOccurrences — seekhe hue template ke body me
//      TEACHER task ke apne ID(s) kin byte-offsets par hain
//      (yehi jaghein badli jayengi; ID khud kabhi log nahi
//      hota — sirf ginti aur offsets).
//   2. substituteIds — agle task ke liye body ki byte-level
//      tabdeeli: teacher ke ID ki HAR occurrence ki jagah is
//      task ka ID. Lambai barabar ho ya na ho — Buffer tukdon
//      se dobara jodta hai, is liye alag lambai bhi sahi
//      sambhalti hai.
//   3. (v2.48.34) findIdOccurrencesInText / substituteIdsInUrl
//      — wohi do hisaab darkhwast ke URL par: live test me
//      body me id NAHI mili thi (idsInBody=0), is liye ab
//      URL bhi usi hifazat se jaancha/badla jata hai.

/** ID string ke UTF-8 bytes (Flow ke IDs ASCII hote hain; har haal me yahi sab se wafadaar roop hai). */
function idBytes(id) {
  return Buffer.from(String(id), 'utf8');
}

/**
 * Body (Buffer) me har diye gaye ID ki saari occurrence
 * jaghein: [{ id, offsets: [byteOffset, ...] }] — sirf woh
 * IDs lautte hain jo asal me milen (khaali/duplicate IDs
 * chhod diye jate hain; needle body se lamba ho to bhi
 * khamoshi se chhod diya jata hai). Offsets chadhte kram me
 * hain. ID ki qeemat natije me sirf is liye hai ke bulane
 * wala use pehchan sake — log me sirf GINTI jati hai.
 */
function findIdOccurrences(body, ids) {
  const out = [];
  if (!Buffer.isBuffer(body) || body.length === 0 || !Array.isArray(ids)) return out;
  const seen = new Set();
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const needle = idBytes(id);
    if (needle.length === 0 || needle.length > body.length) continue;
    const offsets = [];
    let from = 0;
    while (from <= body.length - needle.length) {
      const at = body.indexOf(needle, from);
      if (at < 0) break;
      offsets.push(at);
      from = at + 1;
    }
    if (offsets.length) out.push({ id, offsets });
  }
  return out;
}

/** findIdOccurrences ke natije ki kul occurrence ginti (log ki `idsInBody` qeemat). */
function countOccurrences(occurrences) {
  if (!Array.isArray(occurrences)) return 0;
  let total = 0;
  for (const o of occurrences) {
    if (o && Array.isArray(o.offsets)) total += o.offsets.length;
  }
  return total;
}

/** Ek hi ID ki saari (non-overlapping) occurrences byte-level badlo. */
function replaceAllBytes(body, fromId, toId) {
  const from = idBytes(fromId);
  const to = idBytes(toId);
  if (from.length === 0 || from.length > body.length) return { body, replacements: 0 };
  const parts = [];
  let replacements = 0;
  let cursor = 0;
  while (cursor <= body.length - from.length) {
    const at = body.indexOf(from, cursor);
    if (at < 0) break;
    parts.push(body.subarray(cursor, at));
    parts.push(to);
    replacements++;
    cursor = at + from.length;
  }
  if (replacements === 0) return { body, replacements: 0 };
  parts.push(body.subarray(cursor));
  return { body: Buffer.concat(parts), replacements };
}

/**
 * Template body me ID-jodiyon ki tabdeeli: pairs =
 * [[teacherId, thisTaskId], ...] — har jodi ki saari
 * occurrences badli jati hain (tartib se; agli jodi pichhli
 * ke natije par chalti hai). Khaali ID wali, ya from===to
 * wali jodi chhod di jati hai. Ek bhi qabil jodi na ho to
 * null (replay mumkin hi nahi); warna { body, replacements }
 * — replacements 0 bhi ho sakta hai (teacher ka ID body me
 * tha hi nahi — bulane wala isi par faisla karta hai).
 */
function substituteIds(body, pairs) {
  if (!Buffer.isBuffer(body) || !Array.isArray(pairs)) return null;
  const valid = [];
  for (const p of pairs) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const from = typeof p[0] === 'string' ? p[0] : '';
    const to = typeof p[1] === 'string' ? p[1] : '';
    if (!from || !to || from === to) continue;
    valid.push([from, to]);
  }
  if (!valid.length) return null;
  let cur = body;
  let replacements = 0;
  for (const [from, to] of valid) {
    const r = replaceAllBytes(cur, from, to);
    cur = r.body;
    replacements += r.replacements;
  }
  return { body: cur, replacements };
}

/**
 * v2.48.34 (ZEROCLICK — URL reach): findIdOccurrences ka hi
 * kaam, lekin ek aam string (darkhwast ka poora URL) par —
 * ZEROCLICK live test (2026-11-03) me template ke 170-byte
 * body me teacher task ki koi id NAHI mili (idsInBody=0),
 * is liye ab id URL me bhi dhoondhi jati hai. Natija wahi
 * shakal: [{ id, offsets: [charOffset, ...] }] — sirf woh
 * IDs jo asal me milen. Offsets string ke character offsets
 * hain (Flow ke IDs aur URL dono ASCII hote hain).
 */
function findIdOccurrencesInText(text, ids) {
  const out = [];
  if (typeof text !== 'string' || text.length === 0 || !Array.isArray(ids)) return out;
  const seen = new Set();
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (id.length > text.length) continue;
    const offsets = [];
    let from = 0;
    while (from <= text.length - id.length) {
      const at = text.indexOf(id, from);
      if (at < 0) break;
      offsets.push(at);
      from = at + 1;
    }
    if (offsets.length) out.push({ id, offsets });
  }
  return out;
}

/** Ek hi ID ki saari occurrences ek string me badlo (koi regex nahi — '$' waghera ke khaas matlab se poora bachav). */
function replaceAllInText(text, fromId, toId) {
  if (!fromId || fromId.length > text.length) return { text, replacements: 0 };
  const parts = [];
  let replacements = 0;
  let cursor = 0;
  while (cursor <= text.length - fromId.length) {
    const at = text.indexOf(fromId, cursor);
    if (at < 0) break;
    parts.push(text.slice(cursor, at));
    parts.push(toId);
    replacements++;
    cursor = at + fromId.length;
  }
  if (replacements === 0) return { text, replacements: 0 };
  parts.push(text.slice(cursor));
  return { text: parts.join(''), replacements };
}

/**
 * v2.48.34 (ZEROCLICK — URL reach): substituteIds ka URL
 * wala roop — pairs = [[teacherId, thisTaskId], ...]; har
 * jodi ki saari occurrences URL string me badli jati hain
 * (tartib se; agli jodi pichhli ke natije par). Khaali ID
 * wali ya from===to wali jodi chhod di jati hai. Ek bhi
 * qabil jodi na ho to null; warna { url, replacements } —
 * replacements 0 bhi ho sakta hai (teacher ka ID URL me
 * tha hi nahi — bulane wala isi par faisla karta hai).
 */
function substituteIdsInUrl(url, pairs) {
  if (typeof url !== 'string' || url.length === 0 || !Array.isArray(pairs)) return null;
  const valid = [];
  for (const p of pairs) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const from = typeof p[0] === 'string' ? p[0] : '';
    const to = typeof p[1] === 'string' ? p[1] : '';
    if (!from || !to || from === to) continue;
    valid.push([from, to]);
  }
  if (!valid.length) return null;
  let cur = url;
  let replacements = 0;
  for (const [from, to] of valid) {
    const r = replaceAllInText(cur, from, to);
    cur = r.text;
    replacements += r.replacements;
  }
  return { url: cur, replacements };
}

/**
 * v2.48.35 (VERBATIM PROBE): bina-tabdeeli replay ke jawab ki
 * khalis warg-bandi (classification). ZEROCLICK2 (v2.48.34,
 * live) ne sabit kar diya ke seekhi hui mint call teacher ki
 * id NA body me rakhti hai, NA URL me (idsInBody=0,
 * idsInUrl=0) — tabdeeli wala replay mumkin hi nahi. Bachi
 * hui ek hi theory: call CONTEXT-bound ho — yani jawab usi
 * media ka address laata ho jo us pal page/session ke liye
 * "current" hai. Us ka saboot sirf ye hai ke dusre task ke
 * download ke pal wahi call HU-BAHU (verbatim) bhej kar dekha
 * jaye ke jawab me kya aata hai:
 *   input:  { carriesUrl, urls, teacherUrl }
 *     carriesUrl — jawab ke matan me file-address wala host
 *                  hai kya (mintWindow.responseCarriesFileUrl);
 *     urls       — jawab se nikle hue flow-content video
 *                  address (sirf andarooni muqabla — kabhi
 *                  log nahi hote);
 *     teacherUrl — teacher task ka apna bandha/mint hua
 *                  address (capture se; na maloom ho to null).
 *   output: { carriesUrl, urlVsTeacher }
 *     urlVsTeacher:
 *       'same'      — jawab TEACHER ke hi address ko le aaya:
 *                     call context-bound NAHI, wo apni bandhi
 *                     hui media hi deti hai (dusre task ke
 *                     kaam ki nahi);
 *       'different' — jawab kisi AUR address ko le aaya:
 *                     context-bound hone ka saboot — call us
 *                     pal ke current media ka address deti
 *                     hai;
 *       'n/a'       — muqabla mumkin nahi (jawab me address
 *                     hi nahi, ya teacher ka address maloom
 *                     nahi, ya address nikle hi nahi).
 */
function classifyVerbatimProbe(input) {
  const o = input && typeof input === 'object' ? input : {};
  const carries = !!o.carriesUrl;
  if (!carries) return { carriesUrl: false, urlVsTeacher: 'n/a' };
  const urls = Array.isArray(o.urls) ? o.urls.filter(u => typeof u === 'string' && u) : [];
  const teacherUrl = typeof o.teacherUrl === 'string' && o.teacherUrl ? o.teacherUrl : null;
  if (!teacherUrl || urls.length === 0) return { carriesUrl: true, urlVsTeacher: 'n/a' };
  return { carriesUrl: true, urlVsTeacher: urls.includes(teacherUrl) ? 'same' : 'different' };
}

module.exports = { findIdOccurrences, countOccurrences, substituteIds, findIdOccurrencesInText, substituteIdsInUrl, classifyVerbatimProbe };
