DROP INDEX "products_name_sku_trgm_gin_idx";--> statement-breakpoint
DROP INDEX "users_search_trgm_gin_idx";--> statement-breakpoint
CREATE INDEX "articles_related_product_ids_gin_idx" ON "articles" USING gin ("related_product_ids");--> statement-breakpoint
CREATE INDEX "product_reviews_created_id_idx" ON "product_reviews" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "products_active_price_id_idx" ON "products" USING btree ("price_idr","id") WHERE "products"."deleted_at" is null and "products"."is_active" = true;--> statement-breakpoint
CREATE INDEX "products_active_rating_id_idx" ON "products" USING btree ("rating_avg" DESC NULLS LAST,"review_count" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "products"."deleted_at" is null and "products"."is_active" = true;--> statement-breakpoint
CREATE INDEX "products_name_sku_trgm_gin_idx" ON "products" USING gin (("name" || ' ' || coalesce("sku", '') || ' ' || coalesce("brand_slug", '')) extensions.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "users_search_trgm_gin_idx" ON "users" USING gin (("display_name" || ' ' || "email" || ' ' || coalesce("phone", '') || ' ' || coalesce("address", '')) extensions.gin_trgm_ops);