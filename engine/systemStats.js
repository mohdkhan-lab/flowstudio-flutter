'use strict';

// ---------------------------------------------------------------------------
// v2.48.83 (LIVE PC-STATS PILL — OWNER ORDER 2026-11-10):
// app ke upar wali patti me asal, live PC haalat —
// 'CPU 56% · RAM 89% · Active 1/1' wali shakal ka CPU/RAM
// hissa yahin se banta hai. Saare number ASAL hain, isi
// PC ke, isi pal ke:
//   - CPU %: poori machine ka — os.cpus() ke time hisaab
//     ke do namunon (samples) ke darmiyan ka delta.
//     Pehla namuna sirf buniyad (prime) hai; asal %
//     dusre namune se banta hai. 0–100 par bandha.
//   - RAM %: (totalmem − freemem) / totalmem — Node os
//     se hu-bahu.
//   - About-this-PC ki tafseel: hostname, OS, CPU model
//     + cores, kul RAM, aur download drive ki khaali
//     jagah (fs.statfs) — jo cheez platform sach me na
//     de sake wo payload me aati hi nahi (null), nakli
//     number kabhi nahi.
// Ye file KHALIS hisaab + ek chhota stateful sampler
// (reader ghair- tabdeeli ke liye injectable) hai —
// bridge (engine_bridge.js) har ~2s me namuna lekar
// 'system-stats' SSE event se UI ko bhejta hai.
// ---------------------------------------------------------------------------

/** os.cpus() ki ek jhalak ka kul + idle time hisaab (khalis). */
function cpuTimesTotals(cpus) {
  let idle = 0;
  let total = 0;
  if (Array.isArray(cpus)) {
    for (const c of cpus) {
      const t = c && typeof c === 'object' ? c.times : null;
      if (!t) continue;
      const user = Number(t.user) || 0;
      const nice = Number(t.nice) || 0;
      const sys = Number(t.sys) || 0;
      const idl = Number(t.idle) || 0;
      const irq = Number(t.irq) || 0;
      idle += idl;
      total += user + nice + sys + idl + irq;
    }
  }
  return { idle, total };
}

/**
 * Do cpu namunon ke darmiyan asal istemal % (khalis).
 * prev na ho (pehla namuna) ya kul time aage hi na
 * badha ho to null — % abhi banta hi nahi, nakli 0
 * kabhi nahi. Natija 0–100 ke andar bandha, qareebi
 * poora number.
 */
function cpuUsagePercent(prev, next) {
  if (!prev || !next) return null;
  const totalDelta = (Number(next.total) || 0) - (Number(prev.total) || 0);
  const idleDelta = (Number(next.idle) || 0) - (Number(prev.idle) || 0);
  if (!(totalDelta > 0)) return null;
  const used = totalDelta - Math.max(0, idleDelta);
  const pct = (used / totalDelta) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

/** RAM istemal % (khalis): (total − free) / total × 100, poora number. */
function ramUsagePercent(totalBytes, freeBytes) {
  const total = Number(totalBytes) || 0;
  const free = Number(freeBytes) || 0;
  if (!(total > 0)) return null;
  const pct = ((total - Math.max(0, Math.min(free, total))) / total) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

/**
 * Stats payload ki shakal (khalis). sample =
 * { cpuPercent, totalmem, freemem } aur meta =
 * { hostname, osLabel, cpuModel, cpuCores, disk }
 * (disk = { path, freeBytes, totalBytes } ya null).
 * Jo value asal me na mile wo null rehti hai — UI
 * us hisse ko dikhati hi nahi.
 */
function buildSystemStatsPayload(sample, meta) {
  const s = sample && typeof sample === 'object' ? sample : {};
  const m = meta && typeof meta === 'object' ? meta : {};
  const totalmem = Number(s.totalmem) || 0;
  const freemem = Number(s.freemem) || 0;
  const disk = m.disk && typeof m.disk === 'object' ? m.disk : null;
  return {
    cpuPercent: Number.isFinite(s.cpuPercent) ? s.cpuPercent : null,
    ramPercent: ramUsagePercent(totalmem, freemem),
    ramUsedBytes: totalmem > 0 ? Math.max(0, totalmem - Math.max(0, freemem)) : null,
    ramTotalBytes: totalmem > 0 ? totalmem : null,
    hostname: typeof m.hostname === 'string' && m.hostname ? m.hostname : null,
    os: typeof m.osLabel === 'string' && m.osLabel ? m.osLabel : null,
    cpuModel: typeof m.cpuModel === 'string' && m.cpuModel ? m.cpuModel : null,
    cpuCores: Number.isFinite(m.cpuCores) && m.cpuCores > 0 ? Math.floor(m.cpuCores) : null,
    diskPath: disk && typeof disk.path === 'string' && disk.path ? disk.path : null,
    diskFreeBytes: disk && Number.isFinite(disk.freeBytes) ? Math.max(0, Math.floor(disk.freeBytes)) : null,
    diskTotalBytes: disk && Number.isFinite(disk.totalBytes) && disk.totalBytes > 0 ? Math.floor(disk.totalBytes) : null,
    at: Number.isFinite(s.at) ? s.at : null
  };
}

/**
 * Stateful CPU sampler — readCpus injectable (tests
 * jaali namune dete hain; bridge asal me os.cpus deta
 * hai). Pehla sample() null deta hai (buniyad), us ke
 * baad har sample pichle se delta ka asal %.
 */
function createCpuSampler(readCpus) {
  const read = typeof readCpus === 'function' ? readCpus : (() => []);
  let prev = null;
  return {
    sample() {
      let totals = null;
      try { totals = cpuTimesTotals(read()); } catch (e) { totals = null; }
      if (!totals || !(totals.total > 0)) { prev = null; return null; }
      const pct = cpuUsagePercent(prev, totals);
      prev = totals;
      return pct;
    },
    reset() { prev = null; }
  };
}

module.exports = {
  cpuTimesTotals,
  cpuUsagePercent,
  ramUsagePercent,
  buildSystemStatsPayload,
  createCpuSampler
};
