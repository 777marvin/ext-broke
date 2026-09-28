/**
 * The pure diff-digest formatter behind `/broke diff` (AiderDesk 0.84 added
 * TaskContext.getUpdatedFileDiff, which makes diff content cheap to read for
 * the first time).
 *
 * No IO, no host access: the caller hands over (path, additions, deletions,
 * diff) rows and gets a text digest that respects a char budget. Every case
 * here is a promise the command makes to a user reading the result.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_DIFF_BUDGET_CHARS,
  DIFF_DIGEST_OVERHEAD_CHARS,
  formatDiffDigest,
  type DiffFileInput,
} from '../diff';

const file = (path: string, additions: number, deletions: number, diff: string): DiffFileInput => ({
  path,
  additions,
  deletions,
  diff,
});

describe('formatDiffDigest', () => {
  it('says so when there is nothing to show', () => {
    const digest = formatDiffDigest([], DEFAULT_DIFF_BUDGET_CHARS);
    assert.equal(digest.files, 0);
    assert.equal(digest.shown, 0);
    assert.equal(digest.elided, 0);
    assert.equal(digest.diffChars, 0);
    assert.match(digest.text, /no updated files/i);
  });

  it('names the file count and the summed additions/deletions in the header', () => {
    const digest = formatDiffDigest(
      [file('a.ts', 10, 2, 'x'), file('b.ts', 5, 7, 'y')],
      DEFAULT_DIFF_BUDGET_CHARS,
    );
    assert.equal(digest.files, 2);
    assert.equal(digest.shown, 2);
    assert.equal(digest.elided, 0);
    assert.match(digest.text, /2 changed files/);
    assert.match(digest.text, /\+15/);
    assert.match(digest.text, /-9/);
  });

  it('renders one block per file with its path and its diff head', () => {
    const digest = formatDiffDigest(
      [file('src/a.ts', 1, 0, '@@ -1,3 +1,4 @@\n+added line\n context')],
      DEFAULT_DIFF_BUDGET_CHARS,
    );
    assert.ok(digest.text.includes('src/a.ts'), 'the path is visible');
    assert.ok(digest.text.includes('+added line'), 'the diff head is visible');
    assert.match(digest.text, /\+1\/-0/);
  });

  // The SDK documents an EMPTY STRING for binary files *and* on error. An
  // empty diff must never be reported as a size - "0 chars" would read as
  // "this file has no changes", which is a different and wrong claim.
  it('marks an empty diff as binary or unreadable, never as 0 chars', () => {
    const digest = formatDiffDigest([file('logo.png', 0, 0, '')], DEFAULT_DIFF_BUDGET_CHARS);
    assert.match(digest.text, /binary or unreadable/i);
    assert.doesNotMatch(digest.text, /0 chars/);
    assert.doesNotMatch(digest.text, /no changes/i);
  });

  it('stops at the budget and names the exact elided count', () => {
    const rows: DiffFileInput[] = [];
    for (let i = 0; i < 200; i++) {
      rows.push(file(`src/file${i}.ts`, 3, 1, `+line ${i} of a long diff body `.repeat(20)));
    }
    const digest = formatDiffDigest(rows, 600);
    assert.equal(digest.files, 200);
    assert.ok(digest.shown < 200, 'the budget must actually cut the file list');
    assert.equal(digest.elided, 200 - digest.shown, 'elided is the exact remainder');
    assert.ok(digest.elided > 0);
    assert.match(digest.text, /not shown|elided/i);
    assert.ok(
      digest.text.includes(String(digest.elided)),
      'the elision line names the number of files left out',
    );
  });

  it('keeps the whole digest within budget + overhead', () => {
    const rows: DiffFileInput[] = [];
    for (let i = 0; i < 50; i++) rows.push(file(`f${i}.ts`, 2, 2, 'y'.repeat(500)));
    for (const budget of [200, 600, 2000, 4000]) {
      const digest = formatDiffDigest(rows, budget);
      assert.ok(
        digest.text.length <= budget + DIFF_DIGEST_OVERHEAD_CHARS,
        `budget ${budget}: got ${digest.text.length} chars, limit ${budget + DIFF_DIGEST_OVERHEAD_CHARS}`,
      );
    }
  });

  // The budget bounds the OUTPUT, not the work. Reading a diff is one host
  // round-trip per file, so an unbounded read loop turns /broke diff into a
  // minute-long hang on a repository with thousands of changed files. Files
  // past the cap are named as NOT READ - which is a different fact from a
  // file whose diff could not be read, and must not be rendered as either
  // 'unreadable' or '0 chars'.
  it('names the files that were never read, distinctly from unreadable ones', () => {
    const rows: DiffFileInput[] = [file('read.ts', 1, 0, '@@ -1 +1 @@\n+seen')];
    rows.push({ path: 'skipped.ts', additions: 2, deletions: 0, diff: '', notRead: true });
    const digest = formatDiffDigest(rows, DEFAULT_DIFF_BUDGET_CHARS);
    assert.match(digest.text, /not read/i, 'a not-read file is named as such');
    assert.doesNotMatch(digest.text, /skipped\.ts \(\+\d+\/-\d+\)\s*\n\s*\(binary or unreadable/, 'a not-read file is never reported as unreadable');
    assert.equal(digest.files, 2, 'both files are still counted');
    assert.equal(digest.diffChars, rows[0].diff.length, 'only read diffs contribute a measured size');
  });

  it('reports the total diff size it saw, shown or not', () => {
    const rows = [file('a.ts', 1, 0, 'a'.repeat(1000)), file('b.ts', 1, 0, 'b'.repeat(1000))];
    const digest = formatDiffDigest(rows, 200);
    assert.equal(digest.diffChars, 2000, 'both diffs are counted even though only one fits');
    assert.ok(digest.shown < digest.files);
  });
});
