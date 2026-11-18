'use strict';

// PUBLIC v1.0.0 — Door A (account) client + activation reporter.
//
// Every call goes to the backend named in engine/serviceConfig.js.
// Phase 1 ships with NO backend configured: each function then
// answers { ok: false, reason: 'not-configured' } and the gate
// shows the honest disabled message below. There is NO mock or
// fake success path anywhere in this file.
//
// Backend contract (implemented in the next phase):
//   POST {baseUrl}/v1/auth/email/code     { email }
//        → 200 { ok: true }
//   POST {baseUrl}/v1/auth/email/verify   { email, code }
//        → 200 { ok: true, token, plan, exp, trial }
//          (a first signup's session carries the 7-day trial:
//           plan 'Trial', trial true, exp = today + 7 days)
//   POST {baseUrl}/v1/devices/activate    { kid, fingerprint }
//        → 200 { ok: true } — records the one-device binding;
//          409 when the key is already bound to another device
//   GET  {baseUrl}/v1/auth/google/start   → browser sign-in flow
//
// The client caches nothing itself: the bridge stores the returned
// session in the entry credential and entryGate honours its exp
// while offline.

const { SERVICE_CONFIG, isServiceConfigured } = require('./serviceConfig');

const DOOR_A_UNAVAILABLE_MESSAGE =
  'Account sign-in is not available yet — please use a license key';

function doorAState(config) {
  const configured = isServiceConfigured(config);
  return {
    configured,
    message: configured ? '' : DOOR_A_UNAVAILABLE_MESSAGE
  };
}

function googleAuthUrl(config) {
  if (!isServiceConfigured(config)) return null;
  const cfg = config || SERVICE_CONFIG;
  return `${cfg.baseUrl.replace(/\/+$/, '')}/v1/auth/google/start`;
}

async function postJson(fetchImpl, url, body) {
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

function resolveFetch(opts) {
  if (opts && typeof opts.fetchImpl === 'function') return opts.fetchImpl;
  return typeof fetch === 'function' ? fetch : null;
}

function resolveConfig(opts) {
  return (opts && opts.config) || SERVICE_CONFIG;
}

async function sendEmailCode(email, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  const cleanEmail = typeof email === 'string' ? email.trim() : '';
  if (!cleanEmail) return { ok: false, reason: 'email-required' };
  try {
    const { status, data } = await postJson(
      fetchImpl,
      `${config.baseUrl.replace(/\/+$/, '')}/v1/auth/email/code`,
      { email: cleanEmail }
    );
    if (status === 200 && data && data.ok === true) return { ok: true };
    return { ok: false, reason: 'send-failed', status };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

async function verifyEmailCode(email, code, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  const cleanEmail = typeof email === 'string' ? email.trim() : '';
  const cleanCode = typeof code === 'string' ? code.trim() : '';
  if (!cleanEmail || !cleanCode) return { ok: false, reason: 'code-required' };
  try {
    const { status, data } = await postJson(
      fetchImpl,
      `${config.baseUrl.replace(/\/+$/, '')}/v1/auth/email/verify`,
      { email: cleanEmail, code: cleanCode }
    );
    if (
      status === 200 && data && data.ok === true &&
      typeof data.token === 'string' && typeof data.exp === 'string'
    ) {
      return {
        ok: true,
        session: {
          token: data.token,
          plan: typeof data.plan === 'string' ? data.plan : '',
          exp: data.exp,
          trial: data.trial === true
        }
      };
    }
    return { ok: false, reason: 'verify-failed', status };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

// License activation report: when a backend is configured, the
// bridge posts { kid, fingerprint } and the activation only counts
// when the backend answers OK (it owns the global one-device
// record). Unconfigured → the caller completes a local activation.
async function postActivation(payload, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  const kid = payload && typeof payload.kid === 'string' ? payload.kid : '';
  const fingerprint = payload && typeof payload.fingerprint === 'string' ? payload.fingerprint : '';
  if (!kid || !fingerprint) return { ok: false, reason: 'bad-payload' };
  try {
    const { status, data } = await postJson(
      fetchImpl,
      `${config.baseUrl.replace(/\/+$/, '')}/v1/devices/activate`,
      { kid, fingerprint }
    );
    if (status === 200 && data && data.ok === true) return { ok: true };
    if (status === 409) return { ok: false, reason: 'bound-to-other-device', status };
    return { ok: false, reason: 'activation-rejected', status };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

module.exports = {
  DOOR_A_UNAVAILABLE_MESSAGE,
  doorAState,
  googleAuthUrl,
  sendEmailCode,
  verifyEmailCode,
  postActivation
};
