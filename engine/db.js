const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

/**
 * FlowStudio Lite — SQLite (sql.js) storage.
 *
 * AUDIT FIX #4 (storage half): this database is the SINGLE source of truth
 * for accounts and tasks. There is deliberately NO accounts.json mirror.
 * Persistence is debounced: mutations schedule a write at most once every
 * 2 seconds; persistNow() flushes synchronously (used on app shutdown and
 * by tests).
 *
 * AUDIT FIX #1 (recovery half): on boot, any task left in 'running' state
 * by a crashed/killed previous session is recovered — v1.8.0: reset to
 * 'pending' with needs_check = 1 (ZDola-style check-only recovery), so
 * no task can ever appear stuck in "running" forever, and a prompt that
 * may already have been submitted is verified in Flow before any re-run.
 *
 * The data directory defaults to <app>/data and can be overridden with the
 * FLOW_LITE_DATA_DIR environment variable (used by the smoke tests).
 */

const DATA_DIR = process.env.FLOW_LITE_DATA_DIR
  ? path.resolve(process.env.FLOW_LITE_DATA_DIR)
  : path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'flow_studio_lite.db');
const PERSIST_DEBOUNCE_MS = 2000;

let db = null;
let SQL = null;
let isInitialized = false;
let persistTimer = null;
let persistDirty = false;
let recoveredInterruptedCount = 0;

let wasmPath = null;
try {
  wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
} catch (e) {
  wasmPath = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
}
const wasmBinary = fs.existsSync(wasmPath) ? fs.readFileSync(wasmPath) : null;

function flushPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!db || !persistDirty) return;
  try {
    const data = db.export();
    const buf = Buffer.from(data);
    const tmpPath = `${DB_PATH}.tmp_${process.pid}_${Date.now()}`;
    const fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, buf);
    try { fs.fsyncSync(fd); } catch (e) {}
    fs.closeSync(fd);
    fs.renameSync(tmpPath, DB_PATH);
    persistDirty = false;
  } catch (err) {
    console.warn('[SQLite Persist Error]:', err.message);
  }
}

function schedulePersist() {
  persistDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushPersist();
  }, PERSIST_DEBOUNCE_MS);
  if (persistTimer.unref) persistTimer.unref();
}

function persistNow() {
  persistDirty = true;
  flushPersist();
}

function query(sql, params = []) {
  if (!db) throw new Error('SQLite database is not initialized. Please await dbService.ensureInit() first.');
  const stmt = db.prepare(sql);
  if (params && params.length > 0) stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const list = query(sql, params);
  return list.length > 0 ? list[0] : null;
}

function run(sql, params = []) {
  if (!db) throw new Error('SQLite database is not initialized. Please await dbService.ensureInit() first.');
  db.run(sql, params);
  schedulePersist();
  return true;
}

function runImmediate(sql, params = []) {
  // For boot-time recovery: mutate without scheduling (init flushes itself).
  if (!db) throw new Error('SQLite database is not initialized.');
  db.run(sql, params);
  return true;
}

/**
 * AUDIT FIX #1, v1.8.0 semantics (ZDola-style recovery): a task left in
 * 'running' by a crashed/killed session was picked up by a worker and its
 * prompt MAY already have been submitted to Flow — failing it outright
 * (the pre-v1.8 behavior) threw away a video that might already exist,
 * and blindly re-running it could charge credits twice. Instead the
 * task returns to 'pending' flagged needs_check = 1: on Resume, the
 * pool first looks for its video in the Flow project (check-only) and
 * only then decides. Tasks still 'pending' were never picked up and
 * resume normally. Returns how many tasks were recovered.
 */
function recoverInterruptedTasks() {
  const row = queryOne("SELECT COUNT(*) AS n FROM queue_tasks WHERE status = 'running'");
  const n = row ? Number(row.n) || 0 : 0;
  if (n > 0) {
    runImmediate(
      "UPDATE queue_tasks SET status = 'pending', needs_check = 1, error_reason = 'interrupted — will verify in Flow before any re-run' WHERE status = 'running'"
    );
  }
  recoveredInterruptedCount = n;
  return n;
}

function addColumnIfMissing(table, columnDef) {
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (e) {
    // Column already exists — migrations are idempotent by design.
  }
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      google_name TEXT,
      credits INTEGER,
      proxy_url TEXT DEFAULT '',
      status TEXT DEFAULT 'Need Login',
      dir_name TEXT NOT NULL,
      selected INTEGER DEFAULT 1,
      last_checked TEXT,
      chrome_profile_dir TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS queue_tasks (
      id TEXT PRIMARY KEY,
      batch_id TEXT,
      prompt_text TEXT NOT NULL,
      prompt_index INTEGER DEFAULT 0,
      settings_json TEXT,
      status TEXT DEFAULT 'pending',
      assigned_account_id TEXT,
      assigned_account_name TEXT,
      video_url TEXT,
      file_path TEXT,
      file_name TEXT,
      file_size_mb TEXT,
      duration TEXT,
      aspect_ratio TEXT,
      model TEXT,
      quality TEXT,
      error_reason TEXT,
      retry_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // v1.8.0 migrations (ZDola-logic edition): timed account rest +
  // two-strike sign-out tracking on accounts; check-only recovery flag
  // on tasks. Guarded ALTERs keep existing databases untouched otherwise.
  addColumnIfMissing('accounts', "rest_until TEXT DEFAULT ''");
  addColumnIfMissing('accounts', 'signout_strikes INTEGER DEFAULT 0');
  addColumnIfMissing('accounts', "strike_at TEXT DEFAULT ''");
  addColumnIfMissing('accounts', 'cooldown_level INTEGER DEFAULT 0');
  addColumnIfMissing('queue_tasks', 'needs_check INTEGER DEFAULT 0');
  // v2.3.0: the prompt's TAG (smart parser: `#00-01`, `scene3`, …) —
  // downloads are named by it and the sequence report checks by it.
  addColumnIfMissing('queue_tasks', "prompt_tag TEXT DEFAULT ''");

  recoveredInterruptedCount = recoverInterruptedTasks();
  persistDirty = true;
  flushPersist();
}

const initPromise = initSqlJs(wasmBinary ? { wasmBinary } : {}).then(sqlInstance => {
  SQL = sqlInstance;
  if (fs.existsSync(DB_PATH)) {
    try {
      db = new SQL.Database(fs.readFileSync(DB_PATH));
    } catch (e) {
      console.warn('[DB load fallback]:', e.message);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }
  initSchema();
  isInitialized = true;
  return db;
}).catch(err => {
  console.error('[SQLite Init Error]:', err);
  throw err;
});

function mapAccountRow(a) {
  return {
    id: a.id,
    name: a.name,
    email: a.email,
    credits: (a.credits === null || a.credits === undefined) ? null : Number(a.credits),
    status: a.status,
    selected: Boolean(a.selected),
    googleName: a.google_name,
    proxyUrl: a.proxy_url,
    dirName: a.dir_name,
    lastChecked: a.last_checked,
    chromeProfileDir: a.chrome_profile_dir || '',
    restUntil: a.rest_until || '',
    signoutStrikes: Number(a.signout_strikes) || 0,
    strikeAt: a.strike_at || '',
    cooldownLevel: Number(a.cooldown_level) || 0,
    hasCookies: !!a.has_cookies
  };
}

const dbService = {
  isReady() {
    return isInitialized && !!db;
  },

  async ensureInit() {
    if (!isInitialized || !db) await initPromise;
    return db;
  },

  persistNow,
  recoverInterruptedTasks,
  getRecoveredInterruptedCount() { return recoveredInterruptedCount; },
  getDataDir() { return DATA_DIR; },

  // ---------- Accounts (raw targeted access; credit/status RULES live in creditService) ----------
  getAccounts() {
    // v2.4.0: each account also carries its lifetime completed-video
    // count (the ZDola-style compact row shows "N videos"). One
    // grouped query, mapped onto the rows by assigned account.
    const rows = query('SELECT * FROM accounts ORDER BY created_at ASC');
    let counts = {};
    try {
      const grouped = query("SELECT assigned_account_id AS aid, COUNT(*) AS n FROM queue_tasks WHERE status = 'completed' AND assigned_account_id IS NOT NULL GROUP BY assigned_account_id");
      for (const g of grouped || []) counts[g.aid] = Number(g.n) || 0;
    } catch (e) { counts = {}; }
    return rows.map(a => ({ ...mapAccountRow(a), videosCount: counts[a.id] || 0 }));
  },

  getAccount(id) {
    const row = queryOne('SELECT * FROM accounts WHERE id = ?', [id]);
    return row ? mapAccountRow(row) : null;
  },

  insertAccount(account) {
    run(`
      INSERT INTO accounts (id, name, email, google_name, credits, proxy_url, status, dir_name, selected, last_checked, chrome_profile_dir)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      account.id,
      account.name,
      account.email || '',
      account.googleName || account.name || '',
      (account.credits === null || account.credits === undefined) ? null : Number(account.credits),
      account.proxyUrl || '',
      account.status || 'Need Login',
      account.dirName || account.id,
      account.selected === false ? 0 : 1,
      account.lastChecked || '',
      account.chromeProfileDir || ''
    ]);
    return this.getAccount(account.id);
  },

  /**
   * The ONLY low-level account mutator: a targeted single-row UPDATE built
   * exclusively from the fields provided. Callers (creditService /
   * accountStore) always pass fields derived from a FRESH read — never a
   * stale full-array snapshot.
   */
  updateAccountFields(id, fields) {
    const columnMap = {
      name: 'name',
      email: 'email',
      googleName: 'google_name',
      credits: 'credits',
      proxyUrl: 'proxy_url',
      status: 'status',
      selected: 'selected',
      lastChecked: 'last_checked',
      chromeProfileDir: 'chrome_profile_dir',
      restUntil: 'rest_until',
      signoutStrikes: 'signout_strikes',
      strikeAt: 'strike_at',
      cooldownLevel: 'cooldown_level',
      hasCookies: 'has_cookies'
    };
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(fields || {})) {
      const col = columnMap[key];
      if (!col) continue;
      sets.push(`${col} = ?`);
      if (key === 'credits') {
        params.push((value === null || value === undefined) ? null : Number(value));
      } else if (key === 'selected') {
        params.push(value ? 1 : 0);
      } else {
        params.push(value);
      }
    }
    if (sets.length === 0) return this.getAccount(id);
    params.push(id);
    run(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.getAccount(id);
  },

  deleteAccount(id) {
    run('DELETE FROM accounts WHERE id = ?', [id]);
  },

  // ---------- Queue tasks ----------
  createBatchTasks(batchId, prompts, settings) {
    const now = Date.now();
    (Array.isArray(prompts) ? prompts : []).forEach((p, idx) => {
      // v2.3.0: a prompt item may be a plain string (old callers) or
      // { text, tag, index } from the smart parser / missing-retry.
      // `index` preserves the ORIGINAL prompt position — a retried
      // missing scene keeps its number, it is never renumbered.
      const item = (p && typeof p === 'object')
        ? { text: String(p.text || ''), tag: String(p.tag || ''), index: p.index }
        : { text: String(p || ''), tag: '', index: undefined };
      const promptIndex = Number.isInteger(item.index) ? item.index : idx;
      run(`
        INSERT INTO queue_tasks (id, batch_id, prompt_text, prompt_index, prompt_tag, settings_json, status, duration, aspect_ratio, model, quality)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `, [
        `task_${now}_${idx + 1}`,
        batchId,
        item.text,
        promptIndex,
        item.tag.slice(0, 60),
        JSON.stringify(settings || {}),
        (settings && settings.duration) || '6s',
        (settings && settings.aspectRatio) || '9:16',
        (settings && settings.model) || 'Omni Flash',
        (settings && settings.quality) || '360p'
      ]);
    });
    return this.getPendingTasks(batchId);
  },

  getPendingTasks(batchId = null) {
    if (batchId) {
      return query("SELECT * FROM queue_tasks WHERE batch_id = ? AND status = 'pending' ORDER BY prompt_index ASC", [batchId]);
    }
    return query("SELECT * FROM queue_tasks WHERE status = 'pending' ORDER BY prompt_index ASC");
  },

  getTask(id) {
    return queryOne('SELECT * FROM queue_tasks WHERE id = ?', [id]);
  },

  /**
   * v1.8.0: every task still waiting to run, across all batches, in the
   * order it was created — the Resume surface. Includes needs_check
   * tasks recovered from an interrupted session.
   */
  getResumableTasks() {
    return query("SELECT * FROM queue_tasks WHERE status = 'pending' ORDER BY created_at ASC, prompt_index ASC");
  },

  getNeedsCheckTasks() {
    return query("SELECT * FROM queue_tasks WHERE status = 'pending' AND needs_check = 1 ORDER BY created_at ASC, prompt_index ASC");
  },

  /**
   * v2.4.0: every task that is still OPEN — pending (including
   * needs_check rows) or running right now. The duplicate-charge
   * guard (engine/promptMatch.js) matches freshly pasted prompts
   * against these before a new run may charge credits twice for a
   * render that is already paid for.
   */
  getOpenTasks() {
    return query("SELECT * FROM queue_tasks WHERE status IN ('pending', 'running') ORDER BY created_at ASC, prompt_index ASC");
  },

  setTaskNeedsCheck(taskId, flag) {
    run('UPDATE queue_tasks SET needs_check = ? WHERE id = ?', [flag ? 1 : 0, taskId]);
    return this.getTask(taskId);
  },

  updateTaskProgress(taskId, status, assignedAccountId = null, assignedAccountName = null) {
    run(`
      UPDATE queue_tasks
      SET status = ?,
          assigned_account_id = COALESCE(?, assigned_account_id),
          assigned_account_name = COALESCE(?, assigned_account_name)
      WHERE id = ?
    `, [status, assignedAccountId, assignedAccountName, taskId]);
  },

  completeTask(taskId, result) {
    run(`
      UPDATE queue_tasks
      SET status = 'completed',
          video_url = ?,
          file_path = ?,
          file_name = ?,
          file_size_mb = ?,
          completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      (result && result.videoUrl) || '',
      (result && result.filePath) || '',
      (result && result.fileName) || '',
      (result && result.fileSizeMb) || '',
      taskId
    ]);
  },

  /**
   * v2.3.0: sequence-report rename — a completed task's file was
   * renamed on disk to its tag name; keep the record in step.
   */
  updateTaskFile(taskId, filePath, fileName) {
    run('UPDATE queue_tasks SET file_path = ?, file_name = ? WHERE id = ?', [filePath || '', fileName || '', taskId]);
    return this.getTask(taskId);
  },

  failTask(taskId, errorReason) {
    run(`
      UPDATE queue_tasks
      SET status = 'failed',
          error_reason = ?,
          retry_count = retry_count + 1,
          completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [errorReason || 'Unknown error', taskId]);
  },

  cancelRunningTasks(batchId) {
    run("UPDATE queue_tasks SET status = 'cancelled' WHERE batch_id = ? AND status = 'running'", [batchId]);
  },

  getHistory(limit = 300) {
    return query(
      "SELECT * FROM queue_tasks WHERE status IN ('completed', 'failed') ORDER BY rowid DESC LIMIT ?",
      [limit]
    );
  },

  getFailedTasks() {
    return query("SELECT * FROM queue_tasks WHERE status = 'failed' ORDER BY rowid DESC");
  },

  clearHistory() {
    run("DELETE FROM queue_tasks WHERE status IN ('completed', 'failed', 'cancelled')");
  },

  /**
   * v2.2.0: delete SELECTED history rows (History table's bulk bar).
   * Only finished rows (completed/failed/cancelled) may be deleted —
   * pending/running tasks are never touched, whatever ids arrive.
   * Returns the number of rows actually deleted.
   */
  deleteHistoryTasks(ids) {
    const list = (Array.isArray(ids) ? ids : []).map(v => String(v || '')).filter(Boolean).slice(0, 500);
    let deleted = 0;
    for (const id of list) {
      const before = queryOne('SELECT id FROM queue_tasks WHERE id = ?', [id]);
      if (!before) continue;
      run("DELETE FROM queue_tasks WHERE id = ? AND status IN ('completed', 'failed', 'cancelled')", [id]);
      const after = queryOne('SELECT id FROM queue_tasks WHERE id = ?', [id]);
      if (!after) deleted++;
    }
    return deleted;
  },

  // ---------- App settings ----------
  getSetting(key, defaultValue = null) {
    const row = queryOne('SELECT value FROM app_settings WHERE key = ?', [key]);
    return row ? row.value : defaultValue;
  },

  setSetting(key, value) {
    run(`
      INSERT INTO app_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, [key, String(value)]);
  },

  query,
  queryOne,
  run
};

module.exports = { dbService };
