'use strict';

// v2.38.0: direct-fetch hardening — the pure decision layer in
// engine/downloadFetch.js decides (a) which first-attempt fetch
// failures are transient and get an in-call retry (the owner's
// intermittent "download fail" pattern: same account + route
// succeeds on another run), (b) the retry schedule, (c) that the
// fetch's User-Agent is the browser session's own, and (d) how
// per-attempt REAL errors are summarised into the strategy notes
// that reach the Activity detail.
// Usage: node test_js/run_download_fetch_tests.js
const {
  NODE_FETCH_MAX_ATTEMPTS,
  NODE_FETCH_RETRY_DELAYS_MS,
  retryDelayMs,
  RETRYABLE_STATUSES,
  isRetryableStatus,
  isRetryableFetchError,
  FALLBACK_USER_AGENT,
  resolveUserAgent,
  summarizeFetchSteps,
  fastFetchUrl
} = require('../engine/downloadFetch');

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
function ok(name, cond) { eq(name, !!cond, true); }

// --- Retry schedule: 3 attempts total, delays only between them ---
eq('max attempts is 3', NODE_FETCH_MAX_ATTEMPTS, 3);
eq('delays array matches attempts-1', NODE_FETCH_RETRY_DELAYS_MS.length, NODE_FETCH_MAX_ATTEMPTS - 1);
eq('first retry waits 1200ms', retryDelayMs(1), 1200);
eq('second retry waits 3000ms', retryDelayMs(2), 3000);
eq('no third retry delay', retryDelayMs(3), 0);
eq('retry 0 has no delay', retryDelayMs(0), 0);
ok('delays grow (backoff)', retryDelayMs(2) > retryDelayMs(1));

// --- Retryable HTTP statuses: transient classes only ---
for (const s of [403, 404, 408, 429, 500, 502, 503, 504]) {
  ok(`HTTP ${s} is retryable`, isRetryableStatus(s) && RETRYABLE_STATUSES.has(s));
}
for (const s of [200, 400, 401, 410, 422]) {
  eq(`HTTP ${s} is NOT retried in-call`, isRetryableStatus(s), false);
}
eq('string status coerces', isRetryableStatus('503'), true);
eq('undefined status is not retryable', isRetryableStatus(undefined), false);

// --- Retryable thrown errors: network/abort class only ---
ok('AbortError is retryable', isRetryableFetchError(Object.assign(new Error('x'), { name: 'AbortError' })));
ok('undici TypeError fetch failed is retryable', isRetryableFetchError(new TypeError('fetch failed')));
ok('ECONNRESET cause is retryable', isRetryableFetchError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })));
ok('socket hang up is retryable', isRetryableFetchError(new Error('socket hang up')));
ok('generic programming error is NOT retryable', !isRetryableFetchError(new Error('Cannot read properties of null')));
eq('null error is not retryable', isRetryableFetchError(null), false);

// --- User-Agent: the session's real UA wins; fallback only when unusable ---
const realUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
eq('real page UA is used verbatim', resolveUserAgent(realUA), realUA);
eq('null UA falls back', resolveUserAgent(null), FALLBACK_USER_AGENT);
eq('empty UA falls back', resolveUserAgent(''), FALLBACK_USER_AGENT);
eq('garbage short UA falls back', resolveUserAgent('x'), FALLBACK_USER_AGENT);

// --- Step summary: failures only, deduped, capped, carries the real error ---
eq('no steps -> empty summary', summarizeFetchSteps([]), '');
eq('no steps arg -> empty summary', summarizeFetchSteps(null), '');
eq('all-ok steps -> empty summary', summarizeFetchSteps([{ step: 'node-fetch', ok: true }]), '');
eq('HTTP status is named',
  summarizeFetchSteps([{ step: 'node-fetch', ok: false, status: 403 }]),
  'node-fetch HTTP 403');
eq('exception text is named',
  summarizeFetchSteps([{ step: 'page-fetch', ok: false, error: 'Failed to fetch' }]),
  'page-fetch: Failed to fetch');
eq('duplicate failures collapse',
  summarizeFetchSteps([
    { step: 'node-fetch', ok: false, status: 403 },
    { step: 'node-fetch', ok: false, status: 403 },
    { step: 'page-fetch', ok: false, error: 'Failed to fetch' }
  ]),
  'node-fetch HTTP 403 · page-fetch: Failed to fetch');
ok('summary is capped at 3 entries',
  summarizeFetchSteps([
    { step: 'a', ok: false, status: 403 },
    { step: 'b', ok: false, status: 404 },
    { step: 'c', ok: false, status: 500 },
    { step: 'd', ok: false, status: 503 }
  ]).split(' · ').length === 3);
eq('save-verify failure is named',
  summarizeFetchSteps([{ step: 'save-verify', ok: false, error: 'the saved file failed the video check (ffprobe)' }]),
  'save-verify: the saved file failed the video check (ffprobe)');

// --- v2.47.4 fast path: %-gone + the tile's own src -> fetch NOW;
// anything less -> keep waiting (never a silent skip, never done) ---
const signedUrl = 'https://lh3.googleusercontent.com/v/abc123=s0-dv';
eq('pct gone + http src -> immediate fetch of that src',
  fastFetchUrl({ pctGone: true, url: signedUrl }), signedUrl);
eq('pct gone + blob src -> immediate fetch of that src',
  fastFetchUrl({ pctGone: true, url: 'blob:https://flow.google.com/9f2c' }),
  'blob:https://flow.google.com/9f2c');
eq('pct still showing + src -> keep waiting',
  fastFetchUrl({ pctGone: false, url: signedUrl }), null);
eq('pct gone + EMPTY src -> keep waiting (no silent skip)',
  fastFetchUrl({ pctGone: true, url: '' }), null);
eq('pct gone + missing url -> keep waiting',
  fastFetchUrl({ pctGone: true, url: null }), null);
eq('pct gone + non-fetchable scheme -> keep waiting',
  fastFetchUrl({ pctGone: true, url: 'data:video/mp4;base64,AAAA' }), null);
eq('no state at all -> keep waiting',
  fastFetchUrl(null), null);

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
