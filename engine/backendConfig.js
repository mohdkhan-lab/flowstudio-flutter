'use strict';

// PUBLIC v1.0.13 — backend-config reader.
//
// The operator's panel writes three kinds of backend state the
// app is meant to honour — flags/maintenance, flags/agent_mode,
// flags/announcements + the announcements collection — but no
// app version ever read them. This module is that one reader:
//
//   fetchBackendConfig(opts) →
//     { ok: true,
//       maintenance: bool,             // flags/maintenance.appMaintenance
//       maintenanceMessage: string,    // flags/maintenance.message
//       agentModeEnabled: bool,        // flags/agent_mode.enabled !== false
//       announcement: { title, body } | null }
//     { ok: false, reason }            — no token / backend unreachable
//
// The announcement is the newest ACTIVE announcements doc whose
// audience is the app (a missing audience counts as app — the
// panel's own "current announcement" logic treats it the same),
// and only when flags/announcements is not switched off.
//
// Reads ride any signed-in session (the rules allow signed-in
// reads on flags + announcements): the pending account session's
// token when the caller passes one (opts.token), otherwise this
// module's own cached ANONYMOUS session. Every default is the
// app's pre-1.0.13 behaviour — no maintenance, Agent Mode on, no
// announcement — so a failed fetch changes nothing.

const { isServiceConfigured, SERVICE_CONFIG } = require('./serviceConfig');
const firestore = require('./firestoreClient');
const authClient = require('./authClient');

const DEFAULT_MAINTENANCE_MESSAGE =
  'We are briefly down for maintenance. Please try again shortly.';

// The anonymous READ session, cached per process (same pattern
// as reportClient's reporting session, kept separate so the two
// never wedge each other). Tests may inject opts.anonymousSession.
let cachedReadSession = null;

async function ensureReadSession(opts) {
  if (opts && opts.anonymousSession && opts.anonymousSession.idToken) {
    return { ok: true, session: opts.anonymousSession };
  }
  const nowMs = Date.now();
  if (cachedReadSession && cachedReadSession.expiresAt > nowMs) {
    return { ok: true, session: cachedReadSession };
  }
  if (cachedReadSession && cachedReadSession.refreshToken) {
    const refreshed = await authClient.refreshSession(cachedReadSession.refreshToken, opts);
    if (refreshed.ok) {
      cachedReadSession = refreshed.session;
      return { ok: true, session: cachedReadSession };
    }
    cachedReadSession = null;
  }
  const anon = await authClient.signInAnonymously(opts);
  if (!anon.ok) return anon;
  cachedReadSession = anon.session;
  return { ok: true, session: cachedReadSession };
}

function resetReadSessionCache() {
  cachedReadSession = null;
}

// Pure: choose the announcement the app should show from the
// decoded announcements docs ([{ id, fields }]).
function pickAnnouncement(docs) {
  const list = Array.isArray(docs) ? docs : [];
  const eligible = list.filter((d) => {
    const f = (d && d.fields) || {};
    if (f.active !== true) return false;
    const audience = typeof f.audience === 'string' ? f.audience : '';
    return audience === '' || audience === 'app';
  });
  eligible.sort((a, b) => {
    const ca = a.fields && typeof a.fields.createdAt === 'string' ? a.fields.createdAt : '';
    const cb = b.fields && typeof b.fields.createdAt === 'string' ? b.fields.createdAt : '';
    return cb < ca ? -1 : cb > ca ? 1 : 0;
  });
  if (!eligible.length) return null;
  const f = eligible[0].fields || {};
  const title = typeof f.title === 'string' ? f.title : '';
  const body = typeof f.body === 'string' ? f.body : '';
  if (!title && !body) return null;
  return { title, body };
}

// Pure: fold the four reads into the app's backend state. Any
// missing piece falls back to the pre-1.0.13 behaviour.
function normalizeBackendConfig(parts) {
  const p = parts || {};
  const maintenanceFields = p.maintenanceFields || null;
  const agentModeFields = p.agentModeFields || null;
  const announcementsFlagFields = p.announcementsFlagFields || null;
  const maintenance = !!(maintenanceFields && maintenanceFields.appMaintenance === true);
  const maintenanceMessage = maintenanceFields &&
    typeof maintenanceFields.message === 'string' && maintenanceFields.message.trim()
    ? maintenanceFields.message
    : DEFAULT_MAINTENANCE_MESSAGE;
  const agentModeEnabled = agentModeFields ? agentModeFields.enabled !== false : true;
  const announcementsEnabled = announcementsFlagFields
    ? announcementsFlagFields.enabled !== false : true;
  return {
    maintenance,
    maintenanceMessage,
    agentModeEnabled,
    announcement: announcementsEnabled ? pickAnnouncement(p.announcementDocs) : null
  };
}

async function fetchBackendConfig(opts) {
  const config = (opts && opts.config) || SERVICE_CONFIG;
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  let token = opts && typeof opts.token === 'string' ? opts.token : '';
  if (!token) {
    const anon = await ensureReadSession(opts);
    if (!anon.ok) return { ok: false, reason: anon.reason || 'no-session' };
    token = anon.session.idToken;
  }
  const callOpts = { ...(opts || {}), token };
  const maintenance = await firestore.getDocument('flags/maintenance', callOpts);
  if (!maintenance.ok) return { ok: false, reason: maintenance.reason || 'read-failed' };
  const agentMode = await firestore.getDocument('flags/agent_mode', callOpts);
  const announcementsFlag = await firestore.getDocument('flags/announcements', callOpts);
  const announcements = await firestore.listDocuments('announcements', callOpts);
  return {
    ok: true,
    ...normalizeBackendConfig({
      maintenanceFields: maintenance.exists ? maintenance.fields : null,
      agentModeFields: agentMode.ok && agentMode.exists ? agentMode.fields : null,
      announcementsFlagFields: announcementsFlag.ok && announcementsFlag.exists
        ? announcementsFlag.fields : null,
      announcementDocs: announcements.ok ? announcements.docs : []
    })
  };
}

module.exports = {
  DEFAULT_MAINTENANCE_MESSAGE,
  ensureReadSession,
  resetReadSessionCache,
  pickAnnouncement,
  normalizeBackendConfig,
  fetchBackendConfig
};
