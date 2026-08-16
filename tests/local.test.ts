import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { once } from 'node:events';
import { after, describe, it } from 'node:test';
import { isPlaintextRemoteUrl, ollamaGenerate, ollamaStatus } from '../local';

/**
 * Real HTTP round-trips against a local server: the timeout fix (body read
 * inside the abort window) can only be verified with a server that sends
 * headers and then stalls - a hanging body must fail fast instead of
 * blocking onOptimizeMessages (and with it the whole model call).
 */

const servers: Server[] = [];
const sockets = new Set<Socket>();

async function start(server: Server): Promise<string> {
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address() as { port: number };
  servers.push(server);
  return `http://127.0.0.1:${addr.port}`;
}

after(() => {
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
});

describe('ollamaStatus', () => {
  it('reports reachable with the model list', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:3b' }, { name: 'llama3.2' }] }));
    });
    const url = await start(server);
    const status = await ollamaStatus(url);
    assert.equal(status.reachable, true);
    assert.deepEqual(status.models, ['qwen2.5-coder:3b', 'llama3.2']);
  });

  it('fails fast when the server stalls after sending headers', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"models":'); // partial body, then silence forever
    });
    const url = await start(server);
    const startAt = Date.now();
    const status = await ollamaStatus(url, 200);
    assert.equal(status.reachable, false);
    assert.ok(status.error && status.error.includes('timeout'), String(status.error));
    assert.ok(Date.now() - startAt < 5000, 'a stalled body must fail fast, not hang');
  });

  it('treats HTTP errors as unreachable', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    const url = await start(server);
    const status = await ollamaStatus(url);
    assert.equal(status.reachable, false);
    assert.ok(status.error && status.error.includes('HTTP 500'), String(status.error));
  });
});

describe('ollamaGenerate', () => {
  it('posts to /api/generate and returns the text', async () => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(raw) as { model: string; prompt: string; stream: boolean };
        assert.equal(req.url, '/api/generate');
        assert.equal(parsed.model, 'qwen2.5-coder:3b');
        assert.equal(parsed.prompt, 'compress this');
        assert.equal(parsed.stream, false);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ response: 'summary text', total_duration: 2500000000 }));
      });
    });
    const url = await start(server);
    const r = await ollamaGenerate(url, 'qwen2.5-coder:3b', 'compress this', 800);
    assert.equal(r.ok, true);
    assert.equal(r.text, 'summary text');
    assert.equal(r.durationMs, 2500);
  });

  it('fails fast when the generation body stalls', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"response":"partial');
    });
    const url = await start(server);
    const startAt = Date.now();
    const r = await ollamaGenerate(url, 'm', 'p', 800, 200);
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.includes('timeout'), String(r.error));
    assert.ok(Date.now() - startAt < 5000, 'a stalled generation must fail fast, not hang');
  });

  it('maps HTTP errors with the established message shape', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'model not found' }));
    });
    const url = await start(server);
    const r = await ollamaGenerate(url, 'missing-model', 'p');
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.startsWith('Ollama HTTP 404'), String(r.error));
  });

  it('surfaces ollama body errors', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'model requires more memory' }));
    });
    const url = await start(server);
    const r = await ollamaGenerate(url, 'big-model', 'p');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'model requires more memory');
  });
});

describe('isPlaintextRemoteUrl', () => {
  it('flags plaintext remote hosts only', () => {
    assert.equal(isPlaintextRemoteUrl('http://192.168.1.10:11434'), true);
    assert.equal(isPlaintextRemoteUrl('https://example.com'), false);
    assert.equal(isPlaintextRemoteUrl('http://localhost:11434'), false);
    assert.equal(isPlaintextRemoteUrl('http://127.0.0.1:11434'), false);
  });
});
