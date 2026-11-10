'use strict';

const path = require('path');
const { fileNameForTag } = require('./tagNaming');
const { splitLabelPrefix } = require('./promptParser');

/**
 * FlowStudio Lite — SEQUENCE INTEGRITY report (v2.3.0, owner's order).
 *
 * The owner's biggest worry with bulk generation: videos save in a
 * sequence, and ONE missed or mis-named scene silently breaks the
 * whole chain. After a run, this report compares what the run was
 * SUPPOSED to produce (each task's tag) against what is ACTUALLY on
 * disk — task status alone is never trusted; the file itself must
 * exist, and in tag-naming mode it must carry its tag's name.
 *
 *   present   — task completed, file exists, name correct.
 *   missing   — task failed/cancelled/pending, OR completed but the
 *               file is gone from disk (deleted/moved).
 *   wrongName — file exists and IS this tag's video, but saved under
 *               a different name (e.g. a `-2` duplicate suffix or a
 *               scene-style name) — offered a one-click rename to the
 *               tag name when that name is free (never overwriting).
 *
 *   duplicateContent — (v2.48.35) two present files that are
 *               BYTE-IDENTICAL: one scene's video was saved
 *               under another scene's name (cross-task
 *               contamination). Only checked when the caller
 *               injects `hashOf(absPath)`; the run is NOT
 *               complete while any such pair exists.
 *
 * Pure module: `exists(absPath)` is injected (fs.existsSync in main,
 * a Set in tests).
 */

function displayTag(row) {
  const tag = row && typeof row.prompt_tag === 'string' ? row.prompt_tag.trim() : '';
  if (tag) return tag;
  const idx = row && Number.isInteger(row.prompt_index) ? row.prompt_index : 0;
  return `scene${String(idx + 1).padStart(3, '0')}`;
}

function buildSequenceReport(rows, { exists, namingMode = 'tag', hashOf } = {}) {
  const existsFn = typeof exists === 'function' ? exists : () => false;
  const hashFn = typeof hashOf === 'function' ? hashOf : null;
  // v2.48.78 (Item B): ek hi task row (ek hi id)
  // fehrist me do baar aa jaye to wo EK hi scene
  // hai — do missing kabhi nahi. (2026-11-10: ek
  // prompt ke do missing records ban gaye the.)
  const seenRowIds = new Set();
  const list = (Array.isArray(rows) ? rows : [])
    .filter(r => r && typeof r === 'object')
    .filter(r => {
      const id = String(r.id || '');
      if (!id) return true;
      if (seenRowIds.has(id)) return false;
      seenRowIds.add(id);
      return true;
    })
    .slice()
    .sort((a, b) => (a.prompt_index || 0) - (b.prompt_index || 0));

  const present = [];
  const missing = [];
  const wrongName = [];

  for (const row of list) {
    const tag = displayTag(row);
    const promptIndex = Number.isInteger(row.prompt_index) ? row.prompt_index : 0;
    const base = { taskId: String(row.id || ''), tag, promptIndex, promptText: row.prompt_text || '' };

    if (row.status !== 'completed') {
      const reason = row.status === 'failed'
        ? (row.error_reason || 'The task had failed')
        : row.status === 'cancelled'
          ? 'The task had been cancelled'
          : 'The task has not completed yet (pending/running)';
      missing.push({ ...base, reason });
      continue;
    }

    const filePath = typeof row.file_path === 'string' ? row.file_path : '';
    if (!filePath || !existsFn(filePath)) {
      missing.push({
        ...base,
        reason: 'The task was marked complete, but the video file was not found on disk (deleted/moved?) — it will have to be generated again'
      });
      continue;
    }

    if (namingMode === 'tag') {
      const ext = path.extname(filePath).replace(/^\./, '') || 'mp4';
      const canonical = fileNameForTag(tag, ext);
      const actual = path.basename(filePath);
      if (canonical && actual !== canonical) {
        // v2.10.0: app ke APNE dedupe suffix wala naam (-2, -3 —
        // tagNaming ka tay pattern, jo tab lagta hai jab asal naam
        // wali file pehle se maujood ho) GALAT NAAM nahi hai — ye
        // video POORA hai, bas usi ki jagah par suffix ke saath
        // save hua. Owner ke v2.8.0 run me do poori hui videos
        // (scene001-2 / scene004-2) isi galti se "0 poore · 2
        // GALAT NAAM" ginayi gayi thin — banner jhoota tha.
        const canonBase = canonical.slice(0, canonical.length - ext.length - 1);
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const family = new RegExp(`^${esc(canonBase)}-\\d+\\.${esc(ext)}$`);
        if (family.test(actual)) {
          present.push({ ...base, filePath, fileName: actual, suffixNote: true });
          continue;
        }
        const target = path.join(path.dirname(filePath), canonical);
        wrongName.push({
          ...base,
          filePath,
          currentName: actual,
          expectedName: canonical,
          canRename: !existsFn(target)
        });
        continue;
      }
    }
    present.push({ ...base, filePath, fileName: path.basename(filePath) });
  }

  // v2.48.35 (GUARD): do maujood files BYTE-IDENTICAL hon to
  // ek asal video dusre ke naam par save hua hai (ZEROCLICK2,
  // v2.48.34 par live pakda gaya cross-task contamination) —
  // jhooti "sab save ho gaya" kabhi nahi. hashOf ikhtiyari
  // hai: bulane wala asal files ka hash de to hi ye jaanch
  // chalti hai; hash na mile (null) wali file is jaanch se
  // bahar rehti hai. Hash khud report me KABHI nahi aata —
  // sirf jodiyon (pairs) ki pehchan aati hai.
  const duplicateContent = [];
  if (hashFn && present.length > 1) {
    const ownerByHash = new Map();
    for (const p of present) {
      let h = null;
      try { h = hashFn(p.filePath); } catch (e) { h = null; }
      if (!h || typeof h !== 'string') continue;
      const first = ownerByHash.get(h);
      if (!first) {
        ownerByHash.set(h, p);
      } else if (first.taskId !== p.taskId) {
        duplicateContent.push({
          a: { taskId: first.taskId, tag: first.tag, promptIndex: first.promptIndex, filePath: first.filePath },
          b: { taskId: p.taskId, tag: p.tag, promptIndex: p.promptIndex, filePath: p.filePath }
        });
      }
    }
  }

  return {
    total: list.length,
    presentCount: present.length,
    present,
    missing,
    wrongName,
    duplicateContent,
    complete: list.length > 0 && missing.length === 0 && wrongName.length === 0 && duplicateContent.length === 0
  };
}

/**
 * The re-queue items for [Sirf Missing Dobara Banao]: ONLY the
 * missing tasks, with their ORIGINAL prompt text, tag and index —
 * renumbering kabhi nahi, taaki dobara bane videos apni sahi jagah
 * (tag-naam) par hi save hon.
 *
 * v2.34.0 (Problem 5): the recreated task's TEXT is cleaned with
 * splitLabelPrefix — task rows stored before v2.34.0 still carry
 * their label inside prompt_text ("#00-01 A lighthouse…"), and a
 * redo submits that text to Flow again, so the label must come
 * out here too. The tag keeps the row's own identity; a row whose
 * tag was never stored recovers its label from the text instead
 * of falling back to a scene number.
 */
function selectMissingItems(rows, report) {
  const byId = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && r.id) byId.set(String(r.id), r);
  }
  const items = [];
  // v2.48.78 (Item B): report me ek hi task ki
  // missing entry do baar aa jaye to bhi recreated
  // item EK hi banta hai — ek scene, ek hi redo.
  const seenMissingIds = new Set();
  for (const m of (report && Array.isArray(report.missing)) ? report.missing : []) {
    const row = byId.get(String(m.taskId));
    if (!row) continue;
    const mid = String(m.taskId || '');
    if (mid) {
      if (seenMissingIds.has(mid)) continue;
      seenMissingIds.add(mid);
    }
    const parts = splitLabelPrefix(row.prompt_text || '');
    const ownTag = typeof row.prompt_tag === 'string' ? row.prompt_tag.trim() : '';
    items.push({
      text: parts.text,
      tag: ownTag || parts.label || displayTag(row),
      index: Number.isInteger(row.prompt_index) ? row.prompt_index : items.length
    });
  }
  return items.filter(i => i.text);
}

/**
 * v2.33.0 (missing-scene redo plan): split a report's missing scenes
 * into the two redo routes the owner approved —
 *   existingTaskIds: rows still 'pending' (above all the
 *     download-failed ones, which sit in pending + needs_check) —
 *     they re-enter runQueue AS THEMSELVES, so the check-only
 *     recovery downloads the already-made video and NO new charge
 *     can happen;
 *   recreateItems: rows that must be generated again (failed /
 *     cancelled, or marked complete but the file is gone) — fresh
 *     task rows built from selectMissingItems, carrying the
 *     ORIGINAL text, tag and index, so the redone scene lands on
 *     its own number, never a neighbour's.
 * Pure: the bridge route executes the plan; this decides it.
 */
function planRedo(rows, report) {
  const missingIds = new Set(
    ((report && Array.isArray(report.missing)) ? report.missing : [])
      .map(m => String(m.taskId))
  );
  const existingTaskIds = [];
  const recreateRows = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !missingIds.has(String(row.id))) continue;
    if (row.status === 'pending') existingTaskIds.push(row.id);
    else recreateRows.push(row);
  }
  return {
    existingTaskIds,
    recreateItems: selectMissingItems(recreateRows, report)
  };
}

module.exports = { buildSequenceReport, selectMissingItems, displayTag, planRedo };
