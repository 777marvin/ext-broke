/**
 * Tracked-file gate (npm run check:files).
 *
 * WHY THIS EXISTS. The release artifact is built with
 *
 *   git archive --format=tar.gz --output="broke-vX.Y.Z.tar.gz" vX.Y.Z
 *
 * - no pathspec, no exclude. EVERY tracked file therefore ships to every
 * user of every release, inside a signed and checksum-verified asset that
 * the updater deliberately refuses to touch. A .gitignore entry is not
 * enough protection, because the problem is not "does git see it" but
 * "is it in the tree that gets archived" - which is decided by the index,
 * not by the ignore rules.
 *
 * That is not hypothetical: tasks/plan.md and tasks/todo.md, the
 * maintainer's German-language working notes for the cache-friendly-mode
 * design, were tracked, and therefore shipped inside broke-v1.3.0.tar.gz.
 * .gitignore now keeps new files out, but only an allowlist stops the
 * class of accident, so that is what this checks.
 *
 * The allowlist is the shape of the project, not a list of current
 * files: extension sources at the root, the three JSX components, the
 * repo's own documentation and license, and four directories that hold
 * only their own kind of thing.
 */

import { execFileSync } from 'node:child_process';

export const REPO_ROOT = process.cwd();

/** Root files that are expected, listed explicitly so the set stays reviewable. */
export const ROOT_FILES = new Set([
  '.gitignore',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'ConfigComponent.jsx',
  'LICENSE',
  'MessageMenuItem.jsx',
  'README.md',
  'SECURITY.md',
  'StatusBadge.jsx',
  'package-lock.json',
  'package.json',
  'tsconfig.json',
]);

/** Root patterns. The extension entry points are the root *.ts files. */
export const ROOT_PATTERNS = [/\.ts$/];

/** Directories whose contents are all expected, to any depth. */
export const ALLOWED_DIRS = ['.github/', 'docs/', 'scripts/', 'tests/'];

/** True when a tracked path belongs to the extension or its documentation. */
export function isExpectedFile(path: string): boolean {
  if (ALLOWED_DIRS.some((d) => path.startsWith(d))) return true;
  if (path.includes('/')) return false; // a file in an unexpected root directory
  return ROOT_FILES.has(path) || ROOT_PATTERNS.some((re) => re.test(path));
}

/**
 * Returns one message per tracked path that does not belong. Paths are
 * reported verbatim (git always uses forward slashes) so the message can
 * be pasted into a command.
 */
export function findUnexpectedFiles(tracked: string[]): string[] {
  return tracked.filter((p) => !isExpectedFile(p)).map((p) => `tracked file outside the allowlist -> ${p} (it would ship in the next release tarball)`);
}

export function repoTrackedFiles(root = REPO_ROOT): string[] {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
}

export function runChecks(root = REPO_ROOT): string[] {
  return findUnexpectedFiles(repoTrackedFiles(root));
}
