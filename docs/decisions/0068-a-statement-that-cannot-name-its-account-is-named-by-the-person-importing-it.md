# 0068. A statement that cannot name its account is named by the person importing it

**Status:** Accepted

**Amends:** [ADR-0067](0067-a-card-statement-names-its-account-whichever-layout-reads-it.md) —
its last consequence, _"Still not checked: a tabular export"_. Every other part of ADR-0066 and
ADR-0067 is unchanged.

## Context

ADR-0066 and ADR-0067 made the kind of account a statement belongs to a checked fact: a PDF that
names itself — a savings account's transactions, a credit card's statement — goes onto an
account of that kind and no other, by the website or by any API call. They left one door open
on purpose. A CSV or XLSX export names nothing: a card's export and a bank account's can carry
the same headings, auto-detection picks a _layout_ by its columns, and reading a kind off those
columns would refuse a bank account's own export the day its headings resembled a card's. So a
table claimed no kind, and **the account a person picked for it was never checked at all.**

The audit behind this decision found what that meant in practice:

- **Any table landed on any account.** The owner's ledger has one account, a card. A bank
  account's CSV chosen for import would have been offered that card, and its movements — which
  are immutable — written onto the card's cash waterfall with nothing downstream able to notice.
  Two integration suites did exactly this with synthetic data: a card-shaped CSV imported into a
  savings account, unchallenged.
- **The reading said what the columns could not.** The dialog headlines a file with its layout's
  label, and those labels named kinds — _"Credit/debit card statement (CSV)"_, _"HDFC Bank —
  account statement"_, _"Generic bank CSV"_. A bank export laid out like a card's was introduced
  to the person holding it as a card statement: an inference from columns, stated on screen.
- **An ambiguous layout was reported as an unknown one.** A header that two layouts fit equally
  well is refused, rightly — under one a `D` is a deposit and under the other a debit — but the
  refusal said _"No supported format matched"_, which is a different fact with a different fix.
- **`POST /api/imports/bank-csv` wrote onto any account**, recording every row as a bank transfer
  whatever the account was.

## Decision

1. **A table still names no kind — in data or in words.** Every CSV and XLSX reading returns
   `accountKind: null`, as before, and the tabular layouts are relabelled to describe how the
   columns are arranged (_"Amount with a debit/credit marker column"_, _"HDFC Bank export layout
   — withdrawal and deposit columns"_), never a card, a bank account or its type. A test holds
   every tabular label to that.
2. **The person importing it names it.** `POST /api/imports/statement` takes `statementKind`, one
   of the account types. The kind an import is checked against is the document's own when it
   names one, and the person's otherwise:
   - no kind from either → `STATEMENT_KIND_REQUIRED` (400);
   - a stated kind the document contradicts → `STATEMENT_KIND_CONFLICT` (409) — the document's
     word is neither overruled nor silently preferred;
   - a kind in force that the chosen account is not → `STATEMENT_ACCOUNT_MISMATCH` (409), worded
     by who named it (_"This statement belongs to…"_ or _"You said this is the statement of…"_).

   All three are decided after the file is read and before `writeImportedRows` — so before the
   duplicate check as well, exactly as ADR-0067 ordered it: a refusal writes no batch, no payment
   and no audit event, and a file already on record still has to say what it is.

3. **`POST /api/imports/bank-csv` names its own kind: a bank account.** Not from its columns —
   its five would fit a card's export too — but from its contract: the route imports a
   bank-account statement and records every row as a bank transfer. Any other kind of account
   is refused the same way, before anything is written.
4. **The dialog asks, and never answers for the person.** Whenever the reading does not name a
   kind — every table, and any file whose reading could not be reached — it asks _"What kind of
   account is this statement from?"_ with nothing chosen, explains why in one sentence, and
   offers only accounts of the kind given (the rest disabled, each saying why). The answer is
   cleared with every new file. No account is chosen for the person, even when exactly one fits,
   and the answer is never taken from the accounts on file, from the columns, or from an account
   picked earlier. When no account of that kind exists, it says so and points at Setup, where the
   account's name is the person's to choose. The import sends the answer only when the file did
   not name its kind.
5. **A tie is named as a tie.** Auto-detection that finds several layouts equally good now says
   so, naming them by their labels, and imports nothing.
6. **The audit trail says who named it.** Every imported payment's `create` event records
   `statementKind` and `statementKindNamedBy` (`document` or `importer`), so _"why is this movement
   on this account?"_ has an answer.

## Consequences

- A table cannot land on an account of a kind nobody named, by the website or by any API route,
  and the reverse holes ADR-0066 and ADR-0067 closed for PDFs stay closed.
- **What is checked is the person's word, not the truth of it.** Nothing here can tell that a
  file said to be a card's is a card's — the columns are not evidence, and that is the point.
  What changed is that the import can no longer happen without somebody saying it, that it is
  held to what they said, and that the saying is on the record.
- **Breaking for API callers importing a table**: they must now send `statementKind`. Every
  caller in this repository was updated, and the card-shaped CSVs that were imported into a
  savings account now go onto the card.
- Nothing already imported changes. Rows are read exactly as before, so
  `STATEMENT_PARSER_VERSION` is not bumped; no schema change and no migration — the new audit
  fields live in the event's existing JSON.
- The server enforces this only once it is running this build: `tsx src/server.ts` does not
  reload, so a running stack keeps the previous behaviour until it is restarted. The dialog's
  question does not depend on the server and holds either way.
- **Still open, deliberately:** the website cannot import a file whose columns tie between two
  layouts, because it cannot name a layout — an explicit layout choice would be its own decision,
  since choosing one is choosing which way money went. And a byte-identical file already on
  record answers _"already imported"_ when pointed at a second account of the same kind — nothing
  is copied — without yet naming the account that holds it.
