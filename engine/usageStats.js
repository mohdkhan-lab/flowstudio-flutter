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
 */

const SETTING_KEY = 'usage_stats_v1';
const KEEP_DAYS = 62; // prune day entries older than ~2 months

function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function loadStats(store) {
  try {
    const raw = store.getSetting(SETTING_KEY, null);
    if (!raw) return { total: 0, days: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { total: 0, days: {} };
    return {
      total: Number(parsed.total) || 0,
      days: (parsed.days && typeof parsed.days === 'object') ? parsed.days : {}
    };
  } catch (e) {
    return { total: 0, days: {} };
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
  }
  store.setSetting(SETTING_KEY, JSON.stringify(stats));
  return stats;
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

module.exports = { recordSaved, getStats, dayKey, SETTING_KEY };
