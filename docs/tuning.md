# Tuning: what to use when

broke ships sane defaults - most users never touch anything. This page is
the map for everyone who *does* want to tune: which lever helps in which
situation, what each setting change actually buys you, and how autonomous
agent runs differ from interactive sessions. For the raw command list see
the [README](../README.md#usage), for the internals
[docs/overview.md](overview.md), for every setting and its default the
[configuration table](../README.md#configuration).

One principle first: **saved characters are billed again on every later
model call.** Removing 10k chars at minute five of a long session removes
them from dozens of subsequent requests - which is why almost every tune
pays nearly nothing on short tasks and compounds massively on long ones.

## Which level for which job

The three levels are strictly additive; `truncate` includes `structural`,
`summarize` includes both. Pick the deepest one whose losses you accept.

| You are doing | Recommended setup | Why |
|---|---|---|
| Short chats and quick fixes (input stays < ~60k chars) | Leave defaults | The lossy passes only engage above `maxContextChars` anyway; structural cleanup and the error pass stay active regardless |
| Debug-heavy work: compiler/test loops | `errors on` (default); raise `errors lines` to 12-15 if summaries feel starved | Error dumps get replaced by their diagnostic essence *even below the global threshold* (`errors.minChars` is its own gate) |
| Medium sessions that cross the threshold regularly | `level truncate` + `measure on`; lower `maxContextChars` to ~45000 | Truncation of old tool outputs is the highest-value lossy pass - detail loss matters least there |
| Long or milestone-heavy tasks | `level summarize` with the **local** Ollama summarizer; snapshots come free via `snapshot.onCommit` | The reference benchmark removes ~90% of the input at this level, with near-zero recurring cost since the summarizer runs locally |
| Very long scrollback you want slimmed for good | Snapshot first, then `/broke flush` between milestones | Flush is the one destructive operation - manual, confirmed, and reversible through the history file |
| Read-heavy agents exploring a big codebase | `/broke slice on`, clear the focus afterwards | Interface views instead of full bodies; the focus file (last edited) always comes back complete |
| Finding where something lives without filling the context | Leave `search.enabled` on (default); combine with `/broke slice on` | The agent gets a `broke-search` tool and can pull path:line snippets under a char budget instead of bulk-reading files; sliced views keep the reads it still makes cheap |

Rule of thumb for the summarizer backend: a **cloud** summarizer trades one
extra request for the old region on every later call that re-sends it. It
pays off when that region is large and re-sent often, and loses when the
task is short or the region small. The crossover moves with the
summarizer's price, the summary length and the number of following calls,
so there is no fixed number worth quoting here - the honest way to decide
is to read the summarizer's own cost in `/broke stats` next to the
measured gross saving. The default `local` has no such trade-off at all: it
is free, just slower (~20-60 s per regeneration).

## Settings and their effect on task length

Shorthand used below: **SHORT** = the conversation never crosses
`maxContextChars`; **MEDIUM** = it crosses occasionally; **LONG** =
100k+ chars of accumulated history, multi-milestone work.

| Setting (default) | Effect on SHORT tasks | Effect on MEDIUM sessions | Effect on LONG tasks |
|---|---|---|---|
| `maxContextChars` (60000) | Raising/lowering changes nothing until the session crosses the line | Lowering engages the lossy passes sooner - usually the best single tune | Most sensitive lever here: set too high, broke stays passive while the bill grows; set too low, summaries churn constantly |
| `protectedTurns` (2) | Nearly no effect (few user turns exist) | Moderate: each extra turn shields recent context but shrinks the compressible region | The classic over-tune mistake: protecting 8-10 turns on a long session can eat most of the savings - keep it low |
| `truncate.maxLines` / `maxKB` (200 / 20) | Only relevant if old, huge outputs already exist | Primary dial for how much old output detail survives truncation | Every char kept here is re-billed on every later call - tighten before loosening |
| `truncate.maxInputChars` (2000) | Rarely relevant | Trims oversized tool-call inputs (long writes/greps) | Same compounding logic as above |
| `errors.minChars` (8000) | **Works below the global gate**: a giant test log in a small chat gets compressed regardless | Good balance at 8000; go to ~5000 if your logs are routinely noisy | Low values start rewriting borderline outputs - watch for over-compression, not cost |
| `errors.contextLines` (8) | Detail-per-failure tradeoff, tiny cost either way | Raise toward 12-15 if error summaries lose needed context | Pure quality knob; cost impact is negligible next to truncation |
| `errors.toolLevel` (off) | Off: nothing touches stored history | On: tool results are rewritten *at the source* - savings become permanent instead of per-call | On also means irreversible rewrites plus archived copies (`errors.archive`) eating disk - default off is deliberate |
| `slice.enabled` (off) | Files under `minChars` (4000) pass through untouched; likely dormant | Pays off as soon as an agent reads multiple large files | Interface views shrink every subsequent call that still carries those reads - and the rewrite of stored results is irreversible; disable slicing later does not restore them |
| `slice.focusAuto` (on) | - | Keeps the file just edited intact automatically | If reads return sliced views *you* did not want, check `/broke slice status` - explicit focus beats surprises |
| `summarize.via` (local) | Nothing to summarize yet | Local adds seconds of latency per regeneration; cloud adds provider tokens | Local wins outright at scale: constant quality/cost ratio; cloud with `cloudModelId` = a cheap model only, never the task's frontier model |
| `summarize.afterTurns` (8) | Irrelevant until summarizing starts | Shields recent steps from summarization | Over-raising starves the summarizer on turn-poor sessions - note regions with zero user turns (autonomous loops) exempt themselves anyway |
| `summarize.minChars` (8000) | Gate never met | Fine where it is | Do not lower much: a summary call costs one extra request, small regions never amortize it |
| `snapshot.onCommit` (on) | Cheap, harmless | Free milestone trail after each commit | Summary-only by default (privacy review F-01): raw undo files are opt-in via `snapshot.keepHistory`. The destructive flush keeps its undo file via `flush.undo` (on) |
| `snapshot.onTestPass` (off) | - | False positives on flaky suites made this opt-in | Enable only if your test runner prints a clean `passed`/exit-0 pattern reliably |
| `stats.measure` (on) | Negligible overhead, records every compression run | These ledger records are your provable numbers (`/broke measure`) | Keep it on; 5 MB rotation bounds the file |
| `search.enabled` (on) | Dormant cost only: the registered tool ships its JSON schema with every model call even if never used - `/broke search off` drops that for agents that never search | First real payoff: snippets replace whole-file reads when locating code | Compounds: smaller read results flow into every later call; commits trigger a throttled refresh, queries serve the snapshot within a 60s freshness window and re-scan after it (BRK-013 TTL) |
| `search.maxChars` (6000) / `contextLines` (6) | Irrelevant while dormant | Tighten toward 4000 chars if result sets feel bloated | Lower budgets buy extra headroom below `maxContextChars`; snippets land there once, then get compressed like any other tool output |
| `search.scanBudgetMs` (2000) | Irrelevant | Only matters if a result footer says the index is TRUNCATED | Raise it (max 60000) on a very large monorepo so the first full index finishes; a lower value keeps commit-time refreshes snappy at the cost of more refresh passes |

## Running autonomous agents

An autonomous run (one task brief, then the agent loops with power tools)
behaves differently from a human-driven session - in three ways, all
deliberate:

1. **Protection falls back automatically.** There are no repeated user
   turns to protect, so broke drops from turn-based protection to keeping
   only the current step (task brief + last few messages) untouched and
   treats the rest of the loop as compressible - exactly what you want.
2. **The summarizer stays alive.** Regions with zero user turns exempt
   themselves from the `afterTurns` gate; otherwise summarization would
   be permanently dead precisely in these sessions.
3. **Milestones write themselves.** Every successful commit produces a
   snapshot record (`snapshot.onCommit`).

A practical playbook:

- **Before:** check Ollama reaches the extension (`/broke status` shows it),
  keep `measure on`. Leave `search.enabled` on unless the run will not touch
  code at all - locating definitions via budgeted snippets is exactly what
  keeps an autonomous loop's context from ballooning early. Decide
  consciously whether to enable `snapshot.onTestPass` - commit-based
  snapshots alone are usually enough. Never wire `flush` into the loop itself.
- **During:** let it run. Compression happens inside every model call;
  expect the badge to stay at an honest zero until the input crosses
  `maxContextChars`, then move. Do not run `/broke flush` while an agent
  step is executing - it is designed to run between turns only.
- **After:** `/broke stats` gives the per-pass breakdown,
  `/broke measure` the real-run ledger, `/broke snapshot list` the milestone
  trail. Optionally `/broke flush --yes` to slim the task before follow-up
  prompts - undoable while `flush.undo` is on (default).
- **If the badge says 0 but you expected savings:** run `/broke why` - it
  walks the gates live and names the first one blocking.

## The settings dialog

The badge gear (⚙) opens a quick settings dialog with the core knobs.
Both it and the full settings panel offer **Task length**
(`short / normal / long / custom`) and **Broke automation**
(`autonomous / manual`) selectors. These settings are extension-wide;
task-length presets leave the cache profile and escape hatch unchanged.
Editing a preset-owned field (level, threshold, protected turns, truncate
limits, summarize-after) relabels the mode to `custom` immediately, in the
panel, in the badge dialog and on disk - a late write from the host or
another surface cannot restore a stale preset label. Long-mode selection
(`mode long` or `config set mode long`, any quoting that actually
persists) shows the Ollama/cloud cost and consent guidance BEFORE the
write; invalid spellings are reported as a rejection, never as pending
Long guidance. The full settings panel retains cache controls and their
inline tooltips. Cancel and Escape dismiss the badge dialog during
loading, previewing, or errors, but are blocked while a save is in
progress to avoid implying that an in-flight write was cancelled.

`/broke measure` reports escape rewrites plus the provider-reported cache
tokens (writes / reads / billed).
