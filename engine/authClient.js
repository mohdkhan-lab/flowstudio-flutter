'use strict';

// PUBLIC v1.0.2 — Door A (account) client: Firebase Auth REST.
//
// Every call goes to the account backend named in
// engine/serviceConfig.js (Phase 2: LIVE, Firebase). There is NO
// mock or fake success path anywhere in this file: a sign-in
// counts only when Firebase answers, and the account's plan state
// counts only when its Firestore user document confirms it.
//
// Backend contract (Firebase Auth REST + Firestore REST):
//   POST https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=<apiKey>
//        { email, password, returnSecureToken: true }
//        → 200 { idToken, refreshToken, expiresIn, localId, email }
//        (with NO email/password in the body this creates an
//        ANONYMOUS session — used only as a reporting identity)
//   POST …/accounts:signInWithPassword?key=<apiKey>   (same shape)
//   POST …/accounts:sendOobCode?key=<apiKey>
//        { requestType: 'VERIFY_EMAIL', idToken }     after sign-up
//        { requestType: 'PASSWORD_RESET', email }     "forgot"
//        (Firebase's free tier has no email OTP codes — email +
//        password is the email door, honestly labelled as such.)
//   POST …/accounts:lookup?key=<apiKey>  { idToken }
//        → 200 { users: [ { localId, email, emailVerified, … } ] }
//   POST …/accounts:signInWithIdp?key=<apiKey>
//        { postBody: 'id_token=<google id token>&providerId=google.com',
//          requestUri: <the bridge callback>, returnIdpCredential: true,
//          returnSecureToken: true }                  (Google door)
//   POST https://securetoken.googleapis.com/v1/token?key=<apiKey>
//        form: grant_type=refresh_token&refresh_token=<token>
//        → 200 { id_token, refresh_token, expires_in, user_id }
//
// Plan state (Firestore, via engine/firestoreClient.js):
//   users/{uid} { email, plan, trialStartedAt, trialEndsAt,
//                 videosMade, createdAt, lastSeenAt }
//   The FIRST sign-in creates the doc with plan 'Free' and a
//   7-day trial (trialEndsAt = now + 7 days); later sign-ins read
//   the stored state and never reset it.
//
// Google sign-in: system-browser OAuth with PKCE (S256) against
// accounts.google.com using the Web client ID from the service
// config — NO client secret anywhere (PKCE replaces it). The
// browser lands on the bridge's own GET /auth/callback, which
// exchanges the code at https://oauth2.googleapis.com/token and
// completes the sign-in via accounts:signInWithIdp.
//
// The client caches nothing (except the single pending Google
// PKCE attempt, in memory only): the bridge stores the returned
// session in the entry credential and entryGate decides entry.

const crypto = require('crypto');
const { SERVICE_CONFIG, isServiceConfigured } = require('./serviceConfig');
const firestore = require('./firestoreClient');

const DOOR_A_UNAVAILABLE_MESSAGE =
  'Account sign-in is not available yet — please use a license key';

// The Google flow finishes on the bridge itself: Google redirects
// the system browser to this loopback URL on the app's own bridge
// port (48290 — engine_bridge's PORT).
const GOOGLE_REDIRECT_URI = 'http://127.0.0.1:48290/auth/callback';

const IDENTITY_BASE = 'https://identitytoolkit.googleapis.com/v1';
const SECURETOKEN_URL = 'https://securetoken.googleapis.com/v1/token';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const TRIAL_DAYS = 7;

function doorAState(config) {
  const configured = isServiceConfigured(config);
  return {
    configured,
    message: configured ? '' : DOOR_A_UNAVAILABLE_MESSAGE
  };
}

function resolveFetch(opts) {
  if (opts && typeof opts.fetchImpl === 'function') return opts.fetchImpl;
  return typeof fetch === 'function' ? fetch : null;
}

function resolveConfig(opts) {
  return (opts && opts.config) || SERVICE_CONFIG;
}

function identityUrl(config, verb) {
  return `${IDENTITY_BASE}/accounts:${verb}?key=${config.apiKey}`;
}

// Firebase error codes → plain sentences for the gate. The raw
// code never reaches the UI.
const FIREBASE_ERROR_MESSAGES = {
  EMAIL_EXISTS: 'That email already has an account — try signing in instead.',
  EMAIL_NOT_FOUND: 'Email or password is not correct.',
  INVALID_PASSWORD: 'Email or password is not correct.',
  INVALID_LOGIN_CREDENTIALS: 'Email or password is not correct.',
  INVALID_EMAIL: 'That email address does not look right.',
  WEAK_PASSWORD: 'That password is too weak — use at least 6 characters.',
  USER_DISABLED: 'This account has been disabled.',
  OPERATION_NOT_ALLOWED: 'This sign-in method is not available.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts — wait a while and try again.',
  INVALID_ID_TOKEN: 'Your session has expired — sign in again.',
  USER_NOT_FOUND: 'Your session has expired — sign in again.',
  TOKEN_EXPIRED: 'Your session has expired — sign in again.',
  INVALID_REFRESH_TOKEN: 'Your session has expired — sign in again.'
};

function firebaseErrorCode(data) {
  const raw = data && data.error && typeof data.error.message === 'string'
    ? data.error.message : '';
  // Some codes arrive with a " : detail" suffix.
  return raw.split(' : ')[0].trim();
}

function plainError(data, fallback) {
  const code = firebaseErrorCode(data);
  return FIREBASE_ERROR_MESSAGES[code] || fallback;
}

async function callJson(fetchImpl, url, body) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  return { status: res && typeof res.status === 'number' ? res.status : 0, data };
}

async function callForm(fetchImpl, url, params) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  return { status: res && typeof res.status === 'number' ? res.status : 0, data };
}

// Map a Firebase auth payload onto the app's session shape.
// Accepts both the identitytoolkit spelling (idToken / localId /
// expiresIn) and the securetoken spelling (id_token / user_id /
// expires_in). Returns null when the payload carries no ID token.
function sessionFromAuthData(data, nowMs) {
  if (!data || typeof data !== 'object') return null;
  const idToken = typeof data.idToken === 'string' ? data.idToken
    : (typeof data.id_token === 'string' ? data.id_token : '');
  if (!idToken) return null;
  const expiresInSec = Number(data.expiresIn !== undefined ? data.expiresIn : data.expires_in);
  const refreshToken = typeof data.refreshToken === 'string' ? data.refreshToken
    : (typeof data.refresh_token === 'string' ? data.refresh_token : '');
  return {
    idToken,
    refreshToken,
    uid: typeof data.localId === 'string' ? data.localId
      : (typeof data.user_id === 'string' ? data.user_id : ''),
    email: typeof data.email === 'string' ? data.email : '',
    expiresAt: Number.isFinite(expiresInSec) && expiresInSec > 0
      ? nowMs + expiresInSec * 1000 : 0
  };
}

// --- Firestore user document (plan state) ----------------------

// Read users/{uid} with the session's own ID token. Verdicts:
//   { ok: true, exists, plan, trialEndsAt, videosMade }
//   { ok: false, reason, status? } — getDocument's reasons.
async function fetchUserState(session, opts) {
  if (!session || !session.idToken || !session.uid) {
    return { ok: false, reason: 'account-init-failed', status: 0 };
  }
  const got = await firestore.getDocument(`users/${session.uid}`, {
    ...(opts || {}),
    token: session.idToken
  });
  if (!got.ok) return got;
  if (!got.exists) return { ok: true, exists: false };
  const f = got.fields || {};
  return {
    ok: true,
    exists: true,
    plan: typeof f.plan === 'string' ? f.plan : 'Free',
    trialEndsAt: typeof f.trialEndsAt === 'string' ? f.trialEndsAt : '',
    videosMade: typeof f.videosMade === 'number' ? f.videosMade : 0
  };
}

// First-sign-in creation: users/{uid} starts on plan 'Free' with
// a 7-day trial. Field values ride Firestore's typed encoding
// (timestamps as timestampValue, videosMade as integerValue).
async function createUserDoc(session, opts) {
  const now = new Date((opts && opts.nowMs) || Date.now());
  const trialEnds = new Date(now.getTime() + TRIAL_DAYS * 86400000);
  const fields = {
    email: session.email || '',
    plan: 'Free',
    trialStartedAt: firestore.timestampValue(now.toISOString()),
    trialEndsAt: firestore.timestampValue(trialEnds.toISOString()),
    videosMade: 0,
    createdAt: firestore.timestampValue(now.toISOString()),
    lastSeenAt: firestore.timestampValue(now.toISOString())
  };
  const patched = await firestore.patchDocument(`users/${session.uid}`, fields, {
    ...(opts || {}),
    token: session.idToken
  });
  if (!patched.ok) return patched;
  return {
    ok: true,
    plan: 'Free',
    trialEndsAt: trialEnds.toISOString(),
    isNew: true
  };
}

// Ensure the plan state: read the user doc; create it (starting
// the trial) only when this uid has none yet.
async function ensureUserState(session, opts) {
  const state = await fetchUserState(session, opts);
  if (!state.ok) return state;
  if (state.exists) {
    return { ok: true, plan: state.plan, trialEndsAt: state.trialEndsAt, isNew: false };
  }
  return createUserDoc(session, opts);
}

// Attach the backend-confirmed plan state to a fresh session. A
// sign-in is only complete once this confirms — no plan state is
// ever invented on this side.
async function withAccountState(session, opts) {
  const state = await ensureUserState(session, opts);
  if (!state.ok) {
    return {
      ok: false,
      reason: state.reason === 'network-error' ? 'network-error' : 'account-init-failed',
      status: state.status || 0
    };
  }
  return {
    ok: true,
    session: {
      ...session,
      plan: state.plan,
      trialEndsAt: state.trialEndsAt,
      isNew: state.isNew === true
    }
  };
}

function cleanCredentials(email, password) {
  return {
    email: typeof email === 'string' ? email.trim() : '',
    password: typeof password === 'string' ? password : ''
  };
}

// Create account (email + password). After a successful sign-up
// Firebase is asked to send the verification email; that send is
// fired honestly — its failure never un-creates the account, it
// is reported on the result as verifyEmailSent.
async function signUp(email, password, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  const creds = cleanCredentials(email, password);
  if (!creds.email) return { ok: false, reason: 'email-required' };
  if (!creds.password) return { ok: false, reason: 'password-required' };
  let session = null;
  try {
    const { status, data } = await callJson(
      fetchImpl,
      identityUrl(config, 'signUp'),
      { email: creds.email, password: creds.password, returnSecureToken: true }
    );
    if (status !== 200) {
      return {
        ok: false, reason: 'sign-up-failed', status,
        message: plainError(data, 'Sign-up could not be completed — check the email and password and try again.')
      };
    }
    session = sessionFromAuthData(data, Date.now());
    if (!session) return { ok: false, reason: 'sign-up-failed', status };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
  if (!session.email) session.email = creds.email;
  let verifyEmailSent = false;
  try {
    const sent = await callJson(
      fetchImpl,
      identityUrl(config, 'sendOobCode'),
      { requestType: 'VERIFY_EMAIL', idToken: session.idToken }
    );
    verifyEmailSent = sent.status === 200;
  } catch (e) {
    verifyEmailSent = false;
  }
  const withState = await withAccountState(session, opts);
  if (!withState.ok) return withState;
  return { ...withState, verifyEmailSent };
}

// Sign in (email + password).
async function signIn(email, password, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  const creds = cleanCredentials(email, password);
  if (!creds.email) return { ok: false, reason: 'email-required' };
  if (!creds.password) return { ok: false, reason: 'password-required' };
  let session = null;
  try {
    const { status, data } = await callJson(
      fetchImpl,
      identityUrl(config, 'signInWithPassword'),
      { email: creds.email, password: creds.password, returnSecureToken: true }
    );
    if (status !== 200) {
      return {
        ok: false, reason: 'sign-in-failed', status,
        message: plainError(data, 'Sign-in could not be completed — check the email and password and try again.')
      };
    }
    session = sessionFromAuthData(data, Date.now());
    if (!session) return { ok: false, reason: 'sign-in-failed', status };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
  if (!session.email) session.email = creds.email;
  return withAccountState(session, opts);
}

// Forgot password: Firebase emails a reset link (sendOobCode with
// PASSWORD_RESET). The answer is the same whether or not the
// email has an account — the bridge phrases it that way too.
async function forgotPassword(email, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  const cleanEmail = typeof email === 'string' ? email.trim() : '';
  if (!cleanEmail) return { ok: false, reason: 'email-required' };
  try {
    const { status, data } = await callJson(
      fetchImpl,
      identityUrl(config, 'sendOobCode'),
      { requestType: 'PASSWORD_RESET', email: cleanEmail }
    );
    if (status === 200) return { ok: true };
    return {
      ok: false, reason: 'reset-failed', status,
      message: plainError(data, 'The reset email could not be sent — check the email address and try again.')
    };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

// Anonymous session — a reporting identity only (license-key
// users have no account; their activation/stats writes ride an
// anonymous token, which the backend's rules accept for the
// activations collection only).
async function signInAnonymously(opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  try {
    const { status, data } = await callJson(
      fetchImpl,
      identityUrl(config, 'signUp'),
      { returnSecureToken: true }
    );
    if (status !== 200) return { ok: false, reason: 'anonymous-failed', status };
    const session = sessionFromAuthData(data, Date.now());
    if (!session) return { ok: false, reason: 'anonymous-failed', status };
    return { ok: true, session };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

// Session check: accounts:lookup for a live ID token.
async function lookupSession(idToken, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  const cleanToken = typeof idToken === 'string' ? idToken.trim() : '';
  if (!cleanToken) return { ok: false, reason: 'token-required' };
  try {
    const { status, data } = await callJson(
      fetchImpl,
      identityUrl(config, 'lookup'),
      { idToken: cleanToken }
    );
    if (status !== 200) {
      return {
        ok: false, reason: 'lookup-failed', status,
        message: plainError(data, 'Your session could not be checked.')
      };
    }
    const user = data && Array.isArray(data.users) && data.users.length ? data.users[0] : null;
    if (!user) return { ok: false, reason: 'lookup-failed', status };
    return {
      ok: true,
      uid: typeof user.localId === 'string' ? user.localId : '',
      email: typeof user.email === 'string' ? user.email : '',
      emailVerified: user.emailVerified === true
    };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

// Refresh an expired ID token (securetoken endpoint, form body).
// On success the session is fresh; the plan state is re-read from
// the user doc too (so a plan change reaches the app) but its
// failure does not sink an otherwise verified refresh — the
// caller keeps the stored plan state and accountInitOk says
// whether the plan state was re-confirmed.
async function refreshSession(refreshToken, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  const cleanToken = typeof refreshToken === 'string' ? refreshToken.trim() : '';
  if (!cleanToken) return { ok: false, reason: 'refresh-token-required' };
  let session = null;
  try {
    const { status, data } = await callForm(
      fetchImpl,
      `${SECURETOKEN_URL}?key=${config.apiKey}`,
      { grant_type: 'refresh_token', refresh_token: cleanToken }
    );
    if (status !== 200) {
      return {
        ok: false, reason: 'refresh-failed', status,
        message: plainError(data, 'Your session could not be refreshed.')
      };
    }
    session = sessionFromAuthData(data, Date.now());
    if (!session) return { ok: false, reason: 'refresh-failed', status };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
  if (!session.refreshToken) session.refreshToken = cleanToken;
  const state = await fetchUserState(session, opts);
  if (state.ok && state.exists) {
    session.plan = state.plan;
    session.trialEndsAt = state.trialEndsAt;
    return { ok: true, session, accountInitOk: true };
  }
  return { ok: true, session, accountInitOk: false };
}

// --- Google sign-in (system browser, PKCE) ----------------------
// The engine generates the verifier + state, keeps them in memory
// for the ONE pending attempt, and the bridge's /auth/callback
// exchanges the returned code. A new googleStartUrl() call
// replaces any pending attempt; an exchange consumes it.

function pkceChallengeFor(verifier) {
  return crypto.createHash('sha256').update(String(verifier), 'utf8').digest('base64url');
}

let pendingGoogle = null;

function googleStartUrl(opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return null;
  if (typeof config.googleClientId !== 'string' || !config.googleClientId) return null;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  pendingGoogle = { verifier, state, createdAt: Date.now() };
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    code_challenge: pkceChallengeFor(verifier),
    code_challenge_method: 'S256',
    state
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

// Test/inspection hooks: the pending attempt's verifier + state
// (the challenge in the start URL must be the verifier's S256).
function pendingGoogleVerifier() {
  return pendingGoogle ? pendingGoogle.verifier : null;
}

function pendingGoogleState() {
  return pendingGoogle ? pendingGoogle.state : null;
}

// The callback half: exchange the code for Google tokens (PKCE,
// NO client secret), then trade the Google credential for a
// Firebase session via accounts:signInWithIdp.
async function handleGoogleCallback(code, state, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  if (!pendingGoogle) return { ok: false, reason: 'no-pending-google' };
  const pending = pendingGoogle;
  pendingGoogle = null; // single attempt — consumed either way
  if (typeof state === 'string' && state && state !== pending.state) {
    return { ok: false, reason: 'google-state-mismatch', status: 0 };
  }
  const cleanCode = typeof code === 'string' ? code.trim() : '';
  if (!cleanCode) return { ok: false, reason: 'google-exchange-failed', status: 0 };
  let googleTokens = null;
  try {
    const { status, data } = await callForm(
      fetchImpl,
      GOOGLE_TOKEN_URL,
      {
        code: cleanCode,
        client_id: config.googleClientId,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
        code_verifier: pending.verifier
      }
    );
    if (status !== 200 || !data) {
      return { ok: false, reason: 'google-exchange-failed', status };
    }
    googleTokens = data;
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
  const postBody = typeof googleTokens.id_token === 'string' && googleTokens.id_token
    ? `id_token=${googleTokens.id_token}&providerId=google.com`
    : (typeof googleTokens.access_token === 'string' && googleTokens.access_token
      ? `access_token=${googleTokens.access_token}&providerId=google.com`
      : null);
  if (!postBody) return { ok: false, reason: 'google-exchange-failed', status: 0 };
  let session = null;
  try {
    const { status, data } = await callJson(
      fetchImpl,
      identityUrl(config, 'signInWithIdp'),
      {
        postBody,
        requestUri: GOOGLE_REDIRECT_URI,
        returnIdpCredential: true,
        returnSecureToken: true
      }
    );
    if (status !== 200) {
      return {
        ok: false, reason: 'google-exchange-failed', status,
        message: plainError(data, 'Google sign-in could not be completed.')
      };
    }
    session = sessionFromAuthData(data, Date.now());
    if (!session) return { ok: false, reason: 'google-exchange-failed', status };
    if (!session.email && typeof data.email === 'string') session.email = data.email;
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
  return withAccountState(session, opts);
}

module.exports = {
  DOOR_A_UNAVAILABLE_MESSAGE,
  GOOGLE_REDIRECT_URI,
  TRIAL_DAYS,
  doorAState,
  googleStartUrl,
  pkceChallengeFor,
  pendingGoogleVerifier,
  pendingGoogleState,
  handleGoogleCallback,
  signUp,
  signIn,
  forgotPassword,
  signInAnonymously,
  lookupSession,
  refreshSession,
  fetchUserState,
  ensureUserState,
  createUserDoc,
  sessionFromAuthData,
  firebaseErrorCode
};
