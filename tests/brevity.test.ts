import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionContext, PromptTemplateEvent, ToolFinishedEvent } from '@aiderdesk/extensions';
import { buildBrevityDirective } from '../brevity';
import Broke from '../index';
import { CONFIG_PATH, DEFAULT_CONFIG, invalidateConfigCache, saveConfig, type Config } from '../config';
import { runtimeDir } from '../paths';

describe('buildBrevityDirective (brevity.ts)', () => {
  it('returns empty string for off and non-empty directives with safety guardrails for lite/full/ultra', () => {
    assert.equal(buildBrevityDirective('off'), '');
    for (const level of ['lite', 'full', 'ultra'] as const) {
      const text = buildBrevityDirective(level);
      assert.ok(text.startsWith('## Answer style:'));
      assert.ok(text.includes('Keep code, commands, file paths'));
    }
    assert.notEqual(buildBrevityDirective('lite'), buildBrevityDirective('full'));
    assert.notEqual(buildBrevityDirective('full'), buildBrevityDirective('ultra'));
  });
});

describe('Broke onPromptTemplate & tool-level truncation (S8)', () => {
  const withConfig = async (patch: Partial<Config>, fn: () => Promise<void>): Promise<void> => {
    const prev = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf-8') : null;
    try {
      saveConfig({
        ...DEFAULT_CONFIG,
        ...patch,
        brevity: { ...DEFAULT_CONFIG.brevity, ...patch.brevity },
        truncate: { ...DEFAULT_CONFIG.truncate, ...patch.truncate },
      });
      await fn();
    } finally {
      if (prev === null) rmSync(CONFIG_PATH, { force: true });
      else {
        saveConfig(JSON.parse(prev) as Config);
      }
      invalidateConfigCache();
    }
  };

  const stubContext = (taskId = 'task-s8'): ExtensionContext =>
    ({
      log: () => {},
      getProjectDir: () => '',
      getTaskContext: () => ({ data: { id: taskId } }),
      triggerUIDataRefresh: () => {},
      triggerUIComponentsReload: () => {},
    }) as unknown as ExtensionContext;

  it('injects the brevity directive only on system-prompt when enabled and brevity.level !== off', async () => {
    const ext = new Broke();
    const ctx = stubContext();

    await withConfig({ enabled: true, brevity: { level: 'off' } }, async () => {
      const res = await ext.onPromptTemplate({ name: 'system-prompt', prompt: 'Base prompt' } as PromptTemplateEvent, ctx);
      assert.equal(res, undefined);
    });

    await withConfig({ enabled: true, brevity: { level: 'lite' } }, async () => {
      const res = await ext.onPromptTemplate({ name: 'system-prompt', prompt: 'Base prompt' } as PromptTemplateEvent, ctx);
      assert.ok(res && typeof res.prompt === 'string');
      assert.ok(res.prompt.startsWith('Base prompt\n\n## Answer style: concise'));

      // Non-system templates must never be modified.
      const other = await ext.onPromptTemplate({ name: 'commit-message', prompt: 'Base prompt' } as PromptTemplateEvent, ctx);
      assert.equal(other, undefined);
    });

    await withConfig({ enabled: false, brevity: { level: 'full' } }, async () => {
      const res = await ext.onPromptTemplate({ name: 'system-prompt', prompt: 'Base prompt' } as PromptTemplateEvent, ctx);
      assert.equal(res, undefined);
    });
  });

  it('truncates oversized tool outputs at tool level when truncate.toolLevel is on and respects per-tool rules + secret-masked archiving', async () => {
    const ext = new Broke();
    const ctx = stubContext('task-s8-tool');
    const bigLines = Array.from({ length: 40 }, (_, i) => `line-${i} token=sk-secret1234567890abcdef1234567890abcdef`).join('\n');

    // Default (toolLevel: false) -> untouched
    await withConfig({ truncate: { ...DEFAULT_CONFIG.truncate, maxLines: 10, maxKB: 20, toolLevel: false } }, async () => {
      const res = await ext.onToolFinished(
        { toolName: 'power---bash', toolCallId: 'c1', output: bigLines } as unknown as ToolFinishedEvent,
        ctx,
      );
      assert.equal(res, undefined);
    });

    // toolLevel: true, archive: false -> truncated with "full output removed"
    await withConfig({ truncate: { ...DEFAULT_CONFIG.truncate, maxLines: 10, maxKB: 20, toolLevel: true, archive: false } }, async () => {
      const res = await ext.onToolFinished(
        { toolName: 'power---bash', toolCallId: 'c2', output: bigLines } as unknown as ToolFinishedEvent,
        ctx,
      );
      assert.ok(res && typeof res.output === 'string');
      assert.ok(res.output.includes('… [broke: truncated 40 lines → 10] - full output removed'));
    });

    // Per-tool exemption (bare tool name 'bash' matches 'power---bash') -> untouched
    await withConfig(
      {
        truncate: {
          ...DEFAULT_CONFIG.truncate,
          maxLines: 10,
          maxKB: 20,
          toolLevel: true,
          tools: { bash: { enabled: false } },
        },
      },
      async () => {
        const res = await ext.onToolFinished(
          { toolName: 'power---bash', toolCallId: 'c3', output: bigLines } as unknown as ToolFinishedEvent,
          ctx,
        );
        assert.equal(res, undefined);
      },
    );

    // toolLevel: true, archive: true -> archives secret-masked output and links path in marker
    await withConfig(
      {
        truncate: {
          ...DEFAULT_CONFIG.truncate,
          maxLines: 8,
          maxKB: 20,
          toolLevel: true,
          archive: true,
          retentionDays: 7,
        },
      },
      async () => {
        const res = await ext.onToolFinished(
          { toolName: 'power---file_read', toolCallId: 'call-arch-1', output: bigLines } as unknown as ToolFinishedEvent,
          ctx,
        );
        assert.ok(res && typeof res.output === 'string');
        const match = /full output saved to ([^\n]+)/.exec(res.output);
        assert.ok(match, `expected saved path in marker: ${res.output}`);
        const relPath = match[1].trim();
        const absPath = join(runtimeDir(), relPath);
        assert.ok(existsSync(absPath), `expected archive file at ${absPath}`);
        const archivedContent = readFileSync(absPath, 'utf-8');
        assert.ok(!archivedContent.includes('sk-secret1234567890abcdef1234567890abcdef'), 'secrets must be masked before archiving');
        rmSync(absPath, { force: true });
      },
    );
  });
});
