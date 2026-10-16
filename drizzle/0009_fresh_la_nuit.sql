CREATE TABLE "token_eligibility_blocks" (
	"token_address" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"observed_multiplier" text,
	"review_revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_eligibility_blocks_source_check" CHECK ("token_eligibility_blocks"."source" in ('operator', 'issuer_multiplier_change')),
	CONSTRAINT "token_eligibility_blocks_reason_check" CHECK (char_length("token_eligibility_blocks"."reason") between 1 and 500),
	CONSTRAINT "token_eligibility_blocks_multiplier_check" CHECK ("token_eligibility_blocks"."observed_multiplier" is null or "token_eligibility_blocks"."observed_multiplier" ~ '^\d+(\.\d{1,18})?$')
);
--> statement-breakpoint
CREATE TABLE "token_multiplier_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"previous_multiplier" text NOT NULL,
	"current_multiplier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_multiplier_changes_previous_check" CHECK ("token_multiplier_changes"."previous_multiplier" ~ '^\d+(\.\d{1,18})?$'),
	CONSTRAINT "token_multiplier_changes_current_check" CHECK ("token_multiplier_changes"."current_multiplier" ~ '^\d+(\.\d{1,18})?$')
);
--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "multiplier_known" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "token_eligibility_blocks" ADD CONSTRAINT "token_eligibility_blocks_token_address_tokens_address_fk" FOREIGN KEY ("token_address") REFERENCES "public"."tokens"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_multiplier_changes" ADD CONSTRAINT "token_multiplier_changes_token_address_tokens_address_fk" FOREIGN KEY ("token_address") REFERENCES "public"."tokens"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "token_eligibility_blocks_chain_idx" ON "token_eligibility_blocks" USING btree ("chain_id");--> statement-breakpoint
CREATE INDEX "token_multiplier_changes_token_time_idx" ON "token_multiplier_changes" USING btree ("token_address","created_at" DESC NULLS LAST);
