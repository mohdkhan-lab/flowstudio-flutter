import 'dart:convert';

// FlowStudio Lite — prompt syntax parser (v2.33.0, owner's order).
// Dart mirror of engine/promptParser.js — the two implementations
// are ONE spec, pinned together by the shared fixture suite in
// test/fixtures/prompt_syntax_fixtures.json (run by
// test/fs_parser_test.dart here and test_js/run_prompt_fixtures.js
// on the engine side; both must pass every fixture).
//
// Families: (1) number-based 1. / 1) / (1) / [1] / #1 - (2) prompt
// labels PROMPT 1: / Prompt 01: / PROMPT_001: / PROMPT ID: 001 -
// (3) scene/media labels Scene 1: / SCENE_001: / IMAGE_PROMPT_1: /
// VIDEO_PROMPT_1: / SHOT-001: / CLIP-001: - (4) the owner's
// hash-number ranges #00-01 - (5) separators: blank lines, ---,
// ###, [START]/[END] markers - (6) structured: Markdown headings,
// XML <prompt>, JSON, YAML, CSV (subsets documented per extractor).
//
// An item is {label, text}: label is AS WRITTEN or null; text is
// the prompt exactly as it will be submitted — for line-based
// formats the label line STAYS in the text (the engine has always
// submitted and fingerprinted it that way; v2.33.0 changes identity
// bookkeeping, never the submitted words).
//
// Hard rules (2026-10-14 fixture lesson): markers count ONLY at
// the start of a line; a number or # inside a prompt's own text
// never splits it; label families COMPETE (a family needs >= 2
// boundary lines to split the paste); a prompt may span multiple
// lines under one label.

class ParsedPrompt {
  final String? label;
  final String text;
  const ParsedPrompt(this.label, this.text);
}

class LabelHit {
  final String family;
  final String label;
  const LabelHit(this.family, this.label);
}

class PromptParser {
  static final _hashRangeRe =
      RegExp(r'^#[0-9]{1,4}-[0-9]{1,4}(?=[\s:.\-–—]|$)');
  static final _promptIdRe =
      RegExp(r'^prompt\s*id\s*[:\-]\s*[0-9]+', caseSensitive: false);
  static final _promptNumRe =
      RegExp(r'^prompt[\s_]*[0-9]+', caseSensitive: false);
  static final _sceneRe = RegExp(
      r'^(?:scene|image[\s_]?prompt|video[\s_]?prompt|shot|clip)[\s_\-]*[0-9]+',
      caseSensitive: false);
  static final _hashNumRe = RegExp(r'^#[0-9]+(?=[\s:.)\]]|$)');
  static final _numberDotRe = RegExp(r'^([0-9]+)[.)](?=[\s]|$)');
  static final _numberParenRe = RegExp(r'^\(([0-9]+)\)(?=[\s:.\-]|$)');
  static final _numberBracketRe = RegExp(r'^\[([0-9]+)\](?=[\s:.\-]|$)');
  static final _separatorRe = RegExp(r'^(-{3,}|\*{3,}|#{3,}|={3,}|_{3,})$');
  static final _commentRe = RegExp(r'^<!--[\s\S]*-->$');
  static final _markerRe =
      RegExp(r'^\[\s*(start|begin|end)\b[^\]]*\]$', caseSensitive: false);
  static final _headingRe = RegExp(r'^\s{0,3}(#{1,6})\s+(.+)$');
  static final _leadingWsRe = RegExp(r'^\s+');
  static final _crlfRe = RegExp(r'\r\n?');

  static const _promptKeys = ['prompt', 'text', 'content', 'description'];
  static const _labelKeys = ['label', 'tag', 'id', 'scene', 'name'];

  /// Label match at the start of one line, or null.
  static LabelHit? matchLabelAtLineStart(String line) {
    final s = line.replaceFirst(_leadingWsRe, '');
    RegExpMatch? m;
    if ((m = _hashRangeRe.firstMatch(s)) != null) {
      return LabelHit('hash', m!.group(0)!);
    }
    if ((m = _promptIdRe.firstMatch(s)) != null) {
      return LabelHit('prompt', m!.group(0)!.trim());
    }
    if ((m = _promptNumRe.firstMatch(s)) != null) {
      return LabelHit('prompt', m!.group(0)!.trim());
    }
    if ((m = _sceneRe.firstMatch(s)) != null) {
      return LabelHit('scene', m!.group(0)!.trim());
    }
    if ((m = _hashNumRe.firstMatch(s)) != null) {
      return LabelHit('hashnum', m!.group(0)!);
    }
    if ((m = _numberDotRe.firstMatch(s)) != null) {
      return LabelHit('number', m!.group(1)!);
    }
    if ((m = _numberParenRe.firstMatch(s)) != null) {
      return LabelHit('number', m!.group(1)!);
    }
    if ((m = _numberBracketRe.firstMatch(s)) != null) {
      return LabelHit('number', m!.group(1)!);
    }
    return null;
  }

  /// The label of ONE prompt text (first line only), or null.
  static String? extractLabel(String text) {
    if (text.isEmpty) return null;
    final firstLine = text.replaceAll(_crlfRe, '\n').split('\n').first;
    return matchLabelAtLineStart(firstLine)?.label;
  }

  static bool isSeparatorLine(String line) {
    final t = line.trim();
    if (_separatorRe.hasMatch(t)) return true;
    if (_commentRe.hasMatch(t)) return true;
    if (_markerRe.hasMatch(t)) return true;
    return false;
  }

  /// Heading line -> its label (null label when the heading is a
  /// plain section title); isHeading false when not a heading.
  static ({bool isHeading, String? label}) matchHeading(String line) {
    final m = _headingRe.firstMatch(line);
    if (m == null) return (isHeading: false, label: null);
    final inner = matchLabelAtLineStart(m.group(2)!);
    return (isHeading: true, label: inner?.label);
  }

  // ---------------- structured extractors (family 6) ----------------

  static String? _firstString(
      Map<String, dynamic> lowered, List<String> keys) {
    for (final k in keys) {
      final v = lowered[k];
      if (v is String && v.trim().isNotEmpty) return v.trim();
      if (v is num && v.isFinite) return v.toString();
    }
    return null;
  }

  static Map<String, dynamic> _lowerKeys(Map<dynamic, dynamic> obj) {
    final out = <String, dynamic>{};
    obj.forEach((k, v) => out[k.toString().toLowerCase()] = v);
    return out;
  }

  static List<ParsedPrompt>? _itemsFromJsonValue(dynamic value) {
    List<dynamic>? arr;
    if (value is List) {
      arr = value;
    } else if (value is Map) {
      final map = _lowerKeys(value);
      for (final k in ['prompts', 'items', 'scenes', 'data']) {
        if (map[k] is List) {
          arr = map[k] as List;
          break;
        }
      }
      if (arr == null && _firstString(map, _promptKeys) != null) {
        arr = [value];
      }
    }
    if (arr == null) return null;
    final items = <ParsedPrompt>[];
    for (final el in arr) {
      if (el is String) {
        final text = el.trim();
        if (text.isNotEmpty) items.add(ParsedPrompt(null, text));
      } else if (el is Map) {
        final map = _lowerKeys(el);
        final text = _firstString(map, _promptKeys);
        if (text == null) continue;
        items.add(ParsedPrompt(_firstString(map, _labelKeys), text));
      }
    }
    return items.isNotEmpty ? items : null;
  }

  static String _decodeEntities(String s) {
    return s
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&#39;', "'")
        .replaceAll('&amp;', '&');
  }

  static List<ParsedPrompt>? _itemsFromXml(String t) {
    if (!RegExp(r'<prompt[\s>]', caseSensitive: false).hasMatch(t)) {
      return null;
    }
    final items = <ParsedPrompt>[];
    final re = RegExp(r'<prompt\b([^>]*)>([\s\S]*?)</prompt\s*>',
        caseSensitive: false);
    for (final m in re.allMatches(t)) {
      final attrs = m.group(1) ?? '';
      var body = m.group(2) ?? '';
      String? label;
      for (final key in _labelKeys) {
        final am = RegExp('$key\\s*=\\s*"([^"]*)"', caseSensitive: false)
                .firstMatch(attrs) ??
            RegExp("$key\\s*=\\s*'([^']*)'", caseSensitive: false)
                .firstMatch(attrs);
        if (am != null && am.group(1)!.trim().isNotEmpty) {
          label = am.group(1)!.trim();
          break;
        }
      }
      final trimmedBody = body.trim();
      final child = RegExp(r'^<(label|tag|id|scene)>([\s\S]*?)</\1>',
              caseSensitive: false)
          .firstMatch(trimmedBody);
      if (child != null) {
        if (label == null && child.group(2)!.trim().isNotEmpty) {
          label = child.group(2)!.trim();
        }
        body = trimmedBody.substring(child.group(0)!.length);
      }
      body = body.replaceAllMapped(
          RegExp(r'<!\[CDATA\[([\s\S]*?)\]\]>'), (mm) => mm.group(1)!);
      body = body.replaceAll(RegExp(r'<[^>]+>'), '');
      final text = _decodeEntities(body).trim();
      if (text.isNotEmpty) items.add(ParsedPrompt(label, text));
    }
    return items.isNotEmpty ? items : null;
  }

  static List<String> _parseCsvLine(String line) {
    final cells = <String>[];
    var cur = StringBuffer();
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      final ch = line[i];
      if (inQuotes) {
        if (ch == '"') {
          if (i + 1 < line.length && line[i + 1] == '"') {
            cur.write('"');
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur.write(ch);
        }
      } else if (ch == '"') {
        inQuotes = true;
      } else if (ch == ',') {
        cells.add(cur.toString());
        cur = StringBuffer();
      } else {
        cur.write(ch);
      }
    }
    cells.add(cur.toString());
    return cells;
  }

  static List<ParsedPrompt>? _itemsFromCsv(String t) {
    final lines = t
        .split('\n')
        .map((l) => l.trim())
        .where((l) => l.isNotEmpty)
        .toList();
    if (lines.length < 2) return null;
    final rows = lines.map(_parseCsvLine).toList();
    final counts = rows.map((r) => r.length).toSet();
    if (counts.length != 1) return null;
    final header = rows[0].map((c) => c.trim().toLowerCase()).toList();
    final promptIdx = header.indexWhere((c) => _promptKeys.contains(c));
    if (promptIdx >= 0) {
      final labelIdx = header.indexWhere((c) => _labelKeys.contains(c));
      final items = <ParsedPrompt>[];
      for (final row in rows.skip(1)) {
        final text = row[promptIdx].trim();
        if (text.isEmpty) continue;
        String? label;
        if (labelIdx >= 0 && row[labelIdx].trim().isNotEmpty) {
          label = row[labelIdx].trim();
        }
        items.add(ParsedPrompt(label, text));
      }
      return items.isNotEmpty ? items : null;
    }
    // Headerless single-column CSV only when every row is quoted —
    // an unquoted one-per-line paste is plain text, never a CSV.
    if (rows[0].length == 1 && lines.every((l) => l.startsWith('"'))) {
      final items = rows
          .map((r) => ParsedPrompt(null, r[0].trim()))
          .where((i) => i.text.isNotEmpty)
          .toList();
      return items.isNotEmpty ? items : null;
    }
    return null;
  }

  static List<ParsedPrompt>? _itemsFromYaml(String t) {
    final lines = t.split('\n');
    bool isDash(String l) => RegExp(r'^-\s+').hasMatch(l);
    final dashCount = lines.where(isDash).length;
    final firstNonEmpty =
        lines.firstWhere((l) => l.trim().isNotEmpty, orElse: () => '');
    if (dashCount < 2 || !isDash(firstNonEmpty)) return null;

    final blocks = <List<String>>[];
    List<String>? current;
    for (final line in lines) {
      if (isDash(line)) {
        current = [line.replaceFirst(RegExp(r'^-\s+'), '')];
        blocks.add(current);
      } else if (current != null) {
        current.add(line);
      }
    }

    final kvRe = RegExp(r'^\s*([A-Za-z_][\w -]*)\s*:\s*(.*)$');
    ({String key, String value})? keyOf(String line) {
      final kv = kvRe.firstMatch(line);
      if (kv == null) return null;
      return (key: kv.group(1)!.trim().toLowerCase(), value: kv.group(2)!);
    }

    final items = <ParsedPrompt>[];
    for (final block in blocks) {
      final isMap = block.any((line) {
        final kv = keyOf(line);
        return kv != null &&
            (_labelKeys.contains(kv.key) || _promptKeys.contains(kv.key));
      });
      if (!isMap) {
        var text = block.join('\n').trim();
        if ((text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
            (text.startsWith("'") && text.endsWith("'") && text.length >= 2)) {
          text = text.substring(1, text.length - 1).trim();
        }
        if (text.isNotEmpty) items.add(ParsedPrompt(null, text));
        continue;
      }
      String? label;
      String? promptText;
      final continuations = <String>[];
      for (final line in block) {
        final kv = keyOf(line);
        if (kv != null && _labelKeys.contains(kv.key)) {
          if (label == null && kv.value.trim().isNotEmpty) {
            label = kv.value.trim();
          }
          continue;
        }
        if (kv != null && _promptKeys.contains(kv.key) && promptText == null) {
          promptText = kv.value.trim();
          continue;
        }
        if (kv != null) continue;
        continuations.add(line);
      }
      final text = [promptText, ...continuations]
          .where((s) => s != null)
          .join('\n')
          .trim();
      if (text.isNotEmpty) items.add(ParsedPrompt(label, text));
    }
    return items.isNotEmpty ? items : null;
  }

  // ---------------- line-based parsing (families 1-5) ----------------

  static List<String> _blocksOf(String t) {
    return t
        .split(RegExp(r'\n[ \t]*\n'))
        .map((b) => b.trim())
        .where((b) => b.isNotEmpty)
        .toList();
  }

  static List<ParsedPrompt> _parseLineBased(String t) {
    final lines = t.split('\n');
    final kinds = <String>[];
    final lineLabels = <String?>[];
    final lineFamilies = <String?>[];
    for (final line in lines) {
      if (isSeparatorLine(line)) {
        kinds.add('separator');
        lineLabels.add(null);
        lineFamilies.add(null);
        continue;
      }
      final heading = matchHeading(line);
      if (heading.isHeading) {
        kinds.add('heading');
        lineLabels.add(heading.label);
        lineFamilies.add(null);
        continue;
      }
      final hit = matchLabelAtLineStart(line);
      if (hit != null) {
        kinds.add('label');
        lineLabels.add(hit.label);
        lineFamilies.add(hit.family);
      } else {
        kinds.add('text');
        lineLabels.add(null);
        lineFamilies.add(null);
      }
    }

    final familyCounts = <String, int>{};
    var headingCount = 0;
    var separatorCount = 0;
    for (var i = 0; i < kinds.length; i++) {
      if (kinds[i] == 'label') {
        final f = lineFamilies[i]!;
        familyCounts[f] = (familyCounts[f] ?? 0) + 1;
      } else if (kinds[i] == 'heading') {
        headingCount++;
      } else if (kinds[i] == 'separator') {
        separatorCount++;
      }
    }
    final activeFamilies = <String>{
      for (final e in familyCounts.entries)
        if (e.value >= 2) e.key,
    };
    final headingsActive = headingCount >= 2;

    if (activeFamilies.isNotEmpty || headingsActive) {
      final segments = <({String? label, List<String> lines})>[];
      ({String? label, List<String> lines})? current;
      void openSegment(String? label) {
        current = (label: label, lines: <String>[]);
        segments.add(current!);
      }

      for (var i = 0; i < lines.length; i++) {
        final kind = kinds[i];
        if (kind == 'separator') {
          current = null;
          continue;
        }
        if (kind == 'heading' && headingsActive) {
          openSegment(lineLabels[i]);
          continue;
        }
        if (kind == 'label' && activeFamilies.contains(lineFamilies[i])) {
          openSegment(lineLabels[i]);
          current!.lines.add(lines[i]);
          continue;
        }
        if (current == null) openSegment(null);
        current!.lines.add(lines[i]);
      }
      final items = <ParsedPrompt>[];
      for (final seg in segments) {
        final text = seg.lines.join('\n').trim();
        if (text.isEmpty) continue;
        items.add(ParsedPrompt(seg.label ?? extractLabel(text), text));
      }
      return items;
    }

    if (separatorCount > 0) {
      final joined = [
        for (var i = 0; i < lines.length; i++)
          kinds[i] == 'separator' ? '' : lines[i],
      ].join('\n');
      return _blocksOf(joined)
          .map((b) => ParsedPrompt(extractLabel(b), b))
          .toList();
    }

    return _blocksOf(t).map((b) => ParsedPrompt(extractLabel(b), b)).toList();
  }

  /// Parse a pasted prompt document into items. Structured formats
  /// are recognised whole-document first (JSON -> XML -> CSV ->
  /// YAML), then the line-based families run.
  static List<ParsedPrompt> parse(String raw) {
    final t = raw.replaceAll(_crlfRe, '\n').trim();
    if (t.isEmpty) return const [];

    if (t.startsWith('[') || t.startsWith('{')) {
      try {
        final items = _itemsFromJsonValue(jsonDecode(t));
        if (items != null) return items;
      } catch (_) {
        // Not JSON after all — fall through.
      }
    }
    final xml = _itemsFromXml(t);
    if (xml != null) return xml;
    final csv = _itemsFromCsv(t);
    if (csv != null) return csv;
    final yaml = _itemsFromYaml(t);
    if (yaml != null) return yaml;
    return _parseLineBased(t);
  }
}

/// The v2.33.0 file-name base for a prompt label — a Dart mirror of
/// engine/tagNaming.js (sanitizeTagBase + padNumericTail), used ONLY
/// for the Progress card's predicted name; the engine's real name
/// replaces it when the video completes. Kept faithful so the card
/// never promises a name the engine will not use.
String labelFileBase(String label) {
  final trimmed = label.trim();
  if (trimmed.isEmpty) return '';
  final lead = trimmed.startsWith('#') ? '#' : '';
  final buf = StringBuffer();
  for (final unit in trimmed.codeUnits) {
    if (unit < 0x20) continue; // control characters
    final ch = String.fromCharCode(unit);
    if (ch == '#') continue;
    if ('<>:"/\\|?*'.contains(ch)) continue;
    if (ch.trim().isEmpty) continue; // all whitespace is dropped
    buf.write(ch);
  }
  var s = buf.toString();
  s = s.replaceAll(RegExp(r'^\.+'), '').replaceAll(RegExp(r'\.+$'), '');
  if (s.isEmpty) return '';
  return _padNumericTail(lead + s);
}

const _numericLabelStems = {
  'scene',
  'shot',
  'clip',
  'prompt',
  'imageprompt',
  'videoprompt',
  'image',
  'video',
};

String _padNumericTail(String base) {
  var m = RegExp(r'^#([0-9]+)$').firstMatch(base);
  if (m != null) return '#${m.group(1)!.padLeft(3, '0')}';
  m = RegExp(r'^([0-9]+)$').firstMatch(base);
  if (m != null) return m.group(1)!.padLeft(3, '0');
  m = RegExp(r'^([A-Za-z]+)([0-9]+)$').firstMatch(base);
  if (m != null && _numericLabelStems.contains(m.group(1)!.toLowerCase())) {
    return m.group(1)! + m.group(2)!.padLeft(3, '0');
  }
  m = RegExp(r'^([A-Za-z_]+?)([0-9]+)$').firstMatch(base);
  if (m != null &&
      _numericLabelStems.contains(m.group(1)!.replaceAll('_', '').toLowerCase())) {
    return m.group(1)! + m.group(2)!.padLeft(3, '0');
  }
  return base;
}
