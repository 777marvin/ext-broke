/**
 * Reference benchmark: a deterministic synthetic workload pushed through the
 * real compression pipeline with the SHIPPED defaults. No LLM is involved:
 * the summarizer is a stub that returns a fixed text, so every printed
 * number depends only on the pipeline mechanics and can be regenerated
 * byte for byte with `npm run bench`.
 *
 * This replaces the earlier published "session measurements": those numbers
 * could not be reproduced from raw data and were removed. The benchmark is
 * the one place where broke makes a claim about its compression effect, and
 * it is labeled as what it is: a synthetic reference, not a real session.
 */

import type { ContextMessage } from '@aiderdesk/extensions';
import { compressMessages, createCompressState, type SummarizeDeps } from '../compress';
import { DEFAULT_CONFIG, type Config } from '../config';
import { estimateTokens, messagesChars } from '../tokens';

let seq = 0;
function id(): string {
  return `bench-${++seq}`;
}

function textMessage(role: 'user' | 'assistant', text: string): ContextMessage {
  return { id: id(), role, content: text };
}

function assistantWithToolCall(toolName: string, input: Record<string, unknown>): { message: ContextMessage; callId: string } {
  const callId = id();
  return {
    callId,
    message: {
      id: id(),
      role: 'assistant',
      content: [
        { type: 'text', text: 'Running the tool...' },
        { type: 'tool-call', toolCallId: callId, toolName, input },
      ],
    },
  };
}

function toolMessage(toolName: string, value: string, callId: string): ContextMessage {
  return {
    id: id(),
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: callId, toolName, output: { type: 'text', value } }],
  };
}

/** Oversized file read (260 lines): truncate pass target. */
function fileReadOutput(): string {
  return Array.from({ length: 260 }, (_, i) => `line ${i}: export function helper${i}() { return ${i * 11}; } // module code with realistic padding`).join('\n');
}

/** Oversized test run (250 lines): truncate pass target. */
function bashOutput(): string {
  return Array.from({ length: 250 }, (_, i) => `  OK test case ${i} passed (${i % 7 === 0 ? 'billing' : 'core'} suite, ${12 + (i % 90)}ms)`).join('\n');
}

/** Big compiler dump (300 errors): error pass target. */
function tscDump(): string {
  return (
    Array.from(
      { length: 300 },
      (_, i) =>
        `src/module${i % 9}.ts:${10 + i}:${5 + (i % 3)} - error TS2322: Type 'string' is not assignable to type 'number'.\n  ${10 + i}   const result: number = compute(${i % 2 === 0 ? "'x'" : i});\n      ${'~'.repeat(14)}`,
    ).join('\n') + '\n\nFound 300 errors in 9 files.'
  );
}

/** Fixed-length stand-in for a summarizer answer (bounded by maxSummaryChars). */
export const STUB_SUMMARY =
  'Invoicing service: schema, validation, discount handling, CSV export, tax rules, audit logging and caching implemented across the early turns. Each module change was followed by npm test runs which passed. Strict typing was added and the compile errors were fixed; the suite was re-run twice to confirm. Files: src/schema.ts, src/validate.ts, src/discount.ts, src/export.ts, src/tax.ts, src/audit.ts, src/cache.ts.';

const TOPICS = ['schema', 'validation', 'discounts', 'export', 'taxes', 'audit log', 'caching'];
const FILES = ['schema.ts', 'validate.ts', 'discount.ts', 'export.ts', 'tax.ts', 'audit.ts', 'cache.ts'];

/**
 * A long synthetic coding session: task brief, seven full work turns (user
 * requirement, file read, test run, summary), a typing-error turn, a
 * duplicated test run (dedupe target) and a protected tail of the last two
 * user turns. Deterministic: no randomness, no time, no external state.
 */
export function buildBenchWorkload(): ContextMessage[] {
  const messages: ContextMessage[] = [
    textMessage('user', 'Build the invoicing service: CRUD endpoints, discount handling, CSV export and full test coverage.'),
  ];
  for (let turn = 0; turn < TOPICS.length; turn++) {
    messages.push(textMessage('user', `Requirement ${turn + 1}: adjust the ${TOPICS[turn]} part.`));
    messages.push(textMessage('assistant', `Understood. I will change the ${TOPICS[turn]} module and run the checks.`));
    const read = assistantWithToolCall('power---file-read', { filePath: `src/${FILES[turn]}` });
    messages.push(read.message);
    messages.push(toolMessage('power---file-read', fileReadOutput(), read.callId));
    const run = assistantWithToolCall('power---bash', { command: 'npm test -- --no-color' });
    messages.push(run.message);
    messages.push(toolMessage('power---bash', bashOutput(), run.callId));
    messages.push(textMessage('assistant', `Done with ${TOPICS[turn]}; tests green.`));
  }
  // Turn 8: compiler errors (error pass target).
  messages.push(textMessage('user', 'Add strict typing and fix the compile errors.'));
  const tsc = assistantWithToolCall('power---bash', { command: 'npx tsc --noEmit --no-color' });
  messages.push(tsc.message);
  messages.push(toolMessage('power---bash', tscDump(), tsc.callId));
  // Turn 9: the same test run twice with identical output (dedupe target).
  messages.push(textMessage('user', 'Re-run the suite to confirm nothing broke.'));
  const run1 = assistantWithToolCall('power---bash', { command: 'npm test -- --no-color' });
  messages.push(run1.message);
  messages.push(toolMessage('power---bash', bashOutput(), run1.callId));
  const run2 = assistantWithToolCall('power---bash', { command: 'npm test -- --no-color' });
  messages.push(run2.message);
  messages.push(toolMessage('power---bash', bashOutput(), run2.callId));
  // Turns 10-11: the protected tail (last 2 user turns, never compressed).
  // Like a real working set, the tail carries its own recent tool results.
  messages.push(textMessage('user', 'Export the final CSV with discounts applied.'));
  const grep = assistantWithToolCall('power---grep', { pattern: 'exportCsv', filePattern: 'src/**/*.ts' });
  messages.push(grep.message);
  messages.push(toolMessage('power---grep', 'src/export.ts:42: export function exportCsv()', grep.callId));
  const tailRun = assistantWithToolCall('power---bash', { command: 'npm test -- --no-color' });
  messages.push(tailRun.message);
  messages.push(toolMessage('power---bash', bashOutput(), tailRun.callId));
  messages.push(textMessage('user', 'Also document the API in README.'));
  const readme = assistantWithToolCall('power---file-read', { filePath: 'README.md' });
  messages.push(readme.message);
  messages.push(toolMessage('power---file-read', fileReadOutput(), readme.callId));
  messages.push(textMessage('assistant', 'Adding the endpoint list to README now.'));
  return messages;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

async function runScenario(label: string, config: Config, workload: ContextMessage[]): Promise<string[]> {
  const before = messagesChars(workload);
  const deps: SummarizeDeps = {
    generateLocal: async () => STUB_SUMMARY,
    generateCloud: async () => STUB_SUMMARY,
  };
  const state = createCompressState();
  const { report } = await compressMessages(workload, config, deps, state, 'bench-task');
  const after = report.totalCharsAfter;
  const removed = before - after;
  const pct = before > 0 ? ((removed / before) * 100).toFixed(1) : '0.0';
  return [
    `scenario: ${label}`,
    `  input      ${fmt(before)} chars (~ ${fmt(estimateTokens(before))} tokens)`,
    `  output     ${fmt(after)} chars (~ ${fmt(estimateTokens(after))} tokens)`,
    `  structural ${fmt(report.structuralChars)} chars removed`,
    `  error      ${fmt(report.errorChars)} chars removed`,
    `  truncate   ${fmt(report.truncateChars)} chars removed`,
    `  summarize  ${fmt(report.summarizeChars)} chars removed${config.level === 'summarize' ? '' : ' (pass not enabled at this level)'}`,
    `  total      ${fmt(removed)} chars removed (~ ${fmt(estimateTokens(removed))} tokens, ${pct}% of input)`,
  ];
}

async function main(): Promise<void> {
  const workload = buildBenchWorkload();
  const lines: string[] = [];
  lines.push(`broke bench - deterministic synthetic workload, shipped defaults (no LLM, stub summarizer)`);
  lines.push(`workload: ${workload.length} messages, ${fmt(messagesChars(workload))} chars (~ ${fmt(estimateTokens(messagesChars(workload)))} tokens)`);
  lines.push(`note: the summarize numbers replace the region with a fixed ${STUB_SUMMARY.length}-char stub summary; a real model's summary length varies, so those numbers are pipeline potential, not a model guarantee`);
  lines.push('');
  lines.push(...(await runScenario('level=truncate (shipped default)', { ...DEFAULT_CONFIG }, workload)));
  lines.push('');
  lines.push(...(await runScenario('level=summarize (maximum)', { ...DEFAULT_CONFIG, level: 'summarize' }, workload)));
  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
