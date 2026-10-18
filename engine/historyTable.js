'use strict';

const path = require('path');

/**
 * FlowStudio Lite — History table view-model (v2.2.0).
 *
 * The owner's History demand (his ZDola screenshot): a proper TABLE of
 * downloaded videos — name, output folder (batch), size, date, status,
 * actions — with search, filters, multi-select and a bulk bar. The
 * renderer gets RAW queue_tasks rows from db.getHistory(); this module
 * is the pure mapping from one raw row to exactly what one table row
 * shows, so the mapping (size/date/status/folder) is unit-testable in
 * plain Node and the renderer stays dumb.
 *
 * Dates: SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC. We
 * parse it as UTC and render in the machine's local time, shaped like
 * the reference: "12 Oct, 10:11 PM".
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDbTimestamp(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/** "12 Oct, 10:11 PM" — local time, or '—' when the date is unknown. */
function formatHistoryDate(raw) {
  const d = parseDbTimestamp(raw);
  if (!d) return '—';
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${h}:${min} ${ampm}`;
}

/**
 * file_size_mb is stored as text — the engine writes "2.34 MB", older
 * rows may carry a bare number. Normalise to "2.3 MB"; unknowns '—'.
 */
function formatHistorySize(raw) {
  if (raw === null || raw === undefined || raw === '') return '—';
  const n = parseFloat(String(raw));
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 0.1) return `${Math.max(1, Math.round(n * 1024))} KB`;
  return `${n.toFixed(1)} MB`;
}

/** Folder (batch) name from a file path — the last directory segment. */
function folderNameOf(filePath) {
  if (!filePath || typeof filePath !== 'string') return '—';
  const dir = path.dirname(path.resolve(filePath));
  const base = path.basename(dir);
  return base || '—';
}

function promptSnippet(text, max = 60) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return '(bina prompt text)';
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Map one raw queue_tasks history row to the table view-model.
 * status: 'done' | 'failed' (only completed/failed rows reach History).
 */
function toHistoryRow(task) {
  if (!task || typeof task !== 'object') return null;
  const done = task.status === 'completed';
  const filePath = typeof task.file_path === 'string' && task.file_path ? task.file_path : '';
  const name = (typeof task.file_name === 'string' && task.file_name)
    ? task.file_name
    : (filePath ? path.basename(filePath) : promptSnippet(task.prompt_text, 42));
  return {
    id: String(task.id || ''),
    name,
    tag: (typeof task.prompt_tag === 'string' && task.prompt_tag.trim()) ? task.prompt_tag.trim() : '',
    prompt: promptSnippet(task.prompt_text, 140),
    promptShort: promptSnippet(task.prompt_text, 60),
    folder: folderNameOf(filePath),
    sizeText: formatHistorySize(task.file_size_mb),
    dateText: formatHistoryDate(task.completed_at || task.created_at),
    status: done ? 'done' : 'failed',
    statusLabel: done ? 'Done' : 'Failed',
    reason: done ? '' : (task.error_reason || 'Unknown error'),
    accountName: task.assigned_account_name || '',
    filePath,
    hasFile: !!filePath,
    promptIndex: Number.isInteger(task.prompt_index) ? task.prompt_index : null
  };
}

function toHistoryRows(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.map(toHistoryRow).filter(Boolean);
}

/** Distinct folder names (sorted) for the History folder filter. */
function historyFolders(rows) {
  const set = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && r.folder && r.folder !== '—') set.add(r.folder);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Client-side filter shape, shared by renderer + tests: search matches
 * name, prompt OR tag (v2.3.0, case-insensitive); status
 * 'all'|'done'|'failed'; folder 'all' or an exact folder name.
 */
function filterHistoryRows(rows, { search = '', status = 'all', folder = 'all' } = {}) {
  const q = String(search || '').trim().toLowerCase();
  return (Array.isArray(rows) ? rows : []).filter(r => {
    if (!r) return false;
    if (status !== 'all' && r.status !== status) return false;
    if (folder !== 'all' && r.folder !== folder) return false;
    if (q && !(`${r.name} ${r.prompt} ${r.tag || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

module.exports = {
  toHistoryRow,
  toHistoryRows,
  historyFolders,
  filterHistoryRows,
  formatHistoryDate,
  formatHistorySize,
  parseDbTimestamp
};
