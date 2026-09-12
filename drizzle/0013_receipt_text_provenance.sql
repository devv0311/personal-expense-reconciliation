ALTER TABLE "receipts" ADD COLUMN "text_source" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "text_model" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_text_source_check" CHECK ("receipts"."text_source" is null or text_source in ('evidence_raw_text', 'pdf_text_layer', 'model_vision'));--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_text_model_check" CHECK (("receipts"."text_source" is distinct from 'model_vision') = ("receipts"."text_model" is null));