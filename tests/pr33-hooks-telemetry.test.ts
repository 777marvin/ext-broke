import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { agentTaskId, runAgentCompress } from '../agent-core';
import { handleClaudeHookPayload } from '../cli';
import { DEFAULT_CONFIG, type Config } from '../config';
import { loadRunRecords, loadTaskStats } from '../tokens';

interface TempTelemetryWs {
  dir: string;
  statsPath: string;
  measurePath: string;
  errorsDir: string;
  cleanup: () => void;
}

function makeTelemetryWorkspace(): TempTelemetryWs {
  const dir = mkdtempSync(join(tmpdir(), 'broke-pr33-telemetry-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  return {
    dir,
    statsPath: join(dataDir, 'stats.jsonl'),
    measurePath: join(dataDir, 'measure.jsonl'),
    errorsDir: join(dataDir, 'errors'),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function makeSummarizeConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    level: 'summarize',
    stats: {
      ...DEFAULT_CONFIG.stats,
      measure: true,
    },
    summarize: {
      ...DEFAULT_CONFIG.summarize,
      via: 'local',
      minChars: 50,
      ollamaUrl: 'http://127.0.0.1:11434',
      localModel: 'qwen2.5-coder:1.5b',
    },
    errors: {
      ...DEFAULT_CONFIG.errors,
      enabled: false, // isolate summarizer behavior from error extractor
    },
    truncate: {
      ...DEFAULT_CONFIG.truncate,
      maxLines: 1000,
      maxKB: 100, // ensure input is not truncated before reaching summarizer
    },
  };
}

describe('PR #33 Package E: Record Summarizer Work Independently of Savings (Finding 16)', () => {
  it('records shorter response with positive accepted savings and exact attempt sizes', async () => {
    const ws = makeTelemetryWorkspace();
    try {
      const config = makeSummarizeConfig();
      const rawInput = 'Error: something failed in module X\n' + 'stack line detail\n'.repeat(150);
      let capturedPrompt = '';

      const res = await runAgentCompress(
        ws.dir,
        { text: rawInput, summarize: true },
        'test-agent',
        config,
        {
          telemetryPaths: { statsPath: ws.statsPath, measurePath: ws.measurePath },
          generateOllama: async (_url, _model, prompt) => {
            capturedPrompt = prompt;
            return { ok: true, text: 'Summary: module X failed with 150 stack lines.' };
          },
        },
      );

      assert.equal(res.ok, true);
      assert.ok(res.savedChars > 0);
      assert.match(res.text, /Summary: module X failed/);

      const taskId = agentTaskId('test-agent', ws.dir);
      const stats = loadTaskStats(taskId, ws.statsPath);
      assert.ok(stats, 'stats must be recorded');
      assert.equal(stats.summarizeCalls, 1, 'summarizeCalls should be 1');
      assert.ok(stats.savedChars.summarize > 0, 'summarize savings must be positive');

      const runs = loadRunRecords(ws.measurePath);
      assert.equal(runs.length, 1, 'measure record must be persisted');
      assert.equal(runs[0].summarizeCalls, 1);
      assert.equal(runs[0].summarizer, 'local');
      assert.equal(runs[0].summarizerInputChars, capturedPrompt.length);
      assert.equal(runs[0].summarizerOutputChars, 'Summary: module X failed with 150 stack lines.'.length);
      assert.ok(runs[0].summarizeChars > 0);
      assert.ok(runs[0].savedChars > 0);
    } finally {
      ws.cleanup();
    }
  });

  it('records longer response as 1 call with exact sizes, zero summary savings, and keeps zero-savings run record', async () => {
    const ws = makeTelemetryWorkspace();
    try {
      const config = makeSummarizeConfig();
      const rawInput = 'Simple error header\n' + 'log detail line\n'.repeat(100);
      const bloatedOutput = 'Extremely verbose hallucinated response\n'.repeat(300);
      let capturedPrompt = '';

      const res = await runAgentCompress(
        ws.dir,
        { text: rawInput, summarize: true },
        'test-agent',
        config,
        {
          telemetryPaths: { statsPath: ws.statsPath, measurePath: ws.measurePath },
          generateOllama: async (_url, _model, prompt) => {
            capturedPrompt = prompt;
            return { ok: true, text: bloatedOutput };
          },
        },
      );

      assert.equal(res.ok, true);
      // Because bloated output is longer, summarizer output was rejected!
      // Output must retain original rawInput without bloated text
      assert.equal(res.text, rawInput);
      assert.equal(res.savedChars, 0);

      const taskId = agentTaskId('test-agent', ws.dir);
      const stats = loadTaskStats(taskId, ws.statsPath);
      assert.ok(stats, 'stats must be recorded even when savings are 0');
      assert.equal(stats.summarizeCalls, 1, 'must account for 1 attempted call');
      assert.equal(stats.savedChars.summarize, 0, 'summarize savings must be 0');

      const runs = loadRunRecords(ws.measurePath);
      assert.equal(runs.length, 1, 'a call with no total savings remains in the ledger when measure is enabled');
      assert.equal(runs[0].summarizeCalls, 1);
      assert.equal(runs[0].summarizer, 'local');
      assert.equal(runs[0].summarizerInputChars, capturedPrompt.length);
      assert.equal(runs[0].summarizerOutputChars, bloatedOutput.length);
      assert.equal(runs[0].summarizeChars, 0);
      assert.equal(runs[0].savedChars, 0);
    } finally {
      ws.cleanup();
    }
  });

  it('records empty response without fabricated response data', async () => {
    const ws = makeTelemetryWorkspace();
    try {
      const config = makeSummarizeConfig();
      const rawInput = 'Failing command output\n' + 'stack trace line\n'.repeat(120);
      let capturedPrompt = '';

      const res = await runAgentCompress(
        ws.dir,
        { text: rawInput, summarize: true },
        'test-agent',
        config,
        {
          telemetryPaths: { statsPath: ws.statsPath, measurePath: ws.measurePath },
          generateOllama: async (_url, _model, prompt) => {
            capturedPrompt = prompt;
            return { ok: true, text: '' };
          },
        },
      );

      assert.equal(res.ok, true);
      assert.equal(res.text, rawInput);
      assert.equal(res.savedChars, 0);

      const taskId = agentTaskId('test-agent', ws.dir);
      const stats = loadTaskStats(taskId, ws.statsPath);
      assert.ok(stats);
      assert.equal(stats.summarizeCalls, 1);
      assert.equal(stats.savedChars.summarize, 0);

      const runs = loadRunRecords(ws.measurePath);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].summarizeCalls, 1);
      assert.equal(runs[0].summarizerInputChars, capturedPrompt.length);
      assert.equal(runs[0].summarizerOutputChars, 0, 'empty response must not invent output characters');
      assert.equal(runs[0].summarizeChars, 0);
    } finally {
      ws.cleanup();
    }
  });

  it('records thrown exception without fabricated response data and falls back to deterministic text', async () => {
    const ws = makeTelemetryWorkspace();
    try {
      const config = makeSummarizeConfig();
      const rawInput = 'Build failed: error TS1234\n' + 'context line\n'.repeat(100);
      let capturedPrompt = '';

      const res = await runAgentCompress(
        ws.dir,
        { text: rawInput, summarize: true },
        'test-agent',
        config,
        {
          telemetryPaths: { statsPath: ws.statsPath, measurePath: ws.measurePath },
          generateOllama: async (_url, _model, prompt) => {
            capturedPrompt = prompt;
            throw new Error('ECONNREFUSED 127.0.0.1:11434');
          },
        },
      );

      assert.equal(res.ok, true);
      assert.equal(res.text, rawInput);
      assert.equal(res.savedChars, 0);

      const taskId = agentTaskId('test-agent', ws.dir);
      const stats = loadTaskStats(taskId, ws.statsPath);
      assert.ok(stats);
      assert.equal(stats.summarizeCalls, 1, 'attempt must be recorded on exception');
      assert.equal(stats.savedChars.summarize, 0);

      const runs = loadRunRecords(ws.measurePath);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].summarizeCalls, 1);
      assert.equal(runs[0].summarizerInputChars, capturedPrompt.length);
      assert.equal(runs[0].summarizerOutputChars, 0);
    } finally {
      ws.cleanup();
    }
  });

  it('suppresses stats and measure file writes when recordTelemetry is false', async () => {
    const ws = makeTelemetryWorkspace();
    try {
      const config = makeSummarizeConfig();
      const rawInput = 'Sample log content\n' + 'line\n'.repeat(150);

      const res = await runAgentCompress(
        ws.dir,
        { text: rawInput, summarize: true },
        'test-agent',
        config,
        {
          telemetryPaths: { statsPath: ws.statsPath, measurePath: ws.measurePath },
          recordTelemetry: false,
          generateOllama: async () => {
            return { ok: true, text: 'Short summary' };
          },
        },
      );

      assert.equal(res.ok, true);
      assert.ok(res.savedChars > 0);

      assert.equal(existsSync(ws.statsPath), false, 'stats.jsonl must NOT exist when recordTelemetry: false');
      assert.equal(existsSync(ws.measurePath), false, 'measure.jsonl must NOT exist when recordTelemetry: false');
    } finally {
      ws.cleanup();
    }
  });
});
describe('PR #33 Package F: Claude Hooks Match the Host Contract (Findings 7, 8)', () => {
  it('successful payload returns updatedToolOutput without duplicate additionalContext (Finding 7)', async () => {
    const ws = makeTelemetryWorkspace();
    try {
      const config = {
        ...DEFAULT_CONFIG,
        enabled: true,
        autonomy: 'autonomous' as const,
        errors: {
          ...DEFAULT_CONFIG.errors,
          enabled: true,
          minChars: 50,
        },
      };

      const failingTestOutput = [
        'FAIL tests/unit.test.ts',
        '  ● suite > should validate arguments',
        '    Expected: 200',
        '    Received: 500',
        ...Array.from({ length: 150 }, (_, i) => `    at runStep${i} (src/core.ts:${i + 10}:5)`),
      ].join('\n');

      const payload = {
        session_id: 'session-123',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: {
          stdout: failingTestOutput,
          stderr: '',
          interrupted: false,
        },
      };

      const res = await handleClaudeHookPayload(payload, {
        root: ws.dir,
        config,
        deps: {
          telemetryPaths: { statsPath: ws.statsPath, measurePath: ws.measurePath },
        },
      });

      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout, 'hook should return JSON stdout response');
      const parsed = JSON.parse(res.stdout);

      assert.equal(parsed.hookSpecificOutput?.hookEventName, 'PostToolUse');
      assert.ok(parsed.hookSpecificOutput?.updatedToolOutput, 'must return updatedToolOutput');
      assert.equal(
        parsed.hookSpecificOutput?.additionalContext,
        undefined,
        'must NOT duplicate summary via additionalContext when replacing output',
      );

      // Check updatedToolOutput preserves metadata and replaces stdout
      const updated = parsed.hookSpecificOutput.updatedToolOutput;
      assert.equal(typeof updated, 'object');
      assert.equal(updated.interrupted, false);
      assert.ok(updated.stdout.length < failingTestOutput.length, 'stdout should be compressed');
      assert.match(updated.stdout, /suite > should validate arguments/);
    } finally {
      ws.cleanup();
    }
  });

  it('failure payload returns labeled additionalContext and does not modify savings ledger (Findings 7, 8)', async () => {
    const ws = makeTelemetryWorkspace();
    try {
      const config = {
        ...DEFAULT_CONFIG,
        enabled: true,
        autonomy: 'autonomous' as const,
        errors: {
          ...DEFAULT_CONFIG.errors,
          enabled: true,
          minChars: 50,
        },
      };

      const failureTrace = [
        'AssertionError: compilation failed with 20 errors',
        ...Array.from({ length: 100 }, (_, i) => `  at compileFile${i} (src/file${i}.ts:${i + 1}:10)`),
      ].join('\n');

      const payload = {
        session_id: 'session-fail',
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: { command: 'npx tsc' },
        error: failureTrace,
      };

      const res = await handleClaudeHookPayload(payload, {
        root: ws.dir,
        config,
        deps: {
          telemetryPaths: { statsPath: ws.statsPath, measurePath: ws.measurePath },
        },
      });

      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout, 'hook should return JSON stdout response for failure');
      const parsed = JSON.parse(res.stdout);

      assert.equal(parsed.hookSpecificOutput?.hookEventName, 'PostToolUseFailure');
      assert.ok(parsed.hookSpecificOutput?.additionalContext, 'must provide supplementary additionalContext');
      assert.match(parsed.hookSpecificOutput.additionalContext, /\[broke diagnostic essence\]/);
      assert.equal(parsed.hookSpecificOutput?.updatedToolOutput, undefined, 'must NOT claim replacement of failure output');

      // Ledger must NOT be changed by hook invocation
      assert.equal(existsSync(ws.statsPath), false, 'hook execution must not modify stats.jsonl');
      assert.equal(existsSync(ws.measurePath), false, 'hook execution must not modify measure.jsonl');
    } finally {
      ws.cleanup();
    }
  });

  it('injected Ollama call count remains zero on all hook paths (Finding 8)', async () => {
    const ws = makeTelemetryWorkspace();
    try {
      const config = {
        ...DEFAULT_CONFIG,
        enabled: true,
        level: 'summarize' as const,
        summarize: {
          ...DEFAULT_CONFIG.summarize,
          via: 'local' as const,
          minChars: 50,
        },
        errors: {
          ...DEFAULT_CONFIG.errors,
          enabled: true,
          minChars: 50,
        },
      };

      let ollamaCalls = 0;
      const testDeps = {
        generateOllama: async () => {
          ollamaCalls++;
          return { ok: true, text: 'Ollama generated summary' };
        },
        telemetryPaths: { statsPath: ws.statsPath, measurePath: ws.measurePath },
      };

      const bigOutput = 'Error occurred\n' + 'stack line detail\n'.repeat(150);

      // 1. PostToolUse
      await handleClaudeHookPayload(
        {
          session_id: 's1',
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_response: { stdout: bigOutput },
        },
        { root: ws.dir, config, deps: testDeps },
      );

      // 2. PostToolUseFailure
      await handleClaudeHookPayload(
        {
          session_id: 's2',
          hook_event_name: 'PostToolUseFailure',
          tool_name: 'Bash',
          error: bigOutput,
        },
        { root: ws.dir, config, deps: testDeps },
      );

      assert.equal(ollamaCalls, 0, 'Ollama summarizer must NEVER be called from Claude hooks');
      assert.equal(existsSync(ws.statsPath), false, 'ledger must remain untouched');
    } finally {
      ws.cleanup();
    }
  });

  it('passes through unknown structures, interruptions, and images without modification', async () => {
    const ws = makeTelemetryWorkspace();
    try {
      const config = { ...DEFAULT_CONFIG, enabled: true, autonomy: 'autonomous' as const };

      // 1. Interrupted tool response
      const res1 = await handleClaudeHookPayload(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          is_interrupt: true,
          tool_response: { stdout: 'Partial output before SIGINT\n'.repeat(100) },
        },
        { root: ws.dir, config },
      );
      assert.equal(res1.exitCode, 0);
      assert.equal(res1.stdout, undefined, 'interrupted payload must not be modified');

      // 2. tool_response with interrupted flag
      const res2 = await handleClaudeHookPayload(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_response: { stdout: 'Partial output\n'.repeat(100), interrupted: true },
        },
        { root: ws.dir, config },
      );
      assert.equal(res2.exitCode, 0);
      assert.equal(res2.stdout, undefined);

      // 3. Image response
      const res3 = await handleClaudeHookPayload(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_response: { isImage: true, base64: 'abc123456789' },
        },
        { root: ws.dir, config },
      );
      assert.equal(res3.exitCode, 0);
      assert.equal(res3.stdout, undefined);

      // 4. Non-object unknown structure
      const res4 = await handleClaudeHookPayload(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_response: 123456,
        },
        { root: ws.dir, config },
      );
      assert.equal(res4.exitCode, 0);
      assert.equal(res4.stdout, undefined);
    } finally {
      ws.cleanup();
    }
  });

  it('runs end-to-end via broke-runner.cjs hook claude (real subprocess stdio test)', () => {
    const ws = makeTelemetryWorkspace();
    try {
      const runnerScript = join(__dirname, '..', 'scripts', 'broke-runner.cjs');
      const lines = ['FAIL tests/e2e.test.ts', '  ● test suite failed', '    Expected status: 200'];
      for (let i = 0; i < 300; i++) {
        lines.push(`    at frame${i} (src/app.ts:${i + 1}:5) error stack trace detail extra info ${'x'.repeat(40)}`);
      }
      const failingTestOutput = lines.join('\n');

      const hookPayload = {
        session_id: 'e2e-session',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_response: {
          stdout: failingTestOutput,
          stderr: '',
          interrupted: false,
        },
      };

      const childEnv = {
        ...process.env,
        BROKE_DATA_DIR: ws.dir,
        NODE_V8_COVERAGE: '',
      };

      const proc = execFileSync(
        process.execPath,
        [runnerScript, 'hook', 'claude', '--root', ws.dir],
        {
          input: JSON.stringify(hookPayload),
          encoding: 'utf-8',
          env: childEnv,
        },
      );

      assert.ok(proc.trim(), 'subprocess must emit JSON output on stdout');
      const parsed = JSON.parse(proc.trim());
      assert.equal(parsed.hookSpecificOutput?.hookEventName, 'PostToolUse');
      assert.ok(parsed.hookSpecificOutput?.updatedToolOutput);
      assert.equal(parsed.hookSpecificOutput?.additionalContext, undefined);
    } finally {
      ws.cleanup();
    }
  });
});
