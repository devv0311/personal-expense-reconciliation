# 0067. A card statement names its account too, whichever layout reads it

**Status:** Accepted — **amended in part by
[ADR-0068](0068-a-statement-that-cannot-name-its-account-is-named-by-the-person-importing-it.md)**

> **Amendment note.** The last consequence below — a tabular export is not checked — no longer
> holds. A CSV or XLSX still names no kind, but the person importing it now does, and the import
> is held to that answer before anything is written; `POST /api/imports/bank-csv` states its own.

**Amends:** [ADR-0066](0066-a-bank-statement-is-read-by-its-columns-and-proved-by-its-balances.md)
— its third decision, which stopped a bank statement landing on a card and left the other
direction for later. Every other part of ADR-0066 is unchanged.

## Context

ADR-0066 refused a bank-account statement written onto a card, and said of the reverse: _"The
IDFC credit-card layout is not given `card` in this decision, to keep existing imports and tests
unchanged."_ So the reverse stayed open. A credit-card statement could be imported into a bank
account — or a UPI account, a wallet, cash — and its payments, which are immutable, would sit on
that account's cash waterfall with nothing downstream able to notice. Five integration tests
did exactly that with the synthetic card PDF, because nothing refused it.

There was a second, quieter gap underneath. The import checked the kind declared by **the layout
that read the rows**. `POST /api/imports/statement` accepts any `formatId`, and the generic
`pdf_amount_with_marker` layout reads a card statement's `date narration amount DR/CR` lines
perfectly well while declaring no kind at all. Naming it turned a card statement into an
unclaimed file that any account would accept — the same hole in the bank guard's mirror, reached
by a direct API call instead of the website.

## Decision

1. **The IDFC credit-card layout declares `card`.** Its document names itself a _Credit Card
   Statement_, which is exactly the condition ADR-0066 set for declaring a kind.
2. **The kind is a fact about the document, not about its reader.** A successful parse now
   carries `accountKind`. When the layout that read the rows declares one, that settles it — it
   recognised the document by name first. Otherwise every layout that declares a kind is asked,
   through its `documentPattern`, whether this is its document; a card statement read by a
   generic line shape is still a card's. A layout may declare a kind only alongside a
   `documentPattern`, so the question can always be asked. A document that answers with **two
   different kinds** contradicts itself about which account it belongs to, and the parser refuses
   it whole rather than choosing — nothing is written. A table (CSV/XLSX) claims no kind.
3. **`services.importStatement` checks the document's kind**, not the reader's, after the file is
   read and before `writeImportedRows`: a refusal is `STATEMENT_ACCOUNT_MISMATCH` (409) with no
   batch, payment or audit event written. Because that is also before the file's duplicate check,
   a card statement already on record for its card is still refused, by name, for a bank account
   rather than answered with "already imported". `services.previewStatement` returns the same kind,
   so the dialog offers exactly the accounts an import would accept.
4. **The dialog says it in the words a person uses.** Its account filter was already kind-generic,
   so a card statement disables every account that is not a card and says why (`— not a card`).
   When no card exists it reads _"This is a card statement, and there is no card on record yet.
   Add the card in Setup — its name is yours to choose — …"_, and it is titled **Import a
   statement** rather than "Import a bank statement". The **Setup** link in that sentence is now
   underlined in the accent colour, as `Design.md` requires of a link inside text: it had been
   the sentence's own colour with no underline, so the one way forward did not look like one.
   Nothing here creates an account.

## Consequences

- Neither direction is possible any more, by the website or by a direct API call naming any
  layout: a bank statement never lands on a card (ADR-0066), a card statement never lands on a
  bank account, a UPI account, a wallet or cash (this decision).
- Nothing already imported changes. A card statement still imports into a card and a byte-identical
  re-import onto it is still a no-op. Rows are read exactly as before, so
  `STATEMENT_PARSER_VERSION` is not bumped. No schema change and no migration.
- The tests that imported the synthetic card PDF into a savings account now import it into a card.
- **Still not checked:** a tabular export, including `card_statement_csv`. A column map cannot tell
  a card's export from a bank's — auto-detection picks a format by its columns, and a bank export
  with those columns would be refused from its own account — so the account a person chooses for
  a CSV or XLSX stands, as it did before.
