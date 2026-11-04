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
// nahi dikhayega. Us waqt tartib bas do qadmon ki thi:
// mainpage-harvest, phir grid-replay.
//
// v2.48.44 (HEADLESS HARVEST PACK — owner sequence,
// 2026-11-04): Option 1 (main-page family) ZEROCLICK9/10/11
// ke baad khatam — grid hover sabit taur par sirf ~91–128KB
// ki preview stream laata hai; asal ~1.2MB file grid par
// kabhi load hi nahi hoti. Option 3 (visible/background
// editor-harvest) owner ki tarteeb me SAB SE AAKHRI chaara
// hai aur is pack me NAHI hai. Ab tartib teen qadmon ki hai:
//
//   1. 'headless-harvest' — account ke Chrome profile ki
//      ek throwaway COPY par BILKUL BINA-WINDOW (headless)
//      Chrome: screen par kuch aa hi nahi sakta kyunki
//      window banti hi nahi. PROBE-FIRST: copied session
//      pehle ek jaanch se guzregi ('[ROOT] headless-probe
//      state=<logged-in|logged-out|blocked>'); qubool na
//      ho to rasta EMAANDARI se, editor khole baghair,
//      haar kar aage badhega. Qubool ho to usi adrishya
//      browser me task ka editor khulta hai aur editor
//      ki apni playback stream (ZEROCLICK6/7 ka sabit
//      bytes-zariya) capture/saveGuard mashineri se save
//      hoti hai. Clone har koshish ke baad mit jata hai;
//      asal profile kabhi khulta/likha nahi jata.
//   2. 'mainpage-harvest' — MAIN page ki apni kitab: jo
//      flow-content / googlevideo (videoplayback) stream
//      is task se bandhi hui main page par pehle se dikhi
//      ho, us ke bytes — pehle se pakdi hui mukammal body
//      ho to wohi; warna usi URL ka POORA fetch main page
//      ke apne JS context se (page.evaluate fetch,
//      credentials sameet). Kuch nahi khulta, kuch click
//      nahi hota — audit lineain ('[ROOT] mainpage-audit
//      …') har video-jese jawab ko darj karti hain.
//   3. 'grid-replay' — seekhi hui mint darkhwast ka hu-bahu
//      (verbatim) replay MAIN page se — teacher-guarded:
//      teacher ka address aaye to fetch KABHI nahi.
//
// Is ke baad KOI rasta nahi. Teeno haar jayein to attempt
// EMAANDARI se FAIL hota hai (retry rounds phir yahi teen
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
  'headless-harvest',
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
