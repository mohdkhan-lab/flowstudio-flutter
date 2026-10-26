'use strict';

// v2.33.0 DECISIVE GATE: run the shared parser fixtures against the
// engine parser. The Dart mirror runs the same file in
// test/fs_parser_test.dart — both must pass every fixture before a
// release ships.
// Usage: node test_js/run_prompt_fixtures.js
const fs = require('fs');
const path = require('path');
const { parsePrompts, extractLabel, splitLabelPrefix } = require('../engine/promptParser');

const fixtureFile = path.join(__dirname, '..', 'test', 'fixtures', 'prompt_syntax_fixtures.json');
const { fixtures } = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));

let passed = 0;
let failed = 0;
for (const fx of fixtures) {
  const got = parsePrompts(fx.input);
  const exp = fx.expected;
  const ok = got.length === exp.length &&
    got.every((g, i) => g.label === exp[i].label && g.text === exp[i].text);
  if (ok) {
    passed++;
    console.log(`PASS  ${fx.name} (${exp.length} items)`);
  } else {
    failed++;
    console.log(`FAIL  ${fx.name}`);
    console.log(`  expected: ${JSON.stringify(exp)}`);
    console.log(`  got:      ${JSON.stringify(got)}`);
  }
}

// extractLabel spot checks (the bridge's per-string path).
const labelChecks = [
  ['#00-01 A lighthouse', '#00-01'],
  ['Scene 1: A lighthouse', 'Scene 1'],
  ['PROMPT ID: 001 A lighthouse', 'PROMPT ID: 001'],
  ['1. A lighthouse', '1'],
  ['#stormwatch over the bay', null],
  ['A lighthouse in a storm', null],
  ['3.5 litres of oil', null],
];
for (const [input, exp] of labelChecks) {
  const got = extractLabel(input);
  if (got === exp) {
    passed++;
    console.log(`PASS  extractLabel(${JSON.stringify(input)}) -> ${JSON.stringify(exp)}`);
  } else {
    failed++;
    console.log(`FAIL  extractLabel(${JSON.stringify(input)}) -> got ${JSON.stringify(got)}, want ${JSON.stringify(exp)}`);
  }
}

// v2.34.0 (Problem 5): splitLabelPrefix spot checks — the label
// marker (and its separator) leaves the text on EVERY path that
// submits a prompt: the bridge string path and redo-missing.
const splitChecks = [
  ['#00-01 A lighthouse in a storm', { label: '#00-01', text: 'A lighthouse in a storm' }],
  ['Scene 1: A lighthouse in a storm', { label: 'Scene 1', text: 'A lighthouse in a storm' }],
  ['PROMPT ID: 004: A forest in fog', { label: 'PROMPT ID: 004', text: 'A forest in fog' }],
  ['1. A lighthouse in a storm', { label: '1', text: 'A lighthouse in a storm' }],
  ['(2) A calm valley at dawn', { label: '2', text: 'A calm valley at dawn' }],
  ['Scene 1:\nA lighthouse in a storm', { label: 'Scene 1', text: 'A lighthouse in a storm' }],
  ['PROMPT 1: line one\nline two\nline three', { label: 'PROMPT 1', text: 'line one\nline two\nline three' }],
  ['#00-01 A lighthouse\nScene 9: stays in the body', { label: '#00-01', text: 'A lighthouse\nScene 9: stays in the body' }],
  ['A lighthouse in a storm', { label: null, text: 'A lighthouse in a storm' }],
  ['3.5 litres of oil for the lamp', { label: null, text: '3.5 litres of oil for the lamp' }],
  ['#stormwatch over the bay', { label: null, text: '#stormwatch over the bay' }],
];
for (const [input, exp] of splitChecks) {
  const got = splitLabelPrefix(input);
  if (got.label === exp.label && got.text === exp.text) {
    passed++;
    console.log(`PASS  splitLabelPrefix(${JSON.stringify(input)})`);
  } else {
    failed++;
    console.log(`FAIL  splitLabelPrefix(${JSON.stringify(input)}) -> got ${JSON.stringify(got)}, want ${JSON.stringify(exp)}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed === 0 ? 0 : 1);
