CREATE TABLE "evidence_match_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"strength" text NOT NULL,
	"confidence" text NOT NULL,
	"matched_signals" jsonb NOT NULL,
	"conflicting_signals" jsonb NOT NULL,
	"signals" jsonb NOT NULL,
	"review_reasons" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"matcher_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_match_candidates_strength_check" CHECK (strength in ('deterministic', 'probable', 'weak')),
	CONSTRAINT "evidence_match_candidates_confidence_check" CHECK (confidence in ('high', 'medium', 'low', 'unknown')),
	CONSTRAINT "evidence_match_candidates_status_check" CHECK (status in ('proposed', 'accepted', 'dismissed', 'superseded')),
	CONSTRAINT "evidence_match_candidates_decision_check" CHECK (("evidence_match_candidates"."status" in ('accepted', 'dismissed'))
            = ("evidence_match_candidates"."decided_at" is not null)
          and ("evidence_match_candidates"."status" in ('accepted', 'dismissed'))
            = ("evidence_match_candidates"."decided_by" is not null)),
	CONSTRAINT "evidence_match_candidates_signals_shape_check" CHECK (jsonb_typeof("evidence_match_candidates"."matched_signals") = 'array'
          and jsonb_typeof("evidence_match_candidates"."conflicting_signals") = 'array'
          and jsonb_typeof("evidence_match_candidates"."signals") = 'array'
          and jsonb_typeof("evidence_match_candidates"."review_reasons") = 'array'),
	CONSTRAINT "evidence_match_candidates_signal_names_check" CHECK (matched_signals <@ '["reference","amount","direction","account","time","merchant"]'::jsonb and conflicting_signals <@ '["reference","amount","direction","account","time","merchant"]'::jsonb)
);
--> statement-breakpoint
CREATE TABLE "evidence_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_id" uuid NOT NULL,
	"observed_amount" bigint,
	"observed_direction" text,
	"observed_reference" text,
	"observed_reference_normalized" text,
	"observed_reference_type" text,
	"observed_account_hint" text,
	"observed_merchant_text" text,
	"observed_occurred_at" timestamp with time zone,
	"derivation" text NOT NULL,
	"notification_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_observations_evidence_id_unique" UNIQUE("evidence_id"),
	CONSTRAINT "evidence_observations_notification_key_unique" UNIQUE("notification_key"),
	CONSTRAINT "evidence_observations_direction_check" CHECK ("evidence_observations"."observed_direction" is null or observed_direction in ('debit', 'credit')),
	CONSTRAINT "evidence_observations_reference_type_check" CHECK ("evidence_observations"."observed_reference_type" is null
          or observed_reference_type in ('upi_utr', 'upi_rrn', 'bank_reference', 'card_reference', 'merchant_order_id', 'cheque_number', 'other')),
	CONSTRAINT "evidence_observations_derivation_check" CHECK (derivation in ('caller_supplied', 'parsed_from_text')),
	CONSTRAINT "evidence_observations_amount_check" CHECK ("evidence_observations"."observed_amount" is null or "evidence_observations"."observed_amount" > 0),
	CONSTRAINT "evidence_observations_account_hint_check" CHECK ("evidence_observations"."observed_account_hint" is null or "evidence_observations"."observed_account_hint" ~ '^[0-9]{1,4}$'),
	CONSTRAINT "evidence_observations_not_empty_check" CHECK ("evidence_observations"."observed_amount" is not null
          or "evidence_observations"."observed_direction" is not null
          or "evidence_observations"."observed_reference" is not null
          or "evidence_observations"."observed_account_hint" is not null
          or "evidence_observations"."observed_merchant_text" is not null
          or "evidence_observations"."observed_occurred_at" is not null),
	CONSTRAINT "evidence_observations_reference_normalized_check" CHECK (("evidence_observations"."observed_reference" is null) = ("evidence_observations"."observed_reference_normalized" is null))
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_entity_type_check";--> statement-breakpoint
DROP INDEX "evidence_unmatched_idx";--> statement-breakpoint
ALTER TABLE "evidence_match_candidates" ADD CONSTRAINT "evidence_match_candidates_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_match_candidates" ADD CONSTRAINT "evidence_match_candidates_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_observations" ADD CONSTRAINT "evidence_observations_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_match_candidates_pair_idx" ON "evidence_match_candidates" USING btree ("evidence_id","payment_id");--> statement-breakpoint
CREATE INDEX "evidence_match_candidates_evidence_idx" ON "evidence_match_candidates" USING btree ("evidence_id","status");--> statement-breakpoint
CREATE INDEX "evidence_match_candidates_payment_idx" ON "evidence_match_candidates" USING btree ("payment_id","status");--> statement-breakpoint
CREATE INDEX "evidence_observations_reference_idx" ON "evidence_observations" USING btree ("observed_reference_normalized") WHERE "evidence_observations"."observed_reference_normalized" is not null;--> statement-breakpoint
CREATE INDEX "evidence_observations_amount_idx" ON "evidence_observations" USING btree ("observed_amount","observed_occurred_at");--> statement-breakpoint
CREATE INDEX "evidence_unmatched_idx" ON "evidence" USING btree ("captured_at") WHERE (storage_ref is not null or type in ('bank_line', 'upi_notification')) and linked_payment_id is null and linked_expense_id is null;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_entity_type_check" CHECK (entity_type in ('payment', 'expense', 'expense_item', 'payment_expense_link', 'allocation', 'allocation_line', 'allocation_line_group_expansion', 'settlement', 'expense_adjustment', 'expense_adjustment_item', 'merchant', 'evidence', 'evidence_observation', 'evidence_match_candidate', 'receipt', 'ai_inference', 'rule', 'splitwise_expense', 'splitwise_settlement', 'reconciliation_run', 'reconciliation_account_snapshot'));