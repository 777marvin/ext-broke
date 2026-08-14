import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const CONFIG_PATH = join(__dirname, 'config.json');

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
   * Per-message threshold (chars) — independent of maxContextChars: a 2k-line
   * test failure in a small conversation is exactly the case worth compressing.
   */
  minChars: z.number().int().positive().default(8000),
  /** Context lines kept around the failing line. */
  contextLines: z.number().int().min(1).max(30).default(8),
  /**
   * Rewrite tool results at the source (onToolFinished) instead of input-only.
   * Rewrites STORED history — keep off unless you want the summary persisted;
   * full outputs are archived under <extension>/errors/.
   */
  toolLevel: z.boolean().default(false),
});
const errorsDefault = ErrorsSchema.parse({});

const SummarizeSchema = z.object({
  /** Only summarize turns older than this many user turns. */
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
   * AiderDesk model id ('provider/model') for the cloud summarizer.
   * Empty string = use the task's current model (like built-in compact).
   */
  cloudModelId: z.string().default(''),
  /** Hard cap on the generated summary (chars) — also guards output tokens. */
  maxSummaryChars: z.number().int().positive().default(4000),
});
const summarizeDefault = SummarizeSchema.parse({});

const UiSchema = z.object({
  /** Show the 💸 saved-tokens badge in the task status bar. */
  showStatusBadge: z.boolean().default(true),
});
const uiDefault = UiSchema.parse({});

export const ConfigSchema = z.object({
  /** Master switch — /broke off disables the whole pipeline. */
  enabled: z.boolean().default(true),
  /**
   * Compression depth:
   * - 'structural': lossless only (drop empties, dedupe, merge)
   * - 'truncate':   + lossy head/tail truncation of old tool outputs
   * - 'summarize':  + LLM summarization of old conversation turns
   */
  level: z.enum(['structural', 'truncate', 'summarize']).default('truncate'),
  /**
   * Estimated input size (in characters) above which the lossy passes
   * engage. chars/4 is a rough token heuristic — see docs/token-saving.md.
   * 60000 chars ≈ 15k tokens (below the built-in emergency threshold, so
   * broke acts first).
   */
  maxContextChars: z.number().int().positive().default(60000),
  /**
   * Never compress the last N user turns (the active working set).
   * Sessions with fewer turns fall back to protecting only the current
   * step — see ACTIVE_TURN_TAIL in compress.ts.
   */
  protectedTurns: z.number().int().min(1).max(50).default(2),
  truncate: TruncateSchema.default(truncateDefault),
  errors: ErrorsSchema.default(errorsDefault),
  summarize: SummarizeSchema.default(summarizeDefault),
  ui: UiSchema.default(uiDefault),
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
let configWarning: string | null = null;

/**
 * Why the last config load fell back to defaults, or null when the config
 * loaded cleanly (or was never loaded). Lets the extension surface a
 * corrupted config.json instead of silently running on defaults.
 */
export function getConfigWarning(): string | null {
  return configWarning;
}

export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    cachedConfig = mergeConfig(JSON.parse(raw));
    configWarning = null;
  } catch (err) {
    cachedConfig = DEFAULT_CONFIG;
    configWarning = `config.json unreadable (${err instanceof Error ? err.message : String(err)}) — running on defaults`;
  }
  return cachedConfig;
}

export function invalidateConfigCache(): void {
  cachedConfig = null;
  configWarning = null;
}

/** Atomic write: temp file + rename, so a crash mid-write cannot corrupt config.json. */
export function saveConfig(config: Config): void {
  const tmpPath = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tmpPath, CONFIG_PATH);
  invalidateConfigCache();
}

/** Update a single dotted path (e.g. 'summarize.localModel') and persist. */
export function updateConfigPath(path: string, value: unknown): Config {
  const current = getConfig();
  const clone: Record<string, unknown> = {
    ...current,
    truncate: { ...current.truncate },
    errors: { ...current.errors },
    summarize: { ...current.summarize },
    ui: { ...current.ui },
  };
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
  const config = ConfigSchema.parse(clone);
  saveConfig(config);
  return config;
}
