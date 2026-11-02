'use strict';

// v2.48.28 (SERVER-FIRST): _downloadTaskMediaInner ki ranneeti-
// tartib ka ek-matra sach (single source of truth), taaki tests
// use seedha jaanch saken aur tartib kabhi chup-chaap na badle.
//
// FASTTEST2 (v2.48.27, owner ke PC par engine-log sabit,
// 2026-11-02 21:27): SERVER CHANNEL MIL GAYA — file Flow ke
// server `flow-content.google/video/*` se aati hai (signed CDN,
// video/mp4). Page tile ke saath harkat ke dauraan khud ye fetch
// karta hai, aur fetch hue bytes v2.48.26 ki registry me bhi aa
// jate hain (extraction sirf 131ms lagi thi). Us run me menu
// route FAIL ho gaya tha (⋮ khula, Download item nahi mila,
// ~12s zaya) aur save phir bhi ho gaya — registry se. Is liye ab
// SAB SE PEHLE wohi do raaste hain jo server se uthate hain:
// tile ko prime karke (view + muted play + ⋮ menu ka ek
// khul-band chakkar, Download NAHI dabega) server-fetch ko
// bulawa do, phir registry aur asal server URL — jo pehle mile
// usi se save. (Prime se file fetch hoti hai — ye FASTTEST2 ki
// ek-run timing se nikla HYPOTHESIS hai, pakka usool nahi.)
//
// FASTTEST1 (v2.48.26) ki seekh bhi barkarar hai: kabhi-kabhi
// file page-fetch se guzarti hi nahi (blob aur tareeqe se banta
// hai) — is liye menu wala rasta, jo click par blob banwata
// hai, dusre number par poora barkarar hai.
//
// Kram (video tasks):
//   1. server-first      — prime + registry harvest / flow-content
//                          seedha server fetch (v2.48.28)
//   2. native-menu       — ⋮ menu → Download → resolution select
//   3. blob-harvest      — page ke andar ke bytes (v2.48.26 FAST-DL)
//   4. backend-fetch     — bandha backend link seedha fetch
//   5. backend-order     — kram se bandhan (claimByOrder)
//   6. tile-readiness    — tile media ready hone ka intezaar
//   7. backend-fetch-retry — readiness ke baad backend ek aur baar
//   8. tile-src-fast     — tile ka apna src, turant fetch (v2.47.4)
//   9. tile-src          — tile/stream ka src
//  10. native-editor     — editor ki top bar ka "Download media"
//      (native-menu yahan dobara NAHI chalta — wo pehle hi ho gaya)
const DOWNLOAD_ROUTE_ORDER = Object.freeze([
  'server-first',
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
