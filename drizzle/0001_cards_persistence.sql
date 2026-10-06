CREATE TABLE "card_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"card_id" uuid NOT NULL,
	"provider_scope" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"request_id" uuid NOT NULL,
	"provider_idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"request_enc" text NOT NULL,
	"provider_payment_id" text,
	"provider_topup_id" text,
	"amount_usd" numeric(38, 18),
	"amount_on_card_usd" numeric(38, 18),
	"network" text NOT NULL,
	"pay_currency" text NOT NULL,
	"invoice_url" text,
	"invoice_address" text,
	"invoice_amount" numeric(38, 18),
	"invoice_expires_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"lease_token" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_operations_kind_check" CHECK ("card_operations"."kind" in ('issue', 'topup')),
	CONSTRAINT "card_operations_status_check" CHECK ("card_operations"."status" in ('created', 'submitting', 'awaiting_payment', 'processing', 'completed', 'failed', 'expired', 'review')),
	CONSTRAINT "card_operations_network_check" CHECK (("card_operations"."network", "card_operations"."pay_currency") in (('tron', 'usdttrc20'), ('bsc', 'usdtbep20'), ('ethereum', 'usdterc20'), ('polygon', 'usdtpoly')))
);
--> statement-breakpoint
CREATE TABLE "card_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"provider_scope" text NOT NULL,
	"provider_transaction_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"currency" text NOT NULL,
	"billed_usd" numeric(38, 18),
	"merchant" text,
	"direction" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source_updated_at" timestamp with time zone,
	"is_final" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_transactions_direction_check" CHECK ("card_transactions"."direction" in ('debit', 'credit'))
);
--> statement-breakpoint
CREATE TABLE "card_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_scope" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_at" timestamp with time zone,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"card_id" uuid,
	"operation_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"provider_scope" text NOT NULL,
	"provider_card_id" text,
	"client_card_ref" uuid NOT NULL,
	"product" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"issue_status" text DEFAULT 'created' NOT NULL,
	"provider_issue_status" text,
	"last4" text,
	"is_frozen" boolean,
	"balance_usd" numeric(38, 18),
	"pending_topup_usd" numeric(38, 18),
	"balance_source" text,
	"balance_as_of" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_lease_until" timestamp with time zone,
	"sync_token" uuid,
	"history_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cards_owner_scope_unique" UNIQUE("id","user_id","provider_scope"),
	CONSTRAINT "cards_id_scope_unique" UNIQUE("id","provider_scope"),
	CONSTRAINT "cards_currency_check" CHECK ("cards"."currency" = 'USD'),
	CONSTRAINT "cards_product_check" CHECK ("cards"."product" = 'visa'),
	CONSTRAINT "cards_last4_check" CHECK ("cards"."last4" is null or "cards"."last4" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
ALTER TABLE "card_operations" ADD CONSTRAINT "card_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_operations" ADD CONSTRAINT "card_operations_owner_fk" FOREIGN KEY ("card_id","user_id","provider_scope") REFERENCES "public"."cards"("id","user_id","provider_scope") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_operations" ADD CONSTRAINT "card_operations_card_fk" FOREIGN KEY ("card_id","provider_scope") REFERENCES "public"."cards"("id","provider_scope") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_profiles" ADD CONSTRAINT "card_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_card_fk" FOREIGN KEY ("card_id","provider_scope") REFERENCES "public"."cards"("id","provider_scope") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_webhook_events" ADD CONSTRAINT "card_webhook_events_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_webhook_events" ADD CONSTRAINT "card_webhook_events_operation_id_card_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."card_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_operations_request_unique" ON "card_operations" USING btree ("user_id","kind","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "card_operations_provider_key_unique" ON "card_operations" USING btree ("provider_scope","provider_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "card_operations_payment_unique" ON "card_operations" USING btree ("provider_scope","provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "card_operations_topup_unique" ON "card_operations" USING btree ("provider_scope","provider_topup_id");--> statement-breakpoint
CREATE UNIQUE INDEX "card_operations_open_unique" ON "card_operations" USING btree ("card_id") WHERE "card_operations"."status" not in ('completed', 'failed');--> statement-breakpoint
CREATE INDEX "card_operations_owner_created_idx" ON "card_operations" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "card_operations_status_attempt_idx" ON "card_operations" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "card_transactions_provider_unique" ON "card_transactions" USING btree ("provider_scope","card_id","provider_transaction_id");--> statement-breakpoint
CREATE INDEX "card_transactions_card_occurred_idx" ON "card_transactions" USING btree ("card_id","occurred_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE UNIQUE INDEX "card_webhook_events_provider_unique" ON "card_webhook_events" USING btree ("provider_scope","provider_event_id");--> statement-breakpoint
CREATE INDEX "card_webhook_events_pending_idx" ON "card_webhook_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cards_provider_id_unique" ON "cards" USING btree ("provider_scope","provider_card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cards_client_ref_unique" ON "cards" USING btree ("provider_scope","client_card_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "cards_active_slot_unique" ON "cards" USING btree ("user_id","provider_scope","product") WHERE "cards"."issue_status" <> 'failed';--> statement-breakpoint
CREATE INDEX "cards_owner_scope_idx" ON "cards" USING btree ("user_id","provider_scope");--> statement-breakpoint
CREATE INDEX "cards_next_sync_idx" ON "cards" USING btree ("next_sync_at");