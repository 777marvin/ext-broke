import type { Config } from './config';
import { DEFAULT_CONFIG, updateConfigPath, updateConfigPaths } from './config';
import { isPlaintextRemoteUrl, isRemoteOllamaHost, ollamaStatus } from './local';
import { normalizeTag } from './update';
import { formatUsd, priceLabel, savedCostUsd, type TaskModelPrice } from './pricing';
import { estimateTokens, type MeasureSummary, type TaskStats, totalSavedChars } from './tokens';

/**
 * Help text with the defaults interpolated from DEFAULT_CONFIG: hardcoded
 * numbers in help output drift from the schema the moment a default changes.
 */
function buildHelpText(d: Config): string {
  return `broke - token budget compression

Usage: /broke <subcommand>

  status                        config + current task stats + Ollama status
  on | off                      enable / disable the compression pipeline
  level <structural|truncate|summarize>
                                compression depth (default: truncate)
  maxchars <n>                  engage lossy passes above ~n chars (default ${d.maxContextChars})
  protect <turns>               never compress the last n user turns (default ${d.protectedTurns})
  truncate <lines> <kb>         old tool output limits (default ${d.truncate.maxLines} ${d.truncate.maxKB})
  errors on | off               compress compiler/test output (default: ${d.errors.enabled ? 'on' : 'off'})
  errors minchars <n>           compress matching outputs ≥ n chars (default ${d.errors.minChars})
  errors lines <n>              context lines kept around the failure (default ${d.errors.contextLines})
  errors toollevel <on|off>     rewrite stored history at tool level (default: ${d.errors.toolLevel ? 'on' : 'off'})
  errors archive <on|off>       save full outputs to errors/ (privacy: raw tool output stays on disk, default: ${d.errors.archive ? 'on' : 'off'})
  errors retention <days>       delete archived outputs older than n days (default ${d.errors.retentionDays})
  errors clear                  delete the whole error archive now
  slice on | off                interface views for file reads (default: ${d.slice.enabled ? 'on' : 'off'} - changes what the agent sees)
  slice focus <path>            always return this file in full (per task)
  slice focus clear             drop the explicit focus
  slice status                  slicing mode and current focus for this task
  summarize via <local|cloud>   summarizer backend (default: ${d.summarize.via}${d.summarize.via === 'local' ? ' = Ollama' : ''})
  summarize model <name>        Ollama model tag (default: ${d.summarize.localModel})
  summarize cloud <provider/model>
                                AiderDesk model for cloud summaries ('' = task model)
  summarize after <turns>       summarize only turns older than n user turns (default ${d.summarize.afterTurns})
  summarize allow-remote <on|off>
                                allow NON-loopback Ollama hosts (default: ${d.summarize.allowRemoteHost ? 'on' : 'off'} - conversation content stays on this machine)
  stats                         per-pass saved chars/tokens for this task
  why                           live gate-by-gate verdict: why does this task save 0 (or not)?
  measure                       summarize the per-run measurement ledger (measure.jsonl)
  measure on | off              record every compression run to measure.jsonl (default: ${d.stats.measure ? 'on' : 'off'})
  reset                         clear this task's stats
  selftest                      run the pipeline on synthetic input and log results
  update                        self-update from GitHub releases (installs the latest)
  update check                  only report whether a newer release exists
  update <vX.Y.Z>               install an exact tagged version (rollback path)
  help                          this text

All estimates use the chars/4 heuristic - honest numbers, not provider counts.`;
}

export const HELP_TEXT = buildHelpText(DEFAULT_CONFIG);

export type BrokeCommand =
  | { kind: 'status' }
  | { kind: 'toggle'; enabled: boolean }
  | { kind: 'level'; level: Config['level'] }
  | { kind: 'maxchars'; value: number }
  | { kind: 'protect'; value: number }
  | { kind: 'truncate'; lines: number; kb: number }
  | { kind: 'errors-toggle'; enabled: boolean }
  | { kind: 'errors-minchars'; value: number }
  | { kind: 'errors-lines'; value: number }
  | { kind: 'errors-toollevel'; enabled: boolean }
  | { kind: 'errors-archive'; enabled: boolean }
  | { kind: 'errors-retention'; days: number }
  | { kind: 'errors-clear' }
  | { kind: 'slice-toggle'; enabled: boolean }
  | { kind: 'slice-focus'; path: string }
  | { kind: 'slice-focus-clear' }
  | { kind: 'slice-status' }
  | { kind: 'summarize-via'; via: 'local' | 'cloud' }
  | { kind: 'summarize-model'; model: string }
  | { kind: 'summarize-cloud'; modelId: string }
  | { kind: 'summarize-after'; turns: number }
  | { kind: 'summarize-allow-remote'; enabled: boolean }
  | { kind: 'stats' }
  | { kind: 'why' }
  | { kind: 'measure' }
  | { kind: 'measure-toggle'; enabled: boolean }
  | { kind: 'reset' }
  | { kind: 'selftest' }
  | { kind: 'update'; mode: 'install' | 'check'; tag?: string }
  | { kind: 'help' }
  | { kind: 'unknown'; raw: string };

/**
 * CLI numbers are rounded to integers BEFORE validation: validating first
 * and rounding second lets 0.4 pass the check and become 0 afterwards - a
 * value the config schema rejects (XF8). Garbage maps to NaN, which every
 * bounds check below rejects.
 */
function roundArg(v: string | undefined): number {
  return Math.round(Number(v));
}

export function parseBrokeCommand(args: string[]): BrokeCommand {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case 'status':
      return { kind: 'status' };
    case 'on':
      return { kind: 'toggle', enabled: true };
    case 'off':
      return { kind: 'toggle', enabled: false };
    case 'level': {
      const level = rest[0];
      if (level === 'structural' || level === 'truncate' || level === 'summarize') {
        return { kind: 'level', level };
      }
      return { kind: 'unknown', raw: args.join(' ') };
    }
    case 'maxchars': {
      const n = roundArg(rest[0]);
      if (Number.isFinite(n) && n > 0) return { kind: 'maxchars', value: n };
      return { kind: 'unknown', raw: args.join(' ') };
    }
    case 'protect': {
      const n = roundArg(rest[0]);
      if (Number.isFinite(n) && n >= 1 && n <= 50) return { kind: 'protect', value: n };
      return { kind: 'unknown', raw: args.join(' ') };
    }
    case 'truncate': {
      const lines = roundArg(rest[0]);
      const kb = roundArg(rest[1]);
      if (Number.isFinite(lines) && Number.isFinite(kb) && lines > 0 && kb > 0) {
        return { kind: 'truncate', lines, kb };
      }
      return { kind: 'unknown', raw: args.join(' ') };
    }
    case 'errors': {
      const opt = rest[0];
      if (opt === 'on') return { kind: 'errors-toggle', enabled: true };
      if (opt === 'off') return { kind: 'errors-toggle', enabled: false };
      if (opt === 'minchars') {
        const n = roundArg(rest[1]);
        if (Number.isFinite(n) && n > 0) return { kind: 'errors-minchars', value: n };
      }
      if (opt === 'lines') {
        const n = roundArg(rest[1]);
        if (Number.isFinite(n) && n >= 1 && n <= 30) return { kind: 'errors-lines', value: n };
      }
      if (opt === 'toollevel') {
        const v = rest[1];
        if (v === 'on' || v === 'off') return { kind: 'errors-toollevel', enabled: v === 'on' };
      }
      if (opt === 'archive') {
        const v = rest[1];
        if (v === 'on' || v === 'off') return { kind: 'errors-archive', enabled: v === 'on' };
      }
      if (opt === 'retention') {
        const n = roundArg(rest[1]);
        if (Number.isFinite(n) && n >= 1 && n <= 365) return { kind: 'errors-retention', days: n };
      }
      if (opt === 'clear') return { kind: 'errors-clear' };
      return { kind: 'unknown', raw: args.join(' ') };
    }
    case 'slice': {
      const opt = rest[0];
      if (opt === 'on') return { kind: 'slice-toggle', enabled: true };
      if (opt === 'off') return { kind: 'slice-toggle', enabled: false };
      if (opt === 'focus' && rest[1] === 'clear' && rest.length === 2) return { kind: 'slice-focus-clear' };
      // A focus path may contain spaces - everything after 'focus' is one path.
      if (opt === 'focus' && rest.length >= 2) return { kind: 'slice-focus', path: rest.slice(1).join(' ') };
      if (opt === 'status' && rest.length === 1) return { kind: 'slice-status' };
      return { kind: 'unknown', raw: args.join(' ') };
    }
    case 'summarize': {
      const opt = rest[0];
      const value = rest[1];
      if (opt === 'via' && (value === 'local' || value === 'cloud')) return { kind: 'summarize-via', via: value };
      if (opt === 'model' && value) return { kind: 'summarize-model', model: value };
      if (opt === 'cloud' && value) return { kind: 'summarize-cloud', modelId: value };
      if (opt === 'after') {
        const n = roundArg(value);
        if (Number.isFinite(n) && n >= 2) return { kind: 'summarize-after', turns: n };
      }
      if (opt === 'allow-remote' && (value === 'on' || value === 'off') && rest.length === 2) {
        return { kind: 'summarize-allow-remote', enabled: value === 'on' };
      }
      return { kind: 'unknown', raw: args.join(' ') };
    }
    case 'stats':
      return { kind: 'stats' };
    case 'why':
      return { kind: 'why' };
    case 'measure': {
      const opt = rest[0];
      if (opt === 'on') return { kind: 'measure-toggle', enabled: true };
      if (opt === 'off') return { kind: 'measure-toggle', enabled: false };
      if (opt === undefined) return { kind: 'measure' };
      return { kind: 'unknown', raw: args.join(' ') };
    }
    case 'reset':
      return { kind: 'reset' };
    case 'selftest':
      return { kind: 'selftest' };
    case 'update': {
      const arg = rest[0];
      const tag = arg === undefined ? null : normalizeTag(arg);
      // Exactly one argument max - anything else is a typo, not an update.
      if (arg === undefined && rest.length === 0) return { kind: 'update', mode: 'install' };
      if (arg === 'check' && rest.length === 1) return { kind: 'update', mode: 'check' };
      if (rest.length === 1 && tag) return { kind: 'update', mode: 'install', tag };
      return { kind: 'unknown', raw: args.join(' ') };
    }
    case 'help':
      return { kind: 'help' };
    default:
      return { kind: 'unknown', raw: args.join(' ') };
  }
}

/**
 * Apply a parsed command to the config; returns the new config and a
 * human-readable confirmation. `filePath` defaults to the real config.json
 * and exists so tests can run against a temp file.
 */
export function applyBrokeCommand(cmd: BrokeCommand, config: Config, filePath?: string): { config: Config; message: string } {
  switch (cmd.kind) {
    case 'toggle':
      return { config: updateConfigPath('enabled', cmd.enabled, filePath), message: `broke ${cmd.enabled ? 'enabled' : 'disabled'}` };
    case 'level':
      return { config: updateConfigPath('level', cmd.level, filePath), message: `level → ${cmd.level}` };
    case 'maxchars':
      return { config: updateConfigPath('maxContextChars', cmd.value, filePath), message: `maxContextChars → ${cmd.value.toLocaleString('en-US')} chars (≈ ${estimateTokens(cmd.value).toLocaleString('en-US')} tokens)` };
    case 'protect':
      return { config: updateConfigPath('protectedTurns', cmd.value, filePath), message: `protectedTurns → ${cmd.value}` };
    case 'truncate':
      // One atomic write for both limits: two consecutive writes could leave
      // a half-updated config if the first succeeds and the second fails.
      return {
        config: updateConfigPaths(
          [
            ['truncate.maxLines', cmd.lines],
            ['truncate.maxKB', cmd.kb],
          ],
          filePath,
        ),
        message: `truncate limits → ${cmd.lines} lines / ${cmd.kb} KB`,
      };
    case 'errors-toggle':
      return { config: updateConfigPath('errors.enabled', cmd.enabled, filePath), message: `error compression ${cmd.enabled ? 'enabled' : 'disabled'}` };
    case 'errors-minchars':
      return { config: updateConfigPath('errors.minChars', cmd.value, filePath), message: `errors minChars → ${cmd.value.toLocaleString('en-US')} chars` };
    case 'errors-lines':
      return { config: updateConfigPath('errors.contextLines', cmd.value, filePath), message: `errors contextLines → ${cmd.value}` };
    case 'errors-toollevel':
      return { config: updateConfigPath('errors.toolLevel', cmd.enabled, filePath), message: `error tool-level rewriting ${cmd.enabled ? 'enabled' : 'disabled'} - rewrites STORED history irreversibly` };
    case 'errors-archive':
      return {
        config: updateConfigPath('errors.archive', cmd.enabled, filePath),
        message: cmd.enabled
          ? `error archive enabled - full tool outputs are stored locally under errors/ (redacted best effort)`
          : `error archive disabled - full outputs are no longer saved, summaries say "full output removed"`,
      };
    case 'errors-retention':
      return { config: updateConfigPath('errors.retentionDays', cmd.days, filePath), message: `error archive retention → ${cmd.days} day(s)` };
    case 'errors-clear':
      // Side effect handled in index.ts (deletes the archive directory).
      return { config, message: '' };
    case 'slice-toggle':
      return {
        config: updateConfigPath('slice.enabled', cmd.enabled, filePath),
        message: cmd.enabled
          ? 'ST-slicing enabled - file reads return interface views (focus file stays full). NOTE: rewrites land in STORED task history and cannot be undone by disabling slicing later.'
          : 'ST-slicing disabled - file reads pass through untouched (already-stored views stay sliced)',
      };
    case 'slice-focus':
    case 'slice-focus-clear':
    case 'slice-status':
      // Side effects handled in index.ts (task-scoped focus state / live status).
      return { config, message: '' };
    case 'summarize-via':
      return { config: updateConfigPath('summarize.via', cmd.via, filePath), message: `summarizer → ${cmd.via}` };
    case 'summarize-model':
      return { config: updateConfigPath('summarize.localModel', cmd.model, filePath), message: `local summarizer model → ${cmd.model}` };
    case 'summarize-cloud':
      return { config: updateConfigPath('summarize.cloudModelId', cmd.modelId, filePath), message: `cloud summarizer model → ${cmd.modelId || 'task model'}` };
    case 'summarize-after':
      return { config: updateConfigPath('summarize.afterTurns', cmd.turns, filePath), message: `summarize after → ${cmd.turns} turns` };
    case 'summarize-allow-remote':
      return {
        config: updateConfigPath('summarize.allowRemoteHost', cmd.enabled, filePath),
        message: cmd.enabled
          ? 'remote summarizer host ALLOWED - conversation content (incl. tool outputs) may be sent to another machine'
          : 'remote summarizer host blocked - conversation content stays on this machine',
      };
    case 'measure-toggle':
      return {
        config: updateConfigPath('stats.measure', cmd.enabled, filePath),
        message: `per-run measurement ${cmd.enabled ? 'enabled' : 'disabled'} (records go to measure.jsonl)`,
      };
    default:
      return { config, message: '' };
  }
}

function fmtChars(chars: number): string {
  return `${chars.toLocaleString('en-US')} chars (≈ ${estimateTokens(chars).toLocaleString('en-US')} tokens)`;
}

/**
 * True when the configured local model is actually installed. Exact tag
 * match wins; a base-name (no tag) config matches any tag of that model.
 * A TAG config never matches other tags: `qwen2.5-coder:3b` configured
 * with only `:7b` installed must report NOT found, not a false positive.
 */
export function hasOllamaModel(models: string[], configured: string): boolean {
  if (models.includes(configured)) return true;
  if (configured.includes(':')) return false;
  return models.some((m) => m.startsWith(`${configured}:`));
}

/**
 * Human-readable stats block. `price` is the current task model price -
 * the money line is computed from it, so the saved $ is always the price
 * of the model the task is using right now.
 */
export function formatStats(config: Config, stats: TaskStats | null, price: TaskModelPrice | null | undefined = null): string {
  if (!stats) return 'No stats recorded for this task yet - send a message first.';
  // XF14: the headline is the MEASURED reduction (per-run input before
  // minus after, summed). The per-pass sum can diverge from it (passes
  // overlap, marker overhead) and is shown only as the breakdown. Legacy
  // records without size data fall back to the pass sum, labeled as such.
  const measured = stats.totalCharsBefore > 0 ? Math.max(stats.totalCharsBefore - stats.totalCharsAfter, 0) : null;
  const passSum = totalSavedChars(stats);
  const total = measured ?? passSum;
  const totalTokens = estimateTokens(total);
  // Money is only shown when a REAL input price is known: "$0.00" for a
  // local or unregistered model would read as "free" when the truth is
  // "unknown". Same policy as the compression log line and the badge.
  const money = price?.inputPerMToken ? formatUsd(savedCostUsd(totalTokens, price.inputPerMToken)) : null;
  const lines = [
    `broke stats - ${stats.passes} compression run(s)`,
    measured !== null
      ? `  saved actual:   ${fmtChars(measured)} (measured: per-run input before - after, summed)`
      : `  saved total:    ${fmtChars(passSum)} (pass-sum - records predate size measurement)`,
    ...(money ? [`  estimated cost saved: ${money} (${priceLabel(price)})`] : []),
    `  structural:    ${fmtChars(stats.savedChars.structural)} (content-preserving)`,
    `  error:         ${fmtChars(stats.savedChars.error)} (stack-trace/log compression)`,
    `  truncate:      ${fmtChars(stats.savedChars.truncate)}`,
    `  summarize:     ${fmtChars(stats.savedChars.summarize)} (${stats.summarizedRanges} range(s), ${stats.summarizeFailures} failure(s))`,
    ...(stats.savedChars.slice > 0
      ? [`  slice:         ${fmtChars(stats.savedChars.slice)} (ST-slicing, estimated full-file vs. interface view)`]
      : []),
    `  summarizer LLM calls: ${stats.summarizeCalls} (cache reuse not counted - true cost side)`,
    `  last summarizer: ${stats.lastSummarizer}`,
    `  level: ${config.level} | maxContextChars: ${config.maxContextChars.toLocaleString('en-US')} | protectedTurns: ${config.protectedTurns}`,
  ];
  return lines.join('\n');
}

/**
 * Human-readable measurement summary. Honest framing: the totals sum input
 * sizes PER RUN, and the same region of one conversation is compressed again
 * on every model call - so the sum is NOT a cumulative context claim, and we
 * say so in the output.
 */
export function formatMeasure(summary: MeasureSummary | null): string {
  if (!summary) {
    return (
      'broke measure - no measurement records yet.\n' +
      'broke records one line per compression run to measure.jsonl (config: stats.measure).\n' +
      'Record while working with /broke measure on, then run /broke measure again (or npm run measure).'
    );
  }
  const spanDays = Math.round((summary.spanMs / 86_400_000) * 10) / 10;
  const reduction =
    summary.charsBefore > 0 ? Math.round(((summary.charsBefore - summary.charsAfter) / summary.charsBefore) * 1000) / 10 : 0;
  const lines = [
    `broke measure - ${summary.runs} run(s) across ${summary.tasks} task(s)${summary.spanMs > 0 ? ` over ${spanDays} day(s)` : ''}`,
    `  input per run:   ${fmtChars(summary.charsBefore)} (sum over runs - the same conversation is compressed on every model call, NOT a cumulative context claim)`,
    `  output per run:  ${fmtChars(summary.charsAfter)} (${reduction}% smaller on average across runs)`,
    `  saved total:     ${fmtChars(summary.savedChars)}`,
    `  saved per run:   mean ${fmtChars(summary.meanSavedCharsPerRun)} | median ${fmtChars(summary.medianSavedCharsPerRun)} | max ${fmtChars(summary.maxSavedCharsPerRun)}`,
    `  summarizer calls: ${summary.summarizeCalls} (true cost side - cache reuse not counted)`,
  ];
  if (summary.byTask.length > 0) {
    lines.push('  per task:');
    for (const t of summary.byTask.slice(0, 5)) {
      lines.push(`    ${t.taskId}: ${t.runs} run(s), ${fmtChars(t.savedChars)}`);
    }
    if (summary.byTask.length > 5) {
      lines.push(`    ... and ${summary.byTask.length - 5} more task(s)`);
    }
  }
  return lines.join('\n');
}

/** Status output incl. Ollama reachability. */
export async function formatStatus(config: Config, stats: TaskStats | null, price?: TaskModelPrice | null): Promise<string> {
  const ollama = config.summarize.via === 'local' ? await ollamaStatus(config.summarize.ollamaUrl) : null;
  const lines = [
    `broke - ${config.enabled ? 'enabled' : 'DISABLED'} (level: ${config.level})`,
    `  maxContextChars: ${config.maxContextChars.toLocaleString('en-US')} chars | protectedTurns: ${config.protectedTurns}`,
    `  truncate limits: ${config.truncate.maxLines} lines / ${config.truncate.maxKB} KB | maxInputChars: ${config.truncate.maxInputChars}`,
    `  errors: ${config.errors.enabled ? 'on' : 'off'} | min ${config.errors.minChars.toLocaleString('en-US')} chars | ${config.errors.contextLines} context lines | tool-level: ${config.errors.toolLevel ? 'on' : 'off'} | archive: ${config.errors.archive ? 'on' : 'off'} (${config.errors.retentionDays} d retention)`,
    `  slice: ${config.slice.enabled ? 'on' : 'off'} | parser: ${config.slice.parser} | min ${config.slice.minChars.toLocaleString('en-US')} chars | view cap ${config.slice.maxChars.toLocaleString('en-US')} chars | focusAuto: ${config.slice.focusAuto ? 'on' : 'off'}`,
    `  summarizer: ${config.summarize.via}${config.summarize.via === 'local' ? ` (model: ${config.summarize.localModel})` : ` (model: ${config.summarize.cloudModelId || 'task model'})`} | after ${config.summarize.afterTurns} turns | min ${config.summarize.minChars.toLocaleString('en-US')} chars`,
  ];
  if (ollama) {
    if (ollama.reachable) {
      const hasModel = hasOllamaModel(ollama.models, config.summarize.localModel);
      lines.push(`  ollama ${ollama.version ? `v${ollama.version} ` : ''}reachable at ${config.summarize.ollamaUrl} - ${ollama.models.length} model(s) installed${hasModel ? '' : `, ${config.summarize.localModel} NOT found (run: ollama pull ${config.summarize.localModel})`}`);
    } else {
      lines.push(`  ollama NOT reachable at ${config.summarize.ollamaUrl} - local summarization is inactive (${ollama.error ?? 'unknown error'}). Start it with: ollama serve`);
    }
    if (isPlaintextRemoteUrl(config.summarize.ollamaUrl)) {
      lines.push('  ⚠ remote Ollama via plaintext http - conversation content is sent unencrypted. Prefer https:// or a local Ollama.');
    }
    if (isRemoteOllamaHost(config.summarize.ollamaUrl) && !config.summarize.allowRemoteHost) {
      lines.push('  ⛔ remote summarizer host is BLOCKED - conversation content never leaves this machine until you run /broke summarize allow-remote on.');
    }
  }
  const statsBlock = formatStats(config, stats, price);
  if (statsBlock !== 'No stats recorded for this task yet - send a message first.') {
    lines.push('', statsBlock);
  }
  lines.push('', 'Defaults: ' + JSON.stringify({ level: DEFAULT_CONFIG.level, maxContextChars: DEFAULT_CONFIG.maxContextChars, protectedTurns: DEFAULT_CONFIG.protectedTurns, truncate: DEFAULT_CONFIG.truncate, summarize: { via: DEFAULT_CONFIG.summarize.via, localModel: DEFAULT_CONFIG.summarize.localModel } }));
  return lines.join('\n');
}
