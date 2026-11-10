'use strict';

/**
 * v2.48.80 (Item C — PROVEN-ABSENT MEMORY): ek account ke
 * Flow panel ne kisi model par manga hua resolution
 * asal me OFFER hi nahi kiya (panel dump se sabit —
 * masalan account (7): Omni par sirf 720p, 360p ka koi
 * control hi nahi), to ye sachai (account, model,
 * resolution) ki chabi se app_settings me darj rehti
 * hai. Agle runs me planner us account ko us resolution
 * ke liye settings ki teen koshishon se PEHLE hi chhod
 * deta hai ([ROOT] settings-known-absent line ke saath)
 * aur agle account par chala jata hai. Kitab kabhi
 * bandish nahi banti: koi doosra account serve hi na
 * kar sake to wahi account ek asal koshish phir bhi
 * pata hai (safety valve — panel badal bhi sakta hai),
 * aur ek kamyab chunav us ka record saaf kar deta hai.
 *
 * Ye module khalis faislo + ek patli si kv parat hai —
 * kv wahi { getSetting, setSetting } hai jo dbService
 * deta hai; test jaali kv de sakte hain. Koi nakami
 * (kv ghayab, JSON kharab) hamesha khaali kitab ki
 * taraf girti hai — memory ka hona sahuliyat hai,
 * rukawat kabhi nahi.
 */

const RESOLUTION_MEMORY_KEY = 'resolution_absent_memory_v1';

function resolutionMemoryKey(accountName, model, resolution) {
  const a = String(accountName == null ? '' : accountName).trim();
  const m = String(model == null ? '' : model).trim().toLowerCase();
  const r = String(resolution == null ? '' : resolution).trim().toLowerCase();
  if (!a || !r) return null;
  return `${a}::${m}::${r}`;
}

function parseResolutionMemory(raw) {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (o && typeof o === 'object' && !Array.isArray(o)) return { ...o };
  } catch (e) { /* kharab JSON = khaali kitab */ }
  return {};
}

function isResolutionKnownAbsent(map, accountName, model, resolution) {
  const k = resolutionMemoryKey(accountName, model, resolution);
  return !!(k && map && typeof map === 'object' && map[k]);
}

function recordResolutionAbsent(map, accountName, model, resolution, atIso) {
  const k = resolutionMemoryKey(accountName, model, resolution);
  if (!k || !map || typeof map !== 'object') return false;
  map[k] = {
    account: String(accountName).trim(),
    model: String(model == null ? '' : model).trim(),
    resolution: String(resolution).trim().toLowerCase(),
    at: atIso || new Date().toISOString()
  };
  return true;
}

function clearResolutionAbsent(map, accountName, model, resolution) {
  const k = resolutionMemoryKey(accountName, model, resolution);
  if (!k || !map || typeof map !== 'object' || !map[k]) return false;
  delete map[k];
  return true;
}

function loadResolutionMemory(kv) {
  if (!kv || typeof kv.getSetting !== 'function') return {};
  try {
    return parseResolutionMemory(kv.getSetting(RESOLUTION_MEMORY_KEY, ''));
  } catch (e) {
    return {};
  }
}

function saveResolutionMemory(kv, map) {
  if (!kv || typeof kv.setSetting !== 'function') return false;
  try {
    kv.setSetting(RESOLUTION_MEMORY_KEY, JSON.stringify(map && typeof map === 'object' ? map : {}));
    return true;
  } catch (e) {
    return false;
  }
}

/** Planner ki pass-over line — [ROOT] settings-known-absent. */
function settingsKnownAbsentLine(accountName, resolution, model) {
  return `[ROOT] settings-known-absent account=${String(accountName == null ? '' : accountName).trim()} resolution=${String(resolution == null ? '' : resolution).trim().toLowerCase()} model=${String(model == null ? '' : model).trim()}`;
}

/**
 * Run settings se generation resolution — engine ke
 * configureGenerationSettings wali hi mapping (Quality
 * 720p/1080p -> panel 720p, warna 360p; 1080p ek
 * enhanced DOWNLOAD hai, panel par us ka button nahi).
 */
function generationResolutionOf(settings) {
  const q = String((settings && settings.quality) || '360p').toLowerCase();
  return (q.includes('720') || q.includes('1080')) ? '720p' : '360p';
}

module.exports = {
  RESOLUTION_MEMORY_KEY,
  resolutionMemoryKey,
  parseResolutionMemory,
  isResolutionKnownAbsent,
  recordResolutionAbsent,
  clearResolutionAbsent,
  loadResolutionMemory,
  saveResolutionMemory,
  settingsKnownAbsentLine,
  generationResolutionOf
};
