# Project Overview

*Snapshot: v0.3.0 + unreleased fixes (2026-08-16)*

## What broke is

A token-budget extension for AiderDesk. It compresses the conversation input
**before every model call**, in three depth levels, and can run the
summarization pass on a **free local model** (Ollama) instead of the task's
expensive model. The stored task history is never rewritten, compression
applies to the input of each model call only.

| Level | What happens | Loss |
|---|---|---|
| `structural` | drop empty messages, dedupe identical adjacent tool results, merge consecutive assistant texts | none (lossless) |
| `truncate` (default) | + error compression of compiler/test output (tsc, Python/pytest, Jest/Vitest, Node stack traces) + head/tail truncation of old tool outputs, trimming of oversized tool-call inputs | middle of old outputs, error-dump detail |
| `summarize` | + replace old conversation turns with a dense summary, via local Ollama (default, 0 cloud tokens) or a cloud model | detail of old turns |

## Module map

| File | Lines | Responsibility |
|---|---|---|
| `index.ts` | 495 | Extension entry: `class Broke implements Extension`, `onOptimizeMessages` (core pipeline, summarize auto-disable gate), `onToolFinished` (optional tool-level rewrite), `onTaskInitialized` (activation notice), `getCommands` (`/broke …`), `getUIComponents` (💸 badge), config API (`getConfigComponent` / `getConfigData` / `saveConfigData`) |
| `compress.ts` | 797 | Core pipeline: `compressibleRange` (region protection), `structuralPass`, `truncatePass`, `errorPass` (command tools only), `summarizePass` (rich-part skip, `maskSecrets` + prompt-injection hardening), `compressMessages` (with `CompressOptions` gate) |
| `errors.ts` | 365 | Error compressor: detects tsc / pytest / Jest / Vitest / Node stack traces in `text` **and** structured `json`/`content` outputs (`{ stdout, stderr, exitCode }`), extracts the diagnostic essence, archives full output at tool level; `isCommandTool` classification |
| `config.ts` | 182 | Zod schema, defaults, atomic `config.json` writes, cache invalidation, corrupted-config warning |
| `commands.ts` | 224 | `/broke` parser + all subcommands (status, stats, reset, selftest, help, level/threshold/limit tuning) |
| `tokens.ts` | 178 | Token estimation (chars/4), part text extraction (incl. `error-json`), per-task stats persisted to `stats.jsonl` (rotation > 5 MB, real reset) |
| `local.ts` | 135 | Ollama HTTP client (`requestJson`: fetch + body read inside ONE abort window, so stalled responses fail fast), plaintext-remote-URL detection |
| `selftest.ts` | 151 | `/broke selftest`: synthetic conversation, forced-low thresholds, per-pass savings |
| `ConfigComponent.jsx` | 177 | Settings dialog (gear icon on the extension card) |
| `StatusBadge.jsx` | 64 | 💸 badge in the task status bar, per-pass breakdown in the tooltip, shows the summarize auto-disable state |
| `tests/compress.test.ts` | 734 | Unit tests: region computation, structural/truncate/error passes, summary handling, rich-part skip, summarize gate |
| `tests/errors.test.ts` | 414 | Unit tests: error extraction for plain + structured outputs, command-tool guard, `isCommandTool` classification |
| `tests/local.test.ts` | 137 | HTTP round-trip tests against a local server: success, HTTP errors, body errors, stalled-body timeouts |
| `tests/pricing.test.ts` | 65 | Unit tests: cost-savings math (`savedCostUsd`, `priceLabel`), stats privacy |

## How the pipeline works

`onOptimizeMessages` fires before every model call. Four passes run over
everything older than the protected region:

1. **structural**: drop empty messages, dedupe identical adjacent tool
   results, merge consecutive assistant texts (lossless).
2. **errors** (F1): compiler/test output becomes its diagnostic essence
   with an explicit `… [broke: error summary - N lines → M lines]` marker.
   Engages per-message above `errors.minChars` (default 8000), before
   truncate. Only command/compiler/test tools are compressed (same
   `isCommandTool` guard as the tool-level path): file reads, search
   results and docs that merely look like errors are never rewritten.
   Optionally rewrites stored history at tool level
   (`errors.toolLevel`, archives originals under `<extension>/errors/`).
3. **truncate**: old tool outputs over 200 lines / 20 KB → head+tail with
   marker; tool-call inputs over 2000 chars → `__broke` preview.
4. **summarize**: region ≥ `afterTurns` (8) user turns and input above
   `maxContextChars` (60000 ≈ 15k tokens) → one `[broke-compacted]`
   summary message, cached per task (tool-loop steps append to the cache;
   regeneration only on new user turns or ≥ `minChars` of new content).
   Regions carrying images, file attachments or reasoning parts are
   skipped entirely (never silently dropped); truncate still shrinks
   their text parts.

Protected: the task brief (first user message) and the last `protectedTurns`
(2) user turns; sessions with fewer user turns protect only the current step
(last 5 messages). After 3 consecutive summarize failures the pass
auto-disables for that task (badge shows the state); a successful summary,
`/broke reset` or a summarizer backend/model change re-enables it.

## Measured impact

bmad-build run (2026-08-13, 3 tasks, 543 compression passes,
deepseek-v4-flash): up to ~268k tokens removed from a single call's input;
~55 Mio tokens cumulative across all calls; run cost ~0.29 $ on DeepSeek.
Caveat: run used v0.2.0, before the structured-output error-compression fix.

## Commands / verification / deploy

- Commands: `npm run typecheck` (tsc --noEmit), `npm test` (tsx --test)
- Conventions: Conventional Commits, Keep a Changelog, SemVer + annotated tags
- Deploy: `.\scripts\deploy.ps1 -Category extensions -Name broke` (from
  this repo) → `~/.aider-desk/extensions/broke/`
- Runtime deps: AiderDesk >= 0.77, Node >= 18, `zod`; Ollama for
  `summarize via local`

## Docs

- `docs/token-saving.md`: full lever list
- `docs/aiderdesk-builtin.md`: AiderDesk's built-in token savings (verified from source)
- `docs/local-models.md`: local-model capabilities on this hardware (RTX 3050, 4 GB VRAM)
- `docs/feats.md`: specs for F2 ST-slicing, F3 state snapshotting/memory flushing, F4 local keyword/vector index (F1 shipped in v0.2.0)
- `docs/review-backlog.md`: open findings from the 2026-08-16 review (severity, location, fix approach)
