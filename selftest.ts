import type { ContextMessage } from '@aiderdesk/extensions';
import type { Config } from './config';
import { compressMessages, createCompressState, type SummarizeDeps } from './compress';
import { estimateTokens, messagesChars } from './tokens';

let seq = 0;
function id(): string {
  return `selftest-${++seq}`;
}

function textMessage(role: 'user' | 'assistant', text: string): ContextMessage {
  return { id: id(), role, content: text };
}

function toolMessage(toolName: string, value: string): ContextMessage {
  return {
    id: id(),
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id(),
        toolName,
        output: { type: 'text', value },
      },
    ],
  };
}

function assistantWithToolCall(toolName: string, input: Record<string, unknown>): ContextMessage {
  return {
    id: id(),
    role: 'assistant',
    content: [
      { type: 'text', text: 'Running a tool…' },
      { type: 'tool-call', toolCallId: id(), toolName, input },
    ],
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
export function buildSyntheticMessages(): ContextMessage[] {
  const bigOutput = Array.from({ length: 500 }, (_, i) => `line ${i}: const x${i} = ${i * 7}; // padding for a large tool result`).join('\n');
  const tscErrorOutput =
    Array.from({ length: 120 }, (_, i) => `src/billing.ts:${10 + i}:${5 + (i % 3)} - error TS2554: Expected 2 arguments, but got 1.\n  ${10 + i}   compute(${i % 2 === 0 ? 'total' : ''});\n      ${'~'.repeat(12)}`).join('\n') +
    `\n\nFound ${120} errors in the same file.`;
  const messages: ContextMessage[] = [
    textMessage('user', 'Implement the billing module. Requirements: invoices, payments, CSV export.'),
  ];
  // turn 1
  messages.push(assistantWithToolCall('power---file-read', { filePath: 'src/billing.ts' }));
  messages.push(toolMessage('power---file-read', bigOutput));
  messages.push(textMessage('assistant', 'The file is large. I will implement the module step by step.'));
  // turn 2
  messages.push(assistantWithToolCall('power---bash', { command: 'npm test -- --no-color' }));
  messages.push(toolMessage('power---bash', 'PASS  tests/billing.test.ts (42 tests)'));
  // duplicate adjacent result (dedupe target)
  messages.push(toolMessage('power---bash', 'PASS  tests/billing.test.ts (42 tests)'));
  // turn 3
  messages.push(textMessage('assistant', ''));
  messages.push(assistantWithToolCall('power---grep', { pattern: 'invoice', filePattern: 'src/**/*.ts' }));
  messages.push(toolMessage('power---grep', 'src/billing.ts:10: export function createInvoice()'));
  // turn 4 (region user turn 1)
  messages.push(textMessage('user', 'Also add a discount field to invoices.'));
  messages.push(assistantWithToolCall('power---file-edit', { filePath: 'src/billing.ts', searchTerm: 'total', replacementText: 'discountedTotal' }));
  messages.push(toolMessage('power---file-edit', 'Successfully edited src/billing.ts.'));
  // turn 5 (region user turn 2)
  messages.push(textMessage('user', 'Run the tests again and fix what fails.'));
  messages.push(assistantWithToolCall('power---bash', { command: 'npx tsc --noEmit --no-color' }));
  messages.push(toolMessage('power---bash', tscErrorOutput));
  // turn 6 (protected tail)
  messages.push(textMessage('user', 'Also export the CSV with the discount applied.'));
  messages.push(assistantWithToolCall('power---grep', { pattern: 'exportCsv', filePattern: 'src/**/*.ts' }));
  messages.push(toolMessage('power---grep', 'src/billing.ts:42: export function exportCsv()'));
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
  const levelApplied = config.enabled ? config.level : 'structural';
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
  const hasErrorSummary = result.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => (p as { output?: { value?: unknown } }).output?.value?.toString().includes('[broke: error summary')),
  );
  lines.push(
    `  checks: summary message present: ${hasMarker ? 'yes' : 'no'}, error summary applied: ${hasErrorSummary ? 'yes' : 'no'}, truncation applied: ${report.truncateChars > 0 ? 'yes' : 'no'}, dedupe/merge applied: ${report.structuralChars > 0 ? 'yes' : 'no'}`,
  );

  return { lines, touched: report.touched };
}
