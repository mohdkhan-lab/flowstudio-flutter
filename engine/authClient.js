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
//        (also the verification step for the Google door: the
//        hosted sign-in page hands the bridge a Firebase ID
//        token, and lookup is what proves it is real)
//   POST https://securetoken.googleapis.com/v1/token?key=<apiKey>
//        form: grant_type=refresh_token&refresh_token=<token>
//        → 200 { id_token, refresh_token, expires_in, user_id }
//
// Plan state (Firestore, via engine/firestoreClient.js):
//   users/{uid} { email, plan, trialStartedAt, trialEndsAt,
//                 videosMade, createdAt, lastSeenAt }
//   v1.0.2–v1.0.4: the first sign-in created this doc with plan
//   'Free' and a 7-day trial, and the account session itself
//   opened the app. v1.0.5 REPLACES that flow (owner's order):
//   an account session alone no longer opens anything — sign-in
//   exists only to fetch the user's license key (see the key
//   service below), and from then on entry is by key only. The
//   user-doc helpers stay for the reporting/refresh paths that
//   still read them; sign-in no longer creates the doc.
//
// Key service (v1.0.5, serviceConfig.keyFunctionUrl):
//   POST { action: 'mykey' }     Bearer <Firebase ID token>
//        → 200 { key, kid, plan, exp, reused } — the caller's
//          one key (a fresh 7-day Trial the first time, the
//          SAME key on every later ask)
//        → 403 { error: 'email-not-verified' } — the email is
//          not verified yet (Google sign-ins always are)
//        → 401 — the token is not a valid session
//   POST { action: 'sendotp', email }    (no token — pre-signup)
//        → 200 { ok: true } | 503 { error: 'otp-unavailable' }
//          when the sender is not set up on the service yet
//   POST { action: 'verifyotp', email, code }
//        → 200 { ok: true } | 400 { error: 'otp-…' }
//   The gateway also wants the publishable api key header
//   (serviceConfig.keyFunctionApiKey) on every call.
//
// Google sign-in (v1.0.3): the gate opens a hosted sign-in page
// (serviceConfig.authPageUrl) in the system browser with a
// one-time state. The page signs the user in with the backend
// SDK's own Google provider — no custom OAuth client anywhere —
// and redirects the browser to the bridge's own GET
// /auth/callback carrying the fresh Firebase ID token. The
// bridge verifies that token via accounts:lookup and then runs
// the SAME session-establishment path as email sign-in. (The
// v1.0.2 custom-OAuth/PKCE route is gone: the project's OAuth
// client accepts no app-registered redirect URIs, so Google
// refused every attempt with redirect_uri_mismatch.)
//
// The client caches nothing (except the single pending Google
// state, in memory only): the bridge stores the returned
// session in the entry credential and entryGate decides entry.

const crypto = require('crypto');
const { SERVICE_CONFIG, isServiceConfigured } = require('./serviceConfig');
const firestore = require('./firestoreClient');

const DOOR_A_UNAVAILABLE_MESSAGE =
  'Account sign-in is not available yet — please use a license key';

// The Google flow finishes on the bridge itself: the hosted
// sign-in page redirects the system browser to this loopback URL
// on the app's own bridge port (48290 — engine_bridge's PORT),
// carrying the Firebase ID token + the one-time state.
const GOOGLE_REDIRECT_URI = 'http://127.0.0.1:48290/auth/callback';

const IDENTITY_BASE = 'https://identitytoolkit.googleapis.com/v1';
const SECURETOKEN_URL = 'https://securetoken.googleapis.com/v1/token';

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

// PUBLIC v1.0.8 (F4/F6): a display name, cleaned for storage and
// for the key email's greeting — control characters and
// newlines stripped, whitespace collapsed, capped at 60
// characters. '' means "no name known".
function cleanDisplayName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
}

// Read users/{uid} with the session's own ID token. Verdicts:
//   { ok: true, exists, plan, trialEndsAt, videosMade, name }
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
    videosMade: typeof f.videosMade === 'number' ? f.videosMade : 0,
    name: typeof f.name === 'string' ? f.name : ''
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
    // v1.0.8 (F4): the sign-up / Google display name rides the
    // creation write (the rules' create path allows it; the
    // field is simply absent when no name is known).
    ...(cleanDisplayName(opts && opts.name) ? { name: cleanDisplayName(opts && opts.name) } : {}),
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

// PUBLIC v1.0.8 (F4): record the user's display name on their
// user doc — at sign-up (the typed name) and at Google sign-in
// (the profile name). When the doc does not exist yet this IS
// the account-creation write: the doc is created with the trial
// fields and the name together (the rules' create path allows
// it, trial-capped). When the doc already exists and its name
// differs, the name is patched on its own — NOTE: the published
// rules let a user self-update ONLY videosMade/lastSeenAt, so
// that patch is refused until 'name' joins the rules' self-
// update list; the refusal is reported on the result
// (nameRefreshBlocked) and never fails the sign-in itself.
// Verdicts: { ok, created, nameRecorded, nameRefreshBlocked? } |
// { ok: false, reason } — fetchUserState's reasons.
async function recordUserProfile(session, rawName, opts) {
  const name = cleanDisplayName(rawName);
  const state = await fetchUserState(session, opts);
  if (!state.ok) return state;
  if (!state.exists) {
    const created = await createUserDoc(session, { ...(opts || {}), name });
    if (!created.ok) return created;
    return { ok: true, created: true, nameRecorded: !!name, plan: created.plan, trialEndsAt: created.trialEndsAt };
  }
  if (name && state.name !== name) {
    const patched = await firestore.patchDocument(`users/${session.uid}`, { name }, {
      ...(opts || {}),
      token: session.idToken
    });
    return {
      ok: true,
      created: false,
      nameRecorded: patched.ok === true,
      nameRefreshBlocked: patched.ok !== true
    };
  }
  return { ok: true, created: false, nameRecorded: !!state.name };
}

// Attach the backend-confirmed plan state to a fresh session.
// v1.0.2–v1.0.4 sign-in routed through here (the account itself
// was the entry). v1.0.5 no longer calls this on the sign-in
// path — entry is by license key only — but the helper stays:
// the user-doc read/create it wraps is still the reporting
// path's vocabulary, and the pins keep it honest.
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
  // v1.0.5: sign-up returns the bare session — entry is decided
  // by the license key the session fetches next (fetchMyKey),
  // never by the account itself.
  return { ok: true, session, verifyEmailSent };
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
  // v1.0.5: the bare session, as in signUp — the key decides.
  return { ok: true, session };
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

// --- Google sign-in (hosted sign-in page, token intake) ---------
// The engine generates a one-time state, keeps it in memory for
// the ONE pending attempt, and hands the gate the hosted page's
// URL with that state. The page signs the user in and redirects
// the browser to the bridge's /auth/callback with the Firebase
// ID token + the same state. A new googleStartUrl() call
// replaces any pending attempt; a callback consumes it.

let pendingGoogle = null;

function googleStartUrl(opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return null;
  if (typeof config.authPageUrl !== 'string' || !config.authPageUrl) return null;
  const state = crypto.randomBytes(16).toString('base64url');
  pendingGoogle = { state, createdAt: Date.now() };
  const params = new URLSearchParams({ state });
  return `${config.authPageUrl}?${params.toString()}`;
}

// Test/inspection hook: the pending attempt's state (the start
// URL must carry exactly this value).
function pendingGoogleState() {
  return pendingGoogle ? pendingGoogle.state : null;
}

// Read a Firebase ID token's expiry (the JWT payload's exp
// claim) WITHOUT trusting the token: authenticity is proven by
// accounts:lookup before this value is ever used, and the exp
// only stamps the local session's expiry. 0 when unreadable.
function idTokenExpiryMs(idToken) {
  try {
    const parts = String(idToken).split('.');
    if (parts.length !== 3) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp > 0 ? payload.exp * 1000 : 0;
  } catch (e) {
    return 0;
  }
}

// PUBLIC v1.0.8 (F4): the display name a Firebase ID token
// carries (the Google profile name, in the `name` claim), read
// WITHOUT trusting the token — the bridge calls this only for a
// token accounts:lookup has already proven real (see
// handleGoogleTokenCallback), and the value is only a display
// name on the user's own doc + the key email's greeting.
// Cleaned like every other name in this file; '' when absent.
function idTokenDisplayName(idToken) {
  try {
    const parts = String(idToken).split('.');
    if (parts.length !== 3) return '';
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return cleanDisplayName(payload && payload.name);
  } catch (e) {
    return '';
  }
}

// The callback half: verify the handed-back Firebase ID token
// via accounts:lookup, then build the SAME account session as
// email sign-in (uid/email → trial doc → gate). The page gives
// no refresh token, so the session's refreshToken is empty: the
// token lives for its own lifetime (~1 hour) and the gate's
// offline grace covers short drops after that; a Google user
// whose token has fully expired simply signs in again.
async function handleGoogleTokenCallback(firebaseToken, state, opts) {
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
  const cleanToken = typeof firebaseToken === 'string' ? firebaseToken.trim() : '';
  if (!cleanToken) return { ok: false, reason: 'google-token-missing', status: 0 };
  const looked = await lookupSession(cleanToken, opts);
  if (!looked.ok) {
    return {
      ok: false, reason: 'google-verify-failed', status: looked.status || 0,
      message: looked.message || 'Google sign-in could not be verified.'
    };
  }
  if (!looked.uid) return { ok: false, reason: 'google-verify-failed', status: 0 };
  const session = {
    idToken: cleanToken,
    refreshToken: '',
    uid: looked.uid,
    email: looked.email,
    expiresAt: idTokenExpiryMs(cleanToken) || (Date.now() + 3600000)
  };
  // v1.0.5: the bare session, as in email sign-in — the gate
  // fetches this user's key with it next; the account itself
  // opens nothing.
  return { ok: true, session };
}

// --- Key service (v1.0.5): mykey + email OTP -------------------
// The app never signs keys and never decides who deserves one —
// it carries the user's Firebase ID token to the key service and
// reports what the service answered, in plain reasons.
// v1.0.6: mykey no longer RETURNS a key — the service EMAILS the
// account's short key and answers { emailed: true }. The redeem
// action below is the reverse trip: short key in, signed key out.

async function callKeyFunction(fetchImpl, config, body, idToken) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: config.keyFunctionApiKey
  };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetchImpl(config.keyFunctionUrl, {
    method: 'POST',
    headers,
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

function keyServiceConfigured(config) {
  return typeof config.keyFunctionUrl === 'string' && config.keyFunctionUrl.length > 0 &&
    typeof config.keyFunctionApiKey === 'string' && config.keyFunctionApiKey.length > 0;
}

// Ask the key service to EMAIL this signed-in user their license
// key (v1.0.6: the key travels by email only — it is never in the
// response, and this client never sees it).
//   { ok: true, emailed: true, plan, exp, reused } — reused says
//     the email's key already existed (the normal case on every
//     ask after the first; the SAME key is re-sent).
//   { ok: false, reason: 'email-not-verified' } — the email door
//     still owes a verification (link or code) first.
//   { ok: false, reason: 'key-email-failed' } — the service could
//     not send the email; the gate shows that honestly. There is
//     no fallback that displays the key.
//   { ok: false, reason: 'session-expired' } — the token was
//     refused; the bridge refreshes and retries once before this
//     reaches the gate.
async function fetchMyKey(idToken, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  if (!keyServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  const cleanToken = typeof idToken === 'string' ? idToken.trim() : '';
  if (!cleanToken) return { ok: false, reason: 'token-required' };
  // v1.0.8 (F6): the user's name rides along when the bridge
  // knows it — the service greets the key email with it. Absent
  // name → the body is exactly the pre-v1.0.8 one.
  const name = cleanDisplayName(opts && opts.name);
  const body = name ? { action: 'mykey', name } : { action: 'mykey' };
  try {
    const { status, data } = await callKeyFunction(
      fetchImpl, config, body, cleanToken);
    if (status === 200 && data && data.emailed === true) {
      return {
        ok: true,
        emailed: true,
        plan: typeof data.plan === 'string' ? data.plan : '',
        exp: typeof data.exp === 'string' ? data.exp : '',
        reused: data.reused === true
      };
    }
    if (status === 502 && data && data.error === 'key-email-failed') {
      return {
        ok: false, reason: 'key-email-failed', status,
        message: 'We could not email your key. Please try again later.'
      };
    }
    if (status === 403 && data && data.error === 'email-not-verified') {
      return { ok: false, reason: 'email-not-verified', status };
    }
    if (status === 401) {
      return {
        ok: false, reason: 'session-expired', status,
        message: 'Your session has expired — sign in again.'
      };
    }
    return {
      ok: false, reason: 'my-key-failed', status,
      message: 'Your key could not be fetched — try again in a moment.'
    };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

// PUBLIC v1.0.6 — redeem: exchange a SHORT key (FS-XXXX-XXXX-XXXX)
// for the signed license token the service holds. Open action (the
// short key is the credential — no Firebase token is sent), like
// sendotp. The first use binds the key to this device fingerprint
// server-side; the bridge then verifies + stores the signed token
// exactly like a pasted long key.
//   { ok: true, signedKey, kid, plan, exp }
//   { ok: false, reason: 'key-not-found' }       — no such short key
//   { ok: false, reason: 'key-bound-elsewhere' } — bound to another PC
//   { ok: false, reason: 'network-error' }       — no answer at all
async function redeemKey(shortKey, deviceFingerprint, appVersion, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  if (!keyServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  const cleanShort = typeof shortKey === 'string' ? shortKey.trim() : '';
  const cleanFp = typeof deviceFingerprint === 'string' ? deviceFingerprint.trim() : '';
  if (!cleanShort) return { ok: false, reason: 'key-not-found' };
  if (!cleanFp) return { ok: false, reason: 'device-required' };
  try {
    const { status, data } = await callKeyFunction(
      fetchImpl, config,
      {
        action: 'redeem',
        shortKey: cleanShort,
        deviceFingerprint: cleanFp,
        appVersion: typeof appVersion === 'string' ? appVersion : ''
      },
      null);
    if (status === 200 && data && typeof data.signedKey === 'string' && data.signedKey) {
      return {
        ok: true,
        signedKey: data.signedKey,
        kid: typeof data.kid === 'string' ? data.kid : '',
        plan: typeof data.plan === 'string' ? data.plan : '',
        exp: typeof data.exp === 'string' ? data.exp : ''
      };
    }
    if (status === 404) return { ok: false, reason: 'key-not-found', status };
    if (status === 403) return { ok: false, reason: 'key-bound-elsewhere', status };
    return { ok: false, reason: 'redeem-failed', status };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

// The verification card's LINK route for a live session: ask
// Firebase to (re)send the VERIFY_EMAIL email for this token.
// (Sign-up already sends one automatically; this covers the
// sign-in path and the "send it again" tap.)
async function sendVerificationEmail(idToken, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  const cleanToken = typeof idToken === 'string' ? idToken.trim() : '';
  if (!cleanToken) return { ok: false, reason: 'token-required' };
  try {
    const { status, data } = await callJson(
      fetchImpl,
      identityUrl(config, 'sendOobCode'),
      { requestType: 'VERIFY_EMAIL', idToken: cleanToken }
    );
    if (status === 200) return { ok: true };
    return {
      ok: false, reason: 'verify-email-failed', status,
      message: plainError(data, 'The verification email could not be sent — try again in a moment.')
    };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

// The verification card's CODE route, step 1: ask the key
// service to email a 6-digit code. The service answers
// 'otp-unavailable' until its email sender is set up — the gate
// shows exactly that, never a pretend "code sent".
async function sendOtp(email, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  if (!keyServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  const cleanEmail = typeof email === 'string' ? email.trim() : '';
  if (!cleanEmail) return { ok: false, reason: 'email-required' };
  try {
    const { status, data } = await callKeyFunction(
      fetchImpl, config, { action: 'sendotp', email: cleanEmail }, null);
    if (status === 200 && data && data.ok === true) return { ok: true };
    if (data && data.error === 'otp-unavailable') {
      return {
        ok: false, reason: 'otp-unavailable', status,
        message: 'Email codes are not available yet — please use the verification link instead.'
      };
    }
    return {
      ok: false, reason: 'otp-send-failed', status,
      message: 'The code could not be sent — try again in a moment.'
    };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

// The CODE route, step 2: check the typed code with the service.
// A pass marks the email verified on the service side, so the
// next fetchMyKey succeeds.
async function verifyOtp(email, code, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  if (!keyServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  const cleanEmail = typeof email === 'string' ? email.trim() : '';
  if (!cleanEmail) return { ok: false, reason: 'email-required' };
  const cleanCode = typeof code === 'string' ? code.trim() : '';
  if (!cleanCode) return { ok: false, reason: 'code-required' };
  try {
    const { status, data } = await callKeyFunction(
      fetchImpl, config, { action: 'verifyotp', email: cleanEmail, code: cleanCode }, null);
    if (status === 200 && data && data.ok === true) return { ok: true };
    const messages = {
      'otp-invalid': 'That code is not correct — check the email and try again.',
      'otp-expired': 'That code has expired — send a new code.',
      'otp-too-many-attempts': 'Too many wrong codes — send a new code and try again.'
    };
    return {
      ok: false, reason: 'otp-invalid', status,
      message: (data && messages[data.error]) || 'That code could not be verified — try again.'
    };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

module.exports = {
  DOOR_A_UNAVAILABLE_MESSAGE,
  GOOGLE_REDIRECT_URI,
  TRIAL_DAYS,
  doorAState,
  googleStartUrl,
  pendingGoogleState,
  idTokenExpiryMs,
  idTokenDisplayName,
  cleanDisplayName,
  recordUserProfile,
  handleGoogleTokenCallback,
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
  firebaseErrorCode,
  fetchMyKey,
  redeemKey,
  sendVerificationEmail,
  sendOtp,
  verifyOtp
};
