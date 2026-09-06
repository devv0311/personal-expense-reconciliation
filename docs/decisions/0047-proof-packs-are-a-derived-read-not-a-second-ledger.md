# 0047. A proof pack is a derived read, redacted and fail-closed, never a second ledger

**Status:** Accepted (2026-09-06); implemented in Phase 20.

## Context

`CLAUDE.md`'s fifth pillar is one-click, recipient-specific proof packs: a concise summary of
the original spend, the item refunds against it, the net shares, the settlements already made
and the balance that remains, with supporting evidence references, that a person can paste into
a WhatsApp message to a friend or a flatmate.

`docs/roadmap.md`'s Phase 20 entry and its "Recommended next phase" note both make the same
point, and it is the point this ADR turns into rules: _"Every number a pack quotes already
exists and is already derived once — `domain.netAmount`, the current refund-aware allocation,
`computeNetBalance`, `obligationEvidenceStatus` — so the phase is a rendering and redaction
problem, not a second financial engine, and a pack that recomputes a share is a bug."_

Checked against the code before writing this ADR, every figure a pack needs already has exactly
one owner:

- **the pair balance and its evidence status** — `services.getBalance` →
  `domain.computeNetBalance` + `domain.obligationEvidenceStatus` (ADR-0006, ADR-0014);
- **each expense's recipient share** — `getBalance`'s own `contributions`, from
  `domain.computeObligations`;
- **the net expense after refunds, and whether a refund is still pending** —
  `services.getRefundAllocationState` (ADR-0018, ADR-0045);
- **prior settlements between the pair** — `db.listSettlementsForAudit`, added in Phase 19;
- **unresolved contested facts** — the open `splitwise_audit_findings` for the pair
  (ADR-0046);
- **whether the attached evidence disagrees** — `services.getPaymentContext` →
  `domain.deriveReattachedContext` (ADR-0044).

Phase 20 needed none of a new table, a new balance path, or a new number. What it needed was a
place to arrange those numbers into prose, a redaction step for the free text that arrangement
pulls in, and a fail-closed guard so an unredacted identifier cannot be exported.

## Decision

### 1. Derivation only — no schema, no migration

There is **no `proof_packs` table** and no migration in this phase. A proof pack is a pure
function of the ledger state and one as-of instant, computed on request and returned, exactly
like `getBalance`, `getRefundAllocationState` and `getPaymentContext` — none of which persist
anything either.

A durable table was considered and rejected. It would be a second place a share, a net or a
balance is written down, which is the thing the roadmap forbids; it would go stale the moment
any contributing expense, allocation, adjustment or settlement changed, and a stale proof pack
is worse than none; and nothing in the product needs a pack to outlive the request that asked
for it — a pack is a snapshot to read now and paste now, not a record with its own identity,
review state or lifecycle. `domain.buildProofPack` is pure; `services.buildProofPackPreview`
opens no transaction, runs no `runAudited`, writes no `AuditEvent`, and calls no
`SplitwisePort` method. Generating a pack changes nothing.

### 2. The pack quotes; it never computes

`domain.buildProofPack` receives already-derived values — `netBalance`, each `recipientShare`,
each expense's `netAmount` and refund reductions — and arranges them. Its only arithmetic over
money is `sumPaise` (adding figures it was handed) and an absolute value for the headline
amount. It re-divides nothing, re-nets nothing, re-derives no balance. The service that feeds
it calls `getBalance` / `getRefundAllocationState` and passes their outputs straight through.
A test asserts each pack figure equals the canonical function's output for the same ledger.

Money stays integer paise `bigint` end to end. The one new formatter, `domain.formatInr`, is
display-only and never feeds arithmetic (invariants.md #12), the same rule `formatMajorUnits`
already follows.

### 3. Recipient isolation is structural, not a redaction pass

The assembler only ever receives **the recipient's own share** of an expense (one
`ObligationContribution` between the user and the recipient) and **the settlements between the
user and the recipient**. Other beneficiaries are never passed in, so their names and shares
cannot appear — there is nothing to filter out afterwards. The rendered text names exactly two
people. A three-way dinner where a third person also owes the user shows the recipient their
own third and the pair balance, and does not mention or identify the third person at all.

### 4. Redaction reuses Phase 17, and the export fails closed

Every free-text field a pack would paste into a message — expense descriptions, evidence
labels, an audit finding's summary, a refund's review message — is put through Phase 17's
`redactReceiptText` with a **local** `createLocalRedactionMap` that the service holds and never
returns. The `receipt_text` strength is deliberate: a pack legitimately carries amounts and
dates, which the strict `statement_text` profile's bare-digit-run rule would refuse.

The finished pack is then walked through `findResidualIdentifiers` — the same residual check
`assertPayloadSanitized` runs before an AI call — and if any string still carries a UPI handle,
a phone number, a card/account number or a labelled identifier, `services.assertProofPackExportable`
throws `SanitizationError` and **nothing is returned**. This is ADR-0044's fail-closed boundary
applied to an export instead of an AI payload, for the same reason: redaction is pattern
substitution over free text written by banks and people, a rule that covers today's formats
meets tomorrow's, and a partially-redacted pack that leaked one field would be a worse outcome
than no pack, because nobody would find out. `src/api/http.ts` maps `SanitizationError` to a
`500 PAYLOAD_NOT_SANITIZED` so the stop is greppable in a log rather than an anonymous internal
error.

### 5. Uncertainty is carried, never smoothed

A pack states, always, that its figures are _"Derived from my records — not yet confirmed by
you."_ On top of that baseline, each of the following becomes a visible `ProofPackWarning` on
the preview and a line in the `PLEASE NOTE` section of the text:

- an **unresolved Phase 19 audit finding** for the pair (`open` or `acknowledged`) — the pair
  has contested facts, and the pack says so with a count rather than quoting a confident
  balance over them. This is ADR-0046's _"an incomplete check is not agreement"_ carried into
  the pack's own as-of boundary;
- a **refund recorded but not yet distributed** (`getRefundAllocationState.pendingDistribution`);
- a **refund that needs a manual allocation decision** (`reviewRequired`, ADR-0045);
- a balance the ledger **believes settled but cannot confirm**
  (`believed_settled_unconfirmed_by_ledger`);
- a **reverse balance after a settlement** — a refund landed after money already moved, so part
  of the balance is now owed back the other way (ADR-0018's worked example);
- a **mixed** legacy + item-attributed adjustment basis;
- **conflicting evidence** on a contributing payment (`getPaymentContext().conflicts`);
- a contributing expense with **no supporting evidence** attached.

### 6. `asOf` is an explicit snapshot label, not a historical filter

The pack stamps an explicit `asOf` (a request parameter, or the moment it was served) into its
header and its structure. It does **not** filter the balance, the contributions or the
settlements to that instant: `getBalance` and `computeNetBalance` have no as-of cutoff, and
adding one would be a second balance computation — the very thing §2 forbids. So `asOf` is
"where this stood when I took the snapshot", which is exactly what a WhatsApp summary means.
Determinism is unaffected and is tested: a fixed `asOf` over an unchanged ledger produces a
byte-identical pack, `generatedText` included; a changed ledger changes it.

### 7. API surface

```
GET /api/proof-packs/:recipientPersonId          build and return the preview
```

One route. A **GET**, because the operation is a pure read with no side effect — the same
shape as `GET /api/balances/:a/:b` and `GET /api/expenses/:id/refund-allocation`. `?asOf=<ISO>`
pins the label. `userPersonId` is resolved from the single `User` row via
`services.requireUserPersonId`, never taken from the request. A pack for the user themselves is
refused (`PRECONDITION_FAILED` → 409); an unknown or archived recipient is `ENTITY_NOT_FOUND`
→ 404.

There is no send, no copy-server-side, no "record that this was shared" — generating a pack
neither sends it nor records a settlement, and no WhatsApp transport exists or is required to
produce the artifact. The deliberate copy/export/share step is the caller's (Phase 21's UI),
separate from the local evidence boundary that let the pack be built at all.

## Consequences

- `src/domain/proof-pack.ts` and `src/services/proof-pack-service.ts` are new;
  `src/api/proof-pack-routes.ts` adds the one route. Two tiny repository reads are added —
  `db.listExpensePaymentIds` (the inverse of `listPaymentExpenseLinksByPayment`) and
  `db.listEvidenceLinkedToExpense` — both plain selects. `src/api/http.ts` gains a
  `SanitizationError → 500 PAYLOAD_NOT_SANITIZED` mapping. No existing behaviour changes.
- A fully-refunded expense whose recipient share is now zero **drops out of the pack** — it
  contributes no `ObligationContribution` (a zero share is no debt, `computeObligations`), and
  the unchanged pair balance already reflects it. This is a deliberate boundary of "derive
  strictly from the balance", recorded here rather than discovered later. The refund history
  itself is not lost — it is on the expense and reachable through
  `GET /api/expenses/:id/refund-allocation`; the pack simply does not narrate an expense nobody
  owes anything for any more.
- A non-proportional distribution of a legacy whole-expense reduction is summarised only as its
  total, not its per-person breakdown — the pack shows the recipient's resulting share, which
  is the figure that matters to them, and points at the refund-allocation read for the detail.
- Because the pack reuses `getBalance` unchanged, it inherits every limitation `getBalance`
  has, including `invariants.md` #9b's permanent boundary on settlements between two non-user
  people. That is the correct behaviour: a pack should not claim more certainty than the ledger
  it derives from.

## Alternatives considered

1. **Persist each generated pack in a `proof_packs` table.** Rejected for the reasons in §1: a
   second home for figures the roadmap says must have one, staleness the moment the ledger
   moves, and no product need for a pack to outlive its request. A pack is a view, and views
   are not stored here (`getBalance`, `getRefundAllocationState`, `getPaymentContext` are all
   table-less reads).
2. **A `POST /api/proof-packs` that records the generation as an event.** Rejected: generating
   a pack is not a consequential act — it sends nothing and changes no debt — and a POST that
   writes an audit row for a read would be recording that nothing happened, in the log whose
   job is to record what did (the same reasoning ADR-0044 used for its no-op re-run).
3. **Let `asOf` reconstruct a historical balance.** Rejected: `computeNetBalance` has no
   as-of parameter, and giving the pack its own point-in-time balance would be a parallel
   financial engine — exactly what §2 forbids. `asOf` is the snapshot instant, which is what a
   pasted summary means anyway.
4. **Reuse `assertPayloadSanitized` directly on the whole preview object.** Rejected: its
   field-profile map defaults to `statement_text`, whose bare-4+-digit-run rule would reject a
   pack's own amounts and ISO dates. `services.assertProofPackExportable` reuses the same
   `findResidualIdentifiers` primitive at `receipt_text` strength instead, which is the honest
   profile for text that carries prices and dates.
5. **Redact third-party names out of the text after rendering.** Rejected in favour of §3's
   structural isolation: a name that is never passed to the assembler cannot be rendered, and
   "never received it" is a stronger guarantee than "removed it afterwards".
