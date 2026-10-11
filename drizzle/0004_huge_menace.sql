CREATE TABLE "escrows" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"sender_user_id" uuid,
	"sender_address" text NOT NULL,
	"recipient_phone_hmac" text NOT NULL,
	"recipient_phone_enc" text NOT NULL,
	"recipient_phone_masked" text NOT NULL,
	"recipient_user_id" uuid,
	"token_address" text NOT NULL,
	"amount_raw" numeric(78, 0) NOT NULL,
	"claim_tip_wei" numeric(78, 0) NOT NULL,
	"fee_wei" numeric(78, 0) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"auth_deadline" timestamp with time zone NOT NULL,
	"note" text,
	"status" text DEFAULT 'authorized' NOT NULL,
	"sms_status" text DEFAULT 'failed' NOT NULL,
	"deposit_tx_hash" text,
	"claim_tx_hash" text,
	"refund_tx_hash" text,
	"claimed_to_address" text,
	"deposited_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "escrows_code_unique" UNIQUE("code"),
	CONSTRAINT "escrows_deposit_tx_hash_unique" UNIQUE("deposit_tx_hash"),
	CONSTRAINT "escrows_id_format_check" CHECK ("escrows"."id" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "escrows_code_format_check" CHECK ("escrows"."code" ~ '^[A-Za-z0-9]{10}$'),
	CONSTRAINT "escrows_note_length_check" CHECK ("escrows"."note" is null or char_length("escrows"."note") <= 140),
	CONSTRAINT "escrows_status_check" CHECK ("escrows"."status" in ('authorized', 'deposited', 'claiming', 'claimed', 'refunded', 'void')),
	CONSTRAINT "escrows_sms_status_check" CHECK ("escrows"."sms_status" in ('sent', 'skipped_rate_limit', 'failed', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "router_auths" (
	"id" text PRIMARY KEY NOT NULL,
	"sender_user_id" uuid,
	"sender_address" text NOT NULL,
	"recipient_user_id" uuid,
	"recipient_address" text NOT NULL,
	"recipient_phone_hmac" text NOT NULL,
	"recipient_phone_masked" text NOT NULL,
	"contact_name" text,
	"token_address" text NOT NULL,
	"amount_raw" numeric(78, 0) NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "router_auths_id_format_check" CHECK ("router_auths"."id" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_check";--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "router_id" text;--> statement-breakpoint
ALTER TABLE "escrows" ADD CONSTRAINT "escrows_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrows" ADD CONSTRAINT "escrows_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrows" ADD CONSTRAINT "escrows_token_address_tokens_address_fk" FOREIGN KEY ("token_address") REFERENCES "public"."tokens"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "router_auths" ADD CONSTRAINT "router_auths_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "router_auths" ADD CONSTRAINT "router_auths_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "router_auths" ADD CONSTRAINT "router_auths_token_address_tokens_address_fk" FOREIGN KEY ("token_address") REFERENCES "public"."tokens"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "escrows_recipient_phone_status_idx" ON "escrows" USING btree ("recipient_phone_hmac","status");--> statement-breakpoint
CREATE INDEX "escrows_sender_created_at_idx" ON "escrows" USING btree ("sender_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "escrows_status_expires_at_idx" ON "escrows" USING btree ("status","expires_at");--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_router_id_unique" UNIQUE("router_id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('intent_ready', 'intent_expired', 'intent_incoming', 'transfer_received', 'transfer_failed', 'phone_claim_attempt', 'phone_claim_resolved', 'phone_removed_by_review', 'escrow_ready', 'escrow_incoming', 'escrow_claimed', 'escrow_received', 'escrow_refunded'));