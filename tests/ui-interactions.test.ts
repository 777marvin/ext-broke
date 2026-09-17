import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { transform } from 'sucrase';
import { ConfigSchema, DEFAULT_CONFIG } from '../config';
import { applyPreset } from '../presets';

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
  const js = transform(`const Component = ${readFileSync(file, 'utf8')}`, { transforms: ['typescript', 'jsx'], filePath: file }).code;
  return new Function('React', `${js}; return Component;`)(React);
}
let root: Root;
let container: HTMLDivElement;
let draft: any;
let persisted: any;
let calls: string[];
let action: (name: string, ...args: any[]) => Promise<any>;
async function mount(badge = false, initial = applyPreset(DEFAULT_CONFIG, 'long')) {
  draft = structuredClone(initial);
  persisted = structuredClone(initial);
  calls = [];
  action = async (name, ...args) => {
    calls.push(name);
    if (name === 'getConfig') return structuredClone(persisted);
    if (name === 'previewMode') return ConfigSchema.parse(applyPreset(ConfigSchema.parse(args[0]), args[1]));
    if (name === 'setConfig') { persisted = ConfigSchema.parse(args[0]); return { ok: true, config: persisted }; }
    return null;
  };
  container = win.document.createElement('div');
  win.document.body.append(container);
  root = createRoot(container);
  const Component = component(badge ? 'StatusBadge.jsx' : 'ConfigComponent.jsx');
  const App = () => {
    const [config, setConfig] = React.useState(draft);
    return h(Component, { config, data: { mode: initial.mode, autonomy: initial.autonomy }, ui,
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
    assert.equal(input('Task length').value, 'custom');
    await change('Task length', 'long');
    assert.equal(input('Max context chars').value, '60000');
    await change('Cache profile', 'auto');
    assert.equal(input('Task length').value, 'long');
    for (const label of ['Protected turns', 'Max lines', 'Max KB', 'Summarize only turns older']) {
      await number(label, label === 'Protected turns' ? '3' : '10');
      assert.equal(input('Task length').value, 'custom', label);
      await change('Task length', 'long');
    }
    await change('Compression level', 'truncate');
    assert.equal(input('Task length').value, 'custom');
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
    await change('Task length', 'short');
    await change('Task length', 'normal');
    await React.act(async () => first.resolve(old));
    assert.equal(input('Task length').value, 'normal');
    const second = deferred();
    action = (name, ...args) => name === 'previewMode' ? second.promise : base(name, ...args);
    await change('Task length', 'long');
    await change('Broke automation', 'manual');
    await React.act(async () => second.resolve(applyPreset(DEFAULT_CONFIG, 'long')));
    assert.equal(input('Broke automation').value, 'manual');
    assert.equal(input('Task length').value, 'normal');
  });
});

describe('F5 rendered badge dialog interactions', () => {
  it('previews, refreshes numeric inputs, cancels without writes, and saves mode/autonomy', async () => {
    await mount(true);
    await open();
    assert.ok(container.querySelector('dialog[open]'));
    assert.match(container.textContent!, /extension-wide/i);
    assert.match(container.textContent!, /Ollama.*cloud.*cost/i);
    await number('Max context chars', '70000');
    assert.equal(input('Task length').value, 'custom');
    await change('Task length', 'normal');
    assert.equal(input('Max context chars').value, '60000');
    await change('Broke automation', 'manual');
    await click(button('Cancel'));
    assert.equal(persisted.mode, 'long');
    assert.equal(persisted.autonomy, 'autonomous');
    assert.equal(calls.includes('setConfig'), false);
    await open();
    await change('Task length', 'short');
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
    await change('Task length', 'short');
    await click(button('Cancel'));
    await open();
    await React.act(async () => pending.resolve(applyPreset(DEFAULT_CONFIG, 'short')));
    assert.equal(input('Task length').value, 'long');
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
