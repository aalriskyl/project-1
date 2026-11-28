CREATE TABLE "slug_redirects" (
	"entity_type" varchar(16) NOT NULL,
	"old_slug" varchar(280) NOT NULL,
	"new_slug" varchar(280) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slug_redirects_pk" PRIMARY KEY("entity_type","old_slug"),
	CONSTRAINT "slug_redirects_no_self_chk" CHECK ("slug_redirects"."old_slug" <> "slug_redirects"."new_slug")
);
--> statement-breakpoint
ALTER TABLE "slug_redirects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "slug_redirects_new_slug_idx" ON "slug_redirects" USING btree ("entity_type","new_slug");