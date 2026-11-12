'use strict';

// ---------------------------------------------------------------------------
// v2.48.97 (AGENT RULES — the API-driven decider is GONE): the pure
// rule set behind Agent Prompt mode. The owner removed the external
// decision service entirely ("the replies from the Agent's side are
// mostly all alike anyway"), so Agent mode now runs on FIXED RULES
// only. This module is those rules — numbers and text patterns, no
// network, no keys, no external calls of any kind:
//
//   - the Agent's flat per-video quote table by model (field-
//     calibrated live on 2026-11-12 at x1 outputs),
//   - the app-model -> Agent-model label mapping,
//   - quoted-cost + named-model extraction from a proposal's text,
//   - THE DECISION: approve only when the quoted cost is at or
//     under the run's own expected cost; when the proposal's model
//     is pricier than the run's model, one settings-fix retry is
//     allowed; anything else over cost is rejected and parked.
//
// The DOM driving lives in engine/agentDriver.js; the sacred
// download pipeline is untouched (a download-stage failure never
// comes back here).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AGENT QUOTES (field-calibrated 2026-11-12): Flow's Agent has NO
// duration control — it picks the duration itself — and quotes a
// flat per-video price for the model IT will use, observed live at
// x1 outputs: Omni 1.2 Flash = 12, Veo 3.1 - Lite = 10, Omni 1.1
// Flash = 7. Veo Fast / Quality follow the app's known flat Veo
// rates (20 / 100).
// ---------------------------------------------------------------------------

/** Flow Agent model label (its settings dropdown) -> flat quote at x1. */
const AGENT_MODEL_QUOTES = {
  'Omni 1.1 Flash': 7,
  'Omni 1.2 Flash': 12,
  'Veo 3.1 - Lite': 10,
  'Veo 3.1 - Fast': 20,
  'Veo 3.1 - Quality': 100
};

/** The app's model names (Settings dropdown) -> Flow Agent labels. */
const AGENT_MODEL_MAP = {
  'Omni Flash': 'Omni 1.1 Flash',
  'Omni 1.2 Flash': 'Omni 1.2 Flash',
  'Veo 3.1 Lite': 'Veo 3.1 - Lite',
  'Veo 3.1 Fast': 'Veo 3.1 - Fast',
  'Veo 3.1 Quality': 'Veo 3.1 - Quality'
};

/**
 * Map a run's app model to the Flow Agent's own label + flat
 * quote. Returns null for a model with no Agent mapping (the
 * driver then leaves the project's Agent model default alone and
 * the expected cost falls back to unknown).
 */
function mapAgentModel(appModel) {
  const flowLabel = AGENT_MODEL_MAP[String(appModel || '').trim()];
  if (!flowLabel) return null;
  return { flowLabel, quote: AGENT_MODEL_QUOTES[flowLabel] };
}

/**
 * The flat-quote expected cost for an Agent run: the mapped
 * model's quote at x1 (the driver aligns the project's Agent
 * settings to x1). Used as the expected cost only when the
 * engine's own rate helper cannot price the run; the driver's
 * primary expected cost comes from that helper (the run's chosen
 * model/duration/quality). Null when the model has no Agent
 * mapping (nothing may approve on an unknown cost).
 */
function agentExpectedCost(settings) {
  const s = settings || {};
  const mapped = mapAgentModel(s.model || 'Omni Flash');
  if (!mapped) return null;
  return mapped.quote;
}

/**
 * Extract a quoted credit cost from a Flow Agent proposal text.
 * Only credit-context numbers count ('costing 12 credits', 'cost:
 * 15 credits', '15 credits') — durations, output counts and
 * resolutions in the same text must never be mistaken for a
 * price. Returns an integer or null when no quote can be read.
 */
function parseQuotedCost(text) {
  const s = String(text || '');
  if (!s) return null;
  const patterns = [
    // The field-verified proposal wording comes FIRST — "Would
    // you like me to kick off this 1 video generation, costing
    // 12 credits?" (live calibration, 2026-11-12).
    /costing\s+(\d{1,4})\s*credits?\b/i,
    /(?:total\s+)?cost[^0-9]{0,24}?(\d{1,4})\s*(?:credits?|cr\b)/i,
    /(\d{1,4})\s*credits?\b/i,
    /(?:cost|charge|price)[^0-9]{0,12}?(\d{1,4})\b/i
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

/**
 * Normalise a raw model mention to one of the Agent's canonical
 * labels (AGENT_MODEL_QUOTES keys), or null when it names no
 * known model. Handles the dash-less Veo spelling ('Veo 3.1
 * Lite' -> 'Veo 3.1 - Lite') and stray trailing punctuation.
 */
function normalizeAgentModelLabel(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim().replace(/[.,]+$/, '').trim();
  if (!s) return null;
  const fixed = s.replace(/^(Veo\s+3\.1)\s+(Lite|Fast|Quality)$/i, '$1 - $2');
  for (const label of Object.keys(AGENT_MODEL_QUOTES)) {
    if (label.toLowerCase() === fixed.toLowerCase()) return label;
  }
  return null;
}

/**
 * Extract the model a proposal says it will use. Field wordings
 * (live calibration, 2026-11-12): "using your default model Omni
 * 1.2 Flash.", "Using your default model Veo 3.1 - Lite, I'll
 * generate …", "… using Omni 1.2 Flash." Returns the canonical
 * Agent label, or null when the proposal names no known model.
 */
function parseProposalModel(text) {
  const s = String(text || '');
  if (!s) return null;
  const patterns = [
    // "using your default model X" / "default model X" — the
    // strongest signal; the candidate is normalised, and a
    // candidate that names no known model (e.g. it stopped at a
    // decimal point) simply falls through to the next pattern.
    /(?:using\s+)?(?:your\s+)?default model\s+([A-Za-z0-9][A-Za-z0-9 .\-]*)/i,
    // Any known model label appearing anywhere in the text.
    /\b(Omni\s+\d+(?:\.\d+)?\s+Flash|Veo\s+3\.1\s*-?\s*(?:Lite|Fast|Quality))\b/i,
    // "I'll generate … with X"
    /i'?ll generate[^.]*?\bwith\s+([A-Za-z0-9][A-Za-z0-9 .\-]*)/i
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const label = normalizeAgentModelLabel(m[1]);
      if (label) return label;
    }
  }
  return null;
}

/**
 * THE DECISION — numbers only, no judgement calls. Given a live
 * proposal (its quoted cost + the model it names), the run's own
 * expected cost (from its chosen model/duration/quality) and
 * whether the one settings-fix retry has already been spent:
 *
 *   act 'approve'        — quote <= run expected cost. The driver
 *                          clicks the radio labelled exactly
 *                          "Approve".
 *   act 'retry-settings' — over cost, the proposal's model is
 *                          pricier than the run's model, and the
 *                          retry is unspent: Reject (free), align
 *                          the Agent settings to the run's model,
 *                          re-send the instruction ONCE.
 *   act 'park'           — over cost with no settings fix left:
 *                          Reject (free), then park the card
 *                          (pending + needs_check), reason
 *                          'agent-over-cost'. Nothing is approved.
 *   act 'fail'           — the quote or the expected cost cannot
 *                          be read: never approve blind; the
 *                          driver rejects to settle the page and
 *                          fails with 'agent-cost-unverified'.
 */
function decideOnProposal(input) {
  const i = input || {};
  const quoted = (i.quotedCost === null || i.quotedCost === undefined) ? NaN : Number(i.quotedCost);
  const expected = (i.runExpectedCost === null || i.runExpectedCost === undefined) ? NaN : Number(i.runExpectedCost);
  if (!Number.isFinite(quoted) || !Number.isFinite(expected) || expected <= 0) {
    return { act: 'fail', reason: 'agent-cost-unverified' };
  }
  if (quoted <= expected) {
    return { act: 'approve', reason: 'within-cost' };
  }
  const propQuote = i.proposalModel ? AGENT_MODEL_QUOTES[i.proposalModel] : undefined;
  const runQuote = i.runModelLabel ? AGENT_MODEL_QUOTES[i.runModelLabel] : undefined;
  const modelPricier = propQuote !== undefined && runQuote !== undefined && propQuote > runQuote;
  if (modelPricier && !i.retried) {
    return { act: 'retry-settings', reason: 'agent-model-over-cost' };
  }
  return { act: 'park', reason: 'agent-over-cost' };
}

/**
 * The TAIL of a panel text for the [AGENT] heartbeat lines: the
 * last `max` characters, whitespace-collapsed onto one line, so
 * every waiting log shows what the panel actually says right now.
 */
function panelTail(text, max = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(s.length - max) : s;
}

module.exports = {
  AGENT_MODEL_QUOTES,
  AGENT_MODEL_MAP,
  mapAgentModel,
  agentExpectedCost,
  parseQuotedCost,
  normalizeAgentModelLabel,
  parseProposalModel,
  decideOnProposal,
  panelTail
};
