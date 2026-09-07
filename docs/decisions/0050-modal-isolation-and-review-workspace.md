# 0050. Isolate modal decisions and keep review navigation separate

**Status:** Accepted

## Context

The post-Phase-21 review found that a modal focus trap alone did not isolate a decision.
Global `g` navigation, `?`, Cmd/Ctrl+K and queue triage could still respond while a dialog
was open. On the queue, Enter also intercepted native inspector buttons. Mobile readers
had to pass the whole list to reach the selected item's inspector. A fixed 50-item limit
left lower-priority items unreachable even though the API reported `truncated`.

## Decision

Keep ADR-0049's explicit decision boundary and hand-owned components. Render each modal
through a React body portal; preserve and temporarily set background siblings' `inert`
state and body scroll locking, then restore them alongside the invoking control's focus.
Global commands and queue triage do not run while a modal is present. Initial focus remains
on the panel, and the reason field never submits. A visible close button complements Escape
and the backdrop; all dismissal paths are disabled while a decision request is pending.

The review workspace keeps the domain's order and separates selecting from opening. On
small screens, opening replaces the queue with the inspector; returning reveals the queue
and restores focus to the originating item. A new filter remounts the workspace, resetting
selection and limit. The existing API's `truncated` flag exposes a Show more action that
increases the read limit by 50, preserving the previous list during the request. There is
no client-side reprioritization, approval shortcut or new financial computation.

Unmatched evidence displays an amount only when a receipt total or observation supplies
one. Its backend materiality fallback of zero remains useful for ordering, but must not
be presented as an evidenced monetary fact.

## Consequences and validation

- The portal and inert background use platform capabilities and React already in the
  project; no headless component dependency is introduced.
- Native Enter on a focused button remains keyboard-accessible. It can open a decision
  dialog, but no global shortcut confirms that decision.
- Required reasons, immutable evidence, separate refund/distribution steps and proof-pack
  recipient review remain unchanged. No backend service, schema or calculation changes.
- Regression tests cover modal isolation, pending dismissal, focus restoration, native
  Enter, filtering, loading past 50 items, domain order and unknown versus actual zero.
  Browser checks cover focus containment, responsive behavior, the CSS active-state fix,
  exact API figures and axe accessibility in light, dark and mobile contexts.
