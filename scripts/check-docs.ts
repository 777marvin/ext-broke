/**
 * Documentation gate CLI: `npm run check:docs`.
 *
 * Thin wrapper around the check logic in scripts/docs-checks.ts, which is
 * where the rules and their comments live (and which the regression tests
 * in tests/docs-gate.test.ts import). Read-only, no arguments.
 */

import { LINK_CHECKED, repoTags, runChecks, schemaSettings } from './docs-checks';

function main(): void {
  const errors = runChecks();
  if (errors.length) {
    console.error('documentation check FAILED:\n');
    for (const e of errors) console.error('  - ' + e);
    console.error('');
    process.exit(1);
  }
  console.log(`documentation check OK (${LINK_CHECKED.length} files, ${repoTags().length} tags, ${schemaSettings().length} settings)`);
}

main();
