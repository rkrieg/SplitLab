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
  - **Fully typed**: `db.from('tableName')` infers the correct row type automatically via `TableSchema` overloads — no manual casts needed for new queries
- **Type schema**: `src/types/database.ts` — one interface per table, maps table names to row types via `TableSchema`
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

## Key Pages
- `/` — Public marketing landing page (`src/app/LandingPage.tsx`). Redirects logged-in users to `/dashboard`. All CSS in a `<style>` tag (no Tailwind). Google Fonts loaded via `<link>` in `src/app/layout.tsx`.
- `/dashboard` — Main dashboard
- `/clients/[id]/pages` — A/B tests + AI Pages list for a workspace
- `/clients/[id]/pages/builder` — AI Page Builder (supports `?pageId=` to load an existing page)

## Plan Limits & Permissions (V2)
- `src/lib/plans.ts` — Plan definitions (Free/Pro/Agency/Scale) with limits per plan
- `src/lib/planLimits.ts` — Server-side limit checking utilities (`checkTestLimit`, `checkClientLimit`, `checkAiGenerationAllowed`)
- `src/hooks/usePlanLimit.ts` — Client-side hook for handling `plan_limit_exceeded` API errors
- `src/components/upgrade/UpgradeModal.tsx` — Upgrade prompt modal shown when limits are hit
- Limits enforced on: `POST /api/clients`, `POST /api/workspaces/[id]/tests`, `POST /api/ai/generate`
- Free plan: 1 active test, 1 client, no AI generation
- Pro ($49/mo): 10 tests, 5 clients, AI generation
- Agency ($149/mo): 50 tests, 20 clients, AI generation
- Scale ($349/mo): unlimited everything

## V2 Features (AI Page Builder)
- `src/app/api/pages/generate/route.ts` — SSE streaming page generation via Claude (`claude-sonnet-4-20250514`, maxTokens 8192, 120s timeout)
- `src/lib/page-builder-prompts.ts` — System prompts and vertical templates
- `src/lib/claude.ts` — Claude API wrapper (streaming + non-streaming)
- `src/app/api/pages/[id]/serve/route.ts` — Publicly serves AI pages (no auth). Uses `REPLIT_DEV_DOMAIN` for tracker URL.
- `src/app/api/pages/[id]/publish/route.ts` — Marks page active and sets published_url using `REPLIT_DEV_DOMAIN`
- AI Pages section in `PagesClient.tsx` fetches from `/api/workspaces/[id]/pages` and lists all builder-generated pages with View/Edit links

## Key Relations (RELATIONS map in db.ts)
Defines FK relationships for nested query building. Both `has_many` and `belongs_to` use:
- `fk`: column in the child/junction table
- `ref`: column in the parent table
- WHERE clause always: `alias.fk = parentAlias.ref`
