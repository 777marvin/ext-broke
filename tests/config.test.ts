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

describe('summarize.allowRemoteHost default (review R3)', () => {
  it('defaults to false - remote hosts are blocked without explicit consent', () => {
    assert.equal(DEFAULT_CONFIG.summarize.allowRemoteHost, false);
  });

  it('accepts an explicit true through merge/apply paths', () => {
    const merged = mergeConfig({ summarize: { allowRemoteHost: true } });
    assert.equal(merged.summarize.allowRemoteHost, true);
  });
});

describe('errors.archive default (review R7)', () => {
  it('defaults to OFF - persisting raw tool output is explicit opt-in', () => {
    assert.equal(DEFAULT_CONFIG.errors.archive, false);
  });
});

describe('snapshot config block (F3)', () => {
  it('records milestones on commit by default, test-green heuristics off', () => {
    assert.equal(DEFAULT_CONFIG.snapshot.onCommit, true, 'snapshot writing is additive - nothing in the task history changes');
    assert.equal(DEFAULT_CONFIG.snapshot.onTestPass, false, 'exit-0/passed heuristics misfire on flaky suites');
    assert.equal(
      DEFAULT_CONFIG.snapshot.keepHistory,
      false,
      'raw histories can contain secrets - durable plaintext copies are opt-in (review F-01/D1)',
    );
  });

  it('flush.confirm defaults ON, flush.undo defaults ON - the destructive op keeps its safety net', () => {
    assert.equal(DEFAULT_CONFIG.flush.confirm, true);
    assert.equal(DEFAULT_CONFIG.flush.undo, true, 'restoring a flush needs its raw pre-flush history');
  });

  it('supports dotted-path updates for snapshot/flush keys', () => {
    const updated = applyConfigUpdates(DEFAULT_CONFIG, [['snapshot.onTestPass', true], ['flush.confirm', false]]);
    assert.equal(updated.snapshot.onTestPass, true);
    assert.equal(updated.flush.confirm, false);
    // partial nested merge must not wipe sibling keys
    assert.equal(updated.snapshot.onCommit, DEFAULT_CONFIG.snapshot.onCommit);
  });

  // Regression (found while wiring the F4 search block): without a per-block
  // clone, the dotted-path traversal mutated the CALLER's nested object.
  it('never leaks dotted updates into the previous config instance', () => {
    const before: Config = DEFAULT_CONFIG;
    const snapshotOnCommit = before.snapshot.onCommit;
    const updated = applyConfigUpdates(before, [['snapshot.onCommit', false]]);
    assert.equal(updated.snapshot.onCommit, false);
    assert.equal(before.snapshot.onCommit, snapshotOnCommit, 'previous config was mutated');
  });
});

describe('search config block (F4)', () => {
  it('defaults to keyword backend with honest budget numbers', () => {
    const cfg = mergeConfig({});
    assert.equal(cfg.search.enabled, true); // additive pass - default on
    assert.equal(cfg.search.backend, 'keyword'); // vector/hybrid only when they EXIST
    assert.equal(cfg.search.maxResults, 8);
    assert.equal(cfg.search.maxChars, 6000);
    assert.equal(cfg.search.contextLines, 6);
    assert.equal(cfg.search.maxFileKB, 512);
  });

  it('deep-merges partial search overrides without losing sibling blocks', () => {
    const updated = applyConfigUpdates(DEFAULT_CONFIG, [['search.maxChars', 4000], ['slice.minChars', 5000]]);
    assert.equal(updated.search.maxChars, 4000);
    assert.equal(updated.search.maxResults, DEFAULT_CONFIG.search.maxResults);
    assert.equal(updated.slice.minChars, 5000);
    assert.equal(updated.search.enabled, DEFAULT_CONFIG.search.enabled);
  });
});
