// v2.34.0 (Problems 9, 10, 12): the Generate-bar credit estimate
// table, the selected-tag single-source-of-truth rules, and the
// social-link usability gate.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:flutter_flow/providers/generator_provider.dart';
import 'package:flutter_flow/providers/settings_provider.dart';
import 'package:flutter_flow/services/credit_costs.dart';
import 'package:flutter_flow/widgets/prompts_editor.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('P10 — credit estimate table (REAL rates, owner-verified 2026-10-27)', () {
    test('REQUIRED: Omni Flash · 4s · 360p · 2 prompts → "est. 8 credits"', () {
      expect(
        creditEstimateText(
            model: 'Omni Flash', duration: '4s', quality: '360p', promptCount: 2),
        'est. 8 credits',
      );
    });

    test('Omni Flash 360p row (owner panel evidence)', () {
      expect(creditCostPerVideo('Omni Flash', '4s', '360p'), 4);
      expect(creditCostPerVideo('Omni Flash', '6s', '360p'), 5);
      expect(creditCostPerVideo('Omni Flash', '8s', '360p'), 6);
      expect(creditCostPerVideo('Omni Flash', '10s', '360p'), 7);
    });

    test('Omni Flash 720p row (owner panel evidence)', () {
      expect(creditCostPerVideo('Omni Flash', '4s', '720p'), 7);
      expect(creditCostPerVideo('Omni Flash', '6s', '720p'), 10);
      expect(creditCostPerVideo('Omni Flash', '8s', '720p'), 12);
      expect(creditCostPerVideo('Omni Flash', '10s', '720p'), 15);
    });

    test('1080p setting generates at 720p, so it bills the 720p row', () {
      expect(generationResolution('1080p'), '720p');
      expect(creditCostPerVideo('Omni Flash', '10s', '1080p'), 15);
    });

    test('display name "Omni 1.1 Flash" resolves to the same family', () {
      expect(creditCostPerVideo('Omni 1.1 Flash', '4s', '360p'), 4);
    });

    test('Veo 3.1 Fast is a flat 20 — Veo is always 8s, duration ignored', () {
      expect(
        creditEstimateText(
            model: 'Veo 3.1 Fast', duration: '10s', quality: '720p', promptCount: 3),
        'est. 60 credits',
      );
      expect(creditCostPerVideo('Veo 3.1 Fast', '4s', '720p'), 20);
    });

    test('Veo 3.1 Lite is a flat 10', () {
      expect(creditCostPerVideo('Veo 3.1 Lite', '4s', '720p'), 10);
      expect(creditCostPerVideo('Veo 3.1 Lite', '8s', '720p'), 10);
    });

    test('Veo 3.1 Quality is a flat 100 at any duration', () {
      expect(creditCostPerVideo('Veo 3.1 Quality', '4s', '720p'), 100);
      expect(creditCostPerVideo('Veo 3.1 Quality', '10s', '720p'), 100);
    });

    test('unevidenced combos return NO estimate (never a fake number)', () {
      expect(creditCostPerVideo('Omni Flash', '12s', '360p'), isNull);
      expect(creditCostPerVideo('Some Future Model', '4s', '360p'), isNull);
      expect(
        creditEstimateText(
            model: 'Some Future Model', duration: '4s', quality: '360p', promptCount: 5),
        isNull,
      );
    });

    test('singular credit wording', () {
      // No table entry costs 1, so pin the pluralisation through a
      // zero-prompt edge instead: 0 prompts at a known rate is 0.
      expect(
        creditEstimateText(
            model: 'Omni Flash', duration: '4s', quality: '360p', promptCount: 0),
        'est. 0 credits',
      );
    });
  });

  group('P9 — selected tag: provider is the single source of truth', () {
    test('deleting the selected tag clears the selection to None', () {
      final gen = GeneratorProvider();
      gen.setSelectedTag('Cinematic');
      expect(gen.selectedTag, 'Cinematic');
      // The tag list changes (Settings deleted 'Cinematic') → the
      // composition root reconciles → the stale tag is gone.
      gen.reconcileSelectedTag(const ['None', 'Anime', 'Drone']);
      expect(gen.selectedTag, 'None');
    });

    test('a selection that still exists survives reconciliation', () {
      final gen = GeneratorProvider();
      gen.setSelectedTag('Anime');
      gen.reconcileSelectedTag(const ['None', 'Anime', 'Drone']);
      expect(gen.selectedTag, 'Anime');
    });

    test('None is never reconciled away', () {
      final gen = GeneratorProvider();
      gen.reconcileSelectedTag(const ['None']);
      expect(gen.selectedTag, 'None');
    });

    testWidgets('the TAG dropdown reflects a programmatic setSelectedTag',
        (tester) async {
      final gen = GeneratorProvider();
      final settings = SettingsProvider();
      settings.settings.customTags = ['None', 'Cinematic', 'Anime'];
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider.value(value: gen),
            ChangeNotifierProvider.value(value: settings),
          ],
          child: const MaterialApp(
            home: Scaffold(body: SizedBox(width: 600, child: PromptsEditor())),
          ),
        ),
      );
      await tester.pump();
      DropdownButton<String> dropdown() =>
          tester.widget<DropdownButton<String>>(
              find.byType(DropdownButton<String>).first);
      expect(dropdown().value, 'None');
      // An MCP in-app run (or any programmatic caller) sets the
      // tag on the provider — the dropdown must show it without
      // the user touching anything.
      gen.setSelectedTag('Cinematic');
      await tester.pump();
      expect(dropdown().value, 'Cinematic');
      // And choosing in the dropdown writes back to the provider.
      await tester.tap(find.byType(DropdownButton<String>).first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Anime').last);
      await tester.pumpAndSettle();
      expect(gen.selectedTag, 'Anime');
    });
  });

  group('P12 — social link usability', () {
    test('empty and placeholder links are unusable', () {
      expect(isUsableSocialLink(''), isFalse);
      expect(isUsableSocialLink('https://wa.me/'), isFalse);
      expect(isUsableSocialLink('https://flowstudio.chat/'), isFalse);
      expect(isUsableSocialLink('https://flowstudio.support/'), isFalse);
    });

    test('a wa.me handle is not a valid target', () {
      expect(isUsableSocialLink('https://wa.me/MohdKhan_18?s=t'), isFalse);
    });

    test('real links are usable', () {
      expect(isUsableSocialLink('https://wa.me/919876543210'), isTrue);
      expect(isUsableSocialLink('https://example.com/chat'), isTrue);
      expect(isUsableSocialLink('https://support.example.org/'), isTrue);
    });

    test('garbage is unusable', () {
      expect(isUsableSocialLink('not a url'), isFalse);
      expect(isUsableSocialLink('ftp://example.com/x'), isFalse);
      expect(isUsableSocialLink('https://nodot/path'), isFalse);
    });
  });
}
