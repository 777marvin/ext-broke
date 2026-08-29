/**
 * F3 unit tests: record assembly, masking, persistence/rotation/undo files,
 * the pure flush planner and the conservative test-green heuristic.
 * Persistence tests use an explicit tmp dir override - never the repo tree.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFlushPlan,
  buildStateMessage,
  extractAchieved,
  extractGoal,
  GOAL_MAX_CHARS,
  isoFilename,
  listSnapshots,
  looksLikeGreenTests,
  makeSnapshotRecord,
  MAX_HISTORY_FILE_BYTES,
  MAX_SNAPSHOTS_PER_TASK,
  MAX_SNAPSHOT_BYTES_PER_TASK,
  persistSnapshot,
  readHistory,
  readSnapshot,
  resolveSnapshot,
  rotateTaskDir,
  safeLabel,
  snapshotTaskDir,
  writeFlushReduction,
} from '../snapshot';

const user = (id: string, content: unknown) => ({ id, role: 'user', content });
const assistant = (id: string, content: unknown) => ({ id, role: 'assistant', content });
const systemLike = (id: string, content: unknown) => ({ id, role: 'system', content });

function tmpSnapDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'broke-snapshot-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('makeSnapshotRecord', () => {
  it('produces a schema-valid, masked, truncated record', () => {
    const longGoal = `Implement billing. ${'x'.repeat(GOAL_MAX_CHARS + 500)}`;
    const record = makeSnapshotRecord(
      {
        taskId: 't1',
        taskName: 'Task One',
        goal: longGoal,
        achieved: 'exports created',
        files: ['src/a.ts'],
        commit: 'abc1234',
        summary: 'done',
      },
      '2026-08-26T10:00:00.000Z',
    );
    assert.equal(record.version, 1);
    assert.equal(record.createdAt, '2026-08-26T10:00:00.000Z');
    assert.equal(record.goal.length <= GOAL_MAX_CHARS, true);
    assert.ok(record.goal.endsWith('…'), 'truncation is visible');
    assert.deepEqual(record.files, ['src/a.ts']);
    assert.equal(record.commit, 'abc1234');
    assert.equal(record.historyFile, undefined);
  });

  it('masks secrets in goal and summary', () => {
    const secretGoal = 'use token api_key=sk-qZ9wb8sL2mN4xR7vT5uJ0kA3 for calls';
    const record = makeSnapshotRecord({ taskId: 't1', goal: secretGoal, summary: 'token sk-qZ9wb8sL2mN4xR7vT5uJ0kA3 kept working' });
    assert.ok(!record.goal.includes('sk-qZ9wb8sL2mN4xR7vT5uJ0kA3'));
    assert.ok(record.goal.includes('[REDACTED]'));
    assert.ok(!record.summary.includes('sk-qZ9wb8sL2mN4xR7vT5uJ0kA3'));
  });
});

describe('extractGoal / extractAchieved', () => {
  it('takes the first user turn as goal and tolerates parts-array content', () => {
    const messages = [
      systemLike('s1', 'You are helpful.'),
      user('u1', [{ type: 'text', text: 'First part.' }, { type: 'text', text: 'Second part.' }]),
      assistant('a1', 'working...'),
      user('u2', 'later instruction - NOT the goal'),
    ];
    assert.equal(extractGoal(messages), 'First part.\nSecond part.');
  });

  it('returns empty strings for conversations without user/assistant turns', () => {
    assert.equal(extractGoal([assistant('a1', 'hi')]), '');
    assert.equal(extractAchieved([user('u1', 'hi')]), '');
  });

  it('extractAchieved picks the most recent non-empty assistant statement', () => {
    const messages = [user('u1', 'go'), assistant('a1', ''), assistant('a2', 'feature X built')];
    assert.equal(extractAchieved(messages), 'feature X built');
  });
});

describe('buildStateMessage', () => {
  it('starts with the marker and round-trips the record through JSON', () => {
    const record = makeSnapshotRecord({ taskId: 't1', goal: 'g', summary: 's' });
    const msg = buildStateMessage(record);
    assert.ok(msg.startsWith('[broke-state]\n'));
    assert.deepEqual(JSON.parse(msg.slice('[broke-state]\n'.length)), record);
  });
});

describe('buildFlushPlan (pure)', () => {
  it('rejects a conversation without any user turn', () => {
    const plan = buildFlushPlan([assistant('a1', 'hi')]);
    assert.equal(plan.ok, false);
    assert.match(plan.reason ?? '', /no user turn/);
  });

  it('declines when nothing follows the task brief', () => {
    const plan = buildFlushPlan([user('u1', 'only the brief')]);
    assert.equal(plan.ok, false);
    assert.match(plan.reason ?? '', /nothing to flush|already minimal/i);
  });

  it('plans keep-header+brief / remove-rest with exact counts', () => {
    const messages = [systemLike('s1', 'sys'), user('u1', 'brief'), assistant('a1', 'one'), user('u2', 'two'), assistant('a2', 'three')];
    const plan = buildFlushPlan(messages);
    assert.equal(plan.ok, true);
    assert.equal(plan.briefIndex, 1);
    assert.deepEqual(plan.headerIndexes, [0]);
    assert.equal(plan.removedCount, 3);
  });

  it('collapses earlier state messages into the new one (re-flush)', () => {
    const stateText = `[broke-state]\n{}`;
    const messages = [user('u1', 'brief'), assistant('a0', 'mid'), { id: 'st0', role: 'user' as const, content: stateText }, assistant('a1', 'more work')];
    const plan = buildFlushPlan(messages);
    assert.equal(plan.ok, true);
    assert.equal(plan.removedCount, messages.length - 1, 'everything after the brief is replaced');
  });
});

describe('persistence round-trip', () => {
  it('writes record + history first, reads both back; list is newest-first', () => {
    const { dir, cleanup } = tmpSnapDir();
    try {
      const record1 = makeSnapshotRecord({ taskId: 't9', goal: 'first', summary: 's1' }, '2026-08-26T10:00:00.000Z');
      const history = [user('u1', 'brief'), assistant('a1', 'work')];
      const p1 = persistSnapshot(record1, history, { dir, label: 'manual' });
      assert.ok(existsSync(p1.recordPath));
      assert.ok(p1.historyPath && existsSync(p1.historyPath));
      const parsed = readSnapshot(p1.recordPath);
      assert.ok(parsed);
      assert.equal(parsed.goal, 'first');
      assert.ok(parsed.historyFile?.endsWith('.history.json'), 'record links its undo file');
      const restored = readHistory(p1.recordPath, parsed);
      assert.equal(restored?.length, 2);

      const record2 = makeSnapshotRecord({ taskId: 't9', goal: 'second', summary: 's2' }, '2026-08-26T11:00:00.000Z');
      persistSnapshot(record2, history, { dir, label: 'commit' });
      const entries = listSnapshots('t9', { dir });
      assert.equal(entries.length, 2);
      assert.equal(entries[0].createdAt, '2026-08-26T11:00:00.000Z', 'newest first');
      assert.equal(entries[0].label, 'commit');
      assert.equal(entries[1].label, 'manual');

      const resolved = resolveSnapshot('t9', 2, { dir });
      assert.ok(resolved && resolved.entry.label === 'manual');
      assert.equal(resolveSnapshot('t9', 0, { dir }), undefined);
      assert.equal(resolveSnapshot('t9', 99, { dir }), undefined);
    } finally {
      cleanup();
    }
  });

  it('skips history files when keepHistory is false (undo impossible)', () => {
    const { dir, cleanup } = tmpSnapDir();
    try {
      const record = makeSnapshotRecord({ taskId: 'tk', goal: 'g', summary: 's' });
      const p = persistSnapshot(record, [user('u1', 'x')], { dir, label: 'flush', keepHistory: false });
      assert.equal(p.historyPath, undefined);
      const parsed = readSnapshot(p.recordPath);
      assert.ok(parsed);
      assert.equal(parsed.historyFile, undefined);
      assert.equal(readHistory(p.recordPath, parsed), undefined);
    } finally {
      cleanup();
    }
  });

  it('refuses oversized histories: skips the undo file, keeps the record (review F-01/F-14)', () => {
    const { dir, cleanup } = tmpSnapDir();
    try {
      const record = makeSnapshotRecord({ taskId: 'tk', goal: 'g', summary: 's' });
      const fatHistory = [user('u1', 'x'.repeat(5000))];
      const p = persistSnapshot(record, fatHistory, { dir, label: 'manual', historyBytesCap: 1024 });
      assert.equal(p.historyPath, undefined);
      assert.equal(p.historySkipped, 'oversized', 'caller can distinguish skip-from-failure');
      const parsed = readSnapshot(p.recordPath);
      assert.ok(parsed, 'record still persists');
      assert.equal(parsed.historyFile, undefined, 'record never claims a missing undo file');
      // Default cap is the exported constant.
      assert.ok(MAX_HISTORY_FILE_BYTES > 1024);
    } finally {
      cleanup();
    }
  });

  it('writes records and histories owner-readable only (0600 on POSIX)', () => {
    const { dir, cleanup } = tmpSnapDir();
    try {
      const record = makeSnapshotRecord({ taskId: 'tk', goal: 'g', summary: 's' });
      const p = persistSnapshot(record, [user('u1', 'x')], { dir, label: 'manual' });
      if (process.platform === 'win32') {
        // mode is a POSIX no-op on Windows - existence is the contract there
        assert.ok(existsSync(p.recordPath) && p.historyPath && existsSync(p.historyPath));
        return;
      }
      assert.equal(statSync(p.recordPath).mode & 0o777, 0o600, 'record is 0600');
      assert.equal(statSync(p.historyPath as string).mode & 0o777, 0o600, 'raw history is 0600');
    } finally {
      cleanup();
    }
  });

  it('evicts oldest pairs until the aggregate byte budget holds (review F-14)', () => {
    const { dir, cleanup } = tmpSnapDir();
    try {
      const taskDirPath = snapshotTaskDir(dir, 'rot');
      mkdirSync(taskDirPath, { recursive: true });
      // Three snapshot PAIRS (record + fat history), each ~equal bytes.
      for (let i = 0; i < 3; i++) {
        const iso = `2026-08-26T1${i}:00:00.000Z`;
        const record = makeSnapshotRecord({ taskId: 'rot', goal: `g${i}`, summary: 's' }, iso);
        const p = persistSnapshot(record, [user('u1', 'y'.repeat(900))], { dir, label: 'manual' });
        assert.ok(p.recordPath);
      }
      const before = listSnapshots('rot', { dir });
      assert.equal(before.length, 3);
      // Budget between 2x and 3x the measured pair size -> exactly the
      // oldest pair must leave for the total to fit again.
      const pairBytes = statSync(join(taskDirPath, before[2].file)).size + 940;
      const removed = rotateTaskDir(taskDirPath, MAX_SNAPSHOTS_PER_TASK, Math.round(pairBytes * 2.5));
      assert.equal(removed, 1, 'the oldest pair leaves first');
      const after = listSnapshots('rot', { dir });
      assert.equal(after.length, 2);
      assert.ok(!after.some((e) => e.record?.goal === 'g0'), 'oldest snapshot gone');
      // Count-only ceiling still applies on top.
      assert.equal(rotateTaskDir(taskDirPath, 1, MAX_SNAPSHOT_BYTES_PER_TASK), 1, 'count ceiling evicts the next oldest');
    } finally {
      cleanup();
    }
  });

  it('fails loudly BEFORE creating a record when the history write fails', () => {
    const { dir, cleanup } = tmpSnapDir();
    try {
      const record = makeSnapshotRecord({ taskId: 'tk', goal: 'g', summary: 's' }, '2026-08-26T12:00:00.000Z');
      // A poisoned history array throws during JSON.stringify - BEFORE any
      // file write happens, so no half state can exist on disk.
      const poisonedHistory = [{ toJSON() { throw new Error('boom'); } }];
      assert.throws(() => persistSnapshot(record, poisonedHistory, { dir }));
      assert.equal(listSnapshots('tk', { dir }).length, 0);
    } finally {
      cleanup();
    }
  });

  it('rotates to MAX_SNAPSHOTS_PER_TASK, deleting oldest records AND their undo files', () => {
    const { dir, cleanup } = tmpSnapDir();
    try {
      for (let i = 0; i < MAX_SNAPSHOTS_PER_TASK + 5; i++) {
        const minute = String(i % 60).padStart(2, '0');
        const hour = String(Math.floor(i / 60)).padStart(2, '0');
        const iso = `2026-08-26T${hour}:${minute}:00.000Z`;
        persistSnapshot(makeSnapshotRecord({ taskId: 'rot', goal: `g${i}`, summary: 's' }, iso), [user('u1', 'h')], { dir, label: `n${i}` });
      }
      const entries = listSnapshots('rot', { dir });
      assert.equal(entries.length, MAX_SNAPSHOTS_PER_TASK);
      const rotDir = snapshotTaskDir(dir, 'rot');
      const dirFiles = readdirSync(rotDir);
      assert.equal(dirFiles.filter((f) => f.endsWith('.history.json')).length, MAX_SNAPSHOTS_PER_TASK, 'undo files rotate with their records');
      assert.ok(!existsSync(join(rotDir, dirFiles.find((f) => f.includes('n0.json')) ?? 'never.json')), 'oldest record deleted');
      // Manual rotation on an already-clean dir is a no-op.
      assert.equal(rotateTaskDir(rotDir), 0);
    } finally {
      cleanup();
    }
  });

  it('sanitizes task ids and labels into filename-safe fragments', () => {
    assert.equal(safeLabel('my feature!! v2'), 'my-feature-v2');
    assert.equal(safeLabel('///'), 'snapshot');
    assert.equal(safeLabel('x'.repeat(100)).length <= 40, true);
  });
});

describe('looksLikeGreenTests (snapshot.onTestPass heuristic)', () => {
  it('accepts explicit pass counts without failure signals', () => {
    assert.equal(looksLikeGreenTests('npm test\nℹ pass 42\nℹ fail 0'), false, '"fail" word veto');
    assert.equal(looksLikeGreenTests('Tests:\n24 passed, 24 total'), true);
    assert.equal(looksLikeGreenTests('ok 7 suites'), true);
  });

  it('vetoes failures and ignores unrelated output', () => {
    assert.equal(looksLikeGreenTests('3 failed, 21 passed'), false);
    assert.equal(looksLikeGreenTests('hello world'), false);
    assert.equal(looksLikeGreenTests(`2 failed of ${'x'.repeat(30_000)} 100 passed`), false, 'failure anywhere in window vetoes');
  });
});

describe('flush reduction bookkeeping', () => {
  it('makeSnapshotRecord carries an explicit reduction - or omits the key entirely', () => {
    const withReduction = makeSnapshotRecord({
      taskId: 'task-red',
      goal: 'ship it',
      summary: 'done',
      reduction: { regionChars: 12_345, stateMessageChars: 400 },
    });
    assert.deepEqual(withReduction.reduction, { regionChars: 12_345, stateMessageChars: 400 });

    const plain = makeSnapshotRecord({ taskId: 'task-plain', goal: 'g', summary: 's' });
    assert.equal('reduction' in plain, false, 'manual/milestone records must not claim a flush saving');
  });

  it('negative/garbage reductions are clamped to non-negative ints at build time', () => {
    const record = makeSnapshotRecord({
      taskId: 'task-clamp',
      goal: 'g',
      summary: 's',
      reduction: { regionChars: -5.7, stateMessageChars: 2 ** 33 },
    });
    assert.equal(record.reduction?.regionChars, 0);
    assert.equal(typeof record.reduction?.stateMessageChars, 'number');
  });

  it('writeFlushReduction fills a persisted record exactly once (undo reverts this value)', () => {
    const { dir, cleanup } = tmpSnapDir();
    try {
      const record = makeSnapshotRecord({ taskId: 'task-wfr', goal: 'g', summary: 's' });
      const { recordPath } = persistSnapshot(record, [], { dir, label: 'flush' });
      assert.equal(readSnapshot(recordPath)?.reduction, undefined);

      writeFlushReduction(recordPath, { regionChars: 9_000, stateMessageChars: 350 });
      const first = readSnapshot(recordPath);
      assert.deepEqual(first?.reduction, { regionChars: 9_000, stateMessageChars: 350 });

      // Exactly-once: a second write can never double-credit the estimate.
      writeFlushReduction(recordPath, { regionChars: 99_999, stateMessageChars: 1 });
      assert.deepEqual(readSnapshot(recordPath)?.reduction, { regionChars: 9_000, stateMessageChars: 350 });
    } finally {
      cleanup();
    }
  });
});

describe('BRK-019: snapshot hardening (external review 2026-08-29)', () => {
  it('masks conversation-derived taskName and files like every other field', () => {
    const record = makeSnapshotRecord({
      taskId: 'task-brk19',
      taskName: 'fix the sk-abcdefghijklmnop1234 leak',
      goal: 'g',
      files: ['src/ok.ts', 'notes with sk-abcdefghijklmnop1234.txt'],
      summary: 's',
    });
    assert.ok(!record.taskName.includes('sk-abcdefghijklmnop'), 'taskName must be masked');
    assert.ok(record.files.every((f) => !f.includes('sk-abcdefghijklmnop')), 'files must be masked');
    assert.equal(record.files[0], 'src/ok.ts', 'benign paths pass through unchanged');
  });

  it('separates task dirs that collapse into the same sanitized label', () => {
    const { dir, cleanup } = tmpSnapDir();
    try {
      const long = 'a'.repeat(60);
      const r1 = makeSnapshotRecord({ taskId: long, goal: 'g', summary: 's' });
      const r2 = makeSnapshotRecord({ taskId: `${long}b`, goal: 'g', summary: 's' });
      persistSnapshot(r1, [], { dir, label: 'one' });
      persistSnapshot(r2, [], { dir, label: 'two' });
      assert.equal(listSnapshots(long, { dir }).length, 1, 'task A sees only its own record');
      assert.equal(listSnapshots(`${long}b`, { dir }).length, 1, 'task B sees only its own record');
    } finally {
      cleanup();
    }
  });

  it('does not overwrite files when two snapshots share label and millisecond', () => {
    const { dir, cleanup } = tmpSnapDir();
    try {
      const record = makeSnapshotRecord({ taskId: 'task-brk19b', goal: 'g', summary: 's' }, '2026-08-29T10:00:00.000Z');
      const first = persistSnapshot(record, [], { dir, label: 'same' });
      const second = persistSnapshot(record, [], { dir, label: 'same' });
      assert.notEqual(first.recordPath, second.recordPath, 'same-millisecond snapshots must not collide on one file');
      assert.equal(listSnapshots('task-brk19b', { dir }).length, 2, 'both records exist');
    } finally {
      cleanup();
    }
  });

  it('refuses history files with unexpected names or non-message content', () => {
    const { dir, cleanup } = tmpSnapDir();
    try {
      const record = makeSnapshotRecord({ taskId: 'task-brk19c', goal: 'g', summary: 's' });
      const p = persistSnapshot(record, [user('u1', 'real history')], { dir, label: 'withhistory' });
      const parsed = readSnapshot(p.recordPath);
      assert.ok(parsed);
      assert.ok(Array.isArray(readHistory(p.recordPath, parsed)), 'a legit history still loads');

      // relative-path games INSIDE the dir name (./ prefix) fail the name contract
      const dotSlash = { ...parsed, historyFile: `./${parsed.historyFile}` };
      assert.equal(readHistory(p.recordPath, dotSlash), undefined, './-prefixed names are refused');

      // scalar entries are not message history
      const scalarBase = `${isoFilename('2026-08-29T10:00:00.000Z')}_scalars`;
      const histName = `${scalarBase}.history.json`;
      writeFileSync(join(join(p.recordPath, '..'), histName), JSON.stringify([1, 2, 3]));
      assert.equal(
        readHistory(p.recordPath, { ...parsed, historyFile: histName }),
        undefined,
        'a history of scalars is refused',
      );
    } finally {
      cleanup();
    }
  });

  it('removes the history file when the record write fails (no undo orphans)', () => {
    const { dir, cleanup } = tmpSnapDir();
    try {
      const record = makeSnapshotRecord({ taskId: 'task-brk19e', goal: 'g', summary: 's' }, '2026-08-29T11:00:00.000Z');
      // A poisoned record serializes only when the RECORD write happens -
      // after the history file is already on disk (history goes first).
      const poisoned = { ...record, toJSON(): never { throw new Error('boom'); } };
      assert.throws(() => persistSnapshot(poisoned as never, [user('u1', 'undo payload')], { dir, label: 'sabotage' }));
      const taskDirPath = snapshotTaskDir(dir, 'task-brk19e');
      assert.ok(existsSync(taskDirPath), 'task dir exists - the history was written');
      const leftovers = readdirSync(taskDirPath).filter((n) => n.endsWith('.history.json'));
      assert.deepEqual(leftovers, [], 'the orphaned history file is cleaned up');
    } finally {
      cleanup();
    }
  });
});
