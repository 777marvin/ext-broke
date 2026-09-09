/**
 * Cache-friendly mode E2E: byte stability of the optimize output across
 * consecutive model calls. The provider prompt cache is prefix-based, so the
 * contract is: run N's output must EXTEND run N-1's output byte-for-byte as
 * long as the budget is not overstepped (escape hatch, tested separately).
 *
 * The differentiation cases are the passes whose decisions SHIFT over time:
 * - truncatePass is gated on totalCharsBefore > maxContextChars - history
 *   growth turns "leave as-is" into "rewrite" between runs. The freeze must
 *   keep the previously sent bytes ('anthropic' profile) while 'off'
 *   rewrites them (existing behavior, asserted as control).
 * - structural merges are neighbor-dependent - the frozen-by-content ledger
 *   must re-derive identical merged bytes deterministically.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextMessage, ExtensionContext, OptimizeMessagesEvent } from '@aiderdesk/extensions';

const tmp = mkdtempSync(join(tmpdir(), 'broke-cache-'));
process.env.BROKE_CONFIG_PATH = join(tmp, 'config.json');
process.env.BROKE_STATS_PATH = join(tmp, 'stats.jsonl');
process.env.BROKE_MEASURE_PATH = join(tmp, 'measure.jsonl');
process.env.BROKE_ERRORS_DIR = join(tmp, 'errors');
process.env.BROKE_INDEX_DIR = join(tmp, 'indexdir');
process.env.BROKE_STATS_PERSIST_MIN_MS = '0';

let Broke: (typeof import('../index'))['default'];
let DEFAULT_CONFIG: (typeof import('../config'))['DEFAULT_CONFIG'];
let saveConfig: (typeof import('../config'))['saveConfig'];
let structuralPass: (typeof import('../compress'))['structuralPass'];
let errorPass: (typeof import('../compress'))['errorPass'];
let truncatePass: (typeof import('../compress'))['truncatePass'];
let clearTask: (typeof import('../cache'))['clearTask'];
type Config = import('../config').Config;

before(async () => {
  ({ default: Broke } = await import('../index'));
  ({ DEFAULT_CONFIG, saveConfig } = await import('../config'));
  ({ structuralPass, errorPass, truncatePass } = await import('../compress'));
  ({ clearTask } = await import('../cache'));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const bytes = (msgs: unknown[]): string => JSON.stringify(msgs);

function writeConfig(over: Partial<Config>): Config {
  const config: Config = {
    ...DEFAULT_CONFIG,
    enabled: true,
    level: 'truncate',
    maxContextChars: 6000,
    protectedTurns: 1,
    errors: { ...DEFAULT_CONFIG.errors, enabled: false },
    ...over,
  };
  saveConfig(config);
  return config;
}

function makeHost(taskId: string, provider: string, model: string): ExtensionContext {
  const task = {
    data: { id: taskId, provider, model, mainModel: model },
    getTaskAgentProfile: async () => ({ provider, model }),
    getContextMessages: async () => [],
    getModelConfigs: async () => [],
    addLogMessage: async () => undefined,
  };
  const context = {
    log: () => undefined,
    getTaskContext: () => task,
    triggerUIDataRefresh: () => undefined,
    triggerUIComponentsReload: () => undefined,
  };
  return context as unknown as ExtensionContext;
}

/** u0 brief + big tool output pair + recent turn - the truncate pass's real target. */
function history(toolLines: number, tailPad = 300): ContextMessage[] {
  return [
    { id: 'u0', role: 'user', content: 'please build the widget feature' },
    { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'power---bash', input: { command: 'big-build' } }] },
    {
      id: 't1',
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'power---bash', output: { type: 'text', value: Array.from({ length: toolLines }, (_, i) => `build line ${i}: ok`).join('\n') } }],
    },
    { id: 'u1', role: 'user', content: 'second turn - keep this visible' },
    { id: 'a2', role: 'assistant', content: 'recent work'.padEnd(tailPad, '.') },
  ] as unknown as ContextMessage[];
}

async function run(ext: InstanceType<typeof Broke>, context: ExtensionContext, messages: ContextMessage[]): Promise<ContextMessage[]> {
  const event = { originalMessages: messages, optimizedMessages: messages.slice() } as unknown as OptimizeMessagesEvent;
  const out = await ext.onOptimizeMessages(event, context);
  if (!out || typeof out !== 'object' || !('optimizedMessages' in out)) return messages;
  return (out as { optimizedMessages: ContextMessage[] }).optimizedMessages;
}

describe('cache-friendly byte stability (E2E)', () => {
  it('anthropic profile: budget overrun in run 2 must NOT rewrite history sent as-is in run 1', async () => {
    writeConfig({ cache: { profile: 'anthropic', escapeHatch: true } });
    const taskId = 'byte-stable-anthropic';
    clearTask(taskId);
    const ext = new Broke();
    const context = makeHost(taskId, 'anthropic', 'claude-sonnet-4');

    // Run 1: below maxContextChars (6000) - t1 (~5.1k) ships as-is.
    const out1 = await run(ext, context, history(300));
    assert.ok(bytes(out1).includes('build line 299'), 'run 1 sends the full tool output (below budget)');

    // Run 2: appended protected tail pushes the total over the budget - the
    // truncate gate now fires and WOULD rewrite t1. The freeze keeps it:
    // nothing in the old region is unfrozen, so no truncation marker may
    // appear anywhere (the 'off' control below proves the shapes truncate).
    const out2 = await run(ext, context, [...history(300), { id: 'u2', role: 'user', content: 'third turn' }, { id: 'a3', role: 'assistant', content: 'big new work'.padEnd(8000, 'x') }] as unknown as ContextMessage[]);
    assert.ok(bytes(out2).includes('big new work'), 'protected tail arrives intact');
    assert.ok(out2.length >= out1.length, 'run 2 output extends run 1');
    assert.equal(
      bytes(out2.slice(0, out1.length)),
      bytes(out1),
      'run 2 output must extend run 1 output byte-for-byte (frozen prefix)',
    );
  });

  it("off profile (control): the same budget overrun DOES rewrite run 1's history", async () => {
    writeConfig({ cache: { profile: 'off', escapeHatch: true } });
    const taskId = 'byte-stable-off';
    clearTask(taskId);
    const ext = new Broke();
    const context = makeHost(taskId, 'anthropic', 'claude-sonnet-4');

    const out1 = await run(ext, context, history(300));
    assert.ok(bytes(out1).includes('build line 299'), 'run 1 below budget: full output');

    const out2 = await run(ext, context, [...history(300), { id: 'u2', role: 'user', content: 'third turn' }, { id: 'a3', role: 'assistant', content: 'big new work'.padEnd(8000, 'x') }] as unknown as ContextMessage[]);
    assert.ok(bytes(out2).includes('[broke: truncated'), 'control: off profile rewrites on overrun (current behavior)');
    assert.notEqual(
      bytes(out2.slice(0, out1.length)),
      bytes(out1),
      'control: the prefix CHANGES under off - this is exactly what the cache-friendly mode prevents',
    );
  });

  it('structural merge re-derivation: run 2 reproduces run 1 merged bytes deterministically', async () => {
    writeConfig({ cache: { profile: 'anthropic', escapeHatch: true } });
    const taskId = 'byte-stable-merge';
    clearTask(taskId);
    const ext = new Broke();
    const context = makeHost(taskId, 'anthropic', 'claude-sonnet-4');

    const base: ContextMessage[] = [
      { id: 'u0', role: 'user', content: 'brief' },
      { id: 'a1', role: 'assistant', content: 'hello part one' },
      { id: 'a2', role: 'assistant', content: 'hello part two' },
      { id: 'u1', role: 'user', content: 'second turn' },
      { id: 'a3', role: 'assistant', content: 'recent work'.padEnd(300, '.') },
    ] as unknown as ContextMessage[];

    const out1 = await run(ext, context, base);
    assert.equal(out1.filter((m) => m.role === 'assistant').length, 2, 'run 1 merged the consecutive assistant texts');

    const out2 = await run(ext, context, [...base, { id: 'u2', role: 'user', content: 'third turn' }, { id: 'a4', role: 'assistant', content: 'tail work' }] as unknown as ContextMessage[]);
    assert.equal(
      bytes(out2.slice(0, out1.length)),
      bytes(out1),
      're-derived merge must reproduce the exact bytes sent before',
    );
  });
});

describe('pass-level freeze gating (unit)', () => {
  const frozenIds = new Set(['F1', 'F2']);
  const frozen = (m: ContextMessage) => frozenIds.has((m as { id?: string }).id ?? '');
  const msg = (id: string, text: string, role: 'user' | 'assistant' | 'tool' = 'assistant'): ContextMessage =>
    ({
      id,
      role,
      content: role === 'tool' ? [{ type: 'tool-result', toolCallId: `tc-${id}`, toolName: 'power---bash', output: { type: 'text', value: text } }] : text,
    }) as unknown as ContextMessage;

  it('structuralPass: merge is blocked when either side is frozen, runs when both are unfrozen', () => {
    // Both unfrozen: merge happens (re-derivation contract).
    const both = [msg('u0', 'brief', 'user'), msg('a1', 'one'), msg('a2', 'two'), msg('u1', 'turn', 'user')];
    const merged = structuralPass(both, 1, frozen);
    assert.equal(merged.messages.filter((m) => (m as { id?: string }).id === 'a2').length, 0, 'unfrozen pair merged');

    // Prev frozen: merge must NOT replace the frozen message's bytes.
    const prevFrozen = [msg('u0', 'brief', 'user'), msg('F1', 'one'), msg('a2', 'two'), msg('u1', 'turn', 'user')];
    const kept = structuralPass(prevFrozen, 1, frozen);
    assert.ok(kept.messages.some((m) => bytes([m]) === bytes([msg('F1', 'one')])), 'frozen message kept byte-identical');
    assert.ok(kept.messages.some((m) => bytes([m]) === bytes([msg('a2', 'two')])), 'current side kept unmerged');

    // Current frozen: same.
    const curFrozen = [msg('u0', 'brief', 'user'), msg('a1', 'one'), msg('F2', 'two'), msg('u1', 'turn', 'user')];
    const kept2 = structuralPass(curFrozen, 1, frozen);
    assert.ok(kept2.messages.some((m) => bytes([m]) === bytes([msg('F2', 'two')])), 'frozen current side kept unmerged');
  });

  it('structuralPass: a frozen empty assistant message is not dropped', () => {
    const emptyFrozen: ContextMessage = { id: 'F1', role: 'assistant', content: '' } as unknown as ContextMessage;
    const messages = [msg('u0', 'brief', 'user'), emptyFrozen, msg('u1', 'turn', 'user')];
    const out = structuralPass(messages, 1, frozen);
    assert.ok(out.messages.includes(emptyFrozen), 'frozen empty message survives');
    const emptyUnfrozen: ContextMessage = { id: 'e1', role: 'assistant', content: '' } as unknown as ContextMessage;
    const out2 = structuralPass([msg('u0', 'brief', 'user'), emptyUnfrozen, msg('u1', 'turn', 'user')], 1, frozen);
    assert.ok(!out2.messages.includes(emptyUnfrozen), 'unfrozen empty message still dropped');
  });

  it('errorPass and truncatePass: frozen messages pass through byte-identical, unfrozen are rewritten', () => {
    const big = (id: string, frozenId: boolean) =>
      msg(
        id,
        [
          ...Array.from({ length: 60 }, (_, i) => `build step ${i}: compiled ok`),
          'Traceback (most recent call last):',
          '  File "app.py", line 42, in main',
          '    run()',
          `ValueError: boom-${frozenId ? 'frozen' : 'plain'}${'!'.repeat(600)}`,
        ].join('\n'),
        'tool',
      );
    const calls = (id: string): ContextMessage =>
      ({ id, role: 'assistant', content: [{ type: 'tool-call', toolCallId: `tc-${id}`, toolName: 'x', input: { a: 1 } }] }) as unknown as ContextMessage;

    const messages: ContextMessage[] = [
      msg('u0', 'brief', 'user'),
      calls('c1'),
      big('F1', true),
      calls('c2'),
      big('t2', false),
      msg('u1', 'turn', 'user'),
    ];
    const err = errorPass(messages, 1, { minChars: 500, contextLines: 8 }, frozen);
    const errT1 = err.messages.find((m) => (m as { id?: string }).id === 'F1') as { content: Array<{ output?: { value?: string } }> };
    const errT2 = err.messages.find((m) => (m as { id?: string }).id === 't2') as { content: Array<{ output?: { value?: string } }> };
    assert.ok(errT1.content[0].output?.value?.includes('boom-frozen') && !errT1.content[0].output?.value?.includes('[broke:'), 'frozen tool result not error-compressed');
    assert.ok(errT2.content[0].output?.value?.includes('[broke:'), 'unfrozen tool result error-compressed as usual');

    const trunc = truncatePass(messages, 1, 50, 1, 2000, frozen);
    const truncT1 = trunc.messages.find((m) => (m as { id?: string }).id === 'F1') as { content: Array<{ output?: { value?: string } }> };
    const truncT2 = trunc.messages.find((m) => (m as { id?: string }).id === 't2') as { content: Array<{ output?: { value?: string } }> };
    assert.ok(truncT1.content[0].output?.value?.includes('build step 59') && !truncT1.content[0].output?.value?.includes('[broke:'), 'frozen tool result not truncated');
    assert.ok(truncT2.content[0].output?.value?.includes('[broke: truncated'), 'unfrozen tool result truncated as usual');
  });
});
