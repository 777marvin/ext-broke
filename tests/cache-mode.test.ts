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
let compressMessages: (typeof import('../compress'))['compressMessages'];
let summarizePass: (typeof import('../compress'))['summarizePass'];
let isSummaryMessage: (typeof import('../compress'))['isSummaryMessage'];
let createCompressState: (typeof import('../compress'))['createCompressState'];
let clearTask: (typeof import('../cache'))['clearTask'];
let loadRunRecords: (typeof import('../tokens'))['loadRunRecords'];
type Config = import('../config').Config;
type SummarizeDeps = import('../compress').SummarizeDeps;

before(async () => {
  ({ default: Broke } = await import('../index'));
  ({ DEFAULT_CONFIG, saveConfig } = await import('../config'));
  ({ structuralPass, errorPass, truncatePass, compressMessages, summarizePass, isSummaryMessage, createCompressState } = await import('../compress'));
  ({ clearTask } = await import('../cache'));
  ({ loadRunRecords } = await import('../tokens'));
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
  it('anthropic profile (escapeHatch off): budget overrun in run 2 must NOT rewrite history sent as-is in run 1', async () => {
    writeConfig({ cache: { profile: 'anthropic', escapeHatch: false } });
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

describe('escape hatch (E2E)', () => {
  it('anthropic profile + escapeHatch: a real budget overrun sacrifices the cache exactly once (option B)', async () => {
    writeConfig({ cache: { profile: 'anthropic', escapeHatch: true } });
    const taskId = 'escape-once';
    clearTask(taskId);
    const ext = new Broke();
    const context = makeHost(taskId, 'anthropic', 'claude-sonnet-4');
    const overInput = () =>
      [
        ...history(300),
        { id: 'u2', role: 'user', content: 'third turn' },
        {
          id: 'a3',
          role: 'assistant',
          content: 'big new work'.padEnd(8000, 'x'),
          usageReport: { model: 'claude-sonnet-4', sentTokens: 5000, receivedTokens: 100, messageCost: 0.05, cacheWriteTokens: 4800, cacheReadTokens: 200 },
        },
      ] as unknown as ContextMessage[];

    // Run 1 below budget ships t1 verbatim (sent bytes).
    const out1 = await run(ext, context, history(300));
    assert.ok(bytes(out1).includes('build line 299'), 'run 1 sends the full tool output (below budget)');

    // Run 2 overruns: the hatch is open -> ONE deliberate full rewrite.
    const out2 = await run(ext, context, overInput());
    assert.ok(bytes(out2).includes('big new work'), 'protected tail arrives intact');
    assert.ok(bytes(out2).includes('[broke: truncated'), 'escape hatch rewrites the sent history on overrun');
    assert.notEqual(bytes(out2.slice(0, out1.length)), bytes(out1), 'the sent prefix is deliberately invalidated');

    // Run 3 (same over-budget input): the hatch is locked, and the extension
    // reset the ledger on the escape run - t1's original bytes are no longer
    // "sent", so truncate re-derives the same truncated bytes deterministically.
    // The output re-stabilizes on the escape run's shape and the provider
    // cache can hit again from there.
    const out3 = await run(ext, context, overInput());
    assert.equal(bytes(out3), bytes(out2), 'after the escape run the output is byte-stable again');

    // The measure ledger (task 6) marks the escape run and carries the
    // provider-reported cache usage of the last completed call. Run 3 is
    // touched as well (deterministic re-derivation) and must NOT be flagged.
    const recs = loadRunRecords().filter((r) => r.taskId === 'escape-once');
    assert.equal(recs.length, 2, 'runs 2 and 3 are the touched runs (run 1 ships untouched)');
    const escapeRec = recs.find((r) => r.escaped === true);
    assert.ok(escapeRec, 'the ledger marks the deliberate cache invalidation');
    assert.equal(escapeRec.cacheProfile, 'anthropic');
    assert.equal(escapeRec.lastCacheWriteTokens, 4800);
    assert.equal(escapeRec.lastCacheReadTokens, 200);
    assert.equal(escapeRec.lastSentTokens, 5000);
    assert.equal(recs[recs.length - 1].escaped, undefined, 'the locked run 3 is not an escape');
  });
});

describe('escape hatch state machine (pipeline)', () => {
  const cfg = (): Config => ({
    ...DEFAULT_CONFIG,
    enabled: true,
    level: 'truncate',
    maxContextChars: 3000,
    protectedTurns: 1,
    errors: { ...DEFAULT_CONFIG.errors, enabled: false },
    // The fixture's oversized output is a single 4000-char line - cap by KB,
    // not by line count, so the truncate pass actually rewrites it.
    truncate: { ...DEFAULT_CONFIG.truncate, maxKB: 1 },
    cache: { profile: 'anthropic', escapeHatch: true },
  });
  const big = 'x'.repeat(4000);
  const msgs = (): ContextMessage[] =>
    [
      { id: 'u0', role: 'user', content: 'brief' },
      { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'power---bash', input: {} }] },
      { id: 't1', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'power---bash', output: { type: 'text', value: big } }] },
      { id: 'u1', role: 'user', content: 'tail' },
    ] as unknown as ContextMessage[];
  const deps = { generateLocal: async () => undefined, generateCloud: async () => undefined } as unknown as SummarizeDeps;
  const frozen = (m: ContextMessage) => (m as { id?: string }).id === 't1';

  it('over -> escape once -> locked holds -> under releases -> over escapes again', async () => {
    const state = createCompressState();
    let escapes = 0;
    const escape = { locked: false, onEscape: (): void => void escapes++ };
    const opts = { cache: { frozen, escape, profile: 'anthropic' as const } };

    const r1 = await compressMessages(msgs(), cfg(), deps, state, 'esc-1', opts);
    assert.ok(bytes(r1.messages).includes('[broke: truncated'), 'run 1: hatch open, sent bytes rewritten');
    assert.equal(escape.locked, true, 'run 1 locks the hatch');
    assert.equal(escapes, 1, 'onEscape fired for the ledger reset');
    assert.equal(r1.report.escaped, true, 'the report flags the escape rewrite');
    assert.equal(r1.report.cacheProfile, 'anthropic', 'the report carries the resolved cache profile');

    // Run 2: still over, locked - the frozen bytes ship verbatim.
    const r2 = await compressMessages(msgs(), cfg(), deps, state, 'esc-1', opts);
    assert.ok(bytes(r2.messages).includes(big), 'run 2: frozen tool output kept verbatim');
    assert.ok(!bytes(r2.messages).includes('[broke: truncated'), 'run 2: no second rewrite while locked');
    assert.equal(escape.locked, true, 'run 2 keeps the hatch locked');
    assert.equal(escapes, 1);

    // Run 3: under budget - the hatch releases (even though nothing runs).
    const small = [
      { id: 'u0', role: 'user', content: 'brief' },
      { id: 'u1', role: 'user', content: 'tail' },
    ] as unknown as ContextMessage[];
    await compressMessages(small, cfg(), deps, state, 'esc-1', opts);
    assert.equal(escape.locked, false, 'an under-budget run releases the hatch');

    // Run 4: over again - the hatch may fire once more.
    const r4 = await compressMessages(msgs(), cfg(), deps, state, 'esc-1', opts);
    assert.ok(bytes(r4.messages).includes('[broke: truncated'), 'run 4: hatch fires again after release');
    assert.equal(escapes, 2);
  });

  it('escapeHatch: false never rewrites sent bytes', async () => {
    const state = createCompressState();
    const escape = { locked: false };
    const cfgOff: Config = { ...cfg(), cache: { profile: 'anthropic', escapeHatch: false } };
    const opts = { cache: { frozen, escape } };
    for (let i = 0; i < 2; i++) {
      const r = await compressMessages(msgs(), cfgOff, deps, state, 'esc-off', opts);
      assert.ok(bytes(r.messages).includes(big), `run ${i + 1}: frozen bytes intact`);
      assert.ok(!bytes(r.messages).includes('[broke: truncated'), `run ${i + 1}: no rewrite`);
      assert.equal(escape.locked, false, 'hatch never engages');
    }
  });

  it('CACHE-002: escape state is NOT locked and ledger is NOT reset if validator rejects output', async () => {
    const state = createCompressState();
    let escapes = 0;
    const escape = { locked: false, onEscape: (): void => void escapes++ };
    let shouldReject = true;
    const rejectingValidate = (messages: ContextMessage[]) => {
      if (shouldReject && bytes(messages).includes('[broke: truncated')) {
        return [{ index: 0, reason: 'test simulated corruption' }];
      }
      return [];
    };

    const opts = {
      cache: { frozen, escape, profile: 'anthropic' as const },
      validate: rejectingValidate,
    };

    const r1 = await compressMessages(msgs(), cfg(), deps, state, 'esc-fail', opts);
    assert.equal(r1.report.escaped, undefined, 'report does NOT flag escaped because output was reverted');
    assert.equal(escape.locked, false, 'escape is NOT locked after validator rejection');
    assert.equal(escapes, 0, 'onEscape did NOT fire');
    assert.ok(bytes(r1.messages).includes(big), 'uncompressed messages returned');

    shouldReject = false;
    const r2 = await compressMessages(msgs(), cfg(), deps, state, 'esc-fail', opts);
    assert.equal(r2.report.escaped, true, 'subsequent run successfully escapes');
    assert.equal(escape.locked, true, 'hatch is locked after successful escape');
    assert.equal(escapes, 1, 'onEscape fired once');
    assert.ok(bytes(r2.messages).includes('[broke: truncated'), 'messages rewritten');
  });

  it('CACHE-001: monotonic history allows subsequent escapes when history re-exceeds budget', async () => {
    const state = createCompressState();
    let escapes = 0;
    const escape = { locked: false, onEscape: (): void => void escapes++ };

    const sentSet = new Set<string>();
    const frozenFn = (m: ContextMessage) => sentSet.has((m as { id?: string }).id ?? '');

    const opts = {
      cache: { frozen: frozenFn, escape, profile: 'anthropic' as const },
    };

    // Run 1: starts over budget -> escapes down to ~250 chars.
    const r1 = await compressMessages(msgs(), cfg(), deps, state, 'esc-mono', opts);
    assert.equal(r1.report.escaped, true, 'run 1 escapes');
    assert.equal(escape.locked, true, 'locked after run 1');
    assert.equal(escapes, 1);
    for (const m of r1.messages) {
      if ((m as { id?: string }).id) sentSet.add((m as { id?: string }).id!);
    }

    // Run 2: Monotonic history! Run 1's messages (frozen) + small new turn (50 chars).
    // Total input fits within budget -> cache-preserving output fits without escaping -> re-arms hatch!
    const turn2 = [
      ...r1.messages,
      { id: 'u2', role: 'user', content: 'small question' },
      { id: 'a2', role: 'assistant', content: 'small reply' },
    ] as ContextMessage[];
    const r2 = await compressMessages(turn2, cfg(), deps, state, 'esc-mono', opts);
    assert.equal(r2.report.escaped, undefined, 'run 2 did not need to escape');
    assert.equal(escape.locked, false, 'run 2 re-arms the hatch because output fits within budget');
    assert.equal(escapes, 1);
    for (const m of r2.messages) {
      if ((m as { id?: string }).id) sentSet.add((m as { id?: string }).id!);
    }

    // Run 3: Monotonic growth! Add ANOTHER large tool output (800 chars). Total now ~1150 chars (> 500).
    // Since hatch was re-armed, it can escape again!
    const turn3 = [
      ...r2.messages,
      { id: 't2', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc2', toolName: 'power---bash', output: { type: 'text', value: big } }] },
      { id: 'u3', role: 'user', content: 'tail' },
    ] as unknown as ContextMessage[];

    const r3 = await compressMessages(turn3, cfg(), deps, state, 'esc-mono', opts);
    assert.equal(r3.report.escaped, true, 'run 3 escapes again on second budget crossing!');
    assert.equal(escape.locked, true, 'locked again after second escape');
    assert.equal(escapes, 2);
  });
});

describe('summarizePass cache gating (unit)', () => {
  const sumCfg = (): Config => ({
    ...DEFAULT_CONFIG,
    level: 'summarize',
    summarize: { ...DEFAULT_CONFIG.summarize, afterTurns: 2, minChars: 60, maxSummaryChars: 2000 },
  });
  const conv = (): ContextMessage[] =>
    [
      { id: 'u0', role: 'user', content: 'Brief: build the billing module.' },
      { id: 'a1', role: 'assistant', content: 'Step 1: reading the module.' },
      { id: 't1', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'power---file-read', output: { type: 'text', value: `file content line a\nfile content line b\n${'x'.repeat(350)}` } }] },
      { id: 'u1', role: 'user', content: 'Add a discount field.' },
      { id: 'a2', role: 'assistant', content: 'Step 2: editing.' },
      { id: 't2', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc2', toolName: 'power---file-edit', output: { type: 'text', value: 'edit ok' } }] },
      { id: 'u2', role: 'user', content: 'Run the tests.' },
      { id: 'a3', role: 'assistant', content: 'Step 3: running tests.' },
      { id: 't3', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc3', toolName: 'power---bash', output: { type: 'text', value: 'all tests pass' } }] },
      { id: 'u3', role: 'user', content: 'Protected tail.' },
    ] as unknown as ContextMessage[];
  /** The region grew by one user turn: the old protected tail is now compressible. */
  const grown = (input: ContextMessage[]): ContextMessage[] =>
    [
      ...input.slice(0, 9),
      { id: 'u3', role: 'user', content: 'Protected tail.' },
      { id: 'a4', role: 'assistant', content: 'mid work' },
      { id: 'u4', role: 'user', content: 'Deploy now.' },
    ] as unknown as ContextMessage[];
  const deps = (calls: { n: number }): SummarizeDeps => ({
    generateLocal: async () => {
      calls.n += 1;
      return 'Summary: billing module with discount; tests pass.';
    },
    generateCloud: async () => undefined,
  });

  it('blocks regeneration when the region contains already-sent bytes', async () => {
    const calls = { n: 0 };
    const input = conv();
    const frozen = (m: ContextMessage) => ['t1', 'a2'].includes((m as { id?: string }).id ?? '');
    const r = await summarizePass(input, 1, sumCfg(), deps(calls), createCompressState(), 'sg-a', { frozen });
    assert.equal(calls.n, 0, 'no summarizer call over sent bytes');
    assert.equal(r.messages, input, 'region untouched');
    assert.equal(r.summarizedRanges, 0);
  });

  it('re-serves the sent summary and appends new turns verbatim instead of regenerating', async () => {
    const calls = { n: 0 };
    const state = createCompressState();
    const input = conv();
    const r1 = await summarizePass(input, 1, sumCfg(), deps(calls), state, 'sg-b');
    const S = r1.messages.find(isSummaryMessage);
    assert.ok(S, 'run 1 produces a summary');

    const frozen = (m: ContextMessage) => m === S;
    const r2 = await summarizePass(grown(input), 1, sumCfg(), deps(calls), state, 'sg-b', { frozen });
    assert.equal(calls.n, 1, 'no regeneration over the sent summary');
    const s2 = r2.messages.find(isSummaryMessage);
    assert.ok(s2 && bytes([s2]) === bytes([S]), 'the sent summary bytes are re-served verbatim');
    assert.ok(bytes(r2.messages).includes('Protected tail.') && bytes(r2.messages).includes('mid work'), 'new messages appended verbatim');
    assert.equal(r2.summarizeCalls, 0);

    // The cache boundary must not advance: the same input re-derives the
    // same shape on every subsequent run (BRK-001 discipline).
    const r3 = await summarizePass(grown(input), 1, sumCfg(), deps(calls), state, 'sg-b', { frozen });
    assert.equal(calls.n, 1, 'still no summarizer call');
    assert.equal(bytes(r3.messages), bytes(r2.messages), 'byte-stable across runs');
  });

  it('escaping re-enables regeneration over sent bytes', async () => {
    const calls = { n: 0 };
    const state = createCompressState();
    const input = conv();
    const r1 = await summarizePass(input, 1, sumCfg(), deps(calls), state, 'sg-c');
    const S = r1.messages.find(isSummaryMessage);
    assert.ok(S);

    const r2 = await summarizePass(grown(input), 1, sumCfg(), deps(calls), state, 'sg-c', { frozen: (m) => m === S, escaping: true });
    assert.equal(calls.n, 2, 'the escape run pays for a full regeneration');
    const s2 = r2.messages.find(isSummaryMessage);
    assert.ok(s2 && bytes([s2]) !== bytes([S]), 'a fresh summary replaces the sent one');
    assert.ok(!bytes(r2.messages).includes('file content line a'), 'sent region bytes are rewritten');
  });

  it('regenerates freely when nothing in the region was ever sent', async () => {
    const calls = { n: 0 };
    const input = conv();
    const r = await summarizePass(grown(input), 1, sumCfg(), deps(calls), createCompressState(), 'sg-d', { frozen: () => false });
    assert.equal(calls.n, 1, 'the gate is a no-op for unsent bytes');
    assert.ok(r.messages.some(isSummaryMessage));
  });

  it('a history edit under a sent summary: no call, no rewrite (correctness over cache)', async () => {
    const calls = { n: 0 };
    const state = createCompressState();
    const input = conv();
    const r1 = await summarizePass(input, 1, sumCfg(), deps(calls), state, 'sg-f');
    const S = r1.messages.find(isSummaryMessage);
    assert.ok(S);
    const edited = input.map((m, i) => (i === 1 ? { ...m, content: 'EDITED: Step 1 changed.' } : m)) as ContextMessage[];
    const r2 = await summarizePass(edited, 1, sumCfg(), deps(calls), state, 'sg-f', { frozen: (m) => m === S });
    assert.equal(calls.n, 1, 'no regeneration');
    assert.equal(r2.messages, edited, 'region untouched');
  });
});
