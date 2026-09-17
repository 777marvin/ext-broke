import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigSchema, DEFAULT_CONFIG, applyConfigUpdates, mergeConfig } from '../config';
import { applyPreset, MODE_PRESETS } from '../presets';

describe('F5 mode presets', () => {
  it('migrates legacy configs to custom/autonomous without replacing values', () => {
    const config = ConfigSchema.parse({ maxContextChars: 12345, level: 'summarize' });
    assert.equal(config.mode, 'custom');
    assert.equal(config.autonomy, 'autonomous');
    assert.equal(config.maxContextChars, 12345);
    assert.equal(config.level, 'summarize');
  });

  it('applies every canonical bundle without mutating the input or unrelated settings', () => {
    const original = mergeConfig(DEFAULT_CONFIG, {
      enabled: false, cache: { profile: 'anthropic', escapeHatch: false },
      summarize: { via: 'cloud', cloudModelId: 'provider/model', allowRemoteHost: false },
      slice: { enabled: true }, search: { enabled: false }, autonomy: 'manual',
    });
    const before = structuredClone(original);
    for (const mode of ['short', 'normal', 'long'] as const) {
      const result = ConfigSchema.parse(applyPreset(original, mode));
      assert.equal(result.mode, mode);
      assert.equal(result.level, MODE_PRESETS[mode].level);
      assert.equal(result.enabled, false);
      assert.equal(result.autonomy, 'manual');
      for (const key of ['cache', 'slice', 'search', 'errors', 'snapshot', 'flush'] as const) {
        assert.deepEqual(result[key], original[key]);
      }
      assert.equal(result.summarize.via, 'cloud');
      assert.equal(result.summarize.cloudModelId, 'provider/model');
      assert.equal(result.summarize.allowRemoteHost, false);
    }
    assert.deepEqual(original, before);
  });

  it('pins the approved starting values', () => {
    for (const mode of ['short', 'normal', 'long'] as const) {
      const result = applyPreset(DEFAULT_CONFIG, mode);
      assert.equal(result.maxContextChars, 60000);
      assert.equal(result.protectedTurns, 2);
      assert.equal(result.truncate.maxLines, mode === 'long' ? 120 : 200);
      assert.equal(result.truncate.maxKB, mode === 'long' ? 12 : 20);
      assert.equal(result.summarize.afterTurns, mode === 'long' ? 4 : 8);
    }
  });

  it('custom keeps the current values; preset-owned overrides become custom on every parse', () => {
    const config = applyPreset(DEFAULT_CONFIG, 'long');
    assert.deepEqual(applyPreset(config, 'custom'), { ...config, mode: 'custom' });
    assert.equal(applyConfigUpdates(config, [['maxContextChars', 90000]]).mode, 'custom');
    assert.equal(ConfigSchema.parse({ ...config, level: 'structural' }).mode, 'custom');
    assert.equal(applyConfigUpdates(config, [['cache.profile', 'auto']]).mode, 'long');
    assert.equal(applyConfigUpdates(config, [['autonomy', 'manual']]).mode, 'long');
    assert.equal(applyConfigUpdates(DEFAULT_CONFIG, [['mode', 'long']]).level, 'summarize');
  });

  it('rejects invalid modes and autonomy values', () => {
    assert.throws(() => ConfigSchema.parse({ mode: 'bogus' }));
    assert.throws(() => ConfigSchema.parse({ autonomy: 'guided' }));
  });
});

describe('F5 command surface', () => {
  it('parses mode/autonomy and rejects unknown or extra arguments', async () => {
    const { parseBrokeCommand } = await import('../commands');
    assert.deepEqual(parseBrokeCommand(['mode', 'long']), { kind: 'mode', mode: 'long' });
    assert.deepEqual(parseBrokeCommand(['autonomy', 'manual']), { kind: 'autonomy', autonomy: 'manual' });
    for (const args of [['mode'], ['mode', 'bad'], ['mode', 'long', 'extra'], ['autonomy', 'guided']]) {
      assert.equal(parseBrokeCommand(args).kind, 'unknown');
    }
  });
});
