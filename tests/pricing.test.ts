import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatUsd, priceLabel, resolveTaskModelPrice, savedCostUsd, type TaskModelPrice } from '../pricing';
import { appendJsonLine, clearTaskStats, createStatsLoader, emptyStats, loadTaskStats, persistStats } from '../tokens';

const price = (inputPerMToken: number | null): TaskModelPrice => ({
  modelId: 'gpt-4o',
  providerId: 'openai',
  inputPerMToken,
});

/** Minimal ExtensionContext shape resolveTaskModelPrice touches. */
const fakeContext = (
  models: Array<{ providerId: string; id: string; inputCostPerToken?: number }>,
  provider: string,
  model: string,
): import('@aiderdesk/extensions').ExtensionContext =>
  ({
    getTaskContext: () => ({
      getTaskAgentProfile: async () => ({ provider, model }),
    }),
    getModelConfigs: async () => models,
  }) as never;

describe('resolveTaskModelPrice provider matching (BRK-022)', () => {
  it('prefers the exact provider+model match', async () => {
    const price2 = await resolveTaskModelPrice(
      fakeContext(
        [
          { providerId: 'openai', id: 'exact-4o', inputCostPerToken: 0.000003 },
          { providerId: 'azure', id: 'exact-4o', inputCostPerToken: 0.00003 },
        ],
        'openai',
        'exact-4o',
      ),
    );
    assert.equal(price2?.providerId, 'openai');
    assert.equal(price2?.inputPerMToken, 3);
  });

  it('falls back to a UNIQUE bare-id match', async () => {
    const solo = await resolveTaskModelPrice(
      fakeContext([{ providerId: 'other-provider', id: 'solo-model', inputCostPerToken: 0.000007 }], 'prov-a', 'solo-model'),
    );
    assert.equal(solo?.providerId, 'other-provider');
    assert.equal(solo?.inputPerMToken, 7);
  });

  it('reports the price as UNKNOWN when the bare id is ambiguous across providers', async () => {
    const ambiguous = await resolveTaskModelPrice(
      fakeContext(
        [
          { providerId: 'provider-x', id: 'dup-model', inputCostPerToken: 0.000001 },
          { providerId: 'provider-y', id: 'dup-model', inputCostPerToken: 0.000099 },
        ],
        'prov-b',
        'dup-model',
      ),
    );
    assert.equal(ambiguous?.inputPerMToken, null, 'a wrong-provider price is worse than an honest unknown');
    assert.equal(ambiguous?.modelId, 'dup-model');
  });
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

describe('stats rotation chain (XF15)', () => {
  it('loadTaskStats finds the newest line across rotated files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-stats-rot-'));
    const file = join(dir, 'stats.jsonl');
    try {
      const lineBytes = Buffer.byteLength(`${JSON.stringify({ ...emptyStats('task-1'), passes: 1 })}\n`);
      // Every append past one line rotates (cap below one line).
      appendJsonLine(file, JSON.stringify({ ...emptyStats('task-1'), passes: 1 }), lineBytes - 1);
      appendJsonLine(file, JSON.stringify({ ...emptyStats('other'), passes: 9 }), lineBytes - 1);
      appendJsonLine(file, JSON.stringify({ ...emptyStats('task-1'), passes: 2 }), lineBytes - 1);
      // Now: .2 = task-1(1), .1 = other(9), main = task-1(2).
      assert.equal(loadTaskStats('task-1', file)?.passes, 2, 'newest line in the main file wins');
      assert.equal(loadTaskStats('other', file)?.passes, 9, 'lines that live only in a rotation are still found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clearTaskStats removes the task from the main file AND rotations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-stats-rot-clear-'));
    const file = join(dir, 'stats.jsonl');
    try {
      const lineBytes = Buffer.byteLength(`${JSON.stringify({ ...emptyStats('task-1'), passes: 1 })}\n`);
      const cap = lineBytes * 2 - 1; // rotation fires on the 3rd line
      appendJsonLine(file, JSON.stringify({ ...emptyStats('task-1'), passes: 1 }), cap);
      appendJsonLine(file, JSON.stringify({ ...emptyStats('task-2'), passes: 2 }), cap);
      appendJsonLine(file, JSON.stringify({ ...emptyStats('task-1'), passes: 3 }), cap);
      // Now: .1 = task-1(1), task-2(2); main = task-1(3).
      clearTaskStats('task-1', file);
      assert.equal(loadTaskStats('task-1', file), null, 'all task-1 lines are gone, incl. the rotation');
      assert.equal(loadTaskStats('task-2', file)?.passes, 2, 'other tasks survive in rotated files');
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
