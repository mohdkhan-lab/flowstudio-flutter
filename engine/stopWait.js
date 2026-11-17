'use strict';

// ---------------------------------------------------------------------------
// v2.48.110 (G1) — STOP-AWARE SLEEP.
//
// The owner's complaint: pressing Stop did not stop — long waits
// inside the engine (monitor polls, recovery pauses) ran to their
// full length because a plain sleep() cannot hear the stop flag.
// interruptibleSleep waits in short slices and returns as soon as
// the caller's stop predicate flips, so a stop lands within one
// slice (default 200ms) instead of at the end of the wait.
//
// Resolves true when the full wait elapsed, false when it was cut
// short by the stop predicate.
// ---------------------------------------------------------------------------

async function interruptibleSleep(ms, isStopped, sliceMs = 200) {
  const total = Math.max(0, Number(ms) || 0);
  const slice = Math.max(10, Math.min(Number(sliceMs) || 200, 1000));
  const stopped = () => {
    try { return typeof isStopped === 'function' && !!isStopped(); } catch (e) { return false; }
  };
  let waited = 0;
  while (waited < total) {
    if (stopped()) return false;
    const step = Math.min(slice, total - waited);
    await new Promise(resolve => setTimeout(resolve, step));
    waited += step;
  }
  return !stopped();
}

module.exports = { interruptibleSleep };
