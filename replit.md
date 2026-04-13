# SplitLab — Replit Environment

## Overview
SplitLab is a Next.js 14 A/B testing platform migrated from Vercel + Supabase to Replit's built-in PostgreSQL.

## Architecture

### Database
- **Provider**: Replit built-in PostgreSQL (via `DATABASE_URL` secret)
- **ORM shim**: `src/lib/db.ts` — a Supabase-compatible query builder backed by `pg`
  - Supports: `select`, `insert`, `update`, `delete`, `upsert`, `eq`/`neq`/`in`/`gte`/`lte`/`like`/`ilike`, `order`, `limit`, `single`, `count`
  - Nested relations via PostgreSQL JSON aggregation (has_many / belongs_to)
  - Storage shim (`db.storage`) replicates Supabase Storage API using local filesystem
- **Migrations**: All 7 Supabase migrations applied to Replit PostgreSQL

### Storage
- **Provider**: Local filesystem (`.html-storage/` directory)
- **URL prefix**: `/__html_storage__/`
- **Served by**: `src/app/api/serve/route.ts` (reads files from disk)
- **Shim**: `db.storage.from(bucket).upload/getPublicUrl/remove` in `src/lib/db.ts`

### Authentication
- **Provider**: NextAuth.js with credentials provider
- **Password hashing**: bcryptjs
- **Admin user**: `zubairfloat@gmail.com` / `Zubair@1122`

### Key Files
- `src/lib/db.ts` — PostgreSQL query builder + storage shim (replaces all Supabase usage)
- `src/lib/supabase-server.ts` — re-exports `{ db }` from `@/lib/db` for backward compat
- `src/lib/storage.ts` — local HTML file storage helpers
- `src/lib/auth.ts` — NextAuth configuration
- `.env.local` — all environment variables

## Running the App
- Workflow: `npm run dev` on port 5000
- App URL: determined by `REPLIT_DEV_DOMAIN` env var

## Key Relations (RELATIONS map in db.ts)
Defines FK relationships for nested query building. Both `has_many` and `belongs_to` use:
- `fk`: column in the child/junction table
- `ref`: column in the parent table
- WHERE clause always: `alias.fk = parentAlias.ref`
