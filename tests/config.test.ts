import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyConfigUpdates,
  DEFAULT_CONFIG,
  loadConfigFile,
  mergeConfig,
  updateConfigPaths,
  type Config,
} from '../config';

describe('mergeConfig', () => {
  it('deep-merges nested blocks, later parts win', () => {
    const merged = mergeConfig({ truncate: { maxLines: 10 } }, { truncate: { maxKB: 5 } });
    assert.equal(merged.truncate.maxLines, 10);
    assert.equal(merged.truncate.maxKB, 5);
    assert.equal(merged.truncate.maxInputChars, DEFAULT_CONFIG.truncate.maxInputChars); // untouched default
  });

  it('fills missing values with defaults', () => {
    const merged = mergeConfig({ enabled: false });
    assert.equal(merged.enabled, false);
    assert.equal(merged.level, 'truncate');
    assert.equal(merged.summarize.via, 'local');
  });

  it('replaces arrays instead of merging them', () => {
    const merged = mergeConfig({ level: 'summarize' });
    assert.equal(merged.level, 'summarize');
  });

  it('rejects values outside the schema', () => {
    assert.throws(() => mergeConfig({ protectedTurns: 0 }), /protectedTurns/i);
    assert.throws(() => mergeConfig({ level: 'nuke' }), /level/i);
  });
});

describe('loadConfigFile', () => {
  it('loads a partial config and fills defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-config-'));
    const file = join(dir, 'config.json');
    try {
      writeFileSync(file, JSON.stringify({ maxContextChars: 12345 }), 'utf-8');
      const { config, warning } = loadConfigFile(file);
      assert.equal(config.maxContextChars, 12345);
      assert.equal(config.protectedTurns, DEFAULT_CONFIG.protectedTurns);
      assert.equal(warning, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to defaults with a warning on a corrupted file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-config-'));
    const file = join(dir, 'config.json');
    try {
      writeFileSync(file, '{ not valid json', 'utf-8');
      const { config, warning } = loadConfigFile(file);
      assert.deepEqual(config, DEFAULT_CONFIG);
      assert.ok(warning, 'a corrupted file must produce a warning');
      assert.ok(warning.includes('unreadable'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to defaults when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-config-'));
    try {
      const { config, warning } = loadConfigFile(join(dir, 'missing.json'));
      assert.deepEqual(config, DEFAULT_CONFIG);
      assert.ok(warning);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('applyConfigUpdates', () => {
  it('updates nested paths without mutating the input', () => {
    const before: Config = { ...DEFAULT_CONFIG };
    const updated = applyConfigUpdates(before, [['summarize.localModel', 'llama3.2:1b']]);
    assert.equal(updated.summarize.localModel, 'llama3.2:1b');
    assert.equal(before.summarize.localModel, DEFAULT_CONFIG.summarize.localModel, 'input config must not be mutated');
  });

  it('throws on values outside the schema', () => {
    assert.throws(() => applyConfigUpdates({ ...DEFAULT_CONFIG }, [['protectedTurns', 999]]));
    assert.throws(() => applyConfigUpdates({ ...DEFAULT_CONFIG }, [['summarize.afterTurns', 1]]));
  });
});

describe('updateConfigPaths', () => {
  it('persists multiple updates in one atomic write (F13)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-config-'));
    const file = join(dir, 'config.json');
    try {
      const config = updateConfigPaths(
        [
          ['truncate.maxLines', 123],
          ['truncate.maxKB', 45],
        ],
        file,
      );
      assert.equal(config.truncate.maxLines, 123);
      assert.equal(config.truncate.maxKB, 45);
      // Both values landed in the persisted file.
      const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as Config;
      assert.equal(onDisk.truncate.maxLines, 123);
      assert.equal(onDisk.truncate.maxKB, 45);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the file untouched when an update is invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-config-'));
    const file = join(dir, 'config.json');
    try {
      updateConfigPaths([['truncate.maxLines', 50]], file);
      const before = readFileSync(file, 'utf-8');
      assert.throws(() => updateConfigPaths([['protectedTurns', 999]], file));
      assert.equal(readFileSync(file, 'utf-8'), before, 'a failed update must not corrupt the file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('slice config block', () => {
  it('defaults to OFF with honest thresholds', () => {
    assert.equal(DEFAULT_CONFIG.slice.enabled, false, 'slicing changes what the agent sees - opt-in');
    assert.equal(DEFAULT_CONFIG.slice.parser, 'heuristic');
    assert.equal(DEFAULT_CONFIG.slice.minChars, 4000);
    assert.equal(DEFAULT_CONFIG.slice.maxChars, 20000);
    assert.equal(DEFAULT_CONFIG.slice.focusAuto, true);
  });

  it('deep-merges partial slice overrides without losing sibling blocks', () => {
    const merged = mergeConfig({ slice: { minChars: 100 } });
    assert.equal(merged.slice.minChars, 100);
    assert.equal(merged.slice.enabled, false);
    assert.equal(merged.errors.enabled, true, 'errors block untouched');
  });

  it('supports dotted-path updates for slice keys', () => {
    const updated = applyConfigUpdates(DEFAULT_CONFIG, [['slice.enabled', true], ['slice.maxChars', 1000]]);
    assert.equal(updated.slice.enabled, true);
    assert.equal(updated.slice.maxChars, 1000);
    assert.equal(updated.slice.minChars, 4000, 'untouched default survives');
  });
});
