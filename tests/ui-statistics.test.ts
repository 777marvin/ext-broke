import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, truncateSync } from 'node:fs';
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
    const task = await service.query({ scope: 'task', page: 0 }, 'a', false, null);
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
    const retained = await service.query({ scope: 'retained', page: 0 }, 'a', true, { providerUsage: { sentTokens: 3 } });
    assert.equal(retained.totalRuns, 7);
    assert.equal(retained.summary?.netChars, 1096);
    assert.equal(retained.taskExtras, null);
  });

  it('uses latest-first 60-run windows, returns each window chronologically, and clamps old pages', async () => {
    const path = fixture();
    write(path, Array.from({ length: 125 }, (_, index) => row(125 - index)));
    const service = new StatisticsService(path);
    const newest = await service.query({ scope: 'task', page: 0 }, 'a', true, null);
    assert.equal(newest.totalRuns, 125);
    assert.equal(newest.summary?.runs, 125);
    assert.equal(newest.pageSize, 60);
    assert.deepEqual([newest.runs[0].at, newest.runs[59].at], [66, 125]);
    const middle = await service.query({ scope: 'task', page: 1 }, 'a', true, null);
    assert.deepEqual([middle.runs[0].at, middle.runs[59].at], [6, 65]);
    const oldest = await service.query({ scope: 'task', page: 999 }, 'a', true, null);
    assert.equal(oldest.page, 2);
    assert.deepEqual(oldest.runs.map(run => run.at), [1, 2, 3, 4, 5]);
  });

  it('retains unknown individual passes as null and disables incomplete reconciliation', async () => {
    const path = fixture();
    write(path, [row(1), row(2, 'a', { structuralChars: undefined, errorChars: -1, truncateChars: 0.5, summarizeChars: null }),
      row(3, 'a', { charsBefore: -1 }), row(4, 'a', { charsAfter: 1e100 }), row(5, 'a', { at: 1.5 })]);
    const page = await new StatisticsService(path).query({ scope: 'task', page: 0 }, 'a', true, null);
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
    const empty = await service.query({ scope: 'task', page: 4 }, 'a', true, null);
    assert.equal(empty.state, 'empty');
    assert.equal(empty.summary, null);
    assert.equal(empty.page, 0);
    mkdirSync(missing);
    const noTask = await new StatisticsService(missing).query({ scope: 'task', page: 0 }, null, true, null);
    assert.equal(noTask.state, 'no-task');
    assert.equal(noTask.taskExtras, null);
    await assert.rejects(new StatisticsService(missing).query({ scope: 'retained', page: 0 }, null, true, null), { code: 'read-failed' });
    const malformed = fixture();
    writeFileSync(malformed, 'broken\n{}\nnull\n');
    const partial = await new StatisticsService(malformed).query({ scope: 'retained', page: 0 }, null, true, null);
    assert.equal(partial.state, 'partial');
    assert.equal(partial.skippedRecords, 3);
    assert.equal(partial.totalRuns, 0);
  });

  it('rejects hostile queries before attempting an unreadable ledger', async () => {
    const path = fixture();
    mkdirSync(path);
    const service = new StatisticsService(path);
    for (const query of [null, [], {}, { scope: 'all', page: 0 }, { scope: 'task', page: -1 },
      { scope: 'task', page: 1.5 }, { scope: 'task', page: Infinity }, { scope: 'task', page: Number.MAX_SAFE_INTEGER + 1 },
      { scope: 'task', page: 0, taskId: 'other' }, { scope: 'retained', page: 0, path: 'secret' }]) {
      await assert.rejects(service.query(query, 'a', true, null), { code: 'invalid-query' });
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
    const page = await new StatisticsService(path).query({ scope: 'retained', page: 0 }, null, true, null);
    assert.equal(page.state, 'partial');
    assert.equal(page.skippedRecords, 4);
  });

  it('rejects files, aggregate bytes, physical lines, and unsafe totals past the documented budget', async () => {
    const large = fixture();
    writeFileSync(large, '');
    truncateSync(large, MAX_LEDGER_READ_BYTES + 1);
    await assert.rejects(new StatisticsService(large).query({ scope: 'retained', page: 0 }, null, true, null), { code: 'data-limit' });
    const aggregate = fixture();
    writeFileSync(aggregate, ''); truncateSync(aggregate, Math.ceil(MAX_LEDGER_READ_BYTES / 2));
    writeFileSync(aggregate + '.1', ''); truncateSync(aggregate + '.1', Math.ceil(MAX_LEDGER_READ_BYTES / 2) + 1);
    await assert.rejects(new StatisticsService(aggregate).query({ scope: 'retained', page: 0 }, null, true, null), { code: 'data-limit' });
    const lines = fixture();
    writeFileSync(lines, '\n'.repeat(MAX_LEDGER_READ_LINES + 1));
    await assert.rejects(new StatisticsService(lines).query({ scope: 'retained', page: 0 }, null, true, null), { code: 'data-limit' });
    const overflow = fixture();
    write(overflow, [row(1, 'a', { charsBefore: Number.MAX_SAFE_INTEGER }), row(2)]);
    await assert.rejects(new StatisticsService(overflow).query({ scope: 'task', page: 0 }, 'a', true, null), { code: 'unsafe-totals' });
  });

  it('coalesces concurrent snapshots, reuses one snapshot until a revision bump, and reflects recorded runs and resets', async () => {
    const path = fixture();
    write(path, [row(1)]);
    let now = 10000;
    const service = new StatisticsService(path, () => now++);
    const [first, concurrent] = await Promise.all([
      service.query({ scope: 'task', page: 0 }, 'a', true, null),
      service.query({ scope: 'retained', page: 0 }, null, true, null),
    ]);
    assert.equal(first.generatedAt, concurrent.generatedAt);
    // A visible poll must not rescan the ledger: lines that appear without a
    // measurementRevision() bump stay invisible, however old the snapshot gets.
    write(path, [row(1), row(2)]);
    now = first.generatedAt + 600_000;
    const polled = await service.query({ scope: 'task', page: 0 }, 'a', true, null);
    assert.equal(polled.totalRuns, 1);
    assert.equal(polled.generatedAt, first.generatedAt);
    const { persistRunRecord, clearTaskStats } = await import('../tokens');
    // A recorded run bumps the revision, so the next poll sees the two lines
    // written directly above plus the newly recorded one.
    persistRunRecord(row(3) as import('../tokens').RunRecord, path);
    assert.equal((await service.query({ scope: 'task', page: 0 }, 'a', true, null)).totalRuns, 3);
    write(path, []);
    clearTaskStats('a', join(root, 'absent-stats'));
    assert.equal((await service.query({ scope: 'task', page: 0 }, 'a', true, null)).state, 'empty');
  });

  it('validates optional task metadata without making an empty ledger nonempty', async () => {
    const service = new StatisticsService(fixture());
    const page = await service.query({ scope: 'task', page: 0 }, 'a', false, {
      providerUsage: { sentTokens: 37, cacheReadTokens: undefined, cacheWriteTokens: -1 },
      avoidedChars: { slice: 24, search: Infinity, flush: 0 },
    });
    assert.equal(page.state, 'empty');
    assert.deepEqual(page.taskExtras, { providerUsage: { provenance: 'last-available-completed-call', sentTokens: 37,
      cacheReadTokens: null, cacheWriteTokens: null }, avoidedChars: { slice: 24, search: null, flush: 0 } });
    const invalid = await service.query({ scope: 'task', page: 0 }, 'a', true, { providerUsage: { sentTokens: 0.5 } });
    assert.equal(invalid.taskExtras?.providerUsage, null);
    assert.deepEqual(invalid.taskExtras?.avoidedChars, { slice: null, search: null, flush: null });
  });
});
