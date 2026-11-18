'use strict';

// PUBLIC v1.0.0 — entry-gate service configuration.
//
// This is the ONE place that names the account backend the public
// edition talks to (Door A sign-in + license activation checks).
// The service name is deliberately generic: it is a plumbing label,
// not a product surface.
//
// Phase 1 ships with NO backend configured (baseUrl empty): Door A
// (account sign-in) is honestly unavailable and the gate offers the
// license-key door only. When the backend is deployed, fill baseUrl
// (and projectRef if the deployment uses one) and Door A lights up
// with no other code change.

const SERVICE_CONFIG = {
  serviceName: 'Meridian',
  baseUrl: '',
  projectRef: ''
};

function isServiceConfigured(config) {
  const cfg = config || SERVICE_CONFIG;
  return !!(cfg && typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim().length > 0);
}

module.exports = {
  SERVICE_CONFIG,
  isServiceConfigured
};
