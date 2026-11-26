DROP INDEX "mail_outbox_pending_idx";--> statement-breakpoint
DROP INDEX "product_reviews_user_product_no_order_uidx";--> statement-breakpoint
DROP INDEX "product_reviews_order_product_uidx";--> statement-breakpoint
ALTER TABLE "articles" ALTER COLUMN "published_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "articles" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "articles" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "articles" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "articles" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "articles" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "product_reviews" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "product_reviews" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "product_reviews" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "product_reviews" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "product_reviews" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "token_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "mail_outbox_pending_idx" ON "mail_outbox" USING btree ("next_attempt_at") WHERE "mail_outbox"."finished_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_reviews_user_product_no_order_uidx" ON "product_reviews" USING btree ("user_id","product_id") WHERE "product_reviews"."order_id" is null and "product_reviews"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_reviews_order_product_uidx" ON "product_reviews" USING btree ("order_id","product_id") WHERE "product_reviews"."order_id" is not null and "product_reviews"."deleted_at" is null;--> statement-breakpoint
-- Add NOT VALID first so a single legacy inconsistent row cannot roll back the entire
-- migration, then repair those rows (updated_at is NOT NULL) and validate the constraint.
ALTER TABLE "articles" ADD CONSTRAINT "articles_published_at_present_chk" CHECK ("articles"."is_published" = false or "articles"."published_at" is not null) NOT VALID;--> statement-breakpoint
UPDATE "articles" SET "published_at" = "updated_at" WHERE "is_published" = true AND "published_at" is null;--> statement-breakpoint
ALTER TABLE "articles" VALIDATE CONSTRAINT "articles_published_at_present_chk";