CREATE TABLE "inquiries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid,
	"name" varchar(120) NOT NULL,
	"email" varchar(254) NOT NULL,
	"phone" varchar(40),
	"message" text NOT NULL,
	"status" varchar(16) DEFAULT 'new' NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inquiries_status_chk" CHECK ("inquiries"."status" in ('new', 'contacted', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "inquiries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inquiries_idempotency_key_uidx" ON "inquiries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "inquiries_status_created_id_idx" ON "inquiries" USING btree ("status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inquiries_created_id_idx" ON "inquiries" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inquiries_product_id_idx" ON "inquiries" USING btree ("product_id");