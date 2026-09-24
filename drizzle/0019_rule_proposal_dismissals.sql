CREATE TABLE "rule_proposal_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_key" text NOT NULL,
	"wording" text NOT NULL,
	"category" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_by" text NOT NULL,
	"reason" text NOT NULL,
	"restored_at" timestamp with time zone,
	"restored_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_proposal_dismissals_reason_check" CHECK (length(trim("rule_proposal_dismissals"."reason")) > 0),
	CONSTRAINT "rule_proposal_dismissals_actor_check" CHECK (length(trim("rule_proposal_dismissals"."dismissed_by")) > 0),
	CONSTRAINT "rule_proposal_dismissals_restored_check" CHECK (("rule_proposal_dismissals"."restored_at" is null and "rule_proposal_dismissals"."restored_by" is null)
          or ("rule_proposal_dismissals"."restored_at" is not null and length(trim("rule_proposal_dismissals"."restored_by")) > 0))
);
