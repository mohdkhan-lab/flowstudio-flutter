// v2.34.1 HOTFIX regression test — the Settings grid collapse.
//
// v2.34.0 shipped the Sample-A two-column Settings grid as one-row
// Tables whose every cell used TableCellVerticalAlignment.fill.
// In RenderTable a row's height accumulates only from non-fill
// cells, so each all-fill row collapsed to height 0: the panels
// were built and laid out but INVISIBLE — the owner saw only the
// About bar and the Created By panel under them. The fit harness
// missed it because find.text succeeds inside a 0-height subtree
// and no exception is thrown. These tests therefore assert
// RENDERED SIZES, not just presence: every section heading must be
// found AND its panel must render with height > 0, the two panels
// of a pair must share the same height (the Sample-A promise), and
// the About bar must sit BELOW the Updates | MCP row — on the wide
// two-column path (1024x700) and on the narrow stacked path (<700).
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:flutter_flow/providers/settings_provider.dart';
import 'package:flutter_flow/widgets/settings_view.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // Same fake-bridge pattern as the fit harness: the providers
  // dial the real port, so answer them with a local stub instead
  // of flutter_test's mock HttpClient.
  HttpOverrides.global = null;

  HttpServer? server;
  final sseResponses = <HttpResponse>[];

  Future<void> handle(HttpRequest req) async {
    final path = req.uri.path;
    if (req.method == 'POST' || req.method == 'PUT') {
      try {
        await utf8.decoder.bind(req).join();
      } catch (_) {}
    }
    if (path == '/events') {
      req.response.headers.contentType = ContentType('text', 'event-stream');
      req.response.headers.set('Cache-Control', 'no-cache');
      sseResponses.add(req.response);
      return; // keep open
    }
    req.response.headers.contentType = ContentType.json;
    if (path == '/api/settings' && req.method == 'GET') {
      req.response.write(jsonEncode({'ok': true, 'settings': <String, dynamic>{}}));
    } else {
      req.response.write(jsonEncode({'ok': true}));
    }
    await req.response.close();
  }

  // The panel built by SettingsView._buildPanel: the Container
  // (padding 12, radius-13 bordered decoration) that is the
  // heading's own ancestor. Inner content containers never sit
  // between a section heading and its panel, so this finds
  // exactly one widget per heading.
  Finder panelOf(String heading) {
    return find.ancestor(
      of: find.textContaining(heading),
      matching: find.byWidgetPredicate((w) =>
          w is Container &&
          w.padding == const EdgeInsets.all(12) &&
          w.decoration is BoxDecoration &&
          (w.decoration as BoxDecoration).borderRadius ==
              BorderRadius.circular(13)),
    );
  }

  const headings = [
    'APPEARANCE',
    'DEFAULTS',
    'AUTOMATION',
    'FILES & PATHS',
    'UPDATES',
    'MCP CONNECTION',
  ];

  testWidgets('v2.34.1 — every Settings section renders with real height',
      (tester) async {
    await tester.runAsync(() async {
      server = await HttpServer.bind('127.0.0.1', 48190);
      server!.listen(handle);
    });
    addTearDown(() async {
      for (final res in sseResponses) {
        try {
          await res.close();
        } catch (_) {}
      }
      await server?.close(force: true);
    });

    final settings = SettingsProvider();

    Widget app() {
      return ChangeNotifierProvider.value(
        value: settings,
        child: const MaterialApp(
          debugShowCheckedModeBanner: false,
          home: Scaffold(body: SettingsView()),
        ),
      );
    }

    Future<void> flush([int rounds = 6]) async {
      for (var i = 0; i < rounds; i++) {
        await tester.runAsync(
            () => Future.delayed(const Duration(milliseconds: 150)));
        await tester.pump(const Duration(milliseconds: 60));
      }
    }

    void expectNoException(String where) {
      final e = tester.takeException();
      expect(e, isNull, reason: 'unexpected exception at $where: $e');
    }

    void checkSections({required bool wide}) {
      for (final h in headings) {
        final headingFinder = find.textContaining(h);
        expect(headingFinder, findsOneWidget, reason: '$h heading is present');
        expect(tester.getSize(headingFinder).height, greaterThan(0),
            reason: '$h heading renders with height > 0');
        final panel = panelOf(h);
        expect(panel, findsOneWidget, reason: '$h panel is present');
        expect(tester.getSize(panel).height, greaterThan(0),
            reason: '$h panel renders with height > 0 '
                '(0 == the v2.34.0 all-fill Table collapse)');
      }
      if (wide) {
        // Sample A: the two cards of a row share the SAME height.
        const pairs = [
          ['APPEARANCE', 'DEFAULTS'],
          ['AUTOMATION', 'FILES & PATHS'],
          ['UPDATES', 'MCP CONNECTION'],
        ];
        for (final pair in pairs) {
          expect(
            tester.getSize(panelOf(pair[0])).height,
            tester.getSize(panelOf(pair[1])).height,
            reason: '${pair[0]} and ${pair[1]} share one row height',
          );
        }
      }
      // The About bar sits BELOW the last grid row (Updates | MCP),
      // never floating where the grid should be.
      final about = find.textContaining('ABOUT');
      expect(about, findsOneWidget, reason: 'About bar is present');
      final aboutTop = tester.getTopLeft(about).dy;
      final mcpBottom = tester.getBottomLeft(panelOf('MCP CONNECTION')).dy;
      final updatesBottom = tester.getBottomLeft(panelOf('UPDATES')).dy;
      expect(aboutTop, greaterThanOrEqualTo(mcpBottom - 0.5),
          reason: 'About bar is below the MCP Connection panel');
      expect(aboutTop, greaterThanOrEqualTo(updatesBottom - 0.5),
          reason: 'About bar is below the Updates panel');
    }

    // ---------- wide two-column path: 1024x700 ----------
    tester.view.physicalSize = const Size(1024, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(app());
    await flush();
    expectNoException('Settings wide @ 1024x700');
    checkSections(wide: true);

    // ---------- narrow stacked path: content width < 700 ----------
    tester.view.physicalSize = const Size(600, 700);
    tester.view.devicePixelRatio = 1.0;
    await tester.pumpWidget(app());
    await flush(3);
    expectNoException('Settings narrow @ 600x700');
    checkSections(wide: false);
  });
}
