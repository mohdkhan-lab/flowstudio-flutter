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
//   2. turn Flow's Agent ON and send the user's whole text as ONE
//      chat message,
//   3. poll the Agent panel's WHOLE visible text (innerText) every
//      ~3s and work only from marker substrings in that text —
//      no per-message element hunting (.96 read per-message
//      elements and stayed blind while a proposal sat on screen):
//        PROPOSAL = the text matches /costing\s+(\d+)\s+credits?/i
//          AND an enabled Permission-options radio group is on the
//          page. The quoted cost + the model named in the proposal
//          feed the rule decision (agentRules.decideOnProposal):
//          approve only when quote <= the run's expected cost.
//        STARTED = the text contains "I've started generating" /
//          "I have started generating" -> media watch.
//        QUESTION / OTHER = any other new Agent text: NEVER
//          improvise a reply — the only texts this driver ever
//          sends are the user's instruction and its one re-send
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
// ⚠️ SELECTOR TABLE — the chat PANEL internals are still first-pass
// candidates (the radio-group + proposal-text SEMANTICS above are
// field-verified; the exact DOM hooks get proven on the owner's PC
// from his copied live logs — now self-evidencing, see above).
// Every Flow-Agent DOM guess lives in AGENT_SELECTORS below and
// NOWHERE else, so calibration stays a one-table edit. The Agent
// toggle row reuses the exact chip shape
// engine/flowAutomation.js's ensureAgentModeDisabled has proven
// against the live page since v2.48.x — that part is NOT a guess.
// ============================================================================

const agentRules = require('./agentRules');
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
  settingsSaveText: 'Save'
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
const STARTED_GENERATING_RE = /(i'?ve started generating|i have started generating|started generating|generation has started|now generating)/i;
function looksLikeGenerationStarted(text) {
  return STARTED_GENERATING_RE.test(String(text || ''));
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
    case 'proposal': return `[AGENT] generation proposal from Flow's Agent — model ${d.model || 'not named'}, quoted ${d.quoted} credits (this run's expected cost: ${d.expected} credits) → ${d.act || '?'}.`;
    case 'option-clicked': return `[AGENT] clicked "${d.label}" in the proposal's Permission options.`;
    case 'option-missing': return `[AGENT] the proposal option "${d.label}" was not found in the Permission options group — nothing was clicked.`;
    case 'settled': return '[AGENT] the proposal settled — the Agent panel is free again.';
    case 'settle-timeout': return '[AGENT] the proposal did not settle within 60s of the click.';
    case 'approved': return `[AGENT] proposal approved at ${d.quoted} credits — generation started by Flow's Agent.`;
    case 'rejected': return `[AGENT] proposal rejected (${d.reason || 'over cost'}) — rejecting costs nothing.`;
    case 'retry': return `[AGENT] the proposal's model is pricier than this run's model — aligning the Agent settings to the run's model (${d.model || '?'}) and asking once more.`;
    case 'parked': return '[AGENT] the proposal costs more than this run allows — the card is parked as needs-attention (nothing approved, no credits spent).';
    case 'generation-started': return '[AGENT] Flow\'s Agent started generating without a proposal (its Confirm setting was off) — waiting for the media itself.';
    case 'settings-aligned': return `[AGENT] Flow Agent settings aligned for this project and saved (Confirm before generating = Always${d.detail ? `; ${d.detail}` : ''}).`;
    case 'settings-unaligned': return `[AGENT] Flow Agent settings could not be aligned (${d.detail || 'the settings surface could not be operated'}) — agent-settings-unaligned.`;
    case 'settings-skip': return `[AGENT] Agent settings note: ${d.detail || ''}`;
    case 'media': return '[AGENT] media detected in the project — handing off to the download pipeline.';
    case 'handoff': return '[AGENT] handoff complete — the render monitor and download pipeline own this task now.';
    case 'waiting': return `[AGENT] still waiting for Flow's Agent… (${d.elapsedSec || 0}s) proposalGroup=${d.group || 'absent'} panel tail: "${agentRules.panelTail(d.tail || '')}"`;
    case 'panel-dump': return `[AGENT] failure (${d.reason || 'agent-failed'}) — last panel text (${String(d.text || '').length} chars): "${truncateForLog(d.text, 800)}"`;
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
    viaAgent: true
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

// v2.48.97: the panel reading is WHOLE-TEXT — the Agent panel
// container's full visible text (innerText), whitespace-collapsed.
// The driver works only from marker substrings in this text; there
// is deliberately no per-message element hunting any more.
function pageReadAgentPanelText(selectors) {
  let panel = null;
  for (const sel of selectors.panel) {
    try { panel = document.querySelector(sel); } catch (e) { panel = null; }
    if (panel) break;
  }
  if (!panel) return '';
  return String(panel.innerText || '').replace(/\s+/g, ' ').trim();
}

function pageFocusAgentInput(selectors) {
  let panel = null;
  for (const sel of selectors.panel) {
    try { panel = document.querySelector(sel); } catch (e) { panel = null; }
    if (panel) break;
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
  for (const sel of selectors.panel) {
    try { panel = document.querySelector(sel); } catch (e) { panel = null; }
    if (panel) break;
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

// The proposal's permission radio group — presence, whether it
// is still answerable, its option labels, and whether the panel
// prompt box is locked (its send button reads "Stop" while a
// proposal awaits an answer).
function pagePermissionState(selectors) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  let panel = null;
  for (const sel of selectors.panel) {
    try { panel = document.querySelector(sel); } catch (e) { panel = null; }
    if (panel) break;
  }
  const root = panel || document.body;
  let promptLocked = false;
  try {
    promptLocked = Array.from(root.querySelectorAll('button'))
      .some(b => norm(b.getAttribute('aria-label') || b.innerText || '').toLowerCase() === 'stop');
  } catch (e) {}
  let group = null;
  for (const sel of selectors.permissionGroup) {
    try { group = root.querySelector(sel); } catch (e) { group = null; }
    if (group) break;
  }
  if (!group) return { present: false, enabled: false, options: [], promptLocked };
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
  return { present: true, enabled: !groupDisabled && anyEnabled, options, promptLocked };
}

// Click ONE option of the permission radio group. The label
// match is EXACT after normalisation — 'Approve' can never land
// on 'Always approve in project'. Returns the wanted label when
// clicked, null when no option carries it.
function pageClickPermissionOption(selectors, wanted) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  let panel = null;
  for (const sel of selectors.panel) {
    try { panel = document.querySelector(sel); } catch (e) { panel = null; }
    if (panel) break;
  }
  const root = panel || document.body;
  let group = null;
  for (const sel of selectors.permissionGroup) {
    try { group = root.querySelector(sel); } catch (e) { group = null; }
    if (group) break;
  }
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
// panel prompt box.
function pageOpenAgentSettings(selectors) {
  let panel = null;
  for (const sel of selectors.panel) {
    try { panel = document.querySelector(sel); } catch (e) { panel = null; }
    if (panel) break;
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
  return false;
}

function pageAgentSettingsPresent(selectors) {
  for (const sel of selectors.settingsPanel) {
    try { if (document.querySelector(sel)) return true; } catch (e) {}
  }
  return false;
}

// Read the Agent settings surface — which Confirm radio is
// checked, the model dropdown's current label, the checked
// aspect and the checked outputs. Anything unreadable is null.
function pageReadAgentSettings(selectors, modelLabels) {
  let root = null;
  for (const sel of selectors.settingsPanel) {
    try { root = document.querySelector(sel); } catch (e) { root = null; }
    if (root) break;
  }
  if (!root) return { present: false, confirm: null, model: null, aspect: null, outputs: null };
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const checkedText = (texts) => {
    const els = Array.from(root.querySelectorAll('[role="radio"], [role="option"], label, button, input[type="radio"]'));
    for (const t of texts) {
      const el = els.find(e => norm(e.getAttribute('aria-label') || e.innerText || '') === t);
      if (!el) continue;
      const checked = el.getAttribute('aria-checked') === 'true' || el.checked === true ||
        (el.querySelector && !!el.querySelector('input[type="radio"]:checked')) ||
        /checked|selected|active/.test(String(el.className || ''));
      if (checked) return t;
    }
    return null;
  };
  const confirm = checkedText(['Always', 'Never']);
  let model = null;
  const allEls = Array.from(root.querySelectorAll('button, [role="listbox"], [aria-haspopup="listbox"], select, div, span'));
  for (const label of (modelLabels || [])) {
    if (allEls.some(e => norm(e.innerText || '') === label)) { model = label; break; }
  }
  const aspect = checkedText(['16:9', '9:16']);
  let outputs = checkedText(['x1', 'x2', 'x3', 'x4']);
  if (!outputs) {
    const bare = checkedText(['1', '2', '3', '4']);
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
  for (const sel of selectors.settingsPanel) {
    try { root = document.querySelector(sel); } catch (e) { root = null; }
    if (root) break;
  }
  const roots = root ? [root, document.body] : [document.body];
  for (const r of roots) {
    const els = Array.from(r.querySelectorAll('button, [role="radio"], [role="option"], [role="menuitem"], [aria-haspopup="listbox"], label, li, select'));
    const el = els.find(e => norm(e.getAttribute('aria-label') || e.innerText || '') === text);
    if (el) {
      el.click();
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
  for (const sel of selectors.settingsPanel) {
    try { root = document.querySelector(sel); } catch (e) { root = null; }
    if (root) break;
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

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * Align the project's per-project Agent settings — Confirm
 * before generating = Always (Never is never set), the run's
 * model mapped into the Agent's own labels, the run's aspect
 * when 16:9/9:16, outputs x1 — then Save and verify by
 * reopening. Runs on the model-fix retry path, with the panel
 * open and its prompt box unlocked after a Reject. Best-effort
 * BY DESIGN: when the surface cannot be operated the caller
 * continues WITHOUT the retry, behind an 'agent-settings-
 * unaligned' log line. Returns true only when the reopened
 * settings show the aligned values.
 */
async function alignAgentSettings(engine, settings, log) {
  const desired = desiredAgentSettings(settings);
  if (!desired.modelKnown) {
    log('settings-skip', { detail: `the run's model "${settings.model || ''}" has no Flow Agent mapping — the project's Agent model default is left as-is.` });
  }
  if (!desired.aspect) {
    log('settings-skip', { detail: `the run's aspect "${settings.aspectRatio || ''}" is not 16:9 or 9:16 — the project's Agent aspect default is left as-is.` });
  }
  try {
    let opened = false;
    try { opened = await engine.page.evaluate(pageOpenAgentSettings, AGENT_SELECTORS); } catch (e) {}
    if (opened) {
      await sleep(700);
      try { opened = await engine.page.evaluate(pageAgentSettingsPresent, AGENT_SELECTORS); } catch (e) { opened = false; }
    }
    if (!opened) {
      log('settings-unaligned', { detail: 'the Agent settings surface was not found' });
      return false;
    }
    const state = await engine.page.evaluate(pageReadAgentSettings, AGENT_SELECTORS, KNOWN_AGENT_MODELS);
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
      return false;
    }
    await sleep(700);
    // Verify by reopening — the settings echo is the only proof.
    let verified = false;
    const reopened = await engine.page.evaluate(pageOpenAgentSettings, AGENT_SELECTORS);
    if (reopened) {
      await sleep(700);
      const after = await engine.page.evaluate(pageReadAgentSettings, AGENT_SELECTORS, KNOWN_AGENT_MODELS);
      verified = !!(after.present && after.confirm === 'Always' &&
        (!desired.modelLabel || after.model === desired.modelLabel) &&
        (!desired.aspect || after.aspect === desired.aspect));
    }
    if (verified) {
      const detail = [
        desired.modelLabel ? `model ${desired.modelLabel}` : null,
        desired.aspect ? `aspect ${desired.aspect}` : null,
        'outputs x1'
      ].filter(Boolean).join(', ');
      log('settings-aligned', { detail });
      return true;
    }
    log('settings-unaligned', { detail: 'Save was clicked, but the reopened settings do not show the aligned values' });
    return false;
  } catch (e) {
    log('settings-unaligned', { detail: (e && e.message) ? e.message : 'error while operating the settings surface' });
    return false;
  }
}

/**
 * After a permission-option click, wait (bounded) for the
 * proposal to settle: the radio group gone or disabled, or the
 * panel prompt box unlocked. Returns false on timeout — the
 * caller fails with 'agent-settle-timeout' instead of hanging.
 */
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
 */
async function submitViaAgent(engine, args) {
  const a = args || {};
  const promptText = String(a.promptText || '').replace(/[\r\n]+/g, ' ').trim();
  const settings = a.settings || {};
  const promptIndex = a.promptIndex || 0;
  const totalPrompts = a.totalPrompts || 1;
  const log = (kind, data, type) => {
    try { engine.log(agentLine(kind, data), type || 'info'); } catch (e) {}
  };

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

  // 2. Send the user's whole text as ONE chat message.
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

  const sentFirst = await sendChat(promptText);
  if (!sentFirst) {
    return { status: 'AGENT_FAILED', reason: 'agent-ui-not-found: the chat message could not be sent to Flow\'s Agent (selector calibration needed).' };
  }
  log('sent', { chars: promptText.length });

  // 3. The conversation loop — whole-text polling. The ONLY texts
  // ever sent are the user's instruction and, at most once, its
  // re-send after the settings fix. Any other Agent text (a
  // question, a status note) is logged and waited through: the
  // driver never improvises a reply.
  const proposalWaitMs = a.proposalWaitMs || PROPOSAL_WAIT_MS;
  let lastPanelText = '';
  let lastProgressAt = Date.now();
  let roundStart = Date.now();
  let lastWaitNote = Date.now();
  let panelChanges = 0;
  let proposalHandled = false;
  let retried = false;
  let approved = false;
  let generationStarted = false;

  // ANY failure from here on logs the full last-seen panel text
  // with the failure reason first — no run fails blind.
  const failRun = (reason) => {
    if (lastPanelText) log('panel-dump', { reason, text: lastPanelText }, 'error');
    return { status: 'AGENT_FAILED', reason };
  };

  while (!approved && !generationStarted) {
    if (engine.isStopping) return { status: 'STOPPED' };
    if (Date.now() - lastProgressAt > proposalWaitMs) {
      return failRun('agent-proposal-timeout: Flow\'s Agent did not reach a generation proposal in time. No credits were approved.');
    }
    let text = lastPanelText;
    try {
      const read = await engine.page.evaluate(pageReadAgentPanelText, AGENT_SELECTORS);
      if (typeof read === 'string') text = read;
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
      if (text && !hasProposalText(text) && !looksLikeGenerationStarted(text)) {
        // A question or any other new Agent text — logged, never
        // answered. The wait for a proposal continues.
        log('message', { text });
      }
    }

    // A LIVE proposal = the costing sentence in the text AND an
    // enabled Permission options radio group on the page. Both,
    // always. Handled once per continuous appearance of the
    // group (a click disables the group; a fresh proposal
    // re-enables it and is handled again).
    let perm = null;
    if (hasProposalText(lastPanelText)) {
      try { perm = await engine.page.evaluate(pagePermissionState, AGENT_SELECTORS); } catch (e) { perm = null; }
    }
    if (perm && perm.present && perm.enabled) {
      if (!proposalHandled) {
        proposalHandled = true;
        const quoted = agentRules.parseQuotedCost(lastPanelText);
        const proposalModel = agentRules.parseProposalModel(lastPanelText);
        const decision = agentRules.decideOnProposal({
          quotedCost: quoted,
          proposalModel,
          runModelLabel,
          runExpectedCost: runExpected,
          retried
        });
        log('proposal', { model: proposalModel, quoted, expected: runExpected, act: decision.act });

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
          // model, then re-send the instruction ONCE.
          log('retry', { model: runModelLabel }, 'warn');
          const aligned = await alignAgentSettings(engine, settings, log);
          if (aligned) {
            retried = true;
            const resent = await sendChat(promptText);
            if (!resent) {
              return failRun('agent-ui-not-found: the instruction could not be re-sent after the Agent settings were aligned.');
            }
            log('sent', { chars: promptText.length, retry: true });
            lastProgressAt = Date.now();
            roundStart = Date.now();
            // The Reject disabled the old group; the answer to
            // the re-sent instruction is a NEW proposal and must
            // be handled when its group appears.
            proposalHandled = false;
            continue;
          }
          // The settings surface could not be operated — the
          // 'agent-settings-unaligned' line is already logged;
          // continue WITHOUT the retry: Reject + park.
          log('parked', null, 'warn');
          return { status: 'AGENT_PARKED', reason: `agent-over-cost: Flow's Agent proposed ${quoted} credits (model ${proposalModel || 'unknown'}), above this run's expected cost of ${runExpected} credits, and the Agent settings could not be aligned to the run's model — the proposal was rejected (free) and nothing was approved, so no credits were spent.` };
        }
        if (decision.act === 'park') {
          log('parked', null, 'warn');
          return { status: 'AGENT_PARKED', reason: `agent-over-cost: Flow's Agent proposed ${quoted} credits (model ${proposalModel || 'unknown'}), above this run's expected cost of ${runExpected} credits — the proposal was rejected (free) and nothing was approved, so no credits were spent. Run this prompt in Flow yourself, or adjust the run's model/settings and run again.` };
        }
        // decision.act === 'fail' — the quote or the expected
        // cost could not be verified; the page is settled.
        return failRun(decision.reason || 'agent-failed');
      }
    } else {
      proposalHandled = false;
      if (lastPanelText && looksLikeGenerationStarted(lastPanelText)) {
        // The Agent is already generating (its Confirm setting
        // was off). No proposal will come and no completion
        // message ever follows — the media is the only signal.
        log('generation-started', null, 'warn');
        generationStarted = true;
        break;
      }
    }

    if (Date.now() - lastWaitNote >= (a.heartbeatMs || 30000)) {
      lastWaitNote = Date.now();
      if (!perm) {
        try { perm = await engine.page.evaluate(pagePermissionState, AGENT_SELECTORS); } catch (e) { perm = null; }
      }
      log('waiting', {
        elapsedSec: Math.round((Date.now() - roundStart) / 1000),
        tail: lastPanelText,
        group: (perm && perm.present) ? 'present' : 'absent'
      });
    }
    await sleep(a.chatPollMs || CHAT_POLL_MS);
  }

  // 4. Media detection: a NEW grid tile fingerprint (not
  // pre-existing, not claimed by a sibling task) or a NEW item in
  // the panel's Media options gallery is this run's media. No
  // completion message is ever posted — the media itself is the
  // only signal. Bind it at birth, exactly like submitPrompt
  // does, then hand off — the monitor + download pipeline take
  // it from here.
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
  return task;
}

module.exports = {
  AGENT_SELECTORS,
  PERMISSION_LABELS,
  PROPOSAL_WAIT_MS,
  SETTLE_TIMEOUT_MS,
  MEDIA_TIMEOUT_MS,
  MAX_PANEL_CHANGES,
  looksLikePolicyRefusal,
  hasProposalText,
  looksLikeGenerationStarted,
  desiredAgentSettings,
  truncateForLog,
  agentLine,
  buildAgentTask,
  submitViaAgent
};
