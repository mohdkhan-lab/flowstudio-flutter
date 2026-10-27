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
 * HEADLESS GENERATION (owner's explicit request, 2026-10-27): a
 * SECOND, separate opt-in — setting 'headless_generation' ('1' =
 * on, anything else = off, default OFF). With it on, generation
 * workers launch TRUE headless Chrome ('new'): no window exists at
 * all (nothing in the taskbar, nothing to park) and the PC carries
 * less load. The v2.4.0 lesson stands — headless stalled Flow back
 * then, which is exactly why this is an opt-in the owner turns on
 * himself, with the warning printed next to its Settings toggle,
 * and NOT a change to the default background behaviour above. It
 * governs GENERATION workers only: Sign In windows are a plain
 * visible spawn, and the credit / cookie checks have their own
 * launches — none of those read this setting.
 *
 * This module is the single pure decision point: setting string ->
 * boolean -> launch plan. main.js feeds the pool from it, the engine
 * consumes the plan, and the unit tests pin the mapping here.
 */

const SETTING_KEY = 'browser_background';
const DEFAULT_BACKGROUND = true;
const HEADLESS_SETTING_KEY = 'headless_generation';

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
 * Headless generation is opt-in and defaults OFF (the opposite
 * default from background mode): only the exact string '1' turns
 * it on, so an unset or garbled value can never silently switch a
 * run to headless.
 */
function resolveHeadlessGenerationEnabled(settingValue) {
  return String(settingValue) === '1';
}

/**
 * The launch plan for one automation Chrome.
 * background: headed Chrome, off-screen, NORMAL window state (never
 *   minimized — v2.6.0), anti-throttling flags on. NEVER headless.
 * visible: headed Chrome, maximized on screen, as before.
 * headless generation (second flag, wins over both): TRUE headless
 *   Chrome — no window exists, so there is no position to park and
 *   nothing to show or hide; the page still gets the parked
 *   window's 1366x900 size and the same anti-throttling flags +
 *   focus emulation that keep Flow's timers honest off-screen.
 */
function launchPlan(backgroundEnabled, headlessGenerationEnabled) {
  if (headlessGenerationEnabled) {
    return {
      background: true,
      headless: 'new',
      windowMode: 'headless',
      extraArgs: [OFFSCREEN_SIZE],
      antiThrottleArgs: [...ANTI_THROTTLE_ARGS],
      startMaximized: false,
      minimizeAfterLaunch: false,
      focusEmulation: true
    };
  }
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

// v2.25.0 — PARKED BROWSER (owner-approved design): while an account is
// generating, its Chrome button becomes a Show/Hide toggle for the
// WORKING browser itself. Showing moves the SAME window from its
// off-screen park onto the owner's screen; hiding parks it back. The
// window stays in the NORMAL state either way (never minimized — the
// v2.6.0 throttling lesson), and the page/browser are never touched,
// so generation cannot be interrupted by showing or hiding.
// Pure function: shown -> on-screen bounds sized for the owner's
// 1024x768 monitor; hidden -> the exact park position/size the
// background launch plan uses.
function parkedWindowBounds(shown) {
  if (shown) {
    return { left: 12, top: 12, width: 1000, height: 690, windowState: 'normal' };
  }
  return { left: -32000, top: -32000, width: 1366, height: 900, windowState: 'normal' };
}

/**
 * Equal tiling of the SHOWN generation windows over the screen
 * work area (owner's order, 2026-10-27): every shown window gets
 * the SAME size and together they fill the work area — 1 shown =
 * the whole area, 2 = two equal halves, 3 = three cells of a 2x2
 * grid, 4 = the 2x2 quadrants. [index] is the window's slot in
 * the shown set (0-based), [count] the size of that set, and
 * [workArea] { left, top, width, height } the real work area (see
 * windowStyle.getWorkArea). Cell edges are computed from the
 * area's far edge, so the last column/row absorbs the rounding
 * remainder and the grid fills the area exactly. Parked windows
 * are never part of this — they keep parkedWindowBounds(false).
 */
function tileWindowBounds(index, count, workArea) {
  const total = Math.max(1, Math.floor(Number(count) || 1));
  const slot = Math.min(Math.max(0, Math.floor(Number(index) || 0)), total - 1);
  const cols = Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / cols);
  const col = slot % cols;
  const row = Math.floor(slot / cols);
  const x0 = workArea.left + Math.floor((col * workArea.width) / cols);
  const x1 = workArea.left + Math.floor(((col + 1) * workArea.width) / cols);
  const y0 = workArea.top + Math.floor((row * workArea.height) / rows);
  const y1 = workArea.top + Math.floor(((row + 1) * workArea.height) / rows);
  return {
    left: x0,
    top: y0,
    width: Math.max(1, x1 - x0),
    height: Math.max(1, y1 - y0),
    windowState: 'normal'
  };
}

module.exports = {
  SETTING_KEY,
  DEFAULT_BACKGROUND,
  HEADLESS_SETTING_KEY,
  OFFSCREEN_POSITION,
  OFFSCREEN_SIZE,
  ANTI_THROTTLE_ARGS,
  resolveBackgroundEnabled,
  resolveHeadlessGenerationEnabled,
  launchPlan,
  describeMode,
  parkedWindowBounds,
  tileWindowBounds
};
