ALTER TABLE "escrows" DROP CONSTRAINT "escrows_sms_status_check";--> statement-breakpoint
ALTER TABLE "escrows" ADD COLUMN "sms_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "escrows" ADD COLUMN "sms_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "escrows" ADD CONSTRAINT "escrows_sms_status_check" CHECK ("escrows"."sms_status" in ('sent', 'skipped_rate_limit', 'failed', 'disabled', 'not_required', 'deferred_budget', 'deferred_rate_limit', 'provider_rejected', 'provider_unknown'));