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

describe('H1 quick-command wiring (review finding: runCommand was dead)', () => {
  it('runCommand executes the real dispatcher and reports the logged message', async () => {
    const host = makeHost();
    const seen: string[] = [];
    host.getTaskContext()!.addLogMessage = async (_level, text) => { seen.push(text ?? ''); };
    const ext = new Broke();

    const res = (await ext.executeUIExtensionAction('broke-status', 'runCommand', ['broke stats'], host)) as {
      ok: boolean;
      message: string;
    };

    assert.equal(res.ok, true, 'the wired action reports success');
    assert.equal(typeof res.message, 'string');
    assert.ok(res.message.length > 0, 'a message is returned to the overlay');
    assert.deepEqual(seen, [res.message], 'the command really ran (same message reached the task log)');
  });

  it('the button output is byte-identical to the typed /broke command (same dispatcher)', async () => {
    const viaCommandHost = makeHost();
    const typed: string[] = [];
    viaCommandHost.getTaskContext()!.addLogMessage = async (_level, text) => { typed.push(text ?? ''); };
    await new Broke().getCommands(viaCommandHost)[0].execute(['stats'], viaCommandHost);

    const viaActionHost = makeHost();
    const clicked: string[] = [];
    viaActionHost.getTaskContext()!.addLogMessage = async (_level, text) => { clicked.push(text ?? ''); };
    const res = (await new Broke().executeUIExtensionAction('broke-status', 'runCommand', ['broke stats'], viaActionHost)) as {
      ok: boolean;
      message: string;
    };

    assert.equal(typed.length, 1, 'the typed command logs exactly one line');
    assert.deepEqual(clicked, typed, 'a click must not diverge from the typed command');
    assert.equal(res.message, typed[0], 'the overlay sees what the chat shows');
  });

  it('runCommand accepts every button command of the Quick Commands grid', async () => {
    const host = makeHost();
    host.getTaskContext()!.addLogMessage = async () => undefined;
    const ext = new Broke();
    const buttons = ['status', 'stats', 'why', 'estimate', 'measure', 'summarize now', 'reset', 'selftest', 'help'];

    for (const cmd of buttons) {
      const res = (await ext.executeUIExtensionAction('broke-status', 'runCommand', [`broke ${cmd}`], host)) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(res.ok, true, `"broke ${cmd}" must be wired: ${res.error ?? ''}`);
    }
  });

  it('runCommand refuses commands outside the allowlist BEFORE executing them', async () => {
    const { getConfig, DEFAULT_CONFIG, saveConfig } = await import('../config');
    saveConfig(DEFAULT_CONFIG);
    const host = makeHost();
    const seen: string[] = [];
    host.getTaskContext()!.addLogMessage = async (_level, text) => { seen.push(text ?? ''); };
    const ext = new Broke();

    // A state-changing command that is NOT on the button grid: if the
    // allowlist ever fails open, the config changes and this test catches it.
    for (const raw of ['broke mode long', 'broke level long', 'broke flush', 'broke snapshot wipe-me', 'broke on']) {
      const res = (await ext.executeUIExtensionAction('broke-status', 'runCommand', [raw], host)) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(res.ok, false, `"${raw}" must be refused`);
      assert.match(res.error ?? '', /unsupported/i);
    }

    assert.equal(getConfig().mode, DEFAULT_CONFIG.mode, 'no refused command changed the config');
    assert.deepEqual(seen, [], 'a refused command never reaches the dispatcher');
  });

  it('runCommand refuses malformed input instead of throwing', async () => {
    const host = makeHost();
    const ext = new Broke();

    for (const args of [[], [undefined], [123], [''], ['broke'], ['   '], ['broke zzz-not-a-command']]) {
      const res = await ext.executeUIExtensionAction('broke-status', 'runCommand', args, host);
      assert.equal((res as { ok: boolean }).ok, false, `args ${JSON.stringify(args)} must be refused`);
    }
  });

  it('an unknown action still returns null (host contract unchanged)', async () => {
    const ext = new Broke();
    assert.equal(await ext.executeUIExtensionAction('broke-status', 'totallyUnknown', [], makeHost()), null);
  });

  it('the /broke command itself still works after the extraction', async () => {
    const host = makeHost();
    const seen: string[] = [];
    host.getTaskContext()!.addLogMessage = async (_level, text) => { seen.push(text ?? ''); };
    const ext = new Broke();

    await ext.getCommands(host)[0].execute(['status'], host);

    assert.equal(seen.length, 1, 'the command still logs exactly one line');
    assert.match(seen[0], /broke/i);
  });
});

describe('F5 preset actions', () => {
  it('previews canonical presets without saving; rejects invalid requests', async () => {
    const ext = new Broke();
    const host = makeHost();
    const before = await ext.getConfigData();
    const preview = await ext.executeUIExtensionAction('broke-status', 'previewMode', [before, 'long'], host) as { mode: string; level: string };
    assert.equal(preview.mode, 'long');
    assert.equal(preview.level, 'summarize');
    assert.deepEqual(await ext.getConfigData(), before);
    await assert.rejects(ext.executeUIExtensionAction('broke-status', 'previewMode', [before, 'bogus'], host));
    const saved = await ext.executeUIExtensionAction('broke-status', 'setConfig', [preview], host) as { ok: boolean; config: { mode: string } };
    assert.equal(saved.ok, true);
    assert.equal(saved.config.mode, 'long');
  });
});

describe('F5 Long guidance before command persistence', () => {
  it('shows local/cloud guidance before both Long command entry points write settings', async () => {
    const { getConfig, saveConfig, DEFAULT_CONFIG } = await import('../config');
    const escapedLong = String.raw`"\u006cong"`;
    for (const args of [['mode', 'long'], ['config', 'set', 'mode', 'long'], ['config', 'set', 'mode', escapedLong], ['config', 'set', 'mode', '  "long"  ']]) {
      saveConfig(DEFAULT_CONFIG);
      const ext = new Broke();
      const host = makeHost();
      const seen: { text: string; mode: string }[] = [];
      host.getTaskContext()!.addLogMessage = async (_level, text) => { seen.push({ text: text ?? '', mode: getConfig().mode }); };
      await ext.getCommands(host)[0].execute(args, host);
      assert.match(seen[0].text, /Ollama.*cloud.*cost/i);
      assert.equal(seen[0].mode, 'custom', 'guidance precedes persistence');
      assert.equal(getConfig().mode, 'long');
    }
  });

  it('fires Long guidance for every quoted config set spelling; persistence follows the coerce contract', async () => {
    const { getConfig, saveConfig, DEFAULT_CONFIG } = await import('../config');
    // Double quotes are unwrapped by coerceConfigValue (JSON) and persist;
    // single quotes stay a raw string and are rejected by the schema.
    for (const [raw, persisted] of [['"long"', 'long'], ["'long'", 'custom']] as const) {
      saveConfig(DEFAULT_CONFIG);
      const ext = new Broke();
      const host = makeHost();
      const seen: string[] = [];
      host.getTaskContext()!.addLogMessage = async (_level, text) => { seen.push(text ?? ''); };
      await ext.getCommands(host)[0].execute(['config', 'set', 'mode', raw], host);
      if (persisted === 'long') assert.match(seen[0], /Ollama.*cloud.*cost/i);
      else assert.match(seen[0], /rejected/i, 'invalid values are rejected without claiming Long will be applied');
      assert.equal(getConfig().mode, persisted, `${raw} must ${persisted === 'long' ? 'persist through JSON unwrapping' : 'be rejected, keeping the previous config'}`);
    }
  });
});
