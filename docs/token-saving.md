# Token-Saving Strategies (how to actually save tokens)

The goal is not "fewer tokens" as a number, it is **useful tokens per
dollar**. Every lever below trades fidelity for size; the art is choosing
which fidelity you can afford to lose, at which layer.

## The token lifecycle in AiderDesk

```
per model call:
  system prompt + rules + repo map + context files   ← fixed cost per turn
  + conversation history (user/assistant/tool msgs)  ← grows with the task
  + tool definitions + current tool results          ← recent additions
  → model processes ALL of it on EVERY call
```

Two consequences:

1. **The conversation history is billed N times**: once per model call.
   Saving 10k tokens in the history saves 10k × (number of calls) input
   tokens, not 10k.
2. **Everything in the context is billed every turn**, so removing
   something once helps forever, while shortening answers helps only once.

## The levers, ordered by leverage

### A. Reduce what enters the context (biggest, structural)

| Lever | Where | Effect |
|---|---|---|
| Don't add files you don't need; drop files when done | task files (`addFile`, file picker) | per-turn saving × every call |
| `includeRepoMap: false` or a finer map (tree-sitter-repo-map extension) | agent profile | repo map is billed every call |
| Keep rules (`rules/*.md`) and system prompts short | profile | fixed per-turn cost |
| Subagents with `contextMemory: off` / `last-message` | profile → subagent | isolates subagent context; parent sees only the result |
| Read files via grep/head/tail instead of full reads | agent behavior | full file contents are the #1 context hog |
| `onFilesAdded` filters (extensions) | extension hook | never let noise in |

### B. Stop the history from growing (Broke's job)

| Lever | When | Loss |
|---|---|---|
| Structural pass (dedupe, drop empties, merge) | every call | none (lossless) |
| Truncate pass (head+tail of old tool outputs, trim tool-call inputs) | above threshold | middle of old outputs |
| Summarize pass (LLM summary of old turns) | above threshold, old turns only | detail of old turns |
| AiderDesk `Compact` / `Smart` compaction | at 30%/200k | same idea, reactive |

Rule of thumb: **the last N turns are the working set, never compress
them.** Everything older is increasingly redundant (the model already acted
on it; the file system already reflects it). Broke protects the last 6
turns by default.

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
| Cheaper model for routine tasks (per-task model override) | DeepSeek-class models ≈ 10-30× cheaper than frontier |
| **Local model offload for summaries** (Broke `summarize via local`) | the summary generation costs **zero cloud tokens** |
| Prompt caching (`--cache-prompts`) | stable prefix billed at cache rate (Anthropic/DeepSeek/OpenRouter) |
| Batch small tasks into one prompt | fewer fixed costs (system prompt per call) |

### E. Measure, then tune

- Broke: `/broke stats`, the 💸 badge: chars/4 heuristic, honest
  estimates, per task.
- savemytoken: `/tokens`: response sizes, truncation counts, USD at real
  model prices.
- AiderDesk usage stats (task settings) show provider-reported token
  usage, the ground truth for calibrating the heuristics.

## What "permanent input compression" means

Two different things, both real:

1. **Transient (per call)**: every input the model sees is compressed,
   but the stored task history stays intact. Broke v0.1 does this. Pros:
   reversible, no information destroyed in the log. Cons: the compression
   work repeats per call (mitigated by the summary cache).
2. **Persistent**: the stored conversation is rewritten (old turns
   replaced by a summary), like AiderDesk's built-in `Compact` compaction
   (`loadContextMessages`). Pros: history stays small forever. Cons:
   destructive, hard to undo.

Recommended: **Broke transient for daily work + built-in `Compact`/Smart
as the emergency brake.** If you want persistent compression on demand,
`/compact`-style rewriting is a natural Broke v0.2 feature (`broke commit`).

## Honest numbers

- chars/4 is a heuristic: English prose ≈ 4 chars/token, code ≈ 3–3.5,
  JSON with keys ≈ 3. The heuristic is *consistent*, which is what makes
  before/after comparisons meaningful.
- A 3B local model summary of ~8k tokens of history costs ~0 cloud tokens
  and ~20–60 s of local time; the same summary via a cloud model costs
  input tokens of the summarizer call (usually cheaper than the turns it
  replaces, but not free).
- The built-in `Compact` uses the **task's model**; on a frontier model
  that is the single most expensive token operation in the app.
