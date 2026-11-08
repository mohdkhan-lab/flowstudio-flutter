'use strict';

/**
 * FlowStudio Lite — DOWNLOAD VERIFY (v2.48.70 + hotfix).
 *
 * MASLA: saved file ab automatically verify hota hai (duration check),
 * taaki koi bhi chhoti/partial stream save nahi hota.
 *
 * Usool:
 *   - ffprobe (node ffprobe-service) ya pure-JS duration parse
 *     (mp4DurationSeconds) se duration nikala.
 *   - Expected duration se compare: realDuration >= 85% × expectedSec
 *     TAB accept.
 *   - Har save ke baad [ROOT] save-verify line engine me:
 *     [ROOT] save-verify task=# file=<name> ffprobeDuration=<s>
 *     expected=<s> result=<ok|fail>
 *
 * Ye module pure-JS hai (ffprobe nahi lagta, direct buffer parse).
 * Engine cut-off me call hota hai.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mp4DurationSeconds, looksLikeVideoBuffer, parseDurationSeconds, minBytesForDuration } = require('./download-route');

/** Ki tarah ki check: 'ffprobe' | 'js-duration' | 'size-floor' */
const VERIFY_METHOD = process.env.FS_VERIFY_METHOD || 'js-duration';

/** Block size floor (old) — now duration verification hi main hai. */
const DURATION_MATCH_RATIO = 0.85;

/**
 * Ek saved file ko verify karo.
 *
 * input: {
 *   taskKey,      // task id
 *   filePath,     // saved filePath
 *   expectedSec,  // expected duration (seconds)
 *   fileSizeBytes // khud size (optional; jaanch ke liye)
 * }
 * output: {
 *   ok,           // TRUE tab jab verify pass
 *   method,       // 'ffprobe' | 'js-duration' | 'size-floor'
 *   durationSec,  // nikala (ya null)
 *   expectedSec,  // role
 *   reason,       // 'ok' | 'no-expectation' | 'unparseable' | 'short-duration' | 'fail'
 *   detail,       // simple string
 *   hashSha256    // optional hex
 * }
 */
function verifySavedFile(input) {
  const o = input || {};
  const taskKey = o.taskKey || null;
  const filePath = o.filePath || null;
  const expectedSec = Number(o.expectedSec);
  const fileSizeBytes = Number.isFinite(o.fileSizeBytes) ? o.fileSizeBytes : null;

  if (!filePath) {
    return { ok: false, method: 'none', durationSec: null, expectedSec, reason: 'no-file', detail: 'no-file-path' };
  }

  let buf = null;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, method: 'none', durationSec: null, expectedSec, reason: 'fail:read-error', detail: `read-error: ${String(err.message).slice(0, 80)}` };
  }

  if (!buf || buf.length === 0) {
    return { ok: false, method: 'none', durationSec: null, expectedSec, reason: 'fail:empty', detail: 'empty-body' };
  }

  // Header check
  const headerOk = looksLikeVideoBuffer(buf);
  if (!headerOk) {
    return { ok: false, method: 'js-duration', durationSec: null, expectedSec, reason: 'fail:bad-header', detail: 'not-video-magic' };
  }

  // Method 1: JS duration parse (mp4DurationSeconds)
  let durationSec = null;
  if (VERIFY_METHOD === 'js-duration' || VERIFY_METHOD === 'auto') {
    durationSec = mp4DurationSeconds(buf);
    if (durationSec != null) {
      const v = doDurationVerdict({ buffer: buf, headerOk: true, expectedSec });
      return {
        ok: v.ok,
        method: 'js-duration',
        durationSec,
        expectedSec,
        reason: v.reason,
        detail: durationReasonDetail(v)
      };
    }
  }

  // Duration is the acceptance rule. If it cannot be parsed, reject rather
  // than accepting a partial/preview body based on a byte-size heuristic.
  return { ok: false, method: 'js-duration', durationSec, expectedSec, reason: 'unparseable', detail: 'unparseable-mvhd' };
}

/**
 * Pure duration verdict.
 */
function doDurationVerdict(input) {
  const o = input && typeof input === 'object' ? input : {};
  if (!o.headerOk) return { ok: false, reason: 'bad-header' };
  const durationSec = mp4DurationSeconds(o.buffer);
  if (durationSec == null) return { ok: false, reason: 'unparseable' };
  const expected = Number(o.expectedSec);
  if (!Number.isFinite(expected) || expected <= 0) {
    return { ok: true, reason: 'no-expectation' };
  }
  if (durationSec >= expected * DURATION_MATCH_RATIO) {
    return { ok: true, reason: 'ok' };
  }
  return { ok: false, reason: 'short-duration' };
}

function durationReasonDetail(v) {
  const o = v && typeof v === 'object' ? v : {};
  if (o.reason === 'no-expectation') return 'no-expectation-duration';
  if (o.reason === 'ok') return `duration=${o.durationSec}ok`;
  if (o.reason === 'unparseable') return 'unparseable-mvhd';
  if (o.reason === 'bad-header') return 'bad-header';
  if (o.reason === 'short-duration') return `short-duration dur=${o.durationSec} expected=${o.expectedSec}`;
  return 'unknown';
}

/**
 * [ROOT] save-verify line (khalis).
 */
function saveVerifyLine(input) {
  const o = input || {};
  const taskKey = o.taskKey || o.taskId || null;
  const fileName = o.fileName || o.file || null;
  const method = o.method || 'js-duration';
  const durationSec = Number.isFinite(o.durationSec) ? o.durationSec : null;
  const expectedSec = Number.isFinite(o.expectedSec) ? o.expectedSec : null;
  const reason = o.reason || 'none';
  const ok = Boolean(o.ok);
  const result = ok ? 'ok' : 'fail';

  const tk = taskKey ? String(taskKey) : '(unknown)';
  const fn = fileName ? String(fileName) : '(no-file)';
  const ds = Number.isFinite(durationSec) ? durationSec.toFixed(3) : 'null';
  const es = Number.isFinite(expectedSec) ? expectedSec.toFixed(3) : 'null';
  return `[ROOT] save-verify task=${tk} file=${fn} method=${method} ffprobeDuration=${ds}s expected=${es}s result=${result} reason=${reason}`;
}

/**
 * Save-karne se pehle check: file ko save karne sahi hai ya nahi.
 * (fully in-memory buffer pe check)
 */
function preSaveCheck(input) {
  const o = input || {};
  const buffer = o.buffer || null;
  const expectedSec = Number(o.expectedSec);

  if (!buffer || buffer.length === 0) {
    return { ok: false, reason: 'empty-buffer' };
  }

  const headerOk = looksLikeVideoBuffer(buffer);
  if (!headerOk) {
    return { ok: false, reason: 'bad-header' };
  }

  if (VERIFY_METHOD === 'auto' || VERIFY_METHOD === 'js-duration') {
    const v = doDurationVerdict({ buffer, headerOk, expectedSec });
    if (!v.ok && (v.reason === 'unparseable' || v.reason === 'short-duration')) {
      return { ok: false, reason: v.reason };
    }
  }

  return { ok: true, reason: 'passes' };
}

module.exports = {
  verifySavedFile,
  preSaveCheck,
  saveVerifyLine,
  doDurationVerdict,
  VERIFY_METHOD,
  DURATION_MATCH_RATIO,
  mp4DurationSeconds,
  parseDurationSeconds,
  minBytesForDuration,
  looksLikeVideoBuffer,
  mp4DurationSeconds
};
