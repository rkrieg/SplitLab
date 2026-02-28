# SplitLab

Agency-grade A/B testing and landing page management platform. Manage multiple client workspaces, serve variant pages on custom domains, track conversions, and analyze results — all in one place.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14 (App Router) |
| Database | PostgreSQL via [Supabase](https://supabase.com) |
| Auth | NextAuth.js v4 (credentials provider) |
| Styling | Tailwind CSS |
| Storage | Supabase Storage (HTML files) |
| Deployment | Vercel |
| Code Editor | CodeMirror 6 |

---

## Quick Start

### 1. Clone and install

```bash
git clone <repo-url>
cd splitlab
npm install
```

### 2. Set up Supabase

1. Create a new project at [supabase.com](https://supabase.com)
2. In the Supabase SQL editor, run the migration file:
   ```
   supabase/migrations/001_initial_schema.sql
   ```
3. Create a storage bucket named **`pages`** (or whatever you set `SUPABASE_STORAGE_BUCKET` to)
   - Set the bucket to **public** so uploaded HTML files are publicly accessible
4. Copy your project URL, anon key, and service role key

### 3. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

```env
NEXTAUTH_SECRET=<generate with: openssl rand -base64 32>
NEXTAUTH_URL=http://localhost:3000

NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

APP_HOSTNAME=splitlab.agency          # your production domain
NEXT_PUBLIC_APP_URL=http://localhost:3000

STORAGE_PROVIDER=supabase
SUPABASE_STORAGE_BUCKET=pages

# First admin user (only used on first boot)
BOOTSTRAP_ADMIN_EMAIL=admin@youragency.com
BOOTSTRAP_ADMIN_PASSWORD=changeme123!
BOOTSTRAP_ADMIN_NAME=Agency Admin
```

### 4. Create the first admin user

```bash
npm run dev
```

Then visit: `http://localhost:3000/api/bootstrap`

This creates the first admin user from your `.env.local` bootstrap vars.
**Delete or disable this route after use.**

### 5. Log in

Visit `http://localhost:3000/login` and sign in with your bootstrap credentials.

---

## Vercel Deployment

### Deploy

```bash
npx vercel --prod
```

Or connect your GitHub repo in the Vercel dashboard and push to deploy.

### Environment variables

Add all variables from `.env.example` in the Vercel project settings under **Settings → Environment Variables**.

Set `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL` to your Vercel production URL.

### Wildcard custom domain support

SplitLab serves A/B tests on your clients' custom domains. To enable this:

1. In the **Vercel dashboard** → your project → **Settings → Domains**
2. Add a wildcard domain: `*.splitlab.agency` (replace with your domain)
3. Vercel will give you DNS records — add them to your domain registrar

The Next.js middleware automatically detects incoming requests on custom domains and routes them to the `/api/serve` handler.

---

## DNS Configuration for Client Domains

When a client wants to point their domain (e.g. `landing.clientbrand.com`) to SplitLab:

1. In SplitLab → Client → Domains → **Add Domain**
2. Instruct the client to add a **CNAME record** in their DNS:

   | Type | Name | Value |
   |---|---|---|
   | CNAME | landing (or @) | `splitlab.agency` |

3. Click **Verify DNS** after DNS propagates (up to 48 hours)
4. Once verified, the domain is live and will serve A/B tests

---

## Features Overview

### Auth & Roles
- **Admin** — full access + user management
- **Manager** — manage clients, tests, pages
- **Viewer** — read-only access

No public signup. Admins create all accounts via the Team page.

### Client Workspaces
Each client gets a workspace. Inside a workspace you manage:
- Custom domains
- HTML pages (uploaded or pasted)
- A/B tests
- Scripts (GTM, GA4, Meta Pixel, custom)

### A/B Tests
- 2–5 variants per test
- Traffic weights must sum to 100%
- Status: `draft → active → paused → completed`
- Conversion goals: form submit, button click, URL reached, call click

### Page Serving Engine
The `/api/serve` route:
1. Resolves the incoming domain → workspace
2. Finds the active test for the URL path
3. Assigns the visitor to a variant (SHA-256 hash, sticky cookie)
4. Fetches the HTML from Supabase Storage
5. Injects workspace scripts into `<head>` and before `</body>`
6. Injects the SplitLab tracking snippet (fires pageview + wires up goal listeners)
7. Returns the final HTML

### Analytics
- Per-variant views, conversions, CVR
- Chi-square confidence percentage (vs control)
- Date range filter
- CSV export
- Winning variant highlighted

---

## Project Structure

```
splitlab/
├── src/
│   ├── app/
│   │   ├── (auth)/login/          # Login page
│   │   ├── (dashboard)/           # Protected app
│   │   │   ├── dashboard/         # Agency overview
│   │   │   ├── clients/           # Client list + workspace
│   │   │   │   └── [id]/
│   │   │   │       ├── tests/     # A/B test management
│   │   │   │       │   └── [testId]/  # Analytics
│   │   │   │       ├── pages/     # Page library
│   │   │   │       ├── scripts/   # Script injection
│   │   │   │       └── domains/   # Custom domains
│   │   │   ├── team/              # User management (admin)
│   │   │   └── settings/          # Account settings
│   │   └── api/
│   │       ├── auth/[...nextauth] # NextAuth
│   │       ├── event/             # Conversion tracking
│   │       ├── serve/             # Page serving engine
│   │       ├── clients/           # Client CRUD
│   │       ├── workspaces/[id]/   # Workspace sub-resources
│   │       ├── tests/[id]/        # Test CRUD + analytics
│   │       ├── pages/[id]/        # Page CRUD
│   │       ├── upload/            # HTML file upload
│   │       ├── users/             # User management
│   │       └── bootstrap/         # First-run admin setup
│   ├── components/
│   │   ├── layout/                # Sidebar, Header
│   │   ├── ui/                    # Button, Modal, Badge, etc.
│   │   └── pages/                 # CodeEditor (CodeMirror)
│   ├── lib/
│   │   ├── auth.ts                # NextAuth config
│   │   ├── supabase.ts            # Browser Supabase client
│   │   ├── supabase-server.ts     # Server Supabase client (service role)
│   │   ├── storage.ts             # Supabase Storage helpers
│   │   ├── tracking.ts            # Script injection + tracking snippet
│   │   ├── stats.ts               # Chi-square statistics
│   │   └── utils.ts               # Shared utilities
│   ├── middleware.ts               # Domain routing + auth guard
│   └── types/index.ts             # TypeScript types
└── supabase/
    └── migrations/
        └── 001_initial_schema.sql
```

---

## Development Notes

- CodeMirror is loaded client-side only via `dynamic(() => import(...), { ssr: false })`
- The middleware detects custom domains by checking if the host is NOT the `APP_HOSTNAME` or `localhost`
- HTML is stored in Supabase Storage AND cached in the `html_content` column for fast serving
- Visitor deduplication: one pageview event per visitor per test per calendar day
- Variant assignment is deterministic: `SHA-256(visitorId:testId) mod totalWeight`
