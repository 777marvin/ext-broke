import type { Config } from './config';
import { DEFAULT_CONFIG, updateConfigPath, updateConfigPaths } from './config';
import { isPlaintextRemoteUrl, ollamaStatus } from './local';
import { formatUsd, priceLabel, savedCostUsd, type TaskModelPrice } from './pricing';
import { estimateTokens, type TaskStats, totalSavedChars } from './tokens';

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
  summarize via <local|cloud>   summarizer backend (default: ${d.summarize.via}${d.summarize.via === 'local' ? ' = Ollama' : ''})
  summarize model <name>        Ollama model tag (default: ${d.summarize.localModel})
  summarize cloud <provider/model>
                                AiderDesk model for cloud summaries ('' = task model)
  summarize after <turns>       summarize only turns older than n user turns (default ${d.summarize.afterTurns})
  stats                         per-pass saved chars/tokens for this task
  reset                         clear this task's stats
  selftest                      run the pipeline on synthetic input and log results
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
  | { kind: 'summarize-via'; via: 'local' | 'cloud' }
  | { kind: 'summarize-model'; model: string }
  | { kind: 'summarize-cloud'; modelId: string }
  | { kind: 'summarize-after'; turns: number }
  | { kind: 'stats' }
  | { kind: 'reset' }
  | { kind: 'selftest' }
  | { kind: 'help' }
  | { kind: 'unknown'; raw: string };

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
      const n = Number(rest[0]);
      if (Number.isFinite(n) && n > 0) return { kind: 'maxchars', value: Math.round(n) };
      return { kind: 'unknown', raw: args.join(' ') };
    }
    case 'protect': {
      const n = Number(rest[0]);
      if (Number.isFinite(n) && n >= 1 && n <= 50) return { kind: 'protect', value: Math.round(n) };
      return { kind: 'unknown', raw: args.join(' ') };
    }
    case 'truncate': {
      const lines = Number(rest[0]);
      const kb = Number(rest[1]);
      if (Number.isFinite(lines) && Number.isFinite(kb) && lines > 0 && kb > 0) {
        return { kind: 'truncate', lines: Math.round(lines), kb: Math.round(kb) };
      }
      return { kind: 'unknown', raw: args.join(' ') };
    }
    case 'errors': {
      const opt = rest[0];
      if (opt === 'on') return { kind: 'errors-toggle', enabled: true };
      if (opt === 'off') return { kind: 'errors-toggle', enabled: false };
      if (opt === 'minchars') {
        const n = Number(rest[1]);
        if (Number.isFinite(n) && n > 0) return { kind: 'errors-minchars', value: Math.round(n) };
      }
      if (opt === 'lines') {
        const n = Number(rest[1]);
        if (Number.isFinite(n) && n >= 1 && n <= 30) return { kind: 'errors-lines', value: Math.round(n) };
      }
      if (opt === 'toollevel') {
        const v = rest[1];
        if (v === 'on' || v === 'off') return { kind: 'errors-toollevel', enabled: v === 'on' };
      }
      return { kind: 'unknown', raw: args.join(' ') };
    }
    case 'summarize': {
      const opt = rest[0];
      const value = rest[1];
      if (opt === 'via' && (value === 'local' || value === 'cloud')) return { kind: 'summarize-via', via: value };
      if (opt === 'model' && value) return { kind: 'summarize-model', model: value };
      if (opt === 'cloud' && value) return { kind: 'summarize-cloud', modelId: value };
      if (opt === 'after') {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 2) return { kind: 'summarize-after', turns: Math.round(n) };
      }
      return { kind: 'unknown', raw: args.join(' ') };
    }
    case 'stats':
      return { kind: 'stats' };
    case 'reset':
      return { kind: 'reset' };
    case 'selftest':
      return { kind: 'selftest' };
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
      return { config: updateConfigPath('maxContextChars', cmd.value, filePath), message: `maxContextChars → ${cmd.value.toLocaleString()} chars (≈ ${estimateTokens(cmd.value).toLocaleString()} tokens)` };
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
      return { config: updateConfigPath('errors.minChars', cmd.value, filePath), message: `errors minChars → ${cmd.value.toLocaleString()} chars` };
    case 'errors-lines':
      return { config: updateConfigPath('errors.contextLines', cmd.value, filePath), message: `errors contextLines → ${cmd.value}` };
    case 'errors-toollevel':
      return { config: updateConfigPath('errors.toolLevel', cmd.enabled, filePath), message: `error tool-level rewriting ${cmd.enabled ? 'enabled' : 'disabled'} - rewrites stored history` };
    case 'summarize-via':
      return { config: updateConfigPath('summarize.via', cmd.via, filePath), message: `summarizer → ${cmd.via}` };
    case 'summarize-model':
      return { config: updateConfigPath('summarize.localModel', cmd.model, filePath), message: `local summarizer model → ${cmd.model}` };
    case 'summarize-cloud':
      return { config: updateConfigPath('summarize.cloudModelId', cmd.modelId, filePath), message: `cloud summarizer model → ${cmd.modelId || 'task model'}` };
    case 'summarize-after':
      return { config: updateConfigPath('summarize.afterTurns', cmd.turns, filePath), message: `summarize after → ${cmd.turns} turns` };
    default:
      return { config, message: '' };
  }
}

function fmtChars(chars: number): string {
  return `${chars.toLocaleString()} chars (≈ ${estimateTokens(chars).toLocaleString()} tokens)`;
}

/**
 * Human-readable stats block. `price` is the current task model price -
 * the money line is computed from it, so the saved $ is always the price
 * of the model the task is using right now.
 */
export function formatStats(config: Config, stats: TaskStats | null, price: TaskModelPrice | null | undefined = null): string {
  if (!stats) return 'No stats recorded for this task yet - send a message first.';
  const total = totalSavedChars(stats);
  const totalTokens = estimateTokens(total);
  const money = price ? formatUsd(savedCostUsd(totalTokens, price.inputPerMToken)) : null;
  const lines = [
    `broke stats - ${stats.passes} compression run(s)`,
    `  saved total:   ${fmtChars(total)}`,
    ...(money ? [`  estimated cost saved: ${money} (${priceLabel(price)})`] : []),
    `  structural:    ${fmtChars(stats.savedChars.structural)} (lossless)`,
    `  error:         ${fmtChars(stats.savedChars.error)} (stack-trace/log compression)`,
    `  truncate:      ${fmtChars(stats.savedChars.truncate)}`,
    `  summarize:     ${fmtChars(stats.savedChars.summarize)} (${stats.summarizedRanges} range(s), ${stats.summarizeFailures} failure(s))`,
    `  summarizer LLM calls: ${stats.summarizeCalls} (cache reuse not counted - true cost side)`,
    `  last summarizer: ${stats.lastSummarizer}`,
    `  level: ${config.level} | maxContextChars: ${config.maxContextChars.toLocaleString()} | protectedTurns: ${config.protectedTurns}`,
  ];
  return lines.join('\n');
}

/** Status output incl. Ollama reachability. */
export async function formatStatus(config: Config, stats: TaskStats | null, price?: TaskModelPrice | null): Promise<string> {
  const ollama = config.summarize.via === 'local' ? await ollamaStatus(config.summarize.ollamaUrl) : null;
  const lines = [
    `broke - ${config.enabled ? 'enabled' : 'DISABLED'} (level: ${config.level})`,
    `  maxContextChars: ${config.maxContextChars.toLocaleString()} chars | protectedTurns: ${config.protectedTurns}`,
    `  truncate limits: ${config.truncate.maxLines} lines / ${config.truncate.maxKB} KB | maxInputChars: ${config.truncate.maxInputChars}`,
    `  errors: ${config.errors.enabled ? 'on' : 'off'} | min ${config.errors.minChars.toLocaleString()} chars | ${config.errors.contextLines} context lines | tool-level: ${config.errors.toolLevel ? 'on' : 'off'}`,
    `  summarizer: ${config.summarize.via}${config.summarize.via === 'local' ? ` (model: ${config.summarize.localModel})` : ` (model: ${config.summarize.cloudModelId || 'task model'})`} | after ${config.summarize.afterTurns} turns | min ${config.summarize.minChars.toLocaleString()} chars`,
  ];
  if (ollama) {
    if (ollama.reachable) {
      const hasModel = ollama.models.includes(config.summarize.localModel) || ollama.models.some((m) => m.startsWith(config.summarize.localModel.split(':')[0]));
      lines.push(`  ollama ${ollama.version ? `v${ollama.version} ` : ''}reachable at ${config.summarize.ollamaUrl} - ${ollama.models.length} model(s) installed${hasModel ? '' : `, ${config.summarize.localModel} NOT found (run: ollama pull ${config.summarize.localModel})`}`);
    } else {
      lines.push(`  ollama NOT reachable at ${config.summarize.ollamaUrl} - local summarization is inactive (${ollama.error ?? 'unknown error'}). Start it with: ollama serve`);
    }
    if (isPlaintextRemoteUrl(config.summarize.ollamaUrl)) {
      lines.push('  ⚠ remote Ollama via plaintext http - conversation content is sent unencrypted. Prefer https:// or a local Ollama.');
    }
  }
  const statsBlock = formatStats(config, stats, price);
  if (statsBlock !== 'No stats recorded for this task yet - send a message first.') {
    lines.push('', statsBlock);
  }
  lines.push('', 'Defaults: ' + JSON.stringify({ level: DEFAULT_CONFIG.level, maxContextChars: DEFAULT_CONFIG.maxContextChars, protectedTurns: DEFAULT_CONFIG.protectedTurns, truncate: DEFAULT_CONFIG.truncate, summarize: { via: DEFAULT_CONFIG.summarize.via, localModel: DEFAULT_CONFIG.summarize.localModel } }));
  return lines.join('\n');
}
