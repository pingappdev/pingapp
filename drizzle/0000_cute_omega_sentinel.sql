CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone_hmac" text,
	"phone_enc" text,
	"phone_masked" text,
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_name_length_check" CHECK (char_length("contacts"."name") between 1 and 80),
	CONSTRAINT "contacts_phone_or_address_check" CHECK ("contacts"."phone_hmac" is not null or "contacts"."address" is not null),
	CONSTRAINT "contacts_address_format_check" CHECK ("contacts"."address" is null or "contacts"."address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"recipient_phone_hmac" text NOT NULL,
	"recipient_phone_enc" text NOT NULL,
	"recipient_phone_masked" text NOT NULL,
	"recipient_user_id" uuid,
	"token_address" text NOT NULL,
	"amount_raw" numeric(78, 0) NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"sms_status" text NOT NULL,
	"transfer_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intents_code_unique" UNIQUE("code"),
	CONSTRAINT "intents_code_format_check" CHECK ("intents"."code" ~ '^[A-Za-z0-9]{10}$'),
	CONSTRAINT "intents_note_length_check" CHECK ("intents"."note" is null or char_length("intents"."note") <= 140),
	CONSTRAINT "intents_status_check" CHECK ("intents"."status" in ('pending', 'ready', 'completed', 'cancelled', 'expired')),
	CONSTRAINT "intents_sms_status_check" CHECK ("intents"."sms_status" in ('sent', 'skipped_rate_limit', 'failed', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('intent_ready', 'intent_expired', 'intent_incoming', 'transfer_received', 'transfer_failed', 'phone_claim_attempt', 'phone_claim_resolved', 'phone_removed_by_review'))
);
--> statement-breakpoint
CREATE TABLE "phone_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_hmac" text NOT NULL,
	"phone_enc" text NOT NULL,
	"phone_masked" text NOT NULL,
	"claimant_user_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "phone_claims_status_check" CHECK ("phone_claims"."status" in ('pending_review', 'approved', 'rejected', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fresh_until" timestamp with time zone,
	"user_agent" text,
	"ip_hash" text,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sms_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"phone_hmac" text NOT NULL,
	"country" text,
	"provider_msg_id" text,
	"success" boolean NOT NULL,
	"error" text,
	"price_eur" numeric(10, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_log_purpose_check" CHECK ("sms_log"."purpose" in ('otp', 'intent', 'admin_test')),
	CONSTRAINT "sms_log_country_format_check" CHECK ("sms_log"."country" is null or "sms_log"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"address" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"decimals" integer NOT NULL,
	"kind" text NOT NULL,
	"logo_url" text,
	"multiplier" numeric(38, 18) DEFAULT '1' NOT NULL,
	"rh_asset_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 1000 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tokens_address_format_check" CHECK ("tokens"."address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "tokens_kind_check" CHECK ("tokens"."kind" in ('native', 'stable', 'wrapped', 'stock'))
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_user_id" uuid,
	"sender_address" text NOT NULL,
	"recipient_address" text NOT NULL,
	"recipient_user_id" uuid,
	"recipient_phone_hmac" text,
	"recipient_phone_masked" text,
	"token_address" text NOT NULL,
	"amount_raw" numeric(78, 0) NOT NULL,
	"tx_hash" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"block_number" bigint,
	"intent_id" uuid,
	"contact_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "transfers_tx_hash_unique" UNIQUE("tx_hash"),
	CONSTRAINT "transfers_sender_address_format_check" CHECK ("transfers"."sender_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "transfers_recipient_address_format_check" CHECK ("transfers"."recipient_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "transfers_status_check" CHECK ("transfers"."status" in ('submitted', 'confirmed', 'failed', 'unverified', 'not_found'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"phone_hmac" text,
	"phone_enc" text,
	"phone_country" text,
	"phone_masked" text,
	"phone_linked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_address_unique" UNIQUE("address"),
	CONSTRAINT "users_phone_hmac_unique" UNIQUE("phone_hmac"),
	CONSTRAINT "users_address_format_check" CHECK ("users"."address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "users_display_name_length_check" CHECK (char_length("users"."display_name") <= 40),
	CONSTRAINT "users_phone_country_format_check" CHECK ("users"."phone_country" is null or "users"."phone_country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_token_address_tokens_address_fk" FOREIGN KEY ("token_address") REFERENCES "public"."tokens"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_claims" ADD CONSTRAINT "phone_claims_claimant_user_id_users_id_fk" FOREIGN KEY ("claimant_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_claims" ADD CONSTRAINT "phone_claims_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_token_address_tokens_address_fk" FOREIGN KEY ("token_address") REFERENCES "public"."tokens"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_user_created_at_idx" ON "audit_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_user_phone_hmac_unique_idx" ON "contacts" USING btree ("user_id","phone_hmac") WHERE "contacts"."phone_hmac" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_user_address_unique_idx" ON "contacts" USING btree ("user_id","address") WHERE "contacts"."address" is not null;--> statement-breakpoint
CREATE INDEX "contacts_user_id_idx" ON "contacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "intents_recipient_phone_status_idx" ON "intents" USING btree ("recipient_phone_hmac","status");--> statement-breakpoint
CREATE INDEX "intents_sender_created_at_idx" ON "intents" USING btree ("sender_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "intents_status_expires_at_idx" ON "intents" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "notifications_user_created_at_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "phone_claims_pending_unique_idx" ON "phone_claims" USING btree ("phone_hmac","claimant_user_id") WHERE "phone_claims"."status" = 'pending_review';--> statement-breakpoint
CREATE INDEX "phone_claims_phone_hmac_idx" ON "phone_claims" USING btree ("phone_hmac");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sms_log_created_at_idx" ON "sms_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sms_log_phone_created_at_idx" ON "sms_log" USING btree ("phone_hmac","created_at");--> statement-breakpoint
CREATE INDEX "transfers_sender_created_at_idx" ON "transfers" USING btree ("sender_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transfers_recipient_created_at_idx" ON "transfers" USING btree ("recipient_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transfers_status_idx" ON "transfers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "transfers_intent_id_idx" ON "transfers" USING btree ("intent_id");