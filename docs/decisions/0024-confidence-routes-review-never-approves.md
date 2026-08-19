# 0024. Confidence routes a proposal to review; nothing in phase 8 auto-approves

**Status:** Accepted

## Context

`ai-boundary.md`'s confidence table says a `high`-confidence inference is "eligible for
auto-progression through review if amount/ambiguity thresholds also pass — but still requires an
`accepted` transition, **typically via a matched `Rule` the user previously approved**".
`lifecycle.md` says `REVIEW_REQUIRED` is entered "when confidence is below threshold, the amount
is above a materiality threshold, or beneficiaries are ambiguous", and invariant #16 says
confidence changes _how much friction_ the UI puts in front of the approval transition, "never
whether it's required".

Phase 8 has to turn that into code, and it has to do so without the one mechanism the invariant
names: `Rule` is roadmap phase 16. Nothing exists that could carry a previously-approved
authorization forward to a new payment. The thresholds themselves also had no numbers.

## Decision

**Routing is a pure function, and it decides `CLASSIFIED` vs `REVIEW_REQUIRED` — never
`APPROVED`.**

`domain.routeClassificationForReview` returns every reason that applies, in a stable order:

| Reason            | Rule                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `low_confidence`  | `confidence !== 'high'`. `medium`, `low` and `unknown` all route to review; `unknown` is the model declining to guess, which `ai-boundary.md` says to treat as `low`.           |
| `material_amount` | `amount >= 500000` paise (₹5,000), whatever the confidence. Overridable per call.                                                                                               |
| `settlement_kind` | `proposedKind === 'settlement'`, always. Accepting one creates an APPROVED `Settlement` directly, with no DERIVED state in between for anyone to look at afterwards (ADR-0026). |

**No code path in this phase moves an `Expense` to `approved` without a `decideInference` call**,
and `decideInference` requires an actor that is a person or a `Rule` (`domain.parseDecisionActor`
rejects `ai`, `system`, and an anonymous `rule:`). A `high`-confidence, immaterial expense
proposal therefore ends at `CLASSIFIED` — one state further along than a reviewed one, and still
waiting for a human.

The materiality threshold is a **policy default, not a domain truth**. ₹5,000 is roughly the
point at which a wrong classification in this ledger's fixtures stops being a rounding error and
starts being a real correction, and it is exposed as `DEFAULT_MATERIALITY_THRESHOLD_PAISE` so a
caller can move it without touching the rule.

## Consequences

**The difference between `CLASSIFIED` and `REVIEW_REQUIRED` is, in phase 8, purely a recorded
routing outcome.** Both still require the same decision. That is not a defect — it is invariant
#16 being true structurally rather than by promise, and it is what phase 9's queue will read to
decide what to show first and how loudly.

**Nothing implements "auto-progression" yet, deliberately.** Writing one now would mean either
inventing a `Rule` match phase 16 owns, or letting confidence alone approve — the exact shortcut
invariant #16 exists to forbid. When `Rule` lands, it plugs in at `decideInference` with
`decided_by = rule:<id>` (invariant #17), and this routing function does not change.

**Reasons are reported as a list, not a first-match.** A proposal that is low-confidence _and_
material _and_ a settlement returns all three, so the queue can explain itself completely rather
than showing whichever check happened to run first.

**The threshold is inclusive** (`>=`). A ₹5,000.00 expense is reviewed; ₹4,999.99 is not. Stated
because "above a threshold" in prose does not settle the boundary, and a boundary that is only
settled in the tests is settled in the wrong place.

## Alternatives considered

- **Let `high` confidence below the threshold auto-approve, on the grounds that the phase would
  otherwise never exercise the `classified` state.** Rejected: it is precisely the substitution
  of confidence for approval that invariant #16 forbids, and "otherwise the state is unused" is
  not a financial argument. The state is used — it is simply not terminal.
- **Route on confidence alone, deferring the amount threshold until real data exists.**
  Rejected: `lifecycle.md` names the materiality threshold as a first-class trigger, and leaving
  it out would mean a `high`-confidence ₹50,000 proposal was treated exactly like a ₹120 one.
  A default that can be moved is more honest than a rule that does not exist.
- **Store the routing decision on the `AIInference` row.** Rejected: it is derivable from data
  already stored (`confidence`, the payment's amount, `proposedKind`), and storing a derived
  value invites it to drift from the rule that produced it. Phase 9 recomputes it, cheaply, from
  the same pure function.
- **Treat `unknown` as its own route (a third state) rather than as `low`.** Rejected because
  `ai-boundary.md` explicitly says "`unknown` — treated as `low`", and the distinction it wants
  preserved (the model declined vs. the model guessed badly) is already visible in the stored
  `confidence` column for anyone who wants to display it differently.
