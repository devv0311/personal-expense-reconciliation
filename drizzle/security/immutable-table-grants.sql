-- Role-level immutability for SOURCE and audit tables.
--
-- `docs/architecture/database-design.md` (Conventions) specifies two layers of protection for
-- write-once data: the `services` layer never issues an UPDATE against it, and — defence in
-- depth — the application's PostgreSQL role can be denied the privilege outright, so an
-- accidental attempt fails loudly at the database rather than silently succeeding.
--
-- This file is the second layer. It is deliberately NOT part of the generated migration
-- sequence, because it names a deployment-specific role that does not exist in a fresh
-- development database or in the test harness. Apply it once per environment, after
-- migrations, substituting the role your application actually connects as.
--
-- Usage:
--     psql "$DATABASE_URL" \
--       -v app_role=expense_reconciliation_app \
--       -f drizzle/security/immutable-table-grants.sql
--
-- Note this does not restrict a superuser or the database owner; it constrains the role the
-- application connects as, which is the one that could plausibly make the mistake. Run
-- migrations as a separate, privileged role.

\set ON_ERROR_STOP on

-- SOURCE data: raw imported evidence is never overwritten (invariants.md #4).
-- INSERT stays available — importing new rows is the whole point.
REVOKE UPDATE, DELETE ON TABLE payments FROM :"app_role";
REVOKE UPDATE, DELETE ON TABLE evidence FROM :"app_role";
REVOKE UPDATE, DELETE ON TABLE import_batches FROM :"app_role";

-- `payments.state`/`ignored_reason` and `evidence` linkage are DERIVED metadata layered on
-- immutable SOURCE columns, so those specific columns are granted back explicitly. Postgres
-- has no column-level REVOKE, only column-level GRANT, which is exactly the shape wanted
-- here: everything else on the table stays unwritable.
GRANT UPDATE (state, ignored_reason) ON TABLE payments TO :"app_role";
GRANT UPDATE (linked_payment_id, linked_expense_id) ON TABLE evidence TO :"app_role";

-- Append-only audit log: never edited, never deleted, including for data the user later
-- corrects — the correction is a new event, not a rewrite of history (invariants.md #22).
REVOKE UPDATE, DELETE ON TABLE audit_events FROM :"app_role";

-- Group-expansion snapshots are written exactly once, at allocation approval, and never
-- recomputed — a later membership change must have zero effect on them (ADR-0009).
REVOKE UPDATE, DELETE ON TABLE allocation_line_group_expansions FROM :"app_role";

-- `expenses.amount` is gross, historical, and never changes once the expense is approved
-- (invariants.md #6, ADR-0008). The rest of the row still moves — state, category, the
-- occasion it belongs to — so this is a column-level restriction, applied by granting the
-- mutable columns rather than the whole table.
REVOKE UPDATE ON TABLE expenses FROM :"app_role";
GRANT UPDATE (description, category, occasion_id, relationship_type, state, updated_at)
  ON TABLE expenses TO :"app_role";

-- Allocation versions are append-only apart from being stamped as superseded (invariants.md #6).
REVOKE UPDATE ON TABLE allocations FROM :"app_role";
GRANT UPDATE (superseded_at) ON TABLE allocations TO :"app_role";

-- Allocation lines belong to an immutable allocation version; a correction is a new version.
REVOKE UPDATE, DELETE ON TABLE allocation_lines FROM :"app_role";

-- A settlement and an adjustment are both authoritative records of an observed event.
REVOKE UPDATE, DELETE ON TABLE settlements FROM :"app_role";
REVOKE UPDATE, DELETE ON TABLE expense_adjustments FROM :"app_role";

-- A reconciliation run is a snapshot; a later run supersedes it rather than editing it.
REVOKE UPDATE, DELETE ON TABLE reconciliation_runs FROM :"app_role";
GRANT UPDATE (resolved_at) ON TABLE reconciliation_runs TO :"app_role";
