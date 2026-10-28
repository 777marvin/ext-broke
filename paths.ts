/**
 * BRK-016 (external review 2026-08-29): runtime user data must never live
 * next to the swappable extension code. Every updater/deploy path replaces
 * the installation directory - mutable state inside it was the root cause
 * of several findings (BRK-004, -006, -010, -011 preserve-list coupling).
 *
 * This module owns the ONE path decision: a stable, versioned runtime root
 * that sits OUTSIDE the swap path, plus a resumable, verified migration
 * that moves legacy artifacts out of the installation tree into the new
 * layout. Every other module derives its default paths from here; the
 * BROKE_* env overrides keep working on top (tests + host isolation).
 *
 * Layout under runtimeDir():
 *   config.json            - settings
 *   setup.json             - versioned introduction dismissal, separate from settings
 *   ledgers/stats.jsonl    - per-task stats ledger
 *   ledgers/measure.jsonl  - per-run measurement ledger
 *   snapshots/<task>/      - milestone snapshots + undo files
 *   index/<projectHash>/   - keyword index stores
 *   errors/                - error archive
 */

import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { acquireFileLock, releaseUpdateLock } from './update-lock';

/** Where the extension code is installed (the swappable directory). */
const INSTALL_DIR = __dirname;

/** Completion marker, rechecked whenever legacy artifacts still exist. */
const MIGRATION_MARKER = '.migrated-v1';

/**
 * Runtime data root: BROKE_DATA_DIR override, else
 * `<installDir>/../.broke-data/v1` - a SIBLING of the installation, so an
 * updater/deploy swap of the install directory cannot touch it. Pure path
 * resolution: nothing is created here, write sites mkdir recursively.
 */
export function runtimeDir(): string {
  return process.env.BROKE_DATA_DIR ?? join(INSTALL_DIR, '..', '.broke-data', 'v1');
}

export interface MigrationOptions {
  copyFile?: (from: string, to: string) => void;
  onIssue?: (message: string) => void;
}

/** Validate before even creating a lock, removing a marker or making parents. */
function validateMigrationRoots(legacy: string, target: string): void {
  let current = target;
  for (;;) {
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`destination is linked or not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (current === parent) break;
    current = parent;
  }
  current = target;
  const missing: string[] = [];
  while (!existsSync(current)) { missing.unshift(basename(current)); current = dirname(current); }
  const canonicalTarget = resolve(realpathSync(current), ...missing);
  const canonicalSource = realpathSync(legacy);
  const within = (base: string, path: string) => {
    const rel = relative(base, path);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
  };
  if (within(canonicalSource, canonicalTarget) || within(canonicalTarget, canonicalSource)) throw new Error('legacy and destination roots overlap; originals retained');
}

function fileDigest(path: string): string {
  const fd = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

/** Publish files exclusively: a race can never overwrite an existing target. */
function migrateArtifact(from: string, to: string, staging: string, options: MigrationOptions): boolean {
  if (!existsSync(from)) return true;
  try {
    const source = lstatSync(from);
    if (source.isSymbolicLink()) throw new Error(`source symlink retained: ${from}`);
    if (source.isDirectory()) {
      if (!existsSync(to)) mkdirSync(to, { mode: 0o700 });
      const target = lstatSync(to);
      if (!target.isDirectory() || target.isSymbolicLink()) throw new Error(`destination conflict: ${to}`);
      let complete = true;
      for (const name of readdirSync(from)) {
        if (!migrateArtifact(join(from, name), join(to, name), staging, options)) complete = false;
      }
      if (complete) rmdirSync(from);
      return complete;
    }
    if (!source.isFile()) throw new Error(`unsupported source retained: ${from}`);
    const expected = fileDigest(from);
    if (!existsSync(to)) {
      const temporary = join(staging, randomUUID());
      (options.copyFile ?? copyFileSync)(from, temporary);
      if (fileDigest(temporary) !== expected) throw new Error(`copy verification failed: ${from}`);
      chmodSync(temporary, 0o600);
      const fd = openSync(temporary, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      // A hard link publishes a complete same-filesystem file without clobber.
      // If another writer created the destination, verify it below instead.
      try { linkSync(temporary, to); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const target = lstatSync(to);
    if (!target.isFile() || target.isSymbolicLink() || fileDigest(to) !== expected) throw new Error(`destination conflict: ${to}; legacy source retained`);
    const current = lstatSync(from);
    if (current.size !== source.size || current.mtimeMs !== source.mtimeMs || fileDigest(from) !== expected) throw new Error(`source changed during migration: ${from}`);
    unlinkSync(from);
    return true;
  } catch (error) {
    options.onIssue?.(error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Resumable migration of runtime data into the versioned runtime root.
 * Verified staged copies never overwrite conflicting targets; unresolved
 * sources stay in place. The completion marker is written only on success,
 * so failed files or directories can be retried on subsequent starts.
 * Paths and copy operations are injectable for hermetic tests.
 */
export function migrateLegacyRuntimeData(legacyDir: string = INSTALL_DIR, targetDir: string = runtimeDir(), options: MigrationOptions = {}): boolean {
  const target = resolve(targetDir);
  let claim;
  let staging: string | undefined;
  try {
    validateMigrationRoots(legacyDir, target);
    mkdirSync(dirname(target), { recursive: true });
    const lock = acquireFileLock(`${target}.migration.lock`);
    if (!lock.ok) { options.onIssue?.(lock.reason); return false; }
    claim = lock.claim;
    const mappings = [
      ['config.json', 'config.json'], ['stats.jsonl', 'ledgers/stats.jsonl'],
      ['measure.jsonl', 'ledgers/measure.jsonl'], ['snapshots', 'snapshots'],
      ['index', 'index'], ['errors', 'errors'],
    ];
    const marker = join(target, MIGRATION_MARKER);
    const legacyExists = mappings.some(([from]) => existsSync(join(legacyDir, from)));
    if (existsSync(marker) && !legacyExists) return true;
    if (existsSync(marker)) unlinkSync(marker);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    mkdirSync(join(target, 'ledgers'), { recursive: true, mode: 0o700 });
    if (lstatSync(join(target, 'ledgers')).isSymbolicLink()) throw new Error('destination ledger directory is a link; migration refused');
    staging = join(target, `.migration-${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    const results = mappings.map(([from, to]) => migrateArtifact(join(legacyDir, from), join(target, to), staging!, options));
    const allSucceeded = results.every(Boolean);
    if (allSucceeded) {
      const markerStage = join(staging, 'complete');
      writeFileSync(markerStage, new Date().toISOString(), { encoding: 'utf-8', mode: 0o600 });
      linkSync(markerStage, marker);
      return true;
    }
    return false;
  } catch (error) {
    options.onIssue?.(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    // Only this invocation's generated staging directory is ever removed.
    if (staging && dirname(staging) === target) {
      try { rmSync(staging, { recursive: true, force: true }); } catch { /* retry remains safe */ }
    }
    if (claim) releaseUpdateLock(claim);
  }
}
