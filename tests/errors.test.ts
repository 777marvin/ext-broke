import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextMessage } from '@aiderdesk/extensions';
import { errorPass, compressMessages, createCompressState, maskSecrets, type SummarizeDeps } from '../compress';
import { DEFAULT_CONFIG, type Config } from '../config';
import { clearArchive, enforceArchiveCap, resetArchiveLedger, saveErrorOutput, extractErrorSummary, formatErrorSummary, isCommandTool } from '../errors';
import { messagesChars } from '../tokens';

let seq = 0;
const id = (): string => `test-${++seq}`;

const user = (text: string): ContextMessage => ({ id: id(), role: 'user', content: text });
const assistant = (text: string): ContextMessage => ({ id: id(), role: 'assistant', content: text });
/** Assistant message issuing one tool-call (holder), so results have a producer. */
const assistantWithCall = (callId: string, toolName: string): ContextMessage => ({
  id: id(),
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: callId, toolName, input: {} }],
});
/** Tool result linked to a specific (real) tool-call id. */
const toolWith = (callId: string, toolName: string, value: string): ContextMessage => ({
  id: id(),
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: callId, toolName, output: { type: 'text', value } }],
});
/** Structured result linked to a specific (real) tool-call id. */
const toolJsonWith = (
  callId: string,
  toolName: string,
  value: { stdout?: string; stderr?: string; exitCode?: number },
): ContextMessage => ({
  id: id(),
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: callId, toolName, output: { type: 'json', value } }],
});
const tool = (toolName: string, value: string): ContextMessage => ({
  id: id(),
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id(), toolName, output: { type: 'text', value } }],
});

/** power---bash-style structured output: { stdout, stderr, exitCode } as json. */
const toolJson = (toolName: string, value: { stdout?: string; stderr?: string; exitCode?: number }): ContextMessage => ({
  id: id(),
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id(), toolName, output: { type: 'json', value } }],
});

  /** Conversation with a single old oversized structured bash error output. */
  function errorJsonConversation(tscOutput: string): ContextMessage[] {
    // Realistic history: every result is preceded by its producing
    // tool-call - the pairing clamp refuses regions that start on a
    // holderless result.
    const callId = `call-${id()}`;
    return [
      user('Implement the billing module. Requirements: invoices, payments.'),
      assistantWithCall(callId, 'power---bash'),
      toolJsonWith(callId, 'power---bash', { stdout: tscOutput, stderr: '', exitCode: 2 }),
      assistant('I see the errors - fixing them now.'),
      user('Also add CSV export.'),
    ];
  }

  /** Conversation with a single old oversized error output in the compressible region. */
  function errorConversation(tscOutput: string): ContextMessage[] {
    const callId = `call-${id()}`;
    return [
      user('Implement the billing module. Requirements: invoices, payments.'),
      assistantWithCall(callId, 'power---bash'),
      toolWith(callId, 'power---bash', tscOutput),
      assistant('I see the errors - fixing them now.'),
      user('Also add CSV export.'),
    ];
  }

const TSC_SAMPLE = [
  'src/billing.ts:12:5 - error TS2554: Expected 2 arguments, but got 1.',
  '  12   compute(total);',
  '      ~~~~~~~~~~~~~~~',
  '',
  'src/billing.ts:45:9 - error TS2339: Property \'foo\' does not exist on type \'Invoice\'.',
  '  45   invoice.foo();',
  '      ~~~~~~~~~~~~~~',
  '',
  'Found 2 errors in the same file.',
].join('\n');

const PY_SAMPLE = [
  'Traceback (most recent call last):',
  '  File "C:\\app\\main.py", line 42, in <module>',
  '    main()',
  '  File "C:\\app\\main.py", line 30, in compute',
  '    result = total / count',
  'ZeroDivisionError: division by zero',
].join('\n');

const JEST_SAMPLE = [
  ' FAIL  tests/billing.test.ts',
  '  ● discount calculation',
  '',
  '    expect(received).toBe(expected)',
  '',
  '    Expected: 42',
  '    Received: 43',
  '',
  '      at Object.<anonymous> (C:\\src\\billing.test.ts:12:5)',
  '      at Promise.resolve.then (node:internal/.../loader.js:9:1)',
  '',
  'Test Suites: 1 failed, 1 total',
  'Tests:       1 failed, 1 passed, 2 total',
].join('\n');

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
  };
}

const noopDeps: SummarizeDeps = {
  generateLocal: async () => undefined,
  generateCloud: async () => undefined,
};

describe('extractErrorSummary', () => {
  it('extracts a tsc error with file:line and context', () => {
    const r = extractErrorSummary(TSC_SAMPLE, { contextLines: 8 });
    assert.equal(r.matched, true);
    assert.match(r.body, /error TS2554: Expected 2 arguments, but got 1\./);
    assert.match(r.body, /at src\/billing\.ts:12:5/);
    assert.match(r.body, /\(\+1 more tsc error entries\)/);
    assert.ok(r.summaryLines < r.originalLines);
  });

  it('extracts a python traceback with the exception and innermost frame', () => {
    const r = extractErrorSummary(PY_SAMPLE, { contextLines: 8 });
    assert.equal(r.matched, true);
    assert.match(r.body, /ZeroDivisionError: division by zero/);
    assert.match(r.body, /at C:\\app\\main\.py:30/);
  });

  it('extracts a jest failure block with the failed test name', () => {
    const r = extractErrorSummary(JEST_SAMPLE, { contextLines: 8 });
    assert.equal(r.matched, true);
    assert.match(r.body, /discount calculation/);
    assert.match(r.body, /at .*billing\.test\.ts:12:5/);
  });

  it('matches the generic fallback for a bare Error line', () => {
    const r = extractErrorSummary('TypeError: Cannot read properties of undefined (reading \'x\')', { contextLines: 8 });
    assert.equal(r.matched, true);
    assert.match(r.body, /TypeError: Cannot read properties/);
  });

  it('returns matched:false for normal build output and code listings', () => {
    const normal = ['> building...', '✓ compiled 42 modules', 'ready in 1.2s', 'const x = "Error: not an error";'].join('\n');
    assert.equal(extractErrorSummary(normal, { contextLines: 8 }).matched, false);
    assert.equal(extractErrorSummary('hello world', { contextLines: 8 }).matched, false);
    assert.equal(extractErrorSummary('', { contextLines: 8 }).matched, false);
  });
});

describe('formatErrorSummary', () => {
  it('wraps the body in the standard marker with line counts', () => {
    const r = extractErrorSummary(TSC_SAMPLE, { contextLines: 8 });
    const formatted = formatErrorSummary(r, ' - full output removed');
    assert.match(formatted, /… \[broke: error summary - \d+ lines → \d+ lines\] - full output removed/);
    assert.ok(formatted.includes('error TS2554'));
  });
});

describe('errorPass', () => {
  it('replaces matching oversized tool results with a marked summary', () => {
    const big = `${TSC_SAMPLE}\n${'padding line for size\n'.repeat(300)}`;
    const messages = errorConversation(big);
    const { messages: result, removedChars } = errorPass(messages, 1, { minChars: 500, contextLines: 8 });

    assert.ok(removedChars > 0);
    const text = result.find((m) => m.role === 'tool');
    const value = (text!.content as { output: { value: unknown } }[])[0].output.value as string;
    assert.match(value, /\[broke: error summary/);
    assert.ok(value.length < big.length);
  });

  it('leaves outputs below the threshold untouched', () => {
    const small = TSC_SAMPLE; // well below minChars
    const messages = errorConversation(small);
    const { messages: result, removedChars } = errorPass(messages, 1, { minChars: 500, contextLines: 8 });
    assert.equal(removedChars, 0);
    assert.deepEqual(result, messages); // byte-identical pass-through
  });

  it('never compresses protected turns', () => {
    const big = `${TSC_SAMPLE}\n${'padding line for size\n'.repeat(300)}`;
    const messages = [
      user('First request.'),
      assistant('Working…'),
      user('Second request.'),
      tool('power---bash', big),
      assistant('Fixing.'),
    ];
    // protectedTurns=2 protects both user turns, so the big error output in
    // the most recent turn sits in the protected region and stays untouched.
    const { messages: result, removedChars } = errorPass(messages, 2, { minChars: 500, contextLines: 8 });
    assert.equal(removedChars, 0);
    assert.deepEqual(result, messages);
  });

  it('passes non-error tool output through byte-identical', () => {
    const normal = Array.from({ length: 100 }, (_, i) => `line ${i}: const y${i} = ${i};`).join('\n');
    const messages = errorConversation(normal);
    const { messages: result, removedChars } = errorPass(messages, 1, { minChars: 500, contextLines: 8 });
    assert.equal(removedChars, 0);
    assert.deepEqual(result, messages);
  });

  it('compresses structured json output with stdout (power---bash shape)', () => {
    const big = `${TSC_SAMPLE}\n${'padding line for size\n'.repeat(300)}`;
    const messages = errorJsonConversation(big);
    const { messages: result, removedChars } = errorPass(messages, 1, { minChars: 500, contextLines: 8 });

    assert.ok(removedChars > 0, 'error pass should engage on json stdout');
    const text = result.find((m) => m.role === 'tool');
    const output = (text!.content as { output: { type: string; value: unknown } }[])[0].output;
    // The structured shape is preserved; stdout carries the marked summary.
    assert.equal(output.type, 'json');
    const value = output.value as { stdout: string; stderr: string; exitCode: number };
    assert.match(value.stdout, /\[broke: error summary/);
    assert.ok(value.stdout.length < big.length);
  });

  it('compresses structured json output with the error in stderr', () => {
    const big = `${TSC_SAMPLE}\n${'padding line for size\n'.repeat(300)}`;
    const messages = errorJsonConversation(big).map((m) =>
      m.role === 'tool'
        ? ({
            ...m,
            content: [
              { ...(m.content as unknown as { output: { type: string; value: unknown } }[])[0], output: { type: 'json', value: { stdout: '', stderr: big, exitCode: 2 } } },
            ],
          } as unknown as ContextMessage)
        : m,
    );
    const { messages: result, removedChars } = errorPass(messages, 1, { minChars: 500, contextLines: 8 });

    assert.ok(removedChars > 0, 'error pass should engage on json stderr');
    const text = result.find((m) => m.role === 'tool');
    // The summary is placed into stdout (canonical slot); stderr is emptied.
    const value = (text!.content as unknown as { output: { value: { stdout: string; stderr: string } } }[])[0].output.value;
    assert.match(value.stdout, /\[broke: error summary/);
    assert.equal(value.stderr, '');
  });

  it('leaves non-error structured json output untouched', () => {
    const normal = Array.from({ length: 100 }, (_, i) => `line ${i}: const y${i} = ${i};`).join('\n');
    const messages = errorJsonConversation(normal);
    const { messages: result, removedChars } = errorPass(messages, 1, { minChars: 500, contextLines: 8 });
    assert.equal(removedChars, 0);
    assert.deepEqual(result, messages);
  });

  it('leaves structured json without stdout/stderr untouched', () => {
    const big = `${TSC_SAMPLE}\n${'padding line for size\n'.repeat(300)}`;
    const messages = [
      user('First request.'),
      {
        id: id(),
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: id(), toolName: 'codegraph-search', output: { type: 'json', value: { results: [big] } } }],
      } as ContextMessage,
      assistant('Fixing.'),
    ];
    const { messages: result, removedChars } = errorPass(messages, 1, { minChars: 500, contextLines: 8 });
    assert.equal(removedChars, 0);
    assert.deepEqual(result, messages);
  });

  it('never compresses file-read output even when it looks like a tsc dump', () => {
    // Regression: the error pass must only touch command/compiler/test tools.
    // A file read can legitimately contain pasted compiler output - replacing
    // it with an "error summary" would corrupt the model's view of the file.
    const big = `${TSC_SAMPLE}\n${'padding line for size\n'.repeat(300)}`;
    const messages = [
      user('First request.'),
      {
        id: id(),
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: id(), toolName: 'power---file-read', output: { type: 'text', value: big } }],
      } as ContextMessage,
      assistant('Fixing.'),
      user('Follow-up.'),
    ];
    const { messages: result, removedChars } = errorPass(messages, 1, { minChars: 500, contextLines: 8 });
    assert.equal(removedChars, 0);
    assert.deepEqual(result, messages);
  });

  it('never compresses file-read docs with Error: lines or ● bullets', () => {
    const doc = [
      'Error: this is a documentation heading, not a crash',
      ...Array.from({ length: 300 }, (_, i) => `● bullet ${i}: documentation content`),
    ].join('\n');
    const messages = [
      user('First request.'),
      {
        id: id(),
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: id(), toolName: 'power---file-read', output: { type: 'text', value: doc } }],
      } as ContextMessage,
      assistant('Fixing.'),
      user('Follow-up.'),
    ];
    const { messages: result, removedChars } = errorPass(messages, 1, { minChars: 500, contextLines: 8 });
    assert.equal(removedChars, 0);
    assert.deepEqual(result, messages);
  });
});

describe('error compression in the pipeline', () => {
  it('runs before truncate and reports errorChars', async () => {
    const big = `${TSC_SAMPLE}\n${'padding line for size\n'.repeat(300)}`;
    const messages = errorConversation(big);
    const config = makeConfig({ protectedTurns: 1, errors: { ...DEFAULT_CONFIG.errors, enabled: true, minChars: 500 } });
    const state = createCompressState();
    const { messages: result, report } = await compressMessages(messages, config, noopDeps, state, 't');

    assert.ok(report.errorChars > 0, 'error pass should engage');
    const text = result.find((m) => m.role === 'tool');
    const value = (text!.content as { output: { value: unknown } }[])[0].output.value as string;
    assert.match(value, /\[broke: error summary/);
    // The compressed summary is smaller than the original dump
    assert.ok(value.length < big.length);
  });

  it('is a no-op when errors.enabled is false', async () => {
    const big = `${TSC_SAMPLE}\n${'padding line for size\n'.repeat(300)}`;
    const messages = errorConversation(big);
    const config = makeConfig({ protectedTurns: 1, errors: { ...DEFAULT_CONFIG.errors, enabled: false, minChars: 500 } });
    const state = createCompressState();
    const { report } = await compressMessages(messages, config, noopDeps, state, 't');
    assert.equal(report.errorChars, 0);
  });

  it('never increases the total message size', async () => {
    const big = `${TSC_SAMPLE}\n${'padding line for size\n'.repeat(300)}`;
    const messages = errorConversation(big);
    const before = messagesChars(messages);
    const config = makeConfig({ protectedTurns: 1, errors: { ...DEFAULT_CONFIG.errors, enabled: true, minChars: 500 } });
    const state = createCompressState();
    const { messages: result } = await compressMessages(messages, config, noopDeps, state, 't');
    assert.ok(messagesChars(result) < before);
  });
});

describe('isCommandTool', () => {
  it('classifies command/compiler/test tools as compressible', () => {
    for (const name of ['power---bash', 'aider-desk-terminal', 'npm', 'test-runner-e2e', 'power---exec']) {
      assert.equal(isCommandTool(name), true, name);
    }
  });

  it('excludes file-read tools', () => {
    for (const name of ['power---file-read', 'power---file-write', 'power---grep', 'codegraph-search']) {
      assert.equal(isCommandTool(name), false, name);
    }
  });
});

describe('saveErrorOutput', () => {
  it('archives the output under <dir>/<task>/<call>-<hash>.log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-errors-'));
    try {
      const rel = saveErrorOutput('task-1', 'call-1', 'full output', dir);
      // Task dir AND file name carry an 8-char hash suffix of the original
      // id (F16) - derive the real dir name from disk instead of guessing.
      assert.ok(/^errors[\\/]task-1-[0-9a-f]{8}[\\/]call-1-[0-9a-f]{8}\.log$/.test(rel), rel);
      const taskDirs = readdirSync(dir);
      assert.equal(taskDirs.length, 1);
      const files = readdirSync(join(dir, taskDirs[0]));
      assert.equal(files.length, 1);
      assert.equal(readFileSync(join(dir, taskDirs[0], files[0]), 'utf-8'), 'full output');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes task and call ids for the file system', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-errors-'));
    try {
      const rel = saveErrorOutput('task/../evil', 'call:1?x', 'x', dir);
      // No path-traversal SEGMENT may survive sanitization ('..' glued into
      // a name like 'task_.._evil' is inert - it is a plain file name).
      assert.ok(!rel.split(/[\\/]/).includes('..'), rel);
      const taskDirs = readdirSync(dir);
      assert.equal(taskDirs.length, 1);
      assert.ok(taskDirs[0].startsWith('task_.._evil-'), taskDirs[0]);
      const files = readdirSync(join(dir, taskDirs[0]));
      assert.equal(files.length, 1);
      assert.ok(/^call_1_x-[0-9a-f]{8}\.log$/.test(files[0]), files[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never collides for long ids sharing the same 80-char prefix (F16)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-errors-'));
    try {
      const longA = 'a'.repeat(120);
      const longB = 'a'.repeat(80) + 'b'.repeat(40);
      saveErrorOutput('task-1', longA, 'first', dir);
      saveErrorOutput('task-1', longB, 'second', dir);
      const taskDirs = readdirSync(dir);
      assert.equal(taskDirs.length, 1);
      const files = readdirSync(join(dir, taskDirs[0]));
      assert.equal(files.length, 2, 'shared-prefix ids must not overwrite each other');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforceArchiveCap evicts oldest files first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-errors-'));
    try {
      // 8 files x 50B = 400B; cap 300B -> 5 files must survive (down to 250B).
      for (let i = 0; i < 4; i++) saveErrorOutput('a', `c${i}`, 'x'.repeat(50), dir);
      for (let i = 0; i < 4; i++) saveErrorOutput('b', `c${i}`, 'x'.repeat(50), dir);
      const dirs = readdirSync(dir);
      const dirA = dirs.find((d) => d.startsWith('a-'));
      const dirB = dirs.find((d) => d.startsWith('b-'));
      assert.ok(dirA && dirB, 'both task dirs must exist');
      // Make a-specific files older than b-specific files, so eviction is observable.
      const past = new Date(Date.now() - 3600_000);
      for (const f of readdirSync(join(dir, dirA))) {
        utimesSync(join(dir, dirA, f), past, past);
      }
      enforceArchiveCap(dir, 300, 200);
      const count = (d: string): number => readdirSync(join(dir, d)).filter((f) => f.endsWith('.log')).length;
      assert.equal(count(dirA), 0, 'oldest task files are evicted first');
      assert.equal(count(dirB), 4, 'newer files survive');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('evicts files older than retentionDays regardless of the cap (XF10)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-errors-'));
    try {
      saveErrorOutput('task-1', 'old', 'x'.repeat(50), dir);
      saveErrorOutput('task-1', 'fresh', 'x'.repeat(50), dir);
      const taskDir = join(dir, readdirSync(dir)[0]);
      const names = readdirSync(taskDir);
      const oldName = names.find((n) => n.startsWith('old-'));
      assert.ok(oldName, 'old file must exist before the sweep');
      const past = new Date(Date.now() - 2 * 86_400_000);
      utimesSync(join(taskDir, oldName), past, past);

      const result = enforceArchiveCap(dir, 100 * 1024 * 1024, 80 * 1024 * 1024, { retentionDays: 1 });
      assert.equal(result.removedFiles, 1, 'only the expired file is removed');
      const remaining = readdirSync(taskDir);
      assert.equal(remaining.length, 1);
      assert.ok(remaining[0].startsWith('fresh-'), remaining[0]);
    } finally {
      resetArchiveLedger(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sweeps via the ledger when the cap is exceeded, without an explicit call (XF9)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-errors-'));
    try {
      resetArchiveLedger(dir);
      // 8 files x 50B = 400B, cap 300B / watermark 200B: the save that
      // pushes the ledger over the cap must trigger eviction on its own.
      for (let i = 0; i < 8; i++) {
        saveErrorOutput('t', `c${i}`, 'x'.repeat(50), dir, { maxBytes: 300, watermarkBytes: 200 });
      }
      // After save 7 (400B) the sweep evicts c0-c2 (350->200). Save 8 (c7)
      // adds 50B -> 250B, below the cap: 5 files survive.
      const taskDir = join(dir, readdirSync(dir)[0]);
      const files = readdirSync(taskDir).filter((f) => f.endsWith('.log'));
      assert.equal(files.length, 5, 'ledger-triggered eviction trims to the watermark');
    } finally {
      resetArchiveLedger(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('age sweeps are throttled to once per interval (XF9)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-errors-'));
    try {
      resetArchiveLedger(dir);
      // First save: the ledger is fresh (lastSweepAt 0), so the retention
      // sweep runs now.
      saveErrorOutput('task-1', 'a', 'x'.repeat(50), dir, { retentionDays: 1 });
      const taskDir = join(dir, readdirSync(dir)[0]);
      const names = readdirSync(taskDir);
      const aName = names.find((n) => n.startsWith('a-'));
      assert.ok(aName);
      const past = new Date(Date.now() - 2 * 86_400_000);
      utimesSync(join(taskDir, aName), past, past);

      // A save shortly after the sweep must NOT sweep again (throttle).
      saveErrorOutput('task-1', 'b', 'x'.repeat(50), dir, { retentionDays: 1 });
      const after = readdirSync(taskDir);
      assert.ok(after.some((n) => n.startsWith('a-')), 'throttled sweep must leave the expired file in place');

      // An explicit sweep removes it.
      enforceArchiveCap(dir, 100 * 1024 * 1024, 80 * 1024 * 1024, { retentionDays: 1 });
      const final = readdirSync(taskDir);
      assert.ok(!final.some((n) => n.startsWith('a-')), 'explicit sweep removes the expired file');
    } finally {
      resetArchiveLedger(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('overwriting the same call id is accounted once, not double-counted (XF9)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-errors-'));
    try {
      resetArchiveLedger(dir);
      // The ledger decides WHEN a sweep runs (the scan itself is
      // authoritative). To observe the ledger we need a sweep with a
      // visible side effect: an expired file that only a triggered sweep
      // would remove.
      const opts = { maxBytes: 100, watermarkBytes: 50, retentionDays: 1 };
      saveErrorOutput('task-1', 'same-call', 'x'.repeat(50), dir, opts); // triggers the first retention sweep
      saveErrorOutput('task-1', 'same-call', 'x'.repeat(50), dir, opts); // overwrite: ledger stays at 50
      const taskDir = join(dir, readdirSync(dir)[0]);
      const names = readdirSync(taskDir);
      const sameName = names.find((n) => n.startsWith('same-call-'));
      assert.ok(sameName);
      const past = new Date(Date.now() - 2 * 86_400_000);
      utimesSync(join(taskDir, sameName), past, past);

      // Correct ledger: 50 + 50 = 100 <= cap -> no sweep, the expired file
      // stays. Double-counting would reach 150 > cap and the sweep would
      // evict the expired file (and trim to the watermark).
      saveErrorOutput('task-1', 'other', 'x'.repeat(50), dir, opts);
      const after = readdirSync(taskDir);
      assert.equal(after.length, 2, 'overwrite must not double the ledger');
      assert.ok(after.some((n) => n.startsWith('same-call-')), 'no sweep may have run');
    } finally {
      resetArchiveLedger(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clearArchive removes everything, reports counts and resets the ledger (XF10)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-errors-'));
    try {
      saveErrorOutput('task-1', 'c1', 'x'.repeat(50), dir);
      saveErrorOutput('task-1', 'c2', 'x'.repeat(100), dir);
      const result = clearArchive(dir);
      assert.equal(result.removedFiles, 2);
      assert.equal(result.removedBytes, 150);
      assert.equal(existsSync(dir), false, 'the archive directory is gone');

      // The ledger is reset: a fresh save works and is accounted from zero.
      const rel = saveErrorOutput('task-1', 'c3', 'y', dir);
      assert.ok(rel.includes('c3-'), rel);
      const taskDir = join(dir, readdirSync(dir)[0]);
      assert.equal(readdirSync(taskDir).length, 1);
    } finally {
      resetArchiveLedger(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('secret redaction in error output', () => {
  it('maskSecrets redacts api keys and bearer tokens', () => {
    const out = maskSecrets('error: sk-abcDEFgh1234567890XYZabcd failed\nAuthorization: Bearer tok_0123456789abcdefghijklmnopqrstuv\nAKIA1234567890ABCDEF\nok');
    assert.ok(!out.includes('sk-abcDEFgh1234567890XYZabcd'));
    assert.ok(!out.includes('tok_0123456789abcdefghijklmnopqrstuv'));
    assert.ok(!out.includes('AKIA1234567890ABCDEF'));
    assert.ok(out.includes('[REDACTED]'));
    assert.ok(out.includes('ok'));
  });

  it('errorPass redacts secrets from the generated summary', async () => {
    const text = `tsc output\nsrc/app.ts:1:1 - error TS2322: connect failed with sk-abcDEFgh1234567890XYZabcd\n  1  const x = 1;`;
    const messages: ContextMessage[] = [
      user('brief'),
      assistant('step'),
      tool('power---bash', text),
      user('q2'),
    ];
    const config = makeConfig({ protectedTurns: 1, errors: { ...DEFAULT_CONFIG.errors, enabled: true, minChars: 20 } });
    const state = createCompressState();
    const { messages: result } = await compressMessages(messages, config, noopDeps, state, 't');
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('sk-abcDEFgh1234567890XYZabcd'), 'summary must not leak the secret');
  });
});
