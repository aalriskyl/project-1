ALTER TABLE "articles" ADD COLUMN "focus_keyword" varchar(120);--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "canonical_url" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "no_index" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "og_image_url" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "focus_keyword" varchar(120);--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "canonical_url" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "no_index" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "og_image_url" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "focus_keyword" varchar(120);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "canonical_url" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "no_index" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "og_image_url" text;