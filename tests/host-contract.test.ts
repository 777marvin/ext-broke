/**
 * Host contract tests (review R13): drive the REAL Broke extension through
 * the complete event lifecycle in order - TaskInitialized -> ToolCalled ->
 * ToolFinished -> OptimizeMessages - and assert the two contracts that
 * matter most at the host boundary:
 *
 * 1. broke never breaks host operations: every hook resolves even when the
 *    host surface itself misbehaves (throwing getTaskContext, null outputs,
 *    empty message lists).
 * 2. state flows correctly between hooks: focus tracking feeds slicing,
 *    compression records stats, the UI sees honest data.
 *
 * Self-contained (no shared harness with index.test.ts) so both files stay
 * independently runnable and hermetic.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@aiderdesk/extensions';
import type { Config } from '../config';

const tmp = mkdtempSync(join(tmpdir(), 'broke-contract-'));
process.env.BROKE_CONFIG_PATH = join(tmp, 'config.json');
process.env.BROKE_STATS_PATH = join(tmp, 'stats.jsonl');
process.env.BROKE_MEASURE_PATH = join(tmp, 'measure.jsonl');
process.env.BROKE_ERRORS_DIR = join(tmp, 'errors');
process.env.BROKE_STATS_PERSIST_MIN_MS = '0';

let Broke: (typeof import('../index'))['default'];
let DEFAULT_CONFIG: (typeof import('../config'))['DEFAULT_CONFIG'];
let saveConfig: (typeof import('../config'))['saveConfig'];

before(async () => {
  ({ default: Broke } = await import('../index'));
  ({ DEFAULT_CONFIG, saveConfig } = await import('../config'));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface HostOpts {
  /** When set, getTaskContext throws instead of returning a task. */
  failGetTaskContext?: Error;
}

function makeHost(taskId: string, opts: HostOpts = {}): { context: ExtensionContext; task: Record<string, unknown> } {
  const task: Record<string, unknown> = {
    data: { id: taskId, provider: 'openai', model: 'gpt-4o', mainModel: 'gpt-4o' },
    getUpdatedFiles: async () => [],
    getTaskDir: async () => tmp,
    addLogMessage: async () => undefined,
    generateText: async () => 'contract summary',
    getModelConfigs: async () => [],
    getContextMessages: async () => [],
  };
  const context = {
    ...(opts.failGetTaskContext
      ? {}
      : {
          getTaskContext: () => {
            if (opts.failGetTaskContext) throw opts.failGetTaskContext;
            return task;
          },
        }),
    // Broken variant replaces the method entirely:
    ...(opts.failGetTaskContext ? { getTaskContext: () => { throw opts.failGetTaskContext!; } } : {}),
    log: () => undefined,
    triggerUIDataRefresh: () => undefined,
    triggerUIComponentsReload: () => undefined,
  };
  return { context: context as unknown as ExtensionContext, task };
}

/** Write an isolated config enabling every opt-in pass with tiny gates. */
function writeConfig(over: Partial<Config> = {}): Config {
  const config: Config = {
    ...DEFAULT_CONFIG,
    enabled: true,
    level: 'truncate',
    maxContextChars: 5_000,
    protectedTurns: 1,
    errors: { ...DEFAULT_CONFIG.errors, enabled: true, toolLevel: true, archive: false, minChars: 500 },
    slice: { ...DEFAULT_CONFIG.slice, enabled: true, minChars: 500, maxChars: 20_000, focusAuto: true },
    summarize: { ...DEFAULT_CONFIG.summarize, via: 'cloud', cloudModelId: '', afterTurns: 2, minChars: 2_000 },
    stats: { ...DEFAULT_CONFIG.stats, measure: true },
    ...over,
  };
  saveConfig(config);
  return config;
}

const BIG_TS_FILE = [
  'export interface Widget {',
  '  id: string;',
  '  render(at: number): string;',
  '}',
  '',
  'export class WidgetService {',
  ...Array.from({ length: 60 }, (_, i) => `  step${i}(): number { return ${i} * Math.random(); }`),
  '}',
].join('\n');

describe('host contract: full event lifecycle', () => {
  it('walks TaskInitialized -> ToolCalled -> ToolFinished -> OptimizeMessages', async () => {
    writeConfig();
    const ext = new Broke();
    const { context } = makeHost('contract-1');
    (ext as unknown as { context: ExtensionContext }).context = context;

    // 1. Task init must surface activity honestly (and survive a dead Ollama).
    await ext.onTaskInitialized({ task: { id: 'contract-1' } } as never, context);

    // 2. An edit-tool call establishes the slice focus.
    await ext.onToolCalled(
      { toolCallId: 'c1', toolName: 'power---file_edit', input: { filePath: join(tmp, 'focus.ts') }, agentProfile: {} } as never,
      context,
    );

    // 3a. Reading a NON-focus file yields a sliced view.
    const readEvent = {
      toolCallId: 'c2',
      toolName: 'power---file_read',
      input: { filePath: join(tmp, 'other.ts') },
      agentProfile: {},
      output: { content: [{ type: 'text', text: BIG_TS_FILE }] },
    };
    const sliced = await ext.onToolFinished(readEvent as never, context);
    assert.ok(sliced && typeof sliced === 'object', 'large non-focus read must be rewritten');
    const text1 = JSON.stringify((sliced as { output?: { content?: { text?: string }[] } }).output);
    assert.ok(text1.includes('[broke: interface view'), 'sliced view carries the marker');
    assert.ok(!text1.includes('Math.random()'), 'implementation detail elided');

    // 3b. Reading THE FOCUS file passes through in full.
    const focusEvent = { ...readEvent, toolCallId: 'c3', input: { filePath: join(tmp, 'focus.ts') } };
    const focus = await ext.onToolFinished(focusEvent as never, context);
    assert.ok(focus && typeof focus === 'object');
    assert.ok(JSON.stringify((focus as { output?: unknown }).output).includes('[broke: focus file'), 'focus marker present');

    // 3c. Command output with a stack trace gets error-compressed.
    const errEvent = {
      toolCallId: 'c4',
      toolName: 'power---bash',
      input: { command: 'pytest' },
      agentProfile: {},
      output: {
        stdout: '',
        stderr: ['Traceback (most recent call last):', '  File "app.py", line 42, in main', '    run()', `ValueError: boom${'!'.repeat(600)}`].join('\n'),
        exitCode: 1,
      },
    };
    const summarized = await ext.onToolFinished(errEvent as never, context);
    assert.ok(summarized && typeof summarized === 'object');
    assert.ok(JSON.stringify((summarized as { output?: unknown }).output).includes('[broke: error summary'), 'error summary marker present');

    // 4. OptimizeMessages compresses a large conversation.
    // A large OLD tool output (with proper call/result pairing) inside the
    // compressible region - the truncate pass's real target.
    const messages: unknown[] = [
      { id: 'u0', role: 'user', content: 'please build the widget feature' },
      { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'power---bash', input: { command: 'big-build' } }] },
      {
        id: 't1',
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'power---bash', output: { type: 'text', value: Array.from({ length: 900 }, (_, i) => `build line ${i}: ok`).join('\n') } }],
      },
      { id: 'u1', role: 'user', content: 'second turn' },
      { id: 'a2', role: 'assistant', content: 'more work happened here'.padEnd(400, '.') },
      { id: 'u2', role: 'user', content: 'third turn' },
      { id: 'a3', role: 'assistant', content: 'recent work'.padEnd(400, '.') },
      { id: 'u3', role: 'user', content: 'fourth turn - keep this visible' },
    ];
    const event = { originalMessages: messages, optimizedMessages: messages.slice() };
    const out = await ext.onOptimizeMessages(event as never, context);
    assert.ok(out && typeof out === 'object' && 'optimizedMessages' in (out as object), 'compression result returned');
    const compressed = (out as { optimizedMessages: unknown[] }).optimizedMessages;
    assert.ok(JSON.stringify(compressed).length < JSON.stringify(messages).length, 'payload shrunk');
    // The truncated tool result carries the standard marker.
    const t1 = compressed.find((m) => (m as { id?: string }).id === 't1') as { content: Array<{ output?: { value?: string } }> };
    assert.ok(t1.content[0].output?.value?.includes('[broke: truncated'), 'old tool output truncated with marker');
  });
});

describe('host contract: hooks never throw on hostile surfaces', () => {
  it('resolves every hook when getTaskContext throws', async () => {
    writeConfig();
    const ext = new Broke();
    const { context } = makeHost('x', { failGetTaskContext: new Error('host exploded') });

    await assert.doesNotReject(ext.onTaskInitialized({ task: { id: 'x' } } as never, context));
    await assert.doesNotReject(ext.onToolCalled({ toolName: 'power---file_edit', input: { filePath: 'a.ts' } } as never, context));
    await assert.doesNotReject(
      ext.onToolFinished({ toolCallId: 'c', toolName: 'power---bash', input: {}, agentProfile: {}, output: 'out' } as never, context),
    );
    await assert.doesNotReject(
      ext.onOptimizeMessages({ originalMessages: [], optimizedMessages: [] } as never, context),
    );
  });

  it('tolerates degenerate events: null output, empty messages, missing input', async () => {
    writeConfig();
    const ext = new Broke();
    const { context } = makeHost('y');
    (ext as unknown as { context: ExtensionContext }).context = context;

    await assert.doesNotReject(
      ext.onToolFinished({ toolCallId: 'c', toolName: 'power---file_read', input: { filePath: 'a.ts' }, agentProfile: {}, output: null } as never, context),
    );
    await assert.doesNotReject(
      ext.onToolFinished({ toolCallId: 'c', toolName: 'power---bash', input: undefined, agentProfile: {}, output: 42 } as never, context),
    );
    const empty = { originalMessages: [], optimizedMessages: [] };
    const res = await ext.onOptimizeMessages(empty as never, context);
    assert.equal(res, undefined, 'nothing to do -> undefined, not an error');
  });
});
