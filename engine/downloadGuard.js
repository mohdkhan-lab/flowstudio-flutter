/**
 * FlowStudio Lite — Download Guard (v2.30.0).
 *
 * Why this exists: the download step used to be awaited with NO
 * timeout anywhere — not in the download orchestrator
 * (flowAutomation.downloadTaskMedia), not in its caller (the render
 * monitor), and not in leaf awaits like the Node fetch (no
 * AbortSignal) or page.evaluate (no timeout). One stuck await in
 * the SECOND video's download froze the render monitor forever and
 * the whole run stalled on that video (owner's report: the first
 * video downloads fine, the run gets stuck on the 2nd).
 *
 * The guard gives the download step a hard deadline and, on a
 * timeout/failure, retries the DOWNLOAD ONLY. It NEVER knows how to
 * submit a prompt: re-generation is structurally impossible here —
 * the only thing it can re-run is the download function it was
 * given. That keeps the standing law: a download failure must
 * never re-spend credits.
 */

class DownloadTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`Download step timed out after ${Math.round(timeoutMs / 1000)}s (${label})`);
    this.name = 'DownloadTimeoutError';
    this.isDownloadTimeout = true;
    this.timeoutMs = timeoutMs;
  }
}

/** Race a promise against a deadline. The loser keeps running in
 *  the background (harmless — its result is discarded), the caller
 *  is always released. */
function withTimeout(promise, timeoutMs, label = 'download') {
  if (!timeoutMs || timeoutMs <= 0) return Promise.resolve(promise);
  let timer = null;
  const deadline = new Promise((_, reject) => {
    // NOTE: deliberately NOT unref'd — if the awaited download is
    // the only pending work in the process, an unref'd timer lets
    // Node's event loop empty out and the process exits BEFORE the
    // deadline fires (caught by the v2.30.0 simulation). The timer
    // is always cleared when the race settles, so it never lingers.
    timer = setTimeout(() => reject(new DownloadTimeoutError(label, timeoutMs)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Run `downloadFn` (which resolves to a result object with `ok`)
 * under a per-attempt deadline. On a timeout — or a thrown error,
 * which the orchestrator's caller would otherwise have to treat as
 * a dead run — retry the DOWNLOAD ONLY up to `retries` extra times.
 *
 * Returns the downloadFn result of the successful attempt, or a
 * synthetic failure result:
 *   { ok:false, timedOut:boolean, attempts:[{strategy:'download-step',
 *     ok:false, note}], guardAttempts:n }
 * It never throws for timeouts; unexpected throws from downloadFn
 * are converted into the same failure shape (the caller logs them).
 */
async function attemptDownload(downloadFn, opts = {}) {
  const timeoutMs = opts.timeoutMs || 240000;
  const retries = Math.max(0, opts.retries == null ? 1 : opts.retries);
  const retryDelayMs = opts.retryDelayMs == null ? 2000 : opts.retryDelayMs;
  const label = opts.label || 'download';
  const onTimeout = typeof opts.onTimeout === 'function' ? opts.onTimeout : null;

  let lastTimedOut = false;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await withTimeout(downloadFn(attempt), timeoutMs, label);
      return result;
    } catch (e) {
      lastTimedOut = !!(e && e.isDownloadTimeout);
      lastError = e;
      if (lastTimedOut && onTimeout) {
        try { onTimeout(attempt, e); } catch (_) {}
      }
      if (attempt < retries && retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    }
  }
  return {
    ok: false,
    timedOut: lastTimedOut,
    guardAttempts: retries + 1,
    attempts: [{
      strategy: 'download-step',
      ok: false,
      note: lastTimedOut
        ? `the download step did not finish within ${Math.round(timeoutMs / 1000)}s even after ${retries + 1} attempt(s) — treated as a download failure; the prompt was NOT submitted again`
        : `the download step failed: ${(lastError && lastError.message) || lastError}`
    }]
  };
}

module.exports = { withTimeout, attemptDownload, DownloadTimeoutError };
