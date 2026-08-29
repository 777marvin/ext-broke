import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SLICEABLE_EXT,
  extractTargetPath,
  isEditTool,
  isReadTool,
  isSliceablePath,
  sliceInterfaces,
  sliceMarker,
  slicePathKey,
  sliceWithFocus,
  sameSlicePath,
} from '../slice';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A realistic mid-size TypeScript module (~60 lines) with mixed content. */
const TS_FIXTURE = [
  "import { join } from 'node:path';",
  "import {",
  "  Invoice,",
  "  Payment,",
  "} from './types';",
  "import * as fs from 'node:fs';",
  '',
  '/** Billing domain logic. */',
  'export interface Invoice {',
  '  id: string;',
  '  totalCents: number;',
  '  paidAt?: Date;',
  '}',
  '',
  'export type InvoiceState = "draft" | "sent" | "paid";',
  '',
  'const INTERNAL_TAX_RATE = 0.19;',
  '',
  'function computeTax(cents: number): number {',
  '  const rate = cents > 100 ? INTERNAL_TAX_RATE : 0;',
  '  return Math.round(cents * rate);',
  '}',
  '',
  '@Component()',
  'export class InvoiceService {',
  '  private cache = new Map<string, Invoice>();',
  '',
  '  @Inject(PaymentGateway)',
  '  private gateway!: PaymentGateway;',
  '',
  '  async issue(invoice: Invoice): Promise<void> {',
  '    await this.gateway.charge(invoice.totalCents);',
  '    this.cache.set(invoice.id, invoice);',
  '  }',
  '',
  '  total(): number {',
  '    return [...this.cache.values()].reduce((sum, i) => sum + i.totalCents, 0);',
  '  }',
  '}',
  '',
  'export async function loadInvoice(path: string): Promise<Invoice> {',
  '  const raw = await fs.promises.readFile(join(path, "invoice.json"), "utf-8");',
  '  return JSON.parse(raw) as Invoice;',
  '}',
].join('\n');

/** A realistic Python module with docstring, imports and classes. */
const PY_FIXTURE = [
  '"""Billing domain logic.',
  '',
  'This module invoices and payments.',
  'More documentation follows here.',
  'Even more lines that should be cut after five.',
  'Still counting toward the docstring budget.',
  'And another line beyond the docstring budget.',
  '"""',
  'import os',
  'from dataclasses import dataclass, field',
  'from typing import Optional',
  '',
  'INTERNAL_TAX_RATE = 0.19',
  '',
  '',
  '@dataclass',
  'class Invoice:',
  '    """One invoice."""',
  '',
  '    id: str',
  '    total_cents: int',
  '',
  '    def total(self, tax: bool = False) -> int:',
  '        rate = self.total_cents * 0.1 if tax else 1.0',
  '        return round(self.total_cents * rate)',
  '',
  '    def mark_paid(self) -> None:',
  '        self.paid_at = os.times()[4]',
].join('\n');

// ---------------------------------------------------------------------------
// Extension mapping & path rules
// ---------------------------------------------------------------------------

describe('SLICEABLE_EXT / sliceable paths', () => {
  it('maps known extensions to their language', () => {
    assert.equal(SLICEABLE_EXT['.ts'], 'ts');
    assert.equal(SLICEABLE_EXT['.tsx'], 'ts');
    assert.equal(SLICEABLE_EXT['.js'], 'ts');
    assert.equal(SLICEABLE_EXT['.jsx'], 'ts');
    assert.equal(SLICEABLE_EXT['.mts'], 'ts');
    assert.equal(SLICEABLE_EXT['.cts'], 'ts');
    assert.equal(SLICEABLE_EXT['.py'], 'py');
  });

  it('skips vendor/build directories regardless of extension', () => {
    assert.equal(isSliceablePath('src/billing/service.ts'), true);
    assert.equal(isSliceablePath('node_modules/zod/index.js'), false);
    assert.equal(isSliceablePath('dist\\bundle.js'), false);
    assert.equal(isSliceablePath('.aider-desk/tasks/x.py'), false);
    assert.equal(isSliceablePath('vendor/lib.py'), false);
  });
});

// ---------------------------------------------------------------------------
// TypeScript slicing
// ---------------------------------------------------------------------------

describe('sliceInterfaces - ts', () => {
  const view = sliceInterfaces(TS_FIXTURE, 'ts');

  it('keeps imports (single and multi-line)', () => {
    assert.ok(view.text.includes("import { join } from 'node:path';"));
    assert.ok(view.text.includes("} from './types';"));
    assert.ok(view.text.includes("import * as fs from 'node:fs';"));
  });

  it('keeps interface and type declarations in full', () => {
    assert.ok(view.text.includes('export interface Invoice {'));
    assert.ok(view.text.includes('  paidAt?: Date;'));
    assert.ok(view.text.includes('export type InvoiceState = "draft" | "sent" | "paid";'));
  });

  it('elides function bodies behind a marker', () => {
    assert.ok(view.text.includes('function computeTax(cents: number): number { /* … */ }'));
    assert.ok(!view.text.includes('Math.round(cents * rate)'), 'implementation detail must be gone');
    assert.ok(view.text.includes('export async function loadInvoice(path: string): Promise<Invoice> { /* … */ }'));
  });

  it('keeps the class signature and decorated members, elides undecorated ones', () => {
    assert.ok(view.text.includes('export class InvoiceService { /* … */ }') === false);
    assert.ok(view.text.includes('@Component()'));
    assert.ok(view.text.includes('export class InvoiceService'));
    assert.ok(view.text.includes('@Inject(PaymentGateway)'));
    assert.ok(view.text.includes('private gateway!: PaymentGateway;'), 'decorated property signature stays');
    assert.ok(!view.text.includes('this.cache.set'), 'method bodies must be gone');
  });

  it('reports honest line counts and shrinks the fixture', () => {
    assert.equal(view.originalLines, TS_FIXTURE.split('\n').length);
    assert.ok(view.keptLines < view.originalLines);
    assert.ok(view.text.length < TS_FIXTURE.length);
    // No runs of more than one consecutive blank line survive.
    assert.ok(!view.text.includes('\n\n\n'));
  });
});

// ---------------------------------------------------------------------------
// Python slicing
// ---------------------------------------------------------------------------

describe('sliceInterfaces - py', () => {
  const view = sliceInterfaces(PY_FIXTURE, 'py');

  it('keeps the module docstring but only the first 5 lines', () => {
    assert.ok(view.text.includes('Billing domain logic.'));
    assert.ok(!view.text.includes('beyond the docstring budget'));
  });

  it('keeps imports', () => {
    assert.ok(view.text.includes('from dataclasses import dataclass, field'));
  });

  it('keeps class headers and def signatures, elides bodies', () => {
    assert.ok(view.text.includes('@dataclass'));
    assert.ok(view.text.includes('class Invoice:'));
    assert.ok(view.text.includes('    id: str'), 'dataclass field declarations are the contract');
    assert.ok(view.text.includes('def total(self, tax: bool = False) -> int: …'));
    assert.ok(view.text.includes('def mark_paid(self) -> None: …'));
    assert.ok(!view.text.includes('self.total_cents * rate'), 'method bodies must be gone');
    assert.ok(!view.text.includes('rate = self.total_cents'), 'assignment bodies must be gone');
  });

  it('shrinks the fixture honestly', () => {
    assert.equal(view.originalLines, PY_FIXTURE.split('\n').length);
    assert.ok(view.keptLines < view.originalLines);
  });
});

// ---------------------------------------------------------------------------
// Focus resolution
// ---------------------------------------------------------------------------

describe('sliceWithFocus', () => {
  it('slices normally when there is no focus', () => {
    const view = sliceWithFocus(TS_FIXTURE, 'ts', null, 'src/a.ts');
    assert.deepEqual(view, sliceInterfaces(TS_FIXTURE, 'ts'));
  });

  it('slices normally when the focus points at another file', () => {
    const view = sliceWithFocus(TS_FIXTURE, 'ts', { file: 'src/other.ts' }, 'src/a.ts');
    assert.deepEqual(view, sliceInterfaces(TS_FIXTURE, 'ts'));
  });

  it('returns the full file untouched when this file is the focus (no symbol)', () => {
    const view = sliceWithFocus(TS_FIXTURE, 'ts', { file: 'SRC\\A.TS' }, 'src/a.ts');
    assert.equal(view.text, TS_FIXTURE);
    assert.equal(view.keptLines, view.originalLines);
  });

  it('keeps the full body of a resolvable focus symbol, slices the rest', () => {
    const view = sliceWithFocus(TS_FIXTURE, 'ts', { file: 'src/a.ts', symbol: 'loadInvoice' }, 'src/a.ts');
    assert.ok(view.text.includes('return JSON.parse(raw) as Invoice;'), 'focus symbol body must survive in full');
    assert.ok(!view.text.includes('await this.gateway.charge'), 'non-focus bodies stay elided');
  });

  it('falls back to the full file when the focus symbol does not exist', () => {
    const view = sliceWithFocus(TS_FIXTURE, 'ts', { file: 'src/a.ts', symbol: 'nope' }, 'src/a.ts');
    assert.equal(view.text, TS_FIXTURE);
  });
});

// ---------------------------------------------------------------------------
// Marker & tool detection (used by the hooks)
// ---------------------------------------------------------------------------

describe('sliceMarker', () => {
  it('renders kept/original line counts', () => {
    const view = sliceInterfaces(TS_FIXTURE, 'ts');
    const marker = sliceMarker(view);
    assert.ok(marker.startsWith('[broke: interface view - '));
    assert.ok(marker.includes(`${view.keptLines} of ${view.originalLines} lines`));
    assert.ok(marker.includes('/broke slice off'));
  });
});

describe('fail-safe export pass-through (review R6)', () => {
  /** The view must carry the statement's FIRST line verbatim. */
  const keeps = (src: string, needle: string): void => {
    const view = sliceInterfaces(src, 'ts');
    assert.ok(
      view.text.includes(needle),
      `expected the API surface to survive:\n---\n${view.text}\n---\nmissing: ${needle}`,
    );
  };

  it('keeps `export default class` (previously dropped entirely)', () => {
    keeps('export default class Foo {}\nconst x = 1;\n', 'export default class Foo {}');
  });

  it('keeps a multi-line `export default class` with members', () => {
    const src = ['export default class Widget {', '  render(): void {', '    return this.state;', '  }', '}', ''].join('\n');
    keeps(src, 'export default class Widget {');
    // Body elision is NOT applied to pass-through statements - full text stays.
    const view = sliceInterfaces(src, 'ts');
    assert.ok(view.text.includes('return this.state;'));
  });

  it('keeps `export default function` (elided via the function path)', () => {
    // The named-function pattern already matches default functions - the
    // view shows the signature with an elided body, consistent with every
    // other function declaration.
    const view = sliceInterfaces('export default function main(): void {}\n', 'ts');
    assert.ok(view.text.includes('export default function main(): void { /* … */ }'));
  });

  it('keeps a multiline `export default { ... }` object export', () => {
    keeps('export default {\n  foo: 1,\n  bar: 2,\n};\n', 'bar: 2,');
  });

  it('keeps `export =` assignments', () => {
    keeps('export = Foo;\n', 'export = Foo;');
  });

  it('keeps `declare module` ambient blocks', () => {
    const src = 'declare module "left-pad" {\n  export function pad(s: string): string;\n}\n';
    keeps(src, 'declare module "left-pad" {');
    keeps(src, 'export function pad(s: string): string;');
  });

  it('keeps `declare global` blocks', () => {
    keeps('declare global {\n  interface Window { broke?: boolean; }\n}\n', 'interface Window {');
  });

  it('does not crash on JSX, regex literals or brace-heavy template literals', () => {
    const src = [
      'import React from "react";',
      'export function App(): JSX.Element {',
      '  const re = /[{}]/g;',
      '  const s = `${a.b} { }`;',
      '  return <div className={re ? "x" : "y"}>{s}</div>;',
      '}',
      'export default App;',
    ].join('\n');
    const view = sliceInterfaces(src, 'ts');
    assert.ok(view.text.includes('export function App'));
    assert.ok(!view.text.includes('className='), 'body must be elided');
  });

  it('still elides plain implementation code (no false positives)', () => {
    // Short const lines survive by design; the point is that statements NOT
    // starting with export/declare never take the pass-through path.
    const view = sliceInterfaces('const a = 1;\nrunInternal(a);\ncleanup(a, b, c);\n', 'ts');
    assert.ok(!view.text.includes('runInternal'));
    assert.ok(!view.text.includes('cleanup'));
  });

  it('does not treat CJS `exports.x = ...` as an ESM export block', () => {
    // 'exports' does not match /^export\b/ - stays an implementation detail.
    const view = sliceInterfaces('exports.helper = helper;\n', 'ts');
    assert.ok(!view.text.includes('exports.helper'));
  });

  it('keeps generic and abstract declarations through their normal paths', () => {
    keeps('export class Repo<T> { find(id: string): T | undefined { return undefined; } }\n', 'export class Repo<T>');
    keeps('abstract class Base { abstract run(): void; }\n', 'abstract class Base');
  });
});

describe('tool detection', () => {
  it('detects known read tools carrying a path field', () => {
    assert.equal(isReadTool('power---file_read', { filePath: 'src/a.ts' }), true);
    assert.equal(isReadTool('read_file', { path: 'src/a.ts' }), true);
    assert.equal(isReadTool('power---file_read', { query: 'x' }), false, 'no path field -> not a read');
  });

  it('detects edit tools and ignores command tools', () => {
    assert.equal(isEditTool('power---file_edit', { filePath: 'src/a.ts' }), true);
    assert.equal(isEditTool('write_file', { path: 'src/a.ts' }), true);
    assert.equal(isEditTool('power---bash', { command: 'echo hi' }), false);
  });

  it('extracts the target path with a stable priority', () => {
    assert.equal(extractTargetPath({ filePath: 'a.ts', path: 'b.ts' }), 'a.ts');
    assert.equal(extractTargetPath({ path: 'b.ts' }), 'b.ts');
    assert.equal(extractTargetPath({ file: 'c.ts' }), 'c.ts');
    assert.equal(extractTargetPath({ command: 'ls' }), null);
    assert.equal(extractTargetPath(undefined), null);
  });
});

describe('slicePathKey (D5: relative resolution against the task dir)', () => {
  it('resolves relative paths against the task dir', () => {
    assert.equal(slicePathKey('src/a.ts', 'C:\\proj'), 'c:/proj/src/a.ts');
  });

  it('keeps absolute paths normalized but unchanged', () => {
    assert.equal(slicePathKey('D:\\Repo\\SRC\\a.TS', 'c:/other'), 'd:/repo/src/a.ts');
  });

  it('matches a relative tool path against an absolute stored focus', () => {
    assert.equal(sameSlicePath('src/a.ts', 'C:\\proj\\src\\a.ts', 'c:\\proj'), true);
    assert.equal(sameSlicePath('C:/proj/src/a.ts', 'src\\A.TS', 'C:\\Proj'), true);
  });

  it('does not match when the base produces a different file', () => {
    assert.equal(sameSlicePath('src/a.ts', 'C:\\other\\src\\a.ts', 'c:\\proj'), false);
  });

  it('behaves like before when no base is available', () => {
    assert.equal(sameSlicePath('SRC/A.ts', 'src\\a.ts'), true);
  });
});

describe('BRK-020: heuristic fail-open hardening (external review 2026-08-29)', () => {
  it('keeps exported object/const initializers COMPLETE - never emits an unparseable stub', () => {
    const src = [
      'export const cfg = {',
      '  retries: 3,',
      '  endpoints: { prod: "https://api.example.com" },',
      '};',
      'export function useCfg(): number {',
      '  return cfg.retries;',
      '}',
    ].join('\n');
    const view = sliceInterfaces(src, 'ts');
    assert.ok(view.text.includes('retries: 3'), 'view must keep the exported object whole: ' + view.text);
    assert.ok(view.text.trimEnd().includes('};'), 'the object must be closed in the view: ' + view.text);
    assert.ok(view.text.includes('export function useCfg(): number'), 'later API still present: ' + view.text);
  });

  it('keeps public/protected class fields and overload signatures, drops private state', () => {
    const src = [
      'export class Client {',
      '  private cache = new Map<string, string>();',
      '  public retries = 3;',
      '  protected timeoutMs = 1_000;',
      '  notify(msg: string): void;',
      '  notify(msg: number): void;',
      '  notify(msg: string | number): void {',
      '    console.log(msg);',
      '  }',
      '}',
    ].join('\n');
    const view = sliceInterfaces(src, 'ts');
    assert.ok(view.text.includes('public retries = 3;'), 'public field survives: ' + view.text);
    assert.ok(view.text.includes('protected timeoutMs'), 'protected field survives: ' + view.text);
    assert.ok(view.text.includes('notify(msg: string): void;'), 'overload signature survives: ' + view.text);
    assert.ok(view.text.includes('notify(msg: number): void;'), 'second overload survives: ' + view.text);
    assert.ok(!view.text.includes('private cache'), 'private state stays out: ' + view.text);
  });

  it('case-folds path keys on Windows only', () => {
    const a = slicePathKey('Foo.ts');
    const b = slicePathKey('foo.ts');
    if (process.platform === 'win32') assert.equal(a, b, 'Windows matching stays case-insensitive');
    else assert.notEqual(a, b, 'case-sensitive filesystems must not collide');
  });

  it('never throws on focus symbols containing regex metacharacters', () => {
    const src = 'export function probe(): void {}\n';
    const view = sliceWithFocus(src, 'ts', { file: 'f.ts', symbol: 'probe())[' }, 'f.ts');
    assert.equal(view.text, src, 'unresolvable symbol -> honest full passthrough');
  });
});
