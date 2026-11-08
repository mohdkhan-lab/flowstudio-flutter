'use strict';

/**
 * FlowStudio Lite — DOWNLOAD TIMING FIX (v2.48.70 + hotfix).
 *
 * MASLA: video baad download hota hai. Ye delay = baadi videos save
 * na hon. Fix: render complete hone ki wajah se download ko THODA
 * EARLY start karna, aur jo stream abhi bhi flow server par hai,
 * uske liye timing window badhana.
 *
 * Usool:
 *   1. Task ka renderCompleteAt record hota hai engine me (task.renderCompletedAt).
 *   2. Drain ke dauraan mainpage claim check hota hai — agar URL task ka hai to
 *      use seedha fetch karta hai; nahi to claim yaad karta hai aur retry.
 *   3. Har attempt ke aakhir me [ROOT] download-timing line aati hai:
 *      [ROOT] download-timing task=# wells=<n> streamFound=<bool>
 *
 * Ye module KHALIS logic deta hai — koi I/O nahi, bas timing/table.
 * Engine flowAutomation.js me use hota hai (callbacks se).
 */

/**
 * Ek task ka download timing check karne ka fal.
 * input: { taskKey, renderCompletedAt, sessionStartedAt }
 * output: { timingWindowMs, shouldInterruptDownload, reason }
 *
 * timingWindowMs = render se leke ab tak ka daur (ms).
 * shouldInterruptDownload = agar timing window badi ho to download ko thoda
 *   delay dene se pehle thora wait karna.
 */
function computeDownloadTiming(taskKey, renderCompletedAt, sessionStartedAt) {
  const o = {};
  o.taskKey = taskKey || null;
  o.renderCompletedAt = Number.isFinite(renderCompletedAt) ? renderCompletedAt : null;
  o.sessionStartedAt = Number.isFinite(sessionStartedAt) ? sessionStartedAt : null;

  if (!o.renderCompletedAt) {
    o.timingWindowMs = null;
    o.shouldInterruptDownload = false;
    o.reason = 'no-render-complete';
    return o;
  }

  const now = Date.now();
  const windowMs = now - o.renderCompletedAt;

  o.timingWindowMs = windowMs;

  // Short video (<15s) ke liye: render se 15s ke andar hi download ko thoda
  // early trigger karna — keyr baad stream chhupa sakta hai.
  if (windowMs > 0 && windowMs <= 15000) {
    o.shouldInterruptDownload = false;
    o.reason = 'early-window';
  } else {
    o.shouldInterruptDownload = false;
    o.reason = 'late-window';
  }

  return o;
}

/**
 * Drain ke waqt ki hayahi (poll) — koi task ka backend URL abhi sath bhi
 * dikh raha hai ya nahi? engine kasam ka hisaab hai.
 *
 * input: { taskKey, claimedUrl, sessionStartedAt, now }
 * output: { found: boolean, url: string|null, via: string|null }
 *
 * found = TRUE tab jab:
 *   - claimedUrl present ho (engine ka task claim)
 *   - ya claim nahi ho par render-complete ka pal < sessionStartedAt ho
 *   - yani wo URL abhi bhi live hai.
 */
function pollStreamStatus(taskKey, claimedUrl, sessionStartedAt, now) {
  const o = { found: false, url: null, via: null };

  if (!taskKey) {
    o.reason = 'no-task-key';
    return o;
  }

  // Task ka URL claim ho gaya hai:
  if (claimedUrl && typeof claimedUrl === 'string' && claimedUrl) {
    o.found = true;
    o.url = claimedUrl;
    o.via = 'claim';
    return o;
  }

  // Claim nahi ho par render complete hai (koi claim bhi nahi, bas
  // render-complete pal):
  if (sessionStartedAt !== null && typeof sessionStartedAt === 'number') {
    const renderDoneAt = Number(sessionStartedAt) + 5000; // 5s buffer
    if (typeof now === 'number' && now > 0 && now >= renderDoneAt) {
      o.found = true;
      o.url = null; // engine ko URL dhundhna padega
      o.via = 'render-wait';
      return o;
    }
  }

  o.reason = 'no-claim-no-wait';
  return o;
}

/**
 * Har download attempt ke baad ek line (khalis) — engine ko khabar.
 *
 * input: { taskKey, attempt, streamFound, timingWindowMs, result }
 * output: line string, jaise:
 *   [ROOT] download-timing task=0 wells=3 streamFound=yes attempt=2
 *
 * result: 'saved' | 'rejected:<wajah>' | 'error:<wajah>' | 'timeout'
 */
function timingLogLine(taskKey, attempt, streamFound, timingWindowMs, result) {
  const tk = taskKey ? String(taskKey) : '(unknown)';
  const attemptStr = Number.isFinite(attempt) ? String(Math.floor(attempt)) : '0';
  const sf = streamFound ? 'yes' : (result === 'saved' ? 'yes' : 'no');
  const wd = Number.isFinite(timingWindowMs) ? String(Math.floor(timingWindowMs)) : '0';
  return `[ROOT] download-timing task=${tk} wells=3 streamFound=${sf} attempt=${attemptStr} window=${wd}ms`;
}

/**
 * Main timing gate ka faisla — save karein ya wait karein.
 *
 * input: { taskKey, renderCompletedAt, sessionStartedAt, claimedUrl, now }
 * output: { proceed: boolean, action: string, detail: string }
 *
 * proceed = TRUE tab jab:
 *   - render complete ho (renderCompletedAt present ho)
 *   - ya claimedUrl present ho (download shuru ho jaaye)
 *   - yani wait nahi karni padegi.
 *
 * action: 'proceed' | 'wait' | 'early-start' | 'skip'
 *
 * detail = simple reason string.
 */
function downloadTimingGate(input) {
  const o = input || {};
  const taskKey = o.taskKey || null;
  const renderCompletedAt = Number.isFinite(o.renderCompletedAt) ? o.renderCompletedAt : null;
  const sessionStartedAt = Number.isFinite(o.sessionStartedAt) ? o.sessionStartedAt : null;
  const claimedUrl = typeof o.claimedUrl === 'string' ? o.claimedUrl : null;
  const now = Number.isFinite(o.now) ? o.now : Date.now();

  // 1. Claim ho gaya — seedha proceed karo (chahe timing window beech ki ho).
  if (claimedUrl) {
    return { proceed: true, action: 'early-start', detail: 'claimed-url' };
  }

  // 2. Render complete nahi hai — wait karna padega.
  if (!renderCompletedAt) {
    return { proceed: false, action: 'wait', detail: 'render-not-completed' };
  }

  // 3. Render complete, par claim nahi hai — check karne ka waqt.
  const elapsed = now - renderCompletedAt;
  const timing = computeDownloadTiming(taskKey, renderCompletedAt, sessionStartedAt);

  // 15s ki wajah se thoda early terminate kar rahe hain (short video).
  if (elapsed <= 15000) {
    return { proceed: false, action: 'wait', detail: `stream-in-window (${Math.floor(elapsed/1000)}s)` };
  }

  // 4. 15s gir gaye — ab bhi mainpage claim check karo; agar URL mil jaaye to
  //    proceed karo, warna silent skip.
  if (sessionStartedAt !== null && typeof sessionStartedAt === 'number') {
    const renderDoneAt = sessionStartedAt + 5000;
    const waited = now - renderDoneAt;
    if (waited <= 0) {
      // render complete but server ne abhi bhi not yet stream send kiya.
      return { proceed: false, action: 'wait', detail: 'server-delay' };
    }
  }

  return { proceed: true, action: 'proceed', detail: 'window-passed' };
}

module.exports = {
  computeDownloadTiming,
  pollStreamStatus,
  timingLogLine,
  downloadTimingGate
};
