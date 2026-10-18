'use strict';

/**
 * FlowStudio Lite — Stall watch (v2.1.0).
 *
 * The decision logic behind the generation monitor's in-run stall
 * recovery (owner's PC test, 2026-10-14: a prompt was SUBMITTED, its
 * credits were charged, Flow was simply slow to show the render tile —
 * and the old 120-second anti-stall guard failed the task outright.
 * The paid render was abandoned and, with only one account present,
 * the task died with "(no usable account remained)").
 *
 * The rule now: a submitted render whose tile has not been identified
 * yet is NEVER failed on the first stall sighting. It enters RECOVERY:
 * the monitor keeps polling the project grid (with fingerprint scans
 * and scroll sweeps, see flowAutomation.waitForAccountTasks) for a
 * generous window, reporting progress as it goes. Only when the whole
 * recovery window passes with no tile does the task fail — with a
 * reason that says the recovery was attempted.
 *
 * This module is pure decision logic: the state lives on the task
 * object itself (task._stall) so it survives across the pool's
 * repeated waitForAccountTasks calls for the same window of tasks.
 * No I/O, no timers — the caller passes `now` in, which keeps the
 * whole thing unit-testable.
 */

const DEFAULT_PROGRESS_EVERY_SEC = 30;

/**
 * Observe one task for one monitor poll.
 *
 * @param {object} task  the in-flight task object (state is kept on it)
 * @param {object} obs
 * @param {boolean} obs.stalled  the stall CONDITION this poll: the task
 *        was submitted a while ago, no tile is bound to it, nothing on
 *        this account is generating, and it was never seen generating.
 * @param {boolean} obs.hasTile  a tile is bound to the task this poll.
 * @param {number} obs.now  Date.now() of this poll.
 * @param {number} obs.recoveryWindowMs  how long recovery may run.
 * @param {number} [obs.progressEveryMs]  progress-log cadence.
 * @returns {{type:string, recoveryForSec?:number, logDue?:boolean}}
 *   'none'             — nothing to do/log this poll
 *   'recovery-started' — the stall began; recovery is now running
 *   'recovery-progress'— still stalled, still inside the window;
 *                        logDue says a progress line is due
 *   'recovered'        — a tile appeared while recovery was running
 *   'give-up'          — the recovery window is exhausted; fail now
 */
function observeStall(task, obs) {
  if (!task || typeof task !== 'object') return { type: 'none' };
  const nowNum = Number(obs && obs.now);
  const now = Number.isFinite(nowNum) ? nowNum : Date.now();
  const recoveryWindowMs = Math.max(1000, Number(obs && obs.recoveryWindowMs) || 600000);
  const progressEveryMs = Math.max(1000, Number(obs && obs.progressEveryMs) || DEFAULT_PROGRESS_EVERY_SEC * 1000);
  // recoverySince is null (not 0) when idle: 0 is a legitimate clock
  // reading in tests, and a falsy sentinel would restart the window.
  const st = task._stall || (task._stall = { recoverySince: null, lastProgressAt: 0, gaveUp: false });

  if (obs && obs.hasTile) {
    if (st.recoverySince != null && !st.gaveUp) {
      const recoveryForSec = Math.round((now - st.recoverySince) / 1000);
      st.recoverySince = null;
      st.lastProgressAt = 0;
      return { type: 'recovered', recoveryForSec };
    }
    return { type: 'none' };
  }

  if (st.gaveUp) return { type: 'none' };
  if (!obs || !obs.stalled) return { type: 'none' };

  if (st.recoverySince == null) {
    st.recoverySince = now;
    st.lastProgressAt = now;
    return { type: 'recovery-started', recoveryForSec: 0 };
  }

  const recoveryForMs = now - st.recoverySince;
  if (recoveryForMs >= recoveryWindowMs) {
    st.gaveUp = true;
    return { type: 'give-up', recoveryForSec: Math.round(recoveryForMs / 1000) };
  }

  let logDue = false;
  if (now - st.lastProgressAt >= progressEveryMs) {
    st.lastProgressAt = now;
    logDue = true;
  }
  return { type: 'recovery-progress', recoveryForSec: Math.round(recoveryForMs / 1000), logDue };
}

/** True while this task is inside its stall-recovery window. */
function isInRecovery(task) {
  return !!(task && task._stall && task._stall.recoverySince != null && !task._stall.gaveUp);
}

/** Drop the stall state (task finished one way or another). */
function clearStall(task) {
  if (task && task._stall) task._stall = { recoverySince: null, lastProgressAt: 0, gaveUp: false };
}

/** '2 min 5 s' / '45 s' — plain duration text for logs and Activity. */
function formatDuration(totalSec) {
  const s = Math.max(0, Math.round(Number(totalSec) || 0));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

module.exports = { observeStall, isInRecovery, clearStall, formatDuration, DEFAULT_PROGRESS_EVERY_SEC };
