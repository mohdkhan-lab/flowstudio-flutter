'use strict';

// v2.48.13: DIRECT-API POLL — the pure decision layer in
// engine/networkCapture.js decides (a) which API calls count as
// status checks whose request may be replayed, (b) that a generate
// call is NEVER replayable, (c) which headers a replay may carry,
// and (d) that a captured status request becomes the poll template
// for its task and a replayed response binds the media URL through
// the ordinary identity rules.
// Usage: node test_js/run_api_poll_tests.js
const {
  NetworkCapture,
  isStatusApiUrl,
  isGenerateApiUrl,
  pickReplayHeaders
} = require('../engine/networkCapture');

let passed = 0;
let failed = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; } else { failed++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { eq(name, !!cond, true); }

const GW = 'https://aisandbox-pa.googleapis.com/google.internal.labs.aisandbox.proto.flow.v1.FlowService/GetWorkflow';
const LIST = 'https://aisandbox-pa.googleapis.com/google.internal.labs.aisandbox.proto.flow.v1.FlowService/ListUserWorkflows';
const GEN = 'https://aisandbox-pa.googleapis.com/google.internal.labs.aisandbox.proto.flow.v1.FlowService/StreamGenerateContent';
const OTHER = 'https://example.com/google.internal.labs.aisandbox.proto.flow.v1.FlowService/GetWorkflow';

// (a)/(b) URL classification
ok('GetWorkflow is a status URL', isStatusApiUrl(GW));
ok('ListUserWorkflows is a status URL', isStatusApiUrl(LIST));
eq('StreamGenerateContent is NOT a status URL', isStatusApiUrl(GEN), false);
ok('StreamGenerateContent IS the generate URL', isGenerateApiUrl(GEN));
eq('GetWorkflow is not the generate URL', isGenerateApiUrl(GW), false);
eq('non-API host is not a status URL', isStatusApiUrl(OTHER), false);
eq('media URL is not a status URL', isStatusApiUrl('https://lh3.googleusercontent.com/abc'), false);

// (c) header whitelist
eq('pickReplayHeaders keeps whitelist only', pickReplayHeaders({
  'Content-Type': 'application/grpc-web+proto',
  'X-Grpc-Web': '1',
  'Authorization': 'Bearer xyz',
  'Cookie': 'secret=1',
  'Referer': 'https://flow.google.com/',
  'X-Other': 'drop-me'
}), {
  'content-type': 'application/grpc-web+proto',
  'x-grpc-web': '1',
  'authorization': 'Bearer xyz'
});
eq('pickReplayHeaders empty on junk', pickReplayHeaders(null), {});
eq('pickReplayHeaders drops empty values', pickReplayHeaders({ 'x-grpc-web': '' }), {});

// (d) template capture + binding through a replayed response
{
  const cap = new NetworkCapture({});
  const key = 'vid_1000_1';
  cap.beginSubmission(key, 1000);
  const body = Buffer.from(JSON.stringify({ workflowId: 'wf-abc-123', pageSize: 1 }), 'utf8');
  const r = cap.ingestRequest({
    url: GW, method: 'POST',
    headers: { 'content-type': 'application/json', 'cookie': 'nope=1' },
    postDataText: body.toString('utf8'), postDataBuffer: body, at: 1100
  });
  ok('status request records a template for its workflow', (r.templateIds || []).includes('wf-abc-123'));
  const tpl = cap.templateForKey(key);
  ok('templateForKey returns the captured template', !!tpl && tpl.url === GW);
  eq('template carries no cookie header', (tpl && tpl.headers.cookie) || null, null);
  eq('template body preserved', tpl && tpl.body.toString('utf8'), body.toString('utf8'));

  // A replayed response: same workflowId + its media URL in one body.
  const mediaUrl = 'https://lh3.googleusercontent.com/videoplayback/test491-1.mp4';
  const respBody = Buffer.from(JSON.stringify({ workflowId: 'wf-abc-123', media: mediaUrl }), 'utf8');
  cap.ingestResponse({ url: GW, contentType: 'application/json', bodyBuffer: respBody, at: 1200 });
  const bound = cap.urlForKey(key);
  ok('replayed response binds the media URL by workflowId', !!bound && bound.url === mediaUrl && bound.via === 'workflow-id');
}

// Generate request never becomes a template; latest-template fallback works.
{
  const cap = new NetworkCapture({});
  cap.beginSubmission('vid_2000_1', 5000);
  const genBody = Buffer.from(JSON.stringify({ workflowId: 'wf-gen-1' }), 'utf8');
  const rg = cap.ingestRequest({
    url: GEN, method: 'POST', headers: {},
    postDataText: genBody.toString('utf8'), postDataBuffer: genBody, at: 5100
  });
  eq('generate request records no template', (rg.templateIds || []).length, 0);
  eq('no template available yet', cap.templateForKey('vid_2000_1'), null);

  // A project list call (no workflowId of ours in its body) after
  // the submission becomes the fallback template.
  const listBody = Buffer.from(JSON.stringify({ projectId: 'proj-9' }), 'utf8');
  cap.ingestRequest({
    url: LIST, method: 'POST', headers: { 'content-type': 'application/json' },
    postDataText: listBody.toString('utf8'), postDataBuffer: listBody, at: 5200
  });
  const fb = cap.templateForKey('vid_2000_1');
  ok('latest status template is the fallback', !!fb && fb.url === LIST);
}

// A template from BEFORE a submission: offered within the 120s
// shape window (project-load List call, then settings, then
// submit), but NOT when it is far older than the submission.
{
  const cap = new NetworkCapture({});
  const listBody = Buffer.from(JSON.stringify({ projectId: 'old' }), 'utf8');
  cap.ingestRequest({
    url: LIST, method: 'POST', headers: {},
    postDataText: listBody.toString('utf8'), postDataBuffer: listBody, at: 1000
  });
  cap.beginSubmission('vid_3000_1', 61000);
  ok('template within the 120s window is offered', !!cap.templateForKey('vid_3000_1'));
  cap.beginSubmission('vid_3000_2', 400000);
  eq('far-stale template not offered', cap.templateForKey('vid_3000_2'), null);
}

// v2.48.19: batchexecute body scan (lipat-khol) + CDP body decode.
{
  const { scanBatchExecuteBody, decodeCdpBody, NetworkCapture } = require('../engine/networkCapture');
  const WF = '3f2b8c1e-1234-4a5b-8c9d-0123456789ab';
  const MEDIA = 'https://lh3.googleusercontent.com/videoplayback/abc123xyz';
  // Envelope: payload is a JSON string nested inside the outer array.
  const inner = JSON.stringify([MEDIA, WF]);
  const envelope = Buffer.from(")]}'\n\n" + JSON.stringify([['wrb.fr', 'jwpduf', inner, null, null, null, 'generic']]), 'utf8');
  const r1 = scanBatchExecuteBody(envelope);
  ok('batch scan finds workflow id in envelope', r1.ids.includes(WF));
  ok('batch scan finds media url in envelope', r1.mediaUrls.includes(MEDIA));
  // Escaped slashes form.
  const esc = Buffer.from(JSON.stringify([['wrb.fr', 'jwpduf', 'https:\\/\\/lh3.googleusercontent.com\\/videoplayback\\/abc123xyz']]), 'utf8');
  const r2 = scanBatchExecuteBody(esc);
  ok('batch scan finds media url behind escaped slashes', r2.mediaUrls.includes(MEDIA));
  // CDP body decode.
  eq('decodeCdpBody utf8', decodeCdpBody('hello', false).toString('utf8'), 'hello');
  eq('decodeCdpBody base64', decodeCdpBody(Buffer.from('world').toString('base64'), true).toString('utf8'), 'world');
  eq('decodeCdpBody empty', decodeCdpBody('', false), null);
  // End-to-end: a batchexecute body binds the submission's link.
  const cap = new NetworkCapture({});
  cap.beginSubmission('vid_5000_1', 1000);
  cap.ingestResponse({
    url: 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute',
    contentType: 'application/json',
    bodyBuffer: envelope, at: 1500
  });
  const bound = cap.urlForKey('vid_5000_1');
  ok('batchexecute body binds the task link end-to-end', !!bound && bound.url === MEDIA && bound.via === 'workflow-id');
}

// v2.48.20: streaming-chunk scan — a URL split across chunks binds.
{
  const { NetworkCapture } = require('../engine/networkCapture');
  const WF = '3f2b8c1e-1234-4a5b-8c9d-0123456789ab';
  const MEDIA = 'https://lh3.googleusercontent.com/videoplayback/abc123xyz';
  const inner = JSON.stringify([MEDIA, WF]);
  const full = Buffer.from(")]}'\n\n" + JSON.stringify([['wrb.fr', 'jwpduf', inner, null, null, null, 'generic']]), 'utf8');
  const cut = Math.floor(full.length / 2);
  const cap = new NetworkCapture({});
  cap.beginSubmission('vid_6000_1', 1000);
  cap._cdpBatch.set('req-1', { rpcids: ['jwpduf'], at: 1000 });
  cap._ingestStreamChunk('req-1', full.subarray(0, cut), 1100);
  eq('no bind from half a stream', cap.urlForKey('vid_6000_1'), null);
  cap._ingestStreamChunk('req-1', full.subarray(cut), 1200);
  const bound = cap.urlForKey('vid_6000_1');
  ok('stream chunks bind the task link', !!bound && bound.url === MEDIA);
  eq('stream chunks counted', cap.batchStats.streamChunks, 2);
  eq('stream bound counted', cap.batchStats.streamBound, 1);
}

// v2.48.18 DIAGNOSTIC-3: batchexecute door + rpcid names.
{
  const { isBatchExecuteUrl, rpcidsOf } = require('../engine/networkCapture');
  eq('batchexecute door recognised', isBatchExecuteUrl('https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=MkEWBc'), true);
  eq('other flow path is not the door', isBatchExecuteUrl('https://flow.google.com/project/abc'), false);
  eq('rpcids single', JSON.stringify(rpcidsOf('https://flow.google.com/x?rpcids=MkEWBc')), '["MkEWBc"]');
  eq('rpcids comma list', JSON.stringify(rpcidsOf('https://flow.google.com/x?rpcids=AA%2CBB')), '["AA","BB"]');
  eq('rpcids absent', JSON.stringify(rpcidsOf('https://flow.google.com/x')), '[]');
}

// v2.48.17 DIAGNOSTIC-2: request path keys (host+path, no query).
{
  const { pathKeyOf } = require('../engine/networkCapture');
  eq('pathKeyOf strips query', pathKeyOf('https://flow.google.com/_/flow/data/batchexecute?rpcids=abc&token=secret'), 'flow.google.com/_/flow/data/batchexecute');
  eq('pathKeyOf keeps plain path', pathKeyOf('https://aisandbox-pa.googleapis.com/v1/flow/GetWorkflow'), 'aisandbox-pa.googleapis.com/v1/flow/GetWorkflow');
  eq('pathKeyOf invalid url', pathKeyOf('not a url'), null);
}

// v2.48.16 DIAGNOSTIC: WebSocket frame scanning (pure helper).
{
  const { scanFramePayload } = require('../engine/networkCapture');
  const withMedia = scanFramePayload('{"media":"https://lh3.googleusercontent.com/videoplayback/abc123"}');
  eq('frame scan finds media link', withMedia.hasMedia, true);
  eq('frame scan: no workflow id in media-only frame', withMedia.hasWorkflow, false);
  const withWf = scanFramePayload(Buffer.from('{"workflowId":"3f2b8c1e-1234-4a5b-8c9d-0123456789ab"}', 'utf8'));
  eq('frame scan finds workflow id in buffer frame', withWf.hasWorkflow, true);
  const plain = scanFramePayload('{"status":"progress","percent":42}');
  eq('frame scan: plain frame has neither', plain.hasMedia || plain.hasWorkflow, false);
}

// v2.48.15: claimByOrder only takes backend-body sightings —
// a media RESPONSE sighting (the tile's poster/playback URL
// family) must never be handed out by sequence order (TEST492:
// all three tasks were given poster-type URLs and every fetch
// failed the video check).
{
  const cap = new NetworkCapture({});
  cap.beginSubmission('vid_4000_1', 1000);
  const poster = 'https://lh3.googleusercontent.com/poster-image-abc';
  cap.ingestResponse({ url: poster, contentType: 'image/jpeg', bodyBuffer: null, at: 1500 });
  eq('order claim ignores response-url sightings', cap.claimByOrder('vid_4000_1', 1600), null);
  const realVid = 'https://lh3.googleusercontent.com/videoplayback/real-video-xyz';
  const apiBody = Buffer.from(JSON.stringify({ media: realVid }), 'utf8');
  cap.ingestResponse({ url: GW, contentType: 'application/json', bodyBuffer: apiBody, at: 1700 });
  const claimed = cap.claimByOrder('vid_4000_1', 1800);
  ok('order claim takes the api-body sighting', !!claimed && claimed.url === realVid && claimed.via === 'order');
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
