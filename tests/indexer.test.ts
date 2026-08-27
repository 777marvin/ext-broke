import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  createEmptyState,
  ensureFresh,
  estimateBulkReadAvoided,
  findBestLine,
  formatSearchFooter,
  isConfinedRelPath,
  loadIndex,
  mergeIntoState,
  mergeWindows,
  projectHash,
  rankQuery,
  renderSnippet,
  runSearch,
  saveIndex,
  scanProject,
  tokenize,
  type IndexState,
} from '../indexer';

// ---------------------------------------------------------------------------
// Fixture tree - recreated per suite via mkdtemp so repeated runs and parallel
// files never share state (same isolation rule as BROKE_CONFIG_PATH). All IO
// targets are explicit dirs passed to save/load - NOTHING lands in the real
// extension directory during tests.
// ---------------------------------------------------------------------------

const tmpRoots: string[] = [];
after(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

function writeFile(root: string, relParts: string[], content: string | Buffer): void {
  const abs = join(root, ...relParts);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'broke-indexer-'));
  tmpRoots.push(root);
  writeFile(
    root,
    ['src', 'a.ts'],
    [
      'export interface Invoice { id: string; totalCents: number }',
      '',
      '/** Looks up the alphaFind service. */',
      'export function alphaFind(id: string): Invoice {',
      "  throw new Error('not implemented');",
      '}',
      'export function betaFind(id: string): string {',
      '  return alphaFind(id).id;',
      '}',
    ].join('\n'),
  );
  writeFile(root, ['deep', 'nested', 'b.md'], '# docs\n\nmarkdownGrepKeyword lives here\n');
  writeFile(root, ['node_modules', 'x.js'], 'module.exports = alphaFindShouldNotBeIndexed;\n');
  writeFile(root, ['vendor', 'y.py'], 'def alpha_find(): pass\n');
  writeFile(root, ['logo.png'], Buffer.from([0x89, 0x50]));
  return root;
}

const emptyState = (): IndexState => ({ version: 1, projectRoot: '', builtAt: '', truncated: false, files: {}, postings: {} });

describe('tokenize', () => {
  it('splits identifiers and numbers, lowercases everything', () => {
    assert.deepEqual(tokenize('alphaFind Invoice12'), ['alphafind', 'invoice12']);
  });

  it('drops stopwords and single characters, keeps real terms', () => {
    const out = tokenize('The quick a abb X y');
    assert.deepEqual(out.filter((t) => t === 'the' || t === 'a'), []);
    assert.ok(out.includes('quick'));
    assert.ok(out.includes('abb'));
  });
});

describe('scanProject skip rules', () => {
  it('walks allowlisted extensions only; never enters node_modules/vendor', () => {
    const root = makeProject();
    const { entries, truncated } = scanProject(root, 512);
    const paths = entries.map((e) => e.relPath);
    assert.equal(truncated, false);
    assert.ok(paths.includes('src/a.ts'), JSON.stringify(paths));
    assert.ok(paths.includes('deep/nested/b.md'), JSON.stringify(paths));
    assert.ok(!paths.some((p) => p.startsWith('node_modules/') || p.startsWith('vendor/')));
    assert.ok(!paths.includes('logo.png'));
  });

  it('honors maxFileKB by skipping oversized candidates', () => {
    const root = makeProject();
    writeFile(root, ['src', 'huge.ts'], `export const big = '${'x'.repeat(900)}';\n`);
    // ~920 bytes: above the 0.5 KB cap, below the generous one
    assert.ok(!scanProject(root, 0.5).entries.some((e) => e.relPath === 'src/huge.ts'));
    assert.ok(scanProject(root, 512).entries.some((e) => e.relPath === 'src/huge.ts'));
  });
});

describe('mergeIntoState incremental behavior', () => {
  it('re-tokenizes ONLY changed files and removes deleted ones everywhere', () => {
    const root = makeProject();
    const state = emptyState();
    const scan1 = scanProject(root, 512);
    const d1 = mergeIntoState(state, root, scan1.entries, scan1.truncated);
    assert.deepEqual([d1.added, d1.updated, d1.removed], [2, 0, 0]);

    // Rewrite src/a.ts (new tokens), delete the markdown doc.
    writeFile(root, ['src', 'a.ts'], ['export function gammaOnly(): number {', '  return 7;', '}'].join('\n'));
    rmSync(join(root, 'deep'), { recursive: true, force: true });

    const scan2 = scanProject(root, 512);
    const d2 = mergeIntoState(state, root, scan2.entries, scan2.truncated);
    assert.deepEqual([d2.added, d2.updated, d2.removed], [0, 1, 1]);

    assert.ok(!('deep/nested/b.md' in state.files));
    assert.ok(!state.postings['docs']);
    assert.equal(state.postings['gammaonly']?.['src/a.ts'], 1);
    assert.ok(!state.postings['alphafind']);
  });
});

describe('rankQuery BM25 ranking', () => {
  const ranked: IndexState = {
    version: 1,
    projectRoot: '',
    builtAt: '',
    truncated: false,
    files: {
      'dense.ts': { mtimeMs: 1, sizeBytes: 100, tokenCount: 20 },
      'sparse.ts': { mtimeMs: 2, sizeBytes: 8000, tokenCount: 4000 },
    },
    postings: {
      invoice: { 'dense.ts': 4, 'sparse.ts': 3 }, // higher tf AND shorter doc -> dense wins
    },
  };

  it('ranks tf-saturated short documents above long ones with equal terms', () => {
    const top = rankQuery(ranked, ['invoice']);
    assert.equal(top[0].relPath, 'dense.ts');
  });

  it('returns [] for unknown terms and empty indexes', () => {
    assert.deepEqual(rankQuery(ranked, ['zzzzunknown']), []);
    assert.deepEqual(rankQuery(emptyState(), ['invoice']), []);
  });
});

describe('snippet primitives', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);

  it('finds the line covering most distinct query terms (earlier wins ties)', () => {
    const withHit = lines.slice();
    withHit[10] = 'invoice payment gammaonly';
    withHit[11] = 'invoice invoice invoice';
    assert.equal(findBestLine(withHit, ['invoice', 'payment']).line0, 10);
  });

  it('merges overlapping windows and marks gaps with an elide marker', () => {
    const merged = mergeWindows([5, 6, 30], 3, lines.length);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged[0], [2, 9]);
    assert.deepEqual(merged[1], [27, 33]);
    const text = renderSnippet(lines, merged);
    assert.match(text, /\u2026 \[broke: 17 line\(s\) elided\] \u2026/);
  });
});

describe('runSearch budget and filtering', () => {
  let root = '';
  let state: IndexState;

  it('seeds an index through explicit scan/merge (no extension-dir writes)', () => {
    root = makeProject();
    const scanned = scanProject(root, 512);
    state = createEmptyState(root);
    mergeIntoState(state, root, scanned.entries, scanned.truncated);
  });

  it('respects k and honours exact/prefix path filters', () => {
    const capped = runSearch(state!, root!, 'alphaFind', { k: 1, maxChars: 6000, contextLines: 4 });
    assert.equal(capped.hits.length, 1);

    const all = runSearch(state!, root!, 'alphaFind', { k: 8, maxChars: 60000, contextLines: 4 });
    assert.ok(all.hits.length >= 1);
    assert.ok(all.hits.every((h) => h.path !== 'vendor/y.py')); // vendor was never indexed

    const filtered = runSearch(state!, root!, 'markdownGrepKeyword', { k: 8, maxChars: 6000, contextLines: 4 }, ['deep']);
    assert.equal(filtered.hits.length, 1);
    assert.ok(filtered.hits[0].path.startsWith('deep/'));

    const excludedByFilter = runSearch(state!, root!, 'markdownGrepKeyword', { k: 8, maxChars: 6000, contextLines: 4 }, ['nope']);
    assert.equal(excludedByFilter.hits.length, 0);
  });

  it('enforces the TOTAL char budget across results (trimming oversize hits)', () => {
    const tiny = { k: 50, maxChars: 260, contextLines: 8 };
    const result = runSearch(state!, root!, 'alphafind betafind invoice totalcents', tiny);
    const joined = result.hits.map((h) => h.text).join('\n\n');
    assert.ok(joined.length <= 260, `budget blown: ${joined.length} chars`);
  });

  it('reports zero hits for pure-noise queries without throwing', () => {
    const none = runSearch(state!, root!, 'qqxxzz', { k: 8, maxChars: 6000, contextLines: 4 });
    assert.deepEqual(none.hits, []);
  });
});

describe('persistence round-trip and corruption tolerance', () => {
  it('save -> load reproduces postings and metadata; garbage -> null', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'broke-persist-')), 'store');
    tmpRoots.push(dir);
    const s = emptyState();
    s.projectRoot = 'C:/fake/root';
    s.builtAt = '2026-08-27T00:00:00.000Z';
    s.files['p.ts'] = { mtimeMs: 111, sizeBytes: 7, tokenCount: 3 };
    s.postings['kappa'] = { 'p.ts': 2 };
    saveIndex(dir, s);

    const loaded = loadIndex(dir)!;
    assert.equal(loaded.version, 1);
    assert.equal(loaded.projectRoot, 'C:/fake/root');
    assert.deepEqual(Object.keys(loaded.postings), Object.keys(s.postings));
    assert.deepEqual(loaded.files['p.ts'], s.files['p.ts']);

    writeFileSync(join(dir, 'index.json'), '{oops-not-json', 'utf-8');
    assert.equal(loadIndex(dir), null);
    assert.equal(loadIndex(join(dir, 'missing')), null);
  });

  it('atomic overwrite leaves exactly one index.json (no .tmp leftovers)', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'broke-overwrite-')), 'store');
    tmpRoots.push(dir);
    saveIndex(dir, emptyState());
    saveIndex(dir, emptyState());
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.json')), ['index.json']);
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  });
});

describe('ensureFresh with dir override (isolation pattern)', () => {
  it('builds, persists, then converges to zero-delta without rewriting builtAt', () => {
    const root = makeProject();
    const store = join(mkdtempSync(join(tmpdir(), 'broke-fresh-')), 'idx');
    tmpRoots.push(store);

    const first = ensureFresh(root, { maxFileKB: 512 }, store);
    assert.ok(first.delta.added >= 2);
    const builtAt = first.state.builtAt;
    assert.ok(builtAt.length > 0);

    const second = ensureFresh(root, { maxFileKB: 512 }, store);
    assert.deepEqual(second.delta, { added: 0, updated: 0, removed: 0 });
    assert.equal(second.state.builtAt, builtAt);

    assert.equal(loadIndex(store)!.builtAt, builtAt);
  });
});

describe('footer and hash helpers', () => {
  it('hashes roots deterministically into filesystem-safe fragments (64-bit, review F-09)', () => {
    const h1 = projectHash('C:\\dev\\some\\project');
    assert.equal(h1, projectHash('C:\\dev\\some\\project'));
    assert.match(h1, /^[0-9a-f]{16}$/, 'SHA-256 truncated to 64 bits - no 32-bit collisions across projects');
    assert.notEqual(projectHash('C:\\other'), h1);
  });

  it('isConfinedRelPath rejects traversal, absolutes and backslashes', () => {
    for (const bad of ['../../secret', 'a/../b', 'C:/abs/path.txt', '\\\\server\\share', 'a\\b.ts', '/etc/passwd', 'a//b.ts', 'a/', '.', '..']) {
      assert.equal(isConfinedRelPath(bad), false, bad);
    }
    for (const good of ['src/app.ts', 'deep/nested/file.test.tsx', 'README.md']) {
      assert.equal(isConfinedRelPath(good), true, good);
    }
  });

  it('footer carries result count, file count and the budget numbers', () => {
    const footer = formatSearchFooter(3, 1200, { k: 8, maxChars: 6000, contextLines: 6 }, 42);    assert.match(footer, /^broke-search: 3 result\(s\) \| .* files indexed \| budget 8 hits\/.* chars \| index refreshed 42ms ago$/);
    assert.match(footer, /1[,.\u2009]?200/); // thousand separator is locale-flavored - stay lenient
  });
});

describe('estimateBulkReadAvoided', () => {
  const files = {
    'src/big.ts': { mtimeMs: 1, sizeBytes: 20_000, tokenCount: 5_000 },
    'src/small.ts': { mtimeMs: 2, sizeBytes: 900, tokenCount: 250 },
  };

  it('counts each unique result file once at index-time size minus what was sent', () => {
    const hits = [
      { path: 'src/big.ts', line: 10, matches: 2, text: 'header\nsnippet'.padEnd(600) },
      { path: 'src/big.ts', line: 90, matches: 1, text: 'second window'.padEnd(300) },
      { path: 'src/small.ts', line: 4, matches: 1, text: 'x'.repeat(120) },
    ];
    const avoided = estimateBulkReadAvoided(hits, files);
    assert.equal(avoided, 20_000 + 900 - (600 + 300 + 120));
  });

  it('skips files that vanished from the index meta instead of guessing', () => {
    const hits = [{ path: 'src/gone.ts', line: 1, matches: 1, text: 'abc' }];
    // No baseline contribution for unknown files - sent chars still count,
    // mirroring "honest skip": the estimate errs on the low side.
    assert.equal(estimateBulkReadAvoided(hits, files), -3);
  });

  it('can go negative on pathological input - callers clamp for display', () => {
    const hits = [{ path: 'src/small.ts', line: 1, matches: 1, text: 'y'.repeat(950) }];
    const raw = estimateBulkReadAvoided(hits, files);
    assert.equal(raw, 900 - 950);
    assert.ok(raw < 0);
  });
});

describe('index hardening: persisted-state trust boundary (review F-09)', () => {
  it('rejects persisted indexes with non-confined relPaths', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'broke-tamper-')), 'store');
    tmpRoots.push(dir);
    const s = emptyState();
    s.files['../../secret.txt'] = { mtimeMs: 1, sizeBytes: 1, tokenCount: 1 };
    s.postings['kappa'] = { '../../secret.txt': 1 };
    saveIndex(dir, s);
    assert.equal(loadIndex(dir), null, 'a traversal key invalidates the whole file');

    const s2 = emptyState();
    s2.files['C:/abs.ts'] = { mtimeMs: 1, sizeBytes: 1, tokenCount: 1 };
    saveIndex(dir, s2);
    assert.equal(loadIndex(dir), null, 'an absolute-path key invalidates the file');

    const s3 = emptyState();
    s3.files['src/ok.ts'] = { mtimeMs: 1, sizeBytes: 1, tokenCount: 1 };
    saveIndex(dir, s3);
    assert.ok(loadIndex(dir), 'confined keys load fine');
  });

  it('discards persisted state built for a foreign project root', () => {
    const root = makeProject();
    const dir = join(mkdtempSync(join(tmpdir(), 'broke-foreign-')), 'store');
    tmpRoots.push(dir);
    const s = emptyState();
    s.projectRoot = 'C:/elsewhere/project';
    s.files['ghost.ts'] = { mtimeMs: 1, sizeBytes: 10, tokenCount: 3 };
    s.postings['ghost'] = { 'ghost.ts': 3 };
    saveIndex(dir, s);
    const { state, delta } = ensureFresh(root, { maxFileKB: 512 }, dir);
    assert.equal(state.projectRoot, root, 'state is re-attributed to the real root');
    assert.equal('ghost.ts' in state.files, false, 'ghost entries from the foreign root are gone');
    assert.ok(delta.added >= 2, 'rebuilt from the real scan');
  });

  it('never reads outside the root, even from a hand-built state', () => {
    const root = makeProject();
    const state = emptyState();
    state.projectRoot = root;
    state.files['../evil.txt'] = { mtimeMs: 1, sizeBytes: 10, tokenCount: 3 };
    state.postings['alphafind'] = { '../evil.txt': 5 };
    const result = runSearch(state, root, 'alphafind', { k: 5, maxChars: 6000, contextLines: 4 });
    assert.deepEqual(result.hits, [], 'unconfined candidates are skipped at the read boundary');
  });

  it('cleans up legacy 8-hex index dirs along the default path (hash upgrade)', () => {
    const base = mkdtempSync(join(tmpdir(), 'broke-idxbase-'));
    tmpRoots.push(base);
    const prev = process.env.BROKE_INDEX_DIR;
    process.env.BROKE_INDEX_DIR = base;
    try {
      mkdirSync(join(base, 'index', 'deadbeef'), { recursive: true });
      writeFileSync(join(base, 'index', 'deadbeef', 'index.json'), '{"version":1}');
      const root = makeProject();
      ensureFresh(root, { maxFileKB: 512 });
      assert.equal(existsSync(join(base, 'index', 'deadbeef')), false, 'legacy dir removed');
      assert.ok(existsSync(join(base, 'index', projectHash(root), 'index.json')), 'current index lives under the new hash');
    } finally {
      if (prev === undefined) delete process.env.BROKE_INDEX_DIR;
      else process.env.BROKE_INDEX_DIR = prev;
    }
  });
});
