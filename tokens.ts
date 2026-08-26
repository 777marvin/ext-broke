import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextMessage } from '@aiderdesk/extensions';
import type { CompressReport } from './compress';
import { partText } from './output';

// BROKE_STATS_PATH / BROKE_MEASURE_PATH override the defaults (read at
// module load): tests need isolation from the real ledgers.
export const STATS_PATH = process.env.BROKE_STATS_PATH ?? join(__dirname, 'stats.jsonl');
export const MEASURE_PATH = process.env.BROKE_MEASURE_PATH ?? join(__dirname, 'measure.jsonl');

/**
 * Token estimation. chars/4 is a deliberately crude heuristic (English prose
 * ≈ 4 chars/token; code ≈ 3-3.5). Broke never claims provider-exact numbers
 * - every figure is labeled as an estimate. The heuristic is consistent,
 * which is what matters for comparing before/after.
 */
export function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

/** Estimate the character size of a single message. */
export function messageChars(message: ContextMessage): number {
  const content = message.content;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => sum + partText(part as unknown as { type: string; [key: string]: unknown }).length, 0);
  }
  return 0;
}

/** Estimate the character size of a list of messages. */
export function messagesChars(messages: ContextMessage[]): number {
  return messages.reduce((sum, m) => sum + messageChars(m), 0);
}

export interface SavedTokens {
  structural: number;
  /** Chars removed by stack-trace/log compression (errors pass). */
  error: number;
  truncate: number;
  summarize: number;
  /**
   * Estimated chars saved by ST-slicing (full file vs. interface view).
   * Tool-level (outside optimize runs) - an estimate, labeled as such.
   */
  slice: number;
}

/** Fill missing counters with 0 - legacy stats.jsonl records predate some passes. */
export function normalizeSavedTokens(saved: Partial<SavedTokens> | undefined): SavedTokens {
  return {
    structural: saved?.structural ?? 0,
    error: saved?.error ?? 0,
    truncate: saved?.truncate ?? 0,
    summarize: saved?.summarize ?? 0,
    slice: saved?.slice ?? 0,
  };
}

export interface TaskStats {
  taskId: string;
  /** NOTE: never persist project paths - stats.jsonl must stay portable (privacy). */
  passes: number;
  savedChars: SavedTokens;
  /**
   * Cumulative MEASURED sizes over recorded runs (chars): the honest
   * headline is totalCharsBefore - totalCharsAfter, not the per-pass sum.
   * 0 = no measured records (legacy stats.jsonl lines predate XF14).
   */
  totalCharsBefore: number;
  totalCharsAfter: number;
  summarizedRanges: number;
  /** Real summarizer LLM calls (excludes cache reuse) - lets the user see the true cost side. */
  summarizeCalls: number;
  summarizeFailures: number;
  lastSummarizer: 'local' | 'cloud' | 'none';
  lastRunAt: number;
}

export function emptyStats(taskId: string): TaskStats {
  return {
    taskId,
    passes: 0,
    savedChars: { structural: 0, error: 0, truncate: 0, summarize: 0, slice: 0 },
    totalCharsBefore: 0,
    totalCharsAfter: 0,
    summarizedRanges: 0,
    summarizeCalls: 0,
    summarizeFailures: 0,
    lastSummarizer: 'none',
    lastRunAt: 0,
  };
}

export function totalSavedChars(stats: TaskStats): number {
  return (
    stats.savedChars.structural +
    stats.savedChars.error +
    stats.savedChars.truncate +
    stats.savedChars.summarize +
    stats.savedChars.slice
  );
}

const MAX_STATS_FILE_BYTES = 5 * 1024 * 1024;
const MAX_MEASURE_FILE_BYTES = 5 * 1024 * 1024;
/** Rotation chain length: <file>.1 (newest) .. <file>.3 (oldest) are kept. */
const MAX_ROTATED_FILES = 3;

/**
 * All ledger files for `filePath`, OLDEST first: <file>.3, .2, .1, <file>.
 * Loaders iterate this order so records are seen chronologically; lookups
 * iterate in reverse (newest file wins).
 */
export function ledgerFiles(filePath: string): string[] {
  const out: string[] = [];
  for (let i = MAX_ROTATED_FILES; i >= 1; i--) out.push(`${filePath}.${i}`);
  out.push(filePath);
  return out;
}

/**
 * Rotate by RENAME (XF15): the oversized main file becomes the newest
 * rotation untouched - no read + rewrite of the whole ledger. The oldest
 * rotation is dropped, so the chain stays bounded (~4 x maxBytes on disk).
 */
function rotateLedger(filePath: string): void {
  rmSync(`${filePath}.${MAX_ROTATED_FILES}`, { force: true });
  for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
    if (existsSync(`${filePath}.${i}`)) {
      renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`);
    }
  }
  renameSync(filePath, `${filePath}.1`);
}

/**
 * Append one JSON line to a jsonl ledger. Once the file exceeds `maxBytes`
 * it is rotated (renamed aside) and a fresh file is started - O(1) instead
 * of a full-file rewrite. Shared by the stats ledger (throttled) and the
 * measurement ledger (per run). Best effort - ledger writes must never
 * break the extension. `maxBytes` is parameterizable so rotation is
 * testable with tiny caps.
 */
export function appendJsonLine(filePath: string, line: string, maxBytes: number): void {
  try {
    if (existsSync(filePath) && statSync(filePath).size > maxBytes) {
      rotateLedger(filePath);
    }
    appendFileSync(filePath, `${line}\n`, 'utf-8');
  } catch {
    // ledgers are best effort - never break the extension over them
  }
}

/**
 * Append a stats line. Keeps the file bounded by rotation (see
 * appendJsonLine). `filePath` is parameterizable so tests run against a temp
 * file.
 */
export function persistStats(stats: TaskStats, filePath: string = STATS_PATH): void {
  appendJsonLine(filePath, JSON.stringify(stats), MAX_STATS_FILE_BYTES);
}

/**
 * Remove all persisted stats lines for a task (real reset - old task data,
 * including project paths, is actually deleted from disk).
 */
export function clearTaskStats(taskId: string, filePath: string = STATS_PATH): void {
  try {
    // A real reset must reach rotated files too (XF15): the task's newest
    // line may live in a rotation when the main file was rotated since.
    for (const f of ledgerFiles(filePath)) {
      if (!existsSync(f)) continue;
      const lines = readFileSync(f, 'utf-8').split('\n');
      const kept: string[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as TaskStats;
          if (parsed.taskId === taskId) continue;
        } catch {
          // malformed line: drop it while rewriting
          continue;
        }
        kept.push(line);
      }
      writeFileSync(f, kept.length ? `${kept.join('\n')}\n` : '', 'utf-8');
    }
  } catch {
    // best effort
  }
}

/** Load persisted stats for a task (newest file, last matching line wins). */
export function loadTaskStats(taskId: string, filePath: string = STATS_PATH): TaskStats | null {
  try {
    // Newest file first (XF15): a task's latest line may live in a rotated
    // file when no newer line was written after the rotation.
    for (const f of ledgerFiles(filePath).reverse()) {
      if (!existsSync(f)) continue;
      const lines = readFileSync(f, 'utf-8').split('\n');
      let found: TaskStats | null = null;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as TaskStats;
          if (parsed.taskId === taskId) {
            found = {
              ...parsed,
              savedChars: normalizeSavedTokens(parsed.savedChars),
              // Legacy lines predate the measured-size fields (XF14).
              totalCharsBefore: typeof parsed.totalCharsBefore === 'number' ? parsed.totalCharsBefore : 0,
              totalCharsAfter: typeof parsed.totalCharsAfter === 'number' ? parsed.totalCharsAfter : 0,
            };
          }
        } catch {
          // skip malformed lines
        }
      }
      if (found) return found;
    }
    return null;
  } catch {
    return null;
  }
}

export interface StatsLoader {
  /**
   * Cached load: re-reads the file at most once per `ttlMs` per task.
   * Badge refreshes call this on every UI tick, and each uncached read
   * scans the whole stats.jsonl synchronously (up to 5 MB).
   */
  get(taskId: string): TaskStats | null;
  /** Drop the cache for a task (after /broke reset cleared the persisted lines). */
  invalidate(taskId: string): void;
}

/** Cache bounded like the extension's other per-task maps (evict oldest). */
function boundedCacheSet<K, V>(map: Map<K, V>, key: K, value: V, max = 500): void {
  if (map.size >= max && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export function createStatsLoader(filePath: string = STATS_PATH, ttlMs: number = 30_000): StatsLoader {
  const cache = new Map<string, { at: number; stats: TaskStats | null }>();
  return {
    get(taskId) {
      const hit = cache.get(taskId);
      if (hit && Date.now() - hit.at < ttlMs) return hit.stats;
      const stats = loadTaskStats(taskId, filePath);
      boundedCacheSet(cache, taskId, { at: Date.now(), stats });
      return stats;
    },
    invalidate(taskId) {
      cache.delete(taskId);
    },
  };
}

// ---------------------------------------------------------------------------
// Measurement ledger (measure.jsonl): one record per real compression run.
// This is the provable real-session counterpart to the deterministic
// benchmark in scripts/bench.ts. Records carry sizes and per-pass removals
// only - no paths, no message content (privacy).
// ---------------------------------------------------------------------------

export interface RunRecord {
  kind: 'run';
  taskId: string;
  /** Epoch ms when the compression run happened. */
  at: number;
  /** Input size before compression (chars, incl. all messages). */
  charsBefore: number;
  /** Input size after compression (chars). */
  charsAfter: number;
  /** Total chars removed = charsBefore - charsAfter. */
  savedChars: number;
  structuralChars: number;
  errorChars: number;
  truncateChars: number;
  summarizeChars: number;
  /** Real summarizer LLM calls this run (0 = cache reuse). */
  summarizeCalls: number;
  summarizer: 'local' | 'cloud' | 'none';
}

/** Map a compression report to its measurement record (pure). */
export function buildRunRecord(taskId: string, report: CompressReport): RunRecord {
  return {
    kind: 'run',
    taskId,
    at: Date.now(),
    charsBefore: report.totalCharsBefore,
    charsAfter: report.totalCharsAfter,
    savedChars: report.totalCharsBefore - report.totalCharsAfter,
    structuralChars: report.structuralChars,
    errorChars: report.errorChars,
    truncateChars: report.truncateChars,
    summarizeChars: report.summarizeChars,
    summarizeCalls: report.summarizeCalls,
    summarizer: report.summarizer,
  };
}

/** Append one run record to the measurement ledger (rotation-capped, best effort). */
export function persistRunRecord(record: RunRecord, filePath: string = MEASURE_PATH, maxBytes: number = MAX_MEASURE_FILE_BYTES): void {
  appendJsonLine(filePath, JSON.stringify(record), maxBytes);
}

/** Load all run records (oldest first, incl. rotated files). Malformed lines are skipped. */
export function loadRunRecords(filePath: string = MEASURE_PATH): RunRecord[] {
  try {
    const records: RunRecord[] = [];
    // ledgerFiles() is oldest-first, so the merged stream stays chronological.
    for (const f of ledgerFiles(filePath)) {
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as RunRecord;
          if (parsed.kind === 'run' && typeof parsed.taskId === 'string' && typeof parsed.charsBefore === 'number') {
            records.push(parsed);
          }
        } catch {
          // skip malformed lines
        }
      }
    }
    return records;
  } catch {
    return [];
  }
}

export interface MeasureSummary {
  runs: number;
  tasks: number;
  /** Epoch span from first to last record (0 when only one record). */
  spanMs: number;
  charsBefore: number;
  charsAfter: number;
  savedChars: number;
  savedTokens: number;
  meanSavedCharsPerRun: number;
  medianSavedCharsPerRun: number;
  maxSavedCharsPerRun: number;
  summarizeCalls: number;
  /** Per-task breakdown, sorted by savedChars descending. */
  byTask: Array<{ taskId: string; runs: number; savedChars: number }>;
}

/**
 * Aggregate run records. The totals are a SUM OVER INDIVIDUAL RUNS of the
 * same evolving conversation - they are NOT a cumulative context claim (the
 * same region is compressed again on every model call). Returns null when
 * there are no records.
 */
export function summarizeRunRecords(records: RunRecord[]): MeasureSummary | null {
  if (records.length === 0) return null;
  const savedPerRun = records.map((r) => r.savedChars);
  const sorted = [...savedPerRun].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  const byTask = new Map<string, { runs: number; savedChars: number }>();
  for (const r of records) {
    const entry = byTask.get(r.taskId) ?? { runs: 0, savedChars: 0 };
    entry.runs += 1;
    entry.savedChars += r.savedChars;
    byTask.set(r.taskId, entry);
  }
  const charsBefore = records.reduce((sum, r) => sum + r.charsBefore, 0);
  const charsAfter = records.reduce((sum, r) => sum + r.charsAfter, 0);
  const savedChars = records.reduce((sum, r) => sum + r.savedChars, 0);
  const ats = records.map((r) => r.at).sort((a, b) => a - b);
  return {
    runs: records.length,
    tasks: byTask.size,
    spanMs: ats.length > 1 ? ats[ats.length - 1] - ats[0] : 0,
    charsBefore,
    charsAfter,
    savedChars,
    savedTokens: estimateTokens(savedChars),
    meanSavedCharsPerRun: Math.round(savedChars / records.length),
    medianSavedCharsPerRun: median,
    maxSavedCharsPerRun: sorted[sorted.length - 1],
    summarizeCalls: records.reduce((sum, r) => sum + r.summarizeCalls, 0),
    byTask: [...byTask.entries()]
      .map(([taskId, entry]) => ({ taskId, runs: entry.runs, savedChars: entry.savedChars }))
      .sort((a, b) => b.savedChars - a.savedChars),
  };
}
