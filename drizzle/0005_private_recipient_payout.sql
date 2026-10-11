ALTER TABLE "escrows" DROP CONSTRAINT "escrows_sms_status_check";--> statement-breakpoint
ALTER TABLE "escrows" ADD COLUMN "delivery_mode" text DEFAULT 'claim' NOT NULL;--> statement-breakpoint
ALTER TABLE "escrows" ADD COLUMN "recipient_ref" text;--> statement-breakpoint
ALTER TABLE "escrows" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "escrows" ADD CONSTRAINT "escrows_delivery_mode_check" CHECK ("escrows"."delivery_mode" in ('claim', 'automatic'));--> statement-breakpoint
ALTER TABLE "escrows" ADD CONSTRAINT "escrows_recipient_ref_check" CHECK ("escrows"."delivery_mode" <> 'automatic' or "escrows"."recipient_ref" is not null);--> statement-breakpoint
ALTER TABLE "escrows" ADD CONSTRAINT "escrows_sms_status_check" CHECK ("escrows"."sms_status" in ('sent', 'skipped_rate_limit', 'failed', 'disabled', 'not_required'));