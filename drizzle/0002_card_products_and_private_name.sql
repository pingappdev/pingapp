ALTER TABLE "cards" DROP CONSTRAINT "cards_product_check";--> statement-breakpoint
ALTER TABLE "card_profiles" ADD COLUMN "cardholder_name_enc" text;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_product_check" CHECK ("cards"."product" in ('visa', 'mastercard_standard', 'visa_us', 'mastercard'));