# How AiderDesk already saves tokens (verified from source)

Facts verified 2026-08 against the installed AiderDesk source
(`%APPDATA%\aider-desk\Cache\extensions\hotovo-aider-desk\src`, release
0.77.x/0.78.0-dev). File references are relative to `src/main/`.

## 1. Message optimizer — runs before EVERY model call

`agent/optimizer.ts` (`optimizeMessages`, called from `agent/agent.ts` in
`getBaseModelCallParams`, i.e. every LLM call, including subagents):

| Pass | What it does | Loss |
|------|--------------|------|
| Important reminders | Injects `<ThisIsImportant>` reminders (todos, subagents, plan approval, worktree, memory) into the first user message | adds tokens (small) |
| Image tool results | Moves image data out of tool results into a user message (provider compat) | — |
| Duplicate tool calls | Detects same tool + same input called twice in a row and replaces the second result with an error notice (loop breaker, also saves the duplicate result tokens) | result text |
| Aider messages | Strips `responses` and `promptContext` from `aider---run_prompt` results | yes |
| Subagent messages | Replaces the full subagent message array with the last message's text | yes |

Extensions can hook this exact point via `onOptimizeMessages` — that is
where **Broke** plugs in.

## 2. Automatic context compaction — at a threshold, not before

`agent/agent.ts` (~line 1928): when token usage exceeds the effective
threshold, the conversation is compacted. Defaults: **30% of the context
window / 200k tokens** (`taskSettings.contextCompactingThreshold`), or
per-profile `autoCompactThresholdPercentage` / `autoCompactThresholdTokens`.
The aborted run logs `Agent run aborted due to context compaction` and the
task continues from the compacted conversation.

Three compaction types (`autoCompactionType`, default `Compact`):

- **`Compact`** (`agent/compaction.ts`) — LLM summarization: the **same
  model as the task** (`profile.provider/profile.model`) summarizes the
  whole conversation into a `### **Conversation Summary**` block
  (`buildCompactSummaryMessages`). Persistent: the task's stored history is
  replaced. This is Aider's classic `/compact`.
- **`Smart`** (`agent/smart-compaction.ts`, `smartCompactMessages`, levels
  1–5, last 10 messages protected) — structural, mostly lossless:
  - removes errored / no-op tool calls and results
  - collapses repeated file edits per file into one
    `<file-edited path="...">` marker
  - removes file reads for files that were edited later (stale)
  - compacts file reads, removes obsolete searches
  - compacts semantic searches and bash outputs
  - redacts fetch outputs
  - truncates non-power tool results (L1: 20 lines / 2 KB / 2000 tokens,
    L2: 10 / 1 KB / 1000, L3+: full redaction)
  - removes verbose tool calls, removes reasoning parts
  - merges consecutive assistant messages
- **`Handoff`** — subagent variant (falls back to Smart for subagents).

Key property: both mechanisms are **reactive** — they fire only when the
threshold is hit. Between calls, the full context goes to the model.

## 3. Tool result truncation

`agent/utils.ts` `truncateToolResult` defaults: **1000 lines / 50 KB /
50k tokens**. Applied by the app to MCP server tool results (e.g.
`puppeteer---*`, `playwright---*`) and by `smart-compaction`.
Extension tools (`power---*`, `tasks---*`, …) are NOT truncated by the app
by default — that's the gap savemytoken fills with per-tool limits.

## 4. Prompt caching

The task configuration supports Aider's `--cache-prompts` (option wired
through `task/aider-manager.ts`). With cache-enabled providers (Anthropic,
DeepSeek, OpenRouter cache tiers, Gemini), repeated system prompt + repo
map prefix is billed at a fraction of the price. Broke's summaries benefit
directly: a stable compacted prefix is exactly what caches love.

## 5. Repo map & context files

- `includeRepoMap` profile flag (agent.ts) — Aider's tree-sitter repo map
  is the default way to give the model repo structure without full files.
  The `tree-sitter-repo-map` extension replaces it with a finer map.
- `includeContextFiles` + manual file management: files in context are
  billed every turn. Dropping files (or using read-only add) directly
  reduces per-turn input tokens.
- Rule files (`rules/*.md`) are auto-discovered per profile — keep them
  short; they are billed every turn.

## 6. What combines well with Broke

| Mechanism | When it runs | Relationship to Broke |
|---|---|---|
| Built-in optimizer | every call | Broke runs *after* it (`onOptimizeMessages`), so it compresses the already-optimized messages |
| `Compact` (LLM summary) | at 30%/200k threshold | Expensive (same model). Broke's `summarize` level does the same job **proactively at a lower threshold and optionally via a free local model** — set `autoCompactionType: Smart` and let Broke do the lossy part |
| `Smart` compaction | at threshold | Broke's structural + truncate passes are a light, per-call version of the same idea — it defers the emergency compaction |
| MCP truncation (1000/50) | per MCP tool result | Broke truncates *old* tool results of extension tools (200 lines/20 KB default) on the way into context |
| Prompt caching | per call | Broke keeps the compressed prefix stable → better cache hit rates |
| Repo map | per call | Smaller repo map / `includeRepoMap: false` + Broke = strictly smaller per-turn input |

Recommended profile setup for token-heavy agentic work:

```jsonc
{
  "autoCompactionType": "Smart",          // let Broke handle lossy compression,
                                          // Smart stays structural
  "autoCompactThresholdPercentage": 40,   // give Broke room to act first
  "includeRepoMap": true,                 // or false when Broke+files suffice
  "maxTokens": 8192
}
```

## Sources

- `agent/optimizer.ts`, `agent/compaction.ts`, `agent/smart-compaction.ts`,
  `agent/agent.ts`, `agent/utils.ts`, `task/aider-manager.ts` in the
  installed app package (`%APPDATA%\aider-desk\Cache\extensions\
  hotovo-aider-desk\src\main\`).
- `docs/aiderdesk-reference.md` (project notes, gathered 2026-08-07).
