/**
 * FlowStudio Lite — Usage Stats (v1.8.0, ZDola-style counts).
 *
 * ZDola keeps ONLY counts of the videos it made — no prompts, no file
 * names, no account details — in a small local store that survives
 * history clears. Lite v1.8 adopts the same rule: a single JSON blob in
 * app_settings ('usage_stats_v1') holding an all-time total plus a
 * per-day map. recordSaved() is called by WorkerPool exactly once per
 * task completion; getStats() feeds the History header line.
 * v2.29.0: the blob also carries a per-day CREDITS-spent map
 * (creditsDays), fed by the same recordSaved() calls.
 *
 * The store interface is injected ({ getSetting, setSetting }) so the
 * counting rules are unit-testable in plain Node; production passes
 * dbService.
 *
 * PUBLIC v1.0.16: the blob also carries the all-time GENERATION
 * outcome counters the panel report needs — genSuccess (saved
 * completions, fed by the same recordSaved() calls as `total`),
 * genFailed (terminal failures, fed by recordGenFailure() from
 * dbService.failTask's once-only state transition) and
 * creditsUsed (the cumulative sum of the per-video credit costs
 * recordSaved() is handed — the run's own getRequiredCredits
 * figure, never an estimate invented at report time). Unlike the
 * per-day maps these three are NEVER pruned. Migration for blobs
 * written before v1.0.16 (which lack the fields): genSuccess
 * starts from `total` (recordSaved always fed both from the same
 * event), creditsUsed starts from the sum of the surviving
 * creditsDays (a floor — pruned days are gone), genFailed starts
 * at 0 (failures were never recorded before). getGenStats() is
 * the report's reader: it returns null when the stored blob
 * cannot be read truthfully (unparseable / not an object / the
 * store throws), so the report OMITS the fields instead of
 * sending wrong zeros; a device with no blob at all truthfully
 * reports zeros.
 */

const SETTING_KEY = 'usage_stats_v1';
const KEEP_DAYS = 62; // prune day entries older than ~2 months

function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// PUBLIC v1.0.16: the generation-outcome fields of a parsed
// blob, with the pre-v1.0.16 migration defaults (see the header
// note). A stored finite number always wins; anything else
// falls back.
function genFieldsFrom(parsed, total, creditsDays) {
  const pick = (v, fallback) =>
    (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : fallback;
  let daysSum = 0;
  if (creditsDays && typeof creditsDays === 'object') {
    for (const v of Object.values(creditsDays)) daysSum += Number(v) || 0;
  }
  return {
    genSuccess: pick(parsed.genSuccess, Number(total) || 0),
    genFailed: pick(parsed.genFailed, 0),
    creditsUsed: pick(parsed.creditsUsed, daysSum)
  };
}

function loadStats(store) {
  try {
    const raw = store.getSetting(SETTING_KEY, null);
    if (!raw) return { total: 0, days: {}, creditsDays: {}, genSuccess: 0, genFailed: 0, creditsUsed: 0 };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { total: 0, days: {}, creditsDays: {}, genSuccess: 0, genFailed: 0, creditsUsed: 0 };
    const total = Number(parsed.total) || 0;
    const creditsDays = (parsed.creditsDays && typeof parsed.creditsDays === 'object') ? parsed.creditsDays : {};
    return {
      total,
      days: (parsed.days && typeof parsed.days === 'object') ? parsed.days : {},
      // v2.30.0 fix: creditsDays MUST round-trip through loadStats.
      // Before, loadStats returned only { total, days } — so
      // getStats() always read creditsDays as undefined and
      // "TODAY'S SPEND (CREDITS)" showed 0 forever, and every
      // recordSaved() rewrote the map from an empty base, wiping
      // earlier days' spend.
      creditsDays,
      // v1.0.16: the generation-outcome counters round-trip too
      // (same lesson as creditsDays above — a field loadStats
      // drops is a field every write silently resets).
      ...genFieldsFrom(parsed, total, creditsDays)
    };
  } catch (e) {
    return { total: 0, days: {}, creditsDays: {}, genSuccess: 0, genFailed: 0, creditsUsed: 0 };
  }
}

function pruneDays(days, now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
  const cutoffKey = dayKey(cutoff);
  const out = {};
  for (const [k, v] of Object.entries(days)) {
    if (k >= cutoffKey) out[k] = v;
  }
  return out;
}

function recordSaved(store, creditsSpent) {
  if (!store || typeof store.getSetting !== 'function' || typeof store.setSetting !== 'function') {
    return null;
  }
  const stats = loadStats(store);
  const today = dayKey();
  stats.total += 1;
  // v1.0.16: a saved completion IS a successful generation —
  // the same once-per-completion event feeds genSuccess, so it
  // can never drift from the saved-videos total.
  stats.genSuccess = (Number(stats.genSuccess) || 0) + 1;
  stats.days[today] = (Number(stats.days[today]) || 0) + 1;
  stats.days = pruneDays(stats.days);
  // v2.29.0: REAL credits spent per day — the Activity panel's
  // "Spent today" used to be a fake `videos × 7` multiplication.
  // The caller (WorkerPool) passes the run's actual per-video credit
  // cost (0 for a recovery download, which spends nothing new).
  const spent = Number(creditsSpent);
  if (Number.isFinite(spent) && spent > 0) {
    if (!stats.creditsDays || typeof stats.creditsDays !== 'object') {
      stats.creditsDays = {};
    }
    stats.creditsDays[today] = (Number(stats.creditsDays[today]) || 0) + spent;
    stats.creditsDays = pruneDays(stats.creditsDays);
    // v1.0.16: the all-time spent total rides the same figure —
    // never pruned, unlike the per-day map.
    stats.creditsUsed = (Number(stats.creditsUsed) || 0) + spent;
  }
  store.setSetting(SETTING_KEY, JSON.stringify(stats));
  return stats;
}

// PUBLIC v1.0.16: one terminal generation failure. Called by
// dbService.failTask ONLY on the state transition into 'failed'
// (the once-only guard lives there — this function counts every
// call it receives). Same fail-soft contract as recordSaved.
function recordGenFailure(store) {
  if (!store || typeof store.getSetting !== 'function' || typeof store.setSetting !== 'function') {
    return null;
  }
  const stats = loadStats(store);
  stats.genFailed = (Number(stats.genFailed) || 0) + 1;
  store.setSetting(SETTING_KEY, JSON.stringify(stats));
  return stats;
}

// PUBLIC v1.0.16: the report's read of the generation counters.
// Returns { genSuccess, genFailed, creditsUsed }, or null when
// the stored blob cannot be read truthfully (the store throws,
// or a blob exists but is unparseable / not an object) — the
// caller then OMITS the fields from the report rather than
// sending wrong zeros (the v1.0.15 credits convention). No blob
// at all is a fresh device: truthful zeros.
function getGenStats(store) {
  if (!store || typeof store.getSetting !== 'function') return null;
  let raw;
  try {
    raw = store.getSetting(SETTING_KEY, null);
  } catch (e) {
    return null;
  }
  if (raw === null || raw === undefined || raw === '') {
    return { genSuccess: 0, genFailed: 0, creditsUsed: 0 };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const total = Number(parsed.total) || 0;
  const creditsDays = (parsed.creditsDays && typeof parsed.creditsDays === 'object') ? parsed.creditsDays : {};
  return genFieldsFrom(parsed, total, creditsDays);
}

function getStats(store) {
  const stats = loadStats(store);
  const today = dayKey();
  let last7 = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    last7 += Number(stats.days[dayKey(d)]) || 0;
  }
  const creditsDays = (stats.creditsDays && typeof stats.creditsDays === 'object') ? stats.creditsDays : {};
  return {
    total: stats.total,
    today: Number(stats.days[today]) || 0,
    last7Days: last7,
    creditsToday: Number(creditsDays[today]) || 0
  };
}

module.exports = { recordSaved, recordGenFailure, getStats, getGenStats, dayKey, SETTING_KEY };
