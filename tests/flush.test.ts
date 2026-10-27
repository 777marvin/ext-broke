import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ContextMessage, ExtensionContext } from '@aiderdesk/extensions';
import type { Config } from '../config';

const root = mkdtempSync(join(tmpdir(), 'broke-flush-'));
process.env.BROKE_DATA_DIR = root;
process.env.BROKE_CONFIG_PATH = join(root, 'config.json');
process.env.BROKE_STATS_PATH = join(root, 'stats.jsonl');
process.env.BROKE_MEASURE_PATH = join(root, 'measure.jsonl');
process.env.BROKE_SNAPSHOTS_DIR = join(root, 'snapshots');
let Broke: typeof import('../index').default;
let configModule: typeof import('../config');
before(async () => { ({ default: Broke } = await import('../index')); configModule = await import('../config'); });
after(() => rmSync(root, { recursive: true, force: true }));

interface Commands {
  summarizeNow(context: ExtensionContext): Promise<string>;
  handleFlushCommand(context: ExtensionContext, command: { kind: 'flush'; yes?: boolean; undoIndex?: number }): Promise<string>;
}
let taskNumber = 0;
function fixture() {
  const defaults = configModule.DEFAULT_CONFIG;
  const config: Config = {
    ...defaults, level: 'summarize', protectedTurns: 1, maxContextChars: 1000,
    cache: { ...defaults.cache, profile: 'off' },
    summarize: { ...defaults.summarize, via: 'cloud', cloudModelId: 'synthetic-model', minChars: 100, afterTurns: 2 },
  };
  configModule.saveConfig(config);
  const messages = [
    { id: 'header', role: 'system', content: 'Synthetic system header' },
    { id: 'brief', role: 'user', content: 'Implement a synthetic billing example' },
    { id: 'old-a', role: 'assistant', content: 'first findings '.repeat(300) },
    { id: 'old-u', role: 'user', content: 'Keep the invoice decisions' },
    { id: 'old-b', role: 'assistant', content: 'invoice decisions '.repeat(300) },
    { id: 'old-u2', role: 'user', content: 'Add the pending work' },
    { id: 'old-c', role: 'assistant', content: 'pending work '.repeat(300) },
    { id: 'recent', role: 'user', content: 'This recent request must survive' },
    { id: 'tail', role: 'assistant', content: 'Recent answer must survive too' },
  ] as unknown as ContextMessage[];
  let current = messages;
  let calls = 0;
  let replacements = 0;
  let onConfirm = () => {};
  const task = {
    data: { id: `flush-${++taskNumber}`, provider: 'openai', model: 'synthetic-model' },
    getContextMessages: async () => current,
    generateText: async () => { calls++; return 'Invoices implemented; remaining work: payment validation.'; },
    loadContextMessages: async (next: ContextMessage[]) => {
      assert.ok(existsSync(process.env.BROKE_SNAPSHOTS_DIR!), 'undo storage exists before replacement');
      replacements++; current = next;
    },
    askQuestion: async () => { onConfirm(); return 'y'; },
    addLogMessage: async () => {},
  };
  const context = { getTaskContext: () => task, log: () => {}, triggerUIDataRefresh: () => {} } as unknown as ExtensionContext;
  const ext = new Broke() as unknown as Commands;
  return { ext, context, messages, config, task, current: () => current, calls: () => calls, replacements: () => replacements, confirm: (cb: () => void) => { onConfirm = cb; } };
}

describe('AUD-04 covered-region flush', () => {
  it('uses a real cached summary, preserves recent messages and undoes the entire original history', async () => {
    const f = fixture();
    assert.match(await f.ext.summarizeNow(f.context), /summary generated/);
    const original = JSON.stringify(f.messages);
    assert.match(await f.ext.handleFlushCommand(f.context, { kind: 'flush' }), /flushed 5 message/);
    assert.deepEqual(f.current().slice(-2), f.messages.slice(-2));
    assert.deepEqual(f.current().slice(0, 2), f.messages.slice(0, 2));
    assert.equal(f.current().length, 5);
    assert.equal(f.calls(), 1, 'flush never generates another summary');
    assert.match(await f.ext.handleFlushCommand(f.context, { kind: 'flush', undoIndex: 1 }), /restored/);
    assert.equal(JSON.stringify(f.current()), original);
  });

  it('refuses --yes without a semantic cache', async () => {
    const f = fixture();
    assert.match(await f.ext.handleFlushCommand(f.context, { kind: 'flush', yes: true }), /no valid.*summary|summary.*unavailable/i);
    assert.equal(f.replacements(), 0);
    assert.equal(f.calls(), 0);
  });

  for (const mutation of ['content', 'config', 'confirmation']) {
    it(`refuses ${mutation} changes instead of flushing a stale or unapproved region`, async () => {
      const f = fixture(); await f.ext.summarizeNow(f.context);
      if (mutation === 'content') f.messages[2].content = 'edited under the same id';
      if (mutation === 'config') configModule.saveConfig({ ...f.config, summarize: { ...f.config.summarize, maxSummaryChars: 999 } });
      if (mutation === 'confirmation') f.confirm(() => f.messages.push({ id: 'new', role: 'user', content: 'New context' } as ContextMessage));
      await f.ext.handleFlushCommand(f.context, { kind: 'flush' });
      assert.equal(f.replacements(), 0);
    });
  }

  it('refuses a valid covered flush when its undo history cannot be persisted', async () => {
    const f = fixture(); await f.ext.summarizeNow(f.context);
    const originalDir = process.env.BROKE_SNAPSHOTS_DIR;
    const blocked = join(root, 'blocked'); writeFileSync(blocked, 'file');
    process.env.BROKE_SNAPSHOTS_DIR = blocked;
    try {
      assert.match(await f.ext.handleFlushCommand(f.context, { kind: 'flush', yes: true }), /ABORTED/);
      assert.equal(f.replacements(), 0);
    } finally { process.env.BROKE_SNAPSHOTS_DIR = originalDir; }
  });
});
