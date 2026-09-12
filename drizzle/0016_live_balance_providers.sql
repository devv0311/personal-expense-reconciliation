CREATE TABLE "account_balance_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"account_provider_link_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"balance" bigint,
	"currency" text DEFAULT 'INR' NOT NULL,
	"as_of" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text,
	"read_complete" boolean NOT NULL,
	"read_incomplete_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_balance_readings_status_check" CHECK (status in ('ok', 'unavailable')),
	CONSTRAINT "account_balance_readings_shape_check" CHECK (("account_balance_readings"."status" = 'ok') = ("account_balance_readings"."balance" is not null and "account_balance_readings"."as_of" is not null)
          and ("account_balance_readings"."status" <> 'unavailable' or "account_balance_readings"."failure_reason" is not null)
          and ("account_balance_readings"."read_complete" or "account_balance_readings"."read_incomplete_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "account_provider_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"external_account_ref" text NOT NULL,
	"provider_label" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_balance_readings" ADD CONSTRAINT "account_balance_readings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_balance_readings" ADD CONSTRAINT "account_balance_readings_account_provider_link_id_account_provider_links_id_fk" FOREIGN KEY ("account_provider_link_id") REFERENCES "public"."account_provider_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_provider_links" ADD CONSTRAINT "account_provider_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_balance_readings_account_idx" ON "account_balance_readings" USING btree ("account_id","fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_links_ref_unique" ON "account_provider_links" USING btree ("provider_id","external_account_ref") WHERE archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_links_account_unique" ON "account_provider_links" USING btree ("account_id","provider_id") WHERE archived_at is null;