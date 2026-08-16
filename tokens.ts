import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextMessage } from '@aiderdesk/extensions';
import { partText } from './output';

export const STATS_PATH = join(__dirname, 'stats.jsonl');

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
}

/** Fill missing counters with 0 - legacy stats.jsonl records predate some passes. */
export function normalizeSavedTokens(saved: Partial<SavedTokens> | undefined): SavedTokens {
  return {
    structural: saved?.structural ?? 0,
    error: saved?.error ?? 0,
    truncate: saved?.truncate ?? 0,
    summarize: saved?.summarize ?? 0,
  };
}

export interface TaskStats {
  taskId: string;
  /** NOTE: never persist project paths - stats.jsonl must stay portable (privacy). */
  passes: number;
  savedChars: SavedTokens;
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
    savedChars: { structural: 0, error: 0, truncate: 0, summarize: 0 },
    summarizedRanges: 0,
    summarizeCalls: 0,
    summarizeFailures: 0,
    lastSummarizer: 'none',
    lastRunAt: 0,
  };
}

export function totalSavedChars(stats: TaskStats): number {
  return stats.savedChars.structural + stats.savedChars.error + stats.savedChars.truncate + stats.savedChars.summarize;
}

const MAX_STATS_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Append a stats line. Keeps the file bounded by rotation: once the file
 * exceeds the cap, only the most recent half of the lines is kept, then the
 * new line is appended. Stats are best effort - never break the extension.
 * `filePath` is parameterizable so tests run against a temp file.
 */
export function persistStats(stats: TaskStats, filePath: string = STATS_PATH): void {
  try {
    if (existsSync(filePath) && readFileSync(filePath).length > MAX_STATS_FILE_BYTES) {
      const lines = readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.trim());
      const kept = lines.slice(-Math.ceil(lines.length / 2));
      writeFileSync(filePath, kept.length ? `${kept.join('\n')}\n` : '', 'utf-8');
    }
    appendFileSync(filePath, `${JSON.stringify(stats)}\n`, 'utf-8');
  } catch {
    // stats are best effort - never break the extension over them
  }
}

/**
 * Remove all persisted stats lines for a task (real reset - old task data,
 * including project paths, is actually deleted from disk).
 */
export function clearTaskStats(taskId: string, filePath: string = STATS_PATH): void {
  try {
    if (!existsSync(filePath)) return;
    const lines = readFileSync(filePath, 'utf-8').split('\n');
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
    writeFileSync(filePath, kept.length ? `${kept.join('\n')}\n` : '', 'utf-8');
  } catch {
    // best effort
  }
}

/** Load persisted stats for a task (last matching line wins). */
export function loadTaskStats(taskId: string, filePath: string = STATS_PATH): TaskStats | null {
  try {
    if (!existsSync(filePath)) return null;
    const lines = readFileSync(filePath, 'utf-8').split('\n');
    let found: TaskStats | null = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as TaskStats;
        if (parsed.taskId === taskId) {
          found = { ...parsed, savedChars: normalizeSavedTokens(parsed.savedChars) };
        }
      } catch {
        // skip malformed lines
      }
    }
    return found;
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
