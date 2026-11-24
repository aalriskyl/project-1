CREATE SCHEMA IF NOT EXISTS "extensions";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "extensions";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'storage' AND table_name = 'buckets'
  ) THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'public-assets',
      'public-assets',
      true,
      10485760,
      ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/avif']
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE "product_spareparts" (
	"parent_product_id" uuid NOT NULL,
	"sparepart_product_id" uuid NOT NULL,
	"note" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_spareparts_pk" PRIMARY KEY("parent_product_id","sparepart_product_id"),
	CONSTRAINT "product_spareparts_no_self_link_chk" CHECK ("product_spareparts"."parent_product_id" <> "product_spareparts"."sparepart_product_id")
);
--> statement-breakpoint
ALTER TABLE "product_spareparts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category_id" uuid NOT NULL,
	"brand_slug" varchar(64),
	"name" varchar(255) NOT NULL,
	"slug" varchar(280) NOT NULL,
	"sku" varchar(80),
	"product_type" varchar(24) DEFAULT 'equipment' NOT NULL,
	"description_md" text,
	"meta_title" varchar(160),
	"meta_description" varchar(320),
	"price_idr" bigint NOT NULL,
	"requires_quote" boolean DEFAULT false NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"primary_image_url" text,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"specs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"length_cm" numeric(10, 2),
	"width_cm" numeric(10, 2),
	"height_cm" numeric(10, 2),
	"weight_kg" numeric(10, 2),
	"rating_avg" numeric(3, 2) DEFAULT '0.00' NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("products"."name", '') || ' ' || coalesce("products"."sku", '') || ' ' || coalesce("products"."brand_slug", '') || ' ' || coalesce("products"."description_md", ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "products_non_negative_values_chk" CHECK ("products"."price_idr" >= 0 and "products"."stock" >= 0 and "products"."review_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_spareparts" ADD CONSTRAINT "product_spareparts_parent_product_id_products_id_fk" FOREIGN KEY ("parent_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_spareparts" ADD CONSTRAINT "product_spareparts_sparepart_product_id_products_id_fk" FOREIGN KEY ("sparepart_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_spareparts_sparepart_id_idx" ON "product_spareparts" USING btree ("sparepart_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_active_uidx" ON "products" USING btree ("slug") WHERE "products"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "products_sku_active_uidx" ON "products" USING btree ("sku") WHERE "products"."deleted_at" is null and "products"."sku" is not null;--> statement-breakpoint
CREATE INDEX "products_category_created_id_idx" ON "products" USING btree ("category_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "products_brand_created_id_idx" ON "products" USING btree ("brand_slug","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "products"."deleted_at" is null and "products"."brand_slug" is not null;--> statement-breakpoint
CREATE INDEX "products_featured_created_id_idx" ON "products" USING btree ("is_featured","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "products"."deleted_at" is null and "products"."is_active" = true;--> statement-breakpoint
CREATE INDEX "products_active_created_id_idx" ON "products" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "products"."deleted_at" is null and "products"."is_active" = true;--> statement-breakpoint
CREATE INDEX "products_specs_gin_idx" ON "products" USING gin ("specs" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "products_search_vector_gin_idx" ON "products" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "products_name_sku_trgm_gin_idx" ON "products" USING gin (("name" || ' ' || coalesce("sku", '')) extensions.gin_trgm_ops);