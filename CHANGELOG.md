# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-08-14

### Added

- **Live token & cost savings at the task model's price.** The 💸 badge
  tooltip, the chat log line ("saved ≈ N tokens") and `/broke stats` now
  show the estimated money saved — always computed from the price of the
  model CURRENTLY used in the task (resolved via the task agent profile and
  the model registry; local/Ollama models have no price and honestly show
  no money figure).
- **Honest badge summarizer status.** The badge now distinguishes what is
  configured (local/cloud) from what was actually used (never yet — with an
  explanation of when summarization fires), and shows Ollama reachability
  (30 s cached, 3 s check timeout) with a ⚠ when the local backend is down.

### Fixed

- **Never orphan tool-calls during compression (root cause of "Interrupted"
  after smart-compact).** The structural pass dropped duplicate tool
  results without always removing their matching assistant tool-calls (only
  the first call id was handled, and the holder search stopped 3 messages
  back). A tool-call without its result makes the provider call fail with
  `AI_MissingToolResultsError` — surfaced by AiderDesk as an Interrupted
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
  `ollamaStatus` returned `reachable: true` with `error: "HTTP n"` —
  contradictory semantics that hid a broken server from status checks.
  Generation timeout reduced 120 s → 60 s so a hung Ollama stalls the
  model call for at most a minute.
- **Version/default drift.** `metadata.version` was 0.2.0 while
  package.json said 0.2.1; `/broke help` and the settings dialog showed
  stale defaults (120000 chars / 6 turns instead of 60000 / 2).
- **stats.jsonl no longer persists project paths** (privacy — the field
  was never read).

### Docs

- **README updated with measured real-world savings** (bmad-build run,
  2026-08-13, 3 tasks / 543 passes: up to ~268k tokens removed from a
  single call's input, ~55 Mio tokens cumulative across all calls, run
  cost ~0.29 $ on DeepSeek — with the honest caveat that the run used
  v0.2.0 before the structured-output fix). Error-compressor section now
  documents `json`/`content` (`{stdout, stderr}`) coverage; roadmap marks
  the stack-trace/log compressor as shipped (F1, v0.2.0/v0.2.1).

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
  by their diagnostic essence — exception type, failing `file:line`, up to
  `contextLines` of context — with an explicit
  `… [broke: error summary — N lines → M lines]` marker. Per-message
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
  keyword/vector index — each with verified AiderDesk compatibility,
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

- Compression notice threshold raised to 4000 chars (≈ 1000 tokens) —
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
  Ollama (plaintext HTTP) — in the task log, `/broke status` and README.

## [0.1.1] - 2026-08-13

### Changed

- MIT license added (project is public-ready); `package.json` license field
  and README license section updated.

## [0.1.0] - 2026-08-13

### Added

- **Input compression pipeline** on `onOptimizeMessages` (runs before every
  model call, task history untouched):
  - `structural` level: lossless — drop empty messages, dedupe identical
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
