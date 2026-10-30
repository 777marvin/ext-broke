import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG, type Config } from '../config';
import { applyPreset } from '../presets';
import { composeUiTemplate } from '../scripts/ui-template-source.cjs';

const reducer = new Function(`return (${composeUiTemplate('() => { /* BROKE_CONFIG_DRAFT_HELPER */ return mergeConfigDraft; }')})();`)() as (base: Config, latest: Config, next: Config) => Config;

describe('AUD-09 shared synchronous configuration drafts', () => {
  it('preserves a previous same-render edit while applying a nested change', () => {
    const base = applyPreset(DEFAULT_CONFIG, 'long');
    const latest = { ...base, enabled: false, summarize: { ...base.summarize, allowRemoteHost: true } };
    const next = { ...base, cache: { ...base.cache, escapeHatch: false } };
    const before = JSON.stringify([base, latest, next]);
    const result = reducer(base, latest, next);
    assert.equal(result.enabled, false);
    assert.equal(result.summarize.allowRemoteHost, true);
    assert.equal(result.cache.escapeHatch, false);
    assert.equal(result.mode, 'long');
    assert.equal(JSON.stringify([base, latest, next]), before);
  });

  it('marks preset-owned edits custom while preserving sibling nested settings', () => {
    const base = applyPreset(DEFAULT_CONFIG, 'long');
    const latest = { ...base, truncate: { ...base.truncate, archive: true } };
    const next = { ...base, truncate: { ...base.truncate, maxLines: 42 } };
    const result = reducer(base, latest, next);
    assert.equal(result.truncate.maxLines, 42);
    assert.equal(result.truncate.archive, true);
    assert.equal(result.mode, 'custom');
  });

  it('allows explicit deletion of dictionary entries (e.g. truncate.tools reset) without dropping siblings', () => {
    const base = {
      ...DEFAULT_CONFIG,
      truncate: {
        ...DEFAULT_CONFIG.truncate,
        tools: {
          bash: { enabled: true, maxLines: 120, maxKB: 12 },
          grep: { enabled: false },
        },
      },
    };
    const latest = { ...base };
    // Handler removes 'bash' while keeping 'grep'
    const next = {
      ...base,
      truncate: {
        ...base.truncate,
        tools: { grep: { enabled: false } },
      },
    };
    const result = reducer(base, latest, next);
    assert.deepEqual(result.truncate.tools, { grep: { enabled: false } });

    // An unrelated subsequent edit doesn't revive 'bash'
    const nextUnrelated = { ...base, cache: { ...base.cache, escapeHatch: false } };
    const result2 = reducer(base, result, nextUnrelated);
    assert.deepEqual(result2.truncate.tools, { grep: { enabled: false } });
    assert.equal(result2.cache.escapeHatch, false);
  });

  it('evicts stale require.cache entries for ui-template-source.cjs so hot-reload after an update never omits brokeCommandIsMutating', async () => {
    const req = createRequire(join(__dirname, '..', 'index.ts'));
    const helperResolved = req.resolve('./scripts/ui-template-source.cjs');
    const previousCacheEntry = req.cache[helperResolved];
    try {
      // Simulate AiderDesk's jiti loader holding a v1.4.0 cached CJS module in require.cache
      // across an in-place extension update (`npx @aiderdesk/extensions install -g ...`).
      req.cache[helperResolved] = {
        id: helperResolved,
        filename: helperResolved,
        loaded: true,
        exports: {
          composeUiTemplate: (source: string) =>
            source.replace('/* BROKE_CONFIG_DRAFT_HELPER */', 'const mergeConfigDraft = () => ({});'),
        },
      } as unknown as NodeJS.Module;

      const BrokeExtension = (await import(`../index.ts?hotreload=${Date.now()}`)).default;
      const ext = new BrokeExtension();
      const components = ext.getUIComponents({} as never);
      const badge = components.find((c: { id: string }) => c.id === 'broke-status');
      assert.ok(badge, 'broke-status UI component must be registered');
      assert.match(
        badge.jsx,
        /const brokeCommandIsMutating\s*=/,
        'fresh ui-config-helper.js must be injected even when require.cache had a stale v1.4.0 entry',
      );
    } finally {
      if (previousCacheEntry) req.cache[helperResolved] = previousCacheEntry;
      else delete req.cache[helperResolved];
    }
  });
});
