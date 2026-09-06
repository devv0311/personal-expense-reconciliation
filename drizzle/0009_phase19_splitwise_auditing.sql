CREATE TABLE "splitwise_audit_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_run_id" uuid NOT NULL,
	"last_observed_audit_run_id" uuid NOT NULL,
	"reconciliation_run_id" uuid,
	"kind" text NOT NULL,
	"finding_class" text NOT NULL,
	"scope" text NOT NULL,
	"summary" text NOT NULL,
	"confidence" text NOT NULL,
	"amount" bigint,
	"balance_impact" bigint NOT NULL,
	"person_a_id" uuid,
	"person_b_id" uuid,
	"expense_id" uuid,
	"splitwise_expense_row_id" uuid,
	"settlement_id" uuid,
	"splitwise_settlement_row_id" uuid,
	"external_reference" text,
	"local_snapshot" jsonb NOT NULL,
	"external_snapshot" jsonb,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"comparison_digest" text NOT NULL,
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_status" text DEFAULT 'open' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	"review_reason" text,
	"superseded_at" timestamp with time zone,
	"superseded_by_finding_id" uuid,
	"supersede_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "splitwise_audit_findings_kind_check" CHECK (kind in ('missing_external_expense', 'duplicate_external_expense', 'stale_refund_partial', 'stale_refund_full', 'unreflected_item_refund', 'missing_external_settlement', 'duplicate_external_settlement', 'unrecorded_external_settlement', 'external_amount_disagreement', 'unsupported_ghost_debt', 'unattributed_balance_mismatch', 'external_read_failed', 'external_read_unsupported', 'external_read_partial', 'external_record_inaccessible', 'non_user_settlement_unobservable', 'cross_payer_attribution_unavailable')),
	CONSTRAINT "splitwise_audit_findings_class_check" CHECK (finding_class in ('discrepancy', 'limitation', 'incomplete')),
	CONSTRAINT "splitwise_audit_findings_scope_check" CHECK (scope in ('integration', 'pair', 'expense', 'settlement', 'external_entry')),
	CONSTRAINT "splitwise_audit_findings_confidence_check" CHECK (confidence in ('high', 'medium', 'low', 'unknown')),
	CONSTRAINT "splitwise_audit_findings_review_status_check" CHECK (review_status in ('open', 'acknowledged', 'resolved', 'dismissed')),
	CONSTRAINT "splitwise_audit_findings_supersede_reason_check" CHECK ("splitwise_audit_findings"."supersede_reason" is null
          or supersede_reason in ('materially_changed', 'no_longer_observed')),
	CONSTRAINT "splitwise_audit_findings_amount_check" CHECK ("splitwise_audit_findings"."amount" is null or "splitwise_audit_findings"."amount" >= 0),
	CONSTRAINT "splitwise_audit_findings_review_attribution_check" CHECK (("splitwise_audit_findings"."review_status" <> 'open')
            = ("splitwise_audit_findings"."reviewed_at" is not null)
          and ("splitwise_audit_findings"."review_status" <> 'open')
            = ("splitwise_audit_findings"."reviewed_by" is not null)
          and ("splitwise_audit_findings"."review_status" in ('resolved', 'dismissed'))
            <= ("splitwise_audit_findings"."review_reason" is not null)),
	CONSTRAINT "splitwise_audit_findings_supersede_check" CHECK (("splitwise_audit_findings"."superseded_at" is null) = ("splitwise_audit_findings"."supersede_reason" is null)
          and ("splitwise_audit_findings"."superseded_by_finding_id" is null or "splitwise_audit_findings"."superseded_at" is not null)),
	CONSTRAINT "splitwise_audit_findings_snapshot_shape_check" CHECK (jsonb_typeof("splitwise_audit_findings"."local_snapshot") = 'object'
          and ("splitwise_audit_findings"."external_snapshot" is null
               or jsonb_typeof("splitwise_audit_findings"."external_snapshot") = 'object')
          and jsonb_typeof("splitwise_audit_findings"."evidence") = 'array')
);
--> statement-breakpoint
CREATE TABLE "splitwise_audit_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconciliation_run_id" uuid,
	"external_integration_id" uuid,
	"external_read_status" text NOT NULL,
	"external_read_detail" text,
	"pairs_audited" integer DEFAULT 0 NOT NULL,
	"pairs_unchecked" integer DEFAULT 0 NOT NULL,
	"findings_created" integer DEFAULT 0 NOT NULL,
	"findings_reobserved" integer DEFAULT 0 NOT NULL,
	"findings_superseded" integer DEFAULT 0 NOT NULL,
	"external_balances_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "splitwise_audit_runs_read_status_check" CHECK (external_read_status in ('complete', 'partial', 'unsupported', 'failed', 'skipped')),
	CONSTRAINT "splitwise_audit_runs_counts_check" CHECK ("splitwise_audit_runs"."pairs_audited" >= 0 and "splitwise_audit_runs"."pairs_unchecked" >= 0
          and "splitwise_audit_runs"."pairs_unchecked" <= "splitwise_audit_runs"."pairs_audited"
          and "splitwise_audit_runs"."findings_created" >= 0 and "splitwise_audit_runs"."findings_reobserved" >= 0
          and "splitwise_audit_runs"."findings_superseded" >= 0)
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_entity_type_check";--> statement-breakpoint
ALTER TABLE "splitwise_audit_findings" ADD CONSTRAINT "splitwise_audit_findings_audit_run_id_splitwise_audit_runs_id_fk" FOREIGN KEY ("audit_run_id") REFERENCES "public"."splitwise_audit_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_audit_findings" ADD CONSTRAINT "splitwise_audit_findings_last_observed_audit_run_id_splitwise_audit_runs_id_fk" FOREIGN KEY ("last_observed_audit_run_id") REFERENCES "public"."splitwise_audit_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_audit_findings" ADD CONSTRAINT "splitwise_audit_findings_reconciliation_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("reconciliation_run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_audit_findings" ADD CONSTRAINT "splitwise_audit_findings_person_a_id_people_id_fk" FOREIGN KEY ("person_a_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_audit_findings" ADD CONSTRAINT "splitwise_audit_findings_person_b_id_people_id_fk" FOREIGN KEY ("person_b_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_audit_findings" ADD CONSTRAINT "splitwise_audit_findings_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_audit_findings" ADD CONSTRAINT "splitwise_audit_findings_splitwise_expense_row_id_splitwise_expenses_id_fk" FOREIGN KEY ("splitwise_expense_row_id") REFERENCES "public"."splitwise_expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_audit_findings" ADD CONSTRAINT "splitwise_audit_findings_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_audit_findings" ADD CONSTRAINT "splitwise_audit_findings_splitwise_settlement_row_id_splitwise_settlements_id_fk" FOREIGN KEY ("splitwise_settlement_row_id") REFERENCES "public"."splitwise_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_audit_findings" ADD CONSTRAINT "splitwise_audit_findings_superseded_by_finding_id_splitwise_audit_findings_id_fk" FOREIGN KEY ("superseded_by_finding_id") REFERENCES "public"."splitwise_audit_findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_audit_runs" ADD CONSTRAINT "splitwise_audit_runs_reconciliation_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("reconciliation_run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_audit_runs" ADD CONSTRAINT "splitwise_audit_runs_external_integration_id_external_integrations_id_fk" FOREIGN KEY ("external_integration_id") REFERENCES "public"."external_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "splitwise_audit_findings_current_idx" ON "splitwise_audit_findings" USING btree ("fingerprint") WHERE "splitwise_audit_findings"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "splitwise_audit_findings_run_idx" ON "splitwise_audit_findings" USING btree ("audit_run_id");--> statement-breakpoint
CREATE INDEX "splitwise_audit_findings_review_idx" ON "splitwise_audit_findings" USING btree ("review_status","first_observed_at");--> statement-breakpoint
CREATE INDEX "splitwise_audit_findings_pair_idx" ON "splitwise_audit_findings" USING btree ("person_a_id","person_b_id");--> statement-breakpoint
CREATE INDEX "splitwise_audit_runs_run_at_idx" ON "splitwise_audit_runs" USING btree ("run_at");--> statement-breakpoint
CREATE INDEX "splitwise_audit_runs_reconciliation_idx" ON "splitwise_audit_runs" USING btree ("reconciliation_run_id");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_entity_type_check" CHECK (entity_type in ('payment', 'expense', 'expense_item', 'payment_expense_link', 'allocation', 'allocation_line', 'allocation_line_group_expansion', 'settlement', 'expense_adjustment', 'expense_adjustment_item', 'merchant', 'evidence', 'evidence_observation', 'evidence_match_candidate', 'receipt', 'ai_inference', 'rule', 'splitwise_expense', 'splitwise_settlement', 'reconciliation_run', 'reconciliation_account_snapshot', 'splitwise_audit_run', 'splitwise_audit_finding'));