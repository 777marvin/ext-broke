/**
 * Badge settings-overlay UI actions (task 7): the badge's one-click settings
 * overlay reads the full config via 'getConfig' and saves edits through
 * 'setConfig' - the SAME validated path as the settings dialog
 * (saveConfigData: schema-reject keeps the previous config).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'broke-ui-actions-'));
process.env.BROKE_CONFIG_PATH = join(tmp, 'config.json');
process.env.BROKE_STATS_PATH = join(tmp, 'stats.jsonl');
process.env.BROKE_MEASURE_PATH = join(tmp, 'measure.jsonl');
process.env.BROKE_ERRORS_DIR = join(tmp, 'errors');
process.env.BROKE_INDEX_DIR = join(tmp, 'indexdir');
process.env.BROKE_STATS_PERSIST_MIN_MS = '0';

let Broke: (typeof import('../index'))['default'];
let DEFAULT_CONFIG: (typeof import('../config'))['DEFAULT_CONFIG'];

before(async () => {
  ({ default: Broke } = await import('../index'));
  ({ DEFAULT_CONFIG } = await import('../config'));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const makeHost = (): import('@aiderdesk/extensions').ExtensionContext => {
  const task = { data: { id: 'ui-actions', provider: 'anthropic', model: 'claude-sonnet-4' }, getTaskAgentProfile: async () => ({ provider: 'anthropic', model: 'claude-sonnet-4' }), getContextMessages: async () => [], getModelConfigs: async () => [], addLogMessage: async () => undefined };
  return {
    log: () => undefined,
    getTaskContext: () => task,
    triggerUIDataRefresh: () => undefined,
    triggerUIComponentsReload: () => undefined,
  } as unknown as import('@aiderdesk/extensions').ExtensionContext;
};

describe('badge overlay UI actions (task 7)', () => {
  it('getConfig returns the full validated config incl. the cache section', async () => {
    const ext = new Broke();
    const cfg = (await ext.executeUIExtensionAction('broke-status', 'getConfig', [], makeHost())) as Record<string, unknown>;
    assert.ok(cfg && typeof cfg === 'object');
    assert.equal(cfg.enabled, DEFAULT_CONFIG.enabled);
    assert.deepEqual(cfg.cache, { profile: 'off', escapeHatch: true });
  });

  it('setConfig persists a valid config and returns ok + the parsed result', async () => {
    const context = makeHost();
    const ext = new Broke();
    const current = (await ext.executeUIExtensionAction('broke-status', 'getConfig', [], context)) as Record<string, any>;
    const updated = { ...current, cache: { profile: 'anthropic', escapeHatch: false } };
    const res = (await ext.executeUIExtensionAction('broke-status', 'setConfig', [updated], context)) as { ok: boolean; config: Record<string, any> };
    assert.equal(res.ok, true, 'a valid config saves');
    assert.equal(res.config.cache.profile, 'anthropic');
    assert.equal(res.config.cache.escapeHatch, false);

    // Persisted: a fresh instance reads the saved value from disk.
    const ext2 = new Broke();
    const reread = (await ext2.executeUIExtensionAction('broke-status', 'getConfig', [], context)) as Record<string, any>;
    assert.equal(reread.cache.profile, 'anthropic');
    assert.equal(reread.cache.escapeHatch, false);
  });

  it('setConfig rejects an out-of-schema value (ok: false) and keeps the previous config', async () => {
    const context = makeHost();
    const ext = new Broke();
    const current = (await ext.executeUIExtensionAction('broke-status', 'getConfig', [], context)) as Record<string, any>;
    const bad = { ...current, cache: { profile: 'nope', escapeHatch: true }, level: 'not-a-level' };
    const res = (await ext.executeUIExtensionAction('broke-status', 'setConfig', [bad], context)) as { ok: boolean; config: Record<string, any> };
    assert.equal(res.ok, false, 'the rejection is visible to the overlay');
    assert.equal(res.config.cache.profile, 'anthropic', 'previous config kept');
    assert.equal(res.config.level, 'truncate', 'previous config kept');
  });
});
