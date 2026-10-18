/**
 * FlowStudio Lite — Account Health (v1.8.0, ZDola logic adapted to Flow).
 *
 * What ZDola gets right, and Lite did not have until now:
 *  1. TIMED REST. When Google throttles an account ("unusual activity"),
 *     ZDola parks it for a real duration and the rotation skips it until
 *     the rest expires — first rest short, repeats longer. Lite's old
 *     'Cooldown' status was permanent until a manual Sync. Here the rest
 *     lives on the account row (rest_until + cooldown_level, written via
 *     creditService) and expiry is automatic.
 *  2. DOUBLE-CONFIRMED SIGN-OUT + VERIFY PASS. ZDola never declares a
 *     login dead on one failed look: the rejection must be confirmed
 *     twice (creditService.applySignOutObservation implements the two
 *     strikes), and accounts a check could not confirm are retried once
 *     automatically. verifyAllAccounts() below is that pass: it runs the
 *     existing per-account live check (fetchRealCredits) with bounded
 *     concurrency and classifies every account into
 *     live / low / exhausted / need-login / unconfirmed / unknown.
 *
 * Nothing here writes credits or status directly — every outcome is
 * applied by creditService through fetchRealCredits (fix #4 holds).
 */

const REST_MINUTES_BY_LEVEL = [30, 120, 720]; // 30m, 2h, 12h — repeats escalate

function restMinutesForLevel(level) {
  const idx = Math.max(0, Math.min(REST_MINUTES_BY_LEVEL.length - 1, Number(level) || 0));
  return REST_MINUTES_BY_LEVEL[idx];
}

/** True while the account's timed rest is still running. */
function isResting(account, now = Date.now()) {
  if (!account || account.status !== 'Cooldown') return false;
  if (!account.restUntil) return true; // legacy cooldown without a clock stays parked
  const until = Date.parse(account.restUntil);
  return Number.isFinite(until) ? until > now : true;
}

function restRemainingMs(account, now = Date.now()) {
  if (!isResting(account, now)) return 0;
  if (!account.restUntil) return Infinity;
  return Math.max(0, Date.parse(account.restUntil) - now);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Classify ONE account from a fetchRealCredits-style result plus a FRESH
 * read of the account row (creditService has already applied the outcome
 * to the row by the time the fetch returns).
 */
function classifyOutcome(fetchResult, freshAccount) {
  if (fetchResult && fetchResult.explicitSignedOut) {
    // creditService's two-strike rule decides: confirmed -> 'Need Login',
    // first strike -> 'Unconfirmed'.
    return (freshAccount && freshAccount.status === 'Need Login') ? 'need-login' : 'unconfirmed';
  }
  if (fetchResult && fetchResult.success) {
    const status = freshAccount ? freshAccount.status : null;
    if (status === 'Exhausted') return 'exhausted';
    if (status === 'LowCredits') return 'low';
    return 'live';
  }
  if (freshAccount && freshAccount.status === 'Exhausted') return 'exhausted';
  if (freshAccount && freshAccount.status === 'LowCredits') return 'low';
  return 'unknown';
}

/**
 * The ZDola-style verify pass over every account.
 *
 * deps (injected for tests):
 *  - fetchCredits(accountId) -> fetchRealCredits-shaped result
 *  - getAccount(id) -> fresh account row
 *  - listAccounts() -> accounts to verify
 * Options: concurrency (default 3 — browser checks are heavy), retryDelayMs,
 * onProgress(result) called as each account finishes.
 *
 * An 'unknown' first attempt is retried exactly ONCE (ZDola: accounts a
 * check could not confirm are tried once more automatically). A confirmed
 * classification is never re-checked.
 */
async function verifyAllAccounts(deps = {}, options = {}) {
  const fetchCredits = deps.fetchCredits;
  const getAccount = deps.getAccount;
  const listAccounts = deps.listAccounts;
  if (typeof fetchCredits !== 'function' || typeof getAccount !== 'function' || typeof listAccounts !== 'function') {
    throw new Error('verifyAllAccounts requires deps { fetchCredits, getAccount, listAccounts }');
  }
  const concurrency = Math.max(1, Math.min(6, Number(options.concurrency) || 3));
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 1500;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const accounts = listAccounts() || [];
  const results = [];
  let cursor = 0;

  async function checkOne(acc) {
    let fetchResult = null;
    try {
      fetchResult = await fetchCredits(acc.id);
    } catch (e) {
      fetchResult = { success: false, error: e.message };
    }
    let outcome = classifyOutcome(fetchResult, getAccount(acc.id));
    let attempts = 1;
    if (outcome === 'unknown' || outcome === 'unconfirmed') {
      // ZDola rule, both halves: an inconclusive check is retried once,
      // and a first-strike sign-out gets its second confirmation look
      // inside the same pass — 'Need Login' is only ever reported when
      // two explicit sign-outs agree.
      if (retryDelayMs > 0) await sleep(retryDelayMs);
      attempts = 2;
      try {
        fetchResult = await fetchCredits(acc.id);
      } catch (e) {
        fetchResult = { success: false, error: e.message };
      }
      outcome = classifyOutcome(fetchResult, getAccount(acc.id));
    }
    const fresh = getAccount(acc.id);
    const entry = {
      id: acc.id,
      name: acc.name,
      outcome,
      attempts,
      status: fresh ? fresh.status : null,
      credits: fresh ? fresh.credits : null
    };
    results.push(entry);
    if (onProgress) {
      try { onProgress(entry); } catch (e) {}
    }
    return entry;
  }

  const lanes = [];
  const laneCount = Math.min(concurrency, accounts.length);
  for (let i = 0; i < laneCount; i++) {
    lanes.push((async () => {
      while (cursor < accounts.length) {
        const acc = accounts[cursor++];
        await checkOne(acc);
      }
    })());
  }
  await Promise.all(lanes);

  const summary = { live: 0, low: 0, exhausted: 0, needLogin: 0, unconfirmed: 0, unknown: 0, total: results.length };
  for (const r of results) {
    if (r.outcome === 'need-login') summary.needLogin++;
    else if (summary[r.outcome] !== undefined) summary[r.outcome]++;
  }
  return { results, summary };
}

module.exports = {
  REST_MINUTES_BY_LEVEL,
  restMinutesForLevel,
  isResting,
  restRemainingMs,
  classifyOutcome,
  verifyAllAccounts
};
