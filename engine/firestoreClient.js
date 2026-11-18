'use strict';

// PUBLIC v1.0.2 — a small Firestore REST helper (Phase 2 backend).
//
// Base: https://firestore.googleapis.com/v1/projects/<projectId>/
//         databases/<databaseId>/documents
// The project has NO "(default)" database; the named database in
// engine/serviceConfig.js is the one every path below uses.
//
// Auth is a Bearer token (a Firebase ID token — an account session's
// or an anonymous session's). Values use Firestore's typed encoding:
//   string  -> { stringValue }
//   integer -> { integerValue: '<decimal string>' }
//   float   -> { doubleValue }
//   boolean -> { booleanValue }
//   Date / ISO string marked as a timestamp (see encodeFields'
//   caller: timestamps are passed as Date instances or via
//   timestampValue objects built by timestampValue())
//   null    -> { nullValue: null }
//
// Every call takes an injectable fetchImpl (opts.fetchImpl) so the
// request shapes are unit-testable with a fake fetch, exactly like
// engine/authClient.js.

const { SERVICE_CONFIG, isServiceConfigured } = require('./serviceConfig');

function resolveFetch(opts) {
  if (opts && typeof opts.fetchImpl === 'function') return opts.fetchImpl;
  return typeof fetch === 'function' ? fetch : null;
}

function resolveConfig(opts) {
  return (opts && opts.config) || SERVICE_CONFIG;
}

function firestoreBase(config) {
  const cfg = config || SERVICE_CONFIG;
  return `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/${cfg.databaseId}/documents`;
}

function documentName(config, docPath) {
  const cfg = config || SERVICE_CONFIG;
  return `projects/${cfg.projectId}/databases/${cfg.databaseId}/documents/${docPath}`;
}

// Wrap an ISO string as a Firestore timestamp value.
function timestampValue(iso) {
  return { timestampValue: typeof iso === 'string' ? iso : new Date(iso).toISOString() };
}

function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  // A pre-encoded value (e.g. from timestampValue()) passes through.
  if (typeof value === 'object' &&
      ('stringValue' in value || 'integerValue' in value || 'doubleValue' in value ||
       'booleanValue' in value || 'timestampValue' in value || 'nullValue' in value)) {
    return value;
  }
  return { stringValue: String(value) };
}

function encodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = encodeValue(v);
  return out;
}

function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}

async function callFirestore(fetchImpl, method, url, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetchImpl(url, init);
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  return { status: res && typeof res.status === 'number' ? res.status : 0, data };
}

// GET one document. Verdicts:
//   { ok: true, exists: true, fields }  — decoded plain values
//   { ok: true, exists: false }         — 404: no such document
//   { ok: false, reason, status }       — 'not-configured' |
//     'network-unavailable' | 'network-error' | 'get-failed'
async function getDocument(docPath, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  const token = opts && typeof opts.token === 'string' ? opts.token : '';
  try {
    const { status, data } = await callFirestore(
      fetchImpl, 'GET', `${firestoreBase(config)}/${docPath}`, token);
    if (status === 404) return { ok: true, exists: false };
    if (status === 200 && data) {
      return { ok: true, exists: true, fields: decodeFields(data.fields) };
    }
    return { ok: false, reason: 'get-failed', status };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

// PATCH one document with an update mask (merge semantics: only
// the named fields are written; the document is created when it
// does not exist yet). Verdicts mirror getDocument's.
async function patchDocument(docPath, fields, opts) {
  const config = resolveConfig(opts);
  if (!isServiceConfigured(config)) return { ok: false, reason: 'not-configured' };
  const fetchImpl = resolveFetch(opts);
  if (!fetchImpl) return { ok: false, reason: 'network-unavailable' };
  const token = opts && typeof opts.token === 'string' ? opts.token : '';
  const names = Object.keys(fields || {});
  const params = new URLSearchParams();
  for (const name of names) params.append('updateMask.fieldPaths', name);
  const url = `${firestoreBase(config)}/${docPath}?${params.toString()}`;
  const body = { name: documentName(config, docPath), fields: encodeFields(fields) };
  try {
    const { status, data } = await callFirestore(fetchImpl, 'PATCH', url, token, body);
    if (status === 200) {
      return { ok: true, exists: true, fields: decodeFields(data && data.fields) };
    }
    return { ok: false, reason: 'patch-failed', status };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

module.exports = {
  firestoreBase,
  documentName,
  timestampValue,
  encodeValue,
  encodeFields,
  decodeValue,
  decodeFields,
  getDocument,
  patchDocument
};
