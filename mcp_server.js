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
const { usableCreditsTotal, storedCreditsTotal } = require('./engine/usableCredits');

const MCP_PORT = 48191;
const BRIDGE_PORT = 48190;
const SERVER_VERSION = '2.48.104';

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

// --- v2.32.0 (Full Control) helpers -------------------------------------------
// Account rows from the bridge never carry cookie values or passwords
// (cookies live in a separate store; a row only has a hasCookies flag),
// but MCP answers keep the same tight projection the account tools
// have always used: id / name / email / status / credits, nothing else.
function publicAccount(a) {
  if (!a || typeof a !== 'object') return a;
  return { id: a.id, name: a.name, email: a.email || '', status: a.status, credits: a.credits };
}

function publicAccounts(list) {
  return Array.isArray(list) ? list.map(publicAccount) : list;
}

// The settings keys the bridge's own settings handler serves (the
// exact list its GET /api/settings returns). flowstudio_update_settings
// passes through ONLY these keys — the MCP layer adds no other
// settings surface of its own.
const SETTING_KEYS = [
  'appearance', 'theme', 'default_model', 'default_duration', 'default_aspect',
  'default_naming', 'default_quality', 'default_download_mode', 'custom_tags', 'download_folder', 'chrome_path',
  'browser_background', 'show_browsers', 'preview_autoplay', 'auto_verify_start',
  'auto_check_updates', 'social_links', 'live_only_accounts', 'history_cleared', 'headless_generation',
  'account_aliases', 'parallel_browsers', 'mcp_enabled',
];

// The settings store is string-valued (the bridge String()-coerces on
// write): strings pass through as-is, structured values are stored as
// their JSON text (the form the app itself reads back), scalars are
// stringified. null/undefined means "leave unchanged" and is dropped.
function settingValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
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
    name: 'flowstudio_agent_doctor',
    description: 'Agent Doctor diagnostics: which replace-pack files this engine actually loaded (absolute path, byte size and md5 fingerprint of each — the agent driver and rules in engine/, the agent doctor itself, plus engine_bridge.js and mcp_server.js at the app root — compare against a replace-pack\'s notes to prove the replaced files are really live), plus the most recent Agent-mode run\'s recorded outcome (time, status, reason, last proposal, and a detail field carrying the settings DOM survey or the exact settings field that mismatched, when the run produced one) or null if no Agent run has happened since the app started. The payload also carries agentModeOverride: the current MCP Agent-mode override (true/false, or null when chat runs follow the app toggle — see flowstudio_set_agent_mode).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => bridgeCall('GET', '/api/agent-doctor'),
  },
  {
    // v2.48.99: the chat-side Agent-mode switch. The owner must
    // never have to walk to the PC and flip the app's Agent Prompt
    // toggle for a chat-driven run — this sets an engine-level
    // override that MCP-originated runs (both generate tools)
    // honour. In memory only: an app restart returns it to null.
    name: 'flowstudio_set_agent_mode',
    description: 'Set the Agent-mode override for chat-driven (MCP) generation runs, so the owner never has to touch the app\'s Agent Prompt toggle for a run started from chat. enabled=true: MCP runs go through Flow\'s own Agent (the rule-driven proposal/approve flow). enabled=false: MCP runs take the direct route. Omit enabled (or pass null) to clear the override — MCP runs then follow the app toggle (in-app route) / the direct route (engine route), as before. A per-call agentMode argument on a generate tool beats this override for that one run. Runs the owner starts by hand in the app are never affected. Returns the resulting agentModeOverride (true/false/null).',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: ['boolean', 'null'], description: 'true = Agent route for MCP runs, false = direct route, null/omitted = clear the override' },
      },
    },
    run: async (args) => {
      const enabled = typeof (args && args.enabled) === 'boolean' ? args.enabled : null;
      return bridgeCall('POST', '/api/mcp/agent-mode', { enabled });
    },
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
    description: 'Total SPENDABLE Flow credits (usable accounts only — a Need Login account\'s stored balance is not spendable), plus the per-account breakdown and the stored all-accounts sum.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const res = await bridgeCall('GET', '/api/accounts');
      const accounts = (res.accounts || []).map((a) => ({
        name: a.name,
        status: a.status,
        credits: a.credits,
      }));
      // v2.48.61: totalCredits is the USABLE (spendable) sum — the
      // planner's definition (status !== 'Need Login'), via
      // engine/usableCredits. storedCredits keeps the old
      // all-accounts stored sum under its own honest name.
      return { ok: true, totalCredits: usableCreditsTotal(accounts), storedCredits: storedCreditsTotal(accounts), accounts };
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
    description: 'Start a video generation run in FlowStudio. Only the prompts are required — model, duration, aspect ratio and quality fall back to the app defaults. This spends Flow credits. Agent mode: pass agentMode=true to run through Flow\'s own Agent or false for the direct route — a per-call agentMode beats the flowstudio_set_agent_mode override, which beats this route\'s default (direct).',
    inputSchema: {
      type: 'object',
      properties: {
        prompts: { type: 'array', items: { type: 'string' }, description: 'One prompt per video' },
        model: { type: 'string', description: "e.g. 'Omni Flash', 'Omni 1.2 Flash', 'Veo 3.1 Fast'" },
        duration: { type: 'string', description: "e.g. '4s', '6s', '8s', '10s', '15s'" },
        aspectRatio: { type: 'string', description: "e.g. '9:16', '16:9', '1:1'" },
        quality: { type: 'string', description: "e.g. '720p', '1080p'" },
        parallelBrowsers: { type: 'number', description: 'How many accounts work in parallel (1-4)' },
        tag: { type: 'string', description: 'Optional tag used as the file name' },
        project: { type: 'string', description: 'Optional project name — the videos save into that project\'s own folder inside the output folder, exactly like a project typed into the app' },
        agentMode: { type: 'boolean', description: 'Optional: true runs this call through Flow\'s own Agent, false forces the direct route. Beats the flowstudio_set_agent_mode override for this run only.' },
        agentClips: { description: 'Optional (Agent mode, Bulk Mode v2.48.103): how many clips ONE Agent conversation makes for a prompt — a number applies to every prompt, an array gives a per-prompt count (parallel to prompts). Each bulk prompt runs as ONE conversation whose Agent is asked for that many clips at once; the combined proposal is approved only at or under clips × the per-clip cost with the run\'s model, and every clip is downloaded (saved <TAG>-S1..<TAG>-SN). Default 1 = one clip per conversation, as before.' },
      },
      required: ['prompts'],
    },
    run: async (args) => {
      const prompts = Array.isArray(args.prompts) ? args.prompts.filter((p) => typeof p === 'string' && p.trim()) : [];
      if (prompts.length === 0) throw new Error('prompts must be a non-empty array of strings');
      // mcpOrigin marks this start as chat-originated so the bridge
      // applies the agent-mode precedence (per-call > override >
      // default) instead of reading a UI toggle that is not in play.
      const body = { prompts, mcpOrigin: true };
      for (const k of ['model', 'duration', 'aspectRatio', 'quality', 'tag', 'project']) {
        if (typeof args[k] === 'string' && args[k]) body[k] = args[k];
      }
      if (Number(args.parallelBrowsers) > 0) body.parallelBrowsers = Math.floor(Number(args.parallelBrowsers));
      if (typeof args.agentMode === 'boolean') body.agentMode = args.agentMode;
      // v2.48.103 (BULK MODE): agentClips converts the prompt
      // strings into the bridge's object form {text, agentClips}
      // — only when the caller actually asked for bulk counts,
      // so the default start body stays exactly as before.
      if (args.agentClips !== undefined && args.agentClips !== null) {
        const clipsFor = (i) => {
          const v = Array.isArray(args.agentClips) ? args.agentClips[i] : args.agentClips;
          const n = Math.floor(Number(v));
          return Number.isFinite(n) && n >= 1 ? n : 1;
        };
        body.prompts = prompts.map((p, i) => ({ text: p, agentClips: clipsFor(i) }));
      }
      return bridgeCall('POST', '/api/generation/start', body);
    },
  },
  {
    // v2.32.2: generate THROUGH the app's own screen. The bridge does
    // not start the engine for this one — it signals the Dart app
    // over SSE ('mcp-ui-generate-request') and the app puts the
    // prompts into its own Prompts box and invokes its own Generate
    // button handler, so the owner watches the run in the app's
    // Progress section. The bridge refuses when a run is already
    // active or when the app screen is not connected; there is no
    // silent fallback to the direct engine route.
    name: 'flowstudio_generate_in_app',
    description: 'Start a video generation run inside the FlowStudio app\'s own screen: the prompts appear in the app\'s Prompts box and the run starts exactly as if the user pressed the app\'s Generate button, so the app\'s Progress section shows the run live on their screen. A project name, when given, becomes the app\'s current Project field value before the run starts, so the videos save into that project\'s folder. The FlowStudio app must be open on its main screen. This spends Flow credits like a normal run. Use flowstudio_generate instead when nobody needs to watch the app screen. Agent mode: pass agentMode=true/false to decide this run\'s route from chat — the engine enforces it over the app\'s Agent Prompt toggle, so the owner never has to touch the toggle for a chat run. A per-call agentMode beats the flowstudio_set_agent_mode override; with neither, the app toggle decides as before. The result reports the agentMode the engine resolved for the run (null = the app toggle decides).',
    inputSchema: {
      type: 'object',
      properties: {
        prompts: { type: 'array', items: { type: 'string' }, description: 'One prompt per video' },
        tag: { type: 'string', description: 'Optional tag — becomes the app\'s selected TAG (used as the file name)' },
        project: { type: 'string', description: 'Optional project name — becomes the app\'s current Project field value before the run starts' },
        agentMode: { type: 'boolean', description: 'Optional: true runs this call through Flow\'s own Agent, false forces the direct route — enforced by the engine over the app\'s Agent Prompt toggle for this run. Beats the flowstudio_set_agent_mode override.' },
        agentClips: { description: 'Optional (Agent mode, Bulk Mode v2.48.103): how many clips ONE Agent conversation makes for a prompt — a number applies to every prompt, an array gives a per-prompt count (parallel to prompts). Each bulk prompt becomes ONE app prompt item whose Agent conversation is asked for that many clips at once; the combined proposal is approved only at or under clips × the per-clip cost with the run\'s model, and every clip is downloaded (saved <TAG>-S1..<TAG>-SN). Default 1 = one clip per conversation, as before.' },
        skipFirstTaskDownload: { type: 'boolean', description: 'TEST FLAG (v2.48.62, ZC30): when true, the FIRST prompt of this run is generated as usual but its download step is deliberately skipped — the task stays parked (pending + needs_check) for a later download-only Resume, no download attempt is counted and the prompt is never resubmitted. Exists to separate first-vs-latest-render effects in the download investigation; leave unset for normal runs.' },
      },
      required: ['prompts'],
    },
    run: async (args) => {
      const prompts = Array.isArray(args.prompts) ? args.prompts.filter((p) => typeof p === 'string' && p.trim()) : [];
      if (prompts.length === 0) throw new Error('prompts must be a non-empty array of strings');
      const body = { prompts };
      if (typeof args.tag === 'string' && args.tag) body.tag = args.tag;
      if (typeof args.project === 'string' && args.project) body.project = args.project;
      if (typeof args.agentMode === 'boolean') body.agentMode = args.agentMode;
      // v2.48.103 (BULK MODE): passed through as-is (number or
      // per-prompt array) — the bridge normalises it against
      // the filtered prompt list and the app applies it per
      // prompt item.
      if (args.agentClips !== undefined && args.agentClips !== null) body.agentClips = args.agentClips;
      if (args.skipFirstTaskDownload === true) body.skipFirstTaskDownload = true;
      return bridgeCall('POST', '/api/generation/start-ui', body);
    },
  },
  {
    name: 'flowstudio_pause_resume',
    description: 'Pause or resume generation. "resume" un-pauses the active queue when one is running; when NO run is active it instead starts a download-only recovery for any prompts still pending a check (e.g. videos that were generated but whose download failed — only the download is retried, no prompt is resubmitted, no new charge), and when there is truly nothing waiting it honestly reports resumed:false with reason "nothing-to-resume". The result always says which of these happened (mode: "live" | "recovery", or resumed: false).',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['pause', 'resume'] } },
      required: ['action'],
    },
    run: async (args) => {
      if (args.action === 'pause') return bridgeCall('POST', '/api/generation/pause', {});
      if (args.action === 'resume') {
        const res = await bridgeCall('POST', '/api/generation/resume', {});
        // v2.48.0 (deep-audit fix #1): surface the bridge's REAL
        // answer in the result — the pre-v2.48.0 bare { ok: true }
        // let callers believe a queue had restarted when nothing
        // had. The mode/count/reason fields come from the bridge;
        // the summary states the outcome in plain words.
        let summary;
        if (res && res.mode === 'recovery') summary = `No run was active; a download-only recovery was started for ${res.count} pending prompt(s). Only downloads will be retried — no prompt will be resubmitted and no new charge will apply.`;
        else if (res && res.mode === 'live') summary = 'The active generation queue was resumed.';
        else if (res && res.resumed === false) summary = 'Nothing to resume: no run is active and no prompt is waiting for a download-only check.';
        else summary = 'Resume answered by the app.';
        return { ...res, summary };
      }
      throw new Error("action must be 'pause' or 'resume'");
    },
  },
  {
    // v2.48.0 (deep-audit fix #10): the missing-scene redo, exposed
    // over MCP. Until now the ONLY way to retry generated-but-
    // undownloaded scenes (or remake generation-failed ones) was
    // the app's own Redo Missing button — this tool calls the exact
    // same bridge route the button uses.
    name: 'flowstudio_redo_missing',
    description: 'Redo ONLY the missing scenes of the last generation run (the app\'s Redo Missing). Scenes whose video was generated but whose download failed are downloaded again with NO new charge and NO resubmission; scenes whose generation failed are remade fresh (that part spends Flow credits like a normal run). Refuses while a run is active, and errors when no run has happened yet. The result reports how many scenes were missing and whether the redo started.',
    inputSchema: {
      type: 'object',
      properties: {
        parallelBrowsers: { type: 'number', description: 'Optional parallel browser count for the redo run' },
        accountIds: { type: 'array', items: { type: 'string' }, description: 'Optional account IDs to restrict the redo run to' },
      },
    },
    run: async (args) => {
      const body = {};
      if (Number(args.parallelBrowsers) > 0) body.parallelBrowsers = Math.floor(Number(args.parallelBrowsers));
      if (Array.isArray(args.accountIds)) body.accountIds = args.accountIds.filter((x) => typeof x === 'string' && x);
      return bridgeCall('POST', '/api/generation/redo-missing', body);
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
  {
    // v2.31.4: update the app itself, through the app's OWN updater.
    // 'check' only reads (current version vs the latest GitHub
    // release). 'install' asks the app to download the latest Setup
    // from the app's own GitHub releases and run the same silent
    // install as Settings → Updates — the app closes and restarts,
    // so a successful call returns "started" before it exits. The
    // bridge refuses while a generation run is active or when no
    // newer release exists.
    name: 'flowstudio_update_app',
    description: 'Check for a FlowStudio app update, or install it. action "check" reports the current version, the latest published version, and whether an update is available. action "install" starts the app\'s own update (downloads the latest Setup from the app\'s GitHub releases and installs it silently — the app closes and restarts). Install refuses while a generation run is active or when already up to date.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['check', 'install'] } },
      required: ['action'],
    },
    run: async (args) => {
      if (args.action === 'check') return bridgeCall('GET', '/api/update/check');
      if (args.action === 'install') return bridgeCall('POST', '/api/update/install', {});
      throw new Error("action must be 'check' or 'install'");
    },
  },
  // --- v2.32.0 Full Control: diagnostics, settings, browsers, accounts, files.
  {
    name: 'flowstudio_get_activity',
    description: 'Read the app\'s Activity log — the generation, login, credit and system events the engine records, newest first. This is the first place to look when something went wrong: use category "errors" to see only the failures. Entries carry a timestamp, category, level (info/success/warn/error) and message.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries to return (default 100, max 500)' },
        category: { type: 'string', enum: ['all', 'generation', 'credits', 'login', 'errors', 'system'], description: 'Only return this category (default all)' },
      },
    },
    run: async (args) => {
      const limit = Math.max(1, Math.min(500, Number(args.limit) || 100));
      const category = typeof args.category === 'string' && args.category ? args.category : 'all';
      return bridgeCall('GET', `/api/activity?limit=${limit}&category=${encodeURIComponent(category)}`);
    },
  },
  {
    name: 'flowstudio_get_settings',
    description: 'Read the app settings exactly as the app stores them (appearance, theme, generation defaults, download folder, automation toggles and more). Values come back as strings, the form the app itself uses.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => bridgeCall('GET', '/api/settings'),
  },
  {
    name: 'flowstudio_update_settings',
    description: 'Change app settings. Pass a settings object with any of the app\'s own setting keys (the same keys flowstudio_get_settings returns) — unknown keys are ignored, and omitting a key leaves it unchanged. Values are stored the way the app stores them (structured values as JSON text). Generation defaults apply to the next run.',
    inputSchema: {
      type: 'object',
      properties: {
        settings: {
          type: 'object',
          description: 'Key/value pairs using only the app\'s own setting keys',
          properties: Object.fromEntries(SETTING_KEYS.map((k) => [k, {}])),
          additionalProperties: false,
        },
      },
      required: ['settings'],
    },
    run: async (args) => {
      const incoming = args.settings && typeof args.settings === 'object' ? args.settings : {};
      const clean = {};
      for (const k of SETTING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(incoming, k) && incoming[k] !== null && incoming[k] !== undefined) {
          clean[k] = settingValue(incoming[k]);
        }
      }
      if (Object.keys(clean).length === 0) throw new Error('settings must contain at least one known setting key with a value');
      return bridgeCall('POST', '/api/settings', { settings: clean });
    },
  },
  {
    name: 'flowstudio_get_active_browsers',
    description: 'List the accounts that currently have a live generation browser, and whether each browser window is shown on screen or parked off-screen. Empty when no generation is running.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => bridgeCall('GET', '/api/generation/active-browsers'),
  },
  {
    name: 'flowstudio_list_chrome_profiles',
    description: 'List the Chrome profiles already installed on this PC (profile folder name, profile name, email) — the pool flowstudio_import_chrome_profiles can import from. Nothing is changed.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => bridgeCall('GET', '/api/chrome-profiles'),
  },
  {
    name: 'flowstudio_import_chrome_profiles',
    description: 'Import one Chrome profile that already exists on this PC as a FlowStudio account, by its profile folder name (dirName from flowstudio_list_chrome_profiles). The profile never leaves the PC — no file content or cookie data passes through this call, only the folder name.',
    inputSchema: {
      type: 'object',
      properties: { dirName: { type: 'string', description: 'Chrome profile folder name, e.g. "Default" or "Profile 1"' } },
      required: ['dirName'],
    },
    run: async (args) => {
      if (typeof args.dirName !== 'string' || !args.dirName) throw new Error('dirName must be a non-empty string');
      const res = await bridgeCall('POST', '/api/chrome-profiles/import', { dirName: args.dirName });
      if (res && res.account) return { ...res, account: publicAccount(res.account) };
      return res;
    },
  },
  {
    name: 'flowstudio_add_account',
    description: 'Create a new, empty FlowStudio account line (name and optional email label only). No password, cookie or login is involved — the account still needs a sign-in afterwards (flowstudio_start_login opens one, or the owner signs in inside the app).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name for the account (the app generates one when empty)' },
        email: { type: 'string', description: 'Optional email label — the real Google identity still comes from the live sign-in/sync' },
      },
    },
    run: async (args) => {
      const body = { name: typeof args.name === 'string' ? args.name : '', email: typeof args.email === 'string' ? args.email : '' };
      const res = await bridgeCall('POST', '/api/accounts/add', body);
      // The bridge wraps the store result: res.account is itself
      // { account, accounts } — normalize to the created account only.
      const created = res && res.account && res.account.account ? res.account.account : res && res.account;
      return { ok: true, account: publicAccount(created) };
    },
  },
  {
    name: 'flowstudio_start_login',
    description: 'Start a Google sign-in for a NEW account: the app creates the account line and opens the real Google login window on this PC. The owner types their password in that window — no credential ever passes through this call. Returns the created account once the window is open.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const res = await bridgeCall('POST', '/api/accounts/start-login', {});
      if (res && res.account) {
        const out = { ...res, account: publicAccount(res.account) };
        return out;
      }
      return res;
    },
  },
  {
    name: 'flowstudio_complete_login',
    description: 'Finish checking a sign-in for an account: detects the Google account inside its Chrome profile, fills in the real name/email and syncs its credits. Use after the owner has signed in through the login window.',
    inputSchema: {
      type: 'object',
      properties: { accountId: { type: 'string', description: 'Account ID from flowstudio_list_accounts' } },
      required: ['accountId'],
    },
    run: async (args) => {
      if (typeof args.accountId !== 'string' || !args.accountId) throw new Error('accountId must be a non-empty string');
      const res = await bridgeCall('POST', '/api/accounts/complete-login', { id: args.accountId });
      const out = { ...res };
      if (Array.isArray(out.accounts)) out.accounts = publicAccounts(out.accounts);
      if (out.result && typeof out.result === 'object') {
        const result = { ...out.result };
        delete result.accounts;
        if (result.account) result.account = publicAccount(result.account);
        out.result = result;
      }
      return out;
    },
  },
  {
    name: 'flowstudio_open_chrome',
    description: 'Open the Chrome window of an existing account (its own dedicated profile) on this PC. The owner can inspect or finish a sign-in there; generation is not started.',
    inputSchema: {
      type: 'object',
      properties: { accountId: { type: 'string', description: 'Account ID from flowstudio_list_accounts' } },
      required: ['accountId'],
    },
    run: async (args) => {
      if (typeof args.accountId !== 'string' || !args.accountId) throw new Error('accountId must be a non-empty string');
      return bridgeCall('POST', '/api/accounts/open-chrome', { id: args.accountId });
    },
  },
  {
    name: 'flowstudio_toggle_browser',
    description: 'Show or hide the working browser window of an account that is generating right now (the parked-browser toggle). Only the window moves — generation is never interrupted. Fails cleanly when no generation is running.',
    inputSchema: {
      type: 'object',
      properties: { accountId: { type: 'string', description: 'Account ID from flowstudio_list_accounts' } },
      required: ['accountId'],
    },
    run: async (args) => {
      if (typeof args.accountId !== 'string' || !args.accountId) throw new Error('accountId must be a non-empty string');
      return bridgeCall('POST', '/api/accounts/toggle-browser', { id: args.accountId });
    },
  },
  {
    name: 'flowstudio_sync_selected_accounts',
    description: 'Sync the real credit balance and status of only the given accounts from Google Flow (flowstudio_sync_credits syncs every account). Returns the refreshed accounts.',
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
      const res = await bridgeCall('POST', '/api/accounts/sync-selected', { ids });
      if (res && Array.isArray(res.accounts)) return { ...res, accounts: publicAccounts(res.accounts) };
      return res;
    },
  },
  {
    name: 'flowstudio_delete_accounts',
    description: 'Permanently delete FlowStudio account(s) — the account line, its saved cookies and its dedicated Chrome profile are removed. This permanently deletes the account(s) and cannot be undone. Pass accountId for one account or accountIds for several.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Single account ID from flowstudio_list_accounts' },
        accountIds: { type: 'array', items: { type: 'string' }, description: 'Several account IDs from flowstudio_list_accounts' },
      },
    },
    run: async (args) => {
      const ids = Array.isArray(args.accountIds) ? args.accountIds.filter((x) => typeof x === 'string' && x) : [];
      if (ids.length > 0) {
        const res = await bridgeCall('POST', '/api/accounts/delete-selected', { ids });
        return { ...res, deleted: ids.length };
      }
      if (typeof args.accountId === 'string' && args.accountId) {
        const res = await bridgeCall('POST', '/api/accounts/delete', { id: args.accountId });
        return { ...res, deleted: 1 };
      }
      throw new Error('pass accountId or a non-empty accountIds array');
    },
  },
  {
    name: 'flowstudio_open_output_folder',
    description: 'Open the generated-videos output folder in Windows Explorer on this PC.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => bridgeCall('POST', '/api/open-output-folder', {}),
  },
  {
    name: 'flowstudio_open_output_file',
    description: 'Open one generated video in the PC\'s default player. Only a bare file name from flowstudio_list_outputs is accepted — the app confines it to video files inside the output folder; paths are never accepted.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'File name only, e.g. "#00-01.mp4"' } },
      required: ['name'],
    },
    run: async (args) => {
      if (typeof args.name !== 'string' || !args.name) throw new Error('name must be a non-empty file name');
      return bridgeCall('POST', '/api/open-file', { name: args.name });
    },
  },
  {
    // v2.41.0 (Fix list C, item 2): fetch one generated video's BYTES
    // off this PC, so a finished video can reach the caller without
    // anyone moving files by hand (the Ep11 takes sat in Downloads
    // waiting for exactly this). The bridge resolves the name with
    // the same confined resolver as open-file (bare name or one
    // project-qualified "Project/name" reference, never a path) and
    // enforces the 64 MB cap — oversized files come back as a clear
    // {ok:false} error, never as truncated data.
    name: 'flowstudio_download_output',
    description: 'Download one generated video file from this PC as base64 (returns {ok, name, sizeBytes, mime, dataBase64}). The name must come from flowstudio_list_outputs — a bare file name or its project-qualified "rel" form (e.g. "My Project/clip.mp4"). Files over 64 MB are refused with an error (nothing is truncated); a missing file returns {ok:false, error:"not found"}.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'File name from flowstudio_list_outputs — bare name or project-qualified rel path' } },
      required: ['name'],
    },
    run: async (args) => {
      if (typeof args.name !== 'string' || !args.name) throw new Error('name must be a non-empty file name from flowstudio_list_outputs');
      return bridgeCall('POST', '/api/output-file-content', { name: args.name });
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

  // v2.48.4: if a stale MCP server from an older engine still holds
  // the port, stop that process and take the port over (once) instead
  // of logging an error and leaving the remote route dead. The
  // bridge's own port takeover normally clears both ports together;
  // this covers an MCP orphan outliving its bridge.
  let listenRetried = false;
  mcpServer.on('error', async (e) => {
    console.error('[FlowStudio MCP] Server error:', e.message);
    if (e && e.code === 'EADDRINUSE' && !listenRetried) {
      listenRetried = true;
      try {
        const { killPidOnPort } = require('./engine/portTakeover');
        const killed = await killPidOnPort(MCP_PORT, process.pid);
        if (killed) {
          setTimeout(() => {
            try { mcpServer.listen(MCP_PORT, '0.0.0.0'); } catch (_) {}
          }, 700);
        }
      } catch (_) {}
    }
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
