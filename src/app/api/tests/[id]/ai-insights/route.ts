import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { confidencePercent } from '@/lib/stats';
import { askAI } from '@/lib/ai-client';
import { jsonrepair } from 'jsonrepair';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface VariantStat {
  id: string;
  name: string;
  isControl: boolean;
  views: number;
  uniqueVisitors: number;
  conversions: number;
  cvr: number;
  desktopCvr: number | null;
  mobileCvr: number | null;
  speedMobile: number | null;
  speedDesktop: number | null;
  confidence: number | null;
}

// Pull site-wide behavioral signals from Clarity's Data Export API (aggregate,
// last 3 days, rate-limited). Best-effort: any failure returns null so insights
// still generate from our own A/B data. NOTE: Clarity's API can't break down by
// our sl_variant tag, so this is page/site-level color, not per-variant.
async function fetchClarity(apiToken: string): Promise<{ ok: boolean; note: string; data?: unknown }> {
  try {
    const res = await fetch('https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3', {
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    if (res.status === 429) return { ok: false, note: 'Clarity rate limit reached (10/day) — behavioral data skipped this run.' };
    if (res.status === 401 || res.status === 403) return { ok: false, note: 'Clarity API token invalid — behavioral data skipped.' };
    if (!res.ok) return { ok: false, note: `Clarity API error ${res.status} — behavioral data skipped.` };
    const data = await res.json();
    return { ok: true, note: 'Includes Clarity behavioral signals (last 3 days, site-wide).', data };
  } catch {
    return { ok: false, note: 'Clarity unreachable — behavioral data skipped.' };
  }
}

async function loadTest(id: string, userId: string, role: string) {
  const { data: test } = await db.from('tests').select('id, name, url_path, workspace_id, ai_insights').eq('id', id).single();
  if (!test) return { error: 'Test not found', status: 404 as const };
  const wsRole = await resolveWorkspaceRole(test.workspace_id, userId, role);
  if (!wsRole || wsRole === 'viewer') return { error: 'Forbidden', status: 403 as const };
  return { test };
}

// GET: return cached insights (loads instantly; no model call).
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const r = await loadTest(params.id, session.user.id, session.user.role);
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ insights: (r.test as { ai_insights?: unknown }).ai_insights ?? null });
}

// POST: (re)generate insights from our per-variant stats + optional Clarity.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const r = await loadTest(params.id, session.user.id, session.user.role);
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status });
  const test = r.test as { id: string; name: string; url_path: string; workspace_id: string };

  // 1. Per-variant stats (all-time) via the same RPCs the analytics page uses.
  const [{ data: rpcStats }, { data: rpcDevice }, { data: variantRows }] = await Promise.all([
    db.rpc('test_variant_stats', { p_test_id: test.id, p_from: null, p_to: null }),
    db.rpc('test_variant_device_stats', { p_test_id: test.id, p_from: null, p_to: null }).then(res => res, () => ({ data: null })),
    db.from('test_variants').select('id, name, is_control, speed_mobile, speed_desktop, archived_at').eq('test_id', test.id),
  ]);

  const statsById = new Map<string, { views: number; unique_visitors: number; conversions: number }>();
  for (const s of (rpcStats as { variant_id: string; views: number; unique_visitors: number; conversions: number }[] | null) ?? []) {
    statsById.set(s.variant_id, { views: Number(s.views), unique_visitors: Number(s.unique_visitors), conversions: Number(s.conversions) });
  }
  const deviceById = new Map<string, { d_u: number; d_c: number; m_u: number; m_c: number }>();
  for (const d of (rpcDevice as { variant_id: string; device_type: 'mobile' | 'desktop'; unique_visitors: number; conversions: number }[] | null) ?? []) {
    const cur = deviceById.get(d.variant_id) ?? { d_u: 0, d_c: 0, m_u: 0, m_c: 0 };
    if (d.device_type === 'desktop') { cur.d_u = Number(d.unique_visitors); cur.d_c = Number(d.conversions); }
    else if (d.device_type === 'mobile') { cur.m_u = Number(d.unique_visitors); cur.m_c = Number(d.conversions); }
    deviceById.set(d.variant_id, cur);
  }

  const variants = ((variantRows as { id: string; name: string; is_control: boolean; speed_mobile: number | null; speed_desktop: number | null; archived_at: string | null }[]) ?? [])
    .filter(v => !v.archived_at);
  const control = variants.find(v => v.is_control) ?? variants[0];
  const controlStat = control ? statsById.get(control.id) : undefined;

  const stats: VariantStat[] = variants.map(v => {
    const s = statsById.get(v.id) ?? { views: 0, unique_visitors: 0, conversions: 0 };
    const dev = deviceById.get(v.id);
    const cvr = s.unique_visitors > 0 ? (s.conversions / s.unique_visitors) * 100 : 0;
    const confidence = (control && controlStat && v.id !== control.id && s.unique_visitors > 0 && controlStat.unique_visitors > 0)
      ? confidencePercent(controlStat.unique_visitors, controlStat.conversions, s.unique_visitors, s.conversions)
      : null;
    return {
      id: v.id,
      name: v.name,
      isControl: v.is_control,
      views: s.views,
      uniqueVisitors: s.unique_visitors,
      conversions: s.conversions,
      cvr: Math.round(cvr * 100) / 100,
      desktopCvr: dev && dev.d_u > 0 ? Math.round((dev.d_c / dev.d_u) * 10000) / 100 : null,
      mobileCvr: dev && dev.m_u > 0 ? Math.round((dev.m_c / dev.m_u) * 10000) / 100 : null,
      speedMobile: v.speed_mobile ?? null,
      speedDesktop: v.speed_desktop ?? null,
      confidence,
    };
  });

  const totalConversions = stats.reduce((n, s) => n + s.conversions, 0);
  const totalUnique = stats.reduce((n, s) => n + s.uniqueVisitors, 0);

  // 2. Optional Clarity behavioral signals.
  const { data: clarityInt } = await db
    .from('workspace_integrations')
    .select('config')
    .eq('workspace_id', test.workspace_id)
    .eq('type', 'clarity')
    .eq('enabled', true)
    .limit(1);
  // Per-workspace token wins; otherwise the global agency token from env.
  const clarityToken = (clarityInt?.[0]?.config as { api_token?: string } | null)?.api_token || process.env.CLARITY_API_TOKEN;
  const clarity = clarityToken ? await fetchClarity(clarityToken) : { ok: false, note: 'Clarity not connected (add a Data Export API token for behavioral signals).' };

  // 3. Ask the model for structured insights.
  const system = `You are a senior conversion-rate-optimization (CRO) analyst for SplitLab, an A/B testing platform. Given a test's per-variant results (and optional site-wide behavioral signals from Microsoft Clarity), produce clear, specific, actionable insights for a marketer.

Rules:
- Be concrete and quantitative; reference the actual numbers.
- Judge statistical confidence: 95%+ = significant; 80-94% = trending, needs more data; <80% or low sample = inconclusive. Never call a winner below 95%.
- If total conversions or visitors are very low, say the test needs more data and avoid over-claiming.
- Clarity data (when present) is SITE-WIDE and last-3-days only — it cannot be attributed to a specific variant. Use it as behavioral color (rage/dead clicks, scroll depth, JS errors), never as per-variant proof.
- Give EACH variant its own observation AND its own 1-4 recommendations, specific to that variant (adjust its traffic split, ship it, fix its slow/low-scroll page, investigate its rage clicks, add a challenger, etc.). Recommendations are per-variant, not global.
- Return one entry in "variants" for EVERY variant passed in, using its exact id and name.
- Respond with ONLY valid JSON, no markdown, matching exactly:
{"summary": string, "variants": [{"id": string, "name": string, "observation": string, "recommendations": [{"title": string, "detail": string, "priority": "high"|"medium"|"low"}]}], "clarityNote": string}`;

  const payload = {
    test: { name: test.name, path: test.url_path, totalUniqueVisitors: totalUnique, totalConversions },
    variants: stats,
    clarity: clarity.ok ? { note: clarity.note, raw: clarity.data } : { note: clarity.note },
  };

  let raw: string;
  try {
    raw = await askAI({
      system,
      messages: [{ role: 'user', content: `Analyze this test and return the JSON.\n\n${JSON.stringify(payload)}` }],
      maxTokens: 1800,
      label: 'ai-insights',
    });
  } catch {
    return NextResponse.json({ error: 'Could not generate insights right now. Try again.' }, { status: 502 });
  }

  let parsed: unknown;
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    const slice = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
    try { parsed = JSON.parse(slice); } catch { parsed = JSON.parse(jsonrepair(slice)); }
  } catch {
    return NextResponse.json({ error: 'Insights response was malformed. Try again.' }, { status: 502 });
  }

  const insights = {
    generatedAt: new Date().toISOString(),
    generatedBy: session.user.email ?? null,
    clarityUsed: clarity.ok,
    ...(parsed as Record<string, unknown>),
  };

  await db.from('tests').update({ ai_insights: insights } as never).eq('id', test.id);

  return NextResponse.json({ insights });
}
