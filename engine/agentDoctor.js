'use strict';

// ---------------------------------------------------------------------------
// AGENT DOCTOR (owner's iteration workflow, 2026-11-12): replace-pack
// fixes change engine files inside the INSTALLED app, and until now
// nothing could prove WHICH driver the running engine had actually
// loaded — a replaced file in the wrong folder (or an app that was
// never really closed) looked exactly like a fix that did not work
// (field: test AGENTTEST6 ran the OLD .98 driver behind new files).
// This module is the proof, in two parts:
//
//   1. LOADED-FILE FINGERPRINT — at engine startup the bridge asks
//      this module which agent files Node resolved from the
//      engine's own location (agentDriver.js + agentRules.js) and
//      records each file's absolute path, byte size and short md5.
//      The bridge logs ONE [DOCTOR] startup line with both, so the
//      owner's copied app log itself proves what is live, and the
//      MCP doctor tool serves the same snapshot.
//      Pack 3 (2026-11-13): the snapshot now ALSO fingerprints
//      every other replaceable file a replace-pack ships —
//      agentDoctor.js itself (engine/), engine_bridge.js and
//      mcp_server.js (app root, one level up) — so a whole pack
//      verifies from the same single doctor call. The startup
//      line keeps its two-file format; the tool returns the
//      extended set.
//
//   2. LAST-RUN MEMORY — engine/agentDriver.js records EVERY
//      agent-run exit (submitted / parked / failed / violation /
//      stopped) into the shared slot below: when, the status, the
//      reason, the last proposal the run decided on, and (pack 3)
//      a detail string — the settings DOM survey or the exact
//      settings field that mismatched — when the run produced
//      one. The MCP doctor tool reads it back, so "what exactly
//      went wrong on the last run" is one call — no log copying.
//
// The diagnostics above are read-only: nothing in them can change
// a run, a file or a setting. Every function is built to never
// throw into its caller — a broken fingerprint or a broken record
// degrades to 'unreadable' / a dropped entry, never to a failed
// engine start or a failed agent run.
//
// v2.48.99 (MCP AGENT-MODE SWITCH): this module additionally holds
// ONE writable slot — the MCP agent-mode override (section 3 at
// the bottom) — because the doctor payload must report it and the
// bridge needs a single shared in-memory home for it. The slot
// only ever routes MCP-originated runs; it never touches the
// app's own UI toggle or a manual run.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MD5_SHORT_LEN = 10; // first 10 hex chars of the file md5
const REASON_MAX = 300; // last-run reason is trimmed to ~300 chars
const DETAIL_MAX = 500; // last-run detail is trimmed to ~500 chars

/**
 * Fingerprint ONE file on disk: absolute path, byte size, and the
 * first 10 hex chars of its md5. ANY failure (missing file,
 * unreadable, a directory) returns size/md5 as 'unreadable' —
 * this function never throws.
 */
function fingerprintFile(absPath) {
  const p = String(absPath || '');
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { path: p, size: 'unreadable', md5: 'unreadable' };
    const data = fs.readFileSync(p);
    const md5 = crypto.createHash('md5').update(data).digest('hex').substring(0, MD5_SHORT_LEN);
    return { path: p, size: data.length, md5 };
  } catch (e) {
    return { path: p, size: 'unreadable', md5: 'unreadable' };
  }
}

/**
 * Fingerprint the module Node resolves for `request` FROM THIS
 * module's own folder (the engine dir) — i.e. the exact file a
 * require() of it loads here. If resolution itself fails, the
 * would-be path in this folder is fingerprinted instead (which
 * then reads 'unreadable').
 */
function fingerprintLoadedModule(request) {
  let resolved = null;
  try { resolved = require.resolve(request, { paths: [__dirname] }); } catch (e) { resolved = null; }
  if (!resolved) resolved = path.join(__dirname, `${String(request).replace(/^\.\//, '')}.js`);
  return fingerprintFile(resolved);
}

let _loadedFiles = null;

const UNREADABLE_FP = () => ({ path: '', size: 'unreadable', md5: 'unreadable' });

/**
 * The startup snapshot: fingerprints of the files THIS engine
 * process loaded. Computed once, on first ask (the bridge asks
 * at startup, so the snapshot is the startup truth even if a
 * file is replaced on disk later — the running code is what Node
 * loaded, and that is what this reports).
 *
 * Pack 3: beside the two agent modules (driver / rules), the
 * snapshot fingerprints the REST of a replace-pack's file set
 * the same way — agentDoctor (this module, engine/), and the
 * two app-root files one level up (engineBridge, mcpServer) —
 * so ONE doctor call verifies a whole pack, not just the agent
 * pair. `driver` and `rules` keep their shape and position: the
 * [DOCTOR] startup line and existing consumers read only those.
 */
function loadedAgentFiles() {
  if (_loadedFiles) return _loadedFiles;
  let driver = null;
  let rules = null;
  let agentDoctor = null;
  let engineBridge = null;
  let mcpServer = null;
  try { driver = fingerprintLoadedModule('./agentDriver'); } catch (e) { driver = UNREADABLE_FP(); }
  try { rules = fingerprintLoadedModule('./agentRules'); } catch (e) { rules = UNREADABLE_FP(); }
  try { agentDoctor = fingerprintLoadedModule('./agentDoctor'); } catch (e) { agentDoctor = UNREADABLE_FP(); }
  try { engineBridge = fingerprintFile(path.join(__dirname, '..', 'engine_bridge.js')); } catch (e) { engineBridge = UNREADABLE_FP(); }
  try { mcpServer = fingerprintFile(path.join(__dirname, '..', 'mcp_server.js')); } catch (e) { mcpServer = UNREADABLE_FP(); }
  _loadedFiles = { driver, rules, agentDoctor, engineBridge, mcpServer };
  return _loadedFiles;
}

/** Test seam: forget the cached snapshot (never used in production). */
function resetLoadedFilesCache() {
  _loadedFiles = null;
}

/** The ONE [DOCTOR] startup line the bridge logs at engine start. */
function doctorStartupLine(files) {
  const f = files || loadedAgentFiles();
  const d = f.driver || {};
  const r = f.rules || {};
  return `[DOCTOR] agent driver loaded from ${d.path} (size ${d.size}, md5 ${d.md5}) · rules loaded from ${r.path} (size ${r.size}, md5 ${r.md5})`;
}

// --- Last-agent-run memory -------------------------------------------------
// One slot, last writer wins: the most recent agent run's outcome.
// Shape: { at, status, reason, lastProposal: {quoted, model, act} | null,
// detail: string | null } — detail (pack 3) carries the settings
// evidence a run produced: the settings-region DOM survey when the
// surface could not be found, or the exact field that mismatched
// after Save. Trimmed to ~500 chars; null when the run had none.
let _lastAgentRun = null;

/**
 * Record one agent run's exit. Called by the driver on EVERY exit
 * path (the submitViaAgent wrapper). Never throws — a diagnostics
 * failure must never break the run it describes.
 */
function recordAgentRun(entry) {
  try {
    const e = entry || {};
    const proposal = e.lastProposal && typeof e.lastProposal === 'object'
      ? {
          quoted: e.lastProposal.quoted !== undefined ? e.lastProposal.quoted : null,
          model: e.lastProposal.model !== undefined ? e.lastProposal.model : null,
          act: e.lastProposal.act !== undefined ? e.lastProposal.act : null
        }
      : null;
    _lastAgentRun = {
      at: e.at || new Date().toISOString(),
      status: String(e.status || 'AGENT_FAILED'),
      reason: String(e.reason || '').substring(0, REASON_MAX),
      lastProposal: proposal,
      detail: (e.detail !== undefined && e.detail !== null && String(e.detail) !== '')
        ? String(e.detail).substring(0, DETAIL_MAX)
        : null
    };
  } catch (err) {}
  return _lastAgentRun;
}

/** The most recent recorded agent run, or null before the first one. */
function getLastAgentRun() {
  return _lastAgentRun;
}

/** Test seam: clear the slot (never used in production). */
function resetLastAgentRun() {
  _lastAgentRun = null;
}

// --- Last settings-first record (v2.48.104) ---------------------------------
// SETTINGS FIRST (the owner's final-version order): every Agent
// run now aligns the project's Agent settings (Confirm = Always,
// the run's video model/aspect, outputs x1 — Save, then a
// read-back verify) and ensures the standing "FlowStudio Run
// Rules" instruction BEFORE it sends anything. This slot keeps
// the most recent run's outcome of that pre-flight — the values
// the read-back actually showed, whether they verified, and
// what happened with the instruction — so "did the settings
// really take on the last run?" is the same one doctor call as
// every other agent question. One slot, last writer wins;
// recording never throws.
let _lastSettingsFirst = null;

/**
 * Record one run's settings-first outcome. Shape kept exactly
 * as the brief fixes it: { at, model, aspect, outputs, confirm,
 * readBackOk, instruction: 'present'|'added'|'failed' } — the
 * four values are the READ-BACK (what the reopened settings
 * showed, null when unreadable), never the merely-intended
 * values.
 */
function recordSettingsFirst(entry) {
  try {
    const e = entry || {};
    const val = (v) => (v === undefined || v === null || String(v) === '') ? null : String(v);
    _lastSettingsFirst = {
      at: e.at || new Date().toISOString(),
      model: val(e.model),
      aspect: val(e.aspect),
      outputs: val(e.outputs),
      confirm: val(e.confirm),
      readBackOk: e.readBackOk === true,
      instruction: ['present', 'added', 'failed'].includes(e.instruction) ? e.instruction : 'failed'
    };
  } catch (err) {}
  return _lastSettingsFirst;
}

/** The most recent settings-first record, or null before the first run. */
function getLastSettingsFirst() {
  return _lastSettingsFirst;
}

/** Test seam: clear the slot (never used in production). */
function resetLastSettingsFirst() {
  _lastSettingsFirst = null;
}

/** The one-line rendering of a settings-first record (log + chat). */
function settingsFirstLine(entry) {
  const e = entry || {};
  const show = (v) => (v === undefined || v === null || String(v) === '') ? 'unreadable' : String(v);
  return `[DOCTOR] settings-first: model=${show(e.model)} · aspect=${show(e.aspect)} · outputs=${show(e.outputs)} · confirm=${show(e.confirm)} · readBack=${e.readBackOk === true ? 'ok' : 'FAILED'} · instruction=${e.instruction || 'failed'} (at ${e.at || 'unknown'})`;
}

// --- MCP agent-mode override (v2.48.99) ------------------------------------
// The owner runs the app from chat and must never have to walk to
// the PC to flip the app's Agent Prompt toggle for a chat-driven
// run. The MCP tool flowstudio_set_agent_mode stores an override
// here (in memory only — an app restart returns to null):
//   true  → MCP-originated runs go through Flow's Agent
//   false → MCP-originated runs take the direct (bulk) route
//   null  → no override: MCP runs follow the app's own toggle
//           (in-app route) / the direct route (engine route),
//           exactly as before this feature existed.
// The override NEVER applies to a run the owner starts by hand in
// the app — the bridge only consults it for MCP-originated starts.
let _agentModeOverride = null;

/** Store the override: true/false set it, anything else clears to null. */
function setAgentModeOverride(v) {
  _agentModeOverride = (v === true) ? true : (v === false) ? false : null;
  return _agentModeOverride;
}

/** The current override: true, false, or null (follow the app). */
function getAgentModeOverride() {
  return _agentModeOverride;
}

/** Test seam: clear the override (never used in production). */
function resetAgentModeOverride() {
  _agentModeOverride = null;
}

/**
 * The ONE precedence rule for an MCP-originated run's agent mode:
 * a per-call parameter beats the stored override, which beats the
 * run's own UI-side value. Pure and total — any input shape yields
 * { agentMode: boolean, source: 'param' | 'override' | 'ui' }.
 */
function resolveAgentMode(input) {
  const o = input || {};
  if (typeof o.param === 'boolean') return { agentMode: o.param, source: 'param' };
  if (o.override === true || o.override === false) return { agentMode: o.override, source: 'override' };
  return { agentMode: o.ui === true, source: 'ui' };
}

/** The MCP doctor payload: fingerprints + the last-run memory. */
function doctorPayload(appVersion) {
  const files = loadedAgentFiles();
  return {
    ok: true,
    appVersion: String(appVersion || ''),
    driver: files.driver,
    rules: files.rules,
    agentDoctor: files.agentDoctor,
    engineBridge: files.engineBridge,
    mcpServer: files.mcpServer,
    lastAgentRun: getLastAgentRun(),
    lastSettingsFirst: getLastSettingsFirst(),
    agentModeOverride: getAgentModeOverride()
  };
}

module.exports = {
  MD5_SHORT_LEN,
  REASON_MAX,
  DETAIL_MAX,
  fingerprintFile,
  fingerprintLoadedModule,
  loadedAgentFiles,
  resetLoadedFilesCache,
  doctorStartupLine,
  recordAgentRun,
  getLastAgentRun,
  resetLastAgentRun,
  recordSettingsFirst,
  getLastSettingsFirst,
  resetLastSettingsFirst,
  settingsFirstLine,
  setAgentModeOverride,
  getAgentModeOverride,
  resetAgentModeOverride,
  resolveAgentMode,
  doctorPayload
};
