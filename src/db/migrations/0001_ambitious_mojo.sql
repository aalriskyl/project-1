CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"author_id" uuid,
	"title" varchar(255) NOT NULL,
	"slug" varchar(280) NOT NULL,
	"excerpt" text,
	"content_md" text NOT NULL,
	"cover_image_url" text,
	"meta_title" varchar(160),
	"meta_description" varchar(320),
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"related_product_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "articles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parent_id" uuid,
	"name" varchar(120) NOT NULL,
	"slug" varchar(140) NOT NULL,
	"description" text,
	"meta_title" varchar(160),
	"meta_description" varchar(320),
	"image_url" text,
	"banner_image_url" text,
	"spec_schema" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "articles_slug_active_uidx" ON "articles" USING btree ("slug") WHERE "articles"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "articles_author_id_idx" ON "articles" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "articles_published_feed_idx" ON "articles" USING btree ("published_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "articles"."deleted_at" is null and "articles"."is_published" = true;--> statement-breakpoint
CREATE INDEX "articles_admin_created_id_idx" ON "articles" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "articles"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "articles_tags_gin_idx" ON "articles" USING gin ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_active_uidx" ON "categories" USING btree ("slug") WHERE "categories"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "categories_parent_sort_id_idx" ON "categories" USING btree ("parent_id","sort_order","id");--> statement-breakpoint
CREATE INDEX "categories_active_sort_id_idx" ON "categories" USING btree ("sort_order","id") WHERE "categories"."deleted_at" is null and "categories"."is_active" = true;