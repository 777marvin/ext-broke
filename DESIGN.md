---
version: alpha
name: "Broke"
description: "A calm context-budget instrument for AiderDesk that makes automatic savings understandable without hiding expert control."
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

Broke should feel like a trustworthy instrument panel: one unmistakable state,
one recommended operating choice, and deeper controls available only when the
operator asks for them. The money badge is the compact instrument; its dialog
is the readable inspection panel.

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
- **Memorable signature:** A single colored status dot paired with a complete
  sentence; color never carries meaning alone.
- **Restraint:** No decorative motion, dashboards, or dense metrics in the
  everyday view. Technical measurements live behind disclosure.
- **Anti-references:** Terminal help screens disguised as dialogs; unexplained
  emoji-only state; generic analytics dashboards; warning-heavy setup screens.
- **Token ownership/runtime mapping:** This file records the existing inline
  visual vocabulary. `StatusBadge.jsx` is the runtime owner for the badge and
  its dialog. `ConfigComponent.jsx` uses AiderDesk's supplied controls and is
  the expert configuration surface.

## Colors

White surfaces and dark neutral text preserve the host application's utility
register. Blue is the interactive accent and ready state. Green means measured
work completed, amber means an optional capability needs attention, and red is
reserved for disabled or failed states. Every semantic color is paired with
text. High-contrast and forced-color rendering may fall back to system colors.

## Typography

Use the host-compatible system sans stack for all controls and explanations.
Use the monospace stack only for literal commands, paths, or machine values in
the expert surface. Headings use weight rather than a separate display face so
the extension remains visually native inside AiderDesk.

## Layout

The badge stays compact. The dialog is a single 460 px column with a 94vw cap
and internal scrolling. The sequence is status, everyday controls, common
actions, advanced disclosure, then save/cancel. Controls must remain reachable
at narrow widths; three common actions may wrap or compress without truncating
their labels.

## Elevation & Depth

Use one restrained modal shadow and thin borders. Status cards use tinted flat
surfaces rather than extra elevation. Nested cards and ornamental gradients are
out of scope.

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

### Savings approach

Both settings surfaces use the same synchronous draft reducer assembled into
their standalone templates by `scripts/ui-template-source.cjs`. Draft edits
preserve other changes from the same render and mark preset-owned edits Custom.
Preset values remain owned by `presets.ts`; edits do not add network round trips.

The native select is intentional: the host/operating-system popup is accepted.
Options are outcome-focused: Safe, Balanced, Maximum savings, and Custom.
Balanced is the recommended default.

### Advanced disclosure

Uses native `details`/`summary`, starts closed, and retains all technical
controls and command tools. It is progressive disclosure, not removal.

### Feedback and safety

Action results remain inline in the dialog and use an accessible status region.
State-changing or paid commands retain two-step confirmation. Check setup
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

### Honest savings breakdown (F6)

When inspecting savings (via "View savings" or diagnostics), the UI strictly separates:

1. Observed conversation reduction (measured character delta from the message pipeline; tokens estimated via chars / 4).
2. Provider-reported usage (actual sent, cache-read, and cache-written tokens from the model API).
3. Modeled monetary estimates (dollar savings calculated from task model input rates).
4. Avoided context (counterfactuals like slicing, flushing, and search snippets, labeled outside measured totals).

A mandatory honest notice states that a measurement ledger does not prove a billed saving.

## Accessibility

Target WCAG 2.2 AA. Interactive elements use native semantics, visible text,
keyboard order, accessible names, and status/error regions. No status relies on
color, hover, tooltip, or emoji alone. The dialog must remain usable with zoom
and at narrow desktop widths.
