# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server (localhost:3000)
npm run build        # Production build (use to verify before pushing)
npm run lint         # ESLint
```

No test framework is configured. Verify changes with `npm run build`.

## Architecture

SplitLab is a multi-tenant A/B testing platform for a marketing agency. Agency staff manage clients, each with a workspace containing landing pages, tests, scripts, and custom domains.

### Request Flow for A/B Tests

1. Visitor hits `clientdomain.com/path`
2. **Middleware** (`src/middleware.ts`) detects custom domain, rewrites to `/api/serve?domain=X&path=/path`
3. **Serve route** (`src/app/api/serve/route.ts`) resolves domain → workspace → active test → assigns variant via deterministic SHA-256 hashing
4. Two variant types:
   - **HTML variants**: Fetches page HTML from Supabase Storage, injects tracking snippet + workspace scripts, returns HTML
   - **Redirect variants**: 302 redirects to external URL with `?sl_vid=VARIANT_ID`, records server-side pageview
5. **tracker.js** (`src/app/tracker.js/route.ts`) runs on destination page: resolves `sl_vid` via `/api/resolve`, stores context in localStorage, uses event delegation to capture form submits and button clicks
6. **Event route** (`src/app/api/event/route.ts`) ingests pageview/conversion events, deduplicates pageviews (one per visitor/test/day), auto-matches `goal_id` from `metadata.trigger`

### Middleware Layers (in order)

1. **Naked domain redirect**: `trysplitlab.com` → `www.trysplitlab.com` (301)
2. **Public route bypass**: `/api/event`, `/api/resolve`, `/tracker.js` get CORS headers with dynamic origin echo, skip all auth
3. **Custom domain rewrite**: Non-app hostnames rewrite to `/api/serve`
4. **Auth guard**: Dashboard routes require NextAuth JWT; `/login` redirects to `/dashboard` if logged in

### Key Patterns

- **Supabase server client** (`src/lib/supabase-server.ts`): Lazy Proxy that defers initialization — avoids build-time env var errors. All API routes use `db` from this module with `SUPABASE_SERVICE_ROLE_KEY` (RLS is disabled).
- **Variant assignment** (`src/lib/utils.ts`): `assignVariant()` uses SHA-256 of `visitorId+testId` for deterministic bucketing by `traffic_weight`.
- **Statistics** (`src/lib/stats.ts`): Chi-square 2×2 contingency test. 95%+ confidence = statistically significant winner.
- **CORS**: Handled in middleware (OPTIONS → 204) and route handlers. Uses dynamic origin echo (`request.headers.get('origin')`) with `Access-Control-Allow-Credentials: true`. No CORS headers in `next.config.js` or `vercel.json` — they conflict with dynamic origin.
- **Cookies**: `sl_visitor` (90-day visitor ID) + `sl_test_{testId}` (sticky variant assignment per test).
- **CodeMirror**: Loaded via `dynamic(() => import(...), { ssr: false })` in `src/components/pages/CodeEditor.tsx`.

### Database

Schema: `supabase/migrations/001_initial_schema.sql`

Core tables: `clients` → `workspaces` → `tests` → `test_variants` + `conversion_goals` → `events`. Also: `domains`, `pages`, `scripts`, `users`, `workspace_members`.

### Auth

NextAuth v4 with credentials provider, JWT sessions (30-day), bcrypt passwords. Roles: admin, manager, viewer. Bootstrap first admin via `/api/bootstrap`.

## Conventions

- `@/*` path alias maps to `src/`
- Server DB: `import { db } from '@/lib/supabase-server'`
- Client Supabase: `import { supabase } from '@/lib/supabase'`
- Utility classes: `import { cn } from '@/lib/utils'` (clsx + tailwind-merge)
- Dark-first Tailwind design with brand color `#3D8BDA` (custom indigo palette in `tailwind.config.js`)
- All IDs are UUIDs; table names use snake_case; status fields are string enums (draft, active, paused, completed)
- Public API routes (`/api/event`, `/api/resolve`, `/tracker.js`) must never go through auth middleware
- `NEXT_PUBLIC_APP_URL` must use `https://www.trysplitlab.com` (naked domain causes CORS preflight failures due to Vercel redirect)
