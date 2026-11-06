'use strict';

// v2.48.35 (GUARD): engine/saveGuard.js ke khalis faisle —
// per-run content-hash guard (dusre task jaisi byte-identical
// file = reject; apne hi task ki dobara save = allow; alag
// bytes = allow), claim-discipline ka usool (bandha URL kisi
// aur ke naam ho to is task ka nahi), aur sequenceReport ki
// duplicate-content jaanch (do maujood files byte-identical
// hon to run complete NAHI).
// Wajah: ZEROCLICK2 (v2.48.34, live) — Prompt #2 ke naam par
// Prompt #1 ki file save ho gayi thi aur run ne jhooti
// "all 2 saved" de di thi.
// Usage: node test_js/run_save_guard_tests.js

const { contentHash, checkDuplicate, recordSave, claimedByOtherTask, mainpageRpcBodyPick } = require('../engine/saveGuard');
const { buildSequenceReport } = require('../engine/sequenceReport');

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
function ok(name, cond) {
  eq(name, !!cond, true);
}

// ---------------------------------------------------------------------------
// contentHash
// ---------------------------------------------------------------------------
{
  const a = Buffer.from('red-ball-video-bytes');
  const b = Buffer.from('red-ball-video-bytes');
  const c = Buffer.from('blue-car-video-bytes!');
  ok('HASH same bytes — same hash', contentHash(a) === contentHash(b));
  ok('HASH different bytes — different hash', contentHash(a) !== contentHash(c));
  eq('HASH empty buffer — null', contentHash(Buffer.alloc(0)), null);
  eq('HASH null — null', contentHash(null), null);
  eq('HASH garbage — null', contentHash('not a buffer'), null);
}

// ---------------------------------------------------------------------------
// checkDuplicate + recordSave — guard ke teen faisle
// ---------------------------------------------------------------------------
{
  const registry = new Map();
  const bytesA = contentHash(Buffer.from('video-of-prompt-1'));
  const bytesB = contentHash(Buffer.from('video-of-prompt-2'));

  // Pehli save se pehle: kitab khaali — sab jaiz.
  eq('GUARD empty registry allows task 1', checkDuplicate(registry, 'task-1', bytesA).duplicate, false);
  eq('GUARD empty registry allows task 2', checkDuplicate(registry, 'task-2', bytesB).duplicate, false);

  recordSave(registry, 'task-1', bytesA, 0);

  // (1) WOHI bytes, DUSRA task → reject, malik ki pehchan ke saath.
  const dup = checkDuplicate(registry, 'task-2', bytesA);
  eq('GUARD identical bytes, different task — duplicate', dup.duplicate, true);
  eq('GUARD duplicate names the other task', dup.otherKey, 'task-1');
  eq('GUARD duplicate names the other prompt index', dup.otherPromptIndex, 0);

  // (2) WOHI bytes, WOHI task (race / retry ki dobara save) → allow.
  eq('GUARD identical bytes, same task re-save — allowed', checkDuplicate(registry, 'task-1', bytesA).duplicate, false);

  // (3) ALAG bytes, dusra task → allow.
  eq('GUARD different bytes, different task — allowed', checkDuplicate(registry, 'task-2', bytesB).duplicate, false);

  // Dusri save ke baad: us ke bytes bhi ab dusron ke liye band.
  recordSave(registry, 'task-2', bytesB, 1);
  eq('GUARD second save now guards its own bytes', checkDuplicate(registry, 'task-3', bytesB).duplicate, true);
  eq('GUARD second save owner prompt index', checkDuplicate(registry, 'task-3', bytesB).otherPromptIndex, 1);

  // recordSave pehle malik ko nahi badalta.
  recordSave(registry, 'task-9', bytesA, 8);
  eq('GUARD recordSave keeps the first owner', checkDuplicate(registry, 'task-2', bytesA).otherKey, 'task-1');

  // Ghayab registry / key / hash par guard khud haar maan
  // kar allow karta hai (apni khami par save nahi rokta).
  eq('GUARD missing registry — allowed', checkDuplicate(null, 'task-1', bytesA).duplicate, false);
  eq('GUARD missing task key — allowed', checkDuplicate(registry, null, bytesA).duplicate, false);
  eq('GUARD missing hash — allowed', checkDuplicate(registry, 'task-2', null).duplicate, false);
}

// ---------------------------------------------------------------------------
// claimedByOtherTask — claim discipline ka khalis usool
// ---------------------------------------------------------------------------
{
  eq('CLAIM bound to another task — claimed', claimedByOtherTask('task-1', 'task-2'), true);
  eq('CLAIM bound to this very task — not other', claimedByOtherTask('task-1', 'task-1'), false);
  eq('CLAIM unbound (null owner) — not claimed', claimedByOtherTask(null, 'task-1'), false);
  eq('CLAIM unbound (undefined owner) — not claimed', claimedByOtherTask(undefined, 'task-1'), false);
  eq('CLAIM owner set, task key null — still another task\'s', claimedByOtherTask('task-1', null), true);
}

// ---------------------------------------------------------------------------
// sequenceReport duplicateContent — run ke aakhir wali jaanch
// ---------------------------------------------------------------------------
{
  const rows = [
    { id: 't1', prompt_index: 0, prompt_tag: '#00-01', prompt_text: 'one', status: 'completed', file_path: '/disk/#00-01.mp4' },
    { id: 't2', prompt_index: 1, prompt_tag: '#00-02', prompt_text: 'two', status: 'completed', file_path: '/disk/#00-02.mp4' },
    { id: 't3', prompt_index: 2, prompt_tag: '#00-03', prompt_text: 'three', status: 'completed', file_path: '/disk/#00-03.mp4' }
  ];
  const hashes = { '/disk/#00-01.mp4': 'hash-A', '/disk/#00-02.mp4': 'hash-A', '/disk/#00-03.mp4': 'hash-C' };
  const report = buildSequenceReport(rows, {
    exists: () => true,
    namingMode: 'tag',
    hashOf: (p) => hashes[p] || null
  });
  eq('SEQ identical pair detected', report.duplicateContent.length, 1);
  eq('SEQ pair first is prompt 1', report.duplicateContent[0].a.promptIndex, 0);
  eq('SEQ pair second is prompt 2', report.duplicateContent[0].b.promptIndex, 1);
  eq('SEQ run NOT complete with a duplicate pair', report.complete, false);
  eq('SEQ all three still present', report.presentCount, 3);

  // Alag-alag hashes → koi jodi nahi, run complete.
  const clean = buildSequenceReport(rows, {
    exists: () => true,
    namingMode: 'tag',
    hashOf: (p) => `h:${p}`
  });
  eq('SEQ distinct files — no pairs', clean.duplicateContent.length, 0);
  eq('SEQ distinct files — complete', clean.complete, true);

  // hashOf hi na diya jaye → jaanch nahi, purana rawayya.
  const noHash = buildSequenceReport(rows, { exists: () => true, namingMode: 'tag' });
  eq('SEQ no hashOf — no pairs', noHash.duplicateContent.length, 0);
  eq('SEQ no hashOf — complete as before', noHash.complete, true);

  // Hash na milne wali (null) file jaanch se bahar.
  const partial = buildSequenceReport(rows, {
    exists: () => true,
    namingMode: 'tag',
    hashOf: (p) => (p === '/disk/#00-03.mp4' ? null : 'same-for-a-and-b')
  });
  eq('SEQ null hash excluded, real pair still caught', partial.duplicateContent.length, 1);
}

// ---------------------------------------------------------------------------
// v2.48.53: mainpageRpcBodyPick — rpc-body nazar ki sakht attribution
// ---------------------------------------------------------------------------
{
  const S = (over) => Object.assign({
    url: 'https://rr3---sn-x.googlevideo.com/videoplayback?id=a&itag=18&clen=1193629',
    clen: 1193629, itag: '18', firstSeenAt: 100000, consumedBy: null
  }, over || {});
  const base = { sightings: [S()], triedUrls: new Set(), teacherUrl: null, renderDoneAt: 95000, attemptDeadline: 160000, pendingOthers: 0 };

  eq('RPC empty list is null', mainpageRpcBodyPick({ sightings: [], triedUrls: new Set() }), null);
  const one = mainpageRpcBodyPick(base);
  ok('RPC single in-window candidate is picked', !!one && one.clen === 1193629 && one.itag === '18');
  eq('RPC below-floor clen is not a candidate', mainpageRpcBodyPick({ ...base, sightings: [S({ clen: 98237 })] }), null);
  eq('RPC missing clen is not a candidate', mainpageRpcBodyPick({ ...base, sightings: [S({ clen: null })] }), null);
  eq('RPC consumed sighting is skipped', mainpageRpcBodyPick({ ...base, sightings: [S({ consumedBy: 'other-task' })] }), null);
  eq('RPC tried url is skipped', mainpageRpcBodyPick({ ...base, triedUrls: new Set([S().url]) }), null);
  eq('RPC teacher url is skipped', mainpageRpcBodyPick({ ...base, teacherUrl: S().url }), null);
  eq('RPC seen before the window is skipped', mainpageRpcBodyPick({ ...base, sightings: [S({ firstSeenAt: 80000 })] }), null);
  eq('RPC seen after the deadline is skipped', mainpageRpcBodyPick({ ...base, sightings: [S({ firstSeenAt: 200000 })] }), null);
  const pend = mainpageRpcBodyPick({ ...base, pendingOthers: 1 });
  eq('RPC another pending download blocks the pick', pend && pend.skip, 'pending-others');
  const amb = mainpageRpcBodyPick({ ...base, sightings: [S(), S({ url: 'https://rr5---sn-y.googlevideo.com/videoplayback?id=b&itag=18&clen=1200000', clen: 1200000, firstSeenAt: 101000 })] });
  eq('RPC two in-window candidates are ambiguous', amb && amb.skip, 'ambiguous');
  const edge = mainpageRpcBodyPick({ ...base, sightings: [S({ firstSeenAt: 90000 })] });
  ok('RPC window start is renderDoneAt-5000 inclusive', !!edge && !!edge.url);
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed ? 1 : 0);
