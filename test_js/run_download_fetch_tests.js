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

// --- v2.48.10: parallel range planning ---
const { RANGE_CHUNK_COUNT, RANGE_MIN_BYTES, planRanges } = require('../engine/downloadFetch');
eq('range chunk count is 4', RANGE_CHUNK_COUNT, 4);
eq('range min bytes is 1MB', RANGE_MIN_BYTES, 1024 * 1024);
{
  const rs = planRanges(10, 4);
  eq('planRanges(10,4) count', rs.length, 4);
  eq('planRanges covers start', rs[0].start, 0);
  eq('planRanges covers end', rs[rs.length - 1].end, 9);
  let covered = 0;
  let contiguous = true;
  for (let i = 0; i < rs.length; i++) {
    covered += rs[i].end - rs[i].start + 1;
    if (i > 0 && rs[i].start !== rs[i - 1].end + 1) contiguous = false;
  }
  eq('planRanges covers every byte once', covered, 10);
  eq('planRanges contiguous', contiguous, true);
  const big = planRanges(3133673, RANGE_CHUNK_COUNT);
  eq('planRanges big file count', big.length, 4);
  eq('planRanges big file end', big[big.length - 1].end, 3133672);
}
eq('planRanges(0) empty', planRanges(0, 4).length, 0);

// v2.48.15: content gate — magic bytes decide video vs not.
{
  const { looksLikeVideoBuffer } = require('../engine/downloadFetch');
  const mp4 = Buffer.alloc(64); mp4.write('ftyp', 4, 'ascii'); mp4.write('isom', 8, 'ascii');
  eq('looksLikeVideoBuffer accepts mp4 ftyp', looksLikeVideoBuffer(mp4), true);
  const webm = Buffer.alloc(64); webm[0] = 0x1a; webm[1] = 0x45; webm[2] = 0xdf; webm[3] = 0xa3;
  eq('looksLikeVideoBuffer accepts webm ebml', looksLikeVideoBuffer(webm), true);
  const jpg = Buffer.alloc(64); jpg[0] = 0xff; jpg[1] = 0xd8; jpg[2] = 0xff;
  eq('looksLikeVideoBuffer rejects jpeg', looksLikeVideoBuffer(jpg), false);
  const png = Buffer.alloc(64); png[0] = 0x89; png[1] = 0x50; png[2] = 0x4e; png[3] = 0x47;
  eq('looksLikeVideoBuffer rejects png', looksLikeVideoBuffer(png), false);
  eq('looksLikeVideoBuffer rejects tiny buffer', looksLikeVideoBuffer(Buffer.alloc(8)), false);
}
eq('planRanges tiny total clamps chunks', planRanges(2, 4).length, 2);
eq('planRanges single chunk', planRanges(500, 1).length, 1);

// v2.48.25 (E1): URL shape redactor — the downloadWillBegin log line
// must carry the URL's SHAPE only. A signed URL's query values and
// ID-like path segments (tokens) must never appear in the output.
{
  const { describeUrlShape, formatUrlShape } = require('../engine/urlShape');
  const TOKEN = 'S1gnedT0kenValueXYZ123456789';
  const PATHID = 'aB3dE5fG7hJ9kL2mN4pQ6rS8';
  const signed = `https://lh3.googleusercontent.com/asb/${PATHID}/video.mp4?sig=${TOKEN}&expires=1899999999`;
  const s1 = describeUrlShape(signed);
  eq('E1 shape scheme is https', s1.scheme, 'https');
  eq('E1 shape keeps host', s1.host, 'lh3.googleusercontent.com');
  eq('E1 shape lists query keys only', s1.queryKeys.join(','), 'sig,expires');
  eq('E1 shape records full length', s1.urlLength, signed.length);
  const line1 = formatUrlShape(s1);
  ok('E1 shape keeps readable segment', line1.includes('/asb/'));
  ok('E1 shape keeps file extension', line1.includes('.mp4'));
  ok('E1 shape hides query value', !line1.includes(TOKEN));
  ok('E1 shape hides token substring', !line1.includes('S1gnedT0ken'));
  ok('E1 shape hides path id', !line1.includes(PATHID));
  ok('E1 shape redacts id segment', line1.includes(':seg'));

  const blob = describeUrlShape('blob:https://flow.google.com/123e4567-e89b-12d3-a456-426614174000');
  eq('E1 blob scheme flagged', blob.scheme, 'blob');
  eq('E1 blob inner host kept', blob.host, 'flow.google.com');
  ok('E1 blob uuid hidden', !formatUrlShape(blob).includes('123e4567'));

  const plain = describeUrlShape('https://flow.google.com/asb/poster.jpg');
  eq('E1 no-query keys empty', plain.queryKeys.length, 0);
  ok('E1 no-query line has empty keys', formatUrlShape(plain).includes('queryKeys=[]'));

  eq('E1 garbage input does not throw', describeUrlShape('not a url at all').scheme, 'invalid');
}

// --- v2.48.26 (FAST-DL): blob-harvest selection + chunk plan ---
{
  const blobHarvest = require('../engine/blobHarvest');
  const { selectCandidate, planChunks, candidateKey, isVideoBlobMeta, CHUNK_BYTES, HOOK_SOURCE } = blobHarvest;
  const T0 = 1700000000000;
  const vid = (size, ts, extra) => Object.assign(
    { url: 'blob:https://flow.google.com/x', type: 'video/mp4', size, ts, via: 'fetch' }, extra || {});

  // Picks the largest fresh video blob.
  const c1 = selectCandidate(
    [vid(500000, T0 + 1000), vid(2000000, T0 + 2000), vid(900000, T0 + 3000)],
    { renderStartTs: T0, nowTs: T0 + 10000 });
  eq('FAST-DL picks largest fresh video blob', c1 && c1.size, 2000000);

  // Rejects stale (pre-render) blobs — even big ones.
  eq('FAST-DL rejects pre-render (stale) blob',
    selectCandidate([vid(3000000, T0 - 60000)], { renderStartTs: T0, nowTs: T0 + 10000 }), null);
  const c2 = selectCandidate(
    [vid(3000000, T0 - 60000), vid(800000, T0 + 500)],
    { renderStartTs: T0, nowTs: T0 + 10000 });
  eq('FAST-DL stale big blob ignored, fresh smaller wins', c2 && c2.size, 800000);

  // Rejects non-video and too-small blobs.
  eq('FAST-DL rejects image blob',
    selectCandidate([{ url: 'blob:x', type: 'image/jpeg', size: 500000, ts: T0 + 1 }],
      { renderStartTs: T0, nowTs: T0 + 10000 }), null);
  eq('FAST-DL rejects small video blob',
    selectCandidate([vid(50000, T0 + 1)], { renderStartTs: T0, nowTs: T0 + 10000 }), null);
  eq('FAST-DL rejects small untyped blob',
    selectCandidate([{ url: 'u', type: '', size: 150000, ts: T0 + 1 }],
      { renderStartTs: T0, nowTs: T0 + 10000 }), null);
  const c3 = selectCandidate([{ url: 'u', type: '', size: 250000, ts: T0 + 1 }],
    { renderStartTs: T0, nowTs: T0 + 10000 });
  eq('FAST-DL accepts large untyped blob', c3 && c3.size, 250000);

  // Empty / missing registry → null.
  eq('FAST-DL empty registry gives null', selectCandidate([], { renderStartTs: T0, nowTs: T0 + 10000 }), null);
  eq('FAST-DL missing registry gives null', selectCandidate(null, { renderStartTs: T0, nowTs: T0 + 10000 }), null);

  // A blob already consumed by an earlier task is never re-picked.
  const e1 = vid(2000000, T0 + 1000);
  const e2 = vid(900000, T0 + 2000);
  const c4 = selectCandidate([e1, e2],
    { renderStartTs: T0, nowTs: T0 + 10000, consumedKeys: new Set([candidateKey(e1)]) });
  eq('FAST-DL consumed blob skipped', c4 && c4.size, 900000);

  // An exact expected-size match beats a bigger blob.
  const c5 = selectCandidate([vid(3000000, T0 + 1000), vid(1200000, T0 + 2000)],
    { renderStartTs: T0, nowTs: T0 + 10000, expectedSize: 1200000 });
  eq('FAST-DL expected size wins', c5 && c5.size, 1200000);

  // With a known render-completion time, the blob created closest
  // to it wins over a later task's bigger blob (identity first).
  const c6 = selectCandidate([vid(3000000, T0 + 40000), vid(1100000, T0 + 2000)],
    { renderStartTs: T0 - 60000, renderCompleteTs: T0, nowTs: T0 + 50000 });
  eq('FAST-DL render-complete proximity wins', c6 && c6.size, 1100000);

  ok('FAST-DL isVideoBlobMeta accepts video type', isVideoBlobMeta({ type: 'video/mp4', size: 500000 }));

  // Chunk plan covers a 1.2 MB blob exactly — no gap, no overlap.
  const plan = planChunks(1200000, CHUNK_BYTES);
  eq('FAST-DL chunk count for 1.2MB', plan.length, 3);
  let covered = 0;
  let contiguous = true;
  let prevEnd = 0;
  for (const ch of plan) {
    if (ch.start !== prevEnd) contiguous = false;
    covered += (ch.end - ch.start);
    prevEnd = ch.end;
  }
  ok('FAST-DL chunks are contiguous', contiguous);
  eq('FAST-DL chunks cover exactly', covered, 1200000);
  eq('FAST-DL last chunk ends at total', plan[plan.length - 1].end, 1200000);
  eq('FAST-DL chunk plan of 0 is empty', planChunks(0).length, 0);
  const onePlan = planChunks(1000);
  eq('FAST-DL small blob is one chunk', onePlan.length, 1);
  eq('FAST-DL small chunk end', onePlan[0].end, 1000);
  eq('FAST-DL chunk size is 512KB', CHUNK_BYTES, 512 * 1024);

  // The hook source wires the registry + createObjectURL.
  ok('FAST-DL hook defines the registry', HOOK_SOURCE.includes('__mkBlobRegistry'));
  ok('FAST-DL hook wraps createObjectURL', HOOK_SOURCE.includes('createObjectURL'));
}

// --- v2.48.30 (QUICK-CHECK HEAD) → v2.48.41 (MAIN-PAGE
// HARVEST PACK): download route order ---
{
  const routeOrder = require('../engine/downloadRouteOrder');
  const { DOWNLOAD_ROUTE_ORDER, fallbackRouteOrder, firstRoute } = routeOrder;

  // Tareekh (mukhtasar): .30 quick-check head → .36 verbatim
  // replays → .38 editor-harvest → .40 invisible (bg) harvest
  // → .41 main-page harvest → .42 binding → .43 hover+patience.
  // v2.48.44 (HEADLESS HARVEST PACK — owner sequence
  // 2026-11-04): Option 1 (main-page family) ZEROCLICK9/10/11
  // ke baad khatam; Option 3 (editor-harvest wapsi) sab se
  // aakhri chaara hai, is tartib me NAHI. Video ki tartib ab
  // teen raaste hain: pehle headless-harvest (profile copy
  // par bina-window Chrome, probe-first), phir
  // mainpage-harvest (main page ki apni stream kitab + usi
  // page ke andar se poora fetch), aakhir grid-replay
  // (teacher-guarded verbatim mint replay). Is ke baad
  // kuch nahi — attempt emaandari se FAIL hota hai.
  eq('MAINPAGE first route is headless-harvest', firstRoute(), 'headless-harvest');
  eq('MAINPAGE order starts with headless-harvest', DOWNLOAD_ROUTE_ORDER[0], 'headless-harvest');
  eq('MAINPAGE mainpage-harvest route is second', DOWNLOAD_ROUTE_ORDER[1], 'mainpage-harvest');
  eq('MAINPAGE grid-replay route is third', DOWNLOAD_ROUTE_ORDER[2], 'grid-replay');
  eq('MAINPAGE order ends with grid-replay', DOWNLOAD_ROUTE_ORDER[DOWNLOAD_ROUTE_ORDER.length - 1], 'grid-replay');
  eq('MAINPAGE route count', DOWNLOAD_ROUTE_ORDER.length, 3);
  ok('MAINPAGE order is frozen', Object.isFrozen(DOWNLOAD_ROUTE_ORDER));
  // Banned raaste — editor/menu/viewer/backend — tartib
  // me kahin nahi:
  for (const banned of ['editor-harvest', 'replay-context', 'direct-viewer', 'native-menu', 'native-editor', 'blob-harvest', 'backend-fetch', 'backend-order', 'backend-fetch-retry', 'tile-readiness', 'tile-src-fast', 'tile-src', 'quick-check', 'server-first', 'zero-click']) {
    ok(`MAINPAGE order has no ${banned}`, !DOWNLOAD_ROUTE_ORDER.includes(banned));
  }

  // Fallback = tartib ka pehla rasta chhor kar baaki.
  const fb = fallbackRouteOrder();
  eq('MAINPAGE fallback drops only the head', fb.length, DOWNLOAD_ROUTE_ORDER.length - 1);
  ok('MAINPAGE fallback has no headless-harvest', !fb.includes('headless-harvest'));
  ok('MAINPAGE fallback starts with mainpage-harvest', fb[0] === 'mainpage-harvest');
  eq('MAINPAGE fallback list equals order minus first', JSON.stringify(fb), JSON.stringify(DOWNLOAD_ROUTE_ORDER.slice(1)));
}

// --- v2.48.28 (SERVER-FIRST): flow-content URL matcher ---
{
  const { FLOW_CONTENT_HOST, isFlowContentHost, isFlowContentVideoUrl } = require('../engine/flowContent');

  eq('FLOW host constant', FLOW_CONTENT_HOST, 'flow-content.google');
  ok('FLOW host exact matches', isFlowContentHost('flow-content.google'));
  ok('FLOW host case-insensitive', isFlowContentHost('Flow-Content.Google'));
  eq('FLOW host suffix look-alike rejected', isFlowContentHost('flow-content.google.evil.com'), false);
  eq('FLOW host subdomain rejected', isFlowContentHost('www.flow-content.google'), false);

  // Asal shakal (FASTTEST2): signed CDN address, /video/ rasta.
  ok('FLOW video URL with signature passes', isFlowContentVideoUrl('https://flow-content.google/video/abc123def?sig=xyz&expire=1', 'video/mp4'));
  ok('FLOW video URL without content-type passes', isFlowContentVideoUrl('https://flow-content.google/video/abc123def'));
  ok('FLOW video URL with type parameters passes', isFlowContentVideoUrl('https://flow-content.google/video/abc123def', 'video/mp4; charset=binary'));
  ok('FLOW http scheme passes', isFlowContentVideoUrl('http://flow-content.google/video/abc123def', 'video/mp4'));

  // Naklein — host exact na ho to kabhi nahi.
  eq('FLOW look-alike suffix host rejected', isFlowContentVideoUrl('https://flow-content.google.evil.com/video/abc', 'video/mp4'), false);
  eq('FLOW userinfo trick rejected', isFlowContentVideoUrl('https://flow-content.google@evil.com/video/abc', 'video/mp4'), false);
  eq('FLOW prefix look-alike rejected', isFlowContentVideoUrl('https://evilflow-content.google/video/abc', 'video/mp4'), false);
  eq('FLOW subdomain rejected', isFlowContentVideoUrl('https://www.flow-content.google/video/abc', 'video/mp4'), false);
  eq('FLOW other google host rejected', isFlowContentVideoUrl('https://flow.google.com/video/abc', 'video/mp4'), false);

  // Nau (type) ki jaanch — video ke siwa kuch nahi.
  eq('FLOW image type rejected', isFlowContentVideoUrl('https://flow-content.google/video/abc', 'image/png'), false);
  eq('FLOW html type rejected', isFlowContentVideoUrl('https://flow-content.google/video/abc', 'text/html'), false);
  eq('FLOW empty type skips the type gate', isFlowContentVideoUrl('https://flow-content.google/video/abc', ''), true);

  // Rasta aur shakal ki jaanch.
  eq('FLOW non-video path rejected', isFlowContentVideoUrl('https://flow-content.google/other/abc', 'video/mp4'), false);
  eq('FLOW bare /video/ rejected', isFlowContentVideoUrl('https://flow-content.google/video/', 'video/mp4'), false);
  eq('FLOW blob URL rejected', isFlowContentVideoUrl('blob:https://flow.google.com/6f9619ff-8b86-4a2b-b0d9-2c2e2e2e2e2e', 'video/mp4'), false);
  eq('FLOW garbage rejected', isFlowContentVideoUrl('not a url', 'video/mp4'), false);
  eq('FLOW empty rejected', isFlowContentVideoUrl('', 'video/mp4'), false);
  eq('FLOW null rejected', isFlowContentVideoUrl(null, 'video/mp4'), false);
  eq('FLOW undefined rejected', isFlowContentVideoUrl(undefined), false);
}

// --- v2.48.28 (SERVER-FIRST): capture ki flow-content fehrist ---
{
  const { NetworkCapture } = require('../engine/networkCapture');
  const cap = new NetworkCapture({});
  const T0 = 1700000000000;
  const good = 'https://flow-content.google/video/aaa111?sig=s1';
  const good2 = 'https://flow-content.google/video/bbb222?sig=s2';

  cap._recordFlowContentVideo(good, 'video/mp4', T0 + 1000);
  cap._recordFlowContentVideo(good2, 'video/mp4', T0 + 2000);
  cap._recordFlowContentVideo('https://flow-content.google.evil.com/video/x', 'video/mp4', T0 + 3000); // nakal — darj NAHI hogi
  cap._recordFlowContentVideo('https://flow-content.google/video/ccc333', 'image/png', T0 + 3000); // ghalat nau — darj NAHI hogi
  cap._recordFlowContentVideo(good, 'video/mp4', T0 + 4000); // wahi URL dobara — waqt taaza, entry ek hi

  const all = cap.recentFlowContentVideos(T0);
  eq('FLOW capture keeps only real video URLs', all.length, 2);
  eq('FLOW capture dedupes by URL', all.filter(e => e.url === good).length, 1);
  eq('FLOW capture refreshes the timestamp', all.find(e => e.url === good).at, T0 + 4000);
  eq('FLOW capture window filters old entries', cap.recentFlowContentVideos(T0 + 2500).length, 1);
  eq('FLOW capture claimed URL is not offered', (cap.claimFlowContentVideo(good), cap.recentFlowContentVideos(T0).length), 1);
  eq('FLOW capture double claim refused', cap.claimFlowContentVideo(good), false);
  ok('FLOW capture knows the claim', cap.isFlowContentClaimed(good));
  eq('FLOW capture unclaimed URL still offered', cap.recentFlowContentVideos(T0)[0].url, good2);
}

// --- v2.48.27 (NET-BIG): big-response decision + header lookup ---
{
  const nc = require('../engine/networkCapture');
  const { NET_BIG_THRESHOLD_BYTES, isNetBigResponse, headerValueOf } = nc;

  eq('NET-BIG threshold is 200000', NET_BIG_THRESHOLD_BYTES, 200000);
  ok('NET-BIG encoded at threshold counts', isNetBigResponse(200000, 0));
  ok('NET-BIG declared at threshold counts', isNetBigResponse(0, 200000));
  ok('NET-BIG either side can trigger', isNetBigResponse(150000, 250000));
  eq('NET-BIG just under threshold does not count', isNetBigResponse(199999, 199999), false);
  eq('NET-BIG zero sizes do not count', isNetBigResponse(0, 0), false);
  eq('NET-BIG missing sizes do not count', isNetBigResponse(undefined, undefined), false);
  eq('NET-BIG string sizes coerce', isNetBigResponse('250000', ''), true);

  eq('NET-BIG header lookup is case-insensitive', headerValueOf({ 'Content-Type': 'video/mp4' }, 'content-type'), 'video/mp4');
  eq('NET-BIG header lookup finds length', headerValueOf({ 'content-length': '123' }, 'Content-Length'), '123');
  eq('NET-BIG missing header is empty', headerValueOf({}, 'content-type'), '');
  eq('NET-BIG null headers are safe', headerValueOf(null, 'content-type'), '');
}

// --- v2.48.27 (NET-BIG window): per-host totals, render→save ---
{
  const { summarizeNetBigWindow } = require('../engine/networkCapture');
  const T0 = 1700000000000;
  const entries = [
    { host: 'flow.google.com', bytes: 5000, at: T0 + 100 },
    { host: 'lh3.googleusercontent.com', bytes: 1200000, at: T0 + 200 },
    { host: 'flow.google.com', bytes: 7000, at: T0 + 300 },
    { host: 'www.gstatic.com', bytes: 300000, at: T0 + 400 },
    { host: 'lh3.googleusercontent.com', bytes: 999999, at: T0 - 5000 } // khidki se pehle — gina NAHI jayega
  ];
  // Kul jama + descending kram: sab se bada host sab se pehle.
  eq('NET-BIG window totals per host, descending',
    summarizeNetBigWindow(entries, T0),
    'lh3.googleusercontent.com=1200000 www.gstatic.com=300000 flow.google.com=12000');
  // sinceMs na ho to saari entries ginati hain.
  eq('NET-BIG window without a start counts everything',
    summarizeNetBigWindow(entries, undefined),
    'lh3.googleusercontent.com=2199999 www.gstatic.com=300000 flow.google.com=12000');
  // Khaali / bekaar data par khaali line.
  eq('NET-BIG window empty list is empty', summarizeNetBigWindow([], T0), '');
  eq('NET-BIG window null list is empty', summarizeNetBigWindow(null, T0), '');
  eq('NET-BIG window skips zero/hostless entries',
    summarizeNetBigWindow([{ host: 'a.com', bytes: 0, at: T0 }, { bytes: 500, at: T0 }, { host: 'b.com', bytes: 42, at: T0 }], T0),
    'b.com=42');
  // Barabar bytes par pehla-darj host pehle rehta hai (stable).
  eq('NET-BIG window single host',
    summarizeNetBigWindow([{ host: 'x.com', bytes: 10, at: T0 }, { host: 'x.com', bytes: 5, at: T0 + 1 }], T0),
    'x.com=15');
}

// --- v2.48.29 (QUALITY GATE): duration-aware size floor ---
{
  const {
    QUALITY_BYTES_PER_SECOND, QUALITY_FLAT_FLOOR_BYTES,
    parseDurationSeconds, minBytesForDuration, isPlausibleOriginalSize
  } = require('../engine/downloadFetch');
  eq('QG bytes-per-second is 60KB', QUALITY_BYTES_PER_SECOND, 60 * 1024);
  eq('QG flat floor is 200KB', QUALITY_FLAT_FLOOR_BYTES, 200 * 1024);
  eq('QG parses 4s', parseDurationSeconds('4s'), 4);
  eq('QG parses 10s', parseDurationSeconds('10s'), 10);
  eq('QG parses bare number string', parseDurationSeconds('8'), 8);
  eq('QG parses numeric input', parseDurationSeconds(6), 6);
  eq('QG unparsable duration is null', parseDurationSeconds('long'), null);
  eq('QG undefined duration is null', parseDurationSeconds(undefined), null);
  eq('QG zero duration is null', parseDurationSeconds('0s'), null);
  eq('QG floor for 4s is 240KB', minBytesForDuration('4s'), 240 * 1024);
  eq('QG floor for 10s is 600KB', minBytesForDuration('10s'), 600 * 1024);
  eq('QG floor for unparsable duration is the flat 200KB', minBytesForDuration('junk'), 200 * 1024);
  eq('QG floor for missing duration is the flat 200KB', minBytesForDuration(undefined), 200 * 1024);
  // FASTTEST3 ki asal preview file: 80,843 bytes / 4s — reject.
  eq('QG FASTTEST3 preview buffer (80843B, 4s) is rejected', isPlausibleOriginalSize(80843, '4s'), false);
  // Asal Original (flow-content.google): 1,201,697 bytes / 4s — accept.
  eq('QG genuine Original (1201697B, 4s) is accepted', isPlausibleOriginalSize(1201697, '4s'), true);
  eq('QG genuine Original at 10s (2.2MB) is accepted', isPlausibleOriginalSize(2200000, '10s'), true);
  eq('QG half-megabyte at 10s is below the floor', isPlausibleOriginalSize(500000, '10s'), false);
  eq('QG exact flat floor passes for unknown duration', isPlausibleOriginalSize(200 * 1024, 'junk'), true);
  eq('QG one byte under the flat floor fails', isPlausibleOriginalSize(200 * 1024 - 1, 'junk'), false);
  eq('QG zero bytes never plausible', isPlausibleOriginalSize(0, '4s'), false);
}

// --- v2.48.29 (HTML-POISON): HTML pehchan + dobara fetch par rok ---
{
  const { looksLikeHtmlBuffer, createPoisonGuard } = require('../engine/downloadFetch');
  // FASTTEST3 ka asal head: 3c21646f63747970652068746d6c3e = '<!doctype html><'
  ok('POISON doctype page is HTML', looksLikeHtmlBuffer(Buffer.from('<!DOCTYPE html><html><head></head>')));
  ok('POISON uppercase doctype is HTML', looksLikeHtmlBuffer(Buffer.from('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">')));
  ok('POISON bare <html> is HTML', looksLikeHtmlBuffer(Buffer.from('<html lang="en"><body>x</body></html>')));
  ok('POISON leading whitespace then <html> is HTML', looksLikeHtmlBuffer(Buffer.from('  \n\t<html>')));
  eq('POISON mp4 header is NOT HTML', looksLikeHtmlBuffer(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])), false);
  eq('POISON jpeg is NOT HTML', looksLikeHtmlBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), false);
  eq('POISON tiny buffer is NOT HTML', looksLikeHtmlBuffer(Buffer.from('<ht')), false);
  eq('POISON null buffer is NOT HTML', looksLikeHtmlBuffer(null), false);

  // Guard: pehli fetch chalti hai aur link zeher ho jata hai;
  // dusri koshish guard par hi rukti hai — network call NAHI hoti.
  const guard = createPoisonGuard();
  const LINK = 'https://lh3.googleusercontent.com/asb/EXAMPLE';
  let networkCalls = 0;
  const fetchOnce = (u) => {
    if (guard.isPoisoned(u)) return 'skipped';
    networkCalls++;
    guard.poison(u); // pehli fetch ne HTML diya — engine yahi karta hai
    return 'fetched';
  };
  eq('POISON fresh link is not poisoned', guard.isPoisoned(LINK), false);
  eq('POISON first fetch runs', fetchOnce(LINK), 'fetched');
  eq('POISON link is poisoned after the HTML fetch', guard.isPoisoned(LINK), true);
  eq('POISON second fetch is skipped at the guard', fetchOnce(LINK), 'skipped');
  eq('POISON second fetch made NO network call', networkCalls, 1);
  eq('POISON another link stays clean', guard.isPoisoned('https://lh3.googleusercontent.com/asb/OTHER'), false);
  guard.clear();
  eq('POISON clear() resets the guard (new run)', guard.isPoisoned(LINK), false);
}

// --- v2.48.29 (ALWAYS-ON QUICK-CHECK): khaali par foran null ---
{
  const blobHarvest = require('../engine/blobHarvest');
  const { isFlowContentVideoUrl } = require('../engine/flowContent');
  // Registry khaali ho to candidate null — quick-check ka pehla
  // darwaza yahi hai (bina intezaar ke wapas).
  eq('QC empty registry yields no candidate', blobHarvest.selectCandidate([], { renderStartTs: 1000, renderCompleteTs: 2000, nowTs: 3000, consumedKeys: new Set() }), null);
  eq('QC null registry yields no candidate', blobHarvest.selectCandidate(null, { renderStartTs: 1000, nowTs: 3000 }), null);
  // Capture fehrist khaali ho to koi server URL banta hi nahi —
  // matcher khaali/ghalat shakal par hamesha inkaar karta hai.
  eq('QC no flow-content entries means no URL', [].filter(u => isFlowContentVideoUrl(u)).length, 0);
  eq('QC empty URL is not a flow-content video', isFlowContentVideoUrl(''), false);
  eq('QC undefined URL is not a flow-content video', isFlowContentVideoUrl(undefined), false);
}

// --- v2.48.30 (EVENT-MATCH): FASTTEST4 event=no regression ---
{
  const { stripDedupSuffix, matchCompletedDownload } = require('../engine/downloadEventMatch');
  const T0 = 1700000000000;
  const CLICK = T0 + 40480; // resolution click (22:29:40.48 ki nisbat)

  eq('EM dedup suffix (1) stripped', stripDedupSuffix('Red_ball (1).mp4'), 'Red_ball.mp4');
  eq('EM dedup suffix (12) stripped', stripDedupSuffix('clip (12).mp4'), 'clip.mp4');
  eq('EM plain name untouched', stripDedupSuffix('clip.mp4'), 'clip.mp4');
  eq('EM suffix without extension stripped', stripDedupSuffix('clip (2)'), 'clip');

  // FASTTEST4 ki asal haalat: begin click ke ~15.6s baad,
  // completed ~18.6s baad; save ka intezaar/milaan us ke BAAD
  // hota hai — event pehle se state me darj hai. Purana loop
  // use is liye ganwa deta tha ke eventSave sirf file-dikhne
  // wali iteration me bandhta tha. Matcher ko waqt ki is
  // tartib se koi farq nahi padna chahiye.
  const ft4 = {
    begins: [{ guid: 'g1', suggestedFilename: 'Red_ball_rolling_on_floor_ffeb7d60.mp4', at: CLICK + 15640 }],
    completed: new Map([['g1', { state: 'completed', at: CLICK + 18620, receivedBytes: 1216301, totalBytes: 1216301 }]])
  };
  const m1 = matchCompletedDownload(ft4, { sinceMs: CLICK - 2000 });
  ok('EM FASTTEST4 event fired before the wait still counts', !!m1 && m1.guid === 'g1');
  const m2 = matchCompletedDownload(ft4, { sinceMs: CLICK - 2000, fileName: 'Red_ball_rolling_on_floor_ffeb7d60.mp4' });
  ok('EM FASTTEST4 exact name matches', !!m2 && m2.guid === 'g1');
  // Disk par Chrome ne " (1)" wala naam diya ho to bhi milaan.
  const m3 = matchCompletedDownload(ft4, { sinceMs: CLICK - 2000, fileName: 'Red_ball_rolling_on_floor_ffeb7d60 (1).mp4' });
  ok('EM FASTTEST4 dedup-suffixed disk name matches', !!m3 && m3.guid === 'g1');
  // Naam ajnabi ho lekin size exact wahi (1,216,301) ho.
  const m4 = matchCompletedDownload(ft4, { sinceMs: CLICK - 2000, fileName: 'renamed-by-something.mp4', fileSize: 1216301 });
  ok('EM FASTTEST4 exact size matches when name differs', !!m4 && m4.guid === 'g1');

  // Click se PEHLE shuru hua download is attempt ka nahi.
  const stale = {
    begins: [{ guid: 'g0', suggestedFilename: 'old.mp4', at: CLICK - 60000 }],
    completed: new Map([['g0', { state: 'completed', at: CLICK - 59000, receivedBytes: 5, totalBytes: 5 }]])
  };
  eq('EM begin before the window is ignored', matchCompletedDownload(stale, { sinceMs: CLICK - 2000 }), null);
  // Canceled kabhi completed nahi.
  const canc = {
    begins: [{ guid: 'g2', suggestedFilename: 'x.mp4', at: CLICK + 100 }],
    completed: new Map([['g2', { state: 'canceled', at: CLICK + 200, receivedBytes: 5, totalBytes: 5 }]])
  };
  eq('EM canceled download never matches', matchCompletedDownload(canc, { sinceMs: CLICK - 2000 }), null);
  // Do completed, dono ka size wahi, naam koi na mile → shak, null.
  const amb = {
    begins: [
      { guid: 'ga', suggestedFilename: 'a.mp4', at: CLICK + 100 },
      { guid: 'gb', suggestedFilename: 'b.mp4', at: CLICK + 200 }
    ],
    completed: new Map([
      ['ga', { state: 'completed', at: CLICK + 300, receivedBytes: 999, totalBytes: 999 }],
      ['gb', { state: 'completed', at: CLICK + 400, receivedBytes: 999, totalBytes: 999 }]
    ])
  };
  eq('EM ambiguous size match is refused', matchCompletedDownload(amb, { sinceMs: CLICK - 2000, fileName: 'zzz.mp4', fileSize: 999 }), null);
  // Naam/size na hon to pehla completed (purana vyavhaar).
  const m5 = matchCompletedDownload(amb, { sinceMs: CLICK - 2000 });
  ok('EM bare window returns the first completed', !!m5 && m5.guid === 'ga');
  eq('EM null state is null', matchCompletedDownload(null, { sinceMs: 0 }), null);
  eq('EM empty state is null', matchCompletedDownload({ begins: [], completed: new Map() }, { sinceMs: 0 }), null);
}

// --- v2.48.30 (POST-CLICK RACE): taaza URL ki pehchan ---
{
  const { pickRaceFlowContentUrl } = require('../engine/flowContent');
  const CLICK = 1700000000000;
  const FRESH = 'https://flow-content.google/video/fresh123?sig=a';
  const STALE = 'https://flow-content.google/video/stale999?sig=b';
  const FRESH2 = 'https://flow-content.google/video/fresh456?sig=c';
  const own = () => true;
  const notClaimed = () => false;

  // Click se pehle ka fetch (stale) — is attempt ka saboot nahi.
  eq('RACE stale pre-click URL rejected',
    pickRaceFlowContentUrl([{ url: STALE, type: 'video/mp4', at: CLICK - 5000 }], { sinceMs: CLICK, isClaimed: notClaimed, isOwnUrl: own }), null);
  // Click ke baad ka taaza URL — qabool.
  const p1 = pickRaceFlowContentUrl([{ url: FRESH, type: 'video/mp4', at: CLICK + 14600 }], { sinceMs: CLICK, isClaimed: notClaimed, isOwnUrl: own });
  ok('RACE post-click URL accepted', !!p1 && p1.url === FRESH && p1.via === 'post-click');
  // Pehle se claimed/consumed — inkaar.
  eq('RACE claimed URL rejected',
    pickRaceFlowContentUrl([{ url: FRESH, type: 'video/mp4', at: CLICK + 100 }], { sinceMs: CLICK, isClaimed: () => true, isOwnUrl: own }), null);
  // Ajnabi / purana address (isOwnUrl jhooth) — inkaar.
  eq('RACE foreign URL rejected',
    pickRaceFlowContentUrl([{ url: FRESH, type: 'video/mp4', at: CLICK + 100 }], { sinceMs: CLICK, isClaimed: notClaimed, isOwnUrl: () => false }), null);
  // Nakli host matcher par hi marta hai.
  eq('RACE look-alike host rejected',
    pickRaceFlowContentUrl([{ url: 'https://flow-content.google.evil.com/video/x', type: 'video/mp4', at: CLICK + 100 }], { sinceMs: CLICK, isClaimed: notClaimed, isOwnUrl: own }), null);
  // Stale + fresh mila ho to fresh hi chuna jata hai.
  const p2 = pickRaceFlowContentUrl([
    { url: STALE, type: 'video/mp4', at: CLICK - 5000 },
    { url: FRESH, type: 'video/mp4', at: CLICK + 14600 }
  ], { sinceMs: CLICK, isClaimed: notClaimed, isOwnUrl: own });
  ok('RACE fresh wins over stale in the same list', !!p2 && p2.url === FRESH);
  // Do taaze usable — shak, race nahi hogi.
  const p3 = pickRaceFlowContentUrl([
    { url: FRESH, type: 'video/mp4', at: CLICK + 100 },
    { url: FRESH2, type: 'video/mp4', at: CLICK + 200 }
  ], { sinceMs: CLICK, isClaimed: notClaimed, isOwnUrl: own });
  ok('RACE two fresh URLs are ambiguous', !!p3 && p3.ambiguous === true && p3.count === 2);
  eq('RACE empty list is null', pickRaceFlowContentUrl([], { sinceMs: CLICK, isClaimed: notClaimed, isOwnUrl: own }), null);
  eq('RACE null list is null', pickRaceFlowContentUrl(null, { sinceMs: CLICK }), null);
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

