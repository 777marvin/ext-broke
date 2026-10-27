# Project Overview

*Snapshot: release v1.3.3 (2026-09-28), the published documentation-gate
baseline. Development additions reviewed at 1.3.4-dev on 2026-10-22 include
Unreleased AiderDesk 0.88 message-preparation support, F6's live status and
savings breakdown, and F7.1's everyday badge view. F7.2 guided setup and
readiness is also implemented under Unreleased, with live-host smoke and
non-expert usability checks still open. The changelog records
v1.3.3 as the first published release containing the documentation-gate work
of v1.3.1 and v1.3.2; neither of those earlier tags was published. See
[CHANGELOG](../CHANGELOG.md) for release history and
[feature status](roadmap.md) for
remaining work.*

*This file deliberately carries no per-module line counts and no test-count
prose: hand-maintained numbers drift silently and were already two releases
stale. Run `npm test` and `wc -l` for the current figures.*

## What broke is

A token-budget extension for AiderDesk. It can compress eligible older
conversation messages on model calls, in three depth levels, and can run the
summarization pass on local Ollama without an extra cloud summarizer request.
The stored task history is not rewritten by the input
pipeline, compression applies to the input of each model call only. Since
1.2.0 the optional cache-friendly mode preserves already-sent bytes to help
provider prompt-cache reuse, without guaranteeing hits (sent-ledger, escape hatch
with hysteresis, provider-reported cache tokens in the measure ledger).
It targets AiderDesk 0.88 and newer (the message-preparation hooks) and adds
`/broke diff` (a budgeted digest of the uncommitted changes) to the command
surface.

| Level | What happens | Loss |
|---|---|
| `structural` | drop empty messages, dedupe identical adjacent tool results (producing tool-call must match, XF1), merge consecutive assistant texts | text preserved; message framing may change (content-preserving) |
| `truncate` (default) | + error compression of compiler/test output (tsc, Python/pytest, Jest/Vitest, Node stack traces) + head/tail truncation of old tool outputs, trimming of oversized tool-call inputs | middle of old outputs, error-dump detail |
| `summarize` | + replace eligible old turns with a summary, via local Ollama (default, no cloud summarizer call) or a cloud model | detail of old turns |

## Module map

| File | Responsibility |
|---|---|
| `indexer.ts` | F4 local keyword index (0.10.0): identifier tokenizer, incremental mtime/size merge (bounded scan: `search.scanBudgetMs` wall-clock budget + per-merge document cap for the O(all-terms) delete path, INDEX_MAX_ENTRIES cap), BM25 ranking, live snippet windows (mergeWindows/renderSnippet), total char-budget enforcement per query (footer included, BRK-017), builtAt/scannedAt freshness split (TTL measures the last freshness CHECK), atomic index/<projectHash>/index.json persistence (unique tmp + file/parent fsync) (postings + metadata ONLY, corruption-tolerant load; persisted relPaths are confinement-validated, the project root is re-checked, projectHash is a 64-bit SHA-256 prefix with legacy-dir cleanup, F-09), dirOverride isolation for tests; never throws upward |
| `index.ts` | Extension entry: class Broke implements Extension, onLoad (BRK-016 one-time legacy-data migration before the first config read; BRK-029 starts the Ollama status probe in the background), onOptimizeMessages (core pipeline, shouldCompress content gate F-10, summarize auto-disable gate, reentry guard), onTransformMessages (pre-transform baseline observation, 0.88), onApplyCacheControl (frozen-prefix cache breakpoint, opt-in, Anthropic, 0.88), onToolFinished (optional tool-level rewrite + F3 test-green trigger), onAfterCommit (snapshot milestones), onTaskInitialized (activation notice), getCommands (thin wrapper over executeBrokeCommand, the single /broke command surface incl. snapshots, flush, update wiring, config-watcher close/reopen for the folder swap), executeUIExtensionAction incl. the allowlisted `runCommand` used by the badge Quick Commands, getTools (broke-search tool + throttled index refresh off commit signals), getUIComponents (badge), config API (getConfigComponent/getConfigData/saveConfigData), per-run measurement persistence in recordReport (incl. the 0.88 `anchored`/`anchorIndex`/`baselineChars` fields); on AiderDesk >= 0.80 the watcher is additionally registered via context.addDisposable() so disable/uninstall releases the directory handle |
| `compress.ts` | Core pipeline: `compressibleRange` (region protection), `shouldCompress` content gate (F-10), `structuralPass`, `truncatePass`, `errorPass` (command tools only), `summarizePass` (rich-part skip, `maskSecrets` + disclosure telemetry + extended secret patterns F-13, hierarchical chunked summarization with 8+1 call budget F-07, content-fingerprinted summary cache F-06), `compressMessages` (with `CompressOptions` gate). Since 1.2.0 cache-friendly mode: `frozen` predicate keeps sent bytes byte-identical in passes 1-3, escape hatch with hysteresis (one deliberate rewrite per budget crossing, `escape.locked` released by an under-budget run), summarize gated on sent bytes in BOTH the generate and the cache-reuse branch (byte-stable incremental shape forced, history edits ship untouched, `frozenSkip` reports a frozen refusal instead of a silent no-op) |
| `output.ts` | Canonical tool-output text extraction (F10): `extractOutputText` (part + event-output shapes, `eventOutput`/`serializeJson` options) and `partText`. The single place that knows output shapes, everything else goes through it |
| `errors.ts` | Error compressor: detects tsc / pytest / Jest / Vitest / Node stack traces in the text extracted via `output.ts` (plain `text` **and** structured `json`/`content` outputs shaped `{ stdout, stderr, exitCode }`), builds the diagnostic essence, archives full output at tool level (hash-suffixed names, size-capped dir, retention sweep, archive on/off, XF9/XF10); `isCommandTool` classification |
| `config.ts` | Zod schema (incl. the per-field bounds the settings dialog mirrors), defaults, fsynced atomic `config.json` writes, cache invalidation, corrupted-config warning; `stats.measure` and `search.scanBudgetMs` toggles/knobs |
| `cache.ts` | Sent-ledger (cache-friendly mode 1.2.0): per-task content-hash set (SHA-256 over {role, content, toolCallId}) of bytes already sent to the model, `markSent`/`isSent`/`clearTask`, FIFO 2000 entries per task, task LRU 50 - false "sent" only costs one compression chance, false "not sent" would bust the cache; `frozenPrefixLength` (longest leading already-sent run) and `messageFingerprint` (the ledger's content key, reused to re-locate a message across an array the HOST rebuilt) serve the 0.88 frozen-prefix anchor |
| `cachecontrol.ts` | 0.88 `onApplyCacheControl` helper: `anchorBreakpoint` adds an Anthropic `cache_control` breakpoint (`providerOptions.anthropic.cacheControl`) on a chosen message, merging into that message's existing `providerOptions` without mutating the input; the host's existing tail marker is not removed |
| `paths.ts` | BRK-016 runtime-path decision: `runtimeDir()` = `BROKE_DATA_DIR` override, else the versioned `<extension>/../.broke-data/v1` sibling of the installation (outside the swap path); one-time marker-guarded best-effort migration of legacy artifacts (config.json, ledgers, snapshots, index, errors) with no-overwrite and EXDEV copy-then-remove fallback; injectable paths for hermetic tests |
| `commands.ts` | `/broke` parser + all subcommands (status/why, stats with measured-reduction headline, estimate, measure, reset, selftest, update, snapshot/flush, index/search, level/threshold/limit tuning, help); help text generated from `DEFAULT_CONFIG`; `formatMeasure` (sum-over-runs framing) |
| `update.ts` | Self-update: resolves tagged GitHub release assets, verifies an Ed25519-signed SHA256SUMS manifest before extraction, rebuilds runtime dependencies from the lockfile, and keeps runtime data outside the installation tree. Uses a rename-based swap when possible; Windows file locks can require an in-place fallback with verification and attempted rollback. A crash during that fallback remains an accepted limitation. |
| `tokens.ts` | Token estimation (chars/4), measured vs. modeled-counterfactual savings categories (BRK-022), per-task stats persisted to `stats.jsonl` (rotation > 5 MB, real reset, TTL-cached loader); measurement ledger `measure.jsonl` (`RunRecord`, per-run persistence + rotation, loader, summary aggregation) |
| `local.ts` | Ollama HTTP client (`requestJson`: fetch + body read inside ONE abort window, so stalled responses fail fast), plaintext-remote-URL detection |
| `validate.ts` | ContextValidator (external review P0): pure provider-bound invariant checks - no duplicate tool-call/result ids, no orphaned calls or results; `compressMessages` reverts to the original input when its output violates invariants that the input did not have |
| `slice.ts` | ST-slicing (opt-in, 0.7.0): heuristic TS/Python interface-view extraction, fail-open on uncertainty: exported initializers kept whole (no unparseable stubs), public/protected fields + overload signatures kept, case-folding Windows-only, regex-escaped focus symbols (BRK-020); focus resolution + tool detection helpers |
| `snapshot.ts` | F3 milestone snapshots: `snapshot [label]` records + onCommit/onTestPass triggers, summary-only records by default (`snapshot.keepHistory` off; the destructive flush keeps its undo file via `flush.undo`, D1), per-task 25 MB byte budget and 10 MB undo-file cap with size-aware eviction of the oldest record+history pairs (F-14), owner-only permissions (0600/0700), count-based rotation; ALL conversation-derived fields masked incl. taskName/files, collision-free hashed task dirs + unique filenames, readHistory refuses unexpected names/paths/shapes (BRK-019) |
| `scripts/sign-release.mjs` | Release artifact signing: sha256sum manifest + Ed25519 signature (`BROKE_RELEASE_SIGNING_KEY`, CI-only) |
| `.github/workflows/release.yml` | Tag-push release pipeline (BRK-007/008): full CI gate runs on the exact tagged commit (reusable workflow_call), then `release-sign-and-publish.yml` is called PINNED TO `@main` - the signing code always comes from protected main, never from the tag; ancestor check against origin/main, `environment: release` approval gate, assets built by `git archive` of the tag (the ONLY supported release path since 0.8.0) |
| `.github/workflows/release-sign-and-publish.yml` | BRK-008 callee: signs the tag-built archive and publishes release assets + SHA256SUMS + signature; requires the `release` environment approval |
| `pricing.ts` | Cost estimates from the task model's registered input price; cache multipliers are modeled assumptions, including a fixed OpenAI 0.5x read rate that varies by model in actual provider pricing |
| `selftest.ts` | `/broke selftest` (advanced diagnostics): synthetic conversation with real tool-call ids, forced-low thresholds, stub summarizer and per-pass savings; separate from the badge's metadata readiness check |
| `setup.ts` | Shared configuration/metadata readiness for badge and CLI, consent-gated Ollama model checks, and bounded atomic introduction-dismissal persistence under runtime `setup.json`; never generates summaries |
| `scripts/bench.ts` | Deterministic reference benchmark (npm run bench): a 351,403-char synthetic session through the real pipeline with a stub summarizer, byte-reproducible; F4 keyword-index scenario for the counterfactual estimate model |
| `scripts/measure.ts` | `npm run measure`: CLI wrapper that loads `measure.jsonl` and prints `formatMeasure` |
| `ConfigComponent.jsx` | Settings dialog (gear icon on the extension card), schema-bounded numeric fields, measurement toggle |
| `StatusBadge.jsx` | 💸 badge in the task status bar, per-pass breakdown in the tooltip, shows the summarize auto-disable state; always renders; the 10 s poll runs only while a summarizer backend is active (BRK-029), push refreshes cover the rest |
| `tests/index.test.ts` | Fake-host integration tests (XF11): real extension against a fake ExtensionContext/task, compression + stats/measure persistence, reentry guard, summarize auto-disable, tool-level archiving on/off, silence when disabled |
| `tests/commands.test.ts` | Unit tests: `/broke` parse/apply/format (incl. `update` subcommands), generated help text, Ollama model-tag matching, measure parsing + `formatMeasure` |
| `tests/measure.test.ts` | Unit tests: run-record mapping, ledger append/rotation/malformed-skip, summary math incl. summarizer cost side (mean/median/max/byTask) |
| `tests/compress.test.ts` | Unit tests: region computation, structural/truncate/error passes, summary handling, rich-part skip, summarize gate, secret masking |
| `tests/config.test.ts` | Unit tests: config merge, corrupted-file fallback, pure updates, one-write multi-path persistence |
| `tests/errors.test.ts` | Unit tests: error extraction for plain + structured outputs, command-tool guard, `isCommandTool` classification, archive cap/retention/clear |
| `tests/local.test.ts` | HTTP round-trip tests against a local server: success, HTTP errors, body errors, stalled-body timeouts; remote-host classification (`isRemoteOllamaHost`) |
| `tests/pricing.test.ts` | Unit tests: cost-savings math (`savedCostUsd`, `priceLabel`), stats persistence privacy, stats loader TTL, task-stats reset |
| `tests/selftest.test.ts` | Unit tests: synthetic-call-id linking, dedupe really applied, honest per-pass labels |
| `tests/update.test.ts` | Unit tests: self-update flow with injected deps - release ASSET resolution + semver fallback, tag validation, strict signed-release trust model (refuses unsigned/tampered), happy-path swap with state preservation, check mode, explicit downgrade/reinstall, extract/npm failure aborts, git-checkout guard, concurrency lock, stale-backup recovery, in-place fallback, errors-archive size cap (sparse file), mid-staging rename-lock rollback, partial-copy detection via the manifest check, swap manifest-mismatch rollback, merge-over fallback for unmovable directories/files with pruning, merged-entry snapshot rollback |
| `tests/validate.test.ts` | Unit tests: ContextValidator invariants (duplicates/orphans/format failures) + compressMessages revert semantics (output-broken reverts, input-corrupt ships) |
| `tests/host-contract.test.ts` | Full lifecycle contract with a fake host: TaskInitialized -> ToolCalled -> ToolFinished -> OptimizeMessages state flow + never-break-the-host guarantees under hostile surfaces |
| `tests/update-signing.test.ts` | Signature/checksum primitives against an isolated test keypair (verifySumsSignature, checksumFromSums, defaultVerifyRelease failure paths) |
| `tests/slice.test.ts` | Unit tests: TS/Python slicing, focus resolution, tool detection, fail-safe export pass-through regression matrix (R6) |
| `tests/snapshot.test.ts` | F3 unit tests: record assembly, masking, persistence/rotation/undo files, the pure flush planner, the conservative test-green heuristic |
| `tests/bench.test.ts` | Unit tests: the bench workload builder and F4 scenario pin the documented reference figures |
| `tests/indexer.test.ts` | F4 unit tests: tokenizer, incremental merge + delta accounting, merge-budget exhaustion, scan policy + privacy filters (BRK-003), confinement validation + foreign-root rebuild (F-09), BM25 ranking, snippet windows, budget enforcement, persistence round-trip, TTL freshness split (BRK-017) |
| `tests/paths.test.ts` | BRK-016 unit tests: BROKE_DATA_DIR override, default sibling path, migration + idempotency, no-overwrite against newer data, fresh-install no-op |
| `tests/ollama-gating.test.ts` | BRK-029 tests against a fake Ollama HTTP server: no probing when the level is not summarize or the extension is disabled, in-flight probe deduplication, non-blocking task initialization, cache-aware init line, gated badge poll |
| `tests/ui-contract.test.ts` | Vendored host UI contract pinned against the installed @aiderdesk/extensions version; JSX components validate against real prop shapes (BRK-024) |

## How the pipeline works

<p align="center">
  <img src="assets/broke-pipeline.gif" alt="Animated broke pipeline: eligible older context is cleaned, trimmed, and optionally summarized locally before a smaller payload is sent to the model; the first request, recent turns, and stored task history stay protected" width="960">
</p>

<p align="center"><sub>Only the next model payload is reduced. Stored task history remains unchanged.</sub></p>

`onOptimizeMessages` fires before every model call. Three progressive stages (Clean, Trim, and optional Summarize) run over eligible older context:

1. **Clean (`structural`)**: drop empty messages, dedupe identical adjacent tool
   results (only when the producing tool-call, name and input, matches
   too, XF1), merge consecutive assistant texts (text survives, framing
   may change).
2. **Trim (`truncate` & `errors` F1)**:
   - **errors**: compiler/test output becomes its diagnostic essence
   with an explicit `… [broke: error summary - N lines → M lines]` marker.
   Engages per-message above `errors.minChars` (default 8000), before
   truncate. Only command/compiler/test tools are compressed (same
   `isCommandTool` guard as the tool-level path): file reads, search
   results and docs that merely look like errors are never rewritten.
   Optionally rewrites stored history at tool level
   (`errors.toolLevel`, archives originals under `<extension>/errors/`;
   the archive can be switched off entirely and is retention-swept,
   default 30 days, XF10).
   - **truncate**: old tool outputs → head+tail with marker under combined
   hard limits (≤ 200 lines AND ≤ 20 KB after the cut, XF5); tool-call
   inputs over 2000 chars → `__broke` preview.
3. **Summarize (`summarize`)**: region ≥ `afterTurns` (8) user turns (or a region with
   NO user turn at all - autonomous single-prompt tool loops - which would
   otherwise never qualify) and input above
   `maxContextChars` (60000 ≈ 15k tokens) → one `[broke-compacted]`
   summary message, cached per task and re-validated against the region's
   content fingerprint (F-06: backend/model changes invalidate the cache,
   tool-loop steps append to it; regeneration only on new user turns or ≥
   `minChars` of new content). Regions larger than the summarizer input
   cap are chunked at message boundaries and summarized hierarchically
   (F-07): each chunk within the cap, one meta-call combining the parts,
   hard budget of 8 part + 1 meta calls; messages beyond the budget stay
   verbatim and the marker states the coverage ("Summarized X of Y
   messages"). Regions carrying images, file attachments or reasoning parts
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
Together with the badge and `/broke stats`, these are observations of
conversation-message character counts in real runs, not provider billing data.

## Commands / verification / deploy

- Commands: `npm run typecheck` (tsc --noEmit), `npm test` (tsx --test),
  `npm run bench` (reference benchmark, see above), `npm run measure`
  (analyze measure.jsonl, `--file=<path>` for another file),
  `npm run validate:ui` (JSX UI components, syntax + prop types; vendored
  AiderDesk validator script)
- Conventions: Conventional Commits, Keep a Changelog, SemVer + annotated tags
- Compatibility: the declared API line is `@aiderdesk/extensions` ^0.38.0
  (see package.json; the SDK that ships with AiderDesk 0.88); CI runs
  typecheck + tests against both the lockfile and `@latest` so API drift is
  caught on every push. Host floor: AiderDesk >= 0.88, the release that
  dispatches the message-preparation hooks broke relies on
  (`onTransformMessages`, `onOptimizeMessages`, `onApplyCacheControl`)
  (`docs/aiderdesk-builtin.md` carries the per-version SDK table)
- Deploy / update: installed instances update themselves via `/broke
  update` (installs the latest tagged release from GitHub; `update check`
  peeks, `update <vX.Y.Z>` pins or rolls back). `.\scripts\deploy.ps1
  -Category extensions -Name broke` (from this repo) →
  `~/.aider-desk/extensions/broke/` stays the bootstrap for fresh machines
  and the dev loop for uncommitted changes (`/broke update` refuses git
  checkouts by design)
- Runtime deps: AiderDesk >= 0.88, Node >= 22 (see `engines` in
  package.json), `zod`; Ollama for `summarize via local`

## Docs

- `docs/token-saving.md`: full lever list
- `docs/aiderdesk-builtin.md`: AiderDesk's built-in token savings (verified from source)
- `docs/local-models.md`: local Ollama setup and measurement limits
- `docs/roadmap.md`: shipped features, current focus, proposed candidates
- `docs/roadmap.md`: shipped features, current focus, proposed candidates
