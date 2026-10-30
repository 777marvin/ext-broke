import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { agentTaskId, runAgentCompress } from '../agent-core';
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
