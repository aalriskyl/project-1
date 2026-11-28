# Project 1 API

Stateless, versioned REST API built with **Bun**, **Hono** (`@hono/zod-openapi`), **Zod**, and **Drizzle ORM** (`postgres-js`) targeting **Supabase PostgreSQL**.

## Architecture

```text
src/
  app.ts                 # Hono OpenAPI app composition (no listen; exported for tests & RPC)
  index.ts               # Bun.serve entry point + graceful SIGTERM/SIGINT shutdown
  v1/
    routes.ts            # Central /v1 router aggregator mounting feature modules
  config/
    env.ts               # Fail-fast Zod environment validation
  db/
    client.ts            # Reusable Supavisor-safe postgres-js pool (`prepare: false`)
    migrations/          # Drizzle SQL migrations (single source of truth, RLS enabled)
    schema/              # Auth, catalog, articles, products, reviews, media references & mail outbox
  lib/
    api/                 # OpenAPI helpers, pagination, response envelope, search, status filters
    auth/                # JWT, Argon2id, hashing and ID generation
    cache/               # Redis JSON cache with tag invalidation
    integrations/        # Redis, Supabase Storage, mailer, revalidation, Google OAuth
    logging/             # Structured pino logger
    shared/              # Errors, slug/SEO helpers, asset URL policy, markdown sanitizer
  middlewares/
    auth/                # JWT authentication and admin authorization
    cache/               # Public Cache-Control / ETag middleware
    error/               # Centralized error handler
    observability/       # Request ID and request logging
    security/            # Global/auth/RFQ rate limiting
  modules/
    auth/                # Custom auth (Argon2id, HS256 JWT, refresh token rotation + family reuse revocation)
    users/               # User profile, IDOR ownership checks, cursor-based pagination
    catalog/             # Categories, inherited specs and sitemap feed
    products/            # Product catalog, compare and spareparts
    articles/            # Draft/published Markdown articles and SEO metadata
    reviews/             # Authenticated-user reviews; purchase verification is not implemented
    media/               # Signed uploads, completion verification and reference-safe cleanup
    notifications/       # Encrypted password-reset outbox, delivery leases and retries
    seo/                 # Sitemap feed, JSON-LD structured data and permanent slug redirects
    inquiries/           # Public RFQ / pre-order requests and admin workflow
  types/                 # Typed Hono `AppEnv` context variables
```

Layer boundaries strictly flow `routes → service → repository`. Services are framework-agnostic; repositories are the sole database layer.

## Getting Started

1. **Install dependencies**

   ```bash
   bun install
   ```

2. **Create a development database**

   Use a **separate** database for frontend work — never point a dev frontend at the production Supabase project. Two supported options:

   - **Supabase dev project** (recommended if you already use Supabase): create a second project, then copy its connection strings into `.env.dev` (start from `.env.dev.example`):
     - `DATABASE_URL`: **transaction pooler** (`:6543`) — used by the app; prepared statements are disabled automatically (`prepare: false`).
     - `DIRECT_URL`: **session pooler** (`:5432`, IPv4) or direct host — used **only** by `drizzle-kit` migrations.
   - **Local Postgres**: install PostgreSQL 17 (Docker Compose also provides `postgres-test`/`postgres` services) and use `postgresql://postgres:postgres@127.0.0.1:5432/project_1_dev` for both URLs.

   ```bash
   cp .env.dev.example .env.dev   # then edit the values
   ```

   Use a different `JWT_ACCESS_SECRET` from production. Redis is optional in development (in-memory rate limiting is used when `REDIS_URL` is unset).

3. **Migrate, seed, and start**

   Always pass the env file explicitly so you cannot accidentally use `.env` (production):

   ```bash
   bun --env-file=.env.dev run db:migrate
   bun --env-file=.env.dev run db:seed
   bun --env-file=.env.dev run dev
   ```

   Seed admin (override with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`): `admin@tsuzumi.test` / `dev-admin-password` from `.env.dev.example`.

   - Liveness: `GET /health`
   - Readiness: `GET /ready` (checks DB + Redis)
   - OpenAPI 3.1 spec: `GET /v1/openapi.json` — generated from Zod; every `/v1` operation documents `429`, and authenticated operations document `403`.

## Frontend development

- **Base URL:** `http://localhost:3000`; all feature routes are under `/v1`.
- **CORS:** add your frontend origin to `CORS_ORIGINS` in `.env.dev` (defaults allow `http://localhost:3000` and `http://localhost:5173`).
- **Auth:** `POST /v1/auth/register` / `login` return an access token; send it as `Authorization: Bearer <token>`. Admin routes additionally require the seeded admin account. Access tokens are short-lived; use `/v1/auth/refresh` with the refresh token.
- **Public reads:** `/v1/categories`, `/v1/products`, `/v1/products/by-id/{id}`, `/v1/products/{slug}`, `/v1/articles`, `/v1/seo/*`.
- **RFQ form:** `POST /v1/inquiries` requires an `Idempotency-Key` header. Retries with the same key return the original receipt; reusing a key with a different body returns `409`.
- **Generated clients:** the Postman collection is exported to `postman/exports/project-1-api.postman_collection.json` (62 requests).

### Deprecations

- `GET /v1/products/compare?slugs=<slug,slug>` is deprecated (RFC 8594 `Deprecation: true` and `Sunset` response headers; the parameter is flagged `deprecated` in OpenAPI). Use `?ids=<uuid,uuid>` instead: IDs survive slug renames, whereas a compare URL built from slugs breaks when a slug changes. To migrate, resolve each slug with `GET /v1/products/{slug}` (the detail response includes `id`), then pass those IDs. The `slugs` parameter will be removed after **26 Feb 2027** — removal is a breaking v1 change and will be announced separately, not shipped silently in a patch.

### SEO endpoints

- `GET /v1/seo/sitemap` — indexable slugs + `updatedAt` for `app/sitemap.ts`
- `GET /v1/seo/structured-data?type=product|category|article&slug=...` — schema.org `@graph` to inject into `<script type="application/ld+json">`
- `GET /v1/seo/redirect?type=product|category|article&slug=<old>` — permanent redirect target after a slug rename (404 when none)

`PUBLIC_SITE_URL` / `PUBLIC_SITE_NAME` control the absolute URLs in JSON-LD. When `PUBLIC_SITE_URL` is omitted, the first `CORS_ORIGINS` entry is used. Slug renames are recorded in `slug_redirects` by the admin update endpoints; the frontend should issue a 301 using the redirect lookup above.

### RFQ workflow

- `POST /v1/inquiries` — public; requires an `Idempotency-Key` header. Retries with the same key return the original receipt. Stricter rate limit (`INQUIRY_RATE_LIMIT_MAX`, default 10/window).
- `GET /v1/admin/inquiries` — paginated queue with `status` / `productId` filters (admin only).
- `PATCH /v1/admin/inquiries/{id}` — move a request to `new` / `contacted` / `closed`.

Set `INQUIRY_NOTIFICATION_EMAIL` to email new requests through the existing encrypted mail outbox; without it, requests are still stored. Run migrations `0015_chief_colossus.sql` and `0016_moaning_shinobi_shaw.sql` before deploying. Reusing an idempotency key with a different body returns `409`.

## Scripts

| Script                 | Description                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `bun run dev`          | Start server with hot reload (`bun --hot src/index.ts`)                              |
| `bun run start`        | Start production server                                                              |
| `bun test`             | Run unit & route tests (`TEST_DATABASE_URL` enables live Postgres integration suite) |
| `bun run typecheck`    | Run strict TypeScript check (`tsc --noEmit`)                                         |
| `bun run lint`         | Run ESLint + Prettier check                                                          |
| `bun run format`       | Format codebase with Prettier                                                        |
| `bun run audit`        | Audit dependencies for known vulnerabilities                                         |
| `bun run db:generate`  | Generate SQL migrations from `src/db/schema`                                         |
| `bun run db:migrate`   | Apply pending migrations via `DIRECT_URL`                                            |
| `bun run db:seed`      | Seed development data (including the admin user)                                     |
| `bun run db:refresh`   | Destructive: truncate local app tables and re-seed (`-- --yes` to confirm)           |
| `bun run db:studio`    | Launch Drizzle Studio                                                                |
| `bun run docs:openapi` | Regenerate `postman/specs/openapi.json` from the app                                 |
| `bun run docs:check`   | Fail if the OpenAPI snapshot is stale                                                |
| `bun run docs:postman` | Regenerate the Postman collection/environment exports                                |

Toolchain versions are pinned in `bun.lock` and CI (`bun 1.4.5`). The `esbuild` override to `^0.28.2` keeps drizzle-kit's bundled loader compatible with that Bun toolchain on Windows; `bun run db:migrate` in CI exercises it on every PR.

## Security Conventions

- **CORS:** explicit origin allowlist; wildcards are rejected. In development and test, `http://localhost:3000` is the default when `CORS_ORIGINS` is unset. Production requires an explicit allowlist.
- **RLS everywhere:** Every table in `public` calls `.enableRLS()` in Drizzle so Supabase's auto-exposed PostgREST Data API denies `anon` access by default.
- **Custom Auth (Option B):** Passwords hashed with `Bun.password` (`argon2id`). Access tokens are short-lived `HS256` JWTs verified with pinned `alg`, `iss`, `aud`, and `exp`. Refresh tokens are stored as SHA-256 hashes and rotated atomically; replaying an already-rotated token revokes the entire token family.
- **Authorization:** Ownership and role checks are enforced server-side in services (`UsersService.getUserById`, `UsersService.listUsers`) to prevent IDOR.
- **Rate limiting:** Production requires `REDIS_URL` and an explicit `CLIENT_IP_SOURCE`. `socket` uses Bun's connection address and ignores all forwarded headers. `trusted-proxy` requires non-empty `TRUSTED_PROXY_IPS` and resolves the client from `Forwarded` / `X-Forwarded-For` (skipping trusted hops) or an overwritten `X-Real-IP`. Configure ingress to append or overwrite these headers — never pass through client-supplied values. Redis failures are **fail-closed** by design: the API returns 503 rather than serving unmetered traffic. Monitor `RATE_LIMIT_UNAVAILABLE` and Redis health.
- **Database timeouts:** Postgres `statement_timeout` and `lock_timeout` mirror `REQUEST_TIMEOUT_MS`, so a timed-out request cannot keep a pool connection or advisory lock busy. Keep `DB_POOL_MAX * EXPECTED_MAX_REPLICAS <= 50` for Supabase transaction-pooler limits.
- **Markdown:** raw HTML and `javascript:`/`data:` links are stripped on write for article bodies, product descriptions and review comments. The frontend must still use a real Markdown sanitizer when rendering.
- **JSON-LD:** escape `<`, `>` and `&` as `\u003c`, `\u003e`, `\u0026` when interpolating API strings into `<script type="application/ld+json">`.
- **Sessions:** a concurrent refresh retry with the same token returns 401 without revoking the winning session family; true replay of an already-rotated token still revokes the family.
- **Media cleanup:** orphan claims use compare-and-swap on the lease timestamp, and both the sweep and attachment path lock each upload before deciding whether it is safe to delete or reference.
- **Caches:** product/article detail responses are cached for 60s with dependency tags; stale tag members are pruned to prevent unbounded Redis set growth.

## Media uploads

Files go directly from the client to Supabase Storage; the Hono API accepts JSON metadata, not multipart file bodies.

1. Create a **public** bucket matching `SUPABASE_STORAGE_BUCKET`. Set its maximum file size to **10 MiB (10,485,760 bytes)** or less and explicitly allow only the formats you use: `image/jpeg`, `image/png`, `image/webp`, `image/avif`. Wildcards and unrestricted MIME settings are rejected by the API. Public access allows downloads; do not create anonymous upload/update/delete policies. Objects must be immutable after upload.
2. Configure `SUPABASE_URL` and the server-only `SUPABASE_SERVICE_ROLE_KEY`.
3. As an admin, `POST /v1/admin/media/upload-url` with `folder`, `contentType`, and the **exact** `contentLengthBytes`. The API checks bucket restrictions before returning `uploadId`, `uploadUrl`, and `publicUrl`. The record is pending.
4. `PUT` the binary image to `uploadUrl` with the returned `Content-Type`. The signed token is already in the URL; do not send your API bearer token to Storage. Signed URLs are credentials: do not log them.
5. `POST /v1/admin/media/{uploadId}/complete`. The API verifies the stored size, MIME header, and bounded file signature, then marks the record verified. This endpoint is idempotent.
6. Save the returned `publicUrl` in product, category, or article content. New attachments to unknown, pending, deleting, or deleted managed objects return `409 MEDIA_NOT_VERIFIED`. Inline Markdown references are tracked too.

Signature checks identify a format; they are **not full image decoding, malware scanning, or protection against decompression bombs**. The public object URL can be downloaded before completion; completion controls attachment in this API. If uploads become untrusted, use a private quarantine bucket and a decoding/re-encoding worker before promoting assets to the public bucket.

Admin `POST /v1/admin/media/cleanup-orphans` accepts `olderThanHours` (default 24, minimum 3) and `limit` (1–500). The minimum exceeds the two-hour signed-upload lifetime so a still-valid URL cannot recreate a deleted object. Cleanup selects only unreferenced records, claims deletion transactionally, then calls Storage outside the transaction. Failed deletions retain a deleting state and are retried by the next cleanup call. `scannedCount` counts claimed orphan records, not every retained asset.

Content writes take a short advisory lock keyed by owner type + row id, so edits to different records never block each other; orphan claims use a separate short-lived sweep lock. Indexed `media_references` replace full scans of all Markdown bodies. Existing references are preserved by the additive backfill migration; legacy uploads remain unverified. An existing legacy attachment may be retained by its owner, but must pass completion before attachment to a different record. Imported assets without tracking records need an explicit import/verification step.

### Rollout and compatibility

Migration `0013_purple_silver_fox.sql` changes timestamp precision with `ALTER COLUMN ... SET DATA TYPE` on several populated tables. PostgreSQL rewrites those tables under an `ACCESS EXCLUSIVE` lock for the duration of the migration transaction, so apply it during a maintenance window on existing environments (fresh installs are unaffected by data volume). The accompanying `articles_published_at_present_chk` is added `NOT VALID`, legacy published rows without `published_at` are backfilled from `updated_at`, and the constraint is then validated, so one inconsistent legacy row cannot abort the whole migration.

Index `CREATE`/`DROP` statements in the migrations are not `CONCURRENTLY` because drizzle-kit's migrator wraps each migration in a transaction. On large populated tables, schedule those steps separately outside the migrator.

Media lifecycle writes use per-record advisory locks derived from `(owner type, row id)`, so concurrent edits to different products/categories/articles run in parallel. `claimOrphans` takes a distinct sweep lock that is held only for its short claim transaction (no Storage calls inside it). A cleanup run can still race a just-created reference; keep `MEDIA_CLEANUP_ENABLED=false` until all old replicas that could write unreferenced attachments are drained.

These are security-related behavior changes within v1: Google email matching no longer auto-links accounts; unverified new media attachments return 409; non-null review `orderId` values return 422; cleanup requires at least three hours. Update clients and Postman before rollout.

Apply the generated schema and reference-backfill migrations before deploying this version. Keep production `MEDIA_CLEANUP_ENABLED=false`. Drain all older API replicas, rerun the idempotent statements in `0007_media_reference_backfill.sql` through your controlled migration/rollout process if old replicas wrote during deployment, and verify references before enabling cleanup. Do not set legacy uploads to verified without checking Storage. Never roll back to an application version that bypasses attachment checks while cleanup is enabled.

## Google account linking

`POST /v1/auth/google` signs in an already-linked Google identity or creates a new account. If the email already exists, it returns `409 GOOGLE_LINK_REQUIRED` and does not change the account. Sign in to that account first, then call `POST /v1/auth/google/link` with its bearer token and a Google ID token for the same email. Linking rejects other users and conflicting identities; the repository checks the identity atomically. Registration currently has no email-verification flow, so registration alone does not prove email ownership.

## Password-reset delivery

Configure `RESEND_API_KEY`, `MAIL_FROM`, `APP_PUBLIC_URL`, and `MAIL_OUTBOX_ENCRYPTION_KEY` (32 random bytes encoded as 64 hex characters). Production requires the provider key, encryption key, Redis URL, and an HTTPS public URL at boot. Development without mail configuration returns `503 MAIL_NOT_CONFIGURED` for all reset requests; it does not pretend delivery succeeded.

The reset token hash and encrypted delivery payload commit in one transaction. The request returns a generic 202 for known and unknown accounts without waiting for the provider. The server polls the outbox, leases jobs across replicas, and retries with exponential backoff (5 seconds up to 5 minutes, maximum 8 attempts, bounded by token expiry). A stable provider idempotency key protects retries. Success, exhaustion, and expiry clear the encrypted payload. Logs contain delivery IDs and attempt counts, not reset URLs or recipients. Provider acceptance is not a guarantee of inbox delivery; monitor provider delivery/bounce events separately.

Keep the encryption key stable while pending jobs exist; changing it without draining or re-encrypting the outbox makes those jobs unreadable. All replicas processing the outbox must use the same key. Monitor `mail_outbox` backlog age and exhausted-delivery error logs.

## Reviews and rich text

Reviews currently require authentication and allow one review per user/product. They are immediately published and can be moderated by admins. They are **not verified purchases**: omit `orderId` or send null until an orders module can verify ownership, completion, and line items. Review mutations lock the product before changing reviews and recomputing rating totals.

`articles.related_product_ids` is a plain UUID array without a foreign key. Public article responses filter IDs whose product no longer resolves; admin responses retain them for inspection. Normalizing these links into a join table with a real FK is the durable fix.

Markdown storage does not make rendering automatically safe. The frontend must disable raw HTML or sanitize rendered HTML, reject unsafe URL schemes, and avoid rendering untrusted content with an unsanitized HTML sink. No frontend renderer is included in this repository.

## Postman and verification

Select the Local environment. For media, set `uploadContentType` and `uploadContentLengthBytes` to the actual local file, run **Create Presigned Media Upload URL**, select the file in **Upload Image From PC to Signed URL**, then run **Complete Media Upload**. Only completion sets `uploadedPublicUrl`; requesting another URL clears the previous value. **Link Google Account** overrides the Auth folder's no-auth setting with your current bearer token.

`bun run docs:openapi` regenerates `postman/specs/openapi.json` using isolated test configuration. `bun run docs:check` checks for drift. The checked-in Postman requests and the generated spec are validated in tests.

Local unit/HTTP tests: `bun run typecheck`, `bun run lint`, `bun test`. For real integration tests, start `docker compose --profile test up -d postgres-test redis`, then in PowerShell:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/project_1_test'
$env:TEST_REDIS_URL = 'redis://127.0.0.1:6379'
$env:DIRECT_URL = $env:TEST_DATABASE_URL
bun run db:migrate
bun test
```

Integration tests require a local database whose name ends in `_test`; they never target production Supabase. CI supplies real Postgres and Redis and runs migrations before tests. Without these environment variables the integration suites are skipped. HTTP tests with in-memory repositories exercise contracts but do not verify SQL or concurrency.

`bun run db:seed` seeds development data; `--only=products` selects a subset with prerequisites. `bun run db:refresh -- --yes` is destructive: it clears local application data and re-seeds. Do not point either command at production. The Docker image does not automatically run migrations; apply migrations as a separate controlled deployment step.
