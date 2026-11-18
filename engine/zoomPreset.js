'use strict';

// v2.48.119 (F1 — ZOOM PROFILE PRESET): generation browser
// ka 50% zoom ab keyboard se NAHI lagta. Field saboot
// (.116/.117/.118, TEST118-ZOOM 2026-11-18): CDP keyboard
// zoom (Ctrl+0 + Ctrl+'-') is Chrome me KISI bhi pal par
// nahi lagta — launch, project-open, workspace-ready,
// grid-return, chaaron par read-back dpr=1 FAILED raha.
// .118 ki retry machinery bilkul sahi chali; marne wala
// khud keyboard rasta tha. Wo rasta BAND hai.
//
// Naya rasta: Chrome launch hone se PEHLE, usi ke apne
// profile ke Preferences me flow.google.com ka per-host
// zoom level likh do. Chrome apna HostZoomMap startup
// par 'partition.per_host_zoom_levels' pref se bharta
// hai (chrome/browser/ui/zoom/chrome_zoom_level_prefs.cc):
//
//   Preferences.partition.per_host_zoom_levels
//     .<partitionKey>.<host> = { zoom_level, last_modified }
//
// Default storage partition ke liye partitionKey 'x' hai
// (GetPartitionKey: 'x' + hex(relative path); default
// partition ka relative path khaali hota hai). Host entry
// ya to { zoom_level: <double>, last_modified: <string> }
// hoti hai ya (legacy) seedha double — Chrome dono padhta
// hai; nikaalne (sanitize) ka usool sirf ye hai ke level
// default (0) ke barabar na ho. Zoom level aur scale ka
// rishta: level = ln(scale) / ln(1.2), yani 50% ke liye
// -3.8017840169...
//
// Profile model (engine/accountStore.js): har account ka
// APNA persistent profile directory hai —
// profiles/<accountId>, aur generation puppeteer.launch
// me seedha --user-data-dir wahi deta hai (working copy
// NAHI — session cookies asal profile me hi rehte hain).
// Is liye preset write <profile>/Default/Preferences par
// padti hai, busy check ke baad aur launch se pehle —
// wahi pal jab koi Chrome us profile ko nahi pakde hue
// (profilePrefs.ensureBackgroundModeOff ka bhi yahi
// usool hai). Write fail-soft hai: file na ho to minimal
// banti hai, corrupt ho to haath nahi lagta, aur nakami
// par sirf log — zoom kisi run ko kabhi nahi rokta.

const fs = require('fs');
const path = require('path');

const ZOOM_PRESET_HOST = 'flow.google.com';
const ZOOM_PARTITION_KEY = 'x';
const ZOOM_PRESET_SCALE = 0.5;
// Read-back ki band: |dpr - scale| <= 0.02 hi 'verified'
// (.118 wali band hi rakhi hai).
const ZOOM_PRESET_DPR_TOLERANCE = 0.02;

/**
 * Ek scale ka Chrome zoom level: ln(scale)/ln(1.2).
 * 0.5 → -3.8017840169..., 1 → 0. Naap galat ho (<=0,
 * NaN) to 0 — 'koi zoom nahi' wala mehfooz jawab.
 */
function zoomLevelForScale(scale) {
  const s = Number(scale);
  if (!Number.isFinite(s) || s <= 0) return 0;
  return Math.log(s) / Math.log(1.2);
}

/**
 * Chrome ke waqt ka internal roop (microseconds since
 * 1601-01-01) string me — last_modified ke liye wahi
 * shakal jo Chrome khud likhta hai. Waqt na mile to '0'
 * (Chrome ka GetTimeStamp use epoch samajhta hai aur
 * entry phir bhi padhta hai).
 */
function chromeTimeString(nowMs) {
  const ms = Number(nowMs);
  if (!Number.isFinite(ms) || ms <= 0) return '0';
  return String(Math.round((ms / 1000 + 11644473600) * 1000000));
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function cloneJson(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * KHALIS (pure): prefs object ki NAYI copy lautao jis me
 * host ka per-host zoom level laga ho. Input object ko
 * haath nahi lagta; baaki har key/value jyon ka tyon
 * rehta hai (JSON copy ke zariye). Host ki purani entry
 * ke dusre hisse (masalan last_modified) mehfooz rehte
 * hain — sirf zoom_level badalta hai; nayi entry par
 * lastModified (default '0') bhi likha jata hai.
 */
function applyHostZoom(prefs, host, level, lastModified) {
  const src = isPlainObject(prefs) ? prefs : {};
  const out = cloneJson(src);
  const hostName = String(host == null ? '' : host).trim();
  const lvl = Number(level);
  if (!hostName || !Number.isFinite(lvl)) return out;

  if (!isPlainObject(out.partition)) out.partition = {};
  const partition = out.partition;
  if (!isPlainObject(partition.per_host_zoom_levels)) partition.per_host_zoom_levels = {};
  const perHost = partition.per_host_zoom_levels;
  if (!isPlainObject(perHost[ZOOM_PARTITION_KEY])) perHost[ZOOM_PARTITION_KEY] = {};
  const partitionDict = perHost[ZOOM_PARTITION_KEY];

  const existing = partitionDict[hostName];
  if (isPlainObject(existing)) {
    partitionDict[hostName] = { ...existing, zoom_level: lvl };
  } else {
    partitionDict[hostName] = {
      zoom_level: lvl,
      last_modified: (typeof lastModified === 'string' && lastModified) ? lastModified : '0'
    };
  }
  return out;
}

/** Prefs me host ka maujooda zoom level (na mile to null). */
function hostZoomLevel(prefs, host) {
  try {
    const dict = prefs && prefs.partition && prefs.partition.per_host_zoom_levels
      ? prefs.partition.per_host_zoom_levels[ZOOM_PARTITION_KEY] : null;
    if (!isPlainObject(dict)) return null;
    const entry = dict[String(host == null ? '' : host).trim()];
    if (isPlainObject(entry)) {
      const n = Number(entry.zoom_level);
      return Number.isFinite(n) ? n : null;
    }
    const n = Number(entry);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    return null;
  }
}

/**
 * Read-back ka faisla: asal devicePixelRatio target
 * scale ki band me hai kya. Naap na mile to hamesha
 * false — saboot na ho to verified nahi kehte.
 */
function zoomPresetVerified(dpr, scale = ZOOM_PRESET_SCALE) {
  const s = Number(scale);
  if (!Number.isFinite(s) || s <= 0) return false;
  if (dpr === null || dpr === undefined) return false;
  const n = Number(dpr);
  return Number.isFinite(n) && Math.abs(n - s) <= ZOOM_PRESET_DPR_TOLERANCE + 1e-9;
}

/** Ek read-back value ka log roop ('n/a' jab naap na ho). */
function zoomPresetDprText(v) {
  if (v === null || v === undefined) return 'n/a';
  const n = Number(v);
  if (!Number.isFinite(n)) return 'n/a';
  return String(Math.round(n * 1000) / 1000);
}

/**
 * Workspace-ready ke baad ki EK read-back [ROOT] line:
 *   [ROOT] browser-zoom account=<name> source=profile-preset dpr=<v> verified|FAILED
 */
function zoomPresetLogLine(accountName, dpr, verified) {
  const name = String(accountName == null ? '' : accountName).replace(/\s+/g, ' ').trim() || '-';
  return `[ROOT] browser-zoom account=${name} source=profile-preset dpr=${zoomPresetDprText(dpr)} ${verified ? 'verified' : 'FAILED'}`;
}

/**
 * Profile ke Preferences me zoom preset likho (impure
 * hissa — profilePrefs.ensureBackgroundModeOff ki
 * tartib):
 * - sirf tab bulao jab koi Chrome is profile ko na pakde
 *   ho (warna Chrome exit par apni memory se file dobara
 *   likh kar is tabdeeli ko phenk dega);
 * - Preferences na ho to minimal file banti hai (Chrome
 *   baaki defaults khud bhar dega);
 * - corrupt / non-object JSON par file ko haath NAHI
 *   lagta (jo data samajh na aaye use kabhi na bigado);
 * - idempotent: level pehle se wahi ho to kuch nahi
 *   likha jata.
 * Lautta hai { applied, alreadySet?, reason? } — kabhi
 * throw nahi karta.
 */
function applyProfileZoomPreset(profilePath, opts = {}) {
  if (!profilePath || typeof profilePath !== 'string') {
    return { applied: false, reason: 'no-profile-path' };
  }
  const host = (opts && opts.host) || ZOOM_PRESET_HOST;
  const scale = (opts && Number(opts.scale) > 0) ? Number(opts.scale) : ZOOM_PRESET_SCALE;
  const level = zoomLevelForScale(scale);
  const prefPath = path.join(profilePath, 'Default', 'Preferences');
  const existed = fs.existsSync(prefPath);

  let prefs = {};
  if (existed) {
    try {
      prefs = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
    } catch (e) {
      return { applied: false, reason: 'corrupt-preferences' };
    }
    if (!isPlainObject(prefs)) {
      return { applied: false, reason: 'corrupt-preferences' };
    }
    const current = hostZoomLevel(prefs, host);
    if (current !== null && Math.abs(current - level) <= 1e-9) {
      return { applied: false, alreadySet: true };
    }
  }

  const next = applyHostZoom(prefs, host, level, chromeTimeString(Date.now()));
  try {
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });
    fs.writeFileSync(prefPath, JSON.stringify(next));
    return { applied: true };
  } catch (e) {
    return { applied: false, reason: e.message };
  }
}

module.exports = {
  ZOOM_PRESET_HOST,
  ZOOM_PARTITION_KEY,
  ZOOM_PRESET_SCALE,
  ZOOM_PRESET_DPR_TOLERANCE,
  zoomLevelForScale,
  applyHostZoom,
  hostZoomLevel,
  zoomPresetVerified,
  zoomPresetDprText,
  zoomPresetLogLine,
  applyProfileZoomPreset
};
