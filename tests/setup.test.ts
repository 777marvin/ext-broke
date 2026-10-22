import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { after, describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../config';
import { ollamaStatus } from '../local';
import { checkSetupReadiness, deriveSetupReadiness, dismissSetup, hasOllamaModel, loadSetupState } from '../setup';

function config(overrides: Partial<Config> = {}): Config {
  return { ...structuredClone(DEFAULT_CONFIG), ...overrides };
}

function summaries(overrides: Partial<Config> = {}, local: Partial<Config['summarize']> = {}): Config {
  return config({ level: 'summarize', ...overrides, summarize: { ...DEFAULT_CONFIG.summarize, ...local } });
}

const directories: string[] = [];
const servers: Server[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'broke-setup-'));
  directories.push(path);
  return path;
}

async function fixture(models: string[] = ['qwen2.5-coder:3b']) {
  const requests: { method?: string; url?: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  return { requests, url: `http://127.0.0.1:${port}`, remoteUrl: `http://127.0.0.2:${port}` };
}

after(() => {
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  for (const path of directories) rmSync(path, { recursive: true, force: true });
});

describe('setup readiness', () => {
  it('keeps Balanced basic compression ready without an Ollama status', () => {
    const result = deriveSetupReadiness(config());
    assert.equal(result.basic.state, 'ready');
    assert.equal(result.backend.state, 'not-needed');
    assert.equal(result.model.state, 'not-needed');
    assert.equal(result.automatic.state, 'not-needed');
    assert.match(result.basic.detail, /Broke is enabled/i);
    assert.match(result.basic.detail, /no extra software/i);
    assert.match(result.backend.heading, /backend/i);
    assert.match(result.model.heading, /model/i);
    assert.match(result.automatic.heading, /automatic summaries.*not selected/i);
    assert.equal(new Set([result.backend.heading, result.model.heading, result.automatic.heading]).size, 3);
  });

  it('describes Off even when a previous local check succeeded', () => {
    const result = deriveSetupReadiness(summaries({ enabled: false }), { reachable: true, models: ['qwen2.5-coder:3b'] });
    assert.equal(result.basic.state, 'off');
    assert.equal(result.backend.state, 'not-needed');
    assert.equal(result.automatic.state, 'off');
  });

  it('preserves manual automation with basic compression enabled', () => {
    const result = deriveSetupReadiness(summaries({ autonomy: 'manual' }), { reachable: true, models: ['qwen2.5-coder:3b'] });
    assert.equal(result.basic.state, 'ready');
    assert.equal(result.model.state, 'ready');
    assert.equal(result.automatic.state, 'manual');
  });

  for (const entry of [
    { name: 'unchecked local metadata', status: undefined, backend: 'unknown', model: 'unknown', automatic: 'unknown' },
    { name: 'pending local metadata', status: null, backend: 'checking', model: 'checking', automatic: 'checking' },
    { name: 'unreachable backend', status: { reachable: false, models: [], error: 'timeout after 200 ms' }, backend: 'unavailable', model: 'unchecked', automatic: 'unavailable' },
    { name: 'wrong installed model tag', status: { reachable: true, models: ['qwen2.5-coder:7b'] }, backend: 'ready', model: 'unavailable', automatic: 'unavailable' },
    { name: 'installed configured model', status: { reachable: true, models: ['qwen2.5-coder:3b'] }, backend: 'ready', model: 'ready', automatic: 'ready' },
  ] as const) {
    it(`reports ${entry.name} independently from basic compression`, () => {
      const status = entry.status == null ? entry.status : { ...entry.status, models: [...entry.status.models] };
      const result = deriveSetupReadiness(summaries(), status);
      assert.equal(result.basic.state, 'ready');
      assert.equal(result.backend.state, entry.backend);
      assert.equal(result.model.state, entry.model);
      assert.equal(result.automatic.state, entry.automatic);
      for (const check of Object.values(result)) {
        assert.ok(check.heading.trim());
        assert.ok(check.detail.trim());
      }
    });
  }

  it('does not let a passed status bypass remote-host consent', () => {
    const result = deriveSetupReadiness(summaries({}, { ollamaUrl: 'https://remote.example' }), { reachable: true, models: ['qwen2.5-coder:3b'] });
    assert.equal(result.backend.state, 'blocked');
    assert.equal(result.model.state, 'unchecked');
    assert.equal(result.automatic.state, 'blocked');
  });

  it('accepts a consented remote server but still requires its exact model', () => {
    const result = deriveSetupReadiness(summaries({}, { ollamaUrl: 'https://remote.example', allowRemoteHost: true }), { reachable: true, models: ['qwen2.5-coder:7b'] });
    assert.equal(result.backend.state, 'ready');
    assert.equal(result.model.state, 'unavailable');
  });

  it('reports cloud configuration without claiming generation or provider access', () => {
    const result = deriveSetupReadiness(summaries({}, { via: 'cloud', cloudModelId: 'provider/model' }));
    assert.equal(result.basic.state, 'ready');
    assert.equal(result.backend.state, 'unchecked');
    assert.equal(result.model.state, 'unchecked');
    assert.equal(result.automatic.state, 'unchecked');
    assert.match(result.backend.detail, /configur/i);
    assert.match(result.automatic.detail, /not (checked|verified|tested)|unchecked/i);
  });

  it('retains the exact existing model tag matching contract', () => {
    assert.equal(hasOllamaModel(['qwen:3b'], 'qwen:3b'), true);
    assert.equal(hasOllamaModel(['qwen:7b'], 'qwen:3b'), false);
    assert.equal(hasOllamaModel(['qwen:7b'], 'qwen'), true);
    assert.equal(hasOllamaModel(['qwen-other:7b'], 'qwen'), false);
    assert.equal(hasOllamaModel(['qwen'], 'qwen'), true);
    assert.equal(hasOllamaModel([], 'qwen'), false);
  });
});

describe('setup metadata checks', () => {
  it('only fetches installed-model metadata without sending content or generating', async () => {
    const server = await fixture();
    const result = await checkSetupReadiness(summaries({}, { ollamaUrl: server.url }));
    assert.equal(result.model.state, 'ready');
    assert.deepEqual(server.requests, [{ method: 'GET', url: '/api/tags', body: '' }]);
  });

  it('detects a reachable backend with a missing configured model', async () => {
    const server = await fixture(['qwen2.5-coder:7b']);
    const result = await checkSetupReadiness(summaries({}, { ollamaUrl: server.url }));
    assert.equal(result.backend.state, 'ready');
    assert.equal(result.model.state, 'unavailable');
    assert.equal(result.automatic.state, 'unavailable');
  });

  it('issues no metadata request for disabled, basic, cloud, or blocked configurations', async () => {
    const server = await fixture();
    for (const settings of [
      summaries({ enabled: false }, { ollamaUrl: server.url }),
      config({ summarize: { ...DEFAULT_CONFIG.summarize, ollamaUrl: server.url } }),
      summaries({}, { via: 'cloud', ollamaUrl: server.url }),
      summaries({}, { ollamaUrl: server.remoteUrl }),
    ]) await checkSetupReadiness(settings);
    assert.deepEqual(server.requests, []);
  });

  it('refuses malformed and non-HTTP URLs before invoking the probe', async () => {
    for (const ollamaUrl of ['not a url', 'file:///tmp/model', 'ftp://localhost/model']) {
      const result = await checkSetupReadiness(summaries({}, { ollamaUrl }), async () => { assert.fail('invalid URLs must not be probed'); });
      assert.equal(result.backend.state, 'blocked');
    }
  });

  it('refuses unconsented remote hosts before invoking the probe', async () => {
    const result = await checkSetupReadiness(summaries({}, { ollamaUrl: 'https://remote.example' }), async () => {
      assert.fail('an unconsented remote host must not be probed');
    });
    assert.equal(result.backend.state, 'blocked');
  });

  it('isolates a probe exception and timeout from basic compression', async () => {
    const result = await checkSetupReadiness(summaries(), async () => { throw new Error('timeout after 200 ms'); });
    assert.equal(result.basic.state, 'ready');
    assert.equal(result.backend.state, 'unavailable');
    assert.equal(result.model.state, 'unchecked');
  });

  it('treats HTTP failure as unavailable without running generation', async () => {
    const server = createServer((_req, res) => { res.writeHead(503); res.end('unavailable'); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    const result = await checkSetupReadiness(summaries({}, { ollamaUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
    assert.equal(result.backend.state, 'unavailable');
  });

  it('isolates a real stalled metadata body with the existing timeout', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"models":');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    const result = await checkSetupReadiness(summaries({}, { ollamaUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` }), (url) => ollamaStatus(url, 100));
    assert.equal(result.backend.state, 'unavailable');
    assert.equal(result.basic.state, 'ready');
  });
});

describe('setup dismissal persistence', () => {
  it('fails open for missing, corrupt, invalid-version and oversized state', () => {
    const file = join(directory(), 'setup.json');
    assert.deepEqual(loadSetupState(file), { version: 1, dismissed: false });
    for (const text of ['broken json', '{"version":2,"dismissed":true}', '{"version":1,"dismissed":"true"}', ' '.repeat(4096) + '{"version":1,"dismissed":true}']) {
      writeFileSync(file, text);
      assert.deepEqual(loadSetupState(file), { version: 1, dismissed: false });
    }
  });

  it('survives a new read, creates its directory, and leaves config untouched', () => {
    const dir = directory();
    const configFile = join(dir, 'config.json');
    const file = join(dir, 'nested', 'setup.json');
    writeFileSync(configFile, '{"enabled":false,"mode":"custom"}');
    assert.deepEqual(dismissSetup(file), { version: 1, dismissed: true });
    assert.deepEqual(loadSetupState(file), { version: 1, dismissed: true });
    assert.equal(readFileSync(configFile, 'utf8'), '{"enabled":false,"mode":"custom"}');
    assert.deepEqual(readdirSync(join(dir, 'nested')), ['setup.json']);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it('reloads changed state from disk instead of remembering the previous task', () => {
    const file = join(directory(), 'setup.json');
    dismissSetup(file);
    assert.equal(loadSetupState(file).dismissed, true);
    writeFileSync(file, '{"version":1,"dismissed":false}');
    assert.equal(loadSetupState(file).dismissed, false);
  });

  it('derives the default path from BROKE_DATA_DIR at call time', () => {
    const previous = process.env.BROKE_DATA_DIR;
    const dir = directory();
    try {
      process.env.BROKE_DATA_DIR = dir;
      dismissSetup();
      assert.deepEqual(loadSetupState(), { version: 1, dismissed: true });
      assert.equal(existsSync(join(dir, 'setup.json')), true);
    } finally {
      if (previous === undefined) delete process.env.BROKE_DATA_DIR;
      else process.env.BROKE_DATA_DIR = previous;
    }
  });

  it('reports write failure without marking dismissal or leaving temporary files', () => {
    const dir = directory();
    const target = join(dir, 'setup.json');
    mkdirSync(target);
    assert.throws(() => dismissSetup(target));
    assert.deepEqual(loadSetupState(target), { version: 1, dismissed: false });
    assert.deepEqual(readdirSync(dir), ['setup.json']);
  });
});
