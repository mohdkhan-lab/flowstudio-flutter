// ---------------------------------------------------------------------------
// v2.31.0: FlowStudio MCP Server — Muse AI connector (owner-approved
// design: Settings → "Muse AI — MCP", Option 2 grid card).
//
// FlowStudio acts as an MCP *server*; Muse (the client) calls its tools
// over Streamable HTTP on port 48191. Every tool is a thin, audited proxy
// to the engine bridge's own local API (127.0.0.1:48190), so there is ONE
// source of truth for accounts, credits and generation.
//
// Security rules (locked with the owner):
//  - A Bearer token is required on every request; no token, no service.
//  - Cookies, passwords and Google session data are NEVER exposed — the
//    account tool returns only name / email / status / credits.
//  - The server binds 0.0.0.0 so it is reachable over the owner's private
//    Tailscale network; it is the token that keeps strangers out. It must
//    never be port-forwarded to the public internet.
//  - Every tool call is broadcast to the app Activity log as "MCP • Muse".
// ---------------------------------------------------------------------------
const http = require('http');
const crypto = require('crypto');
const os = require('os');

const MCP_PORT = 48191;
const BRIDGE_PORT = 48190;
const SERVER_VERSION = '2.31.1';

let mcpServer = null;
let lastConnectedAt = null; // ms epoch of the last authenticated MCP request
let lastClientName = '';

function ensureToken(dbService) {
  let token = dbService.getSetting('mcp_token', null);
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    dbService.setSetting('mcp_token', token);
  }
  return token;
}

function regenerateToken(dbService) {
  const token = crypto.randomBytes(24).toString('hex');
  dbService.setSetting('mcp_token', token);
  return token;
}

function mcpEnabled(dbService) {
  // Default ON (the approved design ships with the connector running);
  // the Settings toggle writes '0' to switch it off.
  return dbService.getSetting('mcp_enabled', '1') !== '0';
}

function connectionUrl() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      // Tailscale addresses live in the 100.64.0.0/10 CGNAT range.
      if (net.family === 'IPv4' && net.address.startsWith('100.')) {
        return `http://${net.address}:${MCP_PORT}/mcp`;
      }
    }
  }
  return `http://127.0.0.1:${MCP_PORT}/mcp`;
}

function maskedToken(dbService) {
  const token = ensureToken(dbService);
  return `••••••••••••${token.slice(-4)}`;
}

function getStatus(dbService) {
  return {
    enabled: mcpEnabled(dbService),
    running: !!mcpServer,
    port: MCP_PORT,
    url: connectionUrl(),
    tokenMasked: maskedToken(dbService),
    lastConnectedAt,
    lastClient: lastClientName,
    tools: TOOLS.map((t) => t.name),
  };
}

// --- Bridge proxy: one small helper, no dependencies -----------------------
function bridgeCall(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: BRIDGE_PORT,
        path: pathname,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
        timeout: 120000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
          } catch (e) {
            reject(new Error(`Bridge returned a non-JSON response (${res.statusCode})`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Bridge request timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// --- Tools -------------------------------------------------------------------
const TOOLS = [
  {
    name: 'flowstudio_status',
    description: 'FlowStudio status: app version, whether a generation run is active, and worker count.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => bridgeCall('GET', '/api/status'),
  },
  {
    name: 'flowstudio_list_accounts',
    description: 'List Google Flow accounts with name, email, status (Live/Fail/Checking) and credits. Cookie values are never returned.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const res = await bridgeCall('GET', '/api/accounts');
      const accounts = (res.accounts || []).map((a) => ({
        id: a.id,
        name: a.name,
        email: a.email || '',
        status: a.status,
        credits: a.credits,
      }));
      return { ok: true, accounts };
    },
  },
  {
    name: 'flowstudio_get_credits',
    description: 'Total Flow credits across all accounts, plus the per-account breakdown.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const res = await bridgeCall('GET', '/api/accounts');
      const accounts = (res.accounts || []).map((a) => ({
        name: a.name,
        status: a.status,
        credits: a.credits,
      }));
      const total = accounts.reduce((sum, a) => sum + (Number(a.credits) || 0), 0);
      return { ok: true, totalCredits: total, accounts };
    },
  },
  {
    name: 'flowstudio_get_stats',
    description: 'Usage stats and history totals: videos generated, credits spent (today and all time).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => bridgeCall('GET', '/api/stats'),
  },
  {
    name: 'flowstudio_list_outputs',
    description: 'List the generated video files in the output folder (name, size, modified time), newest first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max files to return (default 50)' } },
    },
    run: async (args) => {
      const res = await bridgeCall('GET', '/api/output-files');
      const limit = Math.max(1, Math.min(500, Number(args.limit) || 50));
      return { ok: true, folder: res.folder, files: (res.files || []).slice(0, limit) };
    },
  },
  {
    name: 'flowstudio_generate',
    description: 'Start a video generation run in FlowStudio. Only the prompts are required — model, duration, aspect ratio and quality fall back to the app defaults. This spends Flow credits.',
    inputSchema: {
      type: 'object',
      properties: {
        prompts: { type: 'array', items: { type: 'string' }, description: 'One prompt per video' },
        model: { type: 'string', description: "e.g. 'Omni Flash', 'Veo 3.1 Fast'" },
        duration: { type: 'string', description: "e.g. '4s', '6s', '8s', '10s'" },
        aspectRatio: { type: 'string', description: "e.g. '9:16', '16:9', '1:1'" },
        quality: { type: 'string', description: "e.g. '720p', '1080p'" },
        parallelBrowsers: { type: 'number', description: 'How many accounts work in parallel (1-4)' },
        tag: { type: 'string', description: 'Optional tag used as the file name' },
      },
      required: ['prompts'],
    },
    run: async (args) => {
      const prompts = Array.isArray(args.prompts) ? args.prompts.filter((p) => typeof p === 'string' && p.trim()) : [];
      if (prompts.length === 0) throw new Error('prompts must be a non-empty array of strings');
      const body = { prompts };
      for (const k of ['model', 'duration', 'aspectRatio', 'quality', 'tag']) {
        if (typeof args[k] === 'string' && args[k]) body[k] = args[k];
      }
      if (Number(args.parallelBrowsers) > 0) body.parallelBrowsers = Math.floor(Number(args.parallelBrowsers));
      return bridgeCall('POST', '/api/generation/start', body);
    },
  },
  {
    name: 'flowstudio_pause_resume',
    description: 'Pause or resume the active generation queue.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['pause', 'resume'] } },
      required: ['action'],
    },
    run: async (args) => {
      if (args.action === 'pause') return bridgeCall('POST', '/api/generation/pause', {});
      if (args.action === 'resume') return bridgeCall('POST', '/api/generation/resume', {});
      throw new Error("action must be 'pause' or 'resume'");
    },
  },
  {
    name: 'flowstudio_stop_generation',
    description: 'Stop the active generation run. Videos already downloaded are kept.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => bridgeCall('POST', '/api/generation/stop', {}),
  },
  {
    name: 'flowstudio_sync_credits',
    description: 'Refresh the real credit balance of every account from Google Flow.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => bridgeCall('POST', '/api/accounts/sync-all', {}),
  },
  {
    name: 'flowstudio_check_cookies',
    description: 'Re-check the login cookies of the given account IDs and report Live/Fail per account. Cookie values are never returned.',
    inputSchema: {
      type: 'object',
      properties: {
        accountIds: { type: 'array', items: { type: 'string' }, description: 'Account IDs from flowstudio_list_accounts' },
      },
      required: ['accountIds'],
    },
    run: async (args) => {
      const ids = Array.isArray(args.accountIds) ? args.accountIds.filter((x) => typeof x === 'string' && x) : [];
      if (ids.length === 0) throw new Error('accountIds must be a non-empty array');
      return bridgeCall('POST', '/api/cookies/check', { ids });
    },
  },
];

// --- Server --------------------------------------------------------------------
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function startMcpServer({ dbService, broadcastEvent }) {
  if (mcpServer) return;
  ensureToken(dbService);

  mcpServer = http.createServer(async (req, res) => {
    const send = (code, obj, extraHeaders = {}) => {
      const payload = obj === null ? '' : JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json', ...extraHeaders });
      res.end(payload);
    };

    try {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      if (reqUrl.pathname !== '/mcp' || req.method !== 'POST') {
        return send(404, { jsonrpc: '2.0', error: { code: -32601, message: 'Not found — POST JSON-RPC to /mcp' }, id: null });
      }

      // Token auth on EVERY request.
      const token = ensureToken(dbService);
      const auth = String(req.headers.authorization || '');
      const headerToken = String(req.headers['x-mcp-token'] || '');
      if (auth !== `Bearer ${token}` && headerToken !== token) {
        // v2.31.1 diagnostic: report WHAT arrived to the Activity log —
        // first 8 chars + total length of the presented value, never
        // more — so a wrong paste is distinguishable from a client
        // that sent nothing or an unswapped placeholder.
        if (broadcastEvent) {
          const presented = auth.startsWith('Bearer ') ? auth.slice(7) : auth || headerToken;
          const detail = presented ? `starts "${presented.slice(0, 8)}", length ${presented.length}` : 'no token';
          broadcastEvent('automation-log', { message: `🔌 MCP • auth FAILED — ${detail}`, level: 'warning' });
        }
        return send(401, { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized — a valid MCP access token is required' }, id: null });
      }

      const raw = await readRequestBody(req);
      let msg;
      try {
        msg = JSON.parse(raw || '{}');
      } catch (e) {
        return send(400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      }

      lastConnectedAt = Date.now();
      const { method, id } = msg;
      const params = msg.params || {};
      const isNotification = id === undefined || id === null;

      if (method === 'initialize') {
        if (params.clientInfo && params.clientInfo.name) lastClientName = String(params.clientInfo.name);
        return send(
          200,
          {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: params.protocolVersion || '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'flowstudio', version: SERVER_VERSION },
            },
          },
          { 'Mcp-Session-Id': crypto.randomBytes(16).toString('hex') }
        );
      }
      if (isNotification) return send(202, null);
      if (method === 'ping') return send(200, { jsonrpc: '2.0', id, result: {} });
      if (method === 'tools/list') {
        return send(200, {
          jsonrpc: '2.0',
          id,
          result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
        });
      }
      if (method === 'tools/call') {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) {
          return send(200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool: ${params.name}` }], isError: true } });
        }
        try {
          if (broadcastEvent) {
            broadcastEvent('automation-log', { message: `🔌 MCP • Muse called ${tool.name}`, level: 'info' });
          }
          const result = await tool.run(params.arguments || {});
          const isError = result && result.ok === false;
          return send(200, {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: !!isError },
          });
        } catch (e) {
          return send(200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
        }
      }
      return send(200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (e) {
      try {
        send(500, { jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null });
      } catch (_) {}
    }
  });

  mcpServer.on('error', (e) => {
    console.error('[FlowStudio MCP] Server error:', e.message);
  });
  mcpServer.listen(MCP_PORT, '0.0.0.0', () => {
    console.log(`[FlowStudio MCP] Listening on http://0.0.0.0:${MCP_PORT}/mcp`);
  });
}

function stopMcpServer() {
  if (!mcpServer) return;
  try {
    mcpServer.close();
  } catch (e) {}
  mcpServer = null;
}

module.exports = {
  MCP_PORT,
  ensureToken,
  regenerateToken,
  mcpEnabled,
  getStatus,
  startMcpServer,
  stopMcpServer,
};
