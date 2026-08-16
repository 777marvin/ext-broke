import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRunRecord,
  loadRunRecords,
  persistRunRecord,
  summarizeRunRecords,
  type RunRecord,
} from '../tokens';
import type { CompressReport } from '../compress';

const report = (over: Partial<CompressReport> = {}): CompressReport => ({
  touched: true,
  structuralChars: 1000,
  errorChars: 500,
  truncateChars: 2000,
  summarizeChars: 0,
  summarizedRanges: 0,
  summarizeCalls: 0,
  summarizeFailed: false,
  summarizer: 'none',
  totalCharsBefore: 20000,
  totalCharsAfter: 16500,
  ...over,
});

describe('buildRunRecord', () => {
  it('maps a CompressReport to a measurement record', () => {
    const r = buildRunRecord('task-1', report());
    assert.equal(r.kind, 'run');
    assert.equal(r.taskId, 'task-1');
    assert.equal(typeof r.at, 'number');
    assert.equal(r.charsBefore, 20000);
    assert.equal(r.charsAfter, 16500);
    assert.equal(r.savedChars, 3500);
    assert.equal(r.structuralChars, 1000);
    assert.equal(r.errorChars, 500);
    assert.equal(r.truncateChars, 2000);
    assert.equal(r.summarizeChars, 0);
    assert.equal(r.summarizeCalls, 0);
    assert.equal(r.summarizer, 'none');
  });

  it('carries summarizer info through', () => {
    const r = buildRunRecord('t', report({ summarizeChars: 9000, summarizeCalls: 1, summarizer: 'cloud', totalCharsAfter: 7500 }));
    assert.equal(r.summarizeChars, 9000);
    assert.equal(r.summarizeCalls, 1);
    assert.equal(r.summarizer, 'cloud');
    assert.equal(r.savedChars, 12500);
  });
});

describe('persistRunRecord + loadRunRecords', () => {
  const withTemp = (fn: (file: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-measure-'));
    const file = join(dir, 'measure.jsonl');
    try {
      fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const record = (taskId: string, charsBefore: number, charsAfter: number): RunRecord => ({
    kind: 'run',
    taskId,
    at: 1_000,
    charsBefore,
    charsAfter,
    savedChars: charsBefore - charsAfter,
    structuralChars: 0,
    errorChars: 0,
    truncateChars: charsBefore - charsAfter,
    summarizeChars: 0,
    summarizeCalls: 0,
    summarizer: 'none',
  });

  it('appends records and loads them oldest first', () => {
    withTemp((file) => {
      persistRunRecord(record('a', 1000, 900), file);
      persistRunRecord(record('b', 2000, 1700), file);
      const records = loadRunRecords(file);
      assert.equal(records.length, 2);
      assert.equal(records[0].taskId, 'a');
      assert.equal(records[1].taskId, 'b');
    });
  });

  it('rotates: keeps only the most recent half once the cap is exceeded', () => {
    withTemp((file) => {
      // All single-digit task ids make every line byte-identical: the cap is
      // 9 lines minus 1 byte, so rotation fires exactly when line 10 arrives.
      const lineBytes = Buffer.byteLength(`${JSON.stringify(record('x', 1000, 900))}\n`);
      const cap = lineBytes * 9 - 1;
      for (let i = 0; i < 10; i++) {
        persistRunRecord(record(`t${i}`, 1000, 900), file, cap);
      }
      const records = loadRunRecords(file);
      assert.equal(records.length, 6); // half of the 9 kept + the new line
      assert.equal(records[0].taskId, 't4'); // oldest half dropped
      assert.equal(records[records.length - 1].taskId, 't9');
    });
  });

  it('skips malformed lines when loading', () => {
    withTemp((file) => {
      persistRunRecord(record('a', 1000, 900), file);
      const raw = readFileSync(file, 'utf-8');
      const corrupted = `${raw}{not json at all}\n{"kind":"run","taskId":`; // broken JSON line
      writeFileSync(file, corrupted, 'utf-8');
      const records = loadRunRecords(file);
      assert.equal(records.length, 1);
      assert.equal(records[0].taskId, 'a');
    });
  });

  it('returns [] for a missing file', () => {
    withTemp((file) => {
      assert.deepEqual(loadRunRecords(file), []);
    });
  });

  it('never writes a file when only loading', () => {
    withTemp((file) => {
      loadRunRecords(file);
      assert.equal(existsSync(file), false);
    });
  });
});

describe('summarizeRunRecords', () => {
  const record = (savedChars: number, taskId = 't', charsBefore = 10000): RunRecord => ({
    kind: 'run',
    taskId,
    at: 1_000,
    charsBefore,
    charsAfter: charsBefore - savedChars,
    savedChars,
    structuralChars: 0,
    errorChars: 0,
    truncateChars: savedChars,
    summarizeChars: 0,
    summarizeCalls: 0,
    summarizer: 'none',
  });

  it('returns null for an empty record list', () => {
    assert.equal(summarizeRunRecords([]), null);
  });

  it('sums per-run sizes and computes mean/median/max', () => {
    const summary = summarizeRunRecords([record(100), record(300), record(200)]);
    assert.ok(summary);
    assert.equal(summary.runs, 3);
    assert.equal(summary.tasks, 1);
    assert.equal(summary.charsBefore, 30000);
    assert.equal(summary.charsAfter, 30000 - 600);
    assert.equal(summary.savedChars, 600);
    assert.equal(summary.savedTokens, 150);
    assert.equal(summary.meanSavedCharsPerRun, 200);
    assert.equal(summary.medianSavedCharsPerRun, 200);
    assert.equal(summary.maxSavedCharsPerRun, 300);
    assert.equal(summary.summarizeCalls, 0);
  });

  it('median for an even count is the rounded mean of the middle pair', () => {
    const summary = summarizeRunRecords([record(100), record(200), record(300), record(400)]);
    assert.ok(summary);
    assert.equal(summary.medianSavedCharsPerRun, 250);
  });

  it('groups by task and sorts the breakdown by saved chars descending', () => {
    const summary = summarizeRunRecords([record(100, 'a'), record(500, 'b'), record(300, 'a')]);
    assert.ok(summary);
    assert.equal(summary.tasks, 2);
    assert.equal(summary.byTask.length, 2);
    assert.equal(summary.byTask[0].taskId, 'b');
    assert.equal(summary.byTask[0].runs, 1);
    assert.equal(summary.byTask[0].savedChars, 500);
    assert.equal(summary.byTask[1].taskId, 'a');
    assert.equal(summary.byTask[1].runs, 2);
    assert.equal(summary.byTask[1].savedChars, 400);
  });

  it('computes the span between first and last run', () => {
    const r1 = record(10);
    const r2 = record(20);
    r1.at = 1_000_000;
    r2.at = r1.at + 86_400_000; // one day later
    const summary = summarizeRunRecords([r1, r2]);
    assert.ok(summary);
    assert.equal(summary.spanMs, 86_400_000);
  });

  it('span is 0 for a single record', () => {
    const summary = summarizeRunRecords([record(10)]);
    assert.ok(summary);
    assert.equal(summary.spanMs, 0);
  });
});
