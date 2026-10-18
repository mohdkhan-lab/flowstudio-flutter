/**
 * FlowStudio Lite — Credit Service.
 *
 * AUDIT FIX #4: This module is the ONLY writer of account `credits` and
 * `status` in the entire app. Every update is a targeted single-row UPDATE
 * (UPDATE accounts SET ... WHERE id = ?) built from a FRESH read of that
 * one row. No full-array snapshot saves exist anywhere in Lite.
 *
 * AUDIT FIX #2: A real credit balance is NEVER zeroed except by:
 *   - applyLiveBalance(id, 0)      — an explicit live read of 0, or
 *   - applyExhaustionBanner(id)    — Flow's own out-of-credits banner.
 * "Balance < required for the chosen model" is recorded as status
 * 'LowCredits' with the real balance left intact — it is a skip reason,
 * not exhaustion. Estimated charges never write a 0 balance.
 *
 * AUDIT FIX #3: An ambiguous live check (selectors missing / page slow /
 * inconclusive) changes NOTHING except last_checked and reports outcome
 * 'unknown'. Only an explicit redirect to accounts.google.com/signin may
 * set 'Need Login' — and even then the last known balance is kept.
 *
 * The store interface is injected so the rules can be unit-tested in plain
 * Node: store = { getAccount(id), updateAccountFields(id, fields) }.
 * In production the store is dbService.
 */

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// v1.8.0 (ZDola-logic edition): two health mechanisms live here because
// creditService is the only writer of account status.
//  - TIMED REST: 'Cooldown' now carries rest_until + an escalating
//    cooldown_level (30m -> 2h -> 12h). Any confirmed-live outcome
//    (live balance / login detected / manual ready) clears the rest.
//  - TWO-STRIKE SIGN-OUT: ZDola never declares a login dead on a single
//    failed look. applySignOutObservation() records a strike and marks
//    the account 'Unconfirmed'; only a SECOND explicit sign-out inside
//    24h confirms 'Need Login' (via the original applyExplicitSignOut,
//    balance still preserved). Any live confirmation clears the strikes.
const STRIKE_WINDOW_MS = 24 * 60 * 60 * 1000;
const REST_MINUTES_BY_LEVEL = [30, 120, 720];
const CLEARED_HEALTH = { restUntil: '', signoutStrikes: 0, strikeAt: '', cooldownLevel: 0 };

function createCreditService(store) {
  if (!store || typeof store.getAccount !== 'function' || typeof store.updateAccountFields !== 'function') {
    throw new Error('createCreditService requires a store with getAccount(id) and updateAccountFields(id, fields)');
  }

  function fresh(id) {
    return store.getAccount(id);
  }

  return {
    /**
     * An authoritative balance read from the live Flow page.
     * n === 0 is one of only two paths allowed to zero a balance.
     */
    applyLiveBalance(id, balance) {
      const n = Number(balance);
      if (!Number.isFinite(n) || n < 0) {
        return { outcome: 'unknown', reason: 'invalid-balance' };
      }
      const acc = fresh(id);
      if (!acc) return { outcome: 'unknown', reason: 'account-not-found' };
      const status = n === 0 ? 'Exhausted' : 'Ready';
      const updated = store.updateAccountFields(id, {
        credits: n,
        status,
        lastChecked: nowTime(),
        // A confirmed live read resolves every health question (v1.8).
        ...CLEARED_HEALTH
      });
      return { outcome: n === 0 ? 'exhausted' : 'ok', account: updated };
    },

    /**
     * Flow displayed its own out-of-credits / insufficient-credits banner.
     * The second (and only other) path allowed to zero a balance.
     */
    applyExhaustionBanner(id) {
      const acc = fresh(id);
      if (!acc) return { outcome: 'unknown', reason: 'account-not-found' };
      const updated = store.updateAccountFields(id, {
        credits: 0,
        status: 'Exhausted',
        lastChecked: nowTime()
      });
      return { outcome: 'exhausted', account: updated };
    },

    /**
     * Balance is real but below the cost of the chosen model/settings.
     * Records 'LowCredits' and KEEPS the balance exactly as-is.
     */
    applyLowCredits(id, required) {
      const acc = fresh(id);
      if (!acc) return { outcome: 'unknown', reason: 'account-not-found' };
      if (acc.status === 'Need Login') {
        return { outcome: 'need-login', account: acc };
      }
      const bal = (typeof acc.credits === 'number') ? acc.credits : null;
      if (bal !== null && typeof required === 'number' && bal >= required) {
        return { outcome: 'ok', account: acc };
      }
      const updated = store.updateAccountFields(id, {
        status: 'LowCredits',
        lastChecked: nowTime()
        // credits deliberately untouched — the real balance stays intact.
      });
      return { outcome: 'low-credits', account: updated };
    },

    /**
     * Local estimate after a submission fires (used only when no live
     * re-read was possible). NEVER writes 0: if the estimate would drain
     * the balance, the stored balance is left alone and the caller is told
     * a live check is needed.
     */
    applyEstimatedCharge(id, cost) {
      const acc = fresh(id);
      if (!acc) return { outcome: 'unknown', reason: 'account-not-found' };
      const bal = (typeof acc.credits === 'number') ? acc.credits : null;
      const c = Number(cost);
      if (bal === null || !Number.isFinite(c) || c <= 0) {
        return { outcome: 'unknown', account: acc };
      }
      const estimate = bal - c;
      if (estimate <= 0) {
        // Do NOT zero an estimated balance (audit fix #2).
        return { outcome: 'needs-live-check', account: acc };
      }
      const updated = store.updateAccountFields(id, { credits: estimate });
      return { outcome: 'ok', account: updated };
    },

    /**
     * The live check could not confirm login state (selectors missing,
     * page slow, evaluation failed). Status and credits stay EXACTLY as
     * they were; only the check timestamp moves.
     */
    applyAmbiguousCheck(id) {
      const acc = fresh(id);
      if (!acc) return { outcome: 'unknown', reason: 'account-not-found' };
      const updated = store.updateAccountFields(id, { lastChecked: nowTime() });
      return { outcome: 'unknown', account: updated };
    },

    /**
     * Explicit redirect to accounts.google.com/signin — the ONLY path that
     * may set 'Need Login'. The last known balance is preserved.
     */
    applyExplicitSignOut(id) {
      const acc = fresh(id);
      if (!acc) return { outcome: 'unknown', reason: 'account-not-found' };
      const updated = store.updateAccountFields(id, {
        status: 'Need Login',
        lastChecked: nowTime()
        // credits deliberately untouched (audit fix #3).
      });
      return { outcome: 'need-login', account: updated };
    },

    /**
     * Login confirmed (account panel / Preferences poll saw the user).
     * Sets 'Ready' and identity fields; credits are only changed when an
     * explicit numeric balance is supplied alongside.
     */
    applyLoginDetected(id, identity = {}) {
      const acc = fresh(id);
      if (!acc) return { outcome: 'unknown', reason: 'account-not-found' };
      const fields = { status: 'Ready', lastChecked: nowTime(), ...CLEARED_HEALTH };
      if (identity.email) fields.email = identity.email;
      if (identity.googleName) fields.googleName = identity.googleName;
      if (typeof identity.credits === 'number' && Number.isFinite(identity.credits)) {
        fields.credits = identity.credits;
        if (identity.credits === 0) fields.status = 'Exhausted';
      }
      const updated = store.updateAccountFields(id, fields);
      return { outcome: 'ok', account: updated };
    },

    /**
     * Google "unusual activity" cooldown — v1.8.0: a TIMED rest
     * (ZDola-style). Duration escalates with the account's cooldown
     * level: 30 min, then 2 h, then 12 h. Credits untouched. The pool
     * skips the account until rest_until passes, then lets it back in
     * for a live check (which clears the level on success).
     */
    applyCooldown(id, minutes) {
      const acc = fresh(id);
      if (!acc) return { outcome: 'unknown', reason: 'account-not-found' };
      const level = Math.max(0, Number(acc.cooldownLevel) || 0);
      const mins = Number.isFinite(minutes) && minutes > 0
        ? minutes
        : REST_MINUTES_BY_LEVEL[Math.min(level, REST_MINUTES_BY_LEVEL.length - 1)];
      const restUntil = new Date(Date.now() + mins * 60000).toISOString();
      const updated = store.updateAccountFields(id, {
        status: 'Cooldown',
        lastChecked: nowTime(),
        restUntil,
        cooldownLevel: level + 1
      });
      return { outcome: 'cooldown', minutes: mins, restUntil, account: updated };
    },

    /**
     * v1.8.0 — one explicit sign-out OBSERVATION (an actual redirect to
     * accounts.google.com; nothing weaker may call this). First strike
     * inside 24h: status 'Unconfirmed', balance preserved, and the
     * caller must not treat the account as dead yet. Second strike:
     * confirmed 'Need Login' via applyExplicitSignOut.
     */
    applySignOutObservation(id) {
      const acc = fresh(id);
      if (!acc) return { outcome: 'unknown', reason: 'account-not-found' };
      const lastStrike = acc.strikeAt ? Date.parse(acc.strikeAt) : NaN;
      const withinWindow = Number.isFinite(lastStrike) && (Date.now() - lastStrike) < STRIKE_WINDOW_MS;
      const strikes = withinWindow ? (Number(acc.signoutStrikes) || 0) + 1 : 1;
      if (strikes >= 2) {
        const res = this.applyExplicitSignOut(id);
        return { outcome: 'need-login', confirmed: true, strikes, account: res.account };
      }
      const updated = store.updateAccountFields(id, {
        status: 'Unconfirmed',
        lastChecked: nowTime(),
        signoutStrikes: strikes,
        strikeAt: new Date().toISOString()
        // credits deliberately untouched — an unconfirmed account is
        // not a dead account (ZDola double-confirm rule).
      });
      return { outcome: 'unconfirmed', confirmed: false, strikes, account: updated };
    },

    /** Manual re-enable (e.g. user clicked Sync and account responded). */
    applyReady(id) {
      const acc = fresh(id);
      if (!acc) return { outcome: 'unknown', reason: 'account-not-found' };
      const updated = store.updateAccountFields(id, {
        status: 'Ready',
        lastChecked: nowTime(),
        ...CLEARED_HEALTH
      });
      return { outcome: 'ok', account: updated };
    }
  };
}

// Production singleton bound to dbService.
let _defaultService = null;
function getCreditService() {
  if (!_defaultService) {
    const { dbService } = require('./db');
    _defaultService = createCreditService(dbService);
  }
  return _defaultService;
}

module.exports = { createCreditService, getCreditService };
