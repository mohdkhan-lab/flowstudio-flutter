'use strict';

// ---------------------------------------------------------------------------
// v2.48.70 (ITEM E — ONE SETTINGS TRUTH, fallback route):
//
// MCP se likhi hui settings (POST /api/settings -> DB
// app_settings) kabhi app ke in-app run tak NAHI pahunchti
// thin: MCP in-app generate Dart side par SettingsProvider
// ki in-memory values uthata tha, jo sirf app start par
// load hoti hain. Field saboot (2026-11-07): MK ne MCP se
// duration 10s likha, read-back 10s aaya, lekin in-app run
// ne 4s ka video banaya — do alag sachaiyan.
//
// Is pack ka fallback rasta (brief ki ijazat se): MCP
// in-app generate ke waqt bridge DB ki settings ko SSE
// payload ke saath PUSH karta hai; Dart unhe apne
// SettingsProvider par apply karta hai (wahi updaters jo
// DB me bhi persist karte hain), phir run shuru hota hai
// — aur maujooda settings-pill gate (configureGeneration-
// Settings / SETTINGS_MISMATCH) us run ko pehle jaisa hi
// rok sakta hai. Khalis hisaab yahan hai taaki node test
// is poori chain ko DB store ke khilaf parkh sake.
// ---------------------------------------------------------------------------

/** UI/in-app run ke chaar settings fields. */
const SETTINGS_FIELDS = ['model', 'duration', 'aspectRatio', 'quality'];

/**
 * DB settings map (getSettings() wali shakl: flat
 * key -> value) se WO hissa jo in-app run ko push
 * karna hai — sirf ghair-khali values. Khali map par
 * {} (Dart kuch apply nahi karega, apni maujooda
 * values hi sach rahengi).
 */
function uiGenerateSettingsHint(dbSettings) {
  const src = dbSettings && typeof dbSettings === 'object' ? dbSettings : {};
  const hint = {};
  for (const field of SETTINGS_FIELDS) {
    const v = src[field];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) hint[field] = s;
  }
  // v2.48.112 (C): the parallel-workers count rides the same push,
  // so an MCP-driven in-app run lands on the app's ONE stored truth
  // instead of whatever the app's memory happened to hold (the
  // split-brain: spawn read Dart memory, supervision read the DB).
  // Only a valid stored value is pushed; absent/invalid stays
  // absent and Dart keeps its own value, exactly like the fields
  // above.
  const pb = clampParallelBrowsers(src.parallelBrowsers);
  if (pb != null) hint.parallelBrowsers = String(pb);
  return hint;
}

/**
 * v2.48.112 (C): the app's parallel-workers range is 1..4
 * everywhere. Returns the clamped integer, or null when the value
 * is absent / not a positive number.
 */
function clampParallelBrowsers(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.min(4, Math.floor(n)));
}

/**
 * v2.48.112 (C): ONE parallel-workers truth per run. The engine DB
 * store (`parallel_browsers`) wins; the request body's value is
 * only a fallback for when the store has none; the last resort is
 * 1. The bridge resolves this BEFORE building the pool and reports
 * it back in the start response, and the pool pins the resolved
 * value for the whole run — spawn count and supervisor target can
 * never again read two different numbers.
 */
function resolveEffectiveParallel({ dbValue, bodyValue } = {}) {
  const fromDb = clampParallelBrowsers(dbValue);
  if (fromDb != null) return fromDb;
  const fromBody = clampParallelBrowsers(bodyValue);
  if (fromBody != null) return fromBody;
  return 1;
}

/**
 * Ek run ki EFFECTIVE settings — bridge ke
 * /api/generation/start wali tarteeb ka khalis model:
 * explicit (request config) sab se upar, phir DB
 * defaults, phir diye gaye hardcoded fallbacks.
 * `db` = { default_model, default_duration,
 * default_aspect_ratio, default_quality } (bridge inhe
 * dbService.getSetting se padhta hai).
 * Natija hamesha chaaron fields ke saath.
 */
function effectiveRunSettings(db, explicit, fallbacks) {
  const d = db && typeof db === 'object' ? db : {};
  const c = explicit && typeof explicit === 'object' ? explicit : {};
  const f = fallbacks && typeof fallbacks === 'object' ? fallbacks : {};
  const pick = (...vals) => {
    for (const v of vals) {
      if (v === undefined || v === null) continue;
      const s = String(v).trim();
      if (s) return s;
    }
    return '';
  };
  return {
    model: pick(c.model, d.default_model, f.model),
    duration: pick(c.duration, d.default_duration, f.duration),
    aspectRatio: pick(c.aspectRatio, c.aspect_ratio, d.default_aspect_ratio, f.aspectRatio),
    quality: pick(c.quality, d.default_quality, f.quality)
  };
}

/**
 * v2.48.110 (G2): a stable signature of the settings an engine
 * actually applies to the Flow panel (type + the four fields).
 * The engine remembers the signature it last configured; when a
 * later submit carries a DIFFERENT signature — because the owner
 * changed a setting mid-run and the pool refreshed the run's
 * settings object — the panel is re-configured before that submit
 * instead of silently generating at the old values. Absent fields
 * sign as empty, so a partial settings object can never alias a
 * fuller one.
 */
function settingsSignatureOf(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const part = (v) => (v === undefined || v === null ? '' : String(v).trim());
  return [part(s.type || 'Video'), part(s.model), part(s.duration), part(s.aspectRatio), part(s.quality)].join('|');
}

module.exports = { SETTINGS_FIELDS, uiGenerateSettingsHint, effectiveRunSettings, settingsSignatureOf, clampParallelBrowsers, resolveEffectiveParallel };
