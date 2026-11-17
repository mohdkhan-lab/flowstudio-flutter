'use strict';

// ---------------------------------------------------------------------------
// v2.48.111 (F1) — SUPERVISOR RESPAWN DISCIPLINE (pure logic, fake-clock
// testable).
//
// The field failure behind this module (GOPAL-W3-1117 on v2.48.110,
// 2026-11-17): the G2 supervisor respawned a replacement worker within
// ~400 ms whenever the live-worker count sat below the parallel target
// and the queue was non-empty — with no backoff, no cap and no memory
// that account-finding had JUST failed. With only 3 bindable accounts
// and a target of 4, the 4th slot churned through workers #3…#216+ in
// ~80 seconds, flooding the log and starving everything else.
//
// This guard is the supervisor's memory. It is fed two signals:
//   · worker exits — an "instant no-account exit" (the worker never
//     bound an account and left at once: the churn signature) versus
//     any other exit (a worker that bound an account / did work: the
//     account picture changed, churn memory resets), and
//   · target raises — the owner RAISED the parallel setting mid-run
//     (G2's headline behaviour): a raise earns an immediate spawn
//     attempt, cooldown or not.
// and answers one question per spawn decision: may a replacement
// worker spawn now?
//
// The rules (owner-approved shape):
//   · After CONSECUTIVE_LIMIT (2) consecutive instant no-account
//     exits, replacements pause until a productive exit or a
//     cooldown passes: BASE_BACKOFF_MS (15s), doubling per renewed
//     trip, capped at MAX_BACKOFF_MS (60s).
//   · Replacement spawns are hard-capped per run at
//     MAX_REPLACEMENT_SPAWNS (30). Beyond the cap the supervisor
//     logs ONE clear line and the run finishes on its bound workers.
//   · Initial spawns (the run's starting set) are never the guard's
//     business: not counted, never blocked.
// ---------------------------------------------------------------------------

const BASE_BACKOFF_MS = 15000; // first cooldown after a churn trip
const MAX_BACKOFF_MS = 60000; // cooldown ceiling (exponential backoff)
const CONSECUTIVE_LIMIT = 2; // instant no-account exits that trip a cooldown
const MAX_REPLACEMENT_SPAWNS = 30; // hard per-run cap on replacement spawns

function createRespawnGuard(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const baseBackoffMs = Math.max(0, Number.isFinite(Number(o.baseBackoffMs)) ? Number(o.baseBackoffMs) : BASE_BACKOFF_MS);
  const maxBackoffMs = Math.max(baseBackoffMs, Number.isFinite(Number(o.maxBackoffMs)) ? Number(o.maxBackoffMs) : MAX_BACKOFF_MS);
  const consecutiveLimit = Math.max(1, Number.isFinite(Number(o.consecutiveLimit)) ? Math.floor(Number(o.consecutiveLimit)) : CONSECUTIVE_LIMIT);
  const maxReplacementSpawns = Math.max(0, Number.isFinite(Number(o.maxReplacementSpawns)) ? Math.floor(Number(o.maxReplacementSpawns)) : MAX_REPLACEMENT_SPAWNS);

  let consecutiveInstant = 0;
  let backoffMs = baseBackoffMs;
  let cooldownUntil = 0;
  let replacementSpawns = 0;

  return {
    /**
     * A worker was spawned. Initial spawns (isReplacement falsy) are
     * ignored by the guard; replacements count against the cap.
     */
    noteSpawn(isReplacement) {
      if (isReplacement) replacementSpawns++;
    },

    /**
     * A worker exited having never bound an account — the churn
     * signature. Consecutive trips arm the cooldown (and grow the
     * next backoff, exponentially, up to the ceiling).
     */
    noteInstantNoAccountExit(now) {
      consecutiveInstant++;
      if (consecutiveInstant >= consecutiveLimit) {
        cooldownUntil = now + backoffMs;
        backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
      }
    },

    /**
     * A worker that bound an account (or otherwise did real work)
     * exited: the account picture changed, so churn memory resets —
     * the next spawn attempt is judged fresh.
     */
    noteProductiveExit() {
      consecutiveInstant = 0;
      backoffMs = baseBackoffMs;
      cooldownUntil = 0;
    },

    /**
     * The parallel target ROSE mid-run (the owner's G2 raise): the
     * cooldown never blocks a raise — clear it so the supervisor's
     * next cycle may spawn at once. (If that spawn also exits
     * instantly, the exits re-arm the guard on their own.)
     */
    noteTargetRaise() {
      cooldownUntil = 0;
    },

    /**
     * May a worker spawn at `now`? Initial spawns always may.
     * Replacements are refused at the hard cap first, then while a
     * churn cooldown is running.
     *   { ok: true }
     *   { ok: false, reason: 'cap' | 'cooldown', retryAt }
     */
    canSpawn(now, isReplacement) {
      if (!isReplacement) return { ok: true };
      if (replacementSpawns >= maxReplacementSpawns) {
        return { ok: false, reason: 'cap', retryAt: null };
      }
      if (now < cooldownUntil) {
        return { ok: false, reason: 'cooldown', retryAt: cooldownUntil };
      }
      return { ok: true };
    },

    get consecutiveInstant() { return consecutiveInstant; },
    get replacementSpawns() { return replacementSpawns; },
    get cooldownUntil() { return cooldownUntil; },
    get capReached() { return replacementSpawns >= maxReplacementSpawns; }
  };
}

module.exports = {
  createRespawnGuard,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  CONSECUTIVE_LIMIT,
  MAX_REPLACEMENT_SPAWNS
};
