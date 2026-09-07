# 0049. Keyboard-first navigation, and a shortcut that never completes a decision

**Status:** Accepted

## Context

`CLAUDE.md`'s design standard asks for `Cmd+K` command search, "discoverable triage shortcuts,
predictable focus, selection and escape behavior" — and, in the same paragraph, that
"consequential approval remains explicit; a shortcut must not silently approve an ambiguous
decision."

Those two sentences pull in opposite directions, and the tension is the whole design problem.
The reason a triage queue gets keyboard shortcuts is that a person is working through a list
quickly. The fastest possible triage is `j`, `a`, `j`, `a` — move, approve, move, approve. That
is also, precisely, a mechanism for approving a financial decision without reading it, in a
system whose central rule is that a human decides (`invariants.md` #16, #17).

A second question came with it. A command palette needs a combobox: a text field that keeps
focus while the arrow keys move a selection in a list below it, closes on Escape, and returns
focus to whatever opened it. `Design.md` says to reach for a styled native control first and for
a headless primitive "only when a specific control genuinely needs one, and say which behavior
justified it when you do". Nothing in phases 15–20 had needed one; this does.

## Decision

### A shortcut moves you somewhere or opens something. It never completes a decision.

The keyboard layer is deliberately small, and every key in it is navigational:

| Key                | What it does                                              |
| ------------------ | --------------------------------------------------------- |
| `Cmd K` / `Ctrl K` | Opens the command palette.                                |
| `?`                | Opens the shortcut list, including the open screen's own. |
| `g` then a letter  | Goes to one of the six sections.                          |
| `j` / `k`          | Moves the selection in the review queue.                  |
| `Enter`            | Moves focus to the selected item's inspector.             |
| `Esc`              | Closes a dialog, or clears the selection.                 |

There is no `a` for accept, no `x` for reject, no shortcut for distributing a refund, reviewing
an audit finding or copying a proof pack. **Every consequential act is a button, pressed after a
dialog that states what it will do** — and each dialog is a component (`DecisionDialog`) that
forces its caller to supply that consequence in words, requires a reason where the service
requires one, and never submits on a keystroke.

The command palette is subject to the same rule: it offers navigation only. It can take you to a
person's balance, a recent run, an open finding or a proof-pack preview; it cannot approve,
distribute or copy anything. The fastest path to a decision still ends at a button.

`Enter` in the queue is the boundary case, and it resolves to _open_, not _act_: it moves focus
into the inspector, where the reader is one Tab away from reading and several deliberate steps
away from deciding.

### A dialog is hand-built, not a headless dependency

`components/ui/dialog.tsx` is about sixty lines and provides the three behaviors HTML does not:
focus containment, focus restoration, and Escape-to-close. `<dialog>`'s own `showModal()` is not
usable here — jsdom, which every test in this package runs in, does not implement it — and a
headless component library would be a dependency and a transitive tree for one control, which is
the trade ADR-0043 already declined when it took shadcn's authoring style without its CLI or
Radix.

Two details are decisions, not defaults:

- **Focus lands on the panel, never on the first button.** A dialog that focuses its confirm
  button is one Enter away from an act the reader has not read.
- **A decision dialog is mounted only while open**, so its reason field starts empty every time.
  A dialog that reopens holding the last reason is a way to submit somebody else's words.

The palette is a `role="combobox"` over a `role="listbox"` driven by `aria-activedescendant`, so
the search field keeps focus while the arrow keys move the highlight — the one control in this
app that a real `<select>` genuinely cannot be.

### Keystrokes that belong to a text field stay in it

Every global listener ignores events originating in an `input`, `textarea`, `select` or
`contenteditable`. Typing "go" into a reason box does not navigate away mid-sentence. The `g`
prefix expires after a second, so an unrelated `r` a minute later is just an `r`.

### Discoverability is part of the contract

A shortcut nobody can find is a shortcut that does not exist, so `?` lists every key that
currently applies — the global ones and the ones the open screen registered — assembled from the
same constants the listener uses, so the list cannot drift out of date.

## Consequences

- Triage is fast to _move_ through and deliberately not fast to _approve_ through. That is the
  intended shape: the bottleneck in this product is a person reading, and removing it would be
  removing the product's reason to exist.
- The keyboard layer is testable without a browser, and is tested both ways: the frontend suite
  asserts that `j`/`k` move a selection while making no `POST` at all, and a driven browser
  confirms the same against the real app.
- `web/` still has no component, animation or icon library. The one hand-built primitive is
  documented in `Design.md` alongside the reason it exists.
- A future phase that wants a genuine bulk action (approving twenty identical proposals at once)
  should design it as an explicit multi-select with one confirmation over the set — not as a
  per-item key. This ADR does not pre-approve that; it rules out the shape that would arrive by
  accident.

## Alternatives considered

1. **`a` to accept, with an undo window.** Rejected: undo is a good pattern for reversible edits
   and a poor one for a recorded financial decision. Accepting a proposal writes an approval with
   an actor and a timestamp, and a settlement or an allocation follows from it; "you can take it
   back for five seconds" is not the same guarantee as "you read it and pressed the button."
2. **`a` to accept, opening the confirmation dialog with the confirm button focused.** Rejected as
   the same thing in a costume: two keystrokes with no reading between them, and the second one
   is `Enter`, which people press reflexively.
3. **Radix (or another headless library) for the dialog and combobox.** Rejected on ADR-0043's
   own reasoning: two controls do not justify a component library, and the behaviors needed here
   are small, well-specified and directly testable. Revisit if a third and fourth control appear.
4. **No keyboard layer at all**, on the grounds that a financial ledger should be slow. Rejected:
   `CLAUDE.md` asks for keyboard-first navigation explicitly, and the friction that matters is at
   the decision, not at the navigation. Making a person mouse to a section does not make them
   read a proposal more carefully.
