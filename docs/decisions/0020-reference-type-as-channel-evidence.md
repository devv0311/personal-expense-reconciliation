# 0020. `reference_type` is the sole deterministic evidence for refining a payment's channel

**Status:** Accepted

## Context

Phase 6's importer sets `channel = bank_transfer` on every row of a bank-statement CSV. That is
correct as far as it goes: it records _the transport that captured the payment_, which is what a
bank's own statement export is, and it matches the shape `fixtures/duplicate-transaction.json`
records for its bank-CSV row against the same transaction captured `upi` by a UPI export.

It is also incomplete. Four of the eight rows in `fixtures/bank-statement.csv` are plainly UPI
payments that a bank statement happened to carry, and leaving them all at `bank_transfer` loses
information the source actually provided. Refining that is normalization's job (`lifecycle.md`,
`NORMALIZED`; `data-flow.md` step 2), and phase 7 is where it lands.

Two signals in an imported row could support the refinement, and they are not equivalent:

| Signal                             | Where it comes from                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `reference_type` (`upi_utr`, …)    | Extracted at import by the adapter, from the statement's reference column, via `parse.ts`'s `REFERENCE_PREFIXES` |
| `raw_description` prefix (`UPI-…`) | Would require `src/services` to parse bank description strings                                                   |

For `fixtures/bank-statement.csv` the two agree on every row, which is exactly why the choice
had to be made deliberately rather than discovered later on a file where they disagree.

The roadmap's phase 7 entry says normalization should refine `channel` "when a description
clearly indicates UPI". This ADR departs from that wording, which is the reason it exists.

## Decision

**`reference_type` is the only evidence consulted.** `domain.refineChannel` maps it to a
channel, falling back to the channel already recorded:

| `reference_type`                                                        | resulting `channel` |
| ----------------------------------------------------------------------- | ------------------- |
| `upi_utr`, `upi_rrn`                                                    | `upi`               |
| `card_reference`                                                        | `card`              |
| `bank_reference`, `merchant_order_id`, `cheque_number`, `other`, `null` | unchanged           |

`raw_description` is never read for this purpose.

Two reasons, in order of weight:

1. **Format knowledge belongs in the adapter.** `integrations/bank-csv/parse.ts` already owns
   the mapping from this bank's reference strings to `reference_type`, and its own file comment
   says so: format knowledge lives in an adapter "so a second source can be added later without
   touching the domain or any other adapter". Matching descriptions in `src/services` would put
   a second copy of that knowledge in a second layer, where every new bank's description quirk
   becomes a service-layer change — and where the two copies can disagree.
2. **Reading meaning out of a description is a heuristic.** `ai-boundary.md` assigns
   "merchant interpretation" and semantic reading of a transaction to inference, and reserves
   deterministic application code for what can be derived exactly. `UPI-` happens to be a
   reliable prefix in one synthetic fixture; treating a substring of free text as proof is the
   kind of guess this layer must not make, however well it works today.

`cheque_number` deliberately maps to nothing. `PAYMENT_CHANNELS` is
`['upi', 'bank_transfer', 'card', 'cash', 'other']` and has no `cheque` member; mapping a cheque
to `other` would be strictly less accurate than the transport the adapter recorded, and adding a
channel value is a schema change phase 7 has no need for.

## Consequences

**A source that carries no reference yields no refinement, by design.** `refineChannel(null, …)`
returns the channel unchanged. This is the correct answer rather than a gap: with no reference
there is no deterministic evidence of the channel, and the alternative — inferring one from a
description — is the guess this ADR rejects. A bank whose export omits references simply keeps
the transport-level channel its adapter recorded, and nothing downstream is misled, because
`channel` continues to mean exactly "the most precise transport this row's evidence supports".

**The roadmap's phase 7 wording is superseded on this point.** "When a description clearly
indicates UPI" described the intent, not the mechanism; the mechanism is the reference type.

**A future source may need its own mapping, not a change to this one.** If a UPI export
populates `reference_type = upi_rrn` where a bank populates `upi_utr`, both already map to
`upi` here. What must not happen is a service-layer special case per source: a source whose
references need different interpretation needs that interpretation in _its adapter_, producing
a correct `reference_type`, which this table then maps uniformly.

**`channel` remains a DERIVED column.** It is written by normalization, never by the import
path after the fact, and it is not a SOURCE value — `invariants.md` #4's write-once guarantee
covers `amount`, `occurred_at`, `raw_description`, and `account_id`, not this.

## Alternatives considered

- **Match `UPI-` at the start of `raw_description`.** The roadmap's literal wording, and it
  works on today's fixture. Rejected for the two reasons above. It also fails open in the worst
  direction: a merchant legitimately named something beginning `UPI-` would be silently
  reclassified, and nothing would flag it.
- **Require both signals to agree, refining only on agreement.** Attractive as a self-checking
  rule, and rejected as speculative: it invents a disagreement-handling path with no consumer,
  since nothing in phase 7 reads such a flag. It also still requires description parsing in the
  service layer, so it carries the cost of the rejected option without dropping it.
- **Have the adapter set the refined `channel` directly at import.** Tempting, since the adapter
  already knows the reference type. Rejected because it collapses the pipeline's first two
  steps: `PAYMENT → PURPOSE → EVIDENCE` requires import to record what the source said, and
  `channel = bank_transfer` _is_ what a bank statement said. Refinement is an interpretation of
  that evidence, and interpretations belong to the step that owns them (`data-flow.md` step 2),
  not folded back into ingestion.
- **Add a `cheque` member to `PAYMENT_CHANNELS`.** Would make `cheque_number` mappable. Rejected
  as out of scope: no fixture, adapter, or requirement needs it today, and a schema change to
  serve a hypothetical is the speculative abstraction CLAUDE.md rules out.
