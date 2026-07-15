import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { isRateLimited, generatePageImages } from '@/lib/ai-client';
import { uploadHtml } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { buildHtmlFromSchema } from '@/lib/ai-page-builder';
import { createSSEStream, sendSSE, closeSSE, SSE_HEADERS } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function countImagePrompts(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  if (Array.isArray(node)) {
    return (node as unknown[]).reduce((sum: number, item) => sum + countImagePrompts(item), 0);
  }
  const obj = node as Record<string, unknown>;
  let count = 0;
  if (typeof obj.image_prompt === 'string' && obj.image_prompt && !obj.generated_image_url) count++;
  for (const val of Object.values(obj)) count += countImagePrompts(val);
  return Math.min(count, 8);
}

export async function POST(request: NextRequest) {
  // ── Pre-stream validation (can still return NextResponse.json) ─────────────

  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (isRateLimited(session.user.id, 3, 60_000) || isRateLimited(session.user.id, 15, 3_600_000)) {
    return NextResponse.json({ error: 'Too many build requests. Please wait a moment before building again.' }, { status: 429 });
  }

  let schema_json: unknown,
    slug: unknown,
    image_urls: unknown,
    user_prompt: unknown,
    workspace_id: unknown,
    competitor_screenshots: unknown,
    competitor_css_tokens: unknown,
    competitor_page_content: unknown;

  try {
    ({
      schema_json,
      slug,
      image_urls,
      user_prompt,
      workspace_id,
      competitor_screenshots,
      competitor_css_tokens,
      competitor_page_content,
    } = await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!workspace_id || typeof workspace_id !== 'string') {
    return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
  }
  const wsRole = await resolveWorkspaceRole(workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

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

  const pageSlug = (slug as string | undefined) ?? crypto.randomUUID();

  // ── Open SSE stream — no NextResponse.json after this point ───────────────

  const { stream, controller } = createSSEStream();
  const response = new Response(stream, { headers: SSE_HEADERS });

  void (async () => {
    try {
      sendSSE(controller, { type: 'status', message: 'Preparing your page...' });

      const imageCount = countImagePrompts(schema_json);
      if (imageCount > 0) {
        sendSSE(controller, {
          type: 'status',
          message: `Generating ${imageCount} image${imageCount !== 1 ? 's' : ''}...`,
        });
      }

      const enrichedSchema = await generatePageImages(
        schema_json as Record<string, unknown>,
        pageSlug,
        (url) => { sendSSE(controller, { type: 'image_ready', url }); },
      );

      if (request.signal.aborted) { closeSSE(controller); return; }

      const hasImages = Array.isArray(image_urls) && (image_urls as string[]).length > 0;

      sendSSE(controller, { type: 'status', message: 'Building HTML...' });

      let statusBuffer = '';
      let html: string;
      try {
        html = await buildHtmlFromSchema(enrichedSchema, {
          competitorScreenshots: Array.isArray(competitor_screenshots) ? competitor_screenshots as string[] : [],
          competitorCssTokens: typeof competitor_css_tokens === 'string' ? competitor_css_tokens : undefined,
          competitorPageContent: typeof competitor_page_content === 'string' ? competitor_page_content : undefined,
          userPrompt: typeof user_prompt === 'string' ? user_prompt : undefined,
          imageUrls: hasImages ? (image_urls as string[]) : [],
          onChunk: (chunk) => {
            statusBuffer += chunk;
            statusBuffer = statusBuffer.replace(
              /<!--\s*STATUS:\s*([^>]*?)-->/g,
              (_full, msg: string) => {
                sendSSE(controller, { type: 'section_status', message: msg.trim() });
                return '';
              }
            );
            if (statusBuffer.length > 200) statusBuffer = statusBuffer.slice(-100);
          },
        });
      } catch {
        sendSSE(controller, { type: 'error', message: 'AI provider returned invalid HTML' });
        closeSSE(controller);
        return;
      }

      // Strip any remaining STATUS comments before upload
      html = html.replace(/<!--\s*STATUS:[^>]*-->/g, '');

      const storagePath = `pages/${pageSlug}.html`;
      const htmlUrl = await uploadHtml(storagePath, html);

      sendSSE(controller, { type: 'done', html_url: htmlUrl, slug: pageSlug, schema_json: enrichedSchema });
      closeSSE(controller);
    } catch (err) {
      console.error('[pages/build]', err);
      sendSSE(controller, { type: 'error', message: 'Internal server error' });
      closeSSE(controller);
    }
  })();

  return response;
}
