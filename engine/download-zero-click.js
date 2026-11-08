'use strict';

/**
 * FlowStudio Lite — ZERO-CLICK WATCH (v2.48.70 + hotfix).
 *
 * MASLA: download kabhi manual button/menu se na ho.
 *
 * Usool: engine ka onBackendMedia callback log karta hai
 * ("No Download button or menu was pressed") — ye line seedha zaahir 
 * karti hai ke flow server sa seedha fetch ho raha hai.
 *
 * Is file ka kaam:
 *   1. zero-click mandate ka record rakhna (kisi bhi save/pick ke 
 *      aaghaz me)
 *   2. Jab bhi ek file pick/save hota hai, to check karna ke 
 *      onBackendMedia or zero-click log present hai; nahi to allow
 *      karna, par log me wajah dikhani
 *   3. Ki koi bhi fallback/manual route false par aaye to 
 *      [ROOT] zero-click rejected=<reason> line aaye.
 *
 * YE FILE PURE HOAT CADDER HAI — koi I/O, koi re-fetch.
 * Engine wo use karta hai jo save/route karta hai.
 */

/**
 * Ek task par zero-click mandate ka record banana.
 * input: { taskKey, source: 'engine' | 'manual' | 'fallback' }
 */
function recordZeroClickStart(taskKey, source) {
  const o = {};
  o.taskKey = taskKey || null;
  o.source = source || 'engine';
  o.at = Date.now();
  // Hash bina iv ke use karke identity banayi (safe for log)
  const h = 0;
  o.hashKey = `${o.taskKey || 'nokey'}:${o.source}:${o.at}`;
  return o;
}

/**
 * Dump line (khalis) — engine ko bataata hai kaise flow gaya.
 */
function zeroClickStatus(taskKey, source) {
  const tk = taskKey ? String(taskKey) : '(unknown)';
  const src = source || 'unknown';
  return `[ROOT] zero-click ${tk} source=${src} active=true`;
}

/**
 * Save/pick ke baad ya reject karne se pehle check karna.
 * Input: { taskKey, fromSource: string }
 * Output: { allowed: boolean, reason: string }
 *
 * allowed = TRUE tab jab:
 *   - engine source hai, ya
 *   - manual source hai par jo bhi fallback hua hai, woh logged hai.
 *
 * This is a whitelist/counter-check, not a hard block: owner 
 * jaanta hai kaunsa source kaam karta hai.
 */
function checkZeroClickCondition(input) {
  const o = input || {};
  const taskKey = o.taskKey || null;
  const fromSource = o.fromSource || 'unknown';

  // Engine flow, backend se fetch — allowed.
  if (fromSource === 'engine') {
    return { allowed: true, reason: 'engine-backend-fetch' };
  }

  // Manual/badge — disallowed.
  if (fromSource === 'manual' || fromSource === 'button' || fromSource === 'menu') {
    return { allowed: false, reason: 'manual-forbidden' };
  }

  // Fallback — log but allow.
  if (fromSource === 'fallback') {
    return { allowed: true, reason: 'fallback-logged' };
  }

  // Unknown source — allow with warning.
  return { allowed: true, reason: 'unknown-source-ok' };
}

/**
 * [ROOT] zero-click rejection line (khalis).
 */
function zeroClickRejectLine(taskKey, reason) {
  const tk = taskKey ? String(taskKey) : '(unknown)';
  const r = reason || 'unknown';
  return `[ROOT] zero-click rejected task=${tk} reason=${r}`;
}

module.exports = {
  recordZeroClickStart,
  zeroClickStatus,
  checkZeroClickCondition,
  zeroClickRejectLine
};
