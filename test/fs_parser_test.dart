// v2.33.0 DECISIVE GATE (Dart half): the shared parser fixtures
// must produce EXACTLY the expected items from the Dart parser —
// the same file the engine suite runs (test_js/run_prompt_fixtures.js).
// Also covers the provider wiring (parsed labels land on items, the
// count pill equals the parsed count) and the label -> file-base
// mirror used by the Progress cards.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_flow/models/prompt_item.dart';
import 'package:flutter_flow/providers/generator_provider.dart';
import 'package:flutter_flow/services/prompt_parser.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final fixtureFile =
      File('test/fixtures/prompt_syntax_fixtures.json');
  final decoded = jsonDecode(fixtureFile.readAsStringSync()) as Map;
  final fixtures = (decoded['fixtures'] as List).cast<Map>();

  group('shared parser fixtures (Dart mirror)', () {
    for (final fx in fixtures) {
      test(fx['name'] as String, () {
        final got = PromptParser.parse(fx['input'] as String);
        final exp = (fx['expected'] as List).cast<Map>();
        expect(got.length, exp.length, reason: 'item count');
        for (var i = 0; i < exp.length; i++) {
          expect(got[i].label, exp[i]['label'],
              reason: 'item ${i + 1} label');
          expect(got[i].text, exp[i]['text'], reason: 'item ${i + 1} text');
        }
      });
    }
  });

  group('extractLabel spot checks', () {
    final checks = <String, String?>{
      '#00-01 A lighthouse': '#00-01',
      'Scene 1: A lighthouse': 'Scene 1',
      'PROMPT ID: 001 A lighthouse': 'PROMPT ID: 001',
      '1. A lighthouse': '1',
      '#stormwatch over the bay': null,
      'A lighthouse in a storm': null,
      '3.5 litres of oil': null,
    };
    checks.forEach((input, want) {
      test('extractLabel($input)', () {
        expect(PromptParser.extractLabel(input), want);
      });
    });
  });

  group('labelFileBase mirror (Progress card names)', () {
    final cases = <String, String>{
      '#00-01': '#00-01',
      'Scene 1': 'Scene001',
      'SCENE_001': 'SCENE_001',
      'IMAGE_PROMPT_1': 'IMAGE_PROMPT_001',
      'SHOT-001': 'SHOT-001',
      'PROMPT ID: 001': 'PROMPTID001',
      '1': '001',
      '#1': '#001',
      'Ep11': 'Ep11',
      'Cinematic': 'Cinematic',
    };
    cases.forEach((label, want) {
      test('labelFileBase($label) = $want', () {
        expect(labelFileBase(label), want);
      });
    });
  });

  group('provider wiring', () {
    test('scene-label paste parses to labelled items', () {
      final gen = GeneratorProvider();
      gen.setRawText('Scene 1: A lighthouse in a storm\n'
          'Scene 2: A calm valley at dawn\n'
          'Scene 10: A mountain pass in snow');
      expect(gen.totalPrompts, 3);
      expect(gen.items.map((i) => i.label).toList(),
          ['Scene 1', 'Scene 2', 'Scene 10']);
      expect(gen.items.every((i) => i.status == PromptStatus.pending), isTrue);
    });

    test('owner canonical hash paste keeps working identically', () {
      final gen = GeneratorProvider();
      gen.setRawText('#11-01 Gauri thakur sahab ke kamre me purani tasveer dekhti hai\n\n'
          '#11-02 Malti darwaze par khadi sab sun leti hai');
      expect(gen.totalPrompts, 2);
      expect(gen.items.map((i) => i.label).toList(), ['#11-01', '#11-02']);
    });

    test('agent mode: one prompt, label still detected for naming', () {
      final gen = GeneratorProvider();
      gen.setPromptMode(false);
      gen.setRawText('#00-01 A single long agent prompt\nwith a second line');
      expect(gen.totalPrompts, 1);
      expect(gen.items.single.label, '#00-01');
    });
  });
}
