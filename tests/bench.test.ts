import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compressMessages, createCompressState, type SummarizeDeps } from '../compress';
import { DEFAULT_CONFIG } from '../config';
import { messagesChars } from '../tokens';
import { buildBenchWorkload, STUB_SUMMARY } from '../scripts/bench';

const deps: SummarizeDeps = {
  generateLocal: async () => STUB_SUMMARY,
  generateCloud: async () => STUB_SUMMARY,
};

describe('benchmark workload', () => {
  it('is deterministic: two runs report identical per-pass numbers', async () => {
    const workload = buildBenchWorkload();
    const config = { ...DEFAULT_CONFIG, level: 'summarize' as const };
    const r1 = await compressMessages(workload, config, deps, createCompressState(), 'bench-1');
    const r2 = await compressMessages(workload, config, deps, createCompressState(), 'bench-2');
    assert.equal(r1.report.totalCharsAfter, r2.report.totalCharsAfter);
    assert.equal(r1.report.structuralChars, r2.report.structuralChars);
    assert.equal(r1.report.errorChars, r2.report.errorChars);
    assert.equal(r1.report.truncateChars, r2.report.truncateChars);
    assert.equal(r1.report.summarizeChars, r2.report.summarizeChars);
  });

  it('produces measurable savings in every enabled pass at the shipped defaults', async () => {
    const workload = buildBenchWorkload();
    const before = messagesChars(workload);
    assert.ok(before > DEFAULT_CONFIG.maxContextChars, 'workload must exceed the lossy-pass threshold');
    const { report } = await compressMessages(workload, { ...DEFAULT_CONFIG }, deps, createCompressState(), 'bench');
    assert.ok(report.structuralChars > 0, 'structural pass must fire (dedupe)');
    assert.ok(report.errorChars > 0, 'error pass must fire (tsc dump)');
    assert.ok(report.truncateChars > 0, 'truncate pass must fire (oversized outputs)');
    assert.equal(report.summarizeChars, 0, 'summarize is not enabled at the shipped level');
    assert.ok(before - report.totalCharsAfter > 0, 'the workload must produce real savings');
  });

  it('fires the summarize pass at maximum level', async () => {
    const workload = buildBenchWorkload();
    const config = { ...DEFAULT_CONFIG, level: 'summarize' as const };
    const { report } = await compressMessages(workload, config, deps, createCompressState(), 'bench');
    assert.ok(report.summarizeChars > 0, 'summarize pass must replace the old region');
    assert.equal(report.summarizeFailed, false);
  });
});
