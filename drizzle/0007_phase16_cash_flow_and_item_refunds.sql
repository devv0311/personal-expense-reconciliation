-- Phase 16 — ADR-0017 (cash balance) and ADR-0018 (item refunds) schema extension.
--
-- Additive only. No column is dropped, retyped or narrowed, and no existing row is rewritten;
-- the one DROP below is `audit_events_entity_type_check`, immediately re-added with two more
-- values (the same shape migration 0006 used to widen it).
--
-- Upgrade path for existing data:
--
--   * Every existing `payments` row backfills to `cash_flow_state = 'imported'` with a null
--     category and no approval provenance. That is deliberate and conservative: ADR-0017
--     forbids guessing an approval from `linked` or from a model's confidence, so a payment
--     this ledger already explained still starts the cash-flow lifecycle at the beginning.
--     `payments.state` is untouched — the two lifecycles run alongside each other.
--   * Existing `reconciliation_runs` gain no account snapshots. A legacy outflow-only run
--     stays exactly what it was and must never be presented as verified cash reconciliation;
--     new evidence produces a new run rather than certifying an old one (ADR-0017, 17.7).
--   * Existing `expense_adjustments` gain no attribution rows. A legacy whole-expense refund
--     keeps ADR-0008's documented path; item attribution is never inferred for it
--     (ADR-0018, 19.2).

CREATE TABLE "expense_adjustment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_adjustment_id" uuid NOT NULL,
	"expense_item_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_adjustment_items_amount_check" CHECK ("expense_adjustment_items"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "reconciliation_account_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reconciliation_run_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"opening_balance" bigint,
	"closing_balance" bigint,
	"opening_balance_evidence_id" uuid,
	"closing_balance_evidence_id" uuid,
	"total_debits" bigint NOT NULL,
	"total_credits" bigint NOT NULL,
	"internal_transfer_debits" bigint NOT NULL,
	"internal_transfer_credits" bigint NOT NULL,
	"explained_debits" bigint NOT NULL,
	"unexplained_debits" bigint NOT NULL,
	"explained_credits" bigint NOT NULL,
	"unexplained_credits" bigint NOT NULL,
	"expected_ending_balance" bigint,
	"cash_balance_delta" bigint,
	"verification_status" text NOT NULL,
	"discrepancies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_account_snapshots_period_check" CHECK ("reconciliation_account_snapshots"."period_end" > "reconciliation_account_snapshots"."period_start"),
	CONSTRAINT "reconciliation_account_snapshots_status_check" CHECK (verification_status in ('incomplete', 'unreconciled', 'verified')),
	CONSTRAINT "reconciliation_account_snapshots_movement_sign_check" CHECK ("reconciliation_account_snapshots"."total_debits" >= 0 and "reconciliation_account_snapshots"."total_credits" >= 0
          and "reconciliation_account_snapshots"."explained_debits" >= 0 and "reconciliation_account_snapshots"."unexplained_debits" >= 0
          and "reconciliation_account_snapshots"."explained_credits" >= 0 and "reconciliation_account_snapshots"."unexplained_credits" >= 0
          and "reconciliation_account_snapshots"."internal_transfer_debits" >= 0 and "reconciliation_account_snapshots"."internal_transfer_credits" >= 0),
	CONSTRAINT "reconciliation_account_snapshots_coverage_check" CHECK ("reconciliation_account_snapshots"."total_debits" = "reconciliation_account_snapshots"."explained_debits" + "reconciliation_account_snapshots"."unexplained_debits"
          and "reconciliation_account_snapshots"."total_credits" = "reconciliation_account_snapshots"."explained_credits" + "reconciliation_account_snapshots"."unexplained_credits"),
	CONSTRAINT "reconciliation_account_snapshots_transfer_subset_check" CHECK ("reconciliation_account_snapshots"."internal_transfer_debits" <= "reconciliation_account_snapshots"."total_debits"
          and "reconciliation_account_snapshots"."internal_transfer_credits" <= "reconciliation_account_snapshots"."total_credits"),
	CONSTRAINT "reconciliation_account_snapshots_boundary_evidence_check" CHECK (("reconciliation_account_snapshots"."opening_balance" is null) = ("reconciliation_account_snapshots"."opening_balance_evidence_id" is null)
          and ("reconciliation_account_snapshots"."closing_balance" is null) = ("reconciliation_account_snapshots"."closing_balance_evidence_id" is null)),
	CONSTRAINT "reconciliation_account_snapshots_derived_presence_check" CHECK (("reconciliation_account_snapshots"."expected_ending_balance" is null)
            = ("reconciliation_account_snapshots"."opening_balance" is null or "reconciliation_account_snapshots"."closing_balance" is null)
          and ("reconciliation_account_snapshots"."cash_balance_delta" is null) = ("reconciliation_account_snapshots"."expected_ending_balance" is null)),
	CONSTRAINT "reconciliation_account_snapshots_identity_check" CHECK ("reconciliation_account_snapshots"."expected_ending_balance" is null
          or ("reconciliation_account_snapshots"."expected_ending_balance"
                = "reconciliation_account_snapshots"."opening_balance" + "reconciliation_account_snapshots"."total_credits" - "reconciliation_account_snapshots"."total_debits"
              and "reconciliation_account_snapshots"."cash_balance_delta"
                = "reconciliation_account_snapshots"."closing_balance" - "reconciliation_account_snapshots"."expected_ending_balance")),
	CONSTRAINT "reconciliation_account_snapshots_verified_check" CHECK ("reconciliation_account_snapshots"."verification_status" <> 'verified'
          or ("reconciliation_account_snapshots"."cash_balance_delta" = 0
              and "reconciliation_account_snapshots"."unexplained_debits" = 0
              and "reconciliation_account_snapshots"."unexplained_credits" = 0
              and "reconciliation_account_snapshots"."opening_balance_evidence_id" is not null
              and "reconciliation_account_snapshots"."closing_balance_evidence_id" is not null
              and jsonb_array_length("reconciliation_account_snapshots"."discrepancies") = 0)),
	CONSTRAINT "reconciliation_account_snapshots_incomplete_check" CHECK ("reconciliation_account_snapshots"."verification_status" <> 'incomplete' or "reconciliation_account_snapshots"."cash_balance_delta" is null)
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_entity_type_check";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "cash_flow_category" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "cash_flow_state" text DEFAULT 'imported' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "cash_flow_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "cash_flow_approved_by" text;--> statement-breakpoint
ALTER TABLE "expense_adjustment_items" ADD CONSTRAINT "expense_adjustment_items_expense_adjustment_id_expense_adjustments_id_fk" FOREIGN KEY ("expense_adjustment_id") REFERENCES "public"."expense_adjustments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_adjustment_items" ADD CONSTRAINT "expense_adjustment_items_expense_item_id_expense_items_id_fk" FOREIGN KEY ("expense_item_id") REFERENCES "public"."expense_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_account_snapshots" ADD CONSTRAINT "reconciliation_account_snapshots_reconciliation_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("reconciliation_run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_account_snapshots" ADD CONSTRAINT "reconciliation_account_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_account_snapshots" ADD CONSTRAINT "reconciliation_account_snapshots_opening_balance_evidence_id_evidence_id_fk" FOREIGN KEY ("opening_balance_evidence_id") REFERENCES "public"."evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_account_snapshots" ADD CONSTRAINT "reconciliation_account_snapshots_closing_balance_evidence_id_evidence_id_fk" FOREIGN KEY ("closing_balance_evidence_id") REFERENCES "public"."evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_adjustment_items_unique" ON "expense_adjustment_items" USING btree ("expense_adjustment_id","expense_item_id");--> statement-breakpoint
CREATE INDEX "expense_adjustment_items_item_idx" ON "expense_adjustment_items" USING btree ("expense_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_account_snapshots_unique" ON "reconciliation_account_snapshots" USING btree ("reconciliation_run_id","account_id");--> statement-breakpoint
CREATE INDEX "reconciliation_account_snapshots_account_idx" ON "reconciliation_account_snapshots" USING btree ("account_id","period_end");--> statement-breakpoint
CREATE INDEX "payments_cash_flow_state_idx" ON "payments" USING btree ("cash_flow_state","direction") WHERE "payments"."cash_flow_state" <> 'approved';--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_entity_type_check" CHECK (entity_type in ('payment', 'expense', 'expense_item', 'payment_expense_link', 'allocation', 'allocation_line', 'allocation_line_group_expansion', 'settlement', 'expense_adjustment', 'expense_adjustment_item', 'merchant', 'evidence', 'receipt', 'ai_inference', 'rule', 'splitwise_expense', 'splitwise_settlement', 'reconciliation_run', 'reconciliation_account_snapshot'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_flow_category_check" CHECK ("payments"."cash_flow_category" is null or cash_flow_category in ('PEER_SETTLEMENT', 'REFUND', 'INTERNAL_TRANSFER', 'EXTERNAL_INFLOW'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_flow_state_check" CHECK (cash_flow_state in ('imported', 'normalized', 'cash_flow_classified', 'approved'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_flow_direction_check" CHECK ("payments"."cash_flow_category" is null
          or "payments"."cash_flow_category" not in ('REFUND', 'EXTERNAL_INFLOW')
          or "payments"."direction" = 'credit');--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_flow_category_state_check" CHECK ("payments"."cash_flow_category" is null
          or "payments"."cash_flow_state" in ('cash_flow_classified', 'approved'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_flow_approved_credit_check" CHECK ("payments"."cash_flow_state" <> 'approved'
          or "payments"."direction" = 'debit'
          or "payments"."cash_flow_category" is not null);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_flow_approved_counterparty_check" CHECK ("payments"."cash_flow_state" <> 'approved'
          or "payments"."cash_flow_category" is null
          or ("payments"."cash_flow_category" = 'PEER_SETTLEMENT' and "payments"."counterparty_type" = 'person')
          or ("payments"."cash_flow_category" = 'INTERNAL_TRANSFER' and "payments"."counterparty_type" = 'internal_account')
          or "payments"."cash_flow_category" in ('REFUND', 'EXTERNAL_INFLOW'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_flow_approval_provenance_check" CHECK (("payments"."cash_flow_state" = 'approved') = ("payments"."cash_flow_approved_at" is not null)
          and ("payments"."cash_flow_state" = 'approved') = ("payments"."cash_flow_approved_by" is not null));