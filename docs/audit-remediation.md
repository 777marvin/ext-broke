# Audit remediation verification

Verification snapshot: 2026-10-28. Later CI results belong to their PR checks.

This development change addresses AUD-01 through AUD-09 against base commit
`34cab88`. It retains version `1.3.4-dev`; it is not a published release.

## Implemented behavior

| Area | Result |
| --- | --- |
| Index consistency | Incomplete Git, scan, merge or replacement-read results retain existing documents. Complete later refreshes can remove deleted files and clear the incomplete status. |
| Local summarizer | HTTP redirects are rejected before sending anything to a redirect target. |
| Update ownership | An external installation lock, random ownership token and atomic guard serialize acquisition, takeover and release across processes and installation swaps. |
| Partial flush | Only a fingerprint-verified cached region is replaced. The recent tail survives, context is rechecked, and complete undo storage must succeed first. |
| Legacy migration | Verified staging and exclusive publication resume partial copies without overwriting conflicts. Linked and overlapping roots are rejected. |
| Cache escape | Escape depends on the compressed candidate exceeding the budget; exact-budget and below-budget candidates retain their cache ledger. |
| Time budget | Git discovery, scanning and merging share an absolute deadline derived from the public duration option. |
| Refactoring | Project-index coordination and update lifecycle have separate modules. Both settings templates share the synchronous draft reducer through one composition function. |

## Local evidence

The final code passed the full 760-test suite on Windows with Node 22.23.4 and
Node 24.14.1. All three existing per-file coverage gates passed; their thresholds
were retained and their module lists now include the extracted modules.

The following checks also passed:

```text
npm run coverage
npm run typecheck
npm run validate:ui
npm run check:docs
npm run check:files
npm run check:version
npm audit --audit-level=high --json
git diff --check
```

The dependency audit reported zero vulnerabilities at every severity. The UI
validator used the vendored host contract. An additional real-Chrome fixture
checked draft edits, Custom mode, cancel, save failure/retry, narrow layout,
focus containment and Escape restoration, with no browser page errors.

The installed AiderDesk 0.89.0 executable was tested in headless mode with a
separate home, user-data directory, runtime directory and synthetic Git project.
The test exercised actual extension registration, assembled settings delivery,
configuration save/readback, project indexing/search, the host's optimization
event dispatcher, explicit local summarization, partial flush, exact undo and
the controlled updater refusal for a development checkout. A loopback Ollama
stub handled the single summarization call; flush made no extra call. This is
real-host integration evidence, not evidence about a paid provider's response
quality or a complete interactive AiderDesk GUI session.

The initial restricted Windows runner could not rename even an ordinary file
or directory in a disposable fixture. The same probe and updater tests passed
outside that runner restriction. Filesystem/process verification therefore used
the native runner; no protection mechanism or dependency version was changed.

Detailed RED/GREEN logs, process probes, browser screenshots and host receipts
are retained locally under `.superpowers/audit-remediation/` in the development
checkout. They are ignored and are not distributed as extension artifacts.

## Decisions and boundaries

- A raw-history mismatch with pipeline-transformed summary coverage aborts
  flush. Explicit `/broke summarize now` can create suitable current coverage;
  flush never calls a model implicitly. If this is overly strict, a user must
  regenerate coverage rather than risking unsummarized history.
- With `flush.undo` disabled, flush refuses replacement. It neither persists raw
  history without consent nor permits an irreversible flush. This deliberately
  makes undo storage a prerequisite for the new partial-flush operation.
- The deadline bounds starting more Git, scan and merge work. A synchronous
  filesystem operation already in progress can overrun it. Final serialization
  and durable index persistence can also add time after that deadline; there is
  no hard end-to-end response-time guarantee. Bounding persistence would require
  a separate change while preserving honest persisted completeness metadata.
- Locks coordinate cooperating new processes. Old updaters do not provide a
  mixed-version guarantee. A reused live PID, unknown owner or abandoned guard
  fails closed and can require manual inspection; the cost is temporary update
  unavailability rather than removing a possibly active owner's lock.
- Migration rejects static links and overlapping roots before mutation. It
  does not claim to defeat a hostile process replacing directory components
  between checks; protecting against that race needs a stronger OS-specific
  handle-based protocol.

## Remaining release checks

The Linux Node 22/24 CI matrix is retained, and a focused Windows
filesystem/process job was added. Require successful checks on the final PR
revision before release; local verification alone does not establish remote CI
success. Merging, signing a release and deploying to production are separate
steps from these tests.
