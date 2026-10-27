import 'package:flutter/material.dart';

/// Staggered entrance for the Settings page's panels.
///
/// When the Settings view opens, each panel fades in while rising
/// a few pixels, one after another in reading order, so the page
/// settles in instead of snapping. This is the ONE place the
/// mechanism lives — the Settings view wraps every panel in a
/// [PanelEntrance] with a fixed [index] (0, 1, 2, …) and this
/// widget does the rest.
///
/// Timing: a single 650ms controller per panel. Panel i animates
/// over 260ms starting i×55ms in, expressed as an [Interval] on
/// that shared-length controller — no timers, nothing to leak,
/// and the whole page (eight panels) is settled in 645ms.
///
/// Only opacity and a vertical translate are animated: both are
/// paint/composite transforms, so layout and sizes NEVER change —
/// the pair() equal-height grid and the fit measurements see
/// exactly the old geometry, and the cost on the owner's PC is
/// negligible.
///
/// The animation runs once per mount. The Settings view is
/// recreated every time it is opened, so the entrance replays on
/// each visit; if the view is closed mid-sequence the wrapper is
/// disposed with it (nothing can be left invisible), and if it
/// stays open the controller always runs to 1.0 — fully opaque,
/// offset zero.
class PanelEntrance extends StatefulWidget {
  const PanelEntrance({super.key, required this.index, required this.child});

  /// This panel's position in the page's reading order; drives
  /// the stagger delay.
  final int index;

  final Widget child;

  @override
  State<PanelEntrance> createState() => _PanelEntranceState();
}

class _PanelEntranceState extends State<PanelEntrance>
    with SingleTickerProviderStateMixin {
  static const int _totalMs = 650;
  static const int _panelMs = 260;
  static const int _stepMs = 55;
  static const double _risePx = 10;

  late final AnimationController _controller;
  late final Animation<double> _anim;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: _totalMs),
    );
    final begin = (widget.index * _stepMs / _totalMs).clamp(0.0, 1.0);
    final end = (begin + _panelMs / _totalMs).clamp(0.0, 1.0);
    _anim = CurvedAnimation(
      parent: _controller,
      curve: Interval(begin, end, curve: Curves.easeOutCubic),
    );
    _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _anim,
      child: widget.child,
      builder: (context, child) {
        final t = _anim.value;
        return Opacity(
          opacity: t,
          child: Transform.translate(
            offset: Offset(0, _risePx * (1 - t)),
            child: child,
          ),
        );
      },
    );
  }
}
