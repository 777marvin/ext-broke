# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Snapshots no longer write raw conversation history by default** (review
  F-01, CRITICAL). `snapshot.keepHistory` now defaults to `false`: automatic
  commit snapshots and manual `/broke snapshot` records are summary-only.
  Raw histories can contain secrets and unmasked tool output - durable
  plaintext copies are an explicit opt-in. The destructive `/broke flush`
  is governed separately by the new `flush.undo` (default `true`): it still
  writes its pre-flush undo file so `/broke flush --undo` keeps working, and
  a flush now aborts BEFORE removing anything when its undo file would
  exceed the new size cap. Undo-file bytes stay on disk owner-readable only
  (0600 on POSIX).
- New storage quotas for snapshots (review F-14): a per-task byte budget
  (`MAX_SNAPSHOT_BYTES_PER_TASK`, 25 MB) and a per-history-file cap
  (`MAX_HISTORY_FILE_BYTES`, 10 MB) complement the existing count-based
  rotation with size-aware eviction of the oldest record+history pairs.
  `/broke update` caps the `snapshots/` carry-over at 64 MB (like the
  errors/ and index/ archives) instead of copying it unbounded.
- **Versioning policy adopted ("Option B")**: `main` carries a development
  version (`X.Y.Z-dev`) between releases; the release commit itself pins the
  exact version and is the only commit a `vX.Y.Z` tag may point at. `main`
  now sits at `0.12.0-dev` after the 0.11.0 release. Post-release work no
  longer hides under a released version number.
- New version-consistency gate (`npm run check:version`, run in CI and in
  the release workflow): `package.json` version == `package-lock.json` root
  version == the release tag at release time. The lockfile root metadata,
  which had drifted to `0.9.0` while `package.json` said `0.11.0`, is now
  synced.

### Fixed

- Summary-cache reuse is now content-verified (review F-06): validity was
  keyed on the last region message's ID, so a history edit that changes a
  message's content while keeping its ID would silently serve a stale
  summary. The cache additionally stores a SHA-256 over the summarized
  portion's contents (role + id + content); any content change with stable
  IDs forces a regeneration. Appending new messages keeps the cache valid.
- **Compression never grows the context anymore** (review F-08): both error
  compression paths (history pass and tool-level rewrite) now skip the
  rewrite when the generated summary is longer than the output it would
  replace. The old history pass rewrote anyway (reporting clamped 0
  savings); the rule is now consistent with the pipeline-wide XF6
  "never grow" guard. Note: in that edge case the original (unredacted)
  output simply stays in the context - live-context redaction was never a
  broke guarantee (`maskSecrets` is best-effort and applies to summaries).
- The pipeline gate is content-based instead of message-count-based
  (review F-10): `compressMessages` no longer hard-excludes contexts with
  fewer than 4 messages; a short context now proceeds when its content
  could trip the error-compression threshold, and the region/pairing math
  decides what is safely compressible. `/broke why` and
  `/broke summarize now` share the same predicate.
- **`/broke update` recovery is transactional** (review F-02, HIGH). Both
  swap paths now write a fsynced `.update-state.json` commit marker only
  after the verified copy finished. Startup recovery reads it instead of
  guessing: a committed install drops its stale backup, a partial install
  (crash mid-copy) is restored FROM the backup - the old "install dir
  exists -> trust it" heuristic could keep a half-written installation and
  delete the good backup. Complete pre-marker installations (deploy.ps1 or
  an older updater, identified by `.deployed-version`, which both write as
  their last step) keep the previous behavior - no surprise rollbacks.
- The primary install rename goes through the existing retrying rename
  instead of raw `renameSync` (review F-15): a transient Windows lock no
  longer escalates straight to the destructive in-place swap path.
- Release tarballs stream to disk with a hard byte counter and a
  Content-Length pre-check instead of being fully buffered in memory before
  the size limit was enforced (review F-11).
- `/broke index`, `/broke index status` and `broke-search` no longer fail with
  "no open project - indexing is project-scoped" inside an open project. The
  command handler and the tool invocation now receive contexts that know their
  project directory (`getProjectDir()`); these were previously ignored in favor
  of the global context captured at extension load, whose `getProjectDir()` is
  documented to return an empty string. Regression tests cover all three entry
  points plus the honest degradation when genuinely no project is available.

## [0.11.0] - 2026-08-27

### Added

- **`/broke estimate`** - a separate, honest view for effects that cannot be
  measured like compression passes. `slice` reuses its existing per-read
  estimate, `flush` records the measured net context bytes freed per flush
  (an `--undo` takes its number back via the snapshot record's new optional
  `reduction` field), and `broke-search` records an explicitly COUNTERFACTUAL
  figure: index-time whole-file sizes of every result minus what the snippets
  sent (`estimateBulkReadAvoided`; files missing from index meta are skipped).
  These figures live in `TaskStats.estimates`, are rendered with their source
  labels, and never enter `totalSavedChars` or `measure.jsonl`.
- Status badge tooltip gains one labeled estimates line (slice marked as
  part of pass totals; flush/search marked counterfactual - not counted).
- Bench: deterministic F4 scenario (in-memory keyword index over a fixed
  temp fixture; no persistence side effects) with `snippets sent` vs.
  `whole-file alternative` figures, exported as `benchF4Scenario`.

### Fixed

- docs/feats.md: stale fragments aligned with shipped status (F1-F4
  acceptance checkboxes, version headers, roadmap/status prose).

## [0.10.0] - 2026-08-27

### Added

- **F4 - Local Keyword/Vector Index with snippet summaries** (0.10.0,
  keyword backend only; vector/hybrid reserved for v2). New `indexer.ts`
  module: identifier-aware tokenizer, per-project inverted index persisted
  atomically under `index/<projectHash>/` holding ONLY term postings +
  file metadata (never file contents or snippets), incremental mtime/size
  re-indexing with a hard entry cap and honest TRUNCATED flag, BM25
  ranking, live `path:line ± contextLines` snippet windows merged around
  best matches, and a TOTAL char budget per query (`search.maxChars`,
  default 6000 ≈ 1.5k tokens) that the footer states up front.
- **`broke-search` agent tool** via the extension API's `getTools`
  (first registered tool in broke): agents can query the local index and
  receive budgeted snippets instead of reading whole files. Registered by
  default (`search.enabled: on`) - one documented tradeoff is that every
  registered tool ships its JSON schema with each model call, so
  `/broke search on | off` unregisters it without touching the built
  index.
- **Commands:** `/broke index [rebuild]`, `/broke index status` (indexed
  files, terms, disk size, built age), `/broke search <query>` (same
  engine without an agent), `/broke search on | off`; help text carries
  schema-derived defaults.
- **Settings UI:** new "Local project search" block in the config dialog
  (toggle, max results, total budget, context lines, file-size skip).
- **Durability:** `deploy.ps1` preserve list AND `/broke update`'s
  runtime-state carry both keep built indexes across installs/deployments
  (64 MB cap, mirroring errors/) so paid indexing work survives updates.

### Changed

- `applyConfigUpdates` now clones EVERY nested block before applying
  dotted-path updates. Previously blocks added after the helper existed
  (`snapshot`, `flush`, and now `search`) shared their sub-object with the
  caller's previous config instance, letting updates mutate it silently
  (regression-tested).

### Notes

- F4 claims NO savedChars/badge numbers anywhere: value comes from agents
  choosing budgeted snippets over bulk reads. README documents the
  positioning against AiderDesk's app-level semantic search and repo map,
  plus the privacy model (nothing but postings/metadata on disk).

## [0.9.0] - 2026-08-26

### Added

- **F3 - State Snapshotting & Memory Flushing.** Milestone snapshots of a
  task's state (goal / achieved / changed files / commit / masked summary)
  live in `snapshots/<taskId>/` next to the extension - written after every
  successful commit (`snapshot.onCommit`, default on), optionally on
  test-green tool results (`snapshot.onTestPass`, default off), and manually
  via `/broke snapshot [label] | list | show <n>`. `/broke flush` is the ONE
  destructive command in broke: it replaces everything after the original
  task brief with a single `[broke-state]` message so long tasks can continue
  from brief + current state instead of full scrollback. Order of guarantees:
  confirm question (`flush.confirm`) -> snapshot AND raw-history undo file on
  disk (abort untouched if those writes fail) -> one loadContextMessages()
  replacement -> byte-exact restore via `/broke flush --undo <n>` (requires
  `snapshot.keepHistory`). Records rotate at 50/task incl. their undo files;
  both deploy.ps1 and `/broke update` carry the folder across installs.
  Known limitation (spike S2): AiderDesk's own `.aider.chat.history.md`
  connector artifact is not rewritten by a flush; see README.
- `/broke selftest` now reports what a flush would do to its synthetic
  conversation (pure planner output).

### Added

- **`/broke summarize now` - manual summary pre-warm.** Runs the summarize
  pass ON DEMAND against the live task context and caches the result. The
  stored history is never rewritten: the compressed view enters only when
  the next model call takes the free cache-reuse path. Use cases:
  pre-warming BEFORE a long autonomous run (summarizer latency moves out of
  the hot path), testing a newly configured backend on real context,
  recovering from the auto-disable gate (a manual success re-enables
  summarization for that task). Shares the pipeline's trust gate and model
  resolution; failures are reported in the chat instead of feeding the
  auto-disable counter, and a warm cache answers repeats without an LLM call.

### Changed

- **Autonomous sessions now get summarization.** The `summarize.afterTurns`
  gate required user turns in the compressible region - but autonomous
  single-prompt tool loops contain NONE after the task brief, leaving the
  summarizer permanently idle there for exactly those sessions (the schema's
  `afterTurns >= 2` floor made it impossible to configure around). Regions
  with zero user turns are now exempt from the turn gate; cost/size guards
  (`minChars`, unsummarizable-parts skip, XF6 grow-guard) are unchanged.

## [0.8.0] - 2026-08-26

Hardening release driven by the external architecture/security review of
2026-08-26 (findings R1-R14; disposition recorded in
docs/review-backlog.md).

### Added

- **Cryptographically verified self-updates (R1, P0).** Releases are now
  installed ONLY from signed artifacts: a new `release` workflow builds a
  byte-stable git-archive tarball per tag, writes a sha256sum manifest and
  signs it with Ed25519 (private key lives only in the
  `BROKE_RELEASE_SIGNING_KEY` repository secret). The updater resolves
  release *assets* (no more GitHub auto-tarballs) and verifies signature +
  checksum BEFORE anything is extracted or `npm ci` runs. Unsigned or
  tampered releases are refused outright - releases older than 0.8.0 can no
  longer be (re-)installed via `/broke update`; roll back to the last signed
  version instead.
- **ContextValidator (P0).** New `validate.ts` checks provider-bound
  invariants on the pipeline output: no duplicated tool-call/result ids, no
  orphaned calls, no orphaned results. If a compression pass ever produced a
  broken context from a sound input, the whole run reverts to the original
  messages (fail-safe over fail-broken); already-corrupt inputs ship
  compressed as before so the guard cannot become a silent kill-switch.
  Reverted savings are discarded; an LLM summarizer call already made stays
  on the honest cost side.
- **Remote Ollama hosts require explicit consent (R3, P0).** A non-loopback
  `summarize.ollamaUrl` means conversation content leaves the machine. The
  local summarizer now refuses such hosts until
  `/broke summarize allow-remote on` (or the settings toggle) is used.
  Refusal is graceful: the model call proceeds uncompressed and repeated
  refusals trip the existing auto-disable.
- **Summarizer cost accounting + net savings (R10/R11).** The measure
  ledger records chars sent to / received from the summarizer LLM;
  `/broke measure` reports the traffic and an estimated NET savings line
  (gross saved tokens minus summarizer traffic), labeled as estimate with
  explicit billing caveats.
- **Host-contract test suite (R13).** Drives the real extension through the
  full event lifecycle with a fake host, including hostile-surface cases
  (throwing `getTaskContext`, degenerate events).

### Changed

- **`errors.archive` defaults to OFF (R7).** Persisting full tool outputs is
  now an explicit opt-in; tool-level summaries say "full output removed"
  until it is enabled. Config table/docs updated accordingly.
- **"lossless" relabeled to "content-preserving" (R5).** Textual content of
  structural passes survives, but message framing may change (consecutive
  assistant texts merge into one message). User-facing surfaces and docs say
  so; config enum values are unchanged.
- **Honest product claims (R4/R14).** README separates guaranteed (payload
  reduction), estimated (chars/4 token figures) and not-guaranteed (actual
  billing savings) tiers; redaction is consistently described as best effort
  with unknown formats passing through.
- **Consent wording for history-rewriting passes (R2 mitigation).** Enabling
  ST-slicing or errors tool-level rewriting now states explicitly that the
  rewrite lands in stored task history irreversibly - disabling later does
  not restore original outputs. (The AiderDesk API currently exposes only a
  single `output` field on tool events, so a non-destructive
  rawOutput/modelOutput split is impossible today; documented.)

### Fixed

- Defused three regexes in the slicer flagged by CodeQL as polynomial-ReDoS
  risks (`js/polynomial-redos`): comment and string-literal stripping now use
  linear character scans instead of backtracking-prone patterns, and the
  function-declaration matcher no longer overlaps whitespace quantifiers.
  Behavior for real-world code is unchanged.
- **Slicer fail-safe for unrecognized exports (R6).** Statements the
  heuristic parser does not know - `export default class`, `export =`,
  ambient `declare module/global` blocks - were silently dropped from the
  interface view, hiding real API surface from the model. Any unmatched
  top-level statement starting with `export`/`declare` now passes through
  in full, plus a regression matrix covering the review's case list.
- **Owner-only file permissions (R8).** Error archive, config.json and
  stats/measure ledgers write with mode 0600 (archive dir 0700) where the
  OS honors POSIX bits.
- **`unknownReadToolsLogged` bounded (R12).**

## [0.7.0] - 2026-08-26

### Added

- **ST-slicing (Semantic Context Thinning), opt-in.** `/broke slice on`
  makes large file reads deliver interface views instead of full bodies:
  imports, type/interface declarations, function/class signatures with
  bodies elided, decorated members, dataclass fields and Python def
  signatures - capped by `slice.maxChars` with an honest fallback to full
  content when a view would not shrink. The focus file always returns in
  full: explicitly via `/broke slice focus <path>`, automatically after an
  edit-tool call (`slice.focusAuto`) or while it has pending task changes.
  Every view carries an explicit marker naming the escape hatch
  (`/broke slice off`). Estimated savings show as `slice:` in
  `/broke stats` and the badge tooltip. Known gap (spike S1): Aider-injected
  context files (repo map, `/add`) bypass tool hooks and are never sliced.
- **Idle transparency for honest zeros.** The 💸 badge now shows why a task
  has saved nothing yet: with no recorded passes but at least one observed
  pipeline run, it renders e.g. `💸 0 · 31k/60k` (last run's input size vs
  the configured threshold) plus an explanatory tooltip. Includes a scope
  note: broke only measures/compresses conversation messages - system
  prompt & tool schemas are never touched.
- **`/broke why`.** Measures the live task context and walks through every
  gate (enabled/level/threshold, turns & protection, compressible region,
  per-item limits) and ends with an explicit verdict - so "the badge shows
  0" becomes diagnosable per task instead of staying silent.

### Fixed

- **Stats flush on unload.** In-memory stats are persisted when the
  extension unloads; before, a restart lost up to one persist-throttle
  window (60 s) of compression runs per task.

## [0.6.3] - 2026-08-24

### Fixed

- **`/broke update` now survives persistently locked entries.** When the
  in-place fallback could not move an entry aside (for example `docs/`
  held open by a host view reading the extension's markdown), the update
  aborted - even though the payload covers the same name. Such entries
  are now secured into the backup by copy (reads survive locks that
  block renames), left in place and merged over; full-replacement
  semantics are preserved by pruning files the payload no longer
  contains. Entries absent from the payload still abort with a complete
  rollback as before. The rename retry budget grew from ~0.6 s to ~4 s
  of staggered waits for genuinely transient locks.

## [0.6.2] - 2026-08-24

### Fixed

- **`/broke update` can no longer truncate the installation.** When the
  install directory was pinned and the in-place fallback ran, one
  transiently locked file (virus scanner or indexer, typically right
  after the dependency refresh) aborted the staging loop mid-way: part
  of the previous installation stayed stranded in `broke.old`, the rest
  was left outdated, and broke could not load after the next AiderDesk
  restart. The replacement now retries transient locks, rolls back
  completely when anything fails, verifies that every payload file
  actually arrived (byte-size check) before declaring success, and
  treats a locked leftover backup as cosmetic instead of failing an
  otherwise finished update. Regression tests cover the mid-staging
  lock abort, the partial-copy detection and the rename-swap mismatch.
- **The config watcher releases its directory handle when the extension
  is disabled or uninstalled** on AiderDesk >= 0.80 via
  `context.addDisposable()`. Older hosts keep using the existing
  `onUnload` cleanup unchanged.

### Added

- CI job validating the JSX UI components with the official
  `validate-extension-ui.mjs` script (vendored from AiderDesk 0.80.0),
  so template breakage fails the build before a release ships.

### Changed

- Extension API types bumped to `@aiderdesk/extensions` ^0.31.0. The
  release is additive (TLS policy registrar, `opencode-go` provider,
  disposable resource management); no breaking changes for this
  extension.

## [0.6.1] - 2026-08-24

### Fixed

- **Status badge stays visible and live.** The badge no longer disappears
  when its data has not arrived yet or a push refresh event was missed by
  the renderer: it now always renders (showing 0 until data arrives) and
  re-fetches its numbers every 10 s via a UI polling action - the same
  fallback pattern the savemytoken badge uses in the same host.

## [0.6.0] - 2026-08-23

### Added

- **Self-update from GitHub releases: `/broke update`.** Normal updates no
  longer need `scripts/deploy.ps1`. The command resolves the latest tagged
  release from GitHub, preserves your `config.json`, the stats/measure
  ledgers, the errors archive and `node_modules`, refreshes dependencies
  automatically when the lockfile changed, and swaps the installation
  atomically with an automatic rollback on any failure. `/broke update
  check` only reports what is available; `/broke update v0.5.1` pins or
  rolls back to an exact version without the script. Safety rails: the
  command refuses to run inside a git checkout (there, git pull +
  deploy.ps1 remain the way), installs strictly `vMAJOR.MINOR.PATCH`
  release tags - never a moving branch - and asks for an AiderDesk restart
  afterwards, since the running instance keeps its previously loaded code
  until then.

## [0.5.1] - 2026-08-23

### Fixed

- **Summarize boundary can no longer orphan a tool result.** With
  `protectedTurns` set above the number of user turns actually present
  (e.g. `/broke protect 10` in a session with fewer turns), the
  compressible region's fallback cut could land between a tool call and
  its result. Summarizing that region removed the call while its result
  survived - an orphaned result makes the next provider call fail.
  Region boundaries are now clamped past tool results on both edges
  (shared by every pass), and the incremental summary append
  regenerates instead of starting on a result. Regression tests cover
  both clamp directions and the split scenario.
- **README and docs quote the real benchmark numbers again.** The
  summarize scenario was still published as 315,389 chars / 78,847
  tokens / 89.8% after a v0.5.0 pipeline change had moved it to
  315,263 / 78,816 / 89.7%. A drift-guard test now recomputes both
  benchmark scenarios and asserts the docs contain exactly those
  numbers, so future drift fails CI instead of shipping.
- **`/broke stats` no longer prints "$0.00" for models without a known
  price.** A local/unregistered model showed a zero cost figure, which
  reads as "free" - the compression log line and the badge already hid
  it. The money line now appears only when an input price is known.
- **The status badge includes error-pass savings.** The badge payload
  dropped `savedChars.error`, so the tooltip understated the total and
  never showed what stack-trace/log compression contributed; the error
  figure now appears in the breakdown line.
- **Parallel tasks compress independently.** The reentry guard (which
  stops the cloud summarizer's own generateText call from triggering
  compression recursively) was a single flag: while one task's
  summarizer ran, any other task's model call silently skipped
  compression. The guard is now scoped per task id.
- **Config watcher honors custom config file names** - a
  `BROKE_CONFIG_PATH` override never invalidated the cache because the
  watcher compared against a hardcoded 'config.json'; it now matches
  `basename(CONFIG_PATH)`. The cloud summarizer also skips its pass
  gracefully instead of calling generateText with a literal
  "provider/undefined" when the task exposes no model id.
- **Locale-independent number formatting.** User-facing numbers
  (`/broke` output, selftest, chat notice, badge) used
  `toLocaleString()` without a locale, so a German system printed
  "4.000" while CI (en-US) printed "4,000" - one test failed on
  GitHub Actions and the CLI contradicted the comma-formatted figures
  in the README. All output now formats as en-US explicitly, matching
  the benchmark and docs.
- **deploy.ps1 works on Linux.** The script staged its copy under
  `$env:TEMP`, which pwsh on Linux does not set - every real (non-dry)
  deploy failed on CI, only the dry-run smoke had been exercised. The
  staging and archive paths now come from `GetTempPath()` (TMPDIR on
  Linux, %TEMP% on Windows).

### Changed

- **Toolchain upgrades**: TypeScript 7.0.2 (tsconfig no longer uses the
  removed `moduleResolution: node10`; it now uses `module: Preserve` +
  `moduleResolution: Bundler` with an explicit `types: ["node"]`,
  verified against both TS 5.9 and TS 7), @types/node 26.2.0, and the
  CI actions checkout v7.0.1 / setup-node v7.0.0 /
  dependency-review-action v5.0.0, all still pinned to commit SHAs.

## [0.5.0] - 2026-08-22

### Added

- **Error archive privacy controls** (`/broke errors archive <on|off>`,
  `retention <days>`, `clear`; also in the settings dialog). The archive
  now respects a retention age (default 30 days) and can be switched off
  entirely, in which case no full tool output is written at all. Saves use
  incremental byte accounting instead of scanning the tree, with age
  sweeps throttled to once per hour; the scan re-syncs the ledger.
- **CI security automation**: npm audit gate, CodeQL, dependency review,
  Dependabot (npm + GitHub Actions), least-privilege job permissions, and
  all actions pinned to commit SHAs.
- **Fake-host integration tests for the extension orchestration**
  (tests/index.test.ts). The real extension is driven with a fake
  ExtensionContext/task: compression + stats/measure persistence, the
  onOptimizeMessages reentry guard, auto-disable after repeated
  summarizer failures, honest badge data, tool-level archiving on/off,
  and silence when disabled. The `BROKE_*` env overrides isolate the
  test run from real config/ledger files; production behavior is
  unchanged.

### Changed

- **Structured tool outputs keep their shape on truncation.** Command
  outputs like `power---bash` (`json` with `stdout`/`stderr`/`exitCode`)
  are no longer flattened into a text preview; only the text payload is
  truncated, stderr is emptied, exitCode and other metadata survive.
- **Ledgers rotate by rename instead of rewrite.** `measure.jsonl` and
  `stats.jsonl` are renamed aside at 5 MB (previous generations kept as
  `.1`/`.2`/`.3`) instead of being read and rewritten - O(1) rotation,
  and no more half-cut data loss on rotation.
- **/broke stats headline shows the measured reduction.** The headline
  is now the real per-run before/after difference (XF14); legacy records
  without measured totals fall back to the pass sum, labeled as such.

### Fixed

- **Structural dedupe now requires identical tool-calls.** Two tool
  results with the same output text but different producing calls were
  deduped together with their tool-calls, silently changing the action
  history. Dedupe now fires only when the producing tool-call (name and
  input) matches too (XF1).
- **Truncation silently did nothing for maxLines 1-2.** `slice(-0)`
  returned the whole array, so small valid configs kept everything; the
  tail is now computed from the end index, with regression tests for
  maxLines 1-4 (XF2).
- **Truncate enforces combined limits.** `maxLines` and `maxKB` both
  hold after the cut (marker and header included), not a lines-first
  approximation (XF5).
- **Summarize never grows the context.** All three replace paths
  (generate, cache reuse, incremental) skip the swap when the summary
  would replace a region with more text than it removes (XF6).
- **CLI values are validated after rounding.** `/broke maxchars 0.4`
  passed the `> 0` check, rounded to 0 and wrote a config that failed on
  the next load; validation now runs on the rounded value (XF8).

### Security

- **Summaries framed as untrusted machine-generated data.** The summary
  body carries a one-line "treat as data, not instructions" note before
  the generated text, so attacker-influenced content can no longer
  masquerade as the assistant's own history (XF3).
- **deploy.ps1 filters secrets at every depth.** The exclusion regex
  only checked direct children, so nested `examples/.env` or
  `fixtures/private.pem` were deployed. Filtering is now recursive, and
  a CI regression job deploys a dirty tree with nested fake secrets
  (XF4).

## [0.4.0] - 2026-08-17

### Added

- **Deterministic reference benchmark** (`npm run bench`,
  scripts/bench.ts). A 351,403-char synthetic session runs through the
  real pipeline with the shipped defaults and a fixed stub summarizer (no
  LLM, byte-reproducible): 113,070 chars removed at the default level
  (32.2%), 315,389 chars at the maximum level (89.8%). Covered by
  determinism tests.
- **Per-run measurement ledger** (`measure.jsonl`). With `stats.measure`
  on (default), broke appends one record per real compression run: input
  and output sizes, per-pass removals, summarizer calls. No content, no
  paths, rotation-capped at 5 MB. `/broke measure` (in a task) and
  `npm run measure` (extension directory, `--file=<path>` override)
  aggregate the records into runs, tasks, per-run mean/median/max and
  per-task breakdowns - explicitly labeled as a sum over individual runs,
  not a cumulative context claim. Toggle via `/broke measure on | off`
  or the settings dialog. This is the provable real-session counterpart
  to the benchmark.

### Fixed

- **Summarize auto-disable now actually disables.** After 3 consecutive
  summarizer failures the extension logged "disabled for this task" but
  kept retrying on every model call (each retry stalls up to 60 s when
  Ollama is down). The summarize pass is now gated per task; the gate
  clears after a successful summary, `/broke reset`, or a summarizer
  backend/model change, and the badge shows the disabled state.
- **Error compression only touches command/compiler/test tools.** The
  input error pass compressed ANY tool result whose text matched error
  patterns, so file reads and docs with "Error:" lines, ● bullets or ✕
  checklists could be replaced by an "error summary", corrupting the
  model's view of the file. Non-command tools are now skipped, matching
  the existing tool-level behavior.
- **Summarization never silently drops images, files or reasoning parts.**
  Replacing a region with a text-only summary discarded rich parts
  (screenshots, file attachments, reasoning) in old turns. Regions
  carrying such parts are now left untouched (truncate still shrinks
  their text), and `error-json` tool results keep their payload in the
  summarizer input instead of contributing nothing.
- **Ollama timeouts now cover the response body.** The request timeout
  ended as soon as the response headers arrived; a server that then
  stalled its body hung the summarization (and with it the model call)
  indefinitely. The whole request (headers AND body) is now inside the
  abort window, and timeouts fail fast with a clear message.
- **Honest numbers and I/O.** Merging adjacent assistant messages now
  counts 0 saved chars (the full text stays in the context); `passes`
  increments and stats persistence only happen when a run actually
  compressed something, persistence is throttled to one write per minute
  per task, badge reads use a 30 s TTL cache instead of re-scanning up to
  5 MB per refresh, and error summaries never report negative savings.
- **Config safety.** Numeric settings fields enforce the schema bounds and
  integer-only input with a readable error instead of a silent save
  failure; `/broke truncate` applies both limits in one atomic write;
  saveConfig fsyncs before the rename; the help text is generated from
  DEFAULT_CONFIG; metadata.version comes from package.json.
- **Summary cache follows summarizer config.** Switching the summarizer
  backend/model invalidates cached summaries instead of reusing stale
  ones; the Ollama model check matches the exact tag first and no longer
  reports a model as available when only a different tag exists.
- **Selftest and archive hygiene.** Synthetic tool results link to real
  tool-call ids, so the dedupe scenario really dedupes and per-pass checks
  assert intermediate outputs; error archive file names carry a hash
  suffix (long ids no longer silently overwrite each other); the deploy
  script preserves the errors/ archive (100 MB cap).
- **Reentry guard.** The cloud summarizer's task.generateText call can
  re-fire onOptimizeMessages; a guard prevents the summarizer's own input
  from being compressed again (double compression or recursion).
- **Extractor consolidation.** The four duplicated tool-output extractors
  (toolResultText, extractToolResultText, extractOutputText, partText)
  became one canonical implementation in output.ts with the shape
  handling as explicit options. No functional change.

### Security

- **Secret masking widened.** JWTs, Slack tokens, AWS session tokens, HTTP
  Basic auth, key assignments (`password=...`), Slack/Discord webhook
  URLs, connection strings and Azure SAS signatures are now masked before
  content reaches the summarizer; the prompt and docs state plainly that
  the masking is best effort.
- **Summarizer prompt-injection risk documented.** The summarize pass
  condenses potentially attacker-influenced web/file content with a small
  model, and injected instructions can survive the condensation into the
  main model's context. The untrusted-data prompt and the masking
  mitigate, they are not a hard boundary; the risk is now documented in
  the README security notes.

### Changed

- **Unverifiable savings figures removed.** The single-session numbers
  published with v0.3.0 (up to ~268k tokens in one call, ~55 Mio
  cumulative, ~0.29 $ run cost) could not be reproduced from raw data and
  were removed from the README and docs. The badge, `/broke stats` and
  the new per-run measurement ledger (above) are the real-session
  numbers; the reference benchmark is the reproducible claim.
- **All em-dashes removed.** Docs, UI strings and log messages now use
  plain punctuation (commas, colons, periods) or a spaced hyphen; test
  assertions on compression markers match the new strings.
- **README badges are now static.** License and release badges no longer
  depend on GitHub API lookups, so they render correctly before the
  repository exists publicly; the CI badge returns once the repo is
  pushed and Actions has run.

## [0.3.0] - 2026-08-14

### Added

- **Live token & cost savings at the task model's price.** The 💸 badge
  tooltip, the chat log line ("saved ≈ N tokens") and `/broke stats` now
  show the estimated money saved, always computed from the price of the
  model CURRENTLY used in the task (resolved via the task agent profile and
  the model registry; local/Ollama models have no price and honestly show
  no money figure).
- **Honest badge summarizer status.** The badge now distinguishes what is
  configured (local/cloud) from what was actually used (never yet, with an
  explanation of when summarization fires), and shows Ollama reachability
  (30 s cached, 3 s check timeout) with a ⚠ when the local backend is down.

### Fixed

- **Never orphan tool-calls during compression (root cause of "Interrupted"
  after smart-compact).** The structural pass dropped duplicate tool
  results without always removing their matching assistant tool-calls (only
  the first call id was handled, and the holder search stopped 3 messages
  back). A tool-call without its result makes the provider call fail with
  `AI_MissingToolResultsError`, surfaced by AiderDesk as an Interrupted
  task. Dedupe and empty-result trimming now remove ALL affected calls and
  abort entirely when the holder cannot be found; keeping a duplicate is
  always safer than orphaning a call. Regression tests cover parallel
  multi-call dedupe, missing holders, all-empty results and a pairing
  invariant on synthetic conversations.
- **Secret redaction for error output.** `errors.toolLevel` archived the
  full tool output unredacted, and both the archive and the generated
  summaries could carry secrets. Archived files and summaries are now
  passed through `maskSecrets`, and the archive is rotation-bounded
  (100 MB cap, oldest files evicted first).
- **Ollama HTTP errors now count as unreachable.** Previously
  `ollamaStatus` returned `reachable: true` with `error: "HTTP n"`,
  contradictory semantics that hid a broken server from status checks.
  Generation timeout reduced 120 s → 60 s so a hung Ollama stalls the
  model call for at most a minute.
- **Version/default drift.** `metadata.version` was 0.2.0 while
  package.json said 0.2.1; `/broke help` and the settings dialog showed
  stale defaults (120000 chars / 6 turns instead of 60000 / 2).
- **stats.jsonl no longer persists project paths** (privacy, the field
  was never read).

### Docs

- **README updated with a savings explanation.** Error-compressor section
  now documents `json`/`content` (`{stdout, stderr}`) coverage; roadmap
  marks the stack-trace/log compressor as shipped (F1, v0.2.0/v0.2.1).
  (The session numbers published with this update could not be reproduced
  and were removed later, see the Unreleased correction entry.)

## [0.2.1] - 2026-08-13

### Fixed

- **Error compressor (F1) now sees structured tool outputs.** Command tools
  like `power---bash` return their result as `json`/`content` outputs shaped
  `{ stdout, stderr, exitCode }`, which the error pass previously skipped
  (only `text`/`error-text` outputs were inspected). Stack traces and test
  failures hidden in `stdout`/`stderr` of such outputs are now compressed
  like plain-text results; the summary replaces `stdout` while `stderr` and
  the surrounding structure (`exitCode`, …) are preserved, so downstream
  consumers keep a valid payload. The same gap existed in the tool-level
  rewrite path (`onToolFinished` / `extractToolResultText`) and is fixed
  there as well. Non-error structured output is left byte-identical.

## [0.2.0] - 2026-08-13

### Added

- **Active Log & Stack-Trace Compressor (F1).** Old tool results that are
  compiler/test error output (tsc, Python/pytest tracebacks, Jest/Vitest
  failure blocks, Node stack traces, generic `Error:` lines) are replaced
  by their diagnostic essence: exception type, failing `file:line`, up to
  `contextLines` of context, with an explicit
  `… [broke: error summary - N lines → M lines]` marker. Per-message
  threshold (`errors.minChars`, default 8000) independent of
  `maxContextChars`: a 2k-line test failure in a small conversation is
  exactly the case worth compressing. Runs before the truncate pass so
  extraction sees the full text. New `error` line in `/broke stats` and
  `/broke selftest` case; `errors.toolLevel` (default off) rewrites stored
  history at tool level (`onToolFinished`) and archives the full output
  under `<extension>/errors/`. Commands: `/broke errors on|off`,
  `errors minchars <n>`, `errors lines <n>`, `errors toollevel <on|off>`.

### Docs

- **Design & specs for four upcoming context features** (docs/feats.md):
  F2 ST-slicing, F3 state snapshotting + memory flushing, F4 local
  keyword/vector index: each with verified AiderDesk compatibility,
  config schema, commands, acceptance criteria and spike list (F1 shipped
  in 0.2.0).

## [0.1.3] - 2026-08-13

### Fixed

- **Compression never engaged in single-prompt sessions.** Real AiderDesk
  sessions are often one task brief plus a long tool loop (1–2 user turns).
  The turn-based region protection (`protectedTurns: 6`) left the
  compressible region empty in exactly these sessions, so broke saved
  nothing even with a huge conversation. The region now falls back to
  protecting only the current step (last 5 messages) when the session has
  fewer user turns than `protectedTurns`.
- **Defaults tuned to act before the built-in compaction.**
  `protectedTurns` default lowered 6 → 2; `maxContextChars` default lowered
  120000 → 60000 chars (≈15k tokens), so the lossy passes engage while the
  input is still well below AiderDesk's emergency threshold.

## [0.1.2] - 2026-08-13

### Fixed

- **Data loss: non-text parts protected.** The structural pass no longer
  drops or merges assistant messages carrying reasoning/file/image parts
  (previously reasoning parts and images could be silently discarded).
- **Tool-call pairing.** Deduping identical adjacent tool results now also
  removes the matching assistant tool-call, so every remaining tool-call
  keeps its result (prevents API/model confusion from orphaned call ids).
- **Summarizer call explosion.** The summary is cached per task and reused
  while the compressible region is unchanged; tool-loop steps append to the
  cached summary instead of regenerating it; regeneration only happens on
  new user turns or ≥ `minChars` of new content. Real summarizer calls are
  tracked (`summarizeCalls` in `/broke stats`).
- **Summarizer prompt injection.** Conversation content (incl. tool
  outputs) is explicitly framed as untrusted data in the summarizer prompt;
  common secret patterns (OpenAI/AWS/GitHub tokens, bearer tokens, private
  keys) are redacted before content leaves for the summarizer.
- **Lost early requirements.** Oversized regions (> 30k chars) now keep the
  beginning of the conversation (original requirements) in addition to the
  recent tail, instead of only the tail.
- **Failure isolation.** A throwing summarizer no longer discards the
  structural/truncate savings and counts as a failure for the soft-disable
  (previously exceptions bypassed the failure counter).
- **JSON truncation.** Oversized `json`/`content` tool outputs are now
  truncated too (previously only `text`/`error-text` outputs were).
- **Blocking status checks.** Ollama status probes use a short timeout
  (3 s) so a dead remote Ollama cannot stall task initialization or
  `/broke status`.
- **stats.jsonl lifecycle.** The file is rotated once it exceeds 5 MB
  instead of silently stopping persistence; `/broke reset` now really
  deletes the task's persisted lines (including project paths).
- **Config robustness.** `config.json` is written atomically (temp +
  rename) and a corrupted config now produces a visible warning instead of
  a silent fallback to defaults.
- **Version drift healed.** Artifact version (`package.json`, extension
  metadata) now matches the `v0.1.1` tag and is bumped to `0.1.2`.

### Changed

- Compression notice threshold raised to 4000 chars (≈ 1000 tokens),
  matching the README; chat noise reduced.
- Status badge/stats unchanged, but `/broke status` warns when the
  summarizer URL is a plaintext remote host.
- Tool-call input placeholders are marked "not re-executable" with the
  original size.
- Internal maps (task stats, log throttle, summarize failures, summary
  cache) are bounded to avoid memory growth in long-running sessions.
- Missing JSX templates no longer prevent the extension from loading.

### Security

- Warn when conversation content would be sent unencrypted to a remote
  Ollama (plaintext HTTP), in the task log, `/broke status` and README.

## [0.1.1] - 2026-08-13

### Changed

- MIT license added (project is public-ready); `package.json` license field
  and README license section updated.

## [0.1.0] - 2026-08-13

### Added

- **Input compression pipeline** on `onOptimizeMessages` (runs before every
  model call, task history untouched):
  - `structural` level: lossless: drop empty messages, dedupe identical
    adjacent tool results, merge consecutive assistant texts.
  - `truncate` level (default): head+tail truncation of old tool outputs
    with explicit markers, trimming of oversized tool-call inputs.
  - `summarize` level: LLM summarization of old conversation turns into a
    single `[broke-compacted]` message, cached per task.
- **Local summarization offload** via direct Ollama HTTP (`/api/generate`):
  zero cloud tokens, no provider registration needed; graceful degradation
  and status reporting when Ollama is offline.
- **Cloud summarizer fallback** (`summarize via cloud`) through
  `TaskContext.generateText`, defaulting to the task's model.
- **`/broke` command**: status (incl. Ollama reachability + model list),
  level/threshold/limits configuration, per-task stats, reset, selftest,
  help.
- **Settings dialog** (gear icon): all pipeline settings with validation.
- **Status badge** (`task-status-bar-right`): 💸 saved input tokens for the
  current task, per-pass breakdown in the tooltip, summarizer indicator.
- **Stats tracking** per task (chars/4 heuristic, honest estimates),
  persisted to `stats.jsonl` (survives deploys), with chat notices
  throttled to once per 5 minutes per task.
- **`/broke selftest`**: exercises all three passes on a synthetic
  conversation with forced-low thresholds and reports per-pass savings.
- **Docs**: `docs/token-saving.md` (lever list), `docs/aiderdesk-builtin.md`
  (AiderDesk's built-in token savings, verified from source),
  `docs/local-models.md` (what local models can do on a 4 GB VRAM stack).
- **Tests**: 14 unit tests for token estimation, region computation,
  structural/truncate passes, summary marker handling.
