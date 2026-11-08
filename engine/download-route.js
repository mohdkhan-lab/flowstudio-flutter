'use strict';

/**
 * FlowStudio Lite — DOWNLOAD ROUTE (v2.48.70 + hotfix).
 *
 * MASLA: video backend se seedha download.
 *
 * Usool (proven):
 *   1. Flow ke server se video aati hai: host `flow-content.google` (path /video/...)
 *      — networkCapture.js ~21.
 *   2. Route 1B (CDP Fetch range-rewrite): player ki tail-range
 *      request ko `bytes=0-` rewrite karke server se full file milta hai.
 *      networkCapture.js ~667.
 *   3. Full stream nahi aaye to Node direct-fetch (downloadFetch.js ~42-43):
 *      3 attempts, delays [1200, 3000]ms, retryable statuses {403,404,408,429,500,502,503,504}.
 *   4. Verification: MP4 duration check (saveGuard.js ~106-185) — real duration
 *      >= 85% of expected duration, is the acceptance test (block-size floor
 *      replaced by duration verification).
 *
 * YE FILE PURE DECISION LAYER HAI:
 *   - pickAndFetch(taskKey, claimedUrl, expectedSec) → { buffer | null }
 *   - storeRenderCompleted(taskKey, renderCompletedAt) → void (engine call)
 *   - timeline(taskKey, sessionStartedAt, nowMs) → { start, runMs }
 *
 * Koi I/O nahi, koi prompt submit nahi. Bas fetch + verification.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// --- FAIL CONSTANTS ---

/** Node fetch inside one downloadFromCapturedStream call. */
const NODE_FETCH_MAX_ATTEMPTS = 3;
const NODE_FETCH_RETRY_DELAYS_MS = [1200, 3000];

/** Retryable HTTP statuses. */
const RETRYABLE_STATUSES = new Set([403, 404, 408, 429, 500, 502, 503, 504]);

/** Fallback UA for direct fetch. */
const FALLBACK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

/** Duration verification. */
const DURATION_MATCH_RATIO = 0.85;

/** MP4 header check. */
const MP4_SIGNATURE = Buffer.from([0x66, 0x74, 0x79, 0x70]); // 'ftyp'
const WEBM_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

// --- HELPERS ---

function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(Number(status));
}

function isRetryableFetchError(err) {
  if (!err) return false;
  const name = String((err && err.name) || '');
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const msg = String((err && err.message) || err || '');
  const cause = (err && err.cause) || null;
  const code = String((cause && cause.code) || (err && err.code) || '');
  const hay = `${msg} ${code}`.toLowerCase();
  return /fetch failed|econnreset|econnrefused|etimedout|eai_again|enotfound|socket hang up|network|connection.*reset|connection.*closed|terminated|aborted/.test(hay);
}

function resolveUserAgent(pageUA) {
  const ua = typeof pageUA === 'string' ? pageUA.trim() : '';
  return ua.length >= 10 ? ua : FALLBACK_USER_AGENT;
}

function decodeCdpBody(body, base64Encoded) {
  if (typeof body !== 'string' || !body) return null;
  try {
    return base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
  } catch (e) { return null; }
}

function looksLikeVideoBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf.subarray(4, 8).equals(MP4_SIGNATURE)) return true;
  if (buf.subarray(0, 4).equals(WEBM_SIGNATURE)) return true;
  return false;
}

function parseDurationSeconds(str) {
  if (typeof str === 'number' && Number.isFinite(str)) {
    return str > 0 && str <= 3600 ? str : null;
  }
  if (typeof str !== 'string') return null;
  const m = str.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*s?$/);
  if (!m) return null;
  const sec = parseFloat(m[1]);
  return sec > 0 && sec <= 3600 ? sec : null;
}

function minBytesForDuration(durationStr) {
  const sec = parseDurationSeconds(durationStr);
  return sec ? Math.round(sec * 60 * 1024) : 200 * 1024;
}

function isPlausibleOriginalSize(bytes, durationStr) {
  const n = Math.floor(Number(bytes) || 0);
  return n >= minBytesForDuration(durationStr);
}

/**
 * MP4 buffer se mvhd duration (seconds) nikala.
 * Khali/parse nahi hua to null.
 */
function mp4DurationSeconds(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
    const readU32 = (off) => buffer.readUInt32BE(off);
    const boxEnd = (start, size, limit) => {
      if (size === 1) {
        if (start + 16 > limit) return -1;
        const big = buffer.readBigUInt64BE(start + 8);
        return big > BigInt(Number.MAX_SAFE_INTEGER) ? -1 : start + Number(big);
      }
      if (size === 0) return limit;
      if (size < 8) return -1;
      return start + size;
    };
    const findBox = (from, to, wanted) => {
      let p = from;
      while (p + 8 <= to) {
        const size = readU32(p);
        const type = buffer.toString('latin1', p + 4, p + 8);
        const end = boxEnd(p, size, to);
        if (end < 0 || end > to) return null;
        if (type === wanted) {
          const headerLen = size === 1 ? 16 : 8;
          return { contentStart: p + headerLen, contentEnd: end };
        }
        if (end <= p) return null;
        p = end;
      }
      return null;
    };
    const moov = findBox(0, buffer.length, 'moov');
    if (!moov) return null;
    const mvhd = findBox(moov.contentStart, moov.contentEnd, 'mvhd');
    if (!mvhd) return null;
    const s = mvhd.contentStart;
    if (s + 4 > mvhd.contentEnd) return null;
    const version = buffer[s];
    let timescale = 0;
    let duration = 0;
    if (version === 1) {
      if (s + 32 > mvhd.contentEnd) return null;
      timescale = readU32(s + 20);
      duration = Number(buffer.readBigUInt64BE(s + 24));
    } else {
      if (s + 20 > mvhd.contentEnd) return null;
      timescale = readU32(s + 12);
      duration = readU32(s + 16);
    }
    if (!Number.isFinite(timescale) || timescale <= 0) return null;
    if (!Number.isFinite(duration) || duration < 0) return null;
    const seconds = duration / timescale;
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  } catch (e) { return null; }
}

/**
 * Duration-tasdeeq = save guzar. Verdict:
 * { ok: boolean, reason: string, durationSec: number|null }
 * reasons: 'ok' | 'no-expectation' | 'bad-header' | 'unparseable' | 'short-duration'
 */
function bodyVerification(input) {
  const o = input && typeof input === 'object' ? input : {};
  if (!o.headerOk) return { ok: false, reason: 'bad-header', durationSec: null };
  const durationSec = mp4DurationSeconds(o.buffer);
  if (durationSec == null) return { ok: false, reason: 'unparseable', durationSec: null };
  const expected = Number(o.expectedSec);
  if (!Number.isFinite(expected) || expected <= 0) {
    return { ok: true, reason: 'no-expectation', durationSec };
  }
  if (durationSec >= expected * DURATION_MATCH_RATIO) {
    return { ok: true, reason: 'ok', durationSec };
  }
  return { ok: false, reason: 'short-duration', durationSec };
}

/**
 * Main fetch: video ko backend se seedha le aana.
 *
 * input: { taskKey, claimedUrl, expectedSec, sessionStartedAt, now }
 * output: { ok: boolean, result: string, detail: string, fileBytes: number|null }
 *
 * ok = TRUE tab jab:
 *   - claimedUrl / server stream mil jaye
 *   - file peparse nahi ho
 *   - duration check fail
 *
 * result: 'saved' | 'rejected:<wajah>' | 'error:<wajah>'
 * detail: log line (khalis, shape-only)
 */
async function pickAndFetch(input) {
  const o = input || {};
  const taskKey = o.taskKey || null;
  const claimedUrl = typeof o.claimedUrl === 'string' ? o.claimedUrl : null;
  const expectedSec = Number(o.expectedSec);
  const sessionStartedAt = Number.isFinite(o.sessionStartedAt) ? o.sessionStartedAt : null;
  const now = Number.isFinite(o.now) ? o.now : Date.now();

  // 1. Claimed URL ho to seedha fetch attempt
  if (!claimedUrl) {
    return { ok: false, result: 'error:no-claim', detail: 'no-claimed-url' };
  }

  // 2. Skip poison guard: HTML page ka link tab bhi
  if (/<!doctype/i.test(claimedUrl.substring(0, 512))) {
    return { ok: false, result: 'rejected:html-poison', detail: 'html-guard' };
  }

  // 3. Direct-load buffer
  let buf = null;
  let fetchError = null;
  try {
    buf = await doDirectFetch(claimedUrl, taskKey);
  } catch (err) {
    fetchError = err;
    buf = null;
  }

  if (!buf || buf.length === 0) {
    return { ok: false, result: 'error:no-body', detail: 'empty-buffer' };
  }

  // 4. Header check
  const headerOk = looksLikeVideoBuffer(buf);
  const headerReason = headerOk ? 'ok' : 'bad-header';
  if (!headerOk) {
    return { ok: false, result: 'rejected:bad-header', detail: `header=${headerReason}` };
  }

  // 5. Duration verification (new: replaces byte floor)
  const v = bodyVerification({ buffer: buf, headerOk, expectedSec });
  const { ok: verifiedOk, reason: verificationReason, durationSec } = v;

  const totalBytes = buf.length;

  // 6. Save or reject
  if (verifiedOk) {
    // Duration verification is the acceptance rule; byte size is not.
    return { ok: true, result: 'saved', detail: `verified-duration`, fileBytes: totalBytes };
  }

  if (verificationReason === 'no-expectation') {
    // With no expected duration, a valid video header is the only available
    // acceptance signal. Do not reintroduce a byte-size floor.
    return { ok: true, result: 'saved', detail: 'verified-header', fileBytes: totalBytes };
  }

  if (verificationReason === 'unparseable' || verificationReason === 'bad-header') {
    return { ok: false, result: 'rejected:' + verificationReason, detail: `reason=${verificationReason}` };
  }

  if (verificationReason === 'short-duration') {
    return { ok: false, result: 'rejected:short-duration', detail: `dur=${durationSec} expected=${expectedSec}` };
  }

  return { ok: false, result: 'error:unknown-verification', detail: `reason=${verificationReason}` };
}

/**
 * Direct fetch (Node) ka core.
 * Claimed URL se fetch; poison guard; range-negotiate; retry.
 */
function doDirectFetch(urlStr, taskKey) {
  const url = new URL(urlStr);

  // Range support check
  const supportsRange = !!(url.searchParams.get('clen') || url.searchParams.get('itag') || url.searchParams.get('dur'));

  // Try plain GET first
  const attempt = (retryNumber) => {
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'User-Agent': resolveUserAgent(null),
        'Accept': '*/*',
        'Connection': 'keep-alive'
      }
    };

    // If the URL has range parameters, strip them (Route 1B) and request full
    const rangeParams = ['range', 'rn', 'rbuf'];
    if (supportsRange) {
      for (const p of rangeParams) {
        if (url.searchParams.has(p)) url.searchParams.delete(p);
      }
    }

    return new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).request(opts, (res) => {
        // Check status
        if (res.statusCode === 403 || res.statusCode === 404 || res.statusCode === 408 || res.statusCode === 429) {
          if (isRetryableStatus(res.statusCode) && retryNumber < NODE_FETCH_MAX_ATTEMPTS) {
            const delay = NODE_FETCH_RETRY_DELAYS_MS[retryNumber - 1] || 0;
            if (delay > 0) {
              setTimeout(() => {
                req.destroy(); // close current
                // retry
                const retry = (retryNumber + 1);
                return attempt(retry).then(resolve).catch(reject);
              }, delay);
            }
          }
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        if (res.statusCode >= 500) {
          if (isRetryableStatus(res.statusCode) && retryNumber < NODE_FETCH_MAX_ATTEMPTS) {
            const delay = NODE_FETCH_RETRY_DELAYS_MS[retryNumber - 1] || 0;
            if (delay > 0) {
              setTimeout(() => {
                req.destroy();
                const retry = (retryNumber + 1);
                return attempt(retry).then(resolve).catch(reject);
              }, delay);
            }
          }
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        // Collect body
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          chunks.push(chunk);
          total += chunk.length;
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve(buf);
        });
        res.on('error', (err) => {
          reject(err);
        });
      });
      req.on('error', (err) => {
        reject(err);
      });
      req.setTimeout(30000, () => {
        req.destroy(new Error('Timeout'));
      });
      req.end();
    });
  };

  return attempt(1);
}

/**
 * Record render-complete pal.
 * call-time: task ka render complete hua.
 */
function storeRenderCompleted(taskKey, renderCompletedAt) {
  // Engine me record hota hai; is module ka khoj hai just for logs.
  // No-op unless needed.
  return;
}

/**
 * Task ka timing line (khalis) — engine log.
 */
function timeline(taskKey, sessionStartedAt, nowMs) {
  const tk = taskKey ? String(taskKey) : '(unknown)';
  const start = Number.isFinite(sessionStartedAt) ? String(Math.floor(sessionStartedAt)) : '0';
  const now = Number.isFinite(nowMs) ? String(Math.floor(nowMs)) : String(Date.now());
  const runMs = Number.isFinite(nowMs) && Number.isFinite(sessionStartedAt)
    ? String(Math.floor(nowMs - sessionStartedAt))
    : '0';
  return `[ROOT] timeline task=${tk} start=${start} run=${runMs}ms`;
}

module.exports = {
  pickAndFetch,
  storeRenderCompleted,
  timeline,
  NODE_FETCH_MAX_ATTEMPTS,
  NODE_FETCH_RETRY_DELAYS_MS,
  RETRYABLE_STATUSES,
  isRetryableStatus,
  isRetryableFetchError,
  resolveUserAgent,
  decodeCdpBody,
  looksLikeVideoBuffer,
  parseDurationSeconds,
  minBytesForDuration,
  isPlausibleOriginalSize,
  mp4DurationSeconds,
  bodyVerification,
  doDirectFetch
};
