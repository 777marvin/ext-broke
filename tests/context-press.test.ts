import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { transform } from 'sucrase';
import { DEFAULT_CONFIG, ConfigSchema } from '../config';
import { applyPreset } from '../presets';
import { composeUiTemplate } from '../scripts/ui-template-source.cjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
const win = dom.window;
Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
win.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
let root: Root | undefined;
let container: HTMLDivElement;
let persisted: any;
let calls: Array<{ name: string; args: any[] }>;
let action: (name: string, ...args: any[]) => Promise<any>;
const sample = (scope = 'task', netChars = 200) => ({
  scope, state: 'ready', recordingEnabled: true, generatedAt: 10, retainedFrom: 1, retainedTo: 2,
  skippedRecords: 0, unattributedRecords: 0, unknownPassRecords: 0, page: 0, pageSize: 60, totalRuns: 2,
  summary: { runs: 2, charsBefore: 1600, charsAfter: 1600 - netChars, netChars,
    passChars: { structural: 100, error: 20, truncate: 300, summarize: 0 }, reconciliationChars: netChars - 420 },
  taskExtras: null,
  runs: [
    { at: 1, charsBefore: 1000, charsAfter: 600, netChars: 400, passChars: { structural: 100, error: 20, truncate: 300, summarize: 0 }, reconciliationChars: -20 },
    { at: 2, charsBefore: 600, charsAfter: 800, netChars: -200, passChars: { structural: 0, error: 0, truncate: 0, summarize: 0 }, reconciliationChars: -200 },
  ],
});
async function mount(initial = applyPreset(DEFAULT_CONFIG, 'normal')) {
  persisted = structuredClone(initial); calls = [];
  action = async (name, ...args) => {
    calls.push({ name, args });
    if (name === 'getConfig') return structuredClone(persisted);
    if (name === 'getSetupState') return { version: 1, dismissed: true };
    if (name === 'previewMode') return applyPreset(ConfigSchema.parse(args[0]), args[1]);
    if (name === 'setConfig') { persisted = ConfigSchema.parse(args[0]); return { ok: true, config: persisted }; }
    if (name === 'getStatistics') return sample(args[0].scope);
    return null;
  };
  const code = transform(`const Component = ${composeUiTemplate(readFileSync('StatusBadge.jsx', 'utf8'))}`, { transforms: ['typescript', 'jsx'], filePath: 'StatusBadge.jsx' }).code;
  const Component = new Function('React', `${code}; return Component;`)(React);
  container = win.document.createElement('div'); win.document.body.append(container); root = createRoot(container);
  await React.act(async () => root!.render(React.createElement(Component, { data: { level: initial.level, mode: initial.mode, autonomy: initial.autonomy, inTask: true }, executeExtensionAction: (name: string, ...args: any[]) => action(name, ...args) })));
  await click(container.querySelector('button')!);
}
afterEach(async () => { if (root) await React.act(async () => root!.unmount()); root = undefined; container?.remove(); });
const button = (text: string) => {
  const el = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  assert.ok(el, `missing button ${text}`); return el;
};
const tab = (name: string) => {
  const el = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(b => b.textContent?.trim() === name);
  assert.ok(el, `missing tab ${name}`); return el;
};
async function click(el: HTMLElement) { await React.act(async () => el.click()); }
async function selectMode(mode: string) {
  const el = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${mode}"]`);
  assert.ok(el, `missing depth ${mode}`); await click(el);
}
async function selectScope(scope: string) {
  const el = container.querySelector<HTMLSelectElement>('select[aria-label="Statistics scope"]'); assert.ok(el);
  await React.act(async () => { el.value = scope; el.dispatchEvent(new win.Event('change', { bubbles: true })); });
}
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; }

describe('Context Press control', () => {
  it('selects cumulative canonical presets without saving or altering manual autonomy/backend', async () => {
    await mount({ ...applyPreset(DEFAULT_CONFIG, 'normal'), autonomy: 'manual', summarize: { ...DEFAULT_CONFIG.summarize, via: 'cloud' } });
    assert.ok(container.querySelector('.broke-context-press'));
    assert.equal(!!container.querySelector('dialog')!.closest('[role="status"]'), false, 'the interactive modal must not be nested in the badge live region');
    assert.equal(tab('Control').getAttribute('aria-selected'), 'true');
    await selectMode('long');
    assert.match(container.textContent!, /Clean.*Trim.*Summarize/s);
    assert.match(container.textContent!, /Unsaved changes/);
    assert.equal(calls.some(c => c.name === 'setConfig'), false);
    assert.equal(calls.some(c => c.name === 'getStatistics'), false, 'history is not fetched in Control');
    await click(button('Save'));
    assert.equal(persisted.mode, 'long'); assert.equal(persisted.autonomy, 'manual'); assert.equal(persisted.summarize.via, 'cloud');
  });
  it('does not falsely select a named preset for Custom and confirms dirty Escape while Cancel discards', async () => {
    await mount({ ...DEFAULT_CONFIG, mode: 'custom', maxContextChars: 72000 });
    assert.equal(container.querySelectorAll('input[type="radio"]:checked').length, 0);
    assert.match(container.textContent!, /Custom settings/);
    await selectMode('short');
    await React.act(async () => container.querySelector('dialog')!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    assert.match(container.textContent!, /Discard your changes/);
    await click(button('Keep editing'));
    assert.ok(container.querySelector('dialog[open]'));
    await click(button('Cancel'));
    assert.equal(persisted.maxContextChars, 72000);
    assert.equal(container.querySelector('dialog'), null);
  });
});

describe('Context Press recorded statistics', () => {
  it('keeps a valid chart explicitly stale after a refresh error and restores it on Retry', async () => {
    await mount(); await click(tab('Statistics'));
    const base = action;
    action = (name, ...args) => name === 'getStatistics' ? Promise.resolve({ error: { message: 'History read failed.' } }) : base(name, ...args);
    await click(tab('Control')); await click(tab('Statistics'));
    assert.equal(container.querySelector('[role="alert"]')?.getAttribute('data-stale'), 'true');
    assert.match(container.querySelector('[aria-labelledby="broke-statistics-tab"]')!.textContent!, /50/);
    action = base; await click(button('Retry'));
    assert.equal(container.querySelector('[role="alert"]'), null);
  });
  it('records only future runs after Save and does not treat missing history as a measured total', async () => {
    await mount(); const base = action;
    action = (name, ...args) => name === 'getStatistics' ? Promise.resolve({ ...sample(), state: 'empty', summary: null, runs: [], totalRuns: 0, recordingEnabled: false }) : base(name, ...args);
    await click(tab('Statistics'));
    assert.match(container.textContent!, /No runs recorded yet/);
    const recording = [...container.querySelectorAll('label')].find(el => el.textContent?.trim() === 'Record run history')?.querySelector<HTMLInputElement>('input');
    assert.ok(recording); await click(recording);
    assert.equal(calls.some(c => c.name === 'setConfig'), false);
    assert.match(container.textContent!, /Unsaved changes/);
    await click(button('Cancel'));
    assert.equal(persisted.stats.measure, true);
  });
  it('renders actual projected net/contributions, converts units and preserves signed runs', async () => {
    await mount(); await click(tab('Statistics'));
    const panel = container.querySelector('[role="tabpanel"][aria-labelledby="broke-statistics-tab"]'); assert.ok(panel);
    assert.match(panel.textContent!, /50/);
    assert.match(panel.textContent!, /Estimated tokens/i);
    await click(button('Characters'));
    assert.match(panel.textContent!, /200/);
    await click(button('Over time'));
    const negative = panel.querySelector<HTMLButtonElement>('button[data-net-chars="-200"]'); assert.ok(negative, 'negative net is a real selectable run');
    await click(negative);
    assert.match(panel.textContent!, /600.*800/s);
    assert.match(panel.textContent!, /added/i);
  });
  it('ignores a late task result after the user explicitly chooses retained history', async () => {
    await mount(); const base = action; const old = deferred();
    action = (name, ...args) => name === 'getStatistics' && args[0].scope === 'task' ? old.promise : base(name, ...args);
    await click(tab('Statistics'));
    assert.match(container.textContent!, /Loading recorded/i);
    await selectScope('retained');
    await React.act(async () => old.resolve(sample('task', 999999)));
    const panel = container.querySelector('[aria-labelledby="broke-statistics-tab"]')!;
    assert.doesNotMatch(panel.textContent!, /249,?999|999,?999/);
    assert.equal(container.querySelector<HTMLSelectElement>('select[aria-label="Statistics scope"]')!.value, 'retained');
  });
  it('does not report a clean task as partial for ledger lines it cannot attribute', async () => {
    await mount(); const base = action;
    action = (name, ...args) => name === 'getStatistics'
      ? Promise.resolve({ ...sample(args[0].scope), unattributedRecords: 3 })
      : base(name, ...args);
    await click(tab('Statistics'));
    const panel = container.querySelector('[aria-labelledby="broke-statistics-tab"]')!;
    assert.doesNotMatch(panel.textContent!, /Partial data/);
    assert.match(panel.textContent!, /3 ledger lines could not be attributed to a task and are excluded from this task/);
  });
  it('still flags partial data for skipped records that belong to the task', async () => {
    await mount(); const base = action;
    action = (name, ...args) => name === 'getStatistics'
      ? Promise.resolve({ ...sample(args[0].scope), state: 'partial', skippedRecords: 2, unattributedRecords: 3 })
      : base(name, ...args);
    await click(tab('Statistics'));
    const panel = container.querySelector('[aria-labelledby="broke-statistics-tab"]')!;
    assert.match(panel.textContent!, /Partial data: 2 malformed records skipped/);
  });
  it('distinguishes read failure from empty data and retries without writing config', async () => {
    await mount(); const base = action; let fail = true;
    action = (name, ...args) => name === 'getStatistics' && fail ? Promise.resolve({ error: { code: 'read-failed', message: 'History could not be read.' } }) : base(name, ...args);
    await click(tab('Statistics'));
    assert.match(container.textContent!, /History could not be read/);
    assert.doesNotMatch(container.textContent!, /No runs recorded yet/);
    fail = false; await click(button('Retry'));
    assert.match(container.textContent!, /Net reduction/i);
    assert.equal(calls.some(c => c.name === 'setConfig'), false);
  });
});
