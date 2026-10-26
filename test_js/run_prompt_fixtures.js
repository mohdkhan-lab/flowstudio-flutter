'use strict';

// v2.33.0 DECISIVE GATE: run the shared parser fixtures against the
// engine parser. The Dart mirror runs the same file in
// test/fs_parser_test.dart — both must pass every fixture before a
// release ships.
// Usage: node test_js/run_prompt_fixtures.js
const fs = require('fs');
const path = require('path');
const { parsePrompts, extractLabel } = require('../engine/promptParser');

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

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed === 0 ? 0 : 1);
