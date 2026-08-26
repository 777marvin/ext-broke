import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ContextMessage } from '@aiderdesk/extensions';
import { compressMessages, createCompressState, type SummarizeDeps } from '../compress';
import { DEFAULT_CONFIG } from '../config';
import { formatValidationFailures, validateContext } from '../validate';

let seq = 0;
const id = (): string => `vtest-${++seq}`;

const user = (text: string): ContextMessage => ({ id: id(), role: 'user', content: text });
const assistant = (text: string): ContextMessage => ({ id: id(), role: 'assistant', content: text });

const assistantWithCalls = (callIds: string[], toolName = 'bash'): ContextMessage => ({
  id: id(),
  role: 'assistant',
  content: callIds.map((callId) => ({ type: 'tool-call', toolCallId: callId, toolName, input: {} })),
});
const toolFor = (callId: string, value = 'out'): ContextMessage => ({
  id: id(),
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: callId, toolName: 'bash', output: { type: 'text', value } }],
});

/** Well-formed conversation: every call answered, no duplicates. */
function validConversation(): ContextMessage[] {
  const c1 = `call-${++seq}`;
  const c2 = `call-${++seq}`;
  return [user('task'), assistantWithCalls([c1]), toolFor(c1), assistant('done'), user('next'), assistantWithCalls([c2]), toolFor(c2), assistant('ok')];
}

describe('validateContext', () => {
  it('accepts a well-formed conversation', () => {
    assert.deepEqual(validateContext(validConversation()), []);
  });

  it('ignores plain-string messages and non-array content', () => {
    const msgs: ContextMessage[] = [
      user('hello'),
      assistant('hi'),
      { id: id(), role: 'system', content: null } as unknown as ContextMessage,
    ];
    assert.deepEqual(validateContext(msgs), []);
  });

  it('flags a tool-result whose producing tool-call is missing (orphaned result)', () => {
    const msgs = validConversation();
    msgs.push({ id: id(), role: 'tool', content: [{ type: 'tool-result', toolCallId: 'ghost-call', toolName: 'bash', output: { type: 'text', value: 'x' } }] });
    const failures = validateContext(msgs);
    assert.equal(failures.length, 1);
    assert.match(failures[0].reason, /tool-result 'ghost-call' has no matching tool-call/);
    assert.equal(failures[0].index, msgs.length - 1);
  });

  it('flags a tool-call whose result was removed (orphaned call)', () => {
    const msgs: ContextMessage[] = [user('task'), assistantWithCalls(['lost-call']), assistant('skipped the result')];
    const failures = validateContext(msgs);
    assert.equal(failures.length, 1);
    assert.match(failures[0].reason, /tool-call 'lost-call' has no matching tool-result/);
  });

  it('flags duplicated tool-call ids across messages', () => {
    const msgs: ContextMessage[] = [
      user('task'),
      assistantWithCalls(['dup-1']),
      toolFor('dup-1'),
      assistantWithCalls(['dup-1']), // same id again
      toolFor('dup-1'),
    ];
    const failures = validateContext(msgs);
    assert.equal(failures.filter((f) => f.reason.includes('duplicate tool-call')).length, 1);
  });

  it('flags duplicated tool-result ids across messages', () => {
    const msgs: ContextMessage[] = [
      user('task'),
      assistantWithCalls(['dup-r']),
      toolFor('dup-r'),
      toolFor('dup-r'),
    ];
    const failures = validateContext(msgs);
    assert.equal(failures.filter((f) => f.reason.includes('duplicate tool-result')).length, 1);
  });

  it('ignores parts without string toolCallId', () => {
    const msgs: ContextMessage[] = [
      user('task'),
      {
        id: id(),
        role: 'assistant',
        content: [{ type: 'tool-call' }, { type: 'text', text: 'no ids here' }],
      } as unknown as ContextMessage,
    ];
    assert.deepEqual(validateContext(msgs), []);
  });

  it('formatValidationFailures renders index + reason', () => {
    const line = formatValidationFailures([{ index: 3, reason: 'boom' }]);
    assert.equal(line, '#3: boom');
  });
});

describe('compressMessages validation revert path', () => {
  const deps: SummarizeDeps = {
    generateLocal: async () => undefined,
    generateCloud: async () => undefined,
  };

  it('reverts to the ORIGINAL messages when the validator rejects the output', async () => {
    const messages = validConversation();
    const state = createCompressState();
    const { messages: out, report } = await compressMessages(messages, DEFAULT_CONFIG, deps, state, 'task-v', {
      validate: () => [{ index: 2, reason: 'injected failure' }],
      onValidationFailure: (line) => {
        assert.match(line, /context validation failed \(#2: injected failure\)/);
      },
    });
    // Original input passes through untouched.
    assert.equal(out, messages);
    // Honest accounting: no savings claimed.
    assert.equal(report.touched, false);
    assert.equal(report.structuralChars, 0);
    assert.equal(report.totalCharsAfter, report.totalCharsBefore);
  });

  it('keeps the summarizer cost side when reverting after an LLM call', async () => {
    // Region construction: protectedTurns=2 keeps the LAST 2 user turns, so
    // the compressible region only contains >=2 user turns when the
    // conversation has >=4 in total (turns #2 and #3 fall inside it).
    const filler = (t: string): ContextMessage => assistant(`${t} ${'x'.repeat(500)}`);
    const bigRegion: ContextMessage[] = [
      user('brief'),
      filler('a1'),
      user('second'),
      filler('a2'),
      user('third'),
      filler('a3'),
      user('fourth'),
      filler('a4'),
      user('fifth'),
      assistant('tail'),
    ];
    const config = {
      ...DEFAULT_CONFIG,
      level: 'summarize' as const,
      maxContextChars: 1000,
      summarize: { ...DEFAULT_CONFIG.summarize, minChars: 100, via: 'cloud' as const, afterTurns: 2 },
    };
    let cloudCalls = 0;
    const callingDeps: SummarizeDeps = {
      generateLocal: async () => undefined,
      generateCloud: async () => {
        cloudCalls++;
        return 'a summary small enough to pass size gates';
      },
    };
    const state = createCompressState();
    const { report } = await compressMessages(bigRegion, config, callingDeps, state, 'task-cost', {
      validate: () => [{ index: 0, reason: 'reject everything' }],
    });
    // The summarizer LLM call really happened - its cost must survive the revert.
    assert.equal(cloudCalls, 1);
    assert.equal(report.summarizeCalls, 1);
    assert.equal(report.summarizer, 'cloud');
  });

  it('does NOT revert when the input context was already invalid', async () => {
    // Pre-corrupt input (orphaned result, no holder) - the provider call
    // fails regardless of compression, so reverting would only disable
    // broke permanently. The compressed output must still ship.
    const messages: ContextMessage[] = [
      user('brief'),
      assistant(''),
      { id: id(), role: 'tool', content: [{ type: 'tool-result', toolCallId: 'ghost', toolName: 'bash', output: { type: 'text', value: 'x' } }] } as ContextMessage,
      user('second'),
      assistant('middle work'),
      user('third'),
      assistant('tail'),
    ];
    const state = createCompressState();
    let warned = 0;
    const { messages: out } = await compressMessages(messages, DEFAULT_CONFIG, deps, state, 'task-pre', {
      validate: () => [{ index: 0, reason: 'reject everything' }],
      onValidationFailure: () => {
        warned++;
      },
    });
    assert.equal(warned, 0);
    assert.notEqual(out, messages); // compression was applied, not reverted
    // The empty assistant inside the region was structurally dropped.
    assert.equal(out.length, messages.length - 1);
    assert.ok(!out.some((m) => m.role === 'assistant' && m.content === ''));
  });

  it('passes valid output through unchanged behavior (validator default)', async () => {
    const messages = validConversation();
    const state = createCompressState();
    const { messages: out, report } = await compressMessages(messages, DEFAULT_CONFIG, deps, state, 'task-ok');
    // Small conversation below all gates: nothing touched, no failure logged.
    assert.equal(out, messages);
    assert.equal(report.touched, false);
  });
});
