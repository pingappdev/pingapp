CREATE TABLE "claim_authorizations" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"escrow_id" text NOT NULL,
	"kind" text NOT NULL,
	"recipient_user_id" uuid,
	"recipient_address" text NOT NULL,
	"relayer_address" text NOT NULL,
	"recipient_phone_hmac" text NOT NULL,
	"phone_linked_at" timestamp with time zone,
	"deadline" timestamp with time zone NOT NULL,
	"domain_name" text NOT NULL,
	"domain_version" text NOT NULL,
	"domain_chain_id" bigint NOT NULL,
	"domain_verifying_contract" text NOT NULL,
	"typed_data_digest" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_authorizations_id_format_check" CHECK ("claim_authorizations"."escrow_id" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "claim_authorizations_kind_check" CHECK ("claim_authorizations"."kind" in ('relayed', 'self')),
	CONSTRAINT "claim_authorizations_recipient_format_check" CHECK ("claim_authorizations"."recipient_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "claim_authorizations_relayer_format_check" CHECK ("claim_authorizations"."relayer_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "claim_authorizations_phone_hmac_format_check" CHECK ("claim_authorizations"."recipient_phone_hmac" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "claim_authorizations_domain_contract_format_check" CHECK ("claim_authorizations"."domain_verifying_contract" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "claim_authorizations_digest_format_check" CHECK ("claim_authorizations"."typed_data_digest" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "claim_authorizations_escrow_signed_idx" ON "claim_authorizations" USING btree ("escrow_id","signed_at");--> statement-breakpoint
CREATE INDEX "claim_authorizations_deadline_idx" ON "claim_authorizations" USING btree ("deadline");