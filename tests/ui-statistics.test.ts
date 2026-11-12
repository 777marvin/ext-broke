import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'broke-ui-statistics-'));
process.env.BROKE_DATA_DIR = join(root, 'data');
let StatisticsService: (typeof import('../ui-statistics'))['StatisticsService'];
let MAX_LEDGER_READ_BYTES: number;
let MAX_LEDGER_READ_LINES: number;
before(async () => {
  ({ StatisticsService, MAX_LEDGER_READ_BYTES, MAX_LEDGER_READ_LINES } = await import('../ui-statistics'));
});
after(() => rmSync(root, { recursive: true, force: true }));
let nextFixture = 0;
function fixture() { return join(root, `ledger-${nextFixture++}.jsonl`); }
function row(at: number, taskId = 'a', overrides: Record<string, unknown> = {}) {
  return { kind: 'run', taskId, at, charsBefore: 100, charsAfter: 80, savedChars: 99999,
    structuralChars: 12, errorChars: 3, truncateChars: 4, summarizeChars: 2, ...overrides };
}
function write(path: string, rows: unknown[]) { writeFileSync(path, rows.map(value => JSON.stringify(value)).join('\n') + '\n'); }

describe('bounded read-only statistics', () => {
  it('filters tasks, recomputes signed net, and aggregates all six calls independently of rounded tokens', async () => {
    const path = fixture();
    write(path + '.3', [row(4), row(1, 'other', { charsBefore: 1000, charsAfter: 0 })]);
    write(path + '.1', [row(2), row(3)]);
    write(path, [row(6, 'a', { charsBefore: 1, charsAfter: 5 }), row(5), row(1)]);
    write(path + '.4', [row(0, 'a', { charsBefore: 99999 })]);
    const service = new StatisticsService(path);
    const task = await service.query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: false, extras: null });
    assert.equal(task.state, 'ready');
    assert.equal(task.recordingEnabled, false);
    assert.deepEqual(task.summary, { runs: 6, charsBefore: 501, charsAfter: 405, netChars: 96,
      passChars: { structural: 72, error: 18, truncate: 24, summarize: 12 }, reconciliationChars: -30 });
    assert.deepEqual(task.runs.map(run => run.at), [1, 2, 3, 4, 5, 6]);
    assert.equal(task.runs[5].netChars, -4);
    assert.equal(task.runs[5].reconciliationChars, -25);
    assert.equal(task.retainedFrom, 1);
    assert.equal(task.retainedTo, 6);
    assert.equal(JSON.stringify(task).includes('other'), false);
    assert.equal(JSON.stringify(task).includes('taskId'), false);
    const retained = await service.query({ rawQuery: { scope: 'retained', page: 0 }, taskId: 'a', recordingEnabled: true, extras: { providerUsage: { sentTokens: 3 } } });
    assert.equal(retained.totalRuns, 7);
    assert.equal(retained.summary?.netChars, 1096);
    assert.equal(retained.taskExtras, null);
  });

  it('uses latest-first 60-run windows, returns each window chronologically, and clamps old pages', async () => {
    const path = fixture();
    write(path, Array.from({ length: 125 }, (_, index) => row(125 - index)));
    const service = new StatisticsService(path);
    const newest = await service.query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: null });
    assert.equal(newest.totalRuns, 125);
    assert.equal(newest.summary?.runs, 125);
    assert.equal(newest.pageSize, 60);
    assert.deepEqual([newest.runs[0].at, newest.runs[59].at], [66, 125]);
    const middle = await service.query({ rawQuery: { scope: 'task', page: 1 }, taskId: 'a', recordingEnabled: true, extras: null });
    assert.deepEqual([middle.runs[0].at, middle.runs[59].at], [6, 65]);
    const oldest = await service.query({ rawQuery: { scope: 'task', page: 999 }, taskId: 'a', recordingEnabled: true, extras: null });
    assert.equal(oldest.page, 2);
    assert.deepEqual(oldest.runs.map(run => run.at), [1, 2, 3, 4, 5]);
  });

  it('retains unknown individual passes as null and disables incomplete reconciliation', async () => {
    const path = fixture();
    write(path, [row(1), row(2, 'a', { structuralChars: undefined, errorChars: -1, truncateChars: 0.5, summarizeChars: null }),
      row(3, 'a', { charsBefore: -1 }), row(4, 'a', { charsAfter: 1e100 }), row(5, 'a', { at: 1.5 })]);
    const page = await new StatisticsService(path).query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: null });
    assert.equal(page.state, 'partial');
    assert.equal(page.skippedRecords, 3);
    assert.equal(page.unknownPassRecords, 1);
    assert.equal(page.totalRuns, 2);
    assert.deepEqual(page.runs[1].passChars, { structural: null, error: null, truncate: null, summarize: null });
    assert.equal(page.runs[1].reconciliationChars, null);
    assert.deepEqual(page.summary?.passChars, { structural: 12, error: 3, truncate: 4, summarize: 2 });
    assert.equal(page.summary?.reconciliationChars, null);
  });

  it('distinguishes malformed-only history, missing ledgers, no task, and read failure', async () => {
    const missing = fixture();
    const service = new StatisticsService(missing);
    const empty = await service.query({ rawQuery: { scope: 'task', page: 4 }, taskId: 'a', recordingEnabled: true, extras: null });
    assert.equal(empty.state, 'empty');
    assert.equal(empty.summary, null);
    assert.equal(empty.page, 0);
    mkdirSync(missing);
    const noTask = await new StatisticsService(missing).query({ rawQuery: { scope: 'task', page: 0 }, taskId: null, recordingEnabled: true, extras: null });
    assert.equal(noTask.state, 'no-task');
    assert.equal(noTask.taskExtras, null);
    await assert.rejects(new StatisticsService(missing).query({ rawQuery: { scope: 'retained', page: 0 }, taskId: null, recordingEnabled: true, extras: null }), { code: 'read-failed' });
    const malformed = fixture();
    writeFileSync(malformed, 'broken\n{}\nnull\n');
    const partial = await new StatisticsService(malformed).query({ rawQuery: { scope: 'retained', page: 0 }, taskId: null, recordingEnabled: true, extras: null });
    assert.equal(partial.state, 'partial');
    assert.equal(partial.skippedRecords, 3);
    assert.equal(partial.unattributedRecords, 3);
    assert.equal(partial.totalRuns, 0);
    // Unattributable lines belong to no task, so they must not turn a clean
    // task into 'partial'; records attributable to another task stay out too.
    const scoped = fixture();
    writeFileSync(scoped, ['broken', row(1), row(2, 'b', { charsBefore: -1 })].map(value =>
      typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n');
    const cleanTask = await new StatisticsService(scoped).query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: null });
    assert.equal(cleanTask.state, 'ready');
    assert.equal(cleanTask.skippedRecords, 0);
    assert.equal(cleanTask.unattributedRecords, 1);
    assert.equal(cleanTask.totalRuns, 1);
    const scopedRetained = await new StatisticsService(scoped).query({ rawQuery: { scope: 'retained', page: 0 }, taskId: null, recordingEnabled: true, extras: null });
    assert.equal(scopedRetained.state, 'partial');
    assert.equal(scopedRetained.skippedRecords, 2);
    assert.equal(scopedRetained.unattributedRecords, 1);
  });

  it('rejects hostile queries before attempting an unreadable ledger', async () => {
    const path = fixture();
    mkdirSync(path);
    const service = new StatisticsService(path);
    for (const query of [null, [], {}, { scope: 'all', page: 0 }, { scope: 'task', page: -1 },
      { scope: 'task', page: 1.5 }, { scope: 'task', page: Infinity }, { scope: 'task', page: Number.MAX_SAFE_INTEGER + 1 },
      { scope: 'task', page: 0, taskId: 'other' }, { scope: 'retained', page: 0, path: 'secret' }]) {
      await assert.rejects(service.query({ rawQuery: query, taskId: 'a', recordingEnabled: true, extras: null }), { code: 'invalid-query' });
    }
  });

  it('reads a mature rotation chain whose files each sit one record past the rotation trigger', async () => {
    const path = fixture();
    // appendJsonLine checks the size BEFORE appending, so every rotated file can
    // hold one record more than MAX_MEASURE_FILE_BYTES: the four-file chain is
    // the ledger's normal steady state and must stay readable.
    const worstCase = 5 * 1024 * 1024 + 400;
    for (const file of [path, `${path}.1`, `${path}.2`, `${path}.3`]) {
      writeFileSync(file, '');
      truncateSync(file, worstCase);
    }
    const page = await new StatisticsService(path).query({ rawQuery: { scope: 'retained', page: 0 }, taskId: null, recordingEnabled: true, extras: null });
    assert.equal(page.state, 'partial');
    assert.equal(page.skippedRecords, 4);
  });

  it('rejects files, aggregate bytes, physical lines, and unsafe totals past the documented budget', async () => {
    const large = fixture();
    // Sparse: truncateSync sets the length without writing 20 MiB of zeroes, so
    // this budget case costs under a millisecond and allocates nothing.
    writeFileSync(large, '');
    truncateSync(large, MAX_LEDGER_READ_BYTES + 1);
    await assert.rejects(new StatisticsService(large).query({ rawQuery: { scope: 'retained', page: 0 }, taskId: null, recordingEnabled: true, extras: null }), { code: 'data-limit' });
    const aggregate = fixture();
    writeFileSync(aggregate, ''); truncateSync(aggregate, Math.ceil(MAX_LEDGER_READ_BYTES / 2));
    writeFileSync(aggregate + '.1', ''); truncateSync(aggregate + '.1', Math.ceil(MAX_LEDGER_READ_BYTES / 2) + 1);
    await assert.rejects(new StatisticsService(aggregate).query({ rawQuery: { scope: 'retained', page: 0 }, taskId: null, recordingEnabled: true, extras: null }), { code: 'data-limit' });
    const lines = fixture();
    writeFileSync(lines, '\n'.repeat(MAX_LEDGER_READ_LINES + 1));
    await assert.rejects(new StatisticsService(lines).query({ rawQuery: { scope: 'retained', page: 0 }, taskId: null, recordingEnabled: true, extras: null }), { code: 'data-limit' });
    const overflow = fixture();
    write(overflow, [row(1, 'a', { charsBefore: Number.MAX_SAFE_INTEGER }), row(2)]);
    await assert.rejects(new StatisticsService(overflow).query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: null }), { code: 'unsafe-totals' });
  });

  it('coalesces concurrent snapshots, reuses one snapshot while the ledger is unchanged, and reflects recorded runs and resets', async () => {
    const path = fixture();
    write(path, [row(1)]);
    let now = 10000;
    const service = new StatisticsService(path, () => now++);
    const [first, concurrent] = await Promise.all([
      service.query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: null }),
      service.query({ rawQuery: { scope: 'retained', page: 0 }, taskId: null, recordingEnabled: true, extras: null }),
    ]);
    assert.equal(first.generatedAt, concurrent.generatedAt);
    // A visible poll with an unchanged ledger costs stat() calls, not a re-read:
    // the snapshot keeps its original generation, however old the poll gets.
    now = first.generatedAt + 600_000;
    const polled = await service.query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: null });
    assert.equal(polled.totalRuns, 1);
    assert.equal(polled.generatedAt, first.generatedAt);

    // Another process appends to the same ledger. measurementRevision() is
    // process-local, so ONLY the file fingerprint can reveal this - and it must,
    // on the very next poll, without waiting for our own next write.
    write(path, [row(1), row(2)]);
    const foreign = await service.query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: null });
    assert.equal(foreign.totalRuns, 2, 'a write from another process invalidates the snapshot immediately');

    const { persistRunRecord, clearTaskStats } = await import('../tokens');
    // A recorded run bumps the revision, so the next poll sees the three lines.
    persistRunRecord(row(3) as import('../tokens').RunRecord, path);
    assert.equal((await service.query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: null })).totalRuns, 3);
    write(path, []);
    clearTaskStats('a', join(root, 'absent-stats'));
    assert.equal((await service.query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: null })).state, 'empty');
  });

  it('sees a rotation that replaces the ledger with a same-sized file', async () => {
    const path = fixture();
    write(path, [row(1)]);
    const service = new StatisticsService(path);
    assert.equal((await service.query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: null })).totalRuns, 1);
    // Rotate the way appendJsonLine does: the current file becomes <path>.1 and
    // a fresh current file takes its place. The inode of the current file
    // changes, so the fingerprint must differ even though a same-sized rewrite
    // would have been invisible to size alone.
    rmSync(path);
    writeFileSync(path, [row(2)].map(value => JSON.stringify(value)).join('\n') + '\n');
    const rotated = await service.query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: null });
    assert.equal(rotated.totalRuns, 1, 'the replacement file is read, not the cached generation');
    assert.equal(rotated.runs[0].at, 2, 'and it is the NEW content, not the old one');
  });

  it('sees a ledger written by another process, whose revision this process cannot observe', async () => {
    // measurementRevision() is process-local. A real second process (the CLI /
    // MCP agents in docs/agents/multi-agent-setup.md append to the same ledger)
    // bumps ITS copy, never ours - so this test spawns one and proves the
    // fingerprint is what makes the write visible.
    const path = fixture();
    write(path, [row(1)]);
    const service = new StatisticsService(path);
    assert.equal((await service.query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: null })).totalRuns, 1);

    const { measurementRevision } = await import('../tokens');
    const before = measurementRevision();
    const script = join(root, `external-writer-${nextFixture++}.mjs`);
    writeFileSync(script, [
      `import { appendFileSync } from 'node:fs';`,
      `appendFileSync(${JSON.stringify(path)}, ${JSON.stringify(JSON.stringify(row(2)) + '\n')});`,
    ].join('\n'));
    execFileSync(process.execPath, [script], { stdio: 'pipe' });

    assert.equal(measurementRevision(), before, 'the other process cannot bump our revision');
    const after = await service.query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: null });
    assert.equal(after.totalRuns, 2, 'the fingerprint exposes the foreign write on the next poll');
  });

  it('re-reads a same-size rewrite whose mtime changed', async () => {
    const path = fixture();
    write(path, [row(1)]);
    const service = new StatisticsService(path);
    assert.equal((await service.query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: null })).totalRuns, 1);
    // A rewrite that keeps the byte count identical is invisible to `size`
    // alone. mtime is the signal that carries it, so a poll after the rewrite
    // must re-read instead of serving the previous generation.
    const stamped = statSync(path);
    write(path, [row(9)]);
    utimesSync(path, new Date(stamped.mtimeMs + 5_000), new Date(stamped.mtimeMs + 5_000));
    const after = await service.query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: null });
    assert.equal(after.runs[0].at, 9, 'a same-size rewrite still invalidates through mtime');
  });

  it('validates optional task metadata without making an empty ledger nonempty', async () => {
    const service = new StatisticsService(fixture());
    const page = await service.query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: false, extras: {
      providerUsage: { sentTokens: 37, cacheReadTokens: undefined, cacheWriteTokens: -1 },
      avoidedChars: { slice: 24, search: Infinity, flush: 0 },
    } });
    assert.equal(page.state, 'empty');
    assert.deepEqual(page.taskExtras, { providerUsage: { provenance: 'last-available-completed-call', sentTokens: 37,
      cacheReadTokens: null, cacheWriteTokens: null }, avoidedChars: { slice: 24, search: null, flush: 0 } });
    const invalid = await service.query({ rawQuery: { scope: 'task', page: 0 }, taskId: 'a', recordingEnabled: true, extras: { providerUsage: { sentTokens: 0.5 } } });
    assert.equal(invalid.taskExtras?.providerUsage, null);
    assert.deepEqual(invalid.taskExtras?.avoidedChars, { slice: null, search: null, flush: null });
  });
});
