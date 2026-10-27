'use strict';

// v2.34.0 (Problem 7): History origin classification — a file the
// app generated (a queue_tasks record proves it) must read "flow";
// a foreign file dropped into the output folder must read "local";
// a generated file whose record points at a PREVIOUS folder (the
// project-folder case: project runs move download_folder, and the
// owner may move files afterwards) must still read "flow" via the
// file_name evidence.
// Usage: node test_js/run_origin_tests.js
const path = require('path');
const { classifyOrigin, withOrigins } = require('../engine/historyOrigin');

let passed = 0;
let failed = 0;
function eq(name, got, want) {
  if (got === want) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

const dir = path.join('C:', 'FlowStudio', 'Videos');
const projDir = path.join(dir, 'My Film');

const records = [
  // generated into the plain output folder
  { file_path: path.join(dir, '#00-01.mp4'), file_name: '#00-01.mp4' },
  // generated into a project subfolder (previous download_folder)
  { file_path: path.join(projDir, 'Scene001.mp4'), file_name: 'Scene001.mp4' },
  // a record with a name but an unrelated path (file was moved)
  { file_path: path.join('D:', 'Elsewhere', 'Ep3.mp4'), file_name: 'Ep3.mp4' },
];

eq('path match -> flow',
  classifyOrigin('#00-01.mp4', path.join(dir, '#00-01.mp4'), records), 'flow');
eq('path match is case/slash-insensitive (Windows)',
  classifyOrigin('#00-01.mp4', 'c:/flowstudio/videos/#00-01.mp4', records), 'flow');
eq('foreign file -> local',
  classifyOrigin('birthday-party.mp4', path.join(dir, 'birthday-party.mp4'), records), 'local');
eq('no records at all -> local',
  classifyOrigin('#00-01.mp4', path.join(dir, '#00-01.mp4'), []), 'local');
eq('project-folder record, file listed from its own folder -> flow',
  classifyOrigin('Scene001.mp4', path.join(projDir, 'Scene001.mp4'), records), 'flow');
eq('project file later moved into the main folder -> still flow (name evidence)',
  classifyOrigin('Scene001.mp4', path.join(dir, 'Scene001.mp4'), records), 'flow');
eq('record under an unrelated folder, same name -> flow (name evidence wins)',
  classifyOrigin('Ep3.mp4', path.join(dir, 'Ep3.mp4'), records), 'flow');
eq('a different file that merely resembles a record -> local',
  classifyOrigin('Scene002.mp4', path.join(dir, 'Scene002.mp4'), records), 'local');

const listing = withOrigins([
  { name: '#00-01.mp4', size: 10, mtime: 1 },
  { name: 'birthday-party.mp4', size: 20, mtime: 2 },
], dir, records);
eq('withOrigins: generated file', listing[0].origin, 'flow');
eq('withOrigins: foreign file', listing[1].origin, 'local');
eq('withOrigins: other fields preserved', listing[0].size, 10);

// (Fix list 2026-10-27, item 1): project-grouped listing entries —
// the path evidence must be compared inside the project subfolder,
// not against a same-named file in the base folder.
const projListing = withOrigins([
  { name: 'Scene001.mp4', size: 30, mtime: 3, project: 'My Film' },
  { name: 'holiday.mp4', size: 40, mtime: 4, project: 'My Film' },
], dir, records);
eq('withOrigins: project file path-matches its own record', projListing[0].origin, 'flow');
eq('withOrigins: unknown project file -> local', projListing[1].origin, 'local');
eq('withOrigins: project field preserved', projListing[0].project, 'My Film');

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed === 0 ? 0 : 1);
