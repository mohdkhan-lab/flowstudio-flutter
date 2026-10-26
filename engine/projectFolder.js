'use strict';

const path = require('path');

/**
 * FlowStudio Lite — per-project download folders (v2.33.0).
 *
 * A run may carry a project name; its downloads then land in a
 * subfolder of the output folder named for the project, so one
 * project's scenes never mix with the general downloads. The name
 * is owner-typed free text, so it is sanitised to ONE safe folder
 * name: path separators and Windows-illegal characters are removed
 * (never interpreted), leading/trailing dots are stripped, and the
 * result can never be "." / ".." / empty — an unusable name simply
 * means "no project", i.e. today's flat output folder.
 */
function sanitizeProjectName(name) {
  if (typeof name !== 'string') return '';
  let s = name.trim().replace(/\s+/g, ' ');
  s = s.replace(/[<>:"/\\|?*\x00-\x1F]/g, '');
  s = s.replace(/^\.+/, '').replace(/\.+$/, '').trim();
  if (s.length > 60) s = s.slice(0, 60).trim();
  if (!s || s === '.' || s === '..') return '';
  return s;
}

/** The folder a run with this project name saves into. */
function projectFolderFor(baseDir, project) {
  const p = sanitizeProjectName(project);
  if (!p) return baseDir;
  return path.join(baseDir, p);
}

module.exports = { sanitizeProjectName, projectFolderFor };
