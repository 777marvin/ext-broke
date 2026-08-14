import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatUsd, priceLabel, savedCostUsd, type TaskModelPrice } from '../pricing';
import { emptyStats, loadTaskStats, persistStats } from '../tokens';

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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
