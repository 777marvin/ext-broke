/**
 * Tracked-file gate CLI: `npm run check:files`.
 *
 * Thin wrapper around scripts/file-checks.ts, which holds the rules and
 * the reasoning (and is what tests/files-gate.test.ts imports). Read-only,
 * no arguments.
 */

import { findUnexpectedFiles, repoTrackedFiles } from './file-checks';

function main(): void {
  const tracked = repoTrackedFiles();
  const errors = findUnexpectedFiles(tracked);
  if (errors.length) {
    console.error('tracked-file check FAILED:\n');
    for (const e of errors) console.error('  - ' + e);
    console.error('');
    console.error('Either unstage it (git rm --cached <path>), gitignore the directory,');
    console.error('or add it to ROOT_FILES in scripts/file-checks.ts if it really belongs.');
    process.exit(1);
  }
  console.log(`tracked-file check OK (${tracked.length} files, all inside the allowlist)`);
}

main();
