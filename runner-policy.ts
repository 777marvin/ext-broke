/**
 * Runner argument validation policy for allowlisted diagnostic runners (broke_check).
 *
 * Enforces a strict allowlist of flags, safe argument bounds, canonical
 * workspace containment for input/output paths, and integer ranges.
 *
 * NOTE: This allowlist restricts diagnostic runner options and path values to
 * prevent accidental workspace escapes and option injection; it is not an
 * operating-system sandbox. Running repository test/compiler suites inherently
 * executes repository code.
 */

import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { AllowedRunner } from './agent-core';
import { forwardSlash, isSafeWorkspaceRelPath } from './indexer';

const MAX_ARGS_COUNT = 16;
const MAX_ARG_LENGTH = 200;
const SHELL_META_REGEX = /[;&|`$<>()\r\n\0]/;

const PYTEST_TB_STYLES: ReadonlySet<string> = new Set([
  'auto',
  'long',
  'short',
  'line',
  'native',
  'no',
]);

const VITEST_REPORTERS: ReadonlySet<string> = new Set([
  'default',
  'verbose',
  'dot',
  'junit',
  'json',
  'tap',
]);

function isIntegerInRange(value: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(value)) return false;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= min && n <= max;
}

/**
 * Validate that an input file path exists strictly within the canonical
 * workspace root, is not a symlink escaping root, and matches safe file rules.
 */
function validateInputFilePath(relPath: string, root: string): { ok: true; rel: string } | { ok: false; reason: string } {
  if (isAbsolute(relPath) || relPath.includes('..')) {
    return { ok: false, reason: `path traversal or absolute path is not allowed: ${relPath}` };
  }
  const normRel = forwardSlash(relPath);
  if (!isSafeWorkspaceRelPath(normRel)) {
    return { ok: false, reason: `access denied: "${relPath}" matches a protected, sensitive, or skipped path` };
  }
  try {
    const canonicalRoot = realpathSync(root);
    const candidateAbs = resolve(canonicalRoot, normRel);
    if (!existsSync(candidateAbs)) {
      return { ok: false, reason: `file does not exist in workspace: ${relPath}` };
    }
    const lst = lstatSync(candidateAbs);
    if (lst.isSymbolicLink()) {
      const canonicalFile = realpathSync(candidateAbs);
      const rel = forwardSlash(relative(canonicalRoot, canonicalFile));
      if (rel.startsWith('..') || isAbsolute(rel) || !isSafeWorkspaceRelPath(rel)) {
        return { ok: false, reason: `symlink escapes workspace or points to sensitive target: ${relPath}` };
      }
      if (!statSync(canonicalFile).isFile()) {
        return { ok: false, reason: `expected regular file: ${relPath}` };
      }
    } else if (!lst.isFile()) {
      return { ok: false, reason: `expected regular file: ${relPath}` };
    }
    return { ok: true, rel: normRel };
  } catch (err) {
    return { ok: false, reason: `could not validate path "${relPath}": ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Validate that an output file path (e.g. --junitxml) is strictly inside the
 * canonical workspace root, does not traverse, does not escape through symlinks,
 * and its parent directory exists and is safe.
 */
function validateOutputFilePath(relPath: string, root: string): { ok: true; rel: string } | { ok: false; reason: string } {
  if (isAbsolute(relPath) || relPath.includes('..')) {
    return { ok: false, reason: `output path must be relative to workspace without traversal: ${relPath}` };
  }
  const normRel = forwardSlash(relPath);
  if (!isSafeWorkspaceRelPath(normRel)) {
    return { ok: false, reason: `output path cannot target sensitive or hidden files: ${relPath}` };
  }
  try {
    const canonicalRoot = realpathSync(root);
    const targetAbs = resolve(canonicalRoot, normRel);
    const parentDir = dirname(targetAbs);
    if (!existsSync(parentDir)) {
      return { ok: false, reason: `parent directory does not exist: ${dirname(relPath)}` };
    }
    const canonicalParent = realpathSync(parentDir);
    const relParent = forwardSlash(relative(canonicalRoot, canonicalParent));
    if (relParent.startsWith('..') || isAbsolute(relParent)) {
      return { ok: false, reason: `output directory escapes workspace: ${dirname(relPath)}` };
    }
    if (existsSync(targetAbs)) {
      const lst = lstatSync(targetAbs);
      if (lst.isSymbolicLink()) {
        const canonicalTarget = realpathSync(targetAbs);
        const relTarget = forwardSlash(relative(canonicalRoot, canonicalTarget));
        if (relTarget.startsWith('..') || isAbsolute(relTarget) || !isSafeWorkspaceRelPath(relTarget)) {
          return { ok: false, reason: `output symlink escapes workspace: ${relPath}` };
        }
      } else if (!lst.isFile()) {
        return { ok: false, reason: `existing output target is not a regular file: ${relPath}` };
      }
    }
    return { ok: true, rel: normRel };
  } catch (err) {
    return { ok: false, reason: `could not validate output path "${relPath}": ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Parse arguments into normalized tokens, expanding `--flag=value` into
 * `['--flag', 'value']` for uniform policy validation.
 */
function splitFlagValue(arg: string): [string, string | null] {
  if (arg.startsWith('--') && arg.includes('=')) {
    const eq = arg.indexOf('=');
    return [arg.slice(0, eq), arg.slice(eq + 1)];
  }
  return [arg, null];
}

export function validateRunnerArgs(
  runner: AllowedRunner,
  args: readonly string[],
  root: string,
): { ok: true; safeArgs: string[] } | { ok: false; reason: string };
export function validateRunnerArgs(
  args: readonly string[],
): { ok: true; safeArgs: string[] } | { ok: false; reason: string };
export function validateRunnerArgs(
  runnerOrArgs: AllowedRunner | readonly string[],
  argsOrRoot?: readonly string[] | string,
  maybeRoot?: string,
): { ok: true; safeArgs: string[] } | { ok: false; reason: string } {
  if (Array.isArray(runnerOrArgs)) {
    const args = runnerOrArgs;
    if (args.length > MAX_ARGS_COUNT) {
      return { ok: false, reason: `too many arguments (max ${MAX_ARGS_COUNT})` };
    }
    const forbiddenFlagRe =
      /^(-c|--eval|-e|--import|--require|--loader|--prefix|--userconfig|--globalconfig|--init-module|--eval)/i;
    const safeArgs: string[] = [];
    for (const arg of args) {
      if (typeof arg !== 'string' || arg.length === 0 || arg.length > MAX_ARG_LENGTH) {
        return { ok: false, reason: 'invalid or oversized argument' };
      }
      if (SHELL_META_REGEX.test(arg)) {
        return { ok: false, reason: `argument contains forbidden metacharacters: ${arg}` };
      }
      if (forbiddenFlagRe.test(arg)) {
        return { ok: false, reason: `argument flag is not allowed in broke_check: ${arg}` };
      }
      if (arg.includes('..') || isAbsolute(arg)) {
        return { ok: false, reason: `path traversal or absolute path is not allowed in broke_check args: ${arg}` };
      }
      safeArgs.push(arg);
    }
    return { ok: true, safeArgs };
  }

  const runner = runnerOrArgs as AllowedRunner;
  const args = (argsOrRoot ?? []) as readonly string[];
  const root = typeof maybeRoot === 'string' ? maybeRoot : process.cwd();
  if (args.length > MAX_ARGS_COUNT) {
    return { ok: false, reason: `too many arguments (max ${MAX_ARGS_COUNT})` };
  }

  // Pre-screen individual argument length and forbidden metacharacters
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > MAX_ARG_LENGTH) {
      return { ok: false, reason: 'invalid or oversized argument' };
    }
    if (SHELL_META_REGEX.test(arg)) {
      return { ok: false, reason: `argument contains forbidden metacharacters: ${arg}` };
    }
  }

  const safeArgs: string[] = [];

  switch (runner) {
    case 'npm-test':
    case 'npm-typecheck':
    case 'npm-check-docs':
    case 'npm-check-files': {
      if (args.length > 0) {
        return { ok: false, reason: `runner "${runner}" does not accept extra arguments` };
      }
      return { ok: true, safeArgs: [] };
    }

    case 'tsc': {
      // Allowed: --project/-p <file>, --noEmit, --pretty <true/false>
      for (let i = 0; i < args.length; i++) {
        const raw = args[i]!;
        const [flag, val] = splitFlagValue(raw);

        if (flag === '--noEmit') {
          if (val !== null) return { ok: false, reason: '--noEmit does not take a value' };
          safeArgs.push('--noEmit');
        } else if (flag === '--project' || flag === '-p') {
          const target = val !== null ? val : args[++i];
          if (!target) return { ok: false, reason: `${flag} requires a path argument` };
          const checked = validateInputFilePath(target, root);
          if (!checked.ok) return checked;
          safeArgs.push(flag, checked.rel);
        } else if (flag === '--pretty') {
          const target = val !== null ? val : args[++i];
          if (target !== 'true' && target !== 'false') {
            return { ok: false, reason: '--pretty requires "true" or "false"' };
          }
          safeArgs.push('--pretty', target);
        } else {
          return { ok: false, reason: `unrecognized option for tsc: ${raw}` };
        }
      }
      return { ok: true, safeArgs };
    }

    case 'pytest': {
      // Allowed: workspace test paths (with optional ::selector), -q, -v, -vv, -x, -s,
      // --collect-only, --maxfail <1-100>, --tb <auto|long|short|line|native|no>, --junitxml <path>
      for (let i = 0; i < args.length; i++) {
        const raw = args[i]!;
        const [flag, val] = splitFlagValue(raw);

        if (['-q', '-v', '-vv', '-x', '-s', '--collect-only'].includes(flag)) {
          if (val !== null) return { ok: false, reason: `${flag} does not take a value` };
          safeArgs.push(flag);
        } else if (flag === '--maxfail') {
          const target = val !== null ? val : args[++i];
          if (!target || !isIntegerInRange(target, 1, 100)) {
            return { ok: false, reason: '--maxfail requires an integer between 1 and 100' };
          }
          safeArgs.push('--maxfail', target);
        } else if (flag === '--tb') {
          const target = val !== null ? val : args[++i];
          if (!target || !PYTEST_TB_STYLES.has(target)) {
            return { ok: false, reason: `--tb style must be one of: ${[...PYTEST_TB_STYLES].join(', ')}` };
          }
          safeArgs.push('--tb', target);
        } else if (flag === '--junitxml') {
          const target = val !== null ? val : args[++i];
          if (!target) return { ok: false, reason: '--junitxml requires an output path' };
          const checked = validateOutputFilePath(target, root);
          if (!checked.ok) return checked;
          safeArgs.push('--junitxml', checked.rel);
        } else if (!raw.startsWith('-')) {
          // Positional workspace test path with optional ::selector
          const parts = raw.split('::');
          const filePath = parts[0]!;
          const checked = validateInputFilePath(filePath, root);
          if (!checked.ok) return checked;
          for (let p = 1; p < parts.length; p++) {
            if (!/^[a-zA-Z0-9_.-]+$/.test(parts[p]!)) {
              return { ok: false, reason: `invalid pytest selector: ${parts[p]}` };
            }
          }
          safeArgs.push(parts.length > 1 ? `${checked.rel}::${parts.slice(1).join('::')}` : checked.rel);
        } else {
          return { ok: false, reason: `unrecognized option for pytest: ${raw}` };
        }
      }
      return { ok: true, safeArgs };
    }

    case 'vitest': {
      // Allowed: workspace test paths, --passWithNoTests, --reporter <default/verbose/dot/junit/json/tap>
      for (let i = 0; i < args.length; i++) {
        const raw = args[i]!;
        const [flag, val] = splitFlagValue(raw);

        if (flag === '--passWithNoTests') {
          if (val !== null) return { ok: false, reason: '--passWithNoTests does not take a value' };
          safeArgs.push('--passWithNoTests');
        } else if (flag === '--reporter') {
          const target = val !== null ? val : args[++i];
          if (!target || !VITEST_REPORTERS.has(target)) {
            return { ok: false, reason: `--reporter must be one of: ${[...VITEST_REPORTERS].join(', ')}` };
          }
          safeArgs.push('--reporter', target);
        } else if (!raw.startsWith('-')) {
          const checked = validateInputFilePath(raw, root);
          if (!checked.ok) return checked;
          safeArgs.push(checked.rel);
        } else {
          return { ok: false, reason: `unrecognized option for vitest: ${raw}` };
        }
      }
      return { ok: true, safeArgs };
    }

    case 'jest': {
      // Allowed: --runInBand, --ci, `--silent`, `--verbose`, `--passWithNoTests`,
      // `--runTestsByPath` with workspace files, positional workspace files
      for (let i = 0; i < args.length; i++) {
        const raw = args[i]!;
        const [flag, val] = splitFlagValue(raw);

        if (['--runInBand', '--ci', '--silent', '--verbose', '--passWithNoTests'].includes(flag)) {
          if (val !== null) return { ok: false, reason: `${flag} does not take a value` };
          safeArgs.push(flag);
        } else if (flag === '--runTestsByPath') {
          safeArgs.push('--runTestsByPath');
          if (val !== null) {
            const checked = validateInputFilePath(val, root);
            if (!checked.ok) return checked;
            safeArgs.push(checked.rel);
          }
        } else if (!raw.startsWith('-')) {
          const checked = validateInputFilePath(raw, root);
          if (!checked.ok) return checked;
          safeArgs.push(checked.rel);
        } else {
          return { ok: false, reason: `unrecognized option for jest: ${raw}` };
        }
      }
      return { ok: true, safeArgs };
    }

    case 'cargo-check': {
      // Allowed: --all-targets, --all-features, --no-default-features, --offline, --locked,
      // --package <name>, --manifest-path <file>
      for (let i = 0; i < args.length; i++) {
        const raw = args[i]!;
        const [flag, val] = splitFlagValue(raw);

        if (['--all-targets', '--all-features', '--no-default-features', '--offline', '--locked'].includes(flag)) {
          if (val !== null) return { ok: false, reason: `${flag} does not take a value` };
          safeArgs.push(flag);
        } else if (flag === '--package') {
          const target = val !== null ? val : args[++i];
          if (!target || !/^[a-zA-Z0-9_-]+$/.test(target)) {
            return { ok: false, reason: 'invalid crate name for --package' };
          }
          safeArgs.push('--package', target);
        } else if (flag === '--manifest-path') {
          const target = val !== null ? val : args[++i];
          if (!target) return { ok: false, reason: '--manifest-path requires a path' };
          const checked = validateInputFilePath(target, root);
          if (!checked.ok) return checked;
          safeArgs.push('--manifest-path', checked.rel);
        } else {
          return { ok: false, reason: `unrecognized option for cargo-check: ${raw}` };
        }
      }
      return { ok: true, safeArgs };
    }

    case 'go-test': {
      // Allowed: -v, -short, -race, -count <1-100>, -run <name>, workspace packages including ./...
      for (let i = 0; i < args.length; i++) {
        const raw = args[i]!;
        const [flag, val] = splitFlagValue(raw);

        if (['-v', '-short', '-race'].includes(flag)) {
          if (val !== null) return { ok: false, reason: `${flag} does not take a value` };
          safeArgs.push(flag);
        } else if (flag === '-count') {
          const target = val !== null ? val : args[++i];
          if (!target || !isIntegerInRange(target, 1, 100)) {
            return { ok: false, reason: '-count requires an integer between 1 and 100' };
          }
          safeArgs.push('-count', target);
        } else if (flag === '-run') {
          const target = val !== null ? val : args[++i];
          if (!target || !/^[a-zA-Z0-9_./-]+$/.test(target)) {
            return { ok: false, reason: 'invalid test pattern for -run' };
          }
          safeArgs.push('-run', target);
        } else if (!raw.startsWith('-')) {
          // Package path like ./... or ./pkg/...
          if (raw.includes('..') && !raw.startsWith('./...') && !raw.endsWith('/...')) {
            return { ok: false, reason: 'traversal is not allowed in go package path' };
          }
          safeArgs.push(raw);
        } else {
          return { ok: false, reason: `unrecognized option for go-test: ${raw}` };
        }
      }
      return { ok: true, safeArgs };
    }

    default:
      return { ok: false, reason: `unsupported runner: ${String(runner)}` };
  }
}
