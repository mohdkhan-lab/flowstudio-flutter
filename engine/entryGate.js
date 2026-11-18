'use strict';

// PUBLIC v1.0.0 — the entry gate's decision + credential store.
// (Phase 2, v1.0.2: real account sessions — see the account branch.)
//
// The gate is the app's front door: on start, when no valid entry
// credential exists, ONLY the gate screen is shown and the main UI
// is unreachable. Two credential shapes are stored (one at a time)
// in <dataDir>/entry-credential.json:
//
//   { type: 'key',     key, kid, fingerprint, activatedAt }
//   { type: 'account', idToken, refreshToken, uid, expiresAt,
//     email, plan, trialEndsAt, lastVerifiedAt }        (Phase 2)
//   { type: 'account', token, plan, exp, trial, email } (v1.0.0
//     shape — never written anymore, still honoured on read)
//
// decideEntry is the single pure decision both the bridge and the
// tests use:
//   no credential            → gate ('no-credential')
//   key, bad signature       → gate ('key-invalid')
//   key, expired             → gate ('key-expired')
//   key, other device's bind → gate ('device-mismatch')
//   key, valid + this device → app
//   account (any shape)      → gate ('key-required') — v1.0.5:
//     an account session ALONE never opens the app any more.
//     Sign-in exists only to fetch the user's license key from
//     the key service; from then on entry is by that key alone.
//     (v1.0.2–v1.0.4 let a live account session in, on its trial
//     window / offline grace — that door is closed by the
//     owner's order; the account shapes below are still READ so
//     a stored one can be adopted as the pending sign-in by the
//     bridge, but the decision is always the gate.)
//
// Removing the credential from the app (Settings) deletes this
// file. It does NOT unbind the device: the binding recorded here
// still names this machine, and only the operator can release it.

const fs = require('fs');
const path = require('path');
const { verifyLicenseKey, keyExpiryMs } = require('./licenseKey');

const ENTRY_CREDENTIAL_FILE = 'entry-credential.json';
const DAY_MS = 86400000;
// The offline grace: an account whose plan state was verified
// online less than this long ago may still enter while offline.
const ACCOUNT_GRACE_MS = 3 * DAY_MS;

// A recorded plan counts as a PAID (standing) plan when it names
// one — anything other than the free/trial labels. Paid plans do
// not depend on the trial window.
function isPaidPlan(plan) {
  if (typeof plan !== 'string') return false;
  const p = plan.trim().toLowerCase();
  return p !== '' && p !== 'free' && p !== 'trial';
}

function credentialPath(dataDir) {
  return path.join(dataDir, ENTRY_CREDENTIAL_FILE);
}

function loadCredential(dataDir) {
  try {
    const raw = fs.readFileSync(credentialPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.type !== 'key' && parsed.type !== 'account') return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function saveCredential(dataDir, credential) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(credentialPath(dataDir), JSON.stringify(credential, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function clearCredential(dataDir) {
  try {
    fs.unlinkSync(credentialPath(dataDir));
    return true;
  } catch (e) {
    return false;
  }
}

// Whole days of validity left, counting a partial day as a day.
function daysLeftUntil(expiryMs, nowMs) {
  if (Number.isNaN(expiryMs)) return 0;
  const left = expiryMs - nowMs;
  if (left <= 0) return 0;
  return Math.ceil(left / DAY_MS);
}

function statusTextFor(plan, exp, trial, expiryMs, nowMs) {
  const planName = plan || 'Licensed';
  if (trial) {
    const days = daysLeftUntil(expiryMs, nowMs);
    return `Trial — ${days} day${days === 1 ? '' : 's'} left`;
  }
  return `${planName} · valid until ${exp}`;
}

function gateDecision(reason) {
  return {
    allowed: false,
    screen: 'gate',
    reason,
    plan: '',
    exp: '',
    trial: false,
    daysLeft: 0,
    statusText: '',
    email: ''
  };
}

// (v1.0.5: the account-entry decision helper is gone with the
// account door itself — see the 'key-required' branch below.)

function decideEntry(credential, ctx) {
  const nowMs = ctx && typeof ctx.nowMs === 'number' ? ctx.nowMs : Date.now();
  const fingerprint = ctx && typeof ctx.fingerprint === 'string' ? ctx.fingerprint : '';
  if (!credential) return gateDecision('no-credential');

  if (credential.type === 'key') {
    const verdict = verifyLicenseKey(credential.key, nowMs);
    if (!verdict.ok) {
      return gateDecision(verdict.reason === 'expired' ? 'key-expired' : 'key-invalid');
    }
    if (credential.fingerprint && fingerprint && credential.fingerprint !== fingerprint) {
      return gateDecision('device-mismatch');
    }
    const expiryMs = keyExpiryMs({ exp: verdict.exp });
    return {
      allowed: true,
      screen: 'app',
      reason: 'key',
      plan: verdict.plan,
      exp: verdict.exp,
      trial: verdict.trial,
      daysLeft: daysLeftUntil(expiryMs, nowMs),
      statusText: statusTextFor(verdict.plan, verdict.exp, verdict.trial, expiryMs, nowMs)
    };
  }

  if (credential.type === 'account') {
    // v1.0.5: an account credential — either shape (the Phase 2
    // token session or the v1.0.0 token+exp record) — is read
    // only so the bridge can adopt it as the pending sign-in for
    // the key fetch. The decision is always the gate: entry is
    // by license key alone now.
    const refused = gateDecision('key-required');
    refused.email = typeof credential.email === 'string' ? credential.email : '';
    refused.plan = typeof credential.plan === 'string' ? credential.plan : '';
    return refused;
  }

  return gateDecision('no-credential');
}

module.exports = {
  ENTRY_CREDENTIAL_FILE,
  ACCOUNT_GRACE_MS,
  isPaidPlan,
  credentialPath,
  loadCredential,
  saveCredential,
  clearCredential,
  daysLeftUntil,
  statusTextFor,
  decideEntry
};
