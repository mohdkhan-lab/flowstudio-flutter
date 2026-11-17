'use strict';

// ---------------------------------------------------------------------------
// v2.48.112 (A) — THE RUN PLANNER: the credit plan is the ASSIGNMENT.
//
// Before .112 the "credit plan" in WorkerPool.runQueue only PRINTED a
// split ("the map"); the workers then pulled tasks from one shared
// queue ("the road"), so any worker could take any prompt on any
// account, browsers opened on speculation, and a 17-prompt run on
// 50-credit accounts did NOT actually divide 7/7/3. The owner's order
// (2026-11-17): divide the prompts by credit capacity BEFORE the run —
// 50 credits per account, 7 credits per video, so at most 7 videos per
// account — and a browser opens only for an account that HAS work.
//
// planBundles is the pure core of that division:
//   - accounts are considered FULLEST-FIRST (highest balance first),
//     matching a worker's fresh binding elsewhere in the pool;
//   - each account's capacity is floor(credits / requiredCredits);
//   - tasks are dealt IN ORDER: the fullest account takes the first
//     `capacity` tasks, the next account the next chunk, and so on;
//   - tasks that fit nowhere are returned as `spillover` — the caller
//     re-plans them ONCE after the first pass against live balances;
//   - `excludeByTask` (Map taskId -> Set of accountIds) keeps a task
//     out of the bundles of accounts it has already been tried on
//     (used by the re-plan; a task whose every fitting account is
//     excluded lands in the spillover, honestly unplaced).
//
// Image runs (requiredCredits <= 0) have no credit capacity: capacity
// is unbounded, so the fullest account takes the whole run — the same
// "a run that fits one account stays on it" rule the pool has always
// preferred for fresh bindings.
//
// Pure module: no DB, no pool state. The pool validates each bundle's
// account live at bind time (status / ticked / balance) before a
// browser opens; a bundle whose account fails that validation is
// released back to the spillover by the pool, never silently served
// by another account.
// ---------------------------------------------------------------------------

function planBundles({ tasks, accounts, requiredCredits, excludeByTask } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const cost = Number(requiredCredits) || 0;
  const fullestFirst = [...(Array.isArray(accounts) ? accounts : [])].sort((x, y) => {
    const cx = (typeof x.credits === 'number' && Number.isFinite(x.credits)) ? x.credits : 0;
    const cy = (typeof y.credits === 'number' && Number.isFinite(y.credits)) ? y.credits : 0;
    return cy - cx;
  });
  const capacityOf = (account) => {
    if (cost <= 0) return Infinity;
    const c = (typeof account.credits === 'number' && Number.isFinite(account.credits)) ? account.credits : 0;
    return Math.floor(Math.max(0, c) / cost);
  };

  const bundles = [];
  const placed = new Set();
  for (const account of fullestFirst) {
    let capacity = capacityOf(account);
    if (!(capacity > 0)) continue;
    const mine = [];
    for (const task of list) {
      if (capacity <= 0) break;
      if (!task || task.id === undefined || task.id === null) continue;
      if (placed.has(task.id)) continue;
      const excluded = excludeByTask && typeof excludeByTask.get === 'function'
        ? excludeByTask.get(task.id)
        : null;
      if (excluded && typeof excluded.has === 'function' && excluded.has(String(account.id))) continue;
      mine.push(task);
      placed.add(task.id);
      capacity--;
    }
    if (mine.length > 0) {
      bundles.push({
        accountId: account.id,
        accountName: account.googleName || account.name || '',
        tasks: mine,
        taskIds: mine.map(t => t.id)
      });
    }
  }
  const spillover = list.filter(t => t && t.id !== undefined && t.id !== null && !placed.has(t.id));
  return { bundles, spillover };
}

module.exports = { planBundles };
