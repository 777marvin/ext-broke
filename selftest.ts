import type { ContextMessage } from '@aiderdesk/extensions';
import type { Config } from './config';
import { compressMessages, createCompressState, errorPass, structuralPass, truncatePass, type SummarizeDeps } from './compress';
import { estimateTokens, messagesChars } from './tokens';

let seq = 0;
function id(): string {
  return `selftest-${++seq}`;
}

function textMessage(role: 'user' | 'assistant', text: string): ContextMessage {
  return { id: id(), role, content: text };
}

/** Tool message whose result references a REAL tool-call id (the caller passes it in). */
function toolMessage(toolName: string, value: string, callId: string): ContextMessage {
  return {
    id: id(),
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: callId,
        toolName,
        output: { type: 'text', value },
      },
    ],
  };
}

/**
 * Assistant message issuing one tool-call. Returns the message AND the call
 * id so tool results can reference the actual call - the dedupe pass pairs
 * results with their holder via the call id, and self-generated ids made the
 * selftest's "duplicate adjacent result" scenario never actually dedupe.
 */
function assistantWithToolCall(toolName: string, input: Record<string, unknown>): { message: ContextMessage; callId: string } {
  const callId = id();
  return {
    callId,
    message: {
      id: id(),
      role: 'assistant',
      content: [
        { type: 'text', text: 'Running a tool…' },
        { type: 'tool-call', toolCallId: callId, toolName, input },
      ],
    },
  };
}

/**
 * Build a synthetic conversation that exercises every pass:
 * - an old oversized tool output (truncate)
 * - a big compiler error dump (error compression)
 * - two identical adjacent tool results (structural dedupe)
 * - an empty assistant message (structural drop)
 * - enough turns to make the region summarizable (summarize)
 */
/** The duplicated bash output: the selftest asserts it appears exactly once after the run. */
const DUPLICATE_OUTPUT = 'PASS  tests/billing.test.ts (42 tests)';

export function buildSyntheticMessages(): ContextMessage[] {
  const bigOutput = Array.from({ length: 500 }, (_, i) => `line ${i}: const x${i} = ${i * 7}; // padding for a large tool result`).join('\n');
  const tscErrorOutput =
    Array.from({ length: 120 }, (_, i) => `src/billing.ts:${10 + i}:${5 + (i % 3)} - error TS2554: Expected 2 arguments, but got 1.\n  ${10 + i}   compute(${i % 2 === 0 ? 'total' : ''});\n      ${'~'.repeat(12)}`).join('\n') +
    `\n\nFound ${120} errors in the same file.`;
  const messages: ContextMessage[] = [
    textMessage('user', 'Implement the billing module. Requirements: invoices, payments, CSV export.'),
  ];
  // turn 1
  const fileRead = assistantWithToolCall('power---file-read', { filePath: 'src/billing.ts' });
  messages.push(fileRead.message);
  messages.push(toolMessage('power---file-read', bigOutput, fileRead.callId));
  messages.push(textMessage('assistant', 'The file is large. I will implement the module step by step.'));
  // turn 2 - the same test run twice with identical output: the second
  // call+result pair is the structural dedupe target.
  const run1 = assistantWithToolCall('power---bash', { command: 'npm test -- --no-color' });
  messages.push(run1.message);
  messages.push(toolMessage('power---bash', DUPLICATE_OUTPUT, run1.callId));
  const run2 = assistantWithToolCall('power---bash', { command: 'npm test -- --no-color' });
  messages.push(run2.message);
  messages.push(toolMessage('power---bash', DUPLICATE_OUTPUT, run2.callId));
  // turn 3
  messages.push(textMessage('assistant', ''));
  const grep1 = assistantWithToolCall('power---grep', { pattern: 'invoice', filePattern: 'src/**/*.ts' });
  messages.push(grep1.message);
  messages.push(toolMessage('power---grep', 'src/billing.ts:10: export function createInvoice()', grep1.callId));
  // turn 4 (region user turn 1)
  messages.push(textMessage('user', 'Also add a discount field to invoices.'));
  const edit = assistantWithToolCall('power---file-edit', { filePath: 'src/billing.ts', searchTerm: 'total', replacementText: 'discountedTotal' });
  messages.push(edit.message);
  messages.push(toolMessage('power---file-edit', 'Successfully edited src/billing.ts.', edit.callId));
  // turn 5 (region user turn 2)
  messages.push(textMessage('user', 'Run the tests again and fix what fails.'));
  const tsc = assistantWithToolCall('power---bash', { command: 'npx tsc --noEmit --no-color' });
  messages.push(tsc.message);
  messages.push(toolMessage('power---bash', tscErrorOutput, tsc.callId));
  // turn 6 (protected tail)
  messages.push(textMessage('user', 'Also export the CSV with the discount applied.'));
  const grep2 = assistantWithToolCall('power---grep', { pattern: 'exportCsv', filePattern: 'src/**/*.ts' });
  messages.push(grep2.message);
  messages.push(toolMessage('power---grep', 'src/billing.ts:42: export function exportCsv()', grep2.callId));
  return messages;
}

export interface SelfTestResult {
  lines: string[];
  touched: boolean;
}

/**
 * Run the full pipeline over synthetic input with a stub summarizer and
 * report per-pass results. Thresholds are deliberately forced low so every
 * pass is exercised regardless of the user's config; the real thresholds are
 * only reported, not applied.
 */
export async function runSelfTest(config: Config): Promise<SelfTestResult> {
  const exerciseConfig: Config = {
    ...config,
    enabled: true,
    level: config.level,
    protectedTurns: 1,
    maxContextChars: 10000,
    truncate: { ...config.truncate, maxLines: 100, maxKB: 20, maxInputChars: 500 },
    errors: { ...config.errors, minChars: 500 },
    summarize: { ...config.summarize, afterTurns: 2, minChars: 2000, maxSummaryChars: 2000 },
  };
  const messages = buildSyntheticMessages();
  const before = messagesChars(messages);
  const lines: string[] = [];
  const level = config.enabled ? config.level : 'off';
  lines.push(
    `broke selftest - synthetic conversation: ${messages.length} messages, ${before.toLocaleString()} chars (≈ ${estimateTokens(before).toLocaleString()} tokens)` +
      ` - thresholds forced low so every applicable pass is exercised (your config: level=${level}, maxContextChars=${config.maxContextChars.toLocaleString()})`,
  );

  const deps: SummarizeDeps = {
    generateLocal: async (_model, _prompt) => {
      lines.push('  [summarizer] local (stub): would call Ollama - returning a stub summary');
      return 'Requirements: implement billing module with invoices, payments, CSV export; discount field added later. Decisions: implemented step by step; tests pass except discount calculation and CSV export format, which must be fixed. Files: src/billing.ts (edited: total → discountedTotal).';
    },
    generateCloud: async () => undefined,
  };

  const state = createCompressState();
  const { messages: result, report } = await compressMessages(messages, exerciseConfig, deps, state, 'selftest-task');

  const after = messagesChars(result);
  // The level that was ACTUALLY exercised, not the user-facing one: labeling
  // passes "NOT exercised" while their numbers were reported contradicts
  // itself when the extension is disabled (enabled=false used to force the
  // label to 'structural' while the pipeline still ran at the real level).
  const levelApplied = exerciseConfig.level;
  lines.push(`  result: ${result.length} messages, ${after.toLocaleString()} chars (≈ ${estimateTokens(after).toLocaleString()} tokens)`);
  lines.push(`  structural:  ${report.structuralChars.toLocaleString()} chars removed (always exercised)`);
  lines.push(
    `  error:       ${report.errorChars.toLocaleString()} chars removed (stack-trace/log compression)${config.errors.enabled && (levelApplied === 'truncate' || levelApplied === 'summarize') ? '' : ' - NOT exercised (needs errors.enabled + level truncate or summarize)'}`,
  );
  lines.push(
    `  truncate:    ${report.truncateChars.toLocaleString()} chars removed${levelApplied === 'truncate' || levelApplied === 'summarize' ? '' : ' - NOT exercised (needs level truncate or summarize)'}`,
  );
  lines.push(
    `  summarize:   ${report.summarizeChars.toLocaleString()} chars removed (${report.summarizedRanges} range(s), ${report.summarizeCalls} LLM call(s), summarizer: ${report.summarizer})${levelApplied === 'summarize' ? '' : ' - NOT exercised (needs level summarize)'}`,
  );
  lines.push(`  total saved: ${(before - after).toLocaleString()} chars (≈ ${estimateTokens(before - after).toLocaleString()} tokens) - ${report.touched ? 'pipeline active' : 'nothing to do'}`);

  const hasMarker = result.some((m) => typeof m.content === 'string' && m.content.startsWith('[broke-compacted]'));
  // F11: assert the dedupe REALLY happened. Each check looks at the output
  // of ITS OWN pass: the final result after a summarize run replaces the
  // whole region with the summary, which would hide every intermediate
  // marker and label applied passes as "no". The duplicated output appears
  // twice in the input and must appear exactly once after structuralPass.
  const structuralOut = structuralPass(messages, exerciseConfig.protectedTurns).messages;
  const dedupeApplied = JSON.stringify(structuralOut).split(DUPLICATE_OUTPUT).length - 1 === 1;
  const errorOut = errorPass(structuralOut, exerciseConfig.protectedTurns, {
    minChars: exerciseConfig.errors.minChars,
    contextLines: exerciseConfig.errors.contextLines,
  }).messages;
  const hasErrorSummary = JSON.stringify(errorOut).includes('[broke: error summary');
  const truncateOut = truncatePass(
    errorOut,
    exerciseConfig.protectedTurns,
    exerciseConfig.truncate.maxLines,
    exerciseConfig.truncate.maxKB,
    exerciseConfig.truncate.maxInputChars,
  ).messages;
  const truncationApplied = JSON.stringify(truncateOut).includes('[broke: truncated');
  lines.push(
    `  checks: summary message present: ${hasMarker ? 'yes' : 'no'}, error summary applied: ${hasErrorSummary ? 'yes' : 'no'}, truncation applied: ${truncationApplied ? 'yes' : 'no'}, dedupe applied: ${dedupeApplied ? 'yes' : 'no'}, structural cleanup applied: ${report.structuralChars > 0 ? 'yes' : 'no'}`,
  );

  return { lines, touched: report.touched };
}
