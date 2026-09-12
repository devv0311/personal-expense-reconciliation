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
-- `cash_flow_*` joins them: ADR-0017 (cash balance)'s interpretation lifecycle is DERIVED
-- metadata layered on the same immutable SOURCE row, exactly as `state` is.
GRANT UPDATE (state, ignored_reason, cash_flow_category, cash_flow_state, cash_flow_approved_at, cash_flow_approved_by)
  ON TABLE payments TO :"app_role";
-- `superseded_by_evidence_id`/`supersede_reason` join them (ADR-0052). A record whose
-- write-once link was wrong is replaced by a new row, and the original is *stamped* rather
-- than edited — everything it says stays exactly as it was written.
GRANT UPDATE (linked_payment_id, linked_expense_id, superseded_by_evidence_id, supersede_reason)
  ON TABLE evidence TO :"app_role";

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

-- An adjustment is append-only apart from being stamped as reversed (ADR-0052) — the same
-- shape `allocations.superseded_at` already has. Reversal says an adjustment was recorded in
-- error and stops it counting; it does not edit the amount, the kind, the date or the expense
-- it named, so the erroneous record and the account of why it was wrong both survive
-- (invariants.md #22).
REVOKE UPDATE, DELETE ON TABLE expense_adjustments FROM :"app_role";
GRANT UPDATE (reversed_at, reversal_reason, reversed_by) ON TABLE expense_adjustments
  TO :"app_role";

-- A reconciliation run is a snapshot; a later run supersedes it rather than editing it.
REVOKE UPDATE, DELETE ON TABLE reconciliation_runs FROM :"app_role";
GRANT UPDATE (resolved_at) ON TABLE reconciliation_runs TO :"app_role";

-- An item attribution records what a refund actually gave money back for. Like the
-- adjustment it belongs to, it is a record of an observed event: a correction is a new
-- adjustment with its own attributions, never an edit of these rows
-- (ADR-0018 (item refunds), 19.5).
REVOKE UPDATE, DELETE ON TABLE expense_adjustment_items FROM :"app_role";

-- An account snapshot records what the inputs said when the run happened. Editing an old
-- `incomplete` snapshot into a `verified` one is the retroactive certification ADR-0017
-- (cash balance) 17.7 forbids; new evidence produces a new run. Unlike `reconciliation_runs`,
-- there is no `resolved_at` to grant back — nothing on this row is ever meant to move.
REVOKE UPDATE, DELETE ON TABLE reconciliation_account_snapshots FROM :"app_role";

-- A delivery record says what was put in front of somebody else. What left is written once:
-- recipient, address, the exact message, its digest and the documents that went with it. Only
-- the delivery's own progress moves — a retry, a provider id, a confirmed arrival — so this is
-- a column-level restriction rather than a whole-table one. "What did I send them" must stay
-- answerable exactly as it was answered on the day it was sent (audit row 42).
REVOKE UPDATE, DELETE ON TABLE proof_pack_deliveries FROM :"app_role";
GRANT UPDATE (status, attempt_count, last_error, provider_message_id, sent_at, delivered_at, updated_at)
  ON TABLE proof_pack_deliveries TO :"app_role";

-- Deliberately absent: `evidence_observations` and `evidence_match_candidates` (phase 17,
-- ADR-0044). Both are DERIVED and both are meant to move — a better reading of a notification
-- replaces the one before it, and a candidate is re-stated when the matcher's view of it
-- changes. What must not change about them is expressed as a CHECK instead of a grant:
-- `evidence_match_candidates_decision_check` makes `accepted`/`dismissed` reachable only with a
-- recorded actor and instant, so a candidate cannot be approved by anything but a person (or an
-- already-approved Rule) whatever privileges the role holds. The link they can lead to is still
-- governed here, by the `evidence` grant above.
