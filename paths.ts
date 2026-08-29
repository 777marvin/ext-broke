/**
 * BRK-016 (external review 2026-08-29): runtime user data must never live
 * next to the swappable extension code. Every updater/deploy path replaces
 * the installation directory - mutable state inside it was the root cause
 * of several findings (BRK-004, -006, -010, -011 preserve-list coupling).
 *
 * This module owns the ONE path decision: a stable, versioned runtime root
 * that sits OUTSIDE the swap path, plus a one-time best-effort migration
 * that moves legacy artifacts out of the installation tree into the new
 * layout. Every other module derives its default paths from here; the
 * BROKE_* env overrides keep working on top (tests + host isolation).
 *
 * Layout under runtimeDir():
 *   config.json            - settings
 *   ledgers/stats.jsonl    - per-task stats ledger
 *   ledgers/measure.jsonl  - per-run measurement ledger
 *   snapshots/<task>/      - milestone snapshots + undo files
 *   index/<projectHash>/   - keyword index stores
 *   errors/                - error archive
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Where the extension code is installed (the swappable directory). */
const INSTALL_DIR = __dirname;

/** Marker that the one-time legacy migration already ran for this root. */
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

/**
 * Best-effort move of one legacy artifact into the new layout. Moves only
 * when the source exists AND the destination does not - newer data at the
 * target always wins, so a partially-applied migration can never destroy
 * anything. All failures are swallowed: a failed move leaves the legacy
 * copy in place for a later retry.
 */
function moveIfPossible(from: string, to: string): void {
  try {
    if (!existsSync(from) || existsSync(to)) return;
    mkdirSync(dirname(to), { recursive: true });
    try {
      renameSync(from, to);
    } catch {
      // Cross-device renames (EXDEV) and pinned files: fall back to
      // copy-then-remove for FILES; directories stay for a later retry.
      if (!existsSync(to) && !statIsDirectory(from)) {
        copyFileSync(from, to);
        rmSync(from, { force: true });
      }
    }
  } catch {
    // best effort - a failed move leaves the legacy copy in place
  }
}

function statIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * One-time migration of runtime data from the installation tree into the
 * versioned runtime root. Best-effort and idempotent (marker file):
 * anything that cannot be moved stays in place; the marker is written
 * regardless so the fast path stabilizes after the first run. Injectable
 * paths for hermetic tests.
 */
export function migrateLegacyRuntimeData(legacyDir: string = INSTALL_DIR, targetDir: string = runtimeDir()): void {
  try {
    const marker = join(targetDir, MIGRATION_MARKER);
    if (existsSync(marker)) return;

    // Move only what exists at the legacy default locations. Env overrides
    // (tests, host isolation) redirect the live modules elsewhere - the
    // legacy location is always the installation directory.
    moveIfPossible(join(legacyDir, 'config.json'), join(targetDir, 'config.json'));
    moveIfPossible(join(legacyDir, 'stats.jsonl'), join(targetDir, 'ledgers', 'stats.jsonl'));
    moveIfPossible(join(legacyDir, 'measure.jsonl'), join(targetDir, 'ledgers', 'measure.jsonl'));
    moveIfPossible(join(legacyDir, 'snapshots'), join(targetDir, 'snapshots'));
    moveIfPossible(join(legacyDir, 'index'), join(targetDir, 'index'));
    moveIfPossible(join(legacyDir, 'errors'), join(targetDir, 'errors'));

    mkdirSync(targetDir, { recursive: true });
    writeFileSync(marker, new Date().toISOString(), { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // best effort - worst case the legacy files stay and are moved later
  }
}
