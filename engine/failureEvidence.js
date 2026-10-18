'use strict';

/**
 * FlowStudio Lite — FAILURE EVIDENCE discipline (v2.9.0).
 *
 * WHY: on the owner's PC (2026-10-15, v2.8.0 run, 2 fresh prompts,
 * account just credit-checked) BOTH tasks were declared Failed at
 * stage 'generation' with the SAME reason:
 *   "Google Safety Filter: closeMohd AslamMohda.ktanwar@gmail.com
 *    Switch account movie_filter_auto46 Google Flow creditsCredits
 *    refresh daily at 9:02 AM Upgrade personCreate ava…"
 * That text is not a Flow refusal at all — it is the first 150 chars
 * of the account/credits POPOVER's innerText (the very panel
 * readLiveCreditsFromPage opens to read the balance). The monitor's
 * modal scan read PAGE-GLOBAL dialogs and fired on a bare substring
 * ('policy' / 'terms' — the popover's footer links "Privacy Policy ·
 * Terms of Service" live in the unseen tail of the same panel). Both
 * not-yet-generating tasks were then failed with that garbage as the
 * "reason", and because the reason began "Google Safety Filter",
 * failover classified it prompt-level FOREVER — no retry, no
 * failover, both videos MISSING. The renders may never have been
 * refused by Flow at all.
 *
 * THE RULES THIS MODULE ENCODES (saboot ka dayra):
 *  1. Failure evidence comes ONLY from (a) the task's OWN claimed
 *     tile (its chrome text, icon ligatures stripped) or (b) a real
 *     alert/dialog/snackbar carrying an actual refusal PHRASE.
 *     Page-global text, the account/credits chrome, or any other
 *     page furniture is NEVER evidence. The account/credits panel is
 *     excluded by explicit markers — the app itself opens it.
 *  2. A refusal is a PHRASE, never a word. REFUSAL_PATTERNS are
 *     word-bounded, context-carrying sentences ("violates our
 *     policy", "failed to generate", "try another prompt"…). A bare
 *     'safety', 'policy', 'violat', 'filter', 'blocked', 'terms' or
 *     'something went wrong' NEVER declares a failure.
 *  3. Weak or mixed evidence is NOT a failure: it stays 'unknown'
 *     and the existing wait/recovery machinery (stallWatch, monitor
 *     deadline) keeps watching. A fast fail needs tile-local,
 *     phrase-proven evidence (or a refusal dialog — see the modal
 *     scan in flowAutomation, which also applies this module's
 *     patterns and fails only the single oldest unobserved task).
 *  4. A failure reason is the ACTUAL short sentence found on the
 *     tile/dialog (extractSnippet) — never a dump of a whole element.
 *     No phrase found → the honest wording "Flow ne tile par wajah
 *     nahi dikhayi" is produced by the caller, not a blanket label.
 *
 * TILE-LEVEL CLASSIFICATION (classifyTileEvidence — the page-side
 * canvas read in flowAutomation mirrors exactly this):
 *   refusal phrase on the tile  -> kind 'safety'    (prompt-level:
 *                                                   failover never
 *                                                   retries it)
 *   'unusual activity' phrases  -> kind 'unusual'   (cooldown path)
 *   error/warning glyph only    -> kind 'tile-error' (the tile DID
 *                                  fail, but the cause is unproven —
 *                                  generation-level, so bounded
 *                                  retry/failover stays possible;
 *                                  it must NOT wear the prompt-level
 *                                  "Safety Filter" label)
 *   otherwise                   -> not failed
 *
 * The page-side evaluates cannot require() this module, so the
 * engine passes patternSources() + ACCOUNT_CHROME_MARKERS into them
 * as arguments — the patterns below remain the single source of
 * truth, and the smoke tests pin the wiring.
 */

const REFUSAL_PATTERNS = [
  // Tartib ahem hai: policy wale jumle pehle — ek hi text me kai
  // jumle hon to wajah wahi banti hai jo SEB (policy) batati hai,
  // sirf "nahi ban paya" wali aam line nahi.
  { name: 'violates-policy', source: '\\bviolat\\w*\\b[^.!?\\n]{0,60}?\\bpolic\\w*\\b' },
  { name: 'against-policies', source: '\\bagainst our polic\\w*\\b' },
  { name: 'content-policy', source: '\\bcontent polic\\w*\\b' },
  { name: 'safety-policy', source: '\\bsafety polic\\w*\\b' },
  { name: 'policy-violation', source: '\\bpolic\\w* violation\\b' },
  { name: 'failed-to-generate', source: '\\bfailed to generate\\b' },
  { name: 'generate-negation', source: "\\b(?:couldn['’]t|could not|can['’]t|can not|cannot|unable to) generate\\b" },
  { name: 'blocked-generation', source: '\\b(?:prompt|generation|request|content|video) (?:was |got )?blocked\\b' },
  { name: 'try-another-prompt', source: '\\btry another prompt\\b' },
  { name: 'not-allowed', source: '\\bnot allowed\\b' }
];

/**
 * Text that marks an element as account/credits CHROME (the panel
 * readLiveCreditsFromPage opens), never as failure evidence.
 * Lowercase substrings; the owner's popover carries all of these.
 */
const ACCOUNT_CHROME_MARKERS = ['switch account', 'credits refresh daily', 'create avatar'];

/** Regex sources only — what the engine hands to page.evaluate. */
function patternSources() {
  return REFUSAL_PATTERNS.map(p => p.source);
}

/**
 * Material icon ligatures render as snake_case text inside innerText
 * (movie_filter_auto, play_circle, file_download…). They are glyph
 * NAMES, not content: strip whole snake_case tokens before scanning.
 */
function stripIconLigatures(text) {
  return String(text || '').replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, ' ');
}

/**
 * The short honest sentence around a match: from the previous
 * sentence boundary (at most 90 chars back) to the next one (at
 * most 90 chars forward), whitespace-collapsed, capped at 140.
 * `flatText` must be the SAME string the match was found in (the
 * callers flatten whitespace per-character so indices align).
 */
function extractSnippet(flatText, matchIndex, matchLength) {
  const text = String(flatText || '');
  const backLimit = Math.max(0, matchIndex - 90);
  let start = backLimit;
  for (let i = matchIndex - 1; i >= backLimit; i--) {
    if ('.!?\n'.includes(text[i])) { start = i + 1; break; }
  }
  const fwdLimit = Math.min(text.length, matchIndex + matchLength + 90);
  let end = fwdLimit;
  for (let i = matchIndex + matchLength; i < fwdLimit; i++) {
    if ('.!?'.includes(text[i])) { end = i + 1; break; }
  }
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (snippet.length > 140) snippet = snippet.slice(0, 137).trim() + '...';
  return snippet;
}

/**
 * Find an actual refusal PHRASE in text. Returns
 * { pattern, snippet } or null. Matching is case-insensitive on a
 * per-character-flattened copy (indices stay aligned with the
 * original, so the snippet keeps its real casing).
 */
function findRefusal(text) {
  const flat = String(text || '').replace(/\s/g, ' ');
  const low = flat.toLowerCase();
  for (const p of REFUSAL_PATTERNS) {
    const m = low.match(new RegExp(p.source, 'i'));
    if (m) return { pattern: p.name, snippet: extractSnippet(flat, m.index, m[0].length) };
  }
  return null;
}

/** Flow's cooldown wording (its own class — never a "safety" fail). */
function findUnusual(text) {
  const low = String(text || '').toLowerCase();
  return /\bunusual activity\b/.test(low) || /\bnot been charged\b/.test(low);
}

/** Is this text the account/credits chrome panel? (marker check) */
function isAccountChromeText(text) {
  const low = String(text || '').toLowerCase();
  return ACCOUNT_CHROME_MARKERS.some(m => low.includes(m));
}

/**
 * The tile-level decision (mirrored by the page-side canvas read):
 * given the tile's chrome text (prompt already stripped by the
 * caller) and whether an exact error/warning glyph sits on the tile.
 * Ligature tokens are stripped before the phrase scan.
 */
function classifyTileEvidence(input = {}) {
  const scanText = stripIconLigatures(input.text || '');
  const refusal = findRefusal(scanText);
  if (refusal) return { isFailed: true, kind: 'safety', reason: refusal.snippet, pattern: refusal.pattern };
  if (findUnusual(scanText)) return { isFailed: true, kind: 'unusual', reason: null, pattern: null };
  if (input.hasErrorIcon) return { isFailed: true, kind: 'tile-error', reason: null, pattern: null };
  return { isFailed: false, kind: null, reason: null, pattern: null };
}

module.exports = {
  REFUSAL_PATTERNS,
  ACCOUNT_CHROME_MARKERS,
  patternSources,
  stripIconLigatures,
  extractSnippet,
  findRefusal,
  findUnusual,
  isAccountChromeText,
  classifyTileEvidence
};
