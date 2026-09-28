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
  isShallowRepo,
  leafPaths,
  repoTags,
  runChecks,
  tagsAreAuthoritative,
} from '../scripts/docs-checks';
import { execFileSync } from 'node:child_process';
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

test('every changelog release heading is a real tag or a declared pre-tag exception', (t) => {
  // This assertion needs a tag list it can trust, which means a repository
  // that is not shallow - a --depth 1 fetch of a tagged commit carries
  // exactly one tag and would make every older release look untagged. It
  // skips otherwise, following the same rule as the gate. The function's own
  // behaviour is covered below with fixture tags either way.
  const tags = new Set(repoTags());
  if (!tagsAreAuthoritative(tags, REPO_ROOT)) return t.skip('this checkout cannot be trusted about git tags');
  const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const headings = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
  assert.ok(headings.length > 10, `expected many releases, found ${headings.length}`);
  assert.deepEqual(findChangelogTagErrors(changelog, tags), []);
  const untagged = headings.filter((v) => !tags.has(`v${v}`));
  // The changelog runs newest first, UNTAGGED_HISTORICAL ascending.
  assert.deepEqual([...untagged].sort(), [...UNTAGGED_HISTORICAL].sort(), 'the only untagged releases are the six declared ones');
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

test('the real repository passes its own gate', (t) => {
  // A checkout that cannot be trusted about tags has no authority on release
  // claims, and the gate skips them there. Skipping mirrors that instead of
  // asserting something the checkout cannot know - this suite runs in CI jobs
  // that check out with depth 1 and no fetch-tags.
  if (!tagsAreAuthoritative(new Set(repoTags()), REPO_ROOT)) {
    return t.skip('this checkout cannot be trusted about git tags');
  }
  const { errors, skipped } = runChecks(REPO_ROOT);
  assert.deepEqual(errors, []);
  assert.deepEqual(skipped, [], 'with tags, nothing is skipped');
});

test('tag-dependent checks run with tags and are skipped, cleanly, without them', () => {
  // Built from the real changelog, NOT from repoTags(): this test must not
  // depend on whether the checkout has tags, or it would only ever verify
  // the case it happens to run in.
  const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const headings = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)]
    .map((m) => m[1])
    .filter((v) => !UNTAGGED_HISTORICAL.has(v));
  assert.ok(headings.length > 10, `expected many releases, found ${headings.length}`);
  const full = new Set(headings.map((v) => `v${v}`));

  const withTags = runChecks(REPO_ROOT, full);
  if (tagsAreAuthoritative(full, REPO_ROOT)) {
    assert.deepEqual(withTags.errors, [], 'a full tag list leaves the real repo clean');
    assert.deepEqual(withTags.skipped, [], 'nothing is skipped when the tag list is trustworthy');
  } else {
    // Shallow checkout: even a hand-built complete list is not authority,
    // because it is this repository's shallowness that decides, not the list.
    assert.deepEqual(withTags.errors, [], 'a shallow checkout reports no release errors');
    assert.equal(withTags.skipped.length, 1, 'still exactly one skip');
    assert.match(withTags.skipped[0], /shallow/);
  }

  const withoutTags = runChecks(REPO_ROOT, new Set());
  assert.deepEqual(withoutTags.errors, [], 'without tags there is nothing to be wrong about');
  assert.equal(withoutTags.skipped.length, 1, 'exactly one skip, reported once');
  assert.match(withoutTags.skipped[0], /no git tags/);
});

test('tagsAreAuthoritative: a non-empty tag list is still not authority in a shallow repo', () => {
  // This is the failure CI hit twice. `git fetch --depth 1` of a tagged commit
  // auto-follows that ONE tag, so `git tag --list` is non-empty and useless:
  // a gate that only checks "are there tags" asserts against a list that
  // cannot answer the question. Verified against a real depth-1 clone, which
  // is why the shallow case is asserted against this repository's own
  // is-shallow flag rather than a mocked git.
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const oneTag = new Set(['v1.0.0']);

  assert.equal(isShallowRepo(REPO_ROOT), shallow === 'true', 'isShallowRepo reports the repository state');

  if (shallow === 'true') {
    // A shallow checkout: one tag must be refused, an empty one too.
    assert.equal(tagsAreAuthoritative(oneTag, REPO_ROOT), false, 'one tag in a shallow clone is not authority');
    assert.equal(tagsAreAuthoritative(new Set(), REPO_ROOT), false, 'no tags is never authority');
  } else {
    // The real repository is complete, so a full list is authority and an
    // empty one is not. A deliberately partial list is NOT detectable as
    // partial here, which is why shallowness is the signal and not a count.
    assert.equal(tagsAreAuthoritative(oneTag, REPO_ROOT), true);
    assert.equal(tagsAreAuthoritative(new Set(), REPO_ROOT), false);
  }
});

test('runChecks reports the shallow reason, not a false release error', () => {
  const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const headings = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => `v${m[1]}`);
  // One tag, many releases: exactly the CI state that produced 19 bogus
  // "has no git tag" errors. With a root that is not this repository the
  // shallow probe is answered by the same rule, so pin the message shape.
  const result = runChecks(REPO_ROOT, new Set(headings.slice(0, 1)));
  if (tagsAreAuthoritative(new Set(headings.slice(0, 1)), REPO_ROOT)) {
    assert.equal(result.skipped.length, 0, 'this checkout is complete, so the partial list is used as given');
  } else {
    assert.deepEqual(result.errors.filter((e) => /has no git tag/.test(e)), [], 'no false release error');
    assert.match(result.skipped[0], /git tags|shallow/);
  }
});
