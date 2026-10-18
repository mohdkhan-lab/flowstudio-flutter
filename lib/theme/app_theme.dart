import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

class AppTheme {
  // FlowStudio Lite v2.21 Exact Design Tokens
  static const Color bgBody = Color(0xFF0F0E0B);
  static const Color surface = Color(0xFF1A1915);
  static const Color surfaceElevated = Color(0xFF22211A);
  static const Color inputBg = Color(0xFF171611);
  static const Color border = Color(0xFF35332A);
  static const Color borderSoft = Color(0xFF2E2B21);
  
  // Accents
  static const Color accentGold = Color(0xFFEAB308);
  static const Color accentAmber = Color(0xFFF59E0B);
  static const Color accentText = Color(0xFFFDE047);
  static const Color onAccent = Color(0xFF1A1405);
  
  // Status Colors
  static const Color green = Color(0xFF4ADE80);
  static const Color greenBg = Color(0x1F4ADE80);
  static const Color red = Color(0xFFF87171);
  static const Color redBg = Color(0x1FF87171);
  static const Color blue = Color(0xFF7DD3FC);
  static const Color whatsApp = Color(0xFF25D366);
  
  // Text Colors
  static const Color textMain = Color(0xFFF5F2E9);
  static const Color textDim = Color(0xFFB5B09C);
  static const Color textFaint = Color(0xFFA8A28E);

  static const LinearGradient accentGrad = LinearGradient(
    colors: [Color(0xFFFACC15), Color(0xFFF59E0B)],
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
  );

  static const LinearGradient panelGrad = LinearGradient(
    colors: [Color(0xFF22211A), Color(0xFF1A1915)],
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
      colorScheme: const ColorScheme.dark(
        primary: accentGold,
        secondary: accentAmber,
        surface: surface,
        error: red,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: surface,
        elevation: 0,
      ),
      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: surfaceElevated,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: border),
        ),
        textStyle: const TextStyle(fontSize: 11, color: textMain),
      ),
    );
  }
}
