/**
 * Zero-dependency MCP (Model Context Protocol) server over stdio.
 *
 * Exposes broke's context-saving capabilities (search, slice, diff, compress,
 * check, status) and brevity/workflow prompts to Claude Code, Antigravity,
 * Codex CLI, Cursor, and any MCP-compatible host without pulling in heavy
 * external SDK dependencies (zod-only).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ALLOWED_RUNNERS,
  normalizeAgentId,
  runAgentCheck,
  runAgentCompress,
  runAgentDiff,
  runAgentSearch,
  runAgentSlice,
  runAgentStatus,
  type AgentCheckDeps,
} from './agent-core';
import { buildBrevityDirective } from './brevity';
import { getConfig } from './config';

function loadVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8')) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export const SUPPORTED_MCP_VERSIONS = ['2024-11-05'] as const;
export type SupportedMcpVersion = (typeof SUPPORTED_MCP_VERSIONS)[number];
export const DEFAULT_MCP_VERSION: SupportedMcpVersion = '2024-11-05';

export function negotiateMcpProtocolVersion(requested?: string | null): SupportedMcpVersion {
  if (typeof requested === 'string' && (SUPPORTED_MCP_VERSIONS as readonly string[]).includes(requested)) {
    return requested as SupportedMcpVersion;
  }
  return DEFAULT_MCP_VERSION;
}

export interface McpSessionState {
  root: string;
  agentId: string;
  protocolVersion: string;
}

const SearchArgsSchema = z.object({
  query: z.string().min(1),
  k: z.number().int().min(1).max(50).optional(),
  files: z.array(z.string()).optional(),
});

const SliceArgsSchema = z.object({
  path: z.string().min(1),
  symbol: z.string().min(1).optional(),
  maxChars: z.number().int().min(500).max(100_000).optional(),
});

const DiffArgsSchema = z.object({
  budgetChars: z.number().int().min(200).max(100_000).optional(),
});

const CompressArgsSchema = z
  .object({
    text: z.string().optional(),
    filePath: z.string().optional(),
    summarize: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.text || v.filePath), {
    message: 'either "text" or "filePath" must be provided',
  });

const CheckArgsSchema = z.object({
  runner: z.enum(ALLOWED_RUNNERS),
  args: z.array(z.string()).max(16).optional(),
  summarize: z.boolean().optional(),
});

const StatusArgsSchema = z.object({
  action: z.enum(['status', 'rebuild-index', 'measure']).optional(),
});

export const MCP_TOOLS = [
  {
    name: 'broke_search',
    description:
      'Search the local project using broke BM25 keyword index and return token-budgeted path:line snippets instead of full-file dumps.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Identifier or keyword query (e.g. "compressMessages errorPass")' },
        k: { type: 'number', description: 'Optional max results (1-50)' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of relative file paths to restrict search to',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'broke_slice',
    description:
      'Return a compact TypeScript/JavaScript/Python interface view (signatures, types, exports; bodies elided) of a large source file. Pass `symbol` to keep one specific function/class body in full.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative or workspace-confined path to the source file' },
        symbol: {
          type: 'string',
          description: 'Optional function, class, or method name whose full body should be preserved',
        },
        maxChars: { type: 'number', description: 'Optional character cap for the returned view' },
      },
      required: ['path'],
    },
  },
  {
    name: 'broke_diff',
    description:
      'Return a token-budgeted digest of uncommitted git changes (staged, unstaged, and untracked files) without flooding the context window.',
    inputSchema: {
      type: 'object',
      properties: {
        budgetChars: {
          type: 'number',
          description: 'Character budget for the diff digest (default 4000, range 200..100000)',
        },
      },
    },
  },
  {
    name: 'broke_compress',
    description:
      'Compress compiler/test/command output or an archived log file down to its diagnostic essence (error summary + head/tail truncation + optional local Ollama summary).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Raw command/test/compiler output text to compress' },
        filePath: {
          type: 'string',
          description: 'Workspace file path or archived errors/<task>/<call>.log path to compress',
        },
        summarize: {
          type: 'boolean',
          description: 'When true, also run local Ollama summarization if reachable and configured',
        },
      },
    },
  },
  {
    name: 'broke_check',
    description:
      'Run an allowlisted compiler or test runner (tsc, pytest, vitest, jest, npm-test, npm-typecheck, npm-check-docs, npm-check-files, cargo-check, go-test) and return its pre-compressed diagnostic essence.',
    inputSchema: {
      type: 'object',
      properties: {
        runner: {
          type: 'string',
          enum: [...ALLOWED_RUNNERS],
          description: 'Allowlisted diagnostic runner to execute in the project root',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional safe arguments (for runners that support filtering, e.g. pytest/vitest/tsc)',
        },
        summarize: {
          type: 'boolean',
          description: 'Optional: summarize oversized output via local Ollama',
        },
      },
      required: ['runner'],
    },
  },
  {
    name: 'broke_status',
    description:
      'Inspect broke configuration, Ollama readiness, index status, and honest savings breakdown (measured vs. modeled counterfactuals) across coding agents, or rebuild the project index.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'rebuild-index', 'measure'],
          description: 'status (default), rebuild-index, or measure (aggregate measurement ledger)',
        },
      },
    },
  },
] as const;

export const MCP_PROMPTS = [
  {
    name: 'broke-workflow',
    description: 'Token-saving workflow instructions for coding agents using broke tools',
    arguments: [
      {
        name: 'brevity',
        description: 'Optional output brevity level: off | lite | full | ultra',
        required: false,
      },
    ],
  },
] as const;

export function buildWorkflowPromptText(brevityOverride?: 'off' | 'lite' | 'full' | 'ultra'): string {
  const cfg = getConfig();
  const level = brevityOverride ?? cfg.brevity.level;
  const brevityBlock = buildBrevityDirective(level);
  return [
    '# broke Context-Budget Workflow',
    '- **Search first (`broke_search`):** Locate symbols and call sites with BM25 budgeted snippets before reading whole files.',
    '- **Slice large files (`broke_slice`):** For `.ts/.tsx/.js/.jsx/.py` files over ~200 lines, call `broke_slice(path)` to inspect the module contract, or `broke_slice(path, symbol)` to read one function/class body in full.',
    '- **Budgeted diffs (`broke_diff`):** Prefer `broke_diff` over raw `git diff` to review uncommitted work within a strict character budget.',
    '- **Compact diagnostics (`broke_check` / `broke_compress`):** Run tests/typechecks with `broke_check` or pass verbose logs through `broke_compress` so only the diagnostic essence enters context.',
    ...(brevityBlock ? ['', brevityBlock] : []),
  ].join('\n');
}

export async function handleMcpMessage(
  msg: JsonRpcRequest | unknown,
  session: McpSessionState,
  deps: AgentCheckDeps = {},
): Promise<JsonRpcResponse | null> {
  if (Array.isArray(msg)) {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request: batch requests are not supported' },
    };
  }

  if (!msg || typeof msg !== 'object' || (msg as JsonRpcRequest).jsonrpc !== '2.0' || typeof (msg as JsonRpcRequest).method !== 'string') {
    return {
      jsonrpc: '2.0',
      id: (msg as { id?: string | number | null })?.id ?? null,
      error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
    };
  }

  const req = msg as JsonRpcRequest;

  // Notifications have no `id` and expect no response.
  if (req.id === undefined) {
    return null;
  }

  const reply = (result: unknown): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id: req.id ?? null,
    result,
  });

  const fail = (code: number, message: string, data?: unknown): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id: req.id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });

  try {
    switch (req.method) {
      case 'initialize': {
        const params = (req.params ?? {}) as {
          protocolVersion?: string;
          clientInfo?: { name?: string };
          initializationOptions?: { root?: string };
        };
        session.protocolVersion = negotiateMcpProtocolVersion(params.protocolVersion);
        if (params.clientInfo?.name && session.agentId === 'mcp') {
          session.agentId = normalizeAgentId(params.clientInfo.name);
        }
        return reply({
          protocolVersion: session.protocolVersion,
          capabilities: {
            tools: {},
            prompts: {},
          },
          serverInfo: {
            name: 'broke',
            version: loadVersion(),
          },
        });
      }

      case 'ping':
        return reply({});

      case 'tools/list':
        return reply({ tools: MCP_TOOLS });

      case 'prompts/list':
        return reply({ prompts: MCP_PROMPTS });

      case 'prompts/get': {
        const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, string> };
        if (params.name !== 'broke-workflow') {
          return fail(-32602, `Unknown prompt: ${String(params.name)}`);
        }
        const rawBrevity = params.arguments?.brevity;
        const brevity =
          rawBrevity === 'off' || rawBrevity === 'lite' || rawBrevity === 'full' || rawBrevity === 'ultra'
            ? rawBrevity
            : undefined;
        return reply({
          description: 'Token-saving workflow instructions for coding agents using broke tools',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: buildWorkflowPromptText(brevity),
              },
            },
          ],
        });
      }

      case 'tools/call': {
        const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
        const toolName = params.name;
        const rawArgs = params.arguments ?? {};
        const config = getConfig();

        const toolText = (text: string, isError = false) =>
          reply({
            content: [{ type: 'text', text }],
            ...(isError ? { isError: true } : {}),
          });

        switch (toolName) {
          case 'broke_search': {
            const parsed = SearchArgsSchema.safeParse(rawArgs);
            if (!parsed.success) return toolText(`broke_search validation error: ${parsed.error.message}`, true);
            const res = runAgentSearch(session.root, parsed.data, session.agentId, config, deps.telemetryPaths);
            return toolText(res.text);
          }

          case 'broke_slice': {
            const parsed = SliceArgsSchema.safeParse(rawArgs);
            if (!parsed.success) return toolText(`broke_slice validation error: ${parsed.error.message}`, true);
            const res = runAgentSlice(session.root, parsed.data, session.agentId, config, deps.telemetryPaths);
            return toolText(res.text, !res.ok);
          }

          case 'broke_diff': {
            const parsed = DiffArgsSchema.safeParse(rawArgs);
            if (!parsed.success) return toolText(`broke_diff validation error: ${parsed.error.message}`, true);
            const res = runAgentDiff(session.root, parsed.data);
            return toolText(res.text, !res.ok);
          }

          case 'broke_compress': {
            const parsed = CompressArgsSchema.safeParse(rawArgs);
            if (!parsed.success) return toolText(`broke_compress validation error: ${parsed.error.message}`, true);
            const res = await runAgentCompress(session.root, parsed.data, session.agentId, config, deps);
            return toolText(res.text, !res.ok);
          }

          case 'broke_check': {
            const parsed = CheckArgsSchema.safeParse(rawArgs);
            if (!parsed.success) return toolText(`broke_check validation error: ${parsed.error.message}`, true);
            const res = await runAgentCheck(session.root, parsed.data, session.agentId, config, deps);
            return toolText(res.text, !res.ok && res.exitCode !== 0);
          }

          case 'broke_status': {
            const parsed = StatusArgsSchema.safeParse(rawArgs);
            if (!parsed.success) return toolText(`broke_status validation error: ${parsed.error.message}`, true);
            const text = await runAgentStatus(session.root, parsed.data, session.agentId, config, deps.telemetryPaths);
            return toolText(text);
          }

          default:
            return fail(-32601, `Unknown tool: ${String(toolName)}`);
        }
      }

      default:
        return fail(-32601, `Method not found: ${req.method}`);
    }
  } catch (err) {
    return fail(-32603, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Start the stdio JSON-RPC loop. Supports both newline-delimited JSON-RPC
 * (MCP 2024-11-05 / 2025-03-26 stdio transport) and Content-Length framed
 * messages, writing matching responses to stdout.
 */
export function startMcpStdioServer(options: { root?: string; agentId?: string } = {}): void {
  const session: McpSessionState = {
    root: options.root || process.env.BROKE_PROJECT_DIR || process.cwd(),
    agentId: normalizeAgentId(options.agentId || process.env.BROKE_AGENT_ID || 'mcp'),
    protocolVersion: '2024-11-05',
  };

  let buffer = Buffer.alloc(0);
  let useContentLengthFraming = false;

  const send = (res: JsonRpcResponse): void => {
    const json = JSON.stringify(res);
    if (useContentLengthFraming) {
      const byteLen = Buffer.byteLength(json, 'utf-8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  };

  const dispatchLine = (rawLine: string): void => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }
    void handleMcpMessage(parsed, session).then((res) => {
      if (res) send(res);
    });
  };

  const drainBuffer = (): void => {
    for (;;) {
      if (buffer.length === 0) return;
      const head = buffer.subarray(0, Math.min(buffer.length, 32)).toString('utf-8');
      if (head.startsWith('Content-Length:')) {
        useContentLengthFraming = true;
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headerStr = buffer.subarray(0, headerEnd).toString('utf-8');
        const match = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const contentLength = Number.parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + contentLength) return;
        const bodyStr = buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf-8');
        buffer = buffer.subarray(bodyStart + contentLength);
        dispatchLine(bodyStr);
        continue;
      }

      const nlIndex = buffer.indexOf(0x0a); // '\n'
      if (nlIndex === -1) return;
      const lineStr = buffer.subarray(0, nlIndex).toString('utf-8');
      buffer = buffer.subarray(nlIndex + 1);
      dispatchLine(lineStr);
    }
  };

  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    drainBuffer();
  });
}
