import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  agentTaskId,
  normalizeAgentId,
  resolveConfinedWorkspaceFile,
  runAgentCheck,
  runAgentCompress,
  runAgentDiff,
  runAgentSearch,
  runAgentSlice,
  runAgentStatus,
  validateRunnerArgs,
} from '../agent-core';
import {
  executeAgentInstall,
  handleClaudeHookPayload,
  readAgentFocus,
  runCli,
} from '../cli';
import { DEFAULT_CONFIG, type Config } from '../config';
import { handleMcpMessage, MCP_TOOLS, type McpSessionState } from '../mcp';
import { loadRunRecords, loadTaskStats } from '../tokens';

function makeTempProject(): {
  dir: string;
  statsPath: string;
  measurePath: string;
  errorsDir: string;
  focusPath: string;
  cleanup: () => void;
} {
  const base = mkdtempSync(join(tmpdir(), 'broke-multi-agent-'));
  const dir = join(base, 'repo');
  const dataDir = join(base, 'data');
  mkdirSync(dir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return {
    dir,
    statsPath: join(dataDir, 'stats.jsonl'),
    measurePath: join(dataDir, 'measure.jsonl'),
    errorsDir: join(dataDir, 'errors'),
    focusPath: join(dataDir, 'focus.json'),
    cleanup: () => {
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
        // ignore Windows cleanup race
      }
    },
  };
}

function buildLargeTsFile(): string {
  const lines: string[] = [
    "import { readFileSync } from 'node:fs';",
    '',
    'export interface ComputeOptions {',
    '  iterations: number;',
    '  label: string;',
    '}',
    '',
  ];
  for (let fnIdx = 1; fnIdx <= 12; fnIdx++) {
    lines.push(`export function computeMetric${fnIdx}(opts: ComputeOptions): number {`);
    for (let bodyIdx = 1; bodyIdx <= 25; bodyIdx++) {
      lines.push(`  const step${bodyIdx} = opts.iterations * ${fnIdx} + ${bodyIdx};`);
    }
    lines.push('  return opts.iterations;');
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

describe('agent-core: workspace confinement, search, slice, diff, compress, check & telemetry', () => {
  it('normalizes agent ids and builds deterministic task ids', () => {
    assert.equal(normalizeAgentId('Claude Code!'), 'claude-code');
    assert.equal(normalizeAgentId(''), 'mcp');
    const id = agentTaskId('Antigravity', '/tmp/example');
    assert.match(id, /^antigravity:[a-f0-9]{16}$/);
  });

  it('enforces strict workspace confinement and blocks sensitive files', () => {
    const tmp = makeTempProject();
    try {
      writeFileSync(join(tmp.dir, 'safe.ts'), 'export const x = 1;\n', 'utf-8');
      writeFileSync(join(tmp.dir, '.env'), 'SECRET=123\n', 'utf-8');
      writeFileSync(join(tmp.dir, 'my_secrets.ts'), 'export const k = 1;\n', 'utf-8');

      const ok = resolveConfinedWorkspaceFile(tmp.dir, 'safe.ts');
      assert.equal(ok.ok, true);
      if (ok.ok) assert.equal(ok.relPath, 'safe.ts');

      const outside = resolveConfinedWorkspaceFile(tmp.dir, '../outside.ts');
      assert.equal(outside.ok, false);

      const envFile = resolveConfinedWorkspaceFile(tmp.dir, '.env');
      assert.equal(envFile.ok, false);

      const secretFile = resolveConfinedWorkspaceFile(tmp.dir, 'my_secrets.ts');
      assert.equal(secretFile.ok, false);
    } finally {
      tmp.cleanup();
    }
  });

  it('runs BM25 search and records search counterfactuals under agent taskId', () => {
    const tmp = makeTempProject();
    try {
      const largeContent = `${buildLargeTsFile()}\nexport function uniqueQuantumTokenizerTarget(): string { return 'ok'; }\n`;
      writeFileSync(join(tmp.dir, 'engine.ts'), largeContent, 'utf-8');

      const res = runAgentSearch(
        tmp.dir,
        { query: 'uniqueQuantumTokenizerTarget', k: 5 },
        'antigravity',
        DEFAULT_CONFIG,
        { statsPath: tmp.statsPath, measurePath: tmp.measurePath },
      );
      assert.match(res.text, /uniqueQuantumTokenizerTarget/);
      assert.ok(res.avoidedChars > 0);

      const taskId = agentTaskId('antigravity', tmp.dir);
      const stats = loadTaskStats(taskId, tmp.statsPath);
      assert.ok(stats);
      assert.equal(stats.estimates?.search, res.avoidedChars);
      assert.equal(stats.savedChars.error, 0);
    } finally {
      tmp.cleanup();
    }
  });

  it('slices large TypeScript files, supports symbol focus, and records slice counterfactuals', () => {
    const tmp = makeTempProject();
    try {
      const largeSource = buildLargeTsFile();
      writeFileSync(join(tmp.dir, 'large.ts'), largeSource, 'utf-8');
      writeFileSync(join(tmp.dir, 'small.ts'), 'export const small = 1;\n', 'utf-8');

      // Small file passes through untouched
      const smallRes = runAgentSlice(tmp.dir, { path: 'small.ts' }, 'claude', DEFAULT_CONFIG, {
        statsPath: tmp.statsPath,
      });
      assert.equal(smallRes.ok, true);
      assert.equal(smallRes.sliced, false);
      assert.equal(smallRes.savedChars, 0);

      // Large file is sliced to interface view
      const slicedRes = runAgentSlice(tmp.dir, { path: 'large.ts' }, 'claude', DEFAULT_CONFIG, {
        statsPath: tmp.statsPath,
      });
      assert.equal(slicedRes.ok, true);
      assert.equal(slicedRes.sliced, true);
      assert.ok(slicedRes.savedChars > 1000);
      assert.match(slicedRes.text, /\[broke: interface view/);
      assert.match(slicedRes.text, /export function computeMetric1\(opts: ComputeOptions\): number \{ \/\* … \*\/ \}/);

      // Symbol focus keeps target function body while eliding others
      const symbolRes = runAgentSlice(
        tmp.dir,
        { path: 'large.ts', symbol: 'computeMetric2' },
        'claude',
        DEFAULT_CONFIG,
        { statsPath: tmp.statsPath },
      );
      assert.equal(symbolRes.ok, true);
      assert.equal(symbolRes.sliced, true);
      assert.match(symbolRes.text, /const step1 = opts\.iterations \* 2 \+ 1;/);
      assert.match(symbolRes.text, /export function computeMetric1\(opts: ComputeOptions\): number \{ \/\* … \*\/ \}/);

      const taskId = agentTaskId('claude', tmp.dir);
      const stats = loadTaskStats(taskId, tmp.statsPath);
      assert.ok(stats);
      assert.equal(stats.savedChars.slice, slicedRes.savedChars + symbolRes.savedChars);
    } finally {
      tmp.cleanup();
    }
  });

  it('produces a token-budgeted git diff digest for modified and untracked files', () => {
    const tmp = makeTempProject();
    try {
      execFileSync('git', ['-c', 'safe.directory=*', 'init'], { cwd: tmp.dir, stdio: 'ignore' });
      execFileSync('git', ['-c', 'safe.directory=*', 'config', 'user.email', 'test@example.com'], { cwd: tmp.dir, stdio: 'ignore' });
      execFileSync('git', ['-c', 'safe.directory=*', 'config', 'user.name', 'Test'], { cwd: tmp.dir, stdio: 'ignore' });
      writeFileSync(join(tmp.dir, 'tracked.ts'), 'export const a = 1;\n', 'utf-8');
      execFileSync('git', ['-c', 'safe.directory=*', 'add', 'tracked.ts'], { cwd: tmp.dir, stdio: 'ignore' });
      execFileSync('git', ['-c', 'safe.directory=*', 'commit', '-m', 'init'], { cwd: tmp.dir, stdio: 'ignore' });

      writeFileSync(join(tmp.dir, 'tracked.ts'), 'export const a = 2;\nexport const b = 3;\n', 'utf-8');
      writeFileSync(join(tmp.dir, 'untracked.ts'), 'export const fresh = true;\n', 'utf-8');

      const diffRes = runAgentDiff(tmp.dir, { budgetChars: 4000 });
      assert.equal(diffRes.ok, true, diffRes.text);
      assert.equal(diffRes.files, 2);
      assert.match(diffRes.text, /tracked\.ts/);
      assert.match(diffRes.text, /untracked\.ts/);
    } finally {
      tmp.cleanup();
    }
  });

  it('compresses compiler/test errors, masks secrets, archives logs, and supports local Ollama summary', async () => {
    const tmp = makeTempProject();
    try {
      const errorLines: string[] = [
        'src/app.ts:42:7 - error TS2322: Type "string" is not assignable to type "number".',
        '42 const count: number = "bad";',
        '         ~~~~~',
      ];
      for (let i = 0; i < 250; i++) {
        errorLines.push(`src/other${i}.ts:10:1 - error TS1005: ";" expected. token=sk-1234567890abcdefghijklmno`);
      }
      const rawLog = errorLines.join('\n');

      const cfg: Config = {
        ...DEFAULT_CONFIG,
        errors: { ...DEFAULT_CONFIG.errors, minChars: 500, archive: true },
      };

      const compRes = await runAgentCompress(
        tmp.dir,
        { text: rawLog, summarize: true, callId: 'test-call-1' },
        'codex',
        cfg,
        {
          errorsDir: tmp.errorsDir,
          telemetryPaths: { statsPath: tmp.statsPath, measurePath: tmp.measurePath },
          generateOllama: async () => ({
            ok: true,
            text: 'Summary: TS2322 at src/app.ts:42:7',
            durationMs: 12,
          }),
        },
      );

      assert.equal(compRes.ok, true);
      assert.ok(compRes.savedChars > 5000);
      assert.ok(compRes.archivedTo);
      assert.doesNotMatch(compRes.text, /sk-1234567890/);
      assert.match(compRes.text, /error TS2322/);

      // Can also compress directly from the archived log path
      const fromArchive = await runAgentCompress(
        tmp.dir,
        { filePath: compRes.archivedTo },
        'codex',
        cfg,
        {
          errorsDir: tmp.errorsDir,
          telemetryPaths: { statsPath: tmp.statsPath, measurePath: tmp.measurePath },
        },
      );
      assert.equal(fromArchive.ok, true);
      assert.match(fromArchive.text, /error TS2322/);

      const taskId = agentTaskId('codex', tmp.dir);
      const stats = loadTaskStats(taskId, tmp.statsPath);
      assert.ok(stats);
      assert.equal(stats.passes, 2);
      assert.ok(stats.savedChars.error > 5000);

      const records = loadRunRecords(tmp.measurePath);
      assert.equal(records.length, 2);
      assert.equal(records[0].taskId, taskId);
    } finally {
      tmp.cleanup();
    }
  });

  it('validates runner arguments and runs allowlisted broke_check runners safely', async () => {
    assert.equal(validateRunnerArgs(['src/index.ts']).ok, true);
    assert.equal(validateRunnerArgs(['foo; rm -rf /']).ok, false);
    assert.equal(validateRunnerArgs(['../outside']).ok, false);
    assert.equal(validateRunnerArgs(['--eval', 'process.exit(1)']).ok, false);

    const tmp = makeTempProject();
    try {
      const rejectedExtra = await runAgentCheck(
        tmp.dir,
        { runner: 'npm-test', args: ['--extra'] },
        'antigravity',
        DEFAULT_CONFIG,
      );
      assert.equal(rejectedExtra.ok, false);
      assert.match(rejectedExtra.text, /does not accept extra arguments/);

      const fakeTscOutput = Array.from(
        { length: 220 },
        (_, i) => `index.ts:${i + 1}:5 - error TS2304: Cannot find name 'x${i}'.`,
      ).join('\n');

      const checkRes = await runAgentCheck(
        tmp.dir,
        { runner: 'tsc', args: ['--pretty', 'false'] },
        'antigravity',
        DEFAULT_CONFIG,
        {
          telemetryPaths: { statsPath: tmp.statsPath, measurePath: tmp.measurePath },
          execRunner: () => ({ exitCode: 2, output: fakeTscOutput }),
        },
      );
      assert.equal(checkRes.exitCode, 2);
      assert.ok(checkRes.savedChars > 2000);
      assert.match(checkRes.text, /\[broke-check: tsc \| exit 2/);
      assert.match(checkRes.text, /error TS2304/);

      const statusText = await runAgentStatus(
        tmp.dir,
        { action: 'status' },
        'antigravity',
        DEFAULT_CONFIG,
        { statsPath: tmp.statsPath, measurePath: tmp.measurePath },
      );
      assert.match(statusText, /broke multi-agent status/);
      assert.match(statusText, /cross-agent ledger totals:/);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('mcp.ts: JSON-RPC 2.0 protocol & stdio runner', () => {
  it('handles initialize, tools/list, prompts/get, and all 6 tools', async () => {
    const tmp = makeTempProject();
    try {
      writeFileSync(join(tmp.dir, 'sample.ts'), buildLargeTsFile(), 'utf-8');
      const session: McpSessionState = {
        root: tmp.dir,
        agentId: 'mcp',
        protocolVersion: '2024-11-05',
      };
      const deps = {
        telemetryPaths: { statsPath: tmp.statsPath, measurePath: tmp.measurePath },
        errorsDir: tmp.errorsDir,
        execRunner: () => ({ exitCode: 0, output: 'All tests passed' }),
      };

      const initRes = await handleMcpMessage(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', clientInfo: { name: 'Claude Code' } },
        },
        session,
        deps,
      );
      assert.ok(initRes?.result);
      assert.equal(session.agentId, 'claude-code');

      // Notification returns null
      const notifRes = await handleMcpMessage(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        session,
        deps,
      );
      assert.equal(notifRes, null);

      const listRes = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session, deps);
      const listed = (listRes?.result as { tools: typeof MCP_TOOLS }).tools;
      assert.equal(listed.length, 6);

      const promptRes = await handleMcpMessage(
        { jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'broke-workflow', arguments: { brevity: 'full' } } },
        session,
        deps,
      );
      assert.match(JSON.stringify(promptRes?.result), /Answer style: terse/);

      const sliceCall = await handleMcpMessage(
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'broke_slice', arguments: { path: 'sample.ts' } },
        },
        session,
        deps,
      );
      assert.match(JSON.stringify(sliceCall?.result), /computeMetric1/);

      const checkCall = await handleMcpMessage(
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'broke_check', arguments: { runner: 'npm-test' } },
        },
        session,
        deps,
      );
      assert.match(JSON.stringify(checkCall?.result), /All tests passed/);
    } finally {
      tmp.cleanup();
    }
  });

  it('runs end-to-end over stdio via scripts/broke-runner.cjs mcp', async () => {
    const runnerPath = join(__dirname, '..', 'scripts', 'broke-runner.cjs');
    const child = spawn(process.execPath, [runnerPath, 'mcp', '--agent', 'antigravity'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    });

    try {
      const responsePromise = new Promise<string>((resolvePromise, rejectPromise) => {
        let out = '';
        const timer = setTimeout(() => rejectPromise(new Error(`timeout; stdout so far: ${out}`)), 8000);
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf-8');
          if (out.includes('"id":1')) {
            clearTimeout(timer);
            resolvePromise(out.trim());
          }
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          rejectPromise(err);
        });
      });

      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`,
      );
      const line = await responsePromise;
      const parsed = JSON.parse(line) as { id: number; result?: { serverInfo?: { name?: string } } };
      assert.equal(parsed.id, 1);
      assert.equal(parsed.result?.serverInfo?.name, 'broke');
    } finally {
      child.kill();
    }
  });
});

describe('cli.ts: Claude Code hooks, agent installer, and CLI commands', () => {
  it('handles Claude Code PreToolUse (focus + Read slicing) and PostToolUse (Bash error compression)', async () => {
    const tmp = makeTempProject();
    try {
      writeFileSync(join(tmp.dir, 'mod.ts'), buildLargeTsFile(), 'utf-8');
      const sliceOnConfig: Config = {
        ...DEFAULT_CONFIG,
        slice: { ...DEFAULT_CONFIG.slice, enabled: true, minChars: 1000, focusAuto: true },
        errors: { ...DEFAULT_CONFIG.errors, enabled: true, minChars: 200 },
      };

      // 1. PreToolUse on Read when not focused -> intercepts with interface view
      const preRead = await handleClaudeHookPayload(
        {
          session_id: 'sess-1',
          cwd: tmp.dir,
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: 'mod.ts' },
        },
        {
          root: tmp.dir,
          config: sliceOnConfig,
          focusStorePath: tmp.focusPath,
          deps: { telemetryPaths: { statsPath: tmp.statsPath, measurePath: tmp.measurePath } },
        },
      );
      assert.equal(preRead.exitCode, 0);
      assert.ok(preRead.stdout);
      const preReadJson = JSON.parse(preRead.stdout) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
      };
      assert.equal(preReadJson.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(preReadJson.hookSpecificOutput.permissionDecisionReason, /interface view/);

      // 2. PreToolUse on Edit -> sets focus to mod.ts, so subsequent Read passes through!
      await handleClaudeHookPayload(
        {
          session_id: 'sess-1',
          cwd: tmp.dir,
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: 'mod.ts' },
        },
        { root: tmp.dir, config: sliceOnConfig, focusStorePath: tmp.focusPath },
      );
      assert.equal(readAgentFocus('claude:sess-1', tmp.focusPath), 'mod.ts');

      const focusedRead = await handleClaudeHookPayload(
        {
          session_id: 'sess-1',
          cwd: tmp.dir,
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: 'mod.ts' },
        },
        { root: tmp.dir, config: sliceOnConfig, focusStorePath: tmp.focusPath },
      );
      assert.equal(focusedRead.stdout, undefined);

      // 3. PostToolUse on Bash -> compresses large error output
      const bigError = Array.from(
        { length: 40 },
        (_, i) => `mod.ts:${i + 1}:2 - error TS2322: Type mismatch at line ${i + 1}`,
      ).join('\n');
      const postBash = await handleClaudeHookPayload(
        {
          session_id: 'sess-1',
          cwd: tmp.dir,
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_response: { stdout: bigError, exitCode: 1 },
        },
        {
          root: tmp.dir,
          config: sliceOnConfig,
          focusStorePath: tmp.focusPath,
          deps: { telemetryPaths: { statsPath: tmp.statsPath, measurePath: tmp.measurePath } },
        },
      );
      assert.ok(postBash.stdout);
      assert.match(postBash.stdout, /error TS2322/);
    } finally {
      tmp.cleanup();
    }
  });

  it('installs multi-agent configs for claude, antigravity, codex, and cursor', async () => {
    const tmp = makeTempProject();
    try {
      for (const agent of ['claude', 'antigravity', 'codex', 'cursor'] as const) {
        const dry = executeAgentInstall({ agent, targetDir: tmp.dir, dryRun: true });
        assert.equal(dry.ok, true);
        assert.ok(dry.files.length >= 2);

        const real = executeAgentInstall({ agent, targetDir: tmp.dir, dryRun: false });
        assert.equal(real.ok, true);
        for (const f of real.files) {
          assert.equal(existsSync(f), true, `expected ${f} to exist for ${agent}`);
        }
      }

      // Idempotent AGENTS.md update
      const agentsMd = readFileSync(join(tmp.dir, 'AGENTS.md'), 'utf-8');
      assert.equal(agentsMd.split('<!-- broke:multi-agent:start -->').length - 1, 1);

      const cliRes = await runCli(['help'], { cwd: tmp.dir });
      assert.equal(cliRes.exitCode, 0);
      assert.match(cliRes.output, /install-agent/);
    } finally {
      tmp.cleanup();
    }
  });
});
