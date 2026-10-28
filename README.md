# broke

**Send less repeated context in long [AiderDesk](https://github.com/hotovo/aider-desk) sessions.**

broke compresses eligible older conversation material before each model call, while protecting the first request and recent turns. The default pipeline changes the payload sent to the model, not the stored task history. Its deepest optional level can summarize locally with [Ollama](https://ollama.com), without an additional cloud summarization request.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/777marvin/ext-broke)](https://github.com/777marvin/ext-broke/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/777marvin/ext-broke/ci.yml)](https://github.com/777marvin/ext-broke/actions)
[![GitHub stars](https://img.shields.io/github/stars/777marvin/ext-broke?style=social)](https://github.com/777marvin/ext-broke/stargazers)

<p align="center">
  <img src="docs/assets/broke-pipeline.gif" alt="Animated broke pipeline: eligible older context is cleaned, trimmed, and optionally summarized locally before a smaller payload is sent to the model; the first request, recent turns, and stored task history stay protected" width="960">
</p>

<p align="center"><sub>Only the next model payload is reduced. Stored task history remains unchanged.</sub></p>

---

## Quick Start

```bash
npx @aiderdesk/extensions install -g https://github.com/777marvin/ext-broke
```

Open any AiderDesk task. broke is active by default — the **💸 badge** shows its current state. Leave **Balanced** selected for everyday use. That's it.

**Check setup** in the badge dialog verifies readiness without changing settings. See [Install](#install) for requirements and manual setup.

---

## Why broke?

Long AI coding tasks repeatedly send growing conversation context. AiderDesk already optimizes messages and can compact a task at a configured threshold; broke adds a **smaller per-call cleanup** of eligible older material. The goal: send less repeated context while keeping the task brief and recent work available to the model.

### Does it actually save money?

Yes — but with honest caveats:

| Measurement | What it shows |
|-------------|---------------|
| **Measured locally** | Characters removed by each compression pass (before/after comparison) |
| **Estimated** | Tokens via `chars / 4` heuristic, USD via task model price |
| **Not guaranteed** | Actual billing savings depend on system prompt, tool schemas, provider caching, and summarizer costs |

The 💸 badge and `/broke stats` report what **your own tasks produce** — live numbers, not screenshots. Turn on the measurement ledger (`/broke measure on`, default) and `/broke measure` aggregates per-run data from `measure.jsonl`.

#### Reproducible reference benchmark

`npm run bench` runs a deterministic 351,403-char synthetic session (67 messages) with no LLM, no randomness:

- shipped default level (`truncate`): **113,070 chars removed**
  (~28,268 tokens, 32.2% of the input);
- maximum level (`summarize`): **315,263 chars removed**
  (~78,816 tokens, 89.7% of the input; the old turns collapse into one
  ~400-char summary while the last 2 turns stay untouched).

---

## How it works

broke runs on the conversation messages AiderDesk is about to send. Each level adds to the one before it:

| Level | What happens | What gets lost? |
|-------|--------------|-----------------|
| **Clean: `structural`** | removes empty messages, collapses identical adjacent tool results, merges consecutive assistant texts | Nothing — text preserved; message framing may change |
| **Trim: `truncate`** (default) | shrinks compiler/test logs, old tool outputs, and oversized tool-call inputs | Old output and tool-call detail |
| **Summarize: `summarize`** | replaces eligible old turns with a summary from local Ollama (default) or a configured cloud model | Fine detail of old turns |

The first user message and recent turns are protected. Optional tool-level slicing, error rewriting, and manual flush are separate features that can change stored history — they are opt-in or explicitly confirmed.

---

## Features at a glance

| Feature | What it does |
|---------|--------------|
| 💸 **Live status badge** | Shows tokens saved, activity state, and savings breakdown |
| 🔍 **broke-search** | Offline keyword index with budgeted `path:line` snippets |
| 📄 **ST-slicing** | Interface views instead of full file bodies for large reads (opt-in) |
| 📸 **Snapshots** | Milestone records per commit; reversible flush if needed |
| ⚡ **Cache-friendly mode** | Preserves already-sent bytes to help provider prompt-cache reuse |
| 🗜️ **Error compression** | Compiler/test output → diagnostic essence with explicit markers |
| 📊 **Measurement ledger** | Per-run records of actual compression savings |

---

## Commands

```
/broke                             # status + stats + ollama status
/broke mode <short|normal|long|custom>  # savings approach
/broke autonomy <autonomous|manual>     # extension automation policy
/broke on \| off                    # enable / disable
/broke level <structural\|truncate\|summarize>
/broke maxchars <n>                # engage lossy passes above ~n chars
/broke protect <turns>             # never compress last n user turns
/broke brevity <off\|lite\|full\|ultra>  # output brevity directive (S8)
/broke truncate <lines> <kb>       # old tool output limits
/broke truncate tool <name> <lines> <kb>  # per-tool override (S8)
/broke truncate toollevel <on\|off>  # rewrite oversized tool results at tool level
/broke errors <on\|off>            # compress compiler/test output
/broke errors minchars <n>         # compress matching outputs ≥ n chars
/broke slice <on\|off>             # interface views for file reads
/broke slice focus <path>          # always return this file in full
/broke index [rebuild]             # build/rebuild local project keyword index
/broke search <query>              # broke-search snippet summary
/broke snapshot [label]            # record a milestone snapshot
/broke snapshot list               # list snapshots
/broke flush [--yes]               # replace only the verified summarized region; keep recent turns
/broke flush --undo <n>            # restore history from snapshot #n
/broke stats                       # per-pass saved chars/tokens
/broke diff [chars]                # token-budgeted digest of uncommitted changes
/broke estimate                    # counterfactual savings (slice/flush/search)
/broke why                         # live gate-by-gate verdict
/broke measure                     # summarize measurement ledger
/broke reset                       # clear this task's stats
/broke selftest                    # synthetic pipeline test
/broke update                      # self-update from GitHub releases
/broke help                        # all commands
```

Flush requires a current cached summary and enabled undo storage. If coverage is
missing or stale, it aborts; `/broke summarize now` can explicitly prepare a
summary under the current settings. Flush never generates one itself. `--yes`
skips confirmation only. See [Snapshots & flush](docs/features.md#snapshots--flush-f3).

---

## Configuration

Every setting is reachable via `/broke config set <path> <value>` (schema-validated). The gear dialog covers the day-to-day surface:

| Setting | Default | Description |
|---------|---------|-------------|
| enabled | on | Master switch |
| level | `truncate` | structural / truncate / summarize |
| mode | `custom` | Short / Normal / Long / Custom preset |
| autonomy | `autonomous` | Suppress auto-summarization and tool rewrites when `manual` |
| maxContextChars | 60000 | ≈15k tokens, engages lossy passes |
| protectedTurns | 2 | Last N user turns never compressed |
| cache.profile | `off` | off / auto / anthropic / openai |
| cache.escapeHatch | on | One cache-invalidating rewrite if the compressed candidate still exceeds budget |
| cache.anchorBreakpoint | off | Anthropic only: target frozen prefix for cache breakpoint |
| cache.openaiStateless | off | `auto` profile only: conservative estimate when no OpenAI cache hits |
| brevity.level | `off` | Output brevity directive (off / lite / full / ultra) |
| truncate.maxLines / maxKB | 200 / 20 | Old tool output limits |
| truncate.maxInputChars | 2000 | Tool-call input trim threshold |
| truncate.tools | `{}` | Per-tool truncation rules |
| truncate.toolLevel | off | Rewrite oversized tool results at tool level |
| truncate.archive | off | Save full truncated outputs to errors/ |
| truncate.retentionDays | 30 | Delete archived outputs older than N days |
| errors.enabled | on | Stack-trace/log compression |
| errors.minChars | 8000 | Compress matching outputs ≥ N chars |
| errors.contextLines | 8 | Context lines kept around failure |
| errors.toolLevel | off | Rewrite stored history at tool level |
| errors.archive | off | Save full outputs to errors/ |
| errors.retentionDays | 30 | Delete archived outputs older than N days |
| slice.enabled | off | Interface views for large file reads |
| slice.parser | `heuristic` | v1 heuristic only; `ast` reserved for web-tree-sitter |
| slice.minChars | 4000 | Files smaller pass through untouched |
| slice.maxChars | 20000 | View cap; larger views fall back to full content |
| slice.focusAuto | on | Derive focus from edit-tool calls / updated files |
| search.enabled | on | Register broke-search agent tool |
| search.backend | `keyword` | v1 ships keyword BM25 only |
| search.maxResults / maxChars | 8 / 6000 | Top-k results and total char budget per query |
| search.contextLines | 6 | Context lines around each match |
| search.maxFileKB | 512 | Files larger than this never enter the index |
| search.scanBudgetMs | 2000 | Shared time budget for Git discovery, scan and merge |
| search.includeGitIgnored | off | Opt-in: index git-ignored files too |
| summarize.via | `local` | Local (Ollama) / cloud |
| summarize.localModel | `qwen2.5-coder:3b` | Ollama model tag |
| summarize.ollamaUrl | `http://127.0.0.1:11434` | Ollama base URL |
| summarize.allowRemoteHost | off | Explicit consent for non-loopback Ollama hosts |
| summarize.cloudModelId | `` | `provider/model`; empty = task model |
| summarize.afterTurns | 8 | Only summarize turns older than N |
| summarize.minChars | 8000 | Min region size for summarization |
| summarize.maxSummaryChars | 4000 | Summary text entering context capped at this length |
| ui.showStatusBadge | on | 💸 badge in task status bar |
| ui.showMessageMenu | off | `broke: why` row in message dropdown menu |
| stats.measure | on | Record every run to `measure.jsonl` |
| snapshot.onCommit | on | Milestone snapshot after every commit |
| snapshot.onTestPass | off | Test-green detection as milestones |
| snapshot.keepHistory | off | Raw-history undo files for snapshots |
| flush.confirm | on | Ask before destructive `/broke flush` |
| flush.undo | on | Raw pre-flush undo file; required for flush |

Full configuration reference: see [docs/features.md](docs/features.md) and the gear dialog.

---

## Status

broke is in active development. roadmap ([docs/roadmap.md](docs/roadmap.md)) documents shipped features F1–F7 and proposed candidates F8–F9. Current Unreleased work includes F6 (live status dot + three-tier savings breakdown) and F7.1/F7.2 (everyday badge view + guided setup). No delivery dates or release versions are assigned to remaining work.

---

## Install & Requirements

**Manual install:**

```bash
git clone https://github.com/777marvin/ext-broke
cp -r ext-broke ~/.aider-desk/extensions/broke
cd ~/.aider-desk/extensions/broke && npm install   # zod only
```

**Windows:** `~/.aider-desk` is `%USERPROFILE%\.aider-desk`. Run `.\scripts\deploy.ps1 -Category extensions -Name broke -InstallDeps` for atomic install with rollback support.

**Requirements:**
- AiderDesk ≥ 0.88, Node.js ≥ 22
- Optional: [Ollama](https://ollama.com) running (`ollama pull qwen2.5-coder:3b`) for local summarization

**Updating:** Ask broke itself — no script, no clone:

```
/broke update          # install latest GitHub release
/broke update check    # check for newer release
/broke update v1.3.3   # pin / roll back to exact version
```

Since 0.8.0, updates are cryptographically verified (Ed25519-signed SHA256SUMS manifest). Unsigned or tampered releases are refused outright.

Runtime data lives **outside** the swappable code tree under `<extension>/../.broke-data/v1/` (`config.json`, `ledgers/`, `snapshots/`, `index/`, `errors/`; `BROKE_DATA_DIR` overrides).

---

## Privacy & Security

- **Local-first:** default summarization uses local Ollama; no content leaves your machine
- **Remote consent required:** non-loopback Ollama hosts are **blocked by default** — explicitly enable with `/broke summarize allow-remote on`
- **Secret masking:** common secret patterns (API keys, tokens) are redacted before sending to summarizers
- **No conversation content in stats:** `/broke stats` and `/broke measure` show only sizes and per-pass removals
- **Workspace confinement:** the indexer never leaves the project root; git-ignored files stay out of the index by default

Security issues: never in a public issue — follow [SECURITY.md](SECURITY.md) (private GitHub advisory).

---

## Documentation

- [docs/tuning.md](docs/tuning.md) — which lever for which situation, per task length
- [docs/features.md](docs/features.md) — deep dives per feature
- [docs/overview.md](docs/overview.md) — module map and pipeline internals
- [docs/token-saving.md](docs/token-saving.md) — all levers that save tokens
- [docs/aiderdesk-builtin.md](docs/aiderdesk-builtin.md) — what AiderDesk saves on its own
- [docs/local-models.md](docs/local-models.md) — local Ollama setup and measurement limits
- [docs/roadmap.md](docs/roadmap.md) — shipped features, current focus, proposed work

---

## Contributing

Bug reports, feature ideas, and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, commit conventions, and release process.

Attach the output of `/broke why`, `/broke stats`, or `/broke measure` to bug reports — none of it contains conversation content.

---

## License

[MIT](LICENSE), free to use, modify and distribute.
