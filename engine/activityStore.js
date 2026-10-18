'use strict';

/**
 * FlowStudio Lite — Activity Store (v2.0.0).
 *
 * The owner's standing complaint was that the app worked silently: "ek
 * activity ka jo details batata rahe ki kya kya ho raha hai". This store
 * is that feed. Every major engine/main event — sign-in, verify results,
 * credits changes, generation start/done/fail, downloads, cooldowns,
 * failovers, queue resumes, cookie checks — is recorded here as one
 * entry and survives restarts.
 *
 * Storage: ONE JSON blob in app_settings ('activity_v1'), newest first,
 * capped at MAX_ENTRIES (oldest dropped). Counts-only discipline from
 * usageStats applies in spirit: entries carry a short human message and
 * an account NAME — never prompts, never cookie values, never tokens.
 *
 * v2.1.0 (owner's demand after his PC test): every entry may ALSO carry
 * the full story — `detail` (what happened, in plain words), `stage`
 * (the step it happened at: 'cookie-check', 'render-wait',
 * 'generation', 'download', 'failover', 'verify'…), `reason` (for
 * errors: why it happened / where it got stuck), plus taskId /
 * promptIndex so an entry can be tied to one queue task. The Activity
 * page shows these expandable and offers a per-entry 📋 Copy button
 * plus a "Sab Copy Karo" button (formatEntryForCopy below shapes the
 * clipboard text) so the owner can forward an error verbatim.
 * Entries written before v2.1.0 simply lack the new fields; the copy
 * formatter prints whatever an entry has.
 *
 * Categories (the Activity page filters):
 *   'generation' — queue runs, submissions, completions, downloads, failovers
 *   'credits'    — live balances, estimated charges, low-credit alerts, cooldowns
 *   'login'      — sign-in, sign-out observations, verify pass, cookie checks
 *   'errors'     — final task failures and other hard errors
 *   'system'     — app start, account add/remove, imports, queue resume
 *
 * Levels: 'info' | 'success' | 'warn' | 'error' (chip/dot colour only).
 *
 * The store interface is injected ({ getSetting, setSetting }) so the
 * rules are unit-testable in plain Node; production passes dbService.
 * An optional broadcaster callback is invoked synchronously with each
 * new entry so main.js can push it to the renderer live (IPC event);
 * the store itself has no Electron dependency.
 */

const SETTING_KEY = 'activity_v1';
const MAX_ENTRIES = 500;
const CATEGORIES = ['generation', 'credits', 'login', 'errors', 'system'];
const LEVELS = ['info', 'success', 'warn', 'error'];

function createActivityStore(store, options = {}) {
  if (!store || typeof store.getSetting !== 'function' || typeof store.setSetting !== 'function') {
    throw new Error('createActivityStore requires a store with getSetting(key, default) and setSetting(key, value)');
  }
  const maxEntries = Math.max(1, Number(options.maxEntries) || MAX_ENTRIES);
  let broadcaster = typeof options.onEntry === 'function' ? options.onEntry : null;
  let seq = 0;

  function load() {
    try {
      const raw = store.getSetting(SETTING_KEY, null);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function save(entries) {
    try {
      store.setSetting(SETTING_KEY, JSON.stringify(entries.slice(0, maxEntries)));
    } catch (e) { /* activity must never break the flow that produced it */ }
  }

  return {
    /**
     * Record one event. Returns the stored entry (or null when the
     * message was empty). Never throws into the caller.
     */
    add(input = {}) {
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      if (!message) return null;
      const now = new Date();
      const entry = {
        id: `act_${now.getTime()}_${++seq}`,
        ts: now.toISOString(),
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        category: CATEGORIES.includes(input.category) ? input.category : 'system',
        level: LEVELS.includes(input.level) ? input.level : 'info',
        message,
        accountId: input.accountId || null,
        accountName: input.accountName || null,
        // v2.1.0 detail fields (all optional; older entries lack them).
        detail: typeof input.detail === 'string' && input.detail.trim() ? input.detail.trim() : null,
        stage: typeof input.stage === 'string' && input.stage.trim() ? input.stage.trim() : null,
        reason: typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : null,
        taskId: input.taskId || null,
        promptIndex: Number.isInteger(input.promptIndex) ? input.promptIndex : null
      };
      try {
        const entries = load();
        entries.unshift(entry);
        save(entries);
      } catch (e) { /* best-effort only */ }
      if (broadcaster) {
        try { broadcaster(entry); } catch (e) {}
      }
      return entry;
    },

    /** Newest-first list; optional category filter ('all' = everything). */
    list({ category = 'all', limit = 200 } = {}) {
      const lim = Math.max(1, Math.min(500, Number(limit) || 200));
      const entries = load();
      const filtered = (category && category !== 'all')
        ? entries.filter(e => e.category === category)
        : entries;
      return filtered.slice(0, lim);
    },

    clear() {
      save([]);
    },

    count() {
      return load().length;
    },

    setBroadcaster(fn) {
      broadcaster = typeof fn === 'function' ? fn : null;
    }
  };
}

// Production singleton bound to dbService.
let _defaultStore = null;
function getActivityStore() {
  if (!_defaultStore) {
    const { dbService } = require('./db');
    _defaultStore = createActivityStore(dbService);
  }
  return _defaultStore;
}

/** Convenience: record an event on the production store, never throwing. */
function recordActivity(input) {
  try {
    return getActivityStore().add(input);
  } catch (e) {
    return null;
  }
}

/**
 * v2.1.0: the exact text the 📋 Copy buttons put on the clipboard —
 * one entry with EVERYTHING it knows, in plain lines the owner can
 * read and forward as-is. Pure function; lives here so the renderer's
 * copy and the unit tests share one shape.
 */
function formatEntryForCopy(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const lines = [];
  const when = entry.ts ? new Date(entry.ts).toLocaleString() : (entry.time || '');
  lines.push(`[${when}] ${String(entry.message || '').trim()}`);
  if (entry.accountName) lines.push(`Account: ${entry.accountName}`);
  if (entry.promptIndex !== null && entry.promptIndex !== undefined) lines.push(`Prompt #: ${entry.promptIndex + 1}`);
  if (entry.stage) lines.push(`Stage: ${entry.stage}`);
  if (entry.category) lines.push(`Category: ${entry.category}`);
  if (entry.level) lines.push(`Level: ${entry.level}`);
  if (entry.detail) lines.push(`Detail: ${entry.detail}`);
  if (entry.reason) lines.push(`Reason: ${entry.reason}`);
  if (entry.taskId) lines.push(`Task ID: ${entry.taskId}`);
  return lines.join('\n');
}

/** All entries (newest first, as stored) joined for "Sab Copy Karo". */
function formatEntriesForCopy(entries) {
  if (!Array.isArray(entries)) return '';
  return entries.map(formatEntryForCopy).filter(Boolean).join('\n\n');
}

/**
 * v2.2.0: the SIMPLE line — one entry, one line, image-4 style:
 *   "[time] ✔ message"
 * The icon carries the level (the renderer colours it by level):
 * success ✔ · warn ⚠ · error ✘ · info ●. No stage/reason/detail —
 * that is what Details mode is for. Pure function; the renderer's log
 * panel mirrors this exact shape for engine log lines.
 */
const LEVEL_ICONS = { success: '✔', warn: '⚠', error: '✘', info: '●' };

function levelIcon(level) {
  return LEVEL_ICONS[level] || LEVEL_ICONS.info;
}

function formatEntrySimple(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const time = entry.time || (entry.ts ? new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  const head = time ? `[${time}] ` : '';
  return `${head}${levelIcon(entry.level)} ${String(entry.message || '').trim()}`.trim();
}

/**
 * v2.2.0: the DETAILS one-liner — the Simple line PLUS the story
 * compressed onto the same line (stage = kahan ruka, reason = kyun
 * hua, account). The full `detail` text still lives in the expandable
 * block / Copy text; this is the list-row summary for Details mode.
 */
function formatEntryDetailLine(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const base = formatEntrySimple(entry);
  const bits = [];
  if (entry.accountName) bits.push(`Account: ${entry.accountName}`);
  if (entry.promptIndex !== null && entry.promptIndex !== undefined) bits.push(`Prompt #${entry.promptIndex + 1}`);
  if (entry.stage) bits.push(`Stage: ${entry.stage}`);
  if (entry.reason) bits.push(`Reason: ${entry.reason}`);
  return bits.length ? `${base} — ${bits.join(' · ')}` : base;
}

module.exports = {
  createActivityStore,
  getActivityStore,
  recordActivity,
  formatEntryForCopy,
  formatEntriesForCopy,
  formatEntrySimple,
  formatEntryDetailLine,
  levelIcon,
  LEVEL_ICONS,
  SETTING_KEY,
  MAX_ENTRIES,
  CATEGORIES,
  LEVELS
};
