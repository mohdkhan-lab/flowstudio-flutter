'use strict';

/**
 * FlowStudio Lite — DIRECT-FETCH hardening helpers (v2.38.0).
 *
 * WHY: the download strategies that fetch a video file directly
 * (backend-fetch, tile-src, captured-stream) all funnel into ONE
 * function (flowAutomation.downloadFromCapturedStream), and that
 * function used to make exactly ONE Node fetch attempt: any
 * transient failure — a connection reset, a 60s abort, or an
 * HTTP 403/404 while a freshly minted signed (FIFE) link is still
 * propagating on Google's side — ended the call, and the caller
 * treated the whole route as dead. The same account + same route
 * succeeding on another run is the signature of exactly this: a
 * transient FIRST-attempt failure being treated as final.
 *
 * This module is the pure decision layer for the hardened fetch:
 *   - how many times the direct fetch retries inside ONE call,
 *     and how long it waits between attempts;
 *   - which failures are worth retrying (transient) and which are
 *     final for this call;
 *   - how the per-attempt REAL errors are summarised into one
 *     compact line, so the Activity detail (which is built from
 *     the strategy notes) carries the actual HTTP status /
 *     exception instead of the old generic "(the link may have
 *     expired)" guess. Before v2.38.0 the fetch returned a bare
 *     boolean and the discriminating evidence was dropped here.
 *
 * Pure functions only — unit-tested in test_js/run_download_fetch_tests.js.
 * Nothing in here can submit a prompt or spend a credit: it only
 * ever informs re-FETCHING an already-generated video's file.
 */

// The direct (Node) fetch inside one downloadFromCapturedStream
// call: 1 initial attempt + up to 2 in-call retries. The delays
// sit between attempts. Total worst case ≈ 45s abort budget is
// NOT multiplied blindly — callers keep their own per-attempt
// abort, and the orchestrator's 120s round guard still bounds
// the whole step; the schedule below is sized so a fast-failing
// transient (the common case: an immediate 403/reset) is retried
// within ~5 seconds, long before the round budget is at risk.
const NODE_FETCH_MAX_ATTEMPTS = 3;
const NODE_FETCH_RETRY_DELAYS_MS = [1200, 3000];

/** Delay to wait BEFORE retry attempt `attemptIndex` (1-based retry
 *  number: 1 = first retry). 0 when no such retry exists. */
function retryDelayMs(retryNumber) {
  const i = Math.floor(Number(retryNumber) || 0) - 1;
  if (i < 0 || i >= NODE_FETCH_RETRY_DELAYS_MS.length) return 0;
  return NODE_FETCH_RETRY_DELAYS_MS[i];
}

/**
 * HTTP statuses worth retrying within the same call:
 *   403 — the classic freshly-minted FIFE signature that is not
 *         servable yet (propagation lag); also cookie warm-up.
 *   404 — object not visible yet on the serving edge.
 *   408 / 429 — timeout / throttling: transient by definition.
 *   5xx — the server's own transient trouble.
 * Other 4xx (400/401/410…) will not heal in seconds — retrying
 * them only burns the round budget; the caller moves on to the
 * next strategy instead.
 */
const RETRYABLE_STATUSES = new Set([403, 404, 408, 429, 500, 502, 503, 504]);

function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(Number(status));
}

/**
 * Is a thrown fetch error transient (worth an in-call retry)?
 * Covers undici/Node fetch shapes: TypeError "fetch failed" (with
 * a cause code like ECONNRESET / ETIMEDOUT / EAI_AGAIN), the
 * AbortError raised by our own per-attempt deadline, socket
 * hang-ups and DNS hiccups. Anything else (programming errors,
 * invalid URL) is final for this call.
 */
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

/**
 * The User-Agent for the direct fetch: the page session's REAL UA
 * (read from the browser itself), never a hardcoded version
 * string. The cookies sent with the fetch come from that same
 * browser session — a UA that names a different Chrome version
 * than the session's own is an inconsistency Google's signed-media
 * checks are free to refuse. The fallback exists only for when
 * the page could not be asked at all.
 */
const FALLBACK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

function resolveUserAgent(pageUA) {
  const ua = typeof pageUA === 'string' ? pageUA.trim() : '';
  return ua.length >= 10 ? ua : FALLBACK_USER_AGENT;
}

/**
 * Compact one-line summary of a fetch call's recorded steps, for
 * strategy notes / Activity detail / the round ledger. Steps are
 * plain objects: { step, ok, status?, error? }. Only failures are
 * listed (a success ends the story), duplicates collapse, and the
 * output is capped so a note never becomes a paragraph.
 * Example: "node-fetch HTTP 403 · node-fetch HTTP 403 · page-fetch: Failed to fetch"
 */
function summarizeFetchSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return '';
  const parts = [];
  for (const s of steps) {
    if (!s || s.ok) continue;
    let p = String(s.step || 'fetch');
    if (s.status) p += ` HTTP ${s.status}`;
    else if (s.error) p += `: ${String(s.error).substring(0, 60)}`;
    if (!parts.includes(p)) parts.push(p);
    if (parts.length >= 3) break;
  }
  return parts.join(' · ');
}

/**
 * v2.47.4 — FAST-PATH ka faisla (owner-approved): tile ka %
 * progress indicator GAYA + tile ke apne <video> element par
 * ghair-khaali src/currentSrc maujood = video ban chuka hai,
 * fetch TURANT shuru ho sakta hai — network-capture binding ka
 * intezaar kiye bina. (Ek mukhalif extension ki tezi ka yahi
 * raaz forensic jaanch me pakka hua tha: wo sirf yahi do
 * nishan dekh kar download chala deta hai.)
 *
 * Ye sirf FAISLA hai — state { pctGone, url } andar, fetch ke
 * kabil URL ya null bahar:
 *   - % abhi dikh raha ho           -> null (intezaar jaari)
 *   - url khaali / ghair-http/blob  -> null (intezaar jaari —
 *     kabhi chup-chaap skip NAHI, kabhi complete NAHI)
 * Identity (URL is task ki apni claimed tile ka hai) aur
 * completion (save + ffprobe ke baad hi) caller ke maujooda
 * usool se hi bante hain — ye function unme kuch nahi badalta.
 */
function fastFetchUrl(state) {
  if (!state || state.pctGone !== true) return null;
  const u = state.url;
  if (typeof u !== 'string' || u.length === 0) return null;
  if (!(u.startsWith('http') || u.startsWith('blob:'))) return null;
  return u;
}

// --- v2.48.0 (deep-audit fix #3): SEPARATE download-round budgets ---
// Before v2.48.0 the monitor's download rounds and the download-retry
// (drain) rounds drew from ONE persisted 3-round ledger on the task
// row: a bad first stretch in the monitor could spend the whole
// budget, leaving the retry — the attempt that runs later, on a
// settled page, with a fresh link — nothing to spend. The two
// channels now keep SEPARATE persisted counters (dbService:
// download_attempts / drain_attempts) and separate caps, decided
// here so the rule is unit-testable without a browser or a database.
// The drain is guaranteed at least 2 rounds (DRAIN_ROUND_CAP = 3)
// no matter how many monitor rounds were already spent.
const MONITOR_ROUND_CAP = 3;
const DRAIN_ROUND_CAP = 3;

/** Round cap for one download channel: 'drain' (download-retry) or
 *  anything else (the monitor's own rounds). */
function roundCapForChannel(channel) {
  return channel === 'drain' ? DRAIN_ROUND_CAP : MONITOR_ROUND_CAP;
}

module.exports = {
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
};
