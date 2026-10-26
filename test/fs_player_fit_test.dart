// v2.33.0 (Problem 1): the in-app player's video area adapts to
// the video's own aspect. The real dialog constructs a native
// media_kit Player, which flutter_test cannot initialise — so the
// geometry is pinned here through the SAME pieces the dialog uses:
// the pure fitVideoSize function and the AdaptiveVideoArea widget,
// laid out in a dialog-shaped column (header + video + controls)
// at the FIT LAW window size 1024x700, for a 9:16 and a 16:9 video.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_flow/widgets/video_player_dialog.dart';

void main() {
  group('fitVideoSize', () {
    test('landscape fills the width, height follows the aspect', () {
      final s = fitVideoSize(aspect: 16 / 9, maxWidth: 660, maxHeight: 480);
      expect(s.width, 660);
      expect(s.height, closeTo(371.25, 0.01));
    });

    test('portrait fills the height, width follows the aspect', () {
      final s = fitVideoSize(aspect: 9 / 16, maxWidth: 660, maxHeight: 480);
      expect(s.height, 480);
      expect(s.width, closeTo(270, 0.01));
    });

    test('square video is bounded by the height', () {
      final s = fitVideoSize(aspect: 1, maxWidth: 660, maxHeight: 480);
      expect(s.width, 480);
      expect(s.height, 480);
    });

    test('a broken aspect falls back to 16:9', () {
      final s = fitVideoSize(aspect: 0, maxWidth: 660, maxHeight: 480);
      expect(s.width, 660);
      expect(s.height, closeTo(371.25, 0.01));
    });
  });

  group('AdaptiveVideoArea in a dialog at 1024x700 (FIT LAW)', () {
    // The dialog's own chrome math, mirrored from _PlayerDialog:
    // header ~42 + controls ~56 + the framework's dialog insets.
    Future<Size> pumpDialog(WidgetTester tester, double aspect) async {
      tester.view.physicalSize = const Size(1024, 700);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: Dialog(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const SizedBox(height: 42), // header stand-in
                    AdaptiveVideoArea(
                      aspect: aspect,
                      maxWidth: 660,
                      maxHeight: 700 - 220,
                      child: const ColoredBox(color: Colors.black),
                    ),
                    const SizedBox(height: 56), // controls stand-in
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      expect(tester.takeException(), isNull,
          reason: 'dialog must not overflow at 1024x700');
      return tester.getSize(find.byType(AdaptiveVideoArea).first);
    }

    testWidgets('9:16 video gets a tall player area', (tester) async {
      final area = await pumpDialog(tester, 9 / 16);
      final box = tester.getSize(find.descendant(
          of: find.byType(AdaptiveVideoArea),
          matching: find.byType(ColoredBox)));
      expect(box.height, greaterThan(box.width),
          reason: 'portrait video area must be taller than wide');
      expect(box.height, closeTo(480, 0.01));
      expect(box.width, closeTo(270, 0.01));
      expect(area.height, greaterThan(0)); // sanity: the area rendered
    });

    testWidgets('16:9 video gets a wide player area', (tester) async {
      await pumpDialog(tester, 16 / 9);
      final box = tester.getSize(find.descendant(
          of: find.byType(AdaptiveVideoArea),
          matching: find.byType(ColoredBox)));
      expect(box.width, greaterThan(box.height),
          reason: 'landscape video area must be wider than tall');
      expect(box.width, closeTo(660, 0.01));
      expect(box.height, closeTo(371.25, 0.01));
    });

    testWidgets('portrait area is narrower than landscape area',
        (tester) async {
      await pumpDialog(tester, 9 / 16);
      final portrait = tester.getSize(find.descendant(
          of: find.byType(AdaptiveVideoArea),
          matching: find.byType(ColoredBox)));
      await pumpDialog(tester, 16 / 9);
      final landscape = tester.getSize(find.descendant(
          of: find.byType(AdaptiveVideoArea),
          matching: find.byType(ColoredBox)));
      expect(portrait.width, lessThan(landscape.width));
      expect(portrait.height, greaterThan(landscape.height));
    });
  });
}
