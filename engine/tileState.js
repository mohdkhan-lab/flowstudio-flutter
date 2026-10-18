'use strict';

/**
 * FlowStudio Lite — render tile state classifier (v2.4.0).
 *
 * WHY: on the owner's PC (2026-10-14, run 1) the log sat SILENT for
 * over four minutes while a paid render was in flight. The monitor
 * only spoke when a percentage changed or the 120s stall guard fired,
 * so the owner could not tell whether Flow was working, stuck, or had
 * refused. The tile's real condition was knowable all along — the
 * canvas read already reports isGenerating / isFailed / isReady per
 * tile — it was just never classified and narrated.
 *
 * This module turns one poll's facts into ONE named state per task,
 * and renders the plain-language line for it. Pure functions; the
 * monitor (flowAutomation.waitForAccountTasks) feeds it each poll and
 * logs on state changes + on the heartbeat cadence.
 *
 * States:
 *   'failed'         the task's tile shows a Flow failure — act now,
 *                    never wait out the recovery window for this.
 *   'ready'          the tile finished — download machinery takes it.
 *   'generating'     the tile exists and is rendering (progress mark
 *                    seen, or it was seen rendering before, or the tile
 *                    simply exists quietly — Flow tiles can sit
 *                    without a percentage while they render).
 *   'absent-active'  no tile bound to this task yet, but SOME tile on
 *                    the grid is generating — render activity exists,
 *                    this task's tile is still to be identified.
 *   'absent'         no tile, and the grid is quiet — Flow may not
 *                    have accepted/created the render at all.
 */

const STATES = ['failed', 'ready', 'generating', 'absent-active', 'absent'];

function classifyTaskTile(obs = {}) {
  const tile = obs.tile || null;
  if (tile) {
    if (tile.isFailed) return 'failed';
    if (tile.isReady) return 'ready';
    return 'generating';
  }
  if (obs.anyGenerating) return 'absent-active';
  return 'absent';
}

/** Plain duration for heartbeat lines: 65 -> '1 min 5 s'. */
function formatElapsed(totalSec) {
  const s = Math.max(0, Math.round(Number(totalSec) || 0));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/**
 * The one-line plain description of a task's state for the log /
 * Activity heartbeat. `facts`: { promptIndex, elapsedSec, percentage }
 * (percentage may be null). Never contains technical jargon.
 */
function describeState(state, facts = {}) {
  const n = (typeof facts.promptIndex === 'number' ? facts.promptIndex : 0) + 1;
  const waited = formatElapsed(facts.elapsedSec);
  switch (state) {
    case 'generating':
      return facts.percentage
        ? `[Prompt #${n}] The video is generating on Flow — ${facts.percentage} done, total wait ${waited}.`
        : `[Prompt #${n}] The video is generating on Flow — the tile is visible in the project, total wait ${waited} (sometimes Flow shows no percentage; the video still keeps generating).`;
    case 'ready':
      return `[Prompt #${n}] The video has been generated on Flow — now downloading (total time taken ${waited}).`;
    case 'failed':
      return `[Prompt #${n}] Flow has marked this video as failed — the reason is in the line below; there will be NO long wait for this one.`;
    case 'absent-active':
      return `[Prompt #${n}] This prompt's tile has not been identified yet, but something is generating on Flow (total ${waited}) — the search for the tile is continuing.`;
    case 'absent':
    default:
      return `[Prompt #${n}] Flow has not created any tile for this prompt yet (total ${waited}) — the prompt may not have been accepted on Flow at all; the tile search (recovery scan) is continuing.`;
  }
}

module.exports = { STATES, classifyTaskTile, describeState, formatElapsed };
