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
  await showDialog(
    context: context,
    builder: (_) => _PlayerDialog(
      title: title,
      path: resolvedPath,
      autoplay: autoplay,
    ),
  );
}

class _PlayerDialog extends StatefulWidget {
  final String title;
  final String path;
  final bool autoplay;

  const _PlayerDialog({
    required this.title,
    required this.path,
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
  // new dependency). 16:9 until the metadata lands, then the dialog
  // reshapes itself to the video: tall for portrait, wide for
  // landscape.
  double _aspect = 16 / 9;
  int? _videoWidth;
  int? _videoHeight;
  StreamSubscription<int?>? _widthSub;
  StreamSubscription<int?>? _heightSub;

  @override
  void initState() {
    super.initState();
    _player = Player();
    _controller = VideoController(_player);
    _widthSub = _player.stream.width.listen((w) {
      _videoWidth = w;
      _updateAspect();
    });
    _heightSub = _player.stream.height.listen((h) {
      _videoHeight = h;
      _updateAspect();
    });
    _player.open(Media(widget.path), play: widget.autoplay);
  }

  void _updateAspect() {
    final w = _videoWidth;
    final h = _videoHeight;
    if (w == null || h == null || w <= 0 || h <= 0 || !mounted) return;
    final a = w / h;
    if (a != _aspect) setState(() => _aspect = a);
  }

  @override
  void dispose() {
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
    final videoSize = fitVideoSize(
      aspect: _aspect,
      maxWidth: maxVideoW,
      maxHeight: maxVideoH,
    );
    // The header/controls need a minimum width to stay whole.
    final contentWidth = math.max(videoSize.width, 300.0);
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

            // Video area — sized to the video's own aspect (v2.33.0);
            // tap toggles play/pause; the centre button mirrors the
            // sample (pause while playing, play while paused).
            AdaptiveVideoArea(
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

            // Control bar
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
                                  decoration: const BoxDecoration(
                                    color: Color(0xFF0A84FF),
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
                              activeColor: const Color(0xFF0A84FF),
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
