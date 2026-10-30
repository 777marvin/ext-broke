import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runAgentCheck, type AllowedRunner } from '../agent-core';
import { runCli } from '../cli';
import { DEFAULT_CONFIG } from '../config';

// The new runner-policy module to be implemented in Package C
let validateRunnerArgs: (
  runner: AllowedRunner,
  args: readonly string[],
  root: string,
) => { ok: true; safeArgs: string[] } | { ok: false; reason: string };

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runnerPolicyMod = require('../runner-policy');
  validateRunnerArgs = runnerPolicyMod.validateRunnerArgs;
} catch {
  // Fallback to agent-core export if runner-policy doesn't exist yet (for RED testing)
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const coreMod = require('../agent-core') as any;
  validateRunnerArgs = (runner: AllowedRunner, args: readonly string[], root: string) => {
    if (typeof coreMod.validateRunnerArgs === 'function') {
      // Baseline only took 1 argument args
      if (coreMod.validateRunnerArgs.length === 1) {
        return coreMod.validateRunnerArgs(args);
      }
      return coreMod.validateRunnerArgs(runner, args, root);
    }
    return { ok: false, reason: 'validateRunnerArgs not available' };
  };
}

function makeTempProject(): { dir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'broke-pr33-runner-'));
  return {
    dir: base,
    cleanup: () => {
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
        // ignore Windows file locks
      }
    },
  };
}

describe('PR #33 Package C: Strict Runner Options and Complete Process Output', () => {
  it('rejects external --junitxml paths and symlink escapes (Finding 4)', () => {
    const tmp = makeTempProject();
    try {
      const outsideDir = mkdtempSync(join(tmpdir(), 'broke-outside-'));
      try {
        const outsideXml = join(outsideDir, 'report.xml');

        // External absolute path embedded via =
        const res1 = validateRunnerArgs('pytest', [`--junitxml=${outsideXml}`], tmp.dir);
        assert.equal(res1.ok, false, 'expected rejection of absolute --junitxml=');
        assert.match(res1.reason, /workspace|outside|escape|absolute|path/i);

        // External absolute path via separate arguments
        const res2 = validateRunnerArgs('pytest', ['--junitxml', outsideXml], tmp.dir);
        assert.equal(res2.ok, false, 'expected rejection of absolute --junitxml <path>');
        assert.match(res2.reason, /workspace|outside|escape|absolute|path/i);

        // Path traversal via relative path
        const res3 = validateRunnerArgs('pytest', ['--junitxml', '../outside.xml'], tmp.dir);
        assert.equal(res3.ok, false, 'expected rejection of path traversal in --junitxml');

        // Escaping symlink directory
        let symlinkCreated = false;
        const symlinkDir = join(tmp.dir, 'link-outside');
        try {
          symlinkSync(outsideDir, symlinkDir, 'junction');
          symlinkCreated = true;
        } catch {
          // Junction creation might fail in restricted environments
        }

        if (symlinkCreated) {
          const res4 = validateRunnerArgs('pytest', ['--junitxml', 'link-outside/report.xml'], tmp.dir);
          assert.equal(res4.ok, false, 'expected rejection of --junitxml via escaping symlink');
          assert.match(res4.reason, /symlink|outside|escape/i);
        }

        // Project-internal valid output target in existing directory
        const reportsDir = join(tmp.dir, 'reports');
        mkdirSync(reportsDir, { recursive: true });
        const res5 = validateRunnerArgs('pytest', ['--junitxml', 'reports/test.xml'], tmp.dir);
        assert.equal(res5.ok, true, `expected internal --junitxml to be accepted: ${!res5.ok ? res5.reason : ''}`);
        if (res5.ok) {
          assert.deepEqual(res5.safeArgs, ['--junitxml', 'reports/test.xml']);
        }

        // Project-internal valid output target via --junitxml=path
        const res6 = validateRunnerArgs('pytest', ['--junitxml=reports/test2.xml'], tmp.dir);
        assert.equal(res6.ok, true, `expected internal --junitxml= to be accepted: ${!res6.ok ? res6.reason : ''}`);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('validates allowed options per runner (positive and negative cases)', () => {
    const tmp = makeTempProject();
    try {
      // 1. tsc
      writeFileSync(join(tmp.dir, 'tsconfig.check.json'), '{}', 'utf-8');
      const tscOk = validateRunnerArgs('tsc', ['--project', 'tsconfig.check.json', '--noEmit', '--pretty', 'false'], tmp.dir);
      assert.equal(tscOk.ok, true, !tscOk.ok ? tscOk.reason : '');
      const tscBad = validateRunnerArgs('tsc', ['--build'], tmp.dir);
      assert.equal(tscBad.ok, false, 'tsc should reject unknown flag --build');

      // 2. pytest
      writeFileSync(join(tmp.dir, 'test_sample.py'), 'def test_one(): pass\n', 'utf-8');
      const pyOk = validateRunnerArgs('pytest', [
        '-q', '-v', '-vv', '-x', '-s',
        '--collect-only', '--maxfail', '5',
        '--tb', 'short',
        'test_sample.py::test_one'
      ], tmp.dir);
      assert.equal(pyOk.ok, true, !pyOk.ok ? pyOk.reason : '');

      const pyBadMaxfail = validateRunnerArgs('pytest', ['--maxfail', '999'], tmp.dir);
      assert.equal(pyBadMaxfail.ok, false, 'pytest should reject maxfail > 100');

      const pyBadTb = validateRunnerArgs('pytest', ['--tb', 'invalid_tb'], tmp.dir);
      assert.equal(pyBadTb.ok, false, 'pytest should reject invalid --tb style');

      const pyBadFlag = validateRunnerArgs('pytest', ['--pdb'], tmp.dir);
      assert.equal(pyBadFlag.ok, false, 'pytest should reject unallowlisted flag --pdb');

      // 3. vitest
      writeFileSync(join(tmp.dir, 'app.test.ts'), 'test("ok", () => {});\n', 'utf-8');
      const vitOk = validateRunnerArgs('vitest', ['app.test.ts', '--passWithNoTests', '--reporter', 'verbose'], tmp.dir);
      assert.equal(vitOk.ok, true, !vitOk.ok ? vitOk.reason : '');
      const vitBad = validateRunnerArgs('vitest', ['--ui'], tmp.dir);
      assert.equal(vitBad.ok, false, 'vitest should reject --ui');

      // 4. jest
      const jestOk = validateRunnerArgs('jest', ['--runInBand', '--ci', '--silent', '--passWithNoTests', '--runTestsByPath', 'app.test.ts'], tmp.dir);
      assert.equal(jestOk.ok, true, !jestOk.ok ? jestOk.reason : '');
      const jestBad = validateRunnerArgs('jest', ['--watch'], tmp.dir);
      assert.equal(jestBad.ok, false, 'jest should reject --watch');

      // 5. npm-* (no extra args allowed)
      const npmOk = validateRunnerArgs('npm-test', [], tmp.dir);
      assert.equal(npmOk.ok, true);
      const npmBad = validateRunnerArgs('npm-test', ['--verbose'], tmp.dir);
      assert.equal(npmBad.ok, false, 'npm-test should reject extra arguments');

      // 6. cargo-check
      writeFileSync(join(tmp.dir, 'Cargo.toml'), '[package]\nname="app"\n', 'utf-8');
      const cargoOk = validateRunnerArgs('cargo-check', [
        '--all-targets', '--all-features', '--offline', '--locked', '--manifest-path', 'Cargo.toml'
      ], tmp.dir);
      assert.equal(cargoOk.ok, true, !cargoOk.ok ? cargoOk.reason : '');
      const cargoBad = validateRunnerArgs('cargo-check', ['--bin', 'main'], tmp.dir);
      assert.equal(cargoBad.ok, false, 'cargo-check should reject unallowlisted --bin');

      // 7. go-test
      const goOk = validateRunnerArgs('go-test', ['-v', '-short', '-race', '-count', '2', '-run', 'TestMain', './...'], tmp.dir);
      assert.equal(goOk.ok, true, !goOk.ok ? goOk.reason : '');
      const goBad = validateRunnerArgs('go-test', ['-exec', 'bash'], tmp.dir);
      assert.equal(goBad.ok, false, 'go-test should reject dangerous flags');
    } finally {
      tmp.cleanup();
    }
  });

  it('separates CLI broke flags from runner args with -- and keeps tsc --project (Finding 14)', async () => {
    const tmp = makeTempProject();
    try {
      const tsconfigPath = join(tmp.dir, 'tsconfig.check.json');
      writeFileSync(tsconfigPath, '{}', 'utf-8');

      let capturedCmd = '';
      let capturedArgs: string[] = [];
      let capturedCwd = '';

      const testDeps = {
        execRunner: (cmd: string, args: string[], cwd: string) => {
          capturedCmd = cmd;
          capturedArgs = args;
          capturedCwd = cwd;
          return { exitCode: 0, output: 'Success' };
        },
      };

      // Running CLI: broke check tsc -- --project tsconfig.check.json --noEmit
      const res1 = await runCli(['check', 'tsc', '--', '--project', 'tsconfig.check.json', '--noEmit'], {
        cwd: tmp.dir,
        deps: testDeps,
      });

      assert.equal(res1.exitCode, 0, res1.output);
      assert.ok(capturedCmd, 'runner binary must be invoked');
      assert.equal(capturedCwd, tmp.dir, 'workspace cwd should remain tmp.dir, not tsconfig file!');
      assert.ok(capturedArgs.includes('--project'), 'forwarded args must contain --project');
      assert.ok(capturedArgs.includes('tsconfig.check.json'), 'forwarded args must contain tsconfig filename');
      assert.ok(capturedArgs.includes('--noEmit'), 'forwarded args must contain --noEmit');

      // Running CLI without --: broke check tsc --project tsconfig.check.json --noEmit
      // --project should still NOT be swallowed as broke's root!
      const res2 = await runCli(['check', 'tsc', '--project', 'tsconfig.check.json', '--noEmit'], {
        cwd: tmp.dir,
        deps: testDeps,
      });
      assert.equal(res2.exitCode, 0, res2.output);
      assert.equal(capturedCwd, tmp.dir, 'workspace cwd should remain tmp.dir, not tsconfig.check.json');
      assert.ok(capturedArgs.includes('--project'), 'forwarded args must contain --project');
      assert.ok(capturedArgs.includes('tsconfig.check.json'));
    } finally {
      tmp.cleanup();
    }
  });

  it('retains stderr from successful execution (Finding 13)', async () => {
    const tmp = makeTempProject();
    try {
      // Injected runner exiting 0 with distinct stdout and stderr markers
      const testDeps = {
        execRunner: () => {
          return {
            exitCode: 0,
            output: 'STDOUT_PASSED_TESTS\nSTDERR_SYNTHETIC_WARNING',
          };
        },
      };

      const res = await runAgentCheck(
        tmp.dir,
        { runner: 'pytest', args: ['-s'] },
        'cli',
        DEFAULT_CONFIG,
        testDeps,
      );

      assert.equal(res.ok, true);
      assert.equal(res.exitCode, 0);
      assert.match(res.text, /STDOUT_PASSED_TESTS/);
      assert.match(res.text, /STDERR_SYNTHETIC_WARNING/);

      // Also verify with a real subprocess (node running inline script exiting 0 and writing both stdout & stderr)
      const realRes = await runAgentCheck(
        tmp.dir,
        { runner: 'tsc', args: ['--noEmit'] },
        'cli',
        DEFAULT_CONFIG,
        {
          execRunner: (_cmd, _args, cwd) => {
            // Run node child process that writes to stdout and stderr and exits 0
            const proc = spawnSync(
              process.execPath,
              ['-e', 'process.stdout.write("MARKER_REAL_STDOUT\\n"); process.stderr.write("MARKER_REAL_STDERR\\n"); process.exit(0);'],
              { cwd, encoding: 'utf-8', env: { ...process.env, NODE_V8_COVERAGE: '' } },
            );
            // Before fix, if someone only captured stdout:
            // The fix must combine both stdout and stderr
            const out = [proc.stdout, proc.stderr].filter(Boolean).join('\n');
            return { exitCode: proc.status ?? 0, output: out };
          },
        },
      );

      assert.equal(realRes.ok, true);
      assert.match(realRes.text, /MARKER_REAL_STDOUT/);
      assert.match(realRes.text, /MARKER_REAL_STDERR/);
    } finally {
      tmp.cleanup();
    }
  });

  it('reports timeout and process-start failure as actionable errors, never success', async () => {
    const tmp = makeTempProject();
    try {
      // Nonexistent runner execution / start failure
      const failStartDeps = {
        execRunner: () => {
          return {
            exitCode: 127,
            output: 'spawnSync nonexistent ENOENT: process failed to start',
          };
        },
      };

      const res1 = await runAgentCheck(
        tmp.dir,
        { runner: 'pytest' },
        'cli',
        DEFAULT_CONFIG,
        failStartDeps,
      );
      assert.equal(res1.ok, false);
      assert.equal(res1.exitCode, 127);
      assert.match(res1.text, /failed to start|ENOENT/i);

      // Timeout failure
      const timeoutDeps = {
        execRunner: () => {
          return {
            exitCode: 124,
            output: 'ETIMEDOUT: runner timed out after 60000ms',
          };
        },
      };
      const res2 = await runAgentCheck(
        tmp.dir,
        { runner: 'tsc' },
        'cli',
        DEFAULT_CONFIG,
        timeoutDeps,
      );
      assert.equal(res2.ok, false);
      assert.equal(res2.exitCode, 124);
      assert.match(res2.text, /timed out|ETIMEDOUT/i);
    } finally {
      tmp.cleanup();
    }
  });
});
