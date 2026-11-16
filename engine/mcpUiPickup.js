'use strict';

// ---------------------------------------------------------------------------
// v2.48.109 (F4 — MCP IN-APP RUNS MUST START LOUDLY OR FAIL LOUDLY):
//
// The in-app start is TWO calls: /api/generation/start-ui here,
// then the app's own /api/generation/start once the app has put
// the prompts in its box and pressed its Generate button. Until
// .109 the bridge answered started:true the moment it had
// BROADCAST the SSE event — it never confirmed the app picked
// the run up. Dart's startGeneration can then refuse the run
// (its re-entry guard: a previous run's state is still
// non-idle while its settle event was lost in a route drop —
// exactly the 2026-11-16 evening, when the route dropped
// repeatedly — or no account is ticked, or the items are
// empty) with only an in-app Activity warning, and nothing
// ever tells MCP or chat: the run vanishes (Gopal Pilot,
// 2026-11-16: solo runs S13, S7B, S13W all answered
// started:true, then NO file, NO charge, NO error).
//
// THE RULE: a start-ui answer is only started:true once the
// app's follow-up /api/generation/start has actually arrived
// (the same count+tag match as the agent-mode stash). The
// bridge waits PICKUP_CONFIRM_WAIT_MS for it; past that the
// answer is started:false with a plain reason, and a 60s
// watchdog still leaves the loud Activity error the brief
// demands, so the miss is visible on the app screen too.
// Pure helpers — unit-tested in the root pack (X113 F4).
// ---------------------------------------------------------------------------

/** How long start-ui waits for the app's follow-up start before answering. */
const PICKUP_CONFIRM_WAIT_MS = 15000;
/** How long after start-ui a still-unconfirmed pickup is logged loudly. */
const PICKUP_WATCHDOG_MS = 60000;
/** A pending pickup older than this can never match a later start. */
const PICKUP_TTL_MS = 180000;

/**
 * Does an arriving /api/generation/start confirm a pending
 * MCP in-app pickup? Same match as the agent-mode stash:
 * same prompt count, same tag when the pending tag is
 * non-empty, and fresh inside the TTL.
 */
function pickupMatches(pending, start) {
  if (!pending || typeof pending !== 'object') return false;
  if (!start || typeof start !== 'object') return false;
  if (typeof pending.at !== 'number' || typeof start.at !== 'number') return false;
  const age = start.at - pending.at;
  if (age < 0 || age > PICKUP_TTL_MS) return false;
  if (pending.count !== start.count) return false;
  if (pending.tag && pending.tag !== start.tag) return false;
  return true;
}

/** The loud Activity error for a pickup that never arrived. */
function pickupMissedMessage(pending) {
  const n = pending && typeof pending.count === 'number' ? pending.count : 0;
  const tag = pending && pending.tag ? ` (tag ${pending.tag})` : '';
  return `MCP in-app run accepted but never started: ${n} prompt(s)${tag} were sent to the app screen and the app did not start them within 60 seconds — no file was made and no credits were spent. Check the app: a run may still be active in Progress, or the app screen may not be on the main screen.`;
}

module.exports = { PICKUP_CONFIRM_WAIT_MS, PICKUP_WATCHDOG_MS, PICKUP_TTL_MS, pickupMatches, pickupMissedMessage };
