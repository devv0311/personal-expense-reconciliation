# 0070. One movement recorded twice is one day, one amount and one name

**Status:** Accepted (22 September 2026) — the owner confirmed the policy after reviewing the
synthetic results, and asked for the name rule to cover sufficiently similar names. Live on the
real ledger since 22 September 2026, 22:51 IST; see [Rollout](#rollout).

**Amends:** [ADR-0069](0069-two-lines-of-one-statement-are-two-movements.md) — which pairs from
two _different_ imports the queue offers — and [ADR-0031](0031-possible-duplicate-review.md) —
its 24-hour pairing window, and the option that let a caller widen it. ADR-0019's deterministic
path, the file-level content hash, ADR-0069's rule for two lines of one import, and what
confirming and dismissing do are unchanged.

## Context

ADR-0069 took two lines of one statement out of the possible-duplicate queue and left every pair
between two imports as it was: same direction and amount within 24 hours. On the owner's ledger
that left card-and-bank lookalikes as the largest source of questions — a card line and a bank
line of one amount on the same or the next day, which is most days for everyday amounts. ADR-0069
left open whether a card account can ever capture the same money as a bank account.

The owner settled it on 22 September 2026, as policy: **two movements with the same calendar
day, the same amount and the same or sufficiently similar name or type are one transaction for
duplicate purposes, including when they came from different accounts.** The similarity must be
explainable, must not merge unrelated merchants, and must keep same-day repeat purchases apart
when their names, types or references show they are distinct. Exact re-imports stay no-ops, and
no existing payment is ever deleted or merged by the rule.

## Decision

`domain.isPossibleDuplicate(a, b)` asks, in this order. Each step is a yes/no a person can check
against the two lines; there is no score and no spelling distance.

1. **Same direction, same amount** — unchanged.
2. **Same calendar day** — the UTC date of `occurred_at`, which for a statement line is the date
   it printed, and for a hand entry the date typed. This replaces the 24-hour window, which
   paired every line with the day after it.
3. **A pair one reference proves is still asked about while both are counted.** The importer
   settles such a pair the moment the second copy arrives (ADR-0019), so no pair it wrote reaches
   this rule with both live. One that does was written by a path that settles nothing — a payment
   typed by hand with the number of one already imported — and must be asked, not assumed
   handled. (The rule as first proposed skipped these pairs as "already certain", which left that
   hand entry counted twice with nobody asked.)
4. **A tax component is compared only with a tax component**, and never with another line of its
   own import — one statement prints a `CGST` and an `SGST` for every charge it taxes, equal to
   the paisa. Across imports its name is the tax it is: `CGST` beside `CGST` is asked about,
   `CGST` beside `SGST` never is.
5. **Two lines of one import** are asked about only when word-for-word identical (ADR-0069) —
   unchanged.
6. **The same transaction number in two packagings is one movement**, whatever the names say —
   `UPI-000000000105` on a statement and `000000000105` in an app (`domain.referencesMatch`). A
   bank may print a payee's legal name where the app prints the brand; the number is the
   stronger witness, and a shared one is never silently kept as two.
7. **Two different numbers of one kind are two movements.** Both lines carry a reference, both
   are the same known kind (`upi_utr`, `card_reference`, `bank_reference`, …) and they are not
   the same identifier: a UTR names exactly one UPI payment, so a card-rail UPI purchase and a
   bank UPI purchase at one shop on one day are two purchases. A reference that is missing, of
   unknown kind, or `other` says nothing either way.
8. **The two lines describe one movement: the same kind of line, naming the same or a
   sufficiently similar payee.**
   - _The same kind_: the purpose reader's reading (`readStatementRow`) — a purchase, an
     instalment's principal or interest, a fee, a bill payment, a refund, money in, a tax — must
     agree. A line it cannot place is unknown, never different.
   - _The name words_ of a line are its description as the purpose reader names a merchant
     (reference numbers, markers, card scaffolding and legal suffixes already removed), less the
     words a second channel wraps round a name (`UPICC`, `IMPS`, `NEFT`, `RTGS`, `ACH`, `NACH`,
     `ECS`, `BBPS`, `MMT`, `paid`, `from`, `sent`, `transfer`, `via`, `debit`, `credit`), words
     of one or two letters and masked digits. A tax line's name is its tax word (`cgst`).
   - _The same or a sufficiently similar payee_ is any of:
     - **every name word of one line appears in the other**;
     - **the same letters once spaces are ignored**;
     - **the payee a narration names appears in the other line.** A bank prints a UPI or transfer
       line as `/`-separated parts — `UPI / payee / number / note`,
       `NEFT / branch code / payee / note` — and a card prints its UPI rail the same way
       (`UPICC / number / payee`). The payee is the first part left with a name word once tokens
       carrying a digit or an `@` (numbers, branch codes, UPI handles) and rail words are set
       aside. Reading the whole line as one name let the payer's note stand between two captures
       of one payment: the bank's `… /Payment from Phone` and the card's `… BANGALORE` each had a
       word the other lacked;
     - and in each of those, **a word the issuer cut short counts as the word it begins**, when at
       least four letters survive (`SUPERMARKE`, `SUPERMARKET`). Issuers truncate a descriptor to
       a fixed width — `purpose.ts` already strips the half-written legal suffixes this leaves.
   - A line that names nobody (`EMI INTEREST 3/6`, `UPI/412345678901`) is judged by its kind
     alone, and a line whose words are unknown is never a difference: missing information can
     only add a question.

| Line on one side                      | Line on the other                   | Asked? | Why                                  |
| ------------------------------------- | ----------------------------------- | ------ | ------------------------------------ |
| `POS SYNTH SHOE STORE`                | `SYNTH SHOE STORE BANGALORE`        | yes    | every word of one is in the other    |
| `UPI/SYNTH CAFE/…/Payment from Phone` | `SYNTH CAFE BANGALORE`              | yes    | the narration's payee is in the card |
| `UPI/SAMPLEEATS/…/Payment from Phone` | `SAMPLEEATS BANGALORE`              | yes    | a one-word payee is still a name     |
| `UPI/SYNTH SUPERMARKET/…`             | `SYNTH SUPERMARKE MUMBAI`           | yes    | a word cut short is the word         |
| `UPICC/…/SYNTH PHARMACY`              | `UPI/SYNTH PHARMACY/…`, no refs     | yes    | the rail word is not a name          |
| `Paid to SYNTH GROCER`                | `UPI/SYNTH GROCER/…`                | yes    | "paid" introduces the name           |
| `BIG BASKET`                          | `BIGBASKET`                         | yes    | the same letters                     |
| `EMI INTEREST 3/6`                    | `EMI INTEREST 3/6`, another import  | yes    | nameless, the same kind of line      |
| `CGST`                                | `CGST`, another import              | yes    | the same tax, printed again          |
| a hand entry with `UPI-000000000501`  | the statement line with that number | yes    | one number, and nothing settled it   |
| `UPI/SYNTH TEA STALL/…`               | `SYNTH AUTO STAND PUNE`             | no     | one shared word is not a name        |
| `UPI/SYNTH CAFE/…/Payment from Phone` | `SYNTH PHONE STORE MUMBAI`          | no     | the note's word is not a name        |
| `SRI SAI TRADERS`                     | `SRI BALAJI TRADERS`                | no     | neither name is inside the other     |
| `SRI SAI TRADERS`                     | `SRI SAIRAM TRADERS`                | no     | three letters are never a cut word   |
| `SYNTH MART`                          | `SYNTH SUPERMART PUNE`              | no     | a cut keeps a word's start, not end  |
| `SYNTH CAFE`                          | `SYNTH CAKE`                        | no     | one letter is a different name       |
| `CGST`                                | `SGST`, either import               | no     | two halves of one tax                |
| `CGST`                                | `CGST`, the same statement          | no     | two charges' taxes                   |
| `… HUB - PRINCIPAL 2/6`               | `… HUB - INTEREST 2/6`              | no     | two kinds of line                    |
| `UPI/SYNTH PHARMACY/…` (UTR …103)     | `UPICC/…/SYNTH PHARMACY` (UTR …201) | no     | two UPI numbers, two payments        |
| same shop, 23:59:45                   | same shop, 00:00:15 the next day    | no     | two calendar days                    |
| `SYNTH CAFE BANGALORE`                | `SYNTH CAFE LUNCH`, typed by hand   | no     | each has a word the other lacks      |

**Nothing is merged.** A match is a question, as before. `confirmPossibleDuplicate` re-checks the
pair with the same whole rows and the same rule, and refuses (`409`) what the queue would not
have asked. Confirming marks the chosen copy `ignored` with `duplicate_of:` the canonical payment
and keeps the row; dismissing records the decision and changes neither payment.

**The window is no longer an option.** `duplicateWindowSeconds` on `GET /api/review` and
`windowSeconds` on `POST /api/review/payments/:paymentId/duplicate` are withdrawn, with the
`ReviewQueueOptions` and `PossibleDuplicateDecisionInput` fields behind them. Which lookalikes
are one movement is the owner's policy, and it lives whole in the domain rule rather than in a
parameter a caller could widen past it. Nothing in `web/` sent either.

**The question says so.** Needs attention's reason for a possible duplicate reads "for the same
amount on the same day, and nothing on them tells them apart: they name the same or a similar
payee, or are the same kind of payment", replacing "close together in time".

## Consequences

Measured on synthetic statements only (`tests/support/synthetic-duplicate-scenario.ts`), imported
through `POST /api/imports/statement` into an in-memory database. "First proposed" is this rule
before the owner's review — every word of one name inside the other, tax lines never compared,
and pairs one reference proves never asked.

| Synthetic set                                                    | 24-hour rule | First proposed | Accepted  |
| ---------------------------------------------------------------- | ------------ | -------------- | --------- |
| Genuine second captures (UPI app ×2, overlapping bank, card)     | 4/4 asked    | 4/4            | 4/4       |
| The policy's own case: card + bank, one shop, day and amount     | 1/1          | 1/1            | 1/1       |
| Lookalikes that are two movements (7 kinds)                      | 7/7          | 0/7            | 0/7       |
| Never a question (one-statement repeat, ₹1 apart, 2 days apart)  | 0/3          | 0/3            | 0/3       |
| One payee beside a bank note, a card city or a cut (3 cases)     | 3/3          | 0/3            | 3/3       |
| A note's word shared with another shop                           | 1/1          | 0/1            | 0/1       |
| A card statement downloaded again: fee, purchase, each tax       | 2/4          | 2/4            | 4/4       |
| …and the two halves of one tax, on either statement              | 0            | 0              | 0         |
| A bank table and a card workbook beside the bank's PDF (2 cases) | 2/2          | 2/2            | 2/2       |
| A line only a chosen generic layout reads, printed again         | 1/1          | 1/1            | 1/1       |
| A hand entry carrying an imported payment's exact number         | 0/1          | 0/1            | 1/1       |
| The same statement, table or workbook sent again                 | no change    | no change      | no change |
| Ten ordinary months, 1,860 bank + 620 card lines, nothing twice  | 176 asked    | 0              | 0         |

The table beside the PDF also shows the division of labour: its row carrying the PDF's own UPI
number is settled at import (ADR-0019) and never becomes a question; its row with no number is
asked. The confirm path accepts each asked pair over HTTP and refuses every lookalike, the other
half of a tax, and a note's shared word with `409`, changing nothing. Every guard in the rule and
in the confirm and queue paths has a mutation test: removing or loosening it fails the suite.

- **No schema change, no migration, no stored decision touched.** The queue is derived on read,
  so on the real ledger this changes what is asked the moment an API running this code starts,
  and nothing before. Dismissals already recorded stay recorded.
- **A second capture that one source dates a day later is no longer asked about.** ADR-0069
  declined the calendar day for exactly this reason; the owner chose it. A matching transaction
  number does not rescue it, because the day is checked first.
- **Two descriptors that each carry a word the other lacks, with no narration to read a payee
  from, do not match** — a card's `SYNTH CAFE BANGALORE` beside a hand-typed `SYNTH CAFE LUNCH`.
  Nothing written tells a city from a note there, and reading the first word or two as the name
  would join unrelated shops (`SRI SAI …`, `NEW INDIA …`). The owner's instruction was to prefer
  that to merging unrelated merchants.
- **A one-word name matches any longer name containing it**, and a payee part matches any line
  containing it. A line that names only `CAFE` would be asked about beside `BLUE TOKAI CAFE`.
  Such lines are rare, and the result is a question, not a merge.
- **A word of four letters or more matches a longer word it begins.** `SYNTH CAFE` beside
  `SYNTH CAFETERIA` is asked about. It never matches a word it merely sits inside.
- **A re-downloaded card statement now asks about its tax lines** — one question per tax per
  charge — where it used to leave them counted twice silently. On one statement they are still
  never asked.
- **The calendar day is the UTC date.** Every statement format stores its printed date at UTC
  midnight and the manual entry form sends a date, the convention `statement-balance.ts`, the
  importer and every date on screen (`web/src/lib/dates.ts`) already use. A future source that
  records a time of day should be dated in the ledger's own time zone before this rule sees it.
- **The question now depends on words.** Every caller passes the whole row, as ADR-0069 already
  required, so the rule reads the description, the reference and its kind with no copy of the
  mapping in a service.

## Rollout

Tested on synthetic data only before it touched the real ledger. **Live on the real ledger since
22 September 2026, 22:51 IST**, through `local-data/start-real.sh` against a ledger that was
already cleanly stopped, with a never-opened cold copy taken first
(`local-data/pglite-dev.pre-adr0070-restart-20260922-225106`). No migration was pending (22 of 22
applied). A system restart stopped the stack cleanly that night — the launcher's own handler ran
and PGlite removed `postmaster.pid` — and it was started again on 25 September at 01:52 IST.

Measured in aggregate only — counts and digests, never a row:

- **The rollout changed no stored data.** A scratch copy of the cold copy and a scratch copy of the
  ledger after the first run (start, GET-only reads and browser QA, shutdown) agree on all 42
  tables by row count and content digest: 10,018 rows, 2 accounts, 7 imports, 2,739 payments,
  6,630 audit events. The second start read the same account, import, payment and overview
  digests, and they were unchanged after its QA.
- **The queue went from 22 possible duplicates to 16.** All 16 are lines one statement prints
  word for word (ADR-0069, unchanged). The 6 card-and-bank pairs the 24-hour rule asked about are
  no longer asked: 2 were on consecutive days, and of the 4 on one day, 2 carry two different UPI
  numbers and 2 name payees that are not one name (one shares a single word). Nothing new is
  asked: no tax pair, no shared-number pair, no hand entry. The 313 category questions are
  unchanged.
- **The domain rule over every live payment reproduces the queue exactly** (16 pairs), and the
  question on Needs attention carries the reason above.

## Alternatives considered

- **A word-overlap score with a threshold.** Rejected: a number nobody can check against the two
  lines, which ADR-0031 already declined for ordering. Whether `SRI SAI TRADERS` and
  `SRI BALAJI TRADERS` are one shop would turn on where the threshold happened to sit.
- **Spelling distance.** Rejected: it merges `CAFE` with `CAKE`, the broad fuzzy matching the
  owner ruled out. The cut-short rule is not a distance: it only ever lets a word stand for a
  longer word it begins.
- **Matching on the first word or two, or any shared word.** Rejected: common first words
  (`SRI`, `SHREE`, `NEW`) and placeholders like `SYNTH` join unrelated shops, and two shops that
  share a two-word beginning (`SHREE GANESH MEDICAL`, `SHREE GANESH SWEETS`) are plainly two.
  Reading the payee part of a narration catches the card-city-versus-bank-note case this was
  meant for without that cost.
- **A list of cities and UPI notes to strip.** Rejected for now: open-ended vocabulary to keep
  current, and the payee part already separates a note from a name where a narration has parts.
- **A merchant directory mapping legal names to brands.** Rejected: `purpose.ts` forbids one, and
  a shared transaction number already covers the case that matters.
- **Merging a match automatically.** Rejected: invariant #10 forbids silent merging, and a same
  shop, same day, same amount pair is often two purchases.
- **Keeping the 24-hour window beside the name rule.** Rejected: the owner's rule is the calendar
  day, and the window's consecutive-day pairs were most of the noise.
- **Never pairing two different accounts.** Rejected by the owner: the policy applies whichever
  accounts the lines came from, as ADR-0010 already required of the deterministic path.
- **Settling a hand entry's shared number at entry, as the importer does.** Rejected: discarding
  what a person has just typed, without telling them, is the silent merge this ADR refuses. The
  queue asks instead.
