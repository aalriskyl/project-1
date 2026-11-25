-- Preserve legacy tracked assets, including inline Markdown references. This is
-- deliberately conservative: a substring false positive retains an asset safely.
-- Existing uploads remain unverified; this migration makes no claims about bytes.
INSERT INTO media_references (upload_id, owner_type, owner_id)
SELECT m.id, 'categories', c.id
FROM media_uploads m JOIN categories c ON strpos(to_jsonb(c)::text, m.public_url) > 0
WHERE c.deleted_at IS NULL AND m.deleted_at IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO media_references (upload_id, owner_type, owner_id)
SELECT m.id, 'products', p.id
FROM media_uploads m JOIN products p ON strpos(to_jsonb(p)::text, m.public_url) > 0
WHERE p.deleted_at IS NULL AND m.deleted_at IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO media_references (upload_id, owner_type, owner_id)
SELECT m.id, 'articles', a.id
FROM media_uploads m JOIN articles a ON strpos(to_jsonb(a)::text, m.public_url) > 0
WHERE a.deleted_at IS NULL AND m.deleted_at IS NULL
ON CONFLICT DO NOTHING;
