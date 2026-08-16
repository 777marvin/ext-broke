# Review Backlog

Open findings from the ruthless self-review of 2026-08-16 (typecheck clean,
80/80 tests green at review time). Severity: 🔴 high, 🟡 medium, ⚪ nit.
Each finding lists the location, the problem and a concrete fix approach.

Fixed in the same review round (see CHANGELOG, commits 77437a0..b0dc2a9):
F1 summarize auto-disable gate, F2 error pass command-tool guard, F3
rich-part protection in summarize, F4 Ollama body timeout.

## 🔴 High

### F5 - Savings accounting overstates the merge pass
`compress.ts` structural pass, merge branch: merging two assistant texts
keeps the full content in the context (plus 2 separator chars), yet
`removedChars += messageChars(msg)` counts the merged-away message as
saved. The badge and `/broke stats` therefore report phantom savings,
which contradicts the project's "honest numbers" line.
**Fix:** count merges as 0 saved chars and report message-framing overhead
separately (e.g. ~4 tokens/message estimate), or exclude merges from
`savedChars`. Add a test: `structuralChars` must not grow via merges.

### F6 - stats.passes counts model calls, not compression runs; sync I/O per call
`index.ts` `recordReport` runs on EVERY model call (also when nothing was
compressed): `passes` increments and `stats.jsonl` gets a synchronous
append each time. Additionally `loadTaskStats` reads the whole file
synchronously on badge refreshes (`noDataCache: true`), up to 5 MB per
refresh in the UI path.
**Fix:** count `passes` only when `report.touched`; throttle persistence;
cache `loadTaskStats` with a TTL.

### F7 - Config dialog allows values outside the schema bounds
`ConfigComponent.jsx` `numberField` knows only `min`, no `max`. Values
like `afterTurns=1` (schema min 2), `contextLines>30`, `protectedTurns>50`
or floats (schema `.int()`) make `ConfigSchema.parse` throw in
`saveConfigData` - the dialog then fails to save without explanation.
**Fix:** pass per-field min/max from the schema into `numberField`, apply
`Math.trunc` to numeric input, and catch parse errors with a readable
message.

### F8 - maskSecrets coverage gaps
`compress.ts` `maskSecrets` covers sk-..., AKIA, github_pat_, gh*_, Bearer
and PEM keys. Missing: JWTs (`eyJ...`), Slack `xoxb-/xoxp-`, AWS session
tokens (`ASIA...`), HTTP Basic auth, assignments (`password=`, `secret:`,
`token=`), Slack/Discord webhook URLs, connection strings
(`postgres://user:pass@...`), `.npmrc` auth lines, Azure SAS URLs.
The prompt claims "Secrets are already redacted" - that is best effort
and should be worded as such.
**Fix:** extend the pattern list (incl. an assignment heuristic
`(password|secret|token|api[_-]?key)\s*[:=]\s*\S+` and webhook URLs), one
test per pattern, docs wording downgraded to "best effort".

### F9 - Prompt-injection amplification via the summarizer
`compress.ts` `summarizePass`: a 3B model (qwen2.5-coder) summarizes
potentially attacker-influenced web/file content; injected instructions
can survive the condensation and land in the main model's context. Marker
and the "untrusted data" prompt mitigate but are not a hard boundary.
**Fix:** document the risk in README/docs; optionally strip imperative
lines from summaries. Accepting the risk is legitimate, silence is not.

### F10 - Four duplicated output extractors
`toolResultText` (compress.ts), `extractToolResultText` (index.ts),
`extractOutputText` (errors.ts), `partText` (tokens.ts) handle the same
tool-output shapes with subtle differences. F2 originated from exactly
this kind of drift (guard in one path, not the other).
**Fix:** one canonical extractor (e.g. in a new `output.ts`), the other
three become thin wrappers; behavioral differences become parameters.

### F11 - Selftest synthetic data is inconsistent: dedupe is never exercised
`selftest.ts` `toolMessage()` generates its own `toolCallId` instead of
referencing the preceding assistant tool-call. `removeToolResultsWithCalls`
aborts on the holder mismatch, so the "two identical adjacent tool
results" are never actually deduped - the selftest's "dedupe/merge
applied: yes" comes only from the empty-message drop.
**Fix:** link tool results to real call ids and assert the duplicates are
gone after the run.

### F12 - Deploy loses the errors/ archive
`scripts/deploy.ps1` `preserveList` contains config.json, stats.jsonl and
node_modules, but not `errors/`. After each deploy, chat references
("full output saved to errors/...") point into the void.
**Fix:** add `errors/` to the preserve list (with a size cap on copy) or
reword the reference text.

### F13 - /broke truncate writes config.json twice
`commands.ts`: two consecutive `updateConfigPath` calls = two atomic
writes; a failure in between leaves a half-updated config.
**Fix:** one combined update (e.g. `updateConfigPaths(paths, values)`).

## 🟡 Medium

### F14 - Summary cache ignores config changes
`compress.ts` `cachedSummaryByTask` is keyed by taskId only; switching the
summarizer backend/model reuses the old summary.
**Fix:** cache key = taskId + fingerprint of `summarize.*`.

### F15 - Ollama model check reports false positives
`commands.ts`: `models.some(m => m.startsWith(localModel.split(':')[0]))`
matches `qwen2.5-coder:7b` even when the configured `:3b` tag is missing.
**Fix:** exact tag match first, base-name match second.

### F16 - Archive filename collisions
`errors.ts` `safeName` truncates to 80 chars and falls back to the tool
name; long call ids can collide and overwrite each other.
**Fix:** append a short hash suffix.

### F17 - Version hardcoded in extension metadata
`index.ts` `static metadata.version` ('0.3.0') drifts from package.json.
**Fix:** read from package.json at load time or add a CI equality check.

### F18 - removedChars can go negative
`compress.ts` `errorPass`: a summary slightly larger than a barely-above-
threshold output produces negative savings.
**Fix:** `Math.max(0, ...)`.

### F19 - Selftest messaging contradicts itself when disabled
`selftest.ts`: with `enabled=false` the report prints per-pass numbers
but labels the same passes "NOT exercised".
**Fix:** derive `levelApplied` from `exerciseConfig.level`.

### F20 - No Windows CI for deploy.ps1
`ci.yml` smokes the PowerShell deploy script on Ubuntu only.
**Fix:** add a `windows-latest` job.

### F21 - saveConfig without fsync
`config.ts`: after an atomic rename there is no fsync; a power loss can
lose the last config write.
**Fix:** optional `fsyncSync` on the file handle after write.

### F22 - HELP_TEXT hardcodes defaults
`commands.ts` HELP_TEXT lists defaults (60000, 200/20, ...) as literal
strings that drift from `DEFAULT_CONFIG`.
**Fix:** generate the text from `DEFAULT_CONFIG`.

### F24 - Verify: does task.generateText re-enter onOptimizeMessages?
`index.ts` cloud summarizer calls `task.generateText`; if that internally
triggers `onOptimizeMessages` again, the result is recursion or double
compression. Not verified against the AiderDesk API.
**Fix:** check the runtime behavior; add a reentry guard if needed.

## ⚪ Nits

### F23 - Duplicate comment "5 - UI" in ConfigComponent.jsx
Cosmetic.

## Test gaps

Untested modules: `commands.ts` (parse/apply/format), `config.ts`
(mergeConfig, updateConfigPath, corrupted-config fallback), `index.ts`
orchestration (onToolFinished, recordReport, failure counter), `selftest.ts`
itself, `clearTaskStats`. The F1-F4 round added regression tests for each
fixed bug - the remaining gaps above should get the same treatment.

## Work log

- 2026-08-16: F1-F4 fixed, tested (80/80), committed; README and
  docs/overview.md updated to match the implemented behavior; this file
  created to record the rest.
