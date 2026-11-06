'use strict';

/**
 * FlowStudio Lite — USABLE credits total (v2.48.61).
 *
 * Owner's bug report (2026-11-06): the top bar showed "53 credits"
 * while only 3 were actually spendable. The old totals (Dart
 * AccountsProvider.totalCredits and MCP flowstudio_get_credits)
 * summed the STORED balance of every account — including 'Need
 * Login' accounts whose Google session is dead. A dead session
 * cannot spend a single credit ((20) showed 42, (24) showed 8),
 * so the stored sum poses as money that is not there.
 *
 * THE ONE DEFINITION (mirrors the run planner in workerPool.js):
 * a run's account pool is built as
 *     pool = all.filter(a => a.status !== 'Need Login')
 * and the pre-flight credit gate then sums the finite balances of
 * the accounts in that pool ("the usable accounts hold N"). An
 * account is therefore USABLE exactly when its status is not
 * 'Need Login':
 *   - 'Ready'      -> usable (session alive)
 *   - 'LowCredits' -> usable — the planner keeps it in the pool;
 *                     a per-run skip happens only when its balance
 *                     cannot fit THAT run's per-video cost, which
 *                     is a run-specific decision, not usability
 *   - 'Exhausted'  -> usable, contributes its real 0
 *   - 'Need Login' -> NOT usable (dead session; balance is a
 *                     preserved last-known number, not spendable)
 * A balance that was never read (null / non-finite) contributes 0,
 * exactly like the gate's known-balance loop.
 *
 * This module is the single source for the DISPLAY totals (MCP
 * totalCredits here; the Dart provider mirrors the same rule).
 * The planner's own gate code is deliberately untouched — its
 * numbers stay identical for every account mix.
 */

function isUsableAccount(acc) {
  return !!acc && acc.status !== 'Need Login';
}

function finiteCredits(acc) {
  const c = acc && acc.credits;
  return (typeof c === 'number' && Number.isFinite(c)) ? Math.max(0, c) : 0;
}

/** Spendable total: balances of usable accounts only. */
function usableCreditsTotal(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  let total = 0;
  for (const acc of list) {
    if (isUsableAccount(acc)) total += finiteCredits(acc);
  }
  return total;
}

/** Stored total: every account's recorded balance (the old figure,
 * kept only as a secondary, clearly-named number). */
function storedCreditsTotal(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  let total = 0;
  for (const acc of list) total += finiteCredits(acc);
  return total;
}

module.exports = { isUsableAccount, usableCreditsTotal, storedCreditsTotal };
