'use strict';

/**
 * FlowStudio Lite — PROJECT RECOVERY (v2.48.70 + hotfix).
 *
 * MASLA: download kabhi banana project (grid page) se hone chahiye,
 * to usi project se hi recover hona chahiye.
 *
 * Usool:
 *   1. Task ne jo project URL record kiya hai, usi ko hoga recovery.
 *   2. Agar record nahi hai, to dbService.findProjectForTime se
 *      nearest-not-after project.
 *   3. Gallery ka date-time wala raasta sirf uske baad.
 *
 * YE FILE PURE LOGIC DETI HAI — koi page/puppeteer nahi chhota.
 * Engine flowAutomation.js me use hota hai.
 */

const dbService = require('./db');

/**
 * Project ka URL nikala.
 */
function projectIdOfUrl(url) {
  const m = String(url || '').match(/\/project\/([^/?#]+)/);
  return m ? m[1] : '';
}

/**
 * Gallery entry ka date-time parse karo.
 */
function parseGalleryDateTime(text, nowMs) {
  const t = String(text || '');
  const m = t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  const month = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 }[m[1].slice(0,3).toLowerCase()];
  if (month === undefined) return null;
  const now = new Date(Number(nowMs) || Date.now());
  let year = m[3] ? Number(m[3]) : now.getFullYear();
  let hh = Number(m[4]) % 24;
  const mm = Number(m[5]) % 60;
  if (m[6]) {
    const pm = m[6].toUpperCase() === 'PM';
    if (pm && hh < 12) hh += 12;
    if (!pm && hh === 12) hh = 0;
  }
  let dt = new Date(year, month, Number(m[2]), hh, mm).getTime();
  if (!Number.isFinite(dt)) return null;
  if (!m[3] && dt - now.getTime() > 31*24*3600*1000) {
    dt = new Date(year-1, month, Number(m[2]), hh, mm).getTime();
  }
  return dt;
}

/**
 * Gallery entries se best project select karo.
 */
function pickGalleryProject(links, targetMs, nowMs) {
  const list = Array.isArray(links) ? links : [];
  if (!list.length) return { index: -1, source: 'none' };
  const target = Number(targetMs) || 0;
  if (target > 0) {
    let best = -1;
    let bestDt = -Infinity;
    list.forEach((l, i) => {
      const dt = parseGalleryDateTime(l && l.text, nowMs);
      if (dt === null) return;
      if (dt <= target + 59999 && dt > bestDt) { bestDt = dt; best = i; }
    });
    if (best >= 0) return { index: best, source: 'datetime' };
  }
  return { index: 0, source: 'first' };
}

/**
 * Recovery ka faisla.
 */
function recoveryEntryPlan(recordedUrl, registryRow, targetMs) {
  const rec = String(recordedUrl || '').trim();
  if (rec) return { kind: 'recorded', projectUrl: rec, source: 'recorded' };
  const regUrl = registryRow
    ? String(registryRow.projectUrl || registryRow.project_url || '').trim()
    : '';
  if (regUrl) return { kind: 'registry', projectUrl: regUrl, source: 'registry' };
  if (targetMs !== undefined && !(Number(targetMs) > 0)) {
    return { kind: 'unmapped', projectUrl: '', source: null };
  }
  return { kind: 'gallery', projectUrl: '', source: null };
}

/**
 * Same-project recovery: hi project me task mila hai to usi me
 * download continue karo, kisi naya project na kholo.
 */
async function recoverProject(task, downloadFolder, settings) {
  const key = task.taskId || task.videoId || null;
  if (!key) return { found: false, reason: 'no-key' };

  // 1. Task par RECORDED project_url ho
  const recorded = task.projectUrl || (task._projectUrl || null);
  const plan = recoveryEntryPlan(recorded, null, null);
  let targetUrl = plan.projectUrl;

  // 2. Registry check
  if (!targetUrl) {
    try {
      const registryRow = await dbService.findProjectForTime(key, task.promptIndex || 0);
      if (registryRow) {
        targetUrl = String(registryRow.projectUrl || registryRow.project_url || '');
      }
    } catch (e) {}
  }

  // 3. Target URL ho to wahi project kan use karo
  if (targetUrl) {
    try {
      // Validate URL shape (minimal)
      const u = new URL(targetUrl);
      if (u.hostname && u.pathname) {
        return { found: true, url: targetUrl, source: plan.source || 'named' };
      }
    } catch (e) {}
  }

  // 4. Gallery wala raasta (fallback)
  return { found: false, reason: 'no-project', plan: plan.kind };
}

module.exports = {
  projectIdOfUrl,
  parseGalleryDateTime,
  pickGalleryProject,
  recoveryEntryPlan,
  recoverProject
};
