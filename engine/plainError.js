'use strict';

/**
 * FlowStudio Lite — plain-language error translation (v2.4.0).
 *
 * WHY: on the owner's PC the raw engine log once leaked
 *   "Cannot read properties of null (reading 'evaluate')"
 * straight into the visible log. To a non-technical reader that line
 * says nothing about WHAT happened or WHY time is passing. Every
 * user-facing log/activity line that originates from a caught JS /
 * Puppeteer error now passes through here first: the owner sees a
 * plain Hinglish explanation, and the original technical text rides
 * along separately (log entry `rawError`, Copy Log appends it) so it
 * is never lost for diagnosis — it just never stands alone.
 *
 * Pure functions, unit-tested. Matching is deliberately conservative:
 * known shapes get a specific explanation; anything else gets an
 * honest generic line plus its raw text preserved.
 */

const RULES = [
  {
    test: /cannot read properties of (null|undefined) \(reading 'evaluate'\)/i,
    plain: 'The Flow page closed or changed midway (part of the page disappeared)'
  },
  {
    test: /(reading 'evaluate'|execution context was destroyed|context was destroyed)/i,
    plain: 'The Flow page was refreshed/changed midway'
  },
  {
    test: /(target closed|session closed|connection closed|protocol error.*target|target.*crashed)/i,
    plain: 'The Chrome window closed midway'
  },
  {
    test: /(waiting for selector|waiting failed|waiting for function|waiting for target)/i,
    plain: 'The Flow page did not load fully — the part being waited for was not found on the page'
  },
  {
    test: /(navigation timeout|net::err|err_aborted|err_timed_out|err_internet|err_name_not_resolved|err_connection)/i,
    plain: 'The Flow page got stuck while opening (the internet or the page was very slow)'
  },
  {
    test: /protocol error/i,
    plain: 'The connection with Chrome broke midway'
  },
  {
    test: /(no element found|node is either not clickable|node is not visible|not clickable at point)/i,
    plain: 'The button/part that was needed was not found on the Flow page at all (the page design may have changed)'
  },
  {
    test: /(detached from document|node is detached)/i,
    plain: 'Part of the Flow page changed midway'
  }
];

const GENERIC_PLAIN = 'A technical problem occurred';

/**
 * Translate an error (Error object, message string, or anything) into
 * { plain, raw, known } — `plain` is safe to show alone, `raw` is the
 * original technical text to keep for Details/copy, `known` says a
 * specific rule matched.
 */
function translateError(input) {
  let raw = '';
  if (input instanceof Error) raw = input.message || String(input);
  else if (typeof input === 'string') raw = input;
  else if (input !== null && input !== undefined) raw = String(input);
  raw = raw.trim();
  if (!raw) return { plain: GENERIC_PLAIN, raw: '', known: false };
  for (const rule of RULES) {
    if (rule.test.test(raw)) return { plain: rule.plain, raw, known: true };
  }
  return { plain: GENERIC_PLAIN, raw, known: false };
}

/**
 * Convenience for log-line building: "plain (takneeki: raw)" is NOT
 * what we show — the visible line is just `plain`; callers attach
 * `raw` to the log entry's rawError field. This helper returns only
 * the plain text for inline interpolation.
 */
function plainOf(input) {
  return translateError(input).plain;
}

module.exports = { translateError, plainOf, GENERIC_PLAIN, RULES };
