import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  CommandDefinition,
  Extension,
  ExtensionContext,
  OptimizeMessagesEvent,
  TaskInitializedEvent,
  ToolFinishedEvent,
  UIComponentDefinition,
} from '@aiderdesk/extensions';
import { applyBrokeCommand, formatStats, formatStatus, HELP_TEXT, parseBrokeCommand } from './commands';
import {
  compressMessages,
  createCompressState,
  maskSecrets,
  type CompressReport,
  type CompressState,
  type SummarizeDeps,
} from './compress';
import { ConfigSchema, CONFIG_PATH, getConfig, getConfigWarning, invalidateConfigCache, saveConfig, type Config } from './config';
import { extractErrorSummary, formatErrorSummary, isCommandTool, saveErrorOutput } from './errors';
import { isPlaintextRemoteUrl, ollamaGenerate, ollamaStatus, type OllamaStatus } from './local';
import { formatUsd, priceLabel, resolveTaskModelPrice, savedCostUsd, type TaskModelPrice } from './pricing';
import { runSelfTest } from './selftest';
import { clearTaskStats, emptyStats, estimateTokens, loadTaskStats, persistStats, totalSavedChars, type TaskStats } from './tokens';
import { boundedMapSet } from './compress';

// Load the JSX templates once at module level (official template pattern).
// A missing template must not prevent the extension from loading at all.
function loadTemplate(path: string): string {
  try {
    return readFileSync(join(__dirname, path), 'utf-8');
  } catch {
    return '';
  }
}
const configComponentJsx = loadTemplate('./ConfigComponent.jsx');
const statusBadgeJsx = loadTemplate('./StatusBadge.jsx');

/** Stable component ids for the UI elements. */
const STATUS_BADGE_ID = 'broke-status';

/** Only log compression activity every this many ms per task (chat noise control). */
const LOG_THROTTLE_MS = 5 * 60 * 1000;
/** Only log when at least this many chars were saved by a run (4000 chars ≈ 1000 tokens). */
const LOG_MIN_SAVED_CHARS = 4000;
/** Auto-disable summarization for a task after this many consecutive failures. */
const MAX_SUMMARIZE_FAILURES = 3;
/** How long the badge may reuse the last Ollama status check (short: UI must stay honest). */
const OLLAMA_STATUS_TTL_MS = 30_000;

interface ToolResultText {
  text: string;
  /** Rebuild a full output value of the same shape from the rewritten text. */
  wrap: (text: string) => unknown;
}

/**
 * Extract plain text from a tool result output (string or content[] shapes)
 * and return a wrapper that rebuilds the original shape. Returns null for
 * non-text outputs (images, structured payloads) - those are never rewritten.
 * Same shape handling as savemytoken's truncate (verified against the
 * installed AiderDesk 0.77.x runtime).
 */
function extractToolResultText(output: unknown): ToolResultText | null {
  if (typeof output === 'string') {
    return { text: output, wrap: (t) => t };
  }
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    const content = record.content;
    if (Array.isArray(content) && content.length > 0) {
      const textParts = content.filter(
        (part): part is { type: 'text'; text: string } =>
          !!part && typeof part === 'object' && (part as { type?: string }).type === 'text' && typeof (part as { text?: unknown }).text === 'string',
      );
      if (textParts.length === content.length) {
        const text = textParts.map((p) => p.text ?? '').join('\n');
        return {
          text,
          wrap: (t) => ({ ...(output as object), content: [{ type: 'text' as const, text: t }] }),
        };
      }
    }
    // Structured command output (power---bash etc.): { stdout, stderr, exitCode }.
    // The error compressor must see stdout/stderr, not skip the payload.
    const stdout = typeof record.stdout === 'string' ? record.stdout : '';
    const stderr = typeof record.stderr === 'string' ? record.stderr : '';
    if (stdout || stderr) {
      const text = stderr ? `${stdout}\n${stderr}` : stdout;
      return {
        text,
        wrap: (t) => ({ ...record, stdout: t, stderr: '' }),
      };
    }
  }
  return null;
}

export default class Broke implements Extension {
  static metadata = {
    name: 'Broke',
    version: '0.3.0',
    description:
      'Token budget extension: progressive input compression (structural + truncate + summarize) with local-model (Ollama) summarization offload',
    author: '777marvin',
    capabilities: ['commands', 'ui-elements'],
  };

  private context: ExtensionContext | null = null;
  private configWatcher: FSWatcher | null = null;
  private readonly state: CompressState = createCompressState();
  private readonly statsByTask = new Map<string, TaskStats>();
  private readonly lastLogAt = new Map<string, number>();
  private readonly summarizeFailures = new Map<string, number>();
  /** Tasks whose summarize pass is auto-disabled after repeated failures. */
  private readonly summarizeDisabled = new Map<string, true>();
  private ollamaStatusCache: { at: number; status: OllamaStatus } | null = null;

  onLoad(context: ExtensionContext): void {
    this.context = context;
    const config = getConfig();
    context.log(
      `Broke loaded - level: ${config.level}, maxContextChars: ${config.maxContextChars.toLocaleString()}, summarizer: ${config.summarize.via}${config.summarize.via === 'local' ? ` (${config.summarize.localModel})` : ''}`,
      'info',
    );
    const warning = getConfigWarning();
    if (warning) {
      context.log(`Broke: ${warning}`, 'warn');
    }
    if (isPlaintextRemoteUrl(config.summarize.ollamaUrl)) {
      context.log(
        `Broke: WARNING - summarizer URL ${config.summarize.ollamaUrl} uses plaintext HTTP to a remote host; conversation content (incl. tool outputs) will be sent unencrypted. Prefer https:// or a local Ollama.`,
        'warn',
      );
    }
    // Reflect config changes made outside the settings dialog immediately.
    try {
      this.configWatcher = watch(dirname(CONFIG_PATH), (_event, filename) => {
        if (filename === 'config.json') {
          invalidateConfigCache();
          this.refreshUI();
        }
      });
      this.configWatcher.on('error', () => {
        this.configWatcher?.close();
        this.configWatcher = null;
      });
    } catch {
      // best effort - getConfig() still picks up changes within its TTL
    }
  }

  async onUnload(): Promise<void> {
    this.configWatcher?.close();
    this.configWatcher = null;
  }

  // -------------------------------------------------------------------------
  // The core: compress the messages that are about to be sent to the model.
  // Runs before EVERY model call (not only at the built-in emergency
  // threshold), which is what makes the input compression "permanent": every
  // input the model sees is already compressed.
  // -------------------------------------------------------------------------
  async onOptimizeMessages(event: OptimizeMessagesEvent, context: ExtensionContext): Promise<Partial<OptimizeMessagesEvent> | void> {
    const config = getConfig();
    if (!config.enabled) return;

    const task = context.getTaskContext();
    if (!task) return;
    const taskId = task.data.id;

    const deps: SummarizeDeps = {
      generateLocal: async (model, prompt) => {
        const result = await ollamaGenerate(config.summarize.ollamaUrl, model, prompt, 800);
        return result.ok ? result.text : undefined;
      },
      generateCloud: async (systemPrompt, prompt) => {
        const modelId = config.summarize.cloudModelId || `${task.data.provider}/${task.data.model ?? task.data.mainModel}`;
        // Cost guards: the summarizer input is capped in summarizePass
        // (MAX_SUMMARIZER_INPUT_CHARS) and the result is truncated to
        // maxSummaryChars afterwards. generateText offers no max-output
        // token option, so those two caps are the whole budget.
        return task.generateText(modelId, systemPrompt, prompt);
      },
    };

    try {
      const { messages, report } = await compressMessages(event.optimizedMessages, config, deps, this.state, taskId, {
        summarizeDisabled: this.summarizeDisabled.get(taskId) === true,
      });
      // Price lookup only when something was actually compressed (it is
      // cached afterwards; the badge warms it on task open).
      const price = report.touched ? await resolveTaskModelPrice(context) : null;
      this.recordReport(taskId, report, price);
      if (report.touched) {
        this.refreshUI();
      }
      if (messages !== event.optimizedMessages) {
        return { optimizedMessages: messages };
      }
    } catch (err) {
      // Never break the model call - compression is best effort.
      context.log(`Broke: compression failed - ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /**
   * Tool-level error compression (errors.toolLevel = on). Rewrites the
   * stored tool result in the task history to its diagnostic essence and
   * archives the full output under <extension>/errors/. Off by default -
   * unlike the input pass this touches stored history, so the user must
   * opt in explicitly. Never throws; never breaks tool execution.
   */
  async onToolFinished(event: ToolFinishedEvent, context: ExtensionContext): Promise<Partial<ToolFinishedEvent> | void> {
    const config = getConfig();
    if (!config.enabled || !config.errors.enabled || !config.errors.toolLevel) return;
    if (!isCommandTool(event.toolName)) return;

    const task = context.getTaskContext();
    if (!task) return;
    const taskId = task.data.id;

    try {
      const extractedText = extractToolResultText(event.output);
      if (!extractedText) return;
      const { text, wrap } = extractedText;
      if (text.length < config.errors.minChars) return;

      // Redact secrets BEFORE archiving and BEFORE extraction: neither the
      // archive file nor the summary in the conversation may leak tokens/keys.
      const redacted = maskSecrets(text);
      const extracted = extractErrorSummary(redacted, { contextLines: config.errors.contextLines });
      if (!extracted.matched) return;

      const savedPath = saveErrorOutput(taskId, event.toolCallId || event.toolName, redacted);
      const suffix = savedPath ? ` - full output saved to ${savedPath}` : ' - full output removed';
      return { output: wrap(formatErrorSummary(extracted, suffix)) };
    } catch (err) {
      // Never break tool execution - compression is best effort.
      context.log(`Broke: tool-level error compression failed - ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  private recordReport(taskId: string, report: CompressReport, price: TaskModelPrice | null): void {
    const stats = this.statsByTask.get(taskId) ?? loadTaskStats(taskId) ?? emptyStats(taskId);
    stats.passes += 1;
    stats.savedChars.structural += report.structuralChars;
    stats.savedChars.error += report.errorChars;
    stats.savedChars.truncate += report.truncateChars;
    stats.savedChars.summarize += report.summarizeChars;
    stats.summarizedRanges += report.summarizedRanges;
    stats.summarizeCalls += report.summarizeCalls;
    if (report.summarizeFailed) {
      stats.summarizeFailures += 1;
      const failures = (this.summarizeFailures.get(taskId) ?? 0) + 1;
      boundedMapSet(this.summarizeFailures, taskId, failures);
      if (failures >= MAX_SUMMARIZE_FAILURES) {
        this.summarizeFailures.delete(taskId);
        // Real disable: the gate is passed to compressMessages on every
        // model call so the summarizer is not retried (each retry costs a
        // full REQUEST_TIMEOUT_MS when Ollama is down).
        boundedMapSet(this.summarizeDisabled, taskId, true);
        this.state.cachedSummaryByTask.delete(taskId);
        void this.context
          ?.getTaskContext()
          ?.addLogMessage(
            'warning',
            `broke: summarization failed ${failures}× in a row - disabled for this task. Check the Ollama status with /broke status (or switch via /broke summarize via cloud).`,
          );
        boundedMapSet(this.lastLogAt, taskId, Date.now());
      }
    } else if (report.summarizer !== 'none') {
      // Only a REAL summarize run resets the failure state - a skipped pass
      // (gate active) reports summarizeFailed=false too and must never
      // re-enable summarization (that would toggle the gate every call).
      this.summarizeFailures.delete(taskId);
      this.summarizeDisabled.delete(taskId);
    }
    if (report.summarizer !== 'none') {
      stats.lastSummarizer = report.summarizer;
    }
    stats.lastRunAt = Date.now();
    boundedMapSet(this.statsByTask, taskId, stats);
    persistStats(stats);

    const savedChars = report.structuralChars + report.errorChars + report.truncateChars + report.summarizeChars;
    const lastLog = this.lastLogAt.get(taskId) ?? 0;
    if (savedChars >= LOG_MIN_SAVED_CHARS && Date.now() - lastLog > LOG_THROTTLE_MS) {
      boundedMapSet(this.lastLogAt, taskId, Date.now());
      const parts = [
        report.structuralChars > 0 ? `structural ${estimateTokens(report.structuralChars)}` : '',
        report.errorChars > 0 ? `error ${estimateTokens(report.errorChars)}` : '',
        report.truncateChars > 0 ? `truncate ${estimateTokens(report.truncateChars)}` : '',
        report.summarizeChars > 0 ? `summarize ${estimateTokens(report.summarizeChars)} (${report.summarizer})` : '',
      ].filter(Boolean);
      // Money line uses the CURRENT task model price (never a stored one).
      // Local/free models have no price - tokens only, no fake $0.00.
      const tokens = estimateTokens(savedChars);
      const money = price?.inputPerMToken ? ` ≈ ${formatUsd(savedCostUsd(tokens, price.inputPerMToken))} at current task model price` : '';
      void this.context
        ?.getTaskContext()
        ?.addLogMessage('info', `💸 broke: compressed input - saved ≈ ${tokens.toLocaleString()} tokens${money} (${parts.join(', ')})`);
    }
  }

  /** Cached Ollama reachability for the badge (30 s TTL, 3 s check timeout). */
  private async cachedOllamaStatus(config: Config): Promise<OllamaStatus | null> {
    if (config.summarize.via !== 'local') return null;
    if (this.ollamaStatusCache && Date.now() - this.ollamaStatusCache.at < OLLAMA_STATUS_TTL_MS) {
      return this.ollamaStatusCache.status;
    }
    const status = await ollamaStatus(config.summarize.ollamaUrl);
    this.ollamaStatusCache = { at: Date.now(), status };
    return status;
  }

  // Visibility: tell the user the extension is active on every new task.
  async onTaskInitialized(event: TaskInitializedEvent, context: ExtensionContext): Promise<void> {
    const config = getConfig();
    // Status checks use a short timeout (3 s) so a dead remote Ollama never
    // blocks task initialization.
    const ollama = config.summarize.via === 'local' ? await ollamaStatus(config.summarize.ollamaUrl) : null;
    if (ollama) this.ollamaStatusCache = { at: Date.now(), status: ollama };
    const ollamaNote =
      config.summarize.via === 'local'
        ? ollama?.reachable
          ? `ollama reachable (${ollama.models.length} models)`
          : `ollama NOT reachable - local summaries inactive (ollama serve)`
        : `cloud summarizer (${config.summarize.cloudModelId || 'task model'})`;
    const remotePlaintext = config.summarize.via === 'local' && isPlaintextRemoteUrl(config.summarize.ollamaUrl);
    await context
      .getTaskContext()
      ?.addLogMessage(
        'info',
        `broke active - level: ${config.level}, threshold: ${config.maxContextChars.toLocaleString()} chars, protectedTurns: ${config.protectedTurns}, ${ollamaNote}${remotePlaintext ? ' - WARNING: remote Ollama via plaintext http, data is sent unencrypted' : ''} - /broke help lists all commands`,
      );
    this.refreshUI(event.task.id);
  }

  /**
   * Refresh UI components. Without a taskId the renderer drops refresh events
   * whose taskId does not match the displayed task, so we omit it - the event
   * then reaches every mounted instance (pattern from savemytoken).
   */
  private refreshUI(_taskId?: string): void {
    const config = getConfig();
    if (config.ui.showStatusBadge) this.context?.triggerUIDataRefresh(STATUS_BADGE_ID);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------
  getCommands(_context: ExtensionContext): CommandDefinition[] {
    const ext = this;
    return [
      {
        name: 'broke',
        description: 'broke: token-budget compression - status, config and per-task stats - /broke help lists all subcommands',
        arguments: [{ description: 'subcommand - see /broke help', required: false }],
        async execute(args, context) {
          const config = getConfig();
          const cmd = parseBrokeCommand(args);
          const task = context.getTaskContext();
          const log = async (line: string): Promise<void> => {
            if (task) await task.addLogMessage('info', line);
            else context.log(line, 'info');
          };

          switch (cmd.kind) {
            case 'status': {
              const price = await resolveTaskModelPrice(context);
              return log(await formatStatus(config, ext.statsFor(context), price));
            }
            case 'stats': {
              const price = await resolveTaskModelPrice(context);
              return log(formatStats(config, ext.statsFor(context), price));
            }
            case 'reset': {
              const taskId = context.getTaskContext()?.data.id;
              if (taskId) {
                const cleared = emptyStats(taskId);
                ext.statsByTask.set(taskId, cleared);
                // Real reset: remove the task's persisted lines from stats.jsonl
                // and drop the summarize cache so nothing stale survives.
                clearTaskStats(taskId);
                ext.state.cachedSummaryByTask.delete(taskId);
                ext.summarizeFailures.delete(taskId);
                ext.summarizeDisabled.delete(taskId);
              }
              return log('broke: stats cleared for this task (incl. persisted history; summarization re-enabled)');
            }
            case 'selftest': {
              const result = await runSelfTest(config);
              return log(result.lines.join('\n'));
            }
            case 'help':
              return log(HELP_TEXT);
            case 'unknown':
              return log(`broke: unknown command - ${cmd.raw} - /broke help lists all subcommands`);
            default: {
              const updated = applyBrokeCommand(cmd, config);
              // Reconfiguring the summarizer backend/model is an explicit
              // retry intent: clear the auto-disable so the new setup runs.
              const taskId = context.getTaskContext()?.data.id;
              if (taskId && (cmd.kind === 'summarize-via' || cmd.kind === 'summarize-model' || cmd.kind === 'summarize-cloud')) {
                ext.summarizeDisabled.delete(taskId);
                ext.summarizeFailures.delete(taskId);
              }
              ext.context?.triggerUIComponentsReload();
              ext.refreshUI();
              return log(`broke: ${updated.message} - /broke help lists all subcommands`);
            }
          }
        },
      },
    ];
  }

  private statsFor(context: ExtensionContext): TaskStats | null {
    const taskId = context.getTaskContext()?.data.id;
    if (!taskId) return null;
    return this.statsByTask.get(taskId) ?? loadTaskStats(taskId);
  }

  // -------------------------------------------------------------------------
  // UI: status badge + settings dialog
  // -------------------------------------------------------------------------
  getUIComponents(): UIComponentDefinition[] {
    const components: UIComponentDefinition[] = [];
    if (statusBadgeJsx && getConfig().ui.showStatusBadge) {
      components.push({
        id: STATUS_BADGE_ID,
        placement: 'task-status-bar-right',
        name: 'Broke status',
        loadData: true,
        noDataCache: true,
        jsx: statusBadgeJsx,
      });
    }
    return components;
  }

  async getUIExtensionData(componentId: string, context: ExtensionContext): Promise<unknown> {
    if (componentId !== STATUS_BADGE_ID) return null;
    const config = getConfig();
    const stats = this.statsFor(context);
    const totalTokens = stats ? estimateTokens(totalSavedChars(stats)) : 0;
    const ollama = await this.cachedOllamaStatus(config);
    // Money is always computed from the price of the task's CURRENT model.
    const price = await resolveTaskModelPrice(context);
    const savedUsd = price ? savedCostUsd(totalTokens, price.inputPerMToken) : null;
    return {
      level: config.enabled ? config.level : 'off',
      // What the user configured (the badge must show this even when the
      // summarizer never fired yet) vs. what was actually used.
      summarizerConfigured: config.enabled && config.level === 'summarize' ? config.summarize.via : 'none',
      summarizerUsed: stats?.lastSummarizer ?? 'none',
      ollama: ollama ? { reachable: ollama.reachable, models: ollama.models.length, error: ollama.error } : null,
      cost: {
        savedUsd,
        modelLabel: price ? priceLabel(price) : null,
      },
      passes: stats?.passes ?? 0,
      savedTokens: {
        structural: stats ? estimateTokens(stats.savedChars.structural) : 0,
        truncate: stats ? estimateTokens(stats.savedChars.truncate) : 0,
        summarize: stats ? estimateTokens(stats.savedChars.summarize) : 0,
      },
      totalSavedTokens: totalTokens,
      summarizeFailures: stats?.summarizeFailures ?? 0,
      summarizeDisabled: this.summarizeDisabled.get(context.getTaskContext()?.data.id ?? '') === true,
      inTask: !!context.getTaskContext(),
      now: Date.now(),
    };
  }

  getConfigComponent(): string {
    return configComponentJsx;
  }

  async getConfigData(): Promise<unknown> {
    return getConfig();
  }

  async saveConfigData(configData: unknown): Promise<unknown> {
    const parsed = ConfigSchema.parse(configData);
    saveConfig(parsed);
    // Re-register UI components (badge may be toggled) and refresh data.
    this.context?.triggerUIComponentsReload();
    this.refreshUI();
    return parsed;
  }
}
