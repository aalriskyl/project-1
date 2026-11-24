# Project 1 API

Stateless, versioned REST API built with **Bun**, **Hono** (`@hono/zod-openapi`), **Zod**, and **Drizzle ORM** (`postgres-js`) targeting **Supabase PostgreSQL**.

## Architecture

```text
src/
  app.ts                 # Hono OpenAPI app composition (no listen; exported for tests & RPC)
  index.ts               # Bun.serve entry point + graceful SIGTERM/SIGINT shutdown
  config/
    env.ts               # Fail-fast Zod environment validation
  db/
    client.ts            # Reusable Supavisor-safe postgres-js pool (`prepare: false`)
    migrations/          # Drizzle SQL migrations (single source of truth, RLS enabled)
    schema/              # Drizzle table definitions (`users`, `refresh_tokens`)
  lib/                   # Shared utilities & Bun runtime adapters (id, password, crypto, jwt, errors, logger, pagination)
  middlewares/           # request-id, structured logger, rate-limit, JWT auth, error-handler
  modules/
    auth/                # Custom auth (Argon2id, HS256 JWT, refresh token rotation + family reuse revocation)
    users/               # User profile, IDOR ownership checks, cursor-based pagination
  types/                 # Typed Hono `AppEnv` context variables
```

Layer boundaries strictly flow `routes → service → repository`. Services are framework-agnostic; repositories are the sole database layer.

## Getting Started

1. **Install dependencies**

   ```bash
   bun install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   - `DATABASE_URL`: Supabase **Supavisor transaction pooler** (`:6543`). Prepared statements are disabled automatically (`prepare: false`).
   - `DIRECT_URL`: Supabase **Supavisor session pooler** (`:5432`, IPv4) or direct host (`:5432`, IPv6) — used **only** by `drizzle-kit` migrations.

3. **Run migrations & start dev server**

   ```bash
   bun run db:migrate
   bun run dev
   ```

   - Liveness: `GET /health`
   - Readiness: `GET /ready`
   - OpenAPI 3.1 Spec: `GET /v1/openapi.json`

## Scripts

| Script                | Description                                                                          |
| --------------------- | ------------------------------------------------------------------------------------ |
| `bun run dev`         | Start server with hot reload (`bun --hot src/index.ts`)                              |
| `bun run start`       | Start production server                                                              |
| `bun test`            | Run unit & route tests (`TEST_DATABASE_URL` enables live Postgres integration suite) |
| `bun run typecheck`   | Run strict TypeScript check (`tsc --noEmit`)                                         |
| `bun run lint`        | Run ESLint + Prettier check                                                          |
| `bun run format`      | Format codebase with Prettier                                                        |
| `bun run db:generate` | Generate SQL migrations from `src/db/schema`                                         |
| `bun run db:migrate`  | Apply pending migrations via `DIRECT_URL`                                            |
| `bun run db:studio`   | Launch Drizzle Studio                                                                |

## Security Conventions

- **RLS everywhere:** Every table in `public` calls `.enableRLS()` in Drizzle so Supabase's auto-exposed PostgREST Data API denies `anon` access by default.
- **Custom Auth (Option B):** Passwords hashed with `Bun.password` (`argon2id`). Access tokens are short-lived `HS256` JWTs verified with pinned `alg`, `iss`, `aud`, and `exp`. Refresh tokens are stored as SHA-256 hashes and rotated atomically; replaying an already-rotated token revokes the entire token family.
- **Authorization:** Ownership and role checks are enforced server-side in services (`UsersService.getUserById`, `UsersService.listUsers`) to prevent IDOR.
- **Horizontal scaling note:** Default rate limiting uses `InMemoryRateLimitStore` for single-instance/dev use; inject a Redis-backed `RateLimitStore` into `createApp()` when running multiple replicas.
