ALTER TABLE "expenses" DROP CONSTRAINT "expenses_state_check";--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_state_check" CHECK (state in ('proposed', 'classified', 'review_required', 'approved', 'allocated', 'ready_to_sync', 'synced', 'reconciled', 'rejected'));
