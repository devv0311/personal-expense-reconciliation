CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"institution" text,
	"last4" text,
	"currency" text DEFAULT 'INR' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_type_check" CHECK (type in ('bank', 'upi', 'card', 'cash', 'wallet')),
	CONSTRAINT "accounts_last4_check" CHECK ("accounts"."last4" is null or "accounts"."last4" ~ '^[0-9]{1,4}$')
);
--> statement-breakpoint
CREATE TABLE "ai_inferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inference_type" text NOT NULL,
	"input_ref_type" text NOT NULL,
	"input_ref_id" uuid NOT NULL,
	"proposed_output" jsonb NOT NULL,
	"confidence" text NOT NULL,
	"model_provider" text,
	"model_name" text,
	"prompt_version" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"resulting_record_type" text,
	"resulting_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_inferences_confidence_check" CHECK (confidence in ('high', 'medium', 'low', 'unknown')),
	CONSTRAINT "ai_inferences_status_check" CHECK (status in ('pending', 'accepted', 'modified', 'rejected', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "allocation_line_group_expansions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allocation_line_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocation_line_group_expansions_amount_check" CHECK ("allocation_line_group_expansions"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "allocation_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allocation_id" uuid NOT NULL,
	"beneficiary_type" text NOT NULL,
	"beneficiary_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"percentage" numeric(5, 2),
	"expense_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocation_lines_amount_check" CHECK ("allocation_lines"."amount" >= 0),
	CONSTRAINT "allocation_lines_beneficiary_type_check" CHECK (beneficiary_type in ('person', 'group')),
	CONSTRAINT "allocation_lines_percentage_check" CHECK ("allocation_lines"."percentage" is null or ("allocation_lines"."percentage" >= 0 and "allocation_lines"."percentage" <= 100))
);
--> statement-breakpoint
CREATE TABLE "allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_id" uuid NOT NULL,
	"method" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"decided_by" text NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocations_method_check" CHECK (method in ('equal', 'exact', 'percentage', 'item_based', 'quantity_based', 'custom'))
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb NOT NULL,
	"actor" text NOT NULL,
	"source" text,
	"reason" text,
	"ai_inference_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_entity_type_check" CHECK (entity_type in ('payment', 'expense', 'expense_item', 'payment_expense_link', 'allocation', 'allocation_line', 'allocation_line_group_expansion', 'settlement', 'expense_adjustment', 'merchant', 'receipt', 'ai_inference', 'rule', 'splitwise_expense', 'splitwise_settlement', 'reconciliation_run')),
	CONSTRAINT "audit_events_action_check" CHECK (action in ('create', 'update', 'supersede', 'delete'))
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"storage_ref" text,
	"raw_text" text,
	"captured_at" timestamp with time zone NOT NULL,
	"linked_payment_id" uuid,
	"linked_expense_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_type_check" CHECK (type in ('bank_line', 'upi_notification', 'receipt_image', 'screenshot', 'email_receipt', 'manual_note'))
);
--> statement-breakpoint
CREATE TABLE "expense_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_expense_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"adjustment_payment_id" uuid,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_adjustments_amount_check" CHECK ("expense_adjustments"."amount" > 0),
	CONSTRAINT "expense_adjustments_kind_check" CHECK (kind in ('merchant_refund', 'third_party_reimbursement'))
);
--> statement-breakpoint
CREATE TABLE "expense_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount" bigint NOT NULL,
	"quantity" numeric(10, 3) DEFAULT '1' NOT NULL,
	"receipt_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_items_amount_check" CHECK ("expense_items"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "expense_occasions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"occurred_start" date NOT NULL,
	"occurred_end" date,
	"default_participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"description" text,
	"amount" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"relationship_type" text NOT NULL,
	"category" text,
	"occasion_id" uuid,
	"paid_by_person_id" uuid NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_amount_check" CHECK ("expenses"."amount" > 0),
	CONSTRAINT "expenses_relationship_type_check" CHECK (relationship_type in ('personal', 'shared', 'paid_on_behalf', 'gift', 'household_shared_flat')),
	CONSTRAINT "expenses_state_check" CHECK (state in ('proposed', 'classified', 'review_required', 'approved', 'allocated', 'ready_to_sync', 'synced', 'reconciled'))
);
--> statement-breakpoint
CREATE TABLE "external_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"external_account_ref" text,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"connected_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_integrations_type_check" CHECK (type in ('splitwise')),
	CONSTRAINT "external_integrations_status_check" CHECK (status in ('connected', 'disconnected', 'error'))
);
--> statement-breakpoint
CREATE TABLE "group_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_memberships_range_check" CHECK ("group_memberships"."left_at" is null or "group_memberships"."left_at" >= "group_memberships"."joined_at")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_channel" text NOT NULL,
	"file_reference" text,
	"content_hash" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parser_version" text,
	"row_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batches_content_hash_unique" UNIQUE("content_hash")
);
--> statement-breakpoint
CREATE TABLE "merchant_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"raw_pattern" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_aliases_raw_pattern_unique" UNIQUE("raw_pattern")
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_name" text NOT NULL,
	"default_category" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_expense_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_expense_links_amount_check" CHECK ("payment_expense_links"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"import_batch_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"direction" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"raw_description" text NOT NULL,
	"channel" text NOT NULL,
	"counterparty_type" text DEFAULT 'unknown' NOT NULL,
	"counterparty_id" uuid,
	"external_reference" text,
	"reference_type" text,
	"source_system" text,
	"state" text DEFAULT 'imported' NOT NULL,
	"ignored_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_direction_check" CHECK (direction in ('debit', 'credit')),
	CONSTRAINT "payments_channel_check" CHECK (channel in ('upi', 'bank_transfer', 'card', 'cash', 'other')),
	CONSTRAINT "payments_counterparty_type_check" CHECK (counterparty_type in ('merchant', 'person', 'internal_account', 'investment_instrument', 'unknown')),
	CONSTRAINT "payments_reference_type_check" CHECK ("payments"."reference_type" is null or reference_type in ('upi_utr', 'upi_rrn', 'bank_reference', 'card_reference', 'merchant_order_id', 'cheque_number', 'other')),
	CONSTRAINT "payments_state_check" CHECK (state in ('imported', 'normalized', 'linked', 'ignored'))
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"linked_user_id" uuid,
	"splitwise_user_id" text,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipt_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(10, 3) DEFAULT '1' NOT NULL,
	"unit_price" bigint,
	"line_total" bigint NOT NULL,
	"suggested_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_id" uuid NOT NULL,
	"merchant_id" uuid,
	"subtotal" bigint,
	"tax" bigint,
	"total" bigint,
	"currency" text DEFAULT 'INR' NOT NULL,
	"extraction_confidence" text,
	"extracted_at" timestamp with time zone,
	"confirmed_by_user" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_extraction_confidence_check" CHECK ("receipts"."extraction_confidence" is null or extraction_confidence in ('high', 'medium', 'low', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"ledger_total_outflow" bigint NOT NULL,
	"ledger_transfers_total" bigint NOT NULL,
	"ledger_investments_total" bigint NOT NULL,
	"ledger_settlements_total" bigint NOT NULL,
	"ledger_explained_total" bigint NOT NULL,
	"ledger_unexplained_total" bigint NOT NULL,
	"splitwise_balances_snapshot" jsonb,
	"discrepancies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_runs_period_check" CHECK ("reconciliation_runs"."period_end" >= "reconciliation_runs"."period_start"),
	CONSTRAINT "reconciliation_runs_unexplained_identity_check" CHECK ("reconciliation_runs"."ledger_unexplained_total" = "reconciliation_runs"."ledger_total_outflow" - "reconciliation_runs"."ledger_transfers_total" - "reconciliation_runs"."ledger_investments_total" - "reconciliation_runs"."ledger_settlements_total" - "reconciliation_runs"."ledger_explained_total")
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_pattern" jsonb NOT NULL,
	"proposed_classification" jsonb NOT NULL,
	"origin" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"times_applied" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rules_origin_check" CHECK (origin in ('manual', 'promoted_from_repeated_ai_suggestion'))
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"counterparty_person_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_amount_check" CHECK ("settlements"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "splitwise_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_id" uuid NOT NULL,
	"external_integration_id" uuid NOT NULL,
	"splitwise_expense_id" text NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	"our_snapshot" jsonb NOT NULL,
	"their_snapshot" jsonb,
	"sync_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "splitwise_expenses_sync_status_check" CHECK (sync_status in ('pending', 'synced', 'drifted', 'stale', 'sync_failed'))
);
--> statement-breakpoint
CREATE TABLE "splitwise_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"external_integration_id" uuid NOT NULL,
	"splitwise_transaction_id" text NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	"our_snapshot" jsonb NOT NULL,
	"their_snapshot" jsonb,
	"sync_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "splitwise_settlements_sync_status_check" CHECK (sync_status in ('pending', 'synced', 'drifted', 'sync_failed'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"person_id" uuid NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_line_group_expansions" ADD CONSTRAINT "allocation_line_group_expansions_allocation_line_id_allocation_lines_id_fk" FOREIGN KEY ("allocation_line_id") REFERENCES "public"."allocation_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_line_group_expansions" ADD CONSTRAINT "allocation_line_group_expansions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_lines" ADD CONSTRAINT "allocation_lines_allocation_id_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_lines" ADD CONSTRAINT "allocation_lines_expense_item_id_expense_items_id_fk" FOREIGN KEY ("expense_item_id") REFERENCES "public"."expense_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_ai_inference_id_ai_inferences_id_fk" FOREIGN KEY ("ai_inference_id") REFERENCES "public"."ai_inferences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_linked_payment_id_payments_id_fk" FOREIGN KEY ("linked_payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_linked_expense_id_expenses_id_fk" FOREIGN KEY ("linked_expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_adjustments" ADD CONSTRAINT "expense_adjustments_original_expense_id_expenses_id_fk" FOREIGN KEY ("original_expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_adjustments" ADD CONSTRAINT "expense_adjustments_adjustment_payment_id_payments_id_fk" FOREIGN KEY ("adjustment_payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_receipt_item_id_receipt_items_id_fk" FOREIGN KEY ("receipt_item_id") REFERENCES "public"."receipt_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_occasion_id_expense_occasions_id_fk" FOREIGN KEY ("occasion_id") REFERENCES "public"."expense_occasions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_paid_by_person_id_people_id_fk" FOREIGN KEY ("paid_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_integrations" ADD CONSTRAINT "external_integrations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_aliases" ADD CONSTRAINT "merchant_aliases_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_expense_links" ADD CONSTRAINT "payment_expense_links_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_expense_links" ADD CONSTRAINT "payment_expense_links_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_linked_user_id_users_id_fk" FOREIGN KEY ("linked_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_counterparty_person_id_people_id_fk" FOREIGN KEY ("counterparty_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_expenses" ADD CONSTRAINT "splitwise_expenses_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_expenses" ADD CONSTRAINT "splitwise_expenses_external_integration_id_external_integrations_id_fk" FOREIGN KEY ("external_integration_id") REFERENCES "public"."external_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_settlements" ADD CONSTRAINT "splitwise_settlements_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splitwise_settlements" ADD CONSTRAINT "splitwise_settlements_external_integration_id_external_integrations_id_fk" FOREIGN KEY ("external_integration_id") REFERENCES "public"."external_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_owner_active_idx" ON "accounts" USING btree ("owner_user_id","is_active");--> statement-breakpoint
CREATE INDEX "ai_inferences_input_idx" ON "ai_inferences" USING btree ("input_ref_type","input_ref_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_line_group_expansions_unique" ON "allocation_line_group_expansions" USING btree ("allocation_line_id","person_id");--> statement-breakpoint
CREATE INDEX "allocation_lines_allocation_idx" ON "allocation_lines" USING btree ("allocation_id");--> statement-breakpoint
CREATE INDEX "allocation_lines_beneficiary_idx" ON "allocation_lines" USING btree ("beneficiary_type","beneficiary_id");--> statement-breakpoint
CREATE INDEX "allocation_lines_expense_item_idx" ON "allocation_lines" USING btree ("expense_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "allocations_one_current_per_expense" ON "allocations" USING btree ("expense_id") WHERE "allocations"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "evidence_linked_payment_idx" ON "evidence" USING btree ("linked_payment_id");--> statement-breakpoint
CREATE INDEX "evidence_linked_expense_idx" ON "evidence" USING btree ("linked_expense_id");--> statement-breakpoint
CREATE INDEX "expense_adjustments_expense_idx" ON "expense_adjustments" USING btree ("original_expense_id");--> statement-breakpoint
CREATE INDEX "expense_items_expense_idx" ON "expense_items" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "expenses_state_idx" ON "expenses" USING btree ("state");--> statement-breakpoint
CREATE INDEX "expenses_occasion_idx" ON "expenses" USING btree ("occasion_id");--> statement-breakpoint
CREATE INDEX "expenses_paid_by_idx" ON "expenses" USING btree ("paid_by_person_id");--> statement-breakpoint
CREATE INDEX "group_memberships_lookup_idx" ON "group_memberships" USING btree ("group_id","person_id","joined_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_expense_links_unique" ON "payment_expense_links" USING btree ("payment_id","expense_id");--> statement-breakpoint
CREATE INDEX "payments_account_occurred_idx" ON "payments" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "payments_dedup_idx" ON "payments" USING btree ("amount","occurred_at","account_id");--> statement-breakpoint
CREATE INDEX "payments_external_reference_idx" ON "payments" USING btree ("external_reference") WHERE "payments"."external_reference" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "people_linked_user_id_unique" ON "people" USING btree ("linked_user_id") WHERE "people"."linked_user_id" is not null;--> statement-breakpoint
CREATE INDEX "receipt_items_receipt_idx" ON "receipt_items" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "receipts_evidence_idx" ON "receipts" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_period_idx" ON "reconciliation_runs" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE INDEX "settlements_payment_idx" ON "settlements" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "settlements_counterparty_idx" ON "settlements" USING btree ("counterparty_person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "splitwise_expenses_external_unique" ON "splitwise_expenses" USING btree ("external_integration_id","splitwise_expense_id");--> statement-breakpoint
CREATE UNIQUE INDEX "splitwise_settlements_external_unique" ON "splitwise_settlements" USING btree ("external_integration_id","splitwise_transaction_id");