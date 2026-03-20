import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';
import { searchImages } from '@/lib/unsplash';
import {
  buildPageGenerationPrompt,
  buildStitchDesignPrompt,
  buildRefinementPrompt,
} from '@/lib/page-builder-prompts';
import { scorePage } from '@/lib/page-quality';
import { uploadHtml } from '@/lib/storage';
import { createProject, generateScreen, downloadScreenHtml } from '@/lib/stitch';
import type { Vertical, BrandSettings } from '@/types/page-builder';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const VALID_VERTICALS: Vertical[] = [
  'legal', 'real_estate_financial', 'saas', 'local_services',
  'healthcare', 'ecommerce', 'education', 'automotive',
  'hospitality', 'fitness', 'insurance', 'nonprofit',
  'agency', 'construction', 'other',
];

function isStitchConfigured(): boolean {
  return !!process.env.STITCH_API_KEY?.trim();
}

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

  let workspaceId: string;
  let clientId: string;
  let prompt: string;
  let vertical: Vertical;
  let customVertical: string | undefined;
  let brandSettings: BrandSettings | undefined;

  try {
    const body = await request.json();
    workspaceId = body.workspace_id;
    clientId = body.client_id;
    prompt = body.prompt;
    vertical = body.vertical;
    customVertical = body.custom_vertical;
    brandSettings = body.brand_settings;

    if (!workspaceId || !prompt || !vertical) {
      throw new Error('Missing required fields');
    }
    if (!VALID_VERTICALS.includes(vertical)) {
      throw new Error('Invalid vertical');
    }
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid request. Required: workspace_id, prompt, vertical' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const useStitch = isStitchConfigured();

  // SSE stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function sendEvent(event: string, data: unknown) {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      }

      const keepalive = setInterval(() => {
        sendEvent('keepalive', { timestamp: Date.now() });
      }, 10_000);

      try {
        sendEvent('started', { status: 'fetching_images' });

        // 1. Fetch Unsplash images
        const imageUrls = await searchImages(prompt, vertical);
        sendEvent('images_fetched', { count: imageUrls.length });

        let finalHtml = '';
        let usedStitch = false;

        if (useStitch) {
          // ═══════════════════════════════════════════
          // STITCH-FIRST PIPELINE: Stitch designs → Claude refines
          // Falls back to Claude-only if Stitch fails or times out
          // ═══════════════════════════════════════════
          try {
            sendEvent('generating', { status: 'designing_with_stitch' });

            // 30s timeout for entire Stitch pipeline
            const stitchTimeout = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Stitch API timed out after 30s')), 30_000)
            );

            const stitchPipeline = async () => {
              const project = await createProject(`SplitLab - ${vertical} - ${Date.now()}`);
              const designPrompt = buildStitchDesignPrompt({
                userPrompt: prompt,
                vertical,
                brandSettings,
              });
              const result = await generateScreen(project.projectId, designPrompt);
              const screen = result.screens[0];
              if (!screen?.htmlCode?.downloadUrl) {
                throw new Error('Stitch did not return HTML');
              }
              return downloadScreenHtml(screen.htmlCode.downloadUrl);
            };

            const stitchHtml = await Promise.race([stitchPipeline(), stitchTimeout]);
            sendEvent('generating', { status: 'design_complete' });

            // Claude refines the Stitch design
            sendEvent('generating', { status: 'refining_with_claude' });
            const { system, user } = buildRefinementPrompt({
              stitchHtml,
              vertical,
              brandSettings,
              imageUrls,
            });

            const refined = await ask(user, {
              system,
              model: 'claude-sonnet-4-20250514',
              maxTokens: 16384,
            });

            finalHtml = refined.trim();
            usedStitch = true;
          } catch (stitchErr) {
            const msg = stitchErr instanceof Error ? stitchErr.message : 'Stitch failed';
            console.error('[page-generate] Stitch failed, falling back to Claude-only:', msg);
            sendEvent('generating', { status: 'stitch_fallback', message: msg });
          }
        }

        if (!usedStitch) {
          // ═══════════════════════════════════════════
          // FALLBACK: Claude-only pipeline (original behavior)
          // ═══════════════════════════════════════════

          sendEvent('generating', { status: 'building_prompt' });
          const { system, user } = buildPageGenerationPrompt({
            userPrompt: prompt,
            vertical,
            customVertical,
            brandSettings,
            imageUrls,
          });

          sendEvent('generating', { status: 'calling_claude' });
          const html = await ask(user, {
            system,
            model: 'claude-opus-4-20250514',
            maxTokens: 16384,
          });

          finalHtml = html.trim();
        }

        // 4. Validate & clean HTML
        if (finalHtml.startsWith('```')) {
          finalHtml = finalHtml.replace(/^```html?\n?/, '').replace(/\n?```$/, '');
        }
        if (!finalHtml.startsWith('<!DOCTYPE') && !finalHtml.startsWith('<html')) {
          finalHtml = '<!DOCTYPE html>\n' + finalHtml;
        }

        // 5. Score quality
        const quality = scorePage(finalHtml, vertical);
        sendEvent('quality_scored', { score: quality.score, details: quality.details });

        // 6. Create page record
        const pageId = crypto.randomUUID();
        const storagePath = `pages/${workspaceId}/${pageId}.html`;

        // 7. Upload to Supabase Storage
        const publicUrl = await uploadHtml(storagePath, finalHtml);

        // 8. Insert into pages table
        const { error: insertErr } = await db.from('pages').insert({
          id: pageId,
          workspace_id: workspaceId,
          name: `AI Page - ${customVertical || vertical}`,
          slug: pageId,
          html_url: publicUrl,
          html_content: finalHtml.length < 500_000 ? finalHtml : null,
          status: 'active',
          prompt,
          vertical,
          brand_settings: brandSettings || null,
          quality_score: quality.score,
          quality_details: quality.details,
          source_type: useStitch ? 'stitch_generated' : 'ai_generated',
          version: 1,
        });

        if (insertErr) {
          throw new Error(`Failed to save page: ${insertErr.message}`);
        }

        const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';
        const previewUrl = `${APP_URL}/api/pages/${pageId}/serve`;

        sendEvent('complete', {
          page_id: pageId,
          preview_url: previewUrl,
          storage_url: publicUrl,
          quality_score: quality.score,
          quality_details: quality.details,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Generation failed';
        const stack = err instanceof Error ? err.stack : '';
        console.error('[page-generate] Error:', message);
        console.error('[page-generate] Stack:', stack);
        sendEvent('error', { error: message });
      } finally {
        clearInterval(keepalive);
        controller.close();
      }
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
