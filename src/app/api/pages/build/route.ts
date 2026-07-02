import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { isRateLimited, generatePageImages } from '@/lib/ai-client';
import { uploadHtml } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { buildHtmlFromSchema } from '@/lib/ai-page-builder';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (isRateLimited(session.user.id, 3, 60_000) || isRateLimited(session.user.id, 15, 3_600_000)) {
    return NextResponse.json({ error: 'Too many build requests. Please wait a moment before building again.' }, { status: 429 });
  }

  try {
    const { schema_json, slug, image_urls, user_prompt, workspace_id, competitor_screenshots, competitor_css_tokens, competitor_page_content } = await request.json();

    if (!workspace_id || typeof workspace_id !== 'string') {
      return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
    }
    const wsRole = await resolveWorkspaceRole(workspace_id, session.user.id, session.user.role);
    if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Plan gate — check owner's plan before consuming a rate-limit slot
    if (session.user.role !== 'admin') {
      const ownerPlan = await resolveOwnerPlan(workspace_id);
      if (!PLAN_LIMITS[ownerPlan]?.aiPages) {
        return NextResponse.json(
          { error: 'AI page generation requires an Agency or Scale plan. Please upgrade to use this feature.', limitError: true },
          { status: 403 }
        );
      }
    }

    if (!schema_json || typeof schema_json !== 'object') {
      return NextResponse.json({ error: 'schema_json is required' }, { status: 400 });
    }

    const pageSlug = slug ?? crypto.randomUUID();

    // Generate images for sections that have image_prompt fields — runs before
    // HTML build so Claude can embed real URLs instead of gradient fallbacks.
    const enrichedSchema = await generatePageImages(
      schema_json as Record<string, unknown>,
      pageSlug,
    );

    const hasImages = Array.isArray(image_urls) && image_urls.length > 0;

    let html: string;
    try {
      html = await buildHtmlFromSchema(enrichedSchema, {
        competitorScreenshots: Array.isArray(competitor_screenshots) ? competitor_screenshots as string[] : [],
        competitorCssTokens: typeof competitor_css_tokens === 'string' ? competitor_css_tokens : undefined,
        competitorPageContent: typeof competitor_page_content === 'string' ? competitor_page_content : undefined,
        userPrompt: typeof user_prompt === 'string' ? user_prompt : undefined,
        imageUrls: hasImages ? (image_urls as string[]) : [],
      });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      return NextResponse.json({ error: 'AI provider returned invalid HTML', raw: msg.slice(0, 500) }, { status: 500 });
    }

    const storagePath = `pages/${pageSlug}.html`;
    const htmlUrl = await uploadHtml(storagePath, html);

    return NextResponse.json({ html_url: htmlUrl, slug: pageSlug, schema_json: enrichedSchema });
  } catch (err) {
    console.error('[pages/build]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
