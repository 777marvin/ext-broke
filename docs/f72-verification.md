# F7.2 verification record

Implementation date: 2026-10-22. Status: implemented under Unreleased.
Scope and acceptance criteria: [F7.2](feats.md#f72-guided-setup--readiness-check).

## Local evidence

- `tests/setup.test.ts`: pure readiness decisions, exact configured tags,
  metadata-only HTTP fixtures, remote-consent gates, Off/manual/cloud behavior,
  failed checks and bounded introduction-state persistence. No production
  backend or paid generation is involved.
- `tests/ui-actions.test.ts`: real extension actions validate unsaved drafts
  and preserve configuration; dismissal survives new extension instances.
- `tests/ui-interactions.test.ts`: first opening, Skip/Got it, reopening,
  Cancel, persistence failure, pending/failed checks, invalidation after edits,
  late guide-state responses, preserved missing-model warnings and focus
  restoration after asynchronous dismissal.
- `tests/commands.test.ts`: the CLI shares readiness decisions and does not
  contact an unapproved remote endpoint.
- Browser verification uses the actual badge component with a fake host and
  local Ollama metadata fixture. This verifies browser interaction and layout;
  it is not proof of AiderDesk host integration or real model generation.
  Exercised: introduction dismissal and persisted reopening, focus after
  dismissal/checking, basic compression, installed and missing models, manual
  automation, unchecked cloud configuration, a blocked remote address, delayed
  metadata and failed metadata. The scrollable result and Save/Cancel actions
  were inspected visually. The native savings selector was used to choose a
  draft without saving it.

## Reproduce automated checks

Run from the repository root with Node 22 or newer and installed dependencies:

```powershell
npm run typecheck
npm run validate:ui
npm test
npm run check:docs
git diff --check
```

In a restricted Windows sandbox that denies atomic renames in its default
temporary directory, point `TEMP` and `TMP` at an isolated writable test
directory. If that directory is inside this checkout, set
`GIT_CEILING_DIRECTORIES` to that same directory so nongit fixture projects do
not accidentally inherit the enclosing repository. Keep `BROKE_DATA_DIR` inside
the isolated test directory so tests never use normal runtime data.

## Outstanding host and usability evidence

These checks have not been performed for this slice and must not be inferred
from synthetic tests or the browser fixture:

- Install through the normal deployment flow into a disposable AiderDesk
  environment; confirm first-open, Skip/Got it and later Setup guide access.
- Start another task and reload the extension; confirm dismissal persists,
  existing Off/Custom/manual configurations are preserved, and Cancel does not
  save a draft or dismiss the introduction.
- With local summaries selected, verify absent Ollama, an installed wrong tag,
  the configured installed model, and a blocked remote address. Confirm that
  the badge and status command agree without a generation request.
- Check keyboard focus, save-error recovery and narrow host-panel layout in
  the live host. Validate everyday comprehension with non-expert users before
  marking the broader F7 initiative complete.
