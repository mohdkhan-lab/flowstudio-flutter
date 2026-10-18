'use strict';

const path = require('path');
const { fileNameForTag } = require('./tagNaming');

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
 * Pure module: `exists(absPath)` is injected (fs.existsSync in main,
 * a Set in tests).
 */

function displayTag(row) {
  const tag = row && typeof row.prompt_tag === 'string' ? row.prompt_tag.trim() : '';
  if (tag) return tag;
  const idx = row && Number.isInteger(row.prompt_index) ? row.prompt_index : 0;
  return `scene${String(idx + 1).padStart(3, '0')}`;
}

function buildSequenceReport(rows, { exists, namingMode = 'tag' } = {}) {
  const existsFn = typeof exists === 'function' ? exists : () => false;
  const list = (Array.isArray(rows) ? rows : [])
    .filter(r => r && typeof r === 'object')
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

  return {
    total: list.length,
    presentCount: present.length,
    present,
    missing,
    wrongName,
    complete: list.length > 0 && missing.length === 0 && wrongName.length === 0
  };
}

/**
 * The re-queue items for [Sirf Missing Dobara Banao]: ONLY the
 * missing tasks, with their ORIGINAL prompt text, tag and index —
 * renumbering kabhi nahi, taaki dobara bane videos apni sahi jagah
 * (tag-naam) par hi save hon.
 */
function selectMissingItems(rows, report) {
  const byId = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && r.id) byId.set(String(r.id), r);
  }
  const items = [];
  for (const m of (report && Array.isArray(report.missing)) ? report.missing : []) {
    const row = byId.get(String(m.taskId));
    if (!row) continue;
    items.push({
      text: row.prompt_text || '',
      tag: displayTag(row),
      index: Number.isInteger(row.prompt_index) ? row.prompt_index : items.length
    });
  }
  return items.filter(i => i.text);
}

module.exports = { buildSequenceReport, selectMissingItems, displayTag };
