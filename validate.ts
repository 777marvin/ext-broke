/**
 * ContextValidator (external review R-phase, P0): pure invariant checks over
 * the message list that is about to be sent to the provider. The compression
 * passes each guard pairing locally, but defense in depth demands ONE place
 * that verifies the final result as a whole: a broken context (an orphaned
 * tool-call or tool-result) makes the next provider call fail outright -
 * which is strictly worse than sending an uncompressed context.
 *
 * Contract: validateContext returns every violation it finds. The pipeline
 * (compressMessages) reverts to the original messages ONLY when its OUTPUT
 * violates the invariants while its INPUT was sound - i.e. when a pass broke
 * a previously valid context. Input that is already corrupt fails the
 * provider call regardless of compression, so reverting would gain nothing
 * while silently disabling broke for that task.
 */
import type { ContextMessage } from '@aiderdesk/extensions';

export interface ValidationFailure {
  /** Message index the violation was found at (-1 when cross-message). */
  index: number;
  reason: string;
}

interface IdPart {
  type: string;
  toolCallId?: unknown;
}

/**
 * Validate provider-bound invariants. Returns [] when the context is sound:
 * - no duplicated tool-call ids across assistant messages
 * - no duplicated tool-result ids across tool messages
 * - every tool-call has a matching tool-result somewhere later
 * - every tool-result has its producing tool-call present somewhere earlier
 * Messages without structured content (plain strings) are ignored - they can
 * never violate pairing.
 */
export function validateContext(messages: ContextMessage[]): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  const callIds = new Map<string, number>();
  const resultIds = new Map<string, number>();

  // Single pass: collect ids AND flag duplicates inline (keeps the first
  // occurrence's index so the failure points at the actual duplicate).
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content as unknown as IdPart[]) {
      if (!part || typeof part.toolCallId !== 'string') continue;
      if (msg.role === 'assistant' && part.type === 'tool-call') {
        if (callIds.has(part.toolCallId)) {
          failures.push({ index: i, reason: `duplicate tool-call id '${part.toolCallId}'` });
        } else {
          callIds.set(part.toolCallId, i);
        }
      }
      if (msg.role === 'tool' && part.type === 'tool-result') {
        if (resultIds.has(part.toolCallId)) {
          failures.push({ index: i, reason: `duplicate tool-result id '${part.toolCallId}'` });
        } else {
          resultIds.set(part.toolCallId, i);
        }
      }
    }
  }

  // Orphaned calls: a call whose result was removed makes AI_MissingToolResultsError.
  // BRK-015 (external review 2026-08-29): set membership cannot prove the
  // documented SEQUENCE invariant - with the stored indexes we also enforce
  // that every result comes AFTER its call (a provider can reject
  // result-before-call streams).
  for (const [id, idx] of callIds) {
    if (!resultIds.has(id)) failures.push({ index: idx, reason: `tool-call '${id}' has no matching tool-result` });
    else if ((resultIds.get(id) as number) < idx) {
      failures.push({ index: resultIds.get(id) as number, reason: `tool-result '${id}' appears before its tool-call` });
    }
  }
  // Orphaned results: a result whose producing call is gone fails the same way.
  for (const [id, idx] of resultIds) {
    if (!callIds.has(id)) failures.push({ index: idx, reason: `tool-result '${id}' has no matching tool-call` });
  }
  return failures;
}

/** One loggable line per failure (index -1-safe). */
export function formatValidationFailures(failures: ValidationFailure[]): string {
  return failures.map((f) => `#${f.index}: ${f.reason}`).join('; ');
}
