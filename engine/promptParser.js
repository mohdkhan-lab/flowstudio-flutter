'use strict';

/**
 * FlowStudio Lite — prompt syntax parser (v2.33.0, owner's order).
 *
 * The owner pastes prompts in many shapes; this module is the ONE
 * spec both sides implement (the Dart mirror lives in
 * lib/services/prompt_parser.dart; the shared fixture suite in
 * test/fixtures/prompt_syntax_fixtures.json pins them together):
 *
 *   family 1  number-based     1.  1)  (1)  [1]  #1
 *   family 2  prompt labels    PROMPT 1:  Prompt 01:  PROMPT_001:
 *                              PROMPT ID: 001
 *   family 3  scene/media      Scene 1:  SCENE_001:  IMAGE_PROMPT_1:
 *             labels           VIDEO_PROMPT_1:  SHOT-001:  CLIP-001:
 *   family 4  hash-number      #00-01  #00-05  #01-03  (owner's own)
 *   family 5  separators       blank lines  ---  ###  [START]/[END]
 *   family 6  structured       Markdown headings, XML <prompt>,
 *                              JSON, YAML, CSV (subsets documented
 *                              at each extractor below)
 *
 * An item is { label, text }: `label` is the label AS WRITTEN
 * ("#00-01", "Scene 1", "PROMPT_001", "3") or null; `text` is the
 * prompt exactly as it will be submitted — for line-based formats
 * the label line STAYS in the text (that is what the engine has
 * always submitted and fingerprinted; v2.33.0 changes identity
 * bookkeeping, never the submitted words).
 *
 * Hard rules (2026-10-14 fixture lesson, still in force):
 *   - markers count ONLY at the start of a line;
 *   - a number or # inside a prompt's own text never splits it;
 *   - label families COMPETE: a family must appear on >= 2 lines
 *     to split the paste (a single "Scene 9:" line inside one
 *     hash-tagged prompt's body is content, not a boundary);
 *   - a prompt may span multiple lines under one label.
 */

// ---------------------------------------------------------------------
// Label matchers. Each returns { family, label } or null. `label` is
// the matched text AS WRITTEN (trailing ":" / "." separators are not
// part of any match), except number forms, whose label is the digits.
// ---------------------------------------------------------------------

function matchLabelAtLineStart(line) {
  const s = String(line || '').replace(/^\s+/, '');
  let m;
  // Family 4: owner's hash-number ranges — #00-01, #01-03, #02-45.
  if ((m = s.match(/^#[0-9]{1,4}-[0-9]{1,4}(?=[\s:.\-–—]|$)/))) {
    return { family: 'hash', label: m[0] };
  }
  // Family 2: PROMPT ID: 001 (the colon rides inside the label).
  if ((m = s.match(/^prompt\s*id\s*[:\-]\s*[0-9]+/i))) {
    return { family: 'prompt', label: m[0].trim() };
  }
  // Family 2: PROMPT 1 / Prompt 01 / PROMPT_001.
  if ((m = s.match(/^prompt[\s_]*[0-9]+/i))) {
    return { family: 'prompt', label: m[0].trim() };
  }
  // Family 3: Scene 1 / SCENE_001 / IMAGE_PROMPT_1 / VIDEO_PROMPT_1 /
  // SHOT-001 / CLIP-001.
  if ((m = s.match(/^(?:scene|image[\s_]?prompt|video[\s_]?prompt|shot|clip)[\s_\-]*[0-9]+/i))) {
    return { family: 'scene', label: m[0].trim() };
  }
  // Families 1/4: #1 (a bare hashtag word like #storm is NOT a label —
  // digits are required).
  if ((m = s.match(/^#[0-9]+(?=[\s:.)\]]|$)/))) {
    return { family: 'hashnum', label: m[0] };
  }
  // Family 1: 1. / 1) — a following space is required so "3.5 litres"
  // inside a prompt can never pose as a list marker.
  if ((m = s.match(/^([0-9]+)[.)](?=[\s]|$)/))) {
    return { family: 'number', label: m[1] };
  }
  // Family 1: (1) / [1].
  if ((m = s.match(/^\(([0-9]+)\)(?=[\s:.\-]|$)/)) ||
      (m = s.match(/^\[([0-9]+)\](?=[\s:.\-]|$)/))) {
    return { family: 'number', label: m[1] };
  }
  return null;
}

/**
 * The label of ONE prompt text (its first line only), or null. The
 * bridge uses this for string prompts so a pasted "Scene 1: …" or
 * "PROMPT_001: …" carries its label into the task identity exactly
 * like the app's own parser does — before v2.33.0 only a leading
 * "#" token was recognised there.
 */
function extractLabel(text) {
  if (typeof text !== 'string' || !text) return null;
  const firstLine = text.replace(/\r\n?/g, '\n').split('\n')[0];
  const hit = matchLabelAtLineStart(firstLine);
  return hit ? hit.label : null;
}

function isSeparatorLine(line) {
  const t = String(line || '').trim();
  if (/^(-{3,}|\*{3,}|#{3,}|={3,}|_{3,})$/.test(t)) return true;
  if (/^<!--[\s\S]*-->$/.test(t)) return true;
  if (/^\[\s*(start|begin|end)\b[^\]]*\]$/i.test(t)) return true;
  return false;
}

function matchHeading(line) {
  const m = String(line || '').match(/^\s{0,3}(#{1,6})\s+(.+)$/);
  if (!m) return null;
  // The heading TEXT may itself be a label ("## Scene 1"); otherwise
  // the heading is a section title and contributes no label.
  const inner = matchLabelAtLineStart(m[2]);
  return { label: inner ? inner.label : null };
}

// ---------------------------------------------------------------------
// Structured extractors (family 6). Each returns an item array or
// null when the document is not (or not usefully) that format.
// ---------------------------------------------------------------------

const PROMPT_KEYS = ['prompt', 'text', 'content', 'description'];
const LABEL_KEYS = ['label', 'tag', 'id', 'scene', 'name'];

function keyLookup(obj) {
  const map = new Map();
  for (const k of Object.keys(obj)) map.set(k.toLowerCase(), obj[k]);
  return map;
}

function firstString(map, keys) {
  for (const k of keys) {
    const v = map.get(k);
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function itemsFromJsonValue(value) {
  let arr = null;
  if (Array.isArray(value)) {
    arr = value;
  } else if (value && typeof value === 'object') {
    const map = keyLookup(value);
    for (const k of ['prompts', 'items', 'scenes', 'data']) {
      if (Array.isArray(map.get(k))) { arr = map.get(k); break; }
    }
    if (!arr && firstString(map, PROMPT_KEYS)) arr = [value];
  }
  if (!arr) return null;
  const items = [];
  for (const el of arr) {
    if (typeof el === 'string') {
      const text = el.trim();
      if (text) items.push({ label: null, text });
    } else if (el && typeof el === 'object') {
      const map = keyLookup(el);
      const text = firstString(map, PROMPT_KEYS);
      if (!text) continue;
      items.push({ label: firstString(map, LABEL_KEYS), text });
    }
  }
  return items.length > 0 ? items : null;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function itemsFromXml(t) {
  if (!/<prompt[\s>]/i.test(t)) return null;
  const items = [];
  const re = /<prompt\b([^>]*)>([\s\S]*?)<\/prompt\s*>/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    const attrs = m[1] || '';
    let body = m[2] || '';
    let label = null;
    for (const key of LABEL_KEYS) {
      const am = attrs.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'i')) ||
        attrs.match(new RegExp(`${key}\\s*=\\s*'([^']*)'`, 'i'));
      if (am && am[1].trim()) { label = am[1].trim(); break; }
    }
    const trimmedBody = body.trim();
    const child = trimmedBody.match(/^<(label|tag|id|scene)>([\s\S]*?)<\/\1>/i);
    if (child) {
      if (!label && child[2].trim()) label = child[2].trim();
      body = trimmedBody.slice(child[0].length);
    }
    body = body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    body = body.replace(/<[^>]+>/g, '');
    const text = decodeEntities(body).trim();
    if (text) items.push({ label, text });
  }
  return items.length > 0 ? items : null;
}

// One CSV line (RFC4180-ish: quoted fields, "" escapes, commas).
// Multi-line quoted cells are outside the supported subset.
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

function itemsFromCsv(t) {
  const lines = t.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return null;
  const rows = lines.map(parseCsvLine);
  const counts = new Set(rows.map(r => r.length));
  if (counts.size !== 1) return null;
  const header = rows[0].map(c => c.trim().toLowerCase());
  const promptIdx = header.findIndex(c => PROMPT_KEYS.includes(c));
  if (promptIdx >= 0) {
    const labelIdx = header.findIndex(c => LABEL_KEYS.includes(c));
    const items = [];
    for (const row of rows.slice(1)) {
      const text = (row[promptIdx] || '').trim();
      if (!text) continue;
      const label = labelIdx >= 0 ? ((row[labelIdx] || '').trim() || null) : null;
      items.push({ label, text });
    }
    return items.length > 0 ? items : null;
  }
  // Headerless single-column CSV is claimed ONLY when every row is
  // a quoted value — an unquoted one-per-line paste is plain text
  // for the line parser, never a CSV (that distinction is the whole
  // point of the quote rule; without it every multi-line paste
  // would be "CSV").
  if (rows[0].length === 1 && lines.every(l => l.startsWith('"'))) {
    const items = rows
      .map(r => ({ label: null, text: (r[0] || '').trim() }))
      .filter(i => i.text);
    return items.length > 0 ? items : null;
  }
  return null;
}

function itemsFromYaml(t) {
  const lines = t.split('\n');
  const isDash = (l) => /^-\s+/.test(l);
  const dashCount = lines.filter(isDash).length;
  const firstNonEmpty = lines.find(l => l.trim().length > 0) || '';
  if (dashCount < 2 || !isDash(firstNonEmpty)) return null;

  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (isDash(line)) {
      current = [line.replace(/^-\s+/, '')];
      blocks.push(current);
    } else if (current) {
      current.push(line);
    }
  }

  const kvRe = /^\s*([A-Za-z_][\w -]*)\s*:\s*(.*)$/;
  const keyOf = (line) => {
    const kv = line.match(kvRe);
    return kv ? { key: kv[1].trim().toLowerCase(), value: kv[2] } : null;
  };
  const items = [];
  for (const block of blocks) {
    // A block is a MAP when any line carries a known label/prompt
    // key; otherwise every line is plain prompt text (a colon inside
    // ordinary prose must survive untouched).
    const isMap = block.some(line => {
      const kv = keyOf(line);
      return kv && (LABEL_KEYS.includes(kv.key) || PROMPT_KEYS.includes(kv.key));
    });
    if (!isMap) {
      let text = block.join('\n').trim();
      if ((text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
          (text.startsWith("'") && text.endsWith("'") && text.length >= 2)) {
        text = text.slice(1, -1).trim();
      }
      if (text) items.push({ label: null, text });
      continue;
    }
    let label = null;
    let promptText = null;
    const continuations = [];
    for (const line of block) {
      const kv = keyOf(line);
      if (kv && LABEL_KEYS.includes(kv.key)) {
        if (!label && kv.value.trim()) label = kv.value.trim();
        continue; // a label line never rides into the prompt text
      }
      if (kv && PROMPT_KEYS.includes(kv.key) && promptText === null) {
        promptText = kv.value.trim();
        continue;
      }
      if (kv) continue; // other keys are metadata, not prompt text
      continuations.push(line);
    }
    const text = [promptText, ...continuations]
      .filter(s => s !== null && s !== undefined)
      .join('\n')
      .trim();
    if (text) items.push({ label, text });
  }
  return items.length > 0 ? items : null;
}

// ---------------------------------------------------------------------
// Line-based parsing (families 1–5).
// ---------------------------------------------------------------------

function blocksOf(t) {
  return t
    .split(/\n[ \t]*\n/)
    .map(b => b.trim())
    .filter(b => b.length > 0);
}

function parseLineBased(t) {
  const lines = t.split('\n');
  const classified = lines.map(line => {
    if (isSeparatorLine(line)) return { kind: 'separator' };
    const heading = matchHeading(line);
    if (heading) return { kind: 'heading', label: heading.label };
    const hit = matchLabelAtLineStart(line);
    if (hit) return { kind: 'label', family: hit.family, label: hit.label };
    return { kind: 'text' };
  });

  const familyCounts = {};
  let headingCount = 0;
  let separatorCount = 0;
  for (const c of classified) {
    if (c.kind === 'label') familyCounts[c.family] = (familyCounts[c.family] || 0) + 1;
    else if (c.kind === 'heading') headingCount++;
    else if (c.kind === 'separator') separatorCount++;
  }
  const activeFamilies = new Set(
    Object.keys(familyCounts).filter(f => familyCounts[f] >= 2)
  );
  const headingsActive = headingCount >= 2;

  if (activeFamilies.size > 0 || headingsActive) {
    const segments = [];
    let current = null;
    const openSegment = (label) => {
      current = { label: label || null, lines: [] };
      segments.push(current);
    };
    lines.forEach((line, i) => {
      const c = classified[i];
      if (c.kind === 'separator') {
        current = null; // separator lines are structure, never text
        return;
      }
      if (c.kind === 'heading' && headingsActive) {
        openSegment(c.label); // heading line is consumed as structure
        return;
      }
      if (c.kind === 'label' && activeFamilies.has(c.family)) {
        openSegment(c.label);
        current.lines.push(line); // the label line stays in the text
        return;
      }
      if (!current) openSegment(null);
      current.lines.push(line);
    });
    const items = [];
    for (const seg of segments) {
      const text = seg.lines.join('\n').trim();
      if (!text) continue;
      items.push({ label: seg.label !== null ? seg.label : extractLabel(text), text });
    }
    return items;
  }

  if (separatorCount > 0) {
    // Separators act as extra blank lines; blocks then split as usual.
    const joined = lines
      .map((line, i) => (classified[i].kind === 'separator' ? '' : line))
      .join('\n');
    return blocksOf(joined).map(b => ({ label: extractLabel(b), text: b }));
  }

  return blocksOf(t).map(b => ({ label: extractLabel(b), text: b }));
}

/**
 * Parse a pasted prompt document into items. Structured formats are
 * recognised whole-document first (JSON -> XML -> CSV -> YAML), then
 * the line-based families run.
 */
function parsePrompts(raw) {
  if (typeof raw !== 'string') return [];
  const t = raw.replace(/\r\n?/g, '\n').trim();
  if (!t) return [];

  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const items = itemsFromJsonValue(JSON.parse(t));
      if (items) return items;
    } catch (e) { /* not JSON after all — fall through */ }
  }
  const xml = itemsFromXml(t);
  if (xml) return xml;
  const csv = itemsFromCsv(t);
  if (csv) return csv;
  const yaml = itemsFromYaml(t);
  if (yaml) return yaml;
  return parseLineBased(t);
}

module.exports = { parsePrompts, extractLabel, matchLabelAtLineStart };
