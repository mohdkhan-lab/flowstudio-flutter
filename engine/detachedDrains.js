'use strict';

// ---------------------------------------------------------------------------
// v2.48.110 (G6) — DETACHED BACKGROUND WORK TRACKER.
//
// Download retries used to be awaited inside the worker's monitor
// window: while a retry crawled, that worker submitted NOTHING —
// prompt feeding was gated on downloads finishing, which is exactly
// the slot-waiting rhythm the owner ordered removed. Retries now run
// detached (fire-and-forget) so submissions continue; this tracker
// is the run's memory of them, so the end of the run can still wait
// for every detached retry to settle before the final download pass
// judges what is left.
// ---------------------------------------------------------------------------

function createDetachedDrains() {
  const pending = new Set();
  return {
    /** Track a promise; returns a promise that never rejects. */
    add(promise) {
      const tracked = Promise.resolve(promise).catch(() => {});
      pending.add(tracked);
      tracked.finally(() => { pending.delete(tracked); });
      return tracked;
    },
    size() {
      return pending.size;
    },
    /**
     * Wait until every tracked promise has settled. Promises added
     * while waiting are waited on too. With timeoutMs > 0, gives up
     * after that long and returns how many are still pending.
     */
    async drainAll(timeoutMs = 0) {
      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
      while (pending.size > 0) {
        if (deadline && Date.now() >= deadline) break;
        const snapshot = [...pending];
        if (deadline) {
          const left = Math.max(0, deadline - Date.now());
          await Promise.race([
            Promise.all(snapshot),
            new Promise(resolve => setTimeout(resolve, left))
          ]);
        } else {
          await Promise.all(snapshot);
        }
      }
      return pending.size;
    }
  };
}

module.exports = { createDetachedDrains };
