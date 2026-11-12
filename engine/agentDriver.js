'use strict';

// ---------------------------------------------------------------------------
// v2.48.95 (AGENT DRIVER): drives Google Flow's OWN built-in Agent
// (the "Agent" toggle inside Flow's prompt box + its chat panel)
// for Agent Prompt mode runs. The in-app brain (engine/agentBrain.js,
// free Gemini API) reads the Agent's chat replies and decides each
// step; this module is only the hands + eyes:
//
//   1. snapshot the project's existing tiles (same proof the direct
//      route takes — audit fix #6),
//   2. turn Flow's Agent ON and send the user's whole text as ONE
//      chat message,
//   3. poll the chat panel; every new Agent message goes to the
//      brain; the brain's reply is typed back, its approval is
//      re-checked against the local cost gate before any click,
//   4. when the Agent's media lands in the project grid, build the
//      SAME submitted-task object submitPrompt returns and hand off
//      — from that moment the existing render monitor + download
//      pipeline own the task, byte for byte. A download-stage
//      failure NEVER comes back here (sacred rule): nothing in this
//      module can resubmit or re-ask the Agent.
//
// ============================================================================
// ⚠️ SELECTOR TABLE — NOT LIVE-VERIFIED (v2.48.95 ships uncalibrated;
// the owner's PC is where these get proven, from his copied live
// logs). Every Flow-Agent DOM guess lives in AGENT_SELECTORS /
// APPROVE_LABELS / REJECT_LABELS below and NOWHERE else, so
// calibration is a one-table edit. The Agent toggle row reuses the
// exact chip shape engine/flowAutomation.js's ensureAgentModeDisabled
// has proven against the live page since v2.48.x — that part is NOT
// a guess. Everything about the chat PANEL (containers, message
// bubbles, send button) is a first-pass candidate list.
// ============================================================================

const agentBrain = require('./agentBrain');
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
  // Message bubbles inside the panel.
  message: [
    '[data-testid*="message" i]',
    'div[class*="message" i]',
    'div[class*="bubble" i]',
    'li'
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
  ]
};

// Proposal decision buttons, in click order. Matched by exact-ish
// visible text inside the agent panel first, then the page.
const APPROVE_LABELS = ['Approve', 'Confirm', 'Generate', 'Create', 'Yes, generate', 'Looks good', 'Proceed'];
const REJECT_LABELS = ['Reject', 'Cancel', 'Discard', 'No, redo', 'Redo'];

// Driver budgets (ms). Chat rounds are slow (the Agent thinks, then
// renders server-side), so these are generous but bounded — a stuck
// conversation fails honestly instead of hanging the run.
const CHAT_POLL_MS = 2500;
const CHAT_TIMEOUT_MS = 10 * 60 * 1000;
const MEDIA_TIMEOUT_MS = 10 * 60 * 1000;
const MEDIA_POLL_MS = 3000;
const MAX_PROPOSALS = 2; // a second over-cap proposal fails the run
const MAX_BRAIN_REPLIES = 12; // conversation length fuse

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test_js — no page, no network)
// ---------------------------------------------------------------------------

/** Stable fingerprint of one chat text (dedupe across polls). */
function chatFingerprint(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().substring(0, 300);
}

/** The texts in `texts` whose fingerprints are not in `seen` yet. */
function unseenTexts(texts, seen) {
  const fresh = [];
  for (const t of Array.isArray(texts) ? texts : []) {
    const fp = chatFingerprint(t);
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    fresh.push(t);
  }
  return fresh;
}

const POLICY_REFUSAL_RE = /(can(not|'t) help with that|against (our|the) (content )?polic|content policy|safety (policy|guidelines)|not able to generate (this|that))/i;
function looksLikePolicyRefusal(text) {
  return POLICY_REFUSAL_RE.test(String(text || ''));
}

/** One-line, length-capped rendering of a chat text for the log. */
function truncateForLog(text, max = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.substring(0, max)}…` : s;
}

/**
 * Every [AGENT] engine-log line is built HERE, from event data only.
 * The Gemini API key is never an input to this function — it cannot
 * appear in a log line (pinned by a fixture test).
 */
function agentLine(kind, data) {
  const d = data || {};
  switch (kind) {
    case 'toggle-on': return '[AGENT] Flow Agent mode is ON — the run will chat with Flow\'s Agent.';
    case 'toggle-missing': return '[AGENT] Flow\'s "Agent" toggle was not found in the prompt box.';
    case 'sent': return `[AGENT] sent the user's instruction to Flow's Agent (${Number(d.chars) || 0} characters).`;
    case 'message': return `[AGENT] agent message: "${truncateForLog(d.text)}"`;
    case 'decision': return `[AGENT] brain decision: ${d.action || '?'}${d.reason ? ` — ${d.reason}` : ''} (brain calls so far: ${Number(d.brainCalls) || 0})`;
    case 'quote': return `[AGENT] quoted cost: ${d.quoted} credits (cap ${d.cap} credits)`;
    case 'approved': return `[AGENT] proposal approved at ${d.quoted} credits — generation started by Flow's Agent.`;
    case 'rejected': return `[AGENT] proposal rejected (${d.reason || 'over cap'}) — asking the Agent again is free.`;
    case 'parked': return '[AGENT] a proposal is waiting, but the credit cap is 0 (never auto-approve) — the card is parked as needs-attention.';
    case 'reply-sent': return `[AGENT] brain reply sent to the Agent: "${truncateForLog(d.text, 120)}"`;
    case 'media': return '[AGENT] media detected in the project — handing off to the download pipeline.';
    case 'handoff': return '[AGENT] handoff complete — the render monitor and download pipeline own this task now.';
    case 'waiting': return `[AGENT] still waiting for Flow's Agent… (${d.elapsedSec || 0}s)`;
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

function pageReadAgentMessages(selectors) {
  let panel = null;
  for (const sel of selectors.panel) {
    try { panel = document.querySelector(sel); } catch (e) { panel = null; }
    if (panel) break;
  }
  const root = panel || document.body;
  let nodes = [];
  for (const sel of selectors.message) {
    try { nodes = Array.from(root.querySelectorAll(sel)); } catch (e) { nodes = []; }
    if (nodes.length) break;
  }
  return nodes
    .map(n => (n.innerText || '').replace(/\s+/g, ' ').trim())
    .filter(t => t.length >= 2);
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

function pageClickAgentLabel(selectors, labels) {
  let panel = null;
  for (const sel of selectors.panel) {
    try { panel = document.querySelector(sel); } catch (e) { panel = null; }
    if (panel) break;
  }
  const roots = panel ? [panel, document.body] : [document.body];
  for (const label of labels) {
    for (const root of roots) {
      const btn = Array.from(root.querySelectorAll('button')).find(b => (b.innerText || '').trim().toLowerCase() === label.toLowerCase());
      if (btn && !btn.disabled) {
        btn.click();
        return label;
      }
    }
  }
  return null;
}

function pageGridFingerprints() {
  return Array.from(document.querySelectorAll('flow-grid-tile-container'))
    .map(c => (c.getAttribute('aria-label') || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * Submit ONE prompt through Flow's Agent. Mirrors submitPrompt's
 * contract with the pool: returns { status: 'STOPPED' |
 * 'EXHAUSTED' | 'LOW_CREDITS' | 'VIOLATION' | 'AGENT_PARKED' |
 * 'AGENT_FAILED' } or a SUBMITTED task object. `args.agentConfig`
 * is { apiKey, brainModel, agentMaxCredits } from the run start —
 * the key is used ONLY as the Gemini header inside agentBrain.
 */
async function submitViaAgent(engine, args) {
  const a = args || {};
  const promptText = String(a.promptText || '').replace(/[\r\n]+/g, ' ').trim();
  const settings = a.settings || {};
  const promptIndex = a.promptIndex || 0;
  const totalPrompts = a.totalPrompts || 1;
  const cfg = a.agentConfig || {};
  const log = (kind, data, type) => {
    try { engine.log(agentLine(kind, data), type || 'info'); } catch (e) {}
  };

  if (engine.isStopping) return { status: 'STOPPED' };
  if (!promptText) {
    return { status: 'AGENT_FAILED', reason: 'The prompt text was EMPTY when it reached the engine — there was nothing to send to Flow\'s Agent.' };
  }
  if (!cfg.apiKey) {
    // The pool guards this before any worker starts; this is the
    // last line of defence, with the same owner-facing words.
    return { status: 'AGENT_FAILED', reason: 'AI Brain: add your free Gemini API key in Settings' };
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
  // media this run claims is provably new.
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

  // 3. The conversation loop. The user's own sent texts are marked
  // seen up-front so the poll never mistakes them for Agent replies.
  const expectedCost = (() => {
    try { return engine.getRequiredCredits(settings); } catch (e) { return null; }
  })();
  const capInfo = agentBrain.resolveAgentCap(cfg.agentMaxCredits, expectedCost);
  const brain = agentBrain.createBrainSession({
    apiKey: cfg.apiKey,
    modelSetting: cfg.brainModel,
    log: (line) => { try { engine.log(line, 'info'); } catch (e) {} }
  });
  const transcript = [{ from: 'user', text: promptText }];
  const seen = new Set([chatFingerprint(promptText)]);
  let proposals = 0;
  let replies = 0;
  let approved = false;
  const chatDeadline = Date.now() + (a.chatTimeoutMs || CHAT_TIMEOUT_MS);
  let lastWaitNote = Date.now();

  while (!approved && Date.now() < chatDeadline) {
    if (engine.isStopping) return { status: 'STOPPED' };
    await sleep(a.chatPollMs || CHAT_POLL_MS);
    let texts = [];
    try { texts = await engine.page.evaluate(pageReadAgentMessages, AGENT_SELECTORS); } catch (e) { texts = []; }
    const fresh = unseenTexts(texts, seen);
    for (const text of fresh) {
      if (engine.isStopping) return { status: 'STOPPED' };
      transcript.push({ from: 'agent', text });
      log('message', { text });
      if (looksLikePolicyRefusal(text)) {
        return { status: 'VIOLATION', reason: 'Flow\'s Agent refused this request (content policy).' };
      }
      const decision = await brain.decide({
        userInstruction: promptText,
        runSettings: settings,
        transcript: transcript.slice(0, -1),
        agentMessage: text,
        expectedCost,
        capSetting: cfg.agentMaxCredits
      });
      log('decision', { action: decision.action, reason: decision.reason, brainCalls: decision.brainCalls },
        decision.action === 'fail' ? 'error' : 'info');

      if (decision.action === 'approve') {
        // The gate already ran inside the brain session; run it
        // once more HERE, at the click, so no code path can approve
        // on the model's word alone.
        const gate = agentBrain.costGate({ quotedCost: decision.quotedCost, capInfo });
        if (!gate.approve) {
          if (gate.reason === 'agent-cap-zero') {
            log('parked', null, 'warn');
            return { status: 'AGENT_PARKED', reason: 'Agent proposal is waiting, but the credit cap is 0 (never auto-approve) — approve it in Flow, or raise the cap in Settings → AI Brain.' };
          }
          return { status: 'AGENT_FAILED', reason: gate.reason };
        }
        log('quote', { quoted: decision.quotedCost, cap: capInfo.cap });
        let clicked = null;
        try { clicked = await engine.page.evaluate(pageClickAgentLabel, AGENT_SELECTORS, APPROVE_LABELS); } catch (e) {}
        if (!clicked) {
          return { status: 'AGENT_FAILED', reason: 'agent-ui-not-found: the proposal\'s Approve button was not found (selector calibration needed). Nothing was approved.' };
        }
        log('approved', { quoted: decision.quotedCost }, 'success');
        approved = true;
        break;
      }
      if (decision.action === 'reject') {
        proposals++;
        log('quote', { quoted: decision.quotedCost, cap: capInfo.cap });
        log('rejected', { reason: decision.reason }, 'warn');
        if (proposals >= (a.maxProposals || MAX_PROPOSALS)) {
          return { status: 'AGENT_FAILED', reason: `agent-cost-over-cap: Flow's Agent kept proposing above the cap of ${capInfo.cap} credits.` };
        }
        let clickedReject = null;
        try { clickedReject = await engine.page.evaluate(pageClickAgentLabel, AGENT_SELECTORS, REJECT_LABELS); } catch (e) {}
        if (!clickedReject && decision.message) {
          await sendChat(decision.message);
          transcript.push({ from: 'user', text: decision.message });
          seen.add(chatFingerprint(decision.message));
        }
        continue;
      }
      if (decision.action === 'park') {
        log('parked', null, 'warn');
        return { status: 'AGENT_PARKED', reason: 'Agent proposal is waiting, but the credit cap is 0 (never auto-approve) — approve it in Flow, or raise the cap in Settings → AI Brain.' };
      }
      if (decision.action === 'fail') {
        return { status: 'AGENT_FAILED', reason: decision.reason || 'agent-failed' };
      }
      if (decision.action === 'reply') {
        replies++;
        if (replies > (a.maxBrainReplies || MAX_BRAIN_REPLIES)) {
          return { status: 'AGENT_FAILED', reason: 'agent-chat-too-long: the conversation with Flow\'s Agent did not reach a generation.' };
        }
        if (decision.message) {
          await sendChat(decision.message);
          transcript.push({ from: 'user', text: decision.message });
          seen.add(chatFingerprint(decision.message));
          log('reply-sent', { text: decision.message });
        }
        continue;
      }
      // 'wait' — nothing to do; keep polling.
    }
    if (!approved && Date.now() - lastWaitNote >= 30000) {
      lastWaitNote = Date.now();
      log('waiting', { elapsedSec: Math.round((Date.now() - (chatDeadline - (a.chatTimeoutMs || CHAT_TIMEOUT_MS))) / 1000) });
    }
  }

  if (!approved) {
    return { status: 'AGENT_FAILED', reason: 'agent-timeout: Flow\'s Agent did not reach an approved generation in time. No credits were approved.' };
  }

  // 4. Media detection: a NEW tile fingerprint in the project grid
  // (not pre-existing, not claimed by a sibling task) is this run's
  // media. Bind it at birth, exactly like submitPrompt does, then
  // hand off — the monitor + download pipeline take it from here.
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
    if (!lockedTileFingerprint) await sleep(a.mediaPollMs || MEDIA_POLL_MS);
  }
  if (!lockedTileFingerprint) {
    return { status: 'AGENT_FAILED', reason: 'agent-media-missing: the Agent reported generation, but no new tile appeared in the project. The media may still be in Flow — check the project before re-running (do NOT resubmit blindly).' };
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
  APPROVE_LABELS,
  REJECT_LABELS,
  CHAT_TIMEOUT_MS,
  MEDIA_TIMEOUT_MS,
  MAX_PROPOSALS,
  chatFingerprint,
  unseenTexts,
  looksLikePolicyRefusal,
  truncateForLog,
  agentLine,
  buildAgentTask,
  submitViaAgent
};
