import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// FlowStudio v2.26.0 — 10-theme pack (owner-approved, 2026-10-24).
/// v2.39.0: + Crimson / Matte / Ember (owner-approved samples,
/// 2026-10-27) — 13 themes, 26 palettes.
///
/// Settings now has a Mode control (Dark / Light / System) and a grid of
/// colour themes. EVERY theme ships in both a Dark and a Light
/// palette; choosing a theme never forces the mode —
/// switching mode keeps the theme and swaps to its other palette.
///
/// Theme 1 "macOS Classic" is the default and is the owner's locked
/// final pair: its Dark palette is exactly the old Soft Charcoal values
/// and its Light palette exactly the old Creamy values.
///
/// Status colours are FIXED in every palette (owner rule): the
/// "● ACTIVE" gold, LIVE green and FAIL red never change with the theme.
///
/// v2.48.86 (owner, light-theme screenshot): the LIGHT palettes'
/// textDim / textFaint / border / borderSoft were washed out on
/// white — labels, hints and card edges blended into the canvas.
/// Contrast repair, LIGHT palettes only (dark palettes are
/// byte-untouched): textDim deepened to a mid-slate with real
/// contrast, textFaint raised to the old textDim level (≈4.5:1
/// or better on white), borders strengthened one-to-two steps
/// so cards separate from the canvas, and inputBg given each
/// family's palest tint (bg2) so input fields read as distinct
/// fills on white cards. The white-card + gold-accent identity
/// of the light theme is unchanged — this is legibility only.
///
/// v2.48.88 (owner, .87 light screenshot): ONE LIGHT THEME ONLY —
/// "jitne bhi light themes ke colour templates hain un sab ko
/// hata do, sirf white me yahi rakho." All 13 light palettes are
/// REMOVED; light mode now resolves every theme id to the single
/// owner-approved Design-3 WHITE palette ([_whiteLight]: deep
/// slate canvas #CBD5E1, pure-white cards, strong #788AA0
/// borders, #E2E8F0 inputs, near-black/slate text, GOLD the only
/// accent). A stored theme named for a removed light palette
/// falls back to white cleanly (see [paletteFor]). The 13 DARK
/// palettes are byte-identical — the theme grid still offers
/// every family in Dark mode; in Light mode it offers the one
/// white theme. The palette-derived `blue` token also resolves
/// to the gold accent in light mode (owner: no blue in the
/// white theme); dark keeps its #64D2FF.
///
/// Every token below is still a getter on [AppTheme], so the 200+
/// existing call sites keep working unchanged — they now delegate to
/// the currently applied [AppPalette].

/// One concrete colour set: a single theme in a single mode.
class AppPalette {
  final String id;
  final bool dark;

  // Surfaces (from the approved sample hexes)
  final Color bgBody;
  final Color bg2; // gradient partner of bgBody (previews / subtle washes)
  final Color surface;
  final Color surfaceElevated;
  final Color inputBg;
  final Color border;
  final Color borderSoft;

  // Accents
  final Color accentGold; // the family's primary accent
  final Color accentAmber; // lighter companion accent
  final Color accentText; // accent tuned for text on surfaces

  // Text
  final Color textMain;
  final Color textDim;
  final Color textFaint;

  // Gradient stops
  final Color gradStart;
  final Color gradEnd;
  final Color panelTop;
  final Color panelBottom;

  const AppPalette({
    required this.id,
    required this.dark,
    required this.bgBody,
    required this.bg2,
    required this.surface,
    required this.surfaceElevated,
    required this.inputBg,
    required this.border,
    required this.borderSoft,
    required this.accentGold,
    required this.accentAmber,
    required this.accentText,
    required this.textMain,
    required this.textDim,
    required this.textFaint,
    required this.gradStart,
    required this.gradEnd,
    required this.panelTop,
    required this.panelBottom,
  });

  Color get onAccent => const Color(0xFFFFFFFF);

  // v2.25.0 (parked browser): the gold of the "● ACTIVE" text and the
  // active account row's border. FIXED across all themes — deeper gold
  // on light palettes, brighter gold on dark palettes.
  // v2.48.89 (owner: light-mode text still not crisp): the light
  // value deepens one full step to amber-800 #92400E (~7.1:1 on
  // white) — #CF8A04 measured only ~2.9:1 as small text. The dark
  // value is byte-identical.
  // v2.48.90: on the owner's WARM CREAM card (#FFFCF2) #92400E
  // measures only ~6.9:1, so the light value deepens one more
  // step to #854008 (~7.5:1 on the cream card). Dark identical.
  // v2.48.91: the light value follows accentText to the owner's
  // own "Warm Sand" spec value #92400E (the .89/.90 relationship
  // activeGold == accentText on light is preserved; ~7.0:1 on
  // the Warm Sand card #FFFDF6). Dark identical.
  Color get activeGold =>
      dark ? const Color(0xFFF5B301) : const Color(0xFF92400E);

  // Status colours — mac greens/reds, FIXED across all themes.
  // v2.48.89: the LIGHT branches deepen to clearly-readable text
  // values on white (green-800 #166534 ~7.1:1, red-700 #B91C1C
  // ~6.5:1; the old mac tints #34C759/#FF3B30 measured ~2.2:1 and
  // ~3.5:1 as the small Live/Fail texts). The tint backgrounds
  // follow their text colour. Dark branches byte-identical.
  // v2.48.90: #166534 measures only ~6.9:1 on the cream card, so
  // the light green deepens to green-900 #14532D (~8.9:1); the
  // tint background follows. Red holds at #B91C1C (~6.3:1).
  Color get green => dark ? const Color(0xFF30D158) : const Color(0xFF14532D);
  Color get greenBg =>
      dark ? const Color(0x1F30D158) : const Color(0x1F14532D);
  Color get red => dark ? const Color(0xFFFF453A) : const Color(0xFFB91C1C);
  Color get redBg => dark ? const Color(0x1FFF453A) : const Color(0x1FB91C1C);
  // v2.48.88: in light mode this is the GOLD accent, not a blue —
  // the single white theme carries no blue anywhere (the token
  // feeds info/running accents in Progress + Notifications +
  // card hovers). Dark keeps its sky blue, byte-identical.
  // v2.48.91: the light value follows accentGold to the Warm
  // Sand spec's #B45309 (the .88 relationship blue == accentGold
  // on light is preserved).
  Color get blue => dark ? const Color(0xFF64D2FF) : const Color(0xFFB45309);

  // Subtle inner overlays (white-alpha on dark palettes, black-alpha on
  // light palettes — same values the app has always used per mode).
  Color get overlay08 =>
      dark ? const Color(0x08FFFFFF) : const Color(0x0A000000);
  Color get overlay10 =>
      dark ? const Color(0x10FFFFFF) : const Color(0x12000000);
  Color get overlay20 =>
      dark ? const Color(0x20FFFFFF) : const Color(0x1F000000);

  // 3D tactile elevation and bevel shadow tokens (theme-adaptive)
  Color get bevelPrimary => dark ? const Color(0xFF0A0E17) : border;
  Color get bevelSecondary => dark ? const Color(0xFF060910) : borderSoft;
  Color get borderHighlight => accentGold.withValues(alpha: dark ? 0.45 : 0.35);
  Color get glowPrimary => accentGold;

  // v2.48.90 (owner's warm-cream sample — "asa color karo"): the
  // ONE uniform light-mode button face, a warm tan #D8CFB4.
  // Every button's light branch rests on this token, so no
  // button reads dark-filled on one surface and light on
  // another. Only ever read on light branches — the dark value
  // simply mirrors the overlay fill dark buttons already use.
  // v2.48.91: the light face is the owner's "Warm Sand" spec
  // value #E3D5B5 (his own design, applied 1:1).
  Color get buttonBg => dark ? overlay10 : const Color(0xFFE3D5B5);

  // v2.48.90 (owner: when the UI glows it turns "black faded"):
  // the warm shadow base for light mode — a deep warm
  // gold-brown #7A5C14. Every light-mode shadow is built from
  // this colour (or from the gold accent itself), never from
  // black, so glows and shadows read as a soft warm tint on
  // the cream surfaces. Only read on light branches; the dark
  // value is plain black, exactly what dark shadows already use.
  // v2.48.91: the light base is the owner's "Warm Sand" spec
  // value #8A6D1F (applied 1:1).
  Color get warmShadow =>
      dark ? const Color(0xFF000000) : const Color(0xFF8A6D1F);

  LinearGradient get accentGrad => LinearGradient(
        colors: [gradStart, gradEnd],
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
      );

  LinearGradient get panelGrad => LinearGradient(
        colors: [panelTop, panelBottom],
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
      );
}

class AppTheme {
  /// True when a dark palette is active.
  static bool dark = true;

  /// The selected colour theme id (see [themeIds]).
  static String themeId = 'gold';

  static const List<String> themeIds = [
    'gold',
    'macos',
    'midnight',
    'graphite',
    'emerald',
    'purple',
    'slate',
    'sunset',
    'teal',
    'rose',
    'crimson',
    'matte',
    'ember',
  ];

  /// v2.48.88: the ONE light theme's picker name. In Light mode
  /// the theme grid shows exactly this single card (see
  /// settings_view._buildThemeGrid).
  static const String whiteThemeName = 'Studio White';

  static const Map<String, String> themeNames = {
    'gold': 'Royal Velvet Gold',
    'macos': 'macOS Classic',
    'midnight': 'Midnight Blue',
    'graphite': 'Graphite + White',
    'emerald': 'Emerald',
    'purple': 'Royal Purple',
    'slate': 'Slate Pro',
    'sunset': 'Sunset',
    'teal': 'Ocean Teal',
    'rose': 'Rose',
    'crimson': 'Crimson',
    'matte': 'Matte',
    'ember': 'Ember',
  };

  static AppPalette _current = _goldDark;

  /// The palette for theme [id] in the given mode. Unknown ids fall
  /// back to Royal Velvet Gold, so a bad stored value can never break the UI.
  /// v2.48.88: LIGHT mode ignores [id] entirely — there is exactly
  /// one light palette (the white theme), so a stored theme named
  /// for any of the removed light palettes lands on white cleanly.
  static AppPalette paletteFor(String id, bool isDark) {
    if (!isDark) return _whiteLight;
    return _darkPalettes[id] ?? _goldDark;
  }

  /// Applies theme [id] + mode [isDark] as the live palette. Called
  /// from main.dart whenever either setting changes.
  static void applyTheme(String id, bool isDark) {
    themeId = themeIds.contains(id) ? id : 'gold';
    dark = isDark;
    _current = paletteFor(themeId, isDark);
  }

  // ------------------------------------------------------------------
  // Palettes. Sample hexes are the approved source; derived tokens:
  //  - borderSoft: dark = midway between input and border;
  //    light = border lightened toward the surface.
  //  - textFaint: one step fainter than textDim (toward the bg).
  //  - accentAmber: the lighter accent-gradient stop.
  //  - accentText: dark palettes = lighter gradient stop; light
  //    palettes = the family accent (macos light keeps #0066CC,
  //    gold light uses #8A6508).
  //  - panelGrad: [elevated -> surface], except macOS Classic which
  //    keeps the exact pre-v2.26 gradient stops.
  // For macOS Classic, textDim/textFaint keep today's exact values
  // (the sample's "dim" is today's textFaint).
  // ------------------------------------------------------------------

  static const AppPalette _goldDark = AppPalette(
    id: 'gold', dark: true,
    bgBody: Color(0xFF080604), bg2: Color(0xFF140F0A),
    surface: Color(0xFF18120B), surfaceElevated: Color(0xFF231C14),
    inputBg: Color(0xFF060402),
    border: Color(0xFFD4AF37), borderSoft: Color(0x3DFBBF24),
    accentGold: Color(0xFFF59E0B), accentAmber: Color(0xFFFBBF24),
    accentText: Color(0xFFFEF3C7),
    textMain: Color(0xFFFEF3C7), textDim: Color(0xFFD4AF37),
    textFaint: Color(0xFFA3907C),
    gradStart: Color(0xFFFBBF24), gradEnd: Color(0xFFB45309),
    panelTop: Color(0xFF231C14), panelBottom: Color(0xFF0E0A06),
  );

  static const AppPalette _macosDark = AppPalette(
    id: 'macos', dark: true,
    bgBody: Color(0xFF16191F), bg2: Color(0xFF12141A),
    surface: Color(0xFF191D26), surfaceElevated: Color(0xFF222734),
    inputBg: Color(0xFF13151C),
    border: Color(0xFF383F4C), borderSoft: Color(0xFF252A34),
    accentGold: Color(0xFF0A84FF), accentAmber: Color(0xFF409CFF),
    accentText: Color(0xFF409CFF),
    textMain: Color(0xFFFFFFFF), textDim: Color(0xFFD1D1D6),
    textFaint: Color(0xFFA1A1A6),
    gradStart: Color(0xFF3A98FF), gradEnd: Color(0xFF0066D6),
    panelTop: Color(0xFF222734), panelBottom: Color(0xFF141720),
  );

  // v2.48.88: THE one and only light palette — the owner-approved
  // Design-3 white theme (these are exactly the v2.48.87 'gold'
  // light values: deep slate frame, pure-white cards, STRONG
  // #788AA0 borders, #E2E8F0 inputs, near-black / slate text,
  // gold the only accent). Every light-mode lookup resolves
  // here; the 13 per-family light palettes are gone.
  // v2.48.89 (owner, on the .88 screenshot: text colour still not
  // right — text must be "saaf saaf" visible): the text ramp
  // deepens one full step (textMain #05080C, textDim #1E293B,
  // textFaint #334155 — the FLOOR for every hint/placeholder/
  // disabled text in light mode) and accentText deepens to
  // amber-800 #92400E (#B45309 measured only ~5.0:1 on white).
  // v2.48.90 (owner's own recoloured sample, image-46 — "asa
  // color karo"): the palette is RECOLOURED to the sample's
  // WARM CREAM scheme, superseding the cool slate-white above.
  // Tones sampled from his sample: canvas a deeper warm cream
  // #E9DCB8, cards/panels warm white #FFFCF2, input/textarea
  // fills pale warm cream #E9E2CC, borders tan/khaki #C9BB96
  // (border AND borderSoft — the strong-border discipline is
  // kept), warm gold accents unchanged. TEXT STAYS DEEP, warmed
  // to brown-black and re-derived against the cream card so
  // the .89 discipline holds: textMain #1A1408 (~17.8:1),
  // textDim #3E3420 (~11.9:1), textFaint #4F422A (~9.5:1 on
  // the card, ~7.6:1 even on input fills — still the floor),
  // accentText #854008 (~7.5:1). Still ONE single light theme.
  // v2.48.91 (2026-11-10, owner's own design): the owner built
  // his light theme on the Theme Designer page and pasted his
  // final spec — "Warm Sand" — applied here EXACTLY 1:1, no
  // value adjusted: bgBody #E7DCC8, surface #FFFDF6,
  // panelBottom #F7EFDC, inputBg #EFE6D2, border #C4B28C,
  // borderSoft #D3C49E (the spec splits the two border roles —
  // the strong-border discipline is kept via the border role),
  // textMain #211806, textDim #453A20, textFaint #5C4E2E,
  // accentGold #B45309, accentText #92400E. Tokens the spec
  // does not name follow their established relationships:
  // surfaceElevated = panelTop = surface, bg2 = bgBody shifted
  // by the .90 bgBody->bg2 delta (-11,-13,-21) = #DCCFB3,
  // accentAmber = one step lighter on the amber ladder
  // (#D97706, as .90's #F59E0B sat above its #D97706),
  // gradStart = accentAmber, gradEnd = accentGold, and the
  // mode-branched getters follow (activeGold = accentText,
  // blue = accentGold, glowPrimary = accentGold, bevels =
  // border/borderSoft, buttonBg #E3D5B5 and warmShadow
  // #8A6D1F from the spec). Contrast on the Warm Sand card
  // #FFFDF6 (computed): textMain ~17.2:1, textDim ~11.0:1,
  // textFaint ~8.0:1, accentText ~7.0:1, green ~9.0:1,
  // red ~6.4:1. Still ONE single light theme.
  static const AppPalette _whiteLight = AppPalette(
    id: 'white', dark: false,
    bgBody: Color(0xFFE7DCC8), bg2: Color(0xFFDCCFB3),
    surface: Color(0xFFFFFDF6), surfaceElevated: Color(0xFFFFFDF6),
    inputBg: Color(0xFFEFE6D2),
    border: Color(0xFFC4B28C), borderSoft: Color(0xFFD3C49E),
    accentGold: Color(0xFFB45309), accentAmber: Color(0xFFD97706),
    accentText: Color(0xFF92400E),
    textMain: Color(0xFF211806), textDim: Color(0xFF453A20),
    textFaint: Color(0xFF5C4E2E),
    gradStart: Color(0xFFD97706), gradEnd: Color(0xFFB45309),
    panelTop: Color(0xFFFFFDF6), panelBottom: Color(0xFFF7EFDC),
  );

  static const Map<String, AppPalette> _darkPalettes = {
    'gold': _goldDark,
    'macos': _macosDark,
    'midnight': AppPalette(
      id: 'midnight', dark: true,
      bgBody: Color(0xFF0F1B2D), bg2: Color(0xFF12233B),
      surface: Color(0xFF16283F), surfaceElevated: Color(0xFF1E3554),
      inputBg: Color(0xFF0B1626),
      border: Color(0xFF2E4A6B), borderSoft: Color(0xFF1E3048),
      accentGold: Color(0xFF409CFF), accentAmber: Color(0xFF1A94FF),
      accentText: Color(0xFF1A94FF),
      textMain: Color(0xFFF2F7FF), textDim: Color(0xFF8FA9C7),
      textFaint: Color(0xFF7189A5),
      gradStart: Color(0xFF1A94FF), gradEnd: Color(0xFF0066D6),
      panelTop: Color(0xFF1E3554), panelBottom: Color(0xFF16283F),
    ),
    'graphite': AppPalette(
      id: 'graphite', dark: true,
      bgBody: Color(0xFF131314), bg2: Color(0xFF1A1A1C),
      surface: Color(0xFF1E1E20), surfaceElevated: Color(0xFF2A2A2D),
      inputBg: Color(0xFF0D0D0E),
      border: Color(0xFF3D3D40), borderSoft: Color(0xFF252527),
      accentGold: Color(0xFF0A84FF), accentAmber: Color(0xFF1A94FF),
      accentText: Color(0xFF1A94FF),
      textMain: Color(0xFFF5F5F7), textDim: Color(0xFF98989D),
      textFaint: Color(0xFF7C7C81),
      gradStart: Color(0xFF1A94FF), gradEnd: Color(0xFF0066D6),
      panelTop: Color(0xFF2A2A2D), panelBottom: Color(0xFF1E1E20),
    ),
    'emerald': AppPalette(
      id: 'emerald', dark: true,
      bgBody: Color(0xFF0C231B), bg2: Color(0xFF0F2C21),
      surface: Color(0xFF143327), surfaceElevated: Color(0xFF1C4534),
      inputBg: Color(0xFF081A13),
      border: Color(0xFF2A5A46), borderSoft: Color(0xFF193A2D),
      accentGold: Color(0xFF2FD574), accentAmber: Color(0xFF4ADE80),
      accentText: Color(0xFF4ADE80),
      textMain: Color(0xFFEFFDF5), textDim: Color(0xFF93BFA9),
      textFaint: Color(0xFF749C86),
      gradStart: Color(0xFF4ADE80), gradEnd: Color(0xFF0E9F5A),
      panelTop: Color(0xFF1C4534), panelBottom: Color(0xFF143327),
    ),
    'purple': AppPalette(
      id: 'purple', dark: true,
      bgBody: Color(0xFF1D1735), bg2: Color(0xFF241C44),
      surface: Color(0xFF2A2149), surfaceElevated: Color(0xFF372B5E),
      inputBg: Color(0xFF130E26),
      border: Color(0xFF4A3D78), borderSoft: Color(0xFF2F2650),
      accentGold: Color(0xFFBF5AF2), accentAmber: Color(0xFFD18CFF),
      accentText: Color(0xFFD18CFF),
      textMain: Color(0xFFF7F2FF), textDim: Color(0xFFADA3CC),
      textFaint: Color(0xFF8C82AB),
      gradStart: Color(0xFFD18CFF), gradEnd: Color(0xFF7D3FE0),
      panelTop: Color(0xFF372B5E), panelBottom: Color(0xFF2A2149),
    ),
    'slate': AppPalette(
      id: 'slate', dark: true,
      bgBody: Color(0xFF22262D), bg2: Color(0xFF282C34),
      surface: Color(0xFF2E333C), surfaceElevated: Color(0xFF3B414C),
      inputBg: Color(0xFF191C21),
      border: Color(0xFF4E5663), borderSoft: Color(0xFF343A44),
      accentGold: Color(0xFF64D2FF), accentAmber: Color(0xFF8AD9FF),
      accentText: Color(0xFF8AD9FF),
      textMain: Color(0xFFF5F7FA), textDim: Color(0xFFA7B0BE),
      textFaint: Color(0xFF87919E),
      gradStart: Color(0xFF8AD9FF), gradEnd: Color(0xFF0B7AC0),
      panelTop: Color(0xFF3B414C), panelBottom: Color(0xFF2E333C),
    ),
    'sunset': AppPalette(
      id: 'sunset', dark: true,
      bgBody: Color(0xFF2B170E), bg2: Color(0xFF36200F),
      surface: Color(0xFF3D2317), surfaceElevated: Color(0xFF4F2E1D),
      inputBg: Color(0xFF1E1008),
      border: Color(0xFF6E4526), borderSoft: Color(0xFF462B17),
      accentGold: Color(0xFFFF8A3D), accentAmber: Color(0xFFFFB25E),
      accentText: Color(0xFFFFB25E),
      textMain: Color(0xFFFFF3E6), textDim: Color(0xFFC09A78),
      textFaint: Color(0xFFA07C5C),
      gradStart: Color(0xFFFFB25E), gradEnd: Color(0xFFE85D1F),
      panelTop: Color(0xFF4F2E1D), panelBottom: Color(0xFF3D2317),
    ),
    'teal': AppPalette(
      id: 'teal', dark: true,
      bgBody: Color(0xFF07272B), bg2: Color(0xFF0A3036),
      surface: Color(0xFF0D3A40), surfaceElevated: Color(0xFF14484F),
      inputBg: Color(0xFF051B1E),
      border: Color(0xFF235E66), borderSoft: Color(0xFF143D43),
      accentGold: Color(0xFF2DD4BF), accentAmber: Color(0xFF5EEAD4),
      accentText: Color(0xFF5EEAD4),
      textMain: Color(0xFFEDFFFC), textDim: Color(0xFF93B8BC),
      textFaint: Color(0xFF74979B),
      gradStart: Color(0xFF5EEAD4), gradEnd: Color(0xFF0B9484),
      panelTop: Color(0xFF14484F), panelBottom: Color(0xFF0D3A40),
    ),
    'rose': AppPalette(
      id: 'rose', dark: true,
      bgBody: Color(0xFF2A121E), bg2: Color(0xFF331827),
      surface: Color(0xFF3B1B2D), surfaceElevated: Color(0xFF4C2439),
      inputBg: Color(0xFF1C0A13),
      border: Color(0xFF63304A), borderSoft: Color(0xFF3F1E30),
      accentGold: Color(0xFFFF6482), accentAmber: Color(0xFFFF8FA8),
      accentText: Color(0xFFFF8FA8),
      textMain: Color(0xFFFFF0F4), textDim: Color(0xFFC79BA9),
      textFaint: Color(0xFFA67A89),
      gradStart: Color(0xFFFF8FA8), gradEnd: Color(0xFFDE2A55),
      panelTop: Color(0xFF4C2439), panelBottom: Color(0xFF3B1B2D),
    ),
    // v2.39.0 (owner-approved samples, fs-design-v2/build_new_themes.py):
    // bgBody = sample bg, surface = sample surf, inputBg/bg2 = sample
    // surf2 (the sample's inner-box fill), borderSoft = sample chip,
    // accentGold = sample accent, textMain/textDim = sample text/sub;
    // the remaining tokens follow the derivation rules above.
    'crimson': AppPalette(
      id: 'crimson', dark: true,
      bgBody: Color(0xFF241D20), bg2: Color(0xFF2E2328),
      surface: Color(0xFF372A2F), surfaceElevated: Color(0xFF45363D),
      inputBg: Color(0xFF2E2328),
      border: Color(0xFF654D53), borderSoft: Color(0xFF4A3238),
      accentGold: Color(0xFFE5484D), accentAmber: Color(0xFFF4737A),
      accentText: Color(0xFFF4737A),
      textMain: Color(0xFFF3E9EB), textDim: Color(0xFFB9A3AA),
      textFaint: Color(0xFF9A858D),
      gradStart: Color(0xFFF4737A), gradEnd: Color(0xFFC22430),
      panelTop: Color(0xFF45363D), panelBottom: Color(0xFF372A2F),
    ),
    'matte': AppPalette(
      id: 'matte', dark: true,
      bgBody: Color(0xFF232323), bg2: Color(0xFF2B2B2B),
      surface: Color(0xFF333333), surfaceElevated: Color(0xFF404040),
      inputBg: Color(0xFF2B2B2B),
      border: Color(0xFF555555), borderSoft: Color(0xFF3D3D3D),
      accentGold: Color(0xFF8B9096), accentAmber: Color(0xFFB9BEC4),
      accentText: Color(0xFFB9BEC4),
      textMain: Color(0xFFECECEC), textDim: Color(0xFFA8A8A8),
      textFaint: Color(0xFF868686),
      gradStart: Color(0xFFB9BEC4), gradEnd: Color(0xFF62666C),
      panelTop: Color(0xFF404040), panelBottom: Color(0xFF333333),
    ),
    'ember': AppPalette(
      id: 'ember', dark: true,
      bgBody: Color(0xFF261E15), bg2: Color(0xFF2F2417),
      surface: Color(0xFF392B1D), surfaceElevated: Color(0xFF483723),
      inputBg: Color(0xFF2F2417),
      border: Color(0xFF6B4E2E), borderSoft: Color(0xFF4A3823),
      accentGold: Color(0xFFF0762B), accentAmber: Color(0xFFFFAB5E),
      accentText: Color(0xFFFFAB5E),
      textMain: Color(0xFFF5EDE2), textDim: Color(0xFFBFA98F),
      textFaint: Color(0xFFA08C6E),
      gradStart: Color(0xFFFFAB5E), gradEnd: Color(0xFFD95D16),
      panelTop: Color(0xFF483723), panelBottom: Color(0xFF392B1D),
    ),
  };

  // v2.48.88: the _lightPalettes table is GONE — all 13 per-family
  // light palettes removed at the owner's order. Light mode has
  // exactly one palette ([_whiteLight] above); [paletteFor]
  // returns it for every id. Dark keeps its full table below.

  // ------------------------------------------------------------------
  // Live tokens — unchanged public API, now delegating to [_current].
  // ------------------------------------------------------------------

  // Surfaces
  static Color get bgBody => _current.bgBody;
  static Color get surface => _current.surface;
  static Color get surfaceElevated => _current.surfaceElevated;
  static Color get inputBg => _current.inputBg;
  static Color get border => _current.border;
  static Color get borderSoft => _current.borderSoft;

  // Accents
  static Color get accentGold => _current.accentGold;
  static Color get accentAmber => _current.accentAmber;
  static Color get accentText => _current.accentText;
  static Color get onAccent => _current.onAccent;

  // v2.25.0 (parked browser): the gold of the "● ACTIVE" text and the
  // active account row's border — fixed across themes (see AppPalette).
  static Color get activeGold => _current.activeGold;

  // Status colors — mac greens/reds, fixed across themes
  static Color get green => _current.green;
  static Color get greenBg => _current.greenBg;
  static Color get red => _current.red;
  static Color get redBg => _current.redBg;
  static Color get blue => _current.blue;
  static const Color whatsApp = Color(0xFF25D366);

  // Text colors
  static Color get textMain => _current.textMain;
  static Color get textDim => _current.textDim;
  static Color get textFaint => _current.textFaint;

  // Subtle inner overlays
  static Color get overlay08 => _current.overlay08;
  static Color get overlay10 => _current.overlay10;
  static Color get overlay20 => _current.overlay20;

  // Tactile 3D and highlight tokens
  static Color get bevelPrimary => _current.bevelPrimary;
  static Color get bevelSecondary => _current.bevelSecondary;
  static Color get borderHighlight => _current.borderHighlight;
  static Color get glowPrimary => _current.glowPrimary;

  // v2.48.90: the uniform light-mode button face + the warm
  // light-mode shadow base (see AppPalette).
  static Color get buttonBg => _current.buttonBg;
  static Color get warmShadow => _current.warmShadow;

  static LinearGradient get accentGrad => _current.accentGrad;
  static LinearGradient get panelGrad => _current.panelGrad;

  static ThemeData get darkTheme {
    return ThemeData(
      brightness: Brightness.dark,
      fontFamily: GoogleFonts.inter().fontFamily,
      scaffoldBackgroundColor: bgBody,
      canvasColor: surface,
      cardColor: surfaceElevated,
      primaryColor: accentGold,
      dividerColor: borderSoft,
      colorScheme: ColorScheme.dark(
        primary: accentGold,
        secondary: accentAmber,
        surface: surface,
        error: red,
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: surface,
        elevation: 0,
      ),
      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: surfaceElevated,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: border),
        ),
        textStyle: TextStyle(fontSize: 11, color: textMain),
      ),
    );
  }

  static ThemeData get lightTheme {
    return ThemeData(
      brightness: Brightness.light,
      fontFamily: GoogleFonts.inter().fontFamily,
      scaffoldBackgroundColor: bgBody,
      canvasColor: surface,
      cardColor: surfaceElevated,
      primaryColor: accentGold,
      dividerColor: borderSoft,
      colorScheme: ColorScheme.light(
        primary: accentGold,
        secondary: accentAmber,
        surface: surface,
        error: red,
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: surface,
        elevation: 0,
      ),
      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: surfaceElevated,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: border),
        ),
        textStyle: TextStyle(fontSize: 11, color: textMain),
      ),
    );
  }
}
