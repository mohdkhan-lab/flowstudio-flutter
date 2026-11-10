import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Style 6: Tactile 3D (Mechanical Bevel) Button Types
enum TactileType {
  primary,   // Electric Blue gradient, dark-blue 3D bevel, soft blue glow
  secondary, // Clean dark slate, dark bevel, cyan-blue soft glow (NO RED / NO BROWN)
  pill,      // Rounded segmented pill with mechanical bevel & lift
  icon,      // Micro-square / circular tactile button with bevel & lift
  gold,      // Gold-accented text & border on clean dark slate
  danger,    // Dark slate background with red text / red hover glow (NO solid red fill)
  stop,      // Clean dark slate with subtle red icon/text, dark bevel (NO solid red fill)
  pause,     // Clean dark slate with subtle amber icon/text, dark bevel (NO solid amber fill)
}

/// A high-performance, tactile 3D button implementing Style 6:
/// - Razor-sharp mechanical bottom bevel depth (0 blur, 0 spread)
/// - 2.5px physical hover lift (`translateY(-2.5px)`)
/// - 1.5px tactile press down (`translateY(1.5px)`)
/// - 180ms smooth cubic ease transition (`Curves.easeOutCubic`)
/// - Contextual Luxury Soft Glow underneath
/// - Clean dark slate aesthetic (no unwanted red or brown fills)
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
  final Color? customTextColor;
  final BoxShape shape;
  final String? tooltip;

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
    this.customTextColor,
    this.shape = BoxShape.rectangle,
    this.tooltip,
  });

  @override
  State<TactileButton> createState() => _TactileButtonState();
}

class _TactileButtonState extends State<TactileButton> {
  bool _isHovered = false;
  bool _isPressed = false;

  @override
  Widget build(BuildContext context) {
    final bool isInteractive = widget.enabled && widget.onTap != null;

    // Resolve color palette by TactileType — strictly preserving dark theme
    Gradient? gradient;
    Color bgColor;
    Color borderColor;
    Color bevelColor;
    Color glowColor;
    Color textColor = widget.customTextColor ?? AppTheme.textMain;

    switch (widget.type) {
      case TactileType.primary:
        gradient = isInteractive ? AppTheme.accentGrad : null;
        bgColor = isInteractive ? AppTheme.accentGold : AppTheme.surfaceElevated;
        borderColor = isInteractive
            ? (_isHovered ? AppTheme.accentAmber : AppTheme.accentGold)
            : AppTheme.borderSoft;
        bevelColor = isInteractive ? AppTheme.bevelPrimary : AppTheme.bevelSecondary;
        glowColor = AppTheme.accentGold;
        textColor = AppTheme.onAccent;
        break;

      case TactileType.pill:
        gradient = widget.isActive ? AppTheme.accentGrad : null;
        // v2.48.89: the inactive light fill is the palette inputBg
        // token (same pattern as stop/pause/secondary since .88) —
        // the near-clear overlay08 read as a dark slate slab in the
        // owner's .88 screenshot (Bulk/Agent Prompt, Simple/Details).
        bgColor = widget.isActive
            ? AppTheme.accentGold
            : (_isHovered ? AppTheme.accentGold.withValues(alpha: 0.16) : (AppTheme.dark ? AppTheme.overlay08 : AppTheme.inputBg));
        borderColor = widget.isActive
            ? AppTheme.accentGold
            : (_isHovered ? AppTheme.accentAmber : AppTheme.borderSoft);
        bevelColor = widget.isActive
            ? AppTheme.bevelPrimary
            : AppTheme.bevelSecondary;
        glowColor = AppTheme.accentGold;
        textColor = widget.isActive
            ? AppTheme.onAccent
            : (_isHovered ? AppTheme.textMain : AppTheme.textDim);
        break;

      case TactileType.gold:
        gradient = null;
        // Clean dark slate background — NO brown/gold fill bricks
        // v2.48.89: light mode rests on inputBg (the '+ Add Tag'
        // chip read dark-filled in the owner's .88 screenshot).
        bgColor = _isHovered ? AppTheme.surfaceElevated : (AppTheme.dark ? AppTheme.overlay10 : AppTheme.inputBg);
        borderColor = _isHovered ? AppTheme.accentGold : AppTheme.accentGold.withValues(alpha: 0.5);
        bevelColor = AppTheme.bevelSecondary;
        glowColor = AppTheme.accentGold;
        textColor = AppTheme.accentText;
        break;

      case TactileType.danger:
        gradient = null;
        // Clean dark slate background — NOT solid red fill
        bgColor = _isHovered ? AppTheme.surfaceElevated : AppTheme.overlay10;
        borderColor = _isHovered ? AppTheme.red.withValues(alpha: 0.8) : AppTheme.borderSoft;
        bevelColor = AppTheme.bevelSecondary;
        glowColor = AppTheme.red;
        // v2.48.89: disabled text in light mode never drops below
        // the textFaint floor (the alpha-dimmed red measured ~2:1).
        textColor = isInteractive ? AppTheme.red : (AppTheme.dark ? AppTheme.red.withValues(alpha: 0.45) : AppTheme.textFaint);
        break;

      case TactileType.stop:
        gradient = null;
        // Clean slate background — subtle red accent text/icon only
        // v2.48.88: the light fill is the palette inputBg token
        // (#E2E8F0 in the white theme), not a hard-coded slab.
        bgColor = _isHovered ? AppTheme.surfaceElevated : (AppTheme.dark ? AppTheme.overlay10 : AppTheme.inputBg);
        borderColor = _isHovered ? AppTheme.border : AppTheme.borderSoft;
        bevelColor = AppTheme.bevelSecondary;
        glowColor = AppTheme.red;
        textColor = isInteractive
            ? (_isHovered ? (AppTheme.dark ? Colors.white : AppTheme.red) : AppTheme.red)
            : (AppTheme.dark ? AppTheme.textDim.withValues(alpha: 0.55) : AppTheme.textFaint);
        break;

      case TactileType.pause:
        gradient = null;
        // Clean slate background — subtle amber accent text/icon only
        bgColor = _isHovered ? AppTheme.surfaceElevated : (AppTheme.dark ? AppTheme.overlay10 : AppTheme.inputBg);
        borderColor = _isHovered ? AppTheme.border : AppTheme.borderSoft;
        bevelColor = AppTheme.bevelSecondary;
        glowColor = AppTheme.accentGold;
        textColor = isInteractive
            ? (_isHovered ? (AppTheme.dark ? Colors.white : AppTheme.accentGold) : AppTheme.accentGold)
            : (AppTheme.dark ? AppTheme.textDim.withValues(alpha: 0.55) : AppTheme.textFaint);
        break;

      case TactileType.icon:
        gradient = null;
        bgColor = widget.isActive
            ? AppTheme.accentGold.withValues(alpha: 0.20)
            : (_isHovered ? AppTheme.surfaceElevated : (AppTheme.dark ? AppTheme.overlay10 : AppTheme.inputBg));
        borderColor = widget.isActive
            ? AppTheme.accentGold
            : (_isHovered ? AppTheme.accentAmber : AppTheme.borderSoft);
        bevelColor = AppTheme.bevelSecondary;
        glowColor = AppTheme.accentGold;
        textColor = widget.isActive || _isHovered ? AppTheme.accentText : AppTheme.textDim;
        break;

      case TactileType.secondary:
        gradient = null;
        // Clean slate background — NO red or brown fills
        bgColor = _isHovered ? AppTheme.surfaceElevated : (AppTheme.dark ? AppTheme.overlay10 : AppTheme.inputBg);
        borderColor = _isHovered ? AppTheme.accentAmber : AppTheme.borderSoft;
        bevelColor = AppTheme.bevelSecondary;
        glowColor = AppTheme.glowPrimary;
        textColor = isInteractive
            ? (_isHovered ? (AppTheme.dark ? Colors.white : AppTheme.textMain) : AppTheme.textMain)
            : (AppTheme.dark ? AppTheme.textDim.withValues(alpha: 0.55) : AppTheme.textFaint);
        break;
    }

    // Custom overrides if explicitly supplied
    if (widget.customBg != null) bgColor = widget.customBg!;
    if (widget.customBorder != null) borderColor = widget.customBorder!;
    if (widget.customBevel != null) bevelColor = widget.customBevel!;
    if (widget.customGlow != null) glowColor = widget.customGlow!;
    if (widget.customTextColor != null) textColor = widget.customTextColor!;

    // Physical 3D calculations:
    // Hover: smooth 2.5px lift up, bottom bevel expands
    // Pressed: 1.5px tactile click down, bottom bevel compresses
    final double translateY;
    final double activeBevel;
    if (_isPressed && isInteractive) {
      translateY = 1.5;
      activeBevel = 0.8;
    } else if (_isHovered && isInteractive) {
      translateY = -2.5;
      activeBevel = widget.bevelDepth + 1.2;
    } else {
      translateY = 0.0;
      activeBevel = widget.bevelDepth;
    }

    final isCircle = widget.shape == BoxShape.circle;

    final btn = MouseRegion(
      onEnter: (_) {
        if (isInteractive && !_isHovered) setState(() => _isHovered = true);
      },
      onExit: (_) {
        if (_isHovered || _isPressed) {
          setState(() {
            _isHovered = false;
            _isPressed = false;
          });
        }
      },
      cursor: isInteractive ? SystemMouseCursors.click : SystemMouseCursors.basic,
      child: GestureDetector(
        onTapDown: (_) {
          if (isInteractive) setState(() => _isPressed = true);
        },
        onTapUp: (_) {
          if (_isPressed) setState(() => _isPressed = false);
        },
        onTapCancel: () {
          if (_isPressed) setState(() => _isPressed = false);
        },
        onTap: isInteractive ? widget.onTap : null,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOutCubic,
          height: widget.height,
          width: widget.width,
          padding: widget.padding ?? const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          transform: Matrix4.translationValues(0, translateY, 0),
          decoration: BoxDecoration(
            shape: widget.shape,
            gradient: gradient,
            color: gradient == null ? bgColor : null,
            borderRadius: isCircle ? null : BorderRadius.circular(widget.borderRadius),
            border: Border.all(
              color: isInteractive ? borderColor : AppTheme.borderSoft.withValues(alpha: 0.5),
              width: 1.0,
            ),
            boxShadow: [
              // Layer 1: Solid Mechanical 3D Bottom Bevel (depth)
              BoxShadow(
                color: isInteractive ? bevelColor : AppTheme.bevelSecondary.withValues(alpha: 0.6),
                offset: Offset(0, activeBevel),
                blurRadius: 0,
                spreadRadius: 0,
              ),
              // Layer 2: Luxury Soft Glow on hover
              if (_isHovered && isInteractive)
                BoxShadow(
                  color: glowColor.withValues(alpha: 0.35),
                  blurRadius: 14,
                  spreadRadius: 0.5,
                  offset: const Offset(0, 3.5),
                )
              else if (!_isPressed && isInteractive)
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

    if (widget.tooltip != null) {
      return Tooltip(message: widget.tooltip!, child: btn);
    }
    return btn;
  }
}

/// A tactile 3D interactive card for progress cards with 2.5px lift
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
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOutCubic,
          transform: Matrix4.translationValues(0, _isHovered ? -2.5 : 0.0, 0),
          padding: widget.padding ?? const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: _isHovered ? AppTheme.surfaceElevated : AppTheme.surface,
            borderRadius: BorderRadius.circular(widget.borderRadius),
            border: Border.all(color: borderCol, width: 1.0),
            boxShadow: [
              // 3D bottom bevel
              BoxShadow(
                color: AppTheme.dark ? const Color(0xFF0F172A) : AppTheme.borderSoft,
                offset: Offset(0, _isHovered ? widget.bevelDepth + 1.2 : widget.bevelDepth),
                blurRadius: AppTheme.dark ? 0 : 1.0,
              ),
              // Soft hover glow
              if (_isHovered)
                BoxShadow(
                  color: glow.withValues(alpha: 0.25),
                  blurRadius: 12,
                  offset: const Offset(0, 3.5),
                )
              else
                BoxShadow(
                  color: AppTheme.dark ? Colors.black26 : const Color(0x0A000000),
                  blurRadius: 4,
                  offset: const Offset(0, 2),
                ),
            ],
          ),
          child: widget.child,
        ),
      ),
    );
  }
}

/// A tactile 3D chip for counter badges and status indicators with smooth hover lift
class TactileChip extends StatefulWidget {
  final Widget? child;
  final String? label;
  final Color color;
  final VoidCallback? onTap;
  final double height;
  final double borderRadius;
  final double bevelDepth;
  final EdgeInsetsGeometry? padding;

  const TactileChip({
    super.key,
    this.child,
    this.label,
    required this.color,
    this.onTap,
    this.height = 24.0,
    this.borderRadius = 8.0,
    this.bevelDepth = 1.8,
    this.padding,
  });

  @override
  State<TactileChip> createState() => _TactileChipState();
}

class _TactileChipState extends State<TactileChip> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    final bool interactive = widget.onTap != null;
    final double translateY = _isHovered ? -1.8 : 0.0;
    final double bevel = _isHovered ? widget.bevelDepth + 1.0 : widget.bevelDepth;

    return MouseRegion(
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      cursor: interactive ? SystemMouseCursors.click : SystemMouseCursors.basic,
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOutCubic,
          height: widget.height,
          padding: widget.padding ?? const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
          transform: Matrix4.translationValues(0, translateY, 0),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: widget.color.withValues(alpha: _isHovered ? 0.22 : 0.12),
            borderRadius: BorderRadius.circular(widget.borderRadius),
            border: Border.all(
              color: widget.color.withValues(alpha: _isHovered ? 0.75 : 0.40),
              width: 1.0,
            ),
            boxShadow: [
              BoxShadow(
                color: AppTheme.dark ? const Color(0xFF0F172A) : widget.color.withValues(alpha: 0.18),
                offset: Offset(0, bevel),
                blurRadius: AppTheme.dark ? 0 : 1.0,
              ),
              if (_isHovered)
                BoxShadow(
                  color: widget.color.withValues(alpha: 0.30),
                  blurRadius: 8,
                  offset: const Offset(0, 2),
                ),
            ],
          ),
          child: widget.child ??
              (widget.label != null
                  ? Text(
                      widget.label!,
                      style: TextStyle(
                        fontSize: 9.5,
                        fontWeight: FontWeight.w800,
                        color: widget.color,
                      ),
                    )
                  : const SizedBox.shrink()),
        ),
      ),
    );
  }
}

/// A luxury 3D interactive section container for major app panels.
/// Features subtle specular edge illumination on hover,
/// smooth 180ms cubic transition, and depth-tuned box shadows.
class TactileSectionContainer extends StatefulWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  final EdgeInsetsGeometry? margin;
  final double borderRadius;
  final double? height;
  final double? width;
  final Clip clipBehavior;

  const TactileSectionContainer({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(12),
    this.margin,
    this.borderRadius = 13.0,
    this.height,
    this.width,
    this.clipBehavior = Clip.none,
  });

  @override
  State<TactileSectionContainer> createState() => _TactileSectionContainerState();
}

class _TactileSectionContainerState extends State<TactileSectionContainer> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    final borderColor = _isHovered
        ? AppTheme.borderHighlight
        : AppTheme.borderSoft;

    return MouseRegion(
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOutCubic,
        height: widget.height,
        width: widget.width,
        margin: widget.margin,
        padding: widget.padding,
        clipBehavior: widget.clipBehavior,
        decoration: BoxDecoration(
          gradient: AppTheme.panelGrad,
          borderRadius: BorderRadius.circular(widget.borderRadius),
          border: Border.all(
            color: borderColor,
            width: 1.0,
          ),
          boxShadow: [
            // v2.48.87 Item 4 (owner-approved LIGHT DESIGN 3 'Gehra frame'):
            // light cards sit on a DEEP slate canvas, so the resting shadow
            // is strengthened (alpha .04 -> .16, blur 5 -> 10) to visibly
            // lift the white cards off the frame. Dark values unchanged.
            BoxShadow(
              color: Colors.black.withValues(
                alpha: AppTheme.dark ? (_isHovered ? 0.45 : 0.35) : (_isHovered ? 0.22 : 0.16),
              ),
              blurRadius: AppTheme.dark ? (_isHovered ? 16 : 12) : (_isHovered ? 14 : 10),
              offset: AppTheme.dark ? const Offset(0, 4) : const Offset(0, 2.5),
            ),
            if (_isHovered)
              BoxShadow(
                color: AppTheme.accentGold.withValues(alpha: AppTheme.dark ? 0.12 : 0.08),
                blurRadius: 18,
                spreadRadius: 0.5,
                offset: const Offset(0, 2),
              ),
          ],
        ),
        child: widget.child,
      ),
    );
  }
}

