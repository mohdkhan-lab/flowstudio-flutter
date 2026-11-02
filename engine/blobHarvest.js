'use strict';

// v2.48.26 (FAST-DL — "turant download"): the pure decision layer
// for harvesting a finished video's bytes from INSIDE the Flow
// page, the moment its render completes.
//
// Why this exists (E1, proven on the owner's PC 2026-11-02): the
// real download is a blob: URL minted inside the page — the video
// bytes already live in the page's memory before any Download
// click, and Chrome's download manager only writes them to disk.
// A blob: URL cannot be fetched from Node, so the only "backend"
// route left is to take the bytes out of the page directly. This
// module holds (a) the in-page hook source that records video
// blobs into window.__mkBlobRegistry, and (b) the pure candidate
// selection + chunk-plan helpers the engine uses — all unit-tested
// offline. No I/O, no timers, never throws on garbage input.

const CHUNK_BYTES = 512 * 1024;
const REGISTRY_CAP = 10;
// Selection floor: a real generated video is hundreds of KB; the
// final word is always the content gate + ffprobe in the engine.
const MIN_VIDEO_BLOB_BYTES = 100000;
// Untyped blobs are only trusted at/above this size (mirrors the
// hook's recording rule for mp4-ish/empty-typed blobs).
const BIG_UNTYPED_BYTES = 200000;
// A blob may be created a few seconds BEFORE the render monitor
// notices completion (the tile player loads as soon as Flow is
// done) — the freshness cutoff keeps this much slack.
const RENDER_COMPLETE_SLACK_MS = 20000;
// A live task anchors freshness at its render start. An old task
// (download-retry / recovery, long after submission) may only use
// blobs the page produced recently, while its own tile was being
// primed — never a stale registry full of other videos.
const LIVE_TASK_WINDOW_MS = 10 * 60 * 1000;
const RECENT_WINDOW_MS = 180000;

/**
 * Does this registry metadata describe a plausible video blob?
 * Typed video/* at any plausible size; untyped / mp4-ish /
 * octet-stream only when big. Images and pages never qualify.
 */
function isVideoBlobMeta(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const size = Number(entry.size) || 0;
  if (size < MIN_VIDEO_BLOB_BYTES) return false;
  const type = String(entry.type || '').toLowerCase();
  if (type.startsWith('video/')) return true;
  if (type === '' || type.includes('mp4') || type.includes('octet-stream')) {
    return size >= BIG_UNTYPED_BYTES;
  }
  return false;
}

/** Stable identity of one registry entry (for consumed tracking). */
function candidateKey(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return `${entry.url || ''}|${Number(entry.size) || 0}|${Number(entry.ts) || 0}`;
}

/**
 * The earliest creation time a blob may have and still count as
 * THIS task's video. See the constants above for the reasoning.
 */
function freshnessCutoff(opts) {
  const o = opts || {};
  const nowTs = Number(o.nowTs) || Date.now();
  if (o.renderCompleteTs) return Number(o.renderCompleteTs) - RENDER_COMPLETE_SLACK_MS;
  const start = Number(o.renderStartTs) || 0;
  if (start && (nowTs - start) <= LIVE_TASK_WINDOW_MS) return start;
  return nowTs - RECENT_WINDOW_MS;
}

function consumedSet(consumedKeys) {
  if (!consumedKeys) return new Set();
  if (consumedKeys instanceof Set) return consumedKeys;
  try { return new Set(consumedKeys); } catch (e) { return new Set(); }
}

/**
 * Pick the one registry entry that is this task's video, or null.
 *
 * opts: {
 *   renderStartTs,      // task.startTime (submission ≈ render start)
 *   renderCompleteTs,   // when the monitor saw the render finish (optional)
 *   consumedKeys,       // Set/array of candidateKey() already used
 *   nowTs,              // injectable clock for tests
 *   expectedSize        // exact byte size if known (optional)
 * }
 *
 * Ranking: an exact expected-size match first; then (when the
 * render-completion time is known) the blob created closest to
 * that moment — in a burst, each video's bytes appear within
 * seconds of its own completion, so proximity is the strongest
 * identity signal after the size match; then the largest blob;
 * then the newest. A candidate must be fresh (see freshnessCutoff)
 * and unconsumed — another task's video is never picked on purpose.
 */
function selectCandidate(entries, opts) {
  try {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const o = opts || {};
    const nowTs = Number(o.nowTs) || Date.now();
    const cutoff = freshnessCutoff(o);
    const used = consumedSet(o.consumedKeys);
    const expectedSize = Number(o.expectedSize) || 0;
    const completeTs = Number(o.renderCompleteTs) || 0;
    const fresh = [];
    for (const e of entries) {
      if (!isVideoBlobMeta(e)) continue;
      const ts = Number(e.ts) || 0;
      if (ts < cutoff) continue;
      if (ts > nowTs + 5000) continue;
      if (used.has(candidateKey(e))) continue;
      fresh.push(e);
    }
    if (fresh.length === 0) return null;
    const scored = fresh.map((e) => ({
      e,
      exact: expectedSize && Number(e.size) === expectedSize ? 1 : 0,
      prox: completeTs ? Math.abs((Number(e.ts) || 0) - completeTs) : 0,
    }));
    scored.sort((a, b) =>
      (b.exact - a.exact) ||
      (a.prox - b.prox) ||
      ((Number(b.e.size) || 0) - (Number(a.e.size) || 0)) ||
      ((Number(b.e.ts) || 0) - (Number(a.e.ts) || 0)));
    return scored[0].e;
  } catch (e) {
    return null;
  }
}

/**
 * Plan the chunked read-out of a blob: exact, contiguous,
 * non-overlapping [start, end) slices of chunkSize (default
 * CHUNK_BYTES). A zero/invalid size yields an empty plan.
 */
function planChunks(totalBytes, chunkSize) {
  const total = Math.floor(Number(totalBytes) || 0);
  if (!Number.isFinite(total) || total <= 0) return [];
  const size = (Number(chunkSize) > 0) ? Math.floor(Number(chunkSize)) : CHUNK_BYTES;
  const out = [];
  for (let start = 0; start < total; start += size) {
    out.push({ start, end: Math.min(start + size, total) });
  }
  return out;
}

// ------------------------------------------------------------------
// The in-page hook. Installed via page.evaluateOnNewDocument BEFORE
// any Flow page script runs. It only OBSERVES: createObjectURL
// blobs, fetch responses and XHR responses that look like video
// are cloned into window.__mkBlobRegistry (metadata + the Blob
// itself, capped at the last REGISTRY_CAP entries, nothing is ever
// revoked). Every wrapper calls the original first and returns its
// result untouched; every step is try/caught, so a page whose APIs
// differ simply ends up with an empty registry and the engine's
// existing download routes run exactly as before.
// ------------------------------------------------------------------
const HOOK_SOURCE = `(function () {
  try {
    if (window.__mkBlobHookInstalled) return;
    window.__mkBlobHookInstalled = true;
    var reg = window.__mkBlobRegistry || (window.__mkBlobRegistry = []);
    var CAP = ${REGISTRY_CAP};
    var MIN_BIG = ${BIG_UNTYPED_BYTES};
    function note(blob, url, via) {
      try {
        if (!blob || typeof blob.size !== 'number') return;
        var type = (blob.type || '').toLowerCase();
        var size = blob.size || 0;
        var isVideoType = type.indexOf('video/') === 0;
        var isBigMaybe = size >= MIN_BIG && (type === '' || type.indexOf('mp4') >= 0 || type.indexOf('octet-stream') >= 0);
        if (!isVideoType && !isBigMaybe) return;
        reg.push({ blob: blob, url: url || '', type: type, size: size, ts: Date.now(), via: via || '' });
        while (reg.length > CAP) reg.shift();
      } catch (e) {}
    }
    function worthCloning(url, ct) {
      try {
        var u = String(url || '');
        var c = String(ct || '').toLowerCase();
        if (c.indexOf('video/') === 0) return true;
        if (/\\.(mp4|webm)(\\?|$)/i.test(u)) return true;
        if (u.indexOf('/asb/') >= 0 && c.indexOf('text/html') !== 0 && c.indexOf('image/') !== 0) return true;
        return false;
      } catch (e) { return false; }
    }
    try {
      var origCreateObjectURL = (typeof URL !== 'undefined') ? URL.createObjectURL : null;
      if (typeof origCreateObjectURL === 'function') {
        URL.createObjectURL = function (obj) {
          var u = origCreateObjectURL.apply(URL, arguments);
          try {
            if (obj && typeof Blob !== 'undefined' && obj instanceof Blob) note(obj, u, 'createObjectURL');
          } catch (e) {}
          return u;
        };
      }
    } catch (e) {}
    try {
      if (typeof window.fetch === 'function') {
        var origFetch = window.fetch;
        window.fetch = function () {
          var p = origFetch.apply(this, arguments);
          try {
            if (p && typeof p.then === 'function') {
              p.then(function (resp) {
                try {
                  if (!resp || typeof resp.clone !== 'function') return;
                  var ct = '';
                  try { ct = (resp.headers && resp.headers.get) ? (resp.headers.get('content-type') || '') : ''; } catch (e) {}
                  var u = resp.url || '';
                  if (!worthCloning(u, ct)) return;
                  resp.clone().blob().then(function (b) { note(b, u, 'fetch'); }).catch(function () {});
                } catch (e) {}
              }).catch(function () {});
            }
          } catch (e) {}
          return p;
        };
      }
    } catch (e) {}
    try {
      var XHR = window.XMLHttpRequest;
      if (XHR && XHR.prototype) {
        var origOpen = XHR.prototype.open;
        XHR.prototype.open = function (method, url) {
          try { this.__mkUrl = url; } catch (e) {}
          return origOpen.apply(this, arguments);
        };
        var origSend = XHR.prototype.send;
        XHR.prototype.send = function () {
          var self = this;
          try {
            self.addEventListener('load', function () {
              try {
                var ct = '';
                try { ct = self.getResponseHeader('content-type') || ''; } catch (e) {}
                var u = self.responseURL || self.__mkUrl || '';
                if (!worthCloning(u, ct)) return;
                if (self.responseType === 'blob' && self.response) { note(self.response, u, 'xhr'); return; }
                if (self.responseType === 'arraybuffer' && self.response && self.response.byteLength >= MIN_BIG) {
                  note(new Blob([self.response], { type: ct || '' }), u, 'xhr');
                }
              } catch (e) {}
            });
          } catch (e) {}
          return origSend.apply(this, arguments);
        };
      }
    } catch (e) {}
  } catch (e) {}
})();`;

module.exports = {
  CHUNK_BYTES,
  REGISTRY_CAP,
  MIN_VIDEO_BLOB_BYTES,
  BIG_UNTYPED_BYTES,
  RENDER_COMPLETE_SLACK_MS,
  RECENT_WINDOW_MS,
  isVideoBlobMeta,
  candidateKey,
  freshnessCutoff,
  selectCandidate,
  planChunks,
  HOOK_SOURCE,
};
