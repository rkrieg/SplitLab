# Supabase Branching Setup (Resume Here Once Pro Plan is Active)

## Goal
Separate dev and production databases so:
- Local machine + Vercel Preview (claude branch) → Dev DB
- Vercel Production (main branch) → Prod DB

---

## Pre-requisite
Client must upgrade Supabase project to **Pro plan** ($25/month).

---

## Step 1 — Enable Branching in Supabase
1. Go to Supabase Dashboard → your SplitLab project
2. Left sidebar → **Branches**
3. Click **Enable Branching**
4. Connect your **GitHub repo** when prompted (authorize the GitHub integration)

---

## Step 2 — Create a Dev Branch
1. Click **Create Branch**
2. Name it `dev`
3. Under "Sync with a GitHub branch" → link it to `claude/ai-variant-scraper-mNeBn`
4. Click Create — Supabase creates a completely isolated database for this branch ✅

---

## Step 3 — Run Migrations on Dev Branch
1. In Supabase dashboard, **switch to the dev branch** (top left branch selector)
2. Open **SQL Editor**
3. Run all migration files in order:
   - `supabase/migrations/001_initial_schema.sql`
   - `supabase/migrations/002_...`
   - `supabase/migrations/003_...`
   - ... all the way to the latest migration
4. Dev DB now has the same schema as production ✅

---

## Step 4 — Connect Supabase to Vercel (one-time)
1. Go to **Vercel** → your SplitLab project → **Integrations**
2. Search for **Supabase** → Install
3. Authorize and link it to your Supabase project
4. Done — Vercel now auto-injects correct DB keys per deployment:
   - Preview deployments (claude branch) → dev DB keys
   - Production deployments (main) → prod DB keys
   - No more manually setting Supabase env vars twice in Vercel ✅

---

## Step 5 — Update Local `.env.local`
1. In Supabase dashboard, switch to **dev branch**
2. Go to **Settings → API**
3. Copy these 3 values:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`
4. Paste into your local `.env.local` (replaces the prod values)
5. Local dev now hits dev DB ✅

---

## Final Result

| Where | Database |
|---|---|
| Local machine | Dev DB |
| Vercel Preview (claude branch) | Dev DB |
| Vercel Production (main) | Prod DB |

---

## Notes
- The 3 Supabase env vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) are handled automatically by the Vercel-Supabase integration. Remove them from manual Vercel env var settings after setup.
- All other env vars (`NEXTAUTH_SECRET`, `STRIPE_*`, `RESEND_API_KEY`, etc.) still need to be set manually in Vercel for both Production and Preview environments.
- Dev branch DB starts empty — make sure all migrations are run (Step 3) before testing locally.
