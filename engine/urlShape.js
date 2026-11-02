'use strict';

// v2.48.25 (E1 — observe-only): describe a URL's SHAPE without ever
// exposing the URL itself. Download URLs from Chrome's download
// manager are signed: the full URL, any query VALUE and any long
// ID-like path segment must never land in a log. This helper returns
// only: scheme, host, a redacted path pattern (ID-like segments
// replaced by ':seg', file extension kept), the query KEY names
// (never values), and the total URL length.
//
// Pure and defensive: any input — garbage, blob:, data:, empty —
// yields a shape object; it never throws and never echoes raw input.

function isIdLikeSegment(seg) {
  if (!seg) return false;
  // Short, purely alphabetic segments ('asb', 'ogw', 'a', 'video')
  // are readable path words and are kept. Anything long, or mixing
  // letters with digits / '-' / '_' / '.', is treated as an ID.
  if (seg.length <= 8 && /^[a-zA-Z]+$/.test(seg)) return false;
  if (seg.length >= 10) return true;
  return /[0-9]/.test(seg) || seg.includes('-') || seg.includes('_');
}

function redactSegment(seg) {
  if (!seg) return seg;
  // Keep a short file extension on the last segment ('xxxx.mp4' ->
  // ':seg.mp4') so the shape still shows what kind of file it was.
  const dot = seg.lastIndexOf('.');
  if (dot > 0 && dot < seg.length - 1) {
    const ext = seg.slice(dot + 1);
    const stem = seg.slice(0, dot);
    if (/^[a-zA-Z0-9]{1,5}$/.test(ext)) {
      return isIdLikeSegment(stem) ? `:seg.${ext.toLowerCase()}` : `${stem}.${ext.toLowerCase()}`;
    }
  }
  return isIdLikeSegment(seg) ? ':seg' : seg;
}

function describeUrlShape(rawUrl) {
  const out = {
    scheme: 'unknown',
    host: '',
    pathPattern: '',
    queryKeys: [],
    urlLength: 0,
  };
  try {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) return out;
    out.urlLength = rawUrl.length;
    const colon = rawUrl.indexOf(':');
    if (colon <= 0) { out.scheme = 'invalid'; return out; }
    out.scheme = rawUrl.slice(0, colon).toLowerCase();

    if (out.scheme === 'blob') {
      // blob:<origin>/<uuid> — describe the inner origin's shape and
      // flag the blob wrapper; the uuid is never echoed.
      const inner = rawUrl.slice(colon + 1);
      const innerShape = describeUrlShape(inner);
      out.host = innerShape.host;
      out.pathPattern = 'blob:' + (innerShape.pathPattern || '/:seg');
      out.queryKeys = innerShape.queryKeys;
      return out;
    }
    if (out.scheme === 'data') {
      out.pathPattern = 'data:';
      return out;
    }

    let u;
    try { u = new URL(rawUrl); } catch (e) { out.scheme = 'invalid'; return out; }
    out.host = u.hostname || '';
    const segs = (u.pathname || '/').split('/').filter((s) => s.length > 0);
    out.pathPattern = '/' + segs.map(redactSegment).join('/');
    const keys = [];
    try {
      for (const k of u.searchParams.keys()) {
        if (k && !keys.includes(k)) keys.push(k);
      }
    } catch (e) {}
    out.queryKeys = keys;
    return out;
  } catch (e) {
    return out;
  }
}

function formatUrlShape(shape) {
  const s = shape || {};
  return 'scheme=' + (s.scheme || 'unknown')
    + ' host=' + (s.host || '(none)')
    + ' path=' + (s.pathPattern || '(none)')
    + ' queryKeys=[' + ((s.queryKeys || []).join(',')) + ']'
    + ' len=' + (s.urlLength || 0);
}

module.exports = { describeUrlShape, formatUrlShape, isIdLikeSegment };
