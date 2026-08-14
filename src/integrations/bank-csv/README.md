# src/integrations/bank-csv

Adapter for one synthetic bank-statement CSV format:

```
date,description,amount_inr,type,reference
2026-07-01,UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD,1240.00,DEBIT,UPI/2607011234/BLINKIT
```

**Owns:** format knowledge, and only format knowledge — how this file writes a date, an
amount, a direction, and which reference-prefix convention it uses. Rupee strings become exact
`bigint` paise via `domain.parseMajorUnitsToPaise`; dates are read at **UTC midnight** so an
import in Kolkata and the same import on a CI runner produce byte-identical `occurred_at`
values.

**Depends on:** `src/domain` types and `parseMajorUnitsToPaise`. Nothing else. Pure — text in,
values out, no I/O and no clock.

**Must never:** decide what a payment was _for_. No counterparty resolution, no merchant
matching, no expense/settlement/transfer/investment classification.
`NEFT TRANSFER TO SELF A/C X4821` is obviously an internal transfer to a human reader, and this
adapter still returns it as nothing but a debit with that description — classifying it belongs
to `docs/roadmap.md` phase 8. `BankStatementCsvRow` has no field that could carry such a
decision, so the boundary is structural rather than a matter of discipline.

**Errors:** a malformed row is reported with its line number and column, never dropped. The
parse is all-or-nothing: a partially imported statement leaves the ledger quietly missing rows,
and "unexplained money" would then measure the importer's gaps rather than the user's spending.

Adding a second source format means adding a sibling directory here, not editing this one — see
`docs/product/requirements.md`, "Extensibility without coupling".
