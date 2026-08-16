# Project Overview

*Snapshot: v0.3.0 + review fixes F1-F24 closed (2026-08-16)*

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
| `index.ts` | 470 | Extension entry: `class Broke implements Extension`, `onOptimizeMessages` (core pipeline, summarize auto-disable gate, reentry guard), `onToolFinished` (optional tool-level rewrite), `onTaskInitialized` (activation notice), `getCommands` (`/broke …`), `getUIComponents` (💸 badge), config API (`getConfigComponent` / `getConfigData` / `saveConfigData`) |
| `compress.ts` | 744 | Core pipeline: `compressibleRange` (region protection), `structuralPass`, `truncatePass`, `errorPass` (command tools only), `summarizePass` (rich-part skip, `maskSecrets` + prompt-injection hardening), `compressMessages` (with `CompressOptions` gate) |
| `output.ts` | 149 | Canonical tool-output text extraction (F10): `extractOutputText` (part + event-output shapes, `eventOutput`/`serializeJson` options) and `partText`. The single place that knows output shapes, everything else goes through it |
| `errors.ts` | 300 | Error compressor: detects tsc / pytest / Jest / Vitest / Node stack traces in the text extracted via `output.ts` (plain `text` **and** structured `json`/`content` outputs shaped `{ stdout, stderr, exitCode }`), builds the diagnostic essence, archives full output at tool level (hash-suffixed names, size-capped dir); `isCommandTool` classification |
| `config.ts` | 198 | Zod schema, defaults, fsynced atomic `config.json` writes, cache invalidation, corrupted-config warning |
| `commands.ts` | 246 | `/broke` parser + all subcommands (status, stats, reset, selftest, help, level/threshold/limit tuning); help text generated from `DEFAULT_CONFIG` |
| `tokens.ts` | 169 | Token estimation (chars/4), per-task stats persisted to `stats.jsonl` (rotation > 5 MB, real reset, TTL-cached loader) |
| `local.ts` | 127 | Ollama HTTP client (`requestJson`: fetch + body read inside ONE abort window, so stalled responses fail fast), plaintext-remote-URL detection |
| `pricing.ts` | 80 | Cost-savings math (`savedCostUsd`, `formatUsd`, `priceLabel`), task model price resolution |
| `selftest.ts` | 181 | `/broke selftest`: synthetic conversation with real tool-call ids, forced-low thresholds, per-pass savings |
| `ConfigComponent.jsx` | 173 | Settings dialog (gear icon on the extension card), schema-bounded numeric fields |
| `StatusBadge.jsx` | 61 | 💸 badge in the task status bar, per-pass breakdown in the tooltip, shows the summarize auto-disable state |
| `tests/commands.test.ts` | 184 | Unit tests: `/broke` parse/apply/format, generated help text, Ollama model-tag matching |
| `tests/compress.test.ts` | 783 | Unit tests: region computation, structural/truncate/error passes, summary handling, rich-part skip, summarize gate, secret masking |
| `tests/config.test.ts` | 120 | Unit tests: config merge, corrupted-file fallback, pure updates, one-write multi-path persistence |
| `tests/errors.test.ts` | 404 | Unit tests: error extraction for plain + structured outputs, command-tool guard, `isCommandTool` classification, archive cap |
| `tests/local.test.ts` | 125 | HTTP round-trip tests against a local server: success, HTTP errors, body errors, stalled-body timeouts |
| `tests/pricing.test.ts` | 135 | Unit tests: cost-savings math (`savedCostUsd`, `priceLabel`), stats persistence privacy, stats loader TTL, task-stats reset |
| `tests/selftest.test.ts` | 51 | Unit tests: synthetic-call-id linking, dedupe really applied, honest per-pass labels |

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
   summary message, cached per task + summarizer-config fingerprint
   (backend/model changes invalidate the cache; tool-loop steps append to
   it; regeneration only on new user turns or ≥ `minChars` of new
   content). Regions carrying images, file attachments or reasoning parts
   are skipped entirely (never silently dropped); truncate still shrinks
   their text parts.

Protected: the task brief (first user message) and the last `protectedTurns`
(2) user turns; sessions with fewer user turns protect only the current step
(last 5 messages). After 3 consecutive summarize failures the pass
auto-disables for that task (badge shows the state); a successful summary,
`/broke reset` or a summarizer backend/model change re-enables it.

## Reference benchmark

`npm run bench` (scripts/bench.ts) pushes a deterministic 351,403-char
synthetic session (67 messages: long tool loops, a compiler-error dump,
duplicated test runs, protected working-set tail) through the real
pipeline with the shipped defaults and a fixed stub summarizer. No LLM,
no randomness, byte-reproducible:

- shipped default level (`truncate`): 113,070 chars removed
  (~28,268 tokens, 32.2% of the input);
- maximum level (`summarize`): 315,389 chars removed
  (~78,847 tokens, 89.8% of the input).

These replace the earlier published single-session figures (268k / 55 Mio /
0.29 $), which could not be reproduced from raw data and were removed.
The benchmark is a synthetic reference, not a real-session claim; the only
real-session numbers are the badge and `/broke stats` of your own tasks.

## Commands / verification / deploy

- Commands: `npm run typecheck` (tsc --noEmit), `npm test` (tsx --test),
  `npm run bench` (reference benchmark, see above)
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
- `docs/review-backlog.md`: findings from the 2026-08-16 review, all closed (severity, location, fix approach, commit mapping)
