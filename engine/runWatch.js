'use strict';

// ---------------------------------------------------------------------------
// v2.48.110 (G5 + G8) — RUN HEALTH WATCH (pure logic, fake-clock testable).
//
// The owner's two field complaints behind this module:
//   G5: the internet dropped mid-run and the app looped "working"
//       forever — nothing noticed, nothing stopped, no reason given.
//   G8: a run crawled for ~10 minutes per prompt inside a tile
//       search and nobody could tell it was stuck.
//
// This watch is fed two kinds of signals by the pool while a run is
// live:
//   · progress      — any prompt state change or save (noteProgress)
//   · connectivity  — the result of a lightweight reachability probe
//                     to flow.google.com (noteNetResult)
// and answers ONE question per evaluate(now): is this run healthy,
// has the internet been lost, or has the run been stuck with no
// progress for the whole budget (5 minutes)?
//
// Internet loss trips on EITHER signal the owner approved:
//   · NET_FAIL_THRESHOLD (3) consecutive failed probes, or
//   · NET_SILENCE_MS (60s) with NO probe result at all (a probe that
//     hangs because the route is dead is itself the symptom).
// A verdict LATCHES: once tripped, evaluate keeps returning it until
// start() is called again — a flapping connection must not un-trip a
// stop that is already being acted on.
// ---------------------------------------------------------------------------

const STUCK_AFTER_MS = 300000; // 5 minutes with no progress at all
const NET_FAIL_THRESHOLD = 3; // consecutive failed reachability probes
const NET_SILENCE_MS = 60000; // no probe result at all for this long

function createRunWatch(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const stuckAfterMs = Math.max(1000, Number(o.stuckAfterMs) || STUCK_AFTER_MS);
  const netFailThreshold = Math.max(1, Number(o.netFailThreshold) || NET_FAIL_THRESHOLD);
  const netSilenceMs = Math.max(1000, Number(o.netSilenceMs) || NET_SILENCE_MS);

  let startedAt = null;
  let lastProgressAt = null;
  let lastNetOkAt = null;
  let lastNetResultAt = null;
  let consecutiveNetFailures = 0;
  let tripped = null;

  return {
    /** Arm the watch at run start (also re-arms after a trip). */
    start(now) {
      startedAt = now;
      lastProgressAt = now;
      lastNetOkAt = null;
      lastNetResultAt = null;
      consecutiveNetFailures = 0;
      tripped = null;
    },

    /** A prompt changed state or a file was saved at `now`. */
    noteProgress(now) {
      lastProgressAt = now;
    },

    /** One reachability probe finished: ok=true/false at `now`. */
    noteNetResult(ok, now) {
      lastNetResultAt = now;
      if (ok) {
        consecutiveNetFailures = 0;
        lastNetOkAt = now;
      } else {
        consecutiveNetFailures++;
      }
    },

    /**
     * The verdict for time `now`:
     *   { type: 'none' }
     *   { type: 'net-lost', consecutiveFailures, silenceMs }
     *   { type: 'stuck', idleMs }
     * Internet loss is reported before stuck: it is the more
     * specific (and more actionable) diagnosis.
     */
    evaluate(now) {
      if (tripped) return tripped;
      if (startedAt == null) return { type: 'none' };
      if (consecutiveNetFailures >= netFailThreshold) {
        tripped = {
          type: 'net-lost',
          consecutiveFailures: consecutiveNetFailures,
          silenceMs: now - (lastNetOkAt == null ? startedAt : lastNetOkAt)
        };
        return tripped;
      }
      const lastResultAt = lastNetResultAt == null ? startedAt : lastNetResultAt;
      if (now - lastResultAt >= netSilenceMs) {
        tripped = {
          type: 'net-lost',
          consecutiveFailures: consecutiveNetFailures,
          silenceMs: now - (lastNetOkAt == null ? startedAt : lastNetOkAt)
        };
        return tripped;
      }
      if (lastProgressAt != null && now - lastProgressAt >= stuckAfterMs) {
        tripped = { type: 'stuck', idleMs: now - lastProgressAt };
        return tripped;
      }
      return { type: 'none' };
    },

    get consecutiveNetFailures() { return consecutiveNetFailures; },
    get tripped() { return tripped; }
  };
}

module.exports = { createRunWatch, STUCK_AFTER_MS, NET_FAIL_THRESHOLD, NET_SILENCE_MS };
