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

module.exports = { findIdOccurrences, countOccurrences, substituteIds };
