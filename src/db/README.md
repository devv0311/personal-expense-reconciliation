# src/db

Schema and persistence. See `docs/architecture/database-design.md` for the reviewed schema
design this will implement.

**Owns:** Drizzle schema definitions, migrations, and repository-style data access functions
(one per entity/query need, no raw queries scattered through `services`).

**Depends on:** nothing else in `src/` (types come from `src/domain`, imported one-way).

**Rule:** no `UPDATE` against SOURCE-classified columns (`payments`, `evidence`,
`import_batches`) is ever issued from here — see `docs/domain/invariants.md` #4 and
`docs/architecture/database-design.md`'s immutability conventions.

**Implemented.**

- `schema.ts` — the 28 tables from `database-design.md` plus the two Phase 16 added
  (`expense_adjustment_items`, `reconciliation_account_snapshots`), with their check
  constraints, foreign keys, partial unique indexes and `bigint` monetary columns. Enum
  check-constraint values come from `src/domain/enums.ts`, so the schema and the domain cannot
  drift. `reconciliation_account_snapshots` is the one table that carries its cross-column
  _arithmetic_ as row `CHECK`s rather than leaving it to `src/domain` — ADR-0017 (cash balance)
  17.7 asks for exactly that, and every term of its identities lives on one row.
- `client.ts` — `openDatabase()`, over `node-postgres` or PGlite (ADR-0017). Both are
  configured so `bigint` columns arrive as JavaScript `bigint`, never `number`.
- `repositories.ts` — data access. No financial arithmetic lives here.
- `drizzle/0000_initial_financial_schema.sql` and the additive migrations after it, most
  recently `0007_phase16_cash_flow_and_item_refunds.sql` (phase 16: `payments` gains
  `cash_flow_category`/`cash_flow_state` and their approval provenance, and the two new tables
  arrive — ADR-0017 (cash balance), ADR-0018 (item refunds); every existing row backfills to
  `cash_flow_state = 'imported'` with no category and no approval, because an approval is never
  guessed from `linked`), `0006_evidence_ingestion.sql` (phase 10: `evidence` gains `media_type`/`byte_size`
  and the checks pairing them to `storage_ref`, plus `evidence` as an auditable entity type —
  ADR-0033), `0005_expense_rejected_state.sql` (phase 9: `expenses.state` gains the terminal
  `rejected`, where a declined or superseded classification proposal's DERIVED expense ends —
  ADR-0028) and `0004_ai_inference_type_check.sql` (phase 8: `ai_inferences.inference_type` is
  constrained to the nine operations `ai-boundary.md` defines, so an invented inference type is
  rejected by the database as well as by the code about to write it). Regenerate with
  `npm run db:generate`; `npm run db:check` verifies they still match.

**Immutability.** There is no update path here for `payments.amount/occurred_at/
raw_description/account_id`, `evidence.type/note_kind/storage_ref/media_type/byte_size/raw_text/
captured_at`, `expenses.amount`, or any `audit_events` row. `updateEvidenceLinks` is the single
exception and writes only `linked_payment_id`/`linked_expense_id` — DERIVED metadata the grants
file explicitly grants back, and only ever from `null`, which `domain.assertEvidenceLinkOnce`
decides before this layer is called (ADR-0034). `drizzle/security/immutable-table-grants.sql` applies the same
restriction at the database-role level as defence in depth; it is deployment-specific and so is
not part of the migration sequence.
