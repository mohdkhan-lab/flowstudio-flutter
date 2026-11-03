'use strict';

// v2.48.30 (QUICK-CHECK HEAD): _downloadTaskMediaInner ki
// ranneeti-tartib ka ek-matra sach (single source of truth),
// taaki tests use seedha jaanch saken aur tartib kabhi
// chup-chaap na badle.
//
// v2.48.28 (SERVER-FIRST) ka head — tile prime + ~12s passive
// watch — v2.48.30 me KHATAM hai. Wajah: prime-trigger
// hypothesis (prime karne se page flow-content fetch karta
// hai) FASTTEST3 aur FASTTEST4 dono me FAIL hui — dono runs
// me 12.1–12.2s ki watch khaali gayi (registry 0, flow-content
// seen: no), aur FASTTEST2/FASTTEST4 dono me hi asal
// flow-content fetch menu ke Download→resolution click ke
// BAAD aaya. Server channel ka asal trigger wahi click hai.
// Is liye ab head sirf .29 wala NO-WAIT quick-check hai
// (_opportunisticServerCheck: ek registry read + ek capture
// fehrist, koi prime nahi, koi intezaar nahi) — aur server
// wala asal muqabla menu route ke ANDAR hai (post-click
// race: resolution click ke baad taaza flow-content URL
// dikhte hi parallel Node fetch; jo pehle verified save de,
// wahi jeeta).
//
// FASTTEST1 (v2.48.26) ki seekh bhi barkarar hai: kabhi-kabhi
// file page-fetch se guzarti hi nahi (blob aur tareeqe se banta
// hai) — is liye menu wala rasta, jo click par blob banwata
// hai, dusre number par poora barkarar hai.
//
// v2.48.31 (DIRECT-PROBE): quick-check ke baad, menu se
// PEHLE naya probe qadam 'direct-viewer' aaya tha — tile ka
// viewer khol kar (aur andar seedha Download button ho to
// use daba kar) dekha gaya ke file ka server address bina
// ⋮ menu ke mint hota hai kya.
//
// v2.48.32 (SWITCH): DIRECTTEST1 (v2.48.31, owner ke PC par
// LIVE PROVEN) ke baad 'direct-viewer' ab PRIMARY download
// rasta hai — viewer ke apne "Download media" button ka
// click hi address mint karta hai aur file app ki verified
// server-fetch se save hoti hai; ⋮ menu kabhi khulta hi
// nahi. Tartib ke andar bhi button pehle, passive poll baad
// me hai. Na bane to viewer band karke baaki tartib bilkul
// pehle ki tarah (menu ab fallback #2 hai).
//
// v2.48.33 (ZEROCLICK — PROBE, abhi LIVE PROVEN NAHI):
// quick-check ke baad naya qadam 'zero-click' — session ke
// kisi pehle task ke download me seekhi hui mint-call
// (batchexecute darkhwast jis ka jawab file-address le aaya
// tha) ko teacher ke ID ki jagah is task ka ID rakh kar page
// ke andar se replay karna, bina kisi UI click ke. Jawab
// address le aaye to wahi verified server-fetch se save;
// na aaye (H2) ya replay nakam ho to 'direct-viewer' wali
// tartib bilkul pehle ki tarah. Pehle task par template
// hota hi nahi — ye qadam khamoshi se guzar jata hai.
//
// Kram (video tasks):
//   1. quick-check       — NO-WAIT: pehle se pakde hue registry
//                          bytes / flow-content URL ka turant
//                          save (v2.48.29 ka opportunistic
//                          check, ab attempt ka pehla qadam)
//   2. zero-click        — PROBE (v2.48.33): seekhi hui
//                          mint-call ka bina-click replay —
//                          jawab ka address verified
//                          server-fetch se save
//   3. direct-viewer     — PRIMARY (v2.48.32): tile viewer ka
//                          apna Download button (bina menu) —
//                          click se mint hua server address,
//                          app ki server-fetch se save
//   4. native-menu       — ⋮ menu → Download → resolution select
//                          (+ v2.48.30 post-click server race)
//   5. blob-harvest      — page ke andar ke bytes (v2.48.26 FAST-DL)
//   6. backend-fetch     — bandha backend link seedha fetch
//   7. backend-order     — kram se bandhan (claimByOrder)
//   8. tile-readiness    — tile media ready hone ka intezaar
//   9. backend-fetch-retry — readiness ke baad backend ek aur baar
//  10. tile-src-fast     — tile ka apna src, turant fetch (v2.47.4)
//  11. tile-src          — tile/stream ka src
//  12. native-editor     — editor ki top bar ka "Download media"
//      (native-menu yahan dobara NAHI chalta — wo pehle hi ho gaya)
const DOWNLOAD_ROUTE_ORDER = Object.freeze([
  'quick-check',
  'zero-click',
  'direct-viewer',
  'native-menu',
  'blob-harvest',
  'backend-fetch',
  'backend-order',
  'tile-readiness',
  'backend-fetch-retry',
  'tile-src-fast',
  'tile-src',
  'native-editor'
]);

/** Pehli ranneeti ke baad ki fallback tartib (purani aapas-tartib barkarar). */
function fallbackRouteOrder() {
  return DOWNLOAD_ROUTE_ORDER.slice(1);
}

/** Pehli (sab se pehle chalne wali) ranneeti. */
function firstRoute() {
  return DOWNLOAD_ROUTE_ORDER[0];
}

module.exports = { DOWNLOAD_ROUTE_ORDER, fallbackRouteOrder, firstRoute };
