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
let buildSyntheticMessages: (typeof import('../selftest'))['buildSyntheticMessages'];

before(async () => {
  ({ default: Broke } = await import('../index'));
  ({ DEFAULT_CONFIG, saveConfig } = await import('../config'));
  ({ loadRunRecords, loadTaskStats, messagesChars } = await import('../tokens'));
  ({ buildSyntheticMessages } = await import('../selftest'));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface FakeHostState {
  summarizeCalls: number;
  generateTextCalls: string[];
  logLines: { level: string; line: string }[];
}

/** A task/context pair that satisfies the parts of the API broke actually uses. */
function makeHost(taskId: string, summarizeImpl: () => string | Promise<string>): { context: ExtensionContext; state: FakeHostState } {
  const state: FakeHostState = { summarizeCalls: 0, generateTextCalls: [], logLines: [] };
  const task = {
    data: { id: taskId, provider: 'openai', model: 'gpt-4o', mainModel: 'gpt-4o' },
    getTaskAgentProfile: async () => ({ provider: 'openai', model: 'gpt-4o' }),
    generateText: async (modelId: string) => {
      state.summarizeCalls += 1;
      state.generateTextCalls.push(modelId);
      return summarizeImpl();
    },
    addLogMessage: async (level: string, line: string) => {
      state.logLines.push({ level, line });
    },
  };
  const context = {
    log: () => undefined,
    getTaskContext: () => task,
    getModelConfigs: async () => [],
    triggerUIDataRefresh: () => undefined,
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
});
