'use strict';

// PUBLIC edition — entry-gate service configuration.
//
// This is the ONE place that names the account backend the public
// edition talks to (Door A sign-in). The service name is deliberately
// generic: it is a plumbing label, not a product surface.
//
// Phase 2 (v1.0.2): the backend is Firebase (Auth + Firestore) and
// it is LIVE. Every value below is public-by-design — a Firebase
// web config identifies the project, it is not a secret; all real
// protection lives in the backend's own access rules. There is NO
// client secret here and there never will be: the Google sign-in
// flow is PKCE, which needs none. Door A (Google + email/password
// sign-in) is therefore configured and the gate offers it for real.

const SERVICE_CONFIG = {
  serviceName: 'Meridian',
  apiKey: 'AIzaSyC7Z3jXrquVsDKFGTK9tx8DpmWEnM4bHls',
  authDomain: 'arcane-airport-k5xj8.firebaseapp.com',
  projectId: 'arcane-airport-k5xj8',
  databaseId: 'ai-studio-dfd8a1b1-c711-4940-bbbe-e0b8e9c8fa50',
  googleClientId: '76046710811-72m4691j2j4m6ngleri075ebbl8r6tg0.apps.googleusercontent.com'
};

function isServiceConfigured(config) {
  const cfg = config || SERVICE_CONFIG;
  return !!(
    cfg &&
    typeof cfg.apiKey === 'string' && cfg.apiKey.trim().length > 0 &&
    typeof cfg.projectId === 'string' && cfg.projectId.trim().length > 0
  );
}

module.exports = {
  SERVICE_CONFIG,
  isServiceConfigured
};
