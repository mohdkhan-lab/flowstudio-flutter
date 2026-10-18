/**
 * FlowStudio Lite — in-memory FIFO task queue with strict submission
 * identity guards (used by WorkerPool; unit-testable in plain Node).
 *
 * Guarantees:
 *  - A task id can be present in the pending list at most once
 *    (requeueFront is idempotent — no duplicate entries ever).
 *  - A task id can be claimed for submission at most once, ever, until
 *    explicitly released. claimForSubmission() is the gate the pool must
 *    pass immediately before firing a prompt at Google Flow, which makes
 *    duplicate submission of the same prompt impossible even if rotation
 *    logic re-queues aggressively.
 */
class TaskQueue {
  constructor(tasks = []) {
    this.pending = [];
    this.submittedIds = new Set();
    for (const t of tasks) this.enqueue(t);
  }

  enqueue(task) {
    if (!task || task.id === undefined || task.id === null) return false;
    if (this.pending.some(t => t.id === task.id)) return false;
    this.pending.push(task);
    return true;
  }

  /** Put a task back at the FRONT (used when its account ran out of credits
   *  before the prompt was ever fired). Idempotent: never duplicates. */
  requeueFront(task) {
    if (!task || task.id === undefined || task.id === null) return false;
    if (this.pending.some(t => t.id === task.id)) return false;
    this.pending.unshift(task);
    return true;
  }

  /** Take the next pending task (FIFO). Returns null when empty. */
  next() {
    return this.pending.length > 0 ? this.pending.shift() : null;
  }

  peek() {
    return this.pending.length > 0 ? this.pending[0] : null;
  }

  has(taskId) {
    return this.pending.some(t => t.id === taskId);
  }

  size() {
    return this.pending.length;
  }

  /**
   * Gate that must pass immediately before a prompt is fired at Flow.
   * Returns true exactly once per task id; every later call returns false,
   * so a task can never be submitted twice.
   */
  claimForSubmission(taskId) {
    if (this.submittedIds.has(taskId)) return false;
    this.submittedIds.add(taskId);
    return true;
  }

  isSubmitted(taskId) {
    return this.submittedIds.has(taskId);
  }

  /** Release a submission claim (only for a task that provably never fired,
   *  e.g. the browser died before the submit click — pool decides). */
  releaseSubmission(taskId) {
    this.submittedIds.delete(taskId);
  }
}

module.exports = { TaskQueue };
