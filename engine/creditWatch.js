'use strict';

/**
 * FlowStudio Lite — Credits dashboard + low-credit alerts (v2.0.0).
 *
 * DASHBOARD NUMBERS (Accounts page strip):
 *  - Total credits: sum of every account's last-known balance.
 *  - Live accounts: accounts whose status says signed-in & usable
 *    (Ready / Low Credits).
 *  - Today's spend: an ESTIMATED ledger. It is fed ONLY by generation
 *    submissions (the worker pool's credit port): an estimated charge
 *    records its cost; a post-submit live re-read records the observed
 *    balance DROP for that account. Syncs / Verify reads never feed it
 *    (they establish baselines, they are not spend). It is labelled
 *    "andazan" (estimate) in the UI — never presented as Flow's bill.
 *  - Today's videos: usageStats (saved-file count, survives Clear History).
 *  - "Kal ke liye bache" = the total above (what remains for tomorrow).
 *
 * LOW-CREDIT ALERTS: an account with a numeric balance BELOW
 * LOW_CREDIT_THRESHOLD (10) raises ONE alert per account per DAY
 * (app_settings 'credit_alerts_v1': { accountId: 'YYYY-MM-DD' }) — the
 * owner asked for a warning before an account empties, not for spam.
 * The UI badge itself is derived from the balance directly (always
 * current); the once-a-day rule governs the ACTIVITY entry only.
 *
 * Pure/injected-store design (same pattern as usageStats) so every rule
 * is unit-testable in plain Node.
 */

const LOW_CREDIT_THRESHOLD = 10;
const SPEND_KEY = 'credit_spend_v1';
const ALERTS_KEY = 'credit_alerts_v1';

function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function accountLabel(account) {
  return (account && (account.googleName || account.name || account.email)) || 'Account';
}

/** Pure dashboard math from an accounts list. Null balances are unknown, never zero. */
function computeDashboard(accounts, { spendToday = 0, todayVideos = 0 } = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  let totalCredits = 0;
  let knownBalances = 0;
  let liveCount = 0;
  const lowAccounts = [];
  for (const acc of list) {
    if (!acc) continue;
    if (typeof acc.credits === 'number' && Number.isFinite(acc.credits)) {
      totalCredits += acc.credits;
      knownBalances++;
      if (acc.credits < LOW_CREDIT_THRESHOLD && acc.status !== 'Need Login') {
        lowAccounts.push({ id: acc.id, name: accountLabel(acc), credits: acc.credits });
      }
    }
    if (acc.status === 'Ready' || acc.status === 'Low Credits') liveCount++;
  }
  return {
    totalCredits,
    knownBalances,
    accountCount: list.length,
    liveCount,
    lowAccounts,
    spendToday: Math.max(0, Math.round(Number(spendToday) || 0)),
    todayVideos: Math.max(0, Number(todayVideos) || 0)
  };
}

function createCreditWatch(store) {
  if (!store || typeof store.getSetting !== 'function' || typeof store.setSetting !== 'function') {
    throw new Error('createCreditWatch requires a store with getSetting(key, default) and setSetting(key, value)');
  }
  const lastLiveBalance = new Map(); // accountId -> last balance seen via the POOL port only

  function loadLedger() {
    try {
      const parsed = JSON.parse(store.getSetting(SPEND_KEY, '') || '{}');
      if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') return parsed;
    } catch (e) {}
    return { days: {} };
  }

  function recordSpend(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const ledger = loadLedger();
    const key = dayKey();
    ledger.days[key] = (Number(ledger.days[key]) || 0) + n;
    // Prune to the last 35 days so the settings blob stays tiny.
    const keys = Object.keys(ledger.days).sort();
    while (keys.length > 35) {
      delete ledger.days[keys.shift()];
    }
    try { store.setSetting(SPEND_KEY, JSON.stringify(ledger)); } catch (e) {}
    return ledger.days[key];
  }

  return {
    recordSpend,

    todaySpend() {
      return Number(loadLedger().days[dayKey()]) || 0;
    },

    /**
     * Feed from the pool's credit port. A live balance read LOWER than
     * the previous pool-observed balance for the same account means a
     * charge landed between the reads — record the drop as spend. The
     * first read per account is a baseline (records nothing). Returns
     * the spend recorded by this observation (0 when none).
     */
    observeLiveBalance(accountId, balance) {
      const n = Number(balance);
      if (!accountId || !Number.isFinite(n) || n < 0) return 0;
      const prev = lastLiveBalance.get(accountId);
      lastLiveBalance.set(accountId, n);
      if (prev === undefined || n >= prev) return 0;
      return recordSpend(prev - n) ? (prev - n) : 0;
    },

    /**
     * Feed from the pool's estimated-charge path. 'ok' and
     * 'needs-live-check' both mean the submission fired and Flow took
     * the credits — record the estimated cost. ('unknown' records
     * nothing: no evidence a charge happened.)
     */
    observeEstimatedCharge(accountId, cost, outcome) {
      if (outcome !== 'ok' && outcome !== 'needs-live-check') return 0;
      return recordSpend(cost) ? Number(cost) : 0;
    },

    /**
     * Raise low-credit alerts for accounts newly below the threshold
     * today. onAlert(account) fires once per account per day; returns
     * the accounts alerted by THIS call.
     */
    checkLowAlerts(accounts, onAlert) {
      const list = Array.isArray(accounts) ? accounts : [];
      let state = {};
      try { state = JSON.parse(store.getSetting(ALERTS_KEY, '') || '{}') || {}; } catch (e) { state = {}; }
      const today = dayKey();
      const alerted = [];
      for (const acc of list) {
        if (!acc || acc.id == null) continue;
        if (typeof acc.credits !== 'number' || !Number.isFinite(acc.credits)) continue;
        if (acc.credits >= LOW_CREDIT_THRESHOLD) continue;
        if (acc.status === 'Need Login') continue;
        if (state[acc.id] === today) continue;
        state[acc.id] = today;
        alerted.push(acc);
        if (typeof onAlert === 'function') {
          try { onAlert(acc); } catch (e) {}
        }
      }
      if (alerted.length) {
        try { store.setSetting(ALERTS_KEY, JSON.stringify(state)); } catch (e) {}
      }
      return alerted;
    }
  };
}

// Production glue ------------------------------------------------------------

/** Dashboard for the real app: dbService balances + spend ledger + usage. */
function getDashboard() {
  const { dbService } = require('./db');
  const usageStats = require('./usageStats');
  const watch = createCreditWatch(dbService);
  const usage = usageStats.getStats(dbService);
  return computeDashboard(dbService.getAccounts(), {
    spendToday: watch.todaySpend(),
    todayVideos: usage.today
  });
}

module.exports = {
  LOW_CREDIT_THRESHOLD,
  dayKey,
  computeDashboard,
  createCreditWatch,
  getDashboard
};
