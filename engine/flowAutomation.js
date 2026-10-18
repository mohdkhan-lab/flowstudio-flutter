const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { getChromeExecutablePath } = require('./chromePaths');
const { getAccountProfilePath } = require('./accountStore');
const { checkProfileBusyAsync } = require('./processHelper');
const liveBrowsers = require('./liveBrowsers');
const tileIdentity = require('./tileIdentity');
const stallWatch = require('./stallWatch');
const renderProgressWatch = require('./renderProgressWatch');
const tileState = require('./tileState');
const plainError = require('./plainError');
const browserMode = require('./browserMode');
const networkCapture = require('./networkCapture');
const failureEvidence = require('./failureEvidence');
const { FFmpegService } = require('./ffmpegService');
const { sanitizeFilePart } = require('./pathSecurity');
const tagNaming = require('./tagNaming');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * FlowStudio Lite — Google Flow automation engine (adapted from the audited
 * V2 engine, keeping its proven Flow page knowledge).
 *
 * Differences from V2, by audit mandate:
 *  - The engine NEVER writes account credits/status itself. Every credit
 *    event goes through the injected creditPort (bound to creditService by
 *    the WorkerPool) — audit fix #4.
 *  - hasConfiguredSettings is reset on EVERY browser close and launch, so
 *    generation settings are always re-applied after an account rotation —
 *    audit fix #5.
 *  - Profile locks are only cleaned as files; a genuinely locked profile
 *    reports PROFILE_BUSY and the account is skipped — audit fix #7.
 *  - Download identity is strict: a task may only complete with media from
 *    ITS OWN claimed tile / its own captured video URL. There are no
 *    "latest fresh URL" or "newest tile" fallbacks — audit fix #6.
 *  - Task persistence (complete/fail) is the WorkerPool's job, via the
 *    onTaskCompleted / onTaskFailed callbacks.
 */
class FlowAutomationEngine {
  constructor(callbacks = {}, options = {}) {
    this.onLog = callbacks.onLog || (() => {});
    this.onProgress = callbacks.onProgress || (() => {});
    this.onVideoStarted = callbacks.onVideoStarted || (() => {});
    this.onVideoProgress = callbacks.onVideoProgress || (() => {});
    this.onVideoCompleted = callbacks.onVideoCompleted || (() => {});
    this.onTaskCompleted = callbacks.onTaskCompleted || (() => {});
    this.onTaskFailed = callbacks.onTaskFailed || (() => {});
    this.onAccountUpdated = callbacks.onAccountUpdated || (() => {});
    // v2.1.0: fired ONCE when a submitted render's tile stays missing
    // and stall recovery begins (the pool turns it into an Activity
    // entry). Optional — older callback sets simply don't get it.
    this.onTaskStalled = callbacks.onTaskStalled || (() => {});
    // v2.4.0: fired when a task's render TILE STATE changes
    // (absent -> generating -> failed/ready …) so the pool can record
    // the story in Activity with its stage. Heartbeat ticks of an
    // unchanged state stay log-only (they would flood the feed).
    this.onTaskHeartbeat = callbacks.onTaskHeartbeat || (() => {});
    // v2.6.0: fired ONCE per frozen episode when a bound, generating
    // tile's progress percentage does not move for the whole stall
    // budget (engine/renderProgressWatch.js) — the pool turns it into
    // an Activity entry with stage 'render-stall'. Optional.
    this.onRenderStall = callbacks.onRenderStall || (() => {});
    // v2.8.0: fired when a task's video link arrives from Flow's
    // BACKEND (network capture — engine/networkCapture.js) and the
    // direct fetch starts. The pool turns it into an Activity entry
    // (stage 'download') so the owner sees the video came without
    // any button/menu. Optional.
    this.onBackendMedia = callbacks.onBackendMedia || (() => {});
    // v2.8.0: the network capture layer for THIS engine's browser
    // session. Listeners attach at launch; ingestion arms at the
    // first submission. Bindings (workflowId -> task -> media URL)
    // arrive through _onBackendMediaBound.
    this.netCapture = new networkCapture.NetworkCapture({
      onMediaBound: (key, url, via) => {
        try { this._onBackendMediaBound(key, url, via); } catch (e) {}
      }
    });
    // v2.8.0: captureKey -> live engine task (registered by the
    // monitor / download-retry), and captureKey -> {url, via} for
    // bindings that landed before the task object was registered.
    this._captureTasks = new Map();
    this._earlyBackend = new Map();
    // v2.8.0: the "backend par koi video link nahi dikha" line is
    // spoken ONCE per browser session, not once per task.
    this._backendNoteLogged = false;
    // v2.6.0: how long a generating tile's percentage may sit frozen
    // before the watchdog speaks (constructor option so tests can
    // shrink it; production 3 minutes — long enough that a busy Flow
    // day does not cry wolf, short enough that a dead render is
    // named while there is still time to act).
    this.progressStallAfterMs = Number(options.progressStallAfterMs) > 0 ? Number(options.progressStallAfterMs) : renderProgressWatch.DEFAULT_STALL_AFTER_MS;
    // v2.4.0: heartbeat cadence for long waits (constructor option so
    // tests can shrink it; production 30s — the owner's rule is that
    // the log may never sit silent while a paid render is in flight).
    this.heartbeatEveryMs = Number(options.heartbeatEveryMs) > 0 ? Number(options.heartbeatEveryMs) : 30000;
    // v2.4.0: the current monitor window's task list, set by
    // waitForAccountTasks — the recovery scan reads it to know
    // whether a weak-text task is the account's ONLY in-flight task
    // (the one condition under which the order/timing scan fallback
    // may bind a tile by position alone).
    this._monitorTasks = null;
    // v2.1.0 stall-recovery tuning (constructor options exist so tests
    // can shrink the windows; production uses the defaults).
    this.stallTimeoutSecOverride = Number(options.stallTimeoutSec) > 0 ? Number(options.stallTimeoutSec) : null;
    this.recoveryWindowSecOverride = Number(options.recoveryWindowSec) > 0 ? Number(options.recoveryWindowSec) : null;
    this.recoveryScanEveryMs = Number(options.recoveryScanEveryMs) > 0 ? Number(options.recoveryScanEveryMs) : 15000;

    // Credit port: every method is a no-op unless the pool binds it.
    const noopPort = {
      liveBalance: () => {}, exhaustionBanner: () => {}, lowCredits: () => {},
      estimatedCharge: () => {}, signOut: () => {}, ambiguous: () => {}
    };
    this.creditPort = Object.assign({}, noopPort, options.creditPort || {});

    this.browser = null;
    this.page = null;
    this.cdpSession = null;
    this.isStopping = false;
    this.isPaused = false;
    this.currentAccount = null;
    this.currentSettings = {};
    this.headless = !!options.headless;
    this.workerId = options.workerId || null;
    this.hasConfiguredSettings = false;
    this.claimedTileIndices = new Set();
    // v1.5.0: tile claims are tracked by FINGERPRINT (the tile's
    // normalized prompt aria), never by DOM index — see tileIdentity.js.
    this.claimedTileFingerprints = new Set();
    // v1.7.0: files THIS engine saved during its lifetime — the only
    // files a later save may overwrite. Anything else already sitting
    // in the download folder (an earlier run's videos) is never
    // silently replaced; the save takes a suffixed name instead.
    this.savedThisSession = new Set();
    this.consumedVideoUrls = new Set();
    this.capturedVideoUrls = [];
    this.capturedVideoBuffers = new Map();
    this.capturedVideoBytes = 0;
    this.lastLaunchError = null;
    // v1.1 freeze fix: video-stream capture stays DISARMED until the first
    // prompt of the session is actually submitted (see submitPrompt). The
    // Flow landing/gallery pages stream many large mp4 previews; buffering
    // every one of them through CDP saturated the Electron main loop.
    this.captureArmed = false;
  }

  log(msg, type = 'info', extra = {}) {
    this.onLog({ message: msg, type, timestamp: new Date().toLocaleTimeString(), ...extra });
  }

  updateProgress(data) {
    this.onProgress(data);
  }

  // v2.4.0 (fix: duplicate log lines): pause/resume/stop are logged
  // ONCE, by the WorkerPool — the owner's PC log showed every such
  // event twice (pool line + engine line). The engine methods now
  // change state silently; the pool's single line carries the news
  // (including the "in-flight renders finish first" note for pause).
  pause() {
    this.isPaused = true;
  }

  resume() {
    this.isPaused = false;
  }

  stop() {
    this.isStopping = true;
    this.isPaused = false;
    try { if (this.netCapture) this.netCapture.detach(); } catch (e) {}
    if (this.browser) {
      try {
        const pid = this.browser.process() ? this.browser.process().pid : null;
        if (pid && this.currentAccount) liveBrowsers.unregister(this.currentAccount.id, pid);
      } catch (e) {}
      try { this.browser.close().catch(() => {}); } catch (e) {}
    }
  }

  async launchBrowserForAccount(account, downloadDir) {
    this.lastLaunchError = null;
    // Audit fix #5: a fresh browser launch must always re-apply settings.
    this.hasConfiguredSettings = false;

    const chromePath = getChromeExecutablePath();
    const profilePath = getAccountProfilePath(account.id);

    // Audit fix #7 (v1.4 form): the app never kills the USER'S Chrome.
    // What checkProfileBusyAsync may terminate is only an UNREGISTERED
    // leftover holding one of THIS app's own profiles (see the v1.4
    // ownership rule in processHelper.js) — most importantly the app's
    // own Sign In Chrome lingering invisibly in background mode. A busy
    // result here now means: a registered live launch is using the
    // profile right now, or a holder could not be cleared (its PIDs are
    // in busyCheck.holderPids and in the log line below).
    // Generation deliberately does NOT fall back to a working copy of
    // the profile (unlike the read-only credit check): a live Flow
    // session rotates its session cookies as it works, so running
    // generation on a throwaway copy would strand the rotated tokens in
    // the copy and leave the real profile with stale session state.
    // Skipping the account with a clear reason is the correct behavior.
    // v1.4.1/v1.5.1: generation outranks EVERY other app-owned browser
    // (reclaimLogin) — the owner's standing order is that generation
    // must never wait on an open Chrome. It closes the app's own Sign
    // In window and any running credit check (a check is disposable:
    // its Puppeteer calls simply fail and creditService is untouched);
    // only another live GENERATION on this profile stays protected.
    const busyCheck = await checkProfileBusyAsync(profilePath, account.id, { reclaimLogin: true });
    if (busyCheck.healedBy === 'reclaim' && busyCheck.killedPids) {
      this.log(`Cleaned up a leftover old app Chrome (PID ${busyCheck.killedPids.join(', ')}) that was holding [${account.name}]'s profile — work continues.`, 'info');
    }
    if (busyCheck.busy) {
      this.lastLaunchError = 'PROFILE_BUSY';
      const holderNote = busyCheck.holderInfo && busyCheck.holderInfo.length
        ? ` (${busyCheck.holderInfo.map((h) => `PID ${h.pid}${h.kind ? `, ${h.kind}` : ''}`).join('; ')})`
        : '';
      const why = busyCheck.reason === 'in-use'
        ? `another job is currently running on this account${holderNote}`
        : `the profile is open in some Chrome${busyCheck.holderPids && busyCheck.holderPids.length ? ` (PID ${busyCheck.holderPids.join(', ')})` : ''} and could not be cleared`;
      this.lastBusyDetail = why;
      this.log(`[${account.name}]'s Chrome profile is busy right now — ${why}. Skipping this account for now.`, 'warn');
      return false;
    }
    this.lastBusyDetail = null;

    this.log(`Opening [${account.name}]'s own Chrome profile…`, 'info');

    // Visibility comes from the browserMode launch plan.
    // `this.headless` is the pool's "background requested" flag (the
    // name is historical): background used to mean Puppeteer headless
    // 'new' (v2.4.0 removed that — headless stalled Flow), then an
    // off-screen window MINIMIZED after launch (v2.6.0 removed the
    // minimize — a minimized/occluded window is throttled by Chrome
    // and Flow's renders froze at 1% on the owner's PC). Background
    // now launches the SAME headed Chrome parked off-screen in the
    // NORMAL window state, with the plan's anti-throttling flags and
    // CDP focus emulation (below), so the page keeps rendering and
    // timing exactly as if it were focused on screen.
    const plan = browserMode.launchPlan(this.headless);
    const args = [
      `--user-data-dir=${profilePath}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(plan.startMaximized ? ['--start-maximized'] : plan.extraArgs),
      ...(plan.antiThrottleArgs || []),
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-notifications',
      '--deny-permission-prompts',
      '--disable-popup-blocking',
      '--disable-features=NotificationTriggers,PushMessaging',
      '--mute-audio',
      '--disk-cache-size=104857600',
      '--enforce-webrtc-ip-permission-check'
    ];

    try {
      this.browserDownloadDir = path.join(downloadDir, '.flow-native', this.workerId || account.id);
      if (!fs.existsSync(this.browserDownloadDir)) fs.mkdirSync(this.browserDownloadDir, { recursive: true });
      this.browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: plan.headless,
        defaultViewport: null,
        args,
        ignoreDefaultArgs: ['--enable-automation']
      });
      // v1.4: register as a legitimately live launch (reclaim safety).
      // Kind 'generation' (v1.4.1) — long-running, never watchdogged.
      try {
        const genPid = this.browser.process() ? this.browser.process().pid : null;
        if (genPid) liveBrowsers.register(account.id, genPid, 'generation');
      } catch (e) {}

      const pages = await this.browser.pages();
      this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

      this.page.on('dialog', async (dialog) => {
        try {
          this.log(`The browser's own popup was closed automatically: "${dialog.message()}"`, 'info');
          await dialog.dismiss();
        } catch (e) {}
      });

      if (pages.length > 1) {
        for (let i = 1; i < pages.length; i++) {
          try { await pages[i].close(); } catch (e) {}
        }
      }

      // v2.6.0: the window is NEVER minimized any more (see the plan
      // comment above — minimized windows get throttled and Flow's
      // renders froze). bringToFront only makes this page the active
      // TAB inside its own window; for an off-screen window nothing
      // appears on any screen. Focus emulation is enabled further
      // down, once the page CDP session exists.
      try { await this.page.bringToFront(); } catch (e) {}

      await this.page.evaluateOnNewDocument(() => {
        try {
          delete Object.getPrototypeOf(navigator).webdriver;
        } catch (e) {}
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        if (!window.chrome) window.chrome = {};
        window.chrome.runtime = window.chrome.runtime || {};
        if (!navigator.languages || navigator.languages.length === 0) {
          Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        }
      });

      try {
        this.cdpSession = await this.page.target().createCDPSession();
        // v2.6.0 (background mode): focus emulation — the page keeps
        // reporting itself focused/visible to its own scripts even
        // though its window sits off-screen, so Flow's progress
        // timers and rendering are not throttled the way an occluded
        // page's are. Best-effort: the anti-throttling launch flags
        // (browserMode plan) already cover the window level.
        if (plan.focusEmulation) {
          try { await this.cdpSession.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
        }
        const targetDownloadPath = this.browserDownloadDir || downloadDir;
        if (targetDownloadPath) {
          if (!fs.existsSync(targetDownloadPath)) fs.mkdirSync(targetDownloadPath, { recursive: true });
          await this.cdpSession.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: targetDownloadPath
          });
        }
      } catch (e) {}

      // Intercept video CDN streams loaded by Google Flow. Buffers are keyed
      // by URL; a task may only consume a URL that was extracted from its
      // OWN claimed tile (audit fix #6).
      this.capturedVideoUrls = [];
      this.capturedVideoBuffers = new Map();
      this.capturedVideoBytes = 0;
      this.page.on('response', async (res) => {
        try {
          // v1.1: ignore ALL traffic until a prompt has been submitted —
          // downloads only ever need streams produced by our own tasks,
          // and downloadFromCapturedStream has a direct-fetch fallback.
          if (!this.captureArmed) return;
          const u = res.url();
          const headers = res.headers();
          const ct = (headers['content-type'] || '').toLowerCase();
          const isImage = ct.includes('image/') || u.includes('/asb/') || u.includes('thumbnail');
          const isVideo = !isImage && (
            ct.includes('video/') ||
            (u.includes('.mp4') && !u.includes('.mp4.')) ||
            (u.includes('flow-content.google') && !u.includes('thumbnail') && !u.includes('/asb/'))
          );
          if (isVideo) {
            if (!this.capturedVideoUrls.includes(u)) {
              this.capturedVideoUrls.push(u);
            }
            try {
              // v1.1: never buffer bodies whose declared size is useless
              // to us (small previews) or beyond the store cap — buffering
              // crosses CDP as base64 on the Electron main thread. The URL
              // is still recorded above, so a later direct fetch works.
              const declaredLen = parseInt(headers['content-length'] || '', 10);
              if (Number.isFinite(declaredLen) && (declaredLen < 100000 || declaredLen > 50 * 1024 * 1024)) return;
              if (this.capturedVideoBuffers.has(u)) return;
              const buf = await res.buffer();
              const isJpegOrPng = buf && buf.length > 4 && ((buf[0] === 0xff && buf[1] === 0xd8) || (buf[0] === 0x89 && buf[1] === 0x50));
              if (buf && buf.length > 100000 && !isJpegOrPng) {
                const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;
                while (this.capturedVideoBytes + buf.length > MAX_CAPTURE_BYTES && this.capturedVideoBuffers.size > 0) {
                  const oldestKey = this.capturedVideoBuffers.keys().next().value;
                  const evicted = this.capturedVideoBuffers.get(oldestKey);
                  this.capturedVideoBytes -= (evicted ? evicted.length : 0);
                  this.capturedVideoBuffers.delete(oldestKey);
                }
                if (this.capturedVideoBytes + buf.length <= MAX_CAPTURE_BYTES) {
                  this.capturedVideoBuffers.set(u, buf);
                  this.capturedVideoBytes += buf.length;
                }
              }
            } catch (bErr) {}
          }
        } catch (e) {}
      });

      // v2.8.0: NETWORK CAPTURE — page ki network khabar sunne wale
      // listeners browser ke saath hi lag jate hain, taaki kisi bhi
      // submission ka pehla jawab bhi na choote. Asal ingestion pehle
      // submit par armed hoti hai (beginSubmission) — usse pehle ke
      // project-page ke jawab (purane projects ke links) capture ko
      // ganda nahi karte. Har launch par capture ki haalat saaf.
      try {
        this.netCapture.reset();
        this.netCapture.disarm();
        this._captureTasks.clear();
        this._earlyBackend.clear();
        this._backendNoteLogged = false;
        this.netCapture.attach(this.page);
      } catch (e) {}

      this.currentAccount = account;
      this.log(`Chrome is ready — [${account.name}]'s profile is open.`, 'success');
      return true;
    } catch (err) {
      this.lastLaunchError = err.message;
      const t = plainError.translateError(err);
      this.log(`Chrome could not open for [${account.name}] — ${t.plain}.`, 'error', { rawError: t.raw });
      return false;
    }
  }

  async closeBrowser() {
    // v2.8.0: capture ke listeners har session ke saath saaf band —
    // koi listener leak nahi, koi purana binding naye session me nahi.
    try { this.netCapture.detach(); } catch (e) {}
    try { this.netCapture.disarm(); } catch (e) {}
    if (this._captureTasks) this._captureTasks.clear();
    if (this._earlyBackend) this._earlyBackend.clear();
    if (this.browser) {
      try {
        const pid = this.browser.process() ? this.browser.process().pid : null;
        if (pid && this.currentAccount) liveBrowsers.unregister(this.currentAccount.id, pid);
      } catch (e) {}
      try { await this.browser.close(); } catch (e) {}
      this.browser = null;
      this.page = null;
      this.cdpSession = null;
      this.browserDownloadDir = null;
    }
    // Audit fix #5: settings must be re-applied after every rotation / fresh
    // launch, so the configured flag never survives a browser close.
    this.hasConfiguredSettings = false;
    this.captureArmed = false;
    if (this.capturedVideoBuffers) {
      this.capturedVideoBuffers.clear();
      this.capturedVideoBytes = 0;
    }
    this.capturedVideoUrls = [];
    if (this.claimedTileIndices) this.claimedTileIndices.clear();
    if (this.claimedTileFingerprints) this.claimedTileFingerprints.clear();
    if (this.consumedVideoUrls) this.consumedVideoUrls.clear();
  }

  /**
   * Navigate into the Flow project canvas.
   * Returns 'READY' | 'NEED_LOGIN' | 'EXHAUSTED' | 'LOW_CREDITS'.
   */
  async openFlowStudio(settings = {}) {
    this.currentSettings = settings;
    const url = 'https://flow.google.com/';
    this.log(`Opening Flow: ${url}`, 'info');

    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      await this.page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await sleep(4000);

    // 1. Landing page -> enter the app
    const clickedLanding = await this.page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
      const createBtn = btns.find(b => {
        const txt = (b.innerText || '').trim();
        return txt.includes('Create with Google Flow') || txt.includes('Try in Google Flow');
      });
      if (createBtn) {
        createBtn.click();
        return true;
      }
      return false;
    });

    if (clickedLanding) {
      this.log('Clicked "Create with Google Flow" — the canvas (work area) is opening…', 'info');
      await sleep(5000);
    }

    // 2. Google Account login check — an explicit signin URL is the only
    // signal allowed to mark the account 'Need Login' (audit fix #3), and
    // even then the credit service preserves the last known balance.
    if (this.page.url().includes('accounts.google.com')) {
      this.log(`[${this.currentAccount ? this.currentAccount.name : 'Account'}] needs a Google login — the account is not signed in.`, 'warn');
      if (!this.headless) {
        for (let i = 0; i < 10; i++) {
          await sleep(3000);
          if (!this.page.url().includes('accounts.google.com')) {
            this.log('Login found — moving towards the Flow studio…', 'success');
            break;
          }
        }
      }
      if (this.page.url().includes('accounts.google.com')) {
        this.creditPort.signOut(this.currentAccount ? this.currentAccount.id : null);
        return 'NEED_LOGIN';
      }
    }

    // 3. Projects gallery -> project canvas
    const preferFreshCanvas = settings.canvasStrategy !== 'existing';
    if (!this.page.url().includes('/project/')) {
      this.currentStage = 'Entering Project Canvas';
      this.log('Going into the Flow project from the gallery…', 'info');

      let enteredCanvas = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const actionResult = await this.page.evaluate((preferFresh) => {
          const newBtn = document.querySelector('button.new-project-button') ||
            Array.from(document.querySelectorAll('button, div[role="button"]')).find(b => {
              const txt = (b.innerText || '').toLowerCase();
              const aria = (b.getAttribute('aria-label') || '').toLowerCase();
              return txt.includes('new project') || aria.includes('new project') || txt.includes('create project');
            });

          const existingLink = document.querySelector('a[href*="/project/"]');

          if (preferFresh && newBtn) { newBtn.click(); return 'clicked-new-project-button'; }
          if (!preferFresh && existingLink) { existingLink.click(); return 'clicked-existing-project-link'; }
          if (existingLink) { existingLink.click(); return 'fallback-clicked-existing-project-link'; }
          if (newBtn) { newBtn.click(); return 'fallback-clicked-new-project-button'; }
          return 'none-found';
        }, preferFreshCanvas);

        this.log(`Attempt ${attempt}/3 to enter the project — ${actionResult === 'none-found' ? 'no New Project button or project link was found' : 'button/link found and clicked'}`, 'info');

        for (let w = 0; w < 10; w++) {
          await sleep(1000);
          if (this.page.url().includes('/project/')) {
            enteredCanvas = true;
            break;
          }
        }

        if (enteredCanvas) break;

        const directHref = await this.page.evaluate(() => {
          const a = document.querySelector('a[href*="/project/"]');
          return a ? a.getAttribute('href') : null;
        });

        if (directHref) {
          const fullUrl = directHref.startsWith('http') ? directHref : `https://flow.google.com${directHref}`;
          this.log('Going in directly via the project link…', 'info');
          try {
            await this.page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await sleep(3000);
            if (this.page.url().includes('/project/')) {
              enteredCanvas = true;
              break;
            }
          } catch (e) {}
        }
      }

      if (!this.page.url().includes('/project/')) {
        throw new Error(`Could not enter Google Flow project canvas. Page remained on ${this.page.url()}. Ensure the account has accepted Google Flow terms and can create projects.`);
      }

      this.log('The Flow project is open — now at the work area.', 'success');
      await sleep(2500);
    }

    // Dismiss tutorial/welcome overlay and clean up stale failed tiles
    try {
      await this.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const dismissBtn = btns.find(b => {
          const txt = (b.innerText || '').trim().toLowerCase();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          return txt === 'got it' || txt.includes('got it') || txt === 'get started' || aria.includes('dismiss');
        });
        if (dismissBtn) dismissBtn.click();

        const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
        containers.forEach(c => {
          const txt = (c.innerText || '').toLowerCase();
          if (txt.includes('unusual activity') || txt.includes('failed to generate')) {
            const trash = c.querySelector('button[aria-label*="delete" i], button[aria-label*="trash" i], button[aria-label*="remove" i]');
            if (trash) {
              try { trash.click(); } catch (e) {}
            }
          }
        });
      });
    } catch (e) {}

    // 4. Live credit pre-check — all writes go through the credit port.
    const required = this.getRequiredCredits(settings || this.currentSettings);
    const accId = this.currentAccount ? this.currentAccount.id : null;
    // v1.9.0: name via a guarded local — currentAccount is set by the
    // launch path in every pool flow, but this public method must never
    // die with a misleading TypeError if it is ever absent.
    const accName = this.currentAccount ? this.currentAccount.name : 'Account';
    const liveCredits = await this.readLiveCreditsFromPage();
    if (typeof liveCredits === 'number') {
      this.creditPort.liveBalance(accId, liveCredits);
      if (this.currentAccount) this.currentAccount.credits = liveCredits;
      if (liveCredits === 0) {
        this.log(`[${accName}] has 0 credits — no video will be made from this account; moving to the next account.`, 'warn');
        return 'EXHAUSTED';
      }
      if (required > 0 && liveCredits < required) {
        // Audit fix #2: low balance is a skip reason, NOT exhaustion.
        this.creditPort.lowCredits(accId, required);
        this.log(`[${accName}] has only ${liveCredits} credits; one video needs ~${required} — skipping this account for this run.`, 'warn');
        return 'LOW_CREDITS';
      }
      this.log(`[${accName}] has ${liveCredits} credits (one video ≈ ${required} credits).`, 'success');
    } else {
      // Audit fix #3: an inconclusive read changes nothing.
      this.creditPort.ambiguous(accId);
      const known = Number(this.currentAccount ? this.currentAccount.credits : NaN);
      if (!isNaN(known) && required > 0 && known < required) {
        this.creditPort.lowCredits(accId, required);
        this.log(`[${accName}]'s last known balance is ${known} credits, which is less than the needed ~${required} — skipping this account.`, 'warn');
        return 'LOW_CREDITS';
      }
    }

    this.log('Waiting for Flow\'s prompt box (prompt bar) to appear — the workspace is getting ready…', 'info');
    try {
      await this.page.waitForSelector('.ProseMirror, div[contenteditable="true"], div[role="textbox"], textarea', { timeout: 30000 });
      this.log('The Flow workspace is ready — prompts can be sent.', 'success');
    } catch (e) {}

    await this.ensureAgentModeDisabled();

    await sleep(1200);
    return 'READY';
  }

  // UNIVERSAL POPUP / OVERLAY AUTO-DISMISSER
  async dismissAnyBlockingOverlays() {
    if (!this.page || this.page.isClosed()) return false;
    try {
      const dismissed = await this.page.evaluate(() => {
        let actionTaken = false;

        const candidateButtons = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"], span[role="button"]'));
        const dismissKeywords = [
          'got it', 'get started', 'dismiss', 'i understand', 'close', 'accept all',
          'accept', 'agree', 'ok', 'okay', 'skip', 'continue', 'not now', 'no thanks',
          'maybe later', 'done', 'explore', 'understood'
        ];

        for (const btn of candidateButtons) {
          const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();

          if (text.includes('generate') || aria.includes('generate') || text.includes('new project') || text.includes('create')) {
            continue;
          }

          const matches = dismissKeywords.some(kw => text === kw || aria === kw || text.startsWith(kw) || aria.startsWith(kw));
          if (matches) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              btn.click();
              actionTaken = true;
            }
          }
        }

        const closeIconBtns = Array.from(document.querySelectorAll(
          'div[role="dialog"] button[aria-label*="close" i], ' +
          'div[role="dialog"] button[aria-label*="dismiss" i], ' +
          'mat-dialog-container button[aria-label*="close" i], ' +
          '.cdk-overlay-pane button[aria-label*="close" i], ' +
          '[class*="banner"] button[aria-label*="close" i], ' +
          '[class*="toast"] button[aria-label*="close" i], ' +
          '[class*="snackbar"] button[aria-label*="close" i]'
        ));
        for (const cBtn of closeIconBtns) {
          try { cBtn.click(); actionTaken = true; } catch (e) {}
        }

        const orphanBackdrops = document.querySelectorAll('.cdk-overlay-backdrop-showing, .modal-backdrop.show');
        if (orphanBackdrops.length > 0 && !document.querySelector('div[role="dialog"], mat-dialog-container')) {
          orphanBackdrops.forEach(b => b.remove());
          actionTaken = true;
        }

        return actionTaken;
      });

      if (dismissed) {
        this.log('A blocking banner/overlay that appeared on Flow was removed automatically.', 'info');
        await sleep(250);
      }
      return dismissed;
    } catch (e) {
      return false;
    }
  }

  // MODEL, DURATION & SUBMODE AWARE REQUIRED CREDITS CALCULATOR
  getRequiredCredits(settings) {
    if (!settings || settings.type === 'Image') {
      return 0;
    }

    const duration = (settings.duration || '6s').toLowerCase().replace('s', '').trim();
    const model = (settings.model || '').toLowerCase();
    // v2.4.0: Outputs is LOCKED to x1 (owner's order — the x2/x3/x4
    // select is gone from the UI; nobody re-renders one prompt into
    // several videos from that option). A settings_json saved by an
    // older version may still carry outputsCount > 1 — it is read as
    // x1 here, quietly, everywhere credits are computed.
    const outputsCount = 1;
    let creditsPerOutput;

    if (model.includes('quality')) {
      creditsPerOutput = 100;
    } else if (model.includes('fast')) {
      if (duration === '4') creditsPerOutput = 15;
      else if (duration === '6') creditsPerOutput = 20;
      else if (duration === '8') creditsPerOutput = 25;
      else if (duration === '10') creditsPerOutput = 30;
      else creditsPerOutput = 20;
    } else if (model.includes('lite')) {
      if (duration === '4') creditsPerOutput = 7;
      else if (duration === '6') creditsPerOutput = 10;
      else if (duration === '8') creditsPerOutput = 12;
      else if (duration === '10') creditsPerOutput = 15;
      else creditsPerOutput = 10;
    } else if (model.includes('omni') || model.includes('flash')) {
      // v1.7.0: Omni Flash TEXT-TO-VIDEO costs 1 credit per second —
      // verified live on 2026-10-11 (a 4s clip charged exactly 4
      // credits). The old table (7/10/12/15) over-charged the local
      // ledger on every estimated deduction, draining displayed
      // balances ~40% too fast and rotating accounts early (the
      // owner's "credits kat-te hain" complaint). Ingredients/Frames
      // modes keep the older, higher estimates — unverified, and
      // conservative on purpose.
      const premiumMode = settings.videoMode === 'Ingredients' || settings.videoMode === 'Frames' || settings.referenceImage || settings.startFrame || settings.endFrame;
      if (!premiumMode) {
        if (duration === '4') creditsPerOutput = 4;
        else if (duration === '6') creditsPerOutput = 6;
        else if (duration === '8') creditsPerOutput = 8;
        else if (duration === '10') creditsPerOutput = 10;
        else creditsPerOutput = 6;
      } else {
        if (duration === '4') creditsPerOutput = 7;
        else if (duration === '6') creditsPerOutput = 10;
        else if (duration === '8') creditsPerOutput = 12;
        else if (duration === '10') creditsPerOutput = 15;
        else creditsPerOutput = 10;
      }
    } else if (settings.videoMode === 'Ingredients' || settings.referenceImage || settings.videoMode === 'Frames' || settings.startFrame || settings.endFrame) {
      creditsPerOutput = 20;
    } else {
      creditsPerOutput = 10;
    }

    return creditsPerOutput * outputsCount;
  }

  // READ REAL-TIME CREDITS DIRECTLY FROM GOOGLE FLOW PAGE / SESSION
  // Returns a number, or null when the page cannot confirm a balance.
  async readLiveCreditsFromPage() {
    if (!this.page || this.page.isClosed()) return null;
    try {
      const isExhaustedBanner = await this.page.evaluate(() => {
        const banner = document.querySelector('.credit-banner-error, .prompt-warning-button');
        const bodyText = document.body ? (document.body.innerText || '') : '';
        return !!(banner || bodyText.includes('out of Google Flow credits') || bodyText.includes('Insufficient credits'));
      });
      if (isExhaustedBanner) {
        return 0;
      }

      const liveCredits = await this.page.evaluate(async () => {
        const targetBtn = document.querySelector('.header-user-button, [aria-label*="Account details" i], [aria-label*="account" i], [aria-label*="Google Account" i], .gb_C');
        if (targetBtn) {
          try {
            targetBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            const panel = document.querySelector('flow-account-panel, [role="dialog"], div[class*="account-panel"], div[class*="profile-menu"]');
            if (panel) {
              const text = panel.innerText || panel.textContent || '';
              const match = text.match(/([\d,]+)\s*(?:Google\s*Flow\s*)?credits/i) || text.match(/credits?:\s*([\d,]+)/i) || text.match(/([\d,]+)\s*cr\b/i);
              const closeBtn = panel.querySelector('.close-btn, button[aria-label*="Close" i]');
              if (closeBtn) {
                closeBtn.click();
              } else if (targetBtn) {
                targetBtn.click();
              }
              if (match) return parseInt(match[1].replace(/,/g, ''), 10);
            }
          } catch (e) {}
        }

        const chips = Array.from(document.querySelectorAll('flow-user-tier-chip'));
        for (const el of chips) {
          const txt = (el.innerText || el.textContent || '').trim();
          const m = txt.match(/^([\d,]{1,7})\s*(?:credits?|cr)$/i) || txt.match(/([\d,]{1,7})\s*(?:Google\s*Flow\s*)?credits?/i);
          if (m) return parseInt(m[1].replace(/,/g, ''), 10);
          const aria = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
          const am = aria.match(/([\d,]{1,7})\s*(?:remaining\s*)?credits?/i);
          if (am) return parseInt(am[1].replace(/,/g, ''), 10);
        }

        return null;
      });
      return liveCredits;
    } catch (e) {
      return null;
    }
  }

  /**
   * Detects Flow's own out-of-credits state for the current settings.
   * Returns 'EXHAUSTED' | 'LOW_CREDITS' | 'OK'. A page banner routes through
   * creditPort.exhaustionBanner (one of only two zeroing paths, fix #2);
   * a merely-insufficient balance routes through creditPort.lowCredits and
   * keeps the real balance intact.
   */
  async checkCreditsState(settings) {
    try {
      if (settings && settings.type === 'Image') return 'OK';
      if (!this.page || this.page.isClosed()) return 'OK';

      const isExhaustedOnPage = await this.page.evaluate(() => {
        const pageText = (document.body.innerText || '').toLowerCase();
        return (
          pageText.includes('insufficient credits') ||
          pageText.includes('out of credits') ||
          pageText.includes('no credits remaining') ||
          pageText.includes('reached your generation limit') ||
          pageText.includes('daily limit reached')
        );
      });

      const accId = this.currentAccount ? this.currentAccount.id : null;
      if (isExhaustedOnPage) {
        this.creditPort.exhaustionBanner(accId);
        if (this.currentAccount) this.currentAccount.credits = 0;
        return 'EXHAUSTED';
      }

      const requiredCredits = this.getRequiredCredits(settings);
      const live = await this.readLiveCreditsFromPage();
      if (typeof live === 'number') {
        this.creditPort.liveBalance(accId, live);
        if (this.currentAccount) this.currentAccount.credits = live;
        if (live === 0) return 'EXHAUSTED';
        if (requiredCredits > 0 && live < requiredCredits) {
          this.creditPort.lowCredits(accId, requiredCredits);
          return 'LOW_CREDITS';
        }
        return 'OK';
      }

      const accCredits = Number(this.currentAccount ? this.currentAccount.credits : NaN);
      if (!isNaN(accCredits) && requiredCredits > 0 && accCredits < requiredCredits) {
        this.creditPort.lowCredits(accId, requiredCredits);
        return 'LOW_CREDITS';
      }

      return 'OK';
    } catch (e) {
      return 'OK';
    }
  }

  // AUTO-DETECT & DISABLE GOOGLE FLOW "AGENT MODE" CHIP
  async ensureAgentModeDisabled() {
    if (!this.page || this.page.isClosed()) return false;
    try {
      const toggled = await this.page.evaluate(() => {
        const chip = document.querySelector('.agent-mode-chip, button.agent-mode-chip') ||
          Array.from(document.querySelectorAll('button')).find(b => {
            const txt = (b.innerText || '').trim().toLowerCase();
            return txt === 'agent' && (b.className.includes('checked') || b.className.includes('active') || b.getAttribute('aria-pressed') === 'true');
          });

        if (chip && (chip.className.includes('checked') || chip.className.includes('active') || chip.getAttribute('aria-pressed') === 'true')) {
          chip.click();
          return true;
        }
        return false;
      });

      if (toggled) {
        this.log('Flow\'s "Agent Mode" was ON — it has been turned OFF for direct video generation.', 'info');
        await sleep(1000);
      }
      return toggled;
    } catch (e) {
      return false;
    }
  }

  // ATOMIC NATIVE TEXT INSERTION (bypasses keydown triggers for @ mentions / search hijacking)
  async insertNativeText(text) {
    const cleanText = (text || '').replace(/[\r\n]+/g, ' ').trim();
    if (!cleanText) return;

    if (!this.cdpSession && this.page) {
      try {
        this.cdpSession = await this.page.target().createCDPSession();
      } catch (e) {}
    }

    try {
      await this.page.evaluate(() => {
        const searchInput = document.querySelector('input.search-input, input[aria-label*="search" i]');
        if (searchInput && (searchInput.value || document.activeElement === searchInput)) {
          searchInput.value = '';
          searchInput.blur();
        }
        const editor = document.querySelector('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror');
        if (editor) {
          editor.focus();
        }
      });
    } catch (e) {}

    if (this.cdpSession) {
      try {
        await this.cdpSession.send('Input.insertText', { text: cleanText });
        return;
      } catch (e) {
        const t = plainError.translateError(e);
        this.log(`A problem came up in the first method of writing the prompt — ${t.plain}. Trying the second method…`, 'warn', { rawError: t.raw });
      }
    }

    const execSuccess = await this.page.evaluate((str) => {
      const editor = document.querySelector('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror');
      if (editor) {
        editor.focus();
        return document.execCommand('insertText', false, str);
      }
      return false;
    }, cleanText);

    if (!execSuccess) {
      await this.page.keyboard.type(cleanText, { delay: 10 });
    }
  }

  // CONFIGURE GENERATION SETTINGS (exact Google Flow UI synchronization)
  async configureGenerationSettings(settings, isRetry = false) {
    try {
      await this.ensureAgentModeDisabled();
      await sleep(1000);

      const modeType = settings.type || 'Video';
      const videoMode = settings.videoMode || 'Text';
      this.log(`Applying Flow settings: Mode=${modeType} | Type=${videoMode} | Model=${settings.model || 'Omni Flash'} | Duration=${settings.duration || '6s'} | Size=${settings.aspectRatio || '9:16'} | Outputs=x1…`, 'info');

      if (videoMode === 'Text') {
        await this.page.evaluate(() => {
          const removeBtns = Array.from(document.querySelectorAll('button')).filter(b => {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            const txt = (b.innerText || '').toLowerCase();
            return aria.includes('remove') || txt.includes('close') || aria.includes('close');
          });
          removeBtns.forEach(b => b.click());
        });
      }

      // 1. Locate and open the Config Pill in the Flow prompt bar
      let pillInfo = await this.page.evaluate(() => {
        const pill = document.querySelector('.settings-trigger-button, button.settings-trigger-button') ||
          Array.from(document.querySelectorAll('button')).find(b => {
            const txt = (b.innerText || '').toLowerCase();
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            return aria.includes('settings trigger') || txt.includes('banana') || txt.includes('veo') || txt.includes('video') || txt.includes('image');
          });

        if (pill) {
          const r = pill.getBoundingClientRect();
          return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, text: pill.innerText };
        }
        return { found: false };
      });

      if (!pillInfo.found) {
        await this.ensureAgentModeDisabled();
        await sleep(800);
        pillInfo = await this.page.evaluate(() => {
          const pill = document.querySelector('.settings-trigger-button, button.settings-trigger-button') ||
            Array.from(document.querySelectorAll('button')).find(b => {
              const txt = (b.innerText || '').toLowerCase();
              const aria = (b.getAttribute('aria-label') || '').toLowerCase();
              return aria.includes('settings trigger') || txt.includes('banana') || txt.includes('veo') || txt.includes('video') || txt.includes('image');
            });
          if (pill) {
            const r = pill.getBoundingClientRect();
            return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, text: pill.innerText };
          }
          return { found: false };
        });
      }

      if (pillInfo.found) {
        this.log(`Clicking Flow's settings pill: "${pillInfo.text.replace(/\n/g, ' ')}"...`, 'info');
        await this.page.mouse.click(pillInfo.x, pillInfo.y);
        await sleep(1000);

        // 2. Select Video vs Image mode inside the settings popover
        this.log(`Changing the mode: [${modeType}]…`, 'info');
        const modeClicked = await this.page.evaluate((targetMode) => {
          const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
          const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
          const m = targetMode.toLowerCase();
          const targetBtn = btns.find(b => {
            const txt = (b.innerText || '').toLowerCase();
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            if (m === 'video') {
              return (txt.includes('video') && !txt.includes('image')) || aria === 'video';
            } else {
              return (txt.includes('image') && !txt.includes('video')) || aria === 'image';
            }
          });

          if (targetBtn) {
            targetBtn.click();
            const r = targetBtn.getBoundingClientRect();
            return { clicked: true, text: targetBtn.innerText, x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
          return { clicked: false };
        }, modeType);

        if (modeClicked.clicked) {
          if (modeClicked.x && modeClicked.y) {
            await this.page.mouse.click(modeClicked.x, modeClicked.y);
          }
          await sleep(800);
        }

        // 3. Select Video Sub-mode (Text vs Ingredients vs Frames)
        if (modeType === 'Video') {
          if (videoMode === 'Ingredients') {
            this.log('Selecting the sub-mode: [Ingredients]…', 'info');
            await this.page.evaluate(() => {
              const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
              const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
              const b = btns.find(btn => (btn.innerText || '').toLowerCase().includes('ingredient'));
              if (b) b.click();
            });
            await sleep(350);
          } else if (videoMode === 'Frames') {
            this.log('Selecting the sub-mode: [Frames]…', 'info');
            await this.page.evaluate(() => {
              const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
              const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
              const b = btns.find(btn => (btn.innerText || '').toLowerCase().includes('frame'));
              if (b) b.click();
            });
            await sleep(350);
          } else {
            await this.page.evaluate(() => {
              const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
              const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
              const btnFrames = btns.find(b => (b.innerText || '').trim().toLowerCase().includes('frames'));
              const btnIngredients = btns.find(b => (b.innerText || '').trim().toLowerCase().includes('ingredients'));
              if (btnFrames && (btnFrames.getAttribute('data-state') === 'on' || btnFrames.className.includes('active'))) btnFrames.click();
              if (btnIngredients && (btnIngredients.getAttribute('data-state') === 'on' || btnIngredients.className.includes('active'))) btnIngredients.click();
            });
            await sleep(200);
          }
        }

        // 3.5 Select AI Model FIRST among the value controls (v1.6.2: changing the model makes Flow reset the duration to that model's default — setting duration before the model is how a 6s request silently became 8s)
        if (settings.model) {
          this.log(`Selecting the AI Model: [${settings.model}]…`, 'info');
          await this.page.evaluate(async (mName) => {
            const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
            const btns = Array.from(pop.querySelectorAll('button, div[role="button"]'));
            const modelDropdown = btns.find(b => {
              const txt = (b.innerText || '').toLowerCase();
              return txt.includes('omni') || txt.includes('veo') || txt.includes('flash') || txt.includes('banana') || b.getAttribute('aria-haspopup') === 'menu';
            });
            if (modelDropdown) {
              const currentTxt = (modelDropdown.innerText || '').toLowerCase();
              const cleanTarget = mName.toLowerCase().replace(/[^a-z0-9]/g, '');
              if (!currentTxt.replace(/[^a-z0-9]/g, '').includes(cleanTarget)) {
                modelDropdown.click();
                await new Promise(r => setTimeout(r, 400));
                const menuItems = Array.from(document.querySelectorAll('.cdk-overlay-pane [role="menuitem"], [role="menu"] button, div[role="menu"] div, div[role="listbox"] [role="option"]'));
                const opt = menuItems.find(item => {
                  const itTxt = (item.innerText || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                  return itTxt.includes(cleanTarget) || cleanTarget.includes(itTxt);
                });
                if (opt) opt.click();
              }
            }
          }, settings.model);
          await sleep(400);
        }

        // 4. Select Aspect Ratio
        const targetAspect = settings.aspectRatio || (modeType === 'Image' ? '1:1' : '9:16');
        this.log(`Selecting the Size (aspect ratio): [${targetAspect}]…`, 'info');
        await this.page.evaluate((aspect) => {
          const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
          const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
          const cleanAspect = aspect.replace(':', '_');
          const targetBtn = btns.find(b => {
            const txt = (b.innerText || '').trim();
            const aria = (b.getAttribute('aria-label') || '').trim();
            return txt.includes(aspect) || txt.includes(cleanAspect) || aria.includes(aspect) || aria.includes(cleanAspect);
          });
          if (targetBtn) targetBtn.click();
        }, targetAspect);
        await sleep(350);

        // 5. Select Duration
        if (modeType === 'Video') {
          const targetDuration = settings.duration || '6s';
          this.log(`Selecting the Duration: [${targetDuration}]…`, 'info');
          await this.page.evaluate((dur) => {
            const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
            const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
            const targetBtn = btns.find(b => {
              const txt = (b.innerText || '').trim().toLowerCase();
              const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
              return txt === dur.toLowerCase() || aria === dur.toLowerCase();
            });
            if (targetBtn) targetBtn.click();
          }, targetDuration);
          await sleep(350);
        }

        // 6. Select Outputs Count — v2.4.0: always x1 (locked). The
        // step itself stays: a profile Flow used before may remember
        // x2 from an older session, and the click back to x1 is what
        // keeps the credit math honest.
        const targetCount = 'x1';
        this.log(`Selecting the output count: [${targetCount}]…`, 'info');
        await this.page.evaluate((cnt) => {
          const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
          const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
          const targetBtn = btns.find(b => {
            const txt = (b.innerText || '').trim().toLowerCase();
            const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
            return txt === cnt.toLowerCase() || aria === cnt.toLowerCase();
          });
          if (targetBtn) targetBtn.click();
        }, targetCount);
        await sleep(350);

        // 7. Verify the duration ACTUALLY selected (v1.6.2): read the
        // popover's selected duration back; if Flow shows a different
        // value (model-switch reset, a click that landed on a hidden
        // twin), click the right one and re-read. The click alone is
        // never trusted again — the 6s→8s report proved why.
        if (modeType === 'Video') {
          const readSelectedDuration = async () => {
            return await this.page.evaluate(() => {
              const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content');
              if (!pop) return null;
              const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
              const durBtns = btns.filter(b => /^\d+\s*s$/.test((b.innerText || '').trim().toLowerCase()));
              const sel = durBtns.find(b => b.getAttribute('aria-checked') === 'true' || b.getAttribute('aria-selected') === 'true' || b.getAttribute('aria-pressed') === 'true' || b.getAttribute('data-state') === 'on' || b.classList.contains('selected') || b.classList.contains('active'));
              return sel ? (sel.innerText || '').trim().toLowerCase() : null;
            });
          };
          const wantDur = (settings.duration || '6s').toLowerCase();
          let shownDur = await readSelectedDuration();
          for (let attempt = 0; attempt < 2 && shownDur && shownDur !== wantDur; attempt++) {
            this.log(`The duration on Flow shows [${shownDur}], need [${wantDur}] — setting it again...`, 'warn');
            await this.page.evaluate((dur) => {
              const pop = Array.from(document.querySelectorAll('.cdk-overlay-pane, .settings-content')).find(p => p.getClientRects().length > 0) || document.querySelector('.settings-content') || document.body;
              const btns = Array.from(pop.querySelectorAll('button, [role="radio"], [role="tab"]'));
              const targetBtn = btns.find(b => {
                const txt = (b.innerText || '').trim().toLowerCase();
                const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
                return txt === dur.toLowerCase() || aria === dur.toLowerCase();
              });
              if (targetBtn) targetBtn.click();
            }, settings.duration || '6s');
            await sleep(350);
            shownDur = await readSelectedDuration();
          }
          if (shownDur) {
            this.log(`Duration confirmed on Flow: [${shownDur}] (needed [${wantDur}])`, shownDur === wantDur ? 'success' : 'warn');
          }
        }

        // 8. Close popover
        await this.page.keyboard.press('Escape');
        await sleep(600);

        // 9. Verify prompt-bar pill text
        const finalPillText = await this.page.evaluate(() => {
          const pill = document.querySelector('.settings-trigger-button, button.settings-trigger-button');
          return pill ? pill.innerText.replace(/\n/g, ' ').trim() : null;
        });

        if (modeType === 'Video' && finalPillText && (finalPillText.includes('Banana') || finalPillText.startsWith('Image'))) {
          if (!isRetry) {
            this.log(`The settings pill is still stuck on Image (${finalPillText}) — trying again to switch it to Video…`, 'warn');
            return await this.configureGenerationSettings(settings, true);
          } else {
            this.log(`Settings pill par chetaavni: "${finalPillText}".`, 'warn');
          }
        } else {
          this.log(`Saari Flow settings lag gayi aur Flow ke UI me confirm bhi ho gayi: "${finalPillText || modeType}"`, 'success');
        }
      } else {
        this.log('No settings pill was found on Flow — work will continue with the default settings.', 'warn');
      }
    } catch (e) {
      const t = plainError.translateError(e);
      this.log(`Settings lagane me ek note: ${t.plain}.`, 'warn', { rawError: t.raw });
    }
  }

  // SUBMIT A SINGLE PROMPT (fire-and-forget: returns once Flow accepts it)
  // Returns { status: 'SUBMITTED' | 'EXHAUSTED' | 'LOW_CREDITS' | 'VIOLATION' | 'STOPPED', ... }
  // EXHAUSTED / LOW_CREDITS are only ever returned BEFORE the prompt fires,
  // so the pool may safely re-queue the task on another account.
  async submitPrompt(promptText, settings, promptIndex, totalPrompts) {
    if (this.isStopping) return { status: 'STOPPED' };
    // v1.1: from here on, video streams on this page may be results of our
    // own submissions — arm the response capture (see launch handler).
    this.captureArmed = true;

    promptText = (promptText || '').replace(/[\r\n]+/g, ' ').trim();
    const videoId = `vid_${Date.now()}_${promptIndex + 1}`;
    this.log(`[Prompt ${promptIndex + 1}/${totalPrompts}] Sending to Flow: "${promptText.substring(0, 50)}..."`, 'info');

    if (this.onVideoStarted) {
      this.onVideoStarted({
        id: videoId,
        prompt: promptText,
        promptIndex: promptIndex + 1,
        totalPrompts,
        accountName: this.currentAccount ? this.currentAccount.name : 'Account',
        status: 'Preparing & Submitting...'
      });
    }

    await this.dismissAnyBlockingOverlays();

    if (settings.type !== 'Image') {
      const creditState = await this.checkCreditsState(settings);
      if (creditState === 'EXHAUSTED') {
        this.log(`[${this.currentAccount.name}]'s credits are finished!`, 'warn');
        return { status: 'EXHAUSTED' };
      }
      if (creditState === 'LOW_CREDITS') {
        this.log(`[${this.currentAccount.name}] has too few credits for the selected model.`, 'warn');
        return { status: 'LOW_CREDITS' };
      }
    }

    // 1. Configure settings on the first prompt of this browser session
    // (hasConfiguredSettings is reset on every launch/close — audit fix #5).
    if (!this.hasConfiguredSettings) {
      await this.configureGenerationSettings(settings);
      this.hasConfiguredSettings = true;
    }

    await this.ensureAgentModeDisabled();
    const currentPillText = await this.page.evaluate(() => {
      const pill = document.querySelector('.settings-trigger-button, button.settings-trigger-button');
      return pill ? pill.innerText.replace(/\n/g, ' ').trim() : null;
    });

    const isVideoExpected = (settings.type || 'Video') === 'Video';
    if (isVideoExpected && currentPillText && (currentPillText.includes('Banana') || currentPillText.startsWith('Image'))) {
      this.log(`The Flow workspace has gone back to Image (${currentPillText}) — applying Video mode again…`, 'warn');
      await this.configureGenerationSettings(settings);
    }

    // 2. Focus the ProseMirror prompt box and type the prompt
    this.currentStage = 'Prompt Input';
    this.log('Focusing Flow\'s prompt box…', 'info');

    let tbFound = false;
    try {
      await this.page.waitForSelector('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror', { timeout: 15000 });
      tbFound = true;
    } catch (tbErr) {
      tbFound = false;
    }

    if (!tbFound) {
      throw new Error(`Google Flow prompt box ('div.ProseMirror') not found on canvas URL: ${this.page.url()}`);
    }

    await this.page.evaluate(() => {
      const searchInput = document.querySelector('input.search-input, input[aria-label*="search" i]');
      if (searchInput) {
        searchInput.value = '';
        searchInput.blur();
      }
      const clearBtn = document.querySelector('button.clear-button, button[aria-label="Clear prompt"]');
      if (clearBtn) {
        try { clearBtn.click(); } catch (e) {}
      }
    });

    const tbCoords = await this.page.evaluate(() => {
      const el = document.querySelector('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror');
      if (el) {
        el.focus();
        const r = el.getBoundingClientRect();
        return { x: r.x + Math.min(25, r.width / 4), y: r.y + r.height / 2 };
      }
      return null;
    });

    if (tbCoords) {
      await this.page.mouse.click(tbCoords.x, tbCoords.y);
      await sleep(150);
    } else {
      const tbHandle = await this.page.$('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror');
      if (tbHandle) await tbHandle.click();
      await sleep(150);
    }

    await this.page.keyboard.down('Control');
    await this.page.keyboard.press('A');
    await this.page.keyboard.up('Control');
    await this.page.keyboard.press('Backspace');
    await sleep(150);

    this.log(`Writing the prompt: "${promptText.substring(0, 50)}..."`, 'info');
    await this.insertNativeText(promptText);
    await sleep(250);

    await this.page.evaluate(() => {
      const searchInput = document.querySelector('input.search-input, input[aria-label*="search" i]');
      if (searchInput && (searchInput.value || document.activeElement === searchInput)) {
        searchInput.value = '';
        searchInput.blur();
      }
    });

    // Verify the prompt actually landed in the editor DOM (multi-layer fallback)
    let domPromptText = await this.page.evaluate(() => {
      const el = document.querySelector('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror');
      return el ? (el.innerText || el.textContent || '').trim() : '';
    });

    if (!domPromptText || domPromptText.length === 0) {
      this.log('The prompt could not be written with the first method — trying the second method (inserting the text directly)…', 'warn');
      if (!this.cdpSession && this.page) {
        try { this.cdpSession = await this.page.target().createCDPSession(); } catch (e) {}
      }
      if (this.cdpSession) {
        try { await this.cdpSession.send('Input.insertText', { text: promptText }); } catch (cdpErr) {}
      }
      await sleep(250);
      domPromptText = await this.page.evaluate(() => {
        const el = document.querySelector('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror');
        return el ? (el.innerText || el.textContent || '').trim() : '';
      });
    }

    if (!domPromptText || domPromptText.length === 0) {
      this.log('The second method also did not work — trying the third method…', 'warn');
      await this.page.evaluate((text) => {
        const el = document.querySelector('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror');
        if (el) {
          el.focus();
          document.execCommand('insertText', false, text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, promptText);
      await sleep(250);
      domPromptText = await this.page.evaluate(() => {
        const el = document.querySelector('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror');
        return el ? (el.innerText || el.textContent || '').trim() : '';
      });
    }

    if (!domPromptText || domPromptText.length === 0) {
      throw new Error('Could not write prompt into Google Flow ProseMirror editor. Editor DOM did not accept input events.');
    }

    this.log(`The prompt has been written correctly in Flow's editor (${domPromptText.length} characters).`, 'success');

    // Snapshot existing tiles + captured URLs before firing, so this task can
    // later prove which media belongs to ITS submission (audit fix #6).
    let preExistingTileCount = 0;
    let preExistingAriaLabels = [];
    try {
      const snap = await this.page.evaluate(() => {
        const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
        return {
          count: containers.length,
          labels: containers.map(c => (c.getAttribute('aria-label') || '').toLowerCase().trim()).filter(Boolean)
        };
      });
      preExistingTileCount = snap.count;
      preExistingAriaLabels = snap.labels;
    } catch (e) {}

    const preExistingVideoUrls = new Set(this.capturedVideoUrls || []);

    // v2.8.0: NETWORK CAPTURE armed — generate fire hone se THEEK
    // pehle is submission ki entry capture me banti hai. Submit ke
    // jawab me aane wala workflowId isi entry se bandhega, aur usi
    // ID ke saath aaya media link seedha isi task ka mana jayega
    // (engine/networkCapture.js — pehchan ka sabse mazboot raasta).
    try { this.netCapture.beginSubmission(videoId, Date.now()); } catch (e) {}

    // 3. Fire the generation request (trusted OS-level click)
    this.currentStage = 'Firing Generation';
    this.log('Sending the Generate request to Flow (pressing the video-generation button)…', 'info');
    await sleep(400);

    let submitBtnCoords = null;
    for (let waitBtn = 0; waitBtn < 5; waitBtn++) {
      submitBtnCoords = await this.page.evaluate(() => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        const submitBtn = allBtns.find(b => {
          const txt = (b.innerText || '').trim();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          const cls = String(b.className || '').toLowerCase();
          const isGenIcon = cls.includes('generate-icon-button') || cls.includes('generate');
          const hasArrow = txt.includes('arrow_forward') || txt.includes('arrow_upward') || txt.includes('send');
          const isGenerate = (aria === 'generate' || aria === 'submit' || aria.includes('generation') || aria.includes('generate'));
          const isAddButton = aria.includes('add') || aria.includes('asset') || txt.includes('add_2') || txt === '+';
          return (isGenIcon || hasArrow || isGenerate) && !isAddButton;
        });

        if (submitBtn) {
          const disabled = submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true';
          const r = submitBtn.getBoundingClientRect();
          return { found: true, disabled, x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        return { found: false };
      });

      if (submitBtnCoords && submitBtnCoords.found && !submitBtnCoords.disabled) {
        break;
      }
      await sleep(500);
    }

    if (submitBtnCoords && submitBtnCoords.found) {
      if (submitBtnCoords.disabled) {
        this.log('The send button is still off (disabled) — trying to enable it…', 'warn');
        await this.page.evaluate(() => {
          const el = document.querySelector('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror');
          if (el) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
        await sleep(500);
      }
      await this.page.mouse.move(submitBtnCoords.x, submitBtnCoords.y, { steps: 5 });
      await sleep(100);
      await this.page.mouse.click(submitBtnCoords.x, submitBtnCoords.y);
      await sleep(350);
    } else {
      this.log('Sending the prompt with the Ctrl+Enter shortcut…', 'info');
      await this.page.keyboard.down('Control');
      await this.page.keyboard.press('Enter');
      await this.page.keyboard.up('Control');
      await sleep(350);
    }

    // 4. Immediate safety / policy violation scan
    // v2.9.0 — SABOOT KA DAYRA (engine/failureEvidence.js): ye scan
    // sirf tab violation maanta hai jab kisi alert/dialog/snackbar me
    // Flow ka ASAL refusal JUMLA mile (word-bounded phrases; akela
    // 'safety'/'policy'/'violat'/'blocked' kabhi kaafi nahi), aur
    // account/credits wala chrome panel — jo credit check khud kholta
    // hai — iske liye kabhi saboot nahi banta. Wajah bhi wahi asal
    // jumla hota hai, poora element ka kata majmua nahi. (Purana scan
    // page ke kisi bhi [class*="error"]/[class*="alert"] hisse par
    // bare-substring se trigger ho jata tha.)
    await sleep(1500);
    const immediateViolation = await this.page.evaluate(({ refusalSources, chromeMarkers }) => {
      const stripLigs = (t) => String(t || '').replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, ' ');
      const findRefusalSnippet = (raw) => {
        const flat = String(raw || '').replace(/\s/g, ' ');
        const low = flat.toLowerCase();
        for (const src of refusalSources) {
          const m = low.match(new RegExp(src, 'i'));
          if (!m) continue;
          let a = Math.max(0, m.index - 90);
          for (let i = m.index - 1; i >= a; i--) { if ('.!?\n'.includes(flat[i])) { a = i + 1; break; } }
          let b = Math.min(flat.length, m.index + m[0].length + 90);
          for (let i = m.index + m[0].length; i < b; i++) { if ('.!?'.includes(flat[i])) { b = i + 1; break; } }
          return flat.slice(a, b).replace(/\s+/g, ' ').trim();
        }
        return null;
      };
      const isAccountChrome = (el, low) => chromeMarkers.some(mk => low.includes(mk)) ||
        (el.closest && !!el.closest('flow-account-panel, [class*="account-panel"], [class*="profile-menu"]'));
      const errorSelectors = [
        'div[role="alert"]',
        'div[role="alertdialog"]',
        'div[role="status"]',
        'snack-bar',
        'mwc-snackbar',
        '[class*="snackbar"]',
        '.toast',
        'div[role="dialog"]',
        'mwc-dialog',
        'flow-dialog'
      ];

      const seen = new Set();
      for (const sel of errorSelectors) {
        const els = Array.from(document.querySelectorAll(sel));
        for (const el of els) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (!(el.offsetWidth > 0 || el.offsetHeight > 0)) continue;
          const raw = el.innerText || '';
          const low = raw.toLowerCase();
          if (isAccountChrome(el, low)) continue;
          const snippet = findRefusalSnippet(stripLigs(raw));
          if (!snippet) continue;
          const dismissBtn = Array.from(el.querySelectorAll('button, [role="button"]')).find(b => {
            const bTxt = (b.innerText || '').toLowerCase().trim();
            return bTxt.includes('got it') || bTxt.includes('dismiss') || bTxt === 'ok' || bTxt.includes('close');
          });
          if (dismissBtn) {
            try { dismissBtn.click(); } catch (e) {}
          }
          return {
            isViolation: true,
            message: snippet.substring(0, 150)
          };
        }
      }

      return null;
    }, { refusalSources: failureEvidence.patternSources(), chromeMarkers: failureEvidence.ACCOUNT_CHROME_MARKERS });

    if (immediateViolation && immediateViolation.isViolation) {
      try { await this.page.keyboard.press('Escape'); } catch (e) {}
      try {
        await this.page.evaluate(() => {
          const clearBtn = document.querySelector('button.clear-button, button[aria-label="Clear prompt"]');
          if (clearBtn) { try { clearBtn.click(); } catch (e) {} }
          const el = document.querySelector('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror');
          if (el) {
            el.textContent = '';
          }
        });
      } catch (e) {}

      this.log(`[Prompt #${promptIndex + 1}] Google Safety/Policy Violation detected: "${immediateViolation.message}". Skipping prompt safely to protect queue!`, 'warn');

      this.onVideoCompleted({
        id: videoId,
        prompt: promptText,
        accountName: this.currentAccount.name,
        status: `Violation: ${immediateViolation.message}`,
        filePath: null,
        error: immediateViolation.message,
        type: settings.type,
        timestamp: new Date().toLocaleTimeString()
      });

      return {
        status: 'VIOLATION',
        // v2.9.0: reason par wahi label + tile/dialog ka ASAL jumla —
        // label failover ki prompt-level pehchan ke liye hai, jumla
        // imaandari ke liye (phrase ab pakka sabit shuda hai).
        reason: `Google Safety Filter: ${immediateViolation.message}`,
        videoId,
        promptIndex
      };
    }

    this.log(`[Prompt #${promptIndex + 1}] The video-generation request has gone to Flow — now waiting for the render (video generation).`, 'success');

    // 5. Post-submit credit sync — through the credit port only (fix #4).
    // A live re-read wins; otherwise an estimated charge is applied, which
    // by credit-service rule can never zero the balance (fix #2).
    const required = this.getRequiredCredits(settings);
    if (this.currentAccount && required > 0) {
      const accId = this.currentAccount.id;
      const liveCr = await this.readLiveCreditsFromPage();
      if (typeof liveCr === 'number') {
        this.creditPort.liveBalance(accId, liveCr);
        this.currentAccount.credits = liveCr;
        this.log(`[Credits] [${this.currentAccount.name}]'s balance after the charge: ${liveCr} credits.`, 'info');
      } else {
        const res = this.creditPort.estimatedCharge(accId, required);
        if (res && res.account && typeof res.account.credits === 'number') {
          this.currentAccount.credits = res.account.credits;
        }
        this.log(`[Credits] ~${required} credits were deducted from [${this.currentAccount.name}] (estimate — the live balance could not be read immediately).`, 'info');
      }
      if (this.onAccountUpdated) {
        this.onAccountUpdated({ account: this.currentAccount });
      }
    }

    this.onVideoStarted({
      id: videoId,
      prompt: promptText,
      accountName: this.currentAccount.name,
      quality: settings.quality || '360p',
      duration: settings.duration || '6s',
      aspectRatio: settings.aspectRatio || '9:16',
      timestamp: new Date().toLocaleTimeString(),
      status: 'Generating'
    });

    // v1.5.0 BIRTH BINDING: poll briefly for the NEW tile this submission
    // created and bind the task to it by FINGERPRINT right away. The
    // monitor then never has to guess which tile belongs to this task
    // (the old guess-by-index/two-words scheme is what scrambled
    // multi-prompt runs). If the tile is slow to appear, the task still
    // returns SUBMITTED unbound — the monitor's strict scored claim is
    // the fallback.
    const preExistingFingerprints = new Set(
      (preExistingAriaLabels || []).map(l => tileIdentity.tileFingerprint(l, ''))
    );
    // v1.7.0: birth binding must be SCORED, never "first new tile wins".
    // Burst submissions race: a sibling prompt's tile can appear before
    // this task's own, and the old text-blind binding locked this task
    // onto the WRONG video for the entire run — the monitor's
    // fingerprint pass trusts a locked binding, so the error never
    // healed (owner's persistent "prompt mismatch" report). Bind only
    // when the tile's own prompt text STRONGLY matches this prompt;
    // otherwise stay unbound and let the monitor's scored assignment
    // (which compares all tasks against all tiles) decide.
    const promptWordsForBind = tileIdentity.significantWords(promptText || '');
    let lockedTileFingerprint = null;
    try {
      for (let poll = 0; poll < 6 && !lockedTileFingerprint; poll++) {
        const fps = await this.page.evaluate(() => {
          return Array.from(document.querySelectorAll('flow-grid-tile-container'))
            .map(c => (c.getAttribute('aria-label') || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
        });
        for (const fp of fps) {
          if (preExistingFingerprints.has(fp) || this.claimedTileFingerprints.has(fp)) continue;
          if (tileIdentity.isStrongMatch(tileIdentity.scoreTileForPrompt(promptWordsForBind, tileIdentity.significantWords(fp)))) {
            lockedTileFingerprint = fp;
            break;
          }
        }
        if (!lockedTileFingerprint) await sleep(2500);
      }
    } catch (e) {}
    if (lockedTileFingerprint) {
      this.claimedTileFingerprints.add(lockedTileFingerprint);
      this.log(`[Prompt #${promptIndex + 1}] Linked to its render tile (the tile identification/fingerprint matched).`, 'info');
    }

    return {
      status: 'SUBMITTED',
      videoId,
      // v2.8.0: network capture isi key se is task ko pehchanta hai
      // (videoId hi capture key hai — submit ke pal par tay hua).
      captureKey: videoId,
      promptText,
      promptIndex,
      startTime: Date.now(),
      preExistingTileCount,
      preExistingAriaLabels,
      preExistingFingerprints: [...preExistingFingerprints],
      preExistingVideoUrls,
      lockedTileFingerprint,
      wasObservedGenerating: false,
      completed: false,
      downloaded: false
    };
  }

  /**
   * v1.5.0: resolve a tile's CURRENT DOM index from its fingerprint
   * (normalized aria). Indices shift as new tiles arrive; fingerprints
   * do not. Returns -1 when the tile is not in the grid right now.
   */
  async _resolveTileIndexByFingerprint(fingerprint) {
    if (!fingerprint || !this.page || this.page.isClosed()) return -1;
    try {
      return await this.page.evaluate((fp) => {
        const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
        for (let i = 0; i < containers.length; i++) {
          if (norm(containers[i].getAttribute('aria-label') || '') === fp) return i;
        }
        return -1;
      }, fingerprint);
    } catch (e) {
      return -1;
    }
  }

  /**
   * v1.7.0: THE canonical way to locate a task's tile in the grid.
   * Fingerprint (the tile's normalized prompt aria) first; a remembered
   * DOM index is only a fallback and is interpreted against the ONE
   * canonical tile list (flow-grid-tile-container). The pre-v1.7 media
   * extraction evaluate read from a BROADER selector list
   * (flow-grid-tile-container, flow-video-tile, [role="gridcell"],
   * div[class*="tile"]) than the list its index was computed in — the
   * same index then pointed at a NEIGHBOUR's tile, and the neighbour's
   * fresh video URL passed the own-URL gate (which only excludes
   * pre-existing/consumed URLs). That selector drift is the
   * download/prompt mismatch the owner kept hitting even after tile
   * ASSIGNMENT was fixed in v1.5.0.
   */
  async _resolveTileIndexForTask(task, fallbackIdx) {
    if (!this.page || this.page.isClosed()) return -1;
    const fp = task ? (task.lockedTileFingerprint || null) : null;
    if (fp) {
      const byFp = await this._resolveTileIndexByFingerprint(fp);
      if (byFp >= 0) return byFp;
    }
    return (typeof fallbackIdx === 'number' && fallbackIdx >= 0) ? fallbackIdx : -1;
  }

  /**
   * v1.7.0: read the media URL from THIS task's tile only (located via
   * _resolveTileIndexForTask — canonical list, fingerprint-first).
   *
   * v2.7.0: the read now also tries the video element's `currentSrc`
   * (the URL the element is ACTUALLY playing — Flow sometimes leaves
   * `src` empty and only materializes currentSrc), and a detailed
   * variant reports WHICH attribute produced the URL so the download
   * orchestrator can log the exact route instead of failing silently.
   */
  async _extractTileMediaUrl(task, fallbackIdx, isImage) {
    const d = await this._extractTileMediaUrlDetailed(task, fallbackIdx, isImage);
    return d ? d.url : null;
  }

  async _extractTileMediaUrlDetailed(task, fallbackIdx, isImage) {
    try {
      const idx = await this._resolveTileIndexForTask(task, fallbackIdx);
      if (idx < 0) return null;
      return await this.page.evaluate(({ idx, isImage }) => {
        const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
        const target = containers[idx] || null;
        if (!target) return null;
        const usable = (u) => (u && (u.startsWith('http') || u.startsWith('blob:'))) ? u : null;
        const vid = target.querySelector('video');
        if (vid) {
          const fromSrc = usable(vid.src);
          if (fromSrc) return { url: fromSrc, via: 'video src' };
          const fromCurrent = usable(vid.currentSrc);
          if (fromCurrent) return { url: fromCurrent, via: 'video currentSrc' };
        }
        const src = target.querySelector('source');
        if (src) {
          const fromSource = usable(src.src);
          if (fromSource) return { url: fromSource, via: 'source src' };
        }
        if (isImage) {
          const img = target.querySelector('img');
          if (img) {
            const fromImg = usable(img.src);
            if (fromImg) return { url: fromImg, via: 'img src' };
          }
        }
        return null;
      }, { idx, isImage });
    } catch (e) {
      return null;
    }
  }

  /**
   * v1.8.0 — CHECK-ONLY RECOVERY scan (ZDola logic): find the tile that
   * belongs to a prompt text in the CURRENT project grid, without
   * submitting anything. Scoring is the replica-tested tileIdentity
   * strong-match (containment metric); an exact tie between two tiles
   * returns null (ambiguous — never guess which video is whose).
   * Returns { tileIndex, fingerprint, url|null } or null.
   */
  async _scanGridForPrompt(promptText, isImage = false, opts = {}) {
    if (!this.page || this.page.isClosed()) return null;
    let tiles;
    try {
      tiles = await this.page.evaluate(() => {
        const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
        return containers.map((c, i) => ({
          tileIndex: i,
          aria: c.getAttribute('aria-label') || '',
          hasVideo: !!c.querySelector('video'),
          hasImg: !!c.querySelector('img')
        }));
      });
    } catch (e) {
      return null;
    }
    if (!tiles || tiles.length === 0) return null;

    const promptWords = tileIdentity.significantWords(promptText || '');

    if (promptWords.size > 0) {
      let best = null;
      let bestCount = 0;
      for (const t of tiles) {
        const score = tileIdentity.scoreTileForPrompt(promptWords, tileIdentity.significantWords(t.aria));
        if (!tileIdentity.isStrongMatch(score)) continue;
        if (!best || score.matched > best.score.matched) {
          best = { tileIndex: t.tileIndex, fingerprint: tileIdentity.tileFingerprint(t.aria, ''), score };
          bestCount = 1;
        } else if (score.matched === best.score.matched) {
          bestCount++;
        }
      }
      if (best && bestCount === 1) {
        const url = await this._extractTileMediaUrl(
          { lockedTileFingerprint: best.fingerprint }, best.tileIndex, isImage
        );
        return { tileIndex: best.tileIndex, fingerprint: best.fingerprint, url: url || null };
      }
      if (best) return null; // ambiguous scored tie — never guess
    }

    // v2.4.0: ORDER/TIMING FALLBACK (weak-text prompts only). The
    // caller opts in ONLY when this task is the account's single
    // in-flight submission and supplies the pre-submit snapshot +
    // claimed set. The first tile that is in NEITHER set is the new
    // tile this submission created — text match is impossible for a
    // weak prompt, so position/timing is the identity. Without the
    // opt-in (check-only recovery, multi-task windows) the scan stays
    // scored-only and returns null rather than guess.
    const fb = opts && opts.newTileFallback;
    if (fb && tileIdentity.isWeakTextPrompt(promptWords)) {
      const pre = fb.preExistingFingerprints || new Set();
      const claimed = fb.claimedFingerprints || new Set();
      for (const t of tiles) {
        const fp = tileIdentity.tileFingerprint(t.aria, '');
        if (!fp) continue;
        if (pre.has(fp) || claimed.has(fp)) continue;
        const url = await this._extractTileMediaUrl(
          { lockedTileFingerprint: fp }, t.tileIndex, isImage
        );
        return { tileIndex: t.tileIndex, fingerprint: fp, url: url || null, viaFallback: true };
      }
    }
    return null;
  }

  /**
   * v2.1.0: scroll the project grid's scrollable ancestor through its
   * full height and back, so Flow's virtualized grid MOUNTS tiles that
   * sit below the fold — the plain canvas read (and _scanGridForPrompt)
   * can only see mounted tiles, and a fresh render can sit unmounted
   * while its owner task looks "dropped". Best-effort: any failure just
   * leaves the grid where it was.
   */
  async _sweepGridScroll() {
    if (!this.page || this.page.isClosed()) return;
    try {
      await this.page.evaluate(async () => {
        const tile = document.querySelector('flow-grid-tile-container');
        let el = tile ? tile.parentElement : null;
        for (let i = 0; i < 8 && el; i++) {
          if (el.scrollHeight > el.clientHeight + 10) break;
          el = el.parentElement;
        }
        if (!el) return;
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        const steps = [0.33, 0.66, 1, 0.5, 0];
        for (const f of steps) {
          el.scrollTop = Math.round(max * f);
          await new Promise(r => setTimeout(r, 350));
        }
      });
    } catch (e) {}
  }

  /**
   * v2.1.0 — IN-RUN stall recovery for ONE submitted task: sweep the
   * grid (mount virtualized tiles), then run the same fingerprint scan
   * the boot-time check-only recovery uses. When the task's own tile is
   * found, bind it (locked fingerprint + claimed) so the monitor's
   * normal assignment/ready/download machinery takes over from the
   * next poll. A fingerprint that was already on the grid BEFORE this
   * task was submitted is never claimed — that tile belongs to an
   * older prompt, not to this paid render.
   * Returns true when this task's tile was found and bound.
   */
  async _recoveryScanForTask(task, isImageMode = false) {
    if (!task || !this.page || this.page.isClosed()) return false;
    await this._sweepGridScroll();
    let scan = null;
    try {
      // v2.4.0: a weak-text task ("make a video") can never pass the
      // scored scan. When it is the ONLY unfinished task in the
      // current monitor window, the scan may bind the one tile that
      // is neither in its pre-submit snapshot nor already claimed —
      // the same fenced rule as assignTiles Pass 3.
      const scanOpts = {};
      const window = Array.isArray(this._monitorTasks) ? this._monitorTasks : null;
      if (window) {
        const unfinished = window.filter(t => t && !t.downloaded && !t.completed);
        if (unfinished.length === 1 && unfinished[0] === task) {
          scanOpts.newTileFallback = {
            preExistingFingerprints: task._preExistingFp || new Set(task.preExistingFingerprints || []),
            claimedFingerprints: this.claimedTileFingerprints
          };
        }
      }
      scan = await this._scanGridForPrompt(task.promptText, isImageMode, scanOpts);
    } catch (e) {
      scan = null;
    }
    if (!scan) return false;
    const preExisting = task._preExistingFp || new Set(task.preExistingFingerprints || []);
    if (preExisting.has(scan.fingerprint)) return false;
    if (this.claimedTileFingerprints.has(scan.fingerprint) && task.lockedTileFingerprint !== scan.fingerprint) {
      return false; // another live task already owns this tile
    }
    task.lockedTileFingerprint = scan.fingerprint;
    if (typeof scan.tileIndex === 'number') task.tileIndex = scan.tileIndex;
    this.claimedTileFingerprints.add(scan.fingerprint);
    this.log(`[Prompt #${task.promptIndex + 1}] Recovery scan me is prompt ki tile project me mil gayi — ab usi tile ka render/download aage badhega.`, 'success');
    return true;
  }

  /**
   * v1.8.0 — reconcile ONE recovered task (its prompt may already have
   * been submitted before the app closed). The video is looked up in
   * the open project and downloaded through the SAME identity-strict
   * paths as live tasks; the prompt is NEVER re-submitted here.
   * Returns { found:false } | { found:true, downloaded:boolean }.
   */
  async reconcileRecoveredTask(task, downloadFolder, settings) {
    const isImage = !!(settings && settings.type === 'Image');
    const scan = await this._scanGridForPrompt(task.promptText, isImage);
    if (!scan) return { found: false };
    task.lockedTileFingerprint = scan.fingerprint;
    task.tileIndex = scan.tileIndex;
    if (scan.url) task.completedVideoUrl = scan.url;
    // v2.7.0: recovery bhi ab poori kai-ranneeti wali download se
    // hoti hai (backend pehle, phir stream/tile-src + native UI ke do roop) — tile par
    // URL na ho tab bhi native roop se file aa sakti hai. Prompt
    // yahan KABHI dobara submit nahi hota (check-only usool barkarar).
    let ok = false;
    try { ok = (await this.downloadTaskMedia(task, downloadFolder, settings, scan.tileIndex)).ok; } catch (e) {}
    if (!ok) {
      try { await this._returnToProjectGrid(); } catch (e) {}
    }
    return { found: true, downloaded: !!ok };
  }

  /**
   * v1.7.0: choose a save path that never silently overwrites a file
   * this engine did not itself save (e.g. a previous run's video with
   * the same scene001.mp4 name) — suffix _2, _3, … instead.
   */
  _pickFreeFilePath(downloadFolder, fileName) {
    const first = path.join(downloadFolder, fileName);
    if (!fs.existsSync(first) || this.savedThisSession.has(first)) return first;
    const ext = path.extname(fileName);
    const base = ext ? fileName.slice(0, -ext.length) : fileName;
    for (let n = 2; n < 1000; n++) {
      const alt = path.join(downloadFolder, `${base}_${n}${ext}`);
      if (!fs.existsSync(alt) || this.savedThisSession.has(alt)) return alt;
    }
    return first;
  }

  /**
   * v2.3.0: pick the actual save path for a computed file name. In
   * TAG naming mode the duplicate suffix is the deterministic `-2`,
   * `-3`… (engine/tagNaming.js); every other mode keeps the legacy
   * `_2` picker untouched.
   */
  _resolveSavePath(downloadFolder, fileName, settings) {
    if (settings && settings.namingPattern === 'tag') {
      return tagNaming.pickFreeTagPath(downloadFolder, fileName, (p) => fs.existsSync(p), this.savedThisSession);
    }
    return this._pickFreeFilePath(downloadFolder, fileName);
  }

  // File naming: strictly by prompt index (001-based), as in V2.
  _fileNameForTask(task, settings) {
    const isImageMode = (settings.type === 'Image');
    const fileExt = isImageMode ? 'png' : 'mp4';
    const indexNum = task.promptIndex + 1;
    const paddedIndex = String(indexNum).padStart(3, '0');
    const pattern = settings.namingPattern || 'scene';
    const prefix = sanitizeFilePart(settings.customNamingPrefix, 'scene');

    // v2.3.0 (default): the file is named by the prompt's TAG —
    // `#00-01` -> `00-01.mp4`, `scene3` -> `scene3.mp4`. A task
    // without a usable tag falls back to the scene pattern below.
    if (pattern === 'tag') {
      const fromTag = tagNaming.fileNameForTag(task && task.tag, fileExt);
      if (fromTag) return fromTag;
    }

    if (pattern === 'numeric') return `${paddedIndex}.${fileExt}`;
    if (pattern === 'clip') return `clip${paddedIndex}.${fileExt}`;
    if (pattern === 'shot') return `shot${paddedIndex}.${fileExt}`;
    if (pattern === 'video') return isImageMode ? `image${paddedIndex}.${fileExt}` : `video${paddedIndex}.${fileExt}`;
    if (pattern === 'custom') return `${prefix}${paddedIndex}.${fileExt}`;
    if (pattern === 'prompt') {
      const clean = (task.promptText || 'prompt').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
      return `${paddedIndex}_${clean}.${fileExt}`;
    }
    return `scene${paddedIndex}.${fileExt}`;
  }

  /**
   * AUDIT FIX #6 — identity gate. A URL may be used for a task ONLY when it
   * was extracted from that task's own claimed tile (task.completedVideoUrl)
   * and it is neither a pre-existing stream nor already consumed by another
   * task. There is deliberately NO "latest fresh URL" fallback.
   */
  _isTaskOwnUrl(task, url) {
    if (!url || typeof url !== 'string') return false;
    if (task.preExistingVideoUrls && task.preExistingVideoUrls.has(url)) return false;
    if (this.consumedVideoUrls && this.consumedVideoUrls.has(url)) return false;
    return true;
  }

  _markTaskUrlConsumed(task, url) {
    if (url) {
      if (!this.consumedVideoUrls) this.consumedVideoUrls = new Set();
      this.consumedVideoUrls.add(url);
    }
  }

  async _saveBufferForTask(task, downloadFolder, settings, buffer, sourceUrl) {
    if (!fs.existsSync(downloadFolder)) {
      fs.mkdirSync(downloadFolder, { recursive: true });
    }
    // v1.7.0: never silently overwrite a file this engine did not
    // itself save — a previous run's same-named video stays intact
    // and this save takes a suffixed name.
    const finalSavedFilePath = this._resolveSavePath(downloadFolder, this._fileNameForTask(task, settings), settings);
    const fileName = path.basename(finalSavedFilePath);
    task.fileName = fileName;
    task.filePath = finalSavedFilePath;

    const fd = fs.openSync(finalSavedFilePath, 'w');
    fs.writeSync(fd, buffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    // Validate the saved file is a real, probeable video (when ffprobe is
    // available). A corrupt payload must not count as a completion.
    const isImageMode = (settings.type === 'Image');
    if (!isImageMode) {
      const valid = await FFmpegService.verifyVideoFile(finalSavedFilePath, 20000);
      if (!valid) {
        try { fs.unlinkSync(finalSavedFilePath); } catch (e) {}
        this.log(`The saved file ${fileName} failed the video check — this download has been treated as failed.`, 'warn');
        return false;
      }
    }

    const sizeMb = (buffer.length / (1024 * 1024)).toFixed(2);
    this.log(`Video saved: ${fileName} (${sizeMb} MB).`, 'success');

    task.downloaded = true;
    task.completed = true;
    // v2.7.0: mediaSaved hi ASLI success ka nishan hai (fail hue task
    // bhi settled mark ke liye downloaded=true lete hain — ginati ke
    // liye wahi purani galti jhooti success line bana rahi thi).
    task.mediaSaved = true;
    this.savedThisSession.add(finalSavedFilePath);
    this._markTaskUrlConsumed(task, sourceUrl);
    if (sourceUrl && this.capturedVideoBuffers && this.capturedVideoBuffers.has(sourceUrl)) {
      this.capturedVideoBytes -= this.capturedVideoBuffers.get(sourceUrl).length;
      this.capturedVideoBuffers.delete(sourceUrl);
    }

    const result = {
      filePath: finalSavedFilePath,
      fileName,
      fileSizeMb: sizeMb + ' MB',
      videoUrl: sourceUrl || ''
    };
    task.result = result;
    this.onTaskCompleted(task, result);

    const elapsed = Math.round((Date.now() - task.startTime) / 1000) + 's';
    this.onVideoCompleted({
      id: task.videoId,
      prompt: task.promptText,
      accountName: this.currentAccount.name,
      videoUrl: `file:///${finalSavedFilePath.replace(/\\/g, '/')}`,
      filePath: finalSavedFilePath,
      downloadFolder: downloadFolder,
      timestamp: new Date().toLocaleTimeString(),
      quality: settings.quality || '360p',
      duration: settings.duration || '6s',
      aspectRatio: settings.aspectRatio || '9:16',
      elapsed: elapsed
    });

    return true;
  }

  /**
   * Download path A: the intercepted CDN stream / direct fetch — but ONLY
   * for the URL extracted from this task's own claimed tile.
   */
  async downloadFromCapturedStream(task, downloadFolder, settings) {
    const targetUrl = task.completedVideoUrl;
    if (!this._isTaskOwnUrl(task, targetUrl)) {
      // No identity-proven URL for this task. Never substitute another
      // task's stream (audit fix #6).
      // v2.7.0: v2.6.0 tak ye rasta yahin CHUP-CHAAP mar jata tha — koi
      // log line nahi. Owner ke burst run me chaaron download isiliye
      // "sirf native-menu koshish" jaise dikhe: stream wala rasta ya
      // to URL na milne par yahin ruk gaya, ya neeche fail hua — bina
      // kisi saboot ke. Ab har rukawat ki wajah log hoti hai.
      this.log(`[Prompt #${task.promptIndex + 1}] Direct stream download is not possible: ${!targetUrl
        ? 'no media URL was found on this task\'s tile at all'
        : 'the URL that was found was not proven to be this task\'s own (an old used one, or another tile\'s — stopped for safety)'}.`, 'warn');
      return false;
    }

    this.log(`[Prompt #${task.promptIndex + 1}] The direct download of the video is running — only from this prompt's own video stream…`, 'info');

    let savedBuffer = null;

    if (this.capturedVideoBuffers && this.capturedVideoBuffers.has(targetUrl)) {
      savedBuffer = this.capturedVideoBuffers.get(targetUrl);
    }

    // Blob URLs can only be materialized inside the page — and only from
    // this task's own tile, located by FINGERPRINT (v1.5.0; the old raw
    // index pointed at a neighbour's tile after any new submission).
    const blobTileIndex = (!savedBuffer && targetUrl.startsWith('blob:'))
      ? await this._resolveTileIndexByFingerprint(task.lockedTileFingerprint)
      : -1;
    if (!savedBuffer && targetUrl.startsWith('blob:') && blobTileIndex >= 0 && this.page && !this.page.isClosed()) {
      try {
        const base64 = await this.page.evaluate(async ({ idx }) => {
          const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
          const target = containers[idx];
          if (!target) return null;
          const vid = target.querySelector('video');
          const src = vid ? (vid.src || vid.currentSrc) : null;
          if (!src || !src.startsWith('blob:')) return null;
          try {
            const r = await fetch(src);
            const b = await r.blob();
            return await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = () => resolve(null);
              reader.readAsDataURL(b);
            });
          } catch (e) {
            return null;
          }
        }, { idx: blobTileIndex });
        if (base64 && base64.includes('base64,')) {
          savedBuffer = Buffer.from(base64.split('base64,')[1], 'base64');
        }
      } catch (e) {
        const t = plainError.translateError(e);
        this.log(`Video data nikalne me ek note: ${t.plain}.`, 'warn', { rawError: t.raw });
      }
    }

    const minSizeDl = (settings.type === 'Image') ? 5000 : 50000;
    if (!savedBuffer && targetUrl.startsWith('http')) {
      // v2.10.0: cookie ka scope theek karo. page.cookies() BINA url
      // diye sirf maujooda page (flow.google.com) ke scope ke cookies
      // deta hai — media host (googleusercontent.com) ke cookies usme
      // NAHI aate, aur signed FIFE link bina un cookies ke 403 de
      // sakta hai (owner ke v2.8.0 PC run me captured-stream theek
      // yahin mara: "URL apna tha, lekin file ka data nahi ban
      // paya"). Ab dono scopes ke cookies mila kar bhejte hain, aur
      // server ka HTTP status bhi log hota hai — khamoshi khatam.
      try {
        const jar = new Map();
        for (const scope of [null, targetUrl]) {
          try {
            const cs = scope ? await this.page.cookies(scope) : await this.page.cookies();
            for (const c of cs || []) jar.set(`${c.name}@${c.domain || ''}`, c);
          } catch (e) {}
        }
        const cookieHeader = [...jar.values()].map(c => `${c.name}=${c.value}`).join('; ');
        const resp = await fetch(targetUrl, {
          headers: {
            'Cookie': cookieHeader,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
            'Referer': 'https://flow.google.com/'
          },
          redirect: 'follow'
        });

        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          if (buf.length >= minSizeDl) {
            savedBuffer = buf;
          } else {
            this.log(`[Prompt #${task.promptIndex + 1}] Direct download: a response came from the server but the data was very small (${buf.length} bytes) — not treated as the actual video.`, 'warn');
          }
        } else {
          this.log(`[Prompt #${task.promptIndex + 1}] Direct download: the server refused (HTTP ${resp.status}) — now a fetch from inside the browser will be tried.`, 'warn');
        }
      } catch (e) {
        const t = plainError.translateError(e);
        this.log(`A problem came up fetching Prompt #${task.promptIndex + 1}'s video file: ${t.plain}.`, 'warn', { rawError: t.raw });
      }
    }

    if (!savedBuffer && targetUrl.startsWith('http') && this.page && !this.page.isClosed()) {
      // v2.10.0: IN-PAGE FETCH — wahi link ab browser ke ANDAR se
      // lao. Page ka apna cookie jar, apna connection, apna referer
      // — jo cheez Node wale haath ke fetch me kabhi pakki nahi mil
      // sakti. Blob wale raste ka hi usool, http link ke liye.
      try {
        const got = await this.page.evaluate(async (url) => {
          try {
            const r = await fetch(url, { credentials: 'include' });
            if (!r.ok) return { err: `HTTP ${r.status}` };
            const buf = await r.arrayBuffer();
            if (!buf || buf.byteLength === 0) return { err: 'server se khaali data aaya' };
            let bin = '';
            const bytes = new Uint8Array(buf);
            const CH = 0x8000;
            for (let i = 0; i < bytes.length; i += CH) {
              bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
            }
            return { b64: btoa(bin), size: buf.byteLength };
          } catch (e) {
            return { err: String(e && e.message || e) };
          }
        }, targetUrl);
        if (got && got.b64) {
          const buf = Buffer.from(got.b64, 'base64');
          if (buf.length >= minSizeDl) {
            savedBuffer = buf;
            this.log(`[Prompt #${task.promptIndex + 1}] Got the video data from the in-browser fetch (${(buf.length / 1024).toFixed(0)} KB).`, 'info');
          } else {
            this.log(`[Prompt #${task.promptIndex + 1}] The in-browser fetch also brought very small data (${buf.length} bytes).`, 'warn');
          }
        } else if (got && got.err) {
          this.log(`[Prompt #${task.promptIndex + 1}] The in-browser fetch also failed: ${got.err}.`, 'warn');
        }
      } catch (e) {
        const t = plainError.translateError(e);
        this.log(`[Prompt #${task.promptIndex + 1}] The in-browser fetch could not run: ${t.plain}.`, 'warn', { rawError: t.raw });
      }
    }

    if (savedBuffer && savedBuffer.length > 10000) {
      return await this._saveBufferForTask(task, downloadFolder, settings, savedBuffer, targetUrl);
    }

    // v2.7.0: yahan tak aane ka matlab hai URL apna tha lekin file ka
    // data nahi ban paya (buffer nahi mila / fetch fail / data bahut
    // chhota). Wajah saaf likho — khamoshi hi v2.6.0 ka bug thi.
    this.log(`[Prompt #${task.promptIndex + 1}] The file could not be made from the stream: the video data was not received (no response from the server, or the data was very small).`, 'warn');
    return false;
  }

  /**
   * v1.6.1: get the page back to the project GRID, verifiably. Clicking
   * a tile opens Flow's EDITOR (a routed view) — if the return fails,
   * the render monitor reads an empty canvas forever and every other
   * pending video stalls on the editor screen (the owner's photo:
   * two videos generated, one downloaded, app stuck in the editor).
   * Escalating routes: already-on-grid check → history back → the
   * editor's Done/Back button (matched by visible text as well as
   * aria) → direct navigation to the project URL (the /edit/… tail
   * dropped). Returns true only when grid tiles are actually present.
   */
  async _returnToProjectGrid() {
    if (!this.page || this.page.isClosed()) return false;
    const onGrid = async () => {
      try {
        // v2.10.0: sirf tile ginati kaafi nahi — editor ke andar ki
        // media strip bhi tile component use karti hai. Grid = tiles
        // hain AUR URL /edit/ par nahi hai.
        return await this.page.evaluate(() => !window.location.pathname.includes('/edit/')
          && document.querySelectorAll('flow-grid-tile-container').length > 0);
      } catch (e) { return false; }
    };
    if (await onGrid()) return true;

    try { await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }); } catch (e) {}
    await sleep(1200);
    if (await onGrid()) return true;

    try {
      await this.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const b = btns.find(x => {
          const t = (x.innerText || '').trim().toLowerCase();
          const a = (x.getAttribute('aria-label') || '').toLowerCase();
          return t === 'done' || a.includes('back') || a.includes('done');
        });
        if (b) b.click();
      });
    } catch (e) {}
    await sleep(1200);
    if (await onGrid()) return true;

    try {
      const m = this.page.url().match(/(https:\/\/flow\.google\.com\/project\/[^/]+)/);
      if (m) {
        await this.page.goto(m[1], { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(1500);
      }
    } catch (e) {}
    return await onGrid();
  }

  /**
   * v2.7.0 — NATIVE DOWNLOAD SUITE (Download path B, dobara likha hua).
   *
   * v2.6.0 ka pakka diagnosis (owner ka burst run, 2026-10-14): chaaron
   * renders 100% complete the, lekin chaaron download EK hi pattern se
   * mare — tile click → ~8s → "Download media button not found". Us
   * samay ka matcher sirf ye roop pehchanta tha: aria me 'download
   * media', aria bilkul 'download', text bilkul 'download', ya icon
   * text bilkul 'download'; poll bhi ~7.5s ka hi tha. Flow ka asal
   * button inme se kisi se na mile (aria 'Download video', sirf-icon
   * wala button, ya ⋮ menu ke andar chhupa Download) to rasta wahin
   * mar jata tha — aur us par captured-stream wala rasta pehle se hi
   * bina kisi log ke fail ho chuka hota tha (URL gate par khamosh
   * return), aur editor se grid par wapas aana bhi pakka nahi tha
   * (sirf Escape), jo stream raste ko aur maar deta tha.
   *
   * v2.7.0 me yahan TEEN roop the (hover icon / editor toolbar /
   * ⋮ menu). v2.8.0 — INSPECTION HISSA 2 (signed-in asal project se
   * VERIFIED) ne do ko kaat diya aur teesre ko pakka kiya:
   *   - Tile par HOVER par download button hota hi NAHI (sirf
   *     Favorite, Reuse prompt, More options) — hover roop HATA.
   *   - Tile ke ⋮ menu me download ka label EXACT "Download" hai.
   *   - "Download media" SIRF editor view ki TOP BAR me hai (tile
   *     click → editor khule, top bar load ho); editor ke ⋮ menu me
   *     download NAHI hai. Editor ka player <canvas> hai, <video>
   *     nahi — editor me DOM-src bekaar hai.
   * Ab native UI ke DO roop bache, har roop sirf task ki APNI bound
   * tile par (galat tile ka video kabhi nahi):
   *   A) ⋮ menu ka exact "Download",
   *   B) editor ki top bar ka "Download media" (~15s ka intezaar).
   * Aur ye dono ab sirf FALLBACK hain — pramukh rasta v2.8.0 ka
   * backend network capture hai (downloadTaskMedia ki tartib dekho).
   * Jo selector mile, wo log hota hai. File aate hi ruk jao.
   */

  /** CDP download folder taiyaar + maujooda files ka snapshot. */
  async _nativePrepareWatch(downloadFolder) {
    if (!fs.existsSync(downloadFolder)) {
      try { fs.mkdirSync(downloadFolder, { recursive: true }); } catch (e) {}
    }
    const nativeDownloadFolder = this.browserDownloadDir || downloadFolder;
    try {
      if (!this.cdpSession && this.page) {
        this.cdpSession = await this.page.target().createCDPSession();
      }
      if (this.cdpSession) {
        await this.cdpSession.send('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: nativeDownloadFolder
        });
      }
    } catch (e) {}
    // v1.7.0: watch ONLY this session's native download folder. The
    // shared download folder is written by stream saves (possibly from
    // ANOTHER worker on another account) — a file landing there during
    // this poll used to be grabbed and renamed as THIS task's video.
    const foldersToWatch = [nativeDownloadFolder];
    const existingFilesByFolder = new Map();
    for (const fld of foldersToWatch) {
      try { existingFilesByFolder.set(fld, new Set(fs.readdirSync(fld))); }
      catch (e) { existingFilesByFolder.set(fld, new Set()); }
    }
    return { nativeDownloadFolder, foldersToWatch, existingFilesByFolder };
  }

  /** Resolution wala menu aaye to uska sahi option click karo. */
  async _nativePickResolution() {
    let optCoords = { found: false };
    for (let r = 0; r < 6; r++) {
      optCoords = await this.page.evaluate(() => {
        const menuItems = Array.from(document.querySelectorAll('.cdk-overlay-pane button, [role="menuitem"], .mat-mdc-menu-panel button'));
        const origBtn = menuItems.find(b => {
          const t = (b.innerText || b.textContent || '').trim().toLowerCase();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          return t.includes('original') || t.includes('720p') || t.includes('1080p') || t.includes('360p') || aria.includes('original');
        });
        if (origBtn) {
          const rect = origBtn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: (origBtn.innerText || origBtn.textContent || '').trim() };
          }
        }
        return { found: false };
      });
      if (optCoords.found) break;
      await sleep(400);
    }
    if (optCoords.found) {
      this.log(`Selecting the resolution: "${optCoords.text}"…`, 'info');
      const clickedAt = Date.now();
      await this.page.mouse.click(optCoords.x, optCoords.y);
      return { found: true, clickedAt };
    }
    this.log('The resolution menu did not appear — the download may have started directly; waiting for the file…', 'warn');
    return { found: false, clickedAt: 0 };
  }

  /**
   * Ek download click ke baad file ka intezaar, phir jaanch + save +
   * completion (native raste ka aakhri hissa, ab dono roopon
   * ke liye saanjha). File is click se PEHLE ki nahi honi chahiye aur
   * 20KB se badi honi chahiye (v1.7.0 ke niyam barkarar).
   */
  async _nativeAwaitAndSave(task, prep, clickTime, timeoutMs, downloadFolder, settings) {
    const fileName = this._fileNameForTask(task, settings);
    let finalSavedFilePath = path.join(downloadFolder, fileName);
    task.fileName = fileName;
    task.filePath = finalSavedFilePath;

    let newlyDownloadedFile = null;
    const pollStart = Date.now();
    const timeout = Math.max(5000, Number(timeoutMs) || 90000);
    while (Date.now() - pollStart < timeout && !this.isStopping) {
      await sleep(1000);
      for (const fld of prep.foldersToWatch) {
        if (!fs.existsSync(fld)) continue;
        const currentFiles = fs.readdirSync(fld);
        const existing = prep.existingFilesByFolder.get(fld) || new Set();
        const newFiles = currentFiles.filter(f => !existing.has(f));
        const finished = newFiles.find(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp') && !f.endsWith('.htm') && (f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.png') || f.endsWith('.gif')));
        if (finished) {
          const fullPath = path.join(fld, finished);
          // v1.9.0: the file can vanish between readdir and stat
          // (browser cleanup, AV quarantine) — treat as "not ready".
          let stats = null;
          try { stats = fs.statSync(fullPath); } catch (e) { stats = null; }
          if (!stats) continue;
          // v1.7.0: the file must post-date THIS download click.
          if (stats.size > 20000 && stats.mtimeMs >= clickTime - 2000) {
            newlyDownloadedFile = fullPath;
            break;
          }
        }
      }
      if (newlyDownloadedFile) break;
    }

    // Return the viewer to the grid either way — VERIFIED (v1.6.1).
    // The old single Escape + aria-only button hunt could leave the
    // page sitting in Flow's editor, where the monitor sees no tiles
    // and every remaining video stalls.
    await this._returnToProjectGrid();

    if (!newlyDownloadedFile) return false;

    // v1.7.0: never overwrite a file this engine did not save itself
    // (e.g. a previous run's scene001.mp4) — take a suffixed name.
    const freePath = this._resolveSavePath(downloadFolder, fileName, settings);
    if (freePath !== finalSavedFilePath) {
      finalSavedFilePath = freePath;
      task.fileName = path.basename(freePath);
      task.filePath = freePath;
    }
    if (newlyDownloadedFile !== finalSavedFilePath) {
      try {
        fs.renameSync(newlyDownloadedFile, finalSavedFilePath);
      } catch (renErr) {
        fs.copyFileSync(newlyDownloadedFile, finalSavedFilePath);
        try { fs.unlinkSync(newlyDownloadedFile); } catch (e) {}
      }
    }

    // Validate before declaring completion.
    const isImageMode = (settings.type === 'Image');
    if (!isImageMode) {
      const valid = await FFmpegService.verifyVideoFile(finalSavedFilePath, 20000);
      if (!valid) {
        try { fs.unlinkSync(finalSavedFilePath); } catch (e) {}
        this.log(`The downloaded file ${task.fileName} failed the video check — this download has been treated as failed.`, 'warn');
        return false;
      }
    }

    const fileStats = fs.statSync(finalSavedFilePath);
    const sizeMb = (fileStats.size / (1024 * 1024)).toFixed(2);
    this.log(`Video saved: ${task.fileName} (${sizeMb} MB).`, 'success');

    task.downloaded = true;
    task.completed = true;
    task.mediaSaved = true;
    this.savedThisSession.add(finalSavedFilePath);

    const result = {
      filePath: finalSavedFilePath,
      fileName: task.fileName,
      fileSizeMb: sizeMb + ' MB',
      videoUrl: task.completedVideoUrl || ''
    };
    task.result = result;
    this.onTaskCompleted(task, result);

    const elapsed = Math.round((Date.now() - task.startTime) / 1000) + 's';
    this.onVideoCompleted({
      id: task.videoId,
      prompt: task.promptText,
      accountName: this.currentAccount.name,
      videoUrl: `file:///${finalSavedFilePath.replace(/\\/g, '/')}`,
      filePath: finalSavedFilePath,
      downloadFolder: downloadFolder,
      timestamp: new Date().toLocaleTimeString(),
      quality: settings.quality || '360p',
      duration: settings.duration || '6s',
      aspectRatio: settings.aspectRatio || '9:16',
      elapsed: elapsed
    });
    return true;
  }

  /**
   * Editor view ki TOP BAR me "Download media" wala control
   * dhoondho (inspection hissa 2, VERIFIED): "Download media" sirf
   * yahin hota hai — tile click ke baad editor (/project/<id>/edit/
   * <id>) khule aur top bar load ho, tab milta hai. Editor ke ⋮
   * menu me download NAHI hota, wahan talaash bekaar hai. Editor ka
   * player <canvas class="video-canvas"> hai, <video> nahi — isliye
   * editor me DOM se src nikalna bhi bekaar hai; ye roop sirf is
   * button ke liye hai. Overlay (menu) ke andar ke controls yahan
   * nahi ginne jate — wo menu wale roop ki jagah hai.
   */
  async _findEditorDownloadControl() {
    try {
      return await this.page.evaluate(() => {
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const all = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const b of all) {
          if (b.closest && b.closest('.cdk-overlay-pane')) continue;
          if (!visible(b)) continue;
          const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
          const t = (b.innerText || b.textContent || '').trim().toLowerCase();
          if (aria.includes('download media') || t.includes('download media')) {
            const r = b.getBoundingClientRect();
            return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, how: (aria || t) };
          }
        }
        return { found: false };
      });
    } catch (e) {
      return { found: false };
    }
  }

  /** Tile ke center ke coordinates (hover/click ke liye). */
  async _tileCenterCoords(tileIndex) {
    try {
      return await this.page.evaluate(({ idx }) => {
        const tiles = Array.from(document.querySelectorAll('flow-grid-tile-container'));
        const target = (typeof idx === 'number') ? tiles[idx] : null;
        if (!target) return { found: false };
        target.scrollIntoView({ behavior: 'instant', block: 'center' });
        const r = target.getBoundingClientRect();
        return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, text: (target.innerText || '').replace(/\n/g, ' ').substring(0, 40) };
      }, { idx: tileIndex });
    } catch (e) {
      return { found: false };
    }
  }

  /**
   * Roop B: tile click → editor view ki TOP BAR ka "Download media"
   * (inspection hissa 2). Tile par hover wala download roop v2.8.0
   * me HATA diya gaya: hover par sirf Favorite, Reuse prompt aur
   * More options (⋮) hote hain — download button hota hi nahi, wo
   * ranneeti kabhi kaam kar hi nahi sakti thi.
   */
  /**
   * v2.10.0: editor khula hai ya nahi — iska faisla URL se hota hai
   * (/edit/ wala rasta) ya "Download media" control ke milne se.
   * v2.8.0 wali grid-tile ginati is kaam ke liye galat thi: editor
   * ke andar ki media strip bhi wahi tile component use karti hai,
   * to editor khulne ke baad bhi "grid par hi raha" padh sakta tha
   * (owner ke v2.8.0 PC run me native-editor theek yahin mara).
   */
  async _inEditorView() {
    try {
      const u = this.page.url() || '';
      if (u.includes('/edit/')) return true;
    } catch (e) {}
    try {
      const ctl = await this._findEditorDownloadControl();
      if (ctl && ctl.found) return true;
    } catch (e) {}
    return false;
  }

  async _nativeEditorForm(task, prep, downloadFolder, settings, tileIndexHint, attempts) {
    const n = task.promptIndex + 1;
    // Editor pehle se khula hai kya? (kisi pichhli koshish se khul
    // gaya ho to tile dobara click karne ki zaroorat nahi.)
    if (!(await this._inEditorView())) {
      const idx = await this._resolveTileIndexForTask(task, tileIndexHint);
      const coords = idx >= 0 ? await this._tileCenterCoords(idx) : { found: false };
      if (!coords.found) {
        attempts.push({ strategy: 'native-editor', ok: false, note: 'not found on its tile grid at all, the editor could not even open' });
        return false;
      }
      this.log(`[Prompt #${n}] Opening its big view (editor) by clicking on its tile: "${coords.text || ''}"`, 'info');
      // Do koshish: pehla click kabhi tile ke upar wale hisse me
      // atak sakta hai — dusra click tabhi jab URL se pakka ho ki
      // editor abhi bhi nahi khula.
      let opened = false;
      for (let clickTry = 0; clickTry < 2 && !opened; clickTry++) {
        await this.page.mouse.click(coords.x, coords.y);
        await sleep(1500);
        opened = await this._inEditorView();
      }
      if (!opened) {
        attempts.push({ strategy: 'native-editor', ok: false, note: 'even after clicking the tile twice, the editor view did not open (the URL stayed on the grid)' });
        return false;
      }
    }
    // Editor ki top bar ke load hone ka sahi intezaar: "Download
    // media" ke liye ~15 second tak poll.
    let ctl = { found: false };
    for (let r = 0; r < 30; r++) {
      ctl = await this._findEditorDownloadControl();
      if (ctl.found) break;
      await sleep(500);
    }
    if (!ctl.found) {
      this.log(`[Prompt #${n}] Even after waiting 15 seconds, "Download media" was not found on the editor's top bar.`, 'warn');
      attempts.push({ strategy: 'native-editor', ok: false, note: '"Download media" was not found on the editor\'s top bar even after waiting 15s' });
      // v2.6.0 ki galti: yahan sirf Escape dabta tha aur page editor
      // me hi atka reh jata tha — baaki raste grid na hone ki wajah
      // se mar jate the. Ab grid par wapas jaana pakka hai.
      await this._returnToProjectGrid();
      return false;
    }
    this.log(`[Prompt #${n}] Found "Download media" on the editor's top bar (${ctl.how}) — clicking…`, 'info');
    const clickTime = Date.now();
    await this.page.mouse.click(ctl.x, ctl.y);
    const res = await this._nativePickResolution();
    const ok = await this._nativeAwaitAndSave(task, prep, res.clickedAt || clickTime, 90000, downloadFolder, settings);
    attempts.push({ strategy: 'native-editor', ok, note: ok ? `the file came from the editor's top bar "Download media" (${ctl.how})` : 'the editor\'s "Download media" was clicked, but no file arrived' });
    if (!ok) this.log(`[Prompt #${n}] No file came from the editor route — the next form will be tried.`, 'warn');
    return ok;
  }

  /** Roop C: ⋮ (more options) menu ke andar ka Download item. */
  async _nativeMenuForm(task, prep, downloadFolder, settings, tileIndexHint, attempts) {
    const n = task.promptIndex + 1;
    const findMoreControl = async (scopeIdx) => {
      try {
        return await this.page.evaluate(({ idx }) => {
          const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const isMore = (b) => {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            const icon = b.querySelector('mat-icon, [data-icon], svg');
            const iconTxt = icon ? (icon.textContent || '').trim().toLowerCase() : '';
            return aria.includes('more options') || aria.includes('more actions') || aria === 'more'
              || iconTxt === 'more_vert' || iconTxt === 'more_horiz';
          };
          let scope = document;
          if (typeof idx === 'number' && idx >= 0) {
            const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
            scope = containers[idx] || null;
            if (!scope) return { found: false };
          }
          const els = Array.from(scope.querySelectorAll('button, [role="button"]'));
          for (const b of els) {
            if (!visible(b)) continue;
            if (b.closest && b.closest('.cdk-overlay-pane')) continue;
            if (isMore(b)) {
              const r = b.getBoundingClientRect();
              return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
          }
          return { found: false };
        }, { idx: scopeIdx });
      } catch (e) {
        return { found: false };
      }
    };

    let more = { found: false };
    let onGrid = false;
    try { onGrid = await this.page.evaluate(() => document.querySelectorAll('flow-grid-tile-container').length > 0); } catch (e) {}
    if (onGrid) {
      const idx = await this._resolveTileIndexForTask(task, tileIndexHint);
      if (idx >= 0) {
        const coords = await this._tileCenterCoords(idx);
        if (coords.found) {
          await this.page.mouse.move(coords.x, coords.y);
          await sleep(900);
        }
        more = await findMoreControl(idx);
      }
    } else {
      // Editor khula hai — uske ⋮ button ko dhoondho (page scope).
      more = await findMoreControl(-1);
    }
    if (!more.found) {
      attempts.push({ strategy: 'native-menu', ok: false, note: 'the ⋮ (more options) button was not found at all' });
      return false;
    }
    this.log(`[Prompt #${n}] Opening the ⋮ (more options) menu — Download will be searched inside it…`, 'info');
    await this.page.mouse.click(more.x, more.y);
    await sleep(800);

    // Menu ke render hone ka intezaar (~10s poll): overlay ke andar
    // EXACT "Download" wala item (inspection hissa 2, VERIFIED —
    // tile ke ⋮ menu me download ka label sirf "Download" hai;
    // "Download media" wahan NAHI hota, wo sirf editor ki top bar
    // me hai). Isiliye yahan 'download' shamil-wala dhundhla match
    // nahi, exact label hi chalega.
    let item = { found: false };
    for (let r = 0; r < 20; r++) {
      try {
        item = await this.page.evaluate(() => {
          // v2.10.0: matcher SAAF karke pehchanta hai. v2.8.0 ka
          // exact 'download' wala match owner ke PC par mara —
          // asal Material menu item ke andar icon (mat-icon) ka
          // ligature text ("file_download" / "download") label ke
          // saath jud jata hai, to poora text kabhi sirf "download"
          // banta hi nahi. Ab: underscores saaf, har line alag
          // ummeedwaar, aur shabd-ke-taur par 'download' bhi chalega
          // (tile ke ⋮ menu me download wala item EK hi hota hai —
          // inspection se verified poori list).
          const norm = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
          const hasWord = (s, w) => (` ${s} `).includes(` ${w} `);
          const items = Array.from(document.querySelectorAll('.cdk-overlay-pane [role="menuitem"], .cdk-overlay-pane button, .mat-mdc-menu-panel [role="menuitem"], .mat-mdc-menu-panel button, [role="menu"] [role="menuitem"], [role="menu"] button'));
          for (const b of items) {
            const r = b.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) continue;
            const aria = norm(b.getAttribute('aria-label'));
            const raw = String(b.innerText || b.textContent || '');
            const lines = raw.split('\n').map(norm).filter(Boolean);
            const full = norm(raw);
            const iconTxt = norm((b.querySelector('mat-icon') || {}).textContent || '');
            const hit = aria === 'download'
              || lines.some(l => l === 'download')
              || full === 'download'
              || hasWord(full, 'download')
              || iconTxt === 'download' || iconTxt === 'file download';
            if (hit) {
              return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, how: (aria || full || 'download').substring(0, 60) };
            }
          }
          return { found: false };
        });
      } catch (e) { item = { found: false }; }
      if (item.found) break;
      await sleep(500);
    }
    if (!item.found) {
      this.log(`[Prompt #${n}] The ⋮ menu opened, but no Download item was found inside it.`, 'warn');
      attempts.push({ strategy: 'native-menu', ok: false, note: 'the menu opened but it had no Download item' });
      try { await this.page.keyboard.press('Escape'); } catch (e) {}
      await this._returnToProjectGrid();
      return false;
    }
    this.log(`[Prompt #${n}] Found the Download item inside the menu ("${item.how}") — clicking…`, 'info');
    const clickTime = Date.now();
    await this.page.mouse.click(item.x, item.y);
    const res = await this._nativePickResolution();
    const ok = await this._nativeAwaitAndSave(task, prep, res.clickedAt || clickTime, 90000, downloadFolder, settings);
    attempts.push({ strategy: 'native-menu', ok, note: ok ? 'the file came from the menu\'s Download item' : 'the menu\'s Download item was clicked, but no file arrived' });
    if (!ok) this.log(`[Prompt #${n}] No file came from the menu route either.`, 'warn');
    return ok;
  }

  /**
   * Native UI ke DO roop ek ke baad ek — pehla safal roop jeet
   * (inspection hissa 2, VERIFIED): pehle tile ke ⋮ menu ka exact
   * "Download" (grid se bahar jana hi nahi padta), phir editor ki
   * top bar ka "Download media". Hover wala roop v2.8.0 me gaya —
   * tile par hover karne se download button aata hi NAHI hai.
   */
  async _downloadViaNativeUi(task, downloadFolder, settings, tileIndexHint, attempts) {
    const prep = await this._nativePrepareWatch(downloadFolder);
    const forms = [
      () => this._nativeMenuForm(task, prep, downloadFolder, settings, tileIndexHint, attempts),
      () => this._nativeEditorForm(task, prep, downloadFolder, settings, tileIndexHint, attempts)
    ];
    for (const run of forms) {
      if (this.isStopping) return false;
      let ok = false;
      try { ok = await run(); } catch (e) {
        const t = plainError.translateError(e);
        this.log(`[Prompt #${task.promptIndex + 1}] A problem in one download form — ${t.plain}. The next form will be tried.`, 'warn', { rawError: t.raw });
      }
      if (ok) return true;
    }
    return false;
  }

  /**
   * Download path B (purana naam, ab andar se kai-roop wala):
   * reconcile jaise purane callers ke liye barkarar. Sirf is task ki
   * apni claimed tile par chalta hai; tile na mile to false — koi
   * newest-tile fallback NAHI hai (audit fix #6).
   */
  async downloadViaFlowNativeMenu(task, downloadFolder, settings, tileIndex) {
    const attempts = [];
    const ok = await this._downloadViaNativeUi(task, downloadFolder, settings, tileIndex, attempts);
    task.downloadAttempts = (task.downloadAttempts || []).concat(attempts);
    return ok;
  }

  /**
   * v2.8.0 — NETWORK CAPTURE ka binding yahan aata hai: kisi task ka
   * media link Flow ke backend (API) ke jawab se bandha. Task agar
   * pehle se register hai (monitor/download-retry chal raha hai) to
   * usi pal TURANT fetch shuru ho jata hai — render monitor ke tile
   * "ready" bolne ka intezaar hi nahi hota. Task abhi register nahi
   * hai (submit aur monitor ke beech ka pal) to link early-store me
   * rehta hai; registration par wahi uthaya jata hai.
   */
  _onBackendMediaBound(key, url, via) {
    if (!key || !url) return;
    const task = this._captureTasks.get(key);
    if (!task) {
      this._earlyBackend.set(key, { url, via });
      return;
    }
    if (task.backendVideoUrl === url) return;
    task.backendVideoUrl = url;
    task.backendUrlVia = via;
    // Agar is pal task ka download orchestrator pehle se chal raha
    // hai, to turant fetch NA chalao (do fetch ek saath ek hi file
    // par ja sakte hain) — link task par bandha reh gaya hai,
    // orchestrator ki backend ranneeti ya download-retry use uthayegi.
    if (task._downloadInProgress) return;
    if (task._backendCtx && !task.downloaded && !task.mediaSaved && !this.isStopping) {
      this._kickBackendFetch(task, task._backendCtx);
    }
  }

  /**
   * v2.8.0: monitor / download-retry kisi task ko backend ke liye
   * register karta hai (download folder + settings ke saath). Pehle
   * se bandha link ho to wahi uthaya jata hai aur fetch turant
   * shuru ho jata hai.
   */
  registerBackendTask(task, downloadFolder, settings) {
    if (!task) return;
    const key = task.captureKey || task.videoId || null;
    if (!key) return;
    task._backendCtx = { downloadFolder, settings };
    this._captureTasks.set(key, task);
    let bound = null;
    try { bound = this.netCapture.urlForKey(key); } catch (e) {}
    if (!bound && this._earlyBackend.has(key)) bound = this._earlyBackend.get(key);
    if (bound && bound.url && !task.downloaded && !task.mediaSaved) {
      task.backendVideoUrl = bound.url;
      task.backendUrlVia = bound.via;
      if (!this.isStopping) this._kickBackendFetch(task, task._backendCtx);
    }
  }

  /** Ek hi task ka backend fetch ek hi baar chalega — in-flight guard. */
  _kickBackendFetch(task, ctx) {
    if (task._backendFetchPromise) return task._backendFetchPromise;
    const p = this._fetchBackendAndSave(task, ctx).catch(() => false);
    task._backendFetchPromise = p;
    return p;
  }

  /**
   * v2.8.0: backend se bandha link seedha fetch karke save karo —
   * wahi authenticated tareeka jo stream download ka hai (page ke
   * session cookies ke saath Node fetch; file save par ffprobe
   * jaanch _saveBufferForTask ke andar hoti hai). FIFE links jaldi
   * expire hote hain, isliye pehli nakami par ek aur koshish.
   * Signed URL khud kabhi log NAHI hota — sirf host ka naam.
   */
  async _fetchBackendAndSave(task, ctx) {
    const url = task.backendVideoUrl;
    if (!url || !ctx) return false;
    const n = (task.promptIndex || 0) + 1;
    if (task.mediaSaved) return true;
    // Pehchan: ye link network capture se bandha hai — yahi is task
    // ka apna hone ka saboot hai (tile wale apna-URL gate se upar
    // ki hifazat: workflowId / currentSrc / kram ki bandish).
    task.completedVideoUrl = url;
    const viaShabd = task.backendUrlVia === 'workflow-id'
      ? 'bound by workflowId identification'
      : (task.backendUrlVia === 'currentSrc' ? 'confirmed from the tile\'s currentSrc' : 'bound by sequence order');
    this.log(`[Prompt #${n}] Got a direct link from the backend (${viaShabd}) — downloading, without any button…`, 'info');
    if (!task._backendNotified) {
      task._backendNotified = true;
      try { this.onBackendMedia(task, { via: task.backendUrlVia || 'workflow-id', host: networkCapture.hostOf(url) }); } catch (e) {}
    }
    let ok = false;
    try { ok = await this.downloadFromCapturedStream(task, ctx.downloadFolder, ctx.settings); } catch (e) { ok = false; }
    if (!ok && !task.mediaSaved && !this.isStopping) {
      await sleep(1500);
      try { ok = await this.downloadFromCapturedStream(task, ctx.downloadFolder, ctx.settings); } catch (e) { ok = false; }
    }
    if (!ok && !task.mediaSaved) {
      this.log(`[Prompt #${n}] The backend link had been found, but the file could not be made from it (the link may have expired). The remaining routes will be tried.`, 'warn');
    }
    return !!ok;
  }

  /**
   * v2.8.0: download ki PEHLI ranneeti — backend. Pehle se bandha
   * link ho (ya turant-fetch chal raha ho) to usi se file lao; na
   * ho to kuch mat karo (caller agle raaston par jayega). Network
   * par is poori run me koi video link dikha hi nahi ho to wo
   * khabar bhi (ek baar) saaf log hoti hai — khamoshi kabhi nahi.
   */
  async _tryBackendDownload(task, downloadFolder, settings, attempts) {
    const key = task.captureKey || task.videoId || null;
    const n = (task.promptIndex || 0) + 1;
    if (task.mediaSaved) return true;
    if (task._backendFetchPromise) {
      const ok = await task._backendFetchPromise;
      attempts.push({ strategy: 'backend-fetch', ok: !!ok, note: ok ? 'as soon as the backend link was found, the file was saved by an immediate fetch' : 'the backend link was found, but the immediate fetch could not save the file' });
      if (ok || task.mediaSaved) return true;
      // Turant fetch fail hua — ek baar phir, taze bandhan ke saath.
      task._backendFetchPromise = null;
    }
    let bound = task.backendVideoUrl ? { url: task.backendVideoUrl, via: task.backendUrlVia } : null;
    if (!bound && key) {
      try { bound = this.netCapture.urlForKey(key); } catch (e) { bound = null; }
      if (!bound && this._earlyBackend.has(key)) bound = this._earlyBackend.get(key);
    }
    if (bound && bound.url) {
      task.backendVideoUrl = bound.url;
      task.backendUrlVia = bound.via;
      if (key) this._captureTasks.set(key, task);
      task._backendCtx = { downloadFolder, settings };
      const ok = await this._kickBackendFetch(task, task._backendCtx);
      attempts.push({ strategy: 'backend-fetch', ok: !!ok, note: ok ? 'the link bound from the backend (network) was fetched directly and saved' : 'the backend link was found, but no file was made from the fetch (the link may have expired)' });
      return !!ok;
    }
    const seen = this.netCapture ? this.netCapture.stats.mediaUrlsSeen : 0;
    attempts.push({
      strategy: 'backend-fetch', ok: false,
      note: seen > 0
        ? 'no link was bound on the backend for this task (a total of ' + seen + ' video links were seen on the network, but not a single one identified as this prompt\'s)'
        : 'no video link was seen at all on the backend (network) in this run'
    });
    if (seen === 0 && !this._backendNoteLogged) {
      this._backendNoteLogged = true;
      // v2.10.0: khabar ke saath DIAGNOSTICS bhi — network par kul
      // kitne jawab aaye, unme API kitne, media jawab kitne, aur
      // kin hosts se. Agli baar ka log khud batayega ki sunne wala
      // (capture) zinda tha ya Flow ka data kisi band-na-hone-wale
      // streaming connection se aata hai.
      let diag = '';
      try {
        const snap = this.netCapture.statsSnapshot();
        diag = ` (Network check: ${snap.responsesSeen} responses came in total, API ${snap.apiResponses}, media responses ${snap.mediaResponsesSeen}; hosts: ${snap.topHosts || '—'})`;
      } catch (e) {}
      this.log(`[Prompt #${n}] No video link was seen on the backend — the UI routes are being tried.${diag}`, 'warn');
    }
    return false;
  }

  /**
   * DOWNLOAD ORCHESTRATOR (v2.8.0 ki tartib): ek task ke liye saari
   * ranneetiyan ek tartib me, har koshish ki saaf log line ke saath.
   * Pehli safal ranneeti par ruk jao. Saari fail hon to
   * { ok:false, attempts } lautta hai — caller (monitor) task ko
   * stage 'download' ke saath fail karta hai; Activity detail me har
   * ranneeti ka natija jata hai.
   *
   * Tartib (v2.8.0 — backend sabse pehle, UI sirf fallback):
   *   1. backend-fetch: network capture se workflowId ki pehchan se
   *      bandha link, seedha fetch (turant-fetch pehle hi chal raha
   *      ho to usi ka natija). Koi button/menu nahi.
   *   2. tile-src / captured-stream: tile ke apne <video>/<source>
   *      element ka src (src / currentSrc) — wahi URL network par
   *      bhi dekha gaya ho to wo backend ki pushti (currentSrc
   *      cross-match) ke saath 'backend-fetch' ginata hai.
   *   3. backend kram (order): kataar ke sabse aage wale task ko
   *      sabse pehle mila bin-bandha link (sirf yahi, download ke
   *      pal par).
   *   4. native UI ke DO roop (inspection hissa 2, VERIFIED):
   *      tile ke ⋮ menu ka exact "Download", phir editor ki top
   *      bar ka "Download media". (Hover par download button hota
   *      hi NAHI — wo ranneeti v2.8.0 me hata di gayi.)
   * Har ranneeti SIRF task ki apni pehchan par chalti hai — galat
   * task ka video kabhi nahi.
   */
  async downloadTaskMedia(task, downloadFolder, settings, tileIndexHint) {
    task._downloadInProgress = true;
    try {
      return await this._downloadTaskMediaInner(task, downloadFolder, settings, tileIndexHint);
    } finally {
      task._downloadInProgress = false;
    }
  }

  async _downloadTaskMediaInner(task, downloadFolder, settings, tileIndexHint) {
    const attempts = [];
    task.downloadAttempts = attempts;
    const n = task.promptIndex + 1;
    const isImage = !!(settings && settings.type === 'Image');
    const captureKey = task.captureKey || task.videoId || null;

    if (!fs.existsSync(downloadFolder)) {
      try { fs.mkdirSync(downloadFolder, { recursive: true }); } catch (e) {}
    }

    // --- Ranneeti 1 (v2.8.0): BACKEND — network se bandha link ---
    try {
      const okBackend = await this._tryBackendDownload(task, downloadFolder, settings, attempts);
      if (okBackend) return { ok: true, strategy: 'backend-fetch', attempts };
    } catch (e) {
      attempts.push({ strategy: 'backend-fetch', ok: false, note: 'a problem came up in the backend route — the remaining routes will be tried' });
    }
    if (task.mediaSaved) return { ok: true, strategy: 'backend-fetch', attempts };

    // --- Ranneeti 2: apni stream / tile ka src ---
    let url = (task.completedVideoUrl && task.completedVideoUrl !== task.backendVideoUrl && this._isTaskOwnUrl(task, task.completedVideoUrl))
      ? task.completedVideoUrl : null;
    let via = url ? 'stream found earlier' : null;
    if (!url) {
      const got = await this._extractTileMediaUrlDetailed(task, tileIndexHint, isImage);
      if (got && got.url) {
        if (this._isTaskOwnUrl(task, got.url)) {
          url = got.url;
          via = got.via;
        } else {
          attempts.push({ strategy: 'tile-src', ok: false, note: 'a URL was found on the tile but it was not proven to be this task\'s own (old, or another tile\'s) — stopped for safety' });
          this.log(`[Prompt #${n}] The URL found on the tile was not proven to be this task's own — it was NOT downloaded, for safety.`, 'warn');
        }
      }
    }
    if (url) {
      // v2.8.0 cross-match: tile par mila URL agar network capture
      // ne bhi dekha tha, to use is task se bandh do — pehchan dono
      // taraf se pakki (backend ki pushti), fetch backend ginata hai.
      let crossMatched = false;
      if (captureKey) {
        try {
          if (this.netCapture.hasSighting(url)) {
            crossMatched = !!this.netCapture.claimByCurrentSrc(captureKey, url, Date.now());
          }
        } catch (e) {}
      }
      task.completedVideoUrl = url;
      const fromBuffer = !!(this.capturedVideoBuffers && this.capturedVideoBuffers.has(url));
      const stratName = crossMatched ? 'backend-fetch' : (fromBuffer ? 'captured-stream' : 'tile-src');
      this.log(`[Prompt #${n}] Download strategy: ${crossMatched ? 'the tile\'s URL has been confirmed from the backend (network)' : (fromBuffer ? 'video stream captured in between' : `URL found from the tile's element (${via})`)} — downloading the file…`, 'info');
      let ok = false;
      try { ok = await this.downloadFromCapturedStream(task, downloadFolder, settings); } catch (e) { ok = false; }
      attempts.push({ strategy: stratName, ok, note: ok ? 'the file was saved by this route' : 'the URL was the task\'s own, but the file data could not be made' });
      if (ok) return { ok: true, strategy: stratName, attempts };
    } else {
      this.log(`[Prompt #${n}] No media URL of this task was found on the tile — direct stream download is not possible; now the remaining routes will be tried.`, 'warn');
      attempts.push({ strategy: 'tile-src', ok: false, note: 'no media URL was found on the tile' });
    }

    // --- Ranneeti 3 (v2.8.0): backend KRAM se bandhan ---
    if (captureKey) {
      let ord = null;
      try { ord = this.netCapture.claimByOrder(captureKey, Date.now()); } catch (e) { ord = null; }
      if (ord && ord.url) {
        task.backendVideoUrl = ord.url;
        task.backendUrlVia = 'order';
        this._captureTasks.set(captureKey, task);
        task._backendCtx = { downloadFolder, settings };
        const ok = await this._kickBackendFetch(task, task._backendCtx);
        attempts.push({ strategy: 'backend-fetch', ok: !!ok, note: ok ? 'the unbound link found on the backend was treated as this task\'s by sequence order and saved' : 'the backend link bound by sequence could not be fetched' });
        if (ok) return { ok: true, strategy: 'backend-fetch', attempts };
      }
    }

    // --- Ranneeti 4: native UI ke do roop (⋮ menu → editor) ---
    const okNative = await this._downloadViaNativeUi(task, downloadFolder, settings, tileIndexHint, attempts);
    if (okNative) {
      const won = attempts.filter(a => a.ok).pop();
      return { ok: true, strategy: won ? won.strategy : 'native', attempts };
    }
    return { ok: false, attempts };
  }

  /**
   * v2.7.0 — SIRF-DOWNLOAD DOBARA KOSHISH (download-retry): prompt
   * DOBARA submit NAHI hota, credits NAHI katte. Usi account ke khule
   * project me task ki tile dobara dhoondhi jati hai (pehle bandhi
   * hui pehchan/fingerprint se, phir poora grid scan karke) aur mil
   * jaye to download ki saari ranneetiyan sirf usi tile par chalti
   * hain. Lautta hai: { status:'downloaded' } |
   * { status:'tile-missing' } | { status:'download-failed', attempts }.
   */
  async retryDownloadForTask(task, downloadFolder, settings) {
    const isImage = !!(settings && settings.type === 'Image');
    const n = (task.promptIndex || 0) + 1;
    // v2.8.0: sabse pehle BACKEND — isi session me is task se bandha
    // link ho (ya kataar/kram se bandh sake) to bina grid khoje
    // seedha fetch. Register bhi yahi hota hai, taaki is pal ke baad
    // aane wala binding turant fetch chala sake.
    this.registerBackendTask(task, downloadFolder, settings);
    const backendAttempts = [];
    let backendOk = false;
    try { backendOk = await this._tryBackendDownload(task, downloadFolder, settings, backendAttempts); } catch (e) { backendOk = false; }
    if (backendOk || task.mediaSaved) {
      task.downloadAttempts = (task.downloadAttempts || []).concat(backendAttempts);
      return { status: 'downloaded', attempts: task.downloadAttempts };
    }
    try { await this._returnToProjectGrid(); } catch (e) {}

    let found = false;
    if (task.lockedTileFingerprint) {
      const idx = await this._resolveTileIndexByFingerprint(task.lockedTileFingerprint);
      if (idx >= 0) { task.tileIndex = idx; found = true; }
    }
    if (!found) {
      found = await this._recoveryScanForTask(task, isImage);
    }
    if (!found) {
      // Virtualized grid: sweep karke ek aur baar talaash.
      await this._sweepGridScroll();
      if (task.lockedTileFingerprint) {
        const idx = await this._resolveTileIndexByFingerprint(task.lockedTileFingerprint);
        if (idx >= 0) { task.tileIndex = idx; found = true; }
      }
      if (!found) found = await this._recoveryScanForTask(task, isImage);
    }
    if (!found) {
      this.log(`[Prompt #${n}] Download-retry: even after scanning the whole project, this prompt's tile was NOT found — the video does not seem to exist there.`, 'warn');
      return { status: 'tile-missing', attempts: backendAttempts.concat(task.downloadAttempts || []) };
    }
    this.log(`[Prompt #${n}] Download-retry: the tile was found in the project — now ONLY all the download strategies will run again (no new submit/charge).`, 'info');
    const dl = await this.downloadTaskMedia(task, downloadFolder, settings, task.tileIndex);
    return dl.ok
      ? { status: 'downloaded', attempts: backendAttempts.concat(dl.attempts) }
      : { status: 'download-failed', attempts: backendAttempts.concat(dl.attempts) };
  }

  /**
   * Monitor submitted tasks until each renders complete, then download.
   *
   * AUDIT FIX #6: a task may only CLAIM a tile whose text/aria matches the
   * task's own prompt (and which no other task has claimed). V2's fallbacks
   * ("any generating tile", "any ready tile after 20s") are removed: if a
   * task's tile cannot be identified, the task FAILS with a clear reason
   * instead of ever completing with another prompt's video.
   */
  async waitForAccountTasks(accountTasks, downloadFolder, settings, returnOnAnyComplete = false) {
    if (!accountTasks || accountTasks.length === 0) return;

    const isImageMode = (settings.type === 'Image');
    const pendingTasks = accountTasks.filter(t => !t.downloaded);
    if (pendingTasks.length === 0) return;

    // v2.4.0: remember the window — _recoveryScanForTask reads it to
    // decide whether a weak-text task is this account's ONLY
    // in-flight task (the order/timing fallback's fence).
    this._monitorTasks = accountTasks;

    // v2.8.0: BACKEND capture ke liye har task register karo — kisi
    // task ka link backend se bandhte hi turant fetch yahin se shuru
    // hoga (tile ke "ready" hone ka intezaar kiye bina).
    for (const t of pendingTasks) {
      try { this.registerBackendTask(t, downloadFolder, settings); } catch (e) {}
    }

    this.log(`[${this.currentAccount.name}] has ${pendingTasks.length} videos generating — watching the render progress…`, 'info');

    // v2.1.0: the base video wait went 360s -> 600s (owner's PC test:
    // Flow was simply slow; the old budget failed a paid render).
    const maxWaitSec = (isImageMode ? 120 : 600) + (pendingTasks.length * 60);
    let effectiveMaxWaitSec = maxWaitSec;
    let timeoutSweeps = 0; // final recovery sweeps already spent at the deadline
    const startMonitorTime = Date.now();
    // v2.1.0 stall recovery windows (engine/stallWatch.js decides; the
    // state lives on each task so it survives across the pool's
    // repeated monitor calls for the same window).
    const stallTimeoutSec = this.stallTimeoutSecOverride || (isImageMode ? 45 : 120);
    const recoveryWindowMs = (this.recoveryWindowSecOverride || (isImageMode ? 120 : 600)) * 1000;
    let lastReportedPercentage = {};
    // v1.5.0: when a task ends in failure, free its tile claim so a
    // sibling task is never starved by a dead binding.
    const releaseTileClaim = (task) => {
      if (task && task.lockedTileFingerprint && this.claimedTileFingerprints) {
        this.claimedTileFingerprints.delete(task.lockedTileFingerprint);
      }
    };
    // v1.1: monitor errors used to be swallowed by `catch { break; }`,
    // which turned any persistent page error into a silent infinite
    // "Running…" from the pool's point of view. Count consecutive errors;
    // a few are tolerated (page hiccups), then fail VISIBLY.
    let consecutiveMonitorErrors = 0;

    while (!this.isStopping) {
      const allSettled = accountTasks.every(t => t.downloaded || t.completed);
      if (allSettled) {
        // v2.7.0 (FIX 2): ye line ab SACH bolti hai — ginati sirf un
        // tasks ki hai jinki file asal me save hui (task.mediaSaved).
        // Pehle ye line tab bhi chhap jati thi jab SAare download fail
        // hue hon, kyunki fail hue task bhi settled mark ke liye
        // downloaded=true lete hain — owner ke burst run me ek bhi
        // file save nahi hui thi aur line ne "saare download bhi ho
        // gaye" keh diya tha.
        const savedCount = accountTasks.filter(t => t.mediaSaved).length;
        const failedTasks = accountTasks.filter(t => t.failed);
        if (failedTasks.length === 0 && savedCount === accountTasks.length) {
          this.log(`[${this.currentAccount.name}] ke saare ${accountTasks.length} video ban gaye aur download bhi ho gaye!`, 'success');
        } else {
          const stages = [...new Set(failedTasks.map(t => t.failureStage || 'generation'))].join(', ');
          this.log(`Work finished on [${this.currentAccount.name}]: out of ${accountTasks.length} prompts, ${savedCount} videos were downloaded, ${failedTasks.length} failed${failedTasks.length ? ` (stage: ${stages})` : ''} — the reasons for the failed ones are in the lines above.`, failedTasks.length ? 'warn' : 'success');
        }
        break;
      }

      if (returnOnAnyComplete && accountTasks.some(t => t.downloaded || t.completed)) {
        break;
      }

      if ((Date.now() - startMonitorTime) > effectiveMaxWaitSec * 1000) {
        // v2.1.0: the deadline is NOT an instant fail any more. First a
        // FINAL recovery sweep per unfinished task (scroll the grid so
        // virtualized tiles mount, then the fingerprint scan). If any
        // task's own tile turns up, the deadline extends by 3 minutes
        // and normal monitoring resumes — a paid render is only failed
        // when two full sweeps found nothing for it.
        let rescuedAny = false;
        if (timeoutSweeps < 2) {
          timeoutSweeps++;
          this.log(`[${this.currentAccount.name}] The render time has become long — before failing, scanning the whole project once properly (sweep ${timeoutSweeps}/2)…`, 'warn');
          for (const t of accountTasks) {
            if (t.downloaded || t.completed) continue;
            if (stallWatch.isInRecovery(t)) continue; // its own window governs it
            const found = await this._recoveryScanForTask(t, isImageMode);
            if (found) rescuedAny = true;
          }
        }
        if (rescuedAny) {
          effectiveMaxWaitSec = ((Date.now() - startMonitorTime) / 1000) + 180;
          this.log(`Some tiles were found in the scan — the wait has been extended by 3 more minutes for their download.`, 'info');
        } else {
          // Fail whatever is unfinished — EXCEPT a task still inside
          // its own stall-recovery window: its give-up moment (in the
          // per-task loop below) is what ends it, never this deadline.
          let stillRecovering = false;
          let failedAny = false;
          for (const t of accountTasks) {
            if (t.downloaded || t.completed) continue;
            if (stallWatch.isInRecovery(t)) { stillRecovering = true; continue; }
            failedAny = true;
            t.completed = true;
            t.downloaded = true;
            t.failed = true;
            releaseTileClaim(t);
            stallWatch.clearStall(t);
            this.onTaskFailed(t, 'Render timed out before this prompt\'s video could be identified and downloaded (in-project recovery search included)');
            this.onVideoCompleted({
              id: t.videoId,
              prompt: t.promptText,
              accountName: this.currentAccount.name,
              status: 'Failed (Render timeout)',
              filePath: null,
              error: 'Render timed out',
              type: settings.type,
              timestamp: new Date().toLocaleTimeString()
            });
          }
          if (failedAny) {
            this.log(`[${this.currentAccount.name}] The render wait is over — the incomplete work has been marked failed (nothing was found in the recovery scan either).`, 'warn');
          }
          if (stillRecovering) {
            effectiveMaxWaitSec = ((Date.now() - startMonitorTime) / 1000) + 30;
          } else {
            break;
          }
        }
      }

      await sleep(2000);

      if (!this.page || this.page.isClosed()) break;

      try {
        await this.dismissAnyBlockingOverlays();

        // v1.5.0: Flow virtualizes long grids — only mounted tiles are
        // readable. Park the grid scroll at the top (newest tiles live
        // there) before every read so fresh tiles are always in the DOM.
        try {
          await this.page.evaluate(() => {
            const tile = document.querySelector('flow-grid-tile-container');
            let el = tile ? tile.parentElement : null;
            for (let i = 0; i < 8 && el; i++) {
              if (el.scrollHeight > el.clientHeight + 10) { el.scrollTop = 0; break; }
              el = el.parentElement;
            }
          });
        } catch (e) {}

        const isCaptcha = await this.page.evaluate(() => {
          const bodyText = (document.body.innerText || '').toLowerCase();
          const url = window.location.href.toLowerCase();
          return url.includes('challenge') || url.includes('recaptcha') || bodyText.includes("verify it's you") || bodyText.includes('unusual traffic');
        });
        if (isCaptcha) {
          this.log('Google has shown a human verification (Captcha)! Solve it in the open Chrome window — generation will stay paused until then.', 'error', { isCaptcha: true });
        }

        const canvasState = await this.page.evaluate((refusalSources) => {
          // v2.9.0: failure ki pehchan failureEvidence ke pakke
          // refusal JUMLO se hi hogi (sources bahar se aate hain —
          // ek hi source of truth). Ye helper tile ke chrome text me
          // mile asal jumle ka chhota snippet lautata hai, warna null.
          const findRefusalSnippet = (scanText) => {
            const flat = String(scanText || '').replace(/\s/g, ' ');
            const low = flat.toLowerCase();
            for (const src of refusalSources) {
              const m = low.match(new RegExp(src, 'i'));
              if (!m) continue;
              let a = Math.max(0, m.index - 90);
              for (let i = m.index - 1; i >= a; i--) { if ('.!?\n'.includes(flat[i])) { a = i + 1; break; } }
              let b = Math.min(flat.length, m.index + m[0].length + 90);
              for (let i = m.index + m[0].length; i < b; i++) { if ('.!?'.includes(flat[i])) { b = i + 1; break; } }
              return flat.slice(a, b).replace(/\s+/g, ' ').trim();
            }
            return null;
          };
          // Icon-font ke ligature naam (movie_filter_auto, play_circle
          // jaisi snake_case tokens) content NAHI hain — scan se pehle
          // saaf, warna koi icon naam hi jhootha saboot ban sakta hai.
          const stripLigs = (t) => String(t || '').replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, ' ');
          const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
          if (containers.length > 0) {
            return containers.map((c, idx) => {
              const promptAria = (c.getAttribute('aria-label') || '').toLowerCase().trim();
              const rawText = (c.innerText || '').toLowerCase();
              // v1.5.0: failure phrases are scanned ONLY in the tile's
              // CHROME text — the tile text with its own prompt (the
              // aria) stripped out. A prompt that merely contains words
              // like "blocked" or "failed" must not mark its OWN tile
              // as failed (a real multi-prompt error source), and any
              // icon (play/download/etc.) must not count as an "error
              // icon" — only a mat-icon whose ligature name IS an
              // error/warning glyph counts.
              const text = promptAria ? rawText.split(promptAria).join(' ') : rawText;
              const pctMatch = text.match(/\b(\d{1,2})%/);
              const hasErrorIcon = Array.from(c.querySelectorAll('mat-icon, i'))
                .some(el => /^(error|warning|priority_high|report)$/.test((el.textContent || '').trim().toLowerCase()));
              // v2.9.0: fail ka saboot SIRF is tile ke chrome text se —
              // ligature-saaf scan text par pakka refusal jumla mile
              // tabhi 'safety' fail; akela 'safety'/'policy'/'violat'
              // shabd (jo pehle bare substring se trigger hota tha)
              // kabhi kaafi nahi. Error icon akela mile to tile fail
              // hai lekin wajah apusht — kind 'tile-error' (blanket
              // "Safety Filter" label NAHI, warna failover use
              // prompt-level bana kar retry hamesha ke liye band kar
              // deta tha).
              const scanText = stripLigs(text);
              const refusalSnippet = findRefusalSnippet(scanText);
              const isUnusualActivity = /\bunusual activity\b/.test(scanText) || /\bnot been charged\b/.test(scanText);
              const isSafetyFailed = !!refusalSnippet;
              const failureKind = refusalSnippet ? 'safety' : (isUnusualActivity ? 'unusual' : (hasErrorIcon ? 'tile-error' : null));
              const isFailed = isSafetyFailed || isUnusualActivity || hasErrorIcon;

              const isGenerating = !!pctMatch;
              const hasVideo = !!c.querySelector('video');
              const hasImg = !!c.querySelector('img');
              const hasResolutionBadge = text.includes('360p') || text.includes('720p') || text.includes('1080p') || text.includes('100%') || text.includes('2k') || text.includes('4k');
              const hasDuration = /\b0:0\d\b|\b\d+s\b/.test(text);
              const isReady = !isGenerating && !isFailed && (hasResolutionBadge || hasVideo || hasDuration || hasImg);

              return {
                tileIndex: idx,
                promptAria,
                text,
                percentage: pctMatch ? `${pctMatch[1]}%` : (isReady ? '100%' : null),
                isGenerating,
                isFailed,
                isSafetyFailed,
                failureKind,
                failureReason: refusalSnippet,
                isUnusualActivity,
                isReady
              };
            });
          }

          const hotbarBtns = Array.from(document.querySelectorAll('button[flowhotbarbutton][aria-label="More options"]'));
          return hotbarBtns.map((btn, idx) => {
            let cur = btn;
            for (let s = 0; s < 8; s++) {
              if (!cur.parentElement) break;
              cur = cur.parentElement;
              if (cur.className && typeof cur.className === 'string' && (cur.className.includes('card') || cur.className.includes('tile') || cur.className.includes('node') || cur.className.includes('virtual-item'))) {
                break;
              }
            }

            const cardAria = (cur.getAttribute('aria-label') || '').toLowerCase().trim();
            const rawCardText = (cur.innerText || '').toLowerCase();
            // v1.5.0: same chrome-text rule as the grid branch — the
            // card's own prompt text never counts as a failure signal.
            // v2.9.0: failure evidence yahan bhi wahi sakht usool —
            // ligature-saaf text par pakka refusal jumla hi 'safety'
            // fail hai; error icon akela 'tile-error'.
            const text = cardAria ? rawCardText.split(cardAria).join(' ') : rawCardText;
            const pctMatch = text.match(/\b(\d{1,2})%/);
            const hasErrorIcon = Array.from(cur.querySelectorAll('mat-icon, i'))
              .some(el => /^(error|warning|priority_high|report)$/.test((el.textContent || '').trim().toLowerCase()));
            const scanText = stripLigs(text);
            const refusalSnippet = findRefusalSnippet(scanText);
            const isUnusualActivity = /\bunusual activity\b/.test(scanText) || /\bnot been charged\b/.test(scanText);
            const isSafetyFailed = !!refusalSnippet;
            const failureKind = refusalSnippet ? 'safety' : (isUnusualActivity ? 'unusual' : (hasErrorIcon ? 'tile-error' : null));
            const isFailed = isSafetyFailed || isUnusualActivity || hasErrorIcon;
            const isGenerating = !!pctMatch;
            const hasResolutionBadge = text.includes('360p') || text.includes('720p') || text.includes('1080p') || text.includes('100%');
            return {
              tileIndex: idx,
              promptAria: (cur.getAttribute('aria-label') || '').toLowerCase().trim(),
              text,
              percentage: pctMatch ? `${pctMatch[1]}%` : (hasResolutionBadge ? '100%' : null),
              isGenerating,
              isFailed,
              isSafetyFailed,
              failureKind,
              failureReason: refusalSnippet,
              isUnusualActivity,
              isReady: !isGenerating && !isFailed && hasResolutionBadge
            };
          });
        }, failureEvidence.patternSources());

        // v1.6.1 self-heal: an empty canvas on an EDITOR page means a
        // download excursion never made it back to the grid. Go back
        // and re-read next poll instead of idling on the editor until
        // the render timeout (the owner's "stuck here" photo).
        if (canvasState.length === 0 && this.page.url().includes('/edit/')) {
          this.log('The page is stuck inside Flow\'s editor, not on the project\'s tile area (grid) — going back to the grid…', 'warn');
          await this._returnToProjectGrid();
          continue;
        }

        // v2.9.0 — MODAL SCAN KA DAYRA BADLA (yahi scan owner ke
        // 2026-10-15 wale jhoothe fail ki jad tha): pehle ye scan
        // page ke KISI BHI dialog ke POORE text par bare substring
        // ('policy'/'terms'/'safety') se trigger hota tha — aur
        // credit check khud account/credits wala [role="dialog"]
        // panel kholta hai, jiske footer me "Privacy Policy / Terms
        // of Service" hota hai. Nateeja: panel ka pehla 150-char kata
        // majmua "Google Safety Filter: …" ban kar har fresh task ko
        // maar deta tha. AB: (1) account/credits chrome hamesha
        // skip; (2) trigger sirf failureEvidence ka asal refusal
        // JUMLA; (3) wajah wahi jumle ka snippet — poora dialog kabhi
        // nahi; (4) neeche ye sirf EK task (sabse purana
        // not-yet-generating) ko fail karega, poori kataar ko nahi.
        const modalViolation = await this.page.evaluate(({ refusalSources, chromeMarkers }) => {
          const stripLigs = (t) => String(t || '').replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, ' ');
          const findRefusalSnippet = (raw) => {
            const flat = String(raw || '').replace(/\s/g, ' ');
            const low = flat.toLowerCase();
            for (const src of refusalSources) {
              const m = low.match(new RegExp(src, 'i'));
              if (!m) continue;
              let a = Math.max(0, m.index - 90);
              for (let i = m.index - 1; i >= a; i--) { if ('.!?\n'.includes(flat[i])) { a = i + 1; break; } }
              let b = Math.min(flat.length, m.index + m[0].length + 90);
              for (let i = m.index + m[0].length; i < b; i++) { if ('.!?'.includes(flat[i])) { b = i + 1; break; } }
              return flat.slice(a, b).replace(/\s+/g, ' ').trim();
            }
            return null;
          };
          const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], div[role="alertdialog"], mwc-dialog, div[role="alert"], [class*="snackbar"], mwc-snackbar'));
          for (const d of dialogs) {
            if (!(d.offsetWidth > 0 || d.offsetHeight > 0)) continue;
            const raw = d.innerText || '';
            const low = raw.toLowerCase();
            if (chromeMarkers.some(mk => low.includes(mk))) continue;
            if (d.closest && d.closest('flow-account-panel, [class*="account-panel"], [class*="profile-menu"]')) continue;
            const snippet = findRefusalSnippet(stripLigs(raw));
            if (!snippet) continue;
            const btn = Array.from(d.querySelectorAll('button, [role="button"]')).find(b => {
              const bTxt = (b.innerText || '').toLowerCase().trim();
              return bTxt.includes('got it') || bTxt.includes('dismiss') || bTxt === 'ok' || bTxt.includes('close');
            });
            if (btn) try { btn.click(); } catch (e) {}
            return snippet.substring(0, 150);
          }
          return null;
        }, { refusalSources: failureEvidence.patternSources(), chromeMarkers: failureEvidence.ACCOUNT_CHROME_MARKERS });

        // Ek refusal dialog = EK prompt ki wajah (submissions
        // tartib se hote hain). Sirf sabse purana aisa task jo abhi
        // generating dekha hi nahi gaya — wahi is poll ka shikaar
        // banta hai; baaki tasks apni tile ke saboot par jeete hain.
        const modalVictim = modalViolation
          ? (accountTasks.find(t => !t.completed && !t.failed && !t.downloaded && !t.wasObservedGenerating) || null)
          : null;

        // The full canvas read succeeded — reset the monitor error streak.
        consecutiveMonitorErrors = 0;

        // v1.5.0: identity assignment for this poll. Each tile gets a
        // fingerprint + significant-word set; assignTiles binds every
        // pending task to AT MOST one tile (and every tile to at most
        // one task) using locked fingerprints first and strict scored
        // claims second — see tileIdentity.js for the rules. This
        // replaces the old index-tracking + two-word guessing that
        // scrambled multi-prompt runs.
        const tileDescriptors = canvasState.map(t => ({
          ...t,
          fingerprint: tileIdentity.tileFingerprint(t.promptAria, t.text),
          words: tileIdentity.significantWords(`${t.promptAria} ${t.text}`)
        }));
        const taskViews = accountTasks.filter(t => !t.downloaded).map(t => {
          if (!t._promptWords) t._promptWords = tileIdentity.significantWords(t.promptText || '');
          if (!t._preExistingFp) t._preExistingFp = new Set(t.preExistingFingerprints || []);
          return {
            key: t.videoId,
            promptWords: t._promptWords,
            preExistingFingerprints: t._preExistingFp,
            lockedFingerprint: t.lockedTileFingerprint || null
          };
        });
        const tileAssignments = tileIdentity.assignTiles(taskViews, tileDescriptors, this.claimedTileFingerprints);

        if (modalViolation && modalVictim) {
          try { await this.page.keyboard.press('Escape'); } catch (e) {}
          try {
            await this.page.evaluate(() => {
              const clearBtn = document.querySelector('button.clear-button, button[aria-label="Clear prompt"]');
              if (clearBtn) { try { clearBtn.click(); } catch (e) {} }
              const el = document.querySelector('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror');
              if (el) { el.textContent = ''; }
            });
          } catch (e) {}
        }

        for (const task of accountTasks) {
          if (task.downloaded) continue;

          const elapsedSec = (Date.now() - task.startTime) / 1000;
          let bestTile = null;

          if (modalViolation && modalVictim && task === modalVictim) {
            task.completed = true;
            task.downloaded = true;
            task.failed = true;
            releaseTileClaim(task);
            this.onTaskFailed(task, `Google Safety Filter: ${modalViolation}`);
            this.log(`[Prompt #${task.promptIndex + 1}] A Google safety policy message came up: "${modalViolation}" — this prompt will not move ahead; the queue is moving on.`, 'warn');
            this.onVideoCompleted({
              id: task.videoId,
              prompt: task.promptText,
              accountName: this.currentAccount.name,
              status: `Policy Violation: ${modalViolation}`,
              filePath: null,
              error: modalViolation,
              type: settings.type,
              timestamp: new Date().toLocaleTimeString()
            });
            continue;
          }

          // v1.5.0: this task's tile for this poll comes ONLY from the
          // fingerprint assignment computed above — never from a
          // remembered DOM index (indices shift as new tiles arrive)
          // and never from a loose text guess.
          bestTile = tileAssignments.get(task.videoId) || null;
          if (bestTile && task.lockedTileFingerprint !== bestTile.fingerprint) {
            task.lockedTileFingerprint = bestTile.fingerprint;
            this.claimedTileFingerprints.add(bestTile.fingerprint);
          }

          // v2.4.0 — TILE STATE + HEARTBEAT (fixes 2 & 3: the owner's
          // 4-minute silence). Every poll, each unfinished task's tile
          // condition is CLASSIFIED (engine/tileState.js): generating /
          // failed / ready / absent. A state CHANGE is narrated at
          // once (and reported via onTaskHeartbeat so Activity gets
          // the story with its stage) — a Flow-side failure is seen
          // the poll it appears, never after the 10-minute window.
          // An UNCHANGED state still earns a heartbeat line every
          // heartbeatEveryMs (30s), so while a paid render is in
          // flight the log can never sit silent, and the owner can
          // always see how long it has been and what is being waited
          // for. Separately, ~60s of total absence triggers one early
          // recovery scan instead of waiting for the 120s stall mark.
          {
            const nowMs = Date.now();
            const stateNow = tileState.classifyTaskTile({
              tile: bestTile,
              anyGenerating: tileDescriptors.some(t => t.isGenerating)
            });
            const facts = {
              promptIndex: task.promptIndex,
              elapsedSec,
              percentage: bestTile ? bestTile.percentage : null
            };
            if (task._tileState !== stateNow) {
              const prevState = task._tileState;
              task._tileState = stateNow;
              task._lastHeartbeatAt = nowMs;
              if (stateNow !== 'absent' || prevState !== undefined) {
                this.log(tileState.describeState(stateNow, facts), stateNow === 'failed' ? 'warn' : 'info');
              }
              try {
                this.onTaskHeartbeat(task, {
                  state: stateNow,
                  elapsedSec: Math.round(elapsedSec),
                  percentage: facts.percentage,
                  accountName: this.currentAccount.name
                });
              } catch (e) {}
            } else if (nowMs - (task._lastHeartbeatAt || 0) >= this.heartbeatEveryMs) {
              task._lastHeartbeatAt = nowMs;
              this.log(tileState.describeState(stateNow, facts), 'info');
              try {
                this.onVideoProgress({ id: task.videoId, elapsedSec: Math.round(elapsedSec), state: stateNow });
              } catch (e) {}
            }
            if (stateNow === 'absent' && elapsedSec >= 60 && !task._absentWarned) {
              task._absentWarned = true;
              task._lastRecoveryScanAt = nowMs;
              await this._recoveryScanForTask(task, isImageMode);
            }
          }

          // v2.6.0 — RENDER PROGRESS WATCHDOG (engine/
          // renderProgressWatch.js). A third kind of stall the older
          // guards cannot see: the tile EXISTS and is 'generating',
          // but its percentage never moves (owner's PC, 2026-10-14:
          // both renders sat at 1% for 8+ minutes in Background
          // mode). The watchdog fires ONCE per frozen episode — a Log
          // line here, an Activity entry (stage 'render-stall') via
          // onRenderStall — naming the last percentage, how long it
          // has been frozen and the plain possible causes. It fails
          // nothing by itself: the monitor deadline + final recovery
          // sweeps further down remain what ends a truly dead render,
          // and this frozen time counts toward that same wait.
          {
            // stateNow lives inside the heartbeat block above, so the
            // state is classified again here (pure + cheap).
            const wdState = tileState.classifyTaskTile({
              tile: bestTile,
              anyGenerating: tileDescriptors.some(t => t.isGenerating)
            });
            const progAct = renderProgressWatch.observeProgress(task, {
              state: wdState,
              percentage: bestTile ? bestTile.percentage : null,
              tileText: bestTile ? bestTile.text : '',
              now: Date.now(),
              stallAfterMs: this.progressStallAfterMs
            });
            if (progAct.type === 'stalled') {
              const frozenFor = stallWatch.formatDuration(progAct.stuckForSec);
              const pctNote = progAct.lastPct
                ? `Last progress: ${progAct.lastPct} — no change since then.`
                : 'Flow has not shown any progress % yet.';
              const hintNote = progAct.queueHint ? ` ${progAct.queueHint}.` : '';
              this.log(`[Prompt #${task.promptIndex + 1}] ⚠ The render seems STUCK — progress has not moved at all for ${frozenFor}. ${pctNote}${hintNote} The task is NOT being failed yet: the total wait clock is running; if progress starts moving again, everything will move ahead as usual.`, 'warn');
              try {
                this.onRenderStall(task, {
                  accountName: this.currentAccount.name,
                  elapsedSec: Math.round(elapsedSec),
                  stuckForSec: progAct.stuckForSec,
                  lastPct: progAct.lastPct,
                  queueHint: progAct.queueHint,
                  background: !!this.headless
                });
              } catch (e) {}
            }
          }

          // v2.1.0 — STALL RECOVERY (replaces the old anti-stall hard
          // fail). A submitted render whose tile has not been identified
          // is NOT failed on the first stall sighting: its credits are
          // already charged, and on the owner's PC (2026-10-14) the
          // tile simply arrived late — the old guard failed the paid
          // render outright. stallWatch decides (its state lives on the
          // task, so it survives the pool's repeated monitor calls):
          // recovery start -> periodic grid sweeps + fingerprint scans
          // + progress logs -> recovered, or give-up only after the
          // whole recovery window passes with no tile.
          const anyActive = tileDescriptors.some(t => t.isGenerating);
          {
            const stallAct = stallWatch.observeStall(task, {
              stalled: !bestTile && !anyActive && elapsedSec > stallTimeoutSec && !task.wasObservedGenerating && !task.completed,
              hasTile: !!bestTile,
              now: Date.now(),
              recoveryWindowMs,
              progressEveryMs: 30000
            });
            if (stallAct.type === 'recovery-started') {
              this.log(`[Prompt #${task.promptIndex + 1}] This prompt's video has not appeared in Flow yet — but its credits have already been deducted, so it is NOT being failed. Searching for the tile in the project and waiting will continue (at most ~${Math.round(recoveryWindowMs / 60000)} minutes).`, 'warn');
              task._lastRecoveryScanAt = Date.now();
              await this._recoveryScanForTask(task, isImageMode);
              try {
                this.onTaskStalled(task, {
                  accountName: this.currentAccount.name,
                  recoveryWindowSec: Math.round(recoveryWindowMs / 1000),
                  stallAfterSec: Math.round(elapsedSec)
                });
              } catch (e) {}
            } else if (stallAct.type === 'recovery-progress') {
              if (stallAct.logDue) {
                this.log(`[Prompt #${task.promptIndex + 1}] The render wait is continuing — ${stallWatch.formatDuration(stallAct.recoveryForSec)} have passed, the tile has still not been found. The project is being scanned again; since credits were already deducted, the wait will be completed fully.`, 'info');
              }
              if (!task._lastRecoveryScanAt || Date.now() - task._lastRecoveryScanAt >= this.recoveryScanEveryMs) {
                task._lastRecoveryScanAt = Date.now();
                await this._recoveryScanForTask(task, isImageMode);
              }
            } else if (stallAct.type === 'recovered') {
              this.log(`[Prompt #${task.promptIndex + 1}] Tile found! The render is visible again (after a wait of ${stallWatch.formatDuration(stallAct.recoveryForSec)}) — its further progress will now be watched.`, 'success');
            } else if (stallAct.type === 'give-up') {
              this.log(`[Prompt #${task.promptIndex + 1}] Even after the full recovery attempt (${stallWatch.formatDuration(stallAct.recoveryForSec)}), this prompt's tile was not found in the Flow project — Flow may have dropped or rejected the render. The task is being marked failed.`, 'warn');
              task.completed = true;
              task.downloaded = true;
              task.failed = true;
              releaseTileClaim(task);
              stallWatch.clearStall(task);
              this.onTaskFailed(task, `Generation tile for this prompt could not be identified even after ${stallWatch.formatDuration(recoveryWindowMs / 1000)} of in-project recovery search (dropped or rejected by Flow)`);
              this.onVideoCompleted({
                id: task.videoId,
                prompt: task.promptText,
                accountName: this.currentAccount.name,
                status: 'Failed (Dropped by Flow)',
                filePath: null,
                error: 'Generation tile not created',
                type: settings.type,
                timestamp: new Date().toLocaleTimeString()
              });
              continue;
            }
          }

          if (bestTile) {
            this.claimedTileIndices.add(bestTile.tileIndex); // legacy bookkeeping only
            if (bestTile.isGenerating) {
              task.wasObservedGenerating = true;
            }

            if (bestTile.isFailed) {
              const isUnusual = bestTile.isUnusualActivity || (bestTile.text && bestTile.text.includes('unusual activity'));

              if (isUnusual && !task.unusualActivityRetried) {
                task.unusualActivityRetried = true;
                this.log(`[Prompt #${task.promptIndex + 1}] Google Flow gave an "unusual activity" message — waiting 8 seconds and trying the tile again…`, 'warn');
                await sleep(8000);

                // v1.7.0: locate by fingerprint-first resolver, and
                // NEVER fall back to "the first button on the tile" —
                // that mystery click could hit download/edit/menu and
                // corrupt the run (or worse). Only a clearly-labelled
                // retry/regenerate button may be clicked.
                const retryIdx = await this._resolveTileIndexForTask(task, bestTile.tileIndex);
                const retried = await this.page.evaluate(({ idx }) => {
                  const containers = Array.from(document.querySelectorAll('flow-grid-tile-container'));
                  const container = (typeof idx === 'number' && containers[idx]) ? containers[idx] : null;
                  if (!container) return false;
                  const btns = Array.from(container.querySelectorAll('button'));
                  const retryBtn = btns.find(b => {
                    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                    const txt = (b.innerText || '').toLowerCase();
                    return aria.includes('retry') || aria.includes('regenerate') || aria.includes('refresh') ||
                      txt.includes('refresh') || txt.includes('replay') || txt.includes('autorenew');
                  });
                  if (retryBtn) {
                    retryBtn.click();
                    return true;
                  }
                  return false;
                }, { idx: retryIdx });

                if (retried) {
                  this.log(`[Prompt #${task.promptIndex + 1}] Pressed the Retry button on the tile — now waiting for the render again…`, 'info');
                  await sleep(3000);
                  continue;
                }
              }

              task.completed = true;
              task.downloaded = true;
              task.failed = true;
              releaseTileClaim(task);
              // v2.9.0: wajah ka dayra tile tak bandha hai —
              //  · refusal jumla sabit hua (failureKind 'safety') to
              //    wajah wahi ASAL jumla hai (label ke saath, taaki
              //    failover use prompt-level pehchane);
              //  · sirf error icon mila (wajah apusht) to imaandaar
              //    wording — blanket "Google Safety / Policy Filter"
              //    NAHI, kyunki wo label is fail ko prompt-level bana
              //    kar dobara koshish hamesha ke liye band kar deta
              //    tha, jabke ye fail generation-level rehna chahiye.
              const failureReason = isUnusual
                ? 'Google Flow: Unusual Activity (Cooldown / Delay required)'
                : (bestTile.failureKind === 'safety' && bestTile.failureReason)
                  ? `Google Safety Filter: ${bestTile.failureReason}`
                  : 'Flow showed an error on the tile, but no clear reason sentence was found on the tile';
              if (isUnusual) task.status = 'Unusual Activity';

              this.onTaskFailed(task, failureReason);
              this.log(`[Prompt #${task.promptIndex + 1}] ${failureReason}. Advancing queue cleanly...`, 'warn');

              try {
                await this.page.keyboard.press('Escape');
                await this.page.evaluate(() => {
                  const btns = Array.from(document.querySelectorAll('button'));
                  const dismiss = btns.find(b => {
                    const t = (b.innerText || '').toLowerCase();
                    return t.includes('got it') || t.includes('dismiss') || t.includes('close') || t.includes('ok');
                  });
                  if (dismiss) dismiss.click();
                  const el = document.querySelector('div.prosemirror-editor div.ProseMirror, div.ProseMirror[contenteditable="true"], div.ProseMirror');
                  if (el) { el.textContent = ''; }
                });
              } catch (e) {}

              this.onVideoCompleted({
                id: task.videoId,
                prompt: task.promptText,
                accountName: this.currentAccount.name,
                status: failureReason,
                filePath: null,
                error: failureReason,
                type: settings.type,
                timestamp: new Date().toLocaleTimeString()
              });
              continue;
            }

            if (bestTile.percentage && bestTile.isGenerating) {
              if (lastReportedPercentage[task.videoId] !== bestTile.percentage) {
                lastReportedPercentage[task.videoId] = bestTile.percentage;
                // v2.7.0 (FIX 3): yahan ki purani "Video ban raha hai:
                // X%…" wali LOG line band kar di gayi hai — progress ki
                // EK hi awaaz rahegi (upar wali tileState narration /
                // heartbeat). Owner ke log me har % update DO lines me
                // aa raha tha. onVideoProgress (UI ke liye) barkarar hai.
                this.onVideoProgress({
                  id: task.videoId,
                  percentage: bestTile.percentage,
                  prompt: task.promptText,
                  accountName: this.currentAccount.name,
                  elapsedSec: elapsedSec
                });
              }
            }

            // True completion: percentage gone AND a video/badge is present,
            // and the task was observed generating or 25s+ elapsed.
            if (bestTile.isReady && (task.wasObservedGenerating || elapsedSec >= 25)) {
              task.completed = true;
              this.onVideoProgress({ id: task.videoId, percentage: '100%' });
              // v2.8.0: ho sakta hai backend wala turant fetch pehle
              // hi file save kar chuka ho (ya kar raha ho) — pehle
              // use settle hone do; file aa gayi ho to download ki
              // baaki ranneetiyan chalti hi nahi.
              if (task._backendFetchPromise && !task.mediaSaved) {
                try { await task._backendFetchPromise; } catch (e) {}
              }
              if (task.mediaSaved) {
                this.log(`[Prompt #${task.promptIndex + 1}] The video has already been downloaded from the backend — no need for the remaining download attempts.`, 'success');
                if (returnOnAnyComplete) return;
                continue;
              }
              this.log(`[Prompt #${task.promptIndex + 1}] The video has been generated (100%) on [${this.currentAccount.name}] — now it will be downloaded.`, 'success');

              // v2.8.0: download ab backend-first orchestrator hai
              // (downloadTaskMedia): sabse pehle network capture se
              // bandha backend link, phir task ki apni stream / tile
              // ka src, aakhir me Flow ke Download UI ke do roop
              // (⋮ menu ka "Download", editor ka "Download media") —
              // har koshish ki log line ke saath. (v1.7.0 ki
              // pehchan-hifazat barkarar: har ranneeti sirf is task
              // ki apni pehchan par.)
              let dl = { ok: false, attempts: [] };
              try {
                dl = await this.downloadTaskMedia(task, downloadFolder, settings, bestTile.tileIndex);
              } catch (dlErr) {
                const t = plainError.translateError(dlErr);
                this.log(`[Prompt #${task.promptIndex + 1}] A problem came up in the download attempt — ${t.plain}.`, 'warn', { rawError: t.raw });
              }

              if (!dl.ok && !task.downloaded) {
                task.downloaded = true;
                task.failed = true;
                // v2.7.0 (FIX 2): stage LAZMI hai — render pura hua
                // tha, sirf SAVE fail hua. Pool is stage ko dekh kar
                // task ko needs_check (sirf-download retry) banata
                // hai: prompt DOBARA submit NAHI hota, credits dobara
                // NAHI katte. (Pehle yahi fail failover/same-account
                // retry me ja kar charon prompts dobara fire kar deta
                // tha — owner ke credits do baar kate the.)
                task.failureStage = 'download';
                releaseTileClaim(task);
                this.onTaskFailed(task, 'Download failed: the video had been generated on Flow, but no download route could save its file — only the download will be retried; the prompt will NOT be submitted again');
                this.onVideoCompleted({
                  id: task.videoId,
                  prompt: task.promptText,
                  accountName: this.currentAccount.name,
                  status: 'Download failed',
                  filePath: null,
                  error: 'The video had been generated, but its file could not be saved — only the download will happen again.',
                  type: settings.type,
                  timestamp: new Date().toLocaleTimeString()
                });
              }

              if (task.downloaded || task.completed) {
                this.claimedTileIndices.add(bestTile.tileIndex);
              }

              if (returnOnAnyComplete && (task.downloaded || task.completed)) {
                return;
              }
            }
          }
        }
      } catch (e) {
        // v1.1: never swallow a monitor error silently. Tolerate up to 2
        // consecutive errors (the loop sleeps 2s at the top), then fail the
        // unfinished tasks with the concrete reason and stop monitoring —
        // the pool can then rotate/finish instead of hanging forever.
        consecutiveMonitorErrors++;
        if (consecutiveMonitorErrors < 3) {
          // v2.4.0: the raw JS error never stands alone in the log —
          // plain explanation visible, technical text in rawError
          // (Copy Log carries it for diagnosis).
          const t = plainError.translateError(e);
          this.log(`A small problem came up while watching the render — ${t.plain}. Watching again…`, 'warn', { rawError: t.raw });
          continue;
        }
        {
          const t = plainError.translateError(e);
          this.log(`Watching the render keeps failing — ${t.plain}. Marking the incomplete tasks as failed…`, 'error', { rawError: t.raw });
        }
        for (const t of accountTasks) {
          if (!t.downloaded && !t.completed) {
            t.completed = true;
            t.downloaded = true;
            t.failed = true;
            releaseTileClaim(t);
            this.onTaskFailed(t, `Render monitor error: ${e.message}`);
            this.onVideoCompleted({
              id: t.videoId,
              prompt: t.promptText,
              accountName: this.currentAccount.name,
              status: 'Failed (Monitor error)',
              filePath: null,
              error: `Render monitor error: ${e.message}`,
              type: settings.type,
              timestamp: new Date().toLocaleTimeString()
            });
          }
        }
        break;
      }
    }
  }
}

module.exports = { FlowAutomationEngine };
