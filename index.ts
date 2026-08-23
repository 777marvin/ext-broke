import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  CommandDefinition,
  Extension,
  ExtensionContext,
  OptimizeMessagesEvent,
  TaskInitializedEvent,
  ToolFinishedEvent,
  UIComponentDefinition,
} from '@aiderdesk/extensions';
import { applyBrokeCommand, formatMeasure, formatStats, formatStatus, HELP_TEXT, parseBrokeCommand } from './commands';
import {
  compressMessages,
  createCompressState,
  maskSecrets,
  type CompressReport,
  type CompressState,
  type SummarizeDeps,
} from './compress';
import { ConfigSchema, CONFIG_PATH, getConfig, getConfigWarning, invalidateConfigCache, saveConfig, type Config } from './config';
import { clearArchive, extractErrorSummary, formatErrorSummary, isCommandTool, saveErrorOutput } from './errors';
import { isPlaintextRemoteUrl, ollamaGenerate, ollamaStatus, type OllamaStatus } from './local';
import { extractOutputText } from './output';
import { formatUsd, priceLabel, resolveTaskModelPrice, savedCostUsd, type TaskModelPrice } from './pricing';
import { runSelfTest } from './selftest';
import {
  buildRunRecord,
  clearTaskStats,
  createStatsLoader,
  emptyStats,
  estimateTokens,
  loadRunRecords,
  persistRunRecord,
  persistStats,
  summarizeRunRecords,
  totalSavedChars,
  type StatsLoader,
  type TaskStats,
} from './tokens';
import { boundedMapSet } from './compress';
import { runUpdate } from './update';

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
/**
 * Persist stats at most this often per task - stats.jsonl is debug data,
 * not a ledger. BROKE_STATS_PERSIST_MIN_MS overrides for tests (read at
 * module load, like the other BROKE_* isolation variables).
 */
const STATS_PERSIST_MIN_MS = (() => {
  const raw = process.env.BROKE_STATS_PERSIST_MIN_MS;
  const parsed = raw === undefined ? 60_000 : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
})();

/**
 * The metadata version comes from package.json (single source of truth):
 * a hardcoded string drifts from the released version.
 */
function loadPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8')) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export default class Broke implements Extension {
  static metadata = {
    name: 'Broke',
    version: loadPackageVersion(),
    description:
      'Token budget extension: progressive input compression (structural + truncate + summarize) with local-model (Ollama) summarization offload',
    author: '777marvin',
    capabilities: ['commands', 'ui-elements'],
  };

  private context: ExtensionContext | null = null;
  private configWatcher: FSWatcher | null = null;
  private readonly state: CompressState = createCompressState();
  private readonly statsByTask = new Map<string, TaskStats>();
  /** TTL-cached reads of stats.jsonl - a badge refresh must not re-scan 5 MB per tick. */
  private readonly statsLoader: StatsLoader = createStatsLoader();
  private readonly lastPersistAt = new Map<string, number>();
  private readonly lastLogAt = new Map<string, number>();
  private readonly summarizeFailures = new Map<string, number>();
  /** Tasks whose summarize pass is auto-disabled after repeated failures. */
  private readonly summarizeDisabled = new Map<string, true>();
  /**
   * Reentry guard (per task): the cloud summarizer calls task.generateText,
   * and that call can fire onOptimizeMessages again on the same extension
   * instance. Without the guard the summarizer's own input would be
   * compressed again (double compression or unbounded recursion). Scoped to
   * the task id, so two tasks with model calls in flight compress
   * independently instead of silently skipping each other.
   */
  private readonly optimizingTasks = new Set<string>();
  private ollamaStatusCache: { at: number; status: OllamaStatus } | null = null;

  onLoad(context: ExtensionContext): void {
    this.context = context;
    const config = getConfig();
    context.log(
      `Broke loaded - level: ${config.level}, maxContextChars: ${config.maxContextChars.toLocaleString('en-US')}, summarizer: ${config.summarize.via}${config.summarize.via === 'local' ? ` (${config.summarize.localModel})` : ''}`,
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
    this.startConfigWatcher();
  }

  /**
   * Watch the config file for external edits. Extracted so /broke update can
   * close the watcher while the installer swaps the installation folder (the
   * watcher's open handle pins that directory on Windows) and start a fresh
   * one afterwards.
   */
  startConfigWatcher(): void {
    try {
      this.configWatcher = watch(dirname(CONFIG_PATH), (_event, filename) => {
        // Match the CONFIGURED file name, not a hardcoded 'config.json':
        // BROKE_CONFIG_PATH overrides must invalidate the cache too.
        if (filename === basename(CONFIG_PATH)) {
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

  /** Release the directory handle so /broke update can swap the folder. */
  closeConfigWatcher(): void {
    this.configWatcher?.close();
    this.configWatcher = null;
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
    const task = context.getTaskContext();
    if (!task) return;
    const taskId = task.data.id;
    if (this.optimizingTasks.has(taskId)) return;
    const config = getConfig();
    if (!config.enabled) return;

    const deps: SummarizeDeps = {
      generateLocal: async (model, prompt) => {
        const result = await ollamaGenerate(config.summarize.ollamaUrl, model, prompt, 800);
        return result.ok ? result.text : undefined;
      },
      generateCloud: async (systemPrompt, prompt) => {
        const fallbackModel = task.data.model ?? task.data.mainModel;
        // No usable model id: fail this pass gracefully instead of calling
        // generateText with a literal "provider/undefined".
        if (!fallbackModel) return undefined;
        const modelId = config.summarize.cloudModelId || `${task.data.provider}/${fallbackModel}`;
        // Cost guards: the summarizer input is capped in summarizePass
        // (MAX_SUMMARIZER_INPUT_CHARS) and the result is truncated to
        // maxSummaryChars afterwards. generateText offers no max-output
        // token option, so those two caps are the whole budget.
        return task.generateText(modelId, systemPrompt, prompt);
      },
    };

    this.optimizingTasks.add(taskId);
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
    } finally {
      this.optimizingTasks.delete(taskId);
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
      const extractedText = extractOutputText(event.output, { eventOutput: true });
      if (!extractedText) return;
      const { text, wrap } = extractedText;
      if (text.length < config.errors.minChars) return;

      // Redact secrets BEFORE archiving and BEFORE extraction: neither the
      // archive file nor the summary in the conversation may leak tokens/keys.
      const redacted = maskSecrets(text);
      const extracted = extractErrorSummary(redacted, { contextLines: config.errors.contextLines });
      if (!extracted.matched) return;

      // Privacy control (XF10): archive on/off + retention. When the user
      // turned the archive off, no full output is written to disk at all.
      const savedPath = config.errors.archive
        ? saveErrorOutput(taskId, event.toolCallId || event.toolName, redacted, undefined, { retentionDays: config.errors.retentionDays })
        : '';
      const suffix = savedPath ? ` - full output saved to ${savedPath}` : ' - full output removed';
      return { output: wrap(formatErrorSummary(extracted, suffix)) };
    } catch (err) {
      // Never break tool execution - compression is best effort.
      context.log(`Broke: tool-level error compression failed - ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  private recordReport(taskId: string, report: CompressReport, price: TaskModelPrice | null): void {
    // No-op runs (nothing compressed, nothing attempted) are not compression
    // runs: counting them inflates `passes` and appends a stats line on
    // EVERY model call.
    if (!report.touched) return;
    const stats = this.statsByTask.get(taskId) ?? this.statsLoader.get(taskId) ?? emptyStats(taskId);
    stats.passes += 1;
    stats.savedChars.structural += report.structuralChars;
    stats.savedChars.error += report.errorChars;
    stats.savedChars.truncate += report.truncateChars;
    stats.savedChars.summarize += report.summarizeChars;
    // Measured sizes (XF14): the honest headline is before-after, not the
    // per-pass sum - multiple passes can overlap or the marker overhead can
    // eat into the pass savings.
    stats.totalCharsBefore += report.totalCharsBefore;
    stats.totalCharsAfter += report.totalCharsAfter;
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
    // Throttled persistence: an active task compresses on every model call;
    // writing stats.jsonl synchronously each time is needless disk churn.
    const lastPersist = this.lastPersistAt.get(taskId) ?? 0;
    if (Date.now() - lastPersist >= STATS_PERSIST_MIN_MS) {
      boundedMapSet(this.lastPersistAt, taskId, Date.now());
      persistStats(stats);
    }
    // Per-run measurement ledger (NOT throttled - one record per real run is
    // the point). Rotation-capped like stats.jsonl, config-gated, best effort.
    if (getConfig().stats.measure) {
      persistRunRecord(buildRunRecord(taskId, report));
    }

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
        ?.addLogMessage('info', `💸 broke: compressed input - saved ≈ ${tokens.toLocaleString('en-US')} tokens${money} (${parts.join(', ')})`);
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
        `broke active - level: ${config.level}, threshold: ${config.maxContextChars.toLocaleString('en-US')} chars, protectedTurns: ${config.protectedTurns}, ${ollamaNote}${remotePlaintext ? ' - WARNING: remote Ollama via plaintext http, data is sent unencrypted' : ''} - /broke help lists all commands`,
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
                ext.statsLoader.invalidate(taskId);
                ext.lastPersistAt.delete(taskId);
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
            case 'update': {
              // Self-update from GitHub releases. The hooks free the config
              // watcher's directory handle for the folder swap and reopen it
              // afterwards; progress goes to the extension log, not the chat.
              const result = await runUpdate({ mode: cmd.mode, tag: cmd.tag }, {
                onBeforeSwap: () => ext.closeConfigWatcher(),
                onAfterSwap: () => ext.startConfigWatcher(),
                progress: (line) => context.log(line, 'info'),
              });
              return log(result.message);
            }
            case 'errors-clear': {
              const result = clearArchive();
              return log(
                result.removedFiles > 0
                  ? `broke: error archive cleared - ${result.removedFiles} file(s), ${result.removedBytes.toLocaleString('en-US')} bytes removed`
                  : 'broke: error archive was already empty',
              );
            }
            case 'measure': {
              const summary = summarizeRunRecords(loadRunRecords());
              return log(formatMeasure(summary));
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
    return this.statsByTask.get(taskId) ?? this.statsLoader.get(taskId);
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
        error: stats ? estimateTokens(stats.savedChars.error) : 0,
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

  /**
   * UI component actions. 'refresh' is the polling fallback used by the
   * badge interval: it forces the renderer to re-fetch the component data
   * even when a push event (triggerUIDataRefresh) was missed.
   */
  async executeUIExtensionAction(_componentId: string, action: string, _args: unknown[], _context: ExtensionContext): Promise<unknown> {
    if (action === 'refresh') this.refreshUI();
    return null;
  }

  getConfigComponent(): string {
    return configComponentJsx;
  }

  async getConfigData(): Promise<unknown> {
    return getConfig();
  }

  async saveConfigData(configData: unknown): Promise<unknown> {
    let parsed: Config;
    try {
      parsed = ConfigSchema.parse(configData);
    } catch (err) {
      // A value outside the schema bounds must not fail silently: log the
      // violation and keep the last valid config.
      this.context?.log(
        `Broke: settings not saved - invalid value (${err instanceof Error ? err.message : String(err)}). Keeping the previous config.`,
        'error',
      );
      return getConfig();
    }
    saveConfig(parsed);
    // Re-register UI components (badge may be toggled) and refresh data.
    this.context?.triggerUIComponentsReload();
    this.refreshUI();
    return parsed;
  }
}
