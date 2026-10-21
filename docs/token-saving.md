# Token-Saving Strategies (how to actually save tokens)

The goal is to reduce unnecessary input while retaining enough context to
complete the task. Some levers trade detail for size; inspect the resulting
messages and provider usage before treating character counts as savings.

## The token lifecycle in AiderDesk

```
per model call:
  system prompt + rules + repo map + context files   ← often repeated
  + conversation messages (user/assistant/tool)       ← may grow with the task
  + tool definitions and current results               ← request dependent
  → provider processes the submitted input; caching may change its price
```

Two consequences:

1. Removing 10k actual input tokens from each of N later requests would
   reduce submitted input by 10k × N tokens. The billing effect depends on
   whether those tokens would have been cached and on the provider's rates.
2. A shorter recurring input can help on later calls. A one-time output
   reduction affects that response and any later calls that include it.

## The levers, ordered by leverage

### A. Reduce what enters the context (biggest, structural)

| Lever | Where | Effect |
|---|---|---|
| Don't add files you don't need; drop files when done | task files (`addFile`, file picker) | per-turn saving × every call |
| `includeRepoMap: false` or a finer map (tree-sitter-repo-map extension) | agent profile | can reduce repeated input; provider caching affects the bill |
| Keep rules (`rules/*.md`) and system prompts short | profile | fixed per-turn cost |
| Subagents with `contextMemory: off` / `last-message` | profile → subagent | isolates subagent context; parent sees only the result |
| Read only relevant file sections | agent behavior | avoids adding unnecessary file content |
| `onFilesAdded` filters (extensions) | extension hook | never let noise in |

### B. Stop the history from growing (Broke's job)

| Lever | When | Loss |
|---|---|---|
| Structural pass (dedupe, drop empties, merge) | eligible calls | text preserved; message framing may change |
| Error pass (compiler/test output → diagnostic essence) | above `errors.minChars`, old turns only | error-dump detail |
| Truncate pass (head+tail of old tool outputs, trim tool-call inputs) | above threshold | middle of old outputs |
| Summarize pass (LLM summary of old turns) | above threshold, old turns only | detail of old turns |
| AiderDesk `Compact` / `Smart` compaction | at the configured host threshold | persistent host compaction; exact behavior depends on the host version |

The last N user turns are protected by broke's input pipeline (2 by
default). Older content is only a candidate for compression; it may still
contain facts the agent needs, so review lossy settings for your workload.

### C. Compress output tokens (one-time)

| Lever | Where | Notes |
|---|---|---|
| Brevity directive | savemytoken extension (`/tokens level`) | style compression; code stays byte-exact |
| `maxOutputTokens` | profile / model call settings | caps runaway generations |
| Reasoning models only when needed | model choice | reasoning tokens are output tokens |
| `maxIterations`, tool approval discipline | profile | fewer agent steps = fewer calls |

### D. Cheaper tokens per unit of work (pricing)

| Lever | Notes |
|---|---|
| Lower-priced model for suitable tasks (per-task model override) | compare current provider rates and task quality |
| **Local model offload for summaries** (Broke `summarize via local`) | avoids a cloud summarizer call; uses local compute |
| Prompt caching | stable prefixes may qualify for a provider's model-specific cached-input rate |
| Batch small tasks into one prompt | fewer fixed costs (system prompt per call) |

### E. Measure, then tune

- Broke: `/broke stats`, the 💸 badge: chars/4 heuristic, honest
  estimates, per task.
- Broke: `/broke measure` (in a task) or `npm run measure` (extension
  directory): the measurement ledger `measure.jsonl` aggregates per-run
  sizes and per-pass removals into observed real-session character counts - runs,
  tasks, per-run mean/median/max, per-task breakdowns. The totals are
  sums over individual runs of the same evolving conversation and are
  labeled as such, never presented as a cumulative context claim.
- savemytoken: `/tokens`: response sizes, truncation counts, USD at real
  model prices.
- AiderDesk usage stats (task settings) show provider-reported token
  usage, the ground truth for calibrating the heuristics.

## What "permanent input compression" means

Two different things, both real:

1. **Transient (per call)**: eligible messages can be compressed before a
   model call while stored task history stays intact. Broke's default input
   pipeline does this. Pros:
   reversible, no information destroyed in the log. Cons: the compression
   work repeats per call (mitigated by the summary cache).
2. **Persistent**: the stored conversation is rewritten (old turns
   replaced by a summary), like AiderDesk's built-in `Compact` compaction
   (`loadContextMessages`). Pros: history stays small forever. Cons:
   destructive, hard to undo.

Recommended: **Broke transient for daily work + built-in `Compact`/Smart
as the emergency brake.** For the on-demand persistent variant, use
`/broke flush`: it replaces everything after the task brief with one
`[broke-state]` message, is manual and confirmed by default, and is
reversible through the history file that `/broke flush --undo <n>` reads
back (F3 state snapshotting & memory flushing, shipped in v0.9.0, see
docs/feats.md).

## Honest numbers

- chars/4 is a heuristic: English prose ≈ 4 chars/token, code ≈ 3–3.5,
  JSON with keys ≈ 3. The heuristic is *consistent*, which is what makes
  before/after comparisons meaningful.
- Merging adjacent assistant messages keeps the full text in the context
  (only the message framing disappears), so merges count 0 saved chars in
  the stats: the badge never inflates savings with merges.
- A local summary uses no cloud summarizer request, but consumes local time
  and compute. A cloud summary adds one or more billable requests; its net value depends
  on the summary size, later reuse and model pricing.
- In the documented AiderDesk 0.85 source snapshot, built-in `Compact` uses
  the task model. Its cost depends on that model and the conversation size.

## Inspecting the diff without paying for it

`/broke diff` renders the uncommitted changes as a digest under a char
budget (`/broke diff [chars]`, default 4000). It reads each file's diff
through `TaskContext.getUpdatedFileDiff`, which AiderDesk 0.84 added when it
moved updated-file diffs to lazy per-file loading. Before that, getting
diff content into an extension meant shelling out to git.

The digest is deliberately a *budgeted view*, not a dump:

- the header names the file count, the summed `+`/`-` lines and the total
  diff size the host actually returned;
- files are shown in the host's own order until the budget runs out, and the
  digest then names exactly how many files it left out rather than cutting
  silently;
- a binary or unreadable file is reported as `binary or unreadable`, never as
  `0 chars` - the SDK returns an empty string for binary files *and* on
  error, so a size that was never measured is never printed as a number;
- one failing diff read costs that one file, not the whole digest.

On a host older than 0.84 the command says which version it needs instead of
throwing or pretending the task has no changes.

## Why the index ignores git-ignored files (and the index boundary is intentional)

`search.includeGitIgnored` (BRK-003) already exists and is **off by
default**. That default is not an oversight, and AiderDesk 0.84/0.85 does not
change it:

- **Committing and indexing are different subsystems.** 0.84 and 0.85 made
  the HOST's commit action force-stage git-ignored files (`git add -A -f`
  retry). That decides what enters version control. broke's indexer decides
  what becomes *searchable*, and a search hit flows straight into the model
  prompt.
- **The files people ignore are the ones they consider private.** A match on
  an ignored `.env` line would put a secret into the prompt. The dot-path and
  sensitive-basename denylists stay on regardless of the flag.
- **Generated output is not worth indexing.** Ignored trees are usually
  build artifacts and dependencies; indexing them costs disk, time and search
  precision for nothing.

The host sets the same precedent: AiderDesk 0.82 gave its own grep tool an
opt-in `ignoreGitignore` parameter - ignore by default, widen per call. If you
want broke to search ignored files, turn `search.includeGitIgnored` on
deliberately; it is your call, not a default.
