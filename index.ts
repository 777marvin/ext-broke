import { readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  AfterCommitEvent,
  CommandDefinition,
  ContextMessage,
  Extension,
  ExtensionContext,
  OptimizeMessagesEvent,
  TaskInitializedEvent,
  ToolCalledEvent,
  ToolDefinition,
  ToolFinishedEvent,
  UIComponentDefinition,
} from '@aiderdesk/extensions';
import { applyBrokeCommand, formatEstimate, formatMeasure, formatStats, formatStatus, HELP_TEXT, parseBrokeCommand, type BrokeCommand } from './commands';
import {
  ACTIVE_TURN_TAIL,
  compressibleRange,
  compressMessages,
  createCompressState,
  maskSecrets,
  shouldCompress,
  summarizePass,
  type CompressReport,
  type CompressState,
  type SummarizeDeps,
} from './compress';
import { ConfigSchema, CONFIG_PATH, getConfig, getConfigWarning, invalidateConfigCache, saveConfig, type Config } from './config';
import { clearArchive, extractErrorSummary, formatErrorSummary, isCommandTool, saveErrorOutput } from './errors';
import {
  createEmptyState,
  ensureFresh,
  estimateBulkReadAvoided,
  formatSearchFooter,
  indexDirFor,
  loadIndex,
  mergeIntoState,
  projectHash,
  resolveSearchOptions,
  runSearch,
  saveIndex,
  scanProject,
  type IndexState,
} from './indexer';
import { isPlaintextRemoteUrl, isRemoteOllamaHost, ollamaGenerate, ollamaStatus, type OllamaStatus } from './local';
import { extractOutputText } from './output';
import { formatUsd, priceLabel, resolveTaskModelPrice, savedCostUsd, type TaskModelPrice } from './pricing';
import {
  extractTargetPath,
  FOCUS_MARKER,
  isEditTool,
  isSliceablePath,
  looksLikeReadTool,
  sliceableLang,
  sliceInterfaces,
  sliceMarker,
  slicePathKey,
} from './slice';
import { runSelfTest } from './selftest';
import {
  buildFlushPlan,
  buildStateMessage,
  extractAchieved,
  extractGoal,
  listSnapshots,
  looksLikeGreenTests,
  makeSnapshotRecord,
  persistSnapshot,
  readHistory,
  readSnapshot,
  resolveSnapshot,
  summaryTextOf,
  writeFlushReduction,
} from './snapshot';
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
  messagesChars,
  type StatsLoader,
  type TaskStats,
} from './tokens';
import { boundedMapSet } from './compress';
import { runUpdate } from './update';
import { z } from 'zod';

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

/**
 * Char-only scan of command-tool result sizes in a live message array
 * (`/broke why` pass hints). No content is read beyond .length - same
 * privacy parity as the measurement ledger.
 */
function scanBiggestCommandResultChars(messages: ReadonlyArray<{ role?: unknown; content?: unknown }>): number {
  let biggest = 0;
  for (const m of messages) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const part of m.content as Array<Record<string, unknown>>) {
      if (part.type !== 'tool-result') continue;
      const out = part.output as { value?: unknown } | undefined;
      const text = typeof out?.value === 'string' ? out.value : '';
      if (!isCommandTool(typeof part.toolName === 'string' ? part.toolName : '')) continue;
      if (text.length > biggest) biggest = text.length;
    }
  }
  return biggest;
}

export default class Broke implements Extension {
  static metadata = {
    name: 'Broke',
    version: loadPackageVersion(),
    description:
      'Token budget extension: progressive input compression (structural + truncate + summarize) with local-model (Ollama) summarization offload',
    author: '777marvin',
    capabilities: ['commands', 'ui-elements', 'tools'],
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
   * Last optimize-run observation per task - recorded for EVERY real
   * pipeline run, including no-op runs where nothing was compressed. This
   * is what lets the badge and /broke why explain an honest zero ("input
   * 31k of 60k chars") instead of leaving the user to guess whether the
   * extension is broken or simply idle.
   */
  private readonly lastObservation = new Map<string, { at: number; inputChars: number }>();
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
  /**
   * ST-slicing state (F2), all task-scoped and bounded. The last edit target
   * becomes the task focus (focusAuto); explicit focus comes from
   * /broke slice focus. updatedFiles caches getUpdatedFiles() for a short
   * TTL - it runs a git diff per call and must not fire on every file read.
   */
  private readonly lastEditPath = new Map<string, { path: string; at: number }>();
  private readonly explicitFocus = new Map<string, string>();
  private readonly updatedFilesCache = new Map<string, { paths: string[]; at: number }>();
  private readonly unknownReadToolsLogged = new Map<string, true>();
  /** Review R12: dynamic tool names must not grow state unboundedly. */
  private static readonly MAX_UNKNOWN_READ_TOOLS = 1000;
  private static readonly UPDATED_FILES_TTL_MS = 30_000;
  /**
   * F4 state: one keyword index per open project (hash-keyed, bounded like
   * every other map here). `at` also throttles the commit-signal refresh -
   * a rebuild storm must never follow a rapid commit series.
   */
  private readonly indexByProject = new Map<string, { state: IndexState; at: number }>();
  private static readonly INDEX_REFRESH_TTL_MS = 60_000;

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
    // API >= AiderDesk 0.80 (@aiderdesk/extensions 0.31): the host runs this
    // cleanup itself on unload/disable, so the watcher's directory handle no
    // longer leaks when the extension is toggled off or uninstalled. Optional
    // chaining keeps older hosts (plain onUnload) working unchanged.
    context.addDisposable?.(() => this.closeConfigWatcher());
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

  /**
   * Persist every task's in-memory stats NOW. STATS_PERSIST_MIN_MS throttles
   * writes during normal operation; without this flush a restart would lose
   * up to that throttle window of runs per task. Best effort like every
   * ledger write.
   */
  private flushStats(): void {
    for (const [taskId, stats] of this.statsByTask) {
      persistStats(stats);
      this.lastPersistAt.set(taskId, Date.now());
    }
  }

  async onUnload(): Promise<void> {
    this.flushStats();
    this.configWatcher?.close();
    this.configWatcher = null;
  }

  // -------------------------------------------------------------------------
  // The core: compress the messages that are about to be sent to the model.
  // Runs before EVERY model call (not only at the built-in emergency
  // threshold), which is what makes the input compression "permanent": every
  // input the model sees is already compressed.
  // -------------------------------------------------------------------------
  /**
   * Contract wrapper (review R13): NOTHING in broke may break the host's
   * model call - including a throwing getTaskContext or any other host
   * surface in the prelude. The actual work lives in optimizeMessages.
   */
  async onOptimizeMessages(event: OptimizeMessagesEvent, context: ExtensionContext): Promise<Partial<OptimizeMessagesEvent> | void> {
    try {
      return await this.optimizeMessages(event, context);
    } catch (err) {
      try {
        context.log(`Broke: compression failed - ${err instanceof Error ? err.message : String(err)}`, 'error');
      } catch {
        // even logging may fail on a hostile surface - swallow
      }
      return undefined;
    }
  }

  private async optimizeMessages(event: OptimizeMessagesEvent, context: ExtensionContext): Promise<Partial<OptimizeMessagesEvent> | void> {
    const task = context.getTaskContext();
    if (!task) return;
    const taskId = task.data.id;
    if (this.optimizingTasks.has(taskId)) return;
    const config = getConfig();
    if (!config.enabled) return;

    const deps = this.buildSummarizeDeps(config, task, context);

    this.optimizingTasks.add(taskId);
    try {
      const { messages, report } = await compressMessages(event.optimizedMessages, config, deps, this.state, taskId, {
        summarizeDisabled: this.summarizeDisabled.get(taskId) === true,
      });
      // Price lookup only when something was actually compressed (it is
      // cached afterwards; the badge warms it on task open).
      const price = report.touched ? await resolveTaskModelPrice(context) : null;
      this.recordReport(taskId, report, price);
      // Observe every real pipeline run - touched or not. No-op runs are
      // still facts the UI needs: they are how a zero badge explains itself.
      boundedMapSet(this.lastObservation, taskId, { at: Date.now(), inputChars: report.totalCharsBefore });
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
   * Summarizer backends shared by the pipeline (onOptimizeMessages) and the
   * manual /broke summarize now command, so both run through the SAME trust
   * gate and model resolution - a fix here covers every caller.
   *
   * explainFailures: the pipeline relies on the auto-disable counter to keep
   * failure noise down; the manual command surfaces failures to the user in
   * the chat instead, so it enables per-failure warnings.
   */
  /**
   * Disclosure telemetry (review F-13): every time conversation content
   * leaves this machine for summarization, the user gets ONE clear log line
   * per target - repeats would be noise, silence would hide the disclosure.
   * Regex redaction stays best-effort; the trust boundary is this log plus
   * the consent gates, never a "secret-free" claim.
   */
  private readonly disclosureNotified = new Set<string>();
  private notifyDisclosure(context: ExtensionContext, backend: 'ollama' | 'cloud', target: string): void {
    const key = `${backend}:${target}`;
    if (this.disclosureNotified.has(key)) return;
    this.disclosureNotified.add(key);
    try {
      context.log(
        `Broke: DISCLOSURE - conversation content (best-effort secret-masked) is sent to the ${backend} summarization target "${target}".`,
        'warn',
      );
    } catch {
      // logging must never break the pipeline
    }
  }

  private buildSummarizeDeps(
    config: Config,
    task: NonNullable<ReturnType<ExtensionContext['getTaskContext']>>,
    context: ExtensionContext,
    opts: { explainFailures?: boolean } = {},
  ): SummarizeDeps {
    return {
      generateLocal: async (model, prompt) => {
        // Trust gate (review R3): a non-loopback Ollama host means
        // conversation content leaves this machine. Without explicit consent
        // the summarizer refuses - graceful failure, the model call proceeds
        // uncompressed. Repeated refusals trip the existing auto-disable,
        // which keeps this warning from spamming every model call.
        if (isRemoteOllamaHost(config.summarize.ollamaUrl) && !config.summarize.allowRemoteHost) {
          context.log(
            `Broke: local summarizer refused - ${config.summarize.ollamaUrl} is a remote host and conversation content (incl. tool outputs) would be sent to another machine. Consent with /broke summarize allow-remote on (or use a loopback URL).`,
            'warn',
          );
          return undefined;
        }
        if (isRemoteOllamaHost(config.summarize.ollamaUrl)) {
          this.notifyDisclosure(context, 'ollama', config.summarize.ollamaUrl);
        }
        const result = await ollamaGenerate(config.summarize.ollamaUrl, model, prompt, 800);
        if (!result.ok && opts.explainFailures) {
          context.log(`Broke: local summarizer error - ${result.error ?? 'unknown Ollama error'}`, 'warn');
        }
        return result.ok ? result.text : undefined;
      },
      generateCloud: async (systemPrompt, prompt) => {
        const fallbackModel = task.data.model ?? task.data.mainModel;
        // No usable model id: fail this pass gracefully instead of calling
        // generateText with a literal "provider/undefined".
        if (!fallbackModel) return undefined;
        const modelId = config.summarize.cloudModelId || `${task.data.provider}/${fallbackModel}`;
        // Cloud targets are remote by definition (review F-13): one clear
        // disclosure line per target, then silence.
        this.notifyDisclosure(context, 'cloud', modelId);
        // Cost guards: the summarizer input is capped in summarizePass
        // (MAX_SUMMARIZER_INPUT_CHARS) and the result is truncated to
        // maxSummaryChars afterwards. generateText offers no max-output
        // token option, so those two caps are the whole budget.
        return task.generateText(modelId, systemPrompt, prompt);
      },
    };
  }

  /**
   * /broke summarize now - run the summarize pass ON DEMAND against the live
   * task context and cache its result. This never rewrites anything the user
   * can see: the replacement list returned by summarizePass is discarded,
   * only cachedSummaryByTask is written - the next real model call then takes
   * the free cache-reuse path (the XF6 grow-guard still protects that swap).
   *
   * Use cases: pre-warming BEFORE a long autonomous run (summarizer latency
   * moves out of the hot path), testing a newly configured summarizer backend
   * on real context instead of the synthetic selftest input, and recovering
   * from the auto-disable gate without waiting for another threshold cross.
   *
   * Deliberately NOT routed through recordReport: stats.passes counts real
   * pipeline compression runs and the saved chars are realized (and counted)
   * later by the reuse path. Manual failures surface here instead of feeding
   * the auto-disable counter - but a MANUAL SUCCESS clears the auto-disable
   * state for this task (same "explicit retry intent" semantics as the
   * /broke summarize via/model/cloud reconfiguration commands).
   */
  private async summarizeNow(context: ExtensionContext): Promise<string> {
    const task = context.getTaskContext();
    if (!task) return 'broke: summarize now - run this inside a task';
    const taskId = task.data.id;
    const config = getConfig();
    if (!config.enabled) return 'broke: summarize now - the pipeline is disabled (/broke on)';
    if (config.level !== 'summarize') return 'broke: summarize now - level is not summarize (/broke level summarize)';
    // Same reentry guard as the pipeline: the cloud summarizer's
    // task.generateText can fire onOptimizeMessages while we wait.
    if (this.optimizingTasks.has(taskId)) {
      return 'broke: summarize now - a model call is being compressed right now; try again in a moment';
    }

    let messages: ContextMessage[];
    try {
      messages = (await task.getContextMessages()) ?? [];
    } catch (err) {
      return `broke: summarize now - could not read context messages (${err instanceof Error ? err.message : String(err)})`;
    }
    const { start, end } = compressibleRange(messages, config.protectedTurns);
    const regionChars = start < end ? messagesChars(messages.slice(start, end)) : 0;
    if (!shouldCompress(messages, config) || regionChars <= 0) {
      return 'broke: summarize now - nothing compressible yet (no old messages outside the protected turns)';
    }

    this.optimizingTasks.add(taskId);
    try {
      const deps = this.buildSummarizeDeps(config, task, context, { explainFailures: true });
      const result = await summarizePass(messages, config.protectedTurns, config, deps, this.state, taskId);
      if (result.failed) {
        return 'broke: summarize now FAILED - check /broke status (Ollama reachable? model installed?) and the extension log for details';
      }
      if (result.summarizedRanges > 0) {
        // A real summary was produced or served from cache: explicit success,
        // so clearing the auto-disable state matches recordReport's rule for
        // successful runs.
        this.summarizeDisabled.delete(taskId);
        this.summarizeFailures.delete(taskId);
        const estTokens = estimateTokens(Math.max(result.removedChars, 0)).toLocaleString('en-US');
        if (result.summarizeCalls === 0) {
          return `broke: summary for the current region is already cached - nothing regenerated (≈ ${estTokens} tokens ready for reuse)`;
        }
        return `broke: summary generated (≈ ${estTokens} tokens smaller than the old region) and cached - it will be applied automatically on the next model call`;
      }
      if (result.summarizeCalls > 0) {
        // XF6: the produced summary would GROW the context - nothing cached.
        return 'broke: summary produced but NOT smaller than the region it replaces - nothing was cached or changed';
      }
      return 'broke: nothing summarized - the old region is below summarize.minChars or holds image/file/reasoning parts that must be preserved verbatim';
    } catch (err) {
      // Never let the command break - same contract as every hook.
      context.log(`Broke: summarize now failed - ${err instanceof Error ? err.message : String(err)}`, 'error');
      return 'broke: summarize now FAILED with an unexpected error - see the extension log';
    } finally {
      this.optimizingTasks.delete(taskId);
    }
  }

  /**
   * ST-slicing focus tracking (F2): when an edit/write tool fires, its
   * target becomes the task focus - the next read of that file passes
   * through in full while everything else is sliced. Read-only side effect;
   * never modifies the event.
   */
  async onToolCalled(event: ToolCalledEvent, context: ExtensionContext): Promise<void> {
    try {
      const config = getConfig();
      if (!config.enabled || !config.slice.enabled || !config.slice.focusAuto) return;
      if (!isEditTool(event.toolName, event.input)) return;
      const path = extractTargetPath(event.input);
      const taskId = context.getTaskContext()?.data.id;
      if (!path || !taskId) return;
      boundedMapSet(this.lastEditPath, taskId, { path, at: Date.now() });
    } catch (err) {
      // Never break tool execution - focus tracking is best effort.
      context.log(`Broke: slice focus tracking failed - ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /**
   * Tool-level passes. Two independent rewrites, both opt-in and both
   * never-throwing; they are mutually exclusive by tool type:
   * - ST-slicing (F2): file reads -> interface views (slice.enabled).
   * - Error compression (errors.toolLevel): command output -> error summary.
   * Contract wrapper (R13): the whole body is failure-isolated so a hostile
   * host surface cannot break tool execution.
   */
  async onToolFinished(event: ToolFinishedEvent, context: ExtensionContext): Promise<Partial<ToolFinishedEvent> | void> {
    try {
      return await this.toolFinished(event, context);
    } catch (err) {
      // Never break tool execution - compression is best effort.
      try {
        context.log(`Broke: tool-level pass failed - ${err instanceof Error ? err.message : String(err)}`, 'error');
      } catch {
        // swallow - logging is best effort
      }
      return undefined;
    }
  }

  /**
   * F3 trigger: record a milestone snapshot after every commit. The event is
   * read-only; Broke only writes its own JSON under snapshots/<taskId>/.
   * Isolation contract (host-contract suite): never throws into the loop.
   */
  async onAfterCommit(event: AfterCommitEvent, context: ExtensionContext): Promise<void> {
    try {
      const config = getConfig();
      if (!config.enabled || !config.snapshot.onCommit || !event.message) return;
      await this.snapshotMilestone(context, 'commit', event.message.split('\n')[0].slice(0, 200));
      // F4 trigger (throttled inside): keep the keyword index warm so the
      // next broke-search call does not pay the whole incremental walk.
      void this.refreshIndexFromSignal(context);
    } catch (err) {
      try {
        context.log(`Broke: commit snapshot failed - ${err instanceof Error ? err.message : String(err)}`, 'warn');
      } catch {
        // swallow - logging is best effort
      }
    }
  }

  private async toolFinished(event: ToolFinishedEvent, context: ExtensionContext): Promise<Partial<ToolFinishedEvent> | void> {
    const config = getConfig();
    if (!config.enabled) return;

    const sliced = await this.sliceOnToolFinished(event, config, context);
    if (sliced) return sliced;

    // F3 trigger (off by default): test-green detection. Fire-and-forget -
    // it must neither block nor influence the compression passes below.
    if (config.enabled && config.snapshot.onTestPass && isCommandTool(event.toolName)) {
      try {
        const extracted = extractOutputText(event.output, { eventOutput: true });
        if (extracted && looksLikeGreenTests(extracted.text)) void this.snapshotMilestone(context, 'tests-pass').catch(() => undefined);
      } catch {
        // detection is best effort
      }
    }

    if (!config.errors.enabled || !config.errors.toolLevel) return;
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
      const summary = formatErrorSummary(extracted, suffix);
      // XF6/D2 (review F-08): never grow the stored history with a summary
      // longer than the output it replaces.
      if (summary.length >= text.length) return;
      return { output: wrap(summary) };
    } catch (err) {
      // Never break tool execution - compression is best effort.
      context.log(`Broke: tool-level error compression failed - ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** True when the target key matches this task's focus (explicit > edit > updated files). */
  private isFocus(taskId: string, targetKey: string, base: string | null, config: Config, context: ExtensionContext): boolean {
    const explicit = this.explicitFocus.get(taskId);
    if (explicit && slicePathKey(explicit, base) === targetKey) return true;
    if (!config.slice.focusAuto) return false;
    const edit = this.lastEditPath.get(taskId);
    if (edit && slicePathKey(edit.path, base) === targetKey) return true;
    for (const updated of this.cachedUpdatedFiles(taskId, context)) {
      if (slicePathKey(updated, base) === targetKey) return true;
    }
    return false;
  }

  /**
   * TTL-cached getUpdatedFiles() - a git diff must not fire per file read.
   * Resolves through the LIVE execution context (review F-12): the captured
   * extension-level `this.context` can belong to a different task/project
   * in multi-task scenarios, which would leak another task's updated-file
   * list into this task's focus decision.
   */
  private cachedUpdatedFiles(taskId: string, context: ExtensionContext): string[] {
    const cached = this.updatedFilesCache.get(taskId);
    if (cached && Date.now() - cached.at < Broke.UPDATED_FILES_TTL_MS) return cached.paths;
    void context
      .getTaskContext()
      ?.getUpdatedFiles?.()
      .then((files) => {
        boundedMapSet(
          this.updatedFilesCache,
          taskId,
          { paths: files.map((f) => f.path), at: Date.now() },
        );
      })
      .catch(() => undefined); // best effort - focus stays edit/explicit-driven
    // Return the stale list meanwhile; an empty first call is acceptable.
    return cached?.paths ?? [];
  }

  /**
   * The ST-slicing pass: rewrite large sliceable file reads into interface
   * views. Rewrites STORED history - hence default-off and every guard
   * failing toward untouched passthrough.
   */
  private async sliceOnToolFinished(
    event: ToolFinishedEvent,
    config: Config,
    context: ExtensionContext,
  ): Promise<Partial<ToolFinishedEvent> | void> {
    if (!config.slice.enabled) return;
    if (!looksLikeReadTool(event.toolName)) return;
    const path = extractTargetPath(event.input);
    if (!path) {
      this.logUnknownReadToolOnce(event.toolName, context);
      return;
    }
    const lang = sliceableLang(path);
    if (!lang || !isSliceablePath(path)) return;

    const task = context.getTaskContext();
    const taskId = task?.data.id ?? '';

    try {
      const extracted = extractOutputText(event.output, { eventOutput: true });
      if (!extracted) return;
      const { text, wrap } = extracted;
      if (text.length < config.slice.minChars) return;

      // D5: tool inputs and stored focus may mix relative/absolute paths -
      // resolve both against the task dir before comparing.
      let base: string | null = null;
      try {
        const dir = await task?.getTaskDir?.();
        base = typeof dir === 'string' && dir.trim() ? dir : null;
      } catch {
        base = null; // best effort - plain comparison still applies
      }
      const targetKey = slicePathKey(path, base);

      if (taskId && this.isFocus(taskId, targetKey, base, config, context)) {
        return { output: wrap(`${FOCUS_MARKER}\n${text}`) };
      }

      const view = sliceInterfaces(text, lang);
      // Honest fallbacks: an oversized view or a non-shrinking one is worse
      // than the original - pass the full content through untouched.
      if (view.text.length > config.slice.maxChars || view.text.length >= text.length) return;

      if (taskId) this.recordSliceStats(taskId, text.length - view.text.length);
      return { output: wrap(`${sliceMarker(view)}\n${view.text}`) };
    } catch (err) {
      // Never break tool execution - slicing is best effort.
      context.log(`Broke: slicing failed - ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** Diagnose read-tool candidates without a path field once per session. */
  private logUnknownReadToolOnce(toolName: string, context: ExtensionContext): void {
    if (this.unknownReadToolsLogged.has(toolName)) return;
    boundedMapSet(this.unknownReadToolsLogged, toolName, true, Broke.MAX_UNKNOWN_READ_TOOLS);
    context.log(
      `Broke: read tool '${toolName}' carries no path field - slicing skipped for it (S4 feature-detect). Report this if slicing should apply.`,
      'info',
    );
  }

  /** Record estimated slice savings on the task's stats (throttled persistence). */
  private recordSliceStats(taskId: string, savedChars: number): void {
    const stats = this.statsByTask.get(taskId) ?? this.statsLoader.get(taskId) ?? emptyStats(taskId);
    stats.savedChars.slice += savedChars;
    stats.lastRunAt = Date.now();
    boundedMapSet(this.statsByTask, taskId, stats);
    const lastPersist = this.lastPersistAt.get(taskId) ?? 0;
    if (Date.now() - lastPersist >= STATS_PERSIST_MIN_MS) {
      boundedMapSet(this.lastPersistAt, taskId, Date.now());
      persistStats(stats);
    }
  }

  /**
   * Add to one of the counterfactual/one-shot estimate counters (flush,
   * search). Estimates stay OUT of totalSavedChars by design - they are
   * displayed only via /broke estimate and the badge tooltip, always with
   * an explicit "counterfactual / not counted" label. Negative deltas are
   * legitimate: a flush --undo subtracts exactly what its flush added.
   * Throttled persistence mirrors recordSliceStats.
   */
  private bumpEstimate(taskId: string, kind: 'flush' | 'search', delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    const stats = this.statsByTask.get(taskId) ?? this.statsLoader.get(taskId) ?? emptyStats(taskId);
    const estimates = stats.estimates ?? { flush: 0, search: 0 };
    estimates[kind] += Math.round(delta);
    stats.estimates = estimates;
    stats.lastRunAt = Date.now();
    boundedMapSet(this.statsByTask, taskId, stats);
    const lastPersist = this.lastPersistAt.get(taskId) ?? 0;
    if (Date.now() - lastPersist >= STATS_PERSIST_MIN_MS) {
      boundedMapSet(this.lastPersistAt, taskId, Date.now());
      persistStats(stats);
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
    try {
      await this.taskInitialized(event, context);
    } catch (err) {
      // Host surfaces must never see a broke failure.
      try {
        context.log(`Broke: task initialization notice failed - ${err instanceof Error ? err.message : String(err)}`, 'warn');
      } catch {
        // swallow - logging is best effort
      }
    }
  }

  private async taskInitialized(event: TaskInitializedEvent, context: ExtensionContext): Promise<void> {
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
    const remoteBlocked =
      config.summarize.via === 'local' && isRemoteOllamaHost(config.summarize.ollamaUrl) && !config.summarize.allowRemoteHost;
    await context
      .getTaskContext()
      ?.addLogMessage(
        'info',
        `broke active - level: ${config.level}, threshold: ${config.maxContextChars.toLocaleString('en-US')} chars, protectedTurns: ${config.protectedTurns}, ${ollamaNote}${remotePlaintext ? ' - WARNING: remote Ollama via plaintext http, data is sent unencrypted' : ''}${remoteBlocked ? ' - NOTE: remote summarizer host is BLOCKED until you consent (/broke summarize allow-remote on)' : ''} - /broke help lists all commands`,
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
            case 'estimate':
              return log(formatEstimate(ext.statsFor(context)));
            case 'why': {
              return log(await ext.explainWhy(context));
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
            case 'slice-focus':
            case 'slice-focus-clear':
            case 'slice-status': {
              const taskId = context.getTaskContext()?.data.id;
              if (!taskId) return log('broke: slice focus is task-scoped - run this inside a task');
              if (cmd.kind === 'slice-focus') {
                boundedMapSet(ext.explicitFocus, taskId, cmd.path);
                return log(`broke: slice focus → ${cmd.path} (this file always returns in full while slicing is on)`);
              }
              if (cmd.kind === 'slice-focus-clear') {
                ext.explicitFocus.delete(taskId);
                return log('broke: explicit slice focus cleared - focusAuto rules apply again');
              }
              const configNow = getConfig();
              const focus =
                ext.explicitFocus.get(taskId) ??
                ext.lastEditPath.get(taskId)?.path ??
                '(none yet - becomes the last edited file with focusAuto)';
              return log(
                `broke slice status: slicing ${configNow.enabled ? '' : '(pipeline OFF) '}${configNow.slice.enabled ? 'on' : 'off'} | parser: ${configNow.slice.parser} | min ${configNow.slice.minChars.toLocaleString('en-US')} chars | view cap ${configNow.slice.maxChars.toLocaleString('en-US')} chars | focusAuto: ${configNow.slice.focusAuto ? 'on' : 'off'} | current focus: ${focus}`,
              );
            }
            case 'index-rebuild':
              return log(ext.rebuildProjectIndex(context));
            case 'index-status':
              return log(ext.indexStatusText(context));
            case 'search':
              return log(ext.searchViaTool({ query: cmd.query }, context));
            case 'summarize-now':
              return log(await ext.summarizeNow(context));
            case 'snapshot':
            case 'snapshot-list':
            case 'snapshot-show':
              return log(await ext.handleSnapshotCommand(context, cmd));
            case 'flush':
              return log(await ext.handleFlushCommand(context, cmd));
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

  // -------------------------------------------------------------------------
  // F4 - local project keyword index & broke-search tool
  // -------------------------------------------------------------------------

  /**
   * Host-side ToolDefinition mirror (app main `packages/common/src/extensions.ts`).
   * The published types package we compile against (@aiderdesk/extensions
   * 0.31) does not export ToolDefinition/getTools yet - the classic "types
   * lag runtime" pattern. A structural local type keeps typecheck green;
   * at runtime the host reads plain properties from this JS object.
   */
  private static readonly BROKE_SEARCH_SCHEMA = z.object({
    query: z.string().min(1),
    k: z.number().int().min(1).max(50).optional(),
    files: z.array(z.string()).optional(),
  });

  getTools(_context: ExtensionContext, _mode: string, _agentProfile: unknown): ToolDefinition[] {
    const config = getConfig();
    if (!config.enabled || !config.search.enabled) return [];
    return [
      {
        name: 'broke-search',
        description:
          'Search this project locally (keyword index). Returns a token-budgeted snippet summary: path:line plus context lines around each best match, ALL results together under a strict char budget. Prefer this over reading whole files when locating definitions or usages.',
        inputSchema: Broke.BROKE_SEARCH_SCHEMA,
        execute: async (input, _signal, context) => {
          const parsed = Broke.BROKE_SEARCH_SCHEMA.safeParse(input);
          if (!parsed.success) return 'broke-search: invalid arguments';
          return this.searchViaTool(parsed.data, context);
        },
      },
    ];
  }

  /**
   * Project root at call time. The context passed to command execution and
   * tool invocation is created per project/task and carries a real
   * getProjectDir(); the context captured in onLoad() is the global one whose
   * getProjectDir() is documented to return "" - so call-site context wins.
   */
  private rootFor(context?: ExtensionContext): string {
    return context?.getProjectDir?.() || this.context?.getProjectDir?.() || '';
  }

  /** Tool entry point: freshness sweep + budgeted search, never throwing. */
  private searchViaTool(input: { query: string; k?: number; files?: string[] }, context?: ExtensionContext): string {
    const config = getConfig();
    if (!config.search.enabled) return 'broke-search is disabled (/broke help for config paths)';
    const root = this.rootFor(context);
    if (!root) return 'broke-search: no open project - indexing is project-scoped';
    try {
      const fresh = ensureFresh(root, { maxFileKB: config.search.maxFileKB });
      boundedMapSet(this.indexByProject, projectHash(root), { state: fresh.state, at: Date.now() });
      const resolved = resolveSearchOptions(config.search);
      const result = runSearch(fresh.state, root, input.query, { ...resolved.options, k: input.k ?? resolved.options.k }, input.files);
      const builtMs = Date.parse(fresh.state.builtAt);
      const ageMs = Number.isFinite(builtMs) ? Math.max(0, Date.now() - builtMs) : 0;
      const footer =
        formatSearchFooter(result.hits.length, Object.keys(fresh.state.files).length, resolved.options, ageMs) +
        (result.truncated ? ' | INDEX TRUNCATED at cap' : '');
      if (result.hits.length === 0) return `no matches for "${input.query}"\n${footer}`;
      // Counterfactual estimate only (E5 honesty): never shown to the agent
      // and never added to savedChars - /broke estimate + badge tooltip use
      // it with an explicit "counterfactual" label. Files that changed since
      // indexing are skipped by the estimator itself.
      const taskId = context?.getTaskContext?.()?.data.id ?? this.context?.getTaskContext?.()?.data.id;
      if (taskId) {
        const avoided = estimateBulkReadAvoided(result.hits, fresh.state.files);
        if (avoided > 0) this.bumpEstimate(taskId, 'search', avoided);
      }
      return `${result.hits.map((h) => h.text).join('\n\n')}\n\n${footer}`;
    } catch (err) {
      return `broke-search failed - ${err instanceof Error ? err.message : String(err)} - the agent loop was not affected`;
    }
  }

  /** /broke index|index rebuild: full re-index from scratch, persisted atomically. */
  private rebuildProjectIndex(context?: ExtensionContext): string {
    const config = getConfig();
    if (!config.search.enabled) return 'broke: search is disabled - nothing to build';
    const root = this.rootFor(context);
    if (!root) return 'broke: no open project - indexing is project-scoped';
    try {
      const scan = scanProject(root, config.search.maxFileKB);
      const state = createEmptyState(root);
      const delta = mergeIntoState(state, root, scan.entries, scan.truncated);
      saveIndex(indexDirFor(root), state);
      boundedMapSet(this.indexByProject, projectHash(root), { state, at: Date.now() });
      return (
        `broke: index rebuilt - ${Object.keys(state.files).length.toLocaleString('en-US')} file(s), ` +
        `${Object.keys(state.postings).length.toLocaleString('en-US')} term(s), ` +
        `(+${delta.added} new/0 unchanged/-${delta.removed})` +
        (scan.truncated ? ' [TRUNCATED: entries exceed the hard cap]' : '')
      );
    } catch (err) {
      return `broke: index rebuild failed - ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** /broke index status: honest numbers without forcing a rescan. */
  private indexStatusText(context?: ExtensionContext): string {
    const config = getConfig();
    if (!config.search.enabled) return 'broke: local search disabled (search.enabled=false)';
    const root = this.rootFor(context);
    if (!root) return 'broke: no open project - nothing indexed';
    let state: IndexState | null | undefined = this.indexByProject.get(projectHash(root))?.state;
    if (!state) {
      try {
        state = loadIndex(indexDirFor(root));
      } catch {
        state = null;
      }
    }
    if (!state) return 'broke: no index yet on disk - run "/broke index" to build one';
    let bytes = 0;
    try {
      bytes = statSync(join(indexDirFor(root), 'index.json')).size;
    } catch {
      bytes = 0;
    }
    const builtMs = Date.parse(state.builtAt);
    const age = Number.isFinite(builtMs) && builtMs > 0 ? Math.max(1, Math.round((Date.now() - builtMs) / 1000)) : null;
    return [
      `broke index status: backend ${config.search.backend} | top-k ${config.search.maxResults} | budget ${config.search.maxChars.toLocaleString('en-US')} chars/context ±${config.search.contextLines} line(s)`,
      `files: ${Object.keys(state.files).length.toLocaleString('en-US')} | terms: ${Object.keys(state.postings).length.toLocaleString('en-US')} | index.json: ${(bytes / 1024).toFixed(1)} KB`,
      `built: ${state.builtAt || '(unknown)'}${age !== null ? ` (${age}s ago)` : ''}${state.truncated ? ' | TRUNCATED' : ''}`,
      `location: <extension>/index/${projectHash(root)}`,
    ].join('\n');
  }

  /** Fire-and-forget freshness sweep off the commit signal (throttled by TTL). */
  private refreshIndexFromSignal(context: ExtensionContext): void {
    try {
      const config = getConfig();
      if (!config.enabled || !config.search.enabled) return;
      const root = context.getProjectDir?.() ?? '';
      if (!root) return;
      const hash = projectHash(root);
      const cached = this.indexByProject.get(hash);
      if (cached && Date.now() - cached.at < Broke.INDEX_REFRESH_TTL_MS) return;
      const fresh = ensureFresh(root, { maxFileKB: config.search.maxFileKB });
      boundedMapSet(this.indexByProject, hash, { state: fresh.state, at: Date.now() });
    } catch {
      // best effort - never propagate into the commit loop
    }
  }

  // -------------------------------------------------------------------------
  // F3 - snapshots & flush
  // -------------------------------------------------------------------------

  /** Build and persist a milestone record. Additive only - never touches messages. */
  private async snapshotMilestone(context: ExtensionContext, label: string, commit?: string): Promise<string> {
    const config = getConfig();
    const task = context.getTaskContext();
    if (!task) return 'broke: snapshots are task-scoped - run this inside a task';
    const taskId = task.data.id;
    if (!taskId) return 'broke: task has no id yet - send a message first';
    let messages: ContextMessage[] = [];
    try {
      if (typeof task.getContextMessages === 'function') messages = await task.getContextMessages();
    } catch {
      // Degraded record below still persists goal-less; feature-detect pattern.
    }
    let files: string[] = [];
    try {
      if (typeof task.getUpdatedFiles === 'function') files = (await task.getUpdatedFiles()).map((f) => f.path);
    } catch {
      // degraded - empty file list
    }
    const cachedText = summaryTextOf(this.state.cachedSummaryByTask.get(taskId));
    const record = makeSnapshotRecord({
      taskId,
      taskName: task.data.name ?? '',
      goal: extractGoal(messages),
      achieved: extractAchieved(messages),
      files,
      commit,
      summary: cachedText || `template summary - ${messages.length} message(s), ${files.length} updated file(s)`,
    });
    const { recordPath, historyPath } = persistSnapshot(record, messages, { label, keepHistory: config.snapshot.keepHistory });
    return `broke: snapshot recorded (${basename(recordPath)}${historyPath ? ' + undo file' : ''})`;
  }

  private async handleSnapshotCommand(context: ExtensionContext, cmd: BrokeCommand): Promise<string> {
    const task = context.getTaskContext();
    const taskId = task?.data.id;
    if (!taskId) return 'broke: snapshots are task-scoped - run this inside a task';
    try {
      if (cmd.kind === 'snapshot-list') {
        const entries = listSnapshots(taskId);
        if (entries.length === 0) return 'broke: no snapshots for this task yet - /broke snapshot [label] or automatic on commits';
        const lines = entries.map(
          (e, i) => `#${i + 1} ${e.file}${e.bytes ? ` (${e.bytes.toLocaleString('en-US')} B)` : ''}${e.record?.commit ? ` | ${e.record.commit.slice(0, 12)}` : ''}${e.record ? ` | ${e.record.summary.slice(0, 100)}` : ' | (unreadable)'}`,
        );
        lines.unshift(`broke snapshots for this task (${entries.length}):`);
        return lines.join('\n');
      }
      if (cmd.kind === 'snapshot-show') {
        const resolved = resolveSnapshot(taskId, cmd.index);
        if (!resolved) return `broke: no snapshot #${cmd.index} - /broke snapshot list shows the numbering (newest first)`;
        const record = readSnapshot(resolved.path);
        if (!record) return `broke: snapshot #${cmd.index} is unreadable/corrupt (${resolved.entry.file})`;
        return JSON.stringify(record, null, 2);
      }
      if (cmd.kind !== 'snapshot') return '';
      // Manual milestone with optional label.
      return await this.snapshotMilestone(context, cmd.label ?? 'manual');
    } catch (err) {
      return `broke: snapshot failed - ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * The ONLY destructive operation in broke. Order of guarantees:
   * 1. plan + confirm gate, 2. write snapshot AND (when flush.undo is on)
   * the undo file - abort on any IO failure or an oversized undo file BEFORE
   * touching the conversation, 3. one loadContextMessages() replacement to
   * task brief + [broke-state]. removeMessagesUpTo cannot keep the brief
   * (inclusive-of-self), hence the documented loadContext alternative.
   */
  private async handleFlushCommand(context: ExtensionContext, cmd: BrokeCommand): Promise<string> {
    if (cmd.kind !== 'flush') return '';
    const config = getConfig();
    const task = context.getTaskContext();
    if (!task) return 'broke: flush runs inside a task - nothing done';
    const taskId = task.data.id;
    if (!taskId) return 'broke: task has no id yet - nothing to flush';

    if (cmd.undoIndex !== undefined) {
      try {
        const resolved = resolveSnapshot(taskId, cmd.undoIndex);
        if (!resolved) return `broke: no snapshot #${cmd.undoIndex} for this task - /broke snapshot list shows the numbering`;
        const record = readSnapshot(resolved.path);
        if (!record) return `broke: snapshot #${cmd.undoIndex} is unreadable - refusing a half-known restore`;
        const history = readHistory(resolved.path, record);
        if (!history || history.length === 0) {
          return record.historyFile
            ? 'broke: the undo file is missing or unreadable - refusing to half-restore'
            : 'broke: no undo file for this snapshot (raw history was not written - snapshot.keepHistory/flush.undo was off, or the history exceeded the size cap)';
        }
        if (typeof task.loadContextMessages !== 'function') {
          return 'broke: this AiderDesk build does not expose loadContextMessages - undo unavailable (feature-detect)';
        }
        await task.loadContextMessages(history as ContextMessage[]);
        // Undo takes the flush estimate back - exactly what the flushed
        // snapshot recorded, so undoing never leaves inflated numbers.
        if (record.reduction) {
          this.bumpEstimate(taskId, 'flush', -(record.reduction.regionChars - record.reduction.stateMessageChars));
        }
        return `broke: restored ${history.length} message(s) from snapshot #${cmd.undoIndex}`;
      } catch (err) {
        return `broke: undo failed - ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    try {
      const messages = typeof task.getContextMessages === 'function' ? await task.getContextMessages() : null;
      if (!messages || messages.length === 0) {
        return 'broke: this AiderDesk build does not expose getContextMessages - flush unavailable (feature-detect)';
      }
      const plan = buildFlushPlan(messages);
      if (!plan.ok) return `broke: nothing flushed - ${plan.reason}`;
      if (config.flush.confirm && !cmd.yes) {
        if (typeof task.askQuestion !== 'function') {
          return `broke: host confirmation is unavailable here - rerun with explicit "/broke flush --yes" to remove ${plan.removedCount} message(s)`;
        }
        const answer = await task.askQuestion(
          `broke flush removes ${plan.removedCount} message(s) between the task brief and now and replaces them with ONE [broke-state] summary. With flush.undo on (default), a history file enables /broke flush --undo. Proceed?`,
          { answers: [{ text: 'Flush', shortkey: 'y' }, { text: 'Cancel', shortkey: 'n' }], defaultAnswer: 'n' },
        );
        if (!/^y(es)?$/i.test(String(answer ?? '').trim())) return 'broke: flush cancelled - nothing changed';
      }
      let persistedName = '';
      let stateText = '';
      let recordPath = '';
      try {
        const cachedText = summaryTextOf(this.state.cachedSummaryByTask.get(taskId));
        const record = makeSnapshotRecord({
          taskId,
          taskName: task.data.name ?? '',
          goal: extractGoal(messages),
          achieved: extractAchieved(messages),
          summary: cachedText || `${plan.removedCount} message(s) were flushed right after this state was recorded`,
        });
        stateText = buildStateMessage(record);
        const persisted = persistSnapshot(record, messages, { label: 'flush', keepHistory: config.flush.undo });
        if (config.flush.undo && persisted.historySkipped === 'oversized') {
          // Abort-safe contract: a flush that could never be undone (undo
          // file over the size cap) must not remove anything.
          throw new Error(
            `pre-flush history exceeds the undo-file cap (MAX_HISTORY_FILE_BYTES) - flush aborted, nothing removed`,
          );
        }
        recordPath = persisted.recordPath;
        persistedName = basename(recordPath);
      } catch (err) {
        return `broke: flush ABORTED before removing anything - could not write snapshot/history (${err instanceof Error ? err.message : String(err)})`;
      }
      if (typeof task.loadContextMessages !== 'function') {
        return 'broke: flush stopped AFTER writing the snapshot but BEFORE removing anything - this AiderDesk build does not expose loadContextMessages (feature-detect)';
      }
      const replacement: ContextMessage[] = [
        ...plan.headerIndexes.map((i) => messages[i]),
        messages[plan.briefIndex],
        { id: `broke-state-${Date.now()}`, role: 'user', content: stateText } as unknown as ContextMessage,
      ];
      await task.loadContextMessages(replacement);
      // Estimate bookkeeping (only AFTER the replacement succeeded): the
      // measured net reduction is the chars removed from context minus the
      // replacement [broke-state] message's own chars - both real numbers,
      // but this is a one-shot freed-bytes figure, NOT a compression pass.
      // Best effort on every line below: estimates never break a flush.
      try {
        const regionChars = messagesChars(messages.slice(plan.briefIndex + 1));
        writeFlushReduction(recordPath, { regionChars, stateMessageChars: stateText.length });
        this.bumpEstimate(taskId, 'flush', Math.max(0, regionChars - stateText.length));
      } catch {
        // estimates are best effort
      }
      return `broke: flushed ${plan.removedCount} message(s) - context is now the task brief plus one [broke-state] summary (snapshot ${persistedName}). Undo with /broke flush --undo <n>.`;
    } catch (err) {
      return `broke: flush failed - ${err instanceof Error ? err.message : String(err)}. If a replacement already happened, restore via /broke flush --undo.`;
    }
  }

  /**
   * /broke why - measure the live task context and walk through every gate.
   * Most "the badge is broken" reports are honest zeros: the input never
   * crossed maxContextChars, or everything oversized sits in the protected
   * tail. This makes those cases explicit instead of leaving them silent.
   */
  private async explainWhy(context: ExtensionContext): Promise<string> {
    const config = getConfig();
    const task = context.getTaskContext();
    if (!task) return 'broke why - run this inside a task';
    let messages: ContextMessage[];
    try {
      messages = (await task.getContextMessages()) ?? [];
    } catch (err) {
      return `broke why - could not read context messages (${err instanceof Error ? err.message : String(err)})`;
    }
    const totalChars = messagesChars(messages);
    const userTurns = messages.filter((m) => m.role === 'user').length;
    const { start, end } = compressibleRange(messages, config.protectedTurns);
    const hasOldContent = start < end;
    const regionChars = messagesChars(messages.slice(start, end));
    const stats = this.statsFor(context);
    const observation = this.lastObservation.get(task.data.id);

    const lines = [
      'broke why - gate-by-gate verdict for this task',
      '  scope: conversation messages ONLY - system prompt & tool schemas are never measured or compressed',
      `  pipeline: ${config.enabled ? 'enabled' : 'DISABLED (/broke on)'} | level: ${config.level} | threshold: ${config.maxContextChars.toLocaleString('en-US')} chars (≈ ${estimateTokens(config.maxContextChars).toLocaleString('en-US')} tokens est.)`,
      `  current context: ${messages.length} message(s), ${totalChars.toLocaleString('en-US')} chars (≈ ${estimateTokens(totalChars).toLocaleString('en-US')} tokens), ${userTurns} user turn(s)`,
      userTurns < config.protectedTurns
        ? `  protection: only ${userTurns} turn(s) -> ACTIVE_TURN_TAIL keeps the last ${ACTIVE_TURN_TAIL} message(s) untouched`
        : `  protection: last ${config.protectedTurns} user turn(s) kept untouched`,
      hasOldContent
        ? `  compressible region: msgs #${start}..#${end} (${regionChars.toLocaleString('en-US')} chars)`
        : '  compressible region: none - everything is protected',
    ];
    if (!config.enabled) {
      lines.push('  verdict: pipeline disabled - nothing will be compressed or recorded (/broke on).');
    } else if (!shouldCompress(messages, config)) {
      lines.push('  verdict: nothing to process - the context is below every compression threshold (enabled passes will no-op).');
    } else if (hasOldContent && totalChars > config.maxContextChars) {
      lines.push(
        `  verdict: ABOVE threshold with compressible history - lossy passes engage on the next model call. Savings depend on items exceeding per-item limits (truncate: ${config.truncate.maxLines} lines / ${config.truncate.maxKB} KB, tool inputs > ${config.truncate.maxInputChars.toLocaleString('en-US')} chars${config.level === 'summarize' ? `, summarize regions ≥ ${config.summarize.minChars.toLocaleString('en-US')} chars` : ''}).`,
      );
    } else if (!hasOldContent && totalChars > config.maxContextChars) {
      lines.push('  verdict: above threshold but everything is protected - wait for more turns/messages or lower /broke protect.');
    } else {
      lines.push(
        `  verdict: input is ${(config.maxContextChars - totalChars).toLocaleString('en-US')} chars below the threshold - broke stays idle (an honest 0 on the badge). Engage earlier with /broke maxchars <n>.`,
      );
    }
    // Per-pass zero explanations (why is structural/error at 0 in a run that
    // clearly saved millions of chars?). Data-driven where possible.
    if (stats && stats.passes > 0) {
      const saved = stats.savedChars;
      if (saved.truncate + saved.summarize > 0 && saved.structural === 0) {
        lines.push(
          '  structural: 0 is honest - it counts only REMOVED adjacent duplicate tool results and empty messages; merged message framing never counts as savings (anti-phantom rule)',
        );
      }
      if (saved.error === 0 && (config.level === 'truncate' || config.level === 'summarize') && config.errors.enabled) {
        const biggest = scanBiggestCommandResultChars(messages);
        if (biggest < config.errors.minChars) {
          lines.push(
            `  error: 0 so far - the largest command-tool output still in the region is ${biggest.toLocaleString('en-US')} chars (< errors.minChars ${config.errors.minChars.toLocaleString('en-US')}); big failing-test/compiler dumps are what this pass eats`,
          );
        } else {
          lines.push(
            `  error: 0 even though a ${biggest.toLocaleString('en-US')}-char command output exists - none matched the known compiler/test-log patterns; send a sample to broaden coverage`,
          );
        }
      }
    }
    lines.push(
      observation
        ? `  last optimize run: ${Math.max(1, Math.round((Date.now() - observation.at) / 1000))}s ago, input ${observation.inputChars.toLocaleString('en-US')} chars${stats ? `, ${stats.passes} recorded pass(es)` : ''}`
        : '  last optimize run: none since extension load - no model call observed yet',
    );
    return lines.join('\n');
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
    const taskId = context.getTaskContext()?.data.id ?? '';
    const stats = this.statsFor(context);
    const observation = this.lastObservation.get(taskId) ?? null;
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
      lastRunAt: stats?.lastRunAt ?? null,
      maxContextChars: config.maxContextChars,
      // What the last optimize run saw - including no-op runs. A zero badge
      // can then say "31k of 60k chars" instead of a bare, suspicious 0.
      observation: observation
        ? {
            at: observation.at,
            inputChars: observation.inputChars,
            inputTokens: estimateTokens(observation.inputChars),
            belowThreshold: observation.inputChars <= config.maxContextChars,
          }
        : null,
      savedTokens: {
        structural: stats ? estimateTokens(stats.savedChars.structural) : 0,
        error: stats ? estimateTokens(stats.savedChars.error) : 0,
        truncate: stats ? estimateTokens(stats.savedChars.truncate) : 0,
        summarize: stats ? estimateTokens(stats.savedChars.summarize) : 0,
        slice: stats ? estimateTokens(stats.savedChars.slice) : 0,
      },
      // Counterfactual/one-shot estimates - the badge tooltip labels them
      // explicitly as NOT counted in totalSavedTokens above (E5 honesty).
      estimates: stats
        ? {
            slice: estimateTokens(stats.savedChars.slice),
            flush: estimateTokens(stats.estimates?.flush ?? 0),
            search: estimateTokens(stats.estimates?.search ?? 0),
          }
        : null,
      totalSavedTokens: totalTokens,
      summarizeFailures: stats?.summarizeFailures ?? 0,
      summarizeDisabled: this.summarizeDisabled.get(taskId) === true,
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
