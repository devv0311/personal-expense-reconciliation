CREATE TABLE "splitwise_remote_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"remote_read_id" uuid NOT NULL,
	"last_observed_read_id" uuid NOT NULL,
	"external_integration_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"effect" text NOT NULL,
	"summary" text NOT NULL,
	"consequence" text NOT NULL,
	"read_status" text NOT NULL,
	"read_detail" text,
	"person_a_id" uuid,
	"person_b_id" uuid,
	"expense_id" uuid,
	"splitwise_expense_row_id" uuid,
	"settlement_id" uuid,
	"splitwise_settlement_row_id" uuid,
	"external_reference" text,
	"external_user_reference" text,
	"amount" bigint,
	"local_snapshot" jsonb NOT NULL,
	"remote_snapshot" jsonb,
	"subjects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"comparison_digest" text NOT NULL,
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"decision_reason" text,
	"applied_effect" text,
	"applied_target_id" uuid,
	"superseded_at" timestamp with time zone,
	"superseded_by_change_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "splitwise_remote_changes_kind_check" CHECK (kind in ('remote_expense_amount_changed', 'remote_settlement_amount_changed', 'remote_expense_deleted', 'remote_settlement_deleted', 'remote_expense_unlinked', 'remote_settlement_unlinked', 'remote_person_unmapped', 'remote_duplicate_candidate')),
	CONSTRAINT "splitwise_remote_changes_effect_check" CHECK (effect in ('record_drift', 'record_external_deletion', 'adopt_expense_link', 'adopt_settlement_link', 'map_person', 'none')),
	CONSTRAINT "splitwise_remote_changes_status_check" CHECK (status in ('proposed', 'accepted', 'rejected')),
	CONSTRAINT "splitwise_remote_changes_read_status_check" CHECK (read_status in ('complete', 'partial', 'unsupported', 'failed', 'skipped')),
	CONSTRAINT "splitwise_remote_changes_applied_effect_check" CHECK ("splitwise_remote_changes"."applied_effect" is null
          or applied_effect in ('record_drift', 'record_external_deletion',
                                'adopt_expense_link', 'adopt_settlement_link', 'map_person')),
	CONSTRAINT "splitwise_remote_changes_amount_check" CHECK ("splitwise_remote_changes"."amount" is null or "splitwise_remote_changes"."amount" >= 0),
	CONSTRAINT "splitwise_remote_changes_decision_check" CHECK (("splitwise_remote_changes"."status" <> 'proposed') = ("splitwise_remote_changes"."decided_at" is not null)
          and ("splitwise_remote_changes"."status" <> 'proposed') = ("splitwise_remote_changes"."decided_by" is not null)
          and ("splitwise_remote_changes"."status" <> 'proposed') = ("splitwise_remote_changes"."decision_reason" is not null)
          and ("splitwise_remote_changes"."status" = 'accepted') = ("splitwise_remote_changes"."applied_effect" is not null)),
	CONSTRAINT "splitwise_remote_changes_supersede_check" CHECK ("splitwise_remote_changes"."superseded_by_change_id" is null or "splitwise_remote_changes"."superseded_at" is not null),
	CONSTRAINT "splitwise_remote_changes_snapshot_shape_check" CHECK (jsonb_typeof("splitwise_remote_changes"."local_snapshot") = 'object'
          and ("splitwise_remote_changes"."remote_snapshot" is null
               or jsonb_typeof("splitwise_remote_changes"."remote_snapshot") = 'object')
          and jsonb_typeof("splitwise_remote_changes"."subjects") = 'array')
);
--> statement-breakpoint
CREATE TABLE "splitwise_remote_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"external_integration_id" uuid,
	"external_read_status" text NOT NULL,
	"external_read_detail" text,
	"pairs_read" integer DEFAULT 0 NOT NULL,
	"pairs_unchecked" integer DEFAULT 0 NOT NULL,
	"changes_created" integer DEFAULT 0 NOT NULL,
	"changes_reobserved" integer DEFAULT 0 NOT NULL,
	"changes_superseded" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "splitwise_remote_reads_status_check" CHECK (external_read_status in ('complete', 'partial', 'unsupported', 'failed', 'skipped')),
	CONSTRAINT "splitwise_remote_reads_counts_check" CHECK ("splitwise_remote_reads"."pairs_read" >= 0 and "splitwise_remote_reads"."pairs_unchecked" >= 0
          and "splitwise_remote_reads"."pairs_unchecked" <= "splitwise_remote_reads"."pairs_read"
          and "splitwise_remote_reads"."changes_created" >= 0 and "splitwise_remote_reads"."changes_reobserved" >= 0
          and "splitwise_remote_reads"."changes_superseded" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_inferences" DROP CONSTRAINT "ai_inferences_inference_type_check";--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_entity_type_check";--> statement-breakpoint
ALTER TABLE "splitwise_expenses" DROP CONSTRAINT "splitwise_expenses_sync_status_check";--> statement-breakpoint
ALTER TABLE "splitwise_settlements" DROP CONSTRAINT "splitwise_settlements_sync_status_check";--> statement-breakpoint
ALTER TABLE "splitwise_remote_changes" ADD CONSTRAINT "splitwise_remote_changes_remote_read_id_splitwise_remote_reads_id_fk" FOREIGN KEY ("remote_read_id") REFERENCES "public"."splitwise_remote_reads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_remote_changes" ADD CONSTRAINT "splitwise_remote_changes_last_observed_read_id_splitwise_remote_reads_id_fk" FOREIGN KEY ("last_observed_read_id") REFERENCES "public"."splitwise_remote_reads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_remote_changes" ADD CONSTRAINT "splitwise_remote_changes_external_integration_id_external_integrations_id_fk" FOREIGN KEY ("external_integration_id") REFERENCES "public"."external_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_remote_changes" ADD CONSTRAINT "splitwise_remote_changes_person_a_id_people_id_fk" FOREIGN KEY ("person_a_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_remote_changes" ADD CONSTRAINT "splitwise_remote_changes_person_b_id_people_id_fk" FOREIGN KEY ("person_b_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_remote_changes" ADD CONSTRAINT "splitwise_remote_changes_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_remote_changes" ADD CONSTRAINT "splitwise_remote_changes_splitwise_expense_row_id_splitwise_expenses_id_fk" FOREIGN KEY ("splitwise_expense_row_id") REFERENCES "public"."splitwise_expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_remote_changes" ADD CONSTRAINT "splitwise_remote_changes_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_remote_changes" ADD CONSTRAINT "splitwise_remote_changes_splitwise_settlement_row_id_splitwise_settlements_id_fk" FOREIGN KEY ("splitwise_settlement_row_id") REFERENCES "public"."splitwise_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_remote_changes" ADD CONSTRAINT "splitwise_remote_changes_superseded_by_change_id_splitwise_remote_changes_id_fk" FOREIGN KEY ("superseded_by_change_id") REFERENCES "public"."splitwise_remote_changes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_remote_reads" ADD CONSTRAINT "splitwise_remote_reads_external_integration_id_external_integrations_id_fk" FOREIGN KEY ("external_integration_id") REFERENCES "public"."external_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "splitwise_remote_changes_current_idx" ON "splitwise_remote_changes" USING btree ("fingerprint") WHERE "splitwise_remote_changes"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "splitwise_remote_changes_read_idx" ON "splitwise_remote_changes" USING btree ("remote_read_id");--> statement-breakpoint
CREATE INDEX "splitwise_remote_changes_status_idx" ON "splitwise_remote_changes" USING btree ("status","first_observed_at");--> statement-breakpoint
CREATE INDEX "splitwise_remote_changes_pair_idx" ON "splitwise_remote_changes" USING btree ("person_a_id","person_b_id");--> statement-breakpoint
CREATE INDEX "splitwise_remote_reads_run_at_idx" ON "splitwise_remote_reads" USING btree ("run_at");--> statement-breakpoint
ALTER TABLE "ai_inferences" ADD CONSTRAINT "ai_inferences_inference_type_check" CHECK (inference_type in ('classify_transaction', 'normalize_merchant', 'parse_receipt', 'extract_receipt_items', 'suggest_beneficiaries', 'suggest_allocation', 'group_into_occasion', 'explain_anomaly', 'propose_rule', 'plan_ledger_query'));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_entity_type_check" CHECK (entity_type in ('person', 'account', 'group', 'group_membership', 'import_batch', 'expense_occasion', 'payment', 'expense', 'expense_item', 'payment_expense_link', 'allocation', 'allocation_line', 'allocation_line_group_expansion', 'settlement', 'expense_adjustment', 'expense_adjustment_item', 'merchant', 'evidence', 'evidence_observation', 'evidence_match_candidate', 'receipt', 'ai_inference', 'rule', 'splitwise_expense', 'splitwise_settlement', 'reconciliation_run', 'reconciliation_account_snapshot', 'splitwise_audit_run', 'splitwise_audit_finding', 'splitwise_remote_read', 'splitwise_remote_change', 'proof_pack_delivery'));--> statement-breakpoint
ALTER TABLE "splitwise_expenses" ADD CONSTRAINT "splitwise_expenses_sync_status_check" CHECK (sync_status in ('pending', 'synced', 'drifted', 'stale', 'withdrawn', 'externally_deleted', 'sync_failed'));--> statement-breakpoint
ALTER TABLE "splitwise_settlements" ADD CONSTRAINT "splitwise_settlements_sync_status_check" CHECK (sync_status in ('pending', 'synced', 'drifted', 'externally_deleted', 'sync_failed'));