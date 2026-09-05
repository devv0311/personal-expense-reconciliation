# 0044. Context re-attachment records a reading and a set of explained candidates, never a link

**Status:** Accepted

## Context

`CLAUDE.md`'s pillar 1 is context re-attachment: a UPI statement line decays to
`UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD`, or worse to `UPI/P2M/402312345678`, while the push
notification that arrived the same second knows the amount, the reference, the account tail and
the merchant. Phase 17 is the phase that puts the two together.

Two pieces of the answer already existed and must not be rebuilt:

- **ADR-0034** made `evidence.linked_payment_id` / `linked_expense_id` **write-once**:
  `null → id` is permitted, `id → a different id` and `id → null` are refused, because a
  `Receipt` reaches its payment through exactly those columns and re-pointing one silently
  relocates every interpretation extracted from that document.
- **ADR-0037** made receipt-to-payment matching **surface candidates only**:
  `domain.findCandidatePaymentMatches` compares an extracted `Receipt.total` against unlinked
  live debits inside a date window, the `unmatched_evidence` review item carries the result, and
  a human still clicks. Auto-linking was rejected because "exactly one match" is not the same
  guarantee as "the correct match", and a wrong link is unrecoverable under ADR-0034.

What phase 17 needed that neither provides:

1. **Somewhere to put what a piece of evidence says.** A bank SMS or a UPI push notification is
   free text on an immutable `evidence` row. There was no structured amount, direction,
   reference, account tail or merchant anywhere — so there was nothing for a general matcher to
   compare, and no way to record that a document _had_ been read.
2. **A matcher that works on more than an extracted receipt total.** ADR-0037's rule is amount
   plus a capture-date window. The signal that actually resolves UPI narration decay is the
   **reference identifier** — the same UTR/RRN that `invariants.md` #10 already treats as
   conclusive identity for deduplication — with direction, owned account, time and merchant
   corroborating or contradicting it.
3. **A record of the offer, and of what was decided about it.** A candidate list recomputed on
   every read cannot say "a person looked at this and said no", cannot be idempotent in any
   meaningful sense, and gives a reviewer no stable thing to decide about.

## Decision

### `EvidenceObservation` — the structured reading, beside the immutable source

One DERIVED row per `Evidence` record (`evidence_observations`, unique on `evidence_id`),
holding `observed_amount`, `observed_direction`, `observed_reference` (plus its normalized
form), `observed_reference_type`, `observed_account_hint`, `observed_merchant_text` and
`observed_occurred_at`. Every field is nullable, because partial evidence is the ordinary case;
what is not optional is that the row observes **something**, enforced by
`evidence_observations_not_empty_check` and `domain.validateEvidenceObservation`.

It is a separate table for the same reason `receipts` is one: `evidence` is SOURCE and immutable,
and an interpretation of a source cannot live on the source's own row. The raw notification text
stays in `evidence.raw_text`, untouched, forever.

`derivation` records how the reading was arrived at — `parsed_from_text`
(`domain.parseNotificationText`, a fixed grammar over the evidence's own words) or
`caller_supplied` (an importer that already had the fields as structured data). **Neither is a
model.** Reading `Rs.450.00 debited … UPI Ref no 402312345678` off a bank's own SMS is parsing,
which `ai-boundary.md` assigns to deterministic application code, not inference. Where the
grammar does not match, the field is `null` — an honest "this text does not say" rather than a
guess. Direction specifically is refused when the text contains both families of words
("refund … credited against your debit"), because picking one would be a coin flip recorded as a
fact.

`notification_key` is unique and deterministic (`domain.notificationDedupeKey`): the same
notification forwarded twice, or the same SMS export imported twice, resolves to the record it
already is. That is the rule `ingestEvidenceDocument` applies to bytes, applied to text that has
no content address of its own.

It is **nullable**, and that is load-bearing. A reading of an `Evidence` row that already exists
— a receipt's extracted total, a human's correction — carries no key, because that row's own id
is already its identity. Giving every observation a movement-shaped key would mean two receipts
that happen to total the same amount collide, and the second one's reading would be lost to a
uniqueness rule that was never about it. PostgreSQL's unique indexes ignore nulls, which is
exactly the shape wanted. A correction also leaves the key as it was: the key describes the
notification as it arrived, not the reading, and changing it would let the same notification be
recorded a second time.

`observed_account_hint` carries the same `~ '^[0-9]{1,4}$'` check `accounts.last4` does. An SMS
is where `A/C XXXX4821` enters this system, so it is where `security-model.md`'s "no full account
or card number is ever stored" has to hold.

### `EvidenceMatchCandidate` — the offer, with its reasoning, recorded

One DERIVED row per (evidence, payment) pair the matcher offers
(`evidence_match_candidates`, unique on the pair), holding `strength`, `confidence`, the matched
and conflicting signal names, the **full per-signal provenance** (`signals`: verdict plus both
sides of each comparison plus a line explaining it), the review reasons, and a `status` of
`proposed | accepted | dismissed | superseded`.

`domain.matchEvidenceToPayments` is a pure function producing them. Six signals — reference,
amount, direction, account, time, merchant — each returning `matched`, `conflicted` or **`absent`**.
The third value is load-bearing: a notification with no account tail says nothing about the
account, it does not disagree about it, and collapsing the two would turn silence into evidence.

Eligibility is stated positively, so neither half is a judgement call:

- **Nothing structural contradicts it.** A debit is not a credit (the two legs of one transfer
  are two payments, ADR-0023); a movement on `…4821` is not a movement on `…9013`; money on an
  account this user does not own is not theirs to re-attach. Each produces **no candidate**,
  with the reason recorded on the assessment, rather than a low-confidence one.
- **Something positively corroborates it.** Either the references agree, or the amount agrees
  _and_ the timing is inside the window. Amount alone is a coincidence waiting to happen; timing
  alone is not evidence.

A reference match with a disagreeing amount or date stays a candidate, flagged. The UTR says
these are one transaction, and the disagreement is exactly what a reviewer needs to see.

`strength` is `deterministic` only for a matching reference with **nothing** contradicting it —
the same basis `isDeterministicDuplicate` already uses. `confidence` restates the signal set in
`ai-boundary.md`'s four levels, deliberately not as a 0–100 score, which would invite exactly the
threshold rule ADR-0024 forbids.

### Linking is still the human act ADR-0034/0037 made it

Nothing in the matcher returns an instruction. `services.decideEvidenceMatch` with `accept` is
the only path from a candidate to a link, and it goes through **phase 10's own**
`domain.assertEvidenceLinkOnce` and `services.applyEvidenceLink` — extracted for reuse rather
than reimplemented, so there is exactly one write path to the column ADR-0034 governs. Attaching
evidence that already has a home fails there, identically, however it was reached.

The schema enforces the other half:
`evidence_match_candidates_decision_check` makes `accepted`/`dismissed` possible **only** with a
recorded `decided_at` and `decided_by`, and `domain.parseDecisionActor` refuses anything but a
person or an approved `Rule`. "No confidence threshold silently approves an evidence link" is
therefore a property of the schema, not a promise in a service.

Accepting supersedes the candidate's siblings — the question has been answered — and a candidate
a person has decided is never rewritten by a later matcher run.

### Re-running writes nothing

`services.matchEvidenceContext` computes the whole write plan before opening a transaction, and
returns `outcome: 'unchanged'` having written no row, no `updated_at` and no audit event when the
plan is empty. That is structural rather than a promise: `runAudited` rolls back a mutating unit
of work that recorded nothing, so entering it on a no-op would turn an idempotent re-run into an
error — and writing an audit event to avoid that would be recording that nothing happened, in the
log whose job is to record what did.

A candidate the matcher no longer offers becomes `superseded` rather than being deleted, so "why
was this evidence never attached?" stays answerable.

### The re-attached context is a read

`services.getPaymentContext` folds a payment and every evidence record linked to it into
`domain.deriveReattachedContext`. The narration comes through **verbatim** in its own field and
the reconstruction sits beside it; there is no code path producing a _replacement_ narration, so
nothing downstream can mistake one for the other (`invariants.md` #4). Several records enrich one
movement, and where two of them disagree — or one disagrees with the payment — the context names
both values and picks neither.

### The sanitization boundary, extended and made fail-closed

The re-attached merchant names are the one part of this that leaves the machine:
`ClassificationContext.reattachedContext` feeds `redactPaymentForInference`, which sends
`reattachedMerchantHints` and nothing else off the context — no reference, no account tail, no
raw notification text.

`assertPayloadSanitized` now runs at the end of every redaction builder and **throws instead of
sending** if any identifier is still present. It is independent of the redactors on purpose: they
are pattern substitutions over free text written by banks, and a payload is a shape somebody can
extend without noticing there was a rule attached to it. Both failures are silent, and both end
with an account number at a third party. Per-field profiles keep it honest — a statement
description's bare 4+ digit run is refused, a receipt's is not (prices and quantities are the
signal extraction exists to read), and a structural field is not scanned at all.

`createLocalRedactionMap` keeps the reversible mapping `CLAUDE.md`'s pillar 6 requires **local**,
as a separate object the caller holds rather than a field on a payload, so there is no way to
serialize a request and include it by accident.

## Consequences

- A bank SMS or UPI push notification is now first-class evidence with its own ingestion route,
  and appears in the review queue when it has no home — `listUnmatchedEvidence` widened from "a
  stored document" to "a stored document, or a bank/UPI notification". Manual notes stay out:
  their links were chosen by the person who typed them.
- The `unmatched_evidence` review item gains `observation` and `matchCandidates`. ADR-0037's
  `candidateMatches` is unchanged and still works with no enrichment run at all; where both are
  populated they agree by construction, because enrichment derives a receipt's observation from
  the same `Receipt.total`.
- Phase 8's classifier gets better input for free on any payment with attached evidence, and
  identical input on any payment without.
- A same-amount collision now has an explicit outcome: every equally-supported payment is offered
  and every candidate carries `ambiguous_candidates`. The honest reading is "the evidence does
  not distinguish these", not "the first one is probably right".
- Nothing here can move a number. No amount, no `raw_description`, no `cash_flow_category`, no
  `cash_flow_state`. Matching a refund notification to a credit explains that credit to a human;
  it does not classify it, which stays `services.classifyPaymentCashFlow` plus an explicit
  approval (ADR-0017, cash balance).

## Alternatives considered

1. **Recompute candidates on every read, as ADR-0037 does.** Simplest, trivially idempotent, and
   it loses the two things this phase needs: a dismissal has nowhere to live, so the same
   rejected suggestion returns forever; and a reviewer decides about a list that may have changed
   underneath them between load and click. ADR-0037's read-time list remains, unchanged, for the
   receipt case it was written for.
2. **Store the reading on `evidence` itself.** Fewer tables, and it breaks the immutability
   boundary the whole ledger rests on: `evidence` is SOURCE, `UPDATE` is revoked on it at the role
   level, and only linkage is granted back. An interpretation belongs beside the source, which is
   what `receipts` already established.
3. **Route matches through `ai_inferences` as scored proposals.** Rejected for ADR-0037's reason,
   one layer on: `ai-boundary.md`'s confidence machinery is for judgement calls a model makes over
   ambiguous evidence. Comparing two reference strings is not a judgement, and dressing it up as a
   model proposal would misstate what kind of claim it is — and would put an inference type in
   the closed `AI_INFERENCE_TYPES` set for an operation no model performs.
4. **Auto-link a `deterministic` candidate.** The most tempting one, and still wrong under
   ADR-0034: a reference match is strong evidence about a transaction, not permission to make an
   irreversible write. It would also make "no confidence threshold approves anything" false in
   the one place the system could least afford it.
5. **A blanket deep-scan for any 4+ digit run in every outgoing string.** Rejected because a
   receipt's raw text is legitimately full of them and an ISO timestamp or a UUID contains them
   by construction; a per-field profile refuses the fields where a digit run means something and
   leaves alone the ones where it does not.
