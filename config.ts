import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Config file location. BROKE_CONFIG_PATH overrides the default (read at
 * module load): tests and parallel extension instances need isolation
 * from the real config.json.
 */
export const CONFIG_PATH = process.env.BROKE_CONFIG_PATH ?? join(__dirname, 'config.json');

/**
 * Broke configuration. All values have defaults, so a missing or partial
 * config file always produces a valid configuration. The file lives in the
 * extension directory and is preserved across deploys (deploy.ps1 keeps
 * config.json in the target).
 */
const TruncateSchema = z.object({
  /** Max lines kept per truncated old tool output (head + tail). */
  maxLines: z.number().int().positive().default(200),
  /** Max KB kept per truncated old tool output. */
  maxKB: z.number().int().positive().default(20),
  /** Tool-call inputs (assistant messages) longer than this many chars are trimmed. */
  maxInputChars: z.number().int().positive().default(2000),
});
const truncateDefault = TruncateSchema.parse({});

const ErrorsSchema = z.object({
  /** Compress matching tool results (stack traces, compiler/test output). */
  enabled: z.boolean().default(true),
  /**
   * Per-message threshold (chars) - independent of maxContextChars: a 2k-line
   * test failure in a small conversation is exactly the case worth compressing.
   */
  minChars: z.number().int().positive().default(8000),
  /** Context lines kept around the failing line. */
  contextLines: z.number().int().min(1).max(30).default(8),
  /**
   * Rewrite tool results at the source (onToolFinished) instead of input-only.
   * Rewrites STORED history - keep off unless you want the summary persisted;
   * full outputs are archived under <extension>/errors/.
   */
  toolLevel: z.boolean().default(false),
  /**
   * Persist full tool outputs under <extension>/errors/ (privacy: raw tool
   * output - source code, URLs, paths - stays on disk, redacted best effort).
   * When off, tool-level summaries say "full output removed" instead.
   * Default OFF (review R7): durable copies of potentially sensitive tool
   * output are an explicit opt-in, not a side effect.
   */
  archive: z.boolean().default(false),
  /** Age-based eviction: archived outputs older than N days are deleted. */
  retentionDays: z.number().int().min(1).max(365).default(30),
});
const errorsDefault = ErrorsSchema.parse({});

const SummarizeSchema = z.object({
  /**
   * Only summarize turns older than this many user turns. Regions without
   * ANY user turn (autonomous single-prompt tool loops) are exempt - the
   * gate would otherwise be unsatisfiable there.
   */
  afterTurns: z.number().int().min(2).max(100).default(8),
  /** Minimum region size (chars) before summarization is worth it. */
  minChars: z.number().int().positive().default(8000),
  /** Summarizer backend: 'local' = Ollama HTTP, 'cloud' = AiderDesk model registry. */
  via: z.enum(['local', 'cloud']).default('local'),
  /** Ollama model tag used by the local summarizer. */
  localModel: z.string().min(1).default('qwen2.5-coder:3b'),
  /** Ollama base URL. */
  ollamaUrl: z.string().url().default('http://127.0.0.1:11434'),
  /**
   * Explicit consent gate for NON-loopback Ollama hosts (review R3): when
   * false (default), a remote summarize.ollamaUrl is refused - conversation
   * content never leaves the machine until the user actively allows it.
   */
  allowRemoteHost: z.boolean().default(false),
  /**
   * AiderDesk model id ('provider/model') for the cloud summarizer.
   * Empty string = use the task's current model (like built-in compact).
   */
  cloudModelId: z.string().default(''),
  /** Hard cap on the generated summary (chars) - also guards output tokens. */
  maxSummaryChars: z.number().int().positive().default(4000),
});
const summarizeDefault = SummarizeSchema.parse({});

const SliceSchema = z.object({
  /**
   * Master switch - OFF by default: ST-slicing rewrites what the agent sees
   * (and the stored tool result). Opt-in like every behavior-changing pass.
   */
  enabled: z.boolean().default(false),
  /** v1 ships only the heuristic parser; 'ast' is reserved for web-tree-sitter (v2). */
  parser: z.enum(['heuristic', 'ast']).default('heuristic'),
  /** Files smaller than this many chars always pass through untouched. */
  minChars: z.number().int().positive().default(4000),
  /** Cap for the generated interface view; larger views fall back to full content. */
  maxChars: z.number().int().positive().default(20000),
  /** Derive focus from edit-tool calls (and updated files) automatically. */
  focusAuto: z.boolean().default(true),
});
const sliceDefault = SliceSchema.parse({});

const SnapshotSchema = z.object({
  /**
   * Record a milestone snapshot on every successful commit (onAfterCommit).
   * Writing snapshots is additive - nothing in the task history changes.
   */
  onCommit: z.boolean().default(true),
  /** Detect test-green tool results as milestones - off: exit-0/`passed`
   *  heuristics misfire regularly on flaky suites. */
  onTestPass: z.boolean().default(false),
  /**
   * Also write the raw message array next to each auto/manual snapshot
   * record (the undo file). Default OFF (external review F-01): raw
   * histories can contain secrets and unmasked tool output - durable
   * plaintext copies are an explicit opt-in, not a side effect. The
   * destructive flush is governed separately by `flush.undo` (default ON),
   * since restoring a flush needs its raw history.
   */
  keepHistory: z.boolean().default(false),
});
const snapshotDefault = SnapshotSchema.parse({});

const FlushSchema = z.object({
  /**
   * The ONLY destructive operation in broke: /broke flush asks before
   * removing anything. --yes skips the question - deliberate foot-gun.
   */
  confirm: z.boolean().default(true),
  /**
   * Write the raw pre-flush message array as the undo file (enables
   * `/broke flush --undo`). Default ON: a destructive operation keeps its
   * safety net. Independent of `snapshot.keepHistory`, which only governs
   * the non-destructive auto/manual snapshots (review F-01).
   */
  undo: z.boolean().default(true),
});
const flushDefault = FlushSchema.parse({});

/**
 * F4 local project search. v1 ships the KEYWORD backend only - the enum
 * stays single-valued until vector/hybrid actually exist (honest config
 * surface over forward-declared dead options).
 */
const SearchSchema = z.object({
  /**
   * Default ON: registering the broke-search tool touches no stored history.
   * Honest tradeoff (documented in README): every registered tool ships its
   * JSON schema with each model call - keep off if every token counts.
   */
  enabled: z.boolean().default(true),
  backend: z.enum(['keyword']).default('keyword'),
  /** Top-k snippet results per query. */
  maxResults: z.number().int().min(1).max(50).default(8),
  /** TOTAL char budget across all results of one query - the token control. */
  maxChars: z.number().int().positive().default(6000),
  /** Context lines kept around each best-matching line. */
  contextLines: z.number().int().min(1).max(20).default(6),
  /** Files larger than this never enter the index. */
  maxFileKB: z.number().int().positive().default(512),
  /**
   * Opt-in (BRK-003, external review 2026-08-29): when true, git-ignored
   * files are indexed too. The dot-path and sensitive-basename filters stay
   * ON regardless - this flag only widens the git surface to the ignored
   * remainder, never to conventionally private files.
   */
  includeGitIgnored: z.boolean().default(false),
});
const searchDefault = SearchSchema.parse({});

const UiSchema = z.object({
  /** Show the 💸 saved-tokens badge in the task status bar. */
  showStatusBadge: z.boolean().default(true),
});
const uiDefault = UiSchema.parse({});

const StatsSchema = z.object({
  /**
   * Append one record per real compression run to measure.jsonl (taskId,
   * timestamps, input/output chars, per-pass removals). These per-run
   * records are what /broke measure and `npm run measure` analyze - the
   * provable real-session numbers. No paths, no content, rotation-capped
   * like stats.jsonl.
   */
  measure: z.boolean().default(true),
});
const statsDefault = StatsSchema.parse({});

export const ConfigSchema = z.object({
  /** Master switch - /broke off disables the whole pipeline. */
  enabled: z.boolean().default(true),
  /**
   * Compression depth:
   * - 'structural': content-preserving only (drop empties, dedupe, merge;
   *   textual content survives but message framing may change)
   * - 'truncate':   + lossy head/tail truncation of old tool outputs
   * - 'summarize':  + LLM summarization of old conversation turns
   */
  level: z.enum(['structural', 'truncate', 'summarize']).default('truncate'),
  /**
   * Estimated input size (in characters) above which the lossy passes
   * engage. chars/4 is a rough token heuristic - see docs/token-saving.md.
   * 60000 chars ≈ 15k tokens (below the built-in emergency threshold, so
   * broke acts first).
   */
  maxContextChars: z.number().int().positive().default(60000),
  /**
   * Never compress the last N user turns (the active working set).
   * Sessions with fewer turns fall back to protecting only the current
   * step - see ACTIVE_TURN_TAIL in compress.ts.
   */
  protectedTurns: z.number().int().min(1).max(50).default(2),
  truncate: TruncateSchema.default(truncateDefault),
  errors: ErrorsSchema.default(errorsDefault),
  slice: SliceSchema.default(sliceDefault),
  summarize: SummarizeSchema.default(summarizeDefault),
  ui: UiSchema.default(uiDefault),
  stats: StatsSchema.default(statsDefault),
  snapshot: SnapshotSchema.default(snapshotDefault),
  flush: FlushSchema.default(flushDefault),
  search: SearchSchema.default(searchDefault),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

/** Deep-merge plain objects (config fragments), then validate against the schema. */
export function mergeConfig(...parts: unknown[]): Config {
  const merged: Record<string, unknown> = {};
  for (const part of parts) {
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      for (const [key, value] of Object.entries(part as Record<string, unknown>)) {
        const prev = merged[key];
        if (value && typeof value === 'object' && !Array.isArray(value) && prev && typeof prev === 'object' && !Array.isArray(prev)) {
          merged[key] = { ...(prev as Record<string, unknown>), ...(value as Record<string, unknown>) };
        } else {
          merged[key] = value;
        }
      }
    }
  }
  return ConfigSchema.parse(merged);
}

let cachedConfig: Config | null = null;
let cachedConfigMtimeMs: number | null = null;
let configWarning: string | null = null;

/**
 * Why the last config load fell back to defaults, or null when the config
 * loaded cleanly (or was never loaded). Lets the extension surface a
 * corrupted config.json instead of silently running on defaults.
 */
export function getConfigWarning(): string | null {
  return configWarning;
}

/**
 * BRK-023 (external review 2026-08-29): a typo'd key (maxContexChars vs
 * maxContextChars) must not vanish silently - unknown keys are collected
 * with their FULL dotted path, reported, and stripped so the known values
 * around them still apply.
 */
function collectUnknownKeys(candidate: unknown, defaults: unknown, prefix = '', out: string[] = []): string[] {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return out;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    out.push(prefix);
    return out;
  }
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const defaultRecord = defaults as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(defaultRecord, key)) out.push(path);
    else collectUnknownKeys(value, defaultRecord[key], path, out);
  }
  return out;
}

/** Deep-remove the reported unknown keys so the parse still applies known values. */
function stripUnknownKeys(candidate: unknown, defaults: unknown): unknown {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return undefined;
  const out: Record<string, unknown> = {};
  const defaultRecord = defaults as Record<string, unknown>;
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(defaultRecord, key)) continue;
    out[key] = stripUnknownKeys(value, defaultRecord[key]);
  }
  return out;
}

/** Read + validate one config file (no cache). Corrupted files fall back to defaults. */
export function loadConfigFile(filePath: string): { config: Config; warning: string | null } {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    // BRK-023: a MISSING file is the normal first run, not an anomaly -
    // only unreadable/corrupted files warn.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { config: DEFAULT_CONFIG, warning: null };
    return {
      config: DEFAULT_CONFIG,
      warning: `config.json unreadable (${err instanceof Error ? err.message : String(err)}) - running on defaults`,
    };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const unknownKeys = collectUnknownKeys(parsed, DEFAULT_CONFIG);
    if (unknownKeys.length > 0) {
      const cleaned = stripUnknownKeys(parsed, DEFAULT_CONFIG);
      return {
        config: mergeConfig(cleaned),
        warning: `config.json contains unknown key(s): ${unknownKeys.join(', ')} - check for typos; they were ignored, all known keys still apply`,
      };
    }
    return { config: mergeConfig(parsed), warning: null };
  } catch (err) {
    return {
      config: DEFAULT_CONFIG,
      warning: `config.json unreadable (${err instanceof Error ? err.message : String(err)}) - running on defaults`,
    };
  }
}

/**
 * Cached config read (BRK-006 belt-and-braces): the cache is invalidated by
 * BOTH invalidateConfigCache() (watcher events) and the file's mtime, so an
 * externally edited config is picked up even when no watcher is running
 * (e.g. right after a failed update that closed it). A stat error keeps the
 * cached value - never worse than before.
 */
export function getConfig(): Config {
  if (cachedConfig) {
    try {
      const mtime = statSync(CONFIG_PATH).mtimeMs;
      if (mtime === cachedConfigMtimeMs) return cachedConfig;
    } catch {
      return cachedConfig; // transient stat failure - serve the cache
    }
  }
  const loaded = loadConfigFile(CONFIG_PATH);
  cachedConfig = loaded.config;
  configWarning = loaded.warning;
  try {
    cachedConfigMtimeMs = existsSync(CONFIG_PATH) ? statSync(CONFIG_PATH).mtimeMs : null;
  } catch {
    cachedConfigMtimeMs = null;
  }
  return cachedConfig;
}

export function invalidateConfigCache(): void {
  cachedConfig = null;
  cachedConfigMtimeMs = null;
  configWarning = null;
}

/**
 * Atomic write: temp file + fsync + rename, so a crash mid-write cannot
 * corrupt config.json and a power loss cannot leave the renamed file
 * empty (fsync flushes the data to disk before the rename).
 */
/**
 * Atomic write (BRK-010): UNIQUE temp file (pid + randomness) + file fsync +
 * rename + parent-directory fsync (POSIX), so a crash mid-write cannot
 * corrupt config.json, concurrent writers cannot collide on one temp name,
 * and a power loss cannot leave the renamed file empty. On failure the temp
 * file is cleaned up.
 */
export function saveConfig(config: Config, filePath: string = CONFIG_PATH): void {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    // mode 0o600 (POSIX): config can hold summarizer endpoints; owner-only is
    // the least-surprise default for sensitive local state (review R8).
    writeFileSync(tmpPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
    const fd = openSync(tmpPath, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // cleanup is best effort - the original error matters more
    }
    throw err;
  }
  // Parent-directory fsync (POSIX only - Windows cannot open directories):
  // makes the rename itself durable, completing the atomic-write contract.
  if (process.platform !== 'win32') {
    try {
      const dfd = openSync(dirname(filePath), 'r');
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // best effort - the file fsync above already bounds the damage
    }
  }
  if (filePath === CONFIG_PATH) invalidateConfigCache();
}

/** Apply dotted-path updates to a config WITHOUT touching the disk (pure). */
export function applyConfigUpdates(current: Config, updates: Array<[string, unknown]>): Config {
  const clone: Record<string, unknown> = {
    ...current,
    truncate: { ...current.truncate },
    errors: { ...current.errors },
    slice: { ...current.slice },
    summarize: { ...current.summarize },
    ui: { ...current.ui },
    stats: { ...current.stats },
    // Blocks added later need their clones too - without one, a dotted-path
    // update traverses the SHARED sub-object and mutates the caller's
    // previous config instance (found while wiring the search block).
    snapshot: { ...current.snapshot },
    flush: { ...current.flush },
    search: { ...current.search },
  };
  for (const [path, value] of updates) {
    const parts = path.split('.');
    let target: Record<string, unknown> = clone;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      const next = target[key];
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        target[key] = {};
      }
      target = target[key] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = value;
  }
  return ConfigSchema.parse(clone);
}

/**
 * Apply several dotted-path updates and persist them in ONE atomic write.
 * Multi-path commands (/broke truncate) must never leave a half-updated
 * config on disk when a write fails in between.
 */
export function updateConfigPaths(updates: Array<[string, unknown]>, filePath: string = CONFIG_PATH): Config {
  const current = loadConfigFile(filePath).config;
  const config = applyConfigUpdates(current, updates);
  saveConfig(config, filePath);
  return config;
}

/** Update a single dotted path (e.g. 'summarize.localModel') and persist. */
export function updateConfigPath(path: string, value: unknown, filePath: string = CONFIG_PATH): Config {
  return updateConfigPaths([[path, value]], filePath);
}
