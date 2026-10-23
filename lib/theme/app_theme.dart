import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// FlowStudio v2.24.0 — FINAL design (locked by Aslam, 2026-10-22):
/// macOS style. Light = Creamy Gradient, Dark = Soft Charcoal.
/// System-blue accent in both modes; green toggles/status stay mac green.
///
/// Every token is a getter backed by [dark], so the whole app recolors
/// when the appearance changes without touching widget call sites.
class AppTheme {
  /// True when the dark (Soft Charcoal) palette is active.
  static bool dark = true;

  // Surfaces
  static Color get bgBody => dark ? const Color(0xFF232325) : const Color(0xFFF7ECD7);
  static Color get surface => dark ? const Color(0xFF2C2C2E) : const Color(0xFFFFFDF8);
  static Color get surfaceElevated => dark ? const Color(0xFF3A3A3C) : const Color(0xFFFFFFFF);
  static Color get inputBg => dark ? const Color(0xFF1C1C1E) : const Color(0xFFFFFDF8);
  static Color get border => dark ? const Color(0xFF5A5A5E) : const Color(0xFFE3D5BA);
  static Color get borderSoft => dark ? const Color(0xFF3D3D40) : const Color(0xFFF1E8D5);

  // Accents — macOS system blue in both modes
  static Color get accentGold => const Color(0xFF0A84FF);
  static Color get accentAmber => dark ? const Color(0xFF409CFF) : const Color(0xFF1A94FF);
  static Color get accentText => dark ? const Color(0xFF409CFF) : const Color(0xFF0066CC);
  static Color get onAccent => const Color(0xFFFFFFFF);

  // v2.25.0 (parked browser): the gold of the "● ACTIVE" text and the
  // active account row's border — deeper gold on the creamy light
  // palette, brighter gold on Soft Charcoal so it stays readable.
  static Color get activeGold => dark ? const Color(0xFFF5B301) : const Color(0xFFCF8A04);

  // Status colors — mac greens/reds
  static Color get green => dark ? const Color(0xFF30D158) : const Color(0xFF34C759);
  static Color get greenBg => dark ? const Color(0x1F30D158) : const Color(0x1F34C759);
  static Color get red => dark ? const Color(0xFFFF453A) : const Color(0xFFFF3B30);
  static Color get redBg => dark ? const Color(0x1FFF453A) : const Color(0x1FFF3B30);
  static Color get blue => dark ? const Color(0xFF64D2FF) : const Color(0xFF0071E3);
  static const Color whatsApp = Color(0xFF25D366);

  // Text colors
  static Color get textMain => dark ? const Color(0xFFFFFFFF) : const Color(0xFF1D1D1F);
  static Color get textDim => dark ? const Color(0xFFD1D1D6) : const Color(0xFF6E6E73);
  static Color get textFaint => dark ? const Color(0xFFA1A1A6) : const Color(0xFF86868B);

  // Subtle inner overlays (replaces fixed white-alpha fills, which only
  // worked on the old dark theme)
  static Color get overlay08 => dark ? const Color(0x08FFFFFF) : const Color(0x0A000000);
  static Color get overlay10 => dark ? const Color(0x10FFFFFF) : const Color(0x12000000);
  static Color get overlay20 => dark ? const Color(0x20FFFFFF) : const Color(0x1F000000);

  static LinearGradient get accentGrad => const LinearGradient(
        colors: [Color(0xFF1A94FF), Color(0xFF0066D6)],
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
      );

  static LinearGradient get panelGrad => dark
      ? const LinearGradient(
          colors: [Color(0xFF3A3A3C), Color(0xFF2C2C2E)],
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
        )
      : const LinearGradient(
          colors: [Color(0xFFFFFFFF), Color(0xFFFFFAF0)],
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
        );

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
