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
 *      usi run ki entry wala project (.116 R3: queue-ghadi
 *      aur entry-ghadi ek ki gayi hain).
 *   3. Gallery ka date-time wala raasta sirf uske baad.
 *   4. v2.48.116 (R4): planned project me tile na mile to
 *      usi account ke usi DIN ke doosre registry projects
 *      bhi bari bari parkhe jate hain (sweep) — purani
 *      galat likhai ab dead end nahi rehti.
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
 * v2.48.116 (R4 — RECOVERY SWEEP): ek parked task ka
 * tile us ke planned project me na mile to account ke
 * DOOSRE registry projects me talash ki tartib —
 * KHALIS faisla, koi DB/page nahi chhoota.
 *   - sirf wahi projects jo task ke QUEUE wale DIN
 *     (local calendar day) registry me pehli baar
 *     dekhe gaye — purane dinon ki kitab is talash se
 *     bahar hai;
 *   - planned project khud shamil NAHI (wo pehle hi
 *     parkha ja chuka hai);
 *   - tartib: sab se NAYI entry pehle (newest first);
 *   - had: zyada se zyada RECOVERY_SWEEP_MAX_PROJECTS
 *     (4) — bulane wale ka cap is se aage nahi badh
 *     sakta.
 * Rows dbService ki mapped shakal (projectUrl /
 * firstSeenAt) me bhi aa sakte hain aur kachi DB
 * shakal (project_url / first_seen_at) me bhi.
 */
const RECOVERY_SWEEP_MAX_PROJECTS = 4;

function recoverySweepCandidates(registryRows, excludeUrl, targetMs, cap) {
  const t = Number(targetMs) || 0;
  if (!(t > 0)) return [];
  const day = new Date(t);
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEnd = dayStart + 24 * 3600 * 1000;
  const excluded = String(excludeUrl || '').trim();
  let limit = Math.floor(Number(cap)) || RECOVERY_SWEEP_MAX_PROJECTS;
  if (limit > RECOVERY_SWEEP_MAX_PROJECTS) limit = RECOVERY_SWEEP_MAX_PROJECTS;
  if (limit < 0) limit = 0;
  const seen = new Set();
  const picked = [];
  for (const r of (Array.isArray(registryRows) ? registryRows : [])) {
    if (!r) continue;
    const url = String(r.projectUrl || r.project_url || '').trim();
    const seenAt = Number(r.firstSeenAt !== undefined ? r.firstSeenAt : r.first_seen_at) || 0;
    if (!url || url === excluded || seen.has(url)) continue;
    if (!(seenAt >= dayStart && seenAt < dayEnd)) continue;
    seen.add(url);
    picked.push({
      projectUrl: url,
      projectId: String(r.projectId || r.project_id || projectIdOfUrl(url) || ''),
      firstSeenAt: seenAt,
      id: Number(r.id) || 0
    });
  }
  picked.sort((a, b) => (b.firstSeenAt - a.firstSeenAt) || (b.id - a.id));
  return picked.slice(0, limit);
}

/**
 * v2.48.116 (R4): sweep ki har koshish ka [ROOT] saboot
 * — kaunsi task, kaunsa project parkha gaya, tile mila
 * ya nahi. Project hamesha us ke id se naam leta hai.
 */
function recoverySweepLogLine(promptIndex, projectUrl, found) {
  const id = projectIdOfUrl(projectUrl) || String(projectUrl || '');
  return `[ROOT] recovery-sweep task=${promptIndex} project=${id} found=${found ? 'yes' : 'no'}`;
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

/**
 * v2.48.74 (Item C REVISED — owner): Progress panel
 * ke Parked downloads section ke Start button ka
 * chunav — KHALIS faisla. taskId diya ho to SIRF
 * wahi ek parked row (Start = sirf usi item ki
 * recovery); na diya ho to saari rows (Start All).
 * Ajnabi id par khaali fehrist — kuch nahi chalega.
 */
function selectParkedRows(rows, taskId) {
  const list = Array.isArray(rows) ? rows.filter(r => r && r.id) : [];
  const wanted = String(taskId || '').trim();
  if (!wanted) return list;
  return list.filter(r => String(r.id) === wanted);
}

module.exports = {
  projectIdOfUrl,
  parseGalleryDateTime,
  pickGalleryProject,
  recoveryEntryPlan,
  recoverProject,
  selectParkedRows,
  RECOVERY_SWEEP_MAX_PROJECTS,
  recoverySweepCandidates,
  recoverySweepLogLine
};
