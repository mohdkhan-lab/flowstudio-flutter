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
//   account, plan inactive   → gate ('trial-expired') — the trial
//     window has ended and no paid plan is recorded
//   account, token expired   → gate ('session-expired')
//   account, plan active + token live → app
//   account, plan active + token expired BUT the last successful
//     online check is < 3 days old and this check failed on the
//     network (ctx.networkFailed) → app, on the offline grace —
//     the status line says it is running on a recent check
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

function accountDecision(fields) {
  return { screen: 'app', reason: 'account', exp: '', ...fields };
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
    const email = typeof credential.email === 'string' ? credential.email : '';

    // Phase 2 session shape: real backend tokens (the Firebase
    // ID token + refresh token) + the plan state the backend
    // confirmed (trial window / paid plan). The held Phase-2
    // draft's accessToken spelling is accepted on read too.
    if (typeof credential.idToken === 'string' ||
        typeof credential.accessToken === 'string' ||
        typeof credential.refreshToken === 'string' ||
        typeof credential.expiresAt === 'number' ||
        typeof credential.trialEndsAt === 'string') {
      const plan = typeof credential.plan === 'string' ? credential.plan : '';
      const trialEndsMs = typeof credential.trialEndsAt === 'string'
        ? Date.parse(credential.trialEndsAt) : NaN;
      const trialActive = !Number.isNaN(trialEndsMs) && nowMs < trialEndsMs;
      const planActive = trialActive || isPaidPlan(plan);
      if (!planActive) {
        const refused = gateDecision('trial-expired');
        refused.email = email;
        refused.plan = plan;
        return refused;
      }
      const planLine = trialActive
        ? statusTextFor(plan, credential.trialEndsAt, true, trialEndsMs, nowMs)
        : plan;
      const planFields = {
        allowed: true,
        plan,
        trial: trialActive,
        daysLeft: trialActive ? daysLeftUntil(trialEndsMs, nowMs) : 0,
        exp: trialActive ? credential.trialEndsAt : '',
        email
      };
      const tokenLive = typeof credential.expiresAt === 'number' && nowMs < credential.expiresAt;
      if (tokenLive) {
        return accountDecision({ ...planFields, statusText: planLine });
      }
      // Token expired. The bridge refreshes online before it
      // asks; reaching here with ctx.networkFailed means that
      // refresh could not run — the offline grace may apply.
      const lastVerifiedAt = typeof credential.lastVerifiedAt === 'number'
        ? credential.lastVerifiedAt : NaN;
      const grace = ctx && ctx.networkFailed === true &&
        !Number.isNaN(lastVerifiedAt) &&
        nowMs - lastVerifiedAt < ACCOUNT_GRACE_MS;
      if (grace) {
        return accountDecision({
          ...planFields,
          statusText: `${planLine} · offline — running on a recent check`
        });
      }
      const refused = gateDecision('session-expired');
      refused.email = email;
      refused.plan = plan;
      return refused;
    }

    // v1.0.0 shape (token + exp): honoured as written.
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
      statusText: statusTextFor(plan, exp, trial, expiryMs, nowMs),
      email
    };
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
