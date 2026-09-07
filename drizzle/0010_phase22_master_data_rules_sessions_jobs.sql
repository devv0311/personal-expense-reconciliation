CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"actor" text NOT NULL,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_kind_check" CHECK (kind in ('import_bank_statement_csv', 'normalize_payments', 'classify_payments', 'extract_receipt', 'run_splitwise_audit')),
	CONSTRAINT "jobs_status_check" CHECK (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "jobs_attempts_check" CHECK ("jobs"."attempts" >= 0 and "jobs"."max_attempts" >= 1),
	CONSTRAINT "jobs_terminal_check" CHECK (("jobs"."status" in ('succeeded', 'failed', 'cancelled')) = ("jobs"."finished_at" is not null)
          and ("jobs"."status" = 'queued') = ("jobs"."started_at" is null))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sessions_expiry_check" CHECK ("sessions"."expires_at" > "sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_entity_type_check";--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "action" text DEFAULT 'set_counterparty_type' NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "effect" text DEFAULT 'propose' NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "last_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_status_scheduled_idx" ON "jobs" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_entity_type_check" CHECK (entity_type in ('person', 'account', 'group', 'group_membership', 'import_batch', 'expense_occasion', 'payment', 'expense', 'expense_item', 'payment_expense_link', 'allocation', 'allocation_line', 'allocation_line_group_expansion', 'settlement', 'expense_adjustment', 'expense_adjustment_item', 'merchant', 'evidence', 'evidence_observation', 'evidence_match_candidate', 'receipt', 'ai_inference', 'rule', 'splitwise_expense', 'splitwise_settlement', 'reconciliation_run', 'reconciliation_account_snapshot', 'splitwise_audit_run', 'splitwise_audit_finding'));--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_action_check" CHECK (action in ('set_counterparty_type', 'set_cash_flow_category', 'set_expense_category'));--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_effect_check" CHECK (effect in ('propose', 'apply'));--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_pattern_shape_check" CHECK (jsonb_typeof("rules"."match_pattern") = 'object'
          and jsonb_typeof("rules"."proposed_classification") = 'object');