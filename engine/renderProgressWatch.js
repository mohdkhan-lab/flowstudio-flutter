'use strict';

/**
 * FlowStudio Lite — render progress watchdog (v2.6.0).
 *
 * WHY: on the owner's PC (2026-10-14, v2.5.0 Background run) both
 * renders were identified, bound and "generating" — at 1% — and then
 * NOTHING moved for 8+ minutes. The v2.4.0 state classifier narrated
 * "video ban raha hai" but nobody was watching whether the progress
 * itself had stopped. A frozen percentage is a THIRD kind of stall
 * (the tile exists, so stallWatch's missing-tile recovery never
 * engages, and the tile is not failed, so the fast-fail never fires).
 *
 * This module watches ONE thing: while a task's tile is in the
 * 'generating' state, has its progress signal moved? The progress
 * signal is the tile's percentage string. If it does not change for
 * `stallAfterMs` (production: 3 minutes), the watchdog fires ONCE
 * per frozen episode — the monitor turns that into a Log line plus
 * an Activity entry (stage 'render-stall') with the elapsed time,
 * the last percentage and the plain possible causes. It never fails
 * anything by itself: Flow can legitimately sit on one percentage
 * for a while on a busy day. The run's overall wait (the monitor
 * deadline + its final recovery sweeps) remains the thing that ends
 * a truly dead render — the watchdog's job is that the owner HEARS
 * about the freeze at minute 3, in plain words, instead of staring
 * at a silent "Generating" for ten.
 *
 * A tile that never shows ANY percentage also arms the watch (its
 * lastChangeAt starts at the first generating sighting) — the
 * warning then honestly says no percentage was ever shown.
 *
 * If Flow's tile carries its own words (queue / high demand), they
 * are quoted in the warning — see queueHintFromText.
 *
 * Pure decision logic, stallWatch style: state lives on the task
 * (task._progress), the caller passes `now` in. No I/O, no timers.
 */

const DEFAULT_STALL_AFTER_MS = 3 * 60 * 1000;

/**
 * Best-effort: does the tile's own text say Flow is queueing / busy?
 * The canvas read strips the prompt's own text out of `text`, so
 * these matches are Flow's chrome words, not the user's prompt.
 * Returns a short quoted hint or null.
 */
function queueHintFromText(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/\bqueue\b/.test(t) || t.includes('in line')) return 'The Flow tile shows a queue (line) state';
  if (t.includes('high demand') || t.includes('lots of people') || t.includes('many people')) return 'The Flow tile shows a high-demand state';
  if (t.includes('try again later') || t.includes('come back later')) return 'The Flow tile shows a "try again later" type of state';
  if (t.includes('taking longer') || t.includes('longer than usual')) return 'The Flow tile itself says it is taking longer than usual';
  return null;
}

/**
 * Observe one task for one monitor poll.
 *
 * @param {object} task  in-flight task (state kept on task._progress)
 * @param {object} obs
 * @param {string} obs.state  tileState state this poll ('generating'…)
 * @param {string|null} obs.percentage  the tile's percentage ('1%')
 * @param {string} [obs.tileText]  the tile's chrome text (queue hint)
 * @param {number} obs.now  Date.now() of this poll
 * @param {number} [obs.stallAfterMs]  freeze budget (default 3 min)
 * @returns {{type:string, stuckForSec?:number, lastPct?:string|null,
 *            queueHint?:string|null, elapsedSec?:number}}
 *   'none'     — nothing to report this poll
 *   'progress' — the percentage moved; the episode clock reset
 *   'stalled'  — frozen for the whole budget; warn (once per episode)
 */
function observeProgress(task, obs) {
  if (!task || typeof task !== 'object' || !obs) return { type: 'none' };
  const nowNum = Number(obs.now);
  const now = Number.isFinite(nowNum) ? nowNum : Date.now();
  const stallAfterMs = Math.max(1000, Number(obs.stallAfterMs) || DEFAULT_STALL_AFTER_MS);
  // lastChangeAt is null (not 0) when idle — 0 is a legitimate clock
  // reading in tests, and a falsy sentinel would restart the clock.
  const st = task._progress || (task._progress = { lastPct: undefined, lastChangeAt: null, warned: false });

  if (obs.state !== 'generating') {
    // Only a bound, rendering tile can freeze. Any other state ends
    // the episode quietly — the next generating stretch starts fresh.
    st.lastPct = undefined;
    st.lastChangeAt = null;
    st.warned = false;
    return { type: 'none' };
  }

  const pct = (obs.percentage === undefined) ? null : obs.percentage;

  if (st.lastChangeAt == null) {
    // First generating sighting — arm the watch.
    st.lastPct = pct;
    st.lastChangeAt = now;
    st.warned = false;
    return { type: 'none' };
  }

  if (pct !== null && pct !== st.lastPct) {
    st.lastPct = pct;
    st.lastChangeAt = now;
    st.warned = false;
    return { type: 'progress' };
  }

  const frozenMs = now - st.lastChangeAt;
  if (frozenMs >= stallAfterMs && !st.warned) {
    st.warned = true;
    return {
      type: 'stalled',
      stuckForSec: Math.round(frozenMs / 1000),
      lastPct: st.lastPct,
      queueHint: queueHintFromText(obs.tileText)
    };
  }
  return { type: 'none' };
}

/** Drop the progress-watch state (task finished one way or another). */
function clearProgress(task) {
  if (task && task._progress) task._progress = { lastPct: undefined, lastChangeAt: null, warned: false };
}

module.exports = { observeProgress, clearProgress, queueHintFromText, DEFAULT_STALL_AFTER_MS };
