/**
 * Multi-Agent CLI, Claude Code Hook Handler, and Agent Installer (S5 / S6).
 *
 * Entry point invoked by `scripts/broke-runner.cjs`:
 *   broke mcp [--root <dir>] [--agent <id>]
 *   broke hook claude
 *   broke install-agent <claude|antigravity|codex|cursor> [--project <dir>] [--dry-run]
 *   broke search <query> [--k <n>]
 *   broke slice <path> [symbol]
 *   broke diff [budgetChars]
 *   broke compress [--file <path>] [--summarize]
 *   broke check <runner> [args...]
 *   broke status [status|rebuild-index|measure]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ALLOWED_RUNNERS,
  agentTaskId,
  normalizeAgentId,
  runAgentCheck,
  runAgentCompress,
  runAgentDiff,
  runAgentSearch,
  runAgentSlice,
  runAgentStatus,
  type AgentCheckDeps,
  type AllowedRunner,
} from './agent-core';
import {
  executeAgentInstall,
  planAgentInstall,
  SUPPORTED_INSTALL_AGENTS,
  updateCodexToml,
  type InstallAgentFsOps,
  type InstallAgentOptions,
  type PlannedFileWrite,
  type SupportedInstallAgent,
} from './agent-install';
import { getConfig, type Config } from './config';
import { extractErrorSummary, isCommandTool } from './errors';
import { startMcpStdioServer } from './mcp';
import { runtimeDir } from './paths';
import { extractTargetPath, isEditTool, isReadTool, sameSlicePath } from './slice';

// ---------------------------------------------------------------------------
// Persistent cross-invocation focus state for stateless hook processes
// ---------------------------------------------------------------------------

interface FocusStore {
  version: 1;
  entries: Record<string, { file: string; at: number }>;
}

const FOCUS_TTL_MS = 30 * 60 * 1000;

export function defaultFocusStorePath(): string {
  return join(runtimeDir(), 'agent-focus.json');
}

export function readAgentFocus(sessionKey: string, storePath = defaultFocusStorePath()): string | undefined {
  try {
    if (!existsSync(storePath)) return undefined;
    const parsed = JSON.parse(readFileSync(storePath, 'utf-8')) as FocusStore;
    const entry = parsed?.entries?.[sessionKey];
    if (!entry || typeof entry.file !== 'string' || typeof entry.at !== 'number') return undefined;
    if (Date.now() - entry.at > FOCUS_TTL_MS) return undefined;
    return entry.file;
  } catch {
    return undefined;
  }
}

export function writeAgentFocus(sessionKey: string, file: string, storePath = defaultFocusStorePath()): void {
  try {
    let store: FocusStore = { version: 1, entries: {} };
    if (existsSync(storePath)) {
      try {
        const parsed = JSON.parse(readFileSync(storePath, 'utf-8')) as FocusStore;
        if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
          store = parsed;
        }
      } catch {
        // reset corrupted store
      }
    }
    const now = Date.now();
    // Prune expired entries and cap at 50 sessions.
    const keys = Object.keys(store.entries);
    for (const k of keys) {
      if (now - (store.entries[k]?.at ?? 0) > FOCUS_TTL_MS) {
        delete store.entries[k];
      }
    }
    while (Object.keys(store.entries).length >= 50) {
      const oldestKey = Object.keys(store.entries)[0];
      if (!oldestKey) break;
      delete store.entries[oldestKey];
    }
    store.entries[sessionKey] = { file, at: now };
    mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
    writeFileSync(storePath, `${JSON.stringify(store)}\n`, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // best effort - focus persistence must never break a hook
  }
}

// ---------------------------------------------------------------------------
// Claude Code Hook Handler (`PreToolUse` / `PostToolUse`)
// ---------------------------------------------------------------------------

export interface ClaudeHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  error?: string;
  is_interrupt?: boolean;
}

export interface ClaudeHookOptions {
  root?: string;
  config?: Config;
  focusStorePath?: string;
  deps?: AgentCheckDeps;
}

function extractHookResponseText(resp: unknown): string {
  if (typeof resp === 'string') return resp;
  if (!resp || typeof resp !== 'object') return '';
  const obj = resp as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof obj.stdout === 'string' && obj.stdout) parts.push(obj.stdout);
  if (typeof obj.stderr === 'string' && obj.stderr) parts.push(obj.stderr);
  if (typeof obj.output === 'string' && obj.output) parts.push(obj.output);
  if (typeof obj.content === 'string' && obj.content) parts.push(obj.content);
  return parts.join('\n');
}

export async function handleClaudeHookPayload(
  payload: unknown,
  opts: ClaudeHookOptions = {},
): Promise<{ exitCode: number; stdout?: string }> {
  if (!payload || typeof payload !== 'object') {
    return { exitCode: 0 };
  }
  const ev = payload as ClaudeHookPayload;
  const config = opts.config ?? getConfig();
  if (!config.enabled || config.autonomy === 'manual') {
    return { exitCode: 0 };
  }

  const root = opts.root ?? (typeof ev.cwd === 'string' && ev.cwd ? ev.cwd : process.cwd());
  const sessionKey =
    typeof ev.session_id === 'string' && ev.session_id
      ? `claude:${ev.session_id}`
      : agentTaskId('claude', root);
  const toolName = typeof ev.tool_name === 'string' ? ev.tool_name : '';
  const toolInput = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
  const focusStorePath = opts.focusStorePath ?? defaultFocusStorePath();

  if (ev.is_interrupt === true) {
    return { exitCode: 0 };
  }

  if (ev.hook_event_name === 'PreToolUse') {
    if (config.slice.enabled && config.slice.focusAuto && isEditTool(toolName, toolInput)) {
      const target = extractTargetPath(toolInput);
      if (target) {
        writeAgentFocus(sessionKey, target, focusStorePath);
      }
      return { exitCode: 0 };
    }

    if (config.slice.enabled && isReadTool(toolName, toolInput)) {
      // Never intercept ranged reads (when the agent explicitly passed offset or limit).
      if (typeof toolInput.offset === 'number' || typeof toolInput.limit === 'number') {
        return { exitCode: 0 };
      }
      const target = extractTargetPath(toolInput);
      if (!target) return { exitCode: 0 };

      const focusFile = readAgentFocus(sessionKey, focusStorePath);
      if (focusFile && sameSlicePath(focusFile, target, root)) {
        return { exitCode: 0 };
      }

      const sliceRes = runAgentSlice(
        root,
        { path: target, focusFile },
        'claude',
        config,
        opts.deps?.telemetryPaths,
      );
      if (sliceRes.ok && sliceRes.sliced && sliceRes.savedChars > 0) {
        const responseJson = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              `[broke ST-Slicing: "${target}" (${sliceRes.originalChars.toLocaleString('en-US')} chars) was reduced to its interface view (${sliceRes.keptChars.toLocaleString('en-US')} chars). ` +
              `To inspect a specific function or class body, call mcp__broke__broke_slice(path, symbol) or call Read with explicit offset and limit.]\n\n` +
              sliceRes.text,
          },
        };
        return { exitCode: 0, stdout: JSON.stringify(responseJson) };
      }
    }
    return { exitCode: 0 };
  }

  if (ev.hook_event_name === 'PostToolUse') {
    if (config.errors.enabled && isCommandTool(toolName)) {
      if (typeof ev.tool_response !== 'object' && typeof ev.tool_response !== 'string') {
        return { exitCode: 0 };
      }
      if (typeof ev.tool_response === 'object' && ev.tool_response !== null) {
        const respObj = ev.tool_response as Record<string, unknown>;
        if (respObj.interrupted === true || respObj.isImage === true) {
          return { exitCode: 0 };
        }
      }

      const rawText = extractHookResponseText(ev.tool_response);
      if (rawText.length >= config.errors.minChars) {
        const matchCheck = extractErrorSummary(rawText, { contextLines: config.errors.contextLines });
        if (matchCheck.matched) {
          const compressed = await runAgentCompress(
            root,
            { text: rawText, summarize: false, callId: `hook-${Date.now()}` },
            'claude',
            config,
            { ...opts.deps, recordTelemetry: false },
          );
          if (compressed.ok && compressed.savedChars > 0) {
            let updatedToolOutput: unknown;
            if (typeof ev.tool_response === 'object' && ev.tool_response !== null && !Array.isArray(ev.tool_response)) {
              updatedToolOutput = {
                ...(ev.tool_response as Record<string, unknown>),
                stdout: compressed.text,
                stderr: '',
              };
            } else {
              updatedToolOutput = compressed.text;
            }

            const responseJson = {
              hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                updatedToolOutput,
              },
            };
            return { exitCode: 0, stdout: JSON.stringify(responseJson) };
          }
        }
      }
    }
    return { exitCode: 0 };
  }

  if (ev.hook_event_name === 'PostToolUseFailure') {
    if (config.errors.enabled && isCommandTool(toolName)) {
      const failureText = [
        typeof ev.error === 'string' ? ev.error : '',
        extractHookResponseText(ev.tool_response),
      ]
        .filter(Boolean)
        .join('\n');

      if (failureText.length >= config.errors.minChars) {
        const matchCheck = extractErrorSummary(failureText, { contextLines: config.errors.contextLines });
        if (matchCheck.matched) {
          const compressed = await runAgentCompress(
            root,
            { text: failureText, summarize: false, callId: `hook-fail-${Date.now()}` },
            'claude',
            config,
            { ...opts.deps, recordTelemetry: false },
          );
          if (compressed.ok && compressed.savedChars > 0) {
            const responseJson = {
              hookSpecificOutput: {
                hookEventName: 'PostToolUseFailure',
                additionalContext: `[broke diagnostic essence]\n${compressed.text}`,
              },
            };
            return { exitCode: 0, stdout: JSON.stringify(responseJson) };
          }
        }
      }
    }
    return { exitCode: 0 };
  }

  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Multi-Agent Installer (`broke install-agent <agent>`) — re-exported
// ---------------------------------------------------------------------------

export {
  executeAgentInstall,
  planAgentInstall,
  SUPPORTED_INSTALL_AGENTS,
  updateCodexToml,
  type InstallAgentFsOps,
  type InstallAgentOptions,
  type PlannedFileWrite,
  type SupportedInstallAgent,
};

// ---------------------------------------------------------------------------
// CLI Argument Dispatcher
// ---------------------------------------------------------------------------

function readFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

export function formatCliHelp(): string {
  return [
    'broke multi-agent CLI & MCP bridge',
    '',
    'Usage:',
    '  node scripts/broke-runner.cjs mcp [--root <dir>] [--agent <name>]',
    '  node scripts/broke-runner.cjs hook claude',
    '  node scripts/broke-runner.cjs install-agent <claude|antigravity|codex|cursor> [--project <dir>] [--dry-run]',
    '  node scripts/broke-runner.cjs search <query> [--k <n>] [--root <dir>]',
    '  node scripts/broke-runner.cjs slice <path> [symbol] [--root <dir>]',
    '  node scripts/broke-runner.cjs diff [budgetChars] [--root <dir>]',
    '  node scripts/broke-runner.cjs compress --file <path> [--summarize] [--root <dir>]',
    '  node scripts/broke-runner.cjs check <runner> [args...] [--root <dir>]',
    '  node scripts/broke-runner.cjs status [status|rebuild-index|measure] [--root <dir>]',
  ].join('\n');
}

export async function runCli(
  argv: string[],
  io: {
    cwd?: string;
    stdinText?: string;
    deps?: AgentCheckDeps;
  } = {},
): Promise<{ exitCode: number; output: string }> {
  const cmd = argv[0] ?? 'help';
  const rest = argv.slice(1);
  const flagsSection = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
  const root =
    readFlag(flagsSection, '--root') ??
    (cmd === 'install-agent' ? readFlag(flagsSection, '--project') : undefined) ??
    io.cwd ??
    process.cwd();
  const agentId = normalizeAgentId(readFlag(flagsSection, '--agent') ?? process.env.BROKE_AGENT_ID ?? 'cli');

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    return { exitCode: 0, output: formatCliHelp() };
  }

  if (cmd === 'mcp') {
    startMcpStdioServer({ root, agentId });
    return { exitCode: 0, output: '' };
  }

  if (cmd === 'hook') {
    const hookTarget = rest[0];
    if (hookTarget !== 'claude') {
      return { exitCode: 1, output: `broke hook: unsupported target "${String(hookTarget)}" (expected "claude")` };
    }
    const rawStdin = io.stdinText ?? readFileSync(0, 'utf-8');
    if (!rawStdin.trim()) return { exitCode: 0, output: '' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawStdin);
    } catch {
      return { exitCode: 0, output: '' };
    }
    const res = await handleClaudeHookPayload(parsed, { root, deps: io.deps });
    return { exitCode: res.exitCode, output: res.stdout ?? '' };
  }

  if (cmd === 'install-agent') {
    const agent = rest[0] as SupportedInstallAgent | undefined;
    if (!agent || !SUPPORTED_INSTALL_AGENTS.includes(agent)) {
      return {
        exitCode: 1,
        output: `broke install-agent: specify one of ${SUPPORTED_INSTALL_AGENTS.join(', ')}`,
      };
    }
    const dryRun = rest.includes('--dry-run');
    const res = executeAgentInstall({ agent, targetDir: root, dryRun });
    return { exitCode: res.ok ? 0 : 1, output: res.text };
  }

  if (cmd === 'search') {
    const kRaw = readFlag(rest, '--k');
    const positional = rest.filter(
      (a, i) => !a.startsWith('--') && (i === 0 || !['--root', '--project', '--agent', '--k'].includes(rest[i - 1])),
    );
    const query = positional.join(' ').trim();
    if (!query) return { exitCode: 1, output: 'broke search: query is required' };
    const k = kRaw ? Number.parseInt(kRaw, 10) : undefined;
    const res = runAgentSearch(root, { query, ...(k && Number.isFinite(k) ? { k } : {}) }, agentId, getConfig(), io.deps?.telemetryPaths);
    return { exitCode: 0, output: res.text };
  }

  if (cmd === 'slice') {
    const positional = rest.filter(
      (a, i) => !a.startsWith('--') && (i === 0 || !['--root', '--project', '--agent'].includes(rest[i - 1])),
    );
    const filePath = positional[0];
    const symbol = positional[1];
    if (!filePath) return { exitCode: 1, output: 'broke slice: path is required' };
    const res = runAgentSlice(root, { path: filePath, ...(symbol ? { symbol } : {}) }, agentId, getConfig(), io.deps?.telemetryPaths);
    return { exitCode: res.ok ? 0 : 1, output: res.text };
  }

  if (cmd === 'diff') {
    const positional = rest.filter(
      (a, i) => !a.startsWith('--') && (i === 0 || !['--root', '--project', '--agent'].includes(rest[i - 1])),
    );
    const budget = positional[0] ? Number.parseInt(positional[0], 10) : undefined;
    const res = runAgentDiff(root, { ...(budget && Number.isFinite(budget) ? { budgetChars: budget } : {}) });
    return { exitCode: res.ok ? 0 : 1, output: res.text };
  }

  if (cmd === 'compress') {
    const filePath = readFlag(rest, '--file');
    const summarize = rest.includes('--summarize');
    const text = filePath ? undefined : io.stdinText ?? readFileSync(0, 'utf-8');
    const res = await runAgentCompress(root, { filePath, text, summarize }, agentId, getConfig(), io.deps);
    return { exitCode: res.ok ? 0 : 1, output: res.text };
  }

  if (cmd === 'check') {
    const dashDashIdx = rest.indexOf('--');
    let runner: AllowedRunner | undefined;
    let extra: string[] = [];
    let summarize = false;

    if (dashDashIdx !== -1) {
      const beforeDashDash = rest.slice(0, dashDashIdx);
      const afterDashDash = rest.slice(dashDashIdx + 1);
      runner = beforeDashDash.find(
        (a, i) => !a.startsWith('--') && (i === 0 || !['--root', '--agent'].includes(beforeDashDash[i - 1])),
      ) as AllowedRunner | undefined;
      summarize = beforeDashDash.includes('--summarize');
      extra = afterDashDash;
    } else {
      runner = rest.find(
        (a, i) => !a.startsWith('--') && (i === 0 || !['--root', '--agent'].includes(rest[i - 1])),
      ) as AllowedRunner | undefined;
      summarize = rest.includes('--summarize');
      if (runner) {
        const runnerIdx = rest.indexOf(runner);
        const candidateArgs = [...rest.slice(0, runnerIdx), ...rest.slice(runnerIdx + 1)];
        extra = candidateArgs.filter(
          (a, i, arr) =>
            !['--root', '--agent', '--summarize'].includes(a) &&
            (i === 0 || !['--root', '--agent'].includes(arr[i - 1])),
        );
      }
    }

    if (!runner || !ALLOWED_RUNNERS.includes(runner)) {
      return {
        exitCode: 1,
        output: `broke check: specify one of ${ALLOWED_RUNNERS.join(', ')}`,
      };
    }

    const res = await runAgentCheck(root, { runner, args: extra, summarize }, agentId, getConfig(), io.deps);
    return { exitCode: res.exitCode, output: res.text };
  }

  if (cmd === 'status') {
    const sub = rest[0];
    const action =
      sub === 'rebuild-index' || sub === 'measure' || sub === 'status' ? sub : 'status';
    const text = await runAgentStatus(root, { action }, agentId, getConfig(), io.deps?.telemetryPaths);
    return { exitCode: 0, output: text };
  }

  return { exitCode: 1, output: `broke: unknown command "${cmd}"\n\n${formatCliHelp()}` };
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void runCli(process.argv.slice(2)).then(({ exitCode, output }) => {
    if (output) process.stdout.write(`${output}\n`);
    if (exitCode !== 0) process.exitCode = exitCode;
  });
}
