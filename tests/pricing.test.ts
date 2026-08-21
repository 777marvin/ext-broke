import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatUsd, priceLabel, savedCostUsd, type TaskModelPrice } from '../pricing';
import { clearTaskStats, createStatsLoader, emptyStats, loadTaskStats, persistStats } from '../tokens';

const price = (inputPerMToken: number | null): TaskModelPrice => ({
  modelId: 'gpt-4o',
  providerId: 'openai',
  inputPerMToken,
});

describe('savedCostUsd', () => {
  it('computes USD from tokens and the per-1M input price', () => {
    // 250k input tokens at $3/1M = $0.75
    assert.equal(savedCostUsd(250_000, 3), 0.75);
    assert.equal(savedCostUsd(1000, 3), 0.003);
  });

  it('is 0 for unknown/local prices and empty counts', () => {
    assert.equal(savedCostUsd(250_000, null), 0);
    assert.equal(savedCostUsd(0, 3), 0);
  });
});

describe('formatUsd', () => {
  it('formats dollars, small amounts with 4 decimals', () => {
    assert.equal(formatUsd(1.234), '$1.23');
    assert.equal(formatUsd(0.0042), '$0.0042');
    assert.equal(formatUsd(0), '$0.00');
    assert.equal(formatUsd(-1), '$0.00');
  });
});

describe('priceLabel', () => {
  it('shows the price when known', () => {
    assert.equal(priceLabel(price(3)), 'openai/gpt-4o @ $3/1M input');
  });

  it('marks local/unknown models honestly', () => {
    assert.equal(priceLabel(price(null)), 'openai/gpt-4o (local/unknown - $0)');
    assert.equal(priceLabel(null), 'unknown model');
  });
});

describe('stats persistence privacy', () => {
  it('never persists project paths - only task-scoped fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-stats-'));
    const file = join(dir, 'stats.jsonl');
    try {
      const stats = { ...emptyStats('task-1'), passes: 3 };
      persistStats(stats, file);
      const line = readFileSync(file, 'utf-8').trim();
      assert.ok(!line.includes('projectDir'), 'stats.jsonl must not contain project paths');
      assert.ok(!line.includes('C:'), 'no absolute paths in stats.jsonl');
      const loaded = loadTaskStats('task-1', file);
      assert.equal(loaded?.passes, 3);
      assert.equal(loaded?.savedChars.structural, 0);
      assert.equal(loaded?.totalCharsBefore, 0);
      assert.equal(loaded?.totalCharsAfter, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes legacy stats lines without the measured-size fields (XF14)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-stats-legacy-'));
    const file = join(dir, 'stats.jsonl');
    try {
      // A legacy line: no totalCharsBefore/After.
      writeFileSync(
        file,
        JSON.stringify({ taskId: 'legacy-1', passes: 2, savedChars: { structural: 10 } }) + '\n',
        'utf-8',
      );
      const loaded = loadTaskStats('legacy-1', file);
      assert.equal(loaded?.passes, 2);
      assert.equal(loaded?.totalCharsBefore, 0, 'legacy lines default to 0 (unmeasured)');
      assert.equal(loaded?.totalCharsAfter, 0);
      assert.equal(loaded?.savedChars.truncate, 0, 'missing pass counters normalize to 0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('clearTaskStats', () => {
  it('removes only the matching task lines and keeps others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-stats-clear-'));
    const file = join(dir, 'stats.jsonl');
    try {
      persistStats({ ...emptyStats('task-1'), passes: 1 }, file);
      persistStats({ ...emptyStats('task-2'), passes: 2 }, file);
      persistStats({ ...emptyStats('task-1'), passes: 3 }, file);

      clearTaskStats('task-1', file);

      assert.equal(loadTaskStats('task-1', file), null, 'all task-1 lines are gone');
      assert.equal(loadTaskStats('task-2', file)?.passes, 2, 'other tasks survive the reset');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops malformed lines instead of crashing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-stats-clear-'));
    const file = join(dir, 'stats.jsonl');
    try {
      persistStats({ ...emptyStats('task-1'), passes: 1 }, file);
      const line = readFileSync(file, 'utf-8').trim();
      persistStats({ ...emptyStats('task-2'), passes: 2 }, file);
      // Corrupt the first line in place (keep its taskId unparseable).
      const rewritten = readFileSync(file, 'utf-8').replace(line, '{not json');
      writeFileSync(file, rewritten, 'utf-8');

      clearTaskStats('task-2', file);

      assert.equal(loadTaskStats('task-2', file), null);
      assert.equal(loadTaskStats('task-1', file), null, 'malformed lines are dropped during the rewrite');
      assert.equal(readFileSync(file, 'utf-8').trim(), '', 'no leftover garbage lines');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createStatsLoader', () => {
  it('caches reads within the TTL and re-reads after it (F6)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-stats-loader-'));
    const file = join(dir, 'stats.jsonl');
    const loader = createStatsLoader(file, 60_000);
    try {
      persistStats({ ...emptyStats('task-1'), passes: 1 }, file);
      assert.equal(loader.get('task-1')?.passes, 1);

      // The file changed on disk, but the TTL has not elapsed: cached value.
      persistStats({ ...emptyStats('task-1'), passes: 2 }, file);
      assert.equal(loader.get('task-1')?.passes, 1);

      // A file change must never be invisible after the TTL expires.
      const ttlLoader = createStatsLoader(file, -1); // TTL already over
      assert.equal(ttlLoader.get('task-1')?.passes, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invalidate drops the cache immediately (F6)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-stats-loader-'));
    const file = join(dir, 'stats.jsonl');
    const loader = createStatsLoader(file, 60_000);
    try {
      persistStats({ ...emptyStats('task-1'), passes: 1 }, file);
      assert.equal(loader.get('task-1')?.passes, 1);
      persistStats({ ...emptyStats('task-1'), passes: 2 }, file);
      loader.invalidate('task-1');
      assert.equal(loader.get('task-1')?.passes, 2, 'a reset must be visible immediately');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for unknown tasks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-stats-loader-'));
    const file = join(dir, 'stats.jsonl');
    const loader = createStatsLoader(file, 60_000);
    try {
      assert.equal(loader.get('never-seen'), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
