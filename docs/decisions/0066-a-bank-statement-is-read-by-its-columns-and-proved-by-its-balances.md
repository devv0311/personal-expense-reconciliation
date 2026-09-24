# 0066. A bank statement is read by its columns, proved by its own balances, and read before it is written

**Status:** Accepted — **amended in part by
[ADR-0067](0067-a-card-statement-names-its-account-whichever-layout-reads-it.md)**

> **Amendment note.** Decision 3's deferred half is done: the IDFC credit-card layout now declares
> `card`, and the kind checked is the one the _document_ names, whichever layout read it — so a
> card statement is refused from a bank account exactly as a bank statement is from a card.

## Context

The website could import the owner's IDFC FIRST **credit-card** PDFs and refused their **bank
account** statement PDF outright: _"none of its lines matched a statement layout this build
reads."_ Three things stood between that file and the ledger, and only the first is about parsing.

**Direction is not in the text.** A bank-account statement prints a withdrawal and a deposit as
two columns, fills one and leaves the other empty. An empty cell leaves no trace in a PDF's text
layer, so every row extracts as `… 250.00 9,750.00` whichever column the 250.00 was printed in.
The line-pattern readers ADR-0051/0058 introduced cannot tell a debit from a credit on such a
statement, and inferring direction from the balance column is not safe either: on the owner's
statement the bank applies a day's movements in a different order from the one it prints, so
some rows' balances go _up_ beside a withdrawal and _down_ beside a deposit while every day
still closes exactly.

**A PDF import could only say "check the count yourself."** The existing PDF warning is honest —
a PDF has no columns, so the count is what the layout matched — and it leaves the proof of
completeness to the person holding the statement.

**The only account on file is a card**, and the import dialog asked for an account before it knew
what the file was. Nothing stopped a bank statement being written onto the card, where immutable
payments would sit on the wrong account's cash waterfall with no way for anything downstream to
notice.

## Decision

1. **A columnar layout is read by position.** `extractPdfTextWithPdfJs` now also returns where
   each word sat (`layout`, additive). A layout may declare `columns`: the headings it prints,
   the renderer's cell inset, the page furniture it repeats, the opening-balance row and the start
   of its summary. `readColumnarPdfRows` assigns every word to a column by position under the
   page's own headings; money is right-aligned, so an amount belongs to the heading it ends
   nearest, and one that sits between two is refused. **Direction is the column the amount was
   printed in.** A row runs from its printed number to the next one, so a row the page broke in
   two is joined across the next page's headings; a line joins a row only if it starts where a
   cell starts, which keeps furniture, disclaimers and the summary out of every description.
2. **A read is proved complete by the statement's own balances.**
   `domain.reconcilePrintedBalancesByDay` checks that each run of same-dated rows closes exactly
   on the balance printed beside its last row, from the printed opening balance. Rows whose
   balances follow the bank's intra-day order are _counted_ and said out loud, not refused. The
   printed row numbers must also run without a gap. Any failure refuses the whole file, like every
   other import (all-or-nothing, ADR-0051). A row printed after the statement's summary is refused
   too, because stopping at a summary that is not the end would drop the rest without a check.
3. **A statement names the kind of account it belongs to, when its document says so.**
   `PdfLinePattern.accountKind` is declared only by a layout whose document names it — "Savings /
   Current Account Transactions" is a bank account's. `services.importStatement` refuses an import
   into an account of a different kind with `STATEMENT_ACCOUNT_MISMATCH` (409) **before anything
   is written**. Formats that cannot tell — every generic CSV — declare nothing and are not
   checked. The IDFC credit-card layout is not given `card` in this decision, to keep existing
   imports and tests unchanged; doing so is the obvious next step once a bank account exists.
4. **The website reads a statement before anyone decides where it goes.** A new read-only route,
   `POST /api/imports/preview` (`services.previewStatement`), runs the same reader, checks and
   duplicate lookup as an import and **writes nothing**. The dialog calls it the moment a file is chosen and
   says what the file is, how many movements it holds, money out and in, the printed closing
   balance, whether its balances proved it complete, and whether these exact bytes are already on
   record. Only accounts of the statement's kind are offered. When none exists, the dialog says so
   and points at Setup, where the account's name is the person's to choose — **nothing here
   creates an account**. The reading is advisory: if it cannot be reached, the import still reads
   the file itself and the server still refuses the wrong kind of account.

The new layout is `idfc_first_bank_account_pdf`. It was built from the structure of the owner's
statement — which columns exist, where cells sit relative to their headings, how pages repeat
their furniture — without copying any of its text or figures into source, fixtures or tests; the
tests draw synthetic statements in the same shape with `buildPlacedTextPdf`.

## Consequences

- A supported bank PDF imports as a statement known to be complete, not "check the count": every
  day of it was reconciled against what the bank printed before a row was written.
- A bank statement cannot be written onto a card by any path, the website's or a direct API call.
- Reading a file is free of consequences, so the dialog can show the analysis first and ask for
  the account second — the decision-first order the rest of `/add` already follows.
- `web/` still performs no arithmetic: every total the preview shows is summed by the service.
- Row-level duplicates between overlapping statements are still matched by reference only. A row
  that prints no reference in its Chq/Ref column would be imported twice by two overlapping
  statements, as it would under every other format — the file-level hash still makes an exact
  re-import a no-op.
- No schema change and no migration.
