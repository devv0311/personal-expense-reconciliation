CREATE TABLE "proof_pack_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_person_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"body_text" text NOT NULL,
	"content_digest" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"pack_as_of" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"provider_message_id" text,
	"transport_id" text NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proof_pack_deliveries_channel_check" CHECK (channel in ('whatsapp')),
	CONSTRAINT "proof_pack_deliveries_status_check" CHECK (status in ('pending', 'sent', 'delivered', 'failed')),
	CONSTRAINT "proof_pack_deliveries_attempts_check" CHECK ("proof_pack_deliveries"."attempt_count" >= 0),
	CONSTRAINT "proof_pack_deliveries_timestamps_check" CHECK (("proof_pack_deliveries"."status" in ('sent', 'delivered')) = ("proof_pack_deliveries"."sent_at" is not null)
          and ("proof_pack_deliveries"."status" = 'delivered') = ("proof_pack_deliveries"."delivered_at" is not null)
          and ("proof_pack_deliveries"."status" <> 'failed' or "proof_pack_deliveries"."last_error" is not null))
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_entity_type_check";--> statement-breakpoint
ALTER TABLE "proof_pack_deliveries" ADD CONSTRAINT "proof_pack_deliveries_recipient_person_id_people_id_fk" FOREIGN KEY ("recipient_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proof_pack_deliveries_idempotency_unique" ON "proof_pack_deliveries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "proof_pack_deliveries_recipient_idx" ON "proof_pack_deliveries" USING btree ("recipient_person_id","created_at");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_entity_type_check" CHECK (entity_type in ('person', 'account', 'group', 'group_membership', 'import_batch', 'expense_occasion', 'payment', 'expense', 'expense_item', 'payment_expense_link', 'allocation', 'allocation_line', 'allocation_line_group_expansion', 'settlement', 'expense_adjustment', 'expense_adjustment_item', 'merchant', 'evidence', 'evidence_observation', 'evidence_match_candidate', 'receipt', 'ai_inference', 'rule', 'splitwise_expense', 'splitwise_settlement', 'reconciliation_run', 'reconciliation_account_snapshot', 'splitwise_audit_run', 'splitwise_audit_finding', 'proof_pack_delivery'));