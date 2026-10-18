const { FlowAutomationEngine } = require('./flowAutomation');
const { getAccounts } = require('./accountStore');
const { dbService } = require('./db');
const { getCreditService } = require('./creditService');
const { TaskQueue } = require('./taskQueue');
const accountHealth = require('./accountHealth');
const usageStats = require('./usageStats');
const failover = require('./failover');
const { createCreditWatch } = require('./creditWatch');
const { recordActivity } = require('./activityStore');
const plainError = require('./plainError');
const tileState = require('./tileState');
const stallWatch = require('./stallWatch');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * FlowStudio Lite — WorkerPool (adapted from the V2 skeleton).
 *
 * AUDIT FIX #1 (the big one): a worker exception can NEVER crash the pool
 * or wedge the queue. In V2 the catch block referenced `currentTask`, a
 * const declared inside the loop — a ReferenceError inside the error
 * handler itself, which killed the worker and left tasks stuck in
 * 'running' forever. Here:
 *  - `currentTask` lives in WORKER scope, declared before the loop.
 *  - Every task-processing step runs inside its own try/catch. On error,
 *    ONLY the current task is failed (with the reason), the worker's
 *    browser is closed cleanly, the account assignment is released, and
 *    the worker moves on to the next task / account.
 *  - runWorker has an outer finally that always closes the browser and
 *    unregisters the worker — no orphaned browsers, ever.
 *  - The pool constructor + runQueue start call
 *    dbService.recoverInterruptedTasks(), so any task a previous crashed
 *    session left in 'running' is reset to 'failed: interrupted'.
 *
 * Credit/status writes go ONLY through creditService (fix #4), via the
 * creditPort handed to each engine. Low balances rotate as 'LowCredits'
 * with the balance intact (fix #2); logins keep the balance (fix #3).
 */
class WorkerPool {
  constructor(options = {}) {
    // v2.0.0: parallel generation widened to 1..5 workers (owner's order:
    // default 3 — see main.js). Burst per worker stays capped at 4.
    this.concurrency = Math.max(1, Math.min(5, Number(options.concurrency) || 1));
    // Bounded launch retry (v1.1 freeze fix): a Chrome launch / profile-busy
    // failure is retried at most maxLaunchAttempts times per account per
    // run, with an async backoff between attempts — never a tight loop.
    this.maxLaunchAttempts = Math.max(1, Number(options.maxLaunchAttempts) || 2);
    const lb = Number(options.launchBackoffMs);
    this.launchBackoffMs = Number.isFinite(lb) ? Math.max(0, lb) : 1500;
    // v2.1.0: single-account failover retry — when a task fails and NO
    // other eligible account exists, it retries on the SAME account
    // after this backoff (owner's PC test: with exactly one account the
    // v2.0.0 failover dead-ended the task). Options exist for tests.
    const sab = Number(options.sameAccountBackoffMs);
    this.sameAccountBackoffMs = Number.isFinite(sab) ? Math.max(0, sab) : 60000;
    this.maxSameAccountAttempts = Math.max(1, Number(options.maxSameAccountAttempts) || 3);
    this.headless = !!options.headless;
    // v2.5.0: "Sirf live accounts chalao" (Accounts page toggle) —
    // when ON, account selection only ever picks accounts whose live
    // status is Ready / Low Credits ("live ready"); every other
    // account is invisible to the run. Default OFF = purana bartav.
    this.liveOnly = !!options.liveOnly;
    this.onLog = options.onLog || (() => {});
    this.onProgress = options.onProgress || (() => {});
    this.onWorkerUpdate = options.onWorkerUpdate || (() => {});
    this.onVideoStarted = options.onVideoStarted || (() => {});
    this.onVideoProgress = options.onVideoProgress || (() => {});
    this.onVideoCompleted = options.onVideoCompleted || (() => {});
    this.onAccountUpdated = options.onAccountUpdated || (() => {});
    this.onTaskUpdate = options.onTaskUpdate || (() => {});
    // v2.3.0: fired once per run with { batchId, taskIds, downloadFolder }
    // so main can build the SEQUENCE REPORT for exactly this run's tasks.
    this.onRunStart = options.onRunStart || (() => {});

    this.isStopping = false;
    this.isPaused = false;
    this.activeWorkers = new Map(); // workerId -> FlowAutomationEngine
    this.assignedAccounts = new Set(); // accountId currently bound to a worker
    this.queuePromise = null;
    this.currentBatchId = null;

    // Boot recovery (audit fix #1): no task may remain 'running' from a
    // previous crashed session. db.js also does this at init; calling it
    // here keeps the guarantee even if the DB was opened earlier.
    try {
      const n = dbService.recoverInterruptedTasks();
      if (n > 0) {
        this.log(`Found ${n} incomplete tasks from the previous closed session — they have been made pending again; each one will be checked in Flow first and will NOT be resubmitted without a check.`, 'warn');
      }
    } catch (e) {}
  }

  log(msg, type = 'info', extra = {}) {
    this.onLog({ message: msg, type, timestamp: new Date().toLocaleTimeString(), ...extra });
  }

  pause() {
    this.isPaused = true;
    for (const engine of this.activeWorkers.values()) {
      try { engine.pause(); } catch (e) {}
    }
    // v2.4.0: this pool line is the ONLY pause line (the engines no
    // longer log their own — the owner's log showed every pause twice).
    this.log('The whole queue has been stopped (PAUSED) — all workers are stopped. Videos that are already generating will stop only after downloading completely.', 'warn');
  }

  resume() {
    this.isPaused = false;
    for (const engine of this.activeWorkers.values()) {
      try { engine.resume(); } catch (e) {}
    }
    this.log('The queue has started again (RESUMED).', 'success');
  }

  async stop() {
    this.isStopping = true;
    this.isPaused = false;
    const engines = [...this.activeWorkers.values()];
    for (const engine of engines) {
      try { engine.stop(); } catch (e) {}
    }
    await Promise.all(engines.map(engine => engine.closeBrowser().catch(() => {})));
    if (this.queuePromise) {
      await Promise.race([
        this.queuePromise.catch(() => {}),
        sleep(6000)
      ]);
    }
    this.activeWorkers.clear();
    this.assignedAccounts.clear();
    this.log('The queue has been closed (STOPPED).', 'warn');
  }

  _creditPort() {
    const cs = getCreditService();
    // v2.0.0: spend ledger for the credits dashboard. Fed ONLY through
    // this port (generation submissions) — syncs/verify reads use other
    // paths and never pollute "aaj ka kharch".
    const watch = createCreditWatch(dbService);
    const notify = (accountId) => {
      if (!accountId) return;
      const acc = dbService.getAccount(accountId);
      if (acc) this.onAccountUpdated({ account: acc, accounts: getAccounts() });
    };
    return {
      liveBalance: (accountId, balance) => {
        try { watch.observeLiveBalance(accountId, balance); } catch (e) {}
        const r = cs.applyLiveBalance(accountId, balance); notify(accountId); return r;
      },
      exhaustionBanner: (accountId) => { const r = cs.applyExhaustionBanner(accountId); notify(accountId); return r; },
      lowCredits: (accountId, required) => { const r = cs.applyLowCredits(accountId, required); notify(accountId); return r; },
      estimatedCharge: (accountId, cost) => {
        const r = cs.applyEstimatedCharge(accountId, cost);
        try { watch.observeEstimatedCharge(accountId, cost, r && r.outcome); } catch (e) {}
        notify(accountId); return r;
      },
      // v1.8.0: sign-out is a two-strike OBSERVATION now (ZDola
      // double-confirm) — one redirect marks 'Unconfirmed', only a
      // second explicit redirect confirms 'Need Login'.
      signOut: (accountId) => { const r = cs.applySignOutObservation(accountId); notify(accountId); return r; },
      ambiguous: (accountId) => { const r = cs.applyAmbiguousCheck(accountId); return r; },
      cooldown: (accountId) => {
        const r = cs.applyCooldown(accountId); notify(accountId);
        try {
          const acc = (r && r.account) || dbService.getAccount(accountId);
          const name = acc ? (acc.googleName || acc.name) : 'Account';
          recordActivity({
            category: 'credits', level: 'warn', accountId, accountName: name,
            stage: 'cooldown',
            detail: `Google reported "unusual activity" on this account, so the account has been put on a timed rest (cooldown) of ${r && r.minutes ? r.minutes : '?'} minutes — credits are completely safe, nothing was deducted. As soon as the rest ends, the account will return to rotation by itself. If cooldowns keep happening, the rest gets longer (30 min → 2 hours → 12 hours).`,
            message: `Cooldown: ${name} — unusual activity, ${r && r.minutes ? r.minutes : '?'} min rest`
          });
        } catch (e) {}
        return r;
      }
    };
  }

  _findNextAvailableAccount(pool, requiredCredits, unusableAccounts, afterAccountId) {
    // v2.0.0: ROUND-ROBIN scan — the search starts just AFTER the
    // account this worker was last bound to (wrapping around). Before
    // v2.0 the scan always restarted at the pool head, which was safe
    // only because a rotated-away account had usually changed status.
    // Failover (v2.0.0) rotates away from accounts whose status did NOT
    // change (e.g. a render timeout) — restarting at the head would
    // re-bind the same account forever and the task would never reach
    // the next account. Behaviour for status-blocked accounts is
    // unchanged: they are skipped wherever the scan starts.
    let start = 0;
    if (afterAccountId) {
      const idx = pool.findIndex(a => a.id === afterAccountId);
      if (idx >= 0) start = idx + 1;
    }
    for (let k = 0; k < pool.length; k++) {
      const candidate = pool[(start + k) % pool.length];
      if (unusableAccounts && unusableAccounts.has(candidate.id)) continue;
      const live = dbService.getAccount(candidate.id) || candidate;
      if (this.assignedAccounts.has(candidate.id)) continue;
      if (live.status === 'Exhausted' || live.status === 'Need Login' || live.status === 'Unconfirmed') continue;
      // v2.5.0: live-only mode — sirf Live / Ready accounts hi chune
      // jayenge, baaki sab is run ke liye invisible hain.
      if (this.liveOnly && !WorkerPool.LIVE_READY_STATUSES.has(live.status)) continue;
      // v1.8.0: Cooldown is a TIMED rest — an account whose rest has
      // expired is eligible again (openFlowStudio live-checks it first).
      if (live.status === 'Cooldown' && accountHealth.isResting(live)) continue;
      const credits = (typeof live.credits === 'number') ? live.credits : null;
      if (credits !== null && credits < requiredCredits) continue;
      return live;
    }
    return null;
  }

  /**
   * v1.8.0 — CHECK-ONLY RECOVERY for tasks flagged needs_check (they
   * were mid-flight when the app last closed, so their prompts may
   * already have been submitted to Flow). For each affected account the
   * EXISTING Flow project is opened and each prompt's video is looked
   * up by fingerprint: found + downloadable -> completed WITHOUT
   * spending credits again; found but not downloadable -> failed with
   * the reason; not found -> failed with the reason (never blindly
   * re-submitted — that could double-charge credits; the user has
   * per-task Retry). If the project cannot be opened at all, the rows
   * stay pending + flagged for a later Resume.
   * Returns the set of task ids this run must NOT process normally
   * (resolved rows AND rows left for a later resume).
   */
  async _reconcileNeedsCheck(checkRows, downloadFolder, settings) {
    const handled = new Set();
    const byAccount = new Map();
    for (const row of checkRows) {
      const key = row.assigned_account_id || '';
      if (!byAccount.has(key)) byAccount.set(key, []);
      byAccount.get(key).push(row);
    }

    for (const [accountId, group] of byAccount) {
      const account = accountId ? dbService.getAccount(accountId) : null;
      if (!account) {
        for (const row of group) {
          const reason = 'Recovered after restart, but the account it was running on no longer exists. It was NOT re-submitted.';
          try { dbService.failTask(row.id, reason); } catch (e) {}
          try { dbService.setTaskNeedsCheck(row.id, 0); } catch (e) {}
          this.onTaskUpdate({ taskId: row.id, promptIndex: row.prompt_index, promptText: row.prompt_text, status: 'failed', reason });
          handled.add(row.id);
        }
        continue;
      }

      const engine = new FlowAutomationEngine({
        onLog: (data) => { this.onLog({ ...data, message: `[Recovery]: ${data.message}` }); },
        onTaskCompleted: (task, result) => {
          try { dbService.completeTask(task.taskId, result); } catch (e) {}
          try { usageStats.recordSaved(dbService); } catch (e) {}
          recordActivity({
            category: 'generation', level: 'success', accountId: account.id,
            accountName: account.googleName || account.name,
            stage: 'recovery',
            taskId: task.taskId || null,
            promptIndex: typeof task.promptIndex === 'number' ? task.promptIndex : null,
            detail: `This prompt had already been sent to Flow before the app closed. It was NOT submitted again (that would deduct credits twice) — its tile was found in the Flow project and that same video was downloaded. File: ${result.fileName}`,
            message: `Recovery: Prompt #${(task.promptIndex || 0) + 1}'s video was found in Flow — downloaded without extra credits (${result.fileName})`
          });
          this.onTaskUpdate({
            taskId: task.taskId,
            promptIndex: task.promptIndex,
            promptText: task.promptText,
            status: 'done',
            filePath: result.filePath,
            fileName: result.fileName
          });
        },
        onTaskFailed: () => {}
      }, {
        headless: this.headless,
        workerId: 'recovery',
        creditPort: this._creditPort()
      });

      try {
        let ready = false;
        const launched = await engine.launchBrowserForAccount(account, downloadFolder).catch(() => false);
        if (launched) {
          const st = await engine.openFlowStudio({ ...settings, canvasStrategy: 'existing' }).catch(() => null);
          ready = (st === 'READY');
        }
        if (!ready) {
          this.log(`Recovery: [${account.name}]'s Flow project could not be opened, so ${group.length} old tasks will stay pending — press Resume later to check again. Nothing was resubmitted.`, 'warn');
          for (const row of group) handled.add(row.id);
          continue;
        }

        for (const row of group) {
          handled.add(row.id);
          const taskObj = {
            taskId: row.id,
            promptText: row.prompt_text,
            promptIndex: row.prompt_index,
            tag: row.prompt_tag || '',
            videoId: row.id,
            startTime: Date.now(),
            downloaded: false,
            completed: false
          };
          let res = null;
          try { res = await engine.reconcileRecoveredTask(taskObj, downloadFolder, settings); } catch (e) { res = null; }
          try { dbService.setTaskNeedsCheck(row.id, 0); } catch (e) {}
          if (res && res.found && res.downloaded) {
            this.log(`Recovery: Prompt #${row.prompt_index + 1}'s video already existed in [${account.name}]'s Flow project — that same one was downloaded. No credits were deducted again.`, 'success');
          } else if (res && res.found) {
            const reason = 'Recovered after restart: this prompt\'s tile exists in the Flow project but no downloadable video was found (it may still be rendering, or it failed on Flow). It was NOT re-submitted, to avoid a double credit charge — download it from the Flow project, or use Retry.';
            try { dbService.failTask(row.id, reason); } catch (e) {}
            this.onTaskUpdate({ taskId: row.id, promptIndex: row.prompt_index, promptText: row.prompt_text, status: 'failed', reason });
            this.log(`Recovery: Prompt #${row.prompt_index + 1}'s tile was found in the project, but no downloadable video was found on it. Marked as failed (NOT resubmitted).`, 'warn');
          } else {
            const reason = 'Interrupted by an app close. No matching video was found in the account\'s latest Flow project, so it was NOT auto-resubmitted (that could double-charge credits). Use Retry to run it again.';
            try { dbService.failTask(row.id, reason); } catch (e) {}
            this.onTaskUpdate({ taskId: row.id, promptIndex: row.prompt_index, promptText: row.prompt_text, status: 'failed', reason });
            this.log(`Recovery: No video matching Prompt #${row.prompt_index + 1} was found in the Flow project. Marked as failed (NOT resubmitted).`, 'warn');
          }
        }
      } finally {
        await engine.closeBrowser().catch(() => {});
      }
    }
    return handled;
  }

  async runQueue(prompts, settings = {}, downloadFolder = '', opts = {}) {
    let queueResolver;
    this.queuePromise = new Promise(resolve => { queueResolver = resolve; });

    try {
      this.isStopping = false;
      this.isPaused = false;
      this.activeWorkers.clear();
      this.assignedAccounts.clear();

      // v1.8.0: a run is either FRESH prompts (task rows are created) or
      // a RESUME of existing pending rows (opts.existingTasks) — the
      // queue now survives app restarts.
      let batchId;
      let pendingTasks;
      if (opts && Array.isArray(opts.existingTasks) && opts.existingTasks.length > 0) {
        pendingTasks = [...opts.existingTasks];
        if (!settings) {
          settings = {};
          try { settings = JSON.parse(pendingTasks[0].settings_json || '{}'); } catch (e) { settings = {}; }
          if (!settings.model) settings.model = pendingTasks[0].model || 'Omni Flash';
          if (!settings.duration) settings.duration = pendingTasks[0].duration || '6s';
          if (!settings.aspectRatio) settings.aspectRatio = pendingTasks[0].aspect_ratio || '9:16';
          if (!settings.type) settings.type = 'Video';
          if (!settings.quality) settings.quality = pendingTasks[0].quality || '360p';
          if (!settings.namingPattern) settings.namingPattern = 'tag';
        }
        batchId = pendingTasks[0].batch_id;
      } else {
        batchId = `batch_${Date.now()}`;
        pendingTasks = dbService.createBatchTasks(batchId, prompts, settings);
      }
      this.currentBatchId = batchId;
      this.batchIds = new Set(pendingTasks.map(t => t.batch_id).filter(Boolean));
      if (batchId) this.batchIds.add(batchId);
      // v2.3.0: tell main which tasks belong to THIS run (sequence report).
      try { this.onRunStart({ batchId, taskIds: pendingTasks.map(t => t.id), downloadFolder }); } catch (e) {}

      // v1.8.0 CHECK-ONLY RECOVERY runs before any new submission.
      const checkRows = pendingTasks.filter(t => t.needs_check);
      if (checkRows.length > 0 && !this.isStopping) {
        const handled = await this._reconcileNeedsCheck(checkRows, downloadFolder, settings);
        pendingTasks = pendingTasks.filter(t => !handled.has(t.id));
        if (pendingTasks.length === 0) {
          this.onProgress({ status: 'Completed' });
          this.log('Recovery check is complete — no prompt is left to generate now.', 'success');
          return;
        }
      }

      const requiredCredits = (settings.type === 'Image')
        ? 0
        : FlowAutomationEngine.prototype.getRequiredCredits(settings);
      const all = getAccounts();
      let pool = all.filter(a => a.status !== 'Need Login');
      // v2.5.0: "Sirf live accounts chalao" ON ho to pool sirf Live /
      // Ready accounts ka banta hai; ek bhi na mile to wajah saaf
      // bol kar run yahin rukta hai (khamosh fail kabhi nahi).
      if (this.liveOnly) {
        pool = pool.filter(a => WorkerPool.LIVE_READY_STATUSES.has(a.status));
        if (pool.length === 0) {
          this.log('"Only run live accounts" is ON, but no Live / Ready account was found. First make an account Live with Verify All on the Accounts page, or turn that toggle off and run again.', 'error');
          this.onProgress({ status: 'NoAccounts' });
          return;
        }
      }

      if (pool.length === 0) {
        this.log('No Google account is available (all need login). Add an account from the Accounts page and Sign In.', 'error');
        this.onProgress({ status: 'NoAccounts' });
        return;
      }

      const taskQueue = new TaskQueue(pendingTasks);

      for (const t of pendingTasks) {
        this.onTaskUpdate({ taskId: t.id, promptIndex: t.prompt_index, promptText: t.prompt_text, tag: t.prompt_tag || '', status: 'pending' });
      }

      const actualWorkersCount = Math.min(this.concurrency, pool.length, pendingTasks.length);
      // v2.7.0 (FIX 4): ginati pehle din se saaf — owner ki "main
      // problem" yahi thi: Settings me seema 3 thi, live account sirf
      // 1 tha, isliye 1 worker chala, aur app ne wajah kahin nahi
      // dikhayi. Ab seema / live / asal workers teeno har jagah ek
      // jaise shabdon me milte hain (log + Generate status line).
      this.log(`Queue is starting: ${pendingTasks.length} prompts · Limit (from Settings): ${this.concurrency} · Live available: ${pool.length} · Workers will run: ${actualWorkersCount}`, 'info');
      try {
        this.onProgress({
          status: WorkerPool.buildRunStatusText({ total: pendingTasks.length, active: 0, done: 0, failed: 0 }),
          runStats: { total: pendingTasks.length, active: 0, done: 0, failed: 0 },
          seema: this.concurrency,
          liveAccounts: pool.length,
          workersActive: actualWorkersCount
        });
      } catch (e) {}

      // v2.0.0 Activity: run start (+ resume note).
      if (opts && Array.isArray(opts.existingTasks) && opts.existingTasks.length > 0) {
        recordActivity({ category: 'system', level: 'info', message: `Queue resume: ${pendingTasks.length} pending prompt(s) are running again` });
      }
      recordActivity({ category: 'generation', level: 'info', message: `Generation started: ${pendingTasks.length} prompt(s) · ${actualWorkersCount} worker(s) in parallel` });

      const creditPort = this._creditPort();
      let completedCount = 0;

      // v2.0.0 FAILOVER (owner's order): a task that fails on one account
      // for an ACCOUNT-level reason (credits out / need-login / cooldown /
      // generation or download error) moves by itself to the queue for
      // the next eligible account — at most 3 account tries per task,
      // never the same account twice, prompt-policy failures never move.
      // Charges stay recorded per-account (creditService) — a failover
      // is a NEW submission on a DIFFERENT account, never a double record
      // on one. The submission claim is released ONLY for this
      // cross-account move after a recorded failure.
      //
      // v2.1.0 (owner's PC test): with exactly ONE account the move above
      // had nowhere to go — the burst guard skipped the task on the only
      // account it had tried, and the run ended with "(no usable account
      // remained)" even though that account was still Live with credits.
      // Now, when NO other eligible account exists, the task retries on
      // the SAME account after a backoff (the account must still be Live
      // with enough credits; per-account attempts are capped; policy /
      // stopped failures still never retry). "(no usable account
      // remained)" can now only appear when truly nothing is usable.
      // v2.6.0 (FIX B) — RUN STATUS, saaf shabdon me. The old status
      // text was a per-worker burst counter — "Running (2/4)" meant
      // "this worker is submitting its 2nd burst task of a max burst
      // of 4", which the owner understandably read as a prompt count
      // (he had TWO prompts; the 4 was the burst cap, not prompts).
      // The status now counts ONLY this run's own task rows
      // (pendingTasks — never older queue leftovers): how many are
      // generating right now, how many are done, how many finally
      // failed, and the run's total. The terminal words 'Completed' /
      // 'Stopped' / 'NoAccounts' are unchanged — the renderer keys
      // its end-of-run behaviour off them.
      const runStats = { total: pendingTasks.length, active: 0, done: 0, failed: 0 };
      const emitRunStatus = () => {
        // v2.7.0 (FIX 4): status ke saath ginati bhi bhejo — Generate
        // page ki saaf line ("Seema (Settings se): 3 · Live uplabdh:
        // 1 · Abhi chal rahe: 1") isi se banti hai.
        try {
          this.onProgress({
            status: WorkerPool.buildRunStatusText(runStats),
            runStats: { ...runStats },
            seema: this.concurrency,
            liveAccounts: pool.length,
            workersActive: this.activeWorkers.size
          });
        } catch (e) {}
      };
      // Bookkeeping by task id, so no path can double-count: a task
      // is "active" from the moment a worker picks it up until it
      // settles (done / finally failed) or moves (failover — it will
      // be picked up again and re-enter active then).
      const activeTaskIds = new Set();
      const settledTaskIds = new Set();
      const noteTaskActive = (id) => {
        if (!id || activeTaskIds.has(id)) return;
        activeTaskIds.add(id);
        runStats.active = activeTaskIds.size;
      };
      const noteTaskSettled = (id, outcome) => {
        if (!id) return;
        if (activeTaskIds.delete(id)) runStats.active = activeTaskIds.size;
        if ((outcome === 'done' || outcome === 'failed') && !settledTaskIds.has(id)) {
          settledTaskIds.add(id);
          if (outcome === 'done') runStats.done++;
          else runStats.failed++;
        }
        emitRunStatus();
      };

      const failoverTracker = failover.createFailoverTracker();
      let lastFailureReason = null;
      // v2.7.0 (FIX 2): DOWNLOAD-stage failures wait here for their
      // download-only retry. Entries carry the OWNING worker's engine
      // (the browser that still has the account's project open); the
      // worker drains its own entries after each monitor window.
      const deferredDownloadRetries = [];
      const failTaskOrFailover = (rowTask, reason, accountId, accountName, opts = {}) => {
        if (!rowTask || !rowTask.id) return 'failed';
        // v2.7.0 (FIX 2) — DOWNLOAD STAGE sabse pehle: video BAN gaya
        // tha, credits kat chuke the, sirf file save nahi hui. Aise
        // task ko failover ya same-account retry par bhejna matlab
        // prompt DOBARA submit karke credits DO BAAR kaatna (owner ke
        // burst run me bilkul yahi hua tha). Isliye:
        //   - failover NAHI (dusre account par tile hoti hi nahi),
        //   - resubmit NAHI (claim bhi release nahi hota),
        //   - task needs_check (download-retry) banta hai; worker
        //     apne khule browser me usi tile se SIRF download dobara
        //     try karega, aur browser/account na rahe to agla Resume
        //     check-only recovery wahi karega.
        if (opts.stage === 'download' && !this.isStopping) {
          try { dbService.updateTaskProgress(rowTask.id, 'pending'); } catch (e) {}
          try { dbService.setTaskNeedsCheck(rowTask.id, 1); } catch (e) {}
          deferredDownloadRetries.push({
            rowTask,
            engineTask: opts.engineTask || null,
            owner: opts.engine || null,
            accountId: accountId || null,
            accountName: accountName || '',
            reason,
            attempts: (opts.engineTask && opts.engineTask.downloadAttempts) || []
          });
          recordActivity({
            category: 'generation', level: 'warn', accountId: accountId || null, accountName: accountName || null,
            stage: 'download',
            taskId: rowTask.id,
            promptIndex: rowTask.prompt_index,
            reason,
            detail: `Prompt #${rowTask.prompt_index + 1}'s video HAD been generated on [${accountName || 'account'}] and credits had been deducted — only its file (download) could not be saved. The task was NOT failed and the prompt will NOT be SUBMITTED AGAIN (zero double charge). Now all download strategies will run again from that same tile in that same account's project. Failover did not happen for this reason: the generated tile exists only in THIS account's project; it does not exist on any other account.`,
            message: `Download fail: Prompt #${rowTask.prompt_index + 1} — the video had been generated, only the download will happen again (no new charge)`
          });
          this.log(`Prompt #${rowTask.prompt_index + 1}: the video had been generated — only the download failed. The prompt will NOT be submitted again; only the download will be retried from the same tile (no new charge).`, 'warn');
          this.onTaskUpdate({
            taskId: rowTask.id,
            promptIndex: rowTask.prompt_index,
            promptText: rowTask.prompt_text,
            tag: rowTask.prompt_tag || '',
            status: 'pending',
            reason: 'The video had been generated — only the download will happen again (no new charge)'
          });
          noteTaskSettled(rowTask.id, 'moved');
          return 'download-retry';
        }
        if (!this.isStopping) {
          const verdict = failoverTracker.canFailover(rowTask.id, reason);
          if (verdict.ok) {
            // Is there ANOTHER eligible account this task has not tried?
            const triedSet = failoverTracker.accountsTried(rowTask.id);
            const searchBlocked = new Set(unusableAccounts.keys());
            for (const id of triedSet) searchBlocked.add(id);
            const otherAccount = this._findNextAvailableAccount(pool, requiredCredits, searchBlocked, accountId || null);
            if (otherAccount) {
              try { dbService.updateTaskProgress(rowTask.id, 'pending'); } catch (e) {}
              try { taskQueue.releaseSubmission(rowTask.id); } catch (e) {}
              taskQueue.enqueue(rowTask);
              recordActivity({
                category: 'generation', level: 'warn', accountId: accountId || null, accountName: accountName || null,
                stage: 'failover',
                taskId: rowTask.id,
                promptIndex: rowTask.prompt_index,
                reason,
                detail: `Prompt #${rowTask.prompt_index + 1} stopped on [${accountName || 'account'}] for this reason: ${reason}. This fault is from the account's side (not the prompt's), so the task was not ended — now it will be sent to [${otherAccount.name}] (try ${verdict.tries + 1}/${verdict.maxTries}). The charge will apply only on the account where the video actually gets generated.`,
                message: `Failover: Prompt #${rowTask.prompt_index + 1}${accountName ? ` [${accountName}]` : ''} failed (${verdict.kind || 'error'}) — will be tried on another account (try ${verdict.tries + 1}/${verdict.maxTries})`
              });
              this.log(`Failover: Prompt #${rowTask.prompt_index + 1} will be tried on another account [${otherAccount.name}] (try ${verdict.tries + 1}/${verdict.maxTries}) — reason: ${reason}`, 'warn');
              this.onTaskUpdate({
                taskId: rowTask.id,
                promptIndex: rowTask.prompt_index,
                promptText: rowTask.prompt_text,
                status: 'pending',
                reason: `Failover — another account will be tried (try ${verdict.tries + 1}/${verdict.maxTries})`
              });
              noteTaskSettled(rowTask.id, 'moved');
              return 'failover';
            }

            // v2.1.0: NO other eligible account — same-account backoff
            // retry when the failed account itself is still usable.
            const retryVerdict = accountId
              ? failoverTracker.canSameAccountRetry(rowTask.id, accountId, reason, this.maxSameAccountAttempts)
              : { ok: false, kind: verdict.kind };
            if (retryVerdict.ok) {
              const fresh = dbService.getAccount(accountId);
              const stillUsable = !!fresh
                && fresh.status !== 'Need Login'
                && fresh.status !== 'Exhausted'
                && fresh.status !== 'Unconfirmed'
                && (!this.liveOnly || WorkerPool.LIVE_READY_STATUSES.has(fresh.status))
                && !(fresh.status === 'Cooldown' && accountHealth.isResting(fresh))
                && !unusableAccounts.has(accountId)
                && (typeof fresh.credits !== 'number' || requiredCredits === 0 || fresh.credits >= requiredCredits);
              if (stillUsable) {
                const backoffSec = Math.round(this.sameAccountBackoffMs / 1000);
                const attemptsUsed = failoverTracker.attempts(rowTask.id, accountId);
                failoverTracker.markSameAccountRetry(rowTask.id, accountId, Date.now() + this.sameAccountBackoffMs);
                try { dbService.updateTaskProgress(rowTask.id, 'pending'); } catch (e) {}
                try { taskQueue.releaseSubmission(rowTask.id); } catch (e) {}
                taskQueue.enqueue(rowTask);
                recordActivity({
                  category: 'generation', level: 'warn', accountId, accountName: accountName || null,
                  stage: 'failover',
                  taskId: rowTask.id,
                  promptIndex: rowTask.prompt_index,
                  reason,
                  detail: `Prompt #${rowTask.prompt_index + 1} stopped on [${accountName || 'account'}] for this reason: ${reason}. No other eligible account is available right now, but this account is still Live and has credits left — so the task was NOT ended. After waiting ${backoffSec} seconds, it will be tried again on THIS SAME account (try ${attemptsUsed + 1}/${this.maxSameAccountAttempts}).`,
                  message: `Same-account retry: Prompt #${rowTask.prompt_index + 1}${accountName ? ` [${accountName}]` : ''} — no other account, will retry on this one after ${backoffSec}s (try ${attemptsUsed + 1}/${this.maxSameAccountAttempts})`
                });
                this.log(`Prompt #${rowTask.prompt_index + 1}: no other account is available — after waiting ${backoffSec} seconds it will be tried again on this account [${accountName || ''}] (try ${attemptsUsed + 1}/${this.maxSameAccountAttempts}). Reason: ${reason}`, 'warn');
                this.onTaskUpdate({
                  taskId: rowTask.id,
                  promptIndex: rowTask.prompt_index,
                  promptText: rowTask.prompt_text,
                  status: 'pending',
                  reason: `No other account — will be tried again on this same account (after ${backoffSec}s, try ${attemptsUsed + 1}/${this.maxSameAccountAttempts})`
                });
                noteTaskSettled(rowTask.id, 'moved');
                return 'failover';
              }
            }
          }
        }
        lastFailureReason = reason;
        try { failoverTracker.clearSameAccountRetry(rowTask.id); } catch (e) {}
        try { dbService.failTask(rowTask.id, reason); } catch (e) {}
        {
          const kind = (failover.classifyFailure(reason) || {}).kind;
          const stageByKind = { generation: 'generation', download: 'download', credits: 'credits', 'need-login': 'login', cooldown: 'cooldown', 'prompt-policy': 'policy' };
          recordActivity({
            category: 'errors', level: 'error', accountId: accountId || null, accountName: accountName || null,
            stage: stageByKind[kind] || 'generation',
            taskId: rowTask.id,
            promptIndex: rowTask.prompt_index,
            reason,
            detail: kind === 'prompt-policy'
              ? `Prompt #${rowTask.prompt_index + 1} was stopped by Google's safety policy. This fault is from the prompt's side — the same will happen on every account, so credits were NOT wasted by trying other accounts. Change the prompt and send it again. Reason for stopping: ${reason}`
              : `Prompt #${rowTask.prompt_index + 1} finally failed — all allowed tries (other accounts + same-account retry) are over, or no usable account is left. Last reason: ${reason}. This task can be retried from History.`,
            message: `Task FAIL: Prompt #${rowTask.prompt_index + 1} — ${reason}`
          });
        }
        noteTaskSettled(rowTask.id, 'failed');
        return 'failed';
      };

      // v2.7.0 (FIX 2): DOWNLOAD-RETRY processor — a worker drains ITS
      // OWN deferred download failures while its browser is still open
      // on the account that owns the tiles. HAR round sirf download
      // hai (engine.retryDownloadForTask): koi submit nahi, koi credit
      // nahi. Teen nateeje:
      //   downloaded    → task complete (onTaskCompleted ne DB likha),
      //                   needs_check saaf.
      //   tile-missing  → task 'lost-render' ke roop me FAIL — plain
      //                   report ke saath; dobara banana user ka faisla
      //                   (Sequence report ka "Sirf Missing Dobara
      //                   Banao"), khamosh resubmit KABHI nahi.
      //   download-failed (tile maujood hai, ranneetiyan phir fail)
      //                   → task pending + needs_check hi rehta hai —
      //                   agla Resume check-only recovery sirf download
      //                   dobara try karega. Paid render chhoda nahi
      //                   gaya, jhoota fail bhi nahi likha gaya.
      const formatAttempts = (attempts) => {
        if (!Array.isArray(attempts) || attempts.length === 0) return 'no strategy was recorded';
        return attempts.map(a => `${a.strategy}: ${a.ok ? 'worked' : `failed (${a.note || 'reason not recorded'})`}`).join(' · ');
      };
      const processDownloadRetries = async (engine) => {
        const mine = deferredDownloadRetries.filter(e => e.owner === engine);
        for (const entry of mine) {
          const at = deferredDownloadRetries.indexOf(entry);
          if (at >= 0) deferredDownloadRetries.splice(at, 1);
          if (this.isStopping) continue; // row pending + needs_check hai — Resume sambhalega
          const { rowTask, engineTask } = entry;
          if (!engineTask) continue; // engine task ke bagair tile ki pehchan namumkin — Resume check-only karega
          this.log(`Prompt #${rowTask.prompt_index + 1}: download-only retry starting — from the same tile, no new submit/charge…`, 'info');
          let outcome = null;
          for (let round = 1; round <= 2; round++) {
            try {
              outcome = await engine.retryDownloadForTask(engineTask, downloadFolder, settings);
            } catch (e) {
              const t = plainError.translateError(e);
              this.log(`Prompt #${rowTask.prompt_index + 1}: problem during the download-retry — ${t.plain}.`, 'warn', { rawError: t.raw });
              outcome = { status: 'download-failed', attempts: engineTask.downloadAttempts || [] };
            }
            if (!outcome || outcome.status !== 'download-failed') break;
            if (round < 2 && !this.isStopping) {
              this.log(`Prompt #${rowTask.prompt_index + 1}: the download still did not happen — after a short wait, ONLY the download will be tried once more…`, 'warn');
              await sleep(3000);
            }
          }
          if (!outcome) continue;
          if (outcome.status === 'downloaded') {
            try { dbService.setTaskNeedsCheck(rowTask.id, 0); } catch (e) {}
            this.log(`Prompt #${rowTask.prompt_index + 1}: download-retry succeeded — the same generated video was saved, no new charge was applied.`, 'success');
          } else if (outcome.status === 'tile-missing') {
            const reason = 'The generated video was not found in the project (lost render): even after scanning the whole project, this prompt\'s tile was not found — a download-only retry was not possible, and the prompt was NOT quietly resubmitted.';
            try { dbService.setTaskNeedsCheck(rowTask.id, 0); } catch (e) {}
            try { dbService.failTask(rowTask.id, reason); } catch (e) {}
            recordActivity({
              category: 'errors', level: 'error', accountId: entry.accountId, accountName: entry.accountName || null,
              stage: 'download',
              taskId: rowTask.id,
              promptIndex: rowTask.prompt_index,
              reason,
              detail: `Prompt #${rowTask.prompt_index + 1}'s video had been made on [${entry.accountName || 'account'}] and credits had been deducted, but when the project was scanned again for the download-retry, its tile was NOT found anywhere (Flow may have removed it, or the project may have changed). The task has been failed as 'lost-render'. The prompt was NOT quietly RESUBMITTED — if you want it made again, run it yourself from the Sequence report's "Regenerate Missing Only", so the charge happens by your decision.`,
              message: `Lost render: Prompt #${rowTask.prompt_index + 1} — the generated tile was not found in the project, NOT resubmitted`
            });
            this.onTaskUpdate({ taskId: rowTask.id, promptIndex: rowTask.prompt_index, promptText: rowTask.prompt_text, tag: rowTask.prompt_tag || '', status: 'failed', reason });
            noteTaskSettled(rowTask.id, 'failed');
          } else {
            // download-failed, tile maujood: pending + needs_check
            // barkarar — agla Resume sirf download dobara try karega.
            recordActivity({
              category: 'generation', level: 'warn', accountId: entry.accountId, accountName: entry.accountName || null,
              stage: 'download',
              taskId: rowTask.id,
              promptIndex: rowTask.prompt_index,
              reason: entry.reason,
              detail: `Prompt #${rowTask.prompt_index + 1}'s tile EXISTS in [${entry.accountName || 'account'}]'s project (the video is generated), but in this run's download-retry too, no strategy could save the file. Strategy results: ${formatAttempts(outcome.attempts)}. The task has NOT been failed: it is in pending (check-only) — on the next Resume ONLY its download will happen again, the prompt will NOT be submitted again and NO new charge will apply. If you want, you can also download the video manually from the Flow project.`,
              message: `Download remaining: Prompt #${rowTask.prompt_index + 1} — the tile exists; on the next Resume only the download will happen again`
            });
            this.log(`Prompt #${rowTask.prompt_index + 1}: the tile exists but the download did not happen this time either — the task is kept in pending (check-only); on the next Resume only the download will happen again, no new charge.`, 'warn');
          }
        }
      };

      // v1.1 freeze fix: accounts that cannot launch / open the studio in
      // this run are remembered here (shared across workers) together with
      // the concrete reason, so no worker ever retries them in a tight
      // loop, and any prompts left over at the end are failed VISIBLY with
      // that reason instead of hanging in "Running…" forever.
      const unusableAccounts = new Map(); // accountId -> reason
      let lastStartError = null;

      const runWorker = async (workerIndex) => {
        const workerId = `worker_${workerIndex + 1}`;
        // WORKER-SCOPE task reference (audit fix #1): the error handler
        // below must always be able to see the task it was processing.
        let currentTask = null;
        let workerAccount = null;
        // Set when the bound account reports EXHAUSTED / LOW_CREDITS before a
        // prompt fires. Submission pauses on this account, the in-flight
        // window drains on the SAME browser (renders live server-side in
        // the project), and only then does the worker rotate.
        let accountBlocked = false;
        // Per-account launch/open attempts in this run (v1.1 freeze fix).
        const launchAttempts = new Map();
        // v2.0.0: bounds the failover tried-skip cycle — a worker that
        // keeps pulling tasks its bound account already tried (with no
        // other account to rotate to) stops instead of spinning.
        let triedSkips = 0;
        // v2.0.0: round-robin anchor — the account this worker was last
        // bound to; the next search starts after it.
        let lastBoundAccountId = null;

        const engine = new FlowAutomationEngine({
          onLog: (data) => {
            this.onLog({ ...data, workerId, message: `[Worker #${workerIndex + 1}${workerAccount ? ` (${workerAccount.name})` : ''}]: ${data.message}` });
          },
          onProgress: (p) => {
            this.onWorkerUpdate({ workerId, workerIndex, accountName: workerAccount ? workerAccount.name : '', ...p });
          },
          onVideoStarted: (data) => {
            this.onVideoStarted({ ...data, workerId, accountName: workerAccount ? workerAccount.name : '' });
            // Map engine video events back to the queue task. v1.9.0:
            // prefer THIS worker's current task — a multi-batch resume
            // can hold several tasks with the same prompt_index, and a
            // plain find() by index could highlight the wrong row (the
            // event fires synchronously inside submitPrompt, so
            // currentTask is always the task being submitted here).
            const idx = (data.promptIndex || 1) - 1;
            const t = (currentTask && currentTask.prompt_index === idx)
              ? currentTask
              : pendingTasks.find(pt => pt.prompt_index === idx);
            if (t) this.onTaskUpdate({ taskId: t.id, promptIndex: idx, promptText: t.prompt_text, tag: t.prompt_tag || '', status: 'generating', accountName: workerAccount ? workerAccount.name : '' });
          },
          onVideoProgress: (data) => {
            this.onVideoProgress({ ...data, workerId });
          },
          onVideoCompleted: (data) => {
            this.onVideoCompleted({ ...data, workerId, accountName: workerAccount ? workerAccount.name : '' });
          },
          onTaskCompleted: (task, result) => {
            try {
              dbService.completeTask(task.taskId, result);
            } catch (e) {}
            // v1.8.0: ZDola-style usage counting — counts only.
            try { usageStats.recordSaved(dbService); } catch (e) {}
            completedCount++;
            noteTaskSettled(task.taskId, 'done');
            recordActivity({
              category: 'generation', level: 'success',
              accountId: workerAccount ? workerAccount.id : null,
              accountName: workerAccount ? workerAccount.name : null,
              stage: 'download',
              taskId: task.taskId || null,
              promptIndex: typeof task.promptIndex === 'number' ? task.promptIndex : null,
              detail: `Prompt #${(task.promptIndex || 0) + 1}'s video was generated and also downloaded. File: ${result.fileName}${result.filePath ? ` · Save location: ${result.filePath}` : ''}${result.fileSizeMb ? ` · Size: ${result.fileSizeMb}` : ''}`,
              message: `Download complete: ${result.fileName}${task.tag ? ` · Tag ${task.tag}` : ''} · Prompt #${(task.promptIndex || 0) + 1}${workerAccount ? ` · ${workerAccount.name}` : ''}`
            });
            this.onTaskUpdate({
              taskId: task.taskId,
              promptIndex: task.promptIndex,
              promptText: task.promptText,
              tag: task.tag || '',
              status: 'done',
              filePath: result.filePath,
              fileName: result.fileName
            });
          },
          onTaskFailed: (task, reason) => {
            // v2.0.0: account-level failures fail over to the next
            // account (bounded); only a final failure updates the row
            // as failed here — failTaskOrFailover already emitted the
            // 'pending' update for a failover move.
            // v2.7.0: the engine marks DOWNLOAD-stage failures on the
            // task itself (task.failureStage) — the stage + the engine
            // task + this worker's engine travel with the call so the
            // failure can become a download-only retry, never a
            // credit-charging resubmit.
            const rowTask = pendingTasks.find(pt => pt.id === task.taskId)
              || { id: task.taskId, prompt_index: task.promptIndex, prompt_text: task.promptText };
            const outcome = failTaskOrFailover(rowTask, reason, workerAccount ? workerAccount.id : null, workerAccount ? workerAccount.name : '', {
              stage: task.failureStage || null,
              engineTask: task,
              engine
            });
            if (outcome === 'failed') {
              this.onTaskUpdate({
                taskId: task.taskId,
                promptIndex: task.promptIndex,
                promptText: task.promptText,
                tag: rowTask.prompt_tag || task.tag || '',
                status: 'failed',
                reason
              });
            }
          },
          onTaskHeartbeat: (task, info) => {
            // v2.4.0: the task's tile STATE changed (absent ->
            // generating / absent-active …). Activity gets the story
            // with its stage; the 'failed' transition is narrated by
            // the failure path itself, and 'ready' by the download —
            // recording them here too would double-tell both.
            const state = info && info.state;
            if (!state || state === 'failed' || state === 'ready') return;
            const stageByState = { generating: 'render', 'absent-active': 'render-wait', absent: 'render-wait' };
            recordActivity({
              category: 'generation', level: state === 'generating' ? 'info' : 'warn',
              accountId: workerAccount ? workerAccount.id : null,
              accountName: workerAccount ? workerAccount.name : ((info && info.accountName) || null),
              stage: stageByState[state] || 'render-wait',
              taskId: task.taskId || null,
              promptIndex: typeof task.promptIndex === 'number' ? task.promptIndex : null,
              detail: tileState.describeState(state, {
                promptIndex: typeof task.promptIndex === 'number' ? task.promptIndex : 0,
                elapsedSec: (info && info.elapsedSec) || 0,
                percentage: (info && info.percentage) || null
              }),
              message: state === 'generating'
                ? `Render started: Prompt #${(task.promptIndex || 0) + 1}'s tile has been found — the video is generating on Flow`
                : `Render wait: Prompt #${(task.promptIndex || 0) + 1}'s tile has not been identified yet — the search is continuing`
            });
          },
          onTaskStalled: (task, info) => {
            // v2.1.0: a submitted render's tile is missing and in-run
            // stall recovery has begun (engine/stallWatch.js). Record
            // the full story so the owner can see WHY nothing failed.
            const accName = workerAccount ? workerAccount.name : ((info && info.accountName) || '');
            const windowMin = info && info.recoveryWindowSec ? Math.max(1, Math.round(info.recoveryWindowSec / 60)) : 10;
            recordActivity({
              category: 'generation', level: 'warn',
              accountId: workerAccount ? workerAccount.id : null,
              accountName: accName || null,
              stage: 'render-wait',
              taskId: task.taskId || null,
              promptIndex: typeof task.promptIndex === 'number' ? task.promptIndex : null,
              detail: `Prompt #${(task.promptIndex || 0) + 1}'s video had been sent to Flow on [${accName}] and credits had been deducted, but its tile did not appear in the project even after ${info && info.stallAfterSec ? `${info.stallAfterSec} seconds` : 'a long time'}. Where it stopped: render-wait stage — Flow has not shown the tile yet (Flow is often slow, or the tile is hidden lower down in the grid). The task has NOT been failed: the app will now keep scanning the project (grid scroll + tile identification) and wait up to ${windowMin} minutes. As soon as the tile is found, that same video will be downloaded; only if it is not found will it fail after that.`,
              message: `Render wait: Prompt #${(task.promptIndex || 0) + 1}'s tile has not been found yet — recovery scan is continuing (task has NOT failed)`
            });
          },
          onRenderStall: (task, info) => {
            // v2.6.0: a bound, generating tile whose progress has
            // not moved for the whole watchdog budget (3 min). The
            // Activity entry names the last percentage, the frozen
            // duration, Flow's own words when the tile carries any,
            // and the plain possible causes — including the honest
            // background-mode note, since a throttled off-screen
            // window was the prime suspect in the owner's freeze.
            const accName = workerAccount ? workerAccount.name : ((info && info.accountName) || '');
            const frozenFor = stallWatch.formatDuration((info && info.stuckForSec) || 0);
            const pctNote = info && info.lastPct
              ? `Progress has been stuck at ${info.lastPct}`
              : 'Flow has not shown any progress % yet';
            const causes = info && info.background
              ? 'Possible reason: (1) the render is slow / in a queue from Flow\'s side — in such a state it usually gets made just by waiting; (2) in Background mode the Chrome window is off-screen — in v2.6.0 the window does NOT minimize and anti-throttling flags are set, still, if this happens again and again, try one run in Visible mode (turn Background off) and the difference will be clear.'
              : 'Possible reason: the render is slow / in a queue from Flow\'s side — in such a state it usually gets made just by waiting. If it stays stuck for long, there may be heavy load on Flow, or that prompt\'s render may have got stuck.';
            recordActivity({
              category: 'generation', level: 'warn',
              accountId: workerAccount ? workerAccount.id : null,
              accountName: accName || null,
              stage: 'render-stall',
              taskId: task.taskId || null,
              promptIndex: typeof task.promptIndex === 'number' ? task.promptIndex : null,
              reason: `Progress has not moved for ${frozenFor}${info && info.lastPct ? ` (stuck at ${info.lastPct})` : ''}`,
              detail: `Prompt #${(task.promptIndex || 0) + 1}'s tile [${accName}] had been found and the video was generating, but ${pctNote} — no change at all for ${frozenFor}.${info && info.queueHint ? ` ${info.queueHint}.` : ''} ${causes} The task has NOT failed yet: the run's total wait clock is running, and if progress starts moving again it will move ahead by itself.`,
              message: `Render stuck: Prompt #${(task.promptIndex || 0) + 1}'s progress has not moved for ${frozenFor}${info && info.lastPct ? ` (${info.lastPct})` : ''} — task has not failed yet`
            });
          },
          onBackendMedia: (task, info) => {
            // v2.8.0: is prompt ka video link Flow ke backend
            // (network) se bandha aur seedha fetch shuru hua — koi
            // button/menu nahi daba. Activity me ye khabar stage
            // 'download' ke saath aati hai; signed link khud kabhi
            // nahi likha jata, sirf host ka naam.
            const viaShabd = info && info.via === 'workflow-id'
              ? 'bound by workflowId identification'
              : (info && info.via === 'currentSrc' ? 'confirmed from the tile\'s currentSrc' : 'bound by sequence order');
            recordActivity({
              category: 'generation', level: 'info',
              accountId: workerAccount ? workerAccount.id : null,
              accountName: workerAccount ? workerAccount.name : null,
              stage: 'download',
              taskId: task.taskId || null,
              promptIndex: typeof task.promptIndex === 'number' ? task.promptIndex : null,
              detail: `Prompt #${(task.promptIndex || 0) + 1}'s video link was found from Flow's back end (backend/network) — ${viaShabd}${info && info.host ? ` · Host: ${info.host}` : ''}. No Download button or menu was pressed: the file is being fetched directly. (It will count as truly complete only when the file is saved + verified.)`,
              message: `Backend download: Prompt #${(task.promptIndex || 0) + 1}'s link was found from the backend — downloading directly`
            });
          },
          onAccountUpdated: (data) => {
            this.onAccountUpdated(data);
          }
        }, {
          headless: this.headless,
          workerId,
          creditPort
        });

        this.activeWorkers.set(workerId, engine);

        try {
          const activeWorkerTasks = [];
          const maxBurstConcurrency = Math.min(4, Math.max(1, Number(settings.burstConcurrency) || 4));

          while ((taskQueue.size() > 0 || activeWorkerTasks.length > 0) && !this.isStopping) {
            while (this.isPaused && !this.isStopping) {
              await sleep(1000);
            }
            if (this.isStopping) break;

            // ---- Ensure this worker has a usable account + open studio ----
            if (!workerAccount || !engine.browser || !engine.page || engine.page.isClosed()) {
              if (!workerAccount) {
                workerAccount = this._findNextAvailableAccount(pool, requiredCredits, unusableAccounts, lastBoundAccountId);
                if (!workerAccount) {
                  if (activeWorkerTasks.length === 0) {
                    if (taskQueue.size() > 0 && !lastStartError) {
                      lastStartError = 'No account with enough credits is left available for the remaining prompts.';
                    }
                    this.log(`Worker #${workerIndex + 1}: no free account with enough credits was found — this worker is stopping.`, 'warn');
                    break;
                  }
                } else {
                  this.assignedAccounts.add(workerAccount.id);
                  lastBoundAccountId = workerAccount.id;
                }
              }

              if (workerAccount && (!engine.browser || !engine.page || engine.page.isClosed())) {
                // v1.1 freeze fix: launch + studio entry are BOUNDED. In
                // v1.0 a failure here (e.g. PROFILE_BUSY because the user
                // left the account's login Chrome window open, or a bad
                // Chrome path) released the account and `continue`d with no
                // delay and no attempt limit — the SAME account was picked
                // again instantly, forever, flooding the log IPC and
                // starving the Electron main loop ("Not Responding").
                // Now: definitive credit states (NEED_LOGIN / EXHAUSTED /
                // LOW_CREDITS — creditService was already updated via the
                // credit port) retire the account for this run at once;
                // transient failures (launch error, busy profile, thrown
                // error) get at most maxLaunchAttempts tries, separated by
                // an async backoff, and the reason is surfaced.
                let studioStatus = null;
                let attemptError = null;
                try {
                  const launched = await engine.launchBrowserForAccount(workerAccount, downloadFolder);
                  if (!launched) {
                    attemptError = engine.lastLaunchError === 'PROFILE_BUSY'
                      ? `[${workerAccount.name}]'s Chrome profile is busy — ${engine.lastBusyDetail || 'it is open in another Chrome window. Close that window and press Generate again.'}`
                      : `Chrome could not open for [${workerAccount.name}] — ${plainError.plainOf(engine.lastLaunchError || 'unknown error')}`;
                  } else {
                    studioStatus = await engine.openFlowStudio(settings);
                  }
                } catch (openErr) {
                  attemptError = `Google Flow could not open for [${workerAccount.name}] — ${plainError.plainOf(openErr)}`;
                }

                if (attemptError || studioStatus !== 'READY') {
                  const reason = attemptError || `[${workerAccount.name}] is not usable for this run (studio status: ${studioStatus}).`;
                  const definitive = studioStatus === 'NEED_LOGIN' || studioStatus === 'EXHAUSTED' || studioStatus === 'LOW_CREDITS';
                  const attempts = (launchAttempts.get(workerAccount.id) || 0) + 1;
                  launchAttempts.set(workerAccount.id, attempts);

                  if (definitive || attempts >= this.maxLaunchAttempts) {
                    unusableAccounts.set(workerAccount.id, reason);
                    if (!lastStartError) lastStartError = reason;
                    this.log(`Worker #${workerIndex + 1}: ${reason} This account is being skipped for this whole run.`, 'error');
                    // v2.4.0 self-check (background mode): if Flow
                    // itself would not open while the browser is
                    // hidden, say so plainly and name the one-click
                    // alternative — never leave the owner guessing
                    // why a hidden-mode run is stuck.
                    if (this.headless && !attemptError && !definitive) {
                      this.log(`Worker #${workerIndex + 1}: Note — Background mode is ON and Flow could not open on [${workerAccount.name}] (status: ${studioStatus}). If this happens again and again, turn off the hidden-browser option in Generate/Settings and try in Visible mode.`, 'warn');
                    }
                  } else {
                    this.log(`Worker #${workerIndex + 1}: ${reason} After a short wait, one more try will happen (try ${attempts}/${this.maxLaunchAttempts})…`, 'warn');
                  }

                  await engine.closeBrowser().catch(() => {});
                  this.assignedAccounts.delete(workerAccount.id);
                  workerAccount = null;
                  if (this.launchBackoffMs > 0) await sleep(this.launchBackoffMs);
                  continue;
                }
              }
            }

            // ---- Burst submit: fill the sliding window ----
            while (activeWorkerTasks.length < maxBurstConcurrency && taskQueue.size() > 0 && !this.isStopping && !this.isPaused && !accountBlocked) {
              const nextTask = taskQueue.next();
              if (!nextTask) break;

              // v2.0.0 FAILOVER guard: a task that already failed on THIS
              // worker's account is never fired on it again — it goes to
              // the BACK of the queue for another account, and this
              // worker rotates away. If every account has been tried,
              // the worker stops pulling (bounded by triedSkips); the
              // task stays queued for another worker or fails visibly
              // at the end of the run.
              // v2.1.0 EXCEPTION: a task carrying a same-account retry
              // mark FOR THIS account (set by failTaskOrFailover when no
              // other eligible account existed) is allowed to fire here
              // again — once its backoff has passed. While the backoff
              // is still running the worker simply waits with the task
              // at the FRONT of the queue; it must NOT rotate away (with
              // a single account, rotating away was the dead-end).
              if (workerAccount && failoverTracker.hasTried(nextTask.id, workerAccount.id)) {
                const retryMark = failoverTracker.sameAccountRetry(nextTask.id);
                const markedForThisAccount = retryMark && retryMark.accountId === workerAccount.id;
                if (!markedForThisAccount) {
                  taskQueue.enqueue(nextTask);
                  triedSkips++;
                  if (activeWorkerTasks.length === 0 && triedSkips > pool.length + 1) {
                    this.log(`Worker #${workerIndex + 1}: Prompt #${(nextTask.prompt_index || 0) + 1} has been tried on every available account. The worker is stopping.`, 'warn');
                    return;
                  }
                  accountBlocked = true;
                  break;
                }
                const waitMs = retryMark.dueAt - Date.now();
                if (waitMs > 0) {
                  taskQueue.requeueFront(nextTask);
                  this.log(`Worker #${workerIndex + 1}: Prompt #${(nextTask.prompt_index || 0) + 1}'s same-account retry will happen after ${Math.ceil(waitMs / 1000)} seconds — waiting (there is no other account)…`, 'info');
                  const until = Date.now() + waitMs;
                  // v2.4.0 heartbeat: a silent backoff reads as a hang —
                  // report roughly every 30s how much wait is left.
                  let lastWaitNote = Date.now();
                  while (Date.now() < until && !this.isStopping) {
                    await sleep(Math.min(1000, Math.max(0, until - Date.now())));
                    if (Date.now() - lastWaitNote >= 30000 && Date.now() < until) {
                      lastWaitNote = Date.now();
                      this.log(`Worker #${workerIndex + 1}: Prompt #${(nextTask.prompt_index || 0) + 1}'s retry wait is continuing — about ${Math.ceil((until - Date.now()) / 1000)} seconds are left.`, 'info');
                    }
                  }
                  break;
                }
                // Backoff over — this submission IS the sanctioned retry.
                failoverTracker.clearSameAccountRetry(nextTask.id);
              }

              currentTask = nextTask;
              const currentIdx = (nextTask.prompt_index !== undefined) ? nextTask.prompt_index : 0;

              try {
                dbService.updateTaskProgress(nextTask.id, 'running', workerAccount.id, workerAccount.name);
                // v2.6.0 (FIX B): the status counts THIS run's tasks
                // in plain words — never the old burst fraction
                // ("Running (2/4)" was a burst-window position the
                // owner read as a prompt count).
                noteTaskActive(nextTask.id);
                this.onProgress({
                  currentPromptIndex: currentIdx + 1,
                  totalPrompts: pendingTasks.length,
                  currentProfileName: workerAccount.name,
                  activePromptText: nextTask.prompt_text,
                  status: WorkerPool.buildRunStatusText(runStats),
                  runStats: { ...runStats },
                  seema: this.concurrency,
                  liveAccounts: pool.length,
                  workersActive: this.activeWorkers.size
                });
                this.onTaskUpdate({ taskId: nextTask.id, promptIndex: currentIdx, promptText: nextTask.prompt_text, tag: nextTask.prompt_tag || '', status: 'generating', accountName: workerAccount.name });

                this.log(`Worker #${workerIndex + 1}: sending Prompt #${currentIdx + 1}…`, 'info');

                // Duplicate-submission gate (audit fix #6 companion): a task
                // id may be claimed for submission exactly once.
                if (!taskQueue.claimForSubmission(nextTask.id)) {
                  this.log(`Worker #${workerIndex + 1}: Prompt #${currentIdx + 1} has already been sent once — it will NOT be sent again (duplicate stopped).`, 'warn');
                  continue;
                }

                const submitRes = await engine.submitPrompt(
                  nextTask.prompt_text,
                  settings,
                  currentIdx,
                  pendingTasks.length
                );

                if (submitRes.status === 'EXHAUSTED' || submitRes.status === 'LOW_CREDITS') {
                  // Returned BEFORE firing: the prompt was never submitted,
                  // so re-queue it at the front for the next account and
                  // release the submission claim. The browser is NOT closed
                  // here: tasks already in the window keep rendering in this
                  // account's project and must drain first (rotation happens
                  // after the window empties, below).
                  taskQueue.releaseSubmission(nextTask.id);
                  taskQueue.requeueFront(nextTask);
                  try { dbService.updateTaskProgress(nextTask.id, 'pending'); } catch (e) {}
                  this.onTaskUpdate({ taskId: nextTask.id, promptIndex: currentIdx, promptText: nextTask.prompt_text, status: 'pending' });
                  noteTaskSettled(nextTask.id, 'moved');
                  this.log(`Worker #${workerIndex + 1}: [${workerAccount.name}] cannot run Prompt #${currentIdx + 1} (${submitRes.status}). The prompt has been put back in the queue; as soon as this account's generating videos are downloaded, it will go to another account.`, 'warn');
                  accountBlocked = true;
                  break;
                }

                if (submitRes.status === 'VIOLATION') {
                  // Prompt-level rejection — failover kabhi nahi (har
                  // account par yahi hoga; credits barbaad honge).
                  try { dbService.failTask(nextTask.id, submitRes.reason || 'Safety / Policy Violation'); } catch (e) {}
                  recordActivity({
                    category: 'errors', level: 'error', accountId: workerAccount ? workerAccount.id : null, accountName: workerAccount ? workerAccount.name : null,
                    stage: 'policy',
                    taskId: nextTask.id,
                    promptIndex: currentIdx,
                    reason: submitRes.reason || 'Safety / Policy Violation',
                    detail: `As soon as Prompt #${currentIdx + 1} was sent, Google's safety policy stopped it. This fault is from the prompt's side — the same will happen on every account, so other accounts' credits were NOT wasted by failover. Change the prompt and send it again.`,
                    message: `Task FAIL (policy): Prompt #${currentIdx + 1} — ${submitRes.reason || 'Safety / Policy Violation'}`
                  });
                  this.onTaskUpdate({ taskId: nextTask.id, promptIndex: currentIdx, promptText: nextTask.prompt_text, tag: nextTask.prompt_tag || '', status: 'failed', reason: submitRes.reason || 'Safety / Policy Violation' });
                  noteTaskSettled(nextTask.id, 'failed');
                  continue;
                }

                if (submitRes.status === 'STOPPED') {
                  taskQueue.releaseSubmission(nextTask.id);
                  taskQueue.requeueFront(nextTask);
                  noteTaskSettled(nextTask.id, 'moved');
                  break;
                }

                if (submitRes.status === 'SUBMITTED') {
                  // v2.0.0: the submission FIRED on this account — this
                  // is the one moment a failover "try" is counted.
                  if (workerAccount) failoverTracker.recordTry(nextTask.id, workerAccount.id);
                  triedSkips = 0;
                  submitRes.taskId = nextTask.id;
                  // v2.3.0: the engine names the download by this tag.
                  submitRes.tag = nextTask.prompt_tag || '';
                  activeWorkerTasks.push(submitRes);

                  if (activeWorkerTasks.length < maxBurstConcurrency && taskQueue.size() > 0 && !this.isStopping) {
                    await sleep(2500);
                  }
                }
              } catch (taskErr) {
                // AUDIT FIX #1: a submission error fails ONLY this task.
                // v2.0.0: routed through failover first — a submission
                // error on this account may succeed on the next one.
                {
                  const t = plainError.translateError(taskErr);
                  this.log(`Worker #${workerIndex + 1}: Prompt #${currentIdx + 1} bhejne me fail — ${t.plain}.`, 'error', { rawError: t.raw });
                }
                const fo = failTaskOrFailover(nextTask, `Worker error: ${taskErr.message}`, workerAccount ? workerAccount.id : null, workerAccount ? workerAccount.name : '');
                if (fo === 'failed') {
                  this.onTaskUpdate({ taskId: nextTask.id, promptIndex: currentIdx, promptText: nextTask.prompt_text, status: 'failed', reason: taskErr.message });
                }
                // Fail ONLY this task (fix #1). If other tasks are already
                // rendering in this browser, keep it open so they can drain;
                // otherwise close cleanly and rotate on the next iteration.
                if (activeWorkerTasks.length === 0) {
                  await engine.closeBrowser().catch(() => {});
                  if (workerAccount) {
                    this.assignedAccounts.delete(workerAccount.id);
                    workerAccount = null;
                  }
                } else {
                  this.log(`Worker #${workerIndex + 1}: the browser is being kept open so that the ${activeWorkerTasks.length} generating videos download completely.`, 'warn');
                }
                currentTask = null;
                break;
              }
            }

            // ---- Sliding window: wait for renders, download completions ----
            if (activeWorkerTasks.length > 0 && !this.isStopping) {
              const windowTasks = [...activeWorkerTasks];
              try {
                await engine.waitForAccountTasks(activeWorkerTasks, downloadFolder, settings, taskQueue.size() > 0);
              } catch (waitErr) {
                // AUDIT FIX #1: a monitor error fails only the tasks still
                // in this worker's window; the queue continues.
                {
                  const t = plainError.translateError(waitErr);
                  this.log(`Worker #${workerIndex + 1}: Render dekhne me galti aayi — ${t.plain}. Is window ke ${activeWorkerTasks.length} task failover/fail ki taraf jayenge, queue aage badhegi.`, 'error', { rawError: t.raw });
                }
                for (const t of activeWorkerTasks) {
                  if (!t.completed && !t.downloaded) {
                    t.completed = true;
                    t.downloaded = true;
                    // v2.0.0: monitor errors fail over like other
                    // account-level failures (bounded by the tracker).
                    const rowTask = pendingTasks.find(pt => pt.id === t.taskId)
                      || { id: t.taskId, prompt_index: t.promptIndex, prompt_text: t.promptText };
                    const fo = failTaskOrFailover(rowTask, `Worker error: ${waitErr.message}`, workerAccount ? workerAccount.id : null, workerAccount ? workerAccount.name : '');
                    if (fo === 'failed') {
                      this.onTaskUpdate({ taskId: t.taskId, promptIndex: t.promptIndex, promptText: t.promptText, status: 'failed', reason: waitErr.message });
                    }
                  }
                }
                activeWorkerTasks.length = 0;
                await engine.closeBrowser().catch(() => {});
                if (workerAccount) {
                  this.assignedAccounts.delete(workerAccount.id);
                  workerAccount = null;
                }
                continue;
              }

              const remaining = activeWorkerTasks.filter(t => !t.completed && !t.downloaded);
              activeWorkerTasks.length = 0;
              activeWorkerTasks.push(...remaining);

              // v2.7.0 (FIX 2): is window ke download-fail hue tasks ki
              // SIRF-download dobara koshish — browser abhi isi account
              // par khula hai aur bani hui tiles project me maujood
              // hain. Koi submit nahi, koi credit nahi.
              await processDownloadRetries(engine);

              // Cooldown rotation: if a task in this window failed with
              // Google "Unusual Activity" and the window has drained, park
              // the account as Cooldown (credits untouched — creditService)
              // and rotate this worker to a fresh account.
              const hitUnusualActivity = windowTasks.some(t => t.status === 'Unusual Activity');
              if (hitUnusualActivity && remaining.length === 0 && workerAccount && taskQueue.size() > 0 && !this.isStopping) {
                this.log(`Worker #${workerIndex + 1}: Google's cooldown (unusual activity) hit [${workerAccount.name}] — putting the account on rest and moving to another account…`, 'warn');
                creditPort.cooldown(workerAccount.id);
                await engine.closeBrowser().catch(() => {});
                this.assignedAccounts.delete(workerAccount.id);
                workerAccount = null;
              }
            }

            // ---- Blocked-account rotation: only once the window has fully
            // drained, so no in-flight render is ever stranded. ----
            if (accountBlocked && activeWorkerTasks.length === 0 && workerAccount && !this.isStopping) {
              // v2.7.0: purani line bina jaanche "saare videos download
              // ho gaye" keh deti thi — ab sirf itna kaha jata hai jo
              // sach hai (window settle ho gaya; natija upar ke log me).
              this.log(`Worker #${workerIndex + 1}: the wait for [${workerAccount.name}]'s generating videos is over (the ones that were made are downloaded; the ones that failed have their reasons in the log above). Now leaving this account and moving to another account…`, 'info');
              await engine.closeBrowser().catch(() => {});
              this.assignedAccounts.delete(workerAccount.id);
              workerAccount = null;
              accountBlocked = false;
              continue;
            }

            const delaySec = Number(settings.promptDelaySec) || 0;
            if (delaySec > 0 && activeWorkerTasks.length === 0 && taskQueue.size() > 0 && !this.isStopping) {
              await sleep(delaySec * 1000);
            }
          }
        } catch (err) {
          // AUDIT FIX #1: last-resort guard. currentTask is worker-scoped,
          // so this handler can never throw a ReferenceError of its own.
          {
            const t = plainError.translateError(err);
            this.log(`Worker #${workerIndex + 1} me galti — ${t.plain}.`, 'error', { rawError: t.raw });
          }
          if (currentTask && !currentTask.completed && !currentTask.downloaded) {
            const fo = failTaskOrFailover(currentTask, `Worker error: ${err.message}`, workerAccount ? workerAccount.id : null, workerAccount ? workerAccount.name : '');
            if (fo === 'failed') {
              this.onTaskUpdate({
                taskId: currentTask.id,
                promptIndex: currentTask.prompt_index,
                promptText: currentTask.prompt_text,
                status: 'failed',
                reason: err.message
              });
            }
          }
        } finally {
          // No orphaned browsers, no leaked account assignments — ever.
          await engine.closeBrowser().catch(() => {});
          if (workerAccount) this.assignedAccounts.delete(workerAccount.id);
          this.activeWorkers.delete(workerId);
          this.onWorkerUpdate({ workerId, workerIndex, status: 'Idle' });
        }
      };

      const workerPromises = [];
      for (let i = 0; i < actualWorkersCount; i++) {
        workerPromises.push(runWorker(i));
      }
      await Promise.all(workerPromises);

      // v2.7.0 (FIX 2): run ke aakhir me SACH wali ginati — is run ke
      // jo task video banne ke baad sirf-download ke liye pending
      // (check-only) bache hain, unka bhi hisaab log me aaye. Ye fail
      // NAHI hain: agla Resume sirf unka download karega, koi naya
      // charge nahi lagega. Inhe chhupana bhi ek tarah ki jhooti
      // "sab ho gaya" line hoti.
      if (!this.isStopping) {
        try {
          const stillDownloadPending = pendingTasks.filter(t => {
            const row = dbService.getTask(t.id);
            return row && row.status === 'pending' && row.needs_check;
          });
          if (stillDownloadPending.length > 0) {
            this.log(`Note: ${stillDownloadPending.length} prompts' videos had been generated but their download is still remaining — they are in pending (check-only). On pressing Resume, ONLY their download will happen again; NO new charge will apply.`, 'warn');
          }
        } catch (e) {}
      }

      if (this.isStopping) {
        // v1.8.0: a resumed run can span several original batches.
        const ids = (this.batchIds && this.batchIds.size > 0) ? [...this.batchIds] : [batchId];
        for (const id of ids) {
          if (!id) continue;
          // v2.1.0: a task left 'running' at Stop whose submission had
          // FIRED (claim taken) may already have a paid render sitting
          // in Flow. The old blanket cancelRunningTasks marked it
          // 'cancelled' — invisible to Resume and to check-only
          // recovery, i.e. the paid render was abandoned. Now: fired
          // tasks go back to pending + needs_check (the next Resume
          // reconciles them check-only, no double charge); tasks that
          // never fired go back to plain pending. cancelRunningTasks
          // stays as a safety net for any row this pass could not read.
          let runningRows = [];
          try {
            runningRows = dbService.query("SELECT id FROM queue_tasks WHERE batch_id = ? AND status = 'running'", [id]) || [];
          } catch (e) {}
          for (const r of runningRows) {
            try {
              dbService.updateTaskProgress(r.id, 'pending');
              if (taskQueue.isSubmitted(r.id)) {
                dbService.setTaskNeedsCheck(r.id, 1);
              }
            } catch (e) {}
          }
          try { dbService.cancelRunningTasks(id); } catch (e) {}
        }
        this.onProgress({ status: 'Stopped' });
        this.log(`Queue stopped. A total of ${completedCount} videos were made in this run. Prompts that went in midway are in pending — the ones that had already been sent to Flow will be checked first on the next Resume (credits will not be deducted again).`, 'warn');
      } else if (taskQueue.size() > 0) {
        // v1.1 fix (brief D): prompts that never got to run must end
        // VISIBLY failed with the concrete reason — never stranded in
        // 'pending' while the UI claims "Completed".
        // v2.1.0: prefer the CONCRETE reasons this run actually saw.
        // The "(no usable account remained)" wording is now the last
        // resort — with same-account retry in place it should only
        // surface when every account truly was unusable.
        const reason = lastStartError
          || (lastFailureReason ? `The run ended before this prompt could be processed. The last failure's reason: ${lastFailureReason}` : null)
          || 'The run ended before this prompt could even be processed (no usable account was left).';
        let leftover;
        while ((leftover = taskQueue.next()) !== null) {
          try { dbService.failTask(leftover.id, reason); } catch (e) { /* best-effort */ }
          this.onTaskUpdate({
            taskId: leftover.id,
            promptIndex: leftover.prompt_index,
            promptText: leftover.prompt_text,
            tag: leftover.prompt_tag || '',
            status: 'failed',
            reason
          });
        }
        this.log(`Queue already ended: ${reason}`, 'error');
        this.onProgress({ status: `Error: ${reason}` });
      } else {
        this.onProgress({ status: 'Completed' });
        this.log(`All work is complete! A total of ${completedCount} videos were made in this run.`, 'success');
      }
    } finally {
      if (queueResolver) queueResolver();
      this.queuePromise = null;
    }
  }
}

// v2.5.0: "live ready" ki ek hi paribhasha poore app me — dashboard
// bhi yahi do status ginata hai (Ready / Low Credits).
WorkerPool.LIVE_READY_STATUSES = new Set(['Ready', 'Low Credits']);

// v2.6.0 (FIX B): the run status in plain words, built ONLY from the
// current run's own counts. Pure + exported so the smoke tests pin
// the exact wording the owner reads. (The old text was the burst
// fraction "Running (2/4)" — a worker-internal position/cap pair.)
WorkerPool.buildRunStatusText = function buildRunStatusText(stats) {
  const s = stats || {};
  const total = Math.max(0, Number(s.total) || 0);
  const active = Math.max(0, Number(s.active) || 0);
  const done = Math.max(0, Number(s.done) || 0);
  const failed = Math.max(0, Number(s.failed) || 0);
  let text = `Running — ${active} generating · ${done} complete · total ${total} prompts`;
  if (failed > 0) text += ` · ${failed} fail`;
  return text;
};

module.exports = { WorkerPool };
