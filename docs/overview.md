# Project Overview

*Snapshot: v0.8.0 (2026-08-26), review rounds F1-F24 + XF1-XF16 closed and
external review R1-R14 dispositioned, suite 299/299 green*

## What broke is

A token-budget extension for AiderDesk. It compresses the conversation input
**before every model call**, in three depth levels, and can run the
summarization pass on a **free local model** (Ollama) instead of the task's
expensive model. The stored task history is never rewritten by the input
pipeline, compression applies to the input of each model call only.

| Level | What happens | Loss |
|---|---|---|
| `structural` | drop empty messages, dedupe identical adjacent tool results (producing tool-call must match, XF1), merge consecutive assistant texts | text preserved; message framing may change (content-preserving) |
| `truncate` (default) | + error compression of compiler/test output (tsc, Python/pytest, Jest/Vitest, Node stack traces) + head/tail truncation of old tool outputs, trimming of oversized tool-call inputs | middle of old outputs, error-dump detail |
| `summarize` | + replace old conversation turns with a dense summary, via local Ollama (default, 0 cloud tokens) or a cloud model | detail of old turns |

## Module map

| File | Lines | Responsibility |
|---|---|---|
| `index.ts` | 897 | Extension entry: `class Broke implements Extension`, `onOptimizeMessages` (core pipeline, summarize auto-disable gate, reentry guard), `onToolFinished` (optional tool-level rewrite), `onTaskInitialized` (activation notice), `getCommands` (`/broke …` incl. measure + self-update wiring, config-watcher close/reopen for the folder swap), `getUIComponents` (💸 badge), config API (`getConfigComponent` / `getConfigData` / `saveConfigData`), per-run measurement persistence in `recordReport`; on AiderDesk ≥ 0.80 the watcher is additionally registered via `context.addDisposable()` so disable/uninstall releases the directory handle |
| `compress.ts` | 936 | Core pipeline: `compressibleRange` (region protection), `structuralPass`, `truncatePass`, `errorPass` (command tools only), `summarizePass` (rich-part skip, `maskSecrets` + prompt-injection hardening), `compressMessages` (with `CompressOptions` gate) |
| `output.ts` | 149 | Canonical tool-output text extraction (F10): `extractOutputText` (part + event-output shapes, `eventOutput`/`serializeJson` options) and `partText`. The single place that knows output shapes, everything else goes through it |
| `errors.ts` | 434 | Error compressor: detects tsc / pytest / Jest / Vitest / Node stack traces in the text extracted via `output.ts` (plain `text` **and** structured `json`/`content` outputs shaped `{ stdout, stderr, exitCode }`), builds the diagnostic essence, archives full output at tool level (hash-suffixed names, size-capped dir, retention sweep, archive on/off, XF9/XF10); `isCommandTool` classification |
| `config.ts` | 253 | Zod schema, defaults, fsynced atomic `config.json` writes, cache invalidation, corrupted-config warning; `stats.measure` toggle |
| `commands.ts` | 426 | `/broke` parser + all subcommands (status, stats with measured-reduction headline, measure, reset, selftest, update, help, level/threshold/limit tuning); help text generated from `DEFAULT_CONFIG`; `formatMeasure` (sum-over-runs framing) |
| `update.ts` | 820 | Self-update (`/broke update`): resolves the latest tagged GitHub release (`releases/latest`, fallback highest-semver tag), strict `vMAJOR.MINOR.PATCH` tag validation before any URL use, tarball download with timeouts + size cap, system-`tar` extraction, runtime-state preservation (config.json, stats/measure ledgers incl. rotation files, errors/ ≤ 100 MB, node_modules), automatic `npm ci --omit=dev` on lockfile change, atomic swap with rollback plus in-place replacement when a Windows handle pins the directory; rename retries for transient locks (~4 s staggered), merge-over fallback for persistently locked entries (snapshot by copy, merged over, pruned back to payload contents), byte-size manifest verification of the copied payload before success is declared (.deployed-version is written only then), complete rollback on every failure path, non-fatal leftover-backup cleanup; git-checkout guard, concurrency lock; all I/O injectable for hermetic tests. Since 0.8.0 (R1): installs ONLY release ASSETS - Ed25519-signed SHA256SUMS verified against the embedded public key plus checksum match BEFORE extraction/npm ci; unsigned (pre-0.8.0) releases are refused |
| `tokens.ts` | 383 | Token estimation (chars/4), per-task stats persisted to `stats.jsonl` (rotation > 5 MB, real reset, TTL-cached loader); measurement ledger `measure.jsonl` (`RunRecord`, per-run persistence + rotation, loader, summary aggregation) |
| `local.ts` | 142 | Ollama HTTP client (`requestJson`: fetch + body read inside ONE abort window, so stalled responses fail fast), plaintext-remote-URL detection |
| `validate.ts` | 75 | ContextValidator (external review P0): pure provider-bound invariant checks - no duplicate tool-call/result ids, no orphaned calls or results; `compressMessages` reverts to the original input when its output violates invariants that the input did not have |
| `slice.ts` | 730 | ST-slicing (opt-in, 0.7.0): heuristic TS/Python interface-view extraction; unrecognized top-level `export`/`declare` statements pass through in full (R6 fail-safe); focus resolution + tool detection helpers |
| `scripts/sign-release.mjs` | 78 | Release artifact signing: sha256sum manifest + Ed25519 signature (`BROKE_RELEASE_SIGNING_KEY`, CI-only) |
| `.github/workflows/release.yml` | 55 | Tag-push release pipeline: byte-stable `git archive` artifact -> signed manifest -> GitHub release assets (the ONLY supported release path since 0.8.0) |
| `pricing.ts` | 91 | Cost-savings math (`savedCostUsd`, `formatUsd`, `priceLabel`), task model price resolution |
| `selftest.ts` | 194 | `/broke selftest`: synthetic conversation with real tool-call ids, forced-low thresholds, per-pass savings |
| `scripts/measure.ts` | 25 | `npm run measure`: CLI wrapper that loads `measure.jsonl` and prints `formatMeasure` |
| `ConfigComponent.jsx` | 210 | Settings dialog (gear icon on the extension card), schema-bounded numeric fields, measurement toggle |
| `StatusBadge.jsx` | 75 | 💸 badge in the task status bar, per-pass breakdown in the tooltip, shows the summarize auto-disable state; always renders and polls every 10 s so a missed push refresh cannot hide it |
| `tests/index.test.ts` | 492 | Fake-host integration tests (XF11): real extension against a fake ExtensionContext/task, compression + stats/measure persistence, reentry guard, summarize auto-disable, tool-level archiving on/off, silence when disabled |
| `tests/commands.test.ts` | 394 | Unit tests: `/broke` parse/apply/format (incl. `update` subcommands), generated help text, Ollama model-tag matching, measure parsing + `formatMeasure` |
| `tests/measure.test.ts` | 214 | Unit tests: run-record mapping, ledger append/rotation/malformed-skip, summary math incl. summarizer cost side (mean/median/max/byTask) |
| `tests/compress.test.ts` | 1017 | Unit tests: region computation, structural/truncate/error passes, summary handling, rich-part skip, summarize gate, secret masking |
| `tests/config.test.ts` | 155 | Unit tests: config merge, corrupted-file fallback, pure updates, one-write multi-path persistence |
| `tests/errors.test.ts` | 540 | Unit tests: error extraction for plain + structured outputs, command-tool guard, `isCommandTool` classification, archive cap/retention/clear |
| `tests/local.test.ts` | 145 | HTTP round-trip tests against a local server: success, HTTP errors, body errors, stalled-body timeouts; remote-host classification (`isRemoteOllamaHost`) |
| `tests/pricing.test.ts` | 191 | Unit tests: cost-savings math (`savedCostUsd`, `priceLabel`), stats persistence privacy, stats loader TTL, task-stats reset |
| `tests/selftest.test.ts` | 51 | Unit tests: synthetic-call-id linking, dedupe really applied, honest per-pass labels |
| `tests/update.test.ts` | 574 | Unit tests: self-update flow with injected deps - release ASSET resolution + semver fallback, tag validation, strict signed-release trust model (refuses unsigned/tampered), happy-path swap with state preservation, check mode, explicit downgrade/reinstall, extract/npm failure aborts, git-checkout guard, concurrency lock, stale-backup recovery, in-place fallback, errors-archive size cap (sparse file), mid-staging rename-lock rollback, partial-copy detection via the manifest check, swap manifest-mismatch rollback, merge-over fallback for unmovable directories/files with pruning, merged-entry snapshot rollback |
| `tests/validate.test.ts` | 186 | Unit tests: ContextValidator invariants (duplicates/orphans/format failures) + compressMessages revert semantics (output-broken reverts, input-corrupt ships) |
| `tests/host-contract.test.ts` | 199 | Full lifecycle contract with a fake host: TaskInitialized -> ToolCalled -> ToolFinished -> OptimizeMessages state flow + never-break-the-host guarantees under hostile surfaces |
| `tests/update-signing.test.ts` | 79 | Signature/checksum primitives against an isolated test keypair (verifySumsSignature, checksumFromSums, defaultVerifyRelease failure paths) |
| `tests/slice.test.ts` | 325 | Unit tests: TS/Python slicing, focus resolution, tool detection, fail-safe export pass-through regression matrix (R6) |

## How the pipeline works

`onOptimizeMessages` fires before every model call. Four passes run over
everything older than the protected region:

1. **structural**: drop empty messages, dedupe identical adjacent tool
   results (only when the producing tool-call, name and input, matches
   too, XF1), merge consecutive assistant texts (text survives, framing
   may change).
2. **errors** (F1): compiler/test output becomes its diagnostic essence
   with an explicit `… [broke: error summary - N lines → M lines]` marker.
   Engages per-message above `errors.minChars` (default 8000), before
   truncate. Only command/compiler/test tools are compressed (same
   `isCommandTool` guard as the tool-level path): file reads, search
   results and docs that merely look like errors are never rewritten.
   Optionally rewrites stored history at tool level
   (`errors.toolLevel`, archives originals under `<extension>/errors/`;
   the archive can be switched off entirely and is retention-swept,
   default 30 days, XF10).
3. **truncate**: old tool outputs → head+tail with marker under combined
   hard limits (≤ 200 lines AND ≤ 20 KB after the cut, XF5); tool-call
   inputs over 2000 chars → `__broke` preview.
4. **summarize**: region ≥ `afterTurns` (8) user turns (or a region with
   NO user turn at all - autonomous single-prompt tool loops - which would
   otherwise never qualify) and input above
   `maxContextChars` (60000 ≈ 15k tokens) → one `[broke-compacted]`
   summary message, cached per task + summarizer-config fingerprint
   (backend/model changes invalidate the cache; tool-loop steps append to
   it; regeneration only on new user turns or ≥ `minChars` of new
   content). Regions carrying images, file attachments or reasoning parts
   are skipped entirely (never silently dropped); truncate still shrinks
   their text parts. The swap is skipped when the summary would grow the
   context (XF6), and the summary body is framed as untrusted
   machine-generated data, not assistant history (XF3).

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
- maximum level (`summarize`): 315,263 chars removed
  (~78,816 tokens, 89.7% of the input).

These replace the earlier published single-session figures (268k / 55 Mio /
0.29 $), which could not be reproduced from raw data and were removed.
The benchmark is a synthetic reference, not a real-session claim.

The real-session counterpart is the measurement ledger: with
`stats.measure` on (default), broke appends one `RunRecord` per real
compression run to `measure.jsonl` (sizes + per-pass removals, no content,
no paths, rotation-capped at 5 MB). `/broke measure` (in a task) or
`npm run measure` (in the extension directory) aggregates the records:
runs, tasks, per-run mean/median/max and per-task breakdowns - explicitly
labeled as a sum over individual runs, not a cumulative context claim.
Together with the badge and `/broke stats`, these are the provable
real-session numbers.

## Commands / verification / deploy

- Commands: `npm run typecheck` (tsc --noEmit), `npm test` (tsx --test),
  `npm run bench` (reference benchmark, see above), `npm run measure`
  (analyze measure.jsonl, `--file=<path>` for another file),
  `npm run validate:ui` (JSX UI components, syntax + prop types; vendored
  AiderDesk validator script)
- Conventions: Conventional Commits, Keep a Changelog, SemVer + annotated tags
- Compatibility: the declared API line is `@aiderdesk/extensions` ^0.31.0
  (see package.json); CI runs typecheck + tests against both the lockfile
  and `@latest` so API drift is caught on every push
- Deploy / update: installed instances update themselves via `/broke
  update` (installs the latest tagged release from GitHub; `update check`
  peeks, `update <vX.Y.Z>` pins or rolls back). `.\scripts\deploy.ps1
  -Category extensions -Name broke` (from this repo) →
  `~/.aider-desk/extensions/broke/` stays the bootstrap for fresh machines
  and the dev loop for uncommitted changes (`/broke update` refuses git
  checkouts by design)
- Runtime deps: AiderDesk >= 0.77, Node >= 22 (see `engines` in
  package.json), `zod`; Ollama for `summarize via local`

## Docs

- `docs/token-saving.md`: full lever list
- `docs/aiderdesk-builtin.md`: AiderDesk's built-in token savings (verified from source)
- `docs/local-models.md`: local-model capabilities on this hardware (RTX 3050, 4 GB VRAM)
- `docs/feats.md`: specs for F2 ST-slicing, F3 state snapshotting/memory flushing, F4 local keyword/vector index (F1 shipped in v0.2.0)
- `docs/review-backlog.md`: findings from the 2026-08-16 review, all closed (severity, location, fix approach, commit mapping)
