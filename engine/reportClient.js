'use strict';

// PUBLIC v1.0.2 — app → panel reporting client (fire-and-forget).
//
// The app reports usage to the Firebase backend so the operator's
// panel shows real data. Writes go straight to Firestore via
// engine/firestoreClient.js:
//
//   Account entry → users/{uid}: PATCH { videosMade, lastSeenAt,
//     appVersion } where videosMade = max(the stored value, the
//     local total) — the count only ever moves up, and the local
//     total is the bridge's usage counter of saved videos
//     (usageStats.total). v1.0.13: the same update also runs for
//     KEY entry whenever the account is identified (the pending
//     sign-in at activation time) — see reportForCredential.
//
//   License entry → activations/{id}: the deterministic doc id is
//     sha256hex(keyPrefix + fingerprint), keyPrefix = the first
//     14 characters of the key text (the same prefix the key
//     issuer records). The write rides an ANONYMOUS Firebase
//     session (license users have no account) and carries
//     { keyPrefix, plan, fingerprint, appVersion, videosMade,
//       lastSeenAt } plus firstSeenAt on the create only.
//
//     v1.0.13 ROOT CAUSE (field + live repro, 2026-11-20): the
//     pre-1.0.13 code decided firstSeenAt with a GET first — but
//     the backend rules make activations ADMIN-READABLE ONLY (a
//     device must never read other devices' activations), so the
//     anonymous GET always answered 403 PERMISSION_DENIED and the
//     report aborted before its PATCH, the one write the rules
//     DO allow any signed-in session. No activation ever landed.
//     The write now carries its own existence test: a create-only
//     PATCH (currentDocument.exists=false) with firstSeenAt;
//     ALREADY_EXISTS (409) falls back to a plain merge PATCH
//     without firstSeenAt. There is no GET on this path any more.
//
// Reporting NEVER blocks or fails entry or generation: callers
// fire it and ignore the result entirely. Every verdict here is
// for tests and logs, not for control flow.

const crypto = require('crypto');
const { SERVICE_CONFIG, isServiceConfigured } = require('./serviceConfig');
const firestore = require('./firestoreClient');
const authClient = require('./authClient');
const licenseKey = require('./licenseKey');

function resolveFetch(opts) {
  if (opts && typeof opts.fetchImpl === 'function') return opts.fetchImpl;
  return typeof fetch === 'function' ? fetch : null;
}

function resolveConfig(opts) {
  return (opts && opts.config) || SERVICE_CONFIG;
}

// The issuer's key-prefix rule: the first 14 characters of the
// key text.
function keyPrefixOf(key) {
  return typeof key === 'string' ? key.slice(0, 14) : '';
}

// The plan a key carries, read from its payload. Reporting
// vocabulary only — the key was signature-verified at activation;
// an unparseable key simply reports no plan.
function planOfKey(key) {
  try {
    const parsed = licenseKey.parseLicenseKey(key);
    return parsed && parsed.payload && typeof parsed.payload.plan === 'string'
      ? parsed.payload.plan : '';
  } catch (e) {
    return '';
  }
}

// The deterministic activations document id.
function activationIdFor(keyPrefix, fingerprint) {
  return crypto.createHash('sha256')
    .update(`${keyPrefix || ''}${fingerprint || ''}`, 'utf8')
    .digest('hex');
}

// The anonymous reporting session, cached per process. A fresh
// one is minted when there is none or the cached one has expired
// (its refresh token is tried first). Tests may inject one via
// opts.anonymousSession.
let cachedAnonymous = null;

async function ensureAnonymousSession(opts) {
  if (opts && opts.anonymousSession && opts.anonymousSession.idToken) {
    return { ok: true, session: opts.anonymousSession };
  }
  const nowMs = Date.now();
  if (cachedAnonymous && cachedAnonymous.expiresAt > nowMs) {
    return { ok: true, session: cachedAnonymous };
  }
  if (cachedAnonymous && cachedAnonymous.refreshToken) {
    const refreshed = await authClient.refreshSession(cachedAnonymous.refreshToken, opts);
    if (refreshed.ok) {
      cachedAnonymous = refreshed.session;
      return { ok: true, session: cachedAnonymous };
    }
    cachedAnonymous = null;
  }
  const anon = await authClient.signInAnonymously(opts);
  if (!anon.ok) return anon;
  cachedAnonymous = anon.session;
  return { ok: true, session: cachedAnonymous };
}

function resetAnonymousSessionCache() {
  cachedAnonymous = null;
}

// Account report: users/{uid} videosMade = max(stored, local),
// lastSeenAt, and (v1.0.13) appVersion — the audit found the app
// version never reached the users doc at all. The write rides the
// account's OWN session (the rules only let a user update their
// own doc, and only those fields).
async function reportAccountUsage(args, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  if (!resolveFetch(opts)) return { ok: false, reason: 'network-unavailable' };
  const uid = args && typeof args.uid === 'string' ? args.uid : '';
  const idToken = args && typeof args.idToken === 'string' ? args.idToken : '';
  const appVersion = args && typeof args.appVersion === 'string' ? args.appVersion : '';
  const localTotal = args && typeof args.videosMade === 'number' ? args.videosMade : 0;
  if (!uid || !idToken) return { ok: false, reason: 'session-required' };
  const callOpts = { ...(opts || {}), token: idToken };
  const got = await firestore.getDocument(`users/${uid}`, callOpts);
  if (!got.ok) return got;
  if (!got.exists) return { ok: false, reason: 'user-doc-missing' };
  const stored = got.fields && typeof got.fields.videosMade === 'number'
    ? got.fields.videosMade : 0;
  const nowIso = new Date((opts && opts.nowMs) || Date.now()).toISOString();
  const fields = {
    videosMade: Math.max(stored, localTotal),
    lastSeenAt: firestore.timestampValue(nowIso)
  };
  if (appVersion) fields.appVersion = appVersion;
  const patched = await firestore.patchDocument(`users/${uid}`, fields, callOpts);
  if (!patched.ok) return patched;
  return { ok: true, videosMade: Math.max(stored, localTotal) };
}

// License report: activations/{sha256(keyPrefix+fingerprint)}.
// No existence GET (admin-readable only — see the header note):
// the create-only PATCH is the existence test.
async function reportLicenseUsage(args, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  if (!resolveFetch(opts)) return { ok: false, reason: 'network-unavailable' };
  const key = args && typeof args.key === 'string' ? args.key : '';
  const fingerprint = args && typeof args.fingerprint === 'string' ? args.fingerprint : '';
  const appVersion = args && typeof args.appVersion === 'string' ? args.appVersion : '';
  const localTotal = args && typeof args.videosMade === 'number' ? args.videosMade : 0;
  if (!key) return { ok: false, reason: 'key-required' };
  const anon = await ensureAnonymousSession(opts);
  if (!anon.ok) return anon;
  const keyPrefix = keyPrefixOf(key);
  const docId = activationIdFor(keyPrefix, fingerprint);
  const callOpts = { ...(opts || {}), token: anon.session.idToken };
  const nowIso = new Date((opts && opts.nowMs) || Date.now()).toISOString();
  const fields = {
    keyPrefix,
    plan: planOfKey(key),
    fingerprint,
    appVersion,
    videosMade: localTotal,
    lastSeenAt: firestore.timestampValue(nowIso)
  };
  // Brand-new activation: the create-only write carries
  // firstSeenAt as well. 409 ALREADY_EXISTS is the doc-is-there
  // answer, not an error.
  const created = await firestore.patchDocument(`activations/${docId}`, {
    ...fields,
    firstSeenAt: firestore.timestampValue(nowIso)
  }, { ...callOpts, createOnly: true });
  if (created.ok) return { ok: true, docId, isNew: true };
  if (created.status !== 409) return created;
  // Existing activation: plain merge, firstSeenAt untouched.
  const patched = await firestore.patchDocument(`activations/${docId}`, fields, callOpts);
  if (!patched.ok) return patched;
  return { ok: true, docId, isNew: false };
}

// One entry point for the bridge: route on the stored credential.
//   { credential, key?, fingerprint, appVersion, videosMade,
//     accountSession? }
// (for a key credential the key text rides on the credential
// itself; args.key may override.)
//
// v1.0.13: since v1.0.5 the stored credential is the KEY — an
// account credential is never stored — so the account report
// above only ever ran for legacy records, and a key-entered
// user's own users doc was never updated. When the caller can
// identify the account (args.accountSession = the live pending
// sign-in's { uid, idToken }, present at activation time), the
// key path ALSO updates that user's doc. The license verdict
// stays the headline; the account verdict rides along and the
// combined ok is false when either half failed (the bridge's
// pending-report marker then retries both on the next trigger).
async function reportForCredential(args, opts) {
  const credential = args && args.credential;
  if (!credential) return { ok: false, reason: 'no-credential' };
  if (credential.type === 'account') {
    return reportAccountUsage({
      uid: credential.uid,
      idToken: credential.idToken,
      appVersion: args.appVersion,
      videosMade: args.videosMade
    }, opts);
  }
  if (credential.type === 'key') {
    const license = await reportLicenseUsage({
      key: (args && args.key) || credential.key,
      fingerprint: args.fingerprint,
      appVersion: args.appVersion,
      videosMade: args.videosMade
    }, opts);
    const acct = args && args.accountSession;
    if (acct && typeof acct.uid === 'string' && acct.uid &&
        typeof acct.idToken === 'string' && acct.idToken) {
      const account = await reportAccountUsage({
        uid: acct.uid,
        idToken: acct.idToken,
        appVersion: args.appVersion,
        videosMade: args.videosMade
      }, opts);
      return { ...license, ok: license.ok === true && account.ok === true, account };
    }
    return license;
  }
  return { ok: false, reason: 'no-credential' };
}

module.exports = {
  keyPrefixOf,
  planOfKey,
  activationIdFor,
  reportAccountUsage,
  reportLicenseUsage,
  reportForCredential,
  resetAnonymousSessionCache
};
