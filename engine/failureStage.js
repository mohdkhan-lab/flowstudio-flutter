'use strict';

// ---------------------------------------------------------------------------
// v2.48.109 (F3 — CREDIT PROTECTION): a task whose video EXISTS in
// the Flow project must never be re-submitted for generation.
//
// The pool's failTaskOrFailover() treats a task as a GENERATION
// failure (failover to another account / same-account retry — a
// fresh charge) UNLESS the engine stamps failureStage =
// 'download' on it. The download-failure branch already stamps
// it, but the monitor's OTHER fail paths (watchdog cap,
// render-frozen, stall give-up, deadline, monitor error) did
// not — a task whose render had finished and whose tile was
// bound could fail over and regenerate on another account,
// spending the same 7 credits twice (Gopal Pilot, 2026-11-16:
// 266 credits spent vs 217 expected for 31 generations).
//
// THE RULE (one line): a task that ever bound a tile —
// lockedTileFingerprint set, or a backend/completed video URL
// recorded — is a DOWNLOAD-stage failure, never a generation
// failure. Its download-retry / check-only recovery re-scans
// the SAME project for that tile; if the tile is truly gone
// the task fails as 'lost-render' (no resubmit, ever).
// Policy/safety failures are EXEMPT by design: a tile that
// Flow refused is not a video, and its prompt-level reason
// must keep failing (failoverTracker classifies it) instead
// of parking for a download that can never succeed — the
// monitor's policy paths (modal violation, tile error) do
// NOT call this helper.
//
// Pure function — unit-tested in the root pack (X113 F3).
// ---------------------------------------------------------------------------

/**
 * The failure stage for a task that failed AFTER its video
 * may exist, or null when the failure is genuinely a
 * generation failure (no tile was ever bound).
 */
function downloadFailureStage(task) {
  if (!task || typeof task !== 'object') return null;
  if (task.lockedTileFingerprint) return 'download';
  if (task.completedVideoUrl) return 'download';
  return null;
}

module.exports = { downloadFailureStage };
