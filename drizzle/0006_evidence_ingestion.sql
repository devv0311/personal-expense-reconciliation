ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_entity_type_check";--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "media_type" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "byte_size" integer;--> statement-breakpoint
CREATE INDEX "evidence_storage_ref_idx" ON "evidence" USING btree ("storage_ref");--> statement-breakpoint
CREATE INDEX "evidence_unmatched_idx" ON "evidence" USING btree ("captured_at") WHERE storage_ref is not null and linked_payment_id is null and linked_expense_id is null;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_entity_type_check" CHECK (entity_type in ('payment', 'expense', 'expense_item', 'payment_expense_link', 'allocation', 'allocation_line', 'allocation_line_group_expansion', 'settlement', 'expense_adjustment', 'merchant', 'evidence', 'receipt', 'ai_inference', 'rule', 'splitwise_expense', 'splitwise_settlement', 'reconciliation_run'));--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_media_type_check" CHECK ("evidence"."media_type" is null or media_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'));--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_stored_document_check" CHECK (("evidence"."storage_ref" is null) = ("evidence"."media_type" is null)
          and ("evidence"."storage_ref" is null) = ("evidence"."byte_size" is null));--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_byte_size_check" CHECK ("evidence"."byte_size" is null or "evidence"."byte_size" > 0);--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_content_present_check" CHECK ("evidence"."storage_ref" is not null or "evidence"."raw_text" is not null);--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_note_has_no_document_check" CHECK ("evidence"."type" <> 'manual_note' or "evidence"."storage_ref" is null);