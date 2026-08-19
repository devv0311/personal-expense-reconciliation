# 0022. Phase 7 ships normalization's deterministic leg only; the AI leg waits for phase 8

**Status:** Accepted

## Context

`data-flow.md` step 2 describes normalization as **two legs**:

```
services.normalizePayments ─▶ db (deterministic match + reference extraction) ──┐
                            └─▶ ai.normalizeMerchant ─▶ AIInference (pending) ─▶ db (stored, unapplied)
```

The first resolves `channel` and `counterparty` where the row's own evidence settles it. The
second is the fallback: where counterparty resolution is _not_ deterministic, call
`ai.normalizeMerchant()`, which returns an `AIInference` (`inference_type = normalize_merchant`) —
a proposal, stored unapplied, never a write.

Phase 7 built the first leg (ADR-0020 for `channel`, exact alias matching for the merchant) and
did not build the second. This ADR records that as a decision rather than leaving the gap to be
found later and read as an omission.

The relevant state of the tree when phase 7 started, and still today:

- `src/ai/` contains **one file, `README.md`**. There is no service, no client, no interface.
- `ai_inferences` exists as a table in `src/db/schema.ts` and has **no writer anywhere** — not a
  repository function, not a service. Nothing in `src/` can create a row in it.

So "add the AI leg" is not an increment on existing machinery. It is the first construction of
that machinery.

## Decision

**Phase 7 ships the deterministic leg only.** `normalizePayments` resolves what the row's
evidence settles and stops. There is no `ai.normalizeMerchant()` call, no `AIInference` row, and
no code path from normalization into `src/ai`.

The reason is that building the AI leg here means designing the whole AI service boundary, not a
single function. `ai-boundary.md` specifies what that boundary is: a typed service interface, the
structured-proposal contract every method returns, a `confidence` level of
`high | medium | low | unknown`, and the validation gate that stands between a proposal and
authoritative state — plus `decideInference()` as the sole path by which an `AIInference` leaves
`pending`. Phase 8 (classification) needs all of it in full, because `ai.classifyTransaction` is
the method that boundary exists to constrain.

Designing it inside phase 7 to serve one fallback would mean designing it **twice**: once shaped
around merchant normalization's needs, then again in phase 8 when classification exercises the
parts merchant normalization never touched. The second design would supersede the first, and the
first would have shipped as real code with real tests in the meantime. Building it once, in the
phase whose central concern it is, is the cheaper and more honest order.

This also matches how the phase order is justified generally (CLAUDE.md: _"Do not jump ahead of
the current phase… building later-phase features before earlier ones are solid re-creates the
exact 'messy, unreconciled' problem this system exists to solve, just in code form"_). The AI
boundary is a phase 8 concern that phase 7 happens to be able to see from where it stands.

## Consequences

**An unresolved counterparty ends at `state = normalized`, `counterparty_type = unknown`, with no
`AIInference` row.** That is the complete outcome, and it is a recorded one. The payment is
normalized — the bar is _resolution attempted_, not _resolved_ — and its audit event carries
`counterparty_type: 'unknown'` and `counterparty_id: null` explicitly, so a reader can tell that
resolution ran and found nothing, rather than that it never ran.

**`ai_inferences` stays empty until phase 8.** Any query, report, or review-queue view built
before then must treat an empty `ai_inferences` as the expected state, not as a symptom. The
table is not dead — it is unbuilt-against, and phase 8 is what fills it.

**The three unresolved rows in `fixtures/bank-statement.csv` stay unresolved.** The two
self-transfer legs and the person-to-person UPI row are exactly the cases the AI leg would have
been asked about — and two of the three are not merchant questions at all, which is itself
informative: recognising a self-transfer or a person is classification (phase 8), not merchant
normalization. The fallback would not have resolved them either.

**`data-flow.md` step 2 keeps its two-leg description.** It documents the target state, and the
target state is unchanged. The step carries a note marking which leg exists as of phase 7 and
pointing here; deleting the AI leg from the diagram would misrepresent the design as
deterministic-only, which it is not.

**Nothing in phase 7 needs revisiting when the AI leg lands.** It is a fallback on the miss path:
`findMerchantByAliasKey` returning `null` is exactly where `ai.normalizeMerchant()` will be
called. The deterministic path, the alias-key rule, and the eligibility filter (ADR-0021) are all
unaffected by its arrival.

## Alternatives considered

- **Build a minimal `ai.normalizeMerchant()` now — one method, one inference type.** Rejected as
  the twice-designed path above. "Minimal" is the problem, not the mitigation: a one-method
  boundary would fix the proposal shape, the confidence encoding, and the validation gate for
  every later method, based on the needs of the single simplest case. Phase 8 would inherit those
  choices or break them.
- **Stub `ai.normalizeMerchant()` to return `unknown` with `confidence: 'unknown'`.** Would make
  the code path exist and the diagram true. Rejected because it writes `AIInference` rows that no
  model produced, filling the table with proposals that assert nothing — and `ai-boundary.md`'s
  whole point is that an inference is _evidence of what a model proposed_. Fabricating that
  record to satisfy a diagram inverts the rule.
- **Leave the omission undocumented, since the roadmap already puts AI in phase 8.** Rejected
  because `data-flow.md` step 2 explicitly describes the AI leg as part of normalization, so a
  reader comparing the doc to the code finds a discrepancy with nothing explaining it. That is
  precisely the "rediscovered as a bug later" failure the ADR process exists to prevent.
- **Defer merchant resolution entirely to phase 8, shipping only `channel` refinement.** The
  symmetric alternative: if the AI leg waits, arguably the whole counterparty question should.
  Rejected because the deterministic leg needs none of the AI machinery and delivers real value
  on its own — five of the bank fixture's eight rows resolve exactly, with no proposal, no
  confidence, and no review. Withholding a deterministic answer because a probabilistic fallback
  is not ready would invert `ai-boundary.md`'s priority, which reserves AI for what deterministic
  code _cannot_ settle.
