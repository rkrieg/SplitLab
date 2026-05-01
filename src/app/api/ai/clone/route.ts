import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';
import { searchImages } from '@/lib/unsplash';
import { buildClonePrompt } from '@/lib/page-builder-prompts';
import { scorePage } from '@/lib/page-quality';
import { uploadHtml } from '@/lib/storage';
import { prepareHtml } from '@/lib/variant-utils';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (session.user.role !== 'admin' && session.user.role !== 'manager') {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let scrapedPageId: string;
  let instructions: string | undefined;
  let workspaceId: string;
  let clientId: string | undefined;

  try {
    const body = await request.json();
    scrapedPageId = body.scraped_page_id;
    instructions = body.instructions;
    workspaceId = body.workspace_id;
    clientId = body.client_id;
    if (!scrapedPageId || !workspaceId) throw new Error('Missing fields');
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid request. Required: scraped_page_id, workspace_id' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const { data: scrapedPage, error: scrapeErr } = await (db
    .from('scraped_pages')
    .select('*')
    .eq('id', scrapedPageId)
    .single() as unknown as Promise<{
      data: { id: string; html: string; url: string; analysis: Record<string, unknown> } | null;
      error: { message: string } | null;
    }>);

  if (scrapeErr || !scrapedPage) {
    return new Response(JSON.stringify({ error: 'Scraped page not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      function sendEvent(event: string, data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          closed = true;
        }
      }

      keepalive = setInterval(() => {
        sendEvent('keepalive', { timestamp: Date.now() });
      }, 5_000);

      try {
        sendEvent('started', { status: 'fetching_images' });

        const analysis = scrapedPage.analysis as {
          page_type?: string;
          primary_offer?: string;
          target_audience?: string;
          tone_of_voice?: string;
          cta_strategy?: string;
          color_palette?: string[];
          sections?: Array<{ type: string; content: string; position: string }>;
        };

        const searchQuery = [
          analysis.primary_offer,
          analysis.page_type,
          analysis.target_audience,
        ]
          .filter(Boolean)
          .join(' ')
          .slice(0, 200) || 'professional business';

        const imageUrls = await searchImages(searchQuery, 'other');
        sendEvent('images_fetched', { count: imageUrls.length });

        sendEvent('generating', { status: 'building_prompt' });

        const originalHtmlContext = prepareHtml(scrapedPage.html).slice(0, 30_000);

        const { system, user } = buildClonePrompt({
          originalHtmlContext,
          sourceUrl: scrapedPage.url,
          analysis,
          instructions,
          imageUrls,
        });

        sendEvent('generating', { status: 'calling_claude' });

        const claudeTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Page generation timed out. Please try again.')), 120_000)
        );

        let finalHtml = await Promise.race([
          ask(user, { system, model: 'claude-sonnet-4-20250514', maxTokens: 8192 }),
          claudeTimeout,
        ]);

        finalHtml = finalHtml.trim();

        if (finalHtml.startsWith('```')) {
          finalHtml = finalHtml.replace(/^```html?\n?/, '').replace(/\n?```$/, '');
        }
        if (!finalHtml.startsWith('<!DOCTYPE') && !finalHtml.startsWith('<html')) {
          finalHtml = '<!DOCTYPE html>\n' + finalHtml;
        }

        const htmlLower = finalHtml.toLowerCase();
        if (!htmlLower.includes('</body>') || !htmlLower.includes('</html>')) {
          if (!htmlLower.includes('</style>')) {
            finalHtml += '\n</style></head><body style="font-family:sans-serif;padding:60px 40px;text-align:center;background:#f8fafc">'
              + '<h2 style="color:#e53e3e">Generation Incomplete</h2>'
              + '<p style="color:#64748b">The page was too long. Click Regenerate.</p>'
              + '</body></html>';
          } else if (!htmlLower.includes('<body')) {
            finalHtml += '\n</head><body style="font-family:sans-serif;padding:60px 40px;text-align:center;background:#f8fafc">'
              + '<h2 style="color:#e53e3e">Generation Incomplete</h2>'
              + '<p style="color:#64748b">The page was cut short. Click Regenerate.</p>'
              + '</body></html>';
          } else if (!htmlLower.includes('</body>')) {
            finalHtml += '\n</body></html>';
          } else {
            finalHtml += '\n</html>';
          }
        }

        const quality = scorePage(finalHtml, 'other');
        sendEvent('quality_scored', { score: quality.score });

        const pageId = crypto.randomUUID();
        const storagePath = `pages/${workspaceId}/${pageId}.html`;

        const publicUrl = await uploadHtml(storagePath, finalHtml);

        const pageName = analysis.primary_offer
          ? `Clone: ${String(analysis.primary_offer).slice(0, 50)}`
          : `Cloned Page`;

        const { error: insertErr } = await db.from('pages').insert({
          id: pageId,
          workspace_id: workspaceId,
          name: pageName,
          slug: pageId,
          html_url: publicUrl,
          html_content: finalHtml.length < 500_000 ? finalHtml : null,
          status: 'active',
          prompt: instructions || `Clone of ${scrapedPage.url}`,
          vertical: 'other',
          quality_score: quality.score,
          quality_details: quality.details,
          source_type: 'ai_generated',
          version: 1,
        });

        if (insertErr) {
          throw new Error(`Failed to save page: ${insertErr.message}`);
        }

        const serveUrl = `/api/pages/${pageId}/serve`;

        sendEvent('complete', {
          page_id: pageId,
          serve_url: serveUrl,
          quality_score: quality.score,
          html: finalHtml,
          page_name: pageName,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Clone failed';
        console.error('[ai-clone] Error:', message);
        sendEvent('error', { error: message });
      } finally {
        if (keepalive) clearInterval(keepalive);
        keepalive = null;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      if (keepalive) clearInterval(keepalive);
      keepalive = null;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
