# Roadmap

*broke* is a token-budget extension for AiderDesk. This roadmap tracks shipped features, current development, and future directions.

## Shipped Features

| # | Feature | Version | Description |
|---|---------|---------|-------------|
| F1 | Active Log & Stack-Trace Compressor | 0.2.0 | Compresses compiler/test output (tsc, pytest, Jest, Node) to diagnostic essence |
| F2 | ST-Slicing (Semantic Context Thinning) | 0.7.0 | Interface views for large file reads (TypeScript/Python) |
| F3 | State Snapshotting & Memory Flushing | 0.9.0 | Milestone snapshots + reversible flush operation |
| F4 | Local Keyword Index | 0.10.0 | Offline BM25 search with budgeted snippets (`broke-search`) |
| F5 | Mode Presets | 1.2.2 | Short/Normal/Long/Custom presets with autonomy selector |
| F6 | Live Status & Savings Breakdown | Unreleased | Three-tier honest savings: measured, provider-reported, modeled |
| F7.1 | Everyday Badge View | Unreleased | Plain-language state, Safe/Balanced/Maximum choices |
| F7.2 | Guided Setup & Readiness | Unreleased | One-click setup check with Ollama/backend verification |
| S8 | Output Brevity Directive | Unreleased | `brevity.ts` — reduce assistant verbosity while keeping code intact |

## Current Focus

**Active development (Unreleased):**
- Audit hardening: incomplete-index preservation, redirect refusal, process-safe
  update ownership, verified partial flush, resumable migration and shared index
  deadlines; see [verification and release boundaries](audit-remediation.md).
- F6/F7 completion: live status dot, three-tier savings, guided setup
- S8 (savemytoken migration): brevity directive + per-tool truncation

**Proposed (no release date):**
- F8: Internal benchmark methodology "that tells the truth"
- F9: User-run measurement flow beyond `npm run bench`
- S5: Agent-facing skill/rule for autonomous broke usage
- S6: Agent tool surface evaluation (which capabilities become tools?)
- S7: Subagent behavior investigation (hooks, stats attribution)

## Version Reality

Pre-0.8.0 releases have no tags and are not installable via `/broke update`. Since v0.8.0, releases are signed and verified. Development happens on feature branches; only `main` is tagged and published.

See [CHANGELOG](../CHANGELOG.md) for full release history.
