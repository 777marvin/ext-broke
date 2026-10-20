/**
 * Cache-control helpers and the 0.88 `onApplyCacheControl` prefix anchor.
 *
 * `anchorBreakpoint` is the pure, host-free core: it puts ONE provider cache
 * breakpoint on a chosen message, MERGING into whatever `providerOptions` are
 * already there, and never mutating its input. The hook places that breakpoint
 * at the LAST already-sent message (the byte-stable prefix) instead of the
 * host default's moving tail - opt-in, Anthropic only, reentry-guarded.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApplyCacheControlEvent, ContextMessage, ExtensionContext, OptimizeMessagesEvent } from '@aiderdesk/extensions';
import { ANTHROPIC_BREAKPOINT, anchorBreakpoint } from '../cachecontrol';

const tmp = mkdtempSync(join(tmpdir(), 'broke-cc-'));
process.env.BROKE_CONFIG_PATH = join(tmp, 'config.json');
process.env.BROKE_STATS_PATH = join(tmp, 'stats.jsonl');
process.env.BROKE_MEASURE_PATH = join(tmp, 'measure.jsonl');
process.env.BROKE_ERRORS_DIR = join(tmp, 'errors');
process.env.BROKE_INDEX_DIR = join(tmp, 'indexdir');
process.env.BROKE_STATS_PERSIST_MIN_MS = '0';

let Broke: (typeof import('../index'))['default'];
let DEFAULT_CONFIG: (typeof import('../config'))['DEFAULT_CONFIG'];
let saveConfig: (typeof import('../config'))['saveConfig'];
let loadRunRecords: (typeof import('../tokens'))['loadRunRecords'];
type Config = import('../config').Config;

before(async () => {
  ({ default: Broke } = await import('../index'));
  ({ DEFAULT_CONFIG, saveConfig } = await import('../config'));
  ({ loadRunRecords } = await import('../tokens'));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const msg = (id: string, text: string, providerOptions?: Record<string, Record<string, unknown>>): ContextMessage =>
  ({ id, role: 'user', content: text, ...(providerOptions ? { providerOptions } : {}) }) as unknown as ContextMessage;

describe('cachecontrol: anchorBreakpoint (pure)', () => {
  it('places the Anthropic ephemeral breakpoint on the anchor message', () => {
    const out = anchorBreakpoint([msg('a', 'a'), msg('b', 'b'), msg('c', 'c')], 1, ANTHROPIC_BREAKPOINT);
    const target = out[1] as { providerOptions?: Record<string, Record<string, unknown>> };
    assert.deepEqual(target.providerOptions, { anthropic: { cacheControl: { type: 'ephemeral' } } });
    assert.equal((out[0] as { providerOptions?: unknown }).providerOptions, undefined, 'other messages untouched');
    assert.equal((out[2] as { providerOptions?: unknown }).providerOptions, undefined);
  });

  it('merges into existing providerOptions and keeps every prior key', () => {
    const out = anchorBreakpoint(
      [msg('a', 'a'), msg('b', 'b', { openai: { promptCacheKey: 'task-1' }, anthropic: { someOtherFlag: true } })],
      1,
      ANTHROPIC_BREAKPOINT,
    );
    const target = out[1] as { providerOptions?: Record<string, Record<string, unknown>> };
    assert.deepEqual(target.providerOptions, {
      openai: { promptCacheKey: 'task-1' },
      anthropic: { someOtherFlag: true, cacheControl: { type: 'ephemeral' } },
    });
  });

  it('merges one nested level, so siblings inside cacheControl survive', () => {
    const out = anchorBreakpoint(
      [msg('a', 'a'), msg('b', 'b', { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } })],
      1,
      ANTHROPIC_BREAKPOINT,
    );
    const target = out[1] as { providerOptions?: Record<string, Record<string, unknown>> };
    assert.deepEqual(target.providerOptions, { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } });
  });

  it('is a no-op for an out-of-range or negative anchor (returns the input unchanged)', () => {
    const input = [msg('a', 'a'), msg('b', 'b')];
    assert.equal(anchorBreakpoint(input, -1, ANTHROPIC_BREAKPOINT), input);
    assert.equal(anchorBreakpoint(input, 2, ANTHROPIC_BREAKPOINT), input);
    assert.equal(anchorBreakpoint([], 0, ANTHROPIC_BREAKPOINT).length, 0);
  });

  it('never mutates the input array or its elements', () => {
    const element = msg('b', 'b');
    const input = [msg('a', 'a'), element];
    const snapshot = JSON.stringify(input);
    const out = anchorBreakpoint(input, 1, ANTHROPIC_BREAKPOINT);
    assert.notEqual(out, input, 'a new array is returned when the anchor is valid');
    assert.equal(JSON.stringify(input), snapshot, 'the input was not mutated');
    assert.equal((element as { providerOptions?: unknown }).providerOptions, undefined, 'the input element was not mutated');
  });
});

// ---------------------------------------------------------------------------
// The hook, driven through the REAL extension.
// ---------------------------------------------------------------------------

function cfg(over: Partial<Config> = {}): Config {
  const config: Config = {
    ...DEFAULT_CONFIG,
    enabled: true,
    level: 'structural',
    // A huge budget keeps the small fixtures identity-compressed, so output
    // indices line up with input indices.
    maxContextChars: 1_000_000,
    protectedTurns: 1,
    errors: { ...DEFAULT_CONFIG.errors, enabled: false },
    stats: { ...DEFAULT_CONFIG.stats, measure: true },
    cache: { profile: 'anthropic', escapeHatch: true, openaiStateless: false, anchorBreakpoint: true },
    ...over,
  };
  saveConfig(config);
  return config;
}

function host(taskId: string, provider = 'anthropic', model = 'claude-sonnet-4'): ExtensionContext {
  const task = {
    data: { id: taskId, provider, model, mainModel: model },
    getTaskAgentProfile: async () => ({ provider, model }),
    getContextMessages: async () => [],
    getModelConfigs: async () => [],
    addLogMessage: async () => undefined,
  };
  return {
    log: () => undefined,
    getTaskContext: () => task,
    triggerUIDataRefresh: () => undefined,
    triggerUIComponentsReload: () => undefined,
  } as unknown as ExtensionContext;
}

async function optimize(ext: InstanceType<typeof Broke>, context: ExtensionContext, messages: ContextMessage[]): Promise<ContextMessage[]> {
  const event = { originalMessages: messages, optimizedMessages: messages.slice() } as unknown as OptimizeMessagesEvent;
  const out = await ext.onOptimizeMessages(event, context);
  if (!out || typeof out !== 'object' || !('optimizedMessages' in out)) return messages;
  return (out as { optimizedMessages: ContextMessage[] }).optimizedMessages;
}

/** Two runs: the first sends a 3-message prefix, the second extends it with 2 new turns. */
async function primeAnExtend(ext: InstanceType<typeof Broke>, context: ExtensionContext, extra: Record<string, Record<string, unknown>> = {}): Promise<ContextMessage[]> {
  const prefix = [msg('m0', 'alpha'), msg('m1', 'beta'), msg('m2', 'gamma', extra && Object.keys(extra).length ? extra : undefined)];
  await optimize(ext, context, prefix);
  const full = [msg('m0', 'alpha'), msg('m1', 'beta'), msg('m2', 'gamma', extra && Object.keys(extra).length ? extra : undefined), msg('m3', 'delta'), msg('m4', 'epsilon')];
  await optimize(ext, context, full);
  return full;
}

describe('onApplyCacheControl: prefix anchor (opt-in, Anthropic only)', () => {
  it('places exactly one marker on the last already-sent message', async () => {
    cfg();
    const ext = new Broke();
    const context = host('cc-one');
    (ext as unknown as { context: ExtensionContext }).context = context;

    const full = await primeAnExtend(ext, context);
    const out = (await ext.onApplyCacheControl({ originalMessages: full, messages: full } as ApplyCacheControlEvent, context)) as
      | { messages: ContextMessage[] }
      | undefined;
    assert.ok(out && Array.isArray(out.messages), 'the hook returned messages');
    assert.deepEqual((out.messages[2] as { providerOptions?: unknown }).providerOptions, ANTHROPIC_BREAKPOINT, 'marker on the last frozen message');
    assert.equal((out.messages[3] as { providerOptions?: unknown }).providerOptions, undefined, 'the new tail is not marked');
    assert.equal((out.messages[0] as { providerOptions?: unknown }).providerOptions, undefined);
  });

  it('preserves providerOptions that were already present on the anchor message', async () => {
    cfg();
    const ext = new Broke();
    const context = host('cc-merge');
    (ext as unknown as { context: ExtensionContext }).context = context;

    const full = await primeAnExtend(ext, context, { openai: { promptCacheKey: 'task-1' } });
    const out = (await ext.onApplyCacheControl({ originalMessages: full, messages: full } as ApplyCacheControlEvent, context)) as { messages: ContextMessage[] };
    assert.deepEqual((out.messages[2] as { providerOptions?: unknown }).providerOptions, {
      openai: { promptCacheKey: 'task-1' },
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  it('relocates the anchor by content when the host shifted the array (convertImageToolResults)', async () => {
    cfg();
    const ext = new Broke();
    const context = host('cc-shift');
    (ext as unknown as { context: ExtensionContext }).context = context;

    // Anchor captured at index 2 (m2 'gamma') by the two-optimize run.
    await primeAnExtend(ext, context);
    // The host's convertImageToolResults INSERTS a user message after an image
    // tool result - everything after it shifts by one, so a raw index would
    // now point at the inserted, never-sent message.
    const shifted = [
      msg('m0', 'alpha'),
      msg('m1', 'beta'),
      { id: 'img', role: 'user', content: [{ type: 'file', data: { type: 'data', data: 'x' }, mediaType: 'image/png' }] },
      msg('m2', 'gamma'),
      msg('m3', 'delta'),
      msg('m4', 'epsilon'),
    ] as unknown as ContextMessage[];

    const out = (await ext.onApplyCacheControl({ originalMessages: shifted, messages: shifted } as ApplyCacheControlEvent, context)) as
      | { messages: ContextMessage[] }
      | undefined;
    assert.ok(out && Array.isArray(out.messages));
    assert.deepEqual((out.messages[3] as { providerOptions?: unknown }).providerOptions, ANTHROPIC_BREAKPOINT, 'marker follows m2 to index 3');
    assert.equal((out.messages[2] as { providerOptions?: unknown }).providerOptions, undefined, 'the inserted image message is not marked');
  });

  it('places no marker when the array no longer contains the anchor content', async () => {
    cfg();
    const ext = new Broke();
    const context = host('cc-absent');
    (ext as unknown as { context: ExtensionContext }).context = context;

    await primeAnExtend(ext, context);
    const other = [msg('x0', 'zzz'), msg('x1', 'yyy')];
    assert.equal(
      await ext.onApplyCacheControl({ originalMessages: other, messages: other } as ApplyCacheControlEvent, context),
      undefined,
      'a different array must never be marked',
    );
  });

  it('does nothing when the profile is not anthropic, the toggle is off, or no prefix was sent', async () => {
    // Profile 'off'.
    cfg({ cache: { profile: 'off', escapeHatch: true, openaiStateless: false, anchorBreakpoint: true } });
    const extOff = new Broke();
    const ctxOff = host('cc-off');
    (extOff as unknown as { context: ExtensionContext }).context = ctxOff;
    const fullOff = await primeAnExtend(extOff, ctxOff);
    assert.equal(await extOff.onApplyCacheControl({ originalMessages: fullOff, messages: fullOff } as ApplyCacheControlEvent, ctxOff), undefined);

    // Toggle off.
    cfg({ cache: { profile: 'anthropic', escapeHatch: true, openaiStateless: false, anchorBreakpoint: false } });
    const extToggle = new Broke();
    const ctxToggle = host('cc-toggle');
    (extToggle as unknown as { context: ExtensionContext }).context = ctxToggle;
    const fullToggle = await primeAnExtend(extToggle, ctxToggle);
    assert.equal(await extToggle.onApplyCacheControl({ originalMessages: fullToggle, messages: fullToggle } as ApplyCacheControlEvent, ctxToggle), undefined);

    // No prefix sent yet (no optimize run happened).
    cfg();
    const extFresh = new Broke();
    const ctxFresh = host('cc-fresh');
    (extFresh as unknown as { context: ExtensionContext }).context = ctxFresh;
    const fresh = [msg('m0', 'alpha'), msg('m1', 'beta')];
    assert.equal(await extFresh.onApplyCacheControl({ originalMessages: fresh, messages: fresh } as ApplyCacheControlEvent, ctxFresh), undefined);
  });

  it('is a no-op during the summarizer reentry (optimizingTasks guard)', async () => {
    cfg();
    const ext = new Broke();
    const context = host('cc-reentry');
    (ext as unknown as { context: ExtensionContext }).context = context;

    const full = await primeAnExtend(ext, context);
    // Simulate the cloud summarizer's own generateText re-entering the pipeline.
    (ext as unknown as { optimizingTasks: Set<string> }).optimizingTasks.add('cc-reentry');
    assert.equal(await ext.onApplyCacheControl({ originalMessages: full, messages: full } as ApplyCacheControlEvent, context), undefined);
  });

  it('never rejects on a hostile host surface', async () => {
    cfg();
    const ext = new Broke();
    const hostile = {
      getTaskContext: () => {
        throw new Error('host exploded');
      },
      log: () => undefined,
      triggerUIDataRefresh: () => undefined,
      triggerUIComponentsReload: () => undefined,
    } as unknown as ExtensionContext;
    await assert.doesNotReject(ext.onApplyCacheControl({ originalMessages: [], messages: [] } as ApplyCacheControlEvent, hostile));
  });

  it('records anchored: true on the run record that will place the marker', async () => {
    // A small budget + the truncate level make BOTH runs actually compress
    // (touched), so both write a record - which is what this test reads.
    cfg({ level: 'truncate', maxContextChars: 6000 });
    const ext = new Broke();
    const context = host('cc-record');
    (ext as unknown as { context: ExtensionContext }).context = context;

    // Run 1: a compressible history (big old tool output) - touched, but
    // nothing was sent before, so NOT anchored.
    const bigTool = Array.from({ length: 900 }, (_, i) => `build line ${i}: ok`).join('\n');
    const history = [
      { id: 'u0', role: 'user', content: 'build it' },
      { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'power---bash', input: { command: 'x' } }] },
      { id: 't1', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'power---bash', output: { type: 'text', value: bigTool } }] },
      { id: 'u1', role: 'user', content: 'next' },
      { id: 'a2', role: 'assistant', content: 'ok' },
    ] as unknown as ContextMessage[];
    const out1 = await optimize(ext, context, history);
    assert.ok(out1.length > 0);

    // Run 2: the SAME raw history. The raw oversized tool output was never
    // sent (only its truncated form was), so the pass re-derives those exact
    // bytes - touched again - while the run-1 OUTPUT prefix is already sent,
    // which is exactly when the anchor (and the `anchored` flag) applies.
    await optimize(ext, context, history);

    const recs = loadRunRecords().filter((r) => r.taskId === 'cc-record');
    assert.ok(recs.length >= 2, 'both runs recorded');
    assert.equal(recs[0].anchored, undefined, 'run 1 sent nothing before -> not anchored');
    assert.equal(recs[0].anchorIndex, undefined, 'run 1 carries no anchor index');
    assert.equal(recs[recs.length - 1].anchored, true, 'run 2 anchored at the frozen prefix');
    assert.equal(typeof recs[recs.length - 1].anchorIndex, 'number', 'the anchor index is recorded for audit');
  });
});
