/**
 * Stack-trace & log compression. Pure functions that reduce compiler/test
 * output to its diagnostic essence: exception type, failing file:line and a
 * small window of surrounding context. Used by the input pass (errorPass in
 * compress.ts) and - when errors.toolLevel is on - by onToolFinished.
 *
 * Everything here is deterministic text processing: no LLM, no dependencies.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Directory where full tool outputs are archived when errors.toolLevel is on. */
export const ERRORS_DIR = process.env.BROKE_ERRORS_DIR ?? join(__dirname, 'errors');

/** Total archive cap: full tool outputs are debug data, they must not grow unbounded. */
export const MAX_ERRORS_DIR_BYTES = 100 * 1024 * 1024;
/** After eviction the archive is trimmed to this watermark (hysteresis). */
const EVICT_DOWN_TO_BYTES = 80 * 1024 * 1024;
/** Age-based sweeps run at most this often per directory (XF9: no scan per save). */
export const ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * In-memory byte accounting per archive directory (XF9). Saves add their
 * size to the ledger instead of walking the tree; the full scan + eviction
 * runs only when the ledger exceeds the cap or a retention sweep is due.
 * A scan re-syncs the ledger, so files deleted outside the extension
 * self-correct on the next sweep.
 */
interface ArchiveLedger {
  total: number;
  files: Map<string, { size: number; mtimeMs: number }>;
  lastSweepAt: number;
}

const archiveLedgers = new Map<string, ArchiveLedger>();

function ledgerFor(dir: string): ArchiveLedger {
  let ledger = archiveLedgers.get(dir);
  if (!ledger) {
    ledger = { total: 0, files: new Map(), lastSweepAt: 0 };
    archiveLedgers.set(dir, ledger);
  }
  return ledger;
}

/**
 * Forget all tracked sizes/timestamps for a directory (or all directories).
 * Used by clearArchive and by tests to get deterministic sweep timing.
 */
export function resetArchiveLedger(dir?: string): void {
  if (dir === undefined) {
    archiveLedgers.clear();
  } else {
    archiveLedgers.delete(dir);
  }
}

/**
 * File-system-safe name: invalid chars replaced, truncated to 80 chars, plus
 * an 8-char hash suffix of the ORIGINAL string. Two long ids sharing the
 * same 80-char prefix would otherwise collide and overwrite each other's
 * archive file.
 */
function safeName(s: string): string {
  const base = s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'unknown';
  const hash = createHash('sha1').update(s).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

export interface ArchiveEvictionResult {
  removedFiles: number;
  removedBytes: number;
}

/**
 * Keep the archive bounded: files older than `retentionDays` are deleted
 * first (privacy control, XF10), then - once the total size exceeds the
 * cap - the oldest remaining files until the watermark is reached.
 * Best effort. Cap/watermark/retention are parameters so tests can
 * exercise eviction cheaply. One scan re-syncs the byte ledger (XF9).
 */
export function enforceArchiveCap(
  dir: string = ERRORS_DIR,
  maxBytes: number = MAX_ERRORS_DIR_BYTES,
  watermarkBytes: number = EVICT_DOWN_TO_BYTES,
  opts: { retentionDays?: number; now?: number } = {},
): ArchiveEvictionResult {
  const result: ArchiveEvictionResult = { removedFiles: 0, removedBytes: 0 };
  try {
    if (!existsSync(dir)) {
      resetArchiveLedger(dir);
      return result;
    }
    const now = opts.now ?? Date.now();
    const maxAgeMs = opts.retentionDays ? opts.retentionDays * 86_400_000 : 0;
    const files: { path: string; mtime: number; size: number }[] = [];
    let total = 0;
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const p = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(p);
        } else if (entry.isFile()) {
          const st = statSync(p);
          files.push({ path: p, mtime: st.mtimeMs, size: st.size });
          total += st.size;
        }
      }
    };
    walk(dir);
    files.sort((a, b) => a.mtime - b.mtime);
    const tryUnlink = (f: { path: string; size: number }): void => {
      try {
        unlinkSync(f.path);
        total -= f.size;
        result.removedFiles += 1;
        result.removedBytes += f.size;
      } catch {
        // best effort - a locked file is skipped, the cap is soft
      }
    };
    // 1. Age-based eviction (XF10): expired files go regardless of the cap.
    const survivors: { path: string; mtime: number; size: number }[] = [];
    for (const f of files) {
      if (maxAgeMs > 0 && now - f.mtime > maxAgeMs) {
        tryUnlink(f);
        continue;
      }
      survivors.push(f);
    }
    // 2. Byte cap: only when the survivors still exceed the cap, evict the
    //    oldest ones until the watermark (hysteresis) is reached.
    if (total > maxBytes) {
      for (const f of survivors) {
        if (total <= watermarkBytes) break;
        tryUnlink(f);
      }
    }
    // Re-sync the ledger from the scan (self-corrects external deletions).
    const ledger = ledgerFor(dir);
    ledger.files.clear();
    let remaining = 0;
    for (const f of files) {
      if (!existsSync(f.path)) continue;
      ledger.files.set(f.path, { size: f.size, mtimeMs: f.mtime });
      remaining += f.size;
    }
    ledger.total = remaining;
    ledger.lastSweepAt = now;
  } catch {
    // best effort - archiving must never break tool execution
  }
  return result;
}

export interface SaveErrorOutputOptions {
  /** Age-based eviction: files older than N days are deleted on the next sweep. */
  retentionDays?: number;
  maxBytes?: number;
  watermarkBytes?: number;
}

/**
 * Archive the full (uncompressed) tool output next to the extension so the
 * summary marker can point at it. Best effort - never throws. Returns the
 * path relative to the extension directory ('' when saving failed).
 * Callers MUST redact secrets before calling this (see maskSecrets).
 *
 * XF9: the save updates the byte ledger instead of scanning the tree; the
 * full scan + eviction runs only when the ledger exceeds the cap or a
 * retention sweep is due (at most once per ARCHIVE_SWEEP_INTERVAL_MS).
 */
export function saveErrorOutput(taskId: string, callId: string, text: string, dir: string = ERRORS_DIR, opts: SaveErrorOutputOptions = {}): string {
  try {
    const taskDir = join(dir, safeName(taskId));
    // Owner-only permissions where the OS honors them (POSIX; Windows
    // ignores the mode bits): the archive holds redacted-but-sensitive tool
    // output and must not be world-readable (review R8).
    mkdirSync(taskDir, { recursive: true, mode: 0o700 });
    const file = join(taskDir, `${safeName(callId)}.log`);
    const size = Buffer.byteLength(text, 'utf-8');
    writeFileSync(file, text, { encoding: 'utf-8', mode: 0o600 });

    // Incremental accounting: overwriting the same call id must not
    // double-count the previous content.
    const ledger = ledgerFor(dir);
    const prev = ledger.files.get(file);
    if (prev) ledger.total -= prev.size;
    ledger.files.set(file, { size, mtimeMs: Date.now() });
    ledger.total += size;

    const maxBytes = opts.maxBytes ?? MAX_ERRORS_DIR_BYTES;
    const retentionDays = opts.retentionDays ?? 0;
    const now = Date.now();
    const needsSweep =
      ledger.total > maxBytes || (retentionDays > 0 && now - ledger.lastSweepAt >= ARCHIVE_SWEEP_INTERVAL_MS);
    if (needsSweep) {
      enforceArchiveCap(dir, maxBytes, opts.watermarkBytes ?? EVICT_DOWN_TO_BYTES, { retentionDays, now });
    }
    return join('errors', safeName(taskId), `${safeName(callId)}.log`);
  } catch {
    return '';
  }
}

/**
 * Delete the whole error archive (privacy control, XF10). User-invoked only
 * - never runs during tool execution. Returns what was removed so the
 * command can report it honestly. Resets the ledger.
 */
export function clearArchive(dir: string = ERRORS_DIR): ArchiveEvictionResult {
  const result: ArchiveEvictionResult = { removedFiles: 0, removedBytes: 0 };
  try {
    if (existsSync(dir)) {
      const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const p = join(current, entry.name);
          if (entry.isDirectory()) {
            walk(p);
          } else if (entry.isFile()) {
            const st = statSync(p);
            result.removedFiles += 1;
            result.removedBytes += st.size;
          }
        }
      };
      walk(dir);
      rmSync(dir, { recursive: true, force: true });
    }
    resetArchiveLedger(dir);
  } catch {
    // best effort - the command reports what it could count
  }
  return result;
}

export interface ErrorSummaryOptions {
  /** Context lines kept around the failing location (excerpts, source lines). */
  contextLines: number;
}

export interface ErrorSummaryResult {
  matched: boolean;
  /** Lines of the original text. */
  originalLines: number;
  /** Lines of the extracted body (without the marker line). */
  summaryLines: number;
  /** The extracted body: exception type, file:line, context. Empty when not matched. */
  body: string;
}

const MARKER_PREFIX = '… [broke: error summary - ';

/**
 * Wrap a matched body in the standard marker. `suffix` explains what happened
 * to the original text (input pass: removed; tool level: saved to a file).
 */
export function formatErrorSummary(result: ErrorSummaryResult, suffix: string): string {
  return `${MARKER_PREFIX}${result.originalLines} lines → ${result.summaryLines} lines]${suffix}\n${result.body}`;
}

function result(body: string, originalLines: number): ErrorSummaryResult {
  const summaryLines = body ? body.split('\n').length : 0;
  return { matched: true, originalLines, summaryLines, body };
}

// ---------------------------------------------------------------------------
// 1. TypeScript / tsc / tsx
// ---------------------------------------------------------------------------

const TSC_RE = /^([^\s(]+\.\w+):(\d+):(\d+)\s*-\s*error\s+(TS\d+):\s*(.*)$/;
/** tsc source excerpt lines: "12   foo(bar);" or caret/underline markers. */
const EXCERPT_RE = /^\s*\d+\s|^\s*[~^]/;

function matchTsc(lines: string[], contextLines: number): ErrorSummaryResult | null {
  let first: RegExpMatchArray | null = null;
  let firstIndex = -1;
  let more = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TSC_RE);
    if (!m) continue;
    if (!first) {
      first = m;
      firstIndex = i;
    } else {
      more++;
    }
  }
  if (!first) return null;

  // Keep excerpt lines directly after the first error (bounded by contextLines).
  const excerpt: string[] = [];
  for (let i = firstIndex + 1; i < lines.length && excerpt.length < contextLines; i++) {
    const line = lines[i];
    if (!line.trim() || !EXCERPT_RE.test(line)) break;
    excerpt.push(line.trimEnd());
  }

  const bodyLines = [
    `error ${first[4]}: ${first[5]}`,
    `at ${first[1]}:${first[2]}:${first[3]}`,
    ...excerpt.map((e) => `  ${e}`),
  ];
  if (more > 0) bodyLines.push(`(+${more} more tsc error entries)`);
  return result(bodyLines.join('\n'), lines.length);
}

// ---------------------------------------------------------------------------
// 2. Python / pytest tracebacks
// ---------------------------------------------------------------------------

const TRACEBACK_RE = /^Traceback \(most recent call last\):/;
const PY_FRAME_RE = /^\s*File "([^"]+)", line (\d+), in (.+)$/;
/** Exception lines like "ValueError: ..." / "AssertionError: ...". */
const PY_EXC_RE = /^([A-Za-z_][\w.]*(?:Error|Exception|Warning|Failure|Interrupt)):\s?(.*)$/;
const PY_FAILED_RE = /^FAILED\s+(\S+)\s*-\s*(.+)$/;

function matchPython(lines: string[], contextLines: number): ErrorSummaryResult | null {
  const tbIndex = lines.findIndex((l) => TRACEBACK_RE.test(l));
  if (tbIndex !== -1) {
    const frames: { file: string; line: string; fn: string }[] = [];
    let exc: RegExpMatchArray | null = null;
    let excIndex = -1;
    for (let i = tbIndex + 1; i < lines.length; i++) {
      const frame = lines[i].match(PY_FRAME_RE);
      if (frame) {
        frames.push({ file: frame[1], line: frame[2], fn: frame[3] });
        continue;
      }
      const e = lines[i].match(PY_EXC_RE);
      if (e) {
        exc = e;
        excIndex = i;
        break;
      }
    }
    if (!exc) {
      // A traceback without a final exception line is not a useful summary.
      return null;
    }
    // Innermost frame first (last in the list), plus its source line.
    const bodyLines: string[] = [];
    const innermost = frames[frames.length - 1];
    if (innermost) {
      bodyLines.push(`at ${innermost.file}:${innermost.line} in ${innermost.fn}`);
      // The traceback usually carries the offending source line right after
      // the frame; keep it as context (bounded by contextLines).
      for (let i = excIndex - 1; i > tbIndex && bodyLines.length - 1 < contextLines; i--) {
        const l = lines[i];
        if (!l.trim() || PY_FRAME_RE.test(l)) break;
        bodyLines.push(`  ${l.trim()}`);
      }
    }
    const final = `${exc[1]}: ${exc[2]}`;
    return result([final, ...bodyLines].join('\n'), lines.length);
  }

  const failed = lines.find((l) => PY_FAILED_RE.test(l));
  if (failed) {
    const m = failed.match(PY_FAILED_RE)!;
    return result(`pytest FAILED: ${m[2]}\nat ${m[1]}`, lines.length);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Jest / Vitest failure blocks
// ---------------------------------------------------------------------------

// Real Jest/Vitest output indents these lines (e.g. "  ● discount calculation").
const FAILED_TEST_RE = /^\s*[✕×]\s+(.+)$/;
const FAIL_BLOCK_RE = /^\s*●\s+(.+)$/;
const FRAME_RE = /at\s+(.+?)\s+\(([^)]+):(\d+):(\d+)\)/;
const MAX_NAMED_TESTS = 5;

function matchJest(lines: string[], contextLines: number): ErrorSummaryResult | null {
  const failedTests: string[] = [];
  const blocks: string[] = [];
  for (const line of lines) {
    const ft = line.match(FAILED_TEST_RE);
    if (ft && failedTests.length < MAX_NAMED_TESTS) {
      failedTests.push(ft[1].trim());
      continue;
    }
    const fb = line.match(FAIL_BLOCK_RE);
    if (fb && blocks.length < MAX_NAMED_TESTS) {
      blocks.push(fb[1].trim());
    }
  }
  if (failedTests.length === 0 && blocks.length === 0) return null;

  const bodyLines: string[] = [];
  if (failedTests.length > 0) {
    bodyLines.push(`failed tests: ${failedTests.join(' | ')}`);
  }
  if (blocks.length > 0) {
    bodyLines.push(`failure blocks: ${blocks.join(' | ')}`);
  }
  // First user-code frame in the whole output, if any.
  const frame = lines.map((l) => l.match(FRAME_RE)).find((m) => m && !m[2].includes('node:internal') && !m[2].includes('node_modules'));
  if (frame) {
    bodyLines.push(`at ${frame[2]}:${frame[3]}:${frame[4]} (${frame[1].trimEnd()})`);
  }
  void contextLines; // Jest output carries no usable source excerpt - skip it.
  return result(bodyLines.join('\n'), lines.length);
}

// ---------------------------------------------------------------------------
// 4. Node-style stack traces
// ---------------------------------------------------------------------------

const NODE_ERR_RE = /^([A-Za-z_][\w.]*(?:Error|Exception)):\s?(.*)$/;
/** Frames: "    at fn (C:\file.ts:12:5)" - prefer user code over internals. */
const NODE_FRAME_RE = /^\s+at\s+(.+?)\s+\(([^)]+):(\d+):(\d+)\)$/;

function matchNode(lines: string[]): ErrorSummaryResult | null {
  const headerIndex = lines.findIndex((l) => NODE_ERR_RE.test(l));
  if (headerIndex === -1) return null;
  const header = lines[headerIndex].match(NODE_ERR_RE)!;

  const frames = lines
    .slice(headerIndex + 1)
    .map((l) => l.match(NODE_FRAME_RE))
    .filter((m): m is RegExpMatchArray => !!m);
  const userFrame = frames.find((m) => !m[2].includes('node:internal') && !m[2].includes('node_modules')) ?? frames[0];

  const bodyLines = [`${header[1]}: ${header[2]}`];
  if (userFrame) {
    bodyLines.push(`at ${userFrame[2]}:${userFrame[3]}:${userFrame[4]} (${userFrame[1].trimEnd()})`);
  }
  return result(bodyLines.join('\n'), lines.length);
}

// ---------------------------------------------------------------------------
// 5. Generic fallback: a single "<Type>Error: message" line.
// ---------------------------------------------------------------------------

const GENERIC_ERR_RE = /^([A-Za-z_][\w.]*(?:Error|Exception|Failure)):\s?(.*)$/;

function matchGeneric(lines: string[]): ErrorSummaryResult | null {
  const m = lines.find((l) => GENERIC_ERR_RE.test(l));
  if (!m) return null;
  const g = m.match(GENERIC_ERR_RE)!;
  return result(`${g[1]}: ${g[2]}`, lines.length);
}

/**
 * Extract a compact error summary from raw tool output. Returns
 * `{ matched: false }` when the text does not look like error output, so
 * callers pass it through untouched. The body is always much smaller than
 * the input (callers additionally gate on a minimum size).
 */
export function extractErrorSummary(text: string, opts: ErrorSummaryOptions): ErrorSummaryResult {
  const lines = text.split('\n');
  return (
    matchTsc(lines, opts.contextLines) ??
    matchPython(lines, opts.contextLines) ??
    matchJest(lines, opts.contextLines) ??
    matchNode(lines) ??
    matchGeneric(lines) ?? { matched: false, originalLines: lines.length, summaryLines: 0, body: '' }
  );
}

// ---------------------------------------------------------------------------
// Tool-level support (errors.toolLevel = on)
// ---------------------------------------------------------------------------

/**
 * True when the tool result is command/compiler/test output (bash, test
 * runners, package managers, compilers). Tool-level rewriting is restricted
 * to these so that plain file reads (which can legitimately contain
 * "Error:" text) are never rewritten.
 */
export function isCommandTool(toolName: string): boolean {
  return /bash$|shell|terminal|powershell|cmd$|exec|npm|pnpm|yarn|gradle|maven|dotnet|pytest|vitest|jest|tsc|node$|test-runner|run-tests/i.test(toolName);
}
