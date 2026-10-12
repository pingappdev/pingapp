DELETE FROM "contacts" WHERE "phone_hmac" IS NULL OR "phone_enc" IS NULL OR "phone_masked" IS NULL;--> statement-breakpoint
ALTER TABLE "contacts" DROP CONSTRAINT "contacts_phone_or_address_check";--> statement-breakpoint
ALTER TABLE "contacts" DROP CONSTRAINT "contacts_address_format_check";--> statement-breakpoint
DROP INDEX "contacts_user_address_unique_idx";--> statement-breakpoint
DROP INDEX "contacts_user_phone_hmac_unique_idx";--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "phone_hmac" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "phone_enc" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "phone_masked" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_user_phone_hmac_unique_idx" ON "contacts" USING btree ("user_id","phone_hmac");--> statement-breakpoint
ALTER TABLE "contacts" DROP COLUMN "address";