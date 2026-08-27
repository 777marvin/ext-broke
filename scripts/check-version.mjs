#!/usr/bin/env node
/**
 * Version-consistency gate (external review F-05/F-16).
 *
 * Enforced invariants:
 * 1. package-lock.json root version === package.json version (always).
 * 2. package.json version is exactly one of:
 *    - 'X.Y.Z'    (release commit): requires a git tag 'vX.Y.Z' pointing at
 *      HEAD, so a tagged build and its package metadata can never disagree;
 *    - 'X.Y.Z-dev' (development commit, versioning policy "Option B"):
 *      main carries the development version between releases; a release tag
 *      must never point at a -dev commit.
 *
 * Exit 0 = consistent. Exit 1 = violation, with a human-readable reason.
 * CI runs this on every push/PR; the release workflow runs it again on the
 * tagged commit before signing.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf-8'));
const version = typeof pkg.version === 'string' ? pkg.version : '';
const errors = [];

// Invariant 1: lockfile metadata matches the package manifest.
if (!version) {
  errors.push('package.json has no version field');
} else if (lock.version !== version || lock.packages?.['']?.version !== version) {
  errors.push(
    `package-lock.json root version (${lock.version}) != package.json version (${version})` +
      ' - run: npm install --package-lock-only',
  );
}

// Invariant 2: version shape matches the commit's release state.
const EXACT = /^\d+\.\d+\.\d+$/;
const DEV = /^\d+\.\d+\.\d+-dev$/;

function tagsAtHead() {
  try {
    return execSync('git tag --points-at HEAD', { encoding: 'utf-8' })
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
  } catch {
    return null; // no git available (e.g. tarball checkout)
  }
}

if (version && EXACT.test(version)) {
  const tags = tagsAtHead();
  if (tags === null) {
    errors.push(`version ${version} is an exact release version but git is unavailable to verify the tag`);
  } else if (!tags.includes(`v${version}`)) {
    errors.push(
      `version ${version} is an exact release version but no tag v${version} points at HEAD` +
        ` (tags found: ${tags.length > 0 ? tags.join(', ') : 'none'})` +
        ' - release commits must be tagged v<version>',
    );
  }
} else if (version && DEV.test(version)) {
  const tags = tagsAtHead();
  if (tags && tags.some((t) => /^v\d+\.\d+\.\d+$/.test(t))) {
    errors.push(
      `version ${version} is a development version but a release tag (${tags.join(', ')}) points at HEAD` +
        ' - release tags must point at an exact-version commit (versioning policy Option B)',
    );
  }
} else if (version) {
  errors.push(
    `package.json version "${version}" is neither X.Y.Z (release) nor X.Y.Z-dev (development, policy Option B)`,
  );
}

if (errors.length > 0) {
  console.error('version consistency check FAILED:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`version consistency OK (${version})`);
