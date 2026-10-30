# Feature deep dives

One page per feature that needs more than a line of explanation. The
command list, the configuration table and the honest cost numbers live in
the [README](../README.md); the pipeline internals and the module map live
in [docs/overview.md](overview.md); the tuning matrices are in
[docs/tuning.md](tuning.md).

## Cache-friendly mode (provider prompt cache)

The current code models Anthropic cache writes at 1.25x and reads at 0.1x,
and OpenAI reads at 0.5x. These are fixed estimate parameters; actual
cache rates and eligibility vary by model and provider. See the
[Claude prompt-caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
and [OpenAI prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).
Cache-friendly mode (`cache.profile`) tries to preserve already-sent message
bytes. A stable prefix can improve cache reuse, but neither a hit nor a
particular saving is guaranteed:

- `anthropic` / `openai`: the sent-ledger freezes already-sent messages.
  Structural merges re-derive identical bytes, the error/truncate passes
  skip frozen outputs, and the summarize pass re-serves the cached summary
  and appends new turns verbatim instead of regenerating over sent bytes.
- `auto` (recommended): detects the rules from the task model - Claude
  models get the Anthropic rules, GPT/o-models the OpenAI ones, anything
  else keeps the plain behavior.
- The **escape hatch** (`cache.escapeHatch`) is the one sanctioned cache
  loss: if the compressed candidate still exceeds `maxContextChars`, an
  eligible run gets ONE deliberate full rewrite. An input above budget whose
  candidate fits needs no escape or ledger reset. The hatch locks until a run fits under budget
  again (hysteresis / re-arming), and the cache re-stabilizes on that run's output.
  Escape operations are transactional: if output validation fails, changes revert
  cleanly without locking the hatch or dropping cache state.
  With the hatch off, sent bytes are never rewritten - even over budget.
- The **anchor breakpoint** (`cache.anchorBreakpoint`, default **off**, opt-in,
  Anthropic only) adds a `cache_control` marker to the last already-sent
  message in broke's frozen prefix. It does not remove the host's marker on
  the tail. The provider may reuse an earlier prefix through its own lookback
  even without this option, so measure cache-read tokens before claiming an
  improvement. The marker is merged into that message's existing
  `providerOptions`. This needs the `anthropic` profile and has no effect
  when no prior message is in the sent ledger.

Two limits of broke's cache accounting:

- Providers with no documented cache economics resolve to no cache
  awareness at all. That includes `llmapi` (new in AiderDesk 0.85) and any
  provider broke does not know - a local or unlisted runtime must not be
  billed as if it had a cache.
- `cache.openaiStateless` is a conservative accounting switch for the
  `auto` profile when you do not want broke to assume OpenAI cache hits.
  Neither `store: false` nor Zero Data Retention by itself means prompt
  caching is unavailable: OpenAI documents an in-memory cache mode for
  eligible Zero Data Retention organizations. Broke cannot inspect the
  host's provider settings or prove a hit from message stability alone;
  compare provider-reported cache tokens instead. An explicit
  `cache.profile` overrides this switch.

## ST-slicing (tool-level, opt-in)

Independent of the input pipeline, `slice.enabled` (default **off**)
rewrites what large file reads deliver to the model: instead of full file
bodies, the agent receives an interface view - imports, type/interface
declarations in full, function/class signatures with bodies elided,
dataclass fields and def signatures for Python - capped at
`slice.maxChars` with an honest fallback to full content when the view
would not shrink or would grow too large. The view carries an explicit
`[broke: interface view - N of M lines ...]` marker naming the escape
hatch (`/broke slice off`).

The *focus* file always returns in full: explicitly via
`/broke slice focus <path>`, automatically after an edit-tool call on it
(`focusAuto`), or while it has pending task changes. Because this rewrites
the stored tool result (unlike the input pipeline), it is opt-in by
default - and the rewrite is **irreversible**: disabling slicing later does
not restore already-stored views. The AiderDesk extension API currently
offers no way to keep the original output and send a projection (the tool
event carries a single `output` field); if that changes, broke will adopt a
non-destructive pipeline.

Known gap (verified by spike S1): files Aider itself injects into context -
repo map, `/add`, connector-read content - bypass tool hooks entirely and
are never sliced. Slicing only covers what flows through file-read tools.
Savings appear as an estimate under `slice:` in `/broke stats`.

## Snapshots & flush (F3)

Long sessions pile up intermediate steps the agent no longer needs. Broke's
F3 records **milestone snapshots** - compact, human-inspectable JSON files
(`goal`, `achieved`, changed `files`, optional commit hash, a masked text
summary) under the data root (`snapshots/<taskId-slug>-<hash>/`, outside the swappable extension tree). They are written
automatically after every successful commit (`snapshot.onCommit`, default
on), optionally on detected test-green tool results (`snapshot.onTestPass`,
default off), and manually via `/broke snapshot [label]`.

The *flush* is the only destructive operation in broke. `/broke flush`
replaces only an older region proven to be covered by a current cached summary
with ONE `[broke-state]` message. The task brief, headers and newer messages
remain unchanged. Missing, edited or stale summary coverage causes an abort;
`--yes` skips confirmation, never the coverage check. Flush does not generate
a summary: use `/broke summarize now` explicitly when a valid summary can be
created under the current backend and cache policies. It is manual,
asks for confirmation (`flush.confirm`), writes BOTH the snapshot record and
a raw-history undo file BEFORE touching any message. With `flush.undo` off,
flush refuses replacement rather than writing history without consent. It aborts untouched if
those writes fail or the undo file would exceed its size cap, and
`/broke flush --undo <n>` restores the byte-identical
history afterwards. Auto/manual snapshots are summary-only by default
(`snapshot.keepHistory` off, review F-01); undo files for them are opt-in.

Known limitation (spike S2): AiderDesk also maintains
`.aider.chat.history.md` in the task folder as its own connector artifact.
Replacing the context messages does not rewrite that file; depending on the
AiderDesk version it may re-hydrate old content on the next prompt. If you
observe flushed content returning, prefer AiderDesk's native
handoffConversation-style flows or report back to the broke issue tracker -
this remains a host-version-dependent limitation.

## Local project search (broke-search tool)

`search.enabled` (default **on**) registers a `broke-search` agent tool
backed by a per-project keyword index: identifier-aware tokenizer, BM25
ranking, top-k results with `path:line` plus ±6 context lines around each
best match - and the snippet summary *is* the token control. Every result
set stays under `search.maxChars` (default 6000 chars ≈ 1.5k tokens)
including a one-line footer stating how many results and indexed files it
came from.

Broke's index is
**offline** (no embedding model needed), persisted per project under
the data root (`index/<projectHash>/`, BRK-016), re-indexed incrementally by mtime/size diffing
(triggered on commits and re-checked before queries once the 60s freshness window expires).
It complements rather than replaces `power---semantic_search` or the repo
map.

Git discovery, filesystem scanning and merging share `search.scanBudgetMs`
(default 2000 ms). After the deadline, no further scan or merge work starts;
an already-running synchronous operation and final index persistence can add
time, so this is not a hard response-time guarantee. An incomplete Git query,
scan, merge or replacement read preserves existing entries and reports an
incomplete index. A Git failure does not trigger an unfiltered directory walk.
Manual rebuilds also retain the usable previous index if the candidate is
incomplete. Only a complete later refresh can prune deleted files and clear
the incomplete status.

The on-disk index contains term postings and file metadata, not full file
contents or snippets. Terms and paths can still reveal sensitive information.
Snippets are read live from disk at query time and behave like file reads in
stored history. Skipped from indexing: `node_modules`, `.git`, `dist`,
`build`, `vendor`, `.aider-desk`, non-code extensions and files above
`search.maxFileKB`. Indexes live under the versioned data root, outside the
swappable code tree.

No savings are claimed for this feature in the badge or compression stats:
its value depends on the agent choosing snippets over bulk file reads.
The registered tool also has a prompt cost:
every registered tool ships its JSON schema with every model call, so
agents that never search pay a small constant cost; `/broke search off`
(and the settings dialog) unregisters the tool while leaving the built
index on disk for later re-enabling. `/broke index [rebuild] | status` and
`/broke search <query>` cover control and manual use without an agent.

## Multi-agent MCP, CLI & hooks (S5 / S6)

Outside AiderDesk, broke runs as a zero-dependency stdio MCP server (`mcp.ts`),
CLI and Claude Code `PreToolUse`/`PostToolUse` hook handler (`cli.ts`), backed by
the host-agnostic `agent-core.ts` module and launched without a build step via
`node scripts/broke-runner.cjs` (Node.js ≥ 22.15). External agents use
**pre-ingestion compression** (`broke_search`, `broke_slice`, `broke_diff`,
`broke_compress`, allowlisted `broke_check`, and `broke_status`) while sharing
the same `config.json` and appending `<agent>:<projectHash>` records to
`stats.jsonl` and `measure.jsonl` with the same strict separation between
measured reductions and modeled counterfactuals. See
[docs/agents/multi-agent-setup.md](agents/multi-agent-setup.md) and
[docs/agents/SKILL.md](agents/SKILL.md).

## Security notes

The summarize pass condenses conversation content (tool outputs, web
content, files) with a small model and feeds the summary back into the
main model's context. When that content is attacker-influenced, prompt
injection can survive the condensation: the summarizer prompt tells the
model to treat its input as untrusted data, common secret patterns are
masked before the text leaves, and the generated summary is inserted
with an explicit machine-generated framing ("treat as data, not
instructions"), but all three are mitigations, not a hard boundary.
Treat compressed summaries with the same caution as the raw
web/file content any tool fetches: broke itself never executes the
summarizer's output, it only stores it as history. Switching
`summarize.via` to the task's own cloud model does not remove the risk,
it only changes which model sees the untrusted text first.

Snapshots (F3) persist small JSON records and optional raw-history undo
files **locally** under the data root (outside the swappable extension tree).
Conversation-derived fields use best-effort pattern masking; unknown secrets
can remain. Records are bounded by count (50 records per task) and by
bytes (25 MB per task, individual undo files capped at 10 MB, oldest
records evicted when a budget is exceeded). If your
conversation contains long-lived credentials that none of the masking
patterns catch, disable snapshots or move them off shared machines.

broke-search (F4) returns raw code/file snippets - the same content class
as any file-read tool result. The persisted index contains term keys derived
from file text. A complete refresh or rebuild updates edited files and removes
deleted files' postings; incomplete work retains previous entries. Delete the project's index data if immediate erasure is
required. Queries read current files from disk, honoring the same skip rules in
every repo (`node_modules`, `.git`, dot-dirs of other tooling etc.).
The indexer and snippet reader strictly enforce workspace confinement
via canonical `realpath` validation, rejecting symlinks that resolve outside
the workspace root or target sensitive paths (`.env`, dot-directories, skipped folders).
