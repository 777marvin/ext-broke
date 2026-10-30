# Multi-Agent Setup Guide (Claude Code, Antigravity, Codex, Cursor)

`broke` is built for [AiderDesk](../../README.md), where it compresses older conversation context in-flight before each model call. Its core token-saving engines — **BM25 search** (`indexer.ts`), **ST-slicing** (`slice.ts`), **token-budgeted git diffs** (`diff.ts`), **stack-trace/log compression** (`errors.ts`), and **local Ollama summarization** (`local.ts`) — also run as a **zero-dependency MCP server, CLI, and hook bridge** for other coding agents.

---

## Architecture: Pre-Ingestion Compression

External coding agents (Claude Code, Google Antigravity, OpenAI Codex CLI, Cursor) manage their own conversation history and provider prompt caches. Rewriting already-sent messages in those hosts is either unsupported or would invalidate their prompt cache.

Instead, `broke`'s multi-agent bridge applies **pre-ingestion compression** — shrinking search results, file reads, diffs, and test/compiler logs *before* they enter the model's context window:

| Capability | MCP Tool | CLI Command | Claude Code Hook |Savings Category (F6) |
|---|---|---|---|---|
| **Offline BM25 Search** | `broke_search` | `broke search <query>` | — | Modeled counterfactual (`estimates.search`) |
| **ST-Slicing (Interface View)** | `broke_slice` | `broke slice <path> [symbol]` | `PreToolUse` (`Read`, when `slice.enabled=true`) | Modeled counterfactual (`savedChars.slice`) |
| **Budgeted Git Diff** | `broke_diff` | `broke diff [chars]` | — | Budgeted digest |
| **Allowlisted Check Runner** | `broke_check` | `broke check <runner>` | — | Measured reduction (`error` / `truncate` / `summarize`) |
| **Log / Error Compression** | `broke_compress` | `broke compress --file <log>` | `PostToolUse` (`Bash`, when `errors.enabled=true`) | Measured reduction (`error` / `truncate` / `summarize`) |
| **Readiness & Ledger Status** | `broke_status` | `broke status [measure]` | — | Diagnostic |

All agents share the same configuration (`config.json`) and append to the same privacy-preserving ledgers (`ledgers/stats.jsonl` and `ledgers/measure.jsonl`) under `<extension>/../.broke-data/v1/` (or `BROKE_DATA_DIR`), scoped by `<agent>:<projectHash>` (for example `claude:75529654f1060bc0` or `antigravity:75529654f1060bc0`).

---

## Quick Setup (One-Command Installer)

Requires **Node.js ≥ 22.15** (uses Node's built-in `module.registerHooks` and `module.stripTypeScriptTypes` — no build step or global `tsx` installation needed).

Preview what will be written with `--dry-run`, then run without `--dry-run` to install into a project directory:

```bash
# Claude Code (.mcp.json + .claude/settings.json hooks + .claude/skills/broke/SKILL.md)
node /path/to/broke/scripts/broke-runner.cjs install-agent claude --project /path/to/your-project

# Google Antigravity (.agents/mcp_config.json + .agents/skills/broke/SKILL.md + AGENTS.md section)
node /path/to/broke/scripts/broke-runner.cjs install-agent antigravity --project /path/to/your-project

# OpenAI Codex CLI (.codex/config.toml + AGENTS.md section)
node /path/to/broke/scripts/broke-runner.cjs install-agent codex --project /path/to/your-project

# Cursor (.cursor/mcp.json + .cursor/rules/broke.mdc)
node /path/to/broke/scripts/broke-runner.cjs install-agent cursor --project /path/to/your-project
```

The installer (`agent-install.ts`) performs non-destructive targeted upserts:
- **Existing settings survive:** Codex `.codex/config.toml` edits only `mcp_servers.broke.command` and `mcp_servers.broke.args` via TOML AST source ranges (preserving model settings, comments, unrelated MCP servers, custom `broke` keys, and CRLF/LF line endings). JSON files preserve unrelated servers/settings, and Claude `.claude/settings.json` upserts only `broke`-owned hook entries while preserving foreign guards, formatters, and hook properties.
- **Pre-write validation & atomic rollback:** Unreadable or malformed JSON (comments are not accepted in JSON files), invalid or ambiguous TOML constructs, or corrupted `AGENTS.md` marker blocks abort planning before any target file is written (including `--dry-run`). Writes use temporary sibling files in the target directory and roll back previously modified or newly created files on failure, retaining recovery copies if rollback restoration itself fails.

---

## Manual Configuration by Agent

### 1. Claude Code

Register the MCP server via the Claude CLI:

```bash
claude mcp add broke -- node /path/to/broke/scripts/broke-runner.cjs mcp --agent claude
```

Optional automatic hooks in `.claude/settings.json` (emitted in direct execution form with `"command": "node"` and `"args": ["/path/to/broke/scripts/broke-runner.cjs", "hook", "claude"]`, avoiding shell interpolation of runner paths):
- **`PreToolUse` (`Read|Edit|Write|MultiEdit`):** Tracks the last edited file as focus and, when `slice.enabled` is set to `true` in `config.json`, intercepts full-file reads of large `.ts/.tsx/.js/.jsx/.py` files to return their compact interface view first. Ranged reads (`offset`/`limit`) and the active focus file always pass through untouched.
- **`PostToolUse` (`Bash`):** Extracts the diagnostic essence of oversized compiler/test failures (`>= errors.minChars`) and archives the redacted log when `errors.archive` is enabled.

### 2. Google Antigravity

Add `broke` to `.agents/mcp_config.json` and copy [SKILL.md](SKILL.md) to `.agents/skills/broke/SKILL.md` (existing files under legacy `.gemini/antigravity/` paths are left untouched and are not automatically deleted):

```json
{
  "mcpServers": {
    "broke": {
      "command": "node",
      "args": ["/path/to/broke/scripts/broke-runner.cjs", "mcp", "--agent", "antigravity"]
    }
  }
}
```

### 3. OpenAI Codex CLI

Add the MCP server to `.codex/config.toml` (or `~/.codex/config.toml`) and include the workflow section in `AGENTS.md`:

```toml
[mcp_servers.broke]
command = "node"
args = ["/path/to/broke/scripts/broke-runner.cjs", "mcp", "--agent", "codex"]
```

### 4. Cursor

Add `.cursor/mcp.json` and `.cursor/rules/broke.mdc` via `install-agent cursor`.

---

## Security & Boundaries

- **Workspace confinement (`SEC-001`):** `broke_slice`, `broke_search`, and `broke_compress` resolve canonical paths (`realpathSync`) and refuse symlinks or paths outside the project root, dot-directories, and sensitive files (`.env*`, private keys, credentials).
- **No arbitrary shell execution:** `broke_check` only executes a fixed allowlist of diagnostic runners (`tsc`, `pytest`, `vitest`, `jest`, `npm-test`, `npm-typecheck`, `npm-check-docs`, `npm-check-files`, `cargo-check`, `go-test`) without shell interpolation and rejects shell metacharacters, path traversal, and code-evaluation flags.
- **Secret masking:** All outputs processed by `broke_compress` and `broke_check` pass through `maskSecrets()` before archiving or local Ollama summarization.
