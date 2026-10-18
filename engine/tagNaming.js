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
 *   (c) a path this engine itself saved this session may be reused
 *       (re-save of the same task), mirroring the legacy picker.
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

/** Full file name for a tag, or null when the tag has no usable base. */
function fileNameForTag(tag, ext = 'mp4') {
  const base = sanitizeTagBase(tag);
  if (!base) return null;
  const cleanExt = String(ext || 'mp4').replace(/^\./, '').replace(/[^a-zA-Z0-9]/g, '') || 'mp4';
  return `${base}.${cleanExt}`;
}

/**
 * Choose a save path for `fileName` inside `folder` that never
 * overwrites a foreign file. `existsFn(absPath)` and `ownPaths`
 * (a Set of paths this session saved itself) are injected so the
 * rule is unit-testable without a disk.
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

module.exports = { sanitizeTagBase, fileNameForTag, pickFreeTagPath };
