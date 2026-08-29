# Project Overview

*Snapshot: release v1.1.0 (2026-08-29), review rounds F1-F24, XF1-XF16,
R1-R15 and remediation F-01..F-16 closed, external-review findings BRK-001..030 fixed, suite 474/474 green*/

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
| `indexer.ts` | 862 | F4 local keyword index (0.10.0): identifier tokenizer, incremental mtime/size merge (bounded scan, INDEX_MAX_ENTRIES cap), BM25 ranking, live snippet windows (mergeWindows/renderSnippet), total char-budget enforcement per query (footer included, BRK-017), builtAt/scannedAt freshness split (TTL measures the last freshness CHECK), atomic index/<projectHash>/index.json persistence (unique tmp + file/parent fsync) (postings + metadata ONLY, corruption-tolerant load; persisted relPaths are confinement-validated, the project root is re-checked, projectHash is a 64-bit SHA-256 prefix with legacy-dir cleanup, F-09), dirOverride isolation for tests; never throws upward |
| `index.ts` | 1676 | Extension entry: class Broke implements Extension, onLoad (BRK-016 one-time legacy-data migration before the first config read; BRK-029 starts the Ollama status probe in the background), onOptimizeMessages (core pipeline, shouldCompress content gate F-10, summarize auto-disable gate, reentry guard), onToolFinished (optional tool-level rewrite + F3 test-green trigger), onAfterCommit (snapshot milestones), onTaskInitialized (activation notice), getCommands (/broke command switch incl. snapshots, flush, update wiring, config-watcher close/reopen for the folder swap), getTools (broke-search tool + throttled index refresh off commit signals), getUIComponents (badge), config API (getConfigComponent/getConfigData/saveConfigData), per-run measurement persistence in recordReport; on AiderDesk >= 0.80 the watcher is additionally registered via context.addDisposable() so disable/uninstall releases the directory handle |
| `compress.ts` | 1283 | Core pipeline: `compressibleRange` (region protection), `shouldCompress` content gate (F-10), `structuralPass`, `truncatePass`, `errorPass` (command tools only), `summarizePass` (rich-part skip, `maskSecrets` + disclosure telemetry + extended secret patterns F-13, hierarchical chunked summarization with 8+1 call budget F-07, content-fingerprinted summary cache F-06), `compressMessages` (with `CompressOptions` gate) |
| `output.ts` | 155 | Canonical tool-output text extraction (F10): `extractOutputText` (part + event-output shapes, `eventOutput`/`serializeJson` options) and `partText`. The single place that knows output shapes, everything else goes through it |
| `errors.ts` | 479 | Error compressor: detects tsc / pytest / Jest / Vitest / Node stack traces in the text extracted via `output.ts` (plain `text` **and** structured `json`/`content` outputs shaped `{ stdout, stderr, exitCode }`), builds the diagnostic essence, archives full output at tool level (hash-suffixed names, size-capped dir, retention sweep, archive on/off, XF9/XF10); `isCommandTool` classification |
| `config.ts` | 466 | Zod schema, defaults, fsynced atomic `config.json` writes, cache invalidation, corrupted-config warning; `stats.measure` toggle |
| `paths.ts` | 102 | BRK-016 runtime-path decision: `runtimeDir()` = `BROKE_DATA_DIR` override, else the versioned `<extension>/../.broke-data/v1` sibling of the installation (outside the swap path); one-time marker-guarded best-effort migration of legacy artifacts (config.json, ledgers, snapshots, index, errors) with no-overwrite and EXDEV copy-then-remove fallback; injectable paths for hermetic tests |
| `commands.ts` | 681 | `/broke` parser + all subcommands (status/why, stats with measured-reduction headline, estimate, measure, reset, selftest, update, snapshot/flush, index/search, level/threshold/limit tuning, help); help text generated from `DEFAULT_CONFIG`; `formatMeasure` (sum-over-runs framing) |
| `update.ts` | 1232 | Self-update (`/broke update`): resolves the latest tagged GitHub release (`releases/latest`, fallback highest-semver tag), strict `vMAJOR.MINOR.PATCH` tag validation before any URL use, streaming tarball download with mid-stream cap (F-11), system-`tar` extraction, runtime data lives OUTSIDE the installation under the versioned `.broke-data/v1` root (BRK-016), so a swap cannot touch it - the legacy preserve list stays as a fallback for pre-migration installs (errors/ ≤ 100 MB, index/ ≤ 64 MB caps) and `node_modules` is never carried: `npm ci --omit=dev` always rebuilds from the verified lockfile (BRK-009), atomic swap with rollback plus in-place replacement when a Windows handle pins the directory; rename retries for transient locks (~4 s staggered), merge-over fallback for persistently locked entries (snapshot by copy, merged over, pruned back to payload contents), byte-size manifest verification of the copied payload before success is declared (.deployed-version is written only then), complete rollback on every failure path, transactional .update-state.json marker with stale-backup recovery incl. merge-copy fallback (F-02), non-fatal leftover-backup cleanup; git-checkout guard, concurrency lock; all I/O injectable for hermetic tests. Since 0.8.0 (R1): installs ONLY release ASSETS - Ed25519-signed SHA256SUMS verified against the embedded public key plus checksum match BEFORE extraction/npm ci; unsigned (pre-0.8.0) releases are refused |
| `tokens.ts` | 450 | Token estimation (chars/4), measured vs. modeled-counterfactual savings categories (BRK-022), per-task stats persisted to `stats.jsonl` (rotation > 5 MB, real reset, TTL-cached loader); measurement ledger `measure.jsonl` (`RunRecord`, per-run persistence + rotation, loader, summary aggregation) |
| `local.ts` | 152 | Ollama HTTP client (`requestJson`: fetch + body read inside ONE abort window, so stalled responses fail fast), plaintext-remote-URL detection |
| `validate.ts` | 88 | ContextValidator (external review P0): pure provider-bound invariant checks - no duplicate tool-call/result ids, no orphaned calls or results; `compressMessages` reverts to the original input when its output violates invariants that the input did not have |
| `slice.ts` | 824 | ST-slicing (opt-in, 0.7.0): heuristic TS/Python interface-view extraction, fail-open on uncertainty: exported initializers kept whole (no unparseable stubs), public/protected fields + overload signatures kept, case-folding Windows-only, regex-escaped focus symbols (BRK-020); focus resolution + tool detection helpers |
| `snapshot.ts` | 527 | F3 milestone snapshots: `snapshot [label]` records + onCommit/onTestPass triggers, summary-only records by default (`snapshot.keepHistory` off; the destructive flush keeps its undo file via `flush.undo`, D1), per-task 25 MB byte budget and 10 MB undo-file cap with size-aware eviction of the oldest record+history pairs (F-14), owner-only permissions (0600/0700), count-based rotation; ALL conversation-derived fields masked incl. taskName/files, collision-free hashed task dirs + unique filenames, readHistory refuses unexpected names/paths/shapes (BRK-019) |
| `scripts/sign-release.mjs` | 65 | Release artifact signing: sha256sum manifest + Ed25519 signature (`BROKE_RELEASE_SIGNING_KEY`, CI-only) |
| `.github/workflows/release.yml` | 51 | Tag-push release pipeline (BRK-007/008): full CI gate runs on the exact tagged commit (reusable workflow_call), then `release-sign-and-publish.yml` is called PINNED TO `@main` - the signing code always comes from protected main, never from the tag; ancestor check against origin/main, `environment: release` approval gate, assets built by `git archive` of the tag (the ONLY supported release path since 0.8.0) |
| `.github/workflows/release-sign-and-publish.yml` | 96 | BRK-008 callee: signs the tag-built archive with the key from protected main and publishes release assets + SHA256SUMS + signature; requires the `release` environment approval || `pricing.ts` | 98 | Cost-savings math (`savedCostUsd`, `formatUsd`, `priceLabel`), task model price resolution by exact provider+model match (ambiguous bare ids stay unknown, BRK-022) |
| `selftest.ts` | 249 | `/broke selftest`: synthetic conversation with real tool-call ids, forced-low thresholds, per-pass savings |
| `scripts/bench.ts` | 297 | Deterministic reference benchmark (npm run bench): a 351,403-char synthetic session through the real pipeline with a stub summarizer, byte-reproducible; F4 keyword-index scenario for the counterfactual estimate model |
| `scripts/measure.ts` | 25 | `npm run measure`: CLI wrapper that loads `measure.jsonl` and prints `formatMeasure` |
| `ConfigComponent.jsx` | 290 | Settings dialog (gear icon on the extension card), schema-bounded numeric fields, measurement toggle |
| `StatusBadge.jsx` | 106 | 💸 badge in the task status bar, per-pass breakdown in the tooltip, shows the summarize auto-disable state; always renders; the 10 s poll runs only while a summarizer backend is active (BRK-029), push refreshes cover the rest |
| `tests/index.test.ts` | 850 | Fake-host integration tests (XF11): real extension against a fake ExtensionContext/task, compression + stats/measure persistence, reentry guard, summarize auto-disable, tool-level archiving on/off, silence when disabled |
| `tests/commands.test.ts` | 702 | Unit tests: `/broke` parse/apply/format (incl. `update` subcommands), generated help text, Ollama model-tag matching, measure parsing + `formatMeasure` |
| `tests/measure.test.ts` | 232 | Unit tests: run-record mapping, ledger append/rotation/malformed-skip, summary math incl. summarizer cost side (mean/median/max/byTask) |
| `tests/compress.test.ts` | 1300 | Unit tests: region computation, structural/truncate/error passes, summary handling, rich-part skip, summarize gate, secret masking |
| `tests/config.test.ts` | 271 | Unit tests: config merge, corrupted-file fallback, pure updates, one-write multi-path persistence |
| `tests/errors.test.ts` | 613 | Unit tests: error extraction for plain + structured outputs, command-tool guard, `isCommandTool` classification, archive cap/retention/clear |
| `tests/local.test.ts` | 161 | HTTP round-trip tests against a local server: success, HTTP errors, body errors, stalled-body timeouts; remote-host classification (`isRemoteOllamaHost`) |
| `tests/pricing.test.ts` | 265 | Unit tests: cost-savings math (`savedCostUsd`, `priceLabel`), stats persistence privacy, stats loader TTL, task-stats reset |
| `tests/selftest.test.ts` | 78 | Unit tests: synthetic-call-id linking, dedupe really applied, honest per-pass labels |
| `tests/update.test.ts` | 915 | Unit tests: self-update flow with injected deps - release ASSET resolution + semver fallback, tag validation, strict signed-release trust model (refuses unsigned/tampered), happy-path swap with state preservation, check mode, explicit downgrade/reinstall, extract/npm failure aborts, git-checkout guard, concurrency lock, stale-backup recovery, in-place fallback, errors-archive size cap (sparse file), mid-staging rename-lock rollback, partial-copy detection via the manifest check, swap manifest-mismatch rollback, merge-over fallback for unmovable directories/files with pruning, merged-entry snapshot rollback |
| `tests/validate.test.ts` | 233 | Unit tests: ContextValidator invariants (duplicates/orphans/format failures) + compressMessages revert semantics (output-broken reverts, input-corrupt ships) |
| `tests/host-contract.test.ts` | 392 | Full lifecycle contract with a fake host: TaskInitialized -> ToolCalled -> ToolFinished -> OptimizeMessages state flow + never-break-the-host guarantees under hostile surfaces |
| `tests/update-signing.test.ts` | 88 | Signature/checksum primitives against an isolated test keypair (verifySumsSignature, checksumFromSums, defaultVerifyRelease failure paths) |
| `tests/slice.test.ts` | 444 | Unit tests: TS/Python slicing, focus resolution, tool detection, fail-safe export pass-through regression matrix (R6) |
| `tests/snapshot.test.ts` | 437 | F3 unit tests: record assembly, masking, persistence/rotation/undo files, the pure flush planner, the conservative test-green heuristic |
| `tests/bench.test.ts` | 95 | Unit tests: the bench workload builder and F4 scenario pin the documented reference figures |
| `tests/indexer.test.ts` | 669 | F4 unit tests: tokenizer, incremental merge + delta accounting, merge-budget exhaustion, scan policy + privacy filters (BRK-003), confinement validation + foreign-root rebuild (F-09), BM25 ranking, snippet windows, budget enforcement, persistence round-trip, TTL freshness split (BRK-017) |
| `tests/paths.test.ts` | 100 | BRK-016 unit tests: BROKE_DATA_DIR override, default sibling path, migration + idempotency, no-overwrite against newer data, fresh-install no-op |
| `tests/ollama-gating.test.ts` | 222 | BRK-029 tests against a fake Ollama HTTP server: no probing when the level is not summarize or the extension is disabled, in-flight probe deduplication, non-blocking task initialization, cache-aware init line, gated badge poll |
| `tests/ui-contract.test.ts` | 45 | Vendored host UI contract pinned against the installed @aiderdesk/extensions version; JSX components validate against real prop shapes (BRK-024) |

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
- `docs/review-backlog.md`: the complete review ledger - self-review F1-F24, external XF1-XF16, external R1-R14 (incl. accepted limitations and the open R15), remediation F-01..F-16 - all dispositioned with severity, location, fix approach, commit mapping
