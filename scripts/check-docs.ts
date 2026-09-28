/**
 * Documentation gate CLI: `npm run check:docs`.
 *
 * Thin wrapper around the check logic in scripts/docs-checks.ts, which is
 * where the rules and their comments live (and which the regression tests
 * in tests/docs-gate.test.ts import). Read-only, no arguments.
 */

import { LINK_CHECKED, repoTags, runChecks, schemaSettings } from './docs-checks';

function main(): void {
  const { errors, skipped } = runChecks();
  const tags = repoTags().length;
  if (errors.length) {
    console.error('documentation check FAILED:\n');
    for (const e of errors) console.error('  - ' + e);
    if (skipped.length) {
      console.error('');
      for (const s of skipped) console.error('  ! skipped: ' + s);
    }
    console.error('');
    process.exit(1);
  }
  for (const s of skipped) console.log(`documentation check: skipped ${s}`);
  console.log(`documentation check OK (${LINK_CHECKED.length} files, ${tags} tags, ${schemaSettings().length} settings)`);
}

main();
