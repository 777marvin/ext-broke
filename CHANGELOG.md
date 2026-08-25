# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
