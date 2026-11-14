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
 * Scan a text for ANY known Agent model label (the keys of
 * AGENT_MODEL_QUOTES), longest label first, case-insensitive,
 * over whitespace-squeezed text. The fallback of last resort in
 * parseProposalModel (v2.48.99): the .98 field run's proposal
 * named its model in a sentence the sentence patterns did not
 * reach inside the text the driver had — a plain label mention
 * anywhere in the block is still the model the Agent means.
 * Returns the canonical label, or null when none appears.
 */
function scanKnownModelLabel(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').toLowerCase();
  if (!flat) return null;
  const labels = Object.keys(AGENT_MODEL_QUOTES).slice()
    .sort((a, b) => b.length - a.length);
  for (const label of labels) {
    if (flat.includes(label.toLowerCase())) return label;
  }
  return null;
}

/**
 * Extract the model a proposal says it will use. Field wordings
 * (live calibration, 2026-11-12): "using your default model Omni
 * 1.2 Flash.", "Using your default model Veo 3.1 - Lite, I'll
 * generate …", "… using Omni 1.2 Flash." The sentence patterns
 * are the PRIMARY source; when none of them names a model, a
 * known-label scan over the whole text is the fallback
 * (v2.48.99). Returns the canonical Agent label, or null when
 * the proposal names no known model.
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
  // v2.48.99 fallback: any canonical label mentioned anywhere.
  return scanKnownModelLabel(s);
}

/**
 * v2.48.100 — the LATEST proposal in a panel text. The session
 * panel ACCUMULATES history: a settled proposal's text (and the
 * Agent's cancellation reply) stays on screen ABOVE the fresh
 * proposal (AGENTTEST8, 2026-11-13: the fresh 7-credit Omni 1.1
 * proposal sat under the rejected 12-credit Omni 1.2 one for
 * 163s while every first-match parse kept reading the stale
 * sentence). parseQuotedCost/parseProposalModel match the FIRST
 * costing sentence — right for a single-proposal block, wrong
 * for the accumulated panel. This reader works from the LAST
 * 'costing N credits' occurrence instead:
 *
 *   quoted    — the integer of the LAST costing match.
 *   model     — parsed from the proposal BLOCK around that
 *               match: the text since the previous costing
 *               sentence (or a bounded window before it) up to
 *               the end of its own sentence. The model sentence
 *               precedes the costing sentence inside one block,
 *               and the previous block's model sits before the
 *               previous costing sentence, so the window never
 *               reaches it.
 *   sentence  — the full sentence carrying the costing match
 *               (whitespace-collapsed), for the signature.
 *   signature — `${model || 'unknown'}|${quoted}|${sentence}`,
 *               the identity the driver dedupes on: a proposal
 *               is "the same proposal" iff its signature is the
 *               same, regardless of which DOM node renders it.
 *
 * Returns null when the text carries no costing sentence.
 */
function latestProposal(text) {
  const s = String(text || '');
  if (!s) return null;
  const re = /costing\s+(\d{1,4})\s*credits?\b/gi;
  const matches = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    matches.push({ index: m.index, end: m.index + m[0].length, quoted: parseInt(m[1], 10) });
  }
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  if (!Number.isFinite(last.quoted) || last.quoted < 0) return null;
  // The sentence carrying the costing match: back to the
  // previous sentence end (or the block's start), forward to
  // the next one.
  let sentStart = 0;
  for (let i = last.index - 1; i >= 0; i--) {
    const ch = s[i];
    if (ch === '.' || ch === '?' || ch === '!' || ch === '\n') { sentStart = i + 1; break; }
  }
  let sentEnd = s.length;
  for (let i = last.end; i < s.length; i++) {
    const ch = s[i];
    if (ch === '.' || ch === '?' || ch === '!' || ch === '\n') { sentEnd = i + 1; break; }
  }
  const sentence = s.slice(sentStart, sentEnd).replace(/\s+/g, ' ').trim();
  // The model window: from just after the PREVIOUS costing
  // sentence (the stale block ends there — its cancellation
  // reply names no model), through this proposal's sentence
  // end. Within one block the model sentence can sit FAR
  // before the costing sentence (the .99 widening exists
  // because of exactly that), so the single-proposal lookback
  // reaches 4000 chars — the group-text cap scale.
  const prevEnd = matches.length > 1 ? matches[matches.length - 2].end : 0;
  const windowStart = Math.max(prevEnd, last.index - 4000);
  const windowText = s.slice(windowStart, sentEnd);
  const model = parseProposalModel(windowText) || scanKnownModelLabel(windowText);
  return {
    quoted: last.quoted,
    model: model || null,
    sentence,
    signature: `${model || 'unknown'}|${last.quoted}|${sentence.toLowerCase()}`
  };
}

/**
 * v2.48.103 (BULK MODE) — normalise a task's agentClips value:
 * how many clips ONE Agent conversation is asked to make for
 * this task. Accepts a number or a numeric string from any
 * caller (MCP argument, bridge body, Dart item, settings);
 * anything unreadable, non-finite or below 1 becomes 1 — the
 * single-clip behaviour every run had before bulk mode, so an
 * absent field is byte-for-byte the old semantics.
 */
function normalizeAgentClips(value) {
  const n = (typeof value === 'string') ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(n)) return 1;
  const i = Math.floor(n);
  return i >= 1 ? i : 1;
}

/**
 * v2.48.103 (BULK MODE) — a bulk task's expected TOTAL cost:
 * the per-clip expected cost (the same number the single-clip
 * guard has always used — rate helper first, flat quote table
 * as fallback) times the clip count. Null when the per-clip
 * cost is unknown: nothing may approve on an unknown total,
 * exactly as nothing may approve on an unknown single cost.
 */
function expectedTotalCost(perClipExpected, clips) {
  const per = Number(perClipExpected);
  if (!Number.isFinite(per) || per <= 0) return null;
  return per * normalizeAgentClips(clips);
}

/**
 * v2.48.104 (SETTINGS FIRST + INSTRUCTIONS — the owner's final-
 * version order): before any instruction is sent, the driver
 * aligns the project's Agent settings to the run (Confirm =
 * Always, the run's video model/aspect, outputs x1 — saved and
 * read back), and makes sure the project carries ONE standing
 * instruction, added once and then left alone:
 *
 *   title: "FlowStudio Run Rules"
 *   body:  the guideline text below, byte-for-byte — it tells
 *          the Agent to follow the saved settings (the settings
 *          are the run's truth), to never ask about resolution,
 *          and to quote multi-scene work as ONE combined
 *          proposal (the shape the Bulk Mode guard prices).
 */
const AGENT_INSTRUCTION_TITLE = 'FlowStudio Run Rules';
const AGENT_INSTRUCTION_BODY = 'Always use the video model, aspect ratio and output count saved in this project\'s Agent settings. Never ask which resolution to use — follow the saved settings and the user\'s message. When the user asks for several scenes, give ONE combined proposal covering all of them.';

/**
 * v2.48.104 — does this Agent text ask the USER to choose a
 * generation parameter (resolution / quality / model / aspect)
 * instead of proposing? The driver answers such a question
 * ONCE per run with the fixed settings-based answer below —
 * every other question keeps the standing discipline (logged,
 * waited through, never improvised). The shape required: a
 * question (a '?' or an asking opener) AND a parameter word.
 * A proposal is never a settings question (its costing
 * sentence marks it; the driver also checks that first).
 */
const SETTINGS_QUESTION_PARAM_RE = /\b(720p|1080p|360p|resolution|aspect(?:\s+ratio)?|quality|which model|what model|model should|settings?)\b/i;
const SETTINGS_QUESTION_SHAPE_RE = /(\?|^\s*(should|shall|would you|do you|which|what)\b)/i;
function looksLikeSettingsQuestion(text) {
  const s = String(text || '');
  if (!s || !SETTINGS_QUESTION_PARAM_RE.test(s)) return false;
  if (/costing\s+\d{1,4}\s*credits?\b/i.test(s)) return false;
  return SETTINGS_QUESTION_SHAPE_RE.test(s);
}

/**
 * v2.48.104 — THE fixed settings-based answer (the owner's
 * wording, with the run's own model label + aspect filled
 * in): the Agent is pointed at the saved project settings
 * instead of being given a fresh choice. 360p is the
 * generation resolution of the standard run the owner
 * calibrated; x1 is the aligned output count. Returns null
 * when the run's model has no Agent mapping (nothing truthful
 * to name — the driver then keeps waiting, as before).
 */
function settingsAnswerText(settings) {
  const s = settings || {};
  const mapped = mapAgentModel(s.model || 'Omni Flash');
  if (!mapped) return null;
  const aspect = (s.aspectRatio === '16:9' || s.aspectRatio === '9:16') ? s.aspectRatio : '9:16';
  return `Use the saved project settings: ${mapped.flowLabel}, ${aspect}, x1 output, 360p.`;
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
 *                          v2.48.99: an over-cost proposal whose
 *                          model could NOT be read takes the
 *                          same branch (reason
 *                          'agent-model-unnamed-over-cost') —
 *                          the .98 field run quoted 30 credits
 *                          with no model named, and no x1 flat
 *                          quote is 30: Agent quotes vary with
 *                          the duration/resolution IT picks, so
 *                          forcing the run's model + x1 + the
 *                          run's aspect via the settings is the
 *                          right corrective there too.
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
  // v2.48.99: the proposal's model could not be read at all and
  // the quote is over the run's cost — same corrective as a
  // pricier named model (force the run's model + x1 + aspect
  // via the Agent settings, ask once more). Distinct reason so
  // the driver logs the unnamed-model line.
  if (!i.proposalModel && !i.retried) {
    return { act: 'retry-settings', reason: 'agent-model-unnamed-over-cost' };
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
  normalizeAgentClips,
  expectedTotalCost,
  parseQuotedCost,
  normalizeAgentModelLabel,
  scanKnownModelLabel,
  parseProposalModel,
  latestProposal,
  decideOnProposal,
  panelTail,
  AGENT_INSTRUCTION_TITLE,
  AGENT_INSTRUCTION_BODY,
  looksLikeSettingsQuestion,
  settingsAnswerText
};
