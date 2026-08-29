/**
 * BRK-029 (external review): the optional local Ollama backend must not sit
 * in task-critical paths. Probes happen ONLY while the local summarizer is
 * actually active (extension enabled, level 'summarize', via 'local'),
 * concurrent probes share one in-flight request, and task initialization
 * starts the probe in the background instead of waiting up to 3 s for it.
 *
 * Network layer: a local fake Ollama (/api/tags) with a controllable delay
 * and a hit counter - tests assert on real HTTP traffic, no module mocks.
 *
 * IMPORTANT: env overrides MUST be set before any project module is
 * imported (the path constants bind at module load time).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext, TaskInitializedEvent } from '@aiderdesk/extensions';
import type { Config } from '../config';

const tmp = mkdtempSync(join(tmpdir(), 'broke-ollama-gating-'));
process.env.BROKE_CONFIG_PATH = join(tmp, 'config.json');
process.env.BROKE_STATS_PATH = join(tmp, 'stats.jsonl');
process.env.BROKE_MEASURE_PATH = join(tmp, 'measure.jsonl');
process.env.BROKE_ERRORS_DIR = join(tmp, 'errors');
process.env.BROKE_INDEX_DIR = join(tmp, 'indexdir');
process.env.BROKE_DATA_DIR = join(tmp, 'data');
process.env.BROKE_STATS_PERSIST_MIN_MS = '0';

let Broke: (typeof import('../index'))['default'];
let DEFAULT_CONFIG: (typeof import('../config'))['DEFAULT_CONFIG'];
let saveConfig: (typeof import('../config'))['saveConfig'];

before(async () => {
  ({ default: Broke } = await import('../index'));
  ({ DEFAULT_CONFIG, saveConfig } = await import('../config'));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Fake Ollama: counts /api/tags hits and answers after `delayMs`. */
async function startFakeOllama(delayMs: number): Promise<{
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}> {
  let hitCount = 0;
  const server: Server = createServer((_req, res) => {
    hitCount += 1;
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'llama3:latest' }] }));
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hitCount,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Minimal fake host: exactly the parts of the API the badge/init paths use. */
function makeContext(taskId: string): { context: ExtensionContext; logLines: string[] } {
  const logLines: string[] = [];
  const task = {
    data: { id: taskId, provider: 'openai', model: 'gpt-4o', mainModel: 'gpt-4o' },
    getTaskAgentProfile: async () => ({ provider: 'openai', model: 'gpt-4o' }),
    getContextMessages: async () => [],
    addLogMessage: async (_level: string, line: string) => {
      logLines.push(line);
    },
  };
  const context = {
    log: () => undefined,
    getTaskContext: () => task,
    getModelConfigs: async () => [],
    triggerUIDataRefresh: () => undefined,
    triggerUIComponentsReload: () => undefined,
  };
  return { context: context as unknown as ExtensionContext, logLines };
}

/** Write a test config to the isolated BROKE_CONFIG_PATH and drop the cache. */
function writeConfig(over: Partial<Config> = {}): Config {
  const config: Config = {
    ...DEFAULT_CONFIG,
    enabled: true,
    level: 'summarize',
    maxContextChars: 10_000,
    protectedTurns: 1,
    summarize: { ...DEFAULT_CONFIG.summarize, via: 'cloud', cloudModelId: '', afterTurns: 2, minChars: 2_000 },
    ...over,
  };
  saveConfig(config); // saveConfig invalidates the config cache
  return config;
}

function attachContext(ext: unknown, context: ExtensionContext): void {
  (ext as { context: ExtensionContext }).context = context;
}

/** Summarize block pointing the local backend at the fake Ollama. */
function localVia(url: string): Partial<Config> {
  return { summarize: { ...DEFAULT_CONFIG.summarize, via: 'local', ollamaUrl: url } };
}

describe('BRK-029: Ollama probing is gated, deduplicated and non-blocking', () => {
  it('does not probe Ollama when the level is not summarize (badge data AND task init)', async () => {
    const fake = await startFakeOllama(0);
    try {
      writeConfig({ level: 'truncate', ...localVia(fake.url) });
      const ext = new Broke();
      const { context } = makeContext('task-gate-level');

      const data = (await ext.getUIExtensionData('broke-status', context)) as Record<string, unknown>;
      assert.equal(data.ollama, null, 'the badge must not probe Ollama while the level is truncate');
      assert.equal(fake.hits(), 0, 'no /api/tags request for badge data');

      await ext.onTaskInitialized({ task: { id: 'task-gate-level' } } as unknown as TaskInitializedEvent, context);
      assert.equal(fake.hits(), 0, 'task initialization must not probe Ollama while the level is truncate');
    } finally {
      await fake.close();
    }
  });

  it('does not probe Ollama when the extension is disabled', async () => {
    const fake = await startFakeOllama(0);
    try {
      writeConfig({ enabled: false, ...localVia(fake.url) });
      const ext = new Broke();
      const { context } = makeContext('task-gate-off');

      const data = (await ext.getUIExtensionData('broke-status', context)) as Record<string, unknown>;
      assert.equal(data.ollama, null, 'the badge must not probe Ollama while broke is disabled');
      assert.equal(fake.hits(), 0);
    } finally {
      await fake.close();
    }
  });

  it('deduplicates concurrent probes into ONE in-flight request', async () => {
    const fake = await startFakeOllama(150);
    try {
      writeConfig(localVia(fake.url));
      const ext = new Broke();
      const { context } = makeContext('task-dedup');

      const [a, b] = (await Promise.all([
        ext.getUIExtensionData('broke-status', context),
        ext.getUIExtensionData('broke-status', context),
      ])) as Record<string, unknown>[];
      assert.equal(fake.hits(), 1, 'two concurrent badge fetches must share one probe (got ' + fake.hits() + ')');
      assert.equal((a.ollama as Record<string, unknown>).reachable, true);
      assert.equal((b.ollama as Record<string, unknown>).reachable, true);
    } finally {
      await fake.close();
    }
  });

  it('task initialization starts the probe in the background and never waits for it', async () => {
    const fake = await startFakeOllama(500);
    try {
      writeConfig(localVia(fake.url));
      const ext = new Broke();
      const { context, logLines } = makeContext('task-bg');
      attachContext(ext, context);

      const started = Date.now();
      await ext.onTaskInitialized({ task: { id: 'task-bg' } } as unknown as TaskInitializedEvent, context);
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 300, 'task init must not wait for the Ollama probe (took ' + elapsed + 'ms)');
      assert.ok(logLines.some((l) => l.includes('broke active')), 'the init notice is still emitted');
      const initLine = logLines.find((l) => l.includes('broke active')) ?? '';
      assert.ok(!/reachable/.test(initLine), 'no reachability claim while the probe is still in flight');
      // The probe runs in the background - give it a moment to reach the
      // fake server, then confirm it really fired.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(fake.hits() >= 1, 'the active local backend still gets probed, just in the background');
    } finally {
      await fake.close();
    }
  });

  it('reports a fresh cached status in the init line without re-probing', async () => {
    const fake = await startFakeOllama(0);
    try {
      writeConfig(localVia(fake.url));
      const ext = new Broke();
      const { context, logLines } = makeContext('task-warm-init');
      attachContext(ext, context);

      // Warm the cache through the badge path, then re-open a task.
      await ext.getUIExtensionData('broke-status', context);
      assert.equal(fake.hits(), 1);
      await ext.onTaskInitialized({ task: { id: 'task-warm-init' } } as unknown as TaskInitializedEvent, context);
      assert.equal(fake.hits(), 1, 'a fresh cache answers the init line without a new probe');
      const initLine = logLines.find((l) => l.includes('broke active')) ?? '';
      assert.match(initLine, /ollama reachable \(1 models\)/);
    } finally {
      await fake.close();
    }
  });

  it('keeps the badge poll gated on an active summarizer backend (StatusBadge.jsx)', () => {
    const src = readFileSync(join(__dirname, '..', 'StatusBadge.jsx'), 'utf8');
    assert.match(src, /const activeBackend = /, 'the active-backend signal must be derived from the badge data');
    assert.match(
      src,
      /if \(!activeBackend\) return undefined;/,
      'the 10s poll must not run without an active summarizer backend',
    );
    assert.doesNotMatch(src, /setInterval[\s\S]*?\}, \[\]\);/, 'the poll effect must not be unconditional (empty deps)');
  });
});
