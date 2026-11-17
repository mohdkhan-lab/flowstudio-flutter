'use strict';

/**
 * FlowStudio Lite — media token (v2.48.117, EXACT-DOWNLOAD METHOD).
 *
 * WHY THIS MODULE EXISTS (the rename defect): a tile's identity in
 * the engine used to be its aria-label — Flow's auto-title, which
 * Flow REPLACES once the render lands (design:
 * ~/workspace/fs-tmp/exact-download-method.md). Word-scoring that
 * title against the prompt bound NEIGHBOUR tiles in the W9 run
 * (frame-verified: file "31" held scene 37's video, "32" held 36,
 * "36" held 38) and reported "not created" for a tile standing in
 * the grid. The media URLs a tile carries do NOT rename: the poster
 * <img> src and the <video> currentSrc point at the media itself,
 * and their per-media identifier survives Flow's retitling.
 *
 * A TOKEN is that identifier, reduced to its stable part:
 *   - googleusercontent / flow-content URLs: the URL PATH only
 *     (the signed query — sig/expire/etc. — rotates and is dropped
 *     whole). Path shape on Flow media: /videoplayback/<id> or
 *     /<id>; the id segment is case-sensitive and kept verbatim.
 *   - googlevideo URLs: the host rotates (rr2---sn-…) and the path
 *     is the constant /videoplayback, so the identity is the `id`
 *     query parameter (stable across itag/expire changes for the
 *     same media); the token is prefixed 'gv:' so it can never
 *     collide with a path token.
 *   - blob: URLs and anything else: null — a blob lives only in
 *     this page session and identifies nothing across a reload.
 *
 * Pure functions only — no DOM, no network. The page-side reads
 * (which <img>/<video> attributes to read) live in flowAutomation;
 * everything comparable lands here as a plain string.
 */

function _parse(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  if (!u || u.startsWith('blob:') || u.startsWith('data:')) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function _isGoogleVideoHost(host) {
  return host === 'googlevideo.com' || host.endsWith('.googlevideo.com');
}

function _isPathTokenHost(host) {
  return host === 'googleusercontent.com'
    || host.endsWith('.googleusercontent.com')
    || host === 'flow-content.google'
    || host.endsWith('.flow-content.google');
}

/**
 * The stable per-media token for a media URL, or null when the URL
 * carries no reusable identity. The SAME media yields the SAME
 * token across differing signed queries (poster sizes, expires,
 * itags) — that stability is the entire point, and the X121 pins
 * hold it against the fixture shapes the codebase already uses.
 */
function mediaTokenFromUrl(url) {
  const parsed = _parse(url);
  if (!parsed) return null;
  const host = (parsed.hostname || '').toLowerCase();
  if (_isGoogleVideoHost(host)) {
    const id = parsed.searchParams.get('id');
    if (id && id.length >= 1) return `gv:${id}`;
    return null;
  }
  if (_isPathTokenHost(host)) {
    const path = (parsed.pathname || '').replace(/^\/+/, '');
    // A bare endpoint with no media segment identifies nothing.
    if (!path || path === 'videoplayback' || path.length < 3) return null;
    return path;
  }
  return null;
}

/** Poster identity: a tile's <img> src token (path-token hosts). */
function posterTokenFromUrl(url) {
  return mediaTokenFromUrl(url);
}

/** Video identity: a tile's <video> src/currentSrc token. */
function videoTokenFromUrl(url) {
  return mediaTokenFromUrl(url);
}

/**
 * Do two URLs name the same media? True only when BOTH reduce to
 * the same non-null token — two junk URLs are never "the same".
 */
function sameMediaToken(urlA, urlB) {
  const a = mediaTokenFromUrl(urlA);
  if (!a) return false;
  return a === mediaTokenFromUrl(urlB);
}

module.exports = {
  mediaTokenFromUrl,
  posterTokenFromUrl,
  videoTokenFromUrl,
  sameMediaToken
};
