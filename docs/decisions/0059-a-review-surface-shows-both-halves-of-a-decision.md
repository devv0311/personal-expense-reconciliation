# 0059. A review surface shows both halves of a decision, and adding a record is one thing a person does

**Status:** Accepted

## Context

The outcome-first surface recorded in
`docs/superpowers/plans/2026-09-17-outcome-first-product-surface.md` recomposed this product
into five journeys and re-expressed the review queue as the questions those decisions actually
are. Driving the result on a real ledger surfaced two places where the composition stopped
short of the journey it claimed.

**Adding a record was still a menu of four links out to the machinery.** `/add` listed the four
kinds of record a person holds and sent each one to the screen that ingests it: `/payments/import`,
titled _Import a statement_, with a back-link to _Payments_ and a section explaining "the
deterministic step and the model step"; the evidence library, titled _Evidence_, offering
_Upload a document_, _Write a note_ and _Paste a notification_; and the manual form behind a
query string on the payment workspace. Each is a correct destination. None of them is a place
somebody holding a restaurant bill would have looked, and none of them said, in words, what
would happen to the thing they were about to hand over.

**The review surface could only count down.** `/needs-attention` reported what was open and
nothing reported what was closed. A person could work through every question the ledger had and
never once see a decision they had made — which is also the only way a wrong one is ever found.
A bill attached to the wrong payment looks exactly like a bill attached to the right one, until
there is a list.

A third thing followed from the second. Reading _why_ two records look like the same event, and
_saying whether they are_, happened on two different screens: the connection view explained the
suggestion in sentences and offered no answer, while the answer lived in an inspector built
around a signal-by-signal comparison table, beside a payment named by eight hexadecimal digits.

## Decision

### Adding a record happens in one place, in the reader's words

`/add` asks what somebody is holding — a statement, a bill or receipt, a payment screenshot or
message, a payment no export will show, something they want to write down — and opens the form
for it in place. Each kind states **what adding it does and what it does not do** before the
form: that a statement is all-or-nothing, that the same file twice is recognised rather than
doubled, that nothing on it counts as spending until something says what it was for, and that a
note about a repayment moves no money.

**No new write path.** Every form is the existing component, and every one is still a button
that opens a `DecisionDialog` stating its consequence (ADR-0049). The specialist screens keep
their routes, their batch history and their library, under More.

### `GET /api/links` — what has already been connected

One new read, `services.listConfirmedLinks`, composing `listEvidenceLibrary({ linkage: 'linked' })`
with the accepted candidate behind each link. It computes nothing: every field is stored, or a
word `domain.documentWords`/`domain.matchSignalWords` maps a stored one onto.

Two fields make the row worth having. **`origin`** distinguishes a record somebody accepted from
an offer from one that arrived already attached — two different acts that a single "linked" flag
would report identically, crediting a person with a decision they never made. **`nameSource`**
says when the only name a payment has is the bank's own wording, because on a ledger of imported
statements most of them are, and printing `UPI-AMZN9821PYTM` as though somebody had chosen it is
how a screen starts claiming to know more than it does.

The stored actor string (`user:dev`) stays in the audit trail and off this surface; what the row
carries is _when_, which is what somebody checking their own work is looking for.

### The answer goes where the reasons are

`/connections/:paymentId` gains **Yes, they go together** / **No, different thing** on any
proposal still open, calling `services.decideEvidenceMatch` — the same write the inspector
calls, behind the same kind of dialog. The dialog states the permanence in the words a person
would use, and says what the decision does _not_ do: it does not decide what the payment was
for, who shared it, or what anybody owes.

The review inspector keeps the full comparison and remains the right screen for a doubtful one;
what changed is that its card leads with _what matches_ and _what does not_ and puts the
signal-by-signal table one disclosure away. Nothing was removed from it.

## Consequences

- **`web/` still performs no financial arithmetic.** The one read added is a read
  (`web/CLAUDE.md` rule 1); the origin and name-source judgements are the API's, for the same
  reason `fullyAccountedFor` is.
- **Two places can now accept a match.** They are one function with one audit trail, and
  `evidence.linked_payment_id` stays write-once (ADR-0034) — a second _surface_, never a second
  path.
- A ledger whose records are all unconnected sees the empty state, which says nothing has been
  connected yet rather than showing an empty table. On the ledger this shipped against, that is
  the true answer.
- `Select`'s `className` now sizes its wrapper. Every caller passes a width, and the chevron —
  positioned against the wrapper — used to float at the far right of the row while the box it
  belonged to sat narrow beside it.
