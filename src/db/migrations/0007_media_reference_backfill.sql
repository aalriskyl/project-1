-- Preserve legacy tracked assets, including inline Markdown references. This is
-- deliberately conservative: a substring false positive retains an asset safely.
-- Match only text/URL-bearing columns instead of serializing entire rows to JSON, so
-- the backfill avoids comparing unrelated numeric and timestamp fields.
-- Existing uploads remain unverified; this migration makes no claims about bytes.
INSERT INTO media_references (upload_id, owner_type, owner_id)
SELECT m.id, 'categories', c.id
FROM media_uploads m JOIN categories c ON m.public_url <> '' AND (
  coalesce(c.image_url, '') like '%' || m.public_url || '%' OR
  coalesce(c.banner_image_url, '') like '%' || m.public_url || '%' OR
  coalesce(c.og_image_url, '') like '%' || m.public_url || '%' OR
  coalesce(c.description, '') like '%' || m.public_url || '%' OR
  coalesce(c.meta_description, '') like '%' || m.public_url || '%' OR
  coalesce(c.canonical_url, '') like '%' || m.public_url || '%'
)
WHERE c.deleted_at IS NULL AND m.deleted_at IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO media_references (upload_id, owner_type, owner_id)
SELECT m.id, 'products', p.id
FROM media_uploads m JOIN products p ON m.public_url <> '' AND (
  coalesce(p.primary_image_url, '') like '%' || m.public_url || '%' OR
  coalesce(p.og_image_url, '') like '%' || m.public_url || '%' OR
  coalesce(p.description_md, '') like '%' || m.public_url || '%' OR
  coalesce(p.meta_description, '') like '%' || m.public_url || '%' OR
  coalesce(p.canonical_url, '') like '%' || m.public_url || '%' OR
  p.media::text like '%' || m.public_url || '%'
)
WHERE p.deleted_at IS NULL AND m.deleted_at IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO media_references (upload_id, owner_type, owner_id)
SELECT m.id, 'articles', a.id
FROM media_uploads m JOIN articles a ON m.public_url <> '' AND (
  coalesce(a.cover_image_url, '') like '%' || m.public_url || '%' OR
  coalesce(a.og_image_url, '') like '%' || m.public_url || '%' OR
  coalesce(a.content_md, '') like '%' || m.public_url || '%' OR
  coalesce(a.excerpt, '') like '%' || m.public_url || '%' OR
  coalesce(a.meta_description, '') like '%' || m.public_url || '%' OR
  coalesce(a.canonical_url, '') like '%' || m.public_url || '%'
)
WHERE a.deleted_at IS NULL AND m.deleted_at IS NULL
ON CONFLICT DO NOTHING;
