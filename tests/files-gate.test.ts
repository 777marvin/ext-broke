/**
 * Regression tests for the tracked-file gate (scripts/file-checks.ts).
 *
 * The gate is an allowlist because the release artifact is a `git archive`
 * of the whole tree: whatever is tracked ships to every user, inside the
 * signed asset the updater refuses to modify. These tests pin both
 * directions - the shapes that must pass, and the shapes that must be
 * caught.
 *
 * There is deliberately NO "the real repository passes its own gate" test
 * here, unlike in tests/docs-gate.test.ts. npm run check:files is that
 * assertion, it runs in CI, and duplicating it here would only turn the
 * suite red while the maintainer's own unstage of tasks/ is still pending.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ALLOWED_DIRS, ROOT_FILES, findUnexpectedFiles, isExpectedFile, repoTrackedFiles } from '../scripts/file-checks';

test('isExpectedFile: extension sources at the root are expected', () => {
  for (const f of ['index.ts', 'config.ts', 'commands.ts', 'compress.ts', 'update.ts', 'tokens.ts']) {
    assert.ok(isExpectedFile(f), `${f} should be allowed`);
  }
});

test('isExpectedFile: the three JSX components are expected', () => {
  for (const f of ['ConfigComponent.jsx', 'StatusBadge.jsx', 'MessageMenuItem.jsx']) {
    assert.ok(isExpectedFile(f), `${f} should be allowed`);
  }
});

test('isExpectedFile: repo documentation and license are expected', () => {
  for (const f of ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE', 'package.json', 'package-lock.json', 'tsconfig.json', '.gitignore']) {
    assert.ok(isExpectedFile(f), `${f} should be allowed`);
  }
});

test('isExpectedFile: the four directories are expected to any depth', () => {
  for (const d of ALLOWED_DIRS) {
    assert.ok(isExpectedFile(`${d}deep/nested/file.ts`), `${d} should allow nested files`);
  }
  assert.ok(isExpectedFile('docs/assets/stats.png'), 'binary assets under docs/ are expected');
  assert.ok(isExpectedFile('.github/workflows/ci.yml'), 'CI is expected');
});

test('isExpectedFile: maintainer working notes are NOT expected', () => {
  // The actual accident this gate exists for.
  assert.equal(isExpectedFile('tasks/plan.md'), false);
  assert.equal(isExpectedFile('tasks/todo.md'), false);
  assert.equal(isExpectedFile('tasks/subdir/deep.md'), false);
});

test('isExpectedFile: scratch and secret material are NOT expected', () => {
  for (const f of [
    'broke-release-signing-key.pem',
    'config.json',
    'stats.jsonl',
    'measure.jsonl',
    'release-payload-1.2.1.json',
    'broke-v1.2.2.tar.gz',
    'SHA256SUMS',
    'notes.md',
    'scratch/x.ts',
    '.env',
  ]) {
    assert.equal(isExpectedFile(f), false, `${f} should be rejected`);
  }
});

test('isExpectedFile: a file in an unexpected root directory is rejected even if its name is known', () => {
  // A root *.ts rule must not become a wildcard for any directory.
  assert.equal(isExpectedFile('sub/index.ts'), false);
  assert.equal(isExpectedFile('docs-secrets/README.md'), false);
});

test('findUnexpectedFiles: reports the exact offending paths, one per line', () => {
  const errors = findUnexpectedFiles(['index.ts', 'docs/a.md', 'tasks/plan.md', 'nope.txt', 'tasks/todo.md']);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /tasks\/plan\.md/);
  assert.match(errors[1], /nope\.txt/);
  assert.match(errors[2], /tasks\/todo\.md/);
  for (const e of errors) assert.match(e, /would ship in the next release tarball/);
});

test('findUnexpectedFiles: a clean tree yields no errors', () => {
  assert.deepEqual(findUnexpectedFiles([...ROOT_FILES, 'index.ts', 'tests/a.test.ts', 'scripts/x.ts', '.github/CODEOWNERS']), []);
});

test('repoTrackedFiles: git reports forward-slash paths and no blanks', () => {
  const tracked = repoTrackedFiles();
  assert.ok(tracked.length > 50, `expected a real tree, got ${tracked.length} files`);
  assert.equal(tracked.filter((p) => p === '').length, 0);
  assert.ok(tracked.includes('index.ts'));
});
