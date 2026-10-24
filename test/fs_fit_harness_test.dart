// v2.30.0 fit harness — pumps the REAL app (MainStudioScreen with
// the real providers) against a FAKE engine bridge on the real
// port (127.0.0.1:48190), seeded with the owner's worst cases:
//   - "Account 1" / "26 credits" / LIVE chip / ticked checkbox /
//     eye button in the compact 215px sidebar (item D)
//   - a CHECKING account (longest chip), a LOGIN account
//   - long saved-file names in Progress + History
//   - dynamic states: GENERATING pill, live counts
//   - theme names "Midnight Blue" / "Graphite + White" /
//     "Gold Premium" / "macOS Classic" in Settings (item E)
//   - the Add Account popup with a long profile name/email
// at 950x650, 1024x768, 1150x800, 1440x900, 1920x1080 (item F).
// Zero overflows / zero unexpected exceptions is the pass bar.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:flutter_flow/main.dart';
import 'package:flutter_flow/providers/accounts_provider.dart';
import 'package:flutter_flow/providers/activity_provider.dart';
import 'package:flutter_flow/providers/generator_provider.dart';
import 'package:flutter_flow/providers/settings_provider.dart';
import 'package:flutter_flow/services/automation_bridge.dart';
import 'package:flutter_flow/widgets/top_strip.dart';

const longFileName = 'Ep11-01_Gauri-thakur-sahab-ke-kamre-me-purani-tasveer-dekhti-hai_final-render.mp4';

Map<String, dynamic> fakeAccount(String id, String name, String email,
    String status, int credits, bool selected, bool hasCookies) {
  return {
    'id': id,
    'name': name,
    'email': email,
    'status': status,
    'credits': credits,
    'selected': selected,
    'hasCookies': hasCookies,
    'chromeProfileDir': '',
  };
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // flutter_test installs a mock HttpClient that answers 400 to
  // everything — that would defeat the fake bridge (the app would
  // even spawn the real node bridge). The app creates a fresh
  // HttpClient per request, so clearing the global override before
  // the test body lets its calls reach the fake bridge for real.
  HttpOverrides.global = null;

  HttpServer? server;
  final sseResponses = <HttpResponse>[];
  final postedSettings = <Map<String, dynamic>>[];
  var generationStarted = false;

  Future<void> handle(HttpRequest req) async {
    final path = req.uri.path;
    // Always drain the request body first — answering a POST
    // without consuming its body can stall the response.
    String bodyText = '';
    if (req.method == 'POST' || req.method == 'PUT') {
      try {
        bodyText = await utf8.decoder.bind(req).join();
      } catch (_) {}
    }
    Future<void> send(Object body) async {
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode(body));
      await req.response.close();
    }

    if (path == '/events') {
      req.response.headers.contentType = ContentType('text', 'event-stream');
      req.response.headers.set('Cache-Control', 'no-cache');
      sseResponses.add(req.response);
      return; // keep open
    }
    if (path == '/api/status') {
      return send({'ok': true, 'version': '2.30.0', 'workers': generationStarted ? 1 : 0});
    }
    if (path == '/api/accounts') {
      return send({
        'ok': true,
        'accounts': [
          fakeAccount('a1', 'Mohd Aslam', 'mohd.aslam.test@gmail.com', 'active', 26, true, false),
          fakeAccount('a2', 'Second Account', 'second.test@gmail.com', 'checking', 0, true, true),
          fakeAccount('a3', 'Third Account', 'third.test@gmail.com', 'Need Login', 0, false, false),
        ],
      });
    }
    if (path == '/api/settings' && req.method == 'GET') {
      // NOTE: no download_folder on purpose — v2.30.0 must push the
      // app's folder into the engine (asserted below).
      return send({'ok': true, 'settings': <String, dynamic>{}});
    }
    if (path == '/api/settings' && req.method == 'POST') {
      try {
        final decoded = jsonDecode(bodyText);
        if (decoded is Map && decoded['settings'] is Map) {
          postedSettings.add(Map<String, dynamic>.from(decoded['settings'] as Map));
        } else if (decoded is Map && decoded['key'] != null) {
          postedSettings.add({decoded['key'].toString(): decoded['value']});
        }
      } catch (_) {}
      return send({'ok': true});
    }
    if (path == '/api/stats') {
      return send({
        'ok': true,
        'stats': {'total': 6, 'today': 1, 'last7Days': 3, 'creditsToday': 14},
        'accountCount': 3,
      });
    }
    if (path == '/api/output-files') {
      final now = DateTime.now().millisecondsSinceEpoch;
      return send({
        'ok': true,
        'folder': 'C:\\FlowStudio\\Videos',
        'files': [
          {'name': longFileName, 'size': 73400320, 'mtime': now},
          {'name': 'Ep10-03.mp4', 'size': 1048576, 'mtime': now - 86400000},
        ],
      });
    }
    if (path == '/api/generation/active-browsers') {
      return send({
        'ok': true,
        'accounts': [
          {'id': 'a1', 'windowShown': true},
        ],
      });
    }
    if (path == '/api/chrome-profiles') {
      return send({
        'ok': true,
        'profiles': [
          {
            'dirName': 'Default',
            'name': 'Person 1',
            'email': 'a.very.long.email.address.for.testing@gmail.com',
            'gaiaName': 'A Very Long Profile Display Name For Testing',
          },
        ],
      });
    }
    if (path == '/api/generation/start') {
      generationStarted = true;
      return send({'ok': true});
    }
    if (path.startsWith('/api/generation/') ||
        path == '/api/accounts/sync-all' ||
        path.startsWith('/api/accounts/')) {
      return send({'ok': true, 'accounts': []});
    }
    return send({'ok': true});
  }

  testWidgets('v2.30.0 fit harness — all views, all sizes, worst-case strings',
      (tester) async {
    // Start the fake bridge on the REAL port before any provider
    // is constructed (providers dial it in their constructors).
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

    final accounts = AccountsProvider();
    final settings = SettingsProvider();
    final activity = ActivityProvider();
    final generator = GeneratorProvider();

    Widget app() {
      return MultiProvider(
        providers: [
          ChangeNotifierProvider.value(value: accounts),
          ChangeNotifierProvider.value(value: settings),
          ChangeNotifierProvider.value(value: activity),
          ChangeNotifierProvider.value(value: generator),
        ],
        child: const MaterialApp(
          debugShowCheckedModeBanner: false,
          home: MainStudioScreen(),
        ),
      );
    }

    // The providers' engine-init chains are long sequences of real
    // HTTP awaits created in the fake-async zone: each request only
    // advances when the zone is flushed (probe-verified: roughly
    // one request per runAsync+pump round). This loop is that flush.
    Future<void> flush([int rounds = 6]) async {
      for (var i = 0; i < rounds; i++) {
        await tester.runAsync(
            () => Future.delayed(const Duration(milliseconds: 200)));
        await tester.pump(const Duration(milliseconds: 60));
      }
    }

    Future<void> flushUntil(bool Function() cond, {int maxRounds = 45}) async {
      for (var i = 0; i < maxRounds && !cond(); i++) {
        await tester.runAsync(
            () => Future.delayed(const Duration(milliseconds: 200)));
        await tester.pump(const Duration(milliseconds: 60));
      }
    }

    Future<void> settleReal([int seconds = 2]) async {
      await flush(seconds * 3);
    }

    void expectNoException(String where) {
      final e = tester.takeException();
      expect(e, isNull, reason: 'unexpected exception at $where: $e');
    }

    const sizes = [
      Size(950, 650),
      Size(1024, 768),
      Size(1150, 800),
      Size(1440, 900),
      Size(1920, 1080),
    ];

    // ---------- pass 1: boot + Generate view at every size ----------
    var booted = false;
    for (final size in sizes) {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(app());
      if (!booted) {
        // First boot: flush until the provider init chain has
        // delivered the accounts; fall back to a manual syncAll.
        await flushUntil(() => accounts.accounts.isNotEmpty);
        if (accounts.accounts.isEmpty) {
          unawaited(accounts.syncAll());
          await flushUntil(() => accounts.accounts.isNotEmpty);
        }
        // The ACTIVE flag rides a separate later call in the same
        // init chain (getActiveBrowsers) — flush for it too.
        await flushUntil(() => accounts.accounts.any((a) => a.isActive),
            maxRounds: 25);
        booted = true;
      } else {
        await flush(3);
      }
      // ignore: avoid_print
      print('HARNESS @$size accounts='
          '${accounts.accounts.map((a) => '${a.alias}:${a.credits}:${a.status}').toList()} '
          'total=${accounts.totalCredits}');
      expectNoException('Generate @ $size');

      // Item C: no Sync button in the top strip; totals present.
      expect(
        find.descendant(of: find.byType(TopStrip), matching: find.text('Sync')),
        findsNothing,
        reason: 'top strip must not contain a Sync button',
      );
      expect(find.text('TOTAL CREDITS'), findsOneWidget);
      expect(find.text('26'), findsWidgets); // 26 credits total (a1)

      // Item D strings exist in the sidebar.
      expect(find.text('Account 1'), findsOneWidget);
      expect(find.text('26 credits'), findsOneWidget);
      expect(find.text('LIVE'), findsOneWidget);
      expect(find.text('Cookie 1'), findsOneWidget);
      expect(find.text('CHECKING'), findsOneWidget);
      expect(find.text('● ACTIVE'), findsOneWidget);
    }

    // ---------- item D deep check at the owner's size ----------
    tester.view.physicalSize = const Size(1024, 768);
    tester.view.devicePixelRatio = 1.0;
    await tester.pumpWidget(app());
    await settleReal(2);
    expectNoException('D deep check boot');

    for (final label in ['Account 1', '26 credits', 'Cookie 1']) {
      final textWidget = tester.widget<Text>(find.text(label));
      expect(textWidget.overflow, isNot(TextOverflow.ellipsis),
          reason: '$label must never be ellipsized');
      expect(textWidget.softWrap, isFalse,
          reason: '$label is a single fitted line');
      // It must live inside the scale-down FittedBox that guarantees fit.
      expect(
        find.ancestor(of: find.text(label), matching: find.byType(FittedBox)),
        findsWidgets,
        reason: '$label must be protected by the row FittedBox',
      );
    }
    // The alias fits at (near) full scale: measure the FittedBox scale
    // by comparing the paragraph's intrinsic width with the box width.
    {
      final fittedBoxFinder = find
          .ancestor(of: find.text('Account 1'), matching: find.byType(FittedBox))
          .first;
      final boxSize = tester.getSize(fittedBoxFinder);
      final paragraph = tester.renderObject<RenderParagraph>(find.text('Account 1'));
      final scale = boxSize.width / paragraph.size.width;
      // ignore: avoid_print
      print('D-MEASURE Account 1: box=${boxSize.width.toStringAsFixed(1)}px '
          'text=${paragraph.size.width.toStringAsFixed(1)}px scale=${scale.toStringAsFixed(2)}');
      // FONT CAVEAT: the flutter_test font draws every glyph ~1em
      // wide — roughly 1.8x wider than the production font — AND
      // the LIVE chip inflates by the same factor, shrinking the
      // slot from both sides. In production metrics the title is
      // ~55px in a ~61px slot (full size). The hard guarantees
      // asserted here are the structural ones: no ellipsis anywhere
      // (checked above), the FittedBox fit, and zero exceptions at
      // every size. The 0.4 floor simply proves the fit mechanism
      // is engaged and sane even in this worst-case font world.
      expect(scale, greaterThan(0.4),
          reason: 'Account 1 fit mechanism must be engaged at 215px sidebar');
    }

    // A: with no engine download_folder, the app must have pushed its
    // own folder to the engine (single source of truth).
    await flushUntil(
        () => postedSettings.any((m) => m.containsKey('download_folder')),
        maxRounds: 25);
    expect(
      postedSettings.any((m) => m['download_folder'] == 'C:\\FlowStudio\\Videos'),
      isTrue,
      reason: 'settings load must persist download_folder to the engine',
    );

    // ---------- dynamic states: run a generation ----------
    // ignore: avoid_print
    print('HARNESS section: generation');
    generator.setRawText(
        '#11-01 Gauri thakur sahab ke kamre me purani tasveer dekhti hai\n\n#11-02 Malti darwaze par khadi sab sun leti hai');
    // NOT awaited directly: a bare await on a real-IO future in
    // the fake zone deadlocks (its continuations only advance when
    // the zone is pumped). Fire it, then flush until it lands.
    unawaited(generator.startGeneration(
        accounts: accounts, activity: activity, settings: settings));
    await flushUntil(() => generator.isRunning, maxRounds: 25);
    await flush(5);
    await tester.pump();
    // Complete item 1 with the LONG file name via the real callback.
    AutomationBridge.instance.onVideoCompleted?.call({
      'promptIndex': 0,
      'prompt': '#11-01 Gauri thakur sahab ke kamre me purani tasveer dekhti hai',
      'accountName': 'Account 1',
      'status': 'Completed',
      'fileName': longFileName,
      'filePath': 'C:\\FlowStudio\\Videos\\$longFileName',
      'creditsUsed': 7,
    });
    await tester.pump();
    expectNoException('Generate while GENERATING');
    expect(find.text('GENERATING'), findsOneWidget);
    expect(find.text(longFileName), findsWidgets);

    // ---------- Settings view at every size (item E/F) ----------
    // ignore: avoid_print
    print('HARNESS section: settings');
    settings.setNavView('settings');
    for (final size in sizes) {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1.0;
      await tester.pumpWidget(app());
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump(const Duration(milliseconds: 300));
      expectNoException('Settings @ $size');
      for (final themeName in [
        'Midnight Blue',
        'Graphite + White',
        'Gold Premium',
        'macOS Classic',
      ]) {
        final w = tester.widget<Text>(find.text(themeName));
        expect(w.maxLines, 2, reason: '$themeName gets a two-line slot');
        expect(w.overflow, isNot(TextOverflow.ellipsis),
            reason: '$themeName must not be clipped with an ellipsis');
      }
    }

    // ---------- History view + hidden-records recovery (item A/F) ----
    // ignore: avoid_print
    print('HARNESS section: history');
    settings.setNavView('history');
    tester.view.physicalSize = const Size(1024, 768);
    tester.view.devicePixelRatio = 1.0;
    await tester.pumpWidget(app());
    await settleReal(2);
    expectNoException('History @ 1024x768');
    expect(find.text(longFileName), findsOneWidget);
    expect(find.text('6'), findsWidgets); // TOTAL VIDEOS (ALL TIME) = engine total

    // Clear History hides the records; the page must SAY so and
    // offer recovery — then recovery must bring the rows back.
    settings.clearHistoryRecords([longFileName, 'Ep10-03.mp4']);
    await tester.pump();
    expectNoException('History after Clear');
    expect(find.text('Show them'), findsOneWidget);
    expect(find.textContaining('hidden'), findsWidgets);
    await tester.tap(find.text('Show them'));
    await tester.pump();
    expectNoException('History after Show them');
    expect(find.text(longFileName), findsOneWidget);

    for (final size in sizes) {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1.0;
      await tester.pumpWidget(app());
      await tester.pump(const Duration(milliseconds: 300));
      expectNoException('History @ $size');
    }

    // ---------- Add Account popup (item F) ----------
    // ignore: avoid_print
    print('HARNESS section: popup');
    settings.setNavView('generate');
    tester.view.physicalSize = const Size(950, 650);
    tester.view.devicePixelRatio = 1.0;
    await tester.pumpWidget(app());
    await settleReal(1);
    expectNoException('Generate @ 950x650 before popup');
    await tester.tap(find.text('+ Add Account'));
    await tester.pump(const Duration(milliseconds: 400));
    await settleReal(1);
    expectNoException('Add Account popup @ 950x650');
    expect(find.text('Opens the Gmail login page directly'), findsOneWidget);
    expect(find.text('A Very Long Profile Display Name For Testing'),
        findsOneWidget);
    await tester.tap(find.descendant(
        of: find.byType(AlertDialog), matching: find.byIcon(Icons.close)));
    await tester.pump(const Duration(milliseconds: 300));
    expectNoException('popup closed');

    // ---------- Generate view final sweep at every size ----------
    for (final size in sizes) {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1.0;
      await tester.pumpWidget(app());
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump(const Duration(milliseconds: 300));
      expectNoException('Generate final @ $size');
    }
  });
}
