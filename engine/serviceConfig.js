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
// client secret here and there never will be.
//
// v1.0.3: Google sign-in no longer runs a custom OAuth flow from
// the app (the project's OAuth client is managed elsewhere and
// accepts no app-registered redirects — the v1.0.2 PKCE attempt
// died at Google with redirect_uri_mismatch). Instead the gate
// opens a hosted sign-in page (authPageUrl below) that signs the
// user in with the backend SDK's own Google provider and hands
// the resulting ID token back to the bridge's loopback callback,
// which verifies it via accounts:lookup. No OAuth client ID is
// needed anywhere in the app any more.

const SERVICE_CONFIG = {
  serviceName: 'Meridian',
  apiKey: 'AIzaSyC7Z3jXrquVsDKFGTK9tx8DpmWEnM4bHls',
  authDomain: 'arcane-airport-k5xj8.firebaseapp.com',
  projectId: 'arcane-airport-k5xj8',
  databaseId: 'ai-studio-dfd8a1b1-c711-4940-bbbe-e0b8e9c8fa50',
  // v1.0.4: the sign-in page moved OUT of the panel's site into
  // its own tiny standalone home (its own repo, its own domain),
  // so no panel/backend address ever appears in the sign-in
  // flow. PLANNED domain below — MK swaps in the real domain
  // here (this one line) once it is live, before shipping.
  authPageUrl: 'https://meridian-entry.vercel.app/auth.html'
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
