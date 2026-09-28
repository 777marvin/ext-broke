/**
 * Regression tests for the documentation gate (scripts/check-docs.mts).
 *
 * The gate exists because prose claims drifted from the code for two
 * releases. These tests pin the two properties that make it usable in CI:
 * it FIRES on each drift class this repo actually hit, and it STAYS QUIET
 * on the text that is correct - especially the three unrelated version
 * namespaces the docs quote (broke's tags, the AiderDesk host releases,
 * the @aiderdesk/extensions SDK line) plus bare IP addresses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  UNTAGGED_HISTORICAL,
  compareVersions,
  findBrokenLinks,
  findChangelogTagErrors,
  findConfigTableErrors,
  findReleaseClaimErrors,
  leafPaths,
  repoTags,
  runChecks,
} from '../scripts/docs-checks';
import { DEFAULT_CONFIG } from '../config';

const REPO_ROOT = join(import.meta.dirname, '..');
const TAGS = new Set(['v0.3.0', 'v0.8.0', 'v1.2.0', 'v1.3.0', 'v1.3.1']);
const CURRENT = '1.3.1-dev';
const schema = DEFAULT_CONFIG as unknown as Record<string, unknown>;
const SCHEMA_PATHS = leafPaths(schema);
const TOP_LEVEL = new Set(Object.keys(schema));

test('findBrokenLinks: a dangling relative link is reported with its line', () => {
  const text = '# t\n\nsee [gone](docs/nope.md) and [ok](docs/overview.md).\n';
  const errors = findBrokenLinks(text, 'README.md', REPO_ROOT);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /README\.md:3/);
  assert.match(errors[0], /docs\/nope\.md/);
});

test('findBrokenLinks: external URLs and anchor-only links are skipped', () => {
  const text = '[a](https://example.com) [b](#usage) [c](mailto:x@y.z) [d](docs/overview.md#pipeline)\n';
  assert.deepEqual(findBrokenLinks(text, 'README.md', REPO_ROOT), []);
});

test('findBrokenLinks: a link from docs/ resolves relative to docs/', () => {
  assert.deepEqual(findBrokenLinks('[a](tuning.md) [b](../README.md)', 'docs/features.md', REPO_ROOT), []);
});

test('findReleaseClaimErrors: a real tag at or below the current version passes', () => {
  assert.deepEqual(findReleaseClaimErrors('F5 shipped in v1.3.0 and Since 1.2.0 it works.', 'docs/feats.md', TAGS, CURRENT), []);
});

test('findReleaseClaimErrors: an invented release is caught', () => {
  const errors = findReleaseClaimErrors('F9 shipped in v9.9.9.', 'docs/feats.md', TAGS, CURRENT);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /v9\.9\.9/);
});

test('findReleaseClaimErrors: a release newer than package.json is caught', () => {
  // The tag must exist, otherwise the "no git tag" branch fires first and the
  // future-release check would never be reached.
  const withFuture = new Set([...TAGS, 'v1.4.0']);
  const errors = findReleaseClaimErrors('Since 1.4.0 the gate does X.', 'docs/overview.md', withFuture, '1.3.1-dev');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /package\.json is 1\.3\.1-dev/);
});

test('findReleaseClaimErrors: an untagged version may be named historically', () => {
  assert.deepEqual(findReleaseClaimErrors('F1 shipped in 0.2.0.', 'docs/feats.md', TAGS, CURRENT), []);
  for (const v of UNTAGGED_HISTORICAL) {
    assert.deepEqual(findReleaseClaimErrors(`shipped in ${v}`, 'docs/feats.md', TAGS, CURRENT), []);
  }
});

test('findReleaseClaimErrors: an untagged version must never be an install target', () => {
  const errors = findReleaseClaimErrors('/broke update v0.2.0', 'README.md', TAGS, CURRENT);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no git tag/);
});

test('findReleaseClaimErrors: AiderDesk host and SDK versions in prose are not release claims', () => {
  const text = [
    'Verified against the AiderDesk **v0.85.0** source checkout.',
    'The tarball line: @aiderdesk/extensions 0.35.0, first in 0.34.0, 0.33.0 lacks it.',
    'Defaults: 30% of 200k tokens, llmapi on 0.85.',
    'Ollama runs at 127.0.0.1:11434.',
    'Compatibility line: ^0.31.0 (AiderDesk >= 0.77).',
  ].join('\n');
  assert.deepEqual(findReleaseClaimErrors(text, 'docs/aiderdesk-builtin.md', TAGS, CURRENT), []);
});

test('compareVersions: numeric order, and a prerelease sorts before its release', () => {
  assert.ok(compareVersions('1.3.0', '1.2.3') > 0);
  assert.ok(compareVersions('1.2.3', '1.3.0') < 0);
  assert.equal(compareVersions('1.3.0', '1.3.0'), 0);
  assert.ok(compareVersions('1.3.1-dev', '1.3.1') < 0);
  assert.ok(compareVersions('1.3.1', '1.3.1-dev') > 0);
  assert.equal(compareVersions('1.3.1-dev', '1.3.1-dev'), 0);
});

test('findConfigTableErrors: the shipped README table covers the schema exactly', () => {
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  assert.deepEqual(findConfigTableErrors(readme, SCHEMA_PATHS, TOP_LEVEL), []);
});

test('findConfigTableErrors: a setting missing from the table is reported', () => {
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  const stripped = readme.replace(/^\| search\.scanBudgetMs.*$/m, '');
  const errors = findConfigTableErrors(stripped, SCHEMA_PATHS, TOP_LEVEL);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /does not document: search\.scanBudgetMs/);
});

test('findConfigTableErrors: a top-level setting missing from the table is reported', () => {
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  const stripped = readme.replace(/^\| protectedTurns.*$/m, '');
  assert.match(findConfigTableErrors(stripped, SCHEMA_PATHS, TOP_LEVEL)[0], /does not document: protectedTurns/);
});

test('findConfigTableErrors: a fabricated setting is reported in the other direction', () => {
  // The row has to sit INSIDE the Configuration section, which the gate
  // slices at the next "## " heading.
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8').replace('\n## Status', '\n| made.up.setting | 1 | invented |\n\n## Status');
  assert.match(findConfigTableErrors(readme, SCHEMA_PATHS, TOP_LEVEL)[0], /absent from the schema: made\.up\.setting/);
});

test('findConfigTableErrors: a grouped row documents both of its keys', () => {
  const readme = ['## Configuration', '', '| Setting | Default | Description |', '|---|---|---|', '| truncate.maxLines / maxKB | 200 / 20 | limits |', '', '## License', '', 'x'].join('\n');
  assert.deepEqual(findConfigTableErrors(readme, ['truncate.maxLines', 'truncate.maxKB'], new Set()), []);
});

test('findConfigTableErrors: a missing Configuration section is reported, not crashed on', () => {
  const errors = findConfigTableErrors('# only a title\n', SCHEMA_PATHS, TOP_LEVEL);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no "## Configuration" section/);
});

test('leafPaths: flattens nested blocks to dotted paths', () => {
  assert.deepEqual(leafPaths({ a: 1, b: { c: 2, d: { e: 3 } } }), ['a', 'b.c', 'b.d.e']);
});

test('findChangelogTagErrors: the shipped changelog announces only real tags', () => {
  assert.deepEqual(findChangelogTagErrors(readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8'), new Set(repoTags())), []);
});

test('findChangelogTagErrors: a fabricated release heading is caught', () => {
  const errors = findChangelogTagErrors('# Changelog\n\n## [1.4.0] - 2026-10-01\n\n- shipped things\n', TAGS);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /announces release 1\.4\.0/);
});

test('findChangelogTagErrors: the declared untagged history is allowed, an undeclared one is not', () => {
  const text = [...UNTAGGED_HISTORICAL].map((v) => `## [${v}] - 2026-08-13`).join('\n');
  assert.deepEqual(findChangelogTagErrors(text, TAGS), [], 'the six pre-tag releases are a declared exception');
  assert.equal(findChangelogTagErrors('## [0.2.2] - 2026-08-14', TAGS).length, 1, '0.2.2 is NOT on the list');
});

test('findChangelogTagErrors: [Unreleased] and link references are not releases', () => {
  const text = ['## [Unreleased]', '', '## [1.3.0] - 2026-09-28', '', '[1.3.0]: https://example.com/compare/v1.2.3...v1.3.0'].join('\n');
  assert.deepEqual(findChangelogTagErrors(text, TAGS), []);
});

test('the real repository passes its own gate', () => {
  assert.deepEqual(runChecks(REPO_ROOT), []);
});
