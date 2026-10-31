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
  fastFetchUrl,
  MONITOR_ROUND_CAP,
  DRAIN_ROUND_CAP,
  roundCapForChannel
} = require('../engine/downloadFetch');
const failover = require('../engine/failover');
const renderProgressWatch = require('../engine/renderProgressWatch');

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

// --- v2.48.0 (deep-audit fix #3): SEPARATE round budgets per channel.
// The monitor's rounds and the drain (download-retry) rounds keep
// independent persisted counters; the caps are decided by
// roundCapForChannel so a spent monitor budget can never starve the
// drain, and the drain is guaranteed at least 2 rounds. ---
eq('monitor channel cap is 3', roundCapForChannel('monitor'), MONITOR_ROUND_CAP);
eq('monitor cap constant is 3', MONITOR_ROUND_CAP, 3);
eq('drain channel cap is 3', roundCapForChannel('drain'), DRAIN_ROUND_CAP);
ok('drain is guaranteed at least 2 rounds', DRAIN_ROUND_CAP >= 2);
eq('unknown channel falls back to the monitor cap', roundCapForChannel('bogus'), MONITOR_ROUND_CAP);
eq('missing channel falls back to the monitor cap', roundCapForChannel(undefined), MONITOR_ROUND_CAP);

// --- v2.48.0 (deep-audit fix #7 in the audit's numbering): UNKNOWN
// errors get at most 2 account tries; known account-level classes
// keep 3; 'render-frozen' is a known, eligible generation class. ---
{
  const unknown = failover.classifyFailure('some totally unheard-of glitch xyz');
  eq('unknown failure is eligible', unknown.eligible, true);
  eq('unknown failure is flagged known:false', unknown.known, false);
  const t1 = failover.createFailoverTracker();
  t1.recordTry('task-u', 'acc-1');
  eq('unknown: 1 try spent, one more allowed', t1.canFailover('task-u', 'some totally unheard-of glitch xyz').ok, true);
  eq('unknown: verdict cap is 2', t1.canFailover('task-u', 'some totally unheard-of glitch xyz').maxTries, failover.UNKNOWN_MAX_ACCOUNT_TRIES);
  t1.recordTry('task-u', 'acc-2');
  eq('unknown: 2 tries spent, no third account', t1.canFailover('task-u', 'some totally unheard-of glitch xyz').ok, false);

  const t2 = failover.createFailoverTracker();
  t2.recordTry('task-k', 'acc-1');
  t2.recordTry('task-k', 'acc-2');
  const knownVerdict = t2.canFailover('task-k', 'Render timed out before the video could be identified');
  eq('known generation failure keeps the 3-account budget', knownVerdict.ok && knownVerdict.maxTries, 3);

  const frozen = failover.classifyFailure('Render frozen (render-frozen): progress has not moved at all for 6 minutes');
  eq('render-frozen is failover-eligible', frozen.eligible, true);
  eq('render-frozen is a known class', frozen.known, true);
  eq('render-frozen classifies as generation', frozen.kind, 'generation');
}

// --- v2.48.0 (deep-audit fix #5): frozen-% escalation — warn at the
// stall budget (3 min), escalate to 'frozen' at 6 min, fire once. ---
{
  const task = {};
  const base = { state: 'generating', percentage: '43%', tileText: '', stallAfterMs: 180000, frozenAfterMs: 360000 };
  eq('first sighting arms the watch', renderProgressWatch.observeProgress(task, { ...base, now: 0 }).type, 'none');
  eq('at 3 min the stall warning fires', renderProgressWatch.observeProgress(task, { ...base, now: 180000 }).type, 'stalled');
  eq('at 6 min the frozen escalation fires', renderProgressWatch.observeProgress(task, { ...base, now: 360000 }).type, 'frozen');
  eq('frozen fires only once per episode', renderProgressWatch.observeProgress(task, { ...base, now: 420000 }).type, 'none');
  eq('a % move resets the episode', renderProgressWatch.observeProgress(task, { ...base, percentage: '44%', now: 430000 }).type, 'progress');
  eq('default frozen budget is 6 minutes', renderProgressWatch.DEFAULT_FROZEN_AFTER_MS, 360000);
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
