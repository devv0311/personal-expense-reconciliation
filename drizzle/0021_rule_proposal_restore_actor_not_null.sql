ALTER TABLE "rule_proposal_dismissals" DROP CONSTRAINT "rule_proposal_dismissals_restored_check";--> statement-breakpoint
ALTER TABLE "rule_proposal_dismissals" ADD CONSTRAINT "rule_proposal_dismissals_restored_check" CHECK (("rule_proposal_dismissals"."restored_at" is null and "rule_proposal_dismissals"."restored_by" is null)
          or ("rule_proposal_dismissals"."restored_at" is not null and "rule_proposal_dismissals"."restored_by" is not null
              and length(trim("rule_proposal_dismissals"."restored_by")) > 0));