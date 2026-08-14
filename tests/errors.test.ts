import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextMessage } from '@aiderdesk/extensions';
import { errorPass, compressMessages, createCompressState, maskSecrets, type SummarizeDeps } from '../compress';
import { DEFAULT_CONFIG, type Config } from '../config';
import { enforceArchiveCap, extractErrorSummary, formatErrorSummary, isCommandTool, saveErrorOutput } from '../errors';
import { messagesChars } from '../tokens';

let seq = 0;
const id = (): string => `test-${++seq}`;

const user = (text: string): ContextMessage => ({ id: id(), role: 'user', content: text });
const assistant = (text: string): ContextMessage => ({ id: id(), role: 'assistant', content: text });
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
  return [
    user('Implement the billing module. Requirements: invoices, payments.'),
    toolJson('power---bash', { stdout: tscOutput, stderr: '', exitCode: 2 }),
    assistant('I see the errors — fixing them now.'),
    user('Also add CSV export.'),
  ];
}

/** Conversation with a single old oversized error output in the compressible region. */
function errorConversation(tscOutput: string): ContextMessage[] {
  return [
    user('Implement the billing module. Requirements: invoices, payments.'),
    tool('power---bash', tscOutput),
    assistant('I see the errors — fixing them now.'),
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
    const formatted = formatErrorSummary(r, ' — full output removed');
    assert.match(formatted, /… \[broke: error summary — \d+ lines → \d+ lines\] — full output removed/);
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
  it('archives the output under <dir>/<task>/<call>.log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-errors-'));
    try {
      const rel = saveErrorOutput('task-1', 'call-1', 'full output', dir);
      assert.equal(rel, join('errors', 'task-1', 'call-1.log'));
      assert.equal(readFileSync(join(dir, 'task-1', 'call-1.log'), 'utf-8'), 'full output');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes task and call ids for the file system', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-errors-'));
    try {
      const rel = saveErrorOutput('task/../evil', 'call:1?x', 'x', dir);
      // No path-traversal SEGMENT may survive sanitization ('..' glued into
      // a name like 'task_.._evil' is inert — it is a plain file name).
      assert.ok(!rel.split(/[\\/]/).includes('..'), rel);
      assert.ok(existsSync(join(dir, 'task_.._evil', 'call_1_x.log')));
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
      // Make a-specific files older than b-specific files, so eviction is observable.
      const past = new Date(Date.now() - 3600_000);
      const { utimesSync } = require('node:fs');
      for (let i = 0; i < 4; i++) {
        utimesSync(join(dir, 'a', `c${i}.log`), past, past);
      }
      enforceArchiveCap(dir, 300, 200);
      const count = (d: string): number => readdirSync(join(dir, d)).filter((f) => f.endsWith('.log')).length;
      assert.equal(count('a'), 0, 'oldest task files are evicted first');
      assert.equal(count('b'), 4, 'newer files survive');
    } finally {
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
