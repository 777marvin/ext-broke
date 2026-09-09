import { createHash } from 'node:crypto';
import type { ContextMessage } from '@aiderdesk/extensions';

/**
 * The sent-ledger: remembers which messages were already sent to the model
 * (as part of a previous onOptimizeMessages return) so the compression
 * passes can leave that prefix byte-stable. This is the mechanism behind
 * the cache-friendly mode: provider prompt caches are prefix-based, so ANY
 * rewrite of already-sent history invalidates the cached prefix - at
 * Anthropic even with a ~1.25x write premium for rebuilding it.
 *
 * Matching is by serialized CONTENT (role + content + tool framing), not by
 * message id. Two reasons:
 * 1. Synthetic messages (merged texts, summaries) get fresh ids per run -
 *    id-based matching would never freeze them.
 * 2. Byte stability is the actual contract: identical bytes hit the
 *    provider cache regardless of what the host thinks the id is.
 *
 * The error direction is deliberately conservative: a false "sent" only
 * skips one compression chance, while a false "not sent" would rewrite
 * cached bytes and bust the cache. Consequences of content matching:
 * - Same id, different content (host edit, or the original behind an
 *   earlier merge) => NOT sent => stays compressible so the deterministic
 *   pipeline can re-derive exactly the bytes it sent before.
 * - Identical content under a different id => sent (host id churn must not
 *   un-freeze a stable prefix).
 *
 * In-memory only, per task, FIFO-capped: restarts lose the ledger, which
 * merely re-enables compression for one run - the server-side cache is
 * short-lived anyway (Anthropic ~5 min TTL), so persistence would buy
 * almost nothing. Bounded like every other cache in broke (see
 * unknownReadToolsLogged) so a long session cannot grow unbounded.
 */

/** Tracked serialized messages per task (FIFO beyond this). */
const MAX_ENTRIES_PER_TASK = 2000;
/** Tracked tasks (LRU beyond this) - tasks are short-lived relative to this. */
const MAX_TASKS = 50;

const ledgers = new Map<string, Map<string, number>>();

/**
 * Canonical serialization of a message for cache-relevant byte comparison.
 * JSON.stringify is deterministic for the same object structure, which is
 * what the host replays from its append-only history. Circular or exotic
 * content falls back to String() - the ledger must never throw.
 */
function serialize(msg: ContextMessage): string {
  const frame = msg as { role?: unknown; content?: unknown; toolCallId?: unknown };
  const canonical = { role: frame.role, content: frame.content, toolCallId: frame.toolCallId };
  try {
    return JSON.stringify(canonical);
  } catch {
    return String(frame.content);
  }
}

function hashOf(serialized: string): string {
  return createHash('sha256').update(serialized).digest('hex');
}

/** Track messages contained in an optimize-run OUTPUT as "already sent". */
export function markSent(taskId: string, messages: readonly ContextMessage[]): void {
  if (!taskId || !Array.isArray(messages)) return;
  let ledger = ledgers.get(taskId);
  if (!ledger) {
    ledgers.set(taskId, ledger = new Map());
    // LRU over tasks: evict the least recently touched ledger.
    if (ledgers.size > MAX_TASKS) {
      const oldest = ledgers.keys().next().value;
      if (oldest !== undefined) ledgers.delete(oldest);
    }
  }
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const hash = hashOf(serialize(msg));
    // Delete-then-set keeps Map insertion order = recency order.
    ledger.delete(hash);
    ledger.set(hash, ledger.size + 1);
    while (ledger.size > MAX_ENTRIES_PER_TASK) {
      const oldest = ledger.keys().next().value;
      if (oldest === undefined) break;
      ledger.delete(oldest);
    }
  }
}

/**
 * Whether this message's exact bytes were already sent to the model for
 * this task. Frozen messages must be emitted as-is by every pass.
 */
export function isSent(taskId: string, msg: ContextMessage): boolean {
  if (!taskId || !msg || typeof msg !== 'object') return false;
  const ledger = ledgers.get(taskId);
  if (!ledger) return false;
  return ledger.has(hashOf(serialize(msg)));
}

/** Drop one task's ledger (escape-hatch reset, tests, task cleanup). */
export function clearTask(taskId: string): void {
  if (taskId) ledgers.delete(taskId);
}

/** Observability for tests and future /broke diagnostics. */
export function ledgerStats(taskId: string): { tracked: boolean; entries: number } {
  const ledger = ledgers.get(taskId);
  return { tracked: ledger !== undefined, entries: ledger ? ledger.size : 0 };
}
