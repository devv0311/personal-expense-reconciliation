ALTER TABLE "evidence" ADD COLUMN "note_kind" text;--> statement-breakpoint
CREATE INDEX "evidence_settlement_claim_idx" ON "evidence" USING btree ("linked_expense_id") WHERE note_kind = 'settlement_claim';--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_note_kind_check" CHECK ("evidence"."note_kind" is null or note_kind in ('documentation', 'settlement_claim'));--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_note_kind_only_on_notes_check" CHECK (("evidence"."type" = 'manual_note') = ("evidence"."note_kind" is not null));