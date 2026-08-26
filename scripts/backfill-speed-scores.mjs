/**
 * Backfill per-variant PageSpeed (Lighthouse) load-speed scores.
 *
 * Runs a Google PageSpeed test (mobile + desktop) for every non-archived
 * variant that has a publicly reachable URL, and writes speed_mobile /
 * speed_desktop / speed_tested_at back to test_variants. Mirrors the resolution
 * used by /api/tests/[id]/variants/[variantId]/speed-test:
 *   - redirect variants  -> their redirect_url
 *   - hosted variants    -> https://{verified domain}{url_path}?sl_vid=...&sl_scan=1
 *   - no URL             -> skipped
 *
 * Usage (from project root):
 *   node scripts/backfill-speed-scores.mjs          # only variants never tested
 *   node scripts/backfill-speed-scores.mjs --all    # re-test every variant
 *
 * Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and optional PAGESPEED_API_KEY
 * from .env.local. Requires migration 060 (speed columns) applied.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

// ── Load .env.local manually (no dotenv needed) ───────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PSI_KEY = process.env.PAGESPEED_API_KEY;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';
const RETEST_ALL = process.argv.includes('--all');

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function psiScore(url, strategy) {
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance${PSI_KEY ? `&key=${PSI_KEY}` : ''}`;
  try {
    const res = await fetch(api);
    if (!res.ok) return null;
    const data = await res.json();
    const score = data?.lighthouseResult?.categories?.performance?.score;
    return typeof score === 'number' ? Math.round(score * 100) : null;
  } catch {
    return null;
  }
}

async function resolveUrl(variant) {
  if (variant.redirect_url) return variant.redirect_url;
  if (!variant.page_id) return null;
  const wsId = variant.tests?.workspace_id;
  if (!wsId) return null;
  const vh = crypto.randomUUID();
  const p = variant.tests?.url_path || '/';
  const { data: dom } = await db
    .from('domains')
    .select('domain')
    .eq('workspace_id', wsId)
    .eq('verified', true)
    .limit(1)
    .maybeSingle();
  if (dom?.domain) {
    const sep = p.includes('?') ? '&' : '?';
    return `https://${dom.domain}${p}${sep}sl_vid=${variant.id}&sl_vh=${vh}`;
  }
  // No custom domain — use the app's own public serve URL.
  return `${APP_URL}/api/serve?preview_test_id=${variant.tests?.id || variant.test_id}&sl_vid=${variant.id}&sl_vh=${vh}`;
}

async function main() {
  let query = db
    .from('test_variants')
    .select('id, name, test_id, redirect_url, page_id, speed_tested_at, archived_at, tests!inner(id, url_path, workspace_id)')
    .is('archived_at', null);
  if (!RETEST_ALL) query = query.is('speed_tested_at', null);

  const { data: variants, error } = await query;
  if (error) { console.error('Query failed:', error.message); process.exit(1); }

  const CONCURRENCY = Number(process.env.SPEED_CONCURRENCY) || 5;
  console.log(`Found ${variants.length} variant(s) to process${RETEST_ALL ? ' (--all: re-testing everything)' : ' (untested only)'}. Concurrency ${CONCURRENCY}.`);
  if (!PSI_KEY) console.log('No PAGESPEED_API_KEY set — using anonymous quota (will rate-limit fast).');

  let tested = 0, skipped = 0, failed = 0, done = 0;

  async function processOne(v) {
    const url = await resolveUrl(v);
    if (!url) { skipped++; console.log(`  skip   ${v.name} — no public URL`); return; }
    const [m, d] = await Promise.all([psiScore(url, 'mobile'), psiScore(url, 'desktop')]);
    if (m == null && d == null) { failed++; console.log(`  fail   ${v.name} — ${url}`); return; }
    await db
      .from('test_variants')
      .update({ speed_mobile: m, speed_desktop: d, speed_tested_at: new Date().toISOString() })
      .eq('id', v.id);
    tested++;
    console.log(`  ok     ${v.name} — mobile ${m ?? '—'} / desktop ${d ?? '—'}`);
  }

  for (let i = 0; i < variants.length; i += CONCURRENCY) {
    const batch = variants.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(processOne));
    done += batch.length;
    console.log(`  … ${done}/${variants.length}`);
    await sleep(300);
  }

  console.log(`\nDone. Tested ${tested}, skipped ${skipped} (no URL), failed ${failed}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
