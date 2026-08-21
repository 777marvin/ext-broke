import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyBrokeCommand,
  formatMeasure,
  formatStats,
  hasOllamaModel,
  HELP_TEXT,
  parseBrokeCommand,
  type BrokeCommand,
} from '../commands';
import { DEFAULT_CONFIG, type Config } from '../config';
import { emptyStats } from '../tokens';

const kind = (args: string[]): BrokeCommand['kind'] => parseBrokeCommand(args).kind;
const expectUnknown = (args: string[]): void => {
  const cmd = parseBrokeCommand(args);
  assert.equal(cmd.kind, 'unknown', `expected unknown for: ${args.join(' ')}`);
};

describe('parseBrokeCommand', () => {
  it('defaults to status with no or explicit status args', () => {
    assert.equal(kind([]), 'status');
    assert.equal(kind(['status']), 'status');
  });

  it('parses toggle and level', () => {
    assert.deepEqual(parseBrokeCommand(['on']), { kind: 'toggle', enabled: true });
    assert.deepEqual(parseBrokeCommand(['off']), { kind: 'toggle', enabled: false });
    assert.deepEqual(parseBrokeCommand(['level', 'summarize']), { kind: 'level', level: 'summarize' });
    expectUnknown(['level', 'nuke']);
    expectUnknown(['level']);
  });

  it('parses maxchars with bounds', () => {
    assert.deepEqual(parseBrokeCommand(['maxchars', '60000']), { kind: 'maxchars', value: 60000 });
    assert.deepEqual(parseBrokeCommand(['maxchars', '12.7']), { kind: 'maxchars', value: 13 }); // rounds
    assert.deepEqual(parseBrokeCommand(['maxchars', '1.4']), { kind: 'maxchars', value: 1 }); // rounds
    expectUnknown(['maxchars', '0']);
    expectUnknown(['maxchars', 'abc']);
    expectUnknown(['maxchars']);
    expectUnknown(['maxchars', '0.4']); // XF8: must not pass validation then round to 0
  });

  it('parses protect with schema bounds 1-50', () => {
    assert.deepEqual(parseBrokeCommand(['protect', '1']), { kind: 'protect', value: 1 });
    assert.deepEqual(parseBrokeCommand(['protect', '50']), { kind: 'protect', value: 50 });
    expectUnknown(['protect', '0']);
    expectUnknown(['protect', '51']);
    expectUnknown(['protect', 'x']);
    expectUnknown(['protect', '0.4']); // XF8: rounds to 0, schema min 1
  });

  it('parses truncate', () => {
    assert.deepEqual(parseBrokeCommand(['truncate', '200', '20']), { kind: 'truncate', lines: 200, kb: 20 });
    expectUnknown(['truncate', '200']);
    expectUnknown(['truncate', '0', '20']);
    expectUnknown(['truncate', '200', '0']);
    expectUnknown(['truncate', '0.4', '20']); // XF8: rounds to 0
    expectUnknown(['truncate', '200', '0.4']); // XF8: rounds to 0
  });

  it('parses errors subcommands', () => {
    assert.deepEqual(parseBrokeCommand(['errors', 'on']), { kind: 'errors-toggle', enabled: true });
    assert.deepEqual(parseBrokeCommand(['errors', 'off']), { kind: 'errors-toggle', enabled: false });
    assert.deepEqual(parseBrokeCommand(['errors', 'minchars', '8000']), { kind: 'errors-minchars', value: 8000 });
    assert.deepEqual(parseBrokeCommand(['errors', 'lines', '8']), { kind: 'errors-lines', value: 8 });
    expectUnknown(['errors', 'lines', '0']);
    expectUnknown(['errors', 'lines', '31']);
    expectUnknown(['errors', 'minchars', '0.4']); // XF8: rounds to 0
    expectUnknown(['errors', 'lines', '0.4']); // XF8: rounds to 0
    assert.deepEqual(parseBrokeCommand(['errors', 'toollevel', 'on']), { kind: 'errors-toollevel', enabled: true });
    assert.deepEqual(parseBrokeCommand(['errors', 'toollevel', 'off']), { kind: 'errors-toollevel', enabled: false });
    expectUnknown(['errors', 'toollevel', 'maybe']);
  });

  it('parses summarize subcommands', () => {
    assert.deepEqual(parseBrokeCommand(['summarize', 'via', 'cloud']), { kind: 'summarize-via', via: 'cloud' });
    assert.deepEqual(parseBrokeCommand(['summarize', 'model', 'qwen2.5-coder:3b']), {
      kind: 'summarize-model',
      model: 'qwen2.5-coder:3b',
    });
    assert.deepEqual(parseBrokeCommand(['summarize', 'cloud', 'openai/gpt-4o-mini']), {
      kind: 'summarize-cloud',
      modelId: 'openai/gpt-4o-mini',
    });
    assert.deepEqual(parseBrokeCommand(['summarize', 'after', '2']), { kind: 'summarize-after', turns: 2 });
    assert.deepEqual(parseBrokeCommand(['summarize', 'after', '1.6']), { kind: 'summarize-after', turns: 2 }); // rounds
    expectUnknown(['summarize', 'after', '1']); // schema min 2
    expectUnknown(['summarize', 'after', '1.4']); // XF8: rounds to 1, schema min 2
    expectUnknown(['summarize', 'via', 'remote']);
  });

  it('parses stats, reset, selftest, help', () => {
    assert.equal(kind(['stats']), 'stats');
    assert.equal(kind(['reset']), 'reset');
    assert.equal(kind(['selftest']), 'selftest');
    assert.equal(kind(['help']), 'help');
    expectUnknown(['bogus']);
  });

  it('parses measure and measure on|off', () => {
    assert.deepEqual(parseBrokeCommand(['measure']), { kind: 'measure' });
    assert.deepEqual(parseBrokeCommand(['measure', 'on']), { kind: 'measure-toggle', enabled: true });
    assert.deepEqual(parseBrokeCommand(['measure', 'off']), { kind: 'measure-toggle', enabled: false });
    expectUnknown(['measure', 'maybe']);
  });
});

describe('applyBrokeCommand', () => {
  const withTemp = (fn: (file: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'broke-cmd-'));
    const file = join(dir, 'config.json');
    try {
      fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const onDisk = (file: string): Config => JSON.parse(readFileSync(file, 'utf-8')) as Config;

  it('applies toggle, level, maxchars, protect and persists them', () => {
    withTemp((file) => {
      applyBrokeCommand(parseBrokeCommand(['off']), DEFAULT_CONFIG, file);
      assert.equal(onDisk(file).enabled, false);
      applyBrokeCommand(parseBrokeCommand(['level', 'summarize']), DEFAULT_CONFIG, file);
      assert.equal(onDisk(file).level, 'summarize');
      applyBrokeCommand(parseBrokeCommand(['maxchars', '90000']), DEFAULT_CONFIG, file);
      assert.equal(onDisk(file).maxContextChars, 90000);
      applyBrokeCommand(parseBrokeCommand(['protect', '3']), DEFAULT_CONFIG, file);
      assert.equal(onDisk(file).protectedTurns, 3);
    });
  });

  it('applies both truncate limits in one persisted write (F13)', () => {
    withTemp((file) => {
      const { config } = applyBrokeCommand(parseBrokeCommand(['truncate', '150', '30']), DEFAULT_CONFIG, file);
      assert.equal(config.truncate.maxLines, 150);
      assert.equal(config.truncate.maxKB, 30);
      const disk = onDisk(file);
      assert.equal(disk.truncate.maxLines, 150);
      assert.equal(disk.truncate.maxKB, 30);
    });
  });

  it('applies errors and summarize subcommands', () => {
    withTemp((file) => {
      applyBrokeCommand(parseBrokeCommand(['errors', 'off']), DEFAULT_CONFIG, file);
      assert.equal(onDisk(file).errors.enabled, false);
      applyBrokeCommand(parseBrokeCommand(['errors', 'minchars', '999']), DEFAULT_CONFIG, file);
      assert.equal(onDisk(file).errors.minChars, 999);
      applyBrokeCommand(parseBrokeCommand(['errors', 'toollevel', 'on']), DEFAULT_CONFIG, file);
      assert.equal(onDisk(file).errors.toolLevel, true);
      applyBrokeCommand(parseBrokeCommand(['summarize', 'via', 'cloud']), DEFAULT_CONFIG, file);
      assert.equal(onDisk(file).summarize.via, 'cloud');
      applyBrokeCommand(parseBrokeCommand(['summarize', 'model', 'llama3.2:1b']), DEFAULT_CONFIG, file);
      assert.equal(onDisk(file).summarize.localModel, 'llama3.2:1b');
      applyBrokeCommand(parseBrokeCommand(['summarize', 'after', '4']), DEFAULT_CONFIG, file);
      assert.equal(onDisk(file).summarize.afterTurns, 4);
    });
  });

  it('returns a confirmation message for every applying command', () => {
    withTemp((file) => {
      for (const args of [['off'], ['level', 'summarize'], ['maxchars', '90000'], ['truncate', '150', '30'], ['summarize', 'via', 'cloud'], ['measure', 'off']]) {
        const { message } = applyBrokeCommand(parseBrokeCommand(args), DEFAULT_CONFIG, file);
        assert.ok(message.length > 0, `missing confirmation for: ${args.join(' ')}`);
      }
    });
  });

  it('persists the measurement toggle under stats.measure', () => {
    withTemp((file) => {
      const { config } = applyBrokeCommand(parseBrokeCommand(['measure', 'off']), DEFAULT_CONFIG, file);
      assert.equal(config.stats.measure, false);
      assert.equal(onDisk(file).stats.measure, false);
    });
  });
});

describe('formatStats', () => {
  it('reports no stats message when stats are missing', () => {
    assert.ok(formatStats(DEFAULT_CONFIG, null).includes('No stats recorded'));
  });

  it('lists per-pass numbers and the money line when a price is known', () => {
    const stats = { ...emptyStats('t'), passes: 5, savedChars: { structural: 100, error: 200, truncate: 300, summarize: 400 } };
    const out = formatStats(DEFAULT_CONFIG, stats, { modelId: 'm', providerId: 'p', inputPerMToken: 3 });
    assert.ok(out.includes('5 compression run(s)'));
    assert.ok(out.includes('structural'));
    assert.ok(out.includes('estimated cost saved'));
  });

  it('omits the money line for unknown prices', () => {
    const stats = { ...emptyStats('t'), passes: 1 };
    const out = formatStats(DEFAULT_CONFIG, stats, null);
    assert.ok(!out.includes('estimated cost saved'));
  });
});

describe('HELP_TEXT', () => {
  it('carries the defaults from DEFAULT_CONFIG, not hardcoded numbers (F22)', () => {
    assert.ok(HELP_TEXT.includes(String(DEFAULT_CONFIG.maxContextChars)));
    assert.ok(HELP_TEXT.includes(String(DEFAULT_CONFIG.protectedTurns)));
    assert.ok(HELP_TEXT.includes(String(DEFAULT_CONFIG.truncate.maxLines)));
    assert.ok(HELP_TEXT.includes(String(DEFAULT_CONFIG.errors.minChars)));
    assert.ok(HELP_TEXT.includes(String(DEFAULT_CONFIG.summarize.afterTurns)));
    assert.ok(HELP_TEXT.includes(DEFAULT_CONFIG.summarize.localModel));
  });

  it('documents the measure commands with the stats.measure default', () => {
    assert.ok(HELP_TEXT.includes('measure'));
    assert.ok(HELP_TEXT.includes(String(DEFAULT_CONFIG.stats.measure ? 'on' : 'off')));
  });
});

describe('formatMeasure', () => {
  it('shows the honest framing for an empty ledger', () => {
    const out = formatMeasure(null);
    assert.ok(out.includes('no measurement records'));
    assert.ok(out.includes('stats.measure'));
    assert.ok(out.includes('npm run measure'));
  });

  it('summarizes records and labels the totals as sum-over-runs', () => {
    const out = formatMeasure({
      runs: 2,
      tasks: 1,
      spanMs: 0,
      charsBefore: 20000,
      charsAfter: 15000,
      savedChars: 5000,
      savedTokens: 1250,
      meanSavedCharsPerRun: 2500,
      medianSavedCharsPerRun: 2500,
      maxSavedCharsPerRun: 3000,
      summarizeCalls: 0,
      byTask: [{ taskId: 't1', runs: 2, savedChars: 5000 }],
    });
    assert.ok(out.includes('2 run(s)'));
    assert.ok(out.includes('sum over runs'));
    assert.ok(out.includes('NOT a cumulative context claim'));
    assert.ok(out.includes('25%'));
    assert.ok(out.includes('per task'));
  });

  it('rounds the reduction percentage', () => {
    const out = formatMeasure({
      runs: 1,
      tasks: 1,
      spanMs: 0,
      charsBefore: 30000,
      charsAfter: 20000,
      savedChars: 10000,
      savedTokens: 2500,
      meanSavedCharsPerRun: 10000,
      medianSavedCharsPerRun: 10000,
      maxSavedCharsPerRun: 10000,
      summarizeCalls: 0,
      byTask: [],
    });
    assert.ok(out.includes('33.3%'));
  });
});

describe('hasOllamaModel', () => {
  it('matches the exact tag first (F15)', () => {
    assert.equal(hasOllamaModel(['qwen2.5-coder:3b'], 'qwen2.5-coder:3b'), true);
    assert.equal(hasOllamaModel(['qwen2.5-coder:7b'], 'qwen2.5-coder:3b'), false, 'a tag config must not match other tags');
  });

  it('matches any tag for an untagged base-name config', () => {
    assert.equal(hasOllamaModel(['qwen2.5-coder:3b'], 'qwen2.5-coder'), true);
    assert.equal(hasOllamaModel(['qwen2.5-coder:7b'], 'qwen2.5-coder'), true);
  });

  it('reports missing models honestly', () => {
    assert.equal(hasOllamaModel([], 'qwen2.5-coder:3b'), false);
    assert.equal(hasOllamaModel(['llama3.2:1b'], 'qwen2.5-coder:3b'), false);
  });
});
