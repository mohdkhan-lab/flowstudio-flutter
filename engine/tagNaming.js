'use strict';

const path = require('path');

/**
 * FlowStudio Lite — tag-based download naming (v2.3.0, owner's order).
 *
 * Default naming is now BY THE PROMPT'S TAG: the tag the smart parser
 * found in the paste (`#00-01`, `scene3`, `prompt2`, `1`) becomes the
 * file name (`00-01.mp4`, `scene3.mp4`, …), so a downloaded sequence
 * lines up with the prompt list the owner pasted. The old
 * scene001-style naming remains available as a Settings option.
 *
 * Duplicate protection (demand 2): a save NEVER overwrites a file the
 * current run did not itself produce —
 *   (a) a name already sitting in the output folder (e.g. a previous
 *       run's video) pushes this save to a deterministic `-2`, `-3`…
 *       suffix;
 *   (b) two prompts in the SAME run carrying the same tag get the
 *       same treatment, so BOTH videos survive;
 *   (c) a path THIS TASK itself saved may be reused by that same
 *       task (a download retry re-save), mirroring the legacy picker.
 *
 * v2.32.1 BUG FIX: rule (c) used to be fed the engine's SESSION-WIDE
 * saved-paths set, which cannot tell tasks apart. A run whose prompts
 * all share one tag (e.g. one MCP run tag stamped on every prompt)
 * computed the same file name for every task; the first task's save
 * put that path in the session set, so every later task was handed
 * the SAME path as its own "re-save" and overwrote the previous
 * video — 5 prompts, 1 surviving file, live-proven 2026-10-26.
 * Callers must now pass ONLY the saving task's own paths as
 * `ownPaths` (see pickFreeTagPath). The engine additionally numbers
 * shared-tag files by prompt (numberedTagFileName), so same-tag
 * siblings get `<tag>-1.mp4` … `<tag>-5.mp4` deterministically.
 * The legacy scene picker (_pickFreeFilePath, `_2` suffix) is NOT
 * touched; this module is used only for tag-named saves.
 */

/**
 * Tag -> filename base. The tag is used AS WRITTEN (owner's naming
 * rule, 2026-10-16): `#00-01` -> `#00-01`, `scene3` -> `scene3`,
 * `Scene 1` -> `Scene1`, `PROMPT #1` -> `PROMPT1`. A LEADING `#`
 * is kept (he wrote the tag with it, the file keeps it); `#` signs
 * elsewhere are dropped. Returns '' when nothing usable remains
 * (the caller falls back to scene naming).
 */
function sanitizeTagBase(tag) {
  if (tag === null || tag === undefined) return '';
  let s = String(tag).trim();
  if (!s) return '';
  const lead = s.startsWith('#') ? '#' : '';
  s = s.replace(/#/g, '');
  s = s.replace(/[<>:\"/\\|?*\x00-\x1F]/g, '');
  s = s.replace(/\s+/g, '');
  s = s.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!s) return '';
  return lead + s;
}

// v2.33.0 (owner's Problem 4 amendment to the 2026-10-16 rule): a
// NUMERIC label's number is zero-padded to 3 digits in the file
// name, so a project folder sorts in true numeric order (scene 2
// never lands after scene 10). Applies to: a bare number (`3` ->
// `003`), a bare hash number (`#1` -> `#001`), and word+number
// labels whose word is a known label stem (`Scene 1` -> `Scene001`,
// `Prompt 01` -> `Prompt001`, `SCENE_001` stays `SCENE_001`).
// NOT touched, by the owner's own formats: dash forms stay exactly
// as written (`#00-01`, `SHOT-001` — his hash ranges are already
// two-digit groups), and tags whose word is not a label stem keep
// their literal form (`Ep11` stays `Ep11`, `Cinematic` has no
// number at all). The rule lives HERE, inside fileNameForTag, so
// the engine, the shared-tag group counter and the sequence report
// — all of which call fileNameForTag — always agree on the name.
const NUMERIC_LABEL_STEMS = new Set([
  'scene', 'shot', 'clip', 'prompt', 'imageprompt', 'videoprompt', 'image', 'video'
]);

function padNumericTail(base) {
  let m = base.match(/^#([0-9]+)$/);
  if (m) return `#${m[1].padStart(3, '0')}`;
  m = base.match(/^([0-9]+)$/);
  if (m) return m[1].padStart(3, '0');
  m = base.match(/^([A-Za-z]+)([0-9]+)$/);
  if (m && NUMERIC_LABEL_STEMS.has(m[1].toLowerCase())) {
    return m[1] + m[2].padStart(3, '0');
  }
  m = base.match(/^([A-Za-z_]+?)([0-9]+)$/);
  if (m && NUMERIC_LABEL_STEMS.has(m[1].replace(/_/g, '').toLowerCase())) {
    return m[1] + m[2].padStart(3, '0');
  }
  return base;
}

/** Full file name for a tag, or null when the tag has no usable base. */
function fileNameForTag(tag, ext = 'mp4') {
  const base = padNumericTail(sanitizeTagBase(tag));
  if (!base) return null;
  const cleanExt = String(ext || 'mp4').replace(/^\./, '').replace(/[^a-zA-Z0-9]/g, '') || 'mp4';
  return `${base}.${cleanExt}`;
}

/**
 * The prompt-numbered variant of a tag file name (v2.32.1): when a
 * run carries MORE THAN ONE task with the same tag, each task's file
 * is named by its own prompt number — `diag5.mp4` becomes
 * `diag5-1.mp4` … `diag5-5.mp4` — so the name↔prompt mapping is
 * stable no matter which download finishes first. (The sequence
 * report's `-N` family rule already treats these as correct names.)
 */
function numberedTagFileName(fileName, promptNumber) {
  const name = String(fileName || '');
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  const n = Number.isInteger(promptNumber) && promptNumber > 0 ? promptNumber : 1;
  return `${base}-${n}${ext}`;
}

/**
 * Choose a save path for `fileName` inside `folder` that never
 * overwrites a foreign file. `existsFn(absPath)` and `ownPaths` are
 * injected so the rule is unit-testable without a disk.
 *
 * CONTRACT (v2.32.1): `ownPaths` must contain ONLY the paths saved
 * for the very task this save belongs to. Paths in `ownPaths` are
 * treated as freely reusable (a retry re-saving its own file);
 * passing paths saved by OTHER tasks makes this picker hand the
 * same path to several tasks and each save overwrites the previous
 * one — that was the session-wide-set bug fixed in v2.32.1.
 */
function pickFreeTagPath(folder, fileName, existsFn, ownPaths) {
  const exists = typeof existsFn === 'function' ? existsFn : () => false;
  const own = ownPaths && typeof ownPaths.has === 'function' ? ownPaths : new Set();
  const first = path.join(folder, fileName);
  if (!exists(first) || own.has(first)) return first;
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  for (let n = 2; n < 1000; n++) {
    const alt = path.join(folder, `${base}-${n}${ext}`);
    if (!exists(alt) || own.has(alt)) return alt;
  }
  return first;
}

module.exports = { sanitizeTagBase, fileNameForTag, pickFreeTagPath, numberedTagFileName };
