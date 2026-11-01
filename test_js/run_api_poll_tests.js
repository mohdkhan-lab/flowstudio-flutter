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

// A template from BEFORE a submission is not offered to it.
{
  const cap = new NetworkCapture({});
  const listBody = Buffer.from(JSON.stringify({ projectId: 'old' }), 'utf8');
  cap.ingestRequest({
    url: LIST, method: 'POST', headers: {},
    postDataText: listBody.toString('utf8'), postDataBuffer: listBody, at: 1000
  });
  cap.beginSubmission('vid_3000_1', 9000);
  eq('stale template not offered', cap.templateForKey('vid_3000_1'), null);
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
