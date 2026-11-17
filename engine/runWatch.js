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
  let firstFailureAt = null;
  let netWarned = false;
  let tripped = null;

  return {
    /** Arm the watch at run start (also re-arms after a trip). */
    start(now) {
      startedAt = now;
      lastProgressAt = now;
      lastNetOkAt = null;
      lastNetResultAt = null;
      consecutiveNetFailures = 0;
      firstFailureAt = null;
      netWarned = false;
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
        firstFailureAt = null;
        netWarned = false;
        lastNetOkAt = now;
      } else {
        if (consecutiveNetFailures === 0) firstFailureAt = now;
        consecutiveNetFailures++;
      }
    },

    /**
     * The verdict for time `now`:
     *   { type: 'none' }
     *   { type: 'net-warning', consecutiveFailures }  (.112: probes
     *     failing but the run itself still progressing — log, don't stop)
     *   { type: 'net-lost', consecutiveFailures, silenceMs }
     *   { type: 'stuck', idleMs }
     * Internet loss is reported before stuck: it is the more
     * specific (and more actionable) diagnosis.
     */
    evaluate(now) {
      if (tripped) return tripped;
      if (startedAt == null) return { type: 'none' };
      // v2.48.112 (I): the W4 false positive — the probes failed
      // while work was visibly progressing (tasks changing state,
      // files saving), and the run was killed anyway. A probe
      // measures one route to one host; the run's own progress is
      // direct evidence the work is moving. So a net-lost verdict
      // now requires BOTH: the probe signal AND no engine activity
      // inside the same window (the failure streak for the
      // consecutive path; the silence window for the silence path).
      // With activity present, the verdict is a one-per-episode
      // 'net-warning' instead: the caller logs it and keeps
      // watching — if progress also stops, a later evaluate trips
      // for real. The stuck verdict below is unchanged: five
      // minutes with NO progress trips regardless of probes.
      const netWarning = () => {
        if (netWarned) return { type: 'none' };
        netWarned = true;
        return { type: 'net-warning', consecutiveFailures: consecutiveNetFailures };
      };
      if (consecutiveNetFailures >= netFailThreshold) {
        // Activity excuses the probes only while it is BOTH
        // inside the failure streak AND still recent — progress
        // that itself went silent a full window ago excuses
        // nothing (the stuck verdict below would otherwise be
        // the only remaining guard, five minutes late).
        const activeDuringStreak = lastProgressAt != null && firstFailureAt != null && lastProgressAt >= firstFailureAt && lastProgressAt > now - netSilenceMs;
        if (activeDuringStreak) return netWarning();
        tripped = {
          type: 'net-lost',
          consecutiveFailures: consecutiveNetFailures,
          silenceMs: now - (lastNetOkAt == null ? startedAt : lastNetOkAt)
        };
        return tripped;
      }
      const lastResultAt = lastNetResultAt == null ? startedAt : lastNetResultAt;
      if (now - lastResultAt >= netSilenceMs) {
        const activeInWindow = lastProgressAt != null && lastProgressAt > now - netSilenceMs;
        if (activeInWindow) return netWarning();
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
