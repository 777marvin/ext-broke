# Context Features: Design & Specs

Design document and implementation specs for the next four `feat:` increments
of the Broke extension. Every fact about the AiderDesk extension API in this
document was verified against the authoritative builtin `extension-creator`
skill (`%APPDATA%\aider-desk\Cache\extensions\hotovo-aider-desk\resources\skills\`,
files `event-types.md` and `extension-interface.md`) and
`docs/aiderdesk-reference.md` (meta repo).

Status: **As built**. F1-F4 are shipped; the per-feature "Implementation
notes" blocks record the as-built decisions, and spike outcomes S1-S4 are
recorded in the shared spike list below.

## Roadmap

| # | Feature | Target version | Effort | Status |
|---|---------|----------------|--------|--------|
| F1 | Active Log & Stack-Trace Compressor | 0.2.0 | S | shipped |
| F2 | ST-Slicing (Semantic Context Thinning) | 0.7.0 | M | shipped |
| F3 | State Snapshotting & Memory Flushing | 0.9.0 | M | shipped |
| F4 | Local Keyword/Vector Index with snippet summaries | 0.10.0 | L | shipped |

**Version reality check (2026-08-26):** v0.3.0 to v0.8.0 are released
and shipped F1 improvements, the reference
benchmark, the measurement ledger, the error-archive privacy controls,
the CI security automation, the self-update command (`/broke update`,
which installs tagged GitHub releases without deploy.ps1) plus its
hardening round (rename retries, byte-size payload verification,
complete rollback), the always-live status badge, the AiderDesk 0.80
extension-API updates (disposable config-watcher cleanup), the honest-zero
transparency work (idle badge hint, `/broke why`, stats flush) and F2
ST-slicing (v0.7.0). F3 shipped in v0.9.0
(snapshots/, snapshot.ts module, config blocks,
commands, onAfterCommit/test-green triggers, confirmed+undo-gated flush via
loadContextMessages; spike S2's manual run passed before the release);
F4 shipped in v0.10.0 (2026-08-27).
The original plan assigned F2 -> 0.3.0, F3 -> 0.4.0 and
F4 -> 0.5.0; those targets are obsolete (0.3.0/0.4.0 shipped without
F2/F3, and 0.5.0 shipped the XF-hardening round instead) and stay TBD
until the features are actually scheduled.

Rationale for the order: F1 is a small pure-function pass that slots into the
existing pipeline (quick win, validates the config/command/stats extension
pattern for everything that follows). F2 changes what the agent sees and needs
a hook-level spike first (S1). F3 contains the only genuinely destructive
operation of the whole roadmap (flush) and must land after F1's stats/config
mechanics exist. F4 is the largest and benefits from the patterns established
by F1–F3.

## Candidate backlog (proposed, unscheduled)

Idea-level notes recorded 2026-08-28. None of these are scheduled or
specified yet - a spec gets written here when a candidate is picked up.
Numbering (F5+) is provisional.

| # | Candidate | Type | Effort | Status |
|---|-----------|------|--------|--------|
| F5 | Mode presets (short / normal / long / custom) + autonomy selector + badge icon | feat | M | proposed |
| F6 | Live-UI expansion: provable + estimated savings, colored activity dot | feat | M | proposed |
| F7 | Minimalist user-facing operation (dev mode stays, optional) | feat | M | proposed |
| F8 | Internal benchmark methodology "that tells the truth" | docs/tooling | L | proposed |
| F9 | User-facing benchmark "that tells the truth" | docs/tooling | L | proposed |

- **F5 - Mode presets & autonomy selector.** Selectable presets
  `short / normal / long` with tuned, sensible defaults per task length,
  plus `custom` for fully user-defined values and settings. Additionally
  an `autonomous` vs `manual` mode selector. Entry point: a minimalist
  selector icon next to the savings badge (StatusBadge.jsx). Open
  questions: which config fields each preset pins (compress levels,
  summarize.afterTurns, slice/search defaults), how presets interact with
  manual overrides, and whether autonomous mode implies different safety
  defaults (e.g. flush.confirm).
- **F6 - Live-UI expansion.** Show saved money twice: proven
  (measure-ledger backed) and estimated (chars/4-based, labeled) - the
  estimated value in addition to the proven one. Animated status dot with
  color semantics: green = broke on and active, blue = benchmark/measure
  run, purple = summarizer currently running, yellow = error / needs
  attention, red = broke off.
- **F7 - Minimalist operation.** Reduce the daily-driver surface to the
  essentials for non-power users (sane presets, one toggle, honest numbers
  at a glance); the current developer-facing surface stays as an explicit,
  optional dev mode.
- **F8 - Honest internal benchmark.** A benchmark methodology that tells
  the truth about broke: what is actually saved versus the baseline
  (aiderdesk-builtin.md), measured on reproducible tasks, no vanity
  metrics, estimated and proven numbers strictly separated.
- **F9 - Honest user-facing benchmark.** A truth-telling, user-runnable
  measurement path beyond `npm run bench` / `npm run measure`: users
  should be able to verify savings claims on their own sessions, with a
  clear methodology and documented caveats.
- **S5 - Agent-facing skill/rule (investigation).** Should broke ship an
  AiderDesk skill or rule that teaches agents to use broke on their own
  (tools + `/broke` commands) during autonomous tasks? Evaluate
  discoverability, prompt-cost tradeoff, and whether AiderDesk's
  skill/rule mechanisms are the right vehicle.
- **S6 - Agent tool surface (investigation).** Evaluate which further
  extension capabilities should be exposed as agent-executable tools
  (like broke-search) versus chat-only commands. Working assumption:
  index build/rebuild must NOT become an agent tool - indexing stays a
  deliberate `/broke index` command.
- **S7 - Subagent behavior (investigation).** How do broke's hooks, stats
  attribution and compress passes behave when subagents are spawned?
  (Which events fire per subagent task, per-task map behavior, risk of
  double counting?)
- **S8 - savemytoken migration (investigation).** Evaluate migrating the
  savemytoken extension's functionality into broke (precedent: its
  `truncateToolResult` feature-detection pattern is already referenced in
  the cross-cutting principles).

---

## Cross-cutting principles

1. **Non-destructive by default.** Everything that runs automatically must
   leave the stored task history untouched (Broke's core promise). Destructive
   operations (F3 flush) are manual, opt-in, and require confirmation.
2. **Opt-in for behavior-changing features.** F2 (slicing) and F3 (flush)
   change what the agent or the user sees; their config defaults are `off`.
   F1 and F4 are purely additive and default `on`.
3. **Feature-detect the runtime API.** Published `@aiderdesk/extensions`
   types (~0.31) lag the runtime. Any hook/TaskContext method used here is
   checked at runtime before use and degrades gracefully (pattern established
   by savemytoken's `truncateToolResult` detection).
4. **Failure isolation.** No hook handler may ever throw into the agent loop.
   New passes are wrapped the same way `summarizePass` is (catch → report →
   keep previous savings).
5. **No secrets in new artifacts.** `maskSecrets` (compress.ts) is applied to
   anything derived from conversation content before it is persisted
   (snapshots, flush state messages).
6. **Bounded memory.** All per-task maps use `boundedMapSet`; all persisted
   artifacts (index, snapshots, history dumps) have size caps and rotation.
7. **Honest numbers.** New savings counters stay chars/4 estimates, labeled as
   estimates, and never count the app's own compression.
8. **Extensions of the pattern.** Each feature extends the same four seams:
   a new pure module, zod config block, `/broke` subcommands, and (where
   applicable) stats/UI surfaces. Tests live in `tests/*.test.ts`
   (`tsx --test`), typecheck with `tsc --noEmit`.

## Shared spike list (resolve during development)

- **S1 (F2) - resolved 2026-08-18.** Empirically verified in a real task
  (temporary debug log of message roles/part types in `onOptimizeMessages`;
  session with `includeRepoMap: true`, `includeContextFiles: false`, no
  files added):
  - The repo map arrives as a synthetic first user message, but only as a
    compact file-name listing (~430 chars for this repo) - never file
    contents. Nothing sliceable.
  - No `file` parts and no file contents appear anywhere in the event's
    messages; the stored task context (`context.json`) holds only the bare
    conversation, the repo map is prepended at event assembly.
  - Rule-file content, the skills list and reminders are not part of the
    event messages either (they are injected at prompt level, outside the
    message stream; the test session's rule files failed to load, so the
    rule-file path could not be observed).
  - Conclusion: an input-level slice pass cannot slice Aider-injected file
    contents; the documented "context files bypass hooks" gap stands. Open
    sub-case: a task with an explicitly added context file (drop / read-only
    add) could not be tested from the extension side - if `file` parts
    appear in that case, the input pass could cover them.
- **S2 (F3) - partially resolved 2026-08-26 (live smoke test).** First real
  session after the F3 implementation: snapshot -> list -> flush ->
  follow-up prompt answered correctly from brief + [broke-state] -> undo
  restored history byte-exact; no rehydration artifacts observed and no
  errors. VERDICT STILL OPEN: the session was trivial (fresh repo, single
  short task), so `.aider.chat.history.md` re-hydration over LONG sessions
  remains unobserved. README documents the caveat and asks users to report
  flushed content returning. Execution uses loadContextMessages() (not
  removeMessagesUpTo) so header messages and the task brief survive - see
  index.ts handleFlushCommand.
- **S3 (F3/F4):** resolved for snapshots/ in v0.9.0: deploy.ps1 preserve
  list AND update.ts preserveRuntimeState carry snapshots/ across installs
  (no size cap needed - rotation bounds records).
- **S4 (F2) - partially resolved 2026-08-18.** Real `toolName` strings
  observed via the tool-call/tool-result parts in `onOptimizeMessages` of a
  power-tools session: `power---file_read` (read), `power---file_edit`
  (edit/write), `power---bash`/`power---glob`/`power---grep` (command tools).
  The allowlist must still feature-detect: names differ across environments
  (Aider-native tools vs. power tools) and `onToolCalled`-based capture in a
  UI session remains unverified.

---

## F1: Active Log & Stack-Trace Compressor

**Version:** 0.2.0 (feat: → minor). **Effort:** S.

### Objective

Before the model sees a tool result containing compiler/test output, replace
the noise with the diagnostic essence: exception type, failing
file:line, and a small window of surrounding context. A 2,000-line terminal
dump becomes ~15 lines, permanently shrinking every subsequent model call.

### AiderDesk compatibility

Fully compatible, two verified docking points:

- **Primary: input pass in `onOptimizeMessages`** (matches Broke's
  "stored history untouched" promise; same architecture as the existing
  `truncate` pass). Tool results are messages with `tool` role and
  `tool-result` parts; their text is available via the canonical
  extractors in `output.ts` (`partText` / `extractOutputText`).
- **Optional follow-up: tool-level rewrite in `onToolFinished`** (output is
  modifiable per `ToolFinishedEvent`; `ExtensionContext.truncateToolResult`
  exists for the "save full output to temp file" path). Config-flag controlled
  (default `off`), because it rewrites stored history.

### Design

**New module `errors.ts`** (pure, no deps):

- `extractErrorSummary(text: string, opts: { contextLines: number }): { summary: string; matched: boolean }`
  regex-based extraction. Recognized patterns (v1):
  - TypeScript/tsc/tsx: `error TS\d+`, with `(<file>):(<line>):(<col>)` and
    context lines from the source excerpt block.
  - Node/Vitest/Jest stack traces: `Error: <message>` + `at <fn> (<file>:<line>:<col>)`
    (first frame wins), plus Jest/Vitest `✕ <test name>` + `●` failure blocks.
  - Python/pytest: `Traceback (most recent call last)` … `File "<file>", line <n>, in <fn>`
    + final `<ExceptionType>: <message>`; pytest `FAILED <path> - <ExceptionType>: <message>`.
  - Generic fallback: first line matching `^\S+(Error|Exception|Failure):` .
  - Result shape: exception type + message (first line), failing
    `file:line`, up to `contextLines` of surrounding source context, explicit
    marker `… [broke: error summary - N lines → M lines]`.
  - Unmatched text returns `{ matched: false }` and passes through untouched.

**Pipeline (compress.ts):**

- New pass `errorPass(messages, protectedTurns, opts): PassResult` between
  `truncate` and `summarize`; uses `compressibleRange` (same region rules,
  the active working set is never touched).
- Engage when: level ≥ `truncate` **and** message text length ≥
  `errors.minChars` (per-message threshold, independent of
  `maxContextChars`, a 2k-line test failure in a small conversation is
  exactly the case worth compressing; documented in README).
- `CompressReport` gains `errorChars`; `TaskStats.savedChars` gains `error`.

**Config (config.ts, new `errors` block):**

```ts
const ErrorsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Compress matching tool results ≥ this many chars. */
  minChars: z.number().int().positive().default(8000),
  /** Context lines kept around the failing line. */
  contextLines: z.number().int().min(1).max(30).default(8),
  /** Rewrite at tool level (onToolFinished) instead of input-only. */
  toolLevel: z.boolean().default(false),
});
```

**Commands (commands.ts):** `/broke errors <on|off>`,
`/broke errors minchars <n>`, `/broke errors lines <n>`,
`/broke errors toollevel <on|off>`; status/stats output extended.

**Stats/UI:** `formatStats` line `error: <n> chars (<k> outputs)`;
`/broke selftest` gains an error-compression case.

### Acceptance criteria

- [x] A tsc output with 2,000 lines compresses to exception type + file:line
      + ≤ 8 context lines, with the `[broke: error summary]` marker.
- [x] Python traceback and Jest/Vitest failure blocks are recognized.
- [x] Non-error tool output (normal build logs, code listings) passes through
      byte-identical (except existing passes).
- [x] Protected turns are never compressed; `enabled: false` is a no-op.
- [x] `toolLevel: true` rewrites `output.content[0].text` in `onToolFinished`
      and saves the full output via `truncateToolResult`; `false` (default)
      never touches stored history.
- [x] A throwing `extractErrorSummary` cannot break the model call.

### Verification

`npm run typecheck` && `npm test` (new tests in `tests/errors.test.ts`:
tsc sample, python sample, jest sample, negative samples, threshold, marker
counts, region protection).

---

## F2: ST-Slicing (Semantic Context Thinning)

**Version:** 0.7.0 (shipped; originally planned for 0.3.0, which shipped without it). **Effort:** M.

Implementation notes (v1 as built): two-factor tool detection (name regex +
input path-field shape, S4); focus = explicit > last edit target >
`getUpdatedFiles()` behind a 30 s TTL cache; heuristic parser only (the
`parser` schema field exists, no command - the ast backend ships with its
command together in v2); oversized/non-shrinking views fall back to full
content; `savedChars.slice` is an estimate outside the measure ledger.

### Objective

When the agent reads source files via power tools, deliver interface views,
imports, exported type/interface/class declarations, function signatures,
instead of full bodies. Only the file currently being edited (the *focus*)
is returned in full. A transparent network proxy is **not possible** in the
AiderDesk extension host (no hook intercepts the Aider CLI's own file reads);
instead the interception happens at tool-result level, which is verified
compatible (`ToolCalledEvent`/`ToolFinishedEvent` expose mutable `input` and
`output`).

### AiderDesk compatibility

- `onToolFinished` rewrites `output.content[0].text` of file-read tool
  results (tool-name allowlist, see S4; feature-detect and log unknown names
  once per session for diagnosis).
- `onToolCalled` records edit targets: when a file-edit/write tool fires, its
  target path becomes the task's focus file (bounded per-task map,
  `boundedMapSet`).
- Focus also includes files with pending task changes via
  `TaskContext.getUpdatedFiles()` (available in `onToolFinished`) and
  explicit `/broke slice focus <path>`.
- Skipped when: `output` has `isError`, contains image parts, or the path is
  not sliceable (extension allowlist, skip `node_modules`/`dist`/`vendor`).
- Known gap (documented in README, not a bug): Aider CLI context files
  (repo map, `/add`, connector-injected content) bypass tool hooks. S1
  (2026-08-18) confirmed: `onOptimizeMessages` sees the repo map only as a
  short file-name listing, never file contents - an input-level pass cannot
  close the gap, so it stays out of scope for v1 (only the open context-file
  sub-case could change this; see S1).

### Design

**New module `slice.ts`** (pure, no new deps in v1):

- `SLICEABLE_EXT: Record<string, 'ts' | 'py'>`, `.ts/.tsx/.js/.jsx/.mts/.cts`
  and `.py` in v1.
- `sliceInterfaces(source: string, lang: 'ts' | 'py'): SlicedView`,
  heuristic (regex) extraction, zero dependencies (Broke stays zod-only):
  - keep: imports/exports, `interface`/`type` declarations (full, they are
    the contract), class/function signatures with bodies elided to
    `{ /* … */ }`, decorated members for classes, `__init__`/`def` signatures
    for Python incl. type hints, module docstring first 5 lines.
  - elide: function/class bodies, comments (except docstrings), blank runs.
  - `SlicedView = { text: string; originalLines: number; keptLines: number }`.
- `sliceWithFocus(source, lang, focus: { file: string; symbol?: string } | null)`
  when `focus` matches this file, keep the full body of the focus symbol if
  resolvable, otherwise the full file.
- v2 (config `slice.parser: 'ast'`, default `'heuristic'`): `web-tree-sitter`
  (WASM, no native builds on Windows; folder extensions may carry npm deps).
  Feature-detect module load; fall back to heuristic on failure.

**Hook wiring (index.ts):**

- `onToolCalled`: detect edit tools (S4 allowlist), store
  `lastEditPath[taskId]`.
- `onToolFinished`: detect read tools; if `slice.enabled` and output text
  contains a sliceable file (path from `input.filePath ?? input.path`):
  - file size < `slice.minChars` → pass through untouched;
  - `isFocus(path)` (lastEditPath ∪ getUpdatedFiles ∪ explicit focus) → full
    content, prepended focus marker;
  - else → interface view with marker line
    `[broke: interface view - N of M lines. Full body only for the focus file (run /broke slice focus <path> or /broke slice off to disable)]`.
- Always synchronous and exception-guarded; on any doubt → pass through.

**Config (config.ts, new `slice` block):**

```ts
const SliceSchema = z.object({
  /** Master switch - OFF by default: slicing changes what the agent sees. */
  enabled: z.boolean().default(false),
  parser: z.enum(['heuristic', 'ast']).default('heuristic'),
  /** Files smaller than this (chars) always pass through untouched. */
  minChars: z.number().int().positive().default(4000),
  /** Cap for the generated interface view; larger views fall back to full content. */
  maxChars: z.number().int().positive().default(20000),
  /** Derive focus from edit-tool calls and updated files. */
  focusAuto: z.boolean().default(true),
});
```

**Commands (commands.ts):** `/broke slice <on|off>`,
`/broke slice focus <path>`, `/broke slice focus clear`,
`/broke slice parser <heuristic|ast>`, `/broke slice status`
(active focus per task). Stats: `TaskStats.savedChars.slice` (estimated:
full-file chars vs. interface-view chars, only when a slice actually
replaced content).

### Acceptance criteria

- [x] Reading a TS file ≥ `minChars` returns imports + declarations +
      signatures with elided bodies; reading the focus file returns the full
      body (focus symbol when resolvable).
- [x] Edit-tool call on file X makes the next read of X full-body
      (`focusAuto`), and reads of other files stay sliced.
- [x] Python files slice correctly (def signatures incl. type hints,
      `__init__`, class members).
- [x] `slice.enabled: false`, non-sliceable extensions, small files, error
      outputs and image parts pass through untouched.
- [x] Unknown read/edit tool names are logged once and never crash the hook.
- [x] `/broke slice status` shows the current focus and parser mode.
- [x] README documents the Aider-CLI-context gap (S1 result) honestly.

### Verification

`npm run typecheck` && `npm test` (`tests/slice.test.ts`: TS/Py fixtures,
focus resolution, markers, passthrough cases). Spike S1 + S4 before hook
implementation. Manual check: real task, agent reads two files, one focus,
one not; verify the model sees the sliced view.

---

## F3: State Snapshotting & Memory Flushing

**Version:** 0.9.0 (shipped; originally planned for 0.4.0, which shipped without it). **Effort:** M.

### Objective

On milestone ("sub-goal reached"), persist a compact JSON state protocol
("Feature X built, exports A/B created") and optionally flush the accumulated
conversation so the next step starts from a lean context. Verified API facts:
`TaskContext` exposes `getContextMessages`, `removeMessage`,
`removeLastMessage`, `removeMessagesUpTo(messageId)`, `loadContextMessages`,
`addContextMessage`, `getUpdatedFiles`, `generateText`, `askQuestion`, true
history replacement is therefore **possible**. AiderDesk also ships
`handoffConversation(focus?, execute?)`; F3 complements it rather than
replacing it (snapshots are inspectable JSON; flush is only one of its uses).

### Design

**New module `snapshot.ts`:**

- Zod schema `SnapshotRecord`:
  `{ version: 1, taskId, taskName, createdAt, goal, achieved, files: string[], commit?: string, summary, historyFile?: string }`
  `goal` = first user message (truncated to 2,000 chars); `files` =
  `getUpdatedFiles()`; `summary` = compact text via existing summarizer deps
  (`SummarizeDeps`, `maskSecrets` applied) or a template when unavailable.
- Persistence: `join(__dirname, 'snapshots', taskId, '<iso>_<label>.json')`
  (extension dir, like `stats.jsonl`, survives deploys; S3 verifies
  `deploy.ps1`). `snapshot.keepHistory` (default `false` since the external
  review F-01/D1: raw histories may contain secrets - opt-in) additionally
  writes the raw message array to `<iso>_<label>.history.json`; the
  destructive flush keeps its undo file via `flush.undo` (default `true`).
  Rotation: keep last 50 per task AND an aggregate byte budget per task
  (review F-14).
- Triggers:
  - `onAfterCommit` (read-only event, but writing our own files is allowed):
    record from commit message + `getUpdatedFiles` + current summary.
    Config `snapshot.onCommit` default `true`.
  - Manual `/broke snapshot <label>`, always available.
  - Test-green detection (`onToolFinished` heuristic on test-runner/bash
    results: exit code 0 + `passed`/`ok` patterns), config
    `snapshot.onTestPass` default `false` (false positives).

**Flush (manual only in v1, automatic flushing while an agent loop runs is
dangerous: removed message ids may be referenced by the running step):**

- `/broke flush [--yes]` (chat command, runs between turns):
  1. Write snapshot + history file (abort if writing fails).
  2. `getContextMessages()` → plan via pure `buildFlushPlan(messages, stateMessage)`
     (testable): keep = first user message (task brief) + last state message;
     remove = everything between them.
  3. `removeMessagesUpTo(lastKeptId)` + `addContextMessage(stateMessage)`,
     `loadContextMessages` is the documented alternative (S2 decides).
  4. State message: `[broke-state]` marker + compact JSON of the record.
- `/broke flush --undo <n>`: restore from the history file via
  `loadContextMessages` (only when the task is idle; S2 gates this).
- Config: `snapshot.onCommit` (true), `snapshot.onTestPass` (false),
  `snapshot.keepHistory` (false, opt-in), `flush.confirm` (true),
  `flush.undo` (true - flush aborts untouched when its undo file would
  exceed the size cap), uses
  `askQuestion` or `--yes`.

**Commands (commands.ts):** `/broke snapshot [label]`, `/broke snapshot list`,
`/broke snapshot show <n>`, `/broke flush [--yes]`, `/broke flush --undo <n>`.

### Acceptance criteria

- [x] `onAfterCommit` writes a valid `SnapshotRecord` (schema-parseable) with
      files + commit + summary; secrets are masked; failures never propagate.
- [x] `/broke snapshot list/show` renders persisted records.
- [x] `/broke flush` without `--yes` asks for confirmation; snapshot +
      history file exist before any message is removed.
- [x] After flush, the task context = task brief + `[broke-state]` message;
      the agent answers a follow-up prompt correctly (manual check).
- [x] `--undo` restores the exact prior message array from the history file.
- [x] History files are capped/rotated (count + aggregate byte budget per
      task, F-14); `snapshot.keepHistory: false` skips them for
      auto/manual snapshots while `flush.undo` keeps `--undo` working.
- [x] README documents the `.aider.chat.history.md` desync per S2.

### Verification

`npm run typecheck` && `npm test` (`tests/snapshot.test.ts`:
serialization, goal extraction, `buildFlushPlan`, rotation, undo roundtrip).
Manual: real task with 20+ messages → snapshot → flush → follow-up prompt →
`--undo`.

---

## F4: Local Keyword/Vector Index with Snippet Summaries

**Version:** 0.10.0 (shipped 2026-08-27; originally planned for 0.5.0, which shipped without it). **Effort:** L.

### Objective

A project-local search index that returns **compressed snippet summaries**
(top-k results, ±6 lines around the match) instead of dumping whole files
into the context. Honest positioning: AiderDesk already ships
`power---semantic_search` (app-level vector search) and a cached repo map
(`TaskContext.getRepoMap()`). Broke's differentiators: token-budgeted snippet
output, offline keyword mode with zero embedding dependency, per-project
persistence, and integration with the compression pipeline's philosophy.

Implementation notes (v1 as built, plan decisions E1-E7):

- **E1 spike outcome (supersedes the doc-head API assumption):** `getTools`
  and `ToolDefinition` DO exist in published `@aiderdesk/extensions`
  0.31.0 (`dist/index.d.ts`, zod v4 on both sides) - an earlier grep pass
  missed them, app main shows the same shape
  (`getTools?(context, mode, agentProfile): ToolDefinition[]`). So broke-search
  registers against the REAL typed interface; the one unverified acceptance
  step stays a live agent session invoking the tool (post-deploy check).
- **E2 persistence:** `index/<projectHash>/index.json` is carried by BOTH
  deploy.ps1's extension preserve list AND update.ts `preserveRuntimeState`
  (64 MB cap mirroring errors/). The update.ts path has hermetic regression
  tests (`index/ preserve cap` suite); the deploy.ps1 side is covered by its
  CI smoke jobs (dry-run + real secret-filtered deploy) instead of a dedicated
  assertion that the preserved directory survives an actual swap.
- **E3 scope:** keyword BM25 ONLY. The config enum stays single-valued
  ('keyword') until vector/hybrid actually exist - no forward-declared dead
  options; embeddings land in v2 behind `search.backend` via `ollamaEmbed`.
- **E4 no startup indexing:** builds happen lazily before queries and off
  throttled commit signals (onAfterCommit -> TTL-cached refresh); neither
  app start nor the agent loop is blocked synchronously.
- **E5 honesty:** NO savedChars/stats claims anywhere for F4. Value comes
  from agents choosing budgeted snippets over bulk reads; the tool footer
  reports result counts + indexed-file counts instead.
- **E6 privacy/size:** persisted state = term postings + file metadata
  (mtime/size/tokenCount) ONLY. Snippets are read live from disk at query
  time and never reach storage beyond ordinary tool-result history.
  Skip-list mirrors slice.ts plus `.aider-desk`; INDEX_MAX_ENTRIES caps
  pathological walks with an honest TRUNCATED flag.
- **E7 default on:** a registered tool ships its JSON schema with every
  model call - documented tradeoff in README; controlled via
  `/broke search on | off` (reserved-keyword parsing, pattern from
  snapshot list) or the settings dialog.

### AiderDesk compatibility

Fully compatible, v1 needs no app API beyond filesystem access:
`ExtensionContext.getProjectDir()`, optional `TaskContext.getAllFiles()` /
`getUpdatedFiles()` for change detection, and `getTools()` for the
`broke-search` tool (name kebab-case, zod `inputSchema`). Vector tier reuses
the existing Ollama HTTP client (add `ollamaEmbed` to `local.ts`,
`POST /api/embeddings`). App `MemoryContext` (LanceDB) is explicitly **not**
used: it is global memory, not a per-project file index, and storing file
snippets there would pollute it.

### Design

**New module `indexer.ts`:**

- `Indexer` class: build/update/query. State per project (hashed project
  path): `join(__dirname, 'index', <projectHash>, 'index.json')`.
- Build rules: walk project root; skip `node_modules`, `.git`, `dist`,
  `build`, `vendor`, `.aider-desk`; per-file cap 512 KB; extensions allowlist
  (ts/tsx/js/jsx/py/json/md in v1). Tokenizer: lowercase, identifier-aware,
  minimal stopword list. Inverted index: `term → { file, tf }`; per-file meta
  `{ path, mtime, size }` for incremental rebuilds (only changed files
  re-indexed; merge in place).
- Query: BM25-style ranking; top-k (default 8); snippet = ±6 lines around the
  best match line, middle elided with markers; per-result
  `path:line` + match count; total snippet budget ≤ `search.maxChars`
  (default 6000 chars ≈ 1.5k tokens), the snippet summary *is* the token
  control.
- Staleness: `onAfterCommit` + `onFilesAdded` trigger async, throttled,
  never-throwing rebuilds; queries rebuild lazily when index mtime is older
  than the newest project file change.
- Failure isolation: index build/query errors return a short message and
  never throw into the agent loop.
- v2 (config `search.backend`): `vector`/`hybrid` via Ollama embeddings
  (`nomic-embed-text` or similar, pulled on demand; graceful fallback to
  keyword when Ollama is offline, same pattern as the summarizer).

**Tool (index.ts, `getTools`):** `broke-search`, zod schema
`{ query: string (1-500 chars); k?: number; files?: string[] (<=100 filters, each <=512 chars) }`
- model-generated arguments are untrusted, so the ceilings are schema-hard
(BRK-018); returns the snippet summary text (plus one-line footer with index
stats, which counts toward the char budget). Chat convenience:
`/broke search <query>`.

**Commands (commands.ts):** `/broke index [rebuild]`, `/broke index status`
(file count, index size, last build), `/broke search <query>`,
`/broke index backend <keyword|vector|hybrid>` (v2).

**Config (config.ts, new `search` block):**

```ts
const SearchSchema = z.object({
  enabled: z.boolean().default(true),
  backend: z.enum(['keyword', 'vector', 'hybrid']).default('keyword'),
  maxResults: z.number().int().min(1).max(50).default(8),
  /** Total snippet budget per query - the token control (hard range 500-50k, BRK-018). */
  maxChars: z.number().int().min(500).max(50_000).default(6000),
  contextLines: z.number().int().min(1).max(20).default(6),
  maxFileKB: z.number().int().min(1).max(2048).default(512),
});
```

### Acceptance criteria

- [x] `broke-search` returns ≤ `maxResults` results with `path:line`,
      snippet windows and match counts, total ≤ `maxChars` chars
      including the footer (BRK-017).
- [x] Incremental rebuild re-indexes only changed files (mtime/size);
      index survives extension reload; S3 confirms deploy preservation.
- [x] Query while a file changed since last build returns fresh results
      (lazy rebuild) without blocking the agent loop.
- [x] Unindexable dirs (`node_modules` etc.) are never walked;
      `enabled: false` removes the tool.
- [x] `broke index status` reports honest numbers; rebuild failures degrade
      to a short message.
- [ ] v2: `vector` backend returns embedding-ranked results and falls back to
      keyword when Ollama is unreachable.
- [x] README positions the feature vs. `power---semantic_search` + repo map.

### Verification

`npm run typecheck` && `npm test` (`tests/indexer.test.ts`: tokenizer,
build/merge on tmp fixture dir, BM25 ranking, snippet windowing, staleness,
budget cap, rotation). Manual: real project → `/broke index` → `broke-search`
via agent; verify snippet budget in a large repo.

---

## Versioning & delivery (per feature)

- One feature per release: `feat:` conventional commit (or a short-lived
  branch merged within days), annotated tag `v0.x.0`, CHANGELOG entry under
  `[Unreleased]` written with the change, README updated, docs/feats.md status
  flipped to `released`.
- Before commit: `npm run typecheck` && `npm test` (all green).
- Deploy: `.\scripts\deploy.ps1 -Category extensions -Name broke` from a
  clean, tagged state (verify S3: config.json **and** new artifact folders
  survive).
- Version bumps: F1 → 0.2.0/0.2.1 (shipped). F2 → 0.7.0 (shipped).
  F3 → 0.9.0 (shipped) and F4 → 0.10.0 (shipped 2026-08-27) each got their
  own assigned bump; the originally planned F3 → 0.4.0 / F4 → 0.5.0 bumps
  are obsolete because those versions shipped other work.

## Risk register

| Risk | Feat | Impact | Mitigation |
|------|------|--------|------------|
| Tool names differ from docs at runtime | F2 | Med | S4 spike; allowlist + once-logging + feature-detect |
| Aider-CLI context files bypass hooks | F2 | Med | Documented gap; S1 may close via input pass |
| Flush desyncs `.aider.chat.history.md` | F3 | High | S2 spike before implementation; manual-only; undo file |
| Flush during running agent step | F3 | High | v1 manual-only; confirm gate; snapshot before removal |
| Sliced view confuses the model (missing body) | F2 | Med | Focus tracking; marker line; escape hatch `/broke slice off` |
| Index build blocks the agent loop | F4 | Med | Lazy/async builds, throttling, never-throwing |
| deploy.ps1 wipes new artifact folders | F3/F4 | Med | S3 spike; preserve/restore logic |
| Types lag runtime | all | Low | Feature-detect pattern, graceful degradation |
