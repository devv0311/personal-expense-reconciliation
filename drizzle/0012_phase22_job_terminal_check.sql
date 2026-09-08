ALTER TABLE "jobs" DROP CONSTRAINT "jobs_terminal_check";--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_terminal_check" CHECK (("jobs"."status" in ('succeeded', 'failed', 'cancelled')) = ("jobs"."finished_at" is not null)
          and ("jobs"."status" <> 'queued' or "jobs"."started_at" is null)
          and ("jobs"."status" <> 'running' or "jobs"."started_at" is not null));