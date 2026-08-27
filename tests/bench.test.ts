import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compressMessages, createCompressState, type SummarizeDeps } from '../compress';
import { DEFAULT_CONFIG } from '../config';
import { messagesChars } from '../tokens';
import { benchF4Scenario, buildBenchWorkload, F4_QUERIES, runScenario, STUB_SUMMARY } from '../scripts/bench';

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

  it('README and docs/overview quote exactly these benchmark numbers (drift guard)', async () => {
    // The published reference numbers must be byte-reproducible from the
    // benchmark itself. When a pipeline change moves a number, this test
    // fails until README.md and docs/overview.md are re-synced - the same
    // principle as HELP_TEXT deriving its defaults from DEFAULT_CONFIG.
    const workload = buildBenchWorkload();
    const totals: string[] = [];
    for (const [label, config] of [
      ['level=truncate (shipped default)', { ...DEFAULT_CONFIG }],
      ['level=summarize (maximum)', { ...DEFAULT_CONFIG, level: 'summarize' as const }],
    ] as const) {
      const lines = await runScenario(label, config, workload);
      const totalLine = lines.find((l) => l.trimStart().startsWith('total'));
      assert.ok(totalLine, `scenario "${label}" must report a total line`);
      const m = totalLine.match(/([\d,]+) chars removed \(~ ([\d,]+) tokens, ([\d.]+)% of input\)/);
      assert.ok(m, `cannot parse total line: ${totalLine}`);
      totals.push(`${m[1]} chars removed`, `(~${m[2]} tokens, ${m[3]}% of the input`);
    }
    for (const doc of ['README.md', join('docs', 'overview.md')]) {
      const text = readFileSync(join(process.cwd(), doc), 'utf-8');
      for (const snippet of totals) {
        assert.ok(text.includes(snippet), `${doc} must contain the current bench number "${snippet}" - re-run npm run bench and sync the docs`);
      }
    }
  });
});

describe('F4 keyword-index scenario (bench)', () => {
  it('is deterministic: two runs report identical numbers', async () => {
    const r1 = await benchF4Scenario();
    const r2 = await benchF4Scenario();
    assert.deepEqual(r1.result, r2.result);
    assert.deepEqual(r1.lines, r2.lines);
  });

  it('reports honest counterfactual figures within the shipped budget', async () => {
    const { result } = await benchF4Scenario();
    assert.ok(result.filesIndexed >= 12, 'fixture modules + README must be indexed');
    assert.ok(result.queryHits.reduce((a, b) => a + b, 0) > 0, 'the fixed queries must hit the fixture');
    assert.ok(result.snippetsSentChars > 0);
    assert.ok(
      result.snippetsSentChars <= F4_QUERIES.length * DEFAULT_CONFIG.search.maxChars,
      'snippet traffic must respect the per-query char budget',
    );
    assert.ok(result.bulkReadBaselineChars >= result.snippetsSentChars, 'whole-file reads cost at least as much as snippets here');
    assert.equal(result.avoidedChars, Math.max(0, result.bulkReadBaselineChars - result.snippetsSentChars));
  });
});
