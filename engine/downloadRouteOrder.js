'use strict';

// ---------------------------------------------------------------------------
// VIDEO DOWNLOAD KI TARTIB (DOWNLOAD ROUTE ORDER) — wahid sachai
// (single source of truth; saalon ke live tajurbe se bani hui).
//
// Tareekh jo log bhool jate hain (mukhtasar):
//   v2.19.x — ⋮ menu kabhi hota hi nahi tha; editor-open sab se
//             dheema; CDN fetch menu se bhi tez nikla.
//   v2.48.30–.35 — quick-check + direct-viewer (viewer ke Download
//             button ka click) + zero-click substitution probe;
//             substitution ZEROCLICK2 me falsify hua (mint call me
//             badalne ko koi id hi nahi — idsInBody=0, idsInUrl=0).
//   v2.48.36 (ROOT PACK) — verbatim mint replay (grid + editor
//             context) aur page-fetch harvest tartib me aaye.
//   v2.48.37 (ZEROCLICK5) — dono replay raaste teacher URL par
//             falsify hue: mint call session ke LAST-MINTED media
//             ka hi address deti hai; tile/editor context use nahi
//             badalta. Sirf editor ke apne playback fetch ne asal
//             bytes diye.
//   v2.48.38–.39 (EDITOR-HARVEST) — editor ke playback fetch ke
//             bytes pakadna (koi click nahi, koi menu nahi).
//   v2.48.40 (INVISIBLE HARVEST) — wahi harvest ek CDP background
//             page par; ZEROCLICK8 (2026-11-04) me dono video
//             bg=yes se save hue LEKIN owner ne editor ko DUSRE
//             TAB me chalte hue apni aankhon se dekha aur pack
//             RADD kar diya: "editor dusra tab ma chal ratha
//             mujah ya nahi chya".
//
// v2.48.41 (MAIN-PAGE HARVEST PACK — owner order, 2026-11-04):
// download SIRF usi project/grid page se hoga jis par video
// banti hai. Editor kahin bhi NAHI khulega — na main tab, na
// dusra tab, na CDP background page/tab. Koi fallback kuch
// nahi dikhayega. Tartib bas do qadmon ki hai:
//
//   1. 'mainpage-harvest' — render-complete par sab se pehle
//      MAIN page ki apni kitab: jo flow-content / googlevideo
//      (videoplayback) stream is task se bandhi hui main page
//      par pehle se dikhi ho, us ke bytes — pehle se pakdi hui
//      mukammal body ho to wohi; warna usi URL ka POORA fetch
//      main page ke apne JS context se (page.evaluate fetch,
//      credentials sameet). Adhoora (googlevideo range) jawab
//      ho to usi page-context se poora fetch (range hisse
//      hata kar ya Range: bytes=0- se). Kuch nahi khulta,
//      kuch click nahi hota — audit lineain ('[ROOT]
//      mainpage-audit …') har video-jese jawab ko darj karti
//      hain taaki saboot log se hi mile.
//   2. 'grid-replay' — seekhi hui mint darkhwast ka hu-bahu
//      (verbatim) replay MAIN page se — teacher-guarded:
//      teacher ka address aaye to fetch KABHI nahi.
//
// Is ke baad KOI rasta nahi. Dono haar jayein to attempt
// EMAANDARI se FAIL hota hai (retry rounds phir yahi do
// raaste aazmate hain); prompt dobara KABHI nahi bheja jata
// (sacred rule barkarar). Editor-harvest (visible + bg),
// replay-context, direct-viewer, ⋮ menu (native-menu /
// native-editor), blob-harvest, backend-fetch/-order/-retry,
// tile-readiness aur tile-src — sab is tartib se aur video
// attempt path se HAMESHA ke liye bahar hain.
// IMAGE tasks is tartib se bandhe nahi hain — un ka purana
// backend/tile-src/native rasta apni jagah barqarar hai.
// ---------------------------------------------------------------------------

const DOWNLOAD_ROUTE_ORDER = Object.freeze([
  'mainpage-harvest',
  'grid-replay'
]);

/** Bharri hui copy — tartib ka pehla rasta chhor kar baaki (fallback) raaste. */
function fallbackRouteOrder() {
  return DOWNLOAD_ROUTE_ORDER.slice(1);
}

/** Tartib ka sab se pehla rasta. */
function firstRoute() {
  return DOWNLOAD_ROUTE_ORDER.length > 0 ? DOWNLOAD_ROUTE_ORDER[0] : null;
}

module.exports = { DOWNLOAD_ROUTE_ORDER, fallbackRouteOrder, firstRoute };
