'use strict';

// v2.33.0 naming + project tests (Problems 3 & 4):
//  - label -> file name per family (via the REAL engine naming:
//    tagNaming.fileNameForTag + FlowAutomationEngine._fileNameForTask)
//  - v2.32.1 protections: shared-tag numbering, collision suffix,
//    same-task retry keeps its own name, foreign file never reused
//  - sequence report: expected vs on-disk, exact missing identities
//  - planRedo: pending (download-failed) vs recreate (gen-failed)
//  - project folder sanitising
// Usage: node test_js/run_naming_project_tests.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const tagNaming = require('../engine/tagNaming');
const { buildSequenceReport, planRedo } = require('../engine/sequenceReport');
const { sanitizeProjectName, projectFolderFor } = require('../engine/projectFolder');
const { FlowAutomationEngine } = require('../engine/flowAutomation');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ---------- Problem 3: label -> file name per family ----------
const nameCases = [
  ['#00-01', '#00-01.mp4'],        // owner's hash range: literal
  ['#00-05', '#00-05.mp4'],
  ['#02-45', '#02-45.mp4'],
  ['Scene 1', 'Scene001.mp4'],     // scene labels: sanitised + padded
  ['SCENE_001', 'SCENE_001.mp4'],
  ['SCENE_002', 'SCENE_002.mp4'],
  ['IMAGE_PROMPT_1', 'IMAGE_PROMPT_001.mp4'],
  ['VIDEO_PROMPT_4', 'VIDEO_PROMPT_004.mp4'],
  ['SHOT-001', 'SHOT-001.mp4'],    // dash forms stay literal
  ['CLIP-006', 'CLIP-006.mp4'],
  ['PROMPT 1', 'PROMPT001.mp4'],   // prompt labels
  ['Prompt 01', 'Prompt001.mp4'],
  ['PROMPT_001', 'PROMPT_001.mp4'],
  ['PROMPT ID: 001', 'PROMPTID001.mp4'],
  ['1', '001.mp4'],                // number-based: padded slot
  ['3', '003.mp4'],
  ['12', '012.mp4'],
  ['#1', '#001.mp4'],              // bare hash number: padded
  ['#12', '#012.mp4'],
  ['scene3', 'scene003.mp4'],      // legacy tag style, padded per Problem 4
  ['Ep11', 'Ep11.mp4'],            // non-label stem: literal (unchanged)
  ['Cinematic', 'Cinematic.mp4'],  // no number: literal
  ['diag5', 'diag5.mp4'],          // v2.32.1 shared run tag: literal
];
for (const [tag, want] of nameCases) {
  eq(`fileNameForTag(${JSON.stringify(tag)})`, tagNaming.fileNameForTag(tag), want);
}

// _fileNameForTask: shared-tag numbering (v2.32.1) must be unchanged.
const engine = Object.create(FlowAutomationEngine.prototype);
engine.savedPathOwners = new Map();
engine.savedThisSession = new Set();
const tagSettings = { namingPattern: 'tag', type: 'Video', tagNameGroups: { 'diag5.mp4': 5 } };
eq('shared tag, prompt 1', engine._fileNameForTask({ tag: 'diag5', promptIndex: 0 }, tagSettings), 'diag5-1.mp4');
eq('shared tag, prompt 5', engine._fileNameForTask({ tag: 'diag5', promptIndex: 4 }, tagSettings), 'diag5-5.mp4');
const singleSettings = { namingPattern: 'tag', type: 'Video', tagNameGroups: { '#00-01.mp4': 1 } };
eq('single hash tag unnumbered', engine._fileNameForTask({ tag: '#00-01', promptIndex: 0 }, singleSettings), '#00-01.mp4');
eq('scene label via engine', engine._fileNameForTask({ tag: 'Scene 2', promptIndex: 1 }, { namingPattern: 'tag', type: 'Video' }), 'Scene002.mp4');
eq('untagged falls back to scene pattern', engine._fileNameForTask({ tag: '', promptIndex: 2 }, { namingPattern: 'tag', type: 'Video' }), 'scene003.mp4');

// ---------- v2.32.1 protections on a real temp folder ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-naming-'));
try {
  // A foreign pre-existing file with the same name -> suffix, never reuse.
  fs.writeFileSync(path.join(dir, 'Scene001.mp4'), 'foreign');
  const taskA = { id: 'task-a', tag: 'Scene 1', promptIndex: 0 };
  const pA = engine._resolveSavePath(dir, 'Scene001.mp4', { namingPattern: 'tag' }, taskA);
  eq('collision with foreign file -> -2', path.basename(pA), 'Scene001-2.mp4');
  fs.writeFileSync(pA, 'mine');
  engine._recordSavedPath(taskA, pA);
  // The same task retrying returns to ITS OWN name.
  const pA2 = engine._resolveSavePath(dir, 'Scene001.mp4', { namingPattern: 'tag' }, taskA);
  eq('same-task retry keeps its own name', pA2, pA);
  // A different task with the same label never gets task A's file.
  const taskB = { id: 'task-b', tag: 'Scene 1', promptIndex: 1 };
  const pB = engine._resolveSavePath(dir, 'Scene001.mp4', { namingPattern: 'tag' }, taskB);
  check('sibling task gets a distinct name', pB !== pA && path.basename(pB) === 'Scene001-3.mp4', `got ${pB}`);
  check('foreign file untouched', fs.readFileSync(path.join(dir, 'Scene001.mp4'), 'utf8') === 'foreign');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- Problem 4: project folder sanitising ----------
eq('project: plain name kept', sanitizeProjectName('My Short Film'), 'My Short Film');
eq('project: separators stripped', sanitizeProjectName('a/b\\c:d'), 'abcd');
eq('project: dotdot refused', sanitizeProjectName('..'), '');
eq('project: blank -> none', sanitizeProjectName('   '), '');
eq('project: non-string -> none', sanitizeProjectName(undefined), '');
eq('project folder joins under base', projectFolderFor(path.join('C:', 'Videos'), 'My Film'), path.join('C:', 'Videos', 'My Film'));
eq('project folder unset = base', projectFolderFor(path.join('C:', 'Videos'), ''), path.join('C:', 'Videos'));

// A run with a project name writes ONLY into the project subfolder:
// resolve save paths against the project folder and check placement.
const projBase = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-proj-'));
try {
  const projDir = projectFolderFor(projBase, 'Episode Pack');
  fs.mkdirSync(projDir, { recursive: true });
  const p = engine._resolveSavePath(projDir, engine._fileNameForTask({ tag: '#00-01', promptIndex: 0 }, { namingPattern: 'tag', type: 'Video' }), { namingPattern: 'tag' }, { tag: '#00-01', promptIndex: 0 });
  eq('save path lands in the project subfolder', p, path.join(projDir, '#00-01.mp4'));
  fs.writeFileSync(p, 'video');
  check('nothing written to the base folder', fs.readdirSync(projBase).filter(f => f.endsWith('.mp4')).length === 0);
} finally {
  fs.rmSync(projBase, { recursive: true, force: true });
}

// ---------- Problem 4: missing computation + redo plan ----------
const diskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-seq-'));
try {
  const f1 = path.join(diskDir, '#00-01.mp4');
  const f3 = path.join(diskDir, '#00-03.mp4');
  fs.writeFileSync(f1, 'v1');
  fs.writeFileSync(f3, 'v3');
  const rows = [
    { id: 't1', prompt_index: 0, prompt_tag: '#00-01', prompt_text: '#00-01 one', status: 'completed', file_path: f1 },
    { id: 't2', prompt_index: 1, prompt_tag: '#00-02', prompt_text: '#00-02 two', status: 'pending', needs_check: 1, file_path: '' },
    { id: 't3', prompt_index: 2, prompt_tag: '#00-03', prompt_text: '#00-03 three', status: 'completed', file_path: f3 },
    { id: 't4', prompt_index: 3, prompt_tag: '#00-04', prompt_text: '#00-04 four', status: 'failed', error_reason: 'boom', file_path: '' },
    { id: 't5', prompt_index: 4, prompt_tag: '#00-05', prompt_text: '#00-05 five', status: 'completed', file_path: path.join(diskDir, '#00-05.mp4') }, // file gone
  ];
  const report = buildSequenceReport(rows, { exists: (p) => fs.existsSync(p), namingMode: 'tag' });
  eq('report total', report.total, 5);
  eq('report present', report.presentCount, 2);
  eq('report missing identities, in order', report.missing.map(m => m.tag).join(','), '#00-02,#00-04,#00-05');
  check('report not complete', report.complete === false);

  const plan = planRedo(rows, report);
  eq('redo: download-failed stays an existing task (no re-charge)', plan.existingTaskIds.join(','), 't2');
  eq('redo: gen-failed + file-gone are recreated', plan.recreateItems.map(i => i.tag).join(','), '#00-04,#00-05');
  eq('redo: recreated item keeps original index', plan.recreateItems[0].index, 3);
  // v2.34.0 (Problem 5): the rows above simulate PRE-v2.34.0 stored
  // tasks — their prompt_text still carries the label ("#00-05
  // five"). A redo SUBMITS the text again, so the recreated item
  // must carry the CLEAN text ("five"); the label survives only as
  // the tag. (In v2.33.0 this expectation was the raw stored text.)
  eq('redo: recreated item text is label-free', plan.recreateItems[1].text, 'five');
  eq('redo: recreated item 1 text is label-free', plan.recreateItems[0].text, 'four');

  // A legacy row whose tag was never stored recovers its identity
  // from the label inside its stored text.
  const legacyRows = [
    { id: 't9', prompt_index: 0, prompt_tag: '', prompt_text: 'Scene 9: A barn at dusk', status: 'failed', error_reason: 'boom', file_path: '' },
  ];
  const legacyReport = buildSequenceReport(legacyRows, { exists: () => false, namingMode: 'tag' });
  const legacyPlan = planRedo(legacyRows, legacyReport);
  eq('redo: legacy row recovers its label as the tag', legacyPlan.recreateItems[0].tag, 'Scene 9');
  eq('redo: legacy row text is cleaned', legacyPlan.recreateItems[0].text, 'A barn at dusk');

  // Tag-mode name check: a completed scene saved under a DIFFERENT
  // name is wrongName, not present.
  const wrong = buildSequenceReport(
    [{ id: 'w1', prompt_index: 0, prompt_tag: 'Scene 1', prompt_text: 'x', status: 'completed', file_path: path.join(diskDir, 'random.mp4') }],
    { exists: () => true, namingMode: 'tag' }
  );
  eq('wrong-name detection', wrong.wrongName.length, 1);
  eq('wrong-name expects the padded name', wrong.wrongName[0].expectedName, 'Scene001.mp4');
} finally {
  fs.rmSync(diskDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed === 0 ? 0 : 1);
