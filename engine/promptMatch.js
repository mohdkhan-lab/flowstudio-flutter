'use strict';

/**
 * FlowStudio Lite — duplicate-submission guard matching (v2.4.0).
 *
 * WHY: on the owner's PC (2026-10-14) a prompt was submitted, the app
 * was stopped mid-flight, and he pressed Generate on the SAME prompt
 * again. The app created a brand-new task and Flow charged credits a
 * SECOND time for a render that was already paid for (25 -> 20 for
 * nothing). The Resume banner existed, but nothing warned him at the
 * Generate button itself.
 *
 * This module is the matcher behind the guard: given the prompts
 * about to be pasted into a new run and the queue's still-open tasks
 * (pending / running — needs_check rows are pending by construction),
 * it reports which pasted prompts are already in flight. Matching is
 * on NORMALIZED text (case, whitespace and trailing punctuation are
 * not differences a human would mean), never on substrings — a
 * shorter or longer prompt is a different prompt.
 *
 * Pure functions, unit-tested.
 */

function normalizePromptText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * prompts: array of strings or { text } items (the smart parser's
 * shape). openRows: queue task rows with at least { id, prompt_text,
 * status, needs_check, prompt_index }.
 *
 * Returns one entry per pasted prompt that matches an open task:
 *   { index, text, taskId, status, needsCheck, promptIndex }
 * `index` is the pasted prompt's position, so the caller can warn
 * per-prompt while letting non-duplicates through untouched.
 */
function findPendingDuplicates(prompts, openRows) {
  const openByText = new Map();
  for (const row of Array.isArray(openRows) ? openRows : []) {
    if (!row || !row.prompt_text) continue;
    const st = String(row.status || '');
    if (st !== 'pending' && st !== 'running') continue;
    const key = normalizePromptText(row.prompt_text);
    if (!key) continue;
    if (!openByText.has(key)) {
      openByText.set(key, {
        taskId: row.id || null,
        status: st,
        needsCheck: !!row.needs_check,
        promptIndex: Number.isInteger(row.prompt_index) ? row.prompt_index : null
      });
    }
  }
  const out = [];
  (Array.isArray(prompts) ? prompts : []).forEach((p, index) => {
    const text = (p && typeof p === 'object') ? String(p.text || '') : String(p || '');
    const key = normalizePromptText(text);
    if (!key) return;
    const hit = openByText.get(key);
    if (hit) out.push({ index, text, ...hit });
  });
  return out;
}

module.exports = { normalizePromptText, findPendingDuplicates };
