import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { transform } from 'sucrase';
import { ConfigSchema, DEFAULT_CONFIG } from '../config';
import { applyPreset } from '../presets';
import { composeUiTemplate } from '../scripts/ui-template-source.cjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
const win = dom.window;
Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
// jsdom has no native dialog implementation; keyboard behavior is tested below.
before(() => {
  win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  win.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
const h = React.createElement;
const ui = {
  Select: ({ label, options, onChange, ...props }: any) => h('label', null, label, h('select', { ...props, onChange: (e: any) => onChange(e.target.value) }, options.map((o: any) => h('option', { key: o.value, value: o.value }, o.label)))),
  Input: ({ label, ...props }: any) => h('label', null, label, h('input', props)),
  Checkbox: ({ label, onChange, ...props }: any) => h('label', null, h('input', { ...props, type: 'checkbox', onChange: (e: any) => onChange(e.target.checked) }), label),
  Tooltip: ({ children }: any) => children,
};
function component(file: string): React.ComponentType<any> {
  const js = transform(`const Component = ${composeUiTemplate(readFileSync(file, 'utf8'))}`, { transforms: ['typescript', 'jsx'], filePath: file }).code;
  return new Function('React', `${js}; return Component;`)(React);
}
let root: Root;
let container: HTMLDivElement;
let draft: any;
let persisted: any;
let calls: string[];
let setupDismissed: boolean;
let action: (name: string, ...args: any[]) => Promise<any>;
async function mount(badge = false, initial = applyPreset(DEFAULT_CONFIG, 'long'), badgeData: Record<string, unknown> = {}, dismissed = true) {
  if (root) await React.act(async () => root.unmount());
  container?.remove();
  draft = structuredClone(initial);
  persisted = structuredClone(initial);
  calls = [];
  setupDismissed = dismissed;
  action = async (name, ...args) => {
    calls.push(name);
    if (name === 'getConfig') return structuredClone(persisted);
    if (name === 'getSetupState') return { version: 1, dismissed: setupDismissed };
    if (name === 'dismissSetup') { setupDismissed = true; return { version: 1, dismissed: true }; }
    if (name === 'getSetupReadiness') return {
      basic: { state: 'ready', heading: 'Basic compression is ready', detail: 'Balanced needs no extra software.' },
      backend: { state: 'not-needed', heading: 'No summary backend needed', detail: 'Basic compression works without Ollama.' },
      model: { state: 'not-needed', heading: 'No summary model needed', detail: 'No model is used for basic compression.' },
      automatic: { state: 'not-needed', heading: 'Automatic summaries are not selected', detail: 'Your current approach does not generate summaries.' },
    };
    if (name === 'previewMode') return ConfigSchema.parse(applyPreset(ConfigSchema.parse(args[0]), args[1]));
    if (name === 'setConfig') { persisted = ConfigSchema.parse(args[0]); return { ok: true, config: persisted }; }
    if (name === 'runCommand') return { ok: true, message: `ran ${args[0]}` };
    return null;
  };
  container = win.document.createElement('div');
  win.document.body.append(container);
  root = createRoot(container);
  const Component = component(badge ? 'StatusBadge.jsx' : 'ConfigComponent.jsx');
  const App = () => {
    const [config, setConfig] = React.useState(draft);
    return h(Component, { config, data: { mode: initial.mode, autonomy: initial.autonomy, ...badgeData }, ui,
      updateConfig: (next: any) => { draft = next; setConfig(next); },
      executeExtensionAction: (name: string, ...args: any[]) => action(name, ...args) });
  };
  await React.act(async () => root.render(h(App)));
}
afterEach(async () => { if (root) await React.act(async () => root.unmount()); container?.remove(); });
function input(label: string): HTMLInputElement | HTMLSelectElement {
  const el = [...container.querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith(label))?.querySelector('input,select');
  assert.ok(el, `missing field: ${label}`);
  return el as HTMLInputElement;
}
/** Narrowed accessor for attributes that only exist on <input>. */
function numberInput(label: string): HTMLInputElement {
  const el = input(label);
  assert.ok(el instanceof win.HTMLInputElement, `not a number field: ${label}`);
  return el as HTMLInputElement;
}
function button(text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  assert.ok(el, `missing button: ${text}`);
  return el;
}
async function change(label: string, value: string) {
  await React.act(async () => {
    const el = input(label);
    el.value = value;
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
}
async function number(label: string, value: string) {
  await React.act(async () => { const el = input(label); el.value = value; el.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true })); });
}
async function click(el: HTMLElement) { await React.act(async () => el.click()); }
async function open() { await click(container.querySelector('button')!); }
function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('F5 rendered settings interactions', () => {
  it('uses a single selector, shows scope/backend guidance, and immediately labels owned edits Custom', async () => {
    await mount();
    assert.match(container.textContent!, /extension-wide/i);
    assert.match(container.textContent!, /Ollama.*cloud.*cost/i);
    assert.equal(container.querySelectorAll('button[aria-pressed]').length, 0);
    await number('Max context chars', '72000');
    assert.equal(input('Savings approach').value, 'custom');
    await change('Savings approach', 'long');
    assert.equal(input('Max context chars').value, '60000');
    await change('Cache profile', 'auto');
    assert.equal(input('Savings approach').value, 'long');
    for (const label of ['Protected turns', 'Max lines', 'Max KB', 'Summarize only turns older']) {
      await number(label, label === 'Protected turns' ? '3' : '10');
      assert.equal(input('Savings approach').value, 'custom', label);
      await change('Savings approach', 'long');
    }
    await change('Compression level', 'truncate');
    assert.equal(input('Savings approach').value, 'custom');
    assert.equal(calls.includes('setConfig'), false, 'full settings edits remain host-owned drafts');
  });

  it('preserves owned edits and Custom when multiple fields publish before the next render', async () => {
    await mount();
    await React.act(async () => {
      const chars = input('Max context chars');
      chars.value = '72000';
      chars.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));
      const turns = input('Protected turns');
      turns.value = '3';
      turns.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));
      const lines = input('Max lines');
      lines.value = '80';
      lines.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));
      const kb = input('Max KB');
      kb.value = '8';
      kb.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));
      const autonomy = input('Broke automation');
      autonomy.value = 'manual';
      autonomy.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
    assert.equal(draft.maxContextChars, 72000);
    assert.equal(draft.protectedTurns, 3);
    assert.equal(draft.truncate.maxLines, 80);
    assert.equal(draft.truncate.maxKB, 8);
    assert.equal(draft.autonomy, 'manual');
    assert.equal(draft.mode, 'custom');
  });

  it('ignores stale previews after another selection or a newer unrelated draft edit', async () => {
    await mount();
    const base = action;
    const first = deferred();
    let old: any;
    action = (name, ...args) => { if (name === 'previewMode' && args[1] === 'short') { old = applyPreset(args[0], 'short'); return first.promise; } return base(name, ...args); };
    await change('Savings approach', 'short');
    await change('Savings approach', 'normal');
    await React.act(async () => first.resolve(old));
    assert.equal(input('Savings approach').value, 'normal');
    const second = deferred();
    action = (name, ...args) => name === 'previewMode' ? second.promise : base(name, ...args);
    await change('Savings approach', 'long');
    await change('Broke automation', 'manual');
    await React.act(async () => second.resolve(applyPreset(DEFAULT_CONFIG, 'long')));
    assert.equal(input('Broke automation').value, 'manual');
    assert.equal(input('Savings approach').value, 'normal');
  });
});

describe('F5 rendered badge dialog interactions', () => {
  it('previews, refreshes numeric inputs, cancels without writes, and saves mode/autonomy', async () => {
    await mount(true);
    await open();
    assert.ok(container.querySelector('dialog[open]'));
    assert.match(container.textContent!, /applies to every task/i);
    assert.match(container.textContent!, /Ollama.*cloud.*cost/i);
    await number('Max context chars', '70000');
    assert.equal(input('Savings approach').value, 'custom');
    await change('Savings approach', 'normal');
    assert.equal(input('Max context chars').value, '60000');
    await change('Broke automation', 'manual');
    await click(button('Cancel'));
    assert.equal(persisted.mode, 'long');
    assert.equal(persisted.autonomy, 'autonomous');
    assert.equal(calls.includes('setConfig'), false);
    await open();
    await change('Savings approach', 'short');
    await change('Broke automation', 'manual');
    await click(button('Save'));
    assert.equal(persisted.mode, 'short');
    assert.equal(persisted.autonomy, 'manual');
    assert.equal(container.querySelector('dialog'), null);
  });

  it('contains focus, handles Escape, restores gear focus and always allows Cancel after load failure', async () => {
    await mount(true);
    const gear = container.querySelector('button')!;
    gear.focus();
    await open();
    const dialog = container.querySelector('dialog')!;
    assert.ok(dialog.contains(win.document.activeElement));
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled)')];
    controls[controls.length - 1].focus();
    await React.act(async () => controls[controls.length - 1].dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    assert.equal(win.document.activeElement, controls[0]);
    await React.act(async () => controls[0].dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    assert.equal(container.querySelector('dialog'), null);
    assert.equal(win.document.activeElement, gear);
    action = async () => { throw new Error('load failed'); };
    await open();
    assert.match(container.textContent!, /could not load/i);
    await click(button('Cancel'));
    assert.equal(win.document.activeElement, gear);
  });

  it('discards late previews across Cancel/reopen and keeps errors visible on rejected saves', async () => {
    await mount(true);
    await open();
    const base = action;
    const pending = deferred();
    action = (name, ...args) => name === 'previewMode' ? pending.promise : base(name, ...args);
    await change('Savings approach', 'short');
    await click(button('Cancel'));
    await open();
    await React.act(async () => pending.resolve(applyPreset(DEFAULT_CONFIG, 'short')));
    assert.equal(input('Savings approach').value, 'long');
    action = async (name, ...args) => name === 'setConfig' ? { ok: false, config: persisted } : base(name, ...args);
    await click(button('Save'));
    assert.ok(container.querySelector('dialog[open]'));
    assert.match(container.textContent!, /invalid value/i);
    action = async () => { throw new Error('write failed'); };
    await click(button('Save'));
    assert.match(container.textContent!, /could not save/i);
    await click(button('Cancel'));
  });
});

describe('F7 everyday badge experience', () => {
  it('opens with a plain-language status and keeps technical controls collapsed', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'), {
      level: 'truncate',
      totalSavedTokens: 0,
      passes: 0,
      maxContextChars: 60000,
      observation: { inputChars: 31000, belowThreshold: true },
    });
    await open();

    assert.match(container.textContent!, /Broke is ready/i);
    assert.match(container.textContent!, /nothing else to set up/i);
    assert.equal(input('Savings approach').value, 'normal');
    assert.match(container.textContent!, /Balanced.*recommended/i);

    const advanced = [...container.querySelectorAll('details')].find((node) =>
      /Advanced settings and diagnostics/i.test(node.querySelector('summary')?.textContent ?? ''),
    );
    assert.ok(advanced, 'advanced disclosure exists');
    assert.equal(advanced.open, false, 'expert controls start collapsed');
    assert.ok(advanced.querySelector('label select'), 'existing expert controls remain available');
  });

  it('uses task-focused action labels and runs setup checks without exposing command syntax', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'));
    await open();

    const setup = button('Check setup');
    const savings = button('View savings');
    const explanation = button('Why no savings yet?');
    assert.doesNotMatch(setup.textContent ?? '', /\/broke/);
    assert.doesNotMatch(savings.textContent ?? '', /\/broke/);
    assert.doesNotMatch(explanation.textContent ?? '', /\/broke/);

    await click(setup);
    assert.deepEqual(calls.slice(-1), ['getSetupReadiness']);
    assert.match(container.textContent!, /Basic compression is ready/);
  });

  it('explains when local summaries need attention without implying all compression stopped', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'long'), {
      level: 'summarize',
      summarizerConfigured: 'local',
      ollama: { reachable: false, models: 0, error: 'offline' },
      totalSavedTokens: 0,
      passes: 0,
    });
    await open();

    assert.match(container.textContent!, /Local summaries need setup/i);
    assert.match(container.textContent!, /Basic compression still works/i);
  });

  it('does not leave the badge in an unsaved draft state after Cancel', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'), {
      level: 'truncate',
      totalSavedTokens: 0,
      passes: 0,
    });
    await open();
    await click(input('Use Broke automatically'));
    assert.match(container.textContent!, /Broke is off/i, 'the dialog previews the draft state');
    await click(button('Cancel'));

    const badge = container.querySelector('[role="status"]');
    assert.match(badge?.getAttribute('title') ?? '', /Broke is ready/i, 'Cancel restores the persisted badge state');
  });

  it('renders the status dot on the collapsed badge with color matching the state (F6)', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'), {
      level: 'truncate',
      totalSavedTokens: 1200,
      passes: 2,
    });

    const badge = container.querySelector('[role="status"]');
    const dot = badge?.querySelector('span[aria-hidden="true"]') as HTMLElement;
    assert.ok(dot, 'status dot exists in collapsed badge');
    assert.ok(dot.style.background === 'rgb(25, 99, 59)' || dot.style.background === '#19633b', 'green saving dot');
    assert.match(badge?.getAttribute('title') ?? '', /Broke is saving context/i);
    assert.match(badge?.getAttribute('aria-label') ?? '', /1,200 estimated input tokens saved/);
  });

  it('animates the violet status dot when optimization is actively running (F6)', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'), {
      level: 'truncate',
      isOptimizing: true,
      totalSavedTokens: 500,
      passes: 1,
    });

    const badge = container.querySelector('[role="status"]');
    const dot = badge?.querySelector('span[aria-hidden="true"]') as HTMLElement;
    assert.ok(dot, 'status dot exists');
    assert.ok(dot.style.background === 'rgb(112, 48, 160)' || dot.style.background === '#7030a0', 'violet compressing dot');
    assert.match(dot.style.animation, /broke-pulse/i, 'pulse animation active');
    assert.equal(badge?.getAttribute('title'), 'Broke is compressing context...');
    assert.equal(badge?.getAttribute('aria-label'), 'Broke is compressing context...');

    await open();
    assert.match(container.textContent!, /Broke is compressing/i, 'dialog reflects active compression');
  });

  it('shows the amber dot when local summaries need setup (F6)', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'long'), {
      level: 'summarize',
      summarizerConfigured: 'local',
      ollama: { reachable: false, models: 0, error: 'offline' },
      totalSavedTokens: 0,
      passes: 0,
    });

    const badge = container.querySelector('[role="status"]');
    const dot = badge?.querySelector('span[aria-hidden="true"]') as HTMLElement;
    assert.ok(dot.style.background === 'rgb(122, 85, 18)' || dot.style.background === '#7a5512', 'amber setup dot');
    assert.match(badge?.getAttribute('title') ?? '', /Local summaries need setup/i);
  });

  it('shows the red dot when off (F6)', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'), {
      level: 'off',
      totalSavedTokens: 0,
      passes: 0,
    });
    const badge = container.querySelector('[role="status"]');
    const dot = badge?.querySelector('span[aria-hidden="true"]') as HTMLElement;
    assert.ok(dot.style.background === 'rgb(138, 45, 36)' || dot.style.background === '#8a2d24', 'red off dot');
    assert.match(badge?.getAttribute('title') ?? '', /Broke is off/i);
  });

  it('separates observed reduction, provider usage, and modeled estimates when viewing savings (F6 Slice 2)', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'), {
      level: 'truncate',
      totalSavedTokens: 3113,
      passes: 3,
      savedTokens: { structural: 300, error: 2000, truncate: 813, summarize: 0 },
      observedReduction: { measuredChars: 12450, totalCharsBefore: 50000, totalCharsAfter: 37550 },
      cost: { savedUsd: 0.012, modelLabel: 'Claude 3.5 Sonnet' },
      providerUsage: { sentTokens: 4200, cacheReadTokens: 3500, cacheWriteTokens: 700, messageCost: 0.0045 },
      estimates: { slice: 500, flush: 1000, search: 200 },
    });
    await open();
    await click(button('View savings'));

    assert.ok(calls.includes('runCommand'), 'View savings executes stats');
    assert.match(container.textContent, /Observed Context Reduction/i);
    assert.match(container.textContent, /3,113/);
    assert.match(container.textContent, /12,450 chars/);
    assert.match(container.textContent, /Provider-Reported Usage/i);
    assert.match(container.textContent, /3,500.*read/i);
    assert.match(container.textContent, /A measurement ledger does not prove a billed saving/i);
    assert.match(container.textContent, /Modeled Monetary Estimate/i);
    assert.match(container.textContent, /Claude 3\.5 Sonnet/i);
    assert.match(container.textContent, /Avoided Context \(Counterfactuals\)/i);
    assert.match(container.textContent, /ran broke stats/);

    const dismiss = container.querySelector('button[aria-label="Dismiss result"]') as HTMLElement;
    assert.ok(dismiss, 'dismiss button exists');
    await click(dismiss);
    assert.doesNotMatch(container.textContent, /Savings & Usage Breakdown/);
  });

  it('handles missing provider usage and unpriced models honestly in the savings view (F6 Slice 2)', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'), {
      level: 'truncate',
      totalSavedTokens: 0,
      passes: 0,
      cost: { savedUsd: null, modelLabel: null },
      providerUsage: null,
      estimates: null,
    });
    await open();
    await click(button('View savings'));

    assert.match(container.textContent, /Awaiting next API call or not reported by current provider/i);
    assert.match(container.textContent, /No input rate registered for current model/i);
    assert.match(container.textContent, /A measurement ledger does not prove a billed saving/i);
  });
});

describe('F7.2 guided setup', () => {
  it('does not call an installed backend ready when its configured model is missing', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'long'), {
      level: 'summarize', summarizerConfigured: 'local', ollama: { reachable: true, models: 1 },
      setupReadiness: {
        backend: { state: 'ready', heading: 'Ollama is reachable', detail: 'Metadata only.' },
        model: { state: 'unavailable', heading: 'Configured model is not installed', detail: 'Install the configured model, then check again.' },
        automatic: { state: 'unavailable', heading: 'Automatic summaries need setup', detail: 'The configured model is missing.' },
      },
    });
    assert.match(container.querySelector('[role=status]')!.getAttribute('aria-label')!, /model.*not installed/i);
    await open();
    assert.match(container.querySelector('dialog [role=status]')!.textContent!, /model.*not installed/i);
    assert.doesNotMatch(container.querySelector('dialog [role=status]')!.textContent!, /nothing else to set up/i);
  });

  it('keeps a manually reopened guide visible when its initial state arrives late', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'));
    const pending = deferred();
    const base = action;
    action = (name, ...args) => name === 'getSetupState' ? pending.promise : base(name, ...args);
    await open();
    await click(button('Setup guide'));
    await React.act(async () => pending.resolve({ version: 1, dismissed: true }));
    assert.match(container.textContent!, /Welcome to Broke/);
  });

  it('restores focus after an asynchronous introduction dismissal has enabled the target', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'), {}, false);
    await open();
    const pending = deferred();
    const base = action;
    action = (name, ...args) => name === 'dismissSetup' ? pending.promise : base(name, ...args);
    button('Got it').focus();
    await click(button('Got it'));
    assert.equal(button('Setup guide').disabled, true);
    await React.act(async () => pending.resolve({ version: 1, dismissed: true }));
    assert.equal(document.activeElement === button('Setup guide'), true, 'focus returns to the enabled Setup guide button');
  });

  it('introduces a fresh user without changing settings or probing a backend, and remembers Skip', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'), {}, false);
    await open();
    assert.match(container.textContent!, /Welcome to Broke/);
    assert.match(container.textContent!, /Balanced.*recommended/i);
    assert.match(container.textContent!, /every task/i);
    assert.equal(calls.includes('getSetupReadiness'), false, 'opening alone never contacts a backend');
    await click(button('Skip introduction'));
    assert.equal(setupDismissed, true);
    assert.equal(calls.includes('setConfig'), false);
    await click(button('Cancel'));
    await open();
    assert.doesNotMatch(container.textContent!, /Welcome to Broke/);
    await click(button('Setup guide'));
    assert.match(container.textContent!, /Welcome to Broke/);
    await click(button('Got it'));
    assert.doesNotMatch(container.textContent!, /Welcome to Broke/);
  });

  it('preserves Off, Custom and manual settings when cancelling the introduction', async () => {
    const initial = { ...DEFAULT_CONFIG, enabled: false, mode: 'custom' as const, autonomy: 'manual' as const };
    await mount(true, initial, {}, false);
    await open();
    assert.match(container.textContent!, /Broke is off/);
    await click(button('Cancel'));
    assert.equal(setupDismissed, false, 'Cancel must not mark the introduction as finished');
    assert.deepEqual(persisted, initial);
    assert.equal(calls.includes('dismissSetup'), false);
    assert.equal(document.activeElement, container.querySelector('button'));
  });

  it('shows a recoverable dismissal error without losing the settings draft', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'), {}, false);
    await open();
    await number('Max context chars', '72000');
    const base = action;
    action = (name, ...args) => name === 'dismissSetup' ? Promise.reject(new Error('disk full')) : base(name, ...args);
    await click(button('Got it'));
    assert.match(container.querySelector('[role=alert]')!.textContent!, /could not save.*introduction/i);
    assert.equal(input('Max context chars').value, '72000');
    action = base;
    await click(button('Got it'));
    assert.equal(setupDismissed, true);
    assert.equal(calls.includes('setConfig'), false);
  });

  it('announces pending checks and ignores results after a draft edit or Cancel/reopen', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'));
    await open();
    const pending = deferred();
    const base = action;
    action = (name, ...args) => name === 'getSetupReadiness' ? pending.promise : base(name, ...args);
    await click(button('Check setup'));
    assert.match(container.textContent!, /Checking setup/);
    assert.equal(button('Check setup').disabled, true);
    await number('Max context chars', '72000');
    await click(button('Cancel'));
    await open();
    await React.act(async () => pending.resolve({ basic: { heading: 'STALE RESULT', detail: 'wrong draft' } }));
    assert.doesNotMatch(container.textContent!, /STALE RESULT|Checking setup/);
  });

  it('checks the unsaved draft without persisting it and keeps the synthetic test in diagnostics', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'));
    await open();
    await change('Savings approach', 'long');
    let checked: any;
    const base = action;
    action = (name, ...args) => {
      if (name === 'getSetupReadiness') checked = args[0];
      return base(name, ...args);
    };
    await click(button('Check setup'));
    assert.equal(checked.mode, 'long');
    assert.equal(persisted.mode, 'normal');
    assert.equal(calls.includes('setConfig'), false);
    const advanced = [...container.querySelectorAll('details')].find(n => /Advanced settings/.test(n.querySelector('summary')?.textContent ?? ''))!;
    assert.match(advanced.textContent!, /synthetic.*stub summarizer/i);
    assert.match(advanced.textContent!, /\/broke.*selftest/);
  });

  it('keeps failed checks visible and allows retry', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'));
    await open();
    const base = action;
    action = (name, ...args) => name === 'getSetupReadiness' ? Promise.reject(new Error('offline')) : base(name, ...args);
    await click(button('Check setup'));
    assert.match(container.querySelector('[role=alert]')!.textContent!, /could not check.*setup/i);
    assert.equal(button('Check setup').disabled, false);
    action = base;
    await click(button('Check setup'));
    assert.match(container.textContent!, /Basic compression is ready/);
  });

  it('restores focus after a pending check blurs its disabled button without stealing a field focus', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'));
    await open();
    const base = action;
    const pending = deferred();
    action = (name, ...args) => name === 'getSetupReadiness' ? pending.promise : base(name, ...args);
    button('Check setup').focus();
    await click(button('Check setup'));
    button('Check setup').blur(); // Browser engines blur a disabled, focused button.
    await React.act(async () => pending.resolve(await base('getSetupReadiness')));
    assert.equal(document.activeElement === button('Check setup'), true);

    const next = deferred();
    action = (name, ...args) => name === 'getSetupReadiness' ? next.promise : base(name, ...args);
    await click(button('Check setup'));
    input('Savings approach').focus();
    await React.act(async () => next.resolve(await base('getSetupReadiness')));
    assert.equal(document.activeElement === input('Savings approach'), true);
  });
});

describe('L2 search fields mirror the schema bounds', () => {
  it('carries the schema min/max on both search number fields', async () => {
    await mount(false, applyPreset(DEFAULT_CONFIG, 'long'));
    const budget = numberInput('Total char budget per query');
    const size = numberInput('Skip files larger than (KB)');
    assert.equal(budget.min, '500');
    assert.equal(budget.max, '50000');
    assert.equal(size.min, '1');
    assert.equal(size.max, '2048');
  });

  it('resets an out-of-schema search maxChars to the last valid value', async () => {
    await mount(false, applyPreset(DEFAULT_CONFIG, 'long'));
    await number('Total char budget per query', '100');
    assert.equal(input('Total char budget per query').value, '6000', 'below the floor resets');
    await number('Total char budget per query', '60000');
    assert.equal(input('Total char budget per query').value, '6000', 'above the ceiling resets');
  });

  it('resets an out-of-schema search maxFileKB to the last valid value', async () => {
    await mount(false, applyPreset(DEFAULT_CONFIG, 'long'));
    await number('Skip files larger than (KB)', '0');
    assert.equal(input('Skip files larger than (KB)').value, '512', 'below the floor resets');
    await number('Skip files larger than (KB)', '5000');
    assert.equal(input('Skip files larger than (KB)').value, '512', 'above the ceiling resets');
  });

  it('still commits an in-range search value', async () => {
    await mount(false, applyPreset(DEFAULT_CONFIG, 'long'));
    // Assert the published draft, not the uncontrolled input's DOM value -
    // numberField re-keys on change, which the rest of this suite also
    // avoids depending on.
    await number('Total char budget per query', '12000');
    assert.equal(draft.search.maxChars, 12000);
    await number('Skip files larger than (KB)', '2048');
    assert.equal(draft.search.maxFileKB, 2048, 'the ceiling itself is still accepted');
  });
});

describe('H1 quick commands in the badge overlay', () => {
  const quick = (label: string): HTMLButtonElement => {
    const el = [...container.querySelectorAll('button')].find((b) => /\/broke/.test(b.textContent ?? '') && b.textContent?.trim().endsWith(label));
    assert.ok(el, `missing quick command: ${label}`);
    return el as HTMLButtonElement;
  };

  it('runs a read-only command on the first click and shows the result', async () => {
    await mount(true);
    await open();
    await click(quick('stats'));
    assert.ok(calls.includes('runCommand'), 'the click reaches the extension');
    assert.match(container.textContent!, /ran broke stats/, 'the result is shown, not swallowed');
    assert.doesNotMatch(quick('stats').textContent ?? '', /Confirm\?/, 'read-only commands need no confirmation');
  });

  it('requires a second click for state-changing or spending commands', async () => {
    await mount(true);
    await open();
    for (const label of ['reset', 'summarize now']) {
      calls.length = 0;
      await click(quick(label));
      assert.equal(calls.length, 0, `${label} must not run on the first click`);
      assert.match(quick(label).textContent ?? '', /Confirm\?/, `${label} is armed`);
      await click(quick(label));
      assert.ok(calls.includes('runCommand'), `${label} runs on the confirm click`);
      assert.doesNotMatch(quick(label).textContent ?? '', /Confirm\?/, `${label} is disarmed after running`);
    }
  });

  it('surfaces a rejected command instead of failing silently', async () => {
    await mount(true);
    await open();
    const base = action;
    action = async (name, ...args) => name === 'runCommand' ? { ok: false, error: `unsupported quick command '${args[0]}'` } : base(name, ...args);
    await click(quick('why'));
    assert.match(container.textContent!, /unsupported quick command/i);

    action = async () => { throw new Error('host exploded'); };
    await click(quick('why'));
    assert.match(container.textContent!, /could not be run/i);
  });

  it('disarms a pending confirmation when the overlay is closed and reopened', async () => {
    await mount(true);
    await open();
    await click(quick('reset'));
    assert.match(quick('reset').textContent ?? '', /Confirm\?/);
    await click(button('Cancel'));
    await open();
    assert.doesNotMatch(quick('reset').textContent ?? '', /Confirm\?/, 'state does not survive a close');
    assert.doesNotMatch(container.textContent!, /ran broke/, 'the stale result is gone too');
  });

  it('supports interactive 3-step onboarding with readiness check and Command Studio launch', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'), {}, false);
    await open();

    assert.match(container.textContent!, /Step 1: Choose your operating approach/);
    await click(button('2. Readiness'));
    assert.match(container.textContent!, /Step 2: Verify readiness in one click/);
    await click(button('Run Readiness Check Now'));
    assert.ok(calls.includes('getSetupReadiness'), 'onboarding step 2 triggers setup readiness check');

    await click(button('3. Command Studio'));
    assert.match(container.textContent!, /Step 3: Every command is clickable in the UI/);
    await click(button('Try: Check Search Index'));
    assert.match(container.textContent!, /ran broke index status/);

    await click(button('Explore All Commands'));
    const advanced = [...container.querySelectorAll('details')].find((node) =>
      /Advanced settings and diagnostics/i.test(node.querySelector('summary')?.textContent ?? ''),
    );
    assert.equal(advanced?.open, true, 'Explore All Commands opens the Command Studio disclosure');
  });

  it('executes parameterized commands and universal commands from the Command Studio', async () => {
    await mount(true, applyPreset(DEFAULT_CONFIG, 'normal'));
    await open();

    await click(button('Open Command Studio (All Commands)'));

    const setField = async (ariaLabel: string, value: string) => {
      const el = container.querySelector(`input[aria-label="${ariaLabel}"]`) as HTMLInputElement;
      assert.ok(el, `missing input: ${ariaLabel}`);
      await React.act(async () => {
        const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(el, value);
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true }));
      });
    };

    // 1. Search query (read-only: runs on first click)
    await setField('Search query', 'compressMessages');
    await click(button('Run search'));
    assert.match(container.textContent!, /ran broke search compressMessages/);

    // 2. Diff budget (read-only: runs on first click)
    await setField('Diff char budget', '4500');
    await click(button('Run diff'));
    assert.match(container.textContent!, /ran broke diff 4500/);

    // 3. Snapshot label (mutating: 2-step confirmation)
    await setField('Snapshot label', 'before-refactor');
    await click(button('Save snapshot'));
    assert.ok(container.querySelector('button')?.textContent !== undefined);
    await click(button('Confirm?'));
    assert.match(container.textContent!, /ran broke snapshot before-refactor/);

    // 4. Universal command bar (read-only vs mutating)
    await setField('Universal broke command', 'slice status');
    await click(button('Execute'));
    assert.match(container.textContent!, /ran broke slice status/);

    // 5. Verify no crosstalk: 1-click snapshot does not arm the Save snapshot button
    const snapshotOneClick = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === '/broke snapshot')!;
    await click(snapshotOneClick);
    assert.match(snapshotOneClick.textContent ?? '', /Confirm\?/);
    const saveSnapshotBtn = [...container.querySelectorAll('button')].find((b) => /Save snapshot/i.test(b.textContent ?? ''));
    assert.ok(saveSnapshotBtn, 'Save snapshot button must exist');
    assert.doesNotMatch(saveSnapshotBtn.textContent ?? '', /Confirm\?/, '1-click snapshot must not arm parameterized button');

    // 6. Running /broke reset triggers UI refresh
    const resetOneClick = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === '/broke reset')!;
    await click(resetOneClick);
    await click(resetOneClick);
    assert.ok(calls.includes('refresh'), '/broke reset must trigger UI refresh');
  });

  it('supports ST-slicing, per-tool truncation rules, and command deck in ConfigComponent', async () => {
    await mount(false, applyPreset(DEFAULT_CONFIG, 'normal'));

    // Toggle ST-slicing
    await click(input('Enable ST-slicing'));
    assert.equal(draft.slice.enabled, true);

    // Toggle message menu
    await click(input("Show 'broke: why' in the per-message dropdown menu"));
    assert.equal(draft.ui.showMessageMenu, true);

    // Run read-only command in the settings maintenance deck
    const indexStatusBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === '/broke index status')!;
    await click(indexStatusBtn);
    assert.match(container.textContent!, /ran broke index status/);

    // Run mutating command (2-step confirm) in the settings maintenance deck
    const clearBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === '/broke errors clear')!;
    await click(clearBtn);
    assert.match(clearBtn.textContent ?? '', /Confirm\?/);
    await click(clearBtn);
    assert.match(container.textContent!, /ran broke errors clear/);
    assert.ok(calls.includes('getConfig'), 'deck commands sync host config after execution');

    // Add per-tool truncation rule
    const setToolField = async (label: string, value: string) => {
      const el = input(label);
      assert.ok(el instanceof win.HTMLInputElement);
      await React.act(async () => {
        const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(el, value);
        el.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true }));
      });
    };
    await setToolField('Tool name', 'bash');
    await setToolField('Tool max lines', '150');
    await setToolField('Tool max KB', '15');
    await click(button('Add / Update Rule'));
    assert.deepEqual(draft.truncate.tools?.bash, { enabled: true, maxLines: 150, maxKB: 15 });

    // Toggle Exempt: preserves limits (Bug 2 fix)
    await click(button('Exempt'));
    assert.deepEqual(draft.truncate.tools?.bash, { enabled: false, maxLines: 150, maxKB: 15 });

    // Toggle Enable: preserves limits
    await click(button('Enable'));
    assert.deepEqual(draft.truncate.tools?.bash, { enabled: true, maxLines: 150, maxKB: 15 });

    // Reset rule: deletes entry completely (Bug 1 fix)
    await click(button('Reset'));
    assert.equal(draft.truncate.tools?.bash, undefined);
  });
});
