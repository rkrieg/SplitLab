import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { resolveAssetSource, preselectAssets, findAssetSourceUrls, DEFAULT_SELECTION_CAP, MAX_ASSET_BYTES } from '@/lib/asset-source-resolver';

/**
 * List the images behind a pasted link — Drive folder, single Drive file,
 * direct image URL, or any web page.
 *
 * Listing only. Nothing is downloaded or stored here; the user picks from the
 * result and /api/pages/[id]/import-assets does the fetching. Keeping the two
 * apart is what makes a 20,000-file Drive survivable.
 */
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { url, text, workspace_id, include_images } = await request.json();

    // Two ways in: an explicit link from the picker, or a whole pasted brief to
    // scan. The scan form is what makes a Drive link inside a PRD work without
    // the user having to re-paste it somewhere else.
    let target: string | null = typeof url === 'string' && url.trim() ? url.trim() : null;
    let scannedFrom: string | null = null;
    let otherSources: string[] = [];
    if (!target && typeof text === 'string' && text.trim()) {
      const found = findAssetSourceUrls(text, { includeDirectImages: include_images === true });
      if (found.length === 0) {
        return NextResponse.json({ kind: 'none', assets: [], truncated: false, scanned: 0, error: null, preselected: [], sourceUrl: null });
      }
      target = found[0];
      scannedFrom = found[0];
      // Only the first is resolved. Two asset folders in one brief is rare, and
      // silently merging them would make it impossible to tell which folder a
      // wrong image came from — so the rest are reported, not swallowed.
      otherSources = found.slice(1);
    }
    if (!target) {
      return NextResponse.json({ error: 'url or text is required' }, { status: 400 });
    }
    if (!workspace_id || typeof workspace_id !== 'string') {
      return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
    }

    // This endpoint makes our server fetch a URL the caller chose, so it must
    // never be reachable by a viewer or a non-member — same bar as any other
    // workspace write.
    const wsRole = await resolveWorkspaceRole(workspace_id, session.user.id, session.user.role);
    if (!wsRole || wsRole === 'viewer') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const result = await resolveAssetSource(target);

    return NextResponse.json({
      ...result,
      preselected: preselectAssets(result.assets),
      sourceUrl: scannedFrom,
      otherSources,
      selectionCap: DEFAULT_SELECTION_CAP,
      maxBytes: MAX_ASSET_BYTES,
    });
  } catch (err) {
    console.error('[asset-sources/resolve]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
