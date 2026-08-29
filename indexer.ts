/**
 * F4 - Local Keyword/Vector Index with snippet summaries (docs/feats.md).
 *
 * A per-project inverted index that answers "where does X live?" with a
 * TOKEN-BUDGETED snippet summary instead of whole-file dumps: top-k results,
 * ±contextLines around the best match, everything under search.maxChars.
 *
 * Scope decision (v1, recorded in feats.md F4 notes): KEYWORD ONLY. The
 * vector/hybrid backends are reserved for v2 behind the same entry points;
 * shipping them half-wired would be dishonest config surface.
 *
 * Privacy & size (plan decisions E5/E6): the persisted index holds ONLY
 * term postings and file metadata - never file contents or snippets.
 * Snippets are read live from disk at query time and exist only in the
 * tool result, exactly like any normal file-read tool. No savedChars are
 * claimed anywhere (E5): savings come from the agent choosing broke-search
 * over bulk reads, which is behavior, not pipeline compression.
 *
 * Failure isolation (roadmap principle 4): every exported IO entry point
 * catches internally and degrades to a short honest message. Nothing here
 * throws into the agent loop.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from './config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directories that never enter the index (feats.md F4 build rules). */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.aider-desk',
  'dist',
  'build',
  'vendor',
]);

/** File extensions eligible for indexing. Everything else passes by. */
export const INDEXABLE_EXT: ReadonlySet<string> = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.py', '.json', '.md']);

/**
 * Hard cap on indexed files (bounded-memory principle 6): the walk stops
 * here and reports honestly that the index is truncated. Typical repos are
 * far below this; runaways are "build artifacts misclassified", not workloads.
 */
export const INDEX_MAX_ENTRIES = 50_000;

/** Terms longer than this are dropped (paths pasted into comments etc.). */
const MAX_TOKEN_LENGTH = 48;

/**
 * BRK-002 (external review 2026-08-29): repository content is NOT a trusted
 * key space. Tokens like `__proto__`, `constructor` or `prototype` come
 * straight out of indexed files; routing them through plain property writes
 * polluted `Object.prototype` in the shared host process. All index
 * dictionaries are therefore null-prototype objects, and every write uses
 * `defineKey` so even a hand-built normal-prototype state can never hit the
 * `__proto__` accessor/setter.
 */
type Dict<T> = Record<string, T>;
const nullDict = <T>(): Dict<T> => Object.create(null) as Dict<T>;

/** Create a REAL own key - never a prototype mutation - even for `__proto__`. */
function defineKey<T>(obj: Dict<T>, key: string, value: T): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Own-property check without lib es2022 (`Object.hasOwn`). */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Minimal stopword list. Enough to keep English prose snippets from ranking
 * their filler words; deliberately NOT configurable - tuning this is the
 * vector backend's job in v2.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'not', 'are', 'you', 'all', 'can', 'her', 'was', 'one',
  'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new', 'now',
  'old', 'see', 'two', 'way', 'who', 'its', 'did', 'that', 'this', 'with',
  'from', 'they', 'have', 'will', 'your', 'what', 'when', 'which', 'their',
  'there', 'would', 'about', 'into', 'than', 'then', 'been', 'were', 'does',
]);

// BM25 parameters (standard defaults).
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// ---------------------------------------------------------------------------
// State schema (persisted JSON - versions matter, snapshots taught us why)
// ---------------------------------------------------------------------------

export interface IndexedFile {
  /** mtime in ms (from statSync) at indexing time. */
  mtimeMs: number;
  /** Size in bytes at indexing time. */
  sizeBytes: number;
  /** Number of tokens the file contributed - the BM25 document length. */
  tokenCount: number;
}

export interface IndexState {
  version: 1;
  /** Absolute project root the paths below are relative to. */
  projectRoot: string;
  builtAt: string;
  /** Truncated by INDEX_MAX_ENTRIES during the last build? */
  truncated: boolean;
  /** relPath -> meta. Null-prototype dictionary (BRK-002), also after loadIndex. */
  files: Record<string, IndexedFile>;
  /** term -> relPath -> in-document frequency. Contents never persisted.
   *  Null-prototype dictionary of null-prototype postings (BRK-002). */
  postings: Record<string, Record<string, number>>;
}

export const SEARCH_MARKER_FOOTER_PREFIX = 'broke-search:';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Identifier-aware tokenizer: lowercase word fragments, stopwords out. */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().split(/[^a-z0-9_$]+/);
  const out: string[] = [];
  for (const t of raw) {
    if (t.length < 2 || t.length > MAX_TOKEN_LENGTH || STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/**
 * Deterministic short hash of the project root for the on-disk directory
 * name (no filesystem-hostile characters, no path leakage in dir listings).
 * SHA-256 truncated to 64 bits (review F-09): the previous 32-bit FNV hash
 * made cross-project collisions plausible on a shared machine; 64 bits make
 * them practically impossible.
 */
export function projectHash(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}

/**
 * Path confinement invariant (review F-09): every relPath that enters the
 * persisted index - and is later joined onto the project root for reading -
 * must be a plain forward-slashed relative path without traversal segments.
 * Absolute paths, backslashes, '..'/'.' segments and empty segments are
 * rejected. Applied to persisted index keys at load time and, as defense in
 * depth, to candidates right before their file read at search time.
 */
export function isConfinedRelPath(relPath: unknown): relPath is string {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 512) return false;
  if (relPath.includes('\\') || relPath.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(relPath)) return false;
  return !relPath.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

export function createEmptyState(projectRoot: string): IndexState {
  return { version: 1, projectRoot, builtAt: '', truncated: false, files: nullDict<IndexedFile>(), postings: nullDict<Dict<number>>() };
}

function indexableRelPath(relPath: string): boolean {
  const dot = relPath.lastIndexOf('.');
  return dot >= 0 && INDEXABLE_EXT.has(relPath.slice(dot).toLowerCase());
}

/** Path fragment checks mirroring slice.ts's vendor rules (skip regardless of extension). */
function skippedPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return /(^|[\\/])(node_modules|vendor)([\\/]|$)/.test(lower);
}

/**
 * BRK-003 (external review 2026-08-29): dot-paths (IDE/tool config, cache
 * dirs, .env-style files) never enter the index - the README claims this and
 * private content routinely lives there.
 */
function hasDotSegment(relPath: string): boolean {
  return relPath.split('/').some((seg) => seg.startsWith('.'));
}

/**
 * BRK-003: conventionally private basenames are never indexed, regardless of
 * git status. Deliberately conservative (a tracked `secrets.ts` is skipped
 * too) - a false "not searchable" costs less than a leaked credential.
 */
function sensitiveBasename(relPath: string): boolean {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1).toLowerCase();
  if (base.startsWith('.env')) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.\w+)?$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx)$/.test(base)) return true;
  return /(secret|credential|password|passwd)/.test(base);
}

/**
 * BRK-003: git-aware candidate list - tracked plus untracked-but-not-ignored
 * files (`git ls-files -co --exclude-standard`), i.e. exactly the project
 * surface the user chose to keep visible to git. Returns null when git is
 * missing or fails; the caller then decides the fallback. `-z` keeps paths
 * raw (no core.quotePath escaping), NUL-separated.
 */
function gitCandidateFiles(root: string): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: root,
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .toString('utf-8')
      .split('\0')
      .filter((p) => p.length > 0);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scan + incremental merge
// ---------------------------------------------------------------------------

interface ScannedEntry {
  relPath: string;
  mtimeMs: number;
  sizeBytes: number;
}

export type ScanSource = 'git' | 'git-unavailable' | 'walk';

/**
 * Collect index candidates for the project root (IO, never throws).
 *
 * BRK-003 policy, in order of preference:
 * - `git`: a git repository is scanned from `git ls-files -co
 *   --exclude-standard` - gitignored files (a local secrets.json) are
 *   structurally invisible to the index, matching user expectation that
 *   gitignore separates repo surface from private local data.
 * - `git-unavailable`: a `.git` entry exists but git failed (broken
 *   worktree pointer, busy/corrupt repo). Fail SAFE: index nothing rather
 *   than walking a tree whose ignore rules could not be evaluated.
 * - `walk`: no git at all - the conservative legacy walk, hardened with
 *   dot-path and sensitive-basename filters.
 */
export function scanProject(root: string, maxFileKB: number): { entries: ScannedEntry[]; truncated: boolean; source: ScanSource } {
  const maxBytes = maxFileKB * 1024;
  const entries: ScannedEntry[] = [];
  let truncated = false;
  const gitFiles = gitCandidateFiles(root);
  if (gitFiles !== null) {
    for (const relPath of gitFiles) {
      if (entries.length >= INDEX_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      if (!indexableRelPath(relPath) || skippedPath(relPath) || hasDotSegment(relPath) || sensitiveBasename(relPath)) continue;
      try {
        const st = statSync(join(root, ...relPath.split('/')));
        if (st.size > maxBytes) continue;
        entries.push({ relPath, mtimeMs: st.mtimeMs, sizeBytes: st.size });
      } catch {
        // raced file - skip
      }
    }
    return { entries, truncated, source: 'git' };
  }
  if (existsSync(join(root, '.git'))) {
    // Git repo, but git could not answer. A blind walk here would index
    // exactly the files the user asked git to hide.
    return { entries: [], truncated: false, source: 'git-unavailable' };
  }
  const stack = [root];
  try {
    while (stack.length > 0 && !truncated) {
      const dir = stack.pop() as string;
      let names: Dirent[];
      try {
        names = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
      } catch {
        continue;
      }
      for (const e of names) {
        if (entries.length >= INDEX_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        const abs = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(abs);
          continue;
        }
        if (!e.isFile()) continue;
        if (!indexableRelPath(e.name) || skippedPath(e.name) || e.name.startsWith('.') || sensitiveBasename(e.name)) continue;
        try {
          const st = statSync(abs);
          if (st.size > maxBytes) continue;
          entries.push({ relPath: forwardSlash(join(dir, e.name).slice(root.length + 1)), mtimeMs: st.mtimeMs, sizeBytes: st.size });
        } catch {
          // raced file - skip
        }
      }
    }
  } catch {
    // walking must never throw upward
  }
  return { entries, truncated, source: 'walk' };
}

/** Normalize to forward slashes so on-disk keys are OS-portable. */
function forwardSlash(p: string): string {
  return p.includes('\\') ? p.replace(/\\/g, '/') : p;
}

function removeDocument(state: IndexState, relPath: string): void {
  delete state.files[relPath];
  for (const term of Object.keys(state.postings)) {
    const posting = state.postings[term];
    // Object.hasOwn, not `in`: inherited properties (Object.prototype on a
    // hand-built state) must never pass for a real posting entry.
    if (posting && hasOwn(posting, relPath)) {
      delete posting[relPath];
      if (Object.keys(posting).length === 0) delete state.postings[term];
    }
  }
}

function addDocument(state: IndexState, root: string, entry: ScannedEntry): void {
  removeDocument(state, entry.relPath);
  let text = '';
  try {
    text = readFileSync(join(root, ...entry.relPath.split('/')), 'utf-8');
  } catch {
    return; // unreadable at index time - absent from postings is honest
  }
  const tokens = tokenize(text);
  const tfByTerm = new Map<string, number>();
  for (const t of tokens) tfByTerm.set(t, (tfByTerm.get(t) ?? 0) + 1);
  defineKey(state.files, entry.relPath, { mtimeMs: entry.mtimeMs, sizeBytes: entry.sizeBytes, tokenCount: tokens.length });
  for (const [term, tf] of tfByTerm) {
    // BRK-002: hasOwn + defineKey - for the term '__proto__' on a
    // normal-prototype state, `state.postings[term]` resolves to
    // Object.prototype and a plain assignment would hit the prototype
    // setter instead of creating a real entry.
    let posting = state.postings[term];
    if (posting === undefined || !hasOwn(state.postings, term)) {
      posting = nullDict<number>();
      defineKey(state.postings, term, posting);
    }
    defineKey(posting, entry.relPath, tf);
  }
}

/**
 * Diff-and-merge an existing state against a fresh scan: only NEW and
 * CHANGED files (mtime/size) are re-tokenized, deletions leave both the
 * meta map and every posting. Mutates and returns the SAME state object.
 */
export function mergeIntoState(
  state: IndexState,
  root: string,
  entries: ScannedEntry[],
  truncated: boolean,
): { added: number; updated: number; removed: number } {
  let added = 0;
  let updated = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    seen.add(entry.relPath);
    const old = state.files[entry.relPath];
    if (!old) {
      addDocument(state, root, entry);
      added++;
    } else if (old.mtimeMs !== entry.mtimeMs || old.sizeBytes !== entry.sizeBytes) {
      addDocument(state, root, entry);
      updated++;
    }
  }
  let removed = 0;
  for (const relPath of Object.keys(state.files)) {
    if (!seen.has(relPath)) {
      removeDocument(state, relPath);
      removed++;
    }
  }
  state.truncated = truncated;
  return { added, updated, removed };
}

/**
 * Freshness sweep used by queries AND triggers: load-or-create the state
 * from disk, rescan metadata, re-index exactly what moved. Never throws.
 * `dirOverride` mirrors the BROKE_CONFIG_PATH isolation pattern - tests
 * must never write into the real extension directory.
 */
/**
 * Case/platform-tolerant root comparison for persisted-state verification:
 * a persisted index may only be merged when it was built for THIS project
 * root (review F-09). Trailing separators are ignored; comparison is
 * case-insensitive on Windows only.
 */
function sameProjectRoot(a: string, b: string): boolean {
  const norm = (p: string) => {
    const fwd = forwardSlash(p).replace(/\/+$/, '');
    return process.platform === 'win32' ? fwd.toLowerCase() : fwd;
  };
  return norm(a) === norm(b);
}

/**
 * Remove legacy 8-hex-hash index dirs left by the pre-SHA256 projectHash
 * (best effort, only along the default index path - never with dirOverride,
 * whose parent is test/tmp territory). Orphans are rebuildable caches; the
 * cleanup just keeps the index dir from accumulating stale copies.
 */
function removeLegacyIndexDirs(indexBase: string, currentHash: string): void {
  try {
    for (const name of readdirSync(indexBase)) {
      if (name !== currentHash && /^[0-9a-f]{8}$/.test(name)) {
        rmSync(join(indexBase, name), { recursive: true, force: true });
      }
    }
  } catch {
    // cosmetic cleanup - never fail indexing over it
  }
}

export function ensureFresh(
  root: string,
  opts: { maxFileKB: number },
  dirOverride?: string,
): { state: IndexState; delta: { added: number; updated: number; removed: number } } {
  const dir = dirOverride ?? indexDirFor(root);
  if (!dirOverride) removeLegacyIndexDirs(join(dir, '..'), projectHash(root));
  const state = loadIndex(dir) ?? createEmptyState(root);
  if (!sameProjectRoot(state.projectRoot, root)) {
    // Foreign/stale root (moved project, copied store, tampered file): the
    // persisted state says nothing about THIS tree - rebuild from scratch.
    state.files = nullDict<IndexedFile>();
    state.postings = nullDict<Dict<number>>();
    state.projectRoot = root;
    state.truncated = false;
    state.builtAt = '';
  }
  const scan = scanProject(root, opts.maxFileKB);
  const delta = mergeIntoState(state, root, scan.entries, scan.truncated);
  if (delta.added > 0 || delta.updated > 0 || delta.removed > 0 || scan.truncated !== state.truncated) {
    state.builtAt = new Date().toISOString();
    saveIndex(dir, state);
  }
  return { state, delta };
}

// ---------------------------------------------------------------------------
// Query: BM25 ranking + live snippet extraction
// ---------------------------------------------------------------------------

export interface ScoredHit {
  relPath: string;
  score: number;
}

/** BM25-ish ranking over the postings table (pure). */
export function rankQuery(state: IndexState, queryTerms: string[]): ScoredHit[] {
  const docCount = Object.keys(state.files).length;
  if (docCount === 0 || queryTerms.length === 0) return [];
  let avgLen = 0;
  for (const f of Object.values(state.files)) avgLen += f.tokenCount;
  avgLen = Math.max(1, avgLen / docCount);

  const scores = new Map<string, number>();
  for (const term of new Set(queryTerms)) {
    const posting = state.postings[term];
    if (!posting) continue;
    const df = Object.keys(posting).length;
    // BM25 idf, floored at 0 (a term in every file carries no signal).
    const idf = Math.max(0, Math.log(1 + (docCount - df + 0.5) / (df + 0.5)));
    if (idf <= 0) continue;
    for (const [relPath, tf] of Object.entries(posting)) {
      const meta = state.files[relPath];
      const len = meta?.tokenCount || 1;
      const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * len) / avgLen);
      scores.set(relPath, (scores.get(relPath) ?? 0) + idf * ((tf * (BM25_K1 + 1)) / denom));
    }
  }
  return [...scores.entries()]
    .map(([relPath, score]) => ({ relPath, score }))
    .sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
}

/**
 * Best matching line for ONE query inside ONE live file: the line whose
 * tokens cover the most distinct query terms (ties -> earlier line).
 */
export function findBestLine(textLines: readonly string[], queryTerms: readonly string[]): { line0: number; hits: number } {
  const wanted = new Set(queryTerms);
  let bestLine0 = -1;
  let bestHits = 0;
  for (let i = 0; i < textLines.length; i++) {
    let covered = 0;
    for (const t of new Set(tokenize(textLines[i]))) {
      if (wanted.has(t)) covered++;
    }
    if (covered > bestHits) {
      bestHits = covered;
      bestLine0 = i;
    }
  }
  return { line0: bestLine0, hits: bestHits };
}

/** Merge overlapping ±window line ranges (pure, 0-based inclusive). */
export function mergeWindows(bestLines: readonly number[], contextLines: number, lineCount: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const center of [...bestLines].sort((a, b) => a - b)) {
    const lo = Math.max(0, center - contextLines);
    const hi = Math.min(lineCount - 1, center + contextLines);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }
  return ranges;
}

/** Render elided windows with visible cut markers (pure). */
export function renderSnippet(textLines: readonly string[], ranges: ReadonlyArray<[number, number]>): string {
  const parts: string[] = [];
  let prevEnd = -1;
  for (const [lo, hi] of ranges) {
    if (prevEnd >= 0 && lo > prevEnd + 1) {
      parts.push(`… [broke: ${lo - prevEnd - 1} line(s) elided] …`);
    }
    for (let i = lo; i <= hi; i++) parts.push(textLines[i] ?? '');
    prevEnd = hi;
  }
  return parts.join('\n');
}

export interface SearchResultHit {
  path: string;
  line: number;
  matches: number;
  text: string;
}

export interface SearchRunOptions {
  k: number;
  maxChars: number;
  contextLines: number;
}

/**
 * Execute one search against a FRESH state: rank, read the top files live,
 * extract snippet windows, respect the char budget ACROSS results. Returns
 * a short error-shaped outcome instead of throwing on any failure.
 */
export function runSearch(
  state: IndexState,
  root: string,
  query: string,
  opts: SearchRunOptions,
  pathFilter?: string[],
): { hits: SearchResultHit[]; truncated: boolean; elapsedMs: number } {
  const started = Date.now();
  const terms = tokenize(query);
  if (terms.length === 0) return { hits: [], truncated: false, elapsedMs: Date.now() - started };

  let ranked = rankQuery(state, terms);
  if (pathFilter && pathFilter.length > 0) {
    // Accept exact relative paths or directory prefixes - case-tolerant like most CLIs.
    const normalized = pathFilter.map((p) => forwardSlash(p).toLowerCase());
    ranked = ranked.filter((h) => {
      const lower = h.relPath.toLowerCase();
      return normalized.some((p) => lower === p || lower.startsWith(p.endsWith('/') ? p : `${p}/`));
    });
  }

  const hits: SearchResultHit[] = [];
  let usedChars = 0;
  const wanted = new Set(terms);
  for (const cand of ranked) {
    if (hits.length >= opts.k) break;
    if (usedChars >= opts.maxChars) break;
    // Defense in depth (review F-09): postings keys are validated at load
    // time, but the read boundary re-checks confinement before touching the
    // filesystem - an in-memory state can always be hand-built wrong.
    if (!isConfinedRelPath(cand.relPath)) continue;
    let text = '';
    try {
      text = readFileSync(join(root, ...cand.relPath.split('/')), 'utf-8');
    } catch {
      continue; // deleted/unreadable since indexing - honest skip, not a crash
    }
    const matchCount = tokenize(text).reduce((n, t) => (wanted.has(t) ? n + 1 : n), 0);
    const textLines = text.split(/\r?\n/);
    const { line0 } = findBestLine(textLines, terms);
    if (line0 < 0) continue; // re-read content no longer contains the query
    const snippet = renderSnippet(textLines, mergeWindows([line0], opts.contextLines, textLines.length));
    const header = `${cand.relPath}:${line0 + 1} (${matchCount} match(es))`;
    const block = `${header}\n${snippet}`;
    if (usedChars + block.length > opts.maxChars && hits.length > 0) break;
    if (block.length > opts.maxChars) {
      // Single oversize result: hard-trim to budget rather than dropping.
      hits.push({ path: cand.relPath, line: line0 + 1, matches: matchCount, text: block.slice(0, opts.maxChars) });
      break;
    }
    hits.push({ path: cand.relPath, line: line0 + 1, matches: matchCount, text: block });
    usedChars += block.length + 1;
  }
  return { hits, truncated: state.truncated, elapsedMs: Date.now() - started };
}

/** One-line footer with honest numbers (the "where did these come from" receipt). */
export function formatSearchFooter(hits: number, filesIndexed: number, opts: SearchRunOptions, ageMs: number): string {
  return `${SEARCH_MARKER_FOOTER_PREFIX} ${hits} result(s) | ${filesIndexed.toLocaleString('en-US')} files indexed | budget ${opts.k} hits/${opts.maxChars.toLocaleString('en-US')} chars | index refreshed ${Math.round(ageMs)}ms ago`;
}

/**
 * Counterfactual estimate for the E5-adjacent honesty layer: how many chars
 * would a naive "read every hit's whole file" approach have cost, minus what
 * the snippet summary actually sent? Per unique file, the index-time size is
 * the baseline; files missing from meta (changed since indexing) are skipped
 * honestly rather than guessed. Can go negative on pathological inputs
 * (many hits in tiny files) - callers clamp for display, never for storage.
 * This number backs /broke estimate and the badge tooltip ONLY - it must
 * never feed savedChars or the measure ledger.
 */
export function estimateBulkReadAvoided(
  hits: ReadonlyArray<SearchResultHit>,
  files: Readonly<Record<string, IndexedFile>>,
): number {
  const sentByPath = new Map<string, number>();
  let sent = 0;
  for (const h of hits) {
    sent += h.text.length;
    if (!sentByPath.has(h.path)) sentByPath.set(h.path, h.text.length);
  }
  let baseline = 0;
  for (const path of sentByPath.keys()) {
    const meta = files[path];
    if (!meta || typeof meta.sizeBytes !== 'number') continue;
    baseline += meta.sizeBytes;
  }
  return baseline - sent;
}

// ---------------------------------------------------------------------------
// Persistence (atomic, bounded, corruption-tolerant)
// ---------------------------------------------------------------------------

/** Extension-directory location: survives deploys/updates via preserve lists. */
export function indexDirFor(projectRoot: string): string {
  // Env override mirrors the BROKE_CONFIG_PATH isolation pattern - tests must
  // never write into the real extension directory.
  const base = process.env.BROKE_INDEX_DIR || __dirname;
  return join(base, 'index', projectHash(projectRoot));
}

/**
 * Atomic write (tmp + rename, fsynced pattern from config.saveConfig).
 * Failures THROW here by contract; callers wrap (ensureFresh persists via
 * its own catch, commands report). Bounded by construction: postings are
 * small integers, entries capped at INDEX_MAX_ENTRIES.
 */
export function saveIndex(dir: string, state: IndexState): void {
  // BRK-003 hardening: the index holds paths and terms of the local project,
  // so it is owner-only on POSIX (ignored where modes do not apply).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, 'index.json');
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, target);
}

/** Load a persisted index. Anything suspicious becomes null (rebuild later). */
function rebuildDict<T>(source: Record<string, T>, mapValue?: (value: T) => T): Dict<T> {
  const out = nullDict<T>();
  for (const [key, value] of Object.entries(source)) {
    defineKey(out, key, mapValue ? mapValue(value) : value);
  }
  return out;
}

/** Load a persisted index. Anything suspicious becomes null (rebuild later). */
export function loadIndex(dir: string): IndexState | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf-8')) as Partial<IndexState>;
    if (
      raw?.version !== 1 ||
      typeof raw.projectRoot !== 'string' ||
      typeof raw.files !== 'object' ||
      raw.files === null ||
      typeof raw.postings !== 'object' ||
      raw.postings === null
    ) {
      return null;
    }
    // Path confinement (review F-09): the on-disk index is derived state that
    // a tampered/synced/stale file could poison; relPaths are joined onto the
    // project root at READ time, so every persisted key must be confined.
    // One bad key invalidates the whole file - a rebuild is always safe.
    for (const relPath of Object.keys(raw.files)) {
      if (!isConfinedRelPath(relPath)) return null;
    }
    for (const posting of Object.values(raw.postings)) {
      if (typeof posting !== 'object' || posting === null) return null;
      for (const relPath of Object.keys(posting)) {
        if (!isConfinedRelPath(relPath)) return null;
      }
    }
    return {
      version: 1,
      projectRoot: raw.projectRoot,
      builtAt: raw.builtAt ?? '',
      truncated: raw.truncated === true,
      // BRK-002: rebuild both dictionaries as null-prototype objects. A
      // JSON-parsed object carries Object.prototype, so a term like
      // '__proto__' (JSON.parse DOES create it as a real own key) would
      // otherwise resolve through the prototype chain during queries and
      // merges. Rebuilding also drops any exotic inherited lookups.
      files: rebuildDict<IndexedFile>(raw.files),
      postings: rebuildDict<Dict<number>>(raw.postings, (posting) => rebuildDict<number>(posting)),
    };
  } catch {
    return null;
  }
}

/** Defaults resolved from config in one place (commands + tools share this). */
export function resolveSearchOptions(config: Config['search']): { maxResults: number; options: SearchRunOptions; maxFileKB: number } {
  return {
    maxResults: config.maxResults,
    options: { k: config.maxResults, maxChars: config.maxChars, contextLines: config.contextLines },
    maxFileKB: config.maxFileKB,
  };
}
