import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';
import 'package:provider/provider.dart';
import '../providers/settings_provider.dart';
import '../services/automation_bridge.dart';
import '../theme/app_theme.dart';

// v2.33.0 (player aspect fix): the largest size a video of
// [aspect] (width / height) may occupy inside [maxWidth] x
// [maxHeight] without distorting it. Pure and exported so the fit
// tests can pin the geometry without a native player.
Size fitVideoSize({
  required double aspect,
  required double maxWidth,
  required double maxHeight,
}) {
  final a = (aspect.isFinite && aspect > 0) ? aspect : 16 / 9;
  var w = maxWidth;
  var h = w / a;
  if (h > maxHeight) {
    h = maxHeight;
    w = h * a;
  }
  return Size(w, h);
}

// v2.33.0: the dialog's video area — a box sized to the VIDEO's own
// aspect (portrait video -> tall box, landscape -> wide box),
// centred in the dialog. Before, the area was a fixed 16:9 frame
// and every vertical video played as a narrow pillar inside it.
class AdaptiveVideoArea extends StatelessWidget {
  final double aspect;
  final double maxWidth;
  final double maxHeight;
  final Widget child;

  const AdaptiveVideoArea({
    super.key,
    required this.aspect,
    required this.maxWidth,
    required this.maxHeight,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    final size =
        fitVideoSize(aspect: aspect, maxWidth: maxWidth, maxHeight: maxHeight);
    return Center(
      child: SizedBox(
        width: size.width,
        height: size.height,
        child: child,
      ),
    );
  }
}

// v2.34.0 (Problem 6): the aspect a decoded width/height pair
// implies, or null while either is missing or not positive. Pure
// and exported so the open-flow logic is testable without a
// native player, at the same level as fitVideoSize.
double? aspectFromDimensions(int? width, int? height) {
  if (width == null || height == null || width <= 0 || height <= 0) {
    return null;
  }
  return width / height;
}

// v2.34.0 (Problem 6): what the dialog shows while the video's
// dimensions are being resolved — a NEUTRAL card (same chrome
// width, a plain loading area) that commits to NO aspect. The
// owner asked for exactly this trade: a brief neutral wait is
// fine; a player that opens in the wrong shape and then flips is
// not. Exported for the widget tests.
class PlayerLoadingCard extends StatelessWidget {
  const PlayerLoadingCard({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 170,
      margin: const EdgeInsets.symmetric(horizontal: 14),
      decoration: BoxDecoration(
        color: Colors.black,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: 26,
              height: 26,
              child: CircularProgressIndicator(
                strokeWidth: 2.5,
                color: AppTheme.accentText,
              ),
            ),
            const SizedBox(height: 10),
            Text(
              'Loading video…',
              style: TextStyle(fontSize: 11, color: AppTheme.textDim),
            ),
          ],
        ),
      ),
    );
  }
}

// (Fix list 2026-10-27, item 3): the video area of the dialog —
// the shaped player when the aspect is known, the neutral loading
// card while it is not. The dialog's FIRST frame is built with the
// probed aspect (see probeVideoAspect), so the area is in the
// video's own shape from the moment the dialog becomes visible.
class PlayerArea extends StatelessWidget {
  final double? aspect;
  final double maxWidth;
  final double maxHeight;
  final Widget child;

  const PlayerArea({
    super.key,
    required this.aspect,
    required this.maxWidth,
    required this.maxHeight,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    final a = aspect;
    if (a == null) return const PlayerLoadingCard();
    return AdaptiveVideoArea(
      aspect: a,
      maxWidth: maxWidth,
      maxHeight: maxHeight,
      child: child,
    );
  }
}

// (Fix list 2026-10-27, item 3): resolve a video's aspect from an
// ALREADY-OPENING player, before any dialog exists. Opens the
// media paused on [player] and completes with the first valid
// width/height pair's aspect — or null after 4 seconds, when the
// stream never reports dimensions (the dialog then keeps its
// neutral loading state until they land, as before).
Future<double?> probeVideoAspect(Player player, String path) async {
  final completer = Completer<double?>();
  int? w;
  int? h;
  void tryResolve() {
    final a = aspectFromDimensions(w, h);
    if (a != null && !completer.isCompleted) completer.complete(a);
  }

  final widthSub = player.stream.width.listen((v) {
    w = v;
    tryResolve();
  });
  final heightSub = player.stream.height.listen((v) {
    h = v;
    tryResolve();
  });
  // Fire-and-forget: the probe's completion signal is the
  // dimension streams, not open()'s own future.
  unawaited(player.open(Media(path), play: false).then((_) {},
      onError: (_) {}));
  try {
    return await completer.future.timeout(
      const Duration(seconds: 4),
      onTimeout: () => null,
    );
  } finally {
    await widthSub.cancel();
    await heightSub.cancel();
  }
}

// v2.29.0 (in-app player): Play buttons used to hand the file to
// the OS default player (bridge /api/open-file). Now the video
// plays INSIDE FlowStudio, in this dialog — modelled on the
// owner's approved sample: title + "PLAYING INSIDE FLOWSTUDIO"
// pill + close ✕, the video with a centre play/pause, and a
// control bar (round blue play/pause, seek bar, elapsed/total,
// volume). The file is always resolved through the bridge's
// output-folder-confined path endpoint, or is a path the engine
// itself reported for the task — never an arbitrary caller path.

Future<void> showInAppPlayer(
  BuildContext context, {
  required String title,
  String? filePath,
  String? fileName,
}) async {
  var path = filePath;
  if ((path == null || path.isEmpty) && fileName != null && fileName.isNotEmpty) {
    path = await AutomationBridge.instance.getOutputFilePath(fileName);
  }
  if (path == null || path.isEmpty) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('This video file could not be found in the output folder.'),
          duration: Duration(seconds: 3),
        ),
      );
    }
    return;
  }
  if (!context.mounted) return;
  // v2.29.0: the "Preview autoplay" Settings toggle is real now —
  // it decides whether the preview starts playing on open.
  final autoplay = context.read<SettingsProvider>().settings.previewAutoplay;
  final resolvedPath = path;
  // (Fix list 2026-10-27, item 3 — ROOT CAUSE of the shape flip
  // the owner still saw after v2.34.0): the dialog used to be
  // SHOWN first and resolve the aspect afterwards. Its first
  // visible frame was therefore the loading state — a dialog
  // constrained to a fixed 420 width around a 170-tall black card,
  // i.e. a LANDSCAPE-proportioned box — for every video; when the
  // dimensions landed a moment later the dialog rebuilt at the
  // video's real shape (300 wide and tall for a 9:16 video). The
  // owner saw exactly that: the player "opens in long format,
  // then switches to short". v2.34.0 had removed the wrong-shaped
  // VIDEO but left a wrong-shaped DIALOG as the first frame. Now
  // the player is created and its dimensions are probed BEFORE
  // showDialog runs, so the dialog's first frame already IS the
  // video's own shape; the probe is usually a few hundred
  // milliseconds during which nothing is on screen at all.
  final player = Player();
  final controller = VideoController(player);
  final aspect = await probeVideoAspect(player, resolvedPath);
  if (!context.mounted) {
    await player.dispose();
    return;
  }
  await showDialog(
    context: context,
    builder: (_) => _PlayerDialog(
      title: title,
      player: player,
      controller: controller,
      initialAspect: aspect,
      autoplay: autoplay,
    ),
  );
}

class _PlayerDialog extends StatefulWidget {
  final String title;
  final Player player;
  final VideoController controller;
  final double? initialAspect;
  final bool autoplay;

  const _PlayerDialog({
    required this.title,
    required this.player,
    required this.controller,
    required this.initialAspect,
    required this.autoplay,
  });

  @override
  State<_PlayerDialog> createState() => _PlayerDialogState();
}

class _PlayerDialogState extends State<_PlayerDialog> {
  late final Player _player;
  late final VideoController _controller;
  double _lastVolume = 100;
  // v2.33.0: the video's REAL aspect, from the player's own width /
  // height streams (media_kit exposes the decoded dimensions — no
  // new dependency).
  // v2.34.0 (Problem 6): while the aspect is UNRESOLVED (null) the
  // dialog shows the neutral PlayerLoadingCard — never a
  // wrong-shaped player — and a 4-second fallback resolves to 16:9
  // so a stream that never reports dimensions still opens a player
  // instead of spinning forever.
  // (Fix list 2026-10-27, item 3): the aspect now normally arrives
  // RESOLVED — showInAppPlayer probed the dimensions before this
  // dialog was created, so the first frame is already the video's
  // shape and autoplay starts at once. The unresolved path below
  // survives only for the probe-timeout case; the stream listeners
  // stay either way, so a later dimension correction (rotation
  // metadata) still reshapes the player honestly.
  double? _aspect;
  int? _videoWidth;
  int? _videoHeight;
  StreamSubscription<int?>? _widthSub;
  StreamSubscription<int?>? _heightSub;
  Timer? _resolveFallback;

  @override
  void initState() {
    super.initState();
    _player = widget.player;
    _controller = widget.controller;
    _aspect = widget.initialAspect;
    _widthSub = _player.stream.width.listen((w) {
      _videoWidth = w;
      _updateAspect();
    });
    _heightSub = _player.stream.height.listen((h) {
      _videoHeight = h;
      _updateAspect();
    });
    if (_aspect != null) {
      if (widget.autoplay) _player.play();
    } else {
      _resolveFallback = Timer(const Duration(seconds: 4), () {
        if (mounted && _aspect == null) _resolveAspect(16 / 9);
      });
    }
  }

  void _updateAspect() {
    final a = aspectFromDimensions(_videoWidth, _videoHeight);
    if (a == null || !mounted) return;
    if (_aspect == null) {
      _resolveAspect(a);
    } else if (a != _aspect) {
      setState(() => _aspect = a);
    }
  }

  void _resolveAspect(double a) {
    _resolveFallback?.cancel();
    setState(() => _aspect = a);
    if (widget.autoplay) _player.play();
  }

  @override
  void dispose() {
    _resolveFallback?.cancel();
    _widthSub?.cancel();
    _heightSub?.cancel();
    _player.dispose();
    super.dispose();
  }

  static String _timeLabel(Duration d) {
    final total = d.inSeconds < 0 ? 0 : d.inSeconds;
    final m = total ~/ 60;
    final s = total % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    // v2.33.0: the dialog hugs the VIDEO's shape. The video area is
    // bounded by the window (never wider than the old 660, never
    // taller than the screen minus the header/control chrome), and
    // the dialog's own width follows it — a portrait video gets a
    // tall, narrow player; a landscape video the familiar wide one.
    // At the FIT LAW size (1024x700) both orientations fit whole.
    final screen = MediaQuery.sizeOf(context);
    final maxVideoW = math.min(660.0, math.max(240.0, screen.width - 88));
    final maxVideoH = math.max(160.0, screen.height - 220);
    // v2.34.0 (Problem 6): until the aspect resolves there is NO
    // video area at all — the dialog is a fixed neutral card.
    final resolved = _aspect != null;
    final videoSize = fitVideoSize(
      aspect: _aspect ?? 16 / 9,
      maxWidth: maxVideoW,
      maxHeight: maxVideoH,
    );
    // The header/controls need a minimum width to stay whole.
    final contentWidth =
        resolved ? math.max(videoSize.width, 300.0) : 420.0;
    return Dialog(
      backgroundColor: AppTheme.surfaceElevated,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: contentWidth),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Header: file name + playing pill + close
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 10, 8),
              child: Row(
                children: [
                  Flexible(
                    child: Text(
                      widget.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.bold,
                        color: AppTheme.textMain,
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: AppTheme.green.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(9),
                      border: Border.all(color: AppTheme.green.withValues(alpha: 0.45)),
                    ),
                    child: Text(
                      'PLAYING INSIDE FLOWSTUDIO',
                      style: TextStyle(
                        fontSize: 8.5,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.5,
                        color: AppTheme.green,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  InkWell(
                    onTap: () => Navigator.pop(context),
                    borderRadius: BorderRadius.circular(12),
                    child: Container(
                      width: 24,
                      height: 24,
                      decoration: BoxDecoration(
                        color: AppTheme.overlay10,
                        shape: BoxShape.circle,
                        border: Border.all(color: AppTheme.borderSoft),
                      ),
                      child: Icon(Icons.close, size: 13, color: AppTheme.textDim),
                    ),
                  ),
                ],
              ),
            ),

            // (Fix list 2026-10-27, item 3): ONE area for both
            // states — PlayerArea shows the neutral loading card
            // only while the aspect is unresolved (the rare
            // probe-timeout path); with a probed aspect the shaped
            // player below is the dialog's first frame already.
            // Video area — sized to the video's own aspect (v2.33.0);
            // tap toggles play/pause; the centre button mirrors the
            // sample (pause while playing, play while paused).
            PlayerArea(
              aspect: _aspect,
              maxWidth: maxVideoW,
              maxHeight: maxVideoH,
              child: Container(
                color: Colors.black,
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    Video(
                      controller: _controller,
                      fit: BoxFit.contain,
                      controls: NoVideoControls,
                    ),
                    StreamBuilder<bool>(
                      stream: _player.stream.playing,
                      initialData: widget.autoplay,
                      builder: (context, snap) {
                        final playing = snap.data ?? false;
                        return InkWell(
                          onTap: () => _player.playOrPause(),
                          customBorder: const CircleBorder(),
                          child: Container(
                            width: 58,
                            height: 58,
                            decoration: BoxDecoration(
                              color: Colors.black.withValues(alpha: 0.45),
                              shape: BoxShape.circle,
                              border: Border.all(color: Colors.white24),
                            ),
                            child: Icon(
                              playing ? Icons.pause : Icons.play_arrow,
                              size: 30,
                              color: Colors.white,
                            ),
                          ),
                        );
                      },
                    ),
                  ],
                ),
              ),
            ),
            if (!resolved) const SizedBox(height: 14),

            // Control bar (only once the player exists, v2.34.0)
            if (resolved)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
              child: StreamBuilder<Duration>(
                stream: _player.stream.position,
                initialData: Duration.zero,
                builder: (context, posSnap) {
                  final position = posSnap.data ?? Duration.zero;
                  return StreamBuilder<Duration>(
                    stream: _player.stream.duration,
                    initialData: Duration.zero,
                    builder: (context, durSnap) {
                      final duration = durSnap.data ?? Duration.zero;
                      final maxMs = duration.inMilliseconds.toDouble();
                      final posMs = position.inMilliseconds
                          .toDouble()
                          .clamp(0.0, maxMs > 0 ? maxMs : 0.0);
                      return Row(
                        children: [
                          StreamBuilder<bool>(
                            stream: _player.stream.playing,
                            initialData: widget.autoplay,
                            builder: (context, snap) {
                              final playing = snap.data ?? false;
                              return InkWell(
                                onTap: () => _player.playOrPause(),
                                customBorder: const CircleBorder(),
                                child: Container(
                                  width: 32,
                                  height: 32,
                                  decoration: BoxDecoration(
                                    color: AppTheme.accentGold,
                                    shape: BoxShape.circle,
                                  ),
                                  child: Icon(
                                    playing ? Icons.pause : Icons.play_arrow,
                                    size: 17,
                                    color: Colors.white,
                                  ),
                                ),
                              );
                            },
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Slider(
                              value: maxMs > 0 ? posMs.toDouble() : 0,
                              max: maxMs > 0 ? maxMs : 1,
                              activeColor: AppTheme.accentGold,
                              inactiveColor: AppTheme.overlay20,
                              onChanged: (v) {
                                _player.seek(
                                  Duration(milliseconds: v.round()),
                                );
                              },
                            ),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            '${_timeLabel(position)} / ${_timeLabel(duration)}',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: AppTheme.textDim,
                            ),
                          ),
                          const SizedBox(width: 6),
                          StreamBuilder<double>(
                            stream: _player.stream.volume,
                            initialData: 100,
                            builder: (context, snap) {
                              final vol = snap.data ?? 100;
                              final muted = vol <= 0;
                              return IconButton(
                                icon: Icon(
                                  muted ? Icons.volume_off : Icons.volume_up,
                                  size: 18,
                                  color: AppTheme.textDim,
                                ),
                                visualDensity: VisualDensity.compact,
                                onPressed: () {
                                  if (muted) {
                                    _player.setVolume(_lastVolume);
                                  } else {
                                    _lastVolume = vol;
                                    _player.setVolume(0);
                                  }
                                },
                              );
                            },
                          ),
                        ],
                      );
                    },
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}
