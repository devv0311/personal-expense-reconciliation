# 0061. An import reads what it just wrote

**Status:** Accepted

## Context

[ADR-0060](0060-a-statement-line-says-what-it-was-for-and-what-it-is-not.md) made it possible to
say what a statement line was likely for without a model. It did not make it _happen_. Reading
the records was still a button — **Analyze records** — that a person had to know to press, on a
screen they had to know to visit, before anything they had imported counted towards anything.

Until they pressed it, the product was in a state it could not explain: statements imported in
full, Overview reporting nothing spent, **Needs attention** carrying no question about what
anything was for, and Spending listing every payment as money with no story. Every one of those
screens was telling the truth about the ledger and a lie about the person's finances, and the
only cure was a control named after the machinery behind it.

Two smaller failures sat underneath:

- **`recordsAwaitingAnalysis` counted the wrong thing.** It counted rows awaiting
  _normalization_. A ledger normalized by an earlier version — 120 payments, none ever asked
  what it was for — reported zero waiting. The front page offered nothing to do, over records
  nothing had ever looked at. "Read" meant "moved one state along".
- **The purpose stage reported `skipped` whenever no provider was configured**, and went on
  saying so after the local reader began proposing. A run that read a hundred lines and
  suggested what forty of them were for reported that nothing could be worked out.

## Decision

### The import reads its own rows, in the request that writes them

`POST /api/imports/statement` calls `services.prepareRecords` scoped to the batch it just
committed, and returns what came of it as `prepared`. There is no separate action, and no
screen a person has to find.

**It approves nothing.** Every stage calls a service that already refuses to write an
authoritative category, match, duplicate, split or debt without a person. The most an unattended
run can do is fill the question list.

**A failure in the reading never fails the import.** The rows are committed by the time it runs;
reporting the import as failed because the reading afterwards did not finish would be a lie
about the one thing that is now permanently true. It comes back `ran: false` with a sentence,
and the records wait for the next run — which is idempotent, so nothing is lost or doubled.

### One run at a time, and never two sets of questions

`services.prepareRecords` wraps `analyzeRecords` in a single-flight: a caller arriving while a
run is in flight joins that run. Every stage was already idempotent in sequence
(`normalizePayments` acts on `imported` only, `classifyPayment` refuses a payment that already
carries a proposal, `matchEvidenceContext` returns `unchanged`), which covers a retry but not an
overlap — and overlaps are now the ordinary case, because nobody presses anything: an import
triggers a run, the next screen may ask for one, a refresh asks again, a second tab is open
throughout.

Deliberately a promise in the module, not a job table: nothing in this process claims a job, and
a queue nobody drains reports queued work that never happens. One process, one database, one
in-flight run; after a restart, per-row idempotency is what holds.

### "Waiting" means a reading would still say something

`recordsAwaitingAnalysis` is now rows awaiting normalization, plus normalized rows with no
proposal **that `domain.inferPurpose` would actually propose something for**.

Both halves are needed and the second one is what keeps the number from sticking. A line whose
wording says nothing, and a tax line the reader refuses to propose, never receive an inference —
so counting them as waiting would leave the front page prompting for ever and re-reading the
whole ledger on every visit to do nothing each time. The check is the same pure function the run
uses, so this number cannot promise a proposal the run would not make.

### The result is an outcome, not a report

`PreparedResult` opens with _I found a few things to confirm_ and offers **Review suggestions**.
No stage names, no counts of records checked, no word for analysis, classification or a
pipeline. The one number that leads is how many questions are waiting, because it is the only
one a person can act on. A run with a stage that could not finish says so in a sentence rather
than rounding up to "done".

`/payments` keeps **Run normalization** and **Run classification** for audit and debugging. They
were never the problem; being the only way was.

## Consequences

- A person can import a statement and see what is on it without learning a single word of this
  system's vocabulary.
- The existing ledger was brought up to date through this same path, with the owner's explicit
  authorization: 32 pending proposals and 0 approvals, verified before and after.
- The tax, interest, repayment, fee, refund and transfer rules of ADR-0060 hold unchanged while
  running unattended — which is exactly when they matter most, and is asserted directly.
- One in-flight run is per process. A future worker loop, if one is ever built, replaces this
  guard rather than sitting beside it.
