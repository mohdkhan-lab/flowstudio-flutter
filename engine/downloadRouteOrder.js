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
// v2.48.33 (ZEROCLICK — PROBE): quick-check ke baad naya
// qadam 'zero-click' — session ke kisi pehle task ke download
// me seekhi hui mint-call (batchexecute darkhwast jis ka
// jawab file-address le aaya tha) ko teacher ke ID ki jagah
// is task ka ID rakh kar page ke andar se replay karna, bina
// kisi UI click ke. Jawab address le aaye to wahi verified
// server-fetch se save; na aaye (H2) ya replay nakam ho to
// 'direct-viewer' wali tartib bilkul pehle ki tarah. Pehle
// task par template hota hi nahi — ye qadam khamoshi se
// guzar jata hai.
//
// v2.48.36 (ROOT PACK): tartib ki jad wali tabdeeli —
// substitution wala 'zero-click' qadam GAYA (ZEROCLICK2 ne
// sabit kar diya: mint call me badalne ko koi id hai hi
// nahi — idsInBody=0, idsInUrl=0). Us ki jagah do HU-BAHU
// (verbatim) replay raaste, kyunke .35 ke probe ne dikhaya
// ke call session ke current media ka address deti hai:
//   - 'grid-replay': editor khole baghair tile ko grid
//     par selected/focused karke wahi call — jawab TEACHER
//     ka address le aaye to fetch NAHI hota, naya aaye to
//     claim + verified server-fetch.
//   - 'replay-context': is task ka editor khol kar (Download
//     button NAHI dabta) usi context se wahi call; haar par
//     editor khula rehta hai aur 'direct-viewer' usi se
//     aage badhta hai.
// Aur 'quick-check' ke andar ab PAGE-FETCH HARVEST bhi hai:
// page ne khud server se jo bytes khinche the, capture ne
// unhe task ke naam rakha ho to wohi exact file seedha
// save hoti hai (route C ke andar editor khulne ke baad
// bhi wahi jaanch dobara hoti hai — jeet par strategy ka
// naam 'page-harvest' banta hai, lekin tartib me wo
// quick-check/replay-context ke andar ka hi hisa hai).
// Poora download marhala ab capture-session ke stage
// tale (stageLock) ke andar ek-ek karke chalta hai —
// generation parallel rehti hai, download kabhi aapas me
// nahi ulajhta (ZEROCLICK3 ki mint-binding wali seekh).
//
// v2.48.38 (EDITOR-HARVEST PACK): replay-context ke baad
// naya qadam 'editor-harvest' — ZEROCLICK5 (v2.48.37) ne
// dono replay raaste teacher URL par falsify kar diye
// (mint call session ke last-minted media ka hi address
// deti hai), lekin usi log me editor apni playback ke
// liye file khud mangta dikha: editor-open khidki ke
// andar, Download button dabne se PEHLE, ≈file-size ka
// flow-content GET. Ye rasta usi khule editor (route C
// wala) ke andar dekhe gaye jawabon ke bytes pakadta hai
// — nisbat sirf sanrachna se (jawab is task ke editor ke
// khule hone ki khidki ke andar aaya ho, teacher ka
// address na ho), hash guard dusri hifazat. Adhoora
// jawab (206 / Content-Range / floor se neeche) usi URL
// ka page-context poora fetch bulata hai. Haar par
// editor khula rehta hai aur direct-viewer usi se aage
// badhta hai — click/menu is raaste me bhi NAHI hota.
//
// v2.48.40 (INVISIBLE HARVEST PACK): tartib bilkul
// wahi hai — badla sirf ye hai ke replay-context aur
// editor-harvest ke liye editor ab worker ke ek
// BACKGROUND page par khulta hai (wahi browser
// context/session; asal page grid par hi rehta hai,
// screen par kuch show nahi hota; jeet ki line par
// bg=yes). Background page na bane to
// '[ROOT] editor-harvest bg-failed <reason>' ke saath
// purana dikha-hua editor hi fallback hai, aur
// background page har koshish ke baad band hota hai.
// Saath me cascade diagnostic (observe-only): har
// attempt ke aakhir par '[ROOT] cascade firstSeen=…
// preEditorUrl=…' — file ka address sab se pehle
// kahan dekha gaya tha.
//
// Kram (video tasks):
//   1. quick-check       — NO-WAIT: page-harvest (page ke
//                          khinche hue bytes) + registry
//                          bytes / flow-content URL ka
//                          turant save (attempt ka pehla
//                          qadam)
//   2. grid-replay       — ROOT PACK B (v2.48.36): tile ko
//                          grid par select/focus karke
//                          seekhi hui mint-call ka hu-bahu
//                          replay — editor nahi, click
//                          nahi, menu nahi
//   3. replay-context    — ROOT PACK C (v2.48.36): editor
//                          ke context se wahi hu-bahu
//                          replay (Download button NAHI
//                          dabta; andar page-harvest bhi)
//   4. editor-harvest    — EDITOR-HARVEST (v2.48.38): usi
//                          khule editor ki playback ke
//                          flow-content bytes pakdo —
//                          Download button NAHI, menu NAHI
//   5. direct-viewer     — PRIMARY (v2.48.32): tile viewer ka
//                          apna Download button (bina menu) —
//                          click se mint hua server address,
//                          app ki server-fetch se save
//   6. native-menu       — ⋮ menu → Download → resolution select
//                          (+ v2.48.30 post-click server race)
//   7. blob-harvest      — page ke andar ke bytes (v2.48.26 FAST-DL)
//   8. backend-fetch     — bandha backend link seedha fetch
//   9. backend-order     — kram se bandhan (claimByOrder)
//  10. tile-readiness    — tile media ready hone ka intezaar
//  11. backend-fetch-retry — readiness ke baad backend ek aur baar
//  12. tile-src-fast     — tile ka apna src, turant fetch (v2.47.4)
//  13. tile-src          — tile/stream ka src
//  14. native-editor     — editor ki top bar ka "Download media"
//      (native-menu yahan dobara NAHI chalta — wo pehle hi ho gaya)
const DOWNLOAD_ROUTE_ORDER = Object.freeze([
  'quick-check',
  'grid-replay',
  'replay-context',
  'editor-harvest',
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
