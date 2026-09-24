# 0069. Two lines of one statement are two movements, not a possible duplicate

**Status:** Accepted — **amended in part by
[ADR-0070](0070-one-movement-recorded-twice-is-one-day-one-amount-one-name.md)** (which pairs
between two imports are asked about, and tax lines across imports)

**Amends:** [ADR-0031](0031-possible-duplicate-review.md) — which pairs the review queue offers as
possible duplicates. ADR-0019's deterministic path, the file-level content hash, what confirming
and dismissing do, and every pair between two different imports are unchanged.

## Context

The first bank-account statement imported into the owner's ledger (22 September 2026) added
**1,078 possible-duplicate questions** to the review queue in one import. A bank account is
full of ordinary same-amount movements: the tea, the auto and the metro are all ₹20, often on
the same day.

`domain.isPossibleDuplicate` asked about any two live payments with the same direction and
amount inside the window, unless a shared reference had already settled them. It never asked
**where a row came from**. Two consequences, reproduced on a synthetic statement in the bank
layout's shape (every name, reference and amount invented; nothing read from the real ledger):

1. **Every same-amount pair within a day of one statement became a question.** `k` lines at one
   amount on one day make `k(k−1)/2` pairs.
2. **Consecutive days did too.** A statement prints dates, which land at midnight, so two lines
   one day apart are exactly 24 hours apart — and the queue's 24-hour window is inclusive.

On a 295-row synthetic statement with **no duplicates at all**, the rule raised **100
questions**. All 100 paired two lines of that one statement; 59 paired consecutive days; 96
paired two lines printing two _different_ references. Answering any of them "yes" would have
deleted a real movement from every total — the opposite of what invariant #10 exists for.

Invariant #10 guards against the ledger receiving **one movement twice**: an overlapping
statement, a second channel's copy (a UPI app's history beside the bank's line), a
re-downloaded file. Every one of those arrives as an import batch of its own — each file is one
batch (`writeImportedRows`), and each hand-entered movement is one batch
(`recordManualPayment`). Within one batch the document is the only witness, and a document that
prints two lines that differ in date, words or reference is stating two movements.
`domain/anomaly.ts` already draws the same line: the duplicate check is about _records of one
movement_; two movements that may both be real are a `repeated_charge` observation
([ADR-0063](0063-an-anomaly-is-a-comparison-with-its-evidence-attached.md)).

## Decision

**Within one import batch, two rows are a possible duplicate only when nothing the batch
printed tells them apart**: the same `occurred_at`, the same `raw_description` and the same
`external_reference`. (Two equal non-null references are already a deterministic duplicate, so
in practice this means a line printed twice, word for word, with no reference.) That is the
within-file restatement ADR-0019 already treats as real, and with no reference to settle it,
it stays a person's question.

**Across batches nothing changes.** The same resemblance arriving from a second statement, a
second channel or a second hand entry is asked about exactly as before, including when the two
references differ (ADR-0010).

**Unknown is never a difference.** A row that does not say which batch delivered it, or what it
printed, is judged by the old rule. Missing provenance can only add a question, never remove one.

**One rule, applied in both places.** `DuplicateCandidate` gains an optional `importBatchId`;
`PaymentRow` carries `import_batch_id`; the review queue and `confirmPossibleDuplicate` both hand
the rule the whole row, so confirming re-checks the pair with the same fields the queue used.
Confirming two different lines of one statement is now refused (`409`), where before it
discarded one of them. (The confirm path had also been dropping `raw_description`, so it never
applied the tax-component exclusion the queue did. Passing whole rows fixes both.)

## Consequences

Measured on the synthetic reproduction (genuine questions asked / questions about nothing):

| Scenario                                                     | Before | After |
| ------------------------------------------------------------ | ------ | ----- |
| One ordinary statement, 295 lines                            | 0/100  | 0/2   |
| The same statement sent again: `already_imported`, unchanged | 0/100  | 0/2   |
| An overlapping statement restating 32 lines                  | 2/114  | 2/6   |
| A UPI app's copy of 15 of its payments (different refs)      | 15/107 | 15/9  |
| The same statement, narrations printing no number or ref     | 0/100  | 0/8   |
| Plus an unrelated card statement over the same weeks         | 0/160  | 0/59  |

- **Every genuine duplicate is still asked about**, and an exact re-import still writes nothing
  and changes nothing in the queue.
- **What remains is cross-batch.** An unrelated card and bank line of one amount on the same or
  next day is still a question. That is now the largest source of noise. Whether a card account
  can ever capture the same money as a bank account is left open (see the alternatives).
- **A merchant charging twice is no longer a duplicate question.** Two lines with two references
  are two movements by the statement's own account. Confirming them as one would have deleted
  real spend. They stay visible as ADR-0063's `repeated_charge`, which proposes nothing.
- **No schema change, no migration, no stored decision touched.** The queue is derived on every
  read, so the change needs no backfill. A running API shows it only after a restart (`tsx`
  does not reload). Pairs the queue stops offering keep any dismissal already recorded against
  them.

## Alternatives considered

- **Never pair two rows of one batch.** This clears the last 2%, but a file that prints one line
  twice (two concatenated exports, or an issuer's own repeat) would then be silently kept as two.
  Invariant #10 forbids that.
- **Rule out two different references only.** This does nothing for a layout whose lines print
  no reference: on the synthetic statement with bare narrations, 100 questions stayed 100.
- **Tighten the window below 24 hours, or to one calendar day.** This removes only the
  consecutive-day pairs (about 60%), leaves every same-day pair, and would miss a genuine second
  capture that one source dates a day after the statement does.
- **Never pair two different accounts.** This would clear most of what remains, but ADR-0010
  took the account out of the match on purpose: a bank statement and a UPI app capture the same
  money under two accounts. Whether a card account can do the same (a debit card recorded as a
  card account) is the owner's call, not an inference.
- **Trust the balance proof.** ADR-0066's bank layout proves every line moved money, so its
  lines cannot repeat. But the proof is not recorded against a batch, and recording it needs a
  migration. It also covers one layout, where a printed line's own differences cover them all.
- **Cluster lookalikes into one question.** ADR-0031 already declined this. It would shrink the
  count without making any question more correct.
