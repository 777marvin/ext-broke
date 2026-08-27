/**
 * Self-update (/broke update): installs a tagged GitHub release into the
 * running extension installation (~/.aider-desk/extensions/broke), so the
 * normal update flow no longer needs scripts/deploy.ps1.
 *
 * Design constraints:
 * - The installation directory is IN USE while broke runs from it. On
 *   Windows an open directory handle (the config watcher) blocks renaming
 *   that folder, so the swap asks the host to close such handles first and
 *   falls back to replacing files one-by-one if some other handle still
 *   pins the directory. Both paths keep a backup and restore it on failure.
 * - Runtime state survives every update: config.json, the stats/measure
 *   ledgers incl. rotated files, the errors/ archive (size-capped) and
 *   node_modules - mirroring deploy.ps1's preserve list.
 * - Only tagged releases (vMAJOR.MINOR.PATCH) are ever installed, never a
 *   moving branch: what lands on disk is exactly what CI tested.
 * - Trust model (R1): releases are installed ONLY from signed artifacts -
 *   the release workflow attaches a source archive plus SHA256SUMS and an
 *   Ed25519 signature of that manifest. The updater verifies signature and
 *   checksum BEFORE anything is extracted; unsigned or tampered releases
 *   are refused outright.
 * - All network operations have hard timeouts; the tag is strictly
 *   validated before it may appear in a URL.
 */
import { exec, execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** The public repo releases are pulled from. */
export const UPDATE_REPO = { owner: '777marvin', repo: 'ext-broke' } as const;

/** Strict release-tag shape. Anything else never touches a URL or the disk. */
export const TAG_RE = /^v\d+\.\d+\.\d+$/;

/** Accepts 'v0.6.0' and '0.6.0', returns the canonical tag form or null. */
export function normalizeTag(input: string): string | null {
  const t = input.trim();
  const withV = /^\d+\.\d+\.\d+$/.test(t) ? `v${t}` : t;
  return TAG_RE.test(withV) ? withV : null;
}

/** Negative when version a < b. Inputs are plain 'MAJOR.MINOR.PATCH'. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const na = Number.isFinite(pa[i]) ? pa[i] : -1;
    const nb = Number.isFinite(pb[i]) ? pb[i] : -1;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Network primitives (each with its own hard timeout)
// ---------------------------------------------------------------------------

const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const EXTRACT_TIMEOUT_MS = 60_000;
const DEPS_TIMEOUT_MS = 180_000;
/** Sanity cap for the downloaded release artifact (the whole repo is well under 1 MB). */
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
/** SHA256SUMS / signature assets are tiny; anything larger is hostile. */
const MAX_SUMS_BYTES = 1024 * 1024;

/**
 * Ed25519 public key (SPKI DER, base64) whose private counterpart signs
 * every official release artifact (review R1). The private key lives ONLY
 * in the BROKE_RELEASE_SIGNING_KEY repository secret used by the release
 * workflow - it never travels with the code. The updater refuses any
 * release whose SHA256SUMS file does not carry this key's valid signature,
 * and refuses the artifact when its SHA-256 does not match the manifest.
 */
export const RELEASE_SIGNING_PUBLIC_KEY_B64 =
  'MCowBQYDK2VwAyEAgQkYOmgMDvywgIpei0OJ5lrbWFzj1hkCDPWJ6Cc+Zqs=';

/** Release asset names attached by .github/workflows/release.yml. */
export const SUMS_ASSET_NAME = 'SHA256SUMS';
export const SIG_ASSET_NAME = 'SHA256SUMS.sig';

/** Name of the signed source artifact for a tag ('v0.8.0' -> broke-v0.8.0.tar.gz). */
export function releaseAssetName(tag: string): string {
  return `broke-${tag}.tar.gz`;
}

/** Lowercase hex SHA-256 of `data`. */
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Expected checksum for `fileName` from a standard sha256sum-format
 * manifest ("<hex>  <name>" per line), or null when absent.
 */
export function checksumFromSums(sumsText: string, fileName: string): string | null {
  for (const line of sumsText.split('\n')) {
    const m = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (m && m[2] === fileName) return m[1].toLowerCase();
  }
  return null;
}

/** True when `signature` is a valid Ed25519 signature of `sums` under `publicKeyB64`. */
export function verifySumsSignature(sums: Uint8Array, signature: Uint8Array, publicKeyB64: string = RELEASE_SIGNING_PUBLIC_KEY_B64): boolean {
  if (signature.length === 0) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    // Ed25519: the algorithm parameter must be null (digest comes from the key).
    return verify(null, sums, key, signature);
  } catch {
    return false;
  }
}

/**
 * Full artifact verification: manifest signature first (trust anchor), then
 * the artifact's checksum against that manifest. Throws with a precise
 * reason on any failure - runUpdate refuses to touch the installation.
 * `publicKeyB64` defaults to the embedded release key; tests and future key
 * rotations can pass a different anchor.
 */
export function defaultVerifyRelease(
  sums: Uint8Array,
  signature: Uint8Array,
  artifact: Uint8Array,
  artifactName: string,
  publicKeyB64: string = RELEASE_SIGNING_PUBLIC_KEY_B64,
): void {
  if (!verifySumsSignature(sums, signature, publicKeyB64)) {
    throw new Error('release signature verification failed - artifacts are not signed with the official broke release key');
  }
  const expected = checksumFromSums(Buffer.from(sums).toString('utf-8'), artifactName);
  if (!expected) throw new Error(`${SUMS_ASSET_NAME} contains no entry for ${artifactName}`);
  const actual = sha256Hex(artifact);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${artifactName} - downloaded ${actual}, manifest says ${expected}`);
  }
}

async function defaultDownloadBytes(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'broke-extension' }, signal: controller.signal });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_SUMS_BYTES) throw new Error(`asset exceeds ${MAX_SUMS_BYTES} bytes - refusing`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'broke-extension', Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function defaultDownloadTarball(url: string, destFile: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_TARBALL_BYTES) throw new Error(`tarball exceeds ${MAX_TARBALL_BYTES} bytes - refusing`);
    writeFileSync(destFile, buf);
  } finally {
    clearTimeout(timer);
  }
}

async function defaultExtractTarball(archiveFile: string, destDir: string): Promise<void> {
  // System tar: bsdtar ships with Windows 10+, every Linux/macOS has one.
  // Keeps the updater dependency-free (no npm tar package to vet).
  await execFileAsync('tar', ['-xzf', archiveFile, '-C', destDir], { timeout: EXTRACT_TIMEOUT_MS });
}

async function defaultRunNpmCi(dir: string): Promise<void> {
  // Fixed command string without user input - shell use is required anyway
  // because npm is a .cmd shim on Windows that Node refuses to spawn directly.
  await execAsync('npm ci --omit=dev --no-audit --no-fund', { cwd: dir, timeout: DEPS_TIMEOUT_MS });
}

/** Injectable I/O surface - tests replace every piece with fakes. */
export interface UpdateDeps {
  fetchJson(url: string): Promise<unknown>;
  downloadTarball(url: string, destFile: string): Promise<void>;
  /** Small release assets (SHA256SUMS + signature), fetched into memory. */
  downloadBytes(url: string): Promise<Uint8Array>;
  extractTarball(archiveFile: string, destDir: string): Promise<void>;
  runNpmCi(dir: string): Promise<void>;
  /**
   * Release verification (R1). Defaults to {@link defaultVerifyRelease}
   * against the embedded public key; tests inject stubs to exercise the
   * failure paths without holding the real private key.
   */
  verifyRelease(sums: Uint8Array, signature: Uint8Array, artifact: Uint8Array, artifactName: string): void;
}

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

function tagFromUnknown(v: unknown): string | null {
  return typeof v === 'string' ? normalizeTag(v) : null;
}

/**
 * Latest released version. Primary source is /releases/latest (what
 * `gh release create` publishes); repos that have tags but no release yet
 * fall back to the highest-semver tag. Unauthenticated API access is fine
 * here: /broke update runs when a human asks for it, not on a timer.
 */
export async function resolveLatestVersion(
  fetchJson: (url: string) => Promise<unknown> = defaultFetchJson,
): Promise<{ tag: string; version: string }> {
  let lastError = 'unknown error';
  try {
    const rel = await fetchJson(`https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/latest`);
    const tag = rel && typeof rel === 'object' ? tagFromUnknown((rel as Record<string, unknown>).tag_name) : null;
    if (tag) return { tag, version: tag.slice(1) };
    lastError = 'latest release has no valid vMAJOR.MINOR.PATCH tag';
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
  try {
    const tags = await fetchJson(`https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/tags?per_page=100`);
    let best: string | null = null;
    if (Array.isArray(tags)) {
      for (const entry of tags) {
        const t = entry && typeof entry === 'object' ? tagFromUnknown((entry as Record<string, unknown>).name) : null;
        if (!t) continue;
        // Semver compare, not lexicographic: v0.10.0 > v0.9.0.
        if (!best || compareSemver(t.slice(1), best.slice(1)) > 0) best = t;
      }
    }
    if (best) return { tag: best, version: best.slice(1) };
    throw new Error(lastError === 'unknown error' ? 'no valid release tag found' : lastError);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot resolve latest broke release (${reason})`);
  }
}

/**
 * Assets of one release (name -> browser_download_url). Missing/malformed
 * entries are skipped; the caller decides which assets are REQUIRED.
 */
export function assetsFromRelease(rel: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (rel && typeof rel === 'object' && Array.isArray((rel as Record<string, unknown>).assets)) {
    for (const a of (rel as { assets: unknown[] }).assets) {
      if (
        a &&
        typeof a === 'object' &&
        typeof (a as Record<string, unknown>).name === 'string' &&
        typeof (a as Record<string, unknown>).browser_download_url === 'string'
      ) {
        out.set((a as { name: string }).name, (a as { browser_download_url: string }).browser_download_url);
      }
    }
  }
  return out;
}

/**
 * Resolve the release to install - latest when `tag` is undefined, else the
 * exact tag. Unlike resolveLatestVersion (check mode), install mode REQUIRES
 * a release object with assets: unsigned tags cannot be installed (R1).
 */
async function fetchRelease(
  fetchJson: (url: string) => Promise<unknown>,
  tag?: string,
): Promise<{ tag: string; version: string; assets: Map<string, string> }> {
  const path = tag ? `/releases/tags/${tag}` : '/releases/latest';
  try {
    const rel = await fetchJson(`https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}${path}`);
    const resolvedTag =
      tag ??
      (rel && typeof rel === 'object' ? tagFromUnknown((rel as Record<string, unknown>).tag_name) : null);
    if (!resolvedTag) throw new Error('release has no valid vMAJOR.MINOR.PATCH tag');
    return { tag: resolvedTag, version: resolvedTag.slice(1), assets: assetsFromRelease(rel) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot resolve broke release ${tag ?? '(latest)'} (${reason})`);
  }
}

// ---------------------------------------------------------------------------
// Runtime-state preservation + install swap
// ---------------------------------------------------------------------------

/** Ledgers live at <name>.jsonl plus rotated siblings <name>.jsonl.1-.3. */
const PRESERVED_LEDGER_PREFIXES = ['stats.jsonl', 'measure.jsonl'];
/** errors/ archive is carried over up to this size (parity with deploy.ps1). */
export const MAX_PRESERVED_ERRORS_BYTES = 100 * 1024 * 1024;
/**
 * F4 keyword indexes are derived caches and CAN be rebuilt - carrying them
 * over simply saves paid-for indexing work across an update. Capped like
 * errors/: a runaway index is a bug signal, not a treasure to preserve.
 */
export const MAX_PRESERVED_INDEX_BYTES = 64 * 1024 * 1024;

function dirSizeBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          total += statSync(p).size;
        } catch {
          // raced file - ignore
        }
      }
    }
  }
  return total;
}

/**
 * Copy runtime state from the old installation into the staged payload so
 * an update never wipes settings or archives. Pushes human-readable notes
 * (e.g. skipped oversized archive) onto `warnings`.
 */
function preserveRuntimeState(oldInstall: string, stagedPayload: string, warnings: string[]): void {
  for (const name of readdirSync(oldInstall)) {
    const isLedger = PRESERVED_LEDGER_PREFIXES.some((p) => name.startsWith(p));
    if (!isLedger && name !== 'config.json') continue;
    const src = join(oldInstall, name);
    try {
      if (!statSync(src).isFile()) continue;
      cpSync(src, join(stagedPayload, name));
    } catch {
      // A missing/raced file is not worth failing the update over.
    }
  }
  // node_modules are reused so the swap stays fast; refreshed by npm ci
  // below whenever the lockfile changed.
  const nm = join(oldInstall, 'node_modules');
  if (existsSync(nm)) cpSync(nm, join(stagedPayload, 'node_modules'), { recursive: true });
  const errDir = join(oldInstall, 'errors');
  if (existsSync(errDir)) {
    if (dirSizeBytes(errDir) <= MAX_PRESERVED_ERRORS_BYTES) {
      cpSync(errDir, join(stagedPayload, 'errors'), { recursive: true });
    } else {
      warnings.push('errors/ archive exceeded 100 MB and was not carried over');
    }
  }
  // F3 snapshot history is user session data - carried over like ledgers.
  // Rotation bounds its size (a few JSON records per task), so no cap here.
  const snapDir = join(oldInstall, 'snapshots');
  if (existsSync(snapDir)) cpSync(snapDir, join(stagedPayload, 'snapshots'), { recursive: true });
  // F4 keyword index (plan decision E2): derived cache, but skipping this
  // would wipe every built index on /broke update. Rebuildable, hence capped.
  const idxDir = join(oldInstall, 'index');
  if (existsSync(idxDir)) {
    if (dirSizeBytes(idxDir) <= MAX_PRESERVED_INDEX_BYTES) {
      cpSync(idxDir, join(stagedPayload, 'index'), { recursive: true });
    } else {
      warnings.push('index/ exceeded 64 MB and was left to lazy rebuild');
    }
  }
}

function filesDiffer(a: string, b: string): boolean {
  try {
    return !readFileSync(a).equals(readFileSync(b));
  } catch {
    return true; // unreadable/missing counts as "changed" - refresh deps
  }
}

/** Synchronous pause - lets transient Windows locks (AV/indexer) clear. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename with bounded retries. Right after npm ci has churned thousands of
 * files, virus scanners and indexers briefly hold exclusive handles; such
 * EPERM/EBUSY states clear within milliseconds to seconds. Persistent locks
 * (a host view holding a subfolder open) never do - the staging loop's merge
 * fallback is responsible for those, not longer spinning here.
 */
const RETRY_DELAYS_MS = [100, 150, 250, 400, 650, 1000, 1600];

export function renameWithRetry(from: string, to: string): void {
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      lastError = err;
      if (attempt >= RETRY_DELAYS_MS.length) throw lastError;
      sleepSync(RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** Recursive relative-path -> byte-size map, POSIX-style keys. */
function manifestOf(root: string, prefix = '', into: Map<string, number> = new Map()): Map<string, number> {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      manifestOf(root, rel, into);
    } else {
      try {
        into.set(rel, statSync(join(root, rel)).size);
      } catch {
        // raced file - it will show up as missing in the comparison
      }
    }
  }
  return into;
}

/**
 * Copy the payload into the install directory, then VERIFY the result: every
 * payload file must exist with its original byte size. Extras in the install
 * directory are tolerated (the running extension may append to ledgers
 * mid-swap); missing or truncated files are not - they mean the copy died
 * part-way, which historically left a silently broken installation behind.
 */
function copyPayloadVerified(payloadDir: string, installDir: string, rawCopy: (from: string, to: string) => void): void {
  rawCopy(payloadDir, installDir);
  const missing: string[] = [];
  for (const [rel, size] of manifestOf(payloadDir)) {
    try {
      if (statSync(join(installDir, rel)).size !== size) missing.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  if (missing.length > 0) {
    throw new Error(`payload copy incomplete - ${missing.length} file(s) missing or truncated (first: ${missing[0]})`);
  }
}

/**
 * Remove children of `dst` that no longer exist in `src`, recursively. Used
 * after merging the payload over directories that could not be moved aside,
 * so full-replacement semantics survive the merge (stale files disappear).
 * Best effort: an entry that refuses deletion stays behind instead of failing
 * an otherwise successful update - it is cosmetic by definition, because the
 * manifest verification already proved every payload file arrived.
 */
function pruneExtraneous(dst: string, src: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dst, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const dstChild = join(dst, entry.name);
    const srcChild = join(src, entry.name);
    if (!existsSync(srcChild)) {
      try {
        rmSync(dstChild, { recursive: true, force: true });
      } catch {
        // locked or raced - keep it, it is harmless
      }
      continue;
    }
    if (entry.isDirectory()) pruneExtraneous(dstChild, srcChild);
  }
}

/** Injectable I/O for the swap functions - tests simulate locks/partial copies. */
export interface SwapIo {
  /** Move/rename one entry. Defaults to {@link renameWithRetry}. */
  rename?: (from: string, to: string) => void;
  /** Low-level recursive copy. Defaults to fs.cpSync. */
  copyRaw?: (from: string, to: string) => void;
}

function writeDeployedVersion(installDir: string, tag: string): void {
  writeFileSync(join(installDir, '.deployed-version'), `${tag}\n`, 'utf-8');
}

function recoverStaleBackup(backup: string, installDir: string): void {
  if (!existsSync(backup)) return;
  if (existsSync(installDir)) rmSync(backup, { recursive: true, force: true });
  else renameSync(backup, installDir); // previous run crashed between rename and copy
}

/**
 * Preferred swap: rename the old installation aside, copy the payload in,
 * drop the backup. Returns 'blocked' when something still pins the old
 * directory with an open handle (Windows EPERM) - the caller then uses
 * replaceInstallationInPlace. Throws after restoring the previous state.
 */
export function swapInstallDirectory(installDir: string, payloadDir: string, tag: string, io: SwapIo = {}): 'swapped' | 'blocked' {
  const doRename = io.rename ?? renameWithRetry;
  const backup = `${installDir}.old`;
  recoverStaleBackup(backup, installDir);
  try {
    renameSync(installDir, backup);
  } catch {
    return 'blocked';
  }
  try {
    copyPayloadVerified(payloadDir, installDir, io.copyRaw ?? ((from, to) => cpSync(from, to, { recursive: true })));
    writeDeployedVersion(installDir, tag);
  } catch (err) {
    try {
      rmSync(installDir, { recursive: true, force: true });
    } catch {
      // Restoring the backup matters more than removing the partial copy.
    }
    try {
      doRename(backup, installDir);
    } catch (restoreErr) {
      throw new Error(
        `${reasonOf(err)}; AND the previous installation could not be moved back from ${backup} (${reasonOf(restoreErr)}) - restore it manually.`,
      );
    }
    throw err;
  }
  // A locked leftover backup is cosmetic - the next update's
  // recoverStaleBackup drops it. Never fail a finished update over it.
  rmSync(backup, { recursive: true, force: true });
  return 'swapped';
}

/**
 * Fallback for a pinned directory: move current entries aside one by one,
 * copy the payload in (verified), drop the backup. Less atomic than the
 * rename swap but immune to open DIRECTORY handles (files inside stay
 * replaceable).
 *
 * Entries whose rename keeps failing (a host view holding e.g. docs/ open)
 * are not fatal anymore when the payload contains the same name: their
 * current content is secured into the backup by copy - reads survive locks
 * that block renames - and the entry stays in place, with the payload copy
 * merging over it. Full-replacement semantics are preserved by pruning
 * everything inside merged directories that the payload no longer has.
 *
 * Every phase rolls back completely on failure - a transient lock during
 * staging used to abort this mid-loop and leave the installation truncated
 * (leading-alphabetical slice stranded in the backup), which is exactly the
 * "broke does not load after update" corruption class.
 */
export function replaceInstallationInPlace(installDir: string, payloadDir: string, tag: string, io: SwapIo = {}): void {
  const doRename = io.rename ?? renameWithRetry;
  const doCopy = io.copyRaw ?? ((from, to) => cpSync(from, to, { recursive: true }));
  const backup = `${installDir}.old`;
  recoverStaleBackup(backup, installDir);
  mkdirSync(backup);
  const movedOut: string[] = [];
  /** Could not be moved; secured by copy and merged over instead. */
  const mergedNames: string[] = [];

  /** Move everything staged in the backup back; returns names that failed. */
  const restoreFromBackup = (): string[] => {
    const failures: string[] = [];
    for (const entry of movedOut) {
      try {
        doRename(join(backup, entry), join(installDir, entry));
      } catch {
        failures.push(entry);
      }
    }
    return failures;
  };

  /** Restore merge-mode entries from their backup snapshots. */
  const restoreMerged = (): string[] => {
    const failures: string[] = [];
    for (const name of mergedNames) {
      try {
        rmSync(join(installDir, name), { recursive: true, force: true });
        doCopy(join(backup, name), join(installDir, name));
      } catch {
        failures.push(name);
      }
    }
    return failures;
  };

  // Phase 1: stage the current installation aside. An unmovable entry falls
  // back to merge mode when the payload covers it; otherwise put every
  // already-moved entry back before surfacing the error.
  for (const entry of readdirSync(installDir)) {
    try {
      doRename(join(installDir, entry), join(backup, entry));
      movedOut.push(entry);
      continue;
    } catch (moveErr) {
      if (!existsSync(join(payloadDir, entry))) {
        const failures = restoreFromBackup();
        if (failures.length === 0) rmSync(backup, { recursive: true, force: true });
        throw new Error(
          `cannot stage '${entry}' for replacement (${reasonOf(moveErr)})` +
            (failures.length > 0
              ? `; ROLLBACK INCOMPLETE: ${failures.length} entr(y|ies) remain in ${backup} - move them back manually`
              : '; previous installation is intact'),
        );
      }
      try {
        cpSync(join(installDir, entry), join(backup, entry), { recursive: true });
      } catch (snapshotErr) {
        const failures = restoreFromBackup();
        if (failures.length === 0) rmSync(backup, { recursive: true, force: true });
        throw new Error(
          `cannot stage '${entry}' for replacement (${reasonOf(moveErr)}) and cannot snapshot it either (${reasonOf(snapshotErr)})` +
            (failures.length > 0 ? `; ROLLBACK INCOMPLETE: ${failures.length} entr(y|ies) remain in ${backup}` : '; previous installation is intact'),
        );
      }
      mergedNames.push(entry);
    }
  }

  // Phase 2: copy + verify + mark. Any failure wipes the partial copy and
  // restores the previous installation from moved-back renames plus copied
  // merge snapshots.
  try {
    copyPayloadVerified(payloadDir, installDir, doCopy);
    writeDeployedVersion(installDir, tag);
  } catch (err) {
    for (const entry of readdirSync(installDir)) {
      // Merged entries must NOT be wiped wholesale before their snapshot
      // restore runs - but wiping is still correct: the snapshot copy below
      // rebuilds them. A locked child merely survives as a leftover.
      try {
        rmSync(join(installDir, entry), { recursive: true, force: true });
      } catch {
        // best effort - a locked leftover surfaces as a restore failure below
      }
    }
    const failures = [...restoreFromBackup(), ...restoreMerged()];
    if (failures.length === 0) {
      try {
        rmSync(backup, { recursive: true, force: true });
      } catch {
        // leftover backup is cosmetic; recoverStaleBackup clears it next time
      }
      throw err;
    }
    throw new Error(
      `${reasonOf(err)}; ROLLBACK INCOMPLETE: ${failures.length} previous file(s)/folder(s) could not be restored ` +
        `(e.g. ${failures[0]}) - they are preserved in ${backup}; close whatever locks them and restore them`,
    );
  }

  // Phase 3: full-replacement semantics for merged directories - drop what
  // the payload no longer contains.
  for (const name of mergedNames) {
    let payloadIsDir = false;
    try {
      payloadIsDir = statSync(join(payloadDir, name)).isDirectory();
    } catch {
      // vanished mid-swap - nothing sensible to prune against
      continue;
    }
    if (payloadIsDir) pruneExtraneous(join(installDir, name), join(payloadDir, name));
  }

  // Success: drop the backup. A locked leftover is cosmetic - the next
  // update's recoverStaleBackup drops it. Never fail a finished swap over it.
  rmSync(backup, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The update flow
// ---------------------------------------------------------------------------

export interface UpdateRequest {
  mode: 'install' | 'check';
  /** Explicit tag (canonical 'vX.Y.Z'); enables reinstall/downgrade. */
  tag?: string;
}

export interface UpdateHooks {
  /** Free directory handles BEFORE the installer swaps folders. */
  onBeforeSwap?: () => void;
  /** Called after a successful swap so the host can reopen resources. */
  onAfterSwap?: () => void;
  /** Progress lines for the extension log (not the chat). */
  progress?: (line: string) => void;
}

export interface UpdateResult {
  ok: boolean;
  updated: boolean;
  message: string;
  currentVersion?: string;
  targetVersion?: string;
  warnings?: string[];
}

/** Module-level mutex: two concurrent self-updates would corrupt the swap. */
let updateInFlight = false;

function fail(message: string, currentVersion?: string): UpdateResult {
  return { ok: false, updated: false, message, currentVersion };
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one update/check. `installDir` defaults to this module's own
 * directory (__dirname), which IS the installation when running from
 * ~/.aider-desk/extensions/broke.
 */
export async function runUpdate(
  request: UpdateRequest,
  hooks: UpdateHooks = {},
  deps: Partial<UpdateDeps> = {},
  installDir: string = __dirname,
): Promise<UpdateResult> {
  if (updateInFlight) {
    return fail('broke update is already running - wait for it to finish.');
  }
  // Guard against self-destruction: updating a git checkout would overwrite
  // the developer working tree. There, git pull + deploy.ps1 remain the way.
  if (existsSync(join(installDir, '.git'))) {
    return fail(
      'broke update refused: this looks like a git checkout (contains .git). Use git pull + scripts/deploy.ps1 there.',
    );
  }
  let currentVersion: string;
  try {
    const pkg = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf-8')) as { version?: unknown };
    if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('package.json has no version');
    currentVersion = pkg.version;
  } catch (err) {
    return fail(`cannot read the installed broke version (${reasonOf(err)})`);
  }

  updateInFlight = true;
  try {
    const io: UpdateDeps = {
      fetchJson: deps.fetchJson ?? defaultFetchJson,
      downloadTarball: deps.downloadTarball ?? defaultDownloadTarball,
      downloadBytes: deps.downloadBytes ?? defaultDownloadBytes,
      extractTarball: deps.extractTarball ?? defaultExtractTarball,
      runNpmCi: deps.runNpmCi ?? defaultRunNpmCi,
      verifyRelease: deps.verifyRelease ?? defaultVerifyRelease,
    };

    let targetTag: string;
    if (request.tag !== undefined) {
      const normalized = normalizeTag(request.tag);
      if (!normalized) return fail(`invalid version '${request.tag}' - expected vX.Y.Z`, currentVersion);
      targetTag = normalized;
    } else {
      targetTag = (await resolveLatestVersion(io.fetchJson)).tag;
    }
    const targetVersion = targetTag.slice(1);

    const cmp = compareSemver(targetVersion, currentVersion);
    if (request.mode === 'check') {
      return cmp > 0
        ? {
            ok: true,
            updated: false,
            currentVersion,
            targetVersion,
            message: `broke update - ${targetTag} is available (installed: v${currentVersion}) - run /broke update`,
          }
        : {
            ok: true,
            updated: false,
            currentVersion,
            message: `broke update - already on v${currentVersion} (latest release)`,
          };
    }
    if (cmp <= 0 && !request.tag) {
      return {
        ok: true,
        updated: false,
        currentVersion,
        message: `broke update - already on v${currentVersion} (latest release)`,
      };
    }

    hooks.progress?.(`resolving ${targetTag}...`);
    // Install mode resolves the RELEASE OBJECT (not just the tag): the
    // signed artifacts live as release assets. Strict trust model (R1):
    // releases without the full signed-asset set are refused - installing
    // unsigned code is exactly the attack this gate exists for.
    const release = await fetchRelease(io.fetchJson, targetTag);
    const artifactName = releaseAssetName(release.tag);
    const artifactUrl = release.assets.get(artifactName);
    const sumsUrl = release.assets.get(SUMS_ASSET_NAME);
    const sigUrl = release.assets.get(SIG_ASSET_NAME);
    if (!artifactUrl || !sumsUrl || !sigUrl) {
      return fail(
        `release ${release.tag} has no signed artifacts (expected assets: ${artifactName}, ${SUMS_ASSET_NAME}, ${SIG_ASSET_NAME}) - refusing to install unverified code. Signed releases start at v0.8.0.`,
        currentVersion,
      );
    }

    hooks.progress?.(`downloading ${artifactName}...`);
    const work = mkdtempSync(join(tmpdir(), 'broke-update-'));
    try {
      const archive = join(work, 'release.tgz');
      await io.downloadTarball(artifactUrl, archive);
      const [sums, signature] = await Promise.all([io.downloadBytes(sumsUrl), io.downloadBytes(sigUrl)]);

      hooks.progress?.('verifying signature and checksum...');
      // Trust boundary: NOTHING from the download is executed or extracted
      // before this check passed.
      io.verifyRelease(sums, signature, readFileSync(archive), artifactName);

      const staging = join(work, 'staging');
      mkdirSync(staging);
      await io.extractTarball(archive, staging);

      // GitHub tarballs wrap everything in a single root folder
      // (ext-broke-<version>/) - unwrap it when present.
      const entries = readdirSync(staging, { withFileTypes: true });
      const payload =
        entries.length === 1 && entries[0].isDirectory() ? join(staging, entries[0].name) : staging;
      if (!existsSync(join(payload, 'package.json'))) {
        throw new Error('unexpected archive layout (no package.json) - aborting');
      }

      const warnings: string[] = [];
      preserveRuntimeState(installDir, payload, warnings);

      let refreshedDeps = false;
      if (
        filesDiffer(join(payload, 'package-lock.json'), join(installDir, 'package-lock.json')) ||
        filesDiffer(join(payload, 'package.json'), join(installDir, 'package.json'))
      ) {
        hooks.progress?.('lockfile changed - refreshing dependencies (npm ci --omit=dev)...');
        await io.runNpmCi(payload);
        refreshedDeps = true;
      }

      hooks.onBeforeSwap?.();
      const swapped = swapInstallDirectory(installDir, payload, targetTag);
      if (swapped === 'blocked') {
        hooks.progress?.('directory is pinned by another handle - replacing files in place...');
        replaceInstallationInPlace(installDir, payload, targetTag);
      }
      // The installation is updated at this point - reopening host resources
      // afterwards is best effort and must never flip the result to "failed".
      try {
        hooks.onAfterSwap?.();
      } catch {
        // Host falls back to lazy reload / next start.
      }

      const verb = cmp > 0 ? 'updated' : cmp === 0 ? 'reinstalled' : 'downgraded';
      const lines = [
        `broke ${verb}: v${currentVersion} → ${targetTag}${refreshedDeps ? ' (dependencies refreshed)' : ''}`,
        'Restart AiderDesk to load the new version - this instance still runs the previously loaded code.',
      ];
      for (const w of warnings) lines.push(`Note: ${w}`);
      return { ok: true, updated: true, currentVersion, targetVersion, warnings, message: lines.join('\n') };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  } catch (err) {
    // Every failure path above either never touched the installation or
    // restored it from the backup before throwing.
    return fail(`broke update failed - ${reasonOf(err)}. The installed version is unchanged.`, currentVersion);
  } finally {
    updateInFlight = false;
  }
}
