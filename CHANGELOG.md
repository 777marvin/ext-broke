# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
