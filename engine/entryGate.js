'use strict';

// PUBLIC v1.0.0 — the entry gate's decision + credential store.
//
// The gate is the app's front door: on start, when no valid entry
// credential exists, ONLY the gate screen is shown and the main UI
// is unreachable. Two credential shapes are stored (one at a time)
// in <dataDir>/entry-credential.json:
//
//   { type: 'key',     key, kid, fingerprint, activatedAt }
//   { type: 'account', token, plan, exp, trial, email }
//
// decideEntry is the single pure decision both the bridge and the
// tests use:
//   no credential            → gate ('no-credential')
//   key, bad signature       → gate ('key-invalid')
//   key, expired             → gate ('key-expired')
//   key, other device's bind → gate ('device-mismatch')
//   key, valid + this device → app
//   account, token expired   → gate ('session-expired')
//   account, token live      → app
//
// Removing the credential from the app (Settings) deletes this
// file. It does NOT unbind the device: the binding recorded here
// (and, when a backend is configured, on the backend) still names
// this machine, and only the operator can release it.

const fs = require('fs');
const path = require('path');
const { verifyLicenseKey, keyExpiryMs } = require('./licenseKey');

const ENTRY_CREDENTIAL_FILE = 'entry-credential.json';
const DAY_MS = 86400000;

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
    statusText: ''
  };
}

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
    const exp = typeof credential.exp === 'string' ? credential.exp : '';
    const expiryMs = keyExpiryMs({ exp });
    if (!exp || Number.isNaN(expiryMs) || nowMs > expiryMs) {
      return gateDecision('session-expired');
    }
    const plan = typeof credential.plan === 'string' ? credential.plan : '';
    const trial = credential.trial === true;
    return {
      allowed: true,
      screen: 'app',
      reason: 'account',
      plan,
      exp,
      trial,
      daysLeft: daysLeftUntil(expiryMs, nowMs),
      statusText: statusTextFor(plan, exp, trial, expiryMs, nowMs)
    };
  }

  return gateDecision('no-credential');
}

module.exports = {
  ENTRY_CREDENTIAL_FILE,
  credentialPath,
  loadCredential,
  saveCredential,
  clearCredential,
  daysLeftUntil,
  statusTextFor,
  decideEntry
};
