import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { MAX_LIBRARY_IMPORT } from '@/lib/asset-source-resolver';
import { publicAssetUrl } from '@/lib/asset-proxy';
import { captionAssets, type CaptionTarget } from '@/lib/asset-captions';

/**
 * Describe the images behind a pasted link so the model can choose from all of
 * them — it does NOT download anything.
 *
 * Look first, download last. Downloading 500 files to place 15 spent storage
 * and wall-clock on 485 nobody wanted, and the old 40-file cap that made it
 * survivable is what left the model picking hero shots by filename. Captions
 * cost ~25 tokens against ~1,600 for a vision attachment, so the whole folder
 * now fits where 8 photos used to. The files themselves are fetched later, by
 * verifyAndRehostHtmlImages, for the handful that reach the page.
 */
export const maxDuration = 300;

/**
 * Stop captioning here and return what we have. The platform kills the
 * function at maxDuration with no response at all, which would lose every
 * caption already paid for.
 */
const CAPTION_BUDGET_MS = 240_000;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const startedAt = Date.now();
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
      return NextResponse.json({ error: 'No images found behind that link' }, { status: 400 });
    }

    // A ref we cannot turn into a URL cannot be captioned OR placed, so it is
    // reported rather than carried as an asset that would 404 on the page.
    const targets: CaptionTarget[] = [];
    const unusable: { name: string; reason: string }[] = [];
    for (const a of requested) {
      const url = publicAssetUrl(a.ref);
      if (!url) {
        unusable.push({ name: a.name, reason: "that link isn't usable on a page" });
        continue;
      }
      targets.push({ ref: a.ref, name: a.name, imageUrl: url });
    }

    const { results, cached, generated, skipped } = await captionAssets(targets, {
      deadlineAt: startedAt + CAPTION_BUDGET_MS,
    });

    const byRef = new Map(results.map((r) => [r.ref, r]));
    const imported = targets.map((t) => ({
      url: t.imageUrl as string,
      name: t.name,
      caption: byRef.get(t.ref)?.caption ?? null,
    }));

    console.log('[pages/import-assets] captioned', {
      requested: requested.length,
      usable: targets.length,
      cached,
      generated,
      // Not an error: SVG and other non-vision formats are still offered to the
      // model by filename, exactly as they always were.
      noPreview: skipped,
      described: imported.filter((a) => a.caption).length,
      elapsedMs: Date.now() - startedAt,
    });

    return NextResponse.json({ imported, failed: unusable });
  } catch (err) {
    console.error('[pages/import-assets]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
