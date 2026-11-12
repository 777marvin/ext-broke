---
version: alpha
name: "Broke"
description: "Context Press makes compression depth visible and recorded reductions inspectable without hiding expert control."
colors:
  ink: "#111111"
  text: "#34424A"
  muted: "#666666"
  surface: "#FFFFFF"
  accent: "#0066CC"
  ready: "#185D82"
  success: "#19633B"
  warning: "#7A5512"
  danger: "#8A2D24"
  optimizing: "#7030A0"
  press-paper: "#F0F3FF"
  press-ink: "#1C2451"
  press-action: "#3456EC"
  press-lavender: "#CAD2FF"
  press-protection: "#72DBCF"
  press-contribution: "#9B81DE"
  press-canvas: "#202C61"
typography:
  sans:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.75rem"
spacing:
  control-gap: "0.5rem"
  section-gap: "0.875rem"
  dialog-padding: "1.5rem"
components:
  badge: {}
  status-card: {}
  button: {}
  dialog: {}
  disclosure: {}
---

# Broke Design System

## Overview

### Creative North Star

Broke should make the next-call payload understandable through a visible
material metaphor: a context stack becomes a compact packet. The existing
money badge stays the compact entry point. Context Press provides a Control
view for choosing compression depth and a Statistics view for recorded evidence.

### Product context and register

- **Audience and primary job:** AiderDesk users who want lower repeated context
  cost without learning compression internals. Experts still need access to all
  existing controls and diagnostic commands.
- **Target market and evidence:** No market-specific behavior is established in
  the repository. The current product copy and documentation are English.
- **Locale and language policy:** English-only owned UI today. New copy uses
  plain English and avoids command syntax in the everyday surface.
- **Usage scene:** A small status badge and a compact modal used during coding
  tasks, usually on desktop.
- **Register:** Product utility. Clarity and reliable state feedback lead.
- **Memorable signature:** An indigo context press with visible protection rails,
  native depth choices and a plain-language state; color never carries meaning alone.
- **Restraint:** The press is a qualitative illustration. Replay is explicit,
  brief and decorative; it never generates a summary or previews task content.
  Recorded measurements have their own tab, separate from the draft controls.
- **Anti-references:** Terminal help screens disguised as dialogs; unexplained
  emoji-only state; generic analytics dashboards; warning-heavy setup screens.
- **Token ownership/runtime mapping:** `scripts/context-press-style.js` owns
  Context Press's runtime tokens and styles, scoped to `.broke-context-press`.
  `scripts/context-press-ui.jsx` supplies its controls and charts inside
  `StatusBadge.jsx`; `scripts/ui-template-source.cjs` assembles these fragments
  with the shared draft helper. `StatusBadge.jsx` retains the compact badge,
  native modal lifecycle and advanced commands. `ConfigComponent.jsx` keeps
  AiderDesk's supplied controls as the expert configuration surface.

## Colors

Context Press pairs cool paper (`#F0F3FF`) and ink (`#1C2451`) with an indigo
material canvas (`#202C61`). Action blue (`#3456EC`) marks interactive selection;
lavender layers, teal protection rails and violet contributions support the
material metaphor. Existing status colors retain their text labels. The
current Broke icon is retained; this is not a new brand or logo. Forced-color
rendering may use system colors.

## Typography

Use local system sans fallbacks for controls and explanations, Bahnschrift /
Segoe UI for display headings, and system monospace for machine values and
commands. No remote fonts, chart libraries or new dependencies are required.

## Layout

The badge stays compact, including its observation micro-gauge. Context Press
uses the existing native dialog, capped at 980 CSS px and `100vw - 24px`, with
height capped at `100dvh - 24px`. The header, Control / Statistics tabs and
Save / Cancel footer stay outside the scrolling body. Below 760px the press
sits above compact depth choices; below 420px spacing and controls adapt again.
Expanded Advanced content and result feedback scroll without hiding the footer.

## Elevation & Depth

Use one restrained modal shadow and thin borders. Status cards use tinted flat
surfaces. Layered material depth belongs inside the indigo press illustration.

## Components

### Badge

Shows the status dot indicating the current condition (ready, saving, compressing,
needs setup, off), the existing savings number, and opens the settings dialog.
Its accessible name states the current condition in words. During active
compression, the violet status dot gently pulses.

### Status card

Contains a dot, a short heading, and one corrective or reassuring sentence.
Supported everyday states are ready, saving, compressing, optional local setup needed, off,
and action failure.

### Compression depth and drafts

Both settings surfaces use the same synchronous draft reducer assembled into
their standalone templates by `scripts/ui-template-source.cjs`. Draft edits
preserve other changes from the same render and mark preset-owned edits Custom.
Preset values remain owned by `presets.ts`; edits do not add network round trips.

Native radio inputs select the last included step: Clean maps to Safe / `short`,
Trim to Balanced / `normal`, and Summarize to Maximum savings / `long`. These
are cumulative canonical presets, not independent pass toggles. Balanced is
the recommended default. Existing Custom settings keep their actual depth
without falsely selecting a named preset. Choosing a stage explicitly applies
that preset's owned fields and preserves backend, cache, autonomy and consent.

Enable Broke, automation policy and history recording remain separate settings.
The press reflects draft depth and enablement, not measured capacity or a pass
that has already run. Replay changes only the illustration and respects reduced
motion. Edits require Save; the footer shows saved versus unsaved state and
retains the draft on a failed save. Cancel, Escape and the close control all
close immediately and drop the draft: nothing is destroyed, because settings
change only on Save and commands carry their own confirmation.

Native selects in Statistics, Advanced and the expert panel are intentional:
the host/operating-system popup is accepted.

### Advanced disclosure & Command Studio

Uses native `details`/`summary`, starts closed, and retains technical controls plus
the full **Command Studio**. Every valid `/broke` command is executable from the
UI: one-click commands are organized by category (`Diagnostics`, `Snapshots &
Flush`, `Search & Slice`, `Pipeline & Archives`, `Config & Updates`), and
parameterized commands (`search`, `diff`, `snapshot`, `snapshot show`, `flush
--undo`, `slice focus`, `truncate tool`, `config get/set`, `update <tag>`)
provide dedicated input builders alongside a universal `/broke` command bar.
`ConfigComponent.jsx` mirrors this capability with an embedded Interactive
Command & Maintenance Deck and full schema coverage (`slice.*`,
`truncate.tools`, `ui.showMessageMenu`).

Advanced commands execute immediately through their existing action path.
Their results and confirmations are separate from the settings draft; Cancel
does not undo an executed command.

### Feedback and safety

Action results remain inline in the dialog and use an accessible status region.
State-changing or paid commands retain two-step confirmation. That confirmation
is a CLIENT-side UX hint, not a security boundary: the server-side allowlist
(`QUICK_COMMAND_KINDS` in `index.ts`) intentionally covers every valid
`/broke` subcommand and only rejects `unknown`/malformed input, so a crafted UI
action can reach destructive commands (`flush --yes`, `errors clear`,
`config set`, `update`). Check setup
runs a metadata-only readiness check for the current draft without saving it;
the synthetic selftest stays under advanced diagnostics and uses a stub
summarizer. Introduction completion is a reversible presentation preference
and needs one click.
Modal focus containment, Escape, Cancel,
save failure recovery, and focus restoration remain mandatory.

### Guided setup and readiness (F7.2)

The first badge-dialog opening includes a short introduction within the same
modal, not a second overlay. Got it and Skip introduction persist only a
versioned dismissal flag in runtime `setup.json`; Cancel changes neither this
flag nor configuration. Setup guide reopens the introduction. A delayed initial
state response cannot override an explicit reopen. After completion, focus
returns to the enabled Setup guide button.

Check setup shows basic compression, summary backend, configured model and
automatic-summary readiness as separate text results. The check uses the
displayed draft, sends no conversation content and never generates a summary.
Local metadata checks respect remote-host consent. Cloud configuration remains
explicitly unchecked for provider access. Pending, unavailable, blocked and
unknown states offer a clear next action; manual automation and Off stay honest.
Known results remain visible for the matching saved settings until an edit
invalidates them. Stale checks cannot replace results after edits or reopening.
Failures preserve the draft and allow retry. The readonly check restores focus
when disabling its button would otherwise lose it, without stealing another
control's focus. Modal content scrolls internally; focus rings remain visible,
closed advanced controls stay out of the focus loop, and reduced-motion users
receive a static activity dot.

### Recorded Statistics

View savings opens Statistics. Its read-only `getStatistics` action resolves
the current task from the host; the renderer supplies only scope and page.
This task is the default; Retained history must be selected explicitly and
means the installation's retained ledger, not one project or unlimited history.
No task produces a no-task state rather than silently substituting global data.

By step shows independent Clean, Errors & logs, Trim and Summarize contribution
bars with an inspectable explanation and table. Contributions can overlap.
Net reduction is signed before-minus-after; negative values mean added context.
Reconciliation retains the difference between net and known contributions and
is unavailable for incomplete attribution. Over time shows chronological runs
on pages of 60, starting with the latest page; totals cover the full selected
retained scope, not just the visible page. A selected run shows its sizes and
contributions. Characters are measured; estimated tokens use `Math.round(chars / 4)`
after aggregation. Totals sum calls that may repeat the same evolving material.

Provider usage & avoided context stays collapsed and separate from measured
net. It contains cached current-task counters only: last available completed-call
sent/cache tokens, plus slicing/search/flush estimates. Provider values always
remain tokens and are not attributed to a selected run or summed over retained
history. Missing fields remain unavailable. These numbers do not prove billing
reduction, exact tokenizer output or summary quality.

Record run history edits the existing persisted `stats.measure` preference.
After Save, disabling it stops future records, keeps existing records and does
not disable compression. Missing earlier runs cannot be reconstructed.

`ui-statistics.ts` bounds reads to four known ledger files and 250,000 physical
lines. That byte budget is the rotation ceiling itself, including per-file record
headroom (about 20 MiB), because a rotated file may hold one record past its
5 MiB trigger; ordinary rotation retains a 5 MiB current file plus three
rotations. The query uses a revision-authoritative snapshot: it is reused while
`measurementRevision()` is unchanged and re-read only after a recorded run or a
reset, so a five-second poll costs one integer comparison instead of re-reading
and re-aggregating the ledger. Statistics refresh only while visible, at most
every five seconds, with stale-response protection and Retry. Loading, empty,
no-task, partial and read-error states remain distinct. Skip counts are
scope-aware: a task scope counts only records attributable to that task, so an
unparseable ledger line cannot mark a clean task partial, while retained scope
reports every skipped record and names the unattributable share separately.
Missing counters never
become measured zero; a failed refresh preserves the last valid chart with a
stale notice. A safety-limit error does not claim full totals.

## Accessibility

Target WCAG 2.2 AA. Interactive elements use native semantics, visible text,
keyboard order, accessible names, and status/error regions. No status relies on
color, hover, tooltip, or emoji alone. The dialog must remain usable with zoom
and at narrow desktop widths.
