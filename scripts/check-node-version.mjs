/**
 * pretest guard: the test command relies on glob support in Node's built-in
 * test runner, which only exists from Node 21. `engines` says >=22, but npm
 * merely WARNS on an engines violation, so on a Node 20 machine `npm test`
 * dies with
 *
 *   Could not find 'C:\...\tests\*.test.ts'
 *
 * which reads like a broken repository rather than a wrong runtime. This
 * turns that into an explicit, actionable message. `npm ci` deliberately
 * stays usable on older Node (no engine-strict) - installing is harmless,
 * only the test glob is not.
 */
const version = process.versions.node;
const required = 22;
const major = Number(version.split('.')[0]);
if (!Number.isFinite(major) || major < required) {
  process.stderr.write(
    `\nbroke requires Node >= ${required} to run its tests, but this is Node ${version}.\n` +
      `The test command uses a glob in the Node test runner (supported from Node 21),\n` +
      `so on older versions it fails with a confusing "Could not find 'tests/*.test.ts'".\n\n` +
      `Install a supported Node (e.g. via nvm: 'nvm install ${required} && nvm use ${required}'), then run npm test again.\n` +
      `Installing dependencies still works on older Node - only running the tests needs ${required}+.\n\n`,
  );
  process.exit(1);
}
