import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { materializeAsset } from '@/lib/ai-asset-integrity';
import { toFetchableUrl, MAX_LIBRARY_IMPORT, MAX_ASSET_BYTES } from '@/lib/asset-source-resolver';

/**
 * Download the images a pasted link resolved to and re-host them on our
 * storage, so the page never depends on the client's Drive staying shared.
 *
 * This is the expensive half of the flow — /api/asset-sources/resolve lists,
 * this one spends bytes — and it is capped at MAX_LIBRARY_IMPORT per call.
 *
 * 300, not 120: the picker used to keep the list small, but a pasted folder
 * now arrives whole. MAX_LIBRARY_IMPORT (40) files at IMPORT_CONCURRENCY (5)
 * at a 20s per-file fetch timeout is ~160s worst case — past 120 the function
 * is killed mid-import and the user gets a 504 with a half-filled library.
 */
export const maxDuration = 300;

// Matches REHOST_CONCURRENCY in ai-asset-integrity: Supabase Storage's
// connection pool times out requests past the pool limit instead of queuing
// them, so firing 20 uploads at once loses images rather than slowing down.
const IMPORT_CONCURRENCY = 5;

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

const FAILURE_COPY: Record<string, string> = {
  not_http: "that link isn't downloadable",
  fetch_failed: "couldn't reach it in time",
  rate_limited:
    'Google is rate-limiting downloads right now — wait a few minutes and try again',
  not_shared: 'the file is not shared publicly',
  bad_status: 'the server refused the download',
  not_an_image: "it isn't an image file",
  // Derived, never hardcoded: this string sat at "8MB" while the real ceiling
  // was 5MB, which told users the wrong number to aim for.
  too_large: `it's over the ${Math.round(MAX_ASSET_BYTES / (1024 * 1024))}MB limit`,
  upload_failed: 'saving it failed',
};

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (session.user.role !== 'admin') {
    const ownerPlan = await resolveOwnerPlan(page.workspace_id);
    if (!PLAN_LIMITS[ownerPlan]?.aiPages) {
      return NextResponse.json(
        { error: 'AI page editing requires a Growth, Agency, or Scale plan. Please upgrade to use this feature.', limitError: true },
        { status: 403 }
      );
    }
  }

  try {
    const body = await request.json();
    const incoming = Array.isArray(body?.assets) ? body.assets : [];

    const requested: { ref: string; name: string }[] = (incoming as unknown[])
      .filter((a): a is { url: string; name?: string } =>
        !!a && typeof a === 'object' && typeof (a as { url?: unknown }).url === 'string')
      .map((a) => ({
        ref: a.url.trim(),
        name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : 'image',
      }))
      .filter((a) => a.ref.length > 0)
      .slice(0, MAX_LIBRARY_IMPORT);

    if (requested.length === 0) {
      return NextResponse.json({ error: 'No images selected' }, { status: 400 });
    }

    const results = await inBatches(requested, IMPORT_CONCURRENCY, async (asset) => {
      // Drive refs carry no key by design (see ResolvedAsset.url); the key is
      // added here, server-side, and never leaves this process.
      const fetchable = toFetchableUrl(asset.ref);
      if (!fetchable) {
        return { ok: false as const, name: asset.name, reason: 'not_http' };
      }
      const hosted = await materializeAsset({ pageSlug: params.id, url: fetchable });
      if (!hosted.ok) {
        return { ok: false as const, name: asset.name, reason: hosted.reason };
      }
      return { ok: true as const, name: asset.name, url: hosted.url };
    });

    const imported = results
      .filter((r): r is { ok: true; name: string; url: string } => r.ok)
      .map((r) => ({ url: r.url, name: r.name }));

    const failed = results
      .filter((r): r is { ok: false; name: string; reason: string } => !r.ok)
      .map((r) => ({ name: r.name, reason: FAILURE_COPY[r.reason] ?? 'it failed to download' }));

    return NextResponse.json({ imported, failed });
  } catch (err) {
    console.error('[pages/import-assets]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
