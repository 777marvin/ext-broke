---
name: broke
description: Token-budget context compression, BM25 keyword search (broke_search), interface slicing (broke_slice), budgeted git diffs (broke_diff), and diagnostic error compression (broke_check / broke_compress). Use when exploring large codebases, reading files over 200 lines, reviewing git diffs, or running compiler/test checks with minimal token waste.
---

# broke — Context-Budget Workflow for Coding Agents

Use the `broke` MCP tools (or the `broke` CLI via `node scripts/broke-runner.cjs`) to prevent large file dumps, verbose stack traces, and unbudgeted diffs from exhausting the context window.

## 1. Search Before Bulk Reading (`broke_search`)

When locating symbols, functions, or error messages across the repository, call `broke_search` first:

- Returns top-k BM25-ranked `path:line` snippets within a strict character budget (`search.maxChars`, default 6,000 chars).
- Respects `.gitignore`, workspace confinement, and sensitive-file exclusions automatically.

## 2. Interface Slicing for Large Files (`broke_slice`)

Before reading a TypeScript, JavaScript, or Python file larger than ~200 lines (~4,000 chars) in full:

1. Call `broke_slice({ path: "path/to/file.ts" })` to get its **interface view** (imports, exported types/interfaces, class headers, and function/method signatures with bodies elided).
2. Once you identify the exact function, method, or class you need to edit, call `broke_slice({ path: "path/to/file.ts", symbol: "targetFunctionName" })` (or your host's line-ranged read tool) to inspect that symbol's full body without loading the rest of the file.

## 3. Token-Budgeted Git Diffs (`broke_diff`)

Instead of running raw `git diff` on large working trees:

- Call `broke_diff({ budgetChars: 4000 })` to get an honest, character-budgeted summary of modified, staged, and untracked files.
- Increase `budgetChars` only when you need deeper hunk inspection.

## 4. Diagnostic Error & Log Compression (`broke_check` / `broke_compress`)

Compiler and test suites (`tsc`, `pytest`, `vitest`, `jest`, `cargo check`, `go test`) often emit thousands of lines of repetitive tracebacks:

- Prefer `broke_check({ runner: "tsc" | "pytest" | "vitest" | "jest" | "npm-test" | "npm-typecheck" })` to execute the check and receive only its diagnostic essence (`… [broke: error summary - N lines → M lines]`).
- If you already have a large log file or raw command output, pass it to `broke_compress({ filePath })` or `broke_compress({ text })`. Set `summarize: true` to condense massive logs locally via Ollama (when configured).

## 5. Output Brevity

- Keep explanations concise and direct.
- Keep code, commands, file paths, error messages, and numbers byte-exact.
