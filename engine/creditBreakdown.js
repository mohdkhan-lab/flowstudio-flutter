'use strict';

// ---------------------------------------------------------------------------
// v2.48.114 (Z2b) — THE CREDIT-GATE BREAKDOWN (pure).
//
// The pre-flight gate has always known three numbers — what the run
// needs, what the usable accounts hold — but its message named only
// the usable figure. In the field (2026-11-17) the app said "usable
// 94" while the owner was looking at 142 total credits in the app,
// and from his side the app was simply lying. It was not: 43 credits
// sat on an account resting on a Flow "unusual activity" cooldown
// and 5 more were spread over five 1-credit accounts that cannot
// afford even one video — but the gate never SAID so.
//
// computeCreditBreakdown partitions the run's account universe (the
// accounts the run may consider — the owner's ticked set minus
// Need-Login — captured BEFORE the live-only and balance filters
// remove anyone) into the part the gate counted (countedIds) and the
// excluded remainder, split by reason:
//   - resting:   status Cooldown with the rest still running
//                (the caller's isResting decides), credits >= cost
//                or not — rest is the headline reason;
//   - underCost: known balance below one video's cost.
// Accounts with an unknown (never-read) balance carry no credits
// into any figure. The gate's own math is NOT touched by this
// module: it only explains the numbers the gate already computed,
// and total = the universe's known credits, so the message always
// reconciles (usable + resting + under-cost + any unclassified
// remainder = total).
//
// Pure module: no DB, no pool state — the caller passes the rows,
// the counted id set and the resting test.
// ---------------------------------------------------------------------------

function knownCredits(a) {
  if (!a) return null;
  const c = (typeof a.credits === 'number' && Number.isFinite(a.credits)) ? a.credits : null;
  return c === null ? null : Math.max(0, c);
}

function computeCreditBreakdown(accounts, { requiredCredits = 0, countedIds = null, isResting = null } = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  const cost = Number(requiredCredits) || 0;
  const counted = countedIds instanceof Set ? countedIds : new Set();
  let total = 0;
  let restingCount = 0;
  let restingCredits = 0;
  let underCount = 0;
  let underCredits = 0;
  for (const a of list) {
    const c = knownCredits(a);
    if (c === null) continue;
    total += c;
    if (counted.has(String(a.id))) continue;
    let resting = false;
    try { resting = typeof isResting === 'function' ? !!isResting(a) : false; } catch (e) { resting = false; }
    if (resting) {
      restingCount++;
      restingCredits += c;
    } else if (cost > 0 && c < cost) {
      underCount++;
      underCredits += c;
    }
  }
  return {
    total,
    restingCount,
    restingCredits,
    underCount,
    underCredits,
    hasExclusions: restingCount > 0 || underCount > 0
  };
}

/** The exclusion reasons as plain-word parts, in message order. */
function creditBreakdownParts(bd, requiredCredits) {
  const parts = [];
  if (!bd) return parts;
  if (bd.restingCount > 0) {
    parts.push(`${bd.restingCredits} on ${bd.restingCount} resting account${bd.restingCount === 1 ? '' : 's'}`);
  }
  if (bd.underCount > 0) {
    parts.push(`${bd.underCredits} spread over ${bd.underCount} account${bd.underCount === 1 ? '' : 's'} under ${requiredCredits} each`);
  }
  return parts;
}

/** " of 142 total" — appended to the gate's usable figure. */
function creditGateTotalSegment(bd) {
  return bd ? ` of ${bd.total} total` : '';
}

/** " (43 on 1 resting account, 5 spread over 5 accounts under 7 each)" — or ''. */
function creditGateExclusionSegment(bd, requiredCredits) {
  const parts = creditBreakdownParts(bd, requiredCredits);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

module.exports = {
  computeCreditBreakdown,
  creditBreakdownParts,
  creditGateTotalSegment,
  creditGateExclusionSegment
};
