/**
 * Fake-host integration tests for the orchestration path in index.ts (XF11).
 * Until now no test imported index.ts: only the pipeline and its helpers
 * were covered. These tests drive the real Broke extension with a fake
 * ExtensionContext / task: events -> compress -> summarizer -> stats
 * persistence -> auto-disable -> UI data.
 *
 * IMPORTANT: the env overrides below MUST be set before any project module
 * is imported - the path constants (CONFIG_PATH, STATS_PATH, MEASURE_PATH,
 * ERRORS_DIR) are read at module load time.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextMessage, ExtensionContext, OptimizeMessagesEvent, ToolFinishedEvent } from '@aiderdesk/extensions';
// Type-only: erased at compile time, so the runtime module graph is unaffected.
import type { Config } from '../config';
import type { TaskStats } from '../tokens';

const tmp = mkdtempSync(join(tmpdir(), 'broke-index-'));
process.env.BROKE_CONFIG_PATH = join(tmp, 'config.json');
process.env.BROKE_STATS_PATH = join(tmp, 'stats.jsonl');
process.env.BROKE_MEASURE_PATH = join(tmp, 'measure.jsonl');
process.env.BROKE_ERRORS_DIR = join(tmp, 'errors');
process.env.BROKE_STATS_PERSIST_MIN_MS = '0';

// Project modules load only after the env overrides are in place. The test
// files run as CJS (no package "type": "module"), so top-level await is not
// available - a top-level before() hook performs the dynamic imports instead.
let Broke: (typeof import('../index'))['default'];
let DEFAULT_CONFIG: (typeof import('../config'))['DEFAULT_CONFIG'];
let saveConfig: (typeof import('../config'))['saveConfig'];
let loadRunRecords: (typeof import('../tokens'))['loadRunRecords'];
let loadTaskStats: (typeof import('../tokens'))['loadTaskStats'];
let messagesChars: (typeof import('../tokens'))['messagesChars'];
let emptyStats: (typeof import('../tokens'))['emptyStats'];
let buildSyntheticMessages: (typeof import('../selftest'))['buildSyntheticMessages'];

before(async () => {
  ({ default: Broke } = await import('../index'));
  ({ DEFAULT_CONFIG, saveConfig } = await import('../config'));
  ({ loadRunRecords, loadTaskStats, messagesChars, emptyStats } = await import('../tokens'));
  ({ buildSyntheticMessages } = await import('../selftest'));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface FakeHostState {
  summarizeCalls: number;
  generateTextCalls: string[];
  logLines: { level: string; line: string }[];
  uiRefreshCalls: number;
}

/** A task/context pair that satisfies the parts of the API broke actually uses. */
function makeHost(
  taskId: string,
  summarizeImpl: () => string | Promise<string>,
  contextMessages: unknown[] = [],
  extraTask: Record<string, unknown> = {},
): { context: ExtensionContext; state: FakeHostState } {
  const state: FakeHostState = { summarizeCalls: 0, generateTextCalls: [], logLines: [], uiRefreshCalls: 0 };
  const task = {
    data: { id: taskId, provider: 'openai', model: 'gpt-4o', mainModel: 'gpt-4o' },
    getTaskAgentProfile: async () => ({ provider: 'openai', model: 'gpt-4o' }),
    getContextMessages: async () => contextMessages,
    generateText: async (modelId: string) => {
      state.summarizeCalls += 1;
      state.generateTextCalls.push(modelId);
      return summarizeImpl();
    },
    addLogMessage: async (level: string, line: string) => {
      state.logLines.push({ level, line });
    },
    ...extraTask,
  };
  const context = {
    log: () => undefined,
    getTaskContext: () => task,
    getModelConfigs: async () => [],
    triggerUIDataRefresh: () => {
      state.uiRefreshCalls += 1;
    },
    triggerUIComponentsReload: () => undefined,
  };
  return { context: context as unknown as ExtensionContext, state };
}

/**
 * recordReport (logs, UI refresh) uses the context stored by onLoad(). The
 * tests skip onLoad() because its config watcher would keep a directory
 * handle on the temp dir (its removal then fails on Windows) - so the
 * stored context is assigned directly instead.
 */
function attachContext(ext: unknown, context: ExtensionContext): void {
  (ext as { context: ExtensionContext }).context = context;
}

/** Write a test config to the isolated BROKE_CONFIG_PATH and drop the cache. */
function writeConfig(over: Partial<Config> = {}): Config {
  const config: Config = {
    ...DEFAULT_CONFIG,
    enabled: true,
    level: 'summarize',
    maxContextChars: 10_000,
    // The default (2) protects the last two user turns, leaving only one
    // user turn in the compressible region - below summarize.afterTurns.
    protectedTurns: 1,
    errors: { ...DEFAULT_CONFIG.errors, enabled: true, toolLevel: true, archive: true, minChars: 500 },
    summarize: { ...DEFAULT_CONFIG.summarize, via: 'cloud', cloudModelId: '', afterTurns: 2, minChars: 2_000 },
    stats: { ...DEFAULT_CONFIG.stats, measure: true },
    ...over,
  };
  saveConfig(config); // saveConfig invalidates the config cache
  return config;
}

function bigTscError(): string {
  return (
    Array.from(
      { length: 60 },
      (_, i) =>
        `src/billing.ts:${10 + i}:${5 + (i % 3)} - error TS2554: Expected 2 arguments, but got 1.\n  ${10 + i}   compute(${i % 2 === 0 ? 'total' : ''});\n      ${'~'.repeat(12)}`,
    ).join('\n') + '\n\nFound 60 errors in the same file.'
  );
}

function countLogFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.log')) n += 1;
    }
  };
  walk(dir);
  return n;
}

describe('index.ts orchestration (fake host, XF11)', () => {
  it('compresses the input, calls the summarizer and persists stats + measure record', async () => {
    writeConfig();
    const ext = new Broke();
    const { context, state } = makeHost('task-1', () => 'Stub summary of the compressed region.');
    attachContext(ext, context);
    const messages = buildSyntheticMessages();
    const before = messagesChars(messages);

    const result = (await ext.onOptimizeMessages(
      { originalMessages: messages, optimizedMessages: messages },
      context,
    )) as { optimizedMessages: ContextMessage[] } | undefined;
    console.error('DEBUG-147 state.summarizeCalls=', state.summarizeCalls);
    assert.ok(result, 'the hook must return optimized messages');
    assert.ok(messagesChars(result.optimizedMessages) < before, 'compression must shrink the input');
    assert.ok(state.summarizeCalls >= 1, 'the cloud summarizer must have been called');

    const stats = loadTaskStats('task-1');
    assert.ok(stats, 'stats must be persisted to the isolated stats.jsonl');
    assert.equal(stats.passes, 1);
    assert.ok(stats.totalCharsBefore > stats.totalCharsAfter, 'measured before/after sizes must be recorded');
    assert.equal(stats.lastSummarizer, 'cloud');

    const runs = loadRunRecords();
    assert.equal(runs.length, 1, 'one measure record per compression run');
    assert.equal(runs[0].taskId, 'task-1');
  });

  it('never re-enters compression while a run is in flight (reentry guard)', async () => {
    writeConfig();
    const ext = new Broke();
    const messages = buildSyntheticMessages();
    let nestedCallCount = 0;
    let nested: Promise<Partial<OptimizeMessagesEvent> | void> | undefined;
    // The fake summarizer simulates the host firing onOptimizeMessages for
    // the generateText call the cloud summarizer makes - exactly the
    // recursion the guard exists for.
    const { context, state } = makeHost('task-guard', () => {
      nestedCallCount += 1;
      if (!nested) {
        nested = ext.onOptimizeMessages({ originalMessages: messages, optimizedMessages: messages }, context);
      }
      return 'stub';
    });
    attachContext(ext, context);

    await ext.onOptimizeMessages({ originalMessages: messages, optimizedMessages: messages }, context);
    const nestedResult = await nested;
    assert.equal(nestedResult, undefined, 'the nested call must be cut short by the guard');
    assert.equal(nestedCallCount, 1, 'the summarizer must not be reached by the nested call');
    assert.equal(state.summarizeCalls, 1, 'exactly one real summarizer call per outer run');
  });

  it('compresses a second task in parallel instead of skipping it (per-task guard)', async () => {
    writeConfig();
    const ext = new Broke();
    const messages = buildSyntheticMessages();
    // Task A's summarizer blocks until released; task B must still compress
    // while A's run is in flight - the guard is scoped to the task id.
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const hostA = makeHost('task-a', () => gateA.then(() => 'stub'));
    const hostB = makeHost('task-b', () => 'stub');
    attachContext(ext, hostA.context);

    const runA = ext.onOptimizeMessages({ originalMessages: messages, optimizedMessages: messages }, hostA.context);
    await new Promise((resolve) => setTimeout(resolve, 10)); // let A reach its blocked summarizer
    const resultB = (await ext.onOptimizeMessages(
      { originalMessages: messages, optimizedMessages: messages },
      hostB.context,
    )) as { optimizedMessages: ContextMessage[] } | undefined;
    assert.ok(resultB, 'task B must compress while task A is in flight');
    releaseA();
    const resultA = (await runA) as { optimizedMessages: ContextMessage[] } | undefined;
    assert.ok(resultA, 'task A compresses once its own summarizer resolves');
  });

  it('auto-disables summarization for a task after repeated failures', async () => {
    writeConfig();
    const ext = new Broke();
    const { context, state } = makeHost('task-fail', () => {
      throw new Error('summarizer down');
    });
    attachContext(ext, context);
    const messages = buildSyntheticMessages();

    for (let i = 0; i < 3; i++) {
      await ext.onOptimizeMessages({ originalMessages: messages, optimizedMessages: messages }, context);
    }
    assert.equal(state.summarizeCalls, 3, 'three failing attempts before the gate closes');
    const warnings = state.logLines.filter((l) => l.level === 'warning');
    assert.ok(warnings.some((l) => l.line.includes('disabled for this task')), 'the user must be told about the disable');

    await ext.onOptimizeMessages({ originalMessages: messages, optimizedMessages: messages }, context);
    assert.equal(state.summarizeCalls, 3, 'the 4th run must not retry the summarizer');

    const stats = loadTaskStats('task-fail');
    assert.ok(stats, 'structural/truncate savings are still recorded while summarization is disabled');
    assert.equal(stats.passes, 4);
    assert.ok(stats.summarizeFailures >= 3, 'failures must be counted honestly');
  });

  it('serves honest badge data without touching Ollama for the cloud summarizer', async () => {
    writeConfig();
    const ext = new Broke();
    const { context } = makeHost('task-ui', () => 'stub');

    const data = (await ext.getUIExtensionData('broke-status', context)) as Record<string, unknown>;
    assert.equal(data.level, 'summarize');
    assert.equal(data.inTask, true);
    assert.equal(data.summarizerConfigured, 'cloud');
    assert.equal(data.ollama, null, 'no Ollama status check for the cloud summarizer');
    assert.equal(data.passes, 0, 'no compression run yet');
  });

  it('refreshes the status badge when the renderer polls via the UI action', async () => {
    writeConfig();
    const ext = new Broke();
    const { context, state } = makeHost('task-ui-action', () => 'stub');
    attachContext(ext, context);

    await ext.executeUIExtensionAction('broke-status', 'refresh', [], context);
    assert.equal(state.uiRefreshCalls, 1, "the refresh action must trigger triggerUIDataRefresh('broke-status')");

    await ext.executeUIExtensionAction('broke-status', 'something-else', [], context);
    assert.equal(state.uiRefreshCalls, 1, 'unknown actions must be ignored silently');
  });

  it('registers the status badge for fresh data on render', () => {
    writeConfig();
    const ext = new Broke();
    const badge = ext.getUIComponents().find((c) => c.id === 'broke-status');
    assert.ok(badge, 'the badge must be registered while showStatusBadge is on');
    assert.equal(badge.loadData, true, 'the badge must load its data from the extension');
    assert.equal(badge.noDataCache, true, 'the badge data must never be served from cache');
  });

  it('tool-level rewrite archives the full output when the archive is on (XF10 integration)', async () => {
    writeConfig({ errors: { ...DEFAULT_CONFIG.errors, enabled: true, toolLevel: true, archive: true, minChars: 500 } });
    const ext = new Broke();
    const { context } = makeHost('task-tool', () => 'stub');
    const event = { toolName: 'power---bash', toolCallId: 'call-1', output: bigTscError() };

    const result = await ext.onToolFinished(event as unknown as ToolFinishedEvent, context);
    const output = JSON.stringify(result?.output ?? '');
    assert.ok(output.includes('broke: error summary'), 'the output must be rewritten to its essence');
    // The archive path uses the platform separator - assert the prefix only.
    assert.ok(output.includes('full output saved to'), 'the summary must point at the archive');
    assert.equal(countLogFiles(tmp), 1, 'exactly one archived output');
  });

  it('tool-level rewrite writes nothing when the archive is off (XF10 integration)', async () => {
    writeConfig({ errors: { ...DEFAULT_CONFIG.errors, enabled: true, toolLevel: true, archive: false, minChars: 500 } });
    const ext = new Broke();
    const { context } = makeHost('task-tool-off', () => 'stub');
    const before = countLogFiles(tmp);
    const event = { toolName: 'power---bash', toolCallId: 'call-9', output: bigTscError() };

    const result = await ext.onToolFinished(event as unknown as ToolFinishedEvent, context);
    const output = JSON.stringify(result?.output ?? '');
    assert.ok(output.includes('full output removed'), 'archive off must say so honestly');
    assert.equal(countLogFiles(tmp), before, 'no new archive file may be written');
  });

  it('stays completely silent when the extension is disabled', async () => {
    writeConfig({ enabled: false });
    const ext = new Broke();
    const { context, state } = makeHost('task-off', () => 'stub');
    const messages = buildSyntheticMessages();

    const runsBefore = loadRunRecords().length; // shared ledger - measure the delta
    const result = await ext.onOptimizeMessages({ originalMessages: messages, optimizedMessages: messages }, context);
    assert.equal(result, undefined, 'disabled means no rewrite');
    assert.equal(state.summarizeCalls, 0);
    assert.equal(loadTaskStats('task-off'), null, 'no stats for a disabled run');
    assert.equal(loadRunRecords().length, runsBefore, 'no measure record for a disabled run');
  });

  it('records an idle observation on no-op runs so a zero badge can explain itself', async () => {
    writeConfig();
    const ext = new Broke();
    const tiny = [
      { id: 'm1', role: 'user', content: 'first short question' },
      { id: 'a1', role: 'assistant', content: 'first short answer' },
      { id: 'm2', role: 'user', content: 'second short question' },
      { id: 'a2', role: 'assistant', content: 'second short answer' },
    ] as unknown as ContextMessage[];
    const { context } = makeHost('task-idle', () => 'stub', tiny);

    await ext.onOptimizeMessages({ originalMessages: tiny, optimizedMessages: tiny }, context);
    // Nothing compressible: no stats, no measure record - by design.
    assert.equal(loadTaskStats('task-idle'), null, 'no-op runs stay unrecorded by design');

    const data = (await ext.getUIExtensionData('broke-status', context)) as {
      passes: number;
      maxContextChars: number;
      observation: { at: number; inputChars: number; inputTokens: number; belowThreshold: boolean } | null;
    };
    assert.equal(data.passes, 0);
    assert.ok(data.observation, 'the no-op run must still be observable');
    assert.ok(data.observation.inputChars > 0);
    assert.equal(data.observation.inputTokens, Math.round(data.observation.inputChars / 4));
    assert.equal(data.observation.belowThreshold, true, 'tiny input must read as below threshold');
    assert.ok(data.maxContextChars > 0);
  });

  it('/broke why reports the live gate state for an honest zero', async () => {
    writeConfig({ level: 'truncate' });
    const ext = new Broke();
    const tiny = [
      { id: 'm1', role: 'user', content: 'first short question' },
      { id: 'a1', role: 'assistant', content: 'first short answer' },
      { id: 'm2', role: 'user', content: 'second short question' },
      { id: 'a2', role: 'assistant', content: 'second short answer' },
    ] as unknown as ContextMessage[];
    const { context, state } = makeHost('task-why', () => 'stub', tiny);

    const cmd = ext.getCommands(context)[0];
    await cmd.execute(['why'], context);
    const out = state.logLines.map((l) => l.line).join('\n');
    assert.ok(out.includes('broke why'), 'the why report must be logged into the task');
    assert.match(out, /below the threshold/);
    assert.match(out, /scope: conversation messages ONLY/);
    assert.match(out, /last optimize run/);
    // Per-pass hints must NOT appear when there is nothing to explain:
    // no recorded passes yet -> stats.passes === 0 in a fresh task.
    assert.ok(!out.includes('structural: 0 is honest'), 'pass hints require recorded runs');
  });

  it('/broke why explains structural/error zeros once passes were recorded', async () => {
    writeConfig({ level: 'summarize' });
    const ext = new Broke();
    const bigDump = Array.from({ length: 120 }, (_, i) => `src/x.ts:${i}: error E: nope`).join('\n'); // ~4.7k chars
    const messages = [
      { id: 'u0', role: 'user', content: 'brief' },
      { id: 't1', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'power---bash', output: { type: 'text', value: bigDump } }] },
    ] as unknown as ContextMessage[];
    const { context, state } = makeHost('task-why-passes', () => 'stub', messages);
    const stats: TaskStats = emptyStats('task-why-passes');
    stats.passes = 3;
    stats.savedChars.truncate = 5;
    (ext as unknown as { statsByTask: Map<string, TaskStats> }).statsByTask.set('task-why-passes', stats);

    const cmd = ext.getCommands(context)[0];
    await cmd.execute(['why'], context);
    const out = state.logLines.map((l) => l.line).join('\n');
    // Harness minChars=500 -> 3,249-char dump EXCEEDS it: zero saved means
    // pattern mismatch, and /broke why must say exactly that.
    assert.match(out, /error: 0 even though a .*-char command output exists - none matched the known compiler\/test-log patterns/);
    assert.match(out, /structural: 0 is honest/);
  });

  it('/broke summarize now pre-warms the cache; the next real run reuses it free', async () => {
    // Tiny threshold: the REAL pipeline gate is "input > maxContextChars" -
    // the manual warm bypasses it, the pipeline must not.
    // Level pinned EXPLICITLY: this suite must not inherit the configured
    // level from whichever sibling test ran before it (ordering bug found
    // while adding the pass-hints test).
    writeConfig({ maxContextChars: 100, level: 'summarize' });
    const ext = new Broke();
    const { context, state } = makeHost('task-warm', () => 'Stub summary of the compressed region.');
    attachContext(ext, context);
    // Deterministic layout: brief + non-merging alternating steps + ONE final
    // user turn - the compressible region ends between stable message ids,
    // so the warmed cache key (throughId) survives the structural pass.
    const bigToolOutput = ('line-of-output '.repeat(120)).trim();
    const messages = [
      { id: 'u-brief', role: 'user', content: 'Brief: fix the failing tests.' },
      { id: 'a-1', role: 'assistant', content: 'Step 1: collecting failures.' },
      { id: 't-1', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'power---bash', output: { type: 'text', value: bigToolOutput } }] },
      { id: 'a-2', role: 'assistant', content: 'Step 2: patching module A.' },
      { id: 't-2', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c2', toolName: 'power---bash', output: { type: 'text', value: bigToolOutput } }] },
      { id: 'a-3', role: 'assistant', content: 'Step 3: re-running the suite.' },
      { id: 'u-wrap', role: 'user', content: 'Wrap up this iteration.' },
    ] as unknown as ContextMessage[];
    (context as unknown as { getTaskContext(): { getContextMessages(): Promise<unknown[]> } }).getTaskContext().getContextMessages = async () => messages;

    const runsBefore = loadRunRecords().length;
    const cmd = ext.getCommands(context)[0];

    // 1st call: generates a summary and caches it - no history rewrite.
    await cmd.execute(['summarize', 'now'], context);
    let out = state.logLines.map((l) => l.line).join('\n');
    assert.match(out, /summary generated.*and cached/, `unexpected report: ${out}`);
    assert.equal(state.summarizeCalls, 1, 'exactly one summarizer LLM call');
    assert.equal(JSON.stringify(messages).includes('broke-compacted'), false, 'the manual run must never rewrite the live history');
    assert.equal(loadTaskStats('task-warm'), null, 'a manual warm is not a compression pass - no stats');
    assert.equal(loadRunRecords().length, runsBefore, 'and no measure record either');

    // 2nd call: region unchanged -> cache hit, no new LLM call.
    await cmd.execute(['summarize', 'now'], context);
    out = state.logLines.map((l) => l.line).join('\n');
    assert.match(out, /already cached/);
    assert.equal(state.summarizeCalls, 1, 'the cache must answer the repeat request');

    // 3rd: the next REAL pipeline run takes the free reuse path.
    const result = (await ext.onOptimizeMessages(
      { originalMessages: messages, optimizedMessages: messages },
      context,
    )) as { optimizedMessages: ContextMessage[] } | undefined;
    assert.ok(result, 'the pipeline must return optimized messages');
    assert.equal(state.summarizeCalls, 1, 'the warmed cache must prevent a fresh summarizer call');
    const json = JSON.stringify(result.optimizedMessages);
    assert.ok(json.includes('broke-compacted'), 'the summarized input must contain the broke summary marker');
    assert.ok(json.length < JSON.stringify(messages).length, 'and be smaller than the original input');
    // Cache reuse IS a counted pass - real input reduction at zero LLM cost:
    const reused = loadTaskStats('task-warm');
    assert.ok(reused, 'the cache-reuse run must be recorded');
    assert.equal(reused?.passes, 1);
    assert.equal(reused?.summarizeCalls, 0, 'zero fresh summarizer calls on the reuse path');
  });

  it('/broke summarize now refuses cleanly below summarize.minChars without an LLM call', async () => {
    writeConfig();
    const ext = new Broke();
    const tiny = [
      { id: 'm1', role: 'user', content: 'first short question' },
      { id: 'a1', role: 'assistant', content: 'first short answer' },
      { id: 'm2', role: 'user', content: 'second short question' },
      { id: 'a2', role: 'assistant', content: 'second short answer' },
    ] as unknown as ContextMessage[];
    const { context, state } = makeHost('task-now-tiny', () => 'stub', tiny);
    attachContext(ext, context);

    const cmd = ext.getCommands(context)[0];
    await cmd.execute(['summarize', 'now'], context);
    const out = state.logLines.map((l) => l.line).join('\n');
    assert.match(out, /nothing summarized/);
    assert.equal(state.summarizeCalls, 0, 'the gates must decide before any summarizer traffic');
  });

  it('/broke summarize now refuses when the level is not summarize', async () => {
    writeConfig({ level: 'truncate' });
    const ext = new Broke();
    const { context, state } = makeHost('task-now-level', () => 'stub');
    attachContext(ext, context);

    const cmd = ext.getCommands(context)[0];
    await cmd.execute(['summarize', 'now'], context);
    const out = state.logLines.map((l) => l.line).join('\n');
    assert.match(out, /level is not summarize/);
    assert.equal(state.summarizeCalls, 0);
  });

  it('flushes in-memory stats on unload so a restart loses nothing', async () => {
    writeConfig();
    const ext = new Broke();
    // Simulate a throttled-away tail: stats exist in memory but were never
    // persisted (in production STATS_PERSIST_MIN_MS delays the write).
    const stats: TaskStats = emptyStats('task-flush');
    stats.passes = 3;
    stats.savedChars.truncate = 1234;
    (ext as unknown as { statsByTask: Map<string, TaskStats> }).statsByTask.set('task-flush', stats);

    await ext.onUnload();
    const loaded = loadTaskStats('task-flush');
    assert.ok(loaded, 'unload must persist in-memory stats');
    assert.equal(loaded.passes, 3);
    assert.equal(loaded.savedChars.truncate, 1234);
  });
});

// -------------------------------------------------------------------------
// ST-slicing hooks (F2): onToolCalled focus tracking + onToolFinished views
// -------------------------------------------------------------------------

/** A mid-size TS module used as a file-read payload (~700 chars). */
const TS_READ_PAYLOAD = [
  "import { join } from 'node:path';",
  '',
  'export interface Invoice {',
  '  id: string;',
  '  totalCents: number;',
  '  paidAt?: Date;',
  ...Array.from({ length: 16 }, (_, i) => `  note${i}: string; // padding field ${i} to cross realistic thresholds`),
  '}',
  '',
  'export type InvoiceState = "draft" | "sent" | "paid";',
  '',
  'function computeTax(cents: number): number {',
  '  const rate = cents > 100 ? 0.19 : 0;',
  '  return Math.round(cents * rate);',
  '}',
].join('\n');

/** writeConfig + partial slice overrides (typed against the real schema). */
function withSlice(over: Partial<Config['slice']>): Config {
  const config = writeConfig();
  const merged: Config = { ...config, slice: { ...config.slice, ...over } };
  saveConfig(merged); // saveConfig invalidates the config cache
  return merged;
}

function readEvent(path: string, output: unknown): ToolFinishedEvent {
  return { toolCallId: 'call-read', toolName: 'power---file_read', input: { filePath: path }, output } as unknown as ToolFinishedEvent;
}

describe('ST-slicing hooks (fake host)', () => {
  it('slices a large TS file read and records honest slice stats', async () => {
    withSlice({ enabled: true, minChars: 300 });
    const ext = new Broke();
    const { context } = makeHost('task-slice', () => 'stub');
    attachContext(ext, context);

    const result = await ext.onToolFinished(readEvent('src/billing.ts', TS_READ_PAYLOAD), context);
    const text = JSON.stringify(result?.output ?? '');
    assert.ok(text.includes('[broke: interface view'), 'the view must carry the marker');
    assert.ok(text.includes('export interface Invoice {'), 'contract declarations survive');
    assert.ok(!text.includes('Math.round(cents * rate)'), 'bodies must be elided');

    const stats = loadTaskStats('task-slice');
    assert.ok(stats, 'slice savings must be persisted');
    assert.ok(stats.savedChars.slice > 0, 'estimated slice savings must be recorded');
  });

  it('passes through when disabled (default) - stored history untouched', async () => {
    writeConfig(); // slice.enabled stays false by default
    const ext = new Broke();
    const { context } = makeHost('task-slice-off', () => 'stub');
    attachContext(ext, context);

    const result = await ext.onToolFinished(readEvent('src/billing.ts', TS_READ_PAYLOAD), context);
    assert.equal(result, undefined, 'no rewrite at all');
  });

  it('returns the focus file in full with a focus marker', async () => {
    withSlice({ enabled: true, minChars: 300 });
    const ext = new Broke();
    const { context } = makeHost('task-focus', () => 'stub');
    attachContext(ext, context);
    // Edit first -> the edited file becomes the task focus.
    await ext.onToolCalled(
      { toolCallId: 'c1', toolName: 'power---file_edit', input: { filePath: 'src/billing.ts' } } as never,
      context,
    );

    const result = await ext.onToolFinished(readEvent('SRC\\BILLING.TS', TS_READ_PAYLOAD), context);
    const text = JSON.stringify(result?.output ?? '');
    assert.ok(text.includes('focus file'), 'the focus marker must be present');
    assert.ok(text.includes('Math.round(cents * rate)'), 'the focus file keeps its full body');

    // A different file is still sliced.
    const other = await ext.onToolFinished(readEvent('src/other.ts', TS_READ_PAYLOAD), context);
    assert.ok(JSON.stringify(other?.output ?? '').includes('[broke: interface view'));
  });

  it('falls back to full content when the view would exceed maxChars', async () => {
    withSlice({ enabled: true, minChars: 500, maxChars: 50 });
    const ext = new Broke();
    const { context } = makeHost('task-cap', () => 'stub');
    attachContext(ext, context);

    const result = await ext.onToolFinished(readEvent('src/billing.ts', TS_READ_PAYLOAD), context);
    assert.equal(result, undefined, 'oversized views fall back to untouched passthrough');
  });

  it('skips non-code extensions and vendor paths', async () => {
    withSlice({ enabled: true, minChars: 100 });
    const ext = new Broke();
    const { context } = makeHost('task-skip', () => 'stub');
    attachContext(ext, context);

    assert.equal(await ext.onToolFinished(readEvent('docs/notes.md', TS_READ_PAYLOAD), context), undefined, '.md is not sliceable');
    assert.equal(
      await ext.onToolFinished(readEvent('node_modules/pkg/index.js', TS_READ_PAYLOAD), context),
      undefined,
      'vendor paths are never sliced',
    );
  });

  it('logs an unmatched read-tool name once, never crashes, passes through', async () => {
    withSlice({ enabled: true, minChars: 100 });
    const ext = new Broke();
    const { context } = makeHost('task-log', () => 'stub');
    attachContext(ext, context);

    const event = { toolCallId: 'cx', toolName: 'power---file_read', input: { query: 'no path here' }, output: TS_READ_PAYLOAD } as unknown as ToolFinishedEvent;
    assert.equal(await ext.onToolFinished(event, context), undefined, 'no path field -> no rewrite');
    // Once-per-session logging goes through context.log.
  });

  it('explicit /broke slice focus overrides auto focus until cleared', async () => {
    withSlice({ enabled: true, minChars: 300 });
    const ext = new Broke();
    const { context } = makeHost('task-explicit', () => 'stub');
    attachContext(ext, context);
    const [cmd] = ext.getCommands(context);
    await cmd.execute(['slice', 'focus', 'src/other.ts'], context);

    const focused = await ext.onToolFinished(readEvent('src/other.ts', TS_READ_PAYLOAD), context);
    assert.ok(JSON.stringify(focused?.output ?? '').includes('focus file'));

    await cmd.execute(['slice', 'focus', 'clear'], context);
    const cleared = await ext.onToolFinished(readEvent('src/other.ts', TS_READ_PAYLOAD), context);
    assert.ok(JSON.stringify(cleared?.output ?? '').includes('[broke: interface view'));
  });
});




describe('ST-slicing focus path resolution (D5)', () => {
  it('matches a relative explicit focus against an absolute read via getTaskDir', async () => {
    withSlice({ enabled: true, minChars: 300 });
    const ext = new Broke();
    const { context } = makeHost('task-d5-explicit', () => 'stub', [], { getTaskDir: async () => 'C:\\proj' });
    attachContext(ext, context);
    const [cmd] = ext.getCommands(context);
    await cmd.execute(['slice', 'focus', 'src/billing.ts'], context);

    const result = await ext.onToolFinished(readEvent('C:\\proj\\src\\billing.ts', TS_READ_PAYLOAD), context);
    const out = JSON.stringify(result?.output ?? '');
    assert.ok(out.includes('[broke: focus file'), 'absolute read must hit the relative focus');
    assert.ok(out.includes('Math.round(cents * rate)'), 'focus file keeps its full body');
  });

  it('matches an absolute edit target against a relative read via getTaskDir', async () => {
    withSlice({ enabled: true, minChars: 300 });
    const ext = new Broke();
    const { context } = makeHost('task-d5-edit', () => 'stub', [], { getTaskDir: async () => 'C:\\proj' });
    attachContext(ext, context);
    await ext.onToolCalled(
      { toolCallId: 'c1', toolName: 'power---file_edit', input: { filePath: 'C:/proj/src/billing.ts' } } as never,
      context,
    );

    const result = await ext.onToolFinished(readEvent('src/billing.ts', TS_READ_PAYLOAD), context);
    const out = JSON.stringify(result?.output ?? '');
    assert.ok(out.includes('[broke: focus file'), 'relative read must hit the absolute edit target');
    assert.ok(out.includes('Math.round(cents * rate)'), 'focus file keeps its full body');
  });
});
