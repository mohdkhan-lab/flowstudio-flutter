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
  return hint;
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

module.exports = { SETTINGS_FIELDS, uiGenerateSettingsHint, effectiveRunSettings };
