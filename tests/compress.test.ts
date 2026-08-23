import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ContextMessage } from '@aiderdesk/extensions';
import {
  compressibleRange,
  compressMessages,
  createCompressState,
  errorPass,
  isSummaryMessage,
  maskSecrets,
  structuralPass,
  summarizePass,
  truncatePass,
  SUMMARY_MARKER,
  UNTRUSTED_SUMMARY_NOTE,
  type SummarizeDeps,
} from '../compress';
import { DEFAULT_CONFIG, type Config } from '../config';
import { estimateTokens, messageChars, messagesChars } from '../tokens';

let seq = 0;
const id = (): string => `test-${++seq}`;

const user = (text: string): ContextMessage => ({ id: id(), role: 'user', content: text });
const assistant = (text: string): ContextMessage => ({ id: id(), role: 'assistant', content: text });
const tool = (toolName: string, value: string): ContextMessage => ({
  id: id(),
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id(), toolName, output: { type: 'text', value } }],
});
/** Tool message whose result references a specific tool-call id (realistic pairing). */
const toolFor = (callId: string, toolName: string, value: string): ContextMessage => ({
  id: id(),
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: callId, toolName, output: { type: 'text', value } }],
});
const assistantWithCall = (callId: string, toolName: string, input: Record<string, unknown>): ContextMessage => ({
  id: id(),
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: callId, toolName, input }],
});
/** Assistant message issuing several parallel tool-calls (realistic multi-call holder). */
const assistantWithCalls = (callIds: string[], toolName: string, input: Record<string, unknown>): ContextMessage => ({
  id: id(),
  role: 'assistant',
  content: callIds.map((callId) => ({ type: 'tool-call', toolCallId: callId, toolName, input })),
});
/** Tool message answering several calls at once. */
const multiToolFor = (callIds: string[], toolName: string, values: string[]): ContextMessage => ({
  id: id(),
  role: 'tool',
  content: callIds.map((callId, i) => ({
    type: 'tool-result',
    toolCallId: callId,
    toolName,
    output: { type: 'text', value: values[i] ?? '' },
  })),
});
const collectCallIds = (msgs: ContextMessage[]): string[] =>
  msgs.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content
          .filter((p) => (p as { type?: string }).type === 'tool-call')
          .map((p) => (p as { toolCallId?: string }).toolCallId ?? '')
      : [],
  );
const collectResultIds = (msgs: ContextMessage[]): string[] =>
  msgs.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content
          .filter((p) => (p as { type?: string }).type === 'tool-result')
          .map((p) => (p as { toolCallId?: string }).toolCallId ?? '')
      : [],
  );
/** Broke must never orphan a tool-call: every remaining call keeps its result. */
const assertPairingInvariant = (msgs: ContextMessage[]): void => {
  const results = collectResultIds(msgs);
  for (const call of collectCallIds(msgs)) {
    assert.ok(results.includes(call), `tool-call ${call} lost its result`);
  }
};

/** 10-turn synthetic conversation: brief + 4 pairs (assistant + tool) per turn. */
function conversation(): ContextMessage[] {
  const msgs: ContextMessage[] = [user('Brief: build the billing module.')];
  for (let turn = 1; turn <= 4; turn++) {
    msgs.push(assistant(`Step ${turn}: working on feature ${turn}.`));
    msgs.push(tool('power---bash', `output of turn ${turn}\nline2\nline3\nline4\nline5`));
    msgs.push(user(`User follow-up ${turn}.`));
  }
  return msgs;
}

/** Conversation whose compressible region (protectedTurns=1) holds 2 user turns.
 *  The file-read payload is padded so the region (~500 chars) stays larger
 *  than the framed summary message (~250 chars): XF6 forbids swaps that grow
 *  the context, and the synthetic fixture must still produce a reduction. */
function summaryConversation(): ContextMessage[] {
  return [
    user('Brief: build the billing module.'),
    assistant('Step 1: reading the module.'),
    tool('power---file-read', `file content line a\nfile content line b\n${'x'.repeat(350)}`),
    user('Add a discount field.'),
    assistant('Step 2: editing.'),
    tool('power---file-edit', 'edit ok'),
    user('Run the tests.'),
    assistant('Step 3: running tests.'),
    tool('power---bash', 'all tests pass'),
    user('Protected tail.'),
  ];
}

function summarizeConfig(over: Partial<Config['summarize']> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    summarize: { ...DEFAULT_CONFIG.summarize, afterTurns: 2, minChars: 60, maxSummaryChars: 2000, ...over },
  };
}

function countingDeps(calls: { n: number; inputs: string[] }, stub = 'Summary: billing module with discount; tests pass.'): SummarizeDeps {
  return {
    generateLocal: async (_model, prompt) => {
      calls.n += 1;
      calls.inputs.push(prompt);
      return stub;
    },
    generateCloud: async () => undefined,
  };
}

describe('estimateTokens', () => {
  it('uses the chars/4 heuristic', () => {
    assert.equal(estimateTokens(100), 25);
    assert.equal(estimateTokens(0), 0);
  });
});

describe('messageChars', () => {
  it('handles string and part-based content', () => {
    assert.equal(messageChars(user('hello world')), 11);
    const toolMsg = tool('power---bash', 'abc');
    assert.equal(messageChars(toolMsg), 3);
  });
});

describe('compressibleRange', () => {
  it('protects the task brief and the last N user turns', () => {
    const msgs = conversation();
    const { start, end } = compressibleRange(msgs, 2);
    // brief (index 0) is always protected; last 2 user turns protected
    assert.equal(start, 1);
    assert.ok(end < msgs.length);
    // the two newest user messages are outside the region
    const region = msgs.slice(start, end);
    assert.ok(!region.some((m) => m.id === msgs[msgs.length - 1].id));
    assert.ok(!region.some((m) => m.id === msgs[msgs.length - 3].id));
  });

  it('returns an empty region for short conversations', () => {
    const { start, end } = compressibleRange([user('a'), assistant('b')], 6);
    assert.ok(start >= end);
  });

  it('falls back to protecting only the current step for few user turns', () => {
    // The common AiderDesk pattern: one task brief + a long tool loop.
    const msgs: ContextMessage[] = [user('Brief: audit the extension.')];
    for (let i = 1; i <= 20; i++) {
      msgs.push(assistant(`Step ${i}: inspecting.`));
      msgs.push(tool('power---bash', `output ${i}`));
    }
    const { start, end } = compressibleRange(msgs, 6);
    assert.equal(start, 1);
    // Only the current step stays protected - and the pairing clamp pulls
    // the boundary one further back: the raw cut (length - 5) lands on a
    // tool result whose call would stay inside the region (orphaned
    // result), so the region must end before its holder instead.
    assert.equal(end, msgs.length - 6);
    assert.notEqual(msgs[end]?.role, 'tool');
    const region = msgs.slice(start, end);
    assert.ok(region.length >= 15);
    assert.ok(!region.some((m) => m.id === msgs[msgs.length - 1].id));
    assert.ok(!region.some((m) => m.id === msgs[msgs.length - 5].id));
    assert.ok(region.some((m) => m.id === msgs[5].id));
  });

  it('never ends the region between a tool-call and its result (pairing clamp)', () => {
    const msgs: ContextMessage[] = [
      user('brief'),
      assistantWithCall('c1', 'power---bash', { command: 'echo 1' }),
      toolFor('c1', 'power---bash', 'out 1'),
      assistantWithCall('c2', 'power---bash', { command: 'echo 2' }),
      toolFor('c2', 'power---bash', 'out 2'),
      assistant('filler 1'),
      assistant('filler 2'),
      assistant('filler 3'),
      assistant('filler 4'),
    ];
    // Length 9 → raw fallback cut at 9-5=4, which is exactly T(res-c2):
    // without the clamp the call c2 would be summarized away while its
    // result survives outside the region.
    const range = compressibleRange(msgs, 10);
    assert.deepEqual(range, { start: 1, end: 3 });
    assert.notEqual(msgs[range.end]?.role, 'tool');
  });

  it('never starts the region on an orphaned tool result (pairing clamp)', () => {
    const msgs: ContextMessage[] = [
      user('brief'),
      toolFor('c0', 'power---bash', 'result without holder'),
      assistantWithCall('c1', 'power---bash', { command: 'echo 1' }),
      toolFor('c1', 'power---bash', 'out 1'),
      user('q2'),
      user('q3'),
      user('q4'),
    ];
    const range = compressibleRange(msgs, 1);
    assert.deepEqual(range, { start: 2, end: 6 });
    assert.notEqual(msgs[range.start]?.role, 'tool');
  });

  it('protects two user turns when enough turns exist (default)', () => {
    const msgs: ContextMessage[] = [user('brief')];
    for (let turn = 1; turn <= 4; turn++) {
      msgs.push(assistant(`step ${turn}`));
      msgs.push(tool('power---bash', `out ${turn}`));
      msgs.push(user(`follow-up ${turn}`));
    }
    const { start, end } = compressibleRange(msgs, DEFAULT_CONFIG.protectedTurns);
    assert.equal(DEFAULT_CONFIG.protectedTurns, 2);
    assert.equal(start, 1);
    assert.ok(end < msgs.length);
    const region = msgs.slice(start, end);
    // the two newest user turns are outside the region
    assert.ok(!region.some((m) => m.role === 'user' && m.content === 'follow-up 4'));
    assert.ok(!region.some((m) => m.role === 'user' && m.content === 'follow-up 3'));
  });

  it('has a lossy-pass threshold below the built-in emergency threshold', () => {
    assert.equal(DEFAULT_CONFIG.maxContextChars, 60000);
  });
});

describe('structuralPass', () => {
  it('dedupes identical adjacent tool results', () => {
    const msgs: ContextMessage[] = [
      user('brief'),
      assistantWithCalls(['call-1', 'call-2'], 'power---bash', { command: 'git status' }),
      toolFor('call-1', 'power---bash', 'same output'),
      toolFor('call-2', 'power---bash', 'same output'),
      user('q2'),
    ];
    const { messages: out, removedChars } = structuralPass(msgs, 1);
    assert.equal(out.length, msgs.length - 1);
    assert.ok(removedChars > 0);
    assert.equal(out.filter((m) => m.role === 'tool').length, 1);
    assertPairingInvariant(out);
  });

  it('keeps different tool results', () => {
    const msgs = [user('brief'), assistant('a1'), tool('power---bash', 'one'), tool('power---bash', 'two'), user('q2')];
    const { messages: out } = structuralPass(msgs, 1);
    assert.equal(out.filter((m) => m.role === 'tool').length, 2);
  });

  it('dedupes a repeated call sequence together with its matching call', () => {
    const msgs: ContextMessage[] = [
      user('brief'),
      assistantWithCall('call-1', 'power---bash', { command: 'git status' }),
      toolFor('call-1', 'power---bash', 'clean working tree'),
      assistantWithCall('call-2', 'power---bash', { command: 'git status' }),
      toolFor('call-2', 'power---bash', 'clean working tree'),
      user('q2'),
    ];
    const { messages: out, removedChars } = structuralPass(msgs, 1);
    assert.ok(removedChars > 0);
    // The second call AND its result are gone; the first call keeps its result.
    assert.equal(out.filter((m) => m.role === 'tool').length, 1);
    assert.ok(out.some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('call-1')));
    assert.ok(!out.some((m) => JSON.stringify(m.content).includes('call-2')));
  });

  it('dedupes parallel tool calls together with ALL their matching calls', () => {
    // assistant(call A, call B) → tool(A) → tool(B) where B repeats A:
    // the duplicate AND its call must both go, leaving one intact pair.
    const msgs: ContextMessage[] = [
      user('brief'),
      assistantWithCalls(['call-a', 'call-b'], 'power---bash', { command: 'git status' }),
      toolFor('call-a', 'power---bash', 'clean working tree'),
      toolFor('call-b', 'power---bash', 'clean working tree'),
      user('q2'),
    ];
    const { messages: out, removedChars } = structuralPass(msgs, 1);
    assert.ok(removedChars > 0);
    const calls = collectCallIds(out);
    const results = collectResultIds(out);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls, results);
    assertPairingInvariant(out);
  });

  it('keeps identical results produced by DIFFERENT tool inputs (XF1)', () => {
    // bash("echo 1") and bash("printf '1'") yield the same output but are
    // different actions - dedupe must not erase the second one.
    const msgs: ContextMessage[] = [
      user('brief'),
      assistantWithCall('call-1', 'power---bash', { command: 'echo 1' }),
      toolFor('call-1', 'power---bash', '1'),
      assistantWithCall('call-2', 'power---bash', { command: "printf '1'" }),
      toolFor('call-2', 'power---bash', '1'),
      user('q2'),
    ];
    const { messages: out, removedChars } = structuralPass(msgs, 1);
    assert.equal(removedChars, 0);
    assert.equal(out.filter((m) => m.role === 'tool').length, 2);
    assert.deepEqual(collectCallIds(out), ['call-1', 'call-2']);
    assertPairingInvariant(out);
  });

  it('keeps adjacent identical results with different inputs (XF1, parallel)', () => {
    const msgs: ContextMessage[] = [
      user('brief'),
      {
        id: id(),
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'power---bash', input: { command: 'echo 1' } },
          { type: 'tool-call', toolCallId: 'call-2', toolName: 'power---bash', input: { command: 'printf 1' } },
        ],
      },
      toolFor('call-1', 'power---bash', '1'),
      toolFor('call-2', 'power---bash', '1'),
      user('q2'),
    ];
    const { messages: out, removedChars } = structuralPass(msgs, 1);
    assert.equal(removedChars, 0);
    assert.equal(out.filter((m) => m.role === 'tool').length, 2);
    assertPairingInvariant(out);
  });

  it('keeps the duplicate tool result when its call holder is missing', () => {
    // No assistant message holds these calls (e.g. the holder was compacted
    // away). Dedupe must abort instead of removing the result and orphaning
    // the call - that would break the next provider call.
    const msgs = [
      user('brief'),
      toolFor('call-a', 'power---bash', 'same output'),
      toolFor('call-b', 'power---bash', 'same output'),
      user('q2'),
    ];
    const { messages: out } = structuralPass(msgs, 1);
    assert.equal(out.filter((m) => m.role === 'tool').length, 2);
  });

  it('keeps an all-empty tool message when its calls cannot be removed', () => {
    const msgs = [
      user('brief'),
      toolFor('call-a', 'power---bash', ''),
      toolFor('call-b', 'power---bash', ''),
      user('q2'),
    ];
    const { messages: out } = structuralPass(msgs, 1);
    assert.equal(out.filter((m) => m.role === 'tool').length, 2);
  });

  it('drops empty tool results only together with their calls', () => {
    const msgs: ContextMessage[] = [
      user('brief'),
      assistantWithCalls(['call-a', 'call-b'], 'power---file-read', { path: 'x.ts' }),
      multiToolFor(['call-a', 'call-b'], 'power---file-read', ['', 'real content']),
      user('q2'),
    ];
    const { messages: out } = structuralPass(msgs, 1);
    // The empty result (call-a) is trimmed together with its call; call-b stays intact.
    assert.deepEqual(collectCallIds(out), ['call-b']);
    assert.deepEqual(collectResultIds(out), ['call-b']);
    assertPairingInvariant(out);
  });

  it('never orphans a tool-call on synthetic conversations', () => {
    const msgs = conversation();
    const { messages: out } = structuralPass(msgs, 1);
    assertPairingInvariant(out);
  });

  it('merges consecutive assistant text messages', () => {
    const msgs = [user('brief'), assistant('part one'), assistant('part two'), user('q2')];
    const { messages: out } = structuralPass(msgs, 1);
    const assistants = out.filter((m) => m.role === 'assistant');
    assert.equal(assistants.length, 1);
    assert.ok(JSON.stringify(assistants[0].content).includes('part one'));
    assert.ok(JSON.stringify(assistants[0].content).includes('part two'));
  });

  it('counts merges as 0 saved chars - no phantom savings (F5)', () => {
    // Merging keeps the full text in the context (plus a separator), so it
    // must not count as saved chars.
    const msgs = [user('brief'), assistant('part one'), assistant('part two'), user('q2')];
    const { messages: out, removedChars } = structuralPass(msgs, 1);
    assert.equal(out.filter((m) => m.role === 'assistant').length, 1); // the merge DID happen
    assert.equal(removedChars, 0); // but it reports no savings
  });

  it('drops empty assistant messages', () => {
    const msgs = [user('brief'), assistant(''), assistant('real work'), user('q2')];
    const { messages: out } = structuralPass(msgs, 1);
    assert.equal(out.length, 3);
    assert.ok(!out.some((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content === ''));
  });

  it('keeps assistant messages that carry non-text parts (files)', () => {
    const rich: ContextMessage = {
      id: id(),
      role: 'assistant',
      content: [
        { type: 'file', data: 'data:image/png;base64,AAAA', filename: 'screenshot.png', mediaType: 'image/png' },
        { type: 'text', text: '' },
      ],
    };
    const msgs = [user('brief'), rich, user('q2')];
    const { messages: out } = structuralPass(msgs, 1);
    assert.equal(out.length, msgs.length);
    assert.ok(out.some((m) => m.role === 'assistant'));
  });

  it('does not merge assistant messages with reasoning parts', () => {
    const rich: ContextMessage = {
      id: id(),
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking…' },
        { type: 'text', text: 'visible answer' },
      ],
    };
    const msgs = [user('brief'), rich, assistant('follow-up text'), user('q2')];
    const { messages: out } = structuralPass(msgs, 1);
    const assistants = out.filter((m) => m.role === 'assistant');
    assert.equal(assistants.length, 2);
    assert.ok(JSON.stringify(assistants[0].content).includes('thinking…'));
  });
});

describe('truncatePass', () => {
  it('truncates oversized old tool outputs head+tail with a marker', () => {
    const big = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const msgs = [user('brief'), assistant('a1'), tool('power---bash', big), user('q2')];
    const { messages: out, removedChars } = truncatePass(msgs, 1, 100, 20, 2000);
    assert.ok(removedChars > 0);
    const toolMsg = out.find((m) => m.role === 'tool');
    assert.ok(toolMsg);
    const text = JSON.stringify(toolMsg.content);
    assert.ok(text.includes('broke: truncated'));
    assert.ok(text.includes('line 0'));
    assert.ok(text.includes('line 299'));
  });

  it('actually truncates at the smallest valid maxLines (1-4, slice(-0) trap)', () => {
    // maxLines 1-2 produce tailLines=0; slice(-0) returns the whole array in
    // JS. Without the guard the pass would either expand or silently skip
    // truncation - a valid config must always reduce oversized output.
    const big = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    for (const maxLines of [1, 2, 3, 4]) {
      const msgs = [user('brief'), assistant('a1'), tool('power---bash', big), user('q2')];
      const { messages: out, removedChars } = truncatePass(msgs, 1, maxLines, 20, 2000);
      assert.ok(removedChars > 0, `maxLines=${maxLines}: truncation must actually reduce the output`);
      const text = JSON.stringify(out[2].content);
      assert.ok(text.includes('broke: truncated'), `maxLines=${maxLines}: marker expected`);
      assert.ok(!text.includes('line 25'), `maxLines=${maxLines}: middle must be cut`);
    }
  });

  it('enforces the KB cap even after line truncation (XF5)', () => {
    // 60 lines x 500 chars = 30 KB. The line pass keeps 50 lines (~25 KB),
    // still over the 20 KB cap - the combined pass must end at <= 20 KB.
    const big = Array.from({ length: 60 }, () => 'L'.repeat(500)).join('\n');
    const msgs = [user('brief'), assistant('a1'), tool('power---bash', big), user('q2')];
    const { messages: out, removedChars } = truncatePass(msgs, 1, 50, 20, 2000);
    assert.ok(removedChars > 0);
    const toolMsg = out.find((m) => m.role === 'tool');
    const value = (toolMsg?.content as { output?: { value?: string } }[])[0]?.output?.value ?? '';
    assert.ok(value.length > 0 && value.length <= 20 * 1024, `kept ${value.length} chars, cap 20480`);
    assert.ok(value.includes('lines →'), 'the line marker must still be present');
    assert.ok(value.includes('KB →'), 'the KB marker must be present (both limits applied)');
  });

  it('applies only the KB pass when the line count is within limits', () => {
    // One 30 KB line: the line pass is skipped, only the KB cap applies.
    const big = 'L'.repeat(30 * 1024);
    const msgs = [user('brief'), assistant('a1'), tool('power---bash', big), user('q2')];
    const { messages: out, removedChars } = truncatePass(msgs, 1, 50, 20, 2000);
    assert.ok(removedChars > 0);
    const toolMsg = out.find((m) => m.role === 'tool');
    const value = (toolMsg?.content as { output?: { value?: string } }[])[0]?.output?.value ?? '';
    assert.ok(value.length > 0 && value.length <= 20 * 1024, `kept ${value.length} chars, cap 20480`);
    assert.ok(!value.includes('lines →'), 'no line marker when the line pass did not run');
  });

  it('leaves small outputs untouched', () => {
    const msgs = [user('brief'), assistant('a1'), tool('power---bash', 'tiny output'), user('q2')];
    const { messages: out, removedChars } = truncatePass(msgs, 1, 100, 20, 2000);
    assert.equal(removedChars, 0);
    assert.equal(out.length, msgs.length);
  });

  it('truncates oversized json tool outputs', () => {
    const huge = { rows: Array.from({ length: 5000 }, (_, i) => ({ id: i, payload: 'x'.repeat(50) })) };
    const msgs: ContextMessage[] = [
      user('brief'),
      assistant('a1'),
      { id: id(), role: 'tool', content: [{ type: 'tool-result', toolCallId: id(), toolName: 'power---semantic-search', output: { type: 'json', value: huge } }] },
      user('q2'),
    ];
    const { messages: out, removedChars } = truncatePass(msgs, 1, 100, 10, 2000);
    assert.ok(removedChars > 0);
    const toolMsg = out.find((m) => m.role === 'tool');
    assert.ok(toolMsg);
    assert.ok(JSON.stringify(toolMsg.content).includes('broke: truncated'));
  });

  it('keeps structured command outputs structured, preserving exitCode and metadata (XF7)', () => {
    const big = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const msgs: ContextMessage[] = [
      user('brief'),
      assistant('a1'),
      {
        id: id(),
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: id(),
            toolName: 'power---bash',
            output: { type: 'json', value: { stdout: big, stderr: 'warnings', exitCode: 1, durationMs: 42 } },
          },
        ],
      },
      user('q2'),
    ];
    const { messages: out, removedChars } = truncatePass(msgs, 1, 100, 20, 2000);
    assert.ok(removedChars > 0);
    const toolMsg = out.find((m) => m.role === 'tool');
    const part = (
      toolMsg?.content as { output?: { type?: string; value?: { exitCode?: number; stdout?: string; stderr?: string; durationMs?: number } } }[]
    )[0];
    assert.equal(part.output?.type, 'json', 'structured output must keep its type');
    assert.equal(part.output?.value?.exitCode, 1, 'exitCode must survive truncation');
    assert.equal(part.output?.value?.durationMs, 42, 'other metadata must survive truncation');
    assert.equal(part.output?.value?.stderr, '', 'stderr is emptied by the wrap');
    assert.ok((part.output?.value?.stdout ?? '').includes('broke: truncated'));
    assert.ok((part.output?.value?.stdout ?? '').includes('line 299'), 'tail survives');
  });

  it('trims oversized tool-call inputs in old assistant messages', () => {
    const hugeInput = { data: 'x'.repeat(5000) };
    const msgs: ContextMessage[] = [
      user('brief'),
      { id: id(), role: 'assistant', content: [{ type: 'tool-call', toolCallId: id(), toolName: 'power---file-write', input: hugeInput }] },
      tool('power---file-write', 'ok'),
      user('q2'),
    ];
    const { messages: out, removedChars } = truncatePass(msgs, 1, 100, 20, 2000);
    assert.ok(removedChars > 0);
    const assistantMsg = out.find((m) => m.role === 'assistant');
    const callPart = assistantMsg?.content[0] as { input?: unknown };
    assert.ok(callPart && typeof callPart.input === 'object' && callPart.input !== null);
    assert.ok('__broke' in (callPart.input as Record<string, unknown>));
  });

  it('protects recent turns', () => {
    const big = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    // 6+ user turns so the last 3 are protected; the oversized output sits in a recent turn
    const msgs = [
      user('brief'),
      assistant('a1'),
      tool('power---bash', 'small'),
      user('q2'),
      assistant('a2'),
      tool('power---bash', big),
      user('q3'),
    ];
    const { removedChars } = truncatePass(msgs, 3, 100, 20, 2000);
    assert.equal(removedChars, 0);
  });
});

describe('errorPass', () => {
  it('never reports negative savings when the summary is LONGER than the input (F18)', () => {
    // A single short tsc error line: the marker line alone is longer than
    // the input, so the savings must be clamped to 0. The rewrite still
    // happens (the redacted summary replaces the raw text).
    const msgs: ContextMessage[] = [
      user('brief'),
      assistant('running'),
      tool('power---bash', 'src/app.ts:1:1 - error TS2322: boom'),
      user('q2'),
    ];
    const { messages: out, removedChars } = errorPass(msgs, 1, { minChars: 5, contextLines: 8 });
    assert.equal(removedChars, 0);
    assert.ok(JSON.stringify(out[2].content).includes('broke: error summary'), 'matched error output is still replaced by its redacted summary');
  });

  it('still compresses a large matching output', () => {
    const big = Array.from({ length: 300 }, (_, i) => `src/billing.ts:${10 + i}:5 - error TS2554: Expected 2 arguments, but got 1.`).join('\n');
    const msgs: ContextMessage[] = [user('brief'), assistant('running'), tool('power---bash', big), user('q2')];
    const { messages: out, removedChars } = errorPass(msgs, 1, { minChars: 8000, contextLines: 8 });
    assert.ok(removedChars > 0);
    assert.ok(JSON.stringify(out[2].content).includes('broke: error summary'));
  });
});

describe('summarizePass', () => {
  it('generates a summary and replaces the compressible region', async () => {
    const msgs = summaryConversation();
    const state = createCompressState();
    const calls = { n: 0, inputs: [] as string[] };
    const deps = countingDeps(calls);
    const r = await summarizePass(msgs, 1, summarizeConfig(), deps, state, 'task-sum-1');
    assert.equal(calls.n, 1);
    assert.equal(r.summarizeCalls, 1);
    assert.ok(r.messages.some((m) => isSummaryMessage(m)));
    assert.ok(r.removedChars > 0);
  });

  it('frames the summary as untrusted machine-generated data (XF3)', async () => {
    const msgs = summaryConversation();
    const state = createCompressState();
    const calls = { n: 0, inputs: [] as string[] };
    const deps = countingDeps(calls);
    const r = await summarizePass(msgs, 1, summarizeConfig(), deps, state, 'task-sum-xf3');
    const summaryMsg = r.messages.find((m) => isSummaryMessage(m));
    assert.ok(summaryMsg, 'summary message expected');
    const content = summaryMsg.content as string;
    assert.ok(content.includes(UNTRUSTED_SUMMARY_NOTE), 'summary body must carry the untrusted-data framing');
    assert.ok(
      content.indexOf(UNTRUSTED_SUMMARY_NOTE) < content.indexOf('Summary: billing module'),
      'the framing must come before the generated body',
    );
    // Cache reuse serves the same framed message - no unframed path.
    const r2 = await summarizePass(msgs, 1, summarizeConfig(), deps, state, 'task-sum-xf3');
    const cachedMsg = r2.messages.find((m) => isSummaryMessage(m));
    assert.ok(cachedMsg && (cachedMsg.content as string).includes(UNTRUSTED_SUMMARY_NOTE));
  });

  it('reuses the cached summary when the region is unchanged', async () => {
    const msgs = summaryConversation();
    const state = createCompressState();
    const calls = { n: 0, inputs: [] as string[] };
    const deps = countingDeps(calls);
    const cfg = summarizeConfig();
    const r1 = await summarizePass(msgs, 1, cfg, deps, state, 'task-sum-2');
    assert.equal(r1.summarizeCalls, 1);
    assert.equal(calls.n, 1);
    const r2 = await summarizePass(msgs, 1, cfg, deps, state, 'task-sum-2');
    assert.equal(calls.n, 1); // cache hit - no second LLM call
    assert.equal(r2.summarizeCalls, 0);
    assert.ok(r2.messages.some((m) => isSummaryMessage(m)));
  });

  it('appends new tool messages without regenerating the summary', async () => {
    const msgs = summaryConversation();
    const state = createCompressState();
    const calls = { n: 0, inputs: [] as string[] };
    const deps = countingDeps(calls);
    const cfg = summarizeConfig();
    await summarizePass(msgs, 1, cfg, deps, state, 'task-sum-3');
    assert.equal(calls.n, 1);
    // A tool step arrives after the last summarization, before the protected tail.
    const extended = [...msgs.slice(0, msgs.length - 1), assistant('Step 4: checking status.'), tool('power---bash', 'status ok'), msgs[msgs.length - 1]];
    const r2 = await summarizePass(extended, 1, cfg, deps, state, 'task-sum-3');
    assert.equal(calls.n, 1); // no regeneration for a pure tool step
    assert.equal(r2.summarizeCalls, 0);
    assert.ok(r2.messages.some((m) => isSummaryMessage(m)));
    assert.ok(r2.messages.some((m) => m.role === 'tool' && JSON.stringify(m.content).includes('status ok')));
  });

  it('never orphans a tool result when the fallback boundary splits a pair (regression)', async () => {
    // Few user turns force the ACTIVE_TURN_TAIL fallback; its fixed cut can
    // land inside a call/result pair. The summary must shrink to a safe
    // boundary instead of removing the call alone - an orphaned result
    // makes the next provider call fail.
    const big = 'x'.repeat(400);
    const msgs: ContextMessage[] = [
      user('Brief.'),
      assistantWithCall('c1', 'power---bash', { command: 'one' }),
      toolFor('c1', 'power---bash', big),
      user('Second turn.'),
      assistantWithCall('c2', 'power---bash', { command: 'two' }),
      toolFor('c2', 'power---bash', big),
      user('Third turn.'),
      assistantWithCall('c3', 'power---bash', { command: 'three' }),
      toolFor('c3', 'power---bash', big),
      assistant('tail 1'),
      assistant('tail 2'),
      assistant('tail 3'),
      assistant('tail 4'),
    ];
    // Length 13 → fallback cut at 8, which is T(res-c3): pre-fix this left
    // result c3 behind while the summary swallowed call c3.
    const state = createCompressState();
    const calls = { n: 0, inputs: [] as string[] };
    const r = await summarizePass(msgs, 10, summarizeConfig(), countingDeps(calls), state, 'task-orphan');
    assert.equal(calls.n, 1, 'summarizer ran');
    assert.ok(r.messages.some((m) => isSummaryMessage(m)), 'summary applied');
    // Both directions of the pairing invariant.
    const outCalls = collectCallIds(r.messages);
    const outResults = collectResultIds(r.messages);
    for (const callId of outCalls) assert.ok(outResults.includes(callId), `tool-call ${callId} lost its result`);
    for (const resultId of outResults) assert.ok(outCalls.includes(resultId), `orphaned tool-result ${resultId}`);
  });

  it('regenerates when a new user turn arrives', async () => {
    const msgs = summaryConversation();
    const state = createCompressState();
    const calls = { n: 0, inputs: [] as string[] };
    const deps = countingDeps(calls);
    const cfg = summarizeConfig();
    await summarizePass(msgs, 1, cfg, deps, state, 'task-sum-4');
    assert.equal(calls.n, 1);
    const extended = [...msgs, user('New requirement: CSV export.'), assistant('Step 5: exporting.')];
    const r2 = await summarizePass(extended, 1, cfg, deps, state, 'task-sum-4');
    assert.equal(calls.n, 2); // a new user turn in the region forces regeneration
    assert.equal(r2.summarizeCalls, 1);
  });

  it('keeps the beginning of oversized regions for the summarizer', async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `pad line ${i} - filling the conversation with repetitive content`).join('\n');
    const msgs: ContextMessage[] = [
      user('Brief: build the billing module.'),
      assistant('UNIQUE_ANCHOR_START requirement: invoices must be exact.'),
      tool('power---file-read', big),
      user('Add a discount field.'),
      assistant('Step 2: editing.'),
      tool('power---bash', 'ok'),
      user('Run the tests.'),
      assistant('Step 3: tests.'),
      tool('power---bash', 'pass'),
      user('Tail.'),
    ];
    const state = createCompressState();
    const calls = { n: 0, inputs: [] as string[] };
    const deps = countingDeps(calls);
    await summarizePass(msgs, 1, summarizeConfig({ minChars: 100 }), deps, state, 'task-sum-5');
    assert.equal(calls.n, 1);
    assert.ok(calls.inputs[0].includes('UNIQUE_ANCHOR_START'));
    assert.ok(calls.inputs[0].includes('[BEGINNING OF CONVERSATION'));
  });

  it('redacts secrets before sending content to the summarizer', async () => {
    const msgs: ContextMessage[] = [
      user('Brief.'),
      assistant('step 1'),
      tool('power---bash', 'token=sk-abcdef1234567890abcdef1234567890 and more'),
      user('q2'),
      assistant('step 2'),
      tool('power---bash', 'ok'),
      user('q3'),
      assistant('step 3'),
      tool('power---bash', 'done'),
      user('Tail.'),
    ];
    const state = createCompressState();
    const calls = { n: 0, inputs: [] as string[] };
    const deps = countingDeps(calls);
    await summarizePass(msgs, 1, summarizeConfig(), deps, state, 'task-sum-6');
    assert.equal(calls.n, 1);
    assert.ok(!calls.inputs[0].includes('sk-abcdef1234567890abcdef1234567890'));
    assert.ok(calls.inputs[0].includes('[REDACTED]'));
  });

  it('keeps the original when the summary would GROW the context (XF6)', async () => {
    const msgs = [
      user('Brief: build the billing module.'),
      assistant('Step 1: reading the module.'),
      tool('power---file-read', 'file content'),
      user('Add a discount field.'),
      assistant('Step 2: editing.'),
      tool('power---file-edit', 'edit ok'),
      user('Run the tests.'),
      assistant('Step 3: running tests.'),
      tool('power---bash', 'all tests pass'),
      user('Protected tail.'),
    ];
    const state = createCompressState();
    const calls = { n: 0, inputs: [] as string[] };
    // Stub returns a summary LONGER than the tiny region: the swap would
    // expand the context, so the pass must keep the original messages.
    const deps = countingDeps(calls, `${'y'.repeat(400)} summary is bigger than the region`);
    const cfg = summarizeConfig({ minChars: 60, maxSummaryChars: 1000 });
    const r = await summarizePass(msgs, 1, cfg, deps, state, 'task-sum-xf6');
    assert.equal(r.summarizeCalls, 1); // the LLM call happened (cost side)
    assert.equal(r.failed, false);
    assert.equal(r.summarizer, 'none');
    assert.equal(r.summarizedRanges, 0);
    assert.equal(r.removedChars, 0);
    assert.equal(r.messages, msgs); // untouched - no growth
    // Nothing was cached: the next call must generate again instead of
    // reusing a non-beneficial summary.
    const r2 = await summarizePass(msgs, 1, cfg, deps, state, 'task-sum-xf6');
    assert.equal(calls.n, 2);
    assert.equal(r2.messages, msgs);
  });

  it('reports failure instead of throwing when the summarizer throws', async () => {
    const msgs = summaryConversation();
    const state = createCompressState();
    const failingDeps: SummarizeDeps = {
      generateLocal: async () => {
        throw new Error('summarizer boom');
      },
      generateCloud: async () => undefined,
    };
    const r = await summarizePass(msgs, 1, summarizeConfig(), failingDeps, state, 'task-sum-7');
    assert.equal(r.failed, true);
    assert.equal(r.summarizeCalls, 1);
    assert.equal(r.messages, msgs); // untouched
  });

  it('keeps regions with rich parts (images/files) untouched', async () => {
    const msgs: ContextMessage[] = [
      user('Brief: build the billing module.'),
      assistant('Step 1: reading the module.'),
      tool('power---file-read', 'file content line a\nfile content line b'),
      {
        id: id(),
        role: 'user',
        content: [
          { type: 'text', text: 'Add a discount field - here is a screenshot:' },
          { type: 'image', image: 'https://example.com/screenshot.png' },
        ],
      },
      assistant('Step 2: editing.'),
      tool('power---file-edit', 'edit ok'),
      user('Run the tests.'),
      assistant('Step 3: running tests.'),
      tool('power---bash', 'all tests pass'),
      user('Protected tail.'),
    ];
    const state = createCompressState();
    const calls = { n: 0, inputs: [] as string[] };
    const deps = countingDeps(calls);
    const r = await summarizePass(msgs, 1, summarizeConfig(), deps, state, 'task-sum-rich');
    assert.equal(calls.n, 0); // never replace an image with text-only output
    assert.equal(r.summarizeCalls, 0);
    assert.equal(r.failed, false);
    assert.equal(r.messages, msgs); // untouched
  });

  it('still summarizes when the rich part sits in the protected tail', async () => {
    const msgs: ContextMessage[] = [
      user('Brief: build the billing module.'),
      assistant('Step 1: reading the module.'),
      // Padded so the region beats the framed summary message (XF6 guard).
      tool('power---file-read', `file content line a\nfile content line b\n${'x'.repeat(300)}`),
      user('Add a discount field.'),
      assistant('Step 2: editing.'),
      tool('power---file-edit', 'edit ok'),
      user('Add CSV export.'),
      assistant('Step 3: running tests.'),
      tool('power---bash', 'all tests pass'),
      user('Add PDF support.'),
      assistant('Step 4: editing again.'),
      tool('power---file-edit', 'edit ok'),
      {
        id: id(),
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this error screenshot:' },
          { type: 'image', image: 'https://example.com/screenshot.png' },
        ],
      },
      assistant('Step 5: after the screenshot.'),
      tool('power---bash', 'ok'),
    ];
    const state = createCompressState();
    const calls = { n: 0, inputs: [] as string[] };
    const deps = countingDeps(calls);
    const r = await summarizePass(msgs, 2, summarizeConfig(), deps, state, 'task-sum-rich-tail');
    assert.equal(calls.n, 1); // region is rich-free, summarization proceeds
    assert.ok(r.messages.some((m) => isSummaryMessage(m)));
    // The protected screenshot survives in the result.
    assert.ok(
      r.messages.some(
        (m) => Array.isArray(m.content) && (m.content as { type?: string }[]).some((p) => p.type === 'image'),
      ),
    );
  });
});

describe('compressMessages', () => {
  it('keeps structural/truncate savings when the summarizer throws', async () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i} padding content for the tool output`).join('\n');
    const msgs: ContextMessage[] = [
      user('Brief: build the billing module.'),
      assistant('a1'),
      tool('power---bash', big),
      user('q2'),
      assistant('a2'),
      tool('power---bash', 'same'),
      tool('power---bash', 'same'),
      user('q3'),
      assistant('a3'),
      tool('power---bash', 'ok'),
      user('Tail.'),
    ];
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      level: 'summarize',
      maxContextChars: 1000,
      protectedTurns: 1,
      truncate: { ...DEFAULT_CONFIG.truncate, maxLines: 50, maxKB: 20, maxInputChars: 500 },
      summarize: { ...DEFAULT_CONFIG.summarize, afterTurns: 2, minChars: 10 },
    };
    const state = createCompressState();
    const failingDeps: SummarizeDeps = {
      generateLocal: async () => {
        throw new Error('summarizer boom');
      },
      generateCloud: async () => undefined,
    };
    const { messages: out, report } = await compressMessages(msgs, cfg, failingDeps, state, 'task-int-1');
    assert.equal(report.summarizeFailed, true);
    assert.ok(report.truncateChars > 0); // truncate savings survive the summarizer failure
    const toolMsgs = out.filter((m) => m.role === 'tool');
    assert.ok(toolMsgs.length > 0);
    assert.ok(JSON.stringify(toolMsgs[0].content).includes('broke: truncated'));
  });

  it('reports cache reuse in summarizeCalls', async () => {
    const msgs = summaryConversation();
    const cfg: Config = {
      ...summarizeConfig(),
      level: 'summarize',
      maxContextChars: 100,
      protectedTurns: 1,
    };
    const state = createCompressState();
    const calls = { n: 0, inputs: [] as string[] };
    const deps = countingDeps(calls);
    const r1 = await compressMessages(msgs, cfg, deps, state, 'task-int-2');
    assert.equal(r1.report.summarizeCalls, 1);
    const r2 = await compressMessages(msgs, cfg, deps, state, 'task-int-2');
    assert.equal(r2.report.summarizeCalls, 0);
    assert.equal(calls.n, 1);
  });

  it('invalidates the summary cache when the summarizer config changes (F14)', async () => {
    const msgs = summaryConversation();
    const state = createCompressState();
    const calls = { n: 0, inputs: [] as string[] };
    const deps = countingDeps(calls);
    const base = (summarize: Partial<Config['summarize']>): Config => ({
      ...summarizeConfig(summarize),
      level: 'summarize',
      maxContextChars: 100,
      protectedTurns: 1,
    });
    const r1 = await compressMessages(msgs, base({}), deps, state, 'task-f14');
    assert.equal(r1.report.summarizeCalls, 1);
    // Same config: cache reuse, no new LLM call.
    const r2 = await compressMessages(msgs, base({}), deps, state, 'task-f14');
    assert.equal(r2.report.summarizeCalls, 0);
    assert.equal(calls.n, 1);
    // Switched model: the stale summary must not be reused - fresh call.
    const r3 = await compressMessages(msgs, base({ localModel: 'llama3.2:3b' }), deps, state, 'task-f14');
    assert.equal(r3.report.summarizeCalls, 1);
    assert.equal(calls.n, 2);
  });

  it('compresses a single-prompt tool loop with default settings', async () => {
    // Regression: real AiderDesk sessions are often one task brief plus a
    // long tool loop (few user turns). The old turn-based region protection
    // left the region empty and broke saved nothing. Defaults only.
    const big = Array.from({ length: 800 }, (_, i) => `line ${i} of a large tool output that must be truncated`).join('\n');
    const msgs: ContextMessage[] = [user('Brief: audit the workspace extension.')];
    for (let i = 1; i <= 12; i++) {
      msgs.push(assistant(`Step ${i}: inspecting.`));
      msgs.push(tool('power---bash', big));
    }
    const cfg: Config = { ...DEFAULT_CONFIG, level: 'truncate' };
    const state = createCompressState();
    const deps = countingDeps({ n: 0, inputs: [] });
    const { report } = await compressMessages(msgs, cfg, deps, state, 'task-int-3');
    assert.ok(report.truncateChars > 0, 'truncate must engage on a single-prompt tool loop');
    assert.ok(report.structuralChars >= 0);
    assert.equal(report.summarizeCalls, 0);
  });

  it('skips the summarize pass when summarizeDisabled is set', async () => {
    const msgs = summaryConversation();
    const cfg: Config = {
      ...summarizeConfig(),
      level: 'summarize',
      maxContextChars: 100,
      protectedTurns: 1,
    };
    const state = createCompressState();
    const calls = { n: 0, inputs: [] as string[] };
    const deps = countingDeps(calls);
    const { messages: out, report } = await compressMessages(msgs, cfg, deps, state, 'task-int-4', {
      summarizeDisabled: true,
    });
    assert.equal(calls.n, 0); // the disabled summarizer must not be retried
    assert.equal(report.summarizeCalls, 0);
    assert.equal(report.summarizeFailed, false); // a skipped pass is NOT a failure
    assert.equal(report.summarizer, 'none');
    assert.deepEqual(out, msgs); // no other pass changed the messages
  });
});

describe('maskSecrets', () => {
  // Secret-looking inputs are constructed at runtime so the repo never
  // contains literal token shapes (keeps secret scanners quiet and the
  // tests portable).
  it('redacts one pattern per case (F8)', () => {
    const cases: { name: string; input: string; expected: string }[] = [
      { name: 'sk- key', input: `key: ${'sk-' + 'B'.repeat(32)}`, expected: 'key: [REDACTED]' },
      { name: 'AKIA key', input: `aws: ${'AKIA' + 'C'.repeat(16)}`, expected: 'aws: [REDACTED]' },
      { name: 'ASIA session token', input: `aws: ${'ASIA' + 'D'.repeat(16)}`, expected: 'aws: [REDACTED]' },
      { name: 'github fine-grained pat', input: `pat: ${'github_pat_' + 'e'.repeat(22)}`, expected: 'pat: [REDACTED]' },
      { name: 'classic gh token', input: `tok: ${'ghp_' + 'f'.repeat(36)}`, expected: 'tok: [REDACTED]' },
      { name: 'slack bot token', input: `s: ${'xoxb-' + 'g'.repeat(12)}`, expected: 's: [REDACTED]' },
      { name: 'jwt', input: `jwt: ${'eyJ' + 'h'.repeat(10) + '.' + 'i'.repeat(10) + '.' + 'j'.repeat(10)}`, expected: 'jwt: [REDACTED-JWT]' },
      { name: 'bearer header', input: `auth: Bearer ${'k'.repeat(24)}`, expected: 'auth: Bearer [REDACTED]' },
      { name: 'basic header', input: `auth: Basic ${'Q'.repeat(24) + '=='}`, expected: 'auth: Basic [REDACTED]' },
      {
        name: 'slack webhook url',
        input: 'url: https://hooks.slack.com/services/T0000000/B0000000/XXXXXXXXXXXXXX',
        expected: 'url: [REDACTED-SLACK-WEBHOOK]',
      },
      {
        name: 'discord webhook url',
        input: 'url: https://discord.com/api/webhooks/123456789/abcdefghijklmnop',
        expected: 'url: [REDACTED-DISCORD-WEBHOOK]',
      },
      {
        name: 'connection string',
        input: 'db: postgres://user:s3cr3tpw@db.local:5432/app',
        expected: 'db: postgres://[REDACTED]@db.local:5432/app',
      },
      {
        name: 'azure sas sig',
        input: 'u: https://acct.blob.core.windows.net/c?sv=2024-01-01&sig=BASE64SIG&se=2025-01-01',
        expected: 'u: https://acct.blob.core.windows.net/c?sv=2024-01-01&sig=[REDACTED]&se=2025-01-01',
      },
      { name: 'password assignment', input: 'cfg: password=hunter2', expected: 'cfg: password=[REDACTED]' },
      { name: 'token assignment', input: 'cfg: token=abc123', expected: 'cfg: token=[REDACTED]' },
      { name: 'quoted api_key assignment', input: 'cfg: api_key="abc123"', expected: 'cfg: api_key=[REDACTED]' },
      { name: 'npmrc authToken line', input: '//registry.npmjs.org/:_authToken=abc123', expected: '//registry.npmjs.org/:_authToken=[REDACTED]' },
      {
        name: 'pem private key',
        input: 'k: -----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
        expected: 'k: [REDACTED-PRIVATE-KEY]',
      },
    ];
    for (const c of cases) {
      assert.equal(maskSecrets(c.input), c.expected, c.name);
    }
  });

  it('leaves non-secret text untouched', () => {
    const text = 'plain prose: the build failed with 3 errors, no secrets here.';
    assert.equal(maskSecrets(text), text);
  });
});

describe('isSummaryMessage', () => {
  it('recognizes broke summary markers only', () => {
    assert.ok(isSummaryMessage({ id: id(), role: 'assistant', content: `${SUMMARY_MARKER} Compressed 5 messages` }));
    assert.ok(!isSummaryMessage({ id: id(), role: 'assistant', content: 'normal text' }));
    assert.ok(!isSummaryMessage({ id: id(), role: 'user', content: `${SUMMARY_MARKER} nope` }));
  });
});

describe('messagesChars', () => {
  it('sums all message sizes', () => {
    const msgs = conversation();
    const sum = msgs.reduce((acc, m) => acc + messageChars(m), 0);
    assert.equal(messagesChars(msgs), sum);
  });
});
