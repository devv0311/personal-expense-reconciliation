# Phase 7 — Transaction normalization

**Status:** design, awaiting review. No implementation exists.
**Date:** 2026-08-19
**Roadmap phase:** 7, following phase 6 (transaction import, PR #3).

## What this phase delivers

An imported payment currently carries only what the bank statement said. Normalization gives it
the two pieces of meaning that can be established **deterministically, from evidence already in
the row**, and moves it `imported → normalized`:

1. `channel` refined beyond the adapter's transport-level default.
2. `counterparty_type` / `counterparty_id` resolved to a known merchant, where the description
   matches a catalogued alias exactly.

It stops there. Deciding what a payment _is_ — an expense, a settlement, a transfer, an
investment purchase — is phase 8, and nothing in this phase may anticipate it.

### The bar for `normalized` is "attempted", not "resolved"

`lifecycle.md` already defines `NORMALIZED` as "channel, counterparty resolution **attempted**
(may still be `unknown`)". A payment whose description matches no alias is normalized
successfully with `counterparty_type = 'unknown'`. This is the phase's most important framing:
an unresolved counterparty is a recorded outcome, not a failure to retry, and it is what keeps
"unexplained money is a first-class concept" (CLAUDE.md principle 10) true one layer down.

## Scope decisions

Three questions were open when this phase was scoped. All three are settled; they are recorded
here with their reasoning because each one narrows the phase deliberately.

### 1. Deterministic resolution only — no AI leg

`data-flow.md` step 2 describes normalization as having two legs: a deterministic one, and a
call to `ai.normalizeMerchant()` producing a pending `AIInference` for anything the deterministic
leg cannot resolve. **Phase 7 builds only the deterministic leg.**

`src/ai/` is an empty directory holding a README. Building the AI leg means designing the whole
AI service boundary — interface shape, the structured-proposal contract, confidence handling,
the validation gate before a proposal can become state — which `ai-boundary.md` specifies and
phase 8 needs in full. Doing it here would mean designing that boundary twice, or designing it
under the pressure of a phase whose real subject is something else.

Consequence: a payment with no alias match ends at `normalized` with `counterparty_type =
'unknown'` and **no `AIInference` row**. The `ai_inferences` table stays empty until phase 8.

### 2. `reference_type` is the sole evidence for `channel`

The roadmap's phase 7 entry says normalization should refine `channel` "when a description
clearly indicates UPI". Two signals in the row can support that, and they are not equivalent:

| Signal                             | Where it comes from                                               |
| ---------------------------------- | ----------------------------------------------------------------- |
| `reference_type` (`upi_utr`, …)    | Extracted at import by the adapter, from the reference column     |
| `raw_description` prefix (`UPI-…`) | Would require the service layer to parse bank description strings |

**`reference_type` alone decides `channel`.** It is a typed field, produced by the layer that
owns format knowledge (`integrations/bank-csv/parse.ts` and its `REFERENCE_PREFIXES` table).
Matching on the description would duplicate that knowledge in `src/services`, where every new
bank's description quirk becomes a service-layer change — and string-sniffing a description for
meaning is a heuristic, which `ai-boundary.md` assigns to inference, not to deterministic code.

A source that populates no reference simply yields no refinement. That is the correct outcome,
not a gap: without a reference there is no deterministic evidence of the channel, and inventing
one from a description is exactly the guess this phase must not make.

### 3. The merchant catalog comes from a new synthetic fixture

`merchants` and `merchant_aliases` are declared in the schema and are empty; nothing seeds them.
Exact-alias matching needs data to match against, so this phase adds `fixtures/merchants.json`
and loads it the way `fixtures/people-and-groups.json` is already loaded.

Alias _learning_ — writing a new alias row when a user confirms a match — is phase 16
(rules/learning) and is out of scope. The catalog in this phase is seed data only.

## The two rules

Both live in `src/domain` as pure functions, because both are deterministic derivations of
existing values and CLAUDE.md puts all such logic there.

### Rule 1 — `refineChannel(referenceType, currentChannel)`

A total mapping from the reference type to a channel, falling back to the value the adapter set:

| `reference_type`                                                        | resulting `channel` |
| ----------------------------------------------------------------------- | ------------------- |
| `upi_utr`, `upi_rrn`                                                    | `upi`               |
| `card_reference`                                                        | `card`              |
| `bank_reference`, `merchant_order_id`, `cheque_number`, `other`, `null` | unchanged           |

`cheque_number` deliberately refines nothing: `PAYMENT_CHANNELS` is
`['upi', 'bank_transfer', 'card', 'cash', 'other']` and has no `cheque` member. Mapping a cheque
to `other` would be less accurate than leaving the transport the adapter recorded, and adding a
channel value is a schema change this phase has no need for.

### Rule 2 — `merchantAliasKey(rawDescription)` and exact lookup

The alias key is the description reduced to a canonical form: trimmed, internal whitespace runs
collapsed to a single space, uppercased.

`String.prototype.toUpperCase()` is used, never `toLocaleUpperCase()` — the former is
locale-independent, and the same statement normalized on a developer's machine and on a CI
runner must produce the same key, for the same reason `parse.ts` fixes dates at UTC.

Matching is **exact equality on the canonical key**, never prefix, substring, or fuzzy matching.
A hit sets `counterparty_type = 'merchant'` and `counterparty_id` to that merchant. A miss
changes neither field.

The same function produces the key when an alias is seeded and when a payment is matched. This
is deliberate and load-bearing: the stored `merchant_aliases.raw_pattern` **is** a canonical key,
so a change to how keys are formed is a change to both sides at once, in one place. (This
project has already been bitten by a rule stated once and applied in two places that drifted —
see ADR-0019's amendment.)

## Components

Nothing here requires a migration. `merchants`, `merchant_aliases`, and every `payments` column
this phase writes (`channel`, `counterparty_type`, `counterparty_id`, `state`) already exist from
the phase 1 schema, and `imported → normalized` is already a legal transition in
`PAYMENT_TRANSITIONS`. This phase is code and fixtures only.

| Location                                  | Responsibility                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/domain/normalization.ts`             | `refineChannel()`, `merchantAliasKey()`. Pure, no I/O, no clock, unit-tested.                                       |
| `src/db/repositories.ts`                  | `findMerchantByAliasKey`, `listPaymentsAwaitingNormalization`, `applyPaymentNormalization`, merchant/alias inserts. |
| `src/services/normalization-service.ts`   | `normalizePayments()` — orchestration, state transition, audit.                                                     |
| `fixtures/merchants.json`                 | Synthetic catalog: canonical merchants and their alias strings.                                                     |
| `tests/support/fixtures.ts` / `ledger.ts` | Loader and seeding helper, matching the existing people-and-groups pattern.                                         |

### Service interface

```ts
normalizePayments(db, {
  importBatchId?: ImportBatchId,  // scope to one batch; omitted means every eligible payment
  audit: AuditMeta,
}): Promise<{
  normalizedPaymentIds: readonly PaymentId[];
  channelRefinedCount: number;
  merchantResolvedCount: number;
}>
```

Both counts are counts of payments whose **stored value actually changed** — not of payments the
rule applied to. A payment already carrying `channel = 'upi'` whose `reference_type` is
`upi_utr` is normalized without incrementing `channelRefinedCount`, because nothing about it
changed. Counting rule-applications instead would make the number report how often the code ran
rather than what it did to the ledger.

Given no eligible payments, the call succeeds and returns empty — an import with nothing left to
normalize is an ordinary outcome, not an error.

Wrapped in `runAudited`, exactly as `importBankStatementCsv` is, so the whole run is one
transaction and every field change is recorded with old and new values.

## Boundaries this design must hold

Each of these gets its own test. They are listed as invariants rather than as implementation
notes because each one is a rule that a later change could silently break.

1. **Only `imported` payments are eligible.** A payment already `normalized` is skipped, so
   re-running normalization never rewrites a counterparty that was already resolved. This is
   what keeps "approved financial decisions do not silently change" (CLAUDE.md) true without
   needing a version table for derived fields. Re-deriving a normalization deliberately has no
   entry point in this phase.
2. **`ignored` is terminal and untouched.** A duplicate ignored at import must never be
   normalized. `PAYMENT_TRANSITIONS.ignored` is `[]`, so `assertPaymentTransition` enforces this
   rather than the query alone being careful.
3. **SOURCE columns are never written.** `amount`, `occurred_at`, `raw_description`,
   `account_id` are write-once (`invariants.md` #4). `channel` and `counterparty_*` are DERIVED
   metadata layered on top, which is why they may be written at all.
4. **No classification, at all.** The only `counterparty_type` this phase ever writes is
   `merchant`. `NEFT TRANSFER TO SELF A/C X4821` is plainly an internal transfer to a human
   reader and must be left `unknown` — recognising it is classification, and classification is
   phase 8's. `internal_account` and `investment_instrument` are never written here.
5. **A person is not a merchant.** `UPI-FRIENDA-TRANSFER` matches no merchant alias and stays
   `unknown`. Resolving payments to _people_ is a different problem with a different table, and
   it is not in this phase.
6. **Direction is irrelevant to normalization.** A credit is normalized on the same terms as a
   debit — `ACH REFUND SAMPLE ELECTRONICS STORE` resolves to a merchant. Whether that credit is
   a refund is classification, not normalization.

## Acceptance criteria

Running `normalizePayments` over an import of `fixtures/bank-statement.csv` must produce exactly
this, and the integration test asserts the whole table:

| Description                                  | `reference_type` | `channel`       | counterparty                        |
| -------------------------------------------- | ---------------- | --------------- | ----------------------------------- |
| `UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD` | `upi_utr`        | `upi`           | merchant — Blinkit                  |
| `NEFT TRANSFER TO SELF A/C X4821`            | `bank_reference` | `bank_transfer` | `unknown`                           |
| `NEFT TRANSFER FROM SELF A/C X9013`          | `bank_reference` | `bank_transfer` | `unknown`                           |
| `UPI-ZOMATO0091-SAMPLE RESTAURANT PVT LTD`   | `upi_utr`        | `upi`           | merchant — Sample Restaurant        |
| `ACH REFUND SAMPLE ELECTRONICS STORE`        | `bank_reference` | `bank_transfer` | merchant — Sample Electronics Store |
| `UPI-FRIENDA-TRANSFER`                       | `upi_utr`        | `upi`           | `unknown`                           |
| `ELECTRICITY BOARD BBPS BILLPAY`             | `bank_reference` | `bank_transfer` | merchant — Electricity Board        |
| `UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD` | `upi_utr`        | `upi`           | merchant — Blinkit                  |

Totals: 8 payments normalized, 4 channels refined to `upi`, 5 counterparties resolved across 4
catalogued merchants — the two Blinkit rows are distinct transactions sharing one alias, not
duplicates (they carry different references, which is why phase 6 reports no duplicates for this
fixture).

## Testing

Per `testing-strategy.md`, and because deduplication-adjacent derived state is financial data:

**Unit (`src/domain/normalization.test.ts`)** — every `reference_type` value maps as tabulated,
including `null`; the fallback preserves the adapter's channel; alias keys are stable across
casing, padding, and internal whitespace runs; two descriptions differing only in those respects
produce one key, and descriptions differing otherwise never collide.

**Integration (`tests/integration/normalization.test.ts`)** — import the fixture, normalize,
assert the acceptance table exactly; every payment reaches `normalized`; SOURCE columns are
byte-identical before and after; a second `normalizePayments` run is a no-op that rewrites
nothing; one audit event per changed payment carrying old and new values; scoping to an
`importBatchId` leaves other batches alone.

The ignored-duplicate case needs a duplicate to exist, which this fixture deliberately contains
none of. That test imports the fixture, then imports an **overlapping** statement (the shape
phase 6's own dedup tests use) so a row is ignored, and asserts normalization leaves it
`ignored` with its `ignored_reason` intact.

## Decisions to record as ADRs during implementation

Per CLAUDE.md, non-trivial decisions get an ADR. Three are needed, and none is written yet:

- **`reference_type` as the sole deterministic channel evidence** — including why description
  matching was rejected, and what a reference-less source implies.
- **Normalization acts only on `imported` payments** — the idempotency rule, and why re-deriving
  has no entry point in this phase.
- **Deterministic-only scope for phase 7** — deferring `ai.normalizeMerchant()` and the
  `src/ai` boundary to phase 8, amending `data-flow.md` step 2 to say which leg exists when.

## Explicitly out of scope

- `ai.normalizeMerchant()`, any `src/ai` implementation, any `AIInference` row.
- Alias learning or any catalog write outside seeding (phase 16).
- Classifying a payment as transfer, investment, expense, or settlement (phase 8).
- Resolving a counterparty to a `person` rather than a merchant.
- Surfacing possible (non-deterministic) duplicates for review (phase 9).
- Any schema migration.
