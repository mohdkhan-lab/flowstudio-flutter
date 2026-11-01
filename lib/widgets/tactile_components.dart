import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Style 6: Tactile 3D (Mechanical Bevel) Button Types
enum TactileType {
  primary,   // Blue gradient, solid deep-blue bevel, electric glow
  secondary, // Slate background, dark bevel, cyan-blue soft glow
  stop,      // Red dark bg, deep crimson bevel, rose-red glow
  pause,     // Amber dark bg, warm amber bevel, golden glow
  gold,      // Warm amber/gold bg, deep amber bevel, gold glow
  pill,      // Slim rounded pill with mechanical bevel
  icon,      // Micro-square tactile button for play/folder/copy
}

/// A high-performance, tactile 3D button implementing Style 6:
/// - Razor-sharp mechanical bottom bevel depth (0 blur, 0 spread)
/// - 2.0px physical hover lift (`translateY(-2.0px)`)
/// - 1.5px tactile press down (`translateY(1.5px)`)
/// - Contextual Luxury Soft Glow underneath
class TactileButton extends StatefulWidget {
  final Widget? child;
  final String? label;
  final IconData? icon;
  final double? iconSize;
  final VoidCallback? onTap;
  final TactileType type;
  final double? height;
  final double? width;
  final EdgeInsetsGeometry? padding;
  final double borderRadius;
  final double bevelDepth;
  final bool enabled;
  final bool isActive;
  final Color? customBg;
  final Color? customBorder;
  final Color? customBevel;
  final Color? customGlow;

  const TactileButton({
    super.key,
    this.child,
    this.label,
    this.icon,
    this.iconSize,
    this.onTap,
    this.type = TactileType.secondary,
    this.height,
    this.width,
    this.padding,
    this.borderRadius = 8.0,
    this.bevelDepth = 2.5,
    this.enabled = true,
    this.isActive = false,
    this.customBg,
    this.customBorder,
    this.customBevel,
    this.customGlow,
  });

  @override
  State<TactileButton> createState() => _TactileButtonState();
}

class _TactileButtonState extends State<TactileButton> {
  bool _isHovered = false;
  bool _isPressed = false;

  @override
  Widget build(BuildContext context) {
    final enabled = widget.enabled && widget.onTap != null;

    // Resolve color palette by TactileType
    Gradient? gradient;
    Color bgColor;
    Color borderColor;
    Color bevelColor;
    Color glowColor;
    Color textColor = AppTheme.textMain;

    switch (widget.type) {
      case TactileType.primary:
        gradient = enabled ? AppTheme.accentGrad : null;
        bgColor = enabled ? AppTheme.blue : AppTheme.surfaceElevated;
        borderColor = enabled ? const Color(0xFF3B82F6) : AppTheme.borderSoft;
        bevelColor = enabled ? const Color(0xFF1E3A8A) : const Color(0xFF0F172A);
        glowColor = const Color(0xFF2563EB);
        textColor = Colors.white;
        break;

      case TactileType.stop:
        gradient = null;
        bgColor = const Color(0xFF221115);
        borderColor = const Color(0xFFEF4444).withValues(alpha: _isHovered ? 0.85 : 0.60);
        bevelColor = const Color(0xFF7F1D1D);
        glowColor = const Color(0xFFEF4444);
        textColor = const Color(0xFFFCA5A5);
        break;

      case TactileType.pause:
        gradient = null;
        bgColor = const Color(0xFF24190E);
        borderColor = const Color(0xFFF59E0B).withValues(alpha: _isHovered ? 0.85 : 0.60);
        bevelColor = const Color(0xFF78350F);
        glowColor = const Color(0xFFF59E0B);
        textColor = const Color(0xFFFCD34D);
        break;

      case TactileType.gold:
        gradient = null;
        bgColor = widget.isActive
            ? AppTheme.accentGold.withValues(alpha: 0.22)
            : AppTheme.accentGold.withValues(alpha: _isHovered ? 0.16 : 0.10);
        borderColor = AppTheme.accentGold.withValues(alpha: _isHovered ? 0.85 : 0.55);
        bevelColor = const Color(0xFF78350F);
        glowColor = AppTheme.accentGold;
        textColor = AppTheme.accentText;
        break;

      case TactileType.pill:
        gradient = widget.isActive ? AppTheme.accentGrad : null;
        bgColor = widget.isActive
            ? AppTheme.blue
            : (_isHovered ? AppTheme.blue.withValues(alpha: 0.14) : AppTheme.overlay08);
        borderColor = widget.isActive
            ? const Color(0xFF3B82F6)
            : (_isHovered ? AppTheme.blue : AppTheme.borderSoft);
        bevelColor = widget.isActive
            ? const Color(0xFF1E3A8A)
            : (_isHovered ? const Color(0xFF1E3A8A).withValues(alpha: 0.6) : const Color(0xFF0F172A));
        glowColor = AppTheme.blue;
        textColor = widget.isActive
            ? Colors.white
            : (_isHovered ? AppTheme.textMain : AppTheme.textDim);
        break;

      case TactileType.icon:
        gradient = null;
        bgColor = widget.isActive
            ? AppTheme.blue.withValues(alpha: 0.20)
            : (_isHovered ? AppTheme.surfaceElevated : AppTheme.inputBg);
        borderColor = widget.isActive
            ? AppTheme.blue
            : (_isHovered ? AppTheme.accentText : AppTheme.borderSoft);
        bevelColor = const Color(0xFF0F172A);
        glowColor = AppTheme.accentText;
        textColor = widget.isActive || _isHovered ? AppTheme.accentText : AppTheme.textDim;
        break;

      case TactileType.secondary:
        gradient = null;
        bgColor = _isHovered ? AppTheme.surfaceElevated : AppTheme.overlay10;
        borderColor = _isHovered ? const Color(0xFF475569) : AppTheme.borderSoft;
        bevelColor = const Color(0xFF0F172A);
        glowColor = const Color(0xFF38BDF8);
        textColor = AppTheme.textMain;
        break;
    }

    // Apply custom color overrides if specified
    if (widget.customBg != null) bgColor = widget.customBg!;
    if (widget.customBorder != null) borderColor = widget.customBorder!;
    if (widget.customBevel != null) bevelColor = widget.customBevel!;
    if (widget.customGlow != null) glowColor = widget.customGlow!;

    // Physical calculations:
    // Hover: lift 2.0px up, bevel depth expands slightly
    // Pressed: click 1.5px down, bevel depth compresses
    final double translateY;
    final double activeBevel;
    if (_isPressed && enabled) {
      translateY = 1.5;
      activeBevel = 0.8;
    } else if (_isHovered && enabled) {
      translateY = -2.0;
      activeBevel = widget.bevelDepth + 0.8;
    } else {
      translateY = 0.0;
      activeBevel = widget.bevelDepth;
    }

    return MouseRegion(
      onEnter: (_) {
        if (enabled && !_isHovered) setState(() => _isHovered = true);
      },
      onExit: (_) {
        if (_isHovered || _isPressed) {
          setState(() {
            _isHovered = false;
            _isPressed = false;
          });
        }
      },
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      child: GestureDetector(
        onTapDown: (_) {
          if (enabled) setState(() => _isPressed = true);
        },
        onTapUp: (_) {
          if (_isPressed) setState(() => _isPressed = false);
        },
        onTapCancel: () {
          if (_isPressed) setState(() => _isPressed = false);
        },
        onTap: enabled ? widget.onTap : null,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 100),
          curve: Curves.easeOutQuad,
          height: widget.height,
          width: widget.width,
          padding: widget.padding ?? const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          transform: Matrix4.translationValues(0, translateY, 0),
          decoration: BoxDecoration(
            gradient: gradient,
            color: gradient == null ? bgColor : null,
            borderRadius: BorderRadius.circular(widget.borderRadius),
            border: Border.all(
              color: enabled ? borderColor : AppTheme.borderSoft.withValues(alpha: 0.5),
              width: 1.0,
            ),
            boxShadow: [
              // Layer 1: Solid Mechanical 3D Bottom Bevel (depth)
              BoxShadow(
                color: enabled ? bevelColor : Colors.black26,
                offset: Offset(0, activeBevel),
                blurRadius: 0,
                spreadRadius: 0,
              ),
              // Layer 2: Luxury Soft Glow on hover
              if (_isHovered && enabled)
                BoxShadow(
                  color: glowColor.withValues(alpha: 0.35),
                  blurRadius: 12,
                  spreadRadius: 0.5,
                  offset: const Offset(0, 3),
                )
              else if (!_isPressed && enabled)
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.30),
                  blurRadius: 3,
                  offset: const Offset(0, 1.5),
                ),
            ],
          ),
          child: Center(
            widthFactor: widget.width == null ? 1.0 : null,
            heightFactor: widget.height == null ? 1.0 : null,
            child: widget.child ??
                Row(
                  mainAxisSize: MainAxisSize.min,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    if (widget.icon != null) ...[
                      Icon(
                        widget.icon,
                        size: widget.iconSize ?? 13,
                        color: textColor,
                      ),
                      if (widget.label != null && widget.label!.isNotEmpty)
                        const SizedBox(width: 5),
                    ],
                    if (widget.label != null && widget.label!.isNotEmpty)
                      Text(
                        widget.label!,
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.bold,
                          color: textColor,
                        ),
                      ),
                  ],
                ),
          ),
        ),
      ),
    );
  }
}

/// A tactile 3D interactive card for progress cards with 2.0px lift
class TactileCard extends StatefulWidget {
  final Widget child;
  final EdgeInsetsGeometry? padding;
  final VoidCallback? onTap;
  final double borderRadius;
  final double bevelDepth;
  final Color? borderColor;
  final Color? glowColor;

  const TactileCard({
    super.key,
    required this.child,
    this.padding,
    this.onTap,
    this.borderRadius = 10.0,
    this.bevelDepth = 2.0,
    this.borderColor,
    this.glowColor,
  });

  @override
  State<TactileCard> createState() => _TactileCardState();
}

class _TactileCardState extends State<TactileCard> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    final borderCol = widget.borderColor ?? (_isHovered ? AppTheme.blue.withValues(alpha: 0.75) : AppTheme.borderSoft);
    final glow = widget.glowColor ?? AppTheme.blue;

    return MouseRegion(
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          curve: Curves.easeOutQuad,
          transform: Matrix4.translationValues(0, _isHovered ? -2.0 : 0.0, 0),
          padding: widget.padding ?? const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: _isHovered ? AppTheme.surfaceElevated : AppTheme.surface,
            borderRadius: BorderRadius.circular(widget.borderRadius),
            border: Border.all(color: borderCol, width: 1.0),
            boxShadow: [
              // 3D bottom bevel
              BoxShadow(
                color: const Color(0xFF0F172A),
                offset: Offset(0, _isHovered ? widget.bevelDepth + 1.2 : widget.bevelDepth),
                blurRadius: 0,
              ),
              // Soft hover glow
              if (_isHovered)
                BoxShadow(
                  color: glow.withValues(alpha: 0.22),
                  blurRadius: 10,
                  offset: const Offset(0, 3),
                )
              else
                const BoxShadow(
                  color: Colors.black26,
                  blurRadius: 4,
                  offset: Offset(0, 2),
                ),
            ],
          ),
          child: widget.child,
        ),
      ),
    );
  }
}
