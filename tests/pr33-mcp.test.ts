import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  handleMcpMessage,
  negotiateMcpProtocolVersion,
  SUPPORTED_MCP_VERSIONS,
  type JsonRpcRequest,
  type McpSessionState,
} from '../mcp';

function makeMcpSession(root: string): McpSessionState {
  return {
    root,
    agentId: 'mcp',
    protocolVersion: '2024-11-05',
  };
}

describe('PR #33 Package G: Honest MCP Version Negotiation (Finding 15)', () => {
  it('exports SUPPORTED_MCP_VERSIONS and negotiateMcpProtocolVersion', () => {
    assert.ok(Array.isArray(SUPPORTED_MCP_VERSIONS), 'SUPPORTED_MCP_VERSIONS must be an array');
    assert.deepEqual(SUPPORTED_MCP_VERSIONS, ['2024-11-05']);
    assert.equal(typeof negotiateMcpProtocolVersion, 'function', 'negotiateMcpProtocolVersion must be a function');
  });

  it('negotiates 2024-11-05 when requested', async () => {
    const session = makeMcpSession(tmpdir());
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code' } },
    };

    const res = await handleMcpMessage(req, session);
    assert.ok(res);
    assert.equal(res.id, 1);
    const result = res.result as { protocolVersion: string };
    assert.equal(result.protocolVersion, '2024-11-05');
    assert.equal(session.protocolVersion, '2024-11-05');
  });

  it('negotiates down to 2024-11-05 for synthetic unknown version 1900-01-01 (Finding 15)', async () => {
    const session = makeMcpSession(tmpdir());
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '1900-01-01', clientInfo: { name: 'synthetic-test' } },
    };

    const res = await handleMcpMessage(req, session);
    assert.ok(res);
    assert.equal(res.id, 2);
    const result = res.result as { protocolVersion: string };
    assert.equal(result.protocolVersion, '2024-11-05', 'must negotiate down to 2024-11-05, not echo 1900-01-01');
    assert.equal(session.protocolVersion, '2024-11-05');
  });

  it('negotiates down to 2024-11-05 for unimplemented future version 2025-03-26 (Finding 15)', async () => {
    const session = makeMcpSession(tmpdir());
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'future-client' } },
    };

    const res = await handleMcpMessage(req, session);
    assert.ok(res);
    assert.equal(res.id, 3);
    const result = res.result as { protocolVersion: string };
    assert.equal(result.protocolVersion, '2024-11-05', 'must negotiate down to 2024-11-05, not advertise unimplemented 2025-03-26');
    assert.equal(session.protocolVersion, '2024-11-05');
  });

  it('rejects batch requests honestly with a single -32600 error with id: null (Finding 15)', async () => {
    const session = makeMcpSession(tmpdir());
    const batchReq = [
      { jsonrpc: '2.0', id: 10, method: 'ping' },
      { jsonrpc: '2.0', id: 11, method: 'ping' },
    ];

    const res = await handleMcpMessage(batchReq, session);
    assert.ok(res, 'must return a JSON-RPC error response');
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, null, 'batch rejection error id must be null per JSON-RPC 2.0 / MCP');
    assert.ok(res.error, 'response must carry error object');
    assert.equal(res.error.code, -32600, 'error code must be -32600 (Invalid Request)');
  });

  it('stdio transport initializes, lists all 6 tools, and executes a tool call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-pr33-mcp-stdio-'));
    try {
      writeFileSync(join(dir, 'sample.ts'), 'export const a = 1;\n', 'utf-8');

      const runnerScript = join(__dirname, '..', 'scripts', 'broke-runner.cjs');
      const proc = spawn(process.execPath, [runnerScript, 'mcp', '--root', dir], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdoutAccum = '';
      proc.stdout.setEncoding('utf-8');
      proc.stdout.on('data', (chunk) => {
        stdoutAccum += chunk;
      });

      const sendLine = (obj: unknown) => {
        proc.stdin.write(`${JSON.stringify(obj)}\n`);
      };

      const waitForResponse = async (predicate: (lines: string[]) => boolean, timeoutMs = 5000): Promise<string[]> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const lines = stdoutAccum.split('\n').filter((l) => l.trim().length > 0);
          if (predicate(lines)) {
            return lines;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error(`Timeout waiting for response; got output:\n${stdoutAccum}`);
      };

      // 1. Initialize
      sendLine({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      });

      const initLines = await waitForResponse((lines) => lines.some((l) => l.includes('"id":1')));
      const initResp = JSON.parse(initLines.find((l) => l.includes('"id":1'))!);
      assert.equal(initResp.result?.protocolVersion, '2024-11-05');

      // 2. tools/list
      sendLine({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      const listLines = await waitForResponse((lines) => lines.some((l) => l.includes('"id":2')));
      const listResp = JSON.parse(listLines.find((l) => l.includes('"id":2'))!);
      const tools = listResp.result?.tools as Array<{ name: string }>;
      assert.ok(Array.isArray(tools));
      assert.equal(tools.length, 6, 'must expose exactly 6 tools');
      const toolNames = tools.map((t) => t.name).sort();
      assert.deepEqual(toolNames, [
        'broke_check',
        'broke_compress',
        'broke_diff',
        'broke_search',
        'broke_slice',
        'broke_status',
      ]);

      // 3. tools/call broke_status
      sendLine({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'broke_status',
          arguments: { action: 'status' },
        },
      });

      const callLines = await waitForResponse((lines) => lines.some((l) => l.includes('"id":3')));
      const callResp = JSON.parse(callLines.find((l) => l.includes('"id":3'))!);
      assert.equal(callResp.id, 3);
      assert.ok(callResp.result?.content?.[0]?.text);
      assert.match(callResp.result.content[0].text, /broke/i);

      proc.stdin.end();
      proc.kill();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
