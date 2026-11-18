'use strict';

// PUBLIC v1.0.0 — license key verification (Door B of the entry gate).
//
// Key format: base64url(payloadJSON) + "." + base64url(signature)
//   payload:   { kid, plan, exp, trial? }
//     kid   — key id (identifies which issued key this is)
//     plan  — plan name shown to the user (e.g. "Pro")
//     exp   — expiry, ISO date ("2027-01-31") or ISO datetime; a
//             date-only value is honoured through the END of that
//             day (UTC)
//     trial — optional boolean; true marks a trial key
//   signature: Ed25519 over the exact payload segment (the bytes of
//              the base64url payload string, UTF-8).
//
// Verification is fully offline: the Ed25519 PUBLIC keys below are
// the only keys this module needs. The matching private keys live
// outside the repo: the legacy key's is used only by
// tools/make_license_key.js; the server issuer's never leaves the
// backend that mints panel-generated keys.
//
// PUBLIC v1.0.1: TWO issuers are trusted —
//   [0] the original v1.0.0 key (offline tool), kept unchanged so
//       every key issued before v1.0.1 keeps working, and
//   [1] the server issuer key (panel "Generate" button), added so
//       keys minted by the admin panel verify too.
// verifyLicenseKey tries each in turn; everything else about the
// verdict (parse, fields, expiry) is exactly as in v1.0.0.

const crypto = require('crypto');

const LICENSE_PUBLIC_KEY_PEMS = [
  [
    '-----BEGIN PUBLIC KEY-----',
    'MCowBQYDK2VwAyEASDmix2IbihAIFqhWB0xmas9imayuC3Ro+M5NGE2XrM4=',
    '-----END PUBLIC KEY-----',
    ''
  ].join('\n'),
  [
    '-----BEGIN PUBLIC KEY-----',
    'MCowBQYDK2VwAyEAoupgJBM+mwVhU3JJmaxz6I+OMhYoH3IW8Rrpmc/P3cc=',
    '-----END PUBLIC KEY-----',
    ''
  ].join('\n')
];

// Kept for compatibility: the original (legacy) issuer's key.
const LICENSE_PUBLIC_KEY_PEM = LICENSE_PUBLIC_KEY_PEMS[0];

function base64UrlDecode(segment) {
  if (typeof segment !== 'string' || segment.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    return Buffer.from(segment, 'base64url');
  } catch (e) {
    return null;
  }
}

// Splits and decodes a key string. Returns null for anything that is
// not exactly two non-empty base64url segments with a JSON payload.
function parseLicenseKey(key) {
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot !== trimmed.lastIndexOf('.') || dot === trimmed.length - 1) return null;
  const payloadSegment = trimmed.slice(0, dot);
  const signatureSegment = trimmed.slice(dot + 1);
  const payloadBytes = base64UrlDecode(payloadSegment);
  const signature = base64UrlDecode(signatureSegment);
  if (!payloadBytes || !signature) return null;
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  return { payload, signingInput: payloadSegment, signature };
}

// The instant a key stops being valid, in epoch ms. NaN when the
// payload carries no parseable exp.
function keyExpiryMs(payload) {
  const exp = payload && typeof payload.exp === 'string' ? payload.exp.trim() : '';
  if (!exp) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(exp)) {
    const endOfDay = Date.parse(`${exp}T23:59:59.999Z`);
    return Number.isNaN(endOfDay) ? NaN : endOfDay;
  }
  const parsed = Date.parse(exp);
  return Number.isNaN(parsed) ? NaN : parsed;
}

// Structured verdict:
//   { ok: true, kid, plan, exp, trial }
//   { ok: false, reason: 'malformed' | 'bad-signature' |
//                        'missing-fields' | 'expired' }
function verifyLicenseKey(key, nowMs) {
  const parsed = parseLicenseKey(key);
  if (!parsed) return { ok: false, reason: 'malformed' };
  const { payload, signingInput, signature } = parsed;
  // v1.0.1: a key is authentic when ANY trusted issuer signed it.
  let signatureOk = false;
  for (const pem of LICENSE_PUBLIC_KEY_PEMS) {
    try {
      signatureOk = crypto.verify(
        null,
        Buffer.from(signingInput, 'utf8'),
        crypto.createPublicKey(pem),
        signature
      );
    } catch (e) {
      signatureOk = false;
    }
    if (signatureOk) break;
  }
  if (!signatureOk) return { ok: false, reason: 'bad-signature' };
  const kid = typeof payload.kid === 'string' ? payload.kid.trim() : '';
  const plan = typeof payload.plan === 'string' ? payload.plan.trim() : '';
  const exp = typeof payload.exp === 'string' ? payload.exp.trim() : '';
  const expiryMs = keyExpiryMs(payload);
  if (!kid || !plan || !exp || Number.isNaN(expiryMs)) {
    return { ok: false, reason: 'missing-fields' };
  }
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (now > expiryMs) return { ok: false, reason: 'expired' };
  return { ok: true, kid, plan, exp, trial: payload.trial === true };
}

// ---------------------------------------------------------------------
// PUBLIC v1.0.6 — SHORT user keys: FS-XXXX-XXXX-XXXX (12 uppercase hex
// chars). The short key is NOT a license key: it is only a lookup
// handle the key service's `redeem` action exchanges for the signed
// token (which stays server-side until that moment). These helpers
// are pure so the gate/bridge and the tests share one definition.
// Accepts the canonical dashed form, a bare 12-hex string, any case,
// stray spaces — returns the canonical form, or '' when the input is
// not short-key shaped (a long signed key never matches: it contains
// '.' and far more than 14 alphanumeric chars).
// ---------------------------------------------------------------------
function normalizeShortKey(text) {
  const raw = typeof text === 'string' ? text : '';
  let compact = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (compact.startsWith('FS')) compact = compact.slice(2);
  if (!/^[0-9A-F]{12}$/.test(compact)) return '';
  return `FS-${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}`;
}

function isShortKey(text) {
  return normalizeShortKey(text) !== '';
}

module.exports = {
  LICENSE_PUBLIC_KEY_PEM,
  LICENSE_PUBLIC_KEY_PEMS,
  parseLicenseKey,
  keyExpiryMs,
  verifyLicenseKey,
  normalizeShortKey,
  isShortKey
};
