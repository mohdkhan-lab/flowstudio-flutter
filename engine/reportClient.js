'use strict';

// PUBLIC v1.0.2 — app → panel reporting client (fire-and-forget).
//
// The app reports usage to the Firebase backend so the operator's
// panel shows real data. Writes go straight to Firestore via
// engine/firestoreClient.js:
//
//   Account entry → users/{uid}: PATCH { videosMade, lastSeenAt }
//     where videosMade = max(the stored value, the local total) —
//     the count only ever moves up, and the local total is the
//     bridge's usage counter of saved videos (usageStats.total).
//
//   License entry → activations/{id}: the deterministic doc id is
//     sha256hex(keyPrefix + fingerprint), keyPrefix = the first
//     14 characters of the key text (the same prefix the key
//     issuer records). The write rides an ANONYMOUS Firebase
//     session (license users have no account). PATCH-merge
//     { keyPrefix, fingerprint, appVersion, videosMade,
//       lastSeenAt } and firstSeenAt ONLY when the doc did not
//     exist before this write.
//
// Reporting NEVER blocks or fails entry or generation: callers
// fire it and ignore the result entirely. Every verdict here is
// for tests and logs, not for control flow.

const crypto = require('crypto');
const { SERVICE_CONFIG, isServiceConfigured } = require('./serviceConfig');
const firestore = require('./firestoreClient');
const authClient = require('./authClient');

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

// Account report: users/{uid} videosMade = max(stored, local).
async function reportAccountUsage(args, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  if (!resolveFetch(opts)) return { ok: false, reason: 'network-unavailable' };
  const uid = args && typeof args.uid === 'string' ? args.uid : '';
  const idToken = args && typeof args.idToken === 'string' ? args.idToken : '';
  const localTotal = args && typeof args.videosMade === 'number' ? args.videosMade : 0;
  if (!uid || !idToken) return { ok: false, reason: 'session-required' };
  const callOpts = { ...(opts || {}), token: idToken };
  const got = await firestore.getDocument(`users/${uid}`, callOpts);
  if (!got.ok) return got;
  if (!got.exists) return { ok: false, reason: 'user-doc-missing' };
  const stored = got.fields && typeof got.fields.videosMade === 'number'
    ? got.fields.videosMade : 0;
  const nowIso = new Date((opts && opts.nowMs) || Date.now()).toISOString();
  const patched = await firestore.patchDocument(`users/${uid}`, {
    videosMade: Math.max(stored, localTotal),
    lastSeenAt: firestore.timestampValue(nowIso)
  }, callOpts);
  if (!patched.ok) return patched;
  return { ok: true, videosMade: Math.max(stored, localTotal) };
}

// License report: activations/{sha256(keyPrefix+fingerprint)}.
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
  const got = await firestore.getDocument(`activations/${docId}`, callOpts);
  if (!got.ok) return got;
  const nowIso = new Date((opts && opts.nowMs) || Date.now()).toISOString();
  const fields = {
    keyPrefix,
    fingerprint,
    appVersion,
    videosMade: localTotal,
    lastSeenAt: firestore.timestampValue(nowIso)
  };
  // firstSeenAt is written only for a brand-new activation doc.
  if (!got.exists) fields.firstSeenAt = firestore.timestampValue(nowIso);
  const patched = await firestore.patchDocument(`activations/${docId}`, fields, callOpts);
  if (!patched.ok) return patched;
  return { ok: true, docId, isNew: !got.exists };
}

// One entry point for the bridge: route on the stored credential.
//   { credential, key?, fingerprint, appVersion, videosMade }
// (for a key credential the key text rides on the credential
// itself; args.key may override.)
async function reportForCredential(args, opts) {
  const credential = args && args.credential;
  if (!credential) return { ok: false, reason: 'no-credential' };
  if (credential.type === 'account') {
    return reportAccountUsage({
      uid: credential.uid,
      idToken: credential.idToken,
      videosMade: args.videosMade
    }, opts);
  }
  if (credential.type === 'key') {
    return reportLicenseUsage({
      key: (args && args.key) || credential.key,
      fingerprint: args.fingerprint,
      appVersion: args.appVersion,
      videosMade: args.videosMade
    }, opts);
  }
  return { ok: false, reason: 'no-credential' };
}

module.exports = {
  keyPrefixOf,
  activationIdFor,
  reportAccountUsage,
  reportLicenseUsage,
  reportForCredential,
  resetAnonymousSessionCache
};
