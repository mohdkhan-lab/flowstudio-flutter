'use strict';

const assert = require('assert');
const route = require('../engine/download-route');
const verify = require('../engine/download-verify');

function box(type, payload) {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(b.length, 0);
  b.write(type, 4, 4, 'ascii');
  payload.copy(b, 8);
  return b;
}

function smallMp4(seconds) {
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isomiso2', 'binary'));
  const mvhd = Buffer.alloc(20);
  mvhd[0] = 0; // version
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(seconds * 1000, 16);
  const moov = box('moov', box('mvhd', mvhd));
  return Buffer.concat([ftyp, moov]);
}

(async () => {
  // Regression 1: helper with async direct fetch must return a Promise.
  assert.strictEqual(typeof route.pickAndFetch({ claimedUrl: 'http://127.0.0.1:1/video' }).then, 'function',
    'pickAndFetch must be async because doDirectFetch returns a Promise');

  // Regression 2: duration-passing small files must not be rejected by a byte floor.
  const buf = smallMp4(4);
  const verdict = verify.preSaveCheck({ buffer: buf, expectedSec: 4 });
  assert.strictEqual(verdict.ok, true,
    `duration-valid small MP4 must pass without a size floor; got ${verdict.reason}`);

  const line = verify.saveVerifyLine({ taskKey: 't', fileName: 'x.mp4', durationSec: 3.970612, expectedSec: 4, ok: true, reason: 'ok' });
  assert.ok(line.includes('ffprobeDuration=3.971s') && line.includes('expected=4.000s'),
    'save verification log must preserve exact duration instead of flooring to 3s');

  console.log('REGRESSION_TESTS: PASS');
})().catch((err) => {
  console.error('REGRESSION_TESTS: FAIL', err.stack || err.message || err);
  process.exitCode = 1;
});
