/**
 * F3 - State snapshotting & memory flushing (docs/feats.md).
 *
 * A snapshot is a compact, inspectable JSON record of a milestone: what was
 * the goal, what was achieved, which files changed, optional commit hash and
 * a masked text summary. The optional history file is the raw message array
 * captured BEFORE a flush - the undo source.
 *
 * Non-destructive by default (roadmap principle 1): nothing in this module
 * touches the live task context. Only the command layer in index.ts applies
 * a FlushPlan - manually, confirmed, and only after snapshot + history file
 * exist on disk.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { maskSecrets } from './compress';

// ---------------------------------------------------------------------------
// Record schema
// ---------------------------------------------------------------------------

export const SnapshotRecordSchema = z.object({
  version: z.literal(1),
  taskId: z.string().min(1),
  /** Task display name at snapshot time (best effort, may be empty). */
  taskName: z.string(),
  createdAt: z.string().min(1),
  /** First user turn of the task, truncated to GOAL_MAX_CHARS. */
  goal: z.string(),
  achieved: z.string(),
  /** getUpdatedFiles() result (relative paths). */
  files: z.array(z.string()),
  commit: z.string().optional(),
  /** Compact text summary - secrets already masked. */
  summary: z.string(),
  /**
   * Set only when a history (undo) file was written next to the record.
   * Filename relative to the record's directory.
   */
  historyFile: z.string().optional(),
  /**
   * Set on flush records: the measured context-byte reduction the flush
   * produced (chars of everything after the task brief minus the chars of
   * the replacement [broke-state] message). /broke estimate uses this to
   * credit a flush - and an --undo subtracts exactly this number again,
   * so undoing never leaves an inflated estimate behind.
   */
  reduction: z
    .object({
      regionChars: z.number().int().nonnegative(),
      stateMessageChars: z.number().int().nonnegative(),
    })
    .optional(),
});

export type SnapshotRecord = z.infer<typeof SnapshotRecordSchema>;

/** Goal texts longer than this are truncated (feats.md F3). */
export const GOAL_MAX_CHARS = 2_000;

/** Marker line that identifies Broke-generated state messages. */
export const STATE_MARKER = '[broke-state]';

const SNAPSHOT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Pure helpers (no IO)
// ---------------------------------------------------------------------------

/** Flatten message content to plain text (string content or text parts). */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
      .join('\n')
      .trim();
  }
  return '';
}

/** Truncate with an explicit ellipsis marker so the cut is visible. */
export function truncateGoal(text: string, maxChars = GOAL_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Extract the task-brief text from a context message array (first user turn). */
export function extractGoal(messages: ReadonlyArray<{ role?: unknown; content?: unknown }>): string {
  const firstUser = messages.find((m) => m.role === 'user');
  return firstUser ? contentToText(firstUser.content) : '';
}

/** Extract the most recent assistant statement as the "achieved" field input. */
export function extractAchieved(messages: ReadonlyArray<{ role?: unknown; content?: unknown }>, maxChars = 1_500): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const text = contentToText(m.content);
    if (text) return truncateGoal(text, maxChars);
  }
  return '';
}

/** Pull plain text out of a cached summarizer message ({role, content} shape). */
export function summaryTextOf(cached?: { message?: unknown }): string {
  const content = (cached?.message as { content?: unknown } | undefined)?.content;
  return contentToText(content);
}

/**
 * Conservative test-green detection for the onTestPass trigger (default off).
 * Requires an explicit pass count ("N tests passed" / "N ok") and NO failure
 * indicators within the scan window. Exit codes are not visible at tool-result
 * level, so this stays deliberately stricter than the feats.md sketch.
 */
export function looksLikeGreenTests(text: string): boolean {
  const window = text.slice(0, 20_000);
  const hasPassCount =
    /\b\d+\s+(?:tests?\s+)?(?:pass(?:ed|ing)?|ok)\b/i.test(window) ||
    /(?:^|\r?\n)\s*ok\s+\d+\b/im.test(window) || // TAP-style "ok 7 suites"
    /\ball\s+(?:\d+\s+)?(?:tests?\s+)?pass/i.test(window);
  const hasFailureSignal = /\bfail/i.test(window) || /\b[1-9]\d*\s+(?:failed|errors?)\b/i.test(window);
  return hasPassCount && !hasFailureSignal;
}

/** Masked, schema-valid record from milestone inputs. Secrets never persist. */
export function makeSnapshotRecord(
  input: {
    taskId: string;
    taskName?: string;
    goal: string;
    achieved?: string;
    files?: string[];
    commit?: string;
    summary: string;
    /** Measured flush reduction (see SnapshotRecordSchema.reduction). */
    reduction?: { regionChars: number; stateMessageChars: number };
  },
  createdAt = new Date().toISOString(),
): SnapshotRecord {
  return SnapshotRecordSchema.parse({
    version: SNAPSHOT_VERSION,
    taskId: input.taskId,
    taskName: input.taskName ?? '',
    createdAt,
    goal: truncateGoal(maskSecrets(input.goal)),
    achieved: truncateGoal(maskSecrets(input.achieved ?? '')),
    files: input.files ?? [],
    // Absent vs present matters: an absent key keeps JSON.stringify(state)
    // byte-stable and avoids noise like "commit": null/undefined.
    ...(input.commit ? { commit: maskSecrets(input.commit) } : {}),
    // Same absence rule as commit: only flush records carry a reduction.
    ...(input.reduction
      ? {
          reduction: {
            regionChars: Math.max(0, Math.trunc(input.reduction.regionChars)),
            stateMessageChars: Math.max(0, Math.trunc(input.reduction.stateMessageChars)),
          },
        }
      : {}),
    summary: maskSecrets(input.summary),
  });
}

/**
 * State message handed to the agent after a flush: the marker plus the full
 * record as compact JSON - the agent can re-read the goal without scrolling
 * through the flushed region.
 */
export function buildStateMessage(record: SnapshotRecord): string {
  return `${STATE_MARKER}\n${JSON.stringify(record)}`;
}

/**
 * Result of {@link buildFlushPlan}: index-shaped so the executor maps indices
 * back to the real ContextMessage objects it got from getContextMessages().
 */
export interface FlushPlan {
  ok: boolean;
  reason?: string;
  /** Index of the task-brief (first user) message to keep. */
  briefIndex: number;
  /** Indices (< briefIndex excluded) of leading system/header messages kept unchanged. */
  headerIndexes: number[];
  /** Number of messages dropped between the brief and the end of context. */
  removedCount: number;
}

/**
 * Compute the flush replacement set (pure, fully testable).
 *
 * Final context = header messages + task brief + fresh `[broke-state]`
 * message. Everything between brief and end is replaced - including earlier
 * state messages from previous flushes, which collapse into the new state.
 * Execution uses loadContextMessages (documented replacement API, see S2 in
 * feats.md): removeMessagesUpTo is inclusive-of-self and therefore cannot
 * express "keep the first message, drop the rest".
 */
export function buildFlushPlan(messages: ReadonlyArray<{ role?: unknown; id?: unknown }>): FlushPlan {
  const briefIndex = messages.findIndex((m) => m.role === 'user');
  if (briefIndex === -1) {
    return { ok: false, reason: 'no user turn found in this task yet', briefIndex: -1, headerIndexes: [], removedCount: 0 };
  }
  if (briefIndex >= messages.length - 1) {
    return { ok: false, reason: 'nothing to flush - context holds nothing beyond the task brief', briefIndex, headerIndexes: [], removedCount: 0 };
  }
  // IDs are only needed for the alternative remove/add path; a missing-id
  // context still works via loadContextMessages, so no hard failure here.
  const headerIndexes = messages.map((m, i) => (m.role !== 'user' && i < briefIndex ? i : -1)).filter((i) => i >= 0);
  return { ok: true, briefIndex, headerIndexes, removedCount: messages.length - (briefIndex + 1) };
}

// ---------------------------------------------------------------------------
// Persistence (extension dir - survives deploys/updates, see preserve lists)
// ---------------------------------------------------------------------------

const SNAPSHOT_DIR_NAME = 'snapshots';
/** Rotation ceiling per task - oldest record+history pair deleted first. */
export const MAX_SNAPSHOTS_PER_TASK = 50;
/**
 * Aggregate ceiling per task across records AND history files (review F-14):
 * raw histories make a single snapshot arbitrarily large, so a count-only
 * cap cannot bound storage. Oldest pairs are evicted until both limits hold.
 */
export const MAX_SNAPSHOT_BYTES_PER_TASK = 25 * 1024 * 1024;
/**
 * A single undo file larger than this is refused (review F-01/F-14):
 * non-destructive snapshot callers skip the history (the record still
 * persists), the destructive flush caller aborts instead of deleting
 * context it could never restore.
 */
export const MAX_HISTORY_FILE_BYTES = 10 * 1024 * 1024;

/** Root for snapshots: explicit override > env var (tests/host contract) >
 * default next to the extension entry module (like stats.jsonl). */
export function snapshotsRoot(overrides?: { dir?: string }): string {
  return overrides?.dir ?? process.env.BROKE_SNAPSHOTS_DIR ?? join(__dirname, SNAPSHOT_DIR_NAME);
}

/** Filename-safe label fragment: alphanumerics, dash and underscore only. */
export function safeLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return cleaned || 'snapshot';
}

/**
 * 2026-08-26T12:34:56.789Z -> 20260826T123456789Z (sortable, unique enough).
 * Exported for tests that need to seed/locate history files by their names.
 */
export function isoFilename(iso: string): string {
  // 2026-08-26T12:34:56.789Z -> 20260826T123456789Z (sortable, unique enough)
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(iso);
  if (!m) return Date.now().toString();
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}${m[7]}Z`;
}

interface IoPaths {
  root: string;
}

function taskDir(paths: IoPaths, taskId: string): string {
  return join(paths.root, safeLabel(taskId));
}

/**
 * Record the measured flush reduction onto an EXISTING flush record file
 * (best effort, exactly-once). Deliberately NOT part of persistSnapshot:
 * the pre-flush snapshot must be complete and abort-safe BEFORE any message
 * is removed, while the reduction is only knowable after the replacement
 * message exists (its own chars count against the saving). Only fills an
 * absent field - a second write can never double-credit.
 */
export function writeFlushReduction(
  recordPath: string,
  reduction: { regionChars: number; stateMessageChars: number },
): void {
  try {
    if (!existsSync(recordPath)) return;
    const parsed = SnapshotRecordSchema.safeParse(JSON.parse(readFileSync(recordPath, 'utf-8')));
    if (!parsed.success || parsed.data.reduction) return;
    const next = SnapshotRecordSchema.parse({
      ...parsed.data,
      reduction: {
        regionChars: Math.max(0, Math.trunc(reduction.regionChars)),
        stateMessageChars: Math.max(0, Math.trunc(reduction.stateMessageChars)),
      },
    });
    writeFileSync(recordPath, `${JSON.stringify(next)}\n`, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // best effort: the estimate stays unrecorded instead of breaking anything
  }
}

/**
 * Write snapshot + (optionally) history sidecar. History goes to disk FIRST -
 * if it fails, no record claims an undo file that does not exist.
 * History files larger than `opts.historyBytesCap` (default
 * MAX_HISTORY_FILE_BYTES) are refused: no historyFile is recorded and
 * `historySkipped: 'oversized'` is reported - callers decide whether that
 * is fatal (flush) or acceptable (snapshot).
 * Returns the record path and, when written, the history path.
 */
export function persistSnapshot(
  record: SnapshotRecord,
  history: unknown[],
  opts?: { dir?: string; label?: string; keepHistory?: boolean; historyBytesCap?: number },
): { recordPath: string; historyPath?: string; historySkipped?: 'oversized' } {
  const paths: IoPaths = { root: snapshotsRoot(opts) };
  const dir = taskDir(paths, record.taskId);
  mkdirSync(dir, { recursive: true });

  let historyFile: string | undefined;
  let historyPath: string | undefined;
  let historySkipped: 'oversized' | undefined;
  const base = `${isoFilename(record.createdAt)}_${safeLabel(opts?.label ?? 'manual')}`;
  if (opts?.keepHistory !== false && history.length > 0) {
    const serialized = JSON.stringify(history);
    if (Buffer.byteLength(serialized, 'utf-8') > (opts?.historyBytesCap ?? MAX_HISTORY_FILE_BYTES)) {
      historySkipped = 'oversized';
    } else {
      historyFile = `${base}.history.json`;
      historyPath = join(dir, historyFile);
      try {
        writeFileSync(historyPath, serialized, { encoding: 'utf-8', mode: 0o600 });
      } catch (err) {
        // Principle: abort rather than create a record whose undo file is gone.
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  const stamped: SnapshotRecord = historyFile ? { ...record, historyFile } : record;
  const recordPath = join(dir, `${base}.json`);
  writeFileSync(recordPath, JSON.stringify(stamped, null, 2), { encoding: 'utf-8', mode: 0o600 });

  rotateTaskDir(dir);
  return { recordPath, historyPath, historySkipped };
}

/** List a task's snapshots, newest first. Unreadable records surface as null. */
export interface SnapshotListEntry {
  file: string;
  label: string;
  createdAt: string | undefined;
  record: SnapshotRecord | null;
  bytes: number;
}

export function listSnapshots(taskId: string, opts?: { dir?: string }): SnapshotListEntry[] {
  const dir = taskDir({ root: snapshotsRoot(opts) }, taskId);
  if (!existsSync(dir)) return [];
  const entries: SnapshotListEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.history.json')) continue;
    const p = join(dir, name);
    let record: SnapshotRecord | null = null;
    let bytes = 0;
    try {
      record = readSnapshot(p);
      bytes = statSync(p).size;
    } catch {
      record = null;
    }
    // <iso>_<label>.json - iso block length is fixed (17 chars).
    const labelStart = isoPatternLength(name) + 1;
    entries.push({
      file: name,
      label: name.slice(labelStart, -'.json'.length),
      createdAt: record?.createdAt,
      record,
      bytes,
    });
  }
  entries.sort((a, b) => b.file.localeCompare(a.file));
  return entries;
}

/** Length of the isoFilename block produced by isoFilename(); 0 if non-matching. */
function isoPatternLength(filename: string): number {
  return /^\d{8}T\d{9}Z_/.test(filename) ? 'YYYYMMDDTHHMMSSMMMZ'.length : 0;
}

export function readSnapshot(path: string): SnapshotRecord | null {
  const parsed = SnapshotRecordSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')));
  return parsed.success ? parsed.data : null;
}

/** Resolve a user-supplied list index (1-based, newest first) to a full path. */
export function resolveSnapshot(taskId: string, n: number, opts?: { dir?: string }): { path: string; entry: SnapshotListEntry } | undefined {
  const list = listSnapshots(taskId, opts);
  const entry = list[n - 1];
  if (!entry) return undefined;
  return { path: join(taskDir({ root: snapshotsRoot(opts) }, taskId), entry.file), entry };
}

export function readHistory(recordPath: string, record: SnapshotRecord): unknown[] | undefined {
  if (!record.historyFile) return undefined;
  const p = join(join(recordPath, '..'), record.historyFile);
  if (!existsSync(p)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'));
  return Array.isArray(parsed) ? parsed : undefined;
}

/**
 * Rotation: keep the newest `maxRecords` snapshot records per task, deleting
 * each dropped record together with its history file, AND evict oldest pairs
 * until the aggregate byte budget `maxBytes` holds (review F-14: raw
 * histories make count-only rotation unbounded). Returns removed count.
 */
export function rotateTaskDir(
  dir: string,
  maxRecords: number = MAX_SNAPSHOTS_PER_TASK,
  maxBytes: number = MAX_SNAPSHOT_BYTES_PER_TASK,
): number {
  if (!existsSync(dir)) return 0;
  const records = readdirSync(dir).filter((n) => n.endsWith('.json') && !n.endsWith('.history.json')).sort();
  const histories = new Set(readdirSync(dir).filter((n) => n.endsWith('.history.json')));
  const pairBytes = (name: string): number => {
    let total = 0;
    try {
      total += statSync(join(dir, name)).size;
    } catch {
      // raced/unreadable - count as 0 rather than failing rotation
    }
    const hist = `${name.slice(0, -'.json'.length)}.history.json`;
    if (histories.has(hist)) {
      try {
        total += statSync(join(dir, hist)).size;
      } catch {
        // raced file
      }
    }
    return total;
  };
  let total = 0;
  const sizes = new Map<string, number>();
  for (const name of records) {
    const bytes = pairBytes(name);
    sizes.set(name, bytes);
    total += bytes;
  }
  // records[] is sorted oldest-first (isoFilename prefixes), so eviction
  // walks from the oldest end until both limits hold.
  let removed = 0;
  for (const name of records) {
    if (records.length - removed <= maxRecords && total <= maxBytes) break;
    try {
      rmSync(join(dir, name), { force: true });
      const hist = `${name.slice(0, -'.json'.length)}.history.json`;
      if (histories.has(hist)) rmSync(join(dir, hist), { force: true });
    } catch {
      // raced delete - leave the rest consistent
      continue;
    }
    total -= sizes.get(name) ?? 0;
    removed++;
  }
  return removed;
}
