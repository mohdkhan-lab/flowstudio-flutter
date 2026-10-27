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

  // v2.34.0 (Problem 6): the open flow resolves the video's
  // dimensions BEFORE any shaped player is shown. The native
  // player still cannot initialise under flutter_test, so the
  // logic is pinned at the same level as v2.33.0's: the pure
  // aspectFromDimensions resolver the dialog's stream handlers
  // use, and the neutral loading card the dialog shows while the
  // aspect is unresolved (no AdaptiveVideoArea exists in that
  // state — a wrong-shaped player can never paint).
  group('aspectFromDimensions (v2.34.0 resolve-before-show)', () {
    test('portrait dimensions resolve to a portrait aspect', () {
      expect(aspectFromDimensions(720, 1280), closeTo(9 / 16, 0.001));
    });

    test('landscape dimensions resolve to a landscape aspect', () {
      expect(aspectFromDimensions(1280, 720), closeTo(16 / 9, 0.001));
    });

    test('missing dimensions stay unresolved (null)', () {
      expect(aspectFromDimensions(null, 1280), isNull);
      expect(aspectFromDimensions(720, null), isNull);
      expect(aspectFromDimensions(null, null), isNull);
    });

    test('non-positive dimensions stay unresolved (null)', () {
      expect(aspectFromDimensions(0, 1280), isNull);
      expect(aspectFromDimensions(720, 0), isNull);
      expect(aspectFromDimensions(-720, 1280), isNull);
    });
  });

  group('PlayerLoadingCard (v2.34.0 neutral state)', () {
    testWidgets('renders with NO video area at 1024x700', (tester) async {
      tester.view.physicalSize = const Size(1024, 700);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: Center(
              child: SizedBox(width: 420, child: PlayerLoadingCard()),
            ),
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      expect(find.byType(PlayerLoadingCard), findsOneWidget);
      expect(find.byType(AdaptiveVideoArea), findsNothing,
          reason: 'the unresolved state must not contain any shaped video area');
      expect(find.text('Loading video…'), findsOneWidget);
    });
  });

  // (Fix list 2026-10-27, item 3): the dialog is now shown only
  // AFTER its aspect has been probed (showInAppPlayer), and its
  // area is the PlayerArea below. The regression being pinned:
  // v2.34.0 showed the dialog FIRST, so its first visible frame
  // was a fixed 420-wide loading card — a landscape-shaped box —
  // and the dialog then reshaped when the dimensions landed (the
  // owner's "opens long, then switches to short"). With a probed
  // aspect, PlayerArea's very first frame must already be the
  // shaped player, with NO loading card anywhere in the tree.
  group('PlayerArea (fix list item 3: first frame is already shaped)', () {
    Future<void> pumpArea(WidgetTester tester, double? aspect) async {
      tester.view.physicalSize = const Size(1024, 700);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: PlayerArea(
                aspect: aspect,
                maxWidth: 660,
                maxHeight: 480,
                child: const ColoredBox(color: Colors.black),
              ),
            ),
          ),
        ),
      );
      // Exactly ONE pump: this is the first visible frame.
      expect(tester.takeException(), isNull);
    }

    testWidgets('a probed 9:16 aspect renders the tall player on frame one',
        (tester) async {
      await pumpArea(tester, 9 / 16);
      expect(find.byType(PlayerLoadingCard), findsNothing,
          reason: 'a probed aspect must never show the loading card');
      final box = tester.getSize(find.descendant(
          of: find.byType(AdaptiveVideoArea),
          matching: find.byType(ColoredBox)));
      expect(box.width, closeTo(270, 0.01));
      expect(box.height, closeTo(480, 0.01));
    });

    testWidgets('a probed 16:9 aspect renders the wide player on frame one',
        (tester) async {
      await pumpArea(tester, 16 / 9);
      expect(find.byType(PlayerLoadingCard), findsNothing);
      final box = tester.getSize(find.descendant(
          of: find.byType(AdaptiveVideoArea),
          matching: find.byType(ColoredBox)));
      expect(box.width, closeTo(660, 0.01));
      expect(box.height, closeTo(371.25, 0.01));
    });

    testWidgets('an unresolved aspect shows ONLY the neutral card',
        (tester) async {
      await pumpArea(tester, null);
      expect(find.byType(PlayerLoadingCard), findsOneWidget);
      expect(find.byType(AdaptiveVideoArea), findsNothing,
          reason: 'no shaped player may exist before the aspect is known');
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
