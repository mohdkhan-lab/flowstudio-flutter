'use strict';

/**
 * FlowStudio Lite — Task FAILOVER (v2.0.0, owner's order).
 *
 * When a task dies on one account — credits out, need-login, a Flow
 * generation error, a render/download failure — the task must move by
 * itself to the next eligible account instead of dying permanently.
 *
 * The pure decision logic lives here (unit-tested without a browser):
 *
 *  - classifyFailure(reason) decides whether a failure is ACCOUNT-level
 *    (failover makes sense) or PROMPT-level (failover pointless):
 *      · Policy / safety-filter rejections are prompt-level FOREVER —
 *        the same prompt would be rejected on every account, and
 *        re-firing it would only burn another account's credits.
 *      · User-stopped tasks never fail over.
 *  - A tracker records, per task, which accounts have been TRIED
 *    (recorded when a submission starts on an account). A task may be
 *    tried on at most MAX_ACCOUNT_TRIES (3) accounts TOTAL — the first
 *    attempt counts. canFailover() is false once that budget is spent,
 *    which is what stops loops: the task then fails VISIBLY, once.
 *
 * Credit honesty: a failover is a NEW submission on a DIFFERENT
 * account. Each account's charge is recorded only against that account
 * (creditService, per-account by construction) — a task's charges are
 * never copied to or doubled on the failover account. The submission
 * claim gate (taskQueue) is released ONLY after a recorded failure —
 * for a cross-account move, or (v2.1.0) for ONE deliberate same-account
 * retry when no other eligible account exists: the account must still
 * be Live with credits, a backoff wait applies, and per-account
 * submission attempts are capped (attempts()/canSameAccountRetry()).
 * It is never released for a blind re-fire.
 */

const MAX_ACCOUNT_TRIES = 3;

// v2.48.0 (deep-audit fix #7): an UNCLASSIFIED failure (no pattern
// matched — we honestly do not know what went wrong) gets a smaller
// budget than a known account-level failure: the first try plus ONE
// extra account. Blindly re-firing an unknown error on a third
// account could burn a third charge for what might be a prompt-side
// problem the classifier simply has no words for yet.
const UNKNOWN_MAX_ACCOUNT_TRIES = 2;

const PROMPT_LEVEL_PATTERNS = [
  'google safety',          // 'Google Safety / Policy Filter', 'Google Safety Filter: ...'
  'policy filter',
  'policy violation',
  'safety filter',
  'content policy'
];

const ACCOUNT_LEVEL_PATTERNS = [
  { kind: 'need-login', patterns: ['need login', 'need_login', 'sign in', 'signed out', 'login required'] },
  { kind: 'credits', patterns: ['credits khatam', 'insufficient credits', 'not enough credits', 'low credits', 'exhausted', 'credit limit'] },
  { kind: 'cooldown', patterns: ['unusual activity'] },
  { kind: 'download', patterns: ['download failed', 'download timeout', 'download ho nahi paya'] },
  { kind: 'generation', patterns: [
    'render timed out', 'render timeout', 'render monitor', 'generation error',
    'render-frozen', // v2.48.0: the monitor's frozen-% escalation (tile present, % unmoved for 6 min)
    'tile', // 'Generation tile ... could not be identified (dropped or rejected by Flow)'
    'worker error', 'submit', 'profile busy', 'browser', 'page closed', 'target closed', 'protocol error'
  ] }
];

function classifyFailure(reason) {
  const text = String(reason || '').toLowerCase();
  if (!text.trim()) return { eligible: false, kind: null, known: true };
  if (text.includes('user') && text.includes('stop')) return { eligible: false, kind: null, known: true };
  if (text.includes('stopped by user')) return { eligible: false, kind: null, known: true };
  for (const pattern of PROMPT_LEVEL_PATTERNS) {
    if (text.includes(pattern)) return { eligible: false, kind: 'prompt-policy', known: true };
  }
  for (const group of ACCOUNT_LEVEL_PATTERNS) {
    for (const pattern of group.patterns) {
      if (text.includes(pattern)) return { eligible: true, kind: group.kind, known: true };
    }
  }
  // Unknown worker/monitor failures are treated as generation-level,
  // but flagged known:false — canFailover caps those at
  // UNKNOWN_MAX_ACCOUNT_TRIES (2) instead of MAX_ACCOUNT_TRIES (3).
  return { eligible: true, kind: 'generation', known: false };
}

function createFailoverTracker(maxTries = MAX_ACCOUNT_TRIES) {
  const cap = Math.max(1, Number(maxTries) || MAX_ACCOUNT_TRIES);
  const triedByTask = new Map(); // taskId -> Set<accountId>
  // v2.1.0: raw submission count per (task, account). recordTry/tries
  // count DISTINCT accounts (the cross-account budget); attempts()
  // counts EVERY submission on one account — with a single account the
  // distinct count stays 1 forever, so the v2.0.0 guard dead-ended such
  // tasks ("no usable account remained") instead of retrying them.
  const attemptsByTaskAccount = new Map(); // `${taskId}|${accountId}` -> count
  // v2.1.0: pending same-account retries — taskId -> { accountId, dueAt }.
  // Set by the pool when a task failed on an account, no OTHER account
  // is eligible, and that account is still usable: the task may fire
  // there again once, after the backoff timestamp passes.
  const sameAccountRetries = new Map();

  return {
    recordTry(taskId, accountId) {
      if (!taskId || !accountId) return 0;
      if (!triedByTask.has(taskId)) triedByTask.set(taskId, new Set());
      triedByTask.get(taskId).add(accountId);
      const key = `${taskId}|${accountId}`;
      attemptsByTaskAccount.set(key, (attemptsByTaskAccount.get(key) || 0) + 1);
      return triedByTask.get(taskId).size;
    },

    /** Total submissions of this task on ONE account (v2.1.0). */
    attempts(taskId, accountId) {
      if (!taskId || !accountId) return 0;
      return attemptsByTaskAccount.get(`${taskId}|${accountId}`) || 0;
    },

    /**
     * May this task be re-fired on the SAME account it just failed on?
     * Only when the failure is account-level (never policy/stopped),
     * the task still has overall account budget, and this account has
     * been submitted on fewer than maxSameAccountAttempts times
     * (default 3 submissions total per account: the first try plus up
     * to two backed-off retries).
     */
    canSameAccountRetry(taskId, accountId, reason, maxSameAccountAttempts = 3) {
      const cls = classifyFailure(reason);
      if (!cls.eligible) return { ok: false, kind: cls.kind };
      if (!this.hasTried(taskId, accountId)) return { ok: false, kind: cls.kind };
      const capPerAccount = Math.max(1, Number(maxSameAccountAttempts) || 3);
      if (this.attempts(taskId, accountId) >= capPerAccount) return { ok: false, kind: cls.kind };
      return { ok: true, kind: cls.kind };
    },

    /** Mark (or clear) a pending same-account retry for a task. */
    markSameAccountRetry(taskId, accountId, dueAt) {
      if (!taskId || !accountId) return;
      sameAccountRetries.set(taskId, { accountId, dueAt: Number(dueAt) || 0 });
    },

    sameAccountRetry(taskId) {
      return sameAccountRetries.get(taskId) || null;
    },

    clearSameAccountRetry(taskId) {
      sameAccountRetries.delete(taskId);
    },

    tries(taskId) {
      const set = triedByTask.get(taskId);
      return set ? set.size : 0;
    },

    accountsTried(taskId) {
      const set = triedByTask.get(taskId);
      return set ? new Set(set) : new Set();
    },

    hasTried(taskId, accountId) {
      const set = triedByTask.get(taskId);
      return !!(set && set.has(accountId));
    },

    forget(taskId) {
      triedByTask.delete(taskId);
      sameAccountRetries.delete(taskId);
      for (const key of Array.from(attemptsByTaskAccount.keys())) {
        if (key.startsWith(`${taskId}|`)) attemptsByTaskAccount.delete(key);
      }
    },

    /**
     * May this failed task move to another account?
     * Returns { ok, kind, tries, maxTries } — ok=false when the failure
     * is prompt-level or the 3-account budget is already spent.
     */
    canFailover(taskId, reason) {
      const cls = classifyFailure(reason);
      const tries = this.tries(taskId);
      // v2.48.0: unknown (unclassified) failures get the smaller cap.
      const effectiveCap = cls.known === false ? Math.min(cap, UNKNOWN_MAX_ACCOUNT_TRIES) : cap;
      if (!cls.eligible) return { ok: false, kind: cls.kind, tries, maxTries: effectiveCap };
      if (tries >= effectiveCap) return { ok: false, kind: cls.kind, tries, maxTries: effectiveCap };
      return { ok: true, kind: cls.kind, tries, maxTries: effectiveCap };
    },

    get maxTries() { return cap; }
  };
}

module.exports = { MAX_ACCOUNT_TRIES, UNKNOWN_MAX_ACCOUNT_TRIES, classifyFailure, createFailoverTracker };
