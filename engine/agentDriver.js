'use strict';

// ---------------------------------------------------------------------------
// AGENT DRIVER: drives Google Flow's OWN built-in Agent (the
// "Agent" toggle inside Flow's prompt box + its chat panel) for
// Agent Prompt mode runs. v2.48.97: the driver is RULE-BASED ONLY
// — the external decision service the .95/.96 driver consulted is
// removed entirely (owner's order, 2026-11-12: "the replies from
// the Agent's side are mostly all alike anyway"). Every decision
// comes from engine/agentRules.js — fixed numbers and text
// patterns. This module makes NO external calls and holds NO keys:
//
//   1. snapshot the project's existing tiles (same proof the
//      direct route takes — audit fix #6),
//   2. turn Flow's Agent ON and send the instruction — the
//      user's text plus the pinned-parameter suffix (Fix E,
//      v2.48.102) — as ONE chat message,
//   3. poll the Agent panel's WHOLE visible text (innerText) every
//      ~3s and work only from marker substrings in that text —
//      no per-message element hunting. v2.48.98: the panel is
//      anchored FROM THE COMPOSER (pageAnchorAgentPanel) — the
//      .97 field run proved the old first-match selector table
//      landed on the editor canvas (its whole text was the
//      28-char placeholder "Start creating or drop media") while
//      the real session panel sat elsewhere on the page:
//        PROPOSAL = the text matches /costing\s+(\d+)\s+credits?/i
//          AND an enabled Permission-options radio group is on the
//          page. The quoted cost + the model named in the proposal
//          feed the rule decision (agentRules.decideOnProposal):
//          approve only when quote <= the run's expected cost.
//        STARTED = the text contains "I've started generating" /
//          "I have started generating" -> media watch.
//        QUESTION / OTHER = any other new Agent text: NEVER
//          improvise a reply — the only texts this driver ever
//          sends are the pinned instruction and its re-sends
//          after a settings fix. Keep waiting for a proposal.
//   4. ONE model-fix retry: when a proposal is rejected because
//      its model is pricier than the run's model, open the Agent
//      settings from the panel (now open, box unlocked after the
//      Reject), set the Video model to the run's mapped model,
//      aspect to the run's when 16:9/9:16, outputs x1, Confirm =
//      Always, Save — then re-send the instruction ONCE. A second
//      over-cost proposal -> Reject + park the card with reason
//      'agent-over-cost'. If the settings surface cannot be
//      operated, log 'agent-settings-unaligned' and park without
//      the retry.
//   5. when the Agent's media lands in the project grid, build
//      the SAME submitted-task object submitPrompt returns and
//      hand off — from that moment the existing render monitor +
//      download pipeline own the task, byte for byte. A
//      download-stage failure NEVER comes back here (sacred
//      rule): nothing in this module can resubmit or re-ask the
//      Agent beyond the single settings-fix re-send above.
//
// SELF-EVIDENCING LOGS (the .96 run failed blind — its log showed
// only 'still waiting' while the proposal sat on screen): every
// [AGENT] heartbeat carries the panel text TAIL (last ~200 chars)
// + a proposalGroup=present/absent flag, and ANY agent failure
// logs the full last-seen panel text (up to ~800 chars) with the
// failure reason.
//
// ============================================================================
// FIELD CALIBRATION (2026-11-12, verified firsthand in a real
// browser session — the semantics the rules above are built on):
//
//   - A generation proposal is two text paragraphs ending with
//     "Would you like me to kick off this 1 video generation,
//     costing N credits?" plus a RADIO GROUP (accessibility label
//     "Permission options") with three stacked radio options:
//     Approve / Always approve in project / Reject. They are NOT
//     buttons. After a choice the group disables.
//   - While a proposal awaits an answer the panel prompt box is
//     LOCKED (the send button becomes "Stop"; Enter does nothing).
//     A run can therefore never "just park" internally — it MUST
//     click one of the three options to settle the page. Park /
//     fail paths click REJECT (free) first, then settle the card.
//   - Reject is free, frees the box, and the Agent's cancellation
//     reply wording VARIES — never match on it.
//   - Agent replies take ~10–30s. NO completion message is ever
//     posted: after an approval the Agent posts "I've started
//     generating…" and the finished media appears ONLY as a new
//     grid tile + in the panel's "Media options gallery" (~60s).
//     Completion detection is tile/gallery-based, never
//     message-based.
//   - Agent settings are PER-PROJECT and need an explicit Save
//     (sliders icon in the panel prompt box -> "Agent settings"):
//     "Confirm before generating" Always (default) / Never; Video
//     defaults: aspect 16:9 or 9:16, outputs x1–x4, model dropdown
//     (Omni 1.2 Flash default; Omni 1.1 Flash; Veo 3.1 - Lite /
//     - Fast / - Quality). There is NO duration control — the
//     Agent chooses duration itself. Quotes at x1: Omni 1.2 = 12,
//     Veo Lite = 10, Omni 1.1 = 7 (agentRules.AGENT_MODEL_QUOTES).
//
// Every step has a HARD timeout (proposal wait 180s, post-click
// settle 60s, media wait 300s) — the .95 field run hung silently
// for 10+ minutes at a proposal; that is impossible here.
// ============================================================================
// v2.48.99 (field fixes from the .98 live run, AGENTTEST4-1112:
// detection -> quote -> Reject -> settle -> park ALL worked;
// zero credits spent): (1) the proposal's MODEL was not read —
// it sat outside the radio group's 8-hop/1500-char ancestor
// text. The group text window is now wider (14 hops, up to
// ~4000 chars), the model parse also tries the anchored panel
// text, and parseProposalModel gained a known-label scan
// fallback; the proposal log line names the parse source.
// (2) That run's quote was 30 with NO model named — no x1 flat
// quote is 30, so Agent quotes vary with the duration /
// resolution it picks. An unnamed-model over-cost proposal now
// takes the SAME settings-fix retry as a pricier named model
// (distinct log line + reason 'agent-model-unnamed-over-cost'),
// so the alignment can force the run's model + x1 + aspect
// before the one re-send. (3) The composer anchor missed at
// send time in that run — alignAgentSettings now makes ONE
// re-anchor attempt (logged) before opening the Agent
// settings, when the panel is fully rendered.
//
// v2.48.100 (field fixes from the .99 live run, AGENTTEST8:
// the MCP agent-mode switch worked — the run went out as an
// Agent run without the owner touching the toggle — proposal
// #1 (Omni 1.2, 12) was read, Rejected, settled; the settings
// surface was still not found, but the named-model fallback
// re-send WORKED: the Agent answered with a fresh proposal at
// exactly 7 credits, Omni 1.1 Flash, Permission group present):
// (1) THE BLOCKER — the fresh proposal was never acted on; the
// driver waited 163s into agent-proposal-timeout with 0
// credits spent. TWO stacked first-match traps caused it:
// pagePermissionState read the FIRST Permission group in the
// document — the SETTLED proposal's group, which stays in the
// panel DOM disabled ABOVE the fresh one — so `enabled` read
// false forever; and the text parsers matched the FIRST
// 'costing N credits' sentence — the stale 12-credit one — in
// the accumulated panel text. Fix: pagePermissionState and
// pageClickPermissionOption now read ALL groups and choose
// the last ENABLED one; proposals are parsed by
// agentRules.latestProposal (the LAST costing sentence + its
// block's model) and identified by a TEXT SIGNATURE, handled
// one-shot per continuous appearance (shouldActOnProposal —
// an identical signature after an observed/settle-proven gap
// is a NEW appearance and is decided again); the heartbeat
// now states WHY a present group is not being acted on
// (settled/disabled · no costing sentence yet · signature
// already handled). (2) SETTINGS OPENER — the survey + the
// owner's screen recording pin the composer row's icons as
// Material ligature TEXT ('add' · 'article_spark' · 'tune' ·
// send/stop): the settings opener is the 'tune' button, which
// no earlier strategy could see. New strategy (a2)
// pageClickComposerTuneIcon; and the aligner now SCROLLS the
// settings surface to the 'Video generation default' section
// (below the fold in the recording) before reading/setting
// the video values (pageScrollAgentSettingsToVideo).
//
// v2.48.101 (field fixes from the .100 live run, AGENTTEST9):
// the tune opener WORKED — "Agent settings surface found (via
// composer tune icon)" — and then every verify read came back
// 'unreadable' (Confirm, model, aspect, outputs), the aligner
// reported 'agent-settings-unaligned' (field 'confirm') and the
// run PARKED — one step from the named-model fallback that
// AGENTTEST8 proved, because the fallback was gated on the
// surface-NOT-found outcome only. (1) FIX C: the named-model
// fallback now follows ANY alignment failure (surface not
// found, field mismatch, unreadable fields, Save failure,
// error) — exactly once per run; if alignment succeeds there is
// no fallback, and a fallback proposal that still prices over
// parks behind 'agent-over-cost-named-retry' with no second
// fallback. (2) FIX D: pageReadAgentSettings is rebuilt for the
// real surface's structure (FLOW-MAP.md Step 3): the option
// text and its checked state live on DIFFERENT nodes (a label
// beside the role="radio" control, often with a description
// line), the state is reported through aria-checked /
// aria-pressed / aria-selected / input.checked / a Material
// host's `selected` property / state classes, the model
// dropdown's displayed text carries icon-ligature and
// 'Leaving Dec 5' suffixes, and Material-style controls can sit
// in SHADOW ROOTS a flat querySelectorAll never reaches — the
// reader now collects every element under the surface (shadow
// included), resolves each option's state from its own row,
// reads the model off the dropdown control with suffixes
// stripped, and scopes aspect/outputs to the 'Video generation
// default' section (the image defaults above it share the
// labels). The aligner scrolls BOTH sections through the
// viewport before each read pass, and an 'unreadable' verify
// now captures a settings-SURFACE survey (pageSurveySettings-
// Surface) into the log + the Doctor's last-run detail, so the
// next failure shows the surface's real DOM from chat.
//
// v2.48.102 (field fixes from the .101 live run, AGENTTEST10):
// Fix C worked — the settings alignment failed ('confirm'
// still unreadable), the named fallback fired, and the fresh
// proposal came back with the RIGHT model (Omni 1.1 Flash) —
// but quoted 15 credits against the run's expected 7, and the
// run parked (correctly; the fallback gets one retry). 0
// credits spent. Diagnosis: 15 = Omni 1.1 at 360p for FIFTEEN
// seconds (1 credit/sec) — the Agent chooses the duration (and
// resolution) itself, and across the live tests its quotes
// varied 12 / 30 / 15 purely from those unpinned choices. The
// old instruction pinned model + aspect + count but NOT
// duration or resolution. The owner's own screen recording
// proves the Agent obeys chat-pinned parameters (he typed
// "360p resolution and every clips 10 sec" and the proposal
// matched). (E) PIN EVERYTHING: the instruction sent to the
// Agent — the initial send AND every re-send, the named
// fallback included — now appends the run's pinned parameters
// (pinnedAgentInstruction), derived from the run's ACTUAL
// settings: " (Use Omni 1.1 Flash, 360p resolution, 10
// seconds, vertical 9:16, exactly 1 video.)" The expected-cost
// guard is unchanged. (F) SURVEY TIMING: TEST10's Doctor
// detail "settings surface survey" captured the PANEL's
// elements, not the settings surface — by the verify-time
// capture the surface had already closed. The aligner now
// captures the survey at the FIRST unreadable read, while the
// surface is provably open (just opened + detected, before
// any set/Save/close), and the mismatch detail prefers that
// while-open capture; the verify-time capture remains as a
// fallback when the first read was clean.
//
// v2.48.103 (BULK MODE — from the owner's firsthand study of
// Flow's Agent, 2026-11-13): in ONE conversation the Agent
// accepts a multi-scene instruction, replies with a plan +
// ONE COMBINED proposal (2 videos = "costing 14 credits" =
// 2 × 7), and on Approve creates ALL the tiles in the project
// grid at once; a follow-up message in the same conversation
// ("make scene 1 again, but at night") produces a fresh
// per-clip proposal and ADDS a tile. Bulk mode builds on
// exactly that: (1) a task may carry agentClips (≥1, default
// 1) — its instruction pins "exactly N videos" and its
// proposals are guarded at the expected TOTAL (N × per-clip)
// WITH the run's model required to match; the fallback
// re-send restates the same count. (2) After approval the
// driver waits for N NEW grid tiles (pageGridTilesDetailed:
// fingerprint + grid title + failed flag, first-seen order),
// registers + api-polls EVERY one as a sibling task on the
// primary's result (agentExtraTasks; the pool names the saves
// <TAG>-S1..SN), and hands off a partial set with an explicit
// agent-clips-shortfall reason when fewer arrive — never a
// hang, never a wholesale re-send. (3) A tile that arrives
// FAILED earns ONE repair message in the same conversation
// (per failed scene, one round per task), guarded at the
// PER-CLIP cost; the remade tile fills the failed scene's
// slot. agentClips 1/absent keeps every pre-.103 behaviour
// byte-for-byte (the single-clip media phase is untouched).
//
// ⚠️ SELECTOR TABLE — v2.48.98: the panel is NO LONGER located
// through the `panel` selector list below. On the live page that
// list's first match was Flow's editor-canvas container — the
// .97 field log's "panel text" was exactly "Start creating or
// drop media" (28 chars) for the entire run, while the Agent
// session panel (messages + proposal radio group) sat elsewhere
// and was never inside the polled node. The panel is now
// anchored from the chat composer — located with the exact
// finder shape insertNativeText has proven against the live
// page for months (the visible contenteditable editor named
// "What do you want to create?") — by walking UP from the
// composer to the largest ancestor containing NEITHER the
// project grid NOR the canvas placeholder. The proposal's
// radio group is likewise located DOCUMENT-WIDE, independent
// of the panel anchor. AGENT_SELECTORS.panel survives ONLY as
// a fallback root for the focus/settings helpers and as DOM
// survey candidates. The Agent toggle row reuses the exact
// chip shape engine/flowAutomation.js's
// ensureAgentModeDisabled has proven against the live page
// since v2.48.x — that part is NOT a guess.
// ============================================================================

const agentRules = require('./agentRules');
const agentDoctor = require('./agentDoctor');
const tileIdentity = require('./tileIdentity');

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

const AGENT_SELECTORS = {
  // The Agent toggle inside Flow's prompt box (proven shape — see
  // ensureAgentModeDisabled in flowAutomation.js).
  toggleChip: '.agent-mode-chip, button.agent-mode-chip',
  toggleButtonText: 'agent',
  // Chat panel containers, broadest first.
  panel: [
    '[data-testid*="agent-panel" i]',
    '[data-testid*="agent" i][role="complementary"]',
    'aside[class*="agent" i]',
    'div[class*="agent-panel" i]',
    'div[class*="agentPanel" i]',
    '[role="complementary"]'
  ],
  // Chat input inside the panel (the prompt box itself is the
  // fallback — with Agent ON, Flow's prompt box IS the chat input).
  input: [
    'textarea',
    '[contenteditable="true"][role="textbox"]',
    'div.ProseMirror[contenteditable="true"]'
  ],
  // Send button inside the panel / prompt box.
  sendButton: [
    'button[aria-label*="send" i]',
    'button[data-testid*="send" i]',
    'button[class*="send" i]'
  ],
  // The proposal's permission RADIO GROUP (field-verified
  // semantics: role=radiogroup, accessibility label "Permission
  // options"; the options are radios, never buttons).
  permissionGroup: [
    '[role="radiogroup"][aria-label="Permission options"]',
    '[aria-label="Permission options"]',
    '[role="radiogroup"]'
  ],
  radioOption: [
    '[role="radio"]',
    'label',
    'input[type="radio"]'
  ],
  // The panel's "Media options gallery" — finished media shows
  // up here as well as in the project grid.
  gallery: [
    '[aria-label*="Media options" i]',
    '[data-testid*="media-options" i]',
    '[data-testid*="media-gallery" i]',
    'div[class*="media-gallery" i]',
    'div[class*="mediaGallery" i]'
  ],
  // The Agent settings surface (sliders icon in the panel prompt
  // box -> "Agent settings" dialog; per-project, Save needed).
  settingsButton: [
    'button[aria-label*="agent settings" i]',
    'button[data-testid*="agent-settings" i]',
    'button[aria-label*="settings" i]',
    'button[class*="tune" i]'
  ],
  settingsPanel: [
    '[role="dialog"][aria-label*="agent" i]',
    '[data-testid*="agent-settings" i]',
    'div[class*="agent-settings" i]',
    'div[class*="agentSettings" i]',
    '[role="dialog"]'
  ],
  settingsSaveText: 'Save',
  // v2.48.104: the Agent instructions surface — opened by the
  // FIRST of the three composer-row buttons shown while Agent
  // is on (owner's screenshots, 2026-11-14: instructions,
  // settings, enter). Its icon ligature is 'article_spark'
  // (the settings icon is 'tune'); as with settings, the TEXT
  // ANCHORS ("Agent instructions" + "Add instruction") are the
  // primary detection and these selectors are only a fallback.
  instructionsButton: [
    'button[aria-label*="agent instructions" i]',
    'button[aria-label*="instructions" i]',
    'button[data-testid*="instruction" i]'
  ],
  instructionsPanel: [
    '[role="dialog"][aria-label*="instruction" i]',
    '[data-testid*="agent-instructions" i]',
    'div[class*="agent-instructions" i]',
    'div[class*="agentInstructions" i]',
    '[role="dialog"]'
  ],
  instructionsDoneText: 'Done'
};

// The proposal's radio options — field-verified labels. Matching
// is EXACT (after whitespace/case normalisation): the driver
// approves ONLY via 'Approve', never via 'Always approve in
// project'.
const PERMISSION_LABELS = {
  approve: 'Approve',
  alwaysApprove: 'Always approve in project',
  reject: 'Reject'
};

// The model labels Flow's Agent settings dropdown can show.
const KNOWN_AGENT_MODELS = Object.keys(agentRules.AGENT_MODEL_QUOTES);

// Driver budgets (ms) — hard timeouts. EVERY wait in the
// conversation is bounded by one of these; a stuck step fails
// with a specific reason instead of hanging the run.
const CHAT_POLL_MS = 3000; // whole-text panel poll cadence
const PROPOSAL_WAIT_MS = 180 * 1000; // waiting for the Agent's next step
const SETTLE_TIMEOUT_MS = 60 * 1000; // post-click settle of a proposal
const SETTLE_POLL_MS = 500;
const MEDIA_TIMEOUT_MS = 300 * 1000; // approved -> media in the project
const MEDIA_POLL_MS = 3000;
const MAX_PANEL_CHANGES = 40; // panel-text change fuse (runaway chat)
const PANEL_GUARD_MS = 15 * 1000; // panel-not-found fail-fast window
// Pack 3 (2026-11-13, AGENTTEST7): the composer anchor missed at
// send time in EVERY live run so far and succeeded seconds later
// (the panel is still rendering when the instruction lands), so
// the send-time anchor is retried for up to ~10s before the run
// falls back to group-only proposal detection.
const ANCHOR_RETRY_MS = 10 * 1000; // send-time composer-anchor retry budget
const ANCHOR_RETRY_POLL_MS = 500; // cadence between anchor attempts
// Pack 3: the settings opener clicks, waits ~1.5s, then polls
// for the surface's text anchors for up to ~8s per strategy (the
// AGENTTEST7 surface never appeared for the single legacy
// selector click — the opener is now multi-strategy).
const SETTINGS_OPEN_WAIT_MS = 1500; // settle beat after an opener click
const SETTINGS_SURFACE_WAIT_MS = 8000; // text-anchor poll budget per strategy
const SETTINGS_SURFACE_POLL_MS = 400; // cadence of the surface poll
// Flow's empty-canvas placeholder. It is the ONLY text the .97
// driver ever "read" as the Agent panel — it is canvas chrome,
// never panel content, and is hard-excluded as such.
const CANVAS_PLACEHOLDER_TEXT = 'Start creating or drop media';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test_js — no page, no network)
// ---------------------------------------------------------------------------

const POLICY_REFUSAL_RE = /(can(not|'t) help with that|against (our|the) (content )?polic|content policy|safety (policy|guidelines)|not able to generate (this|that))/i;
function looksLikePolicyRefusal(text) {
  return POLICY_REFUSAL_RE.test(String(text || ''));
}

// A generation proposal is recognised by its field-verified
// closing sentence — "…costing N credits?" — in the panel text.
// The driver ALSO requires an enabled Permission options radio
// group on the page before treating the text as a LIVE proposal
// (the group is what gets clicked).
const PROPOSAL_TEXT_RE = /costing\s+\d{1,4}\s*credits?\b/i;
function hasProposalText(text) {
  return PROPOSAL_TEXT_RE.test(String(text || ''));
}

// After an approval the Agent posts "I've started generating…" —
// informational only. It is NEVER a proposal (no "costing"
// sentence) and no completion message ever follows; the media
// itself is the only completion signal.
/**
 * v2.48.98: the hard guard behind the panel-not-found fail-fast.
 * A panel text is implausible when it is near-empty (<40 chars)
 * or consists ONLY of Flow's canvas placeholder — the exact
 * failure shape of the .96/.97 field runs, where the "panel"
 * being polled was the editor canvas. Exported for fixtures.
 */
function isPanelTextImplausible(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < 40) return true;
  const stripped = t.split(CANVAS_PLACEHOLDER_TEXT).join('').replace(/\s+/g, ' ').trim();
  return stripped.length === 0;
}

const STARTED_GENERATING_RE = /(i'?ve started generating|i have started generating|started generating|generation has started|now generating)/i;
function looksLikeGenerationStarted(text) {
  return STARTED_GENERATING_RE.test(String(text || ''));
}

/**
 * v2.48.100 — the one-shot gate behind Fix A. A proposal is
 * identified by its TEXT SIGNATURE (agentRules.latestProposal:
 * model + quoted cost + the costing sentence), never by its
 * DOM node — the panel reuses and accumulates nodes. The gate:
 *
 *   - a signature never handled this run -> ACT (it is new);
 *   - a signature already handled, with NO gap since (every
 *     poll in between still showed an answerable group — the
 *     same appearance re-rendering) -> DO NOT act again:
 *     approve/reject are one-shot per appearance;
 *   - a signature already handled, but a gap WAS observed (a
 *     poll with no answerable group — the handled proposal
 *     settled/vanished) -> ACT: this is a genuinely NEW
 *     appearance of an identical proposal, which is exactly
 *     what the settings-fix re-send can legitimately produce
 *     (same model, same quote — it must still be decided:
 *     park on the second over-cost, approve if it now fits).
 *
 * `handled` may be a Set or an array. Pure; fixture-pinned.
 */
function shouldActOnProposal(signature, handled, gapSeen) {
  if (!signature) return false;
  const seen = handled && typeof handled.has === 'function'
    ? handled.has(signature)
    : (Array.isArray(handled) && handled.includes(signature));
  if (!seen) return true;
  return !!gapSeen;
}

/**
 * The Agent-settings values a run wants in its project: Confirm
 * is ALWAYS 'Always' (Never is never set — an unproposed
 * generation could not be cost-checked). The model maps through
 * agentRules' table; an unmapped model or a non-16:9/9:16 aspect
 * leaves the project's own default in place (null here) and the
 * driver logs the skip. Outputs are always x1. Used by the
 * model-fix retry — the settings are aligned only when a pricier
 * proposal model forces the issue.
 */
function desiredAgentSettings(settings) {
  const s = settings || {};
  const mapped = agentRules.mapAgentModel(s.model || 'Omni Flash');
  const aspect = (s.aspectRatio === '16:9' || s.aspectRatio === '9:16') ? s.aspectRatio : null;
  return {
    confirm: 'Always',
    modelLabel: mapped ? mapped.flowLabel : null,
    modelKnown: !!mapped,
    aspect,
    outputs: 'x1'
  };
}

/**
 * v2.48.102 (Fix E) — the run's pinned Agent parameters,
 * derived from the run's ACTUAL settings:
 *   modelLabel   — the run's model in the Agent's own label
 *                  (agentRules' table; null when unmapped).
 *   resolution   — the GENERATION resolution the Quality
 *                  setting means, read exactly as the engine's
 *                  own rate helper reads it (flowAutomation
 *                  getRequiredCredits): '720p'/'1080p' quality
 *                  generates at 720p ('1080p' is an enhanced
 *                  DOWNLOAD of a 720p generation), anything
 *                  else generates at 360p; default '360p'.
 *   seconds      — the run's duration in whole seconds
 *                  (settings carry it as '10s'; the rate
 *                  helper's own default when unset is '6s').
 *   aspectPhrase — 'vertical 9:16' / 'horizontal 16:9', or
 *                  null for a non-standard aspect (the phrase
 *                  is then omitted, as it always was).
 * Pure; fixture-pinned.
 */
function agentParamPins(settings) {
  const s = settings || {};
  const mapped = agentRules.mapAgentModel(s.model || 'Omni Flash');
  const quality = String(s.quality || '360p').toLowerCase();
  const resolution = (quality.includes('720') || quality.includes('1080')) ? '720p' : '360p';
  const durSecs = parseInt(String(s.duration || '6s').toLowerCase().replace('s', '').trim(), 10);
  const aspectPhrase = s.aspectRatio === '9:16' ? 'vertical 9:16'
    : (s.aspectRatio === '16:9' ? 'horizontal 16:9' : null);
  return {
    modelLabel: mapped ? mapped.flowLabel : null,
    resolution,
    seconds: (Number.isFinite(durSecs) && durSecs > 0) ? durSecs : null,
    aspectPhrase
  };
}

/**
 * v2.48.102 (Fix E) — the pinned-parameter suffix appended to
 * EVERY instruction this driver sends to Flow's Agent: the
 * initial send, the settings-aligned re-send and the named
 * fallback re-send all carry the same sentence. AGENTTEST10's
 * fallback proposal named the right model yet still quoted
 * 15 against the run's 7 because the Agent picked a 15-second
 * duration itself (1 credit/sec at 360p); across the live
 * tests its quotes varied 12 / 30 / 15 purely from ITS
 * unpinned duration/resolution choices, and the owner's
 * recording proves chat-pinned parameters are obeyed. The
 * sentence pins model + resolution + duration + aspect +
 * exactly one video (each prompt is its own Agent
 * conversation item, so every instruction asks for 1 video):
 * " (Use Omni 1.1 Flash, 360p resolution, 10 seconds,
 * vertical 9:16, exactly 1 video.)"
 */
function pinnedParamsSuffix(settings, clips) {
  const pins = agentParamPins(settings);
  const parts = [];
  if (pins.modelLabel) parts.push(pins.modelLabel);
  if (pins.resolution) parts.push(`${pins.resolution} resolution`);
  if (pins.seconds) parts.push(`${pins.seconds} seconds`);
  if (pins.aspectPhrase) parts.push(pins.aspectPhrase);
  // v2.48.103 (BULK MODE): a bulk task (agentClips > 1) asks
  // this ONE conversation for that many clips, and the suffix
  // must say so — the combined proposal is priced against the
  // task's expected TOTAL. The count comes from the explicit
  // argument first, then the run settings; at 1 (or absent)
  // the phrase is the v2.48.102 sentence, byte-for-byte.
  const n = agentRules.normalizeAgentClips(
    clips !== undefined ? clips : (settings || {}).agentClips);
  parts.push(n > 1 ? `exactly ${n} videos` : 'exactly 1 video');
  return ` (Use ${parts.join(', ')}.)`;
}

/**
 * v2.48.102 (Fix E) — the instruction text for an Agent run:
 * the user's text plus the pinned-parameter suffix. Returns
 * null when the user's text is empty. Pure; fixture-pinned.
 * v2.48.103: the optional clips count rides through to the
 * suffix (bulk tasks ask for exactly N videos).
 */
function pinnedAgentInstruction(promptText, settings, clips) {
  const base = String(promptText || '').replace(/[\r\n]+/g, ' ').trim();
  if (!base) return null;
  return `${base}${pinnedParamsSuffix(settings, clips)}`;
}

/**
 * Pack 3 (item 5) — the named-model fallback instruction. When
 * the Agent settings alignment fails for ANY reason (surface
 * never found, a field mismatch, unreadable fields, a Save
 * failure — v2.48.101 Fix C widened the gate from not-found
 * only), the settings-fix retry has no lever left — except the
 * instruction text itself: the Agent reads the constraints
 * stated in the chat. v2.48.102 (Fix E): the re-send is the
 * SAME pinned instruction as the initial send — the suffix
 * names the run's model in the Agent's own label and now also
 * pins resolution, duration and aspect alongside exactly one
 * video: " (Use Omni 1.1 Flash, 360p resolution, 10 seconds,
 * vertical 9:16, exactly 1 video.)". Returns null when the
 * run's model has no Agent mapping (nothing truthful to name
 * — the caller parks instead) or the instruction is empty.
 * Pure; fixture-pinned.
 */
function namedRetryInstruction(promptText, settings, clips) {
  const s = settings || {};
  const mapped = agentRules.mapAgentModel(s.model || 'Omni Flash');
  if (!mapped) return null;
  // v2.48.103: a bulk task's fallback re-send restates the
  // SAME clip count (and the same pins) as the first send.
  return pinnedAgentInstruction(promptText, settings, clips);
}

/**
 * v2.48.103 (BULK MODE, Part 4) — the ONE repair message a bulk
 * task may send in its own conversation when one of its clips
 * visibly failed: it asks for JUST that scene again, at the
 * same parameters (the per-clip pin suffix rides along), so
 * the resulting proposal is a single-clip quote the driver
 * guards at the per-clip expected cost. `desc` is the failed
 * tile's grid title when known; the generic phrasing covers
 * the no-title case. Pure; fixture-pinned.
 */
function repairMessageFor(desc, settings) {
  const d = String(desc || '').replace(/[\r\n]+/g, ' ').trim();
  const base = d
    ? `Please remake just the failed video "${d}" — it failed to generate.`
    : 'Please remake just the one video that failed to generate.';
  return `${base}${pinnedParamsSuffix(settings, 1)}`;
}

/** One-line, length-capped rendering of a text for the log. */
function truncateForLog(text, max = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.substring(0, max)}…` : s;
}

/**
 * Every [AGENT] engine-log line is built HERE, from event data
 * only. The lines carry evidence, never secrets: the waiting
 * heartbeat includes the panel text tail + the permission-group
 * flag, and a failure includes the last-seen panel text (up to
 * ~800 chars) — no run may ever fail blind.
 */
function agentLine(kind, data) {
  const d = data || {};
  switch (kind) {
    case 'toggle-on': return '[AGENT] Flow Agent mode is ON — the run will chat with Flow\'s Agent.';
    case 'toggle-missing': return '[AGENT] Flow\'s "Agent" toggle was not found in the prompt box.';
    case 'sent': return d.retry
      ? `[AGENT] re-sent the user's instruction to Flow's Agent (${Number(d.chars) || 0} characters) — the one settings-fix retry.`
      : `[AGENT] sent the user's instruction to Flow's Agent (${Number(d.chars) || 0} characters).`;
    case 'message': return `[AGENT] agent message: "${truncateForLog(d.text)}"`;
    case 'proposal': return `[AGENT] generation proposal from Flow's Agent — model ${d.model ? `${d.model}${d.modelSource ? ` (from ${d.modelSource})` : ''}` : 'not named'}, quoted ${d.quoted} credits (this run's expected cost: ${d.expected} credits) → ${d.act || '?'}.`;
    case 'option-clicked': return `[AGENT] clicked "${d.label}" in the proposal's Permission options.`;
    case 'option-missing': return `[AGENT] the proposal option "${d.label}" was not found in the Permission options group — nothing was clicked.`;
    case 'settled': return '[AGENT] the proposal settled — the Agent panel is free again.';
    case 'settle-timeout': return '[AGENT] the proposal did not settle within 60s of the click.';
    case 'approved': return `[AGENT] proposal approved at ${d.quoted} credits — generation started by Flow's Agent.`;
    case 'rejected': return `[AGENT] proposal rejected (${d.reason || 'over cost'}) — rejecting costs nothing.`;
    case 'retry': return `[AGENT] the proposal's model is pricier than this run's model — aligning the Agent settings to the run's model (${d.model || '?'}) and asking once more.`;
    case 'retry-unnamed': return `[AGENT] the proposal's model could not be read and its quote (${Number(d.quoted) || 0}) is above this run's expected cost (${Number(d.expected) || 0}) — aligning the Agent settings to the run's model and asking once more.`;
    case 'reanchor': return d.found
      ? `[AGENT] panel re-anchored at the Agent composer for the settings alignment (ancestor depth ${Number(d.depth) || 0}, panel text ${Number(d.textLength) || 0} chars).`
      : '[AGENT] panel re-anchor for the settings alignment did not find the Agent composer — the settings helpers continue with their fallback search.';
    case 'parked': return '[AGENT] the proposal costs more than this run allows — the card is parked as needs-attention (nothing approved, no credits spent).';
    case 'generation-started': return '[AGENT] Flow\'s Agent started generating without a proposal (its Confirm setting was off) — waiting for the media itself.';
    case 'aligning': return '[AGENT] aligning Agent settings…';
    case 'settings-opened': return `[AGENT] Agent settings surface found (via ${d.via || 'unknown'}).`;
    case 'settings-survey': return `[AGENT] settings survey: ${(Array.isArray(d.entries) ? d.entries : []).join(' | ')}`;
    case 'settings-value': return d.ok
      ? `[AGENT] settings value ${d.field}: '${d.want}' — verified.`
      : `[AGENT] settings value ${d.field}: wanted '${d.want}' but reads '${d.got === null || d.got === undefined ? 'unreadable' : d.got}' — MISMATCH.`;
    case 'retry-named': return `[AGENT] retry-named-model — the Agent settings alignment failed (${d.why || 'the settings surface could not be operated'}), so the instruction is re-sent ONCE with the run's model (${d.model || '?'}) named in the text, for the Agent to pick itself.`;
    case 'settings-aligned': return `[AGENT] Flow Agent settings aligned for this project and saved (Confirm before generating = Always${d.detail ? `; ${d.detail}` : ''}).`;
    case 'settings-unaligned': return `[AGENT] Flow Agent settings could not be aligned (${d.detail || 'the settings surface could not be operated'}) — agent-settings-unaligned.`;
    case 'settings-skip': return `[AGENT] Agent settings note: ${d.detail || ''}`;
    case 'settings-first': {
      const show = (v) => (v === null || v === undefined || String(v) === '') ? 'unreadable' : String(v);
      return `[AGENT] settings-first: model=${show(d.model)}, aspect=${show(d.aspect)}, outputs=${show(d.outputs)}, confirm=${show(d.confirm)}${d.ok ? ' — read-back verified.' : ' — read-back NOT verified; continuing (the chat pin + quote guard remain the safety net).'}`;
    }
    case 'settings-first-record': return agentDoctor.settingsFirstLine(d);
    case 'settings-answer': return `[AGENT] the Agent asked about the run's settings before proposing — answered ONCE from the saved project settings: "${truncateForLog(d.text, 160)}" Any further question is waited through, never improvised.`;
    case 'instructions-present': return `[AGENT] agent instructions: the standing "${d.title || ''}" instruction is already present in this project — left exactly as it is.`;
    case 'instructions-added': return `[AGENT] agent instructions: added the standing "${d.title || ''}" instruction to this project (toggle on, guideline saved via Done) and verified it reads back.`;
    case 'instructions-failed': return `[AGENT] agent instructions: the standing instruction could not be added/verified (${d.detail || 'unknown'}) — continuing without it; this is never fatal to the run.`;
    case 'instructions-survey': return `[AGENT] instructions survey: ${(Array.isArray(d.entries) ? d.entries : []).join(' | ')}`;
    case 'media': return '[AGENT] media detected in the project — handing off to the download pipeline.';
    case 'bulk-plan': return `[AGENT] bulk task — this one conversation is asked for ${Number(d.clips) || 1} clips; expected total ${Number(d.total) || 0} credits (${Number(d.clips) || 1} × ${Number(d.perClip) || 0} per clip). A combined quote is approved only at or under that total, with the run's model.`;
    case 'clips-progress': return `[AGENT] bulk media: ${Number(d.have) || 0} of ${Number(d.want) || 0} clips are in the project grid so far…`;
    case 'repair-send': return `[AGENT] repair — one of this conversation's clips failed; asking Flow's Agent to remake just that one ("${truncateForLog(d.desc || 'the failed video', 80)}") in the SAME conversation. One repair message per failed scene, one repair round per task.`;
    case 'repair-none': return '[AGENT] repair round found nothing more to do — proceeding with the clips that exist.';
    case 'shortfall': return `[AGENT] clips shortfall — only ${Number(d.have) || 0} of ${Number(d.want) || 0} clips arrived from Flow's Agent${d.note ? ` (${d.note})` : ''}. The clips that exist are handed to the download pipeline; the missing scenes are NOT resubmitted.`;
    case 'handoff': return '[AGENT] handoff complete — the render monitor and download pipeline own this task now.';
    case 'waiting': return `[AGENT] still waiting for Flow's Agent… (${d.elapsedSec || 0}s) proposalGroup=${d.group || 'absent'}${d.why ? ` — ${d.why}` : ''} panel tail: "${agentRules.panelTail(d.tail || '')}"`;
    case 'panel-dump': return `[AGENT] failure (${d.reason || 'agent-failed'}) — last panel text (${String(d.text || '').length} chars): "${truncateForLog(d.text, 800)}"`;
    case 'anchor': return d.found
      ? `[AGENT] panel anchored at the Agent composer (ancestor depth ${Number(d.depth) || 0}, panel text ${Number(d.textLength) || 0} chars, composer inside the anchor).`
      : '[AGENT] panel anchor NOT found at send time — the Agent composer ("What do you want to create?") could not be located; proposal detection falls back to the Permission options group alone.';
    case 'survey': return `[AGENT] DOM survey: ${(Array.isArray(d.entries) ? d.entries : []).join(' | ')}`;
    case 'panel-not-found': return `[AGENT] agent-panel-not-found: the anchored panel text stayed implausible (${Number(d.chars) || 0} chars) after sending and no Permission options group appeared — failing fast instead of waiting blind.`;
    default: return `[AGENT] ${kind}`;
  }
}

/**
 * The submitted-task object — the SAME shape submitPrompt returns,
 * so waitForAccountTasks + the download pipeline cannot tell an
 * Agent task from a direct one.
 */
function buildAgentTask(fields) {
  const f = fields || {};
  return {
    status: 'SUBMITTED',
    videoId: f.videoId,
    projectUrl: f.projectUrl || '',
    captureKey: f.videoId,
    promptText: f.promptText,
    promptIndex: f.promptIndex,
    startTime: f.startTime || Date.now(),
    preExistingTileCount: f.preExistingTileCount || 0,
    preExistingAriaLabels: f.preExistingAriaLabels || [],
    preExistingFingerprints: f.preExistingFingerprints || [],
    preExistingVideoUrls: f.preExistingVideoUrls || new Set(),
    lockedTileFingerprint: f.lockedTileFingerprint || null,
    wasObservedGenerating: false,
    completed: false,
    downloaded: false,
    viaAgent: true,
    // v2.48.103 (BULK MODE): a task from a multi-clip
    // conversation carries its scene slot (1-based index among
    // the conversation's clips, and the conversation's clip
    // count) plus the tile's grid title, so the pool can name
    // the save <TAG>-S<index> and the save log can name the
    // scene. Single-clip tasks keep 1/1 + empty title — the
    // fields are inert downstream.
    agentSceneIndex: f.agentSceneIndex || 1,
    agentSceneCount: f.agentSceneCount || 1,
    agentTileTitle: f.agentTileTitle || ''
  };
}

// ---------------------------------------------------------------------------
// Page-side helpers (serialised into the page by Puppeteer — they
// must stay self-contained: selectors arrive as arguments)
// ---------------------------------------------------------------------------

function pageFindAgentToggle(selectors) {
  const chip = document.querySelector(selectors.toggleChip);
  const isOn = el => !!el && (String(el.className || '').includes('checked') || String(el.className || '').includes('active') || el.getAttribute('aria-pressed') === 'true');
  if (chip) return { found: true, on: isOn(chip) };
  const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').trim().toLowerCase() === selectors.toggleButtonText);
  if (btn) return { found: true, on: isOn(btn) };
  return { found: false, on: false };
}

function pageClickAgentToggle(selectors) {
  const chip = document.querySelector(selectors.toggleChip) ||
    Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').trim().toLowerCase() === selectors.toggleButtonText);
  if (!chip) return false;
  chip.click();
  return true;
}

// v2.48.98: anchor the Agent PANEL from the chat COMPOSER.
// The .97 field run proved the old first-match selector table
// landed on the editor canvas: the polled node's whole text
// was "Start creating or drop media" (28 chars) for the entire
// run, while the Agent session panel — session title, messages,
// the proposal radio group and the composer ("What do you want
// to create?") — sat elsewhere on the page and was NEVER inside
// the polled node. The composer is the one panel element the
// driver demonstrably reaches (sending works), and it is found
// with the exact finder shape insertNativeText has proven
// against the live page: the visible contenteditable editor
// NAMED "What do you want to create?" (else the lowest editor
// on screen). From the composer, walk UP to the panel: the
// largest ancestor (bounded depth) that contains NEITHER the
// project grid NOR the canvas placeholder — both live outside
// the session panel, so the first ancestor swallowing either
// is one step too high. The anchored node is stashed on
// document.__fsAgentPanel for the other page helpers; if it
// detaches, the driver re-anchors. Returns a descriptor (the
// send-time survey line) plus the panel's current text.
function pageAnchorAgentPanel(selectors) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const stash = (el) => { try { document.__fsAgentPanel = el || null; } catch (e) {} };
  let composer = null;
  try {
    const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]'));
    const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true');
    const pool = ed.length ? ed : all;
    const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); });
    const list = vis.length ? vis : pool;
    if (list.length) {
      composer = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || e.getAttribute('placeholder') || '')) ||
        list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
    }
  } catch (e) { composer = null; }
  if (!composer) {
    stash(null);
    return { found: false, depth: 0, textLength: 0, containsComposer: false, text: '' };
  }
  let panel = composer;
  let depth = 0;
  let cur = composer;
  while (cur.parentElement && depth < 14) {
    const up = cur.parentElement;
    if (up === document.body || up === document.documentElement) break;
    let upText = '';
    try { upText = norm(up.innerText || ''); } catch (e) { upText = ''; }
    let hasGrid = false;
    try { hasGrid = !!up.querySelector('flow-grid-tile-container'); } catch (e) { hasGrid = false; }
    if (hasGrid || upText.includes('Start creating or drop media')) break;
    if (upText.length > 20000) break;
    cur = up;
    panel = cur;
    depth++;
  }
  stash(panel);
  const text = norm(panel.innerText || '');
  return { found: true, depth, textLength: text.length, containsComposer: true, text };
}

// v2.48.98: read the ANCHORED panel's WHOLE visible text
// (innerText, whitespace-collapsed). Returns null when there is
// no live anchor (never anchored, or the node detached) so the
// driver re-anchors explicitly instead of reading blind. There
// is deliberately no per-message element hunting.
function pageReadAgentPanelText(selectors) {
  let panel = null;
  try { panel = document.__fsAgentPanel || null; } catch (e) { panel = null; }
  if (!panel || !document.contains(panel)) return null;
  return String(panel.innerText || '').replace(/\s+/g, ' ').trim();
}

// v2.48.98: a one-time DOM survey for the panel-not-found
// failure — for each candidate container: how it was found,
// tag/role/aria-label, text length and first 80 chars. A blind
// panel failure must never happen again: the survey makes the
// next one self-proving from the log alone.
function pageSurveyAgentDom(selectors) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const describe = (via, el) => {
    if (!el) return null;
    const text = norm(el.innerText || '');
    const role = el.getAttribute ? el.getAttribute('role') : null;
    const aria = el.getAttribute ? el.getAttribute('aria-label') : null;
    return `${via} <${String(el.tagName || '?').toLowerCase()}${role ? ` role=${role}` : ''}${aria ? ` aria="${aria}"` : ''}> ${text.length} chars "${text.substring(0, 80)}"`;
  };
  const entries = [];
  const seen = new Set();
  const push = (via, el) => {
    if (!el || seen.has(el) || entries.length >= 12) return;
    seen.add(el);
    const d = describe(via, el);
    if (d) entries.push(d);
  };
  try {
    const all = Array.from(document.querySelectorAll('div.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]'));
    const composer = all.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || e.getAttribute('placeholder') || ''));
    let cur = composer || null;
    let depth = 0;
    while (cur && depth < 6) { push(`composer-ancestor depth ${depth}`, cur); cur = cur.parentElement; depth++; }
  } catch (e) {}
  for (const sel of (selectors.panel || [])) {
    try { push(`selector ${sel}`, document.querySelector(sel)); } catch (e) {}
  }
  try { push('landmark aside', document.querySelector('aside')); } catch (e) {}
  try { push('landmark complementary', document.querySelector('[role="complementary"]')); } catch (e) {}
  try { push('permission group', document.querySelector('[role="radiogroup"]')); } catch (e) {}
  return entries;
}

function pageFocusAgentInput(selectors) {
  let panel = null;
  try { panel = document.__fsAgentPanel || null; } catch (e) { panel = null; }
  if (panel && !document.contains(panel)) panel = null;
  if (!panel) {
    for (const sel of selectors.panel) {
      try { panel = document.querySelector(sel); } catch (e) { panel = null; }
      if (panel) break;
    }
  }
  if (!panel) return false;
  for (const sel of selectors.input) {
    let el = null;
    try { el = panel.querySelector(sel); } catch (e) { el = null; }
    if (el) {
      el.focus();
      return true;
    }
  }
  return false;
}

function pageClickAgentSend(selectors) {
  let panel = null;
  try { panel = document.__fsAgentPanel || null; } catch (e) { panel = null; }
  if (panel && !document.contains(panel)) panel = null;
  if (!panel) {
    for (const sel of selectors.panel) {
      try { panel = document.querySelector(sel); } catch (e) { panel = null; }
      if (panel) break;
    }
  }
  const roots = panel ? [panel, document.body] : [document.body];
  for (const root of roots) {
    for (const sel of selectors.sendButton) {
      let btn = null;
      try { btn = root.querySelector(sel); } catch (e) { btn = null; }
      if (btn && !btn.disabled) {
        btn.click();
        return true;
      }
    }
  }
  return false;
}

function pageGridFingerprints() {
  return Array.from(document.querySelectorAll('flow-grid-tile-container'))
    .map(c => (c.getAttribute('aria-label') || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// v2.48.103 (BULK MODE) — the grid read a multi-clip task needs:
// per tile, its fingerprint (the EXACT source + normalisation
// pageGridFingerprints uses — the container's own aria-label —
// so the two reads always agree), its raw grid TITLE (the
// Agent's auto descriptive name for the tile; the save log
// names scenes by it), and a FAILED flag: Flow marks a
// blocked/failed generation on the tile itself, so the tile's
// label or text saying the generation failed is what the
// repair round keys on. DOM order is preserved — it is the
// order scenes are handed off in.
function pageGridTilesDetailed() {
  const failedRe = /(failed|error|couldn'?t|could not|unable to|try again)/i;
  return Array.from(document.querySelectorAll('flow-grid-tile-container'))
    .map(c => {
      const label = c.getAttribute('aria-label') || '';
      const fp = label.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!fp) return null;
      const text = `${label} ${String(c.innerText || c.textContent || '')}`;
      return { fp, title: label.trim(), failed: failedRe.test(text) };
    })
    .filter(Boolean);
}

// The proposal's permission radio group — presence, whether it
// is still answerable, its option labels, and whether the panel
// prompt box is locked (its send button reads "Stop" while a
// proposal awaits an answer).
function pagePermissionState(selectors) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  // v2.48.98: the group is located DOCUMENT-WIDE — the decision
  // UI is ground truth and must be findable even when the panel
  // anchor is wrong or missing. In .96/.97 this search was
  // scoped to the mis-anchored "panel" node (the canvas), so
  // the group read absent for entire runs while a proposal sat
  // on screen. groupText is the text of the nearest panel-like
  // ancestor carrying the costing sentence — a proposal source
  // independent of the panel anchor.
  // v2.48.100: ALL matching groups are read, not the first.
  // The session panel keeps a SETTLED proposal's group in the
  // DOM (disabled) ABOVE the fresh one — AGENTTEST8's watcher
  // read that stale first group for 163s (present but never
  // enabled) while the fresh, answerable group sat below it
  // unseen. The LIVE group is the LAST ENABLED one in document
  // order; when none is enabled the last group is reported
  // (present, disabled) so settle waits still see the truth.
  const groups = [];
  for (const sel of selectors.permissionGroup) {
    let found = [];
    try { found = Array.from(document.querySelectorAll(sel)); } catch (e) { found = []; }
    for (const g of found) { if (!groups.includes(g)) groups.push(g); }
  }
  try {
    groups.sort((x, y) => {
      const p = x.compareDocumentPosition(y);
      if (p & 2) return 1; // DOCUMENT_POSITION_PRECEDING: y precedes x
      if (p & 4) return -1; // DOCUMENT_POSITION_FOLLOWING: y follows x
      return 0;
    });
  } catch (e) {}
  if (!groups.length) return { present: false, enabled: false, options: [], promptLocked: false, groupText: '', groupCount: 0, enabledCount: 0 };
  const stateOf = (group) => {
    // v2.48.99: the text window is WIDER — up to 14 hops and
    // ~4000 chars, keeping the WIDEST costing-bearing ancestor
    // text. The .98 field run's proposal named its model in the
    // FIRST sentence, which sat outside the old 8-hop/1500-char
    // window (the walk stopped at the first small ancestor that
    // carried the costing sentence alone), so the model read as
    // "not named". The model sentence precedes the costing
    // sentence in the same proposal block — the wider block is
    // what carries both.
    let groupText = norm(group.innerText || '');
    let anc = group.parentElement;
    let hops = 0;
    while (anc && hops < 14) {
      const t = norm(anc.innerText || '');
      if (/costing\s+\d{1,4}\s*credits?\b/i.test(t)) {
        if (t.length > 4000) { groupText = t.substring(0, 4000); break; }
        groupText = t;
      }
      anc = anc.parentElement;
      hops++;
    }
    let promptLocked = false;
    try {
      const scope = group.parentElement || document.body;
      promptLocked = Array.from(scope.querySelectorAll('button'))
        .some(b => norm(b.getAttribute('aria-label') || b.innerText || '').toLowerCase() === 'stop');
    } catch (e) {}
    const optionEls = [];
    for (const sel of selectors.radioOption) {
      try {
        group.querySelectorAll(sel).forEach(el => { if (!optionEls.includes(el)) optionEls.push(el); });
      } catch (e) {}
    }
    const options = optionEls
      .map(el => norm(el.getAttribute('aria-label') || el.innerText || ''))
      .filter(Boolean);
    const groupDisabled = group.getAttribute('aria-disabled') === 'true' || group.hasAttribute('disabled');
    const anyEnabled = optionEls.some(el => !(el.disabled || el.getAttribute('aria-disabled') === 'true' ||
      (el.querySelector && el.querySelector('input[disabled]'))));
    return { enabled: !groupDisabled && anyEnabled, options, promptLocked, groupText };
  };
  const states = groups.map(stateOf);
  let chosen = -1;
  for (let i = 0; i < states.length; i++) { if (states[i].enabled) chosen = i; }
  if (chosen < 0) chosen = states.length - 1;
  const st = states[chosen];
  return {
    present: true,
    enabled: st.enabled,
    options: st.options,
    promptLocked: st.promptLocked,
    groupText: st.groupText,
    groupCount: groups.length,
    enabledCount: states.filter(x => x.enabled).length
  };
}

// Click ONE option of the permission radio group. The label
// match is EXACT after normalisation — 'Approve' can never land
// on 'Always approve in project'. Returns the wanted label when
// clicked, null when no option carries it.
function pageClickPermissionOption(selectors, wanted) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  // v2.48.98: document-wide, like pagePermissionState — the
  // click must reach the SAME group the state read found.
  // v2.48.100: that group is the last ENABLED one, exactly as
  // pagePermissionState chooses it — a settled proposal's
  // group lingers above the fresh one and must never take
  // the click.
  const groups = [];
  for (const sel of selectors.permissionGroup) {
    let found = [];
    try { found = Array.from(document.querySelectorAll(sel)); } catch (e) { found = []; }
    for (const g of found) { if (!groups.includes(g)) groups.push(g); }
  }
  try {
    groups.sort((x, y) => {
      const p = x.compareDocumentPosition(y);
      if (p & 2) return 1;
      if (p & 4) return -1;
      return 0;
    });
  } catch (e) {}
  const isEnabled = (g) => {
    if (g.getAttribute('aria-disabled') === 'true' || g.hasAttribute('disabled')) return false;
    const els = [];
    for (const sel of selectors.radioOption) {
      try { g.querySelectorAll(sel).forEach(el => { if (!els.includes(el)) els.push(el); }); } catch (e) {}
    }
    return els.some(el => !(el.disabled || el.getAttribute('aria-disabled') === 'true' ||
      (el.querySelector && el.querySelector('input[disabled]'))));
  };
  let group = null;
  for (const g of groups) { if (isEnabled(g)) group = g; }
  if (!group) group = groups.length ? groups[groups.length - 1] : null;
  if (!group) return null;
  const optionEls = [];
  for (const sel of selectors.radioOption) {
    try {
      group.querySelectorAll(sel).forEach(el => { if (!optionEls.includes(el)) optionEls.push(el); });
    } catch (e) {}
  }
  for (const el of optionEls) {
    const label = norm(el.getAttribute('aria-label') || el.innerText || '');
    if (label === norm(wanted)) {
      const target = (el.querySelector && el.querySelector('input[type="radio"]')) || el;
      target.click();
      return wanted;
    }
  }
  return null;
}

// The panel's "Media options gallery" item labels, normalised
// exactly like grid tile fingerprints (tileIdentity), so a
// gallery sighting compares directly with tile fingerprints.
function pageGalleryLabels(selectors) {
  let gallery = null;
  for (const sel of selectors.gallery) {
    try { gallery = document.querySelector(sel); } catch (e) { gallery = null; }
    if (gallery) break;
  }
  if (!gallery) return [];
  const items = Array.from(gallery.querySelectorAll('img, [aria-label], flow-grid-tile-container, [role="option"], li'));
  return items
    .map(el => (el.getAttribute('aria-label') || el.getAttribute('alt') || ''))
    .map(l => l.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// Open the Agent settings surface via the sliders icon in the
// panel prompt box. This is opener strategy (a) in the driver's
// multi-strategy sequence: the legacy selector table first,
// then (pack 3) any clickable inside/near the anchored panel
// whose aria-label, title or text names "agent settings".
function pageOpenAgentSettings(selectors) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  let panel = null;
  try { panel = document.__fsAgentPanel || null; } catch (e) { panel = null; }
  if (panel && !document.contains(panel)) panel = null;
  if (!panel) {
    for (const sel of selectors.panel) {
      try { panel = document.querySelector(sel); } catch (e) { panel = null; }
      if (panel) break;
    }
  }
  const roots = panel ? [panel, document.body] : [document.body];
  for (const root of roots) {
    for (const sel of selectors.settingsButton) {
      let btn = null;
      try { btn = root.querySelector(sel); } catch (e) { btn = null; }
      if (btn) {
        btn.click();
        return true;
      }
    }
  }
  // Pack 3, strategy (a) second pass: a clickable whose
  // aria-label, title or visible text names "agent settings"
  // (the field surface's opener may be a labelled row, not an
  // icon button matching the selector table).
  for (const root of roots) {
    let els = [];
    try { els = Array.from(root.querySelectorAll('button, [role="button"], a')); } catch (e) { els = []; }
    const hit = els.find(el => /agent settings/i.test(norm(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.innerText || ''}`)));
    if (hit) {
      hit.click();
      return true;
    }
  }
  return false;
}

function pageAgentSettingsPresent(selectors) {
  // Pack 3: a surface the text-anchor finder located (and
  // stashed) counts as present even when no selector matches it.
  try {
    const st = document.__fsAgentSettings || null;
    if (st && document.contains(st)) return true;
  } catch (e) {}
  for (const sel of selectors.settingsPanel) {
    try { if (document.querySelector(sel)) return true; } catch (e) {}
  }
  return false;
}

// Read the Agent settings surface — which Confirm radio is
// checked, the model dropdown's current label, the checked
// aspect and the checked outputs. Anything unreadable is null.
//
// v2.48.101 (Fix D) — the reader is rebuilt around how the REAL
// surface is put together (FLOW-MAP.md Step 3; AGENTTEST9 read
// all four values 'unreadable' off a surface that WAS open):
// (1) the option's TEXT and its checked STATE live on different
// nodes — a label span sits next to the role="radio" control,
// and the Confirm rows carry a description line under the
// label, so no single element both says 'Always' and reports
// the state; (2) the state itself is reported through several
// hooks (aria-checked, aria-pressed, aria-selected, an input's
// checked, a Material host's selected property, state
// classes); (3) the model dropdown's displayed text carries
// suffixes — the dropdown icon's ligature text and the
// 'Leaving Dec 5' subtext — so an exact-text match never
// lands; (4) Material-style hosts can keep their controls
// inside SHADOW ROOTS, which a plain querySelectorAll never
// reaches (the surface's anchors were found through rendered
// text, which does cross). The reader therefore collects
// every element under the surface (shadow roots included)
// once, resolves each option's state from the option's own
// row, reads the model from the dropdown control with the
// suffixes stripped, and scopes the aspect/outputs reads to
// the 'Video generation default' section when it can be
// isolated (the image defaults above it carry the same labels
// with different values).
function pageReadAgentSettings(selectors, modelLabels) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  let root = null;
  // Pack 3: the text-anchor finder's stash is the surface of
  // record when it is live — it may match no selector at all.
  try {
    const st = document.__fsAgentSettings || null;
    if (st && document.contains(st)) root = st;
  } catch (e) {}
  if (!root) {
    for (const sel of selectors.settingsPanel) {
      try { root = document.querySelector(sel); } catch (e) { root = null; }
      if (root) break;
    }
  }
  if (!root) return { present: false, confirm: null, model: null, aspect: null, outputs: null };

  // Every element under a node, shadow roots included, in
  // document order.
  const allDeep = (node) => {
    const out = [];
    const visit = (n) => {
      if (!n) return;
      let kids = [];
      try { kids = n.children ? Array.from(n.children) : []; } catch (e) { kids = []; }
      for (const k of kids) {
        out.push(k);
        visit(k);
        try { if (k.shadowRoot) visit(k.shadowRoot); } catch (e) {}
      }
    };
    visit(node);
    return out;
  };
  const els = allDeep(root);
  const subtree = (node) => [node, ...allDeep(node)];

  // The checked state ONE element reports, through any hook;
  // null when the element carries no state at all.
  const stateOf = (el) => {
    if (!el || typeof el.getAttribute !== 'function') return null;
    let v = null;
    try { v = el.getAttribute('aria-checked'); } catch (e) { v = null; }
    if (v === 'true') return true;
    if (v === 'false') return false;
    try { v = el.getAttribute('aria-pressed'); } catch (e) { v = null; }
    if (v === 'true') return true;
    if (v === 'false') return false;
    try { v = el.getAttribute('aria-selected'); } catch (e) { v = null; }
    if (v === 'true') return true;
    if (v === 'false') return false;
    try {
      if (el.getAttribute('data-checked') === 'true' || el.getAttribute('data-selected') === 'true') return true;
    } catch (e) {}
    if (String(el.tagName || '') === 'INPUT' && typeof el.checked === 'boolean') return !!el.checked;
    if (typeof el.selected === 'boolean') return el.selected;
    if (/checked|selected|active/.test(String(el.className || ''))) return true;
    return null;
  };

  // Resolve the state of the option whose label element is
  // `hit`: the label's own state hook if it has one, else the
  // state carrier in its row — the smallest ancestor holding
  // one. When a level holds several carriers, the one nearest
  // the label in document order is the option's own.
  const stateForHit = (hit) => {
    let node = hit;
    for (let depth = 0; node && depth <= 4; depth++) {
      const own = stateOf(node);
      if (own !== null) return own;
      let sub = [];
      try { sub = subtree(node); } catch (e) { sub = []; }
      const carriers = sub.filter(e => e !== node && stateOf(e) !== null);
      if (carriers.length === 1) return stateOf(carriers[0]);
      if (carriers.length > 1) {
        const hi = sub.indexOf(hit);
        let bestC = null;
        let bestD = Infinity;
        for (const c of carriers) {
          const dist = Math.abs(sub.indexOf(c) - hi);
          if (dist < bestD) { bestD = dist; bestC = c; }
        }
        if (bestC) return stateOf(bestC);
      }
      node = node.parentElement || null;
    }
    return null;
  };

  // The selected option among `texts` within `scope`: an exact
  // label carrier first, then a label-plus-description carrier
  // (the Confirm rows carry a description line under the label,
  // so their row text starts with the label).
  const readOption = (scope, texts) => {
    for (const t of texts) {
      const exact = scope.filter(e => norm(e.innerText || '') === t);
      const prefixed = scope.filter(e => {
        const tx = norm(e.innerText || '');
        return tx !== t && tx.startsWith(`${t} `);
      }).sort((x, y) => norm(x.innerText || '').length - norm(y.innerText || '').length);
      for (const hit of [...exact, ...prefixed]) {
        if (stateForHit(hit) === true) return t;
      }
    }
    return null;
  };

  // The subtree of one settings section: its heading's
  // smallest carrier, climbed to the ancestor that also
  // carries one of mustTexts. Null when the section cannot be
  // isolated (the caller then reads the whole surface).
  const sectionScope = (headingText, mustTexts) => {
    let head = null;
    let bestLen = Infinity;
    for (const e of els) {
      const t = norm(e.innerText || '');
      if (t.includes(headingText) && t.length < bestLen) { bestLen = t.length; head = e; }
    }
    if (!head) return null;
    let node = head;
    for (let d = 0; node && d <= 6; d++) {
      const t = norm(node.innerText || '');
      if (mustTexts.some(m => t.includes(m))) return subtree(node);
      node = node.parentElement || null;
    }
    return null;
  };

  const labels = Array.isArray(modelLabels) ? modelLabels : [];
  const confirmScope = sectionScope('Confirm before generating', ['Always', 'Never']) || els;
  const confirm = readOption(confirmScope, ['Always', 'Never']);

  // The model dropdown's displayed label, with the suffixes
  // the real control appends (icon ligatures, the 'Leaving
  // Dec 5' retirement note) stripped before comparison.
  const stripModelText = (t) => norm(t)
    .replace(/\b(expand_more|expand_less|arrow_drop_down|arrow_drop_up|keyboard_arrow_down|keyboard_arrow_up|unfold_more|unfold_less)\b/gi, ' ')
    .replace(/leaving\s+dec\s+\d+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let model = null;
  const controlEls = els.filter(e => {
    const tag = String(e.tagName || '');
    if (tag === 'BUTTON' || tag === 'SELECT') return true;
    if (typeof e.getAttribute !== 'function') return false;
    const role = e.getAttribute('role');
    return e.getAttribute('aria-haspopup') === 'listbox' || role === 'combobox' || role === 'listbox';
  });
  for (const label of labels) {
    if (controlEls.some(e => stripModelText(e.innerText || '') === label)) { model = label; break; }
  }
  if (!model) {
    for (const label of labels) {
      if (els.some(e => stripModelText(e.innerText || '') === label)) { model = label; break; }
    }
  }

  const videoScope = sectionScope('Video generation default', labels.concat(['16:9', '9:16', 'x1'])) || els;
  const aspect = readOption(videoScope, ['16:9', '9:16']);
  let outputs = readOption(videoScope, ['x1', 'x2', 'x3', 'x4']);
  if (!outputs) {
    const bare = readOption(videoScope, ['1', '2', '3', '4']);
    if (bare) outputs = `x${bare}`;
  }
  return { present: true, confirm, model, aspect, outputs };
}

// Click the element carrying EXACTLY this text inside the Agent
// settings surface (radios, dropdown options, aspect and output
// choices all render as text-bearing controls). Falls back to
// the whole document — dropdown options often render in a portal
// outside the dialog.
function pageClickSettingsText(selectors, text) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  let root = null;
  try {
    const st = document.__fsAgentSettings || null;
    if (st && document.contains(st)) root = st;
  } catch (e) {}
  if (!root) {
    for (const sel of selectors.settingsPanel) {
      try { root = document.querySelector(sel); } catch (e) { root = null; }
      if (root) break;
    }
  }
  const roots = root ? [root, document.body] : [document.body];
  // v2.48.101 (Fix D): on the real surface the option TEXT and
  // the clickable CONTROL are different nodes (a label span
  // beside the radio), and controls may sit in shadow roots —
  // so the candidate pool is the flat query PLUS every deep
  // option carrier, and when the matched carrier is a bare
  // label the click climbs to the nearest interactive ancestor.
  const allDeep = (node) => {
    const out = [];
    const visit = (n) => {
      if (!n) return;
      let kids = [];
      try { kids = n.children ? Array.from(n.children) : []; } catch (e) { kids = []; }
      for (const k of kids) {
        out.push(k);
        visit(k);
        try { if (k.shadowRoot) visit(k.shadowRoot); } catch (e) {}
      }
    };
    visit(node);
    return out;
  };
  const isOptionCarrier = (e) => {
    const tag = String(e.tagName || '');
    if (tag === 'BUTTON' || tag === 'LABEL' || tag === 'LI' || tag === 'SELECT' || tag === 'A' || tag === 'SPAN') return true;
    if (typeof e.getAttribute !== 'function') return false;
    const role = e.getAttribute('role');
    return role === 'radio' || role === 'option' || role === 'menuitem' || e.getAttribute('aria-haspopup') === 'listbox';
  };
  const isInteractive = (e) => {
    const tag = String(e.tagName || '');
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'LABEL') return true;
    if (typeof e.getAttribute !== 'function') return false;
    const role = e.getAttribute('role');
    return role === 'radio' || role === 'option' || role === 'menuitem' || role === 'button' || role === 'combobox' || role === 'listbox' || !!e.getAttribute('aria-haspopup');
  };
  for (const r of roots) {
    let pool = [];
    try { pool = Array.from(r.querySelectorAll('button, [role="radio"], [role="option"], [role="menuitem"], [aria-haspopup="listbox"], label, li, select')); } catch (e) { pool = []; }
    const seen = new Set(pool);
    for (const e of allDeep(r)) {
      if (!seen.has(e) && isOptionCarrier(e)) { pool.push(e); seen.add(e); }
    }
    const el = pool.find(e => norm(e.getAttribute('aria-label') || e.innerText || '') === text);
    if (el) {
      let target = el;
      if (!isInteractive(target)) {
        let up = target.parentElement || null;
        for (let d = 0; up && d < 3; d++) {
          if (isInteractive(up)) { target = up; break; }
          up = up.parentElement || null;
        }
      }
      target.click();
      return true;
    }
  }
  return false;
}

// The settings surface's Save button (settings are per-project
// and apply only after an explicit Save).
function pageSaveAgentSettings(selectors) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  let root = null;
  try {
    const st = document.__fsAgentSettings || null;
    if (st && document.contains(st)) root = st;
  } catch (e) {}
  if (!root) {
    for (const sel of selectors.settingsPanel) {
      try { root = document.querySelector(sel); } catch (e) { root = null; }
      if (root) break;
    }
  }
  const roots = root ? [root, document.body] : [document.body];
  for (const r of roots) {
    const btn = Array.from(r.querySelectorAll('button'))
      .find(b => norm(b.innerText || '') === selectors.settingsSaveText);
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }
  }
  return false;
}

/**
 * v2.48.104 — click the composer's AGENT INSTRUCTIONS icon
 * (the FIRST of the three buttons shown while Agent is on;
 * the owner's screenshots: instructions, settings, enter).
 * The Flow icon font renders it as the ligature text
 * 'article_spark' inside the composer toolbar's icon buttons
 * — the same anchor shape as the settings 'tune' icon —
 * with an aria-labelled fallback. The instructions screen is
 * not inside the agent panel, so the search prefers the
 * conversation/composer scope and falls back to the document.
 * Returns true iff an element was clicked.
 */
function pageClickComposerInstructionsIcon(selectors) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const isInstructionsBtn = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const t = norm(el.innerText || '');
    const aria = norm(el.getAttribute && el.getAttribute('aria-label'));
    const title = norm(el.getAttribute && el.getAttribute('title'));
    return t === 'article_spark' || aria === 'article_spark' || title === 'article_spark' ||
      /agent instructions/i.test(aria) || /agent instructions/i.test(title) ||
      t === 'Instructions' || t === 'Agent instructions';
  };
  const clickIn = (root) => {
    if (!root || !root.querySelectorAll) return false;
    const btns = Array.from(root.querySelectorAll('button, [role="button"]')).filter(isInstructionsBtn);
    if (!btns.length) return false;
    btns[btns.length - 1].click();
    return true;
  };
  // 1) The stashed agent panel (the composer toolbar lives there).
  try { const panel = document.__fsAgentPanel; if (panel && document.contains(panel) && clickIn(panel)) return true; } catch (e) {}
  // 2) The composer scope via the panel resolver (stashes for us).
  try {
    const panel = typeof pageAgentPanel === 'function' ? pageAgentPanel(selectors) : null;
    if (panel && clickIn(panel)) return true;
  } catch (e) {}
  try {
    const sendBtn = document.querySelector('button[aria-label="Send"], [data-testid="send-button"]');
    let scope = sendBtn;
    for (let i = 0; scope && i < 5; i++) {
      if (scope.querySelectorAll && clickIn(scope)) return true;
      scope = scope.parentElement;
    }
  } catch (e) {}
  // 3) The registered selector list, then a bounded document scan.
  try {
    for (const sel of (selectors.instructionsButton || [])) {
      const el = document.querySelector(sel);
      if (el) { el.click(); return true; }
    }
  } catch (e) {}
  try { return clickIn(document.body || document.documentElement); } catch (e) {}
  return false;
}

/**
 * v2.48.104 — surface detection by TEXT ANCHORS for the Agent
 * instructions screen, exactly the settings discipline: the
 * screen carries the title "Agent instructions" beside an
 * "+ Add instruction" control (the owner's screenshot). The
 * smallest element containing BOTH anchors is the surface;
 * stashed on document.__fsAgentInstructions. The selector
 * list is only a fallback. Never throws; returns
 * { present, via }.
 */
function pageAgentInstructionsSurface(selectors) {
  try {
    const st = document.__fsAgentInstructions;
    if (st && document.contains(st)) return { present: true, via: 'stash' };
  } catch (e) {}
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  try {
    const pool = Array.from(document.querySelectorAll('div, section, aside, form, [role="dialog"], [role="menu"]'));
    let best = null;
    for (const el of pool) {
      const t = norm(el.innerText || '');
      if (!t || t.length > 6000) continue;
      if (t.includes('Agent instructions') && (t.includes('Add instruction'))) {
        if (!best || t.length < norm(best.innerText || '').length) best = el;
      }
    }
    if (best) {
      try { document.__fsAgentInstructions = best; } catch (e) {}
      return { present: true, via: 'text' };
    }
  } catch (e) {}
  try {
    for (const sel of (selectors.instructionsPanel || [])) {
      const el = document.querySelector(sel);
      if (el && (el.offsetParent !== null || el === document.body)) {
        try { document.__fsAgentInstructions = el; } catch (e) {}
        return { present: true, via: 'selector' };
      }
    }
  } catch (e) {}
  return { present: false, via: null };
}

/**
 * v2.48.104 (page) — read the instructions surface's text so
 * the caller can presence-check the standing instruction's
 * title EXACTLY (the list shows instruction titles — the
 * owner's screenshot). Returns { present, text }.
 */
function pageReadAgentInstructions(selectors) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  let root = null;
  try { const st = document.__fsAgentInstructions; if (st && document.contains(st)) root = st; } catch (e) {}
  if (!root) {
    try {
      for (const sel of (selectors.instructionsPanel || [])) {
        const el = document.querySelector(sel);
        if (el) { root = el; break; }
      }
    } catch (e) {}
  }
  if (!root) {
    try {
      const pool = Array.from(document.querySelectorAll('div, section, aside, form, [role="dialog"]'));
      for (const el of pool) {
        const t = norm(el.innerText || '');
        if (t && t.length <= 6000 && t.includes('Agent instructions') && t.includes('Add instruction')) { root = el; break; }
      }
    } catch (e) {}
  }
  if (!root) return { present: false, text: '' };
  try { document.__fsAgentInstructions = root; } catch (e) {}
  return { present: true, text: norm(root.innerText || '').slice(0, 4000) };
}

/**
 * v2.48.104 (page) — click the surface's "+ Add instruction"
 * control (opens the instruction form). Exact-text match on
 * the smallest carrier; climbs to a clickable ancestor like
 * the settings clicker. Returns true iff clicked.
 */
function pageClickAddInstruction(selectors) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const isInteractive = (n) => {
    if (!n || !n.tagName) return false;
    if (n.tagName === 'BUTTON' || n.tagName === 'A') return true;
    const role = n.getAttribute && n.getAttribute('role');
    if (role === 'button' || role === 'link' || role === 'menuitem') return true;
    if (n.getAttribute && n.getAttribute('tabindex') !== null && n.getAttribute('tabindex') !== undefined) return true;
    try { if (typeof getComputedStyle === 'function' && getComputedStyle(n).cursor === 'pointer') return true; } catch (e) {}
    return false;
  };
  let root = document.body;
  try { const st = document.__fsAgentInstructions; if (st && document.contains(st)) root = st; } catch (e) {}
  try {
    const pool = Array.from((root || document).querySelectorAll('button, [role="button"], a, label, li, span'));
    const hits = pool.filter(el => {
      const t = norm(el.innerText || '');
      return t === 'Add instruction' || t === '+ Add instruction';
    });
    if (!hits.length) return false;
    let target = hits[0];
    if (!isInteractive(target)) {
      let node = target;
      for (let i = 0; node && i < 6; i++) {
        if (isInteractive(node)) { target = node; break; }
        node = node.parentElement;
      }
    }
    target.click();
    return true;
  } catch (e) {}
  return false;
}

/**
 * v2.48.104 (page) — fill the instruction FORM (the owner's
 * screenshot: an enable toggle, an "Instruction title" field,
 * a "+ Reference" tile, a guideline area whose placeholder
 * reads "Create a guideline for your agent", and Done). The
 * toggle is turned ON only when it is explicitly OFF — an
 * already-on (or unreadable) toggle is never toggled blindly.
 * Values are set with the native setter + input/change
 * events so framework state picks them up. Returns
 * { titleSet, bodySet, toggle } with toggle ∈ true (on) |
 * false (found but off) | null (not found).
 */
function pageFillAgentInstruction(selectors, payload) {
  const p = payload || {};
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  let root = document.body;
  try { const st = document.__fsAgentInstructions; if (st && document.contains(st)) root = st; } catch (e) {}
  const allDeep = (r) => {
    const out = [];
    try { out.push(...Array.from(r.querySelectorAll('*'))); } catch (e) {}
    try {
      const walker = document.createTreeWalker(r, 1);
      let n;
      while ((n = walker.nextNode())) {
        if (n.shadowRoot) { try { out.push(...Array.from(n.shadowRoot.querySelectorAll('*'))); } catch (e) {} }
      }
    } catch (e) {}
    return out;
  };
  const els = allDeep(root || document);
  const hintOf = (el) => norm([el.getAttribute && el.getAttribute('placeholder'), el.getAttribute && el.getAttribute('aria-label'), el.getAttribute && el.getAttribute('name')].filter(Boolean).join(' '));
  const isField = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true || (el.getAttribute && el.getAttribute('contenteditable') === 'true'));
  const setVal = (el, v) => {
    try {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        let desc = null;
        try { desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); } catch (e) {}
        if (desc && desc.set) desc.set.call(el, v); else el.value = v;
      } else {
        el.textContent = v;
      }
    } catch (e) { try { el.value = v; } catch (e2) {} }
    try {
      if (typeof el.dispatchEvent === 'function' && typeof Event === 'function') {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (e) {}
    return true;
  };
  const fields = els.filter(isField);
  let titleEl = fields.find(el => /instruction title/i.test(hintOf(el))) || null;
  let bodyEl = fields.find(el => /create a guideline|guideline/i.test(hintOf(el))) || null;
  if (!bodyEl) bodyEl = fields.find(el => el !== titleEl && el.tagName === 'TEXTAREA') || fields.find(el => el !== titleEl && el.isContentEditable) || null;
  if (!titleEl) titleEl = fields.find(el => el !== bodyEl && el.tagName === 'INPUT') || fields.find(el => el !== bodyEl) || null;
  const titleSet = titleEl ? setVal(titleEl, String(p.title || '')) : false;
  const bodySet = bodyEl ? setVal(bodyEl, String(p.body || '')) : false;
  // The enable toggle: a switch/checkbox in the form.
  let toggle = null;
  try {
    const sw = els.find(el => (el.getAttribute && el.getAttribute('role') === 'switch') || (el.tagName === 'INPUT' && (el.getAttribute && el.getAttribute('type')) === 'checkbox'));
    if (sw) {
      const ariaChecked = sw.getAttribute && sw.getAttribute('aria-checked');
      const on = ariaChecked !== null && ariaChecked !== undefined ? ariaChecked === 'true' : (sw.checked === true || (sw.getAttribute && sw.getAttribute('data-state') === 'checked'));
      if (on) toggle = true;
      else { try { sw.click(); } catch (e) {} toggle = false; }
    }
  } catch (e) {}
  return { titleSet, bodySet, toggle };
}

/**
 * v2.48.104 (page) — click the instructions surface's "Done"
 * button (it SAVES the form / closes the screen — pinned at
 * the bottom in both of the owner's instruction screenshots).
 * Exact-text, non-disabled buttons only; the stashed surface
 * is searched first, then the document. Returns true iff
 * clicked.
 */
function pageClickInstructionsDone(selectors) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const wanted = (selectors && selectors.instructionsDoneText) || 'Done';
  const tryRoot = (root) => {
    if (!root || !root.querySelectorAll) return false;
    const btns = Array.from(root.querySelectorAll('button, [role="button"]'));
    const hit = btns.find(b => norm(b.innerText || '') === wanted && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    if (hit) { hit.click(); return true; }
    return false;
  };
  try { const st = document.__fsAgentInstructions; if (st && document.contains(st) && tryRoot(st)) return true; } catch (e) {}
  try { if (tryRoot(document.body)) return true; } catch (e) {}
  return false;
}

/**
 * v2.48.104 (page) — the instructions-side twin of the
 * settings region survey: when the instructions surface
 * cannot be opened/found, this is the evidence that travels
 * with the failure — every clickable near the composer/panel,
 * with its text and hint attributes. Returns string entries
 * (cap 12).
 */
function pageSurveyInstructionsSurface(selectors) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  let root = document.body || document.documentElement;
  try { const st = document.__fsAgentPanel; if (st && document.contains(st)) root = st; } catch (e) {}
  const out = [];
  try {
    const els = Array.from((root || document).querySelectorAll('button, [role="button"], a'));
    for (const el of els) {
      const tag = (el.tagName || '?').toLowerCase();
      const t = norm(el.innerText || '').slice(0, 30);
      const aria = norm(el.getAttribute && el.getAttribute('aria-label')).slice(0, 40);
      const testid = norm(el.getAttribute && el.getAttribute('data-testid')).slice(0, 30);
      out.push(`${tag} text="${t}" aria="${aria}" testid="${testid}"`);
      if (out.length >= 12) break;
    }
  } catch (e) {}
  return out;
}

// Pack 3 (item 2) — surface detection by TEXT ANCHORS. The
// settings surface counts as found when a visible container's
// text carries "Agent settings" AND ("Confirm before
// generating" OR "Video generation default") — the field-
// calibrated surface contents, independent of any class or
// role the build happens to use (the AGENTTEST7 surface
// matched none of the legacy selectors). The SMALLEST carrier
// of both anchors is the surface; it is stashed on
// document.__fsAgentSettings so the read/click/save helpers
// operate on exactly the node the anchors proved. A live stash
// with the anchors still on it answers immediately.
function pageAgentSettingsSurface(selectors) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const anchorsOf = (t) => ({
    title: t.includes('Agent settings'),
    confirm: t.includes('Confirm before generating'),
    videoDefault: t.includes('Video generation default')
  });
  const isSurface = (a) => a.title && (a.confirm || a.videoDefault);
  try {
    const st = document.__fsAgentSettings || null;
    if (st && document.contains(st)) {
      const a = anchorsOf(norm(st.innerText || ''));
      if (isSurface(a)) return { present: true, via: 'stash', confirm: a.confirm, videoDefault: a.videoDefault };
    }
  } catch (e) {}
  let best = null;
  let bestAnchors = null;
  let bestLen = Infinity;
  try {
    const cands = document.querySelectorAll('div, section, aside, form, [role="dialog"], [role="menu"]');
    for (const el of Array.from(cands)) {
      let t = '';
      try { t = norm(el.innerText || ''); } catch (e) { t = ''; }
      if (!t || t.length >= bestLen || t.length > 8000) continue;
      const a = anchorsOf(t);
      if (isSurface(a)) { best = el; bestAnchors = a; bestLen = t.length; }
    }
  } catch (e) {}
  if (best) {
    try { document.__fsAgentSettings = best; } catch (e) {}
    return { present: true, via: 'text', confirm: bestAnchors.confirm, videoDefault: bestAnchors.videoDefault };
  }
  return { present: false, via: null, confirm: false, videoDefault: false };
}

// v2.48.100 (Fix B) — scroll the settings surface so the
// "Video generation default" section is IN VIEW. The owner's
// recording (FLOW-MAP.md, Step 3) shows that section sits
// BELOW THE FOLD of the slide-over: the panel must be scrolled
// before the video model/aspect/outputs can be read or set
// (an unrendered row cannot be trusted to read). The smallest
// element carrying the section title is scrolled into view,
// and the nearest scrollable ancestor is wound to reveal it.
// Defensive throughout (the surface is another app's DOM):
// returns { found, scrolled } and never throws.
function pageScrollAgentSettingsToVideo(selectors) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  let root = null;
  try {
    const st = document.__fsAgentSettings || null;
    if (st && document.contains(st)) root = st;
  } catch (e) {}
  if (!root) {
    for (const sel of selectors.settingsPanel) {
      try { root = document.querySelector(sel); } catch (e) { root = null; }
      if (root) break;
    }
  }
  if (!root) return { found: false, scrolled: false };
  let target = null;
  try {
    const els = Array.from(root.querySelectorAll('div, span, h1, h2, h3, h4, h5, p, label, section'));
    let bestLen = Infinity;
    for (const el of els) {
      const t = norm(el.innerText || '');
      // <=, not <: ancestors of the heading carry the same
      // text at the same length, and document order visits
      // them first — the DEEPEST carrier is the heading.
      if (t.includes('Video generation default') && t.length <= bestLen) { bestLen = t.length; target = el; }
    }
  } catch (e) {}
  if (!target) return { found: false, scrolled: false };
  let scrolled = false;
  try {
    if (typeof target.scrollIntoView === 'function') { target.scrollIntoView({ block: 'center' }); scrolled = true; }
  } catch (e) {}
  let cur = target;
  for (let depth = 0; cur && depth < 10; depth++) {
    try {
      if (typeof cur.scrollHeight === 'number' && typeof cur.clientHeight === 'number' && cur.scrollHeight > cur.clientHeight) {
        cur.scrollTop = cur.scrollHeight;
        scrolled = true;
        break;
      }
    } catch (e) {}
    cur = cur.parentElement;
  }
  return { found: true, scrolled };
}

// v2.48.101 (Fix D) — the same scroll for any other settings
// section, by its heading text. The aligner scrolls the
// 'Confirm before generating' section back into view before a
// read pass: the video-section scroll leaves it above the
// fold, and a section the panel has never rendered cannot be
// read or trusted.
function pageScrollAgentSettingsToSection(selectors, sectionText) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const want = String(sectionText || '');
  if (!want) return { found: false, scrolled: false };
  let root = null;
  try {
    const st = document.__fsAgentSettings || null;
    if (st && document.contains(st)) root = st;
  } catch (e) {}
  if (!root) {
    for (const sel of selectors.settingsPanel) {
      try { root = document.querySelector(sel); } catch (e) { root = null; }
      if (root) break;
    }
  }
  if (!root) return { found: false, scrolled: false };
  let target = null;
  try {
    const els = Array.from(root.querySelectorAll('div, span, h1, h2, h3, h4, h5, p, label, section'));
    let bestLen = Infinity;
    for (const el of els) {
      const t = norm(el.innerText || '');
      if (t.includes(want) && t.length <= bestLen) { bestLen = t.length; target = el; }
    }
  } catch (e) {}
  if (!target) return { found: false, scrolled: false };
  let scrolled = false;
  try {
    if (typeof target.scrollIntoView === 'function') { target.scrollIntoView({ block: 'center' }); scrolled = true; }
  } catch (e) {}
  let cur = target;
  for (let depth = 0; cur && depth < 10; depth++) {
    try {
      if (typeof cur.scrollHeight === 'number' && typeof cur.clientHeight === 'number' && cur.scrollHeight > cur.clientHeight) {
        cur.scrollTop = cur.scrollHeight;
        scrolled = true;
        break;
      }
    } catch (e) {}
    cur = cur.parentElement;
  }
  return { found: true, scrolled };
}

// v2.48.101 (Fix D) — survey the SETTINGS SURFACE itself (the
// panel-region survey only runs when the surface is NOT
// found). When a read comes back 'unreadable', this is
// the evidence that shows the surface's real DOM from chat.
// v2.48.102 (Fix F): the aligner calls this at the FIRST
// unreadable read, while the surface is still open — a
// verify-time call runs after Save closed the surface and
// photographs the panel instead (AGENTTEST10).
// its interactive elements (deep, shadow roots included) with
// aria / text / geometry, capped at ~500 joined chars.
function pageSurveySettingsSurface(selectors) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  let root = null;
  try {
    const st = document.__fsAgentSettings || null;
    if (st && document.contains(st)) root = st;
  } catch (e) {}
  if (!root) {
    for (const sel of selectors.settingsPanel) {
      try { root = document.querySelector(sel); } catch (e) { root = null; }
      if (root) break;
    }
  }
  if (!root) return [];
  const allDeep = (node) => {
    const out = [];
    const visit = (n) => {
      if (!n) return;
      let kids = [];
      try { kids = n.children ? Array.from(n.children) : []; } catch (e) { kids = []; }
      for (const k of kids) {
        out.push(k);
        visit(k);
        try { if (k.shadowRoot) visit(k.shadowRoot); } catch (e) {}
      }
    };
    visit(node);
    return out;
  };
  const isInteractive = (e) => {
    const tag = String(e.tagName || '');
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'LABEL') return true;
    if (typeof e.getAttribute !== 'function') return false;
    const role = e.getAttribute('role');
    return role === 'button' || role === 'radio' || role === 'option' || role === 'menuitem' || role === 'combobox' || role === 'listbox' || !!e.getAttribute('aria-haspopup') || e.hasAttribute('tabindex');
  };
  const entries = [];
  let joined = 0;
  let els = [];
  try { els = allDeep(root); } catch (e) { els = []; }
  for (const el of els) {
    if (entries.length >= 12) break;
    let interactive = false;
    try { interactive = isInteractive(el); } catch (e) { interactive = false; }
    if (!interactive) continue;
    const aria = el.getAttribute ? el.getAttribute('aria-label') : null;
    const title = el.getAttribute ? el.getAttribute('title') : null;
    const text = norm(el.innerText || '').substring(0, 40);
    let box = '';
    try {
      const r = el.getBoundingClientRect();
      box = ` @${Math.round(r.left || 0)},${Math.round(r.top || 0)} ${Math.round(r.width || 0)}x${Math.round(r.height || 0)}`;
    } catch (e) {}
    const entry = `<${String(el.tagName || '?').toLowerCase()}${aria ? ` aria="${aria}"` : ''}${title ? ` title="${title}"` : ''}${text ? ` text="${text}"` : ''}${box}>`;
    if (entries.length && joined + entry.length + 3 > 500) break;
    entries.push(entry);
    joined += entry.length + 3;
  }
  return entries;
}

// Pack 3 (item 1b) — opener strategy (b): an icon button NEAR
// THE COMPOSER whose aria-label/title speaks of settings at
// all (/settings|tune|sliders|adjust/i). "Near the composer"
// is the composer's toolbar row: the nearest ancestor (bounded
// walk) that holds at least one button. The anchored panel is
// the fallback scope when there is no composer. The composer
// finder is inlined (page functions cannot call each other)
// with the exact shape pageAnchorAgentPanel proved.
function pageClickComposerSettingsIcon(selectors) {
  const findComposer = () => {
    try {
      const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]'));
      const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true');
      const pool = ed.length ? ed : all;
      const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); });
      const list = vis.length ? vis : pool;
      if (!list.length) return null;
      return list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || e.getAttribute('placeholder') || '')) ||
        list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
    } catch (e) { return null; }
  };
  let scope = null;
  const composer = findComposer();
  if (composer) {
    let cur = composer;
    let depth = 0;
    while (cur && depth < 4) {
      let hasBtn = false;
      try { hasBtn = !!cur.querySelector('button, [role="button"]'); } catch (e) { hasBtn = false; }
      if (hasBtn) { scope = cur; break; }
      cur = cur.parentElement;
      depth++;
    }
    if (!scope) scope = composer.parentElement || null;
  }
  if (!scope) {
    try { scope = document.__fsAgentPanel || null; } catch (e) { scope = null; }
    if (scope && !document.contains(scope)) scope = null;
  }
  if (!scope) return false;
  let els = [];
  try { els = Array.from(scope.querySelectorAll('button, [role="button"]')); } catch (e) { els = []; }
  const hit = els.find(el => /settings|tune|sliders|adjust/i.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`));
  if (hit) {
    hit.click();
    return true;
  }
  return false;
}

// v2.48.100 (Fix B) — opener strategy (a2): the 'tune' icon
// button. The AGENTTEST8 settings survey + the owner's screen
// recording (FLOW-MAP.md) pin the composer row's real shape:
// icon buttons whose TEXT is a Material ligature — 'add'
// (ingredients), 'article_spark' (instructions), 'tune'
// (SETTINGS), send/stop. The sliders control that opens Agent
// settings is the 'tune' button: it carries NO settings-ish
// aria-label for strategy (b), its innerText disqualifies it
// from the icon-only strategy (c), and no class hook names it
// for the selector table. This strategy matches a button whose
// icon text (or aria-label/title) is exactly 'tune', looking
// in the docked panel first (its composer row is the panel's
// bottom area), then in the centre composer's toolbar row
// (the pre-dock state, where the same row lives in the page's
// bottom-centre prompt box). The composer finder is inlined
// with the shape the other strategies proved.
function pageClickComposerTuneIcon(selectors) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const isTune = (el) => norm(el.innerText || '') === 'tune' ||
    norm(el.getAttribute ? (el.getAttribute('aria-label') || '') : '') === 'tune' ||
    norm(el.getAttribute ? (el.getAttribute('title') || '') : '') === 'tune';
  const clickIn = (root) => {
    if (!root) return false;
    let els = [];
    try { els = Array.from(root.querySelectorAll('button, [role="button"]')); } catch (e) { els = []; }
    const hits = els.filter(isTune);
    if (!hits.length) return false;
    hits[hits.length - 1].click();
    return true;
  };
  let panel = null;
  try { panel = document.__fsAgentPanel || null; } catch (e) { panel = null; }
  if (panel && !document.contains(panel)) panel = null;
  if (!panel) {
    for (const sel of selectors.panel) {
      try { panel = document.querySelector(sel); } catch (e) { panel = null; }
      if (panel) break;
    }
  }
  if (clickIn(panel)) return true;
  // Centre composer before the panel docks: the composer's
  // toolbar row is the nearest button-bearing ancestor.
  let composer = null;
  try {
    const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]'));
    const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true');
    const pool = ed.length ? ed : all;
    const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); });
    const list = vis.length ? vis : pool;
    composer = list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || e.getAttribute('placeholder') || '')) ||
      list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
  } catch (e) { composer = null; }
  if (composer) {
    let scope = null;
    let cur = composer;
    let depth = 0;
    while (cur && depth < 4) {
      let hasBtn = false;
      try { hasBtn = !!cur.querySelector('button, [role="button"]'); } catch (e) { hasBtn = false; }
      if (hasBtn) { scope = cur; break; }
      cur = cur.parentElement;
      depth++;
    }
    if (clickIn(scope || composer.parentElement)) return true;
  }
  return false;
}

// Pack 3 (item 1c) — opener strategy (c), the last resort: an
// ICON-ONLY button in the composer's toolbar row — no text, no
// aria-label, no title, an svg inside — clicked LAST one first
// (settings icons sit at the row's end). Icon-only matters: a
// labelled button in the row is a known control (Send, the
// Agent toggle), never a guess.
function pageClickComposerToolbarLastIcon(selectors) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const findComposer = () => {
    try {
      const all = Array.from(document.querySelectorAll('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror, [contenteditable="true"][role="textbox"]'));
      const ed = all.filter(e => e.isContentEditable || e.getAttribute('contenteditable') === 'true');
      const pool = ed.length ? ed : all;
      const vis = pool.filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 8 && (e.checkVisibility ? e.checkVisibility() : true); });
      const list = vis.length ? vis : pool;
      if (!list.length) return null;
      return list.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || e.getAttribute('placeholder') || '')) ||
        list.slice().sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
    } catch (e) { return null; }
  };
  const composer = findComposer();
  if (!composer) return false;
  let scope = null;
  let cur = composer;
  let depth = 0;
  while (cur && depth < 4) {
    let hasBtn = false;
    try { hasBtn = !!cur.querySelector('button, [role="button"]'); } catch (e) { hasBtn = false; }
    if (hasBtn) { scope = cur; break; }
    cur = cur.parentElement;
    depth++;
  }
  if (!scope) return false;
  let els = [];
  try { els = Array.from(scope.querySelectorAll('button, [role="button"]')); } catch (e) { els = []; }
  const iconOnly = els.filter(el => {
    if (norm(el.innerText || '')) return false;
    if (el.getAttribute('aria-label') || el.getAttribute('title')) return false;
    try { return !!el.querySelector('svg'); } catch (e) { return false; }
  });
  if (!iconOnly.length) return false;
  iconOnly[iconOnly.length - 1].click();
  return true;
}

// Pack 3 (item 3) — the failure survey for a settings surface
// that never appeared: the clickable elements of the panel /
// composer region (tag, aria-label, title, text snippet,
// bounding box), so the next calibration reads the region's
// real controls from the log (or the Doctor's detail) instead
// of guessing. Mirrors pageSurveyAgentDom's self-evidencing
// style; capped at 12 entries.
function pageSurveySettingsRegion(selectors) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  let scope = null;
  try { scope = document.__fsAgentPanel || null; } catch (e) { scope = null; }
  if (scope && !document.contains(scope)) scope = null;
  if (!scope) {
    try {
      const all = Array.from(document.querySelectorAll('div.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]'));
      const composer = all.find(e => /what do you want to create/i.test(e.getAttribute('aria-label') || e.getAttribute('data-placeholder') || e.getAttribute('placeholder') || ''));
      let cur = composer || null;
      let depth = 0;
      while (cur && depth < 4) { scope = cur; cur = cur.parentElement; depth++; }
    } catch (e) {}
  }
  if (!scope) scope = document.body;
  const entries = [];
  try {
    const els = Array.from(scope.querySelectorAll('button, [role="button"], a, [tabindex]'));
    for (const el of els) {
      if (entries.length >= 12) break;
      const aria = el.getAttribute ? el.getAttribute('aria-label') : null;
      const title = el.getAttribute ? el.getAttribute('title') : null;
      const text = norm(el.innerText || '').substring(0, 40);
      let box = '';
      try {
        const r = el.getBoundingClientRect();
        box = ` @${Math.round(r.left || 0)},${Math.round(r.top || 0)} ${Math.round(r.width || 0)}x${Math.round(r.height || 0)}`;
      } catch (e) {}
      entries.push(`<${String(el.tagName || '?').toLowerCase()}${aria ? ` aria="${aria}"` : ''}${title ? ` title="${title}"` : ''}${text ? ` text="${text}"` : ''}${box}>`);
    }
  } catch (e) {}
  return entries;
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * Align the project's per-project Agent settings — Confirm
 * before generating = Always (Never is never set), the run's
 * model mapped into the Agent's own labels, the run's aspect
 * when 16:9/9:16, outputs x1 — then Save and verify by
 * re-reading. Runs on the model-fix retry path, with the panel
 * open and its prompt box unlocked after a Reject.
 *
 * Pack 3 (AGENTTEST7: the legacy single-click opener never
 * found the surface — 'agent-settings-unaligned' with no
 * evidence): the surface is now hunted in order — (a) the
 * panel's own "agent settings" control (selector table, then a
 * label/text scan), (b) a settings-ish icon button in the
 * composer's toolbar row, (c) the row's LAST icon-only button —
 * and it counts as found by its TEXT ANCHORS ("Agent settings"
 * + "Confirm before generating" / "Video generation default"),
 * with the legacy selector presence as fallback. A surface
 * that never appears produces a DOM survey of the region
 * (logged + returned as detail for the Doctor). When it IS
 * operated, ALL values are set in one pass, Saved, re-read and
 * verified one by one (a line per value); any mismatch names
 * its field.
 *
 * Returns a result object, never a bare boolean:
 *   { aligned: true,  outcome: 'aligned' }
 *   { aligned: false, outcome: 'not-found', detail } — the
 *     surface never appeared; detail is the region survey.
 *   { aligned: false, outcome: 'mismatch', field, detail } —
 *     the surface was operated but a value (or Save) failed;
 *     when a verify read was 'unreadable', detail also carries
 *     a survey of the settings surface itself (Fix D),
 *     captured while the surface is open at the first
 *     unreadable read (Fix F, v2.48.102).
 *   { aligned: false, outcome: 'error', detail } — a throw.
 *
 * v2.48.101 (Fix C): EVERY non-aligned outcome unlocks the
 * driver's named-model fallback re-send (until .100 only
 * 'not-found' did — AGENTTEST9's surface was found and operated
 * yet read all-'unreadable', and the run parked one step from
 * the proven fallback).
 */
async function alignAgentSettings(engine, settings, log, args) {
  const a = args || {};
  const openWaitMs = a.settingsOpenWaitMs !== undefined ? a.settingsOpenWaitMs : SETTINGS_OPEN_WAIT_MS;
  const surfaceWaitMs = a.settingsSurfaceWaitMs !== undefined ? a.settingsSurfaceWaitMs : SETTINGS_SURFACE_WAIT_MS;
  const surfacePollMs = a.settingsSurfacePollMs || SETTINGS_SURFACE_POLL_MS;
  const desired = desiredAgentSettings(settings);
  // v2.48.104: every return carries the READ-BACK — the field
  // values the reopened settings actually showed (nulls where
  // unreadable) — because the settings-first record in the
  // Agent Doctor must report what the settings ARE, never
  // what the run merely intended.
  const readBackOf = (st) => ({
    confirm: st && st.confirm != null ? st.confirm : null,
    model: st && st.model != null ? st.model : null,
    aspect: st && st.aspect != null ? st.aspect : null,
    outputs: st && st.outputs != null ? st.outputs : null
  });
  // Pack 3 (item 11): the alignment announces itself first —
  // the log never goes silent between the Reject and the
  // outcome line.
  log('aligning');
  if (!desired.modelKnown) {
    log('settings-skip', { detail: `the run's model "${settings.model || ''}" has no Flow Agent mapping — the project's Agent model default is left as-is.` });
  }
  if (!desired.aspect) {
    log('settings-skip', { detail: `the run's aspect "${settings.aspectRatio || ''}" is not 16:9 or 9:16 — the project's Agent aspect default is left as-is.` });
  }
  try {
    // v2.48.99: ONE re-anchor attempt before the settings
    // surface is opened. The composer anchor missed at send
    // time in the .98 field run (panel not yet fully rendered);
    // by the retry path the panel HAS rendered (a proposal was
    // read and rejected in it), so the anchor has its best
    // chance here. The outcome is logged either way; when the
    // anchor lands, the settings helpers resolve it first.
    let reanchorInfo = null;
    try { reanchorInfo = await engine.page.evaluate(pageAnchorAgentPanel, AGENT_SELECTORS); } catch (e) { reanchorInfo = null; }
    log('reanchor', reanchorInfo || { found: false });

    // Surface detection: the TEXT ANCHORS are the primary
    // proof; the legacy selector presence is the fallback (the
    // pre-pack-3 signal, kept so a surface the anchors somehow
    // miss is still usable).
    const detectSurface = async () => {
      try {
        const s = await engine.page.evaluate(pageAgentSettingsSurface, AGENT_SELECTORS);
        if (s && s.present === true) return true;
      } catch (e) {}
      try {
        if ((await engine.page.evaluate(pageAgentSettingsPresent, AGENT_SELECTORS)) === true) return true;
      } catch (e) {}
      return false;
    };
    const waitSurface = async (budgetMs) => {
      const deadline = Date.now() + Math.max(0, budgetMs);
      for (;;) {
        if (await detectSurface()) return true;
        if (Date.now() >= deadline) return false;
        await sleep(Math.min(surfacePollMs, Math.max(1, deadline - Date.now())));
      }
    };
    // The multi-strategy opener (item 1): each strategy clicks,
    // waits ~1.5s, then the surface anchors are polled for up
    // to ~8s before the next strategy is tried.
    const openSurface = async () => {
      if (await detectSurface()) return 'already open';
      const strategies = [
        ['panel settings control', pageOpenAgentSettings],
        ['composer tune icon', pageClickComposerTuneIcon],
        ['composer settings icon', pageClickComposerSettingsIcon],
        ['composer toolbar icon (last)', pageClickComposerToolbarLastIcon]
      ];
      for (const [name, fn] of strategies) {
        if (engine.isStopping) return null;
        let clicked = false;
        try { clicked = (await engine.page.evaluate(fn, AGENT_SELECTORS)) === true; } catch (e) { clicked = false; }
        if (!clicked) continue;
        await sleep(openWaitMs);
        if (await waitSurface(surfaceWaitMs)) return name;
      }
      return null;
    };
    const openedVia = await openSurface();
    if (!openedVia) {
      // Item 3: survey the region so the failure carries its
      // own evidence — logged here, and returned as detail for
      // the Doctor's last-run record.
      let entries = [];
      try {
        const raw = await engine.page.evaluate(pageSurveySettingsRegion, AGENT_SELECTORS);
        if (Array.isArray(raw)) entries = raw;
      } catch (e) {}
      if (entries.length) log('settings-survey', { entries });
      log('settings-unaligned', { detail: 'the Agent settings surface was not found' });
      return {
        aligned: false,
        outcome: 'not-found',
        readBack: readBackOf(null),
        detail: entries.length ? entries.join(' | ') : 'the settings survey captured no clickable elements in the panel/composer region'
      };
    }
    log('settings-opened', { via: openedVia });
    // v2.48.102 (Fix F): the settings-surface survey is
    // captured WHILE THE SURFACE IS OPEN — the helper is
    // defined here, the first capture happens at the first
    // unreadable read below, and the mismatch detail prefers
    // that while-open capture. AGENTTEST10's verify-time
    // capture (the .101 Fix D behaviour) ran after Save had
    // already closed the surface, so the Doctor detail showed
    // the PANEL's elements instead of the settings DOM.
    let openSurveyText = null;
    const captureSurfaceSurvey = async () => {
      // v2.48.104: ONE survey per run (memoised on the args
      // object — the submit path resets it for each run). The
      // settings-first pre-flight and a later retry alignment
      // share the FIRST capture, so the evidence that reaches
      // the Doctor is always the state the run first saw (the
      // X105 timing pin), never a later, already-settled DOM.
      if (typeof a.__fsSettingsSurvey === 'string' && a.__fsSettingsSurvey) return a.__fsSettingsSurvey;
      let entries = [];
      try {
        const raw = await engine.page.evaluate(pageSurveySettingsSurface, AGENT_SELECTORS);
        if (Array.isArray(raw)) entries = raw;
      } catch (e) {}
      if (!entries.length) return null;
      log('settings-survey', { entries });
      const joined = entries.join(' | ');
      try { a.__fsSettingsSurvey = joined; } catch (e) {}
      return joined;
    };
    // v2.48.100 (Fix B): the "Video generation default"
    // section is BELOW THE FOLD of the slide-over (the owner's
    // recording) — scroll it into view BEFORE the read/set
    // pass, or the model row may not be rendered to read.
    // v2.48.101 (Fix D): scroll the Confirm section through the
    // viewport too, before AND after the video scroll — a
    // section the panel has never rendered cannot be read
    // (AGENTTEST9's all-'unreadable' verify), and the video
    // scroll leaves Confirm above the fold.
    const scrollBothSections = async () => {
      try { await engine.page.evaluate(pageScrollAgentSettingsToSection, AGENT_SELECTORS, 'Confirm before generating'); } catch (e) {}
      await sleep(200);
      try { await engine.page.evaluate(pageScrollAgentSettingsToVideo, AGENT_SELECTORS); } catch (e) {}
      await sleep(200);
    };
    await scrollBothSections();
    const state = await engine.page.evaluate(pageReadAgentSettings, AGENT_SELECTORS, KNOWN_AGENT_MODELS);
    // v2.48.102 (Fix F): the FIRST unreadable read is the
    // survey moment — the surface has just been opened and
    // detected, nothing has been set or Saved yet, so the
    // survey taken now is the settings DOM itself.
    if (state && state.present
      && [state.confirm, state.model, state.aspect, state.outputs].some(v => v === null || v === undefined)) {
      openSurveyText = await captureSurfaceSurvey();
    }
    if (state.confirm !== 'Always') {
      await engine.page.evaluate(pageClickSettingsText, AGENT_SELECTORS, 'Always');
      await sleep(300);
    }
    if (desired.modelLabel && state.model !== desired.modelLabel) {
      // Open the model dropdown (it shows the current label), then
      // pick the target label from the opened options.
      if (state.model) {
        await engine.page.evaluate(pageClickSettingsText, AGENT_SELECTORS, state.model);
        await sleep(500);
      }
      await engine.page.evaluate(pageClickSettingsText, AGENT_SELECTORS, desired.modelLabel);
      await sleep(300);
    }
    if (desired.aspect && state.aspect !== desired.aspect) {
      await engine.page.evaluate(pageClickSettingsText, AGENT_SELECTORS, desired.aspect);
      await sleep(300);
    }
    if (state.outputs !== 'x1') {
      const okX = await engine.page.evaluate(pageClickSettingsText, AGENT_SELECTORS, 'x1');
      if (!okX) await engine.page.evaluate(pageClickSettingsText, AGENT_SELECTORS, '1');
      await sleep(300);
    }
    const saved = await engine.page.evaluate(pageSaveAgentSettings, AGENT_SELECTORS);
    if (!saved) {
      log('settings-unaligned', { detail: 'the settings Save button was not found' });
      return { aligned: false, outcome: 'mismatch', field: 'save', readBack: readBackOf(state), detail: 'the settings Save button was not found' };
    }
    await sleep(700);
    // Verify by RE-READING the surface (reopening it first if
    // Save closed it) — the settings echo is the only proof.
    // Item 4: EVERY value is verified, one log line per value;
    // a mismatch names its field.
    let after = null;
    await scrollBothSections();
    try { after = await engine.page.evaluate(pageReadAgentSettings, AGENT_SELECTORS, KNOWN_AGENT_MODELS); } catch (e) { after = null; }
    if (!after || !after.present) {
      const via2 = await openSurface();
      if (via2) {
        await sleep(300);
        await scrollBothSections();
        try { after = await engine.page.evaluate(pageReadAgentSettings, AGENT_SELECTORS, KNOWN_AGENT_MODELS); } catch (e) { after = null; }
      }
    }
    const checks = [
      ['confirm', 'Always', after ? after.confirm : null],
      ...(desired.modelLabel ? [['model', desired.modelLabel, after ? after.model : null]] : []),
      ...(desired.aspect ? [['aspect', desired.aspect, after ? after.aspect : null]] : []),
      ['outputs', 'x1', after ? after.outputs : null]
    ];
    let mismatch = null;
    for (const [field, want, got] of checks) {
      const okValue = got === want;
      log('settings-value', { field, want, got, ok: okValue });
      if (!okValue && !mismatch) mismatch = { field, want, got };
    }
    if (after && after.present && !mismatch) {
      const detail = [
        desired.modelLabel ? `model ${desired.modelLabel}` : null,
        desired.aspect ? `aspect ${desired.aspect}` : null,
        'outputs x1'
      ].filter(Boolean).join(', ');
      log('settings-aligned', { detail });
      return { aligned: true, outcome: 'aligned', readBack: readBackOf(after) };
    }
    let mismatchDetail = mismatch
      ? `the settings field '${mismatch.field}' did not take the aligned value (wanted '${mismatch.want}', reads '${mismatch.got === null || mismatch.got === undefined ? 'unreadable' : mismatch.got}')`
      : 'Save was clicked, but the reopened settings do not show the aligned values';
    // v2.48.101 (Fix D): an 'unreadable' verify read captures a
    // survey of the SETTINGS SURFACE itself — logged, and
    // appended to the returned detail so the Doctor's last-run
    // record shows the surface's real DOM from chat (the
    // region survey only exists on the not-found path).
    // v2.48.102 (Fix F): the detail prefers the WHILE-OPEN
    // capture taken at the first unreadable read (the surface
    // is closed by Save before this verify path runs, and
    // AGENTTEST10's verify-time capture photographed the
    // panel instead); the verify-time capture survives as the
    // fallback for a first read that was clean.
    let surveyText = openSurveyText;
    if (!surveyText && mismatch && after && after.present && checks.some(c => c[2] === null || c[2] === undefined)) {
      surveyText = await captureSurfaceSurvey();
    }
    if (mismatch && surveyText) {
      mismatchDetail += ` | settings surface survey: ${surveyText.length > 360 ? `${surveyText.substring(0, 360)}…` : surveyText}`;
    }
    log('settings-unaligned', { detail: mismatchDetail });
    return { aligned: false, outcome: 'mismatch', field: mismatch ? mismatch.field : null, readBack: readBackOf(after), detail: mismatchDetail };
  } catch (e) {
    const errorDetail = (e && e.message) ? e.message : 'error while operating the settings surface';
    log('settings-unaligned', { detail: errorDetail });
    return { aligned: false, outcome: 'error', readBack: readBackOf(null), detail: errorDetail };
  }
}

/**
 * After a permission-option click, wait (bounded) for the
 * proposal to settle: the radio group gone or disabled, or the
 * panel prompt box unlocked. Returns false on timeout — the
 * caller fails with 'agent-settle-timeout' instead of hanging.
 */
/**
 * v2.48.104 — SETTINGS FIRST (the owner's final-version
 * order): align the project's Agent settings to this run —
 * Confirm = Always, the run's VIDEO model + aspect, outputs
 * x1; the Image defaults are never touched — with Save and a
 * read-back verify, BEFORE anything is sent. One retry of the
 * whole alignment when the first attempt does not verify;
 * whatever the outcome, the run CONTINUES (the settings are
 * guidance for the Agent, not a gate: the owner's own
 * recording showed a saved Omni 1.1 still producing an Omni
 * 1.2 proposal — the chat pin + the quote guard remain the
 * safety net). Emits the one summary line the brief fixes:
 * [AGENT] settings-first: model=…, aspect=…, outputs=…,
 * confirm=… — from the READ-BACK, never the intent.
 */
async function runSettingsFirst(engine, settings, log, args) {
  let res = await alignAgentSettings(engine, settings, log, args);
  if (!res || !res.aligned) {
    const second = await alignAgentSettings(engine, settings, log, args);
    if (second) res = second;
  }
  const rb = (res && res.readBack) || { confirm: null, model: null, aspect: null, outputs: null };
  log('settings-first', { model: rb.model, aspect: rb.aspect, outputs: rb.outputs, confirm: rb.confirm, ok: !!(res && res.aligned) });
  return res;
}

/**
 * v2.48.104 — the standing instruction, once per project:
 * open the Agent instructions surface (the FIRST composer-row
 * button); if an instruction titled "FlowStudio Run Rules"
 * is already listed, close and leave it exactly as it is;
 * otherwise add it — toggle ON, title set, the guideline text
 * byte-for-byte from agentRules — via Done, then verify it
 * reads back. Best-effort BY DESIGN: any failure is logged
 * with its evidence and reported as status 'failed'; it is
 * NEVER fatal to the run. Returns
 * { status: 'present' | 'added' | 'failed', detail? }.
 * NEVER throws.
 */
async function ensureAgentInstructions(engine, log, args) {
  const a = args || {};
  const openWaitMs = a.settingsOpenWaitMs !== undefined ? a.settingsOpenWaitMs : SETTINGS_OPEN_WAIT_MS;
  const surfaceWaitMs = a.settingsSurfaceWaitMs !== undefined ? a.settingsSurfaceWaitMs : SETTINGS_SURFACE_WAIT_MS;
  const surfacePollMs = a.settingsSurfacePollMs || SETTINGS_SURFACE_POLL_MS;
  const title = agentRules.AGENT_INSTRUCTION_TITLE;
  try {
    const detect = async () => {
      try { const s = await engine.page.evaluate(pageAgentInstructionsSurface, AGENT_SELECTORS); return !!(s && s.present === true); } catch (e) { return false; }
    };
    const waitSurface = async (budget) => {
      const deadline = Date.now() + Math.max(0, budget);
      for (;;) {
        if (await detect()) return true;
        if (Date.now() >= deadline) return false;
        await sleep(Math.min(surfacePollMs, Math.max(1, deadline - Date.now())));
      }
    };
    const openSurface = async () => {
      if (await detect()) return true;
      let clicked = false;
      try { clicked = (await engine.page.evaluate(pageClickComposerInstructionsIcon, AGENT_SELECTORS)) === true; } catch (e) { clicked = false; }
      if (!clicked) return false;
      await sleep(openWaitMs);
      return waitSurface(surfaceWaitMs);
    };
    const readText = async () => {
      try { const r = await engine.page.evaluate(pageReadAgentInstructions, AGENT_SELECTORS); return (r && typeof r.text === 'string') ? r.text : ''; } catch (e) { return ''; }
    };
    const done = async () => {
      try { await engine.page.evaluate(pageClickInstructionsDone, AGENT_SELECTORS); } catch (e) {}
      await sleep(400);
    };
    if (!(await openSurface())) {
      let entries = [];
      try { const raw = await engine.page.evaluate(pageSurveyInstructionsSurface, AGENT_SELECTORS); if (Array.isArray(raw)) entries = raw; } catch (e) {}
      if (entries.length) log('instructions-survey', { entries });
      const detail = 'the Agent instructions surface was not found';
      log('instructions-failed', { detail });
      return { status: 'failed', detail };
    }
    if ((await readText()).includes(title)) {
      await done();
      log('instructions-present', { title });
      return { status: 'present' };
    }
    let addClicked = false;
    try { addClicked = (await engine.page.evaluate(pageClickAddInstruction, AGENT_SELECTORS)) === true; } catch (e) { addClicked = false; }
    if (!addClicked) {
      const detail = 'the "+ Add instruction" control was not found on the instructions surface';
      log('instructions-failed', { detail });
      return { status: 'failed', detail };
    }
    await sleep(400);
    let fill = null;
    try { fill = await engine.page.evaluate(pageFillAgentInstruction, AGENT_SELECTORS, { title, body: agentRules.AGENT_INSTRUCTION_BODY }); } catch (e) { fill = null; }
    if (!fill || !fill.titleSet || !fill.bodySet) {
      await done();
      const detail = `the instruction form could not be filled (title ${fill && fill.titleSet ? 'set' : 'unset'}, guideline ${fill && fill.bodySet ? 'set' : 'unset'})`;
      log('instructions-failed', { detail });
      return { status: 'failed', detail: 'the instruction form could not be filled' };
    }
    await done();
    let text = await readText();
    if (!text.includes(title) && (await openSurface())) text = await readText();
    if (text.includes(title)) {
      log('instructions-added', { title });
      await done();
      return { status: 'added' };
    }
    const detail = 'the instruction was filled and saved but does not read back on the instructions surface';
    log('instructions-failed', { detail });
    return { status: 'failed', detail: 'the added instruction did not read back' };
  } catch (e) {
    const detail = (e && e.message) || 'error while operating the instructions surface';
    try { log('instructions-failed', { detail }); } catch (e2) {}
    return { status: 'failed', detail: 'error while operating the instructions surface' };
  }
}

async function waitForProposalSettle(engine, args) {
  const a = args || {};
  const deadline = Date.now() + (a.settleTimeoutMs || SETTLE_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (engine.isStopping) return false;
    let st = null;
    try { st = await engine.page.evaluate(pagePermissionState, AGENT_SELECTORS); } catch (e) {}
    if (st && (!st.present || !st.enabled || !st.promptLocked)) return true;
    await sleep(a.settlePollMs || SETTLE_POLL_MS);
  }
  return false;
}

/**
 * Submit ONE prompt through Flow's Agent. Mirrors submitPrompt's
 * contract with the pool: returns { status: 'STOPPED' |
 * 'EXHAUSTED' | 'LOW_CREDITS' | 'VIOLATION' | 'AGENT_PARKED' |
 * 'AGENT_FAILED' } or a SUBMITTED task object. Rule-based only —
 * no keys, no external calls; every decision is
 * agentRules.decideOnProposal over the live panel text.
 *
 * This is the inner run; the exported submitViaAgent wrapper
 * below records EVERY exit of this function (including a throw)
 * into the Agent Doctor's last-run slot. noteProposal (optional)
 * is called at each proposal decision with { quoted, model, act }
 * so the wrapper can record the last proposal the run decided on.
 */
async function submitViaAgentInner(engine, args, noteProposal) {
  const a = args || {};
  const promptText = String(a.promptText || '').replace(/[\r\n]+/g, ' ').trim();
  const settings = a.settings || {};
  const promptIndex = a.promptIndex || 0;
  const totalPrompts = a.totalPrompts || 1;
  const log = (kind, data, type) => {
    try { engine.log(agentLine(kind, data), type || 'info'); } catch (e) {}
  };
  // v2.48.104: the settings-surface survey is memoised per
  // run (alignAgentSettings consults it) — reset it here so a
  // reused args object can never leak a previous run's survey.
  try { a.__fsSettingsSurvey = undefined; } catch (e) {}

  if (engine.isStopping) return { status: 'STOPPED' };
  if (!promptText) {
    return { status: 'AGENT_FAILED', reason: 'The prompt text was EMPTY when it reached the engine — there was nothing to send to Flow\'s Agent.' };
  }

  const videoId = `vid_${Date.now()}_${promptIndex + 1}`;
  engine.captureArmed = true;
  if (engine.onVideoStarted) {
    engine.onVideoStarted({
      id: videoId,
      prompt: promptText,
      promptIndex: promptIndex + 1,
      totalPrompts,
      accountName: engine.currentAccount ? engine.currentAccount.name : 'Account',
      status: 'Chatting with Flow\'s Agent…'
    });
  }

  await engine.dismissAnyBlockingOverlays();

  // Same pre-fire credit gate as the direct route.
  if (settings.type !== 'Image') {
    const creditState = await engine.checkCreditsState(settings);
    if (creditState === 'EXHAUSTED') return { status: 'EXHAUSTED' };
    if (creditState === 'LOW_CREDITS') return { status: 'LOW_CREDITS' };
  }

  // Snapshot the existing tiles BEFORE the Agent makes anything —
  // the same proof the direct route takes (audit fix #6), so the
  // media this run claims is provably new. The panel gallery gets
  // the same snapshot: its items are completion evidence too.
  let preExistingTileCount = 0;
  let preExistingAriaLabels = [];
  try {
    const snap = await engine.page.evaluate(() => {
      const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
      return {
        count: containers.length,
        labels: containers.map(c => (c.getAttribute('aria-label') || '').toLowerCase().trim()).filter(Boolean)
      };
    });
    preExistingTileCount = snap.count;
    preExistingAriaLabels = snap.labels;
  } catch (e) {}
  const preExistingFingerprints = new Set(preExistingAriaLabels.map(l => tileIdentity.tileFingerprint(l, '')));
  let preExistingGallery = new Set();
  try { preExistingGallery = new Set(await engine.page.evaluate(pageGalleryLabels, AGENT_SELECTORS)); } catch (e) {}
  const preExistingVideoUrls = new Set(engine.capturedVideoUrls || []);
  try { if (engine.netCapture) engine.netCapture.beginSubmission(videoId, Date.now()); } catch (e) {}

  // 1. Turn Flow's Agent ON.
  let toggle = await engine.page.evaluate(pageFindAgentToggle, AGENT_SELECTORS);
  if (!toggle.found) {
    log('toggle-missing', null, 'error');
    return { status: 'AGENT_FAILED', reason: 'agent-ui-not-found: Flow\'s "Agent" toggle was not found in the prompt box — the Agent UI may have changed (selector calibration needed).' };
  }
  if (!toggle.on) {
    await engine.page.evaluate(pageClickAgentToggle, AGENT_SELECTORS);
    await sleep(1200);
    toggle = await engine.page.evaluate(pageFindAgentToggle, AGENT_SELECTORS);
    if (!toggle.on) {
      return { status: 'AGENT_FAILED', reason: 'agent-ui-not-found: Flow\'s "Agent" toggle was clicked but did not turn on (selector calibration needed).' };
    }
  }
  log('toggle-on');

  // The run's own expected cost, from its chosen model/duration/
  // quality via the engine's existing rate helper. When the
  // helper cannot price the run, fall back to the Agent's flat
  // quote for the run's mapped model; when neither can, the
  // expected cost stays unknown and no proposal may approve.
  let runExpected = null;
  try {
    if (typeof engine.getRequiredCredits === 'function') {
      const v = Number(engine.getRequiredCredits(settings));
      if (Number.isFinite(v) && v > 0) runExpected = v;
    }
  } catch (e) {}
  if (runExpected === null) runExpected = agentRules.agentExpectedCost(settings);
  const runModelLabel = (agentRules.mapAgentModel(settings.model || 'Omni Flash') || {}).flowLabel || null;

  // v2.48.103 (BULK MODE): agentClips — how many clips THIS
  // one conversation makes for the task (the explicit task arg
  // first, then the run settings; the pool passes it on a
  // per-task settings clone). 1/absent = the single-clip
  // behaviour this driver has always had. The conversation's
  // proposals are guarded at the expected TOTAL (clips × the
  // per-clip expected cost below); the per-clip number stays
  // the guard for a repair proposal (Part 4), and for the
  // single-clip path the two numbers are the same value.
  const agentClips = agentRules.normalizeAgentClips(
    a.agentClips !== undefined ? a.agentClips : settings.agentClips);
  const convoExpected = agentClips > 1
    ? (agentRules.expectedTotalCost(runExpected, agentClips) ?? runExpected)
    : runExpected;

  // v2.48.102 (Fix E): the instruction this run sends — the
  // user's text PLUS the pinned-parameter suffix (model,
  // resolution, duration, aspect, exactly 1 video), composed
  // ONCE here and used for the initial send and every re-send,
  // so the Agent's own duration/resolution choices can no
  // longer drift the quote away from the run's settings
  // (AGENTTEST10: right model, wrong duration -> 15 vs 7).
  // The task's own promptText (tile fingerprints, the card)
  // stays the user's raw text — the pins are chat-only.
  // v2.48.103: a bulk task's suffix asks for exactly N videos.
  const instructionText = pinnedAgentInstruction(promptText, settings, agentClips) || promptText;
  if (agentClips > 1) log('bulk-plan', { clips: agentClips, perClip: runExpected, total: convoExpected });

  // 2. v2.48.104 — SETTINGS FIRST + INSTRUCTIONS (the owner's
  // final-version order): BEFORE anything is sent, align the
  // project's Agent settings to this run (Confirm = Always,
  // the run's video model + aspect, outputs x1 — Save, then a
  // read-back verify, one retry), then make sure the project
  // carries the standing "FlowStudio Run Rules" instruction
  // (added once, then left alone; the IMAGE defaults are
  // never touched). Both phases are best-effort BY DESIGN:
  // any failure is logged with its evidence and the run
  // CONTINUES — the pinned instruction below and the quote
  // guard remain the safety net (the owner's own recording
  // proved settings alone do not bind the Agent's proposal).
  // The outcome lands in the Agent Doctor (lastSettingsFirst)
  // so it can be checked from chat after the run.
  const settingsFirstRes = await runSettingsFirst(engine, settings, log, a);
  const instructionsRes = await ensureAgentInstructions(engine, log, a);
  const sfReadBack = (settingsFirstRes && settingsFirstRes.readBack) || { confirm: null, model: null, aspect: null, outputs: null };
  const sfEntry = {
    at: new Date().toISOString(),
    model: sfReadBack.model,
    aspect: sfReadBack.aspect,
    outputs: sfReadBack.outputs,
    confirm: sfReadBack.confirm,
    readBackOk: !!(settingsFirstRes && settingsFirstRes.aligned),
    instruction: instructionsRes && instructionsRes.status ? instructionsRes.status : 'failed'
  };
  try { agentDoctor.recordSettingsFirst(sfEntry); } catch (e) {}
  log('settings-first-record', sfEntry);

  // 3. Send the pinned instruction as ONE chat message.
  const sendChat = async (text) => {
    const clean = String(text || '').replace(/[\r\n]+/g, ' ').trim();
    if (!clean) return false;
    let focusedPanel = false;
    try { focusedPanel = await engine.page.evaluate(pageFocusAgentInput, AGENT_SELECTORS); } catch (e) {}
    if (focusedPanel) {
      try {
        if (!engine.cdpSession) engine.cdpSession = await engine.page.target().createCDPSession();
        await engine.cdpSession.send('Input.insertText', { text: clean });
      } catch (e) {
        try { await engine.page.keyboard.type(clean, { delay: 5 }); } catch (e2) {}
      }
    } else {
      // Agent ON turns Flow's prompt box into the chat input —
      // the engine's proven prompt-box writer is the right tool.
      await engine.insertNativeText(clean);
    }
    await sleep(400);
    let sent = false;
    try { sent = await engine.page.evaluate(pageClickAgentSend, AGENT_SELECTORS); } catch (e) {}
    if (!sent) {
      try { await engine.page.keyboard.press('Enter'); sent = true; } catch (e) {}
    }
    return sent;
  };

  const sentFirst = await sendChat(instructionText);
  if (!sentFirst) {
    return { status: 'AGENT_FAILED', reason: 'agent-ui-not-found: the chat message could not be sent to Flow\'s Agent (selector calibration needed).' };
  }
  log('sent', { chars: instructionText.length });

  // v2.48.98: anchor the panel read FROM THE COMPOSER and log
  // the anchor once per run — every field log from now on
  // self-proves which container the driver is reading. The
  // panel-not-found guard's clock starts at the send.
  // Pack 3 (item 6): the anchor missed at send time in EVERY
  // live run so far and succeeded seconds later — the panel is
  // still rendering when the instruction lands — so the anchor
  // is retried for up to ~10s before the run falls back to
  // group-only proposal detection. The logged line reports the
  // FINAL outcome, exactly as before.
  let anchorInfo = null;
  const anchorRetryMs = a.anchorRetryMs !== undefined ? a.anchorRetryMs : ANCHOR_RETRY_MS;
  const anchorDeadline = Date.now() + Math.max(0, anchorRetryMs);
  for (;;) {
    try { anchorInfo = await engine.page.evaluate(pageAnchorAgentPanel, AGENT_SELECTORS); } catch (e) { anchorInfo = null; }
    if (anchorInfo && anchorInfo.found) break;
    if (Date.now() >= anchorDeadline) break;
    await sleep(a.anchorRetryPollMs || ANCHOR_RETRY_POLL_MS);
  }
  log('anchor', anchorInfo || { found: false });
  let sentAt = Date.now();
  const panelGuardMs = a.panelGuardMs || PANEL_GUARD_MS;
  let panelGuardFired = false;

  // 4. The conversation loop — whole-text polling. The ONLY texts
  // ever sent are the pinned instruction and, at most once per
  // retry lever, its re-send after a settings fix. Any other Agent text (a
  // question, a status note) is logged and waited through: the
  // driver never improvises a reply.
  const proposalWaitMs = a.proposalWaitMs || PROPOSAL_WAIT_MS;
  let lastPanelText = '';
  let lastProgressAt = Date.now();
  let roundStart = Date.now();
  let lastWaitNote = Date.now();
  let panelChanges = 0;
  // v2.48.100 (Fix A): proposals are handled per TEXT
  // SIGNATURE, one-shot per continuous appearance of an
  // answerable group (shouldActOnProposal). liveGroupGapSeen
  // starts true — nothing has been handled yet, and the first
  // sighting of any signature acts on the never-handled rule
  // anyway.
  const handledSignatures = new Set();
  let liveGroupGapSeen = true;
  let retried = false;
  let approved = false;
  let generationStarted = false;

  // ANY failure from here on logs the full last-seen panel text
  // with the failure reason first — no run fails blind. When the
  // proposal group's own ancestor text carries the proposal it
  // is the better evidence (it is what the decision read).
  // Pack 3: namedRetryUsed marks that the named-model fallback
  // re-send (item 5; any alignment failure since v2.48.101) is
  // the retry this run spent — its park carries its own reason
  // (item 9); runDetail carries the settings evidence (survey /
  // mismatch field) into the Doctor's last-run record via the
  // terminal results below.
  let lastGroupText = '';
  let namedRetryUsed = false;
  // v2.48.104: the fixed settings-based answer fires at most
  // ONCE per run (see the conversation loop below).
  let settingsAnswerUsed = false;
  let runDetail = null;
  const failRun = (reason) => {
    const evidence = (lastGroupText && hasProposalText(lastGroupText)) ? lastGroupText : lastPanelText;
    if (evidence) log('panel-dump', { reason, text: evidence }, 'error');
    const out = { status: 'AGENT_FAILED', reason };
    if (runDetail) out.detail = runDetail;
    return out;
  };

  while (!approved && !generationStarted) {
    if (engine.isStopping) return { status: 'STOPPED' };
    if (Date.now() - lastProgressAt > proposalWaitMs) {
      return failRun('agent-proposal-timeout: Flow\'s Agent did not reach a generation proposal in time. No credits were approved.');
    }
    let text = lastPanelText;
    try {
      const read = await engine.page.evaluate(pageReadAgentPanelText, AGENT_SELECTORS);
      if (typeof read === 'string') {
        text = read;
      } else {
        // No live anchor (never set, or the node detached) —
        // re-anchor once from the composer and take the
        // anchor's own text. A late-rendering panel is picked
        // up here on a later poll.
        const re = await engine.page.evaluate(pageAnchorAgentPanel, AGENT_SELECTORS);
        if (re && re.found && typeof re.text === 'string') text = re.text;
      }
    } catch (e) {}
    if (text !== lastPanelText) {
      lastPanelText = text;
      lastProgressAt = Date.now();
      roundStart = Date.now();
      panelChanges++;
      if (panelChanges > (a.maxPanelChanges || MAX_PANEL_CHANGES)) {
        return failRun('agent-chat-too-long: the conversation with Flow\'s Agent kept changing without reaching a generation.');
      }
      if (text && looksLikePolicyRefusal(text)) {
        return { status: 'VIOLATION', reason: 'Flow\'s Agent refused this request (content policy).' };
      }
      if (text && !hasProposalText(text) && !looksLikeGenerationStarted(text) && !isPanelTextImplausible(text)) {
        // A question or any other new Agent text — logged; the
        // wait for a proposal continues. (The implausibility
        // guard is hard: the canvas placeholder is never
        // reported as an agent message.)
        log('message', { text });
        // v2.48.104: the ONE exception to never-improvise —
        // when the Agent asks the user to CHOOSE a generation
        // parameter (resolution / quality / model / aspect)
        // BEFORE proposing, answer ONCE per run with the
        // fixed settings-based answer: the saved project
        // settings ARE the run's choice (settings-first set
        // them moments ago). Every other question is waited
        // through exactly as before.
        if (!settingsAnswerUsed && agentRules.looksLikeSettingsQuestion(text)) {
          const answer = agentRules.settingsAnswerText(settings);
          if (answer) {
            settingsAnswerUsed = true;
            log('settings-answer', { text: answer });
            const sentAnswer = await sendChat(answer);
            if (sentAnswer) {
              lastProgressAt = Date.now();
              roundStart = Date.now();
            }
          }
        }
      }
    }

    // A LIVE proposal = the costing sentence in the text AND an
    // enabled Permission options radio group on the page. Both,
    // always. Handled once per continuous appearance of the
    // group (a click disables the group; a fresh proposal
    // re-enables it and is handled again).
    // v2.48.98: the group is polled document-wide on EVERY pass
    // (it is the decision UI), and its own ancestor text is a
    // proposal source independent of the panel anchor.
    let perm = null;
    try { perm = await engine.page.evaluate(pagePermissionState, AGENT_SELECTORS); } catch (e) { perm = null; }
    if (perm && typeof perm.groupText === 'string' && perm.groupText) lastGroupText = perm.groupText;
    const proposalText = hasProposalText(lastGroupText) ? lastGroupText : lastPanelText;

    // v2.48.98 panel-not-found guard — never wait blind again:
    // if the anchored text is implausible (near-empty, or
    // nothing but the canvas placeholder) AND no permission
    // group has appeared within the guard window, log a DOM
    // survey and fail fast with 'agent-panel-not-found'
    // instead of burning the whole proposal wait.
    if (!panelGuardFired && !(perm && perm.present) && Date.now() - sentAt > panelGuardMs && isPanelTextImplausible(lastPanelText)) {
      panelGuardFired = true;
      let survey = [];
      try { survey = await engine.page.evaluate(pageSurveyAgentDom, AGENT_SELECTORS); } catch (e) { survey = []; }
      if (Array.isArray(survey) && survey.length) log('survey', { entries: survey }, 'warn');
      log('panel-not-found', { chars: String(lastPanelText || '').length }, 'error');
      return failRun('agent-panel-not-found: after sending, the text at the anchored panel stayed implausible (near-empty, or only the canvas placeholder) and no Permission options group appeared — the Agent session panel was not located. Nothing was approved and no credits were spent. The DOM survey above shows what the page actually offered.');
    }

    // v2.48.100 (Fix A): the LIVE proposal is the LAST costing
    // sentence in the text (agentRules.latestProposal) — the
    // panel accumulates the settled proposals ABOVE the fresh
    // one, and the first-match parsers kept reading the stale
    // sentence in AGENTTEST8. The group side is fixed too:
    // pagePermissionState reports the last ENABLED group, so
    // `perm` here is the fresh proposal's group, not the
    // settled one lingering above it. A poll with no answerable
    // group ends the current appearance (the gap rule in
    // shouldActOnProposal).
    const liveGroup = !!(perm && perm.present && perm.enabled);
    if (!liveGroup) liveGroupGapSeen = true;
    let latest = agentRules.latestProposal(proposalText);
    let latestSource = latest ? (hasProposalText(lastGroupText) ? 'proposal text' : 'panel text') : null;
    if (!latest && lastPanelText && lastPanelText !== proposalText) {
      latest = agentRules.latestProposal(lastPanelText);
      if (latest) latestSource = 'panel text';
    }
    // v2.48.99's model-source rule, kept: when the proposal
    // block names no model, the ANCHORED PANEL text may carry
    // the model sentence for the SAME quote — adopt it (and
    // its signature, so identity stays stable if the group
    // text later widens to include the sentence itself).
    let effectiveSignature = latest ? latest.signature : null;
    if (latest && !latest.model && lastPanelText && lastPanelText !== proposalText) {
      const fromPanel = agentRules.latestProposal(lastPanelText);
      if (fromPanel && fromPanel.quoted === latest.quoted && fromPanel.model) {
        latest = { quoted: latest.quoted, model: fromPanel.model, sentence: latest.sentence, signature: fromPanel.signature };
        latestSource = 'panel text';
        effectiveSignature = fromPanel.signature;
      }
    }
    let actedOnProposal = false;
    if (liveGroup && latest && shouldActOnProposal(effectiveSignature, handledSignatures, liveGroupGapSeen)) {
      actedOnProposal = true;
      handledSignatures.add(effectiveSignature);
      liveGroupGapSeen = false;
      {
        const quoted = latest.quoted;
        const proposalModel = latest.model;
        const modelSource = latestSource;
        let decision = agentRules.decideOnProposal({
          quotedCost: quoted,
          proposalModel,
          runModelLabel,
          // v2.48.103: the conversation is guarded at the
          // expected TOTAL for a bulk task (== runExpected for
          // a single-clip task, so its text/behaviour is the
          // same as before bulk mode).
          runExpectedCost: convoExpected,
          retried
        });
        // v2.48.103 (BULK MODE): a bulk approval needs BOTH the
        // total AND the model. decideOnProposal's single-clip
        // rule lets a wrong-model quote through after the one
        // settings retry; a bulk task may not — a combined quote
        // from the wrong model is rejected and routed through
        // the same settings-align → re-send flow as an
        // over-cost quote, and parks if it comes back wrong a
        // second time.
        if (agentClips > 1 && decision.act === 'approve' && proposalModel && runModelLabel && proposalModel !== runModelLabel) {
          decision = { act: retried ? 'park' : 'retry-settings', reason: 'agent-model-mismatch-bulk', bulkModelGate: true };
        }
        log('proposal', { model: proposalModel, modelSource, quoted, expected: convoExpected, act: decision.act });
        if (typeof noteProposal === 'function') {
          try { noteProposal({ quoted, model: proposalModel, act: decision.act }); } catch (e) {}
        }

        if (decision.act === 'approve') {
          const clicked = await engine.page.evaluate(pageClickPermissionOption, AGENT_SELECTORS, PERMISSION_LABELS.approve);
          if (!clicked) {
            log('option-missing', { label: PERMISSION_LABELS.approve }, 'error');
            return failRun('agent-ui-not-found: the proposal\'s "Approve" radio option was not found (selector calibration needed). Nothing was approved.');
          }
          log('option-clicked', { label: PERMISSION_LABELS.approve });
          const settled = await waitForProposalSettle(engine, a);
          if (!settled) {
            log('settle-timeout', null, 'error');
            return failRun('agent-settle-timeout: the proposal did not settle within 60s of the Approve click.');
          }
          log('settled');
          log('approved', { quoted }, 'success');
          approved = true;
          break;
        }

        // Every other outcome clicks REJECT first — a pending
        // proposal locks the panel, so nothing (park, retry,
        // fail) may leave the page unsettled. Reject is free.
        const clickedReject = await engine.page.evaluate(pageClickPermissionOption, AGENT_SELECTORS, PERMISSION_LABELS.reject);
        if (clickedReject) {
          log('option-clicked', { label: PERMISSION_LABELS.reject });
          const settled = await waitForProposalSettle(engine, a);
          if (!settled) {
            log('settle-timeout', null, 'error');
            return failRun('agent-settle-timeout: the proposal did not settle within 60s of the Reject click.');
          }
          log('settled');
        } else {
          log('option-missing', { label: PERMISSION_LABELS.reject }, 'warn');
        }

        if (decision.act === 'retry-settings') {
          // The panel is open and the box is unlocked now — the
          // one chance to align the Agent settings to the run's
          // model, then re-send the instruction ONCE. The
          // unnamed-model over-cost case (v2.48.99) logs its own
          // line: there is no read model to call pricier.
          if (decision.reason === 'agent-model-unnamed-over-cost') {
            log('retry-unnamed', { quoted, expected: convoExpected }, 'warn');
          } else {
            log('retry', { model: runModelLabel }, 'warn');
          }
          const alignRes = await alignAgentSettings(engine, settings, log, a);
          if (alignRes && alignRes.detail) runDetail = alignRes.detail;
          if (alignRes && alignRes.aligned) {
            retried = true;
            const resent = await sendChat(instructionText);
            if (!resent) {
              return failRun('agent-ui-not-found: the instruction could not be re-sent after the Agent settings were aligned.');
            }
            log('sent', { chars: instructionText.length, retry: true });
            // Pack 3 (item 10): a re-send restarts the wait —
            // the panel-not-found guard and the proposal window
            // reset, so the second proposal gets a full fresh
            // wait of its own.
            lastProgressAt = Date.now();
            roundStart = Date.now();
            sentAt = Date.now();
            panelGuardFired = false;
            // The answer to the re-sent instruction is a NEW
            // proposal appearance: the Reject settled the old
            // group (the settle wait above saw it disable), so
            // the appearance is ended by proof, not just by a
            // later poll — even an IDENTICAL signature may be
            // decided again (v2.48.100).
            liveGroupGapSeen = true;
            continue;
          }
          if (!namedRetryUsed) {
            // Pack 3 (item 5) introduced this fallback for the
            // surface-never-found case. v2.48.101 (Fix C): it
            // now follows ANY alignment failure — surface not
            // found, a field mismatch, unreadable fields, a
            // Save failure, an error. AGENTTEST9's surface WAS
            // found (via the tune icon) and operated, yet every
            // verify read came back 'unreadable' and the run
            // parked one step from this proven lever. The one
            // lever left is the instruction text itself: re-send
            // ONCE with the run's model named in the text, so
            // the Agent picks the run's model itself. The new
            // proposal goes through the SAME quote rules (and
            // `retried` is set, so it can never ask twice).
            const namedText = namedRetryInstruction(promptText, settings, agentClips);
            if (namedText) {
              namedRetryUsed = true;
              retried = true;
              log('retry-named', { model: runModelLabel, why: alignRes && alignRes.outcome ? `settings outcome: ${alignRes.outcome}` : undefined }, 'warn');
              const resent = await sendChat(namedText);
              if (!resent) {
                return failRun('agent-ui-not-found: the instruction could not be re-sent with the run\'s model named in the text.');
              }
              log('sent', { chars: namedText.length, retry: true });
              lastProgressAt = Date.now();
              roundStart = Date.now();
              sentAt = Date.now();
              panelGuardFired = false;
              // Settled by the Reject above — a new appearance
              // may follow, even with an identical signature.
              liveGroupGapSeen = true;
              continue;
            }
          }
          // No fallback could be made (the run's model has no
          // Agent mapping to name in the text) — the
          // 'agent-settings-unaligned' line is already logged
          // with the outcome; park WITHOUT a re-send.
          log('parked', null, 'warn');
          const mismatchPark = { status: 'AGENT_PARKED', reason: `agent-over-cost: Flow's Agent proposed ${quoted} credits (model ${proposalModel || 'unknown'}), above this run's expected cost of ${convoExpected} credits, and the Agent settings could not be aligned to the run's model — the proposal was rejected (free) and nothing was approved, so no credits were spent.` };
          if (runDetail) mismatchPark.detail = runDetail;
          return mismatchPark;
        }
        if (decision.act === 'park') {
          log('parked', null, 'warn');
          if (decision.bulkModelGate) {
            return { status: 'AGENT_PARKED', reason: `agent-model-mismatch: Flow's Agent proposed ${quoted} credits with model ${proposalModel || 'unknown'}, not this run's model (${runModelLabel || 'unknown'}) — a bulk task approves only its own model's combined quote (total ${convoExpected} credits for ${agentClips} clips). The proposal was rejected (free) and nothing was approved, so no credits were spent.` };
          }
          if (namedRetryUsed) {
            // Pack 3 (item 9): the named-model fallback's own
            // park — distinct from every other over-cost park,
            // so the log/Doctor can tell the fallback ran and
            // STILL priced over.
            const namedPark = { status: 'AGENT_PARKED', reason: `agent-over-cost-named-retry: Flow's Agent proposed ${quoted} credits (model ${proposalModel || 'unknown'}), above this run's expected cost of ${convoExpected} credits, even after the instruction was re-sent once with the run's model (${runModelLabel || 'unknown'}) named in the text — the Agent settings could not be aligned to the run's model, so no settings fix was possible. The proposal was rejected (free) and nothing was approved, so no credits were spent.` };
            if (runDetail) namedPark.detail = runDetail;
            return namedPark;
          }
          return { status: 'AGENT_PARKED', reason: `agent-over-cost: Flow's Agent proposed ${quoted} credits (model ${proposalModel || 'unknown'}), above this run's expected cost of ${convoExpected} credits — the proposal was rejected (free) and nothing was approved, so no credits were spent. Run this prompt in Flow yourself, or adjust the run's model/settings and run again.` };
        }
        // decision.act === 'fail' — the quote or the expected
        // cost could not be verified; the page is settled.
        return failRun(decision.reason || 'agent-failed');
      }
    }
    if (!actedOnProposal && lastPanelText && looksLikeGenerationStarted(lastPanelText)) {
      // The Agent is already generating (its Confirm setting
      // was off). No proposal will come and no completion
      // message ever follows — the media is the only signal.
      log('generation-started', null, 'warn');
      generationStarted = true;
      break;
    }

    if (Date.now() - lastWaitNote >= (a.heartbeatMs || 30000)) {
      lastWaitNote = Date.now();
      if (!perm) {
        try { perm = await engine.page.evaluate(pagePermissionState, AGENT_SELECTORS); } catch (e) { perm = null; }
      }
      // v2.48.100: a group on screen that the driver declines
      // to act on must SAY WHY in the heartbeat — AGENTTEST8
      // waited 163s behind bare 'proposalGroup=present' lines
      // while the real state (the only group being read was
      // the settled one) stayed invisible.
      let waitWhy = null;
      if (perm && perm.present && !perm.enabled) {
        waitWhy = 'group present but settled/disabled — no answerable proposal yet';
      } else if (perm && perm.present && perm.enabled && !latest) {
        waitWhy = 'group present, no costing sentence yet';
      } else if (perm && perm.present && perm.enabled && latest && !actedOnProposal) {
        waitWhy = `group present, signature already handled: ${latest.quoted}/${latest.model || 'model not named'}`;
      }
      log('waiting', {
        elapsedSec: Math.round((Date.now() - roundStart) / 1000),
        tail: lastPanelText,
        group: (perm && perm.present) ? 'present' : 'absent',
        why: waitWhy
      });
    }
    await sleep(a.chatPollMs || CHAT_POLL_MS);
  }

  // 5. Media detection: a NEW grid tile fingerprint (not
  // pre-existing, not claimed by a sibling task) or a NEW item in
  // the panel's Media options gallery is this run's media. No
  // completion message is ever posted — the media itself is the
  // only signal. Bind it at birth, exactly like submitPrompt
  // does, then hand off — the monitor + download pipeline take
  // it from here.
  // v2.48.103: single-clip tasks run this phase exactly as
  // before; agentClips > 1 takes the bulk phase below it.
  if (agentClips <= 1) {
  const mediaDeadline = Date.now() + (a.mediaTimeoutMs || MEDIA_TIMEOUT_MS);
  let lockedTileFingerprint = null;
  while (!lockedTileFingerprint && Date.now() < mediaDeadline) {
    if (engine.isStopping) return { status: 'STOPPED' };
    let fps = [];
    try { fps = await engine.page.evaluate(pageGridFingerprints); } catch (e) { fps = []; }
    for (const fp of fps) {
      if (preExistingFingerprints.has(fp)) continue;
      if (engine.claimedTileFingerprints && engine.claimedTileFingerprints.has(fp)) continue;
      lockedTileFingerprint = fp;
      break;
    }
    if (!lockedTileFingerprint) {
      let gallery = [];
      try { gallery = await engine.page.evaluate(pageGalleryLabels, AGENT_SELECTORS); } catch (e) { gallery = []; }
      const freshGallery = gallery.filter(l => !preExistingGallery.has(l));
      if (freshGallery.length) {
        // The media exists. Prefer a grid fingerprint (the
        // pipeline binds tiles); the gallery label itself is the
        // same normalised prompt text, so it serves as the birth
        // fingerprint when the grid has not caught up yet.
        lockedTileFingerprint = freshGallery[0];
      }
    }
    if (!lockedTileFingerprint) await sleep(a.mediaPollMs || MEDIA_POLL_MS);
  }
  if (!lockedTileFingerprint) {
    return failRun('agent-media-missing: the Agent reported generation, but no new tile appeared in the project. The media may still be in Flow — check the project before re-running (do NOT resubmit blindly).');
  }
  if (engine.claimedTileFingerprints) engine.claimedTileFingerprints.add(lockedTileFingerprint);
  log('media', null, 'success');

  const task = buildAgentTask({
    videoId,
    projectUrl: engine.currentProjectUrl(),
    promptText,
    promptIndex,
    startTime: Date.now(),
    preExistingTileCount,
    preExistingAriaLabels,
    preExistingFingerprints: [...preExistingFingerprints],
    preExistingVideoUrls,
    lockedTileFingerprint
  });
  try {
    if (engine.currentDownloadDir) {
      engine.registerBackendTask(task, engine.currentDownloadDir, engine.currentSettings);
    }
  } catch (e) {}
  try { engine._startApiPoll(task); } catch (e) {}
  log('handoff');
  // Pack 3: when the run reached the handoff THROUGH the
  // settings evidence (a survey / mismatch on the retry path),
  // the evidence rides the result so the Doctor's last-run
  // record explains how the run got here.
  if (runDetail) task.detail = runDetail;
  return task;
  }

  // =====================================================================
  // v2.48.103 BULK media phase (agentClips > 1) — Parts 3 + 4.
  // The conversation was approved for N clips at once; the grid
  // fills with this conversation's tiles (together at 0%, then
  // finishing at slightly different times). Wait until N NEW
  // tiles exist, hand ALL of them to the download pipeline as
  // sibling tasks (the pool names the saves <TAG>-S1..SN by
  // scene slot), and if fewer than N materialise, hand off
  // what exists with the shortfall named — never hang forever,
  // never re-send the whole instruction. A tile that arrives
  // FAILED earns ONE in-conversation repair message (per failed
  // scene, one round per task), guarded at the PER-CLIP cost.
  // =====================================================================
  const readGridTiles = async () => {
    try {
      const detailed = await engine.page.evaluate(pageGridTilesDetailed);
      if (Array.isArray(detailed)) return detailed;
    } catch (e) {}
    let fps = [];
    try { fps = await engine.page.evaluate(pageGridFingerprints); } catch (e) { fps = []; }
    return (fps || []).map(fp => ({ fp, title: '', failed: false }));
  };
  // Scene slots in first-seen (grid-appearance) order. A slot's
  // position IS its scene number, stable across the repair
  // round: a repaired tile fills its failed scene's slot.
  const slots = [];
  const slotByFp = new Map();
  let pendingRepairSlot = null;
  const noteTiles = (tiles) => {
    for (const t of (tiles || [])) {
      if (!t || !t.fp) continue;
      if (preExistingFingerprints.has(t.fp)) continue;
      const existing = slotByFp.get(t.fp);
      if (!existing && engine.claimedTileFingerprints && engine.claimedTileFingerprints.has(t.fp)) continue;
      if (existing) {
        if (t.title && !existing.title) existing.title = t.title;
        if (t.failed && existing.state === 'ready') { existing.failed = true; existing.state = 'failed'; }
        continue;
      }
      if (pendingRepairSlot && !pendingRepairSlot.repairedFp && !t.failed) {
        // The first NEW healthy tile during a repair wait IS
        // the remake — it takes the failed scene's slot.
        pendingRepairSlot.repairedFp = t.fp;
        pendingRepairSlot.repairedTitle = t.title || '';
        slotByFp.set(t.fp, pendingRepairSlot);
        if (engine.claimedTileFingerprints) engine.claimedTileFingerprints.add(t.fp);
        continue;
      }
      const slot = { fp: t.fp, title: t.title || '', failed: !!t.failed, state: t.failed ? 'failed' : 'ready', repairedFp: null, repairedTitle: '' };
      slotByFp.set(t.fp, slot);
      slots.push(slot);
      if (slot.state === 'ready' && engine.claimedTileFingerprints) engine.claimedTileFingerprints.add(t.fp);
    }
  };
  const deliveredSlots = () => slots.filter(s => s.state === 'ready' || !!s.repairedFp);
  const deliveredCount = () => deliveredSlots().length;

  const bulkDeadline = Date.now() + (a.mediaTimeoutMs || MEDIA_TIMEOUT_MS);
  let lastClipsNote = 0;
  while (deliveredCount() < agentClips && Date.now() < bulkDeadline) {
    if (engine.isStopping) return { status: 'STOPPED' };
    noteTiles(await readGridTiles());
    if (deliveredCount() >= agentClips) break;
    if (Date.now() - lastClipsNote >= (a.heartbeatMs || 30000)) {
      lastClipsNote = Date.now();
      log('clips-progress', { have: deliveredCount(), want: agentClips });
    }
    if (Date.now() < bulkDeadline) await sleep(a.mediaPollMs || MEDIA_POLL_MS);
  }

  // ---- Part 4: ONE repair round, in this conversation ----
  let repairsAttempted = 0;
  const repairNotes = [];
  if (deliveredCount() < agentClips) {
    const failedSlots = slots.filter(s => s.state === 'failed' && !s.repairedFp);
    for (const slot of failedSlots) {
      if (deliveredCount() >= agentClips) break;
      if (engine.isStopping) return { status: 'STOPPED' };
      repairsAttempted++;
      log('repair-send', { desc: slot.title || '' });
      slot.state = 'repairing';
      const sentRepair = await sendChat(repairMessageFor(slot.title, settings));
      if (!sentRepair) {
        slot.state = 'failed';
        repairNotes.push('the repair message could not be sent');
        break;
      }
      // The repair proposal is a fresh appearance in the SAME
      // conversation, guarded at the PER-CLIP expected cost
      // with the model-match rule (decideOnProposal with
      // retried: true — a repair never unlocks a settings
      // cascade; over-cost simply ends the round).
      let repairApproved = false;
      let repairAnswered = false;
      let repairGapSeen = true;
      const repairDeadline = Date.now() + proposalWaitMs;
      while (Date.now() < repairDeadline && !repairAnswered) {
        if (engine.isStopping) return { status: 'STOPPED' };
        let perm = null;
        try { perm = await engine.page.evaluate(pagePermissionState, AGENT_SELECTORS); } catch (e) { perm = null; }
        if (perm && typeof perm.groupText === 'string' && perm.groupText) lastGroupText = perm.groupText;
        try {
          const read = await engine.page.evaluate(pageReadAgentPanelText, AGENT_SELECTORS);
          if (typeof read === 'string' && read) lastPanelText = read;
        } catch (e) {}
        const liveGroup = !!(perm && perm.present && perm.enabled);
        if (!liveGroup) repairGapSeen = true;
        const srcText = hasProposalText(lastGroupText) ? lastGroupText : lastPanelText;
        let prop = agentRules.latestProposal(srcText);
        if (!prop && lastPanelText && lastPanelText !== srcText) prop = agentRules.latestProposal(lastPanelText);
        if (liveGroup && prop && shouldActOnProposal(prop.signature, handledSignatures, repairGapSeen)) {
          handledSignatures.add(prop.signature);
          repairGapSeen = false;
          repairAnswered = true;
          const decision = agentRules.decideOnProposal({
            quotedCost: prop.quoted,
            proposalModel: prop.model,
            runModelLabel,
            runExpectedCost: runExpected,
            retried: true
          });
          log('proposal', { model: prop.model, modelSource: 'repair', quoted: prop.quoted, expected: runExpected, act: decision.act });
          if (typeof noteProposal === 'function') {
            try { noteProposal({ quoted: prop.quoted, model: prop.model, act: decision.act }); } catch (e) {}
          }
          if (decision.act === 'approve') {
            const clicked = await engine.page.evaluate(pageClickPermissionOption, AGENT_SELECTORS, PERMISSION_LABELS.approve);
            if (!clicked) {
              log('option-missing', { label: PERMISSION_LABELS.approve }, 'error');
              repairNotes.push('the repair proposal\'s Approve option was not found');
            } else {
              log('option-clicked', { label: PERMISSION_LABELS.approve });
              const settled = await waitForProposalSettle(engine, a);
              if (!settled) log('settle-timeout', null, 'error'); else log('settled');
              log('approved', { quoted: prop.quoted }, 'success');
              repairApproved = true;
            }
          } else {
            const clickedReject = await engine.page.evaluate(pageClickPermissionOption, AGENT_SELECTORS, PERMISSION_LABELS.reject);
            if (clickedReject) {
              log('option-clicked', { label: PERMISSION_LABELS.reject });
              const settled = await waitForProposalSettle(engine, a);
              if (!settled) log('settle-timeout', null, 'error'); else log('settled');
            } else {
              log('option-missing', { label: PERMISSION_LABELS.reject }, 'warn');
            }
            repairNotes.push(decision.act === 'fail'
              ? 'the repair proposal could not be verified (quote or expected cost unreadable) — not approved'
              : `the repair proposal quoted ${prop.quoted} credits, above the per-clip expected ${runExpected} — not approved`);
          }
        }
        if (!repairAnswered) await sleep(a.chatPollMs || CHAT_POLL_MS);
      }
      if (!repairAnswered) repairNotes.push('no repair proposal arrived in time');
      if (repairApproved) {
        pendingRepairSlot = slot;
        const tileDeadline = Date.now() + (a.mediaTimeoutMs || MEDIA_TIMEOUT_MS);
        while (Date.now() < tileDeadline && !slot.repairedFp) {
          if (engine.isStopping) return { status: 'STOPPED' };
          noteTiles(await readGridTiles());
          if (!slot.repairedFp && Date.now() < tileDeadline) await sleep(a.mediaPollMs || MEDIA_POLL_MS);
        }
        pendingRepairSlot = null;
        if (slot.repairedFp) {
          slot.state = 'repaired';
          log('clips-progress', { have: deliveredCount(), want: agentClips });
        } else {
          slot.state = 'failed';
          repairNotes.push('the approved repair produced no new tile in time');
        }
      } else {
        slot.state = 'failed';
        break; // an unanswered / unapproved repair ends the round
      }
    }
    if (!failedSlots.length) log('repair-none');
  }

  const delivered = deliveredSlots().slice(0, agentClips);
  if (!delivered.length) {
    return failRun(`agent-media-missing: the Agent reported generation, but no usable tile appeared in the project${repairsAttempted ? ` (a repair round was attempted: ${repairNotes.join('; ') || 'no repair tile arrived'})` : ''}. The media may still be in Flow — check the project before re-running (do NOT resubmit blindly).`);
  }
  log('media', null, 'success');
  const sceneTasks = delivered.map((slot, i) => {
    const sceneIndex = slots.indexOf(slot) + 1;
    const t = buildAgentTask({
      videoId: i === 0 ? videoId : `${videoId}_s${sceneIndex}`,
      projectUrl: engine.currentProjectUrl(),
      promptText,
      promptIndex,
      startTime: Date.now(),
      preExistingTileCount,
      preExistingAriaLabels,
      preExistingFingerprints: [...preExistingFingerprints],
      preExistingVideoUrls,
      lockedTileFingerprint: slot.repairedFp || slot.fp,
      agentSceneIndex: sceneIndex,
      agentSceneCount: agentClips,
      agentTileTitle: slot.repairedTitle || slot.title || ''
    });
    try {
      if (engine.currentDownloadDir) {
        engine.registerBackendTask(t, engine.currentDownloadDir, engine.currentSettings);
      }
    } catch (e) {}
    try { engine._startApiPoll(t); } catch (e) {}
    return t;
  });
  const primaryTask = sceneTasks[0];
  if (sceneTasks.length > 1) primaryTask.agentExtraTasks = sceneTasks.slice(1);
  primaryTask.agentTiles = sceneTasks.map(t => ({
    videoId: t.videoId,
    fingerprint: t.lockedTileFingerprint,
    title: t.agentTileTitle,
    sceneIndex: t.agentSceneIndex
  }));
  if (delivered.length < agentClips) {
    const failedCount = slots.filter(s => s.state === 'failed').length;
    const noteParts = [];
    if (failedCount) noteParts.push(`${failedCount} tile(s) failed`);
    if (repairsAttempted) noteParts.push(`repairs attempted: ${repairsAttempted}${repairNotes.length ? ` (${repairNotes.join('; ')})` : ''}`);
    const note = noteParts.join('; ');
    primaryTask.agentShortfall = `agent-clips-shortfall: only ${delivered.length} of ${agentClips} clips arrived from Flow's Agent${note ? ` — ${note}` : ''}. The delivered clips were handed to the download pipeline; the missing scenes were NOT resubmitted.`;
    log('shortfall', { have: delivered.length, want: agentClips, note }, 'warn');
    runDetail = [runDetail, primaryTask.agentShortfall].filter(Boolean).join(' | ');
  }
  log('handoff');
  if (runDetail) primaryTask.detail = runDetail;
  return primaryTask;
}

/**
 * The exported submit: runs the inner driver and records the
 * outcome into the Agent Doctor's last-run slot on EVERY exit —
 * the approve handoff (a SUBMITTED task), a park, a fail, a
 * policy violation, a stop, even an unexpected throw (recorded,
 * then re-thrown so the pool sees exactly what it saw before).
 * Recording itself can never break the run: agentDoctor's record
 * function swallows its own errors, and the status/reason are
 * read defensively off whatever the inner run returned.
 */
async function submitViaAgent(engine, args) {
  let lastProposal = null;
  const record = (result, thrown) => {
    let status = 'AGENT_FAILED';
    let reason = '';
    if (thrown) {
      reason = `the agent driver threw: ${thrown && thrown.message ? thrown.message : String(thrown)}`;
    } else if (result && typeof result.status === 'string' && result.status) {
      status = result.status;
      reason = result.reason ? String(result.reason) : '';
    } else if (result) {
      status = 'SUBMITTED';
    } else {
      reason = 'the agent driver returned no result';
    }
    agentDoctor.recordAgentRun({
      at: new Date().toISOString(),
      status,
      reason,
      lastProposal,
      detail: (result && typeof result.detail === 'string' && result.detail) ? result.detail : null
    });
  };
  try {
    const result = await submitViaAgentInner(engine, args, (p) => { lastProposal = p; });
    record(result, null);
    return result;
  } catch (e) {
    record(null, e);
    throw e;
  }
}

module.exports = {
  AGENT_SELECTORS,
  PERMISSION_LABELS,
  PROPOSAL_WAIT_MS,
  SETTLE_TIMEOUT_MS,
  MEDIA_TIMEOUT_MS,
  MAX_PANEL_CHANGES,
  PANEL_GUARD_MS,
  ANCHOR_RETRY_MS,
  SETTINGS_OPEN_WAIT_MS,
  SETTINGS_SURFACE_WAIT_MS,
  CANVAS_PLACEHOLDER_TEXT,
  looksLikePolicyRefusal,
  hasProposalText,
  isPanelTextImplausible,
  looksLikeGenerationStarted,
  desiredAgentSettings,
  agentParamPins,
  pinnedParamsSuffix,
  pinnedAgentInstruction,
  namedRetryInstruction,
  repairMessageFor,
  pageGridTilesDetailed,
  truncateForLog,
  agentLine,
  buildAgentTask,
  pageAgentSettingsSurface,
  pageReadAgentSettings,
  pageClickComposerSettingsIcon,
  pageClickComposerToolbarLastIcon,
  pageClickComposerTuneIcon,
  pageScrollAgentSettingsToVideo,
  pageScrollAgentSettingsToSection,
  pageSurveySettingsSurface,
  pagePermissionState,
  pageClickPermissionOption,
  shouldActOnProposal,
  pageSurveySettingsRegion,
  pageClickComposerInstructionsIcon,
  pageAgentInstructionsSurface,
  pageReadAgentInstructions,
  pageClickAddInstruction,
  pageFillAgentInstruction,
  pageClickInstructionsDone,
  pageSurveyInstructionsSurface,
  alignAgentSettings,
  runSettingsFirst,
  ensureAgentInstructions,
  submitViaAgent
};
