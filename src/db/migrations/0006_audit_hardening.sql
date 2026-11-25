CREATE TABLE "mail_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payload" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_id" uuid,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mail_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "media_references" (
	"upload_id" uuid NOT NULL,
	"owner_type" varchar(16) NOT NULL,
	"owner_id" uuid NOT NULL,
	CONSTRAINT "media_references_upload_id_owner_type_owner_id_pk" PRIMARY KEY("upload_id","owner_type","owner_id")
);
--> statement-breakpoint
ALTER TABLE "media_references" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD COLUMN "expected_bytes" integer;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD COLUMN "deleting_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_references" ADD CONSTRAINT "media_references_upload_id_media_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_outbox_pending_idx" ON "mail_outbox" USING btree ("finished_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX "media_references_owner_idx" ON "media_references" USING btree ("owner_type","owner_id");