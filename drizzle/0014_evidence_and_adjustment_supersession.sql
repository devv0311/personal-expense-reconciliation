DROP INDEX "evidence_unmatched_idx";--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "superseded_by_evidence_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "supersede_reason" text;--> statement-breakpoint
ALTER TABLE "expense_adjustments" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expense_adjustments" ADD COLUMN "reversal_reason" text;--> statement-breakpoint
ALTER TABLE "expense_adjustments" ADD COLUMN "reversed_by" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_superseded_by_evidence_id_evidence_id_fk" FOREIGN KEY ("superseded_by_evidence_id") REFERENCES "public"."evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_superseded_by_idx" ON "evidence" USING btree ("superseded_by_evidence_id");--> statement-breakpoint
CREATE INDEX "expense_adjustments_active_idx" ON "expense_adjustments" USING btree ("original_expense_id") WHERE reversed_at is null;--> statement-breakpoint
CREATE INDEX "evidence_unmatched_idx" ON "evidence" USING btree ("captured_at") WHERE (storage_ref is not null or type in ('bank_line', 'upi_notification')) and linked_payment_id is null and linked_expense_id is null and superseded_by_evidence_id is null;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_supersede_reason_check" CHECK (("evidence"."superseded_by_evidence_id" is null) = ("evidence"."supersede_reason" is null));--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_supersede_self_check" CHECK ("evidence"."superseded_by_evidence_id" is null or "evidence"."superseded_by_evidence_id" <> "evidence"."id");--> statement-breakpoint
ALTER TABLE "expense_adjustments" ADD CONSTRAINT "expense_adjustments_reversal_check" CHECK (("expense_adjustments"."reversed_at" is null) = ("expense_adjustments"."reversal_reason" is null)
          and ("expense_adjustments"."reversed_at" is null) = ("expense_adjustments"."reversed_by" is null));