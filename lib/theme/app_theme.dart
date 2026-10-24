import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// FlowStudio v2.26.0 — 10-theme pack (owner-approved, 2026-10-24).
///
/// Settings now has a Mode control (Dark / Light / System) and a grid of
/// 10 colour themes. EVERY theme ships in both a Dark and a Light
/// palette (20 palettes total); choosing a theme never forces the mode —
/// switching mode keeps the theme and swaps to its other palette.
///
/// Theme 1 "macOS Classic" is the default and is the owner's locked
/// final pair: its Dark palette is exactly the old Soft Charcoal values
/// and its Light palette exactly the old Creamy values.
///
/// Status colours are FIXED in every palette (owner rule): the
/// "● ACTIVE" gold, LIVE green and FAIL red never change with the theme.
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
  Color get activeGold =>
      dark ? const Color(0xFFF5B301) : const Color(0xFFCF8A04);

  // Status colours — mac greens/reds, FIXED across all themes.
  Color get green => dark ? const Color(0xFF30D158) : const Color(0xFF34C759);
  Color get greenBg =>
      dark ? const Color(0x1F30D158) : const Color(0x1F34C759);
  Color get red => dark ? const Color(0xFFFF453A) : const Color(0xFFFF3B30);
  Color get redBg => dark ? const Color(0x1FFF453A) : const Color(0x1FFF3B30);
  Color get blue => dark ? const Color(0xFF64D2FF) : const Color(0xFF0071E3);

  // Subtle inner overlays (white-alpha on dark palettes, black-alpha on
  // light palettes — same values the app has always used per mode).
  Color get overlay08 =>
      dark ? const Color(0x08FFFFFF) : const Color(0x0A000000);
  Color get overlay10 =>
      dark ? const Color(0x10FFFFFF) : const Color(0x12000000);
  Color get overlay20 =>
      dark ? const Color(0x20FFFFFF) : const Color(0x1F000000);

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
  static String themeId = 'macos';

  static const List<String> themeIds = [
    'macos',
    'midnight',
    'graphite',
    'gold',
    'emerald',
    'purple',
    'slate',
    'sunset',
    'teal',
    'rose',
  ];

  static const Map<String, String> themeNames = {
    'macos': 'macOS Classic',
    'midnight': 'Midnight Blue',
    'graphite': 'Graphite + White',
    'gold': 'Gold Premium',
    'emerald': 'Emerald',
    'purple': 'Royal Purple',
    'slate': 'Slate Pro',
    'sunset': 'Sunset',
    'teal': 'Ocean Teal',
    'rose': 'Rose',
  };

  static AppPalette _current = _macosDark;

  /// The palette for theme [id] in the given mode. Unknown ids fall
  /// back to macOS Classic, so a bad stored value can never break the UI.
  static AppPalette paletteFor(String id, bool isDark) {
    final table = isDark ? _darkPalettes : _lightPalettes;
    return table[id] ?? (isDark ? _macosDark : _macosLight);
  }

  /// Applies theme [id] + mode [isDark] as the live palette. Called
  /// from main.dart whenever either setting changes.
  static void applyTheme(String id, bool isDark) {
    themeId = themeIds.contains(id) ? id : 'macos';
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

  static const AppPalette _macosDark = AppPalette(
    id: 'macos', dark: true,
    bgBody: Color(0xFF232325), bg2: Color(0xFF2A2A2C),
    surface: Color(0xFF2C2C2E), surfaceElevated: Color(0xFF3A3A3C),
    inputBg: Color(0xFF1C1C1E),
    border: Color(0xFF5A5A5E), borderSoft: Color(0xFF3D3D40),
    accentGold: Color(0xFF0A84FF), accentAmber: Color(0xFF409CFF),
    accentText: Color(0xFF409CFF),
    textMain: Color(0xFFFFFFFF), textDim: Color(0xFFD1D1D6),
    textFaint: Color(0xFFA1A1A6),
    gradStart: Color(0xFF1A94FF), gradEnd: Color(0xFF0066D6),
    panelTop: Color(0xFF3A3A3C), panelBottom: Color(0xFF2C2C2E),
  );

  static const AppPalette _macosLight = AppPalette(
    id: 'macos', dark: false,
    bgBody: Color(0xFFF7ECD7), bg2: Color(0xFFF3E3C3),
    surface: Color(0xFFFFFDF8), surfaceElevated: Color(0xFFFFFFFF),
    inputBg: Color(0xFFFFFDF8),
    border: Color(0xFFE3D5BA), borderSoft: Color(0xFFF1E8D5),
    accentGold: Color(0xFF0A84FF), accentAmber: Color(0xFF1A94FF),
    accentText: Color(0xFF0066CC),
    textMain: Color(0xFF1D1D1F), textDim: Color(0xFF6E6E73),
    textFaint: Color(0xFF86868B),
    gradStart: Color(0xFF1A94FF), gradEnd: Color(0xFF0066D6),
    panelTop: Color(0xFFFFFFFF), panelBottom: Color(0xFFFFFAF0),
  );

  static const Map<String, AppPalette> _darkPalettes = {
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
    'gold': AppPalette(
      id: 'gold', dark: true,
      bgBody: Color(0xFF1C1917), bg2: Color(0xFF241E18),
      surface: Color(0xFF29241E), surfaceElevated: Color(0xFF362E24),
      inputBg: Color(0xFF14110D),
      border: Color(0xFF57492F), borderSoft: Color(0xFF362D1E),
      accentGold: Color(0xFFEAB308), accentAmber: Color(0xFFF5C04E),
      accentText: Color(0xFFF5C04E),
      textMain: Color(0xFFFFF8E7), textDim: Color(0xFFB8A888),
      textFaint: Color(0xFF97876B),
      gradStart: Color(0xFFF5C04E), gradEnd: Color(0xFFB8860B),
      panelTop: Color(0xFF362E24), panelBottom: Color(0xFF29241E),
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
  };

  static const Map<String, AppPalette> _lightPalettes = {
    'macos': _macosLight,
    'midnight': AppPalette(
      id: 'midnight', dark: false,
      bgBody: Color(0xFFE9F1FC), bg2: Color(0xFFDCEAFB),
      surface: Color(0xFFFFFFFF), surfaceElevated: Color(0xFFFFFFFF),
      inputBg: Color(0xFFFFFFFF),
      border: Color(0xFFBCD2EE), borderSoft: Color(0xFFDCE9F8),
      accentGold: Color(0xFF0067D8), accentAmber: Color(0xFF1A94FF),
      accentText: Color(0xFF0067D8),
      textMain: Color(0xFF12263F), textDim: Color(0xFF6B8299),
      textFaint: Color(0xFF93A7BC),
      gradStart: Color(0xFF1A94FF), gradEnd: Color(0xFF0066D6),
      panelTop: Color(0xFFFFFFFF), panelBottom: Color(0xFFFFFFFF),
    ),
    'graphite': AppPalette(
      id: 'graphite', dark: false,
      bgBody: Color(0xFFF5F5F7), bg2: Color(0xFFECECF0),
      surface: Color(0xFFFFFFFF), surfaceElevated: Color(0xFFFFFFFF),
      inputBg: Color(0xFFFFFFFF),
      border: Color(0xFFD9D9DE), borderSoft: Color(0xFFEDEDF0),
      accentGold: Color(0xFF0071E3), accentAmber: Color(0xFF1A94FF),
      accentText: Color(0xFF0071E3),
      textMain: Color(0xFF1D1D1F), textDim: Color(0xFF86868B),
      textFaint: Color(0xFFAEAEB2),
      gradStart: Color(0xFF1A94FF), gradEnd: Color(0xFF0066D6),
      panelTop: Color(0xFFFFFFFF), panelBottom: Color(0xFFFFFFFF),
    ),
    'gold': AppPalette(
      id: 'gold', dark: false,
      bgBody: Color(0xFFFBF3DC), bg2: Color(0xFFF6EAC4),
      surface: Color(0xFFFFFDF4), surfaceElevated: Color(0xFFFFFFFF),
      inputBg: Color(0xFFFFFDF4),
      border: Color(0xFFE4D29A), borderSoft: Color(0xFFF2E7C4),
      accentGold: Color(0xFFB8860B), accentAmber: Color(0xFFE3B341),
      accentText: Color(0xFF8A6508),
      textMain: Color(0xFF2E2303), textDim: Color(0xFF97824F),
      textFaint: Color(0xFFB3A173),
      gradStart: Color(0xFFE3B341), gradEnd: Color(0xFF9A7205),
      panelTop: Color(0xFFFFFFFF), panelBottom: Color(0xFFFFFDF4),
    ),
    'emerald': AppPalette(
      id: 'emerald', dark: false,
      bgBody: Color(0xFFE7F7EE), bg2: Color(0xFFD8F2E2),
      surface: Color(0xFFFFFFFF), surfaceElevated: Color(0xFFFFFFFF),
      inputBg: Color(0xFFFFFFFF),
      border: Color(0xFFB7E2C6), borderSoft: Color(0xFFD9F2E3),
      accentGold: Color(0xFF0E9F5A), accentAmber: Color(0xFF34C759),
      accentText: Color(0xFF0E9F5A),
      textMain: Color(0xFF0E2A1C), textDim: Color(0xFF5F8A72),
      textFaint: Color(0xFF87AB97),
      gradStart: Color(0xFF34C759), gradEnd: Color(0xFF0E9F5A),
      panelTop: Color(0xFFFFFFFF), panelBottom: Color(0xFFFFFFFF),
    ),
    'purple': AppPalette(
      id: 'purple', dark: false,
      bgBody: Color(0xFFF0EBFC), bg2: Color(0xFFE4DAFA),
      surface: Color(0xFFFFFFFF), surfaceElevated: Color(0xFFFFFFFF),
      inputBg: Color(0xFFFFFFFF),
      border: Color(0xFFD3C2F2), borderSoft: Color(0xFFE7DFF9),
      accentGold: Color(0xFF7D3FE0), accentAmber: Color(0xFFD18CFF),
      accentText: Color(0xFF7D3FE0),
      textMain: Color(0xFF241640), textDim: Color(0xFF8578AC),
      textFaint: Color(0xFFA79AC4),
      gradStart: Color(0xFFD18CFF), gradEnd: Color(0xFF7D3FE0),
      panelTop: Color(0xFFFFFFFF), panelBottom: Color(0xFFFFFFFF),
    ),
    'slate': AppPalette(
      id: 'slate', dark: false,
      bgBody: Color(0xFFEDF0F4), bg2: Color(0xFFE1E6ED),
      surface: Color(0xFFFFFFFF), surfaceElevated: Color(0xFFFFFFFF),
      inputBg: Color(0xFFFFFFFF),
      border: Color(0xFFC3CEDA), borderSoft: Color(0xFFDDE4EC),
      accentGold: Color(0xFF0B7AC0), accentAmber: Color(0xFF8AD9FF),
      accentText: Color(0xFF0B7AC0),
      textMain: Color(0xFF1B2430), textDim: Color(0xFF71808F),
      textFaint: Color(0xFF98A5B1),
      gradStart: Color(0xFF8AD9FF), gradEnd: Color(0xFF0B7AC0),
      panelTop: Color(0xFFFFFFFF), panelBottom: Color(0xFFFFFFFF),
    ),
    'sunset': AppPalette(
      id: 'sunset', dark: false,
      bgBody: Color(0xFFFFE9D2), bg2: Color(0xFFFFDDBB),
      surface: Color(0xFFFFFBF4), surfaceElevated: Color(0xFFFFFFFF),
      inputBg: Color(0xFFFFFBF4),
      border: Color(0xFFEBC9A3), borderSoft: Color(0xFFF6DFC4),
      accentGold: Color(0xFFE85D1F), accentAmber: Color(0xFFFFB25E),
      accentText: Color(0xFFE85D1F),
      textMain: Color(0xFF2B1A10), textDim: Color(0xFF9A7B63),
      textFaint: Color(0xFFB79E86),
      gradStart: Color(0xFFFFB25E), gradEnd: Color(0xFFE85D1F),
      panelTop: Color(0xFFFFFFFF), panelBottom: Color(0xFFFFFBF4),
    ),
    'teal': AppPalette(
      id: 'teal', dark: false,
      bgBody: Color(0xFFE4F6F5), bg2: Color(0xFFD2EFEC),
      surface: Color(0xFFFFFFFF), surfaceElevated: Color(0xFFFFFFFF),
      inputBg: Color(0xFFFFFFFF),
      border: Color(0xFFAEDCD8), borderSoft: Color(0xFFD2EEEA),
      accentGold: Color(0xFF0B9484), accentAmber: Color(0xFF5EEAD4),
      accentText: Color(0xFF0B9484),
      textMain: Color(0xFF0A2A28), textDim: Color(0xFF5E8A86),
      textFaint: Color(0xFF88ABA6),
      gradStart: Color(0xFF5EEAD4), gradEnd: Color(0xFF0B9484),
      panelTop: Color(0xFFFFFFFF), panelBottom: Color(0xFFFFFFFF),
    ),
    'rose': AppPalette(
      id: 'rose', dark: false,
      bgBody: Color(0xFFFDECEF), bg2: Color(0xFFFBDCE4),
      surface: Color(0xFFFFFFFF), surfaceElevated: Color(0xFFFFFFFF),
      inputBg: Color(0xFFFFFFFF),
      border: Color(0xFFF2BFCB), borderSoft: Color(0xFFF9DCE3),
      accentGold: Color(0xFFDE2A55), accentAmber: Color(0xFFFF8FA8),
      accentText: Color(0xFFDE2A55),
      textMain: Color(0xFF33101C), textDim: Color(0xFFA47382),
      textFaint: Color(0xFFBE99A5),
      gradStart: Color(0xFFFF8FA8), gradEnd: Color(0xFFDE2A55),
      panelTop: Color(0xFFFFFFFF), panelBottom: Color(0xFFFFFFFF),
    ),
  };

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
