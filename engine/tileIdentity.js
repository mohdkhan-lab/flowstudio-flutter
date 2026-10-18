'use strict';

/**
 * FlowStudio Lite — tile identity (v1.5.0).
 *
 * WHY THIS MODULE EXISTS (the multi-video bug): with ONE prompt in the
 * grid, any tile-matching scheme works. With SEVERAL prompts rendering
 * in the same project grid, the old scheme broke three ways:
 *   1. Tasks tracked tiles by raw DOM index — a new submission inserts
 *      a tile and every later index shifts, so a task ended up watching
 *      (and downloading) a NEIGHBOUR's tile.
 *   2. Claiming needed only TWO shared words (len > 2 — "the", "and",
 *      "with" counted) between a tile's text and a task's prompt, so
 *      paragraph prompts built from one template claimed each other's
 *      tiles almost at random.
 *   3. The pre-existing-tile guard switched itself off as soon as the
 *      grid grew, so a task could "complete" against an old tile from
 *      a previous session and fail its download identity check — or
 *      worse, save the old video under the new prompt's file name.
 *
 * The replacement, all pure functions (unit-tested):
 *   - A tile's identity is a FINGERPRINT: its normalized aria-label
 *     (Flow puts the generation prompt there), never its index.
 *   - A task binds to its tile AT SUBMIT TIME when the new tile is
 *     first seen (submitPrompt), else the monitor claims it by a
 *     strict score: at least MIN_MATCHED significant words in common
 *     AND a containment precision of at least MIN_PRECISION (matched /
 *     the SMALLER word set — Flow routinely expands a short prompt
 *     into a longer descriptive title, so dividing by the tile's full
 *     word count made a task's own tile unclaimable; the replica
 *     harness proved it), AND the tile must beat every sibling task's
 *     score for it (distinctiveness margin).
 *   - Tiles whose fingerprint was already in the grid when the task
 *     was submitted (its pre-existing snapshot) are NEVER claimable
 *     by that task, no matter how the grid grows afterwards.
 *   - v2.4.0: prompts too short to EVER reach the strict threshold
 *     ("make a video" — one significant word) get exactly one fenced
 *     exception, Pass 3 in assignTiles: when the task is the
 *     account's ONLY in-flight submission, a tile that was not in
 *     its pre-submit snapshot may be bound by order/timing alone.
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'over',
  'under', 'between', 'through', 'while', 'video', 'clip', 'shot',
  'scene', 'footage', 'camera', 'angle', 'view', 'style', 'cinematic',
  'photorealistic', 'realistic', 'vertical', 'horizontal', 'seconds',
  'second', 'duration', 'quality', 'her', 'his', 'its', 'their', 'she',
  'him', 'them', 'they', 'are', 'was', 'were', 'has', 'have', 'had',
  'will', 'would', 'can', 'could', 'one', 'two', 'all', 'any', 'out',
  'about', 'after', 'before', 'when', 'where', 'which', 'who', 'what'
]);

const MIN_MATCHED = 4;     // significant words the tile and prompt must share
const MIN_PRECISION = 0.6; // containment: matched / min(tile words, prompt words)

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function significantWords(text) {
  const out = new Set();
  for (const w of normalizeText(text).split(' ')) {
    if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/** A tile's stable identity: its normalized aria-label (the prompt). */
function tileFingerprint(ariaText, fallbackText) {
  const aria = normalizeText(ariaText);
  if (aria) return aria;
  return normalizeText(fallbackText).substring(0, 120);
}

/**
 * Score how strongly a tile belongs to a prompt.
 * Returns { matched, precision } — matched = significant words shared
 * with the prompt; precision = containment = matched / the smaller of
 * (tile words, prompt words). Containment (not tile-side precision)
 * because Flow's tile titles are frequently LONGER than the prompt
 * that created them (it expands "dog running in park" into "a golden
 * dog running in a green park on a sunny day"): tile-side precision
 * scored that tile 4/7 = 0.57 against its own prompt and rejected it.
 */
function scoreTileForPrompt(promptWords, tileWords) {
  if (!promptWords || !tileWords || tileWords.size === 0 || promptWords.size === 0) return { matched: 0, precision: 0 };
  let matched = 0;
  for (const w of tileWords) {
    if (promptWords.has(w)) matched++;
  }
  return { matched, precision: matched / Math.min(tileWords.size, promptWords.size) };
}

function isStrongMatch(score) {
  return score.matched >= MIN_MATCHED && score.precision >= MIN_PRECISION;
}

/**
 * v2.4.0 — a WEAK-TEXT prompt: fewer significant words than the strict
 * claim threshold (MIN_MATCHED). "make a video" has exactly ONE
 * significant word ('make' — 'video' is a stopword, 'a' is too short),
 * so NO tile could ever score-match it, however faithfully Flow
 * rendered it: on the owner's PC (2026-10-14) the tile sat in the
 * project generating while the task watched, unbindable, until the
 * owner stopped the run. Weak-text prompts are eligible for the
 * order/timing fallback in assignTiles — under strict conditions
 * (see Pass 3 there), never as a general loosening.
 */
function isWeakTextPrompt(promptWords) {
  return !promptWords || promptWords.size < MIN_MATCHED;
}

/**
 * Assign tiles to tasks for one monitor poll.
 *
 * tasks: [{ key, promptWords:Set, preExistingFingerprints:Set,
 *           lockedFingerprint:string|null }]
 * tiles: [{ tileIndex, fingerprint, words:Set }]
 * claimedFingerprints: Set of fingerprints already bound to tasks that
 * are NOT in this call (e.g. tasks from another worker window sharing
 * the engine — normally empty, kept for safety).
 *
 * Returns Map(taskKey -> tile). Rules, in order:
 *  1. A task with a lockedFingerprint re-binds to the tile carrying
 *     that exact fingerprint (index-independent — grid shifts and
 *     insertions cannot cross wires), unless that tile is in the
 *     task's pre-existing set (paranoia: never bind to history).
 *  2. Each remaining tile goes to at most one task; each task takes
 *     at most one tile. A tile is claimable by a task only when it is
 *     not in that task's pre-existing set and the match is strong.
 *     Among competing strong tasks, the tile goes to the one with the
 *     highest matched count, provided it strictly beats the runner-up
 *     (a tie means the tile is ambiguous — leave it unclaimed this
 *     poll rather than guess; later polls re-score with more text).
 */
function assignTiles(tasks, tiles, claimedFingerprints) {
  const result = new Map();
  const usedTiles = new Set();
  const external = claimedFingerprints || new Set();

  // Pass 1: fingerprint re-binding.
  for (const task of tasks) {
    if (!task.lockedFingerprint) continue;
    if (task.preExistingFingerprints && task.preExistingFingerprints.has(task.lockedFingerprint)) continue;
    const tile = tiles.find(t => t.fingerprint === task.lockedFingerprint && !usedTiles.has(t.tileIndex));
    if (tile) {
      result.set(task.key, tile);
      usedTiles.add(tile.tileIndex);
    }
  }

  // Pass 2: scored claiming with a strict-win margin.
  const freeTasks = tasks.filter(t => !result.has(t.key));
  const candidates = [];
  for (const task of freeTasks) {
    for (const tile of tiles) {
      if (usedTiles.has(tile.tileIndex)) continue;
      if (external.has(tile.fingerprint)) continue;
      if (task.preExistingFingerprints && task.preExistingFingerprints.has(tile.fingerprint)) continue;
      const score = scoreTileForPrompt(task.promptWords, tile.words);
      if (isStrongMatch(score)) {
        candidates.push({ taskKey: task.key, tile, matched: score.matched, precision: score.precision });
      }
    }
  }
  // Greedy: strongest (matched, then precision) first; a tile claimed by
  // an earlier candidate is gone; a task takes only one tile.
  candidates.sort((a, b) => (b.matched - a.matched) || (b.precision - a.precision));
  const takenTasks = new Set(result.keys());
  const takenTiles = new Set(usedTiles);
  // For the strict-win rule, precompute each tile's best two scores.
  const scoresByTile = new Map();
  for (const c of candidates) {
    if (!scoresByTile.has(c.tile.tileIndex)) scoresByTile.set(c.tile.tileIndex, []);
    scoresByTile.get(c.tile.tileIndex).push(c);
  }
  for (const c of candidates) {
    if (takenTasks.has(c.taskKey) || takenTiles.has(c.tile.tileIndex)) continue;
    const rivals = (scoresByTile.get(c.tile.tileIndex) || [])
      .filter(r => r.taskKey !== c.taskKey && !takenTasks.has(r.taskKey));
    const bestRival = rivals.length ? Math.max(...rivals.map(r => r.matched)) : 0;
    if (c.matched <= bestRival) continue; // ambiguous — do not guess
    takenTasks.add(c.taskKey);
    takenTiles.add(c.tile.tileIndex);
    result.set(c.taskKey, c.tile);
  }

  // Pass 3 (v2.4.0) — ORDER/TIMING FALLBACK for weak-text prompts.
  // A weak-text task (see isWeakTextPrompt) can NEVER pass the scored
  // claim, so without this pass its tile is unbindable forever. The
  // fallback binds it to a NEW tile purely by order/timing, and it is
  // fenced by ALL of these conditions at once:
  //   - it fires only when this poll carries EXACTLY ONE task — the
  //     task is the account's ONLY in-flight submission, so any new
  //     tile can only be its own (with a sibling in flight, a new
  //     tile could be the sibling's and the fallback stays OFF);
  //   - the task is still unbound after passes 1–2;
  //   - the tile was NOT in the task's pre-submit snapshot
  //     (preExistingFingerprints) — a pre-existing tile is history,
  //     never this task's render, no matter how well it would fit;
  //   - the tile is not externally claimed and not already assigned.
  // The FIRST such tile in grid order wins (Flow parks the newest
  // tiles at the top of the grid). The caller records the claim in
  // claimedTileFingerprints exactly like a scored claim, so no other
  // task can take the tile afterwards.
  if (tasks.length === 1) {
    const task = tasks[0];
    if (!result.has(task.key) && isWeakTextPrompt(task.promptWords)) {
      const fallbackTiles = tiles
        .filter(t => !takenTiles.has(t.tileIndex)
          && !usedTiles.has(t.tileIndex)
          && !external.has(t.fingerprint)
          && !(task.preExistingFingerprints && task.preExistingFingerprints.has(t.fingerprint)))
        .sort((a, b) => a.tileIndex - b.tileIndex);
      if (fallbackTiles.length > 0) {
        result.set(task.key, fallbackTiles[0]);
      }
    }
  }

  return result;
}

module.exports = {
  STOPWORDS,
  MIN_MATCHED,
  MIN_PRECISION,
  normalizeText,
  significantWords,
  tileFingerprint,
  scoreTileForPrompt,
  isStrongMatch,
  isWeakTextPrompt,
  assignTiles
};
