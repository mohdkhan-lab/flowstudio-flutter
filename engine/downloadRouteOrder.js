'use strict';

// v2.48.27 (MENU-FIRST): _downloadTaskMediaInner ki ranneeti-tartib
// ka ek-matra sach (single source of truth), taaki tests use seedha
// jaanch saken aur tartib kabhi chup-chaap na badle.
//
// FASTTEST1 (v2.48.26, owner ke PC par engine-log sabit,
// 2026-11-02): render-complete ke pal page ke andar video bytes
// hote hi NAHI (FAST-DL registry khaali mili); file ke bytes sirf
// ⋮ menu ke Download click ke BAAD page me aate hain aur blob
// banta hai. Is liye menu wala rasta — jo file asal me LAATA hai —
// ab SAB SE PEHLE chalta hai; baaki saari ranneetiyan apni purani
// aapas-tartib me sirf FALLBACK hain (menu fail ho tabhi).
//
// Kram (video tasks):
//   1. native-menu       — ⋮ menu → Download → resolution select
//   2. blob-harvest      — page ke andar ke bytes (v2.48.26 FAST-DL)
//   3. backend-fetch     — bandha backend link seedha fetch
//   4. backend-order     — kram se bandhan (claimByOrder)
//   5. tile-readiness    — tile media ready hone ka intezaar
//   6. backend-fetch-retry — readiness ke baad backend ek aur baar
//   7. tile-src-fast     — tile ka apna src, turant fetch (v2.47.4)
//   8. tile-src          — tile/stream ka src
//   9. native-editor     — editor ki top bar ka "Download media"
//      (native-menu yahan dobara NAHI chalta — wo pehle hi ho gaya)
const DOWNLOAD_ROUTE_ORDER = Object.freeze([
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

/** Menu ke baad ki fallback tartib (purani aapas-tartib barkarar). */
function fallbackRouteOrder() {
  return DOWNLOAD_ROUTE_ORDER.slice(1);
}

/** Pehli (sab se pehle chalne wali) ranneeti. */
function firstRoute() {
  return DOWNLOAD_ROUTE_ORDER[0];
}

module.exports = { DOWNLOAD_ROUTE_ORDER, fallbackRouteOrder, firstRoute };
