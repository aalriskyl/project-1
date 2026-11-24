CREATE TABLE "media_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bucket" varchar(63) NOT NULL,
	"object_path" text NOT NULL,
	"public_url" text NOT NULL,
	"content_type" varchar(64) NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "media_uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "product_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"order_id" uuid,
	"rating" smallint NOT NULL,
	"comment" text,
	"is_published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_reviews_rating_range_chk" CHECK ("product_reviews"."rating" >= 1 and "product_reviews"."rating" <= 5)
);
--> statement-breakpoint
ALTER TABLE "product_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "google_sub" varchar(128);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" varchar(24);--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_uploads_bucket_path_uidx" ON "media_uploads" USING btree ("bucket","object_path");--> statement-breakpoint
CREATE INDEX "media_uploads_uploaded_by_idx" ON "media_uploads" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "media_uploads_sweep_created_id_idx" ON "media_uploads" USING btree ("created_at","id") WHERE "media_uploads"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_expires_idx" ON "password_reset_tokens" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_reviews_user_product_no_order_uidx" ON "product_reviews" USING btree ("user_id","product_id") WHERE "product_reviews"."order_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_reviews_order_product_uidx" ON "product_reviews" USING btree ("order_id","product_id") WHERE "product_reviews"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "product_reviews_product_pub_created_idx" ON "product_reviews" USING btree ("product_id","is_published","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "product_reviews_user_id_idx" ON "product_reviews" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_sub_uidx" ON "users" USING btree ("google_sub") WHERE "users"."google_sub" is not null;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_credential_present_chk" CHECK ("users"."password_hash" is not null or "users"."google_sub" is not null);