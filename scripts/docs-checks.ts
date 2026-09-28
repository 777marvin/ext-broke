/**
 * Documentation gate, check logic (npm run check:docs).
 *
 * Hand-maintained claims drift silently. This repo has paid for that
 * repeatedly: the AiderDesk host floor stayed at 0.77 for two releases
 * after it moved to 0.84, the SDK line stayed at ^0.31.0 while
 * package.json said ^0.35.0, the overview snapshot header trailed two
 * releases, a feature was described as "unreleased" for a month after it
 * shipped, and the settings table quietly stopped covering the schema. A
 * version number in prose is exactly as load-bearing as one in code, so
 * it gets the same treatment.
 *
 * Four checks, all read-only:
 *   1. relative markdown links resolve
 *   2. every version named as a broke release is a real git tag
 *   3. the docs never claim a release newer than package.json
 *   4. the README configuration table covers the config schema exactly
 *
 * Check 2 is deliberately context-scoped ("shipped in vX.Y.Z", "Since
 * X.Y.Z", "/broke update vX.Y.Z", "Snapshot: release vX.Y.Z") instead of
 * sweeping every version-shaped token. The docs quote THREE unrelated
 * version namespaces - broke's own tags, the AiderDesk host releases and
 * the @aiderdesk/extensions SDK line - plus bare IP addresses, so a blind
 * sweep would flag correct text. Naming a release is unambiguous; naming a
 * host version in passing is not.
 *
 * The checks are exported as pure functions over text so they can be
 * regression-tested (tests/docs-gate.test.ts) without touching the real
 * files. Everything resolves against process.cwd(), so the gate has to run
 * from the package root - which is what `npm run` does.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_CONFIG } from '../config';

export const REPO_ROOT = process.cwd();

/**
 * CHANGELOG.md is excluded on purpose: it records what each version said
 * at the time, so old floors and old SDK lines are correct there.
 */
export const LINK_CHECKED = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/overview.md',
  'docs/feats.md',
  'docs/features.md',
  'docs/token-saving.md',
  'docs/tuning.md',
  'docs/local-models.md',
  'docs/aiderdesk-builtin.md',
  'docs/review-backlog.md',
];

/** Files in which a release claim must point at a real tag. */
export const VERSION_CHECKED = ['README.md', 'docs/overview.md', 'docs/feats.md', 'docs/features.md', 'docs/token-saving.md', 'docs/tuning.md'];

/**
 * Versions the CHANGELOG records that were never tagged and never
 * published as GitHub releases: the six releases from 0.1.0 to 0.2.1
 * predate the tag-and-sign release process. They may be named
 * HISTORICALLY ("F1 shipped in 0.2.0"), but they must never be offered as
 * an install target ("/broke update v0.2.0" would find nothing).
 */
export const UNTAGGED_HISTORICAL = new Set(['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.2.0', '0.2.1']);

/** Contexts in which a version is unambiguously a broke release. */
const RELEASE_CLAIM: { pattern: RegExp; installable: boolean }[] = [
  { pattern: /Snapshot: release v(\d+\.\d+\.\d+)/g, installable: true },
  { pattern: /\bSince (\d+\.\d+\.\d+)\b/g, installable: true },
  { pattern: /\bshipped in v?(\d+\.\d+\.\d+)/g, installable: false },
  { pattern: /\breleased in v?(\d+\.\d+\.\d+)/g, installable: false },
  { pattern: /\/broke update v(\d+\.\d+\.\d+)/g, installable: true },
];

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** Check 1. External and anchor-only targets are skipped by design. */
export function findBrokenLinks(text: string, file: string, root = REPO_ROOT, exists: (p: string) => boolean = existsSync): string[] {
  const errors: string[] = [];
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
    const bare = target.split('#')[0];
    if (!bare) continue;
    if (!exists(resolve(root, dirname(file), bare))) {
      errors.push(`${file}:${lineOf(text, m.index)}: broken relative link -> ${target}`);
    }
  }
  return errors;
}

/** Checks 2 and 3. `tags` are the repository's real release tags. */
export function findReleaseClaimErrors(text: string, file: string, tags: Set<string>, current: string): string[] {
  const errors: string[] = [];
  for (const { pattern, installable } of RELEASE_CLAIM) {
    for (const m of text.matchAll(pattern)) {
      const v = m[1];
      const line = lineOf(text, m.index);
      if (!tags.has(`v${v}`)) {
        if (!installable && UNTAGGED_HISTORICAL.has(v)) continue;
        errors.push(
          `${file}:${line}: names v${v}, which has no git tag and was never published as a release` +
            (installable ? ' - as an install or rollback target that is simply broken' : ''),
        );
      } else if (compareVersions(v, current) > 0) {
        errors.push(`${file}:${line}: claims release v${v}, but package.json is ${current}`);
      }
    }
  }
  return errors;
}

function splitVersion(v: string): { nums: number[]; pre: string } {
  const [core, pre = ''] = v.split('-', 2);
  return { nums: core.split('.').map(Number), pre };
}

export function compareVersions(a: string, b: string): number {
  const A = splitVersion(a);
  const B = splitVersion(b);
  for (let i = 0; i < 3; i++) if (A.nums[i] !== B.nums[i]) return A.nums[i] - B.nums[i];
  // same core: a prerelease sorts before the release itself
  return A.pre === B.pre ? 0 : A.pre ? -1 : 1;
}

export function leafPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? leafPaths(v as Record<string, unknown>, p) : [p];
  });
}

/**
 * Check 4. Reads the "## Configuration" section of the README and compares
 * its keys against the schema, in both directions. Grouped rows document two
 * settings at once ("truncate.maxLines / maxKB"), where a bare name after a
 * dotted one inherits its prefix.
 */
export function findConfigTableErrors(readme: string, schemaPaths: string[], topLevel: Set<string>): string[] {
  const errors: string[] = [];
  const tableStart = readme.indexOf('## Configuration');
  const tableEnd = tableStart === -1 ? -1 : readme.indexOf('\n## ', tableStart + 5);
  if (tableStart === -1 || tableEnd === -1) {
    return ['README.md: no "## Configuration" section followed by another heading - the gate reads that table'];
  }
  const documented = new Set<string>();
  for (const line of readme.slice(tableStart, tableEnd).split('\n')) {
    if (!line.startsWith('|')) continue;
    const first = (line.split('|')[1] ?? '').trim();
    let prefix = '';
    for (const raw of first.split('/')) {
      const key = raw.replace(/[`\s]/g, '').replace(/\(.*\)$/, '');
      if (!key) continue;
      if (key.includes('.')) {
        documented.add(key);
        prefix = key.split('.').slice(0, -1).join('.');
      } else if (prefix) {
        documented.add(`${prefix}.${key}`);
      } else if (topLevel.has(key)) {
        documented.add(key);
      }
    }
  }
  const missing = schemaPaths.filter((p) => !documented.has(p));
  if (missing.length) errors.push(`README.md: configuration table does not document: ${missing.join(', ')}`);
  const unknown = [...documented].filter((p) => !schemaPaths.includes(p));
  if (unknown.length) errors.push(`README.md: configuration table documents settings absent from the schema: ${unknown.join(', ')}`);
  return errors;
}

/**
 * Check 2b, the reverse direction: a version heading in the CHANGELOG is a
 * claim that a release happened. Every one of them must have a real tag,
 * otherwise the changelog advertises something nobody can install. The
 * six pre-tag releases are the declared exception (see above).
 *
 * The changelog is excluded from the prose checks above because history
 * legitimately quotes old floors and old SDK lines - but its own version
 * headings are exactly where a fabricated release would hide.
 *
 * KNOWN LIMIT: a tag existing is not the same as a release existing. This
 * check is local and offline, so it cannot see that a release workflow
 * run failed, that a tag points at the wrong commit, or that no GitHub
 * release was ever created for a tag that is present. v1.2.1 is exactly
 * that case: a local and remote tag, no published release, and a tag
 * target whose package.json still read 1.2.1-dev. Catching it needs
 * `gh release list` / the Actions API, which does not belong in a test
 * suite. Until that is automated, the changelog preamble and the release
 * sections carry the human-checked facts.
 */
export function findChangelogTagErrors(changelog: string, tags: Set<string>): string[] {
  const errors: string[] = [];
  for (const m of changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)) {
    const v = m[1];
    if (!tags.has(`v${v}`) && !UNTAGGED_HISTORICAL.has(v)) {
      errors.push(`CHANGELOG.md:${lineOf(changelog, m.index)}: announces release ${v}, which has no git tag - either tag the release or move the entry under [Unreleased]`);
    }
  }
  return errors;
}

/* the real thing ----------------------------------------------------------- */

export function repoTags(): string[] {
  return execFileSync('git', ['tag', '--list'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);
}

export function runChecks(root = REPO_ROOT): string[] {
  const read = (f: string) => readFileSync(join(root, f), 'utf8');
  const errors: string[] = [];

  for (const file of LINK_CHECKED) {
    if (!existsSync(join(root, file))) {
      errors.push(`${file}: listed in the check list but does not exist`);
      continue;
    }
    errors.push(...findBrokenLinks(read(file), file, root));
  }

  const tags = new Set(repoTags());
  const current = (JSON.parse(read('package.json')) as { version: string }).version;

  if (!/Snapshot: release v\d+\.\d+\.\d+/.test(read('docs/overview.md'))) {
    errors.push('docs/overview.md: no "Snapshot: release vX.Y.Z" header - keep it, the gate reads that line');
  }
  for (const file of [...new Set(['docs/overview.md', ...VERSION_CHECKED])]) {
    errors.push(...findReleaseClaimErrors(read(file), file, tags, current));
  }

  errors.push(...findChangelogTagErrors(read('CHANGELOG.md'), tags));

  const schema = DEFAULT_CONFIG as unknown as Record<string, unknown>;
  errors.push(...findConfigTableErrors(read('README.md'), leafPaths(schema), new Set(Object.keys(schema))));

  return errors;
}

export function schemaSettings(): string[] {
  return leafPaths(DEFAULT_CONFIG as unknown as Record<string, unknown>);
}
