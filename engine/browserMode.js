'use strict';

/**
 * FlowStudio Lite — browser visibility mode.
 *
 * The owner's demand (v2.2.0): pressing Generate must NOT pop Chrome
 * windows onto his screen — with bulk runs over 10+ accounts the
 * windows and the PC load become unbearable. So generation runs in
 * the BACKGROUND by default, and he opens any account's browser
 * himself, when he wants, from the card's "Chrome ↗" button (the
 * visible Sign In window, unchanged).
 *
 * v2.4.0 — the background TECHNIQUE changed, on the owner's PC
 * evidence: with headless Chrome ('new'), Flow's pages loaded
 * half-way, the prompt bar went missing and renders stalled.
 * Background became the SAME real (headed) Chrome with the window
 * parked OFF-SCREEN and then MINIMIZED via CDP.
 *
 * v2.6.0 — the minimize is GONE, on the owner's next PC test
 * (2026-10-14, v2.5.0): in Background mode both renders froze at 1%
 * for 8+ minutes while the tile was identified and "generating".
 * A minimized (or otherwise occluded) Chrome window is exactly the
 * case where Chrome throttles the page's rendering and timers —
 * Flow's own progress machinery can jam solid even though the tab
 * exists and our CDP polls still answer. Background is now ONLY an
 * off-screen window in the NORMAL window state, launched with the
 * standard anti-throttling flags, and the engine enables CDP focus
 * emulation so the page keeps believing it is the focused page:
 *   --disable-backgrounding-occluded-windows
 *   --disable-renderer-backgrounding
 *   --disable-features=CalculateNativeWinOcclusion
 * (Visible mode needs none of this — its window is on screen.)
 *
 * Setting: 'browser_background' in app_settings.
 *   '1' (or unset / anything but '0') = background ON  (default)
 *   '0'                               = background OFF -> visible
 *
 * This module is the single pure decision point: setting string ->
 * boolean -> launch plan. main.js feeds the pool from it, the engine
 * consumes the plan, and the unit tests pin the mapping here.
 */

const SETTING_KEY = 'browser_background';
const DEFAULT_BACKGROUND = true;

// Far outside any realistic monitor arrangement (Windows virtual
// desktops included) — the window exists in the NORMAL state and
// renders, but no screen shows it.
const OFFSCREEN_POSITION = '--window-position=-32000,-32000';
const OFFSCREEN_SIZE = '--window-size=1366,900';

// v2.6.0: the anti-throttling set for off-screen windows. Without
// these, Chrome treats a window no monitor shows as occluded and
// throttles its renderer + page timers — the v2.5.0 freeze at 1%.
const ANTI_THROTTLE_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion'
];

function resolveBackgroundEnabled(settingValue) {
  if (settingValue === undefined || settingValue === null || settingValue === '') {
    return DEFAULT_BACKGROUND;
  }
  return String(settingValue) !== '0';
}

/**
 * The launch plan for one automation Chrome.
 * background: headed Chrome, off-screen, NORMAL window state (never
 *   minimized — v2.6.0), anti-throttling flags on. NEVER headless.
 * visible: headed Chrome, maximized on screen, as before.
 */
function launchPlan(backgroundEnabled) {
  if (backgroundEnabled) {
    return {
      background: true,
      headless: false,
      windowMode: 'offscreen',
      extraArgs: [OFFSCREEN_POSITION, OFFSCREEN_SIZE],
      antiThrottleArgs: [...ANTI_THROTTLE_ARGS],
      startMaximized: false,
      minimizeAfterLaunch: false,
      focusEmulation: true
    };
  }
  return {
    background: false,
    headless: false,
    windowMode: 'visible',
    extraArgs: [],
    antiThrottleArgs: [],
    startMaximized: true,
    minimizeAfterLaunch: false,
    focusEmulation: false
  };
}

/** Short label for logs/Activity (what mode a run used). */
function describeMode(backgroundEnabled) {
  return backgroundEnabled
    ? 'Background (it is the real Chrome — the window stays off-screen in its normal state; it will not be visible on screen)'
    : 'Visible (the browser will be visible on screen)';
}

module.exports = {
  SETTING_KEY,
  DEFAULT_BACKGROUND,
  OFFSCREEN_POSITION,
  OFFSCREEN_SIZE,
  ANTI_THROTTLE_ARGS,
  resolveBackgroundEnabled,
  launchPlan,
  describeMode
};
