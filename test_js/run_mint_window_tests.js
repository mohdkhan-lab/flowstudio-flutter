'use strict';

// v2.48.31 (MINT-WINDOW): the pure mint-window logic in
// engine/mintWindow.js — request sanitizing (query VALUES must
// never survive), the response-carries-file-url detector, and
// the click→sighting counting window — plus the NetworkCapture
// mint-watch wiring (records only while the watch is on, and
// the carries-url callback dedupes per watch).
// Usage: node test_js/run_mint_window_tests.js

const {
  FILE_URL_MARKER,
  DEFAULT_WINDOW_CAP,
  sanitizeRequestEntry,
  responseCarriesFileUrl,
  createMintWindow
} = require('../engine/mintWindow');
const { NetworkCapture } = require('../engine/networkCapture');

let passed = 0;
let failed = 0;
function eq(name, got, want) {
  if (got === want) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}
function ok(name, cond) {
  eq(name, !!cond, true);
}

// --- sanitizeRequestEntry: safe shape only ---
{
  eq('MINT marker is the CDN host', FILE_URL_MARKER, 'flow-content.google');

  const e1 = sanitizeRequestEntry({
    method: 'post',
    url: 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=abc123&bl=boq_secretvalue',
    at: 1234
  });
  eq('MINT method uppercased', e1.method, 'POST');
  eq('MINT host extracted', e1.host, 'flow.google.com');
  ok('MINT plain path segments survive', e1.path.includes('batchexecute'));
  ok('MINT query keys are listed', e1.path.includes('rpcids') && e1.path.includes('bl'));
  ok('MINT query VALUES never appear', !e1.path.includes('abc123') && !e1.path.includes('boq_secretvalue'));
  eq('MINT timestamp kept', e1.at, 1234);

  const e2 = sanitizeRequestEntry({
    method: 'GET',
    url: 'https://lh3.googleusercontent.com/asb/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789=s0?sig=zzz',
    at: 5
  });
  ok('MINT token-ish segment is starred', e2.path.includes('*') && !e2.path.includes('AbCdEfGh'));
  ok('MINT signature value never appears', !e2.path.includes('zzz'));

  eq('MINT garbage URL is null', sanitizeRequestEntry({ method: 'GET', url: 'not a url' }), null);
  eq('MINT data URL is null', sanitizeRequestEntry({ method: 'GET', url: 'data:text/plain;base64,AAAA' }), null);
  eq('MINT missing URL is null', sanitizeRequestEntry({ method: 'GET' }), null);
  eq('MINT null input is null', sanitizeRequestEntry(null), null);

  const e3 = sanitizeRequestEntry({ url: 'https://flow-content.google/video/xyz' });
  eq('MINT default method is GET', e3.method, 'GET');
  eq('MINT default timestamp is 0', e3.at, 0);
}

// --- responseCarriesFileUrl: haan/na only, never the URL ---
{
  ok('CARRIES location header hit',
    responseCarriesFileUrl({ location: 'https://flow-content.google/video/abc?sig=x' }));
  eq('CARRIES location header miss',
    responseCarriesFileUrl({ location: 'https://example.com/video/abc' }), false);
  ok('CARRIES JSON body hit',
    responseCarriesFileUrl({ bodyText: '{"mediaUrl":"https://flow-content.google/video/abc?sig=x"}' }));
  ok('CARRIES escaped JSON body hit',
    responseCarriesFileUrl({ bodyText: '"https:\\/\\/flow-content.google\\/video\\/abc"' }));
  ok('CARRIES Buffer body hit',
    responseCarriesFileUrl({ bodyText: Buffer.from('prefix flow-content.google/video/x suffix', 'utf8') }));
  eq('CARRIES preview host is NOT the file host',
    responseCarriesFileUrl({ bodyText: 'https://rr2---sn-abc.googlevideo.com/videoplayback?x=1' }), false);
  eq('CARRIES tile link host is NOT the file host',
    responseCarriesFileUrl({ bodyText: 'https://flow.google.com/asb/xyz' }), false);
  eq('CARRIES empty input is false', responseCarriesFileUrl({}), false);
  eq('CARRIES null input is false', responseCarriesFileUrl(null), false);
  eq('CARRIES empty body is false', responseCarriesFileUrl({ bodyText: '' }), false);
}

// --- createMintWindow: counting discipline ---
{
  eq('WINDOW default cap', DEFAULT_WINDOW_CAP, 40);
  const w = createMintWindow({ cap: 3 });
  const entry = { method: 'GET', host: 'h', path: '/p', at: 1 };

  eq('WINDOW closed window ignores requests', w.noteRequest(entry), null);
  eq('WINDOW closed window has no sighting', w.noteSighting(10), null);

  w.open(1000);
  ok('WINDOW open reports open', w.isOpen());
  eq('WINDOW request 1 is loggable', w.noteRequest(entry), entry);
  eq('WINDOW request 2 is loggable', w.noteRequest(entry), entry);
  eq('WINDOW request 3 is loggable', w.noteRequest(entry), entry);
  eq('WINDOW request 4 announces the cap once', w.noteRequest(entry), 'cap');
  eq('WINDOW request 5 is silent', w.noteRequest(entry), null);
  eq('WINDOW count keeps rising past the cap', w.requestCount(), 5);

  const s = w.noteSighting(2500);
  eq('WINDOW sighting carries the click time', s.clickAt, 1000);
  eq('WINDOW sighting carries its own time', s.sightingAt, 2500);
  eq('WINDOW sighting counts ALL window requests', s.requestsBefore, 5);
  eq('WINDOW second sighting is null', w.noteSighting(2600), null);
  eq('WINDOW requests after sighting are ignored', w.noteRequest(entry), null);
  eq('WINDOW closed after sighting', w.isOpen(), false);

  // Reopening (the next download round) resets the count.
  w.open(5000);
  eq('WINDOW reopened count restarts', w.requestCount(), 0);
  eq('WINDOW reopened request is loggable', w.noteRequest(entry), entry);
}

// --- NetworkCapture mint-watch wiring ---
{
  let reqSeen = 0;
  let carriesSeen = 0;
  const nc = new NetworkCapture({
    onMintRequest: () => { reqSeen++; },
    onMintCarriesUrl: () => { carriesSeen++; }
  });

  // Watch OFF: nothing is recorded, no callbacks fire.
  nc._noteMintRequest({ method: 'GET', url: 'https://flow.google.com/x?sig=secret', at: 100 });
  eq('CAPTURE watch off records nothing', nc.mintRequests.length, 0);
  eq('CAPTURE watch off fires no request callback', reqSeen, 0);

  // Watch ON: sanitized entries land in the ring; values never do.
  nc.setMintWatch(true);
  nc._noteMintRequest({ method: 'POST', url: 'https://flow.google.com/data/batchexecute?rpcids=zz&sig=topsecret', at: 1000 });
  eq('CAPTURE watch on records one entry', nc.mintRequests.length, 1);
  eq('CAPTURE request callback fired', reqSeen, 1);
  const rec = nc.mintRequests[0];
  eq('CAPTURE recorded method', rec.method, 'POST');
  eq('CAPTURE recorded host', rec.host, 'flow.google.com');
  ok('CAPTURE recorded path has keys only', rec.path.includes('rpcids') && !rec.path.includes('topsecret') && !rec.path.includes('zz'));
  eq('CAPTURE since filter includes the entry', nc.mintRequestsSince(999).length, 1);
  eq('CAPTURE since filter excludes older', nc.mintRequestsSince(1001).length, 0);

  // Carries-url callback dedupes per (method|host|path) per watch.
  const info = { method: 'POST', host: 'flow.google.com', path: '/data/batchexecute?rpcids' };
  nc._noteMintCarries(info);
  nc._noteMintCarries(info);
  eq('CAPTURE carries callback deduped', carriesSeen, 1);
  nc._noteMintCarries({ method: 'POST', host: 'flow.google.com', path: '/other' });
  eq('CAPTURE carries new shape fires again', carriesSeen, 2);

  // Turning the watch off and on again resets ring + dedupe.
  nc.setMintWatch(false);
  nc._noteMintCarries(info);
  eq('CAPTURE carries silent while watch off', carriesSeen, 2);
  nc.setMintWatch(true);
  eq('CAPTURE ring reset on re-arm', nc.mintRequests.length, 0);
  nc._noteMintCarries(info);
  eq('CAPTURE carries fires again on a fresh watch', carriesSeen, 3);
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed ? 1 : 0);
