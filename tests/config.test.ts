import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyConfigUpdates,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  getConfig,
  invalidateConfigCache,
  loadConfigFile,
  mergeConfig,
  saveConfig,
  updateConfigPaths,
  resolveCacheProfile,
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

  it('missing file is a silent first run (BRK-023)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-config-'));
    try {
      const { config, warning } = loadConfigFile(join(dir, 'missing.json'));
      assert.deepEqual(config, DEFAULT_CONFIG);
      assert.equal(warning, null, 'ENOENT is the normal first run - it must not warn');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns with full paths about unknown keys and keeps known values (BRK-023)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-config-'));
    const file = join(dir, 'config.json');
    try {
      writeFileSync(file, JSON.stringify({ maxContexChars: 99999, search: { maxChars: 1234, typoKey: true } }), 'utf-8');
      const { config, warning } = loadConfigFile(file);
      assert.ok(warning, 'unknown keys must produce a warning');
      assert.match(warning ?? '', /maxContexChars/);
      assert.match(warning ?? '', /search\.typoKey/);
      assert.equal(config.maxContextChars, DEFAULT_CONFIG.maxContextChars, 'the typo must fall back to the default');
      assert.equal(config.search.maxChars, 1234, 'known values still apply alongside the warning');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saveConfig survives a sabotaged legacy temp path via unique temp names (BRK-010)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-config-'));
    const file = join(dir, 'config.json');
    try {
      // A stale/locked fixed-name temp must not break saving: unique temp
      // names (pid + randomness) cannot collide with leftovers.
      mkdirSync(`${file}.tmp`);
      saveConfig(mergeConfig({ maxContextChars: 555 }), file);
      assert.equal(JSON.parse(readFileSync(file, 'utf-8')).maxContextChars, 555);
      assert.equal(existsSync(`${file}.tmp`), true, 'the unrelated directory stays untouched');
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

  it('CONF-001: preserves cache block immutability when applying updates', () => {
    const before = mergeConfig({});
    const previous = before.cache.profile;
    const updated = applyConfigUpdates(before, [['cache.profile', 'anthropic']]);
    assert.equal(before.cache.profile, previous, 'original cache object not mutated');
    assert.equal(updated.cache.profile, 'anthropic');
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

  it('enforces hard ceilings on resource budgets regardless of what was persisted (BRK-018)', () => {
    // In-range values pass through...
    const inRange = mergeConfig({ search: { maxChars: 50_000, maxFileKB: 2048 } });
    assert.equal(inRange.search.maxChars, 50_000);
    assert.equal(inRange.search.maxFileKB, 2048);
    // ...out-of-range values are rejected at the schema boundary (a
    // hand-edited config is not a trusted resource budget).
    assert.throws(() => mergeConfig({ search: { maxChars: 400 } }), /maxChars/i);
    assert.throws(() => mergeConfig({ search: { maxChars: 100_000 } }), /maxChars/i);
    assert.throws(() => mergeConfig({ search: { maxFileKB: 4096 } }), /maxFileKB/i);
  });
});

describe('cache block', () => {
  it('defaults to off (opt-in like every behavior-changing pass) with the escape hatch armed', () => {
    const cfg = mergeConfig({});
    assert.equal(cfg.cache.profile, 'off');
    assert.equal(cfg.cache.escapeHatch, true);
  });

  it('fills the cache block with defaults even when the block is missing entirely', () => {
    const cfg = mergeConfig({ maxContextChars: 12345 });
    assert.equal(cfg.cache.profile, 'off');
    assert.equal(cfg.cache.escapeHatch, true);
  });

  it('accepts every documented profile and rejects unknown ones', () => {
    for (const profile of ['auto', 'anthropic', 'openai', 'off'] as const) {
      assert.equal(mergeConfig({ cache: { profile } }).cache.profile, profile);
    }
    assert.throws(() => mergeConfig({ cache: { profile: 'gemini' } }), /profile/i);
  });
});

describe('resolveCacheProfile', () => {
  it('uses an explicit profile without consulting the hints', () => {
    assert.equal(resolveCacheProfile({ cache: { profile: 'openai' } }, { provider: 'anthropic', model: 'claude-sonnet-4' }), 'openai');
    assert.equal(resolveCacheProfile({ cache: { profile: 'anthropic' } }, { provider: 'openai', model: 'gpt-4o' }), 'anthropic');
    assert.equal(resolveCacheProfile({ cache: { profile: 'off' } }, { provider: 'anthropic', model: 'claude-sonnet-4' }), 'off');
  });

  it('auto: sniffs the MODEL first - cache behavior follows the model, not the aggregator', () => {
    // claude behind an aggregator/proxy still has Anthropic-style caching.
    assert.equal(resolveCacheProfile({ cache: { profile: 'auto' } }, { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' }), 'anthropic');
    assert.equal(resolveCacheProfile({ cache: { profile: 'auto' } }, { provider: 'bedrock', model: 'anthropic.claude-3-5-sonnet-20240620-v1:0' }), 'anthropic');
    assert.equal(resolveCacheProfile({ cache: { profile: 'auto' } }, { provider: 'azure', model: 'gpt-4o' }), 'openai');
    assert.equal(resolveCacheProfile({ cache: { profile: 'auto' } }, { provider: 'openai', model: 'o3-mini' }), 'openai');
  });

  it('auto: falls back to the provider name when the model does not match a known family', () => {
    assert.equal(resolveCacheProfile({ cache: { profile: 'auto' } }, { provider: 'anthropic' }), 'anthropic');
    assert.equal(resolveCacheProfile({ cache: { profile: 'auto' } }, { provider: 'openai' }), 'openai');
    // Local runtimes have no paid cache economics - no reason to restrain passes.
    assert.equal(resolveCacheProfile({ cache: { profile: 'auto' } }, { provider: 'ollama', model: 'qwen2.5-coder:3b' }), 'off');
    assert.equal(resolveCacheProfile({ cache: { profile: 'auto' } }, { provider: 'lmstudio' }), 'off');
  });

  it('auto: unknown provider and unmatched model resolve to off (current behavior, no risk)', () => {
    assert.equal(resolveCacheProfile({ cache: { profile: 'auto' } }, { provider: 'neuralwatt', model: 'some-new-model' }), 'off');
    assert.equal(resolveCacheProfile({ cache: { profile: 'auto' } }, {}), 'off');
    assert.equal(resolveCacheProfile({ cache: { profile: 'auto' } }, { provider: '', model: '' }), 'off');
  });

  it('never throws on odd hints (host surface must stay unbreakable)', () => {
    assert.doesNotThrow(() => resolveCacheProfile({ cache: { profile: 'auto' } }, { provider: undefined as unknown as string, model: 42 as unknown as string }));
    assert.equal(resolveCacheProfile({ cache: { profile: 'auto' } }, { provider: undefined as unknown as string, model: 42 as unknown as string }), 'off');
  });
});

describe('CONF-002: getConfig cached read and ENOENT handling', () => {
  it('reloads default config when cached config file is deleted', () => {
    try {
      invalidateConfigCache();
      saveConfig({ ...DEFAULT_CONFIG, protectedTurns: 5 }, CONFIG_PATH);
      const c1 = getConfig();
      assert.equal(c1.protectedTurns, 5);

      // Delete the file
      if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
      // getConfig should detect ENOENT, invalidate cache, and return defaults
      const c2 = getConfig();
      assert.equal(c2.protectedTurns, DEFAULT_CONFIG.protectedTurns, 'reloads defaults on deleted file');
    } finally {
      invalidateConfigCache();
      if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH, { force: true });
    }
  });
});
