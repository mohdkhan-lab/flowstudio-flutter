const fs = require('fs');
const path = require('path');

/**
 * FlowStudio Lite — profile Preferences hygiene (v1.3).
 *
 * Chrome's "background mode" (Preferences: background.enabled) keeps a
 * chrome.exe process alive after the last window closes so extensions
 * and notifications can keep running. In an APP-OWNED profile that is
 * pure harm: the user closes the Sign In window, the invisible Chrome
 * keeps holding the profile's ProcessSingleton, and every later Sync /
 * Generate sees "Chrome is currently open for this profile" with no
 * window anywhere on screen — exactly the owner's live complaint.
 *
 * Policy: every app-owned profile gets background mode DISABLED in its
 * Preferences before the app opens Chrome on it, so closing the window
 * fully exits Chrome. The user's MAIN Chrome is never touched — this
 * only ever writes inside profiles/<account-id> owned by this app.
 *
 * IMPORTANT: only call this while no Chrome is running on the profile.
 * A running Chrome rewrites Preferences from memory on exit and would
 * discard the change (harmless, but pointless) — callers invoke it right
 * before they spawn Chrome, after the busy check passes.
 */

/**
 * Ensure <profilePath>/Default/Preferences has background.enabled=false.
 * - Merges into the existing JSON: all other keys (and other
 *   background.* keys) are preserved.
 * - Missing Preferences -> a minimal file is created (Chrome fills in
 *   every other default on first launch).
 * - Corrupt / non-object JSON -> the file is left completely untouched
 *   (never clobber user data we cannot parse).
 * - Idempotent: when background mode is already off, nothing is written.
 * Returns { applied: boolean, alreadySet?: boolean, reason?: string }.
 */
function ensureBackgroundModeOff(profilePath) {
  if (!profilePath || typeof profilePath !== 'string') {
    return { applied: false, reason: 'no-profile-path' };
  }
  const prefPath = path.join(profilePath, 'Default', 'Preferences');
  const existed = fs.existsSync(prefPath);

  let prefs = {};
  if (existed) {
    try {
      prefs = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
    } catch (e) {
      return { applied: false, reason: 'corrupt-preferences' };
    }
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
      return { applied: false, reason: 'corrupt-preferences' };
    }
  }

  const background = (prefs.background && typeof prefs.background === 'object' && !Array.isArray(prefs.background))
    ? prefs.background
    : {};
  if (existed && background.enabled === false) {
    return { applied: false, alreadySet: true };
  }

  prefs.background = { ...background, enabled: false };
  try {
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });
    fs.writeFileSync(prefPath, JSON.stringify(prefs));
    return { applied: true };
  } catch (e) {
    return { applied: false, reason: e.message };
  }
}

module.exports = { ensureBackgroundModeOff };
