import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { isRateLimited, generatePageImages, userFacingAIErrorMessage } from '@/lib/ai-client';
import { uploadHtml } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { buildHtmlFromSchema } from '@/lib/ai-page-builder';
import { createSSEStream, sendSSE, closeSSE, SSE_HEADERS } from '@/lib/sse';
import {
  injectBrandAssetsIntoSchema,
  forceEmbedLogoInHtml,
  forceEmbedLogoIntoSections,
  forceEmbedFooterContactInHtml,
  materializeLogoUrl,
  type FooterContact,
} from '@/lib/ai-brand-assets';
import { listSlSectionNames } from '@/lib/ai-visual-qa';
import {
  extractDesignReferenceCopy,
  isDesignReferenceAsk,
  inferDesignMatchSectionNames,
} from '@/lib/ai-follow-up-helpers';
import { forceAppendMissingDesignCopy, wantsReferenceCopy } from '@/lib/ai-content-placement';
import { verifyAndRehostHtmlImages } from '@/lib/ai-asset-integrity';
import { ensureClickToEditFields } from '@/lib/ai-data-field-stamp';
import {
  extractRequirements,
  enforceRequirements,
  checkRequirements,
  describeUnmet,
  parseModelRequirements,
  mergeRequirements,
} from '@/lib/ai-page-requirements';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

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
    competitor_page_content: unknown,
    competitor_logo_url: unknown,
    competitor_logo_svg: unknown,
    competitor_footer_contact: unknown,
    design_copy_lines: unknown,
    reuse_reference_copy: unknown,
    design_reference: unknown,
    model_requirements: unknown;

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
      competitor_logo_url,
      competitor_logo_svg,
      competitor_footer_contact,
      design_copy_lines,
      reuse_reference_copy,
      design_reference,
      requirements: model_requirements,
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
        { error: 'AI page generation requires a Growth, Agency, or Scale plan. Please upgrade to use this feature.', limitError: true },
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

      const logoSvg =
        typeof competitor_logo_svg === 'string' && competitor_logo_svg.trim().startsWith('<svg')
          ? competitor_logo_svg.trim()
          : null;
      let logoUrl =
        typeof competitor_logo_url === 'string' && competitor_logo_url.trim()
          ? competitor_logo_url.trim()
          : typeof (schema_json as Record<string, unknown>).brand_logo_url === 'string'
            ? ((schema_json as Record<string, unknown>).brand_logo_url as string)
            : null;
      // Host inline SVG so <img src> works everywhere (create path)
      logoUrl = await materializeLogoUrl({
        pageSlug,
        logoUrl,
        logoSvg,
      });

      const footerContact =
        competitor_footer_contact && typeof competitor_footer_contact === 'object'
          ? (competitor_footer_contact as FooterContact)
          : null;

      let workingSchema = schema_json as Record<string, unknown>;
      if (logoUrl || footerContact) {
        workingSchema = injectBrandAssetsIntoSchema(workingSchema, {
          logoUrl,
          footer: footerContact,
        });
      }

      const enrichedSchema = await generatePageImages(
        workingSchema,
        pageSlug,
        (url) => { sendSSE(controller, { type: 'image_ready', url }); },
      );

      if (request.signal.aborted) { closeSSE(controller); return; }

      const hasImages = Array.isArray(image_urls) && (image_urls as string[]).length > 0;
      const promptText = typeof user_prompt === 'string' ? user_prompt : '';
      // Copy read off a design screenshot is only content when the user asked for
      // its words. For a pure style reference it must never be required, hinted,
      // or force-placed — the user's own copy is the copy. The schema pass already
      // asked the model; only fall back to keywords when it didn't say.
      const reuseReferenceCopy =
        typeof reuse_reference_copy === 'boolean'
          ? reuse_reference_copy
          : wantsReferenceCopy(promptText);
      let designCopyLines = !reuseReferenceCopy ? [] : Array.isArray(design_copy_lines)
        ? (design_copy_lines as unknown[])
            .filter((l): l is string => typeof l === 'string' && l.trim().length >= 6)
            .map((l) => l.replace(/\s+/g, ' ').trim())
            .slice(0, 12)
        : [];

      // Detect if images are design-references (screenshots to MATCH, not content
      // to embed). The schema pass already asked the model this exact question —
      // use its answer instead of re-deriving a possibly different one from
      // keywords here, which is how the two passes could disagree.
      const promptLooksLikeDesignRef =
        typeof design_reference === 'boolean'
          ? design_reference
          : isDesignReferenceAsk(promptText, hasImages) ||
            /\b(screenshot|design|mockup|reference|like this|match this|footer|nav|hero)\b/i.test(promptText);
      const imagesAreDesignRefs = hasImages && promptLooksLikeDesignRef;

      if (designCopyLines.length === 0 && imagesAreDesignRefs && reuseReferenceCopy) {
        sendSSE(controller, { type: 'status', message: 'Reading design screenshot…' });
        designCopyLines = await extractDesignReferenceCopy({
          imageUrls: (image_urls as string[]).slice(0, 3),
          prompt: promptText,
        });
        console.log('[pages/build] design-ref OCR', { lines: designCopyLines.length });
      }

      sendSSE(controller, { type: 'status', message: 'Building HTML...' });

      let statusBuffer = '';
      let html: string;
      try {
        html = await buildHtmlFromSchema(enrichedSchema, {
          competitorScreenshots: Array.isArray(competitor_screenshots) ? competitor_screenshots as string[] : [],
          competitorCssTokens: typeof competitor_css_tokens === 'string' ? competitor_css_tokens : undefined,
          competitorPageContent: typeof competitor_page_content === 'string' ? competitor_page_content : undefined,
          realLogoUrl: logoUrl ?? undefined,
          userPrompt: promptText || undefined,
          imageUrls: hasImages ? (image_urls as string[]) : [],
          designReferenceCopy: designCopyLines,
          imagesAreDesignRefs,
          callerLabel: 'build',
          onStreamRestart: () => {
            statusBuffer = '';
            sendSSE(controller, { type: 'status', message: 'Connection dropped — restarting the build…' });
          },
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
      } catch (err) {
        // Don't blame the model's output for a dead socket — this catch used to
        // report "invalid HTML" for a connection that never finished sending any.
        console.error('[pages/build] build HTML failed', err);
        sendSSE(controller, { type: 'error', message: userFacingAIErrorMessage(err) });
        closeSSE(controller);
        return;
      }

      // Soft prove-it: push missing OCR lines into named sections (~90% text feel, not pixel CSS).
      if (designCopyLines.length > 0) {
        const slNames = Array.from(html.matchAll(/<!--\s*SL:([a-z0-9_-]+)\s*-->/gi)).map((m) => m[1]);
        let targets = inferDesignMatchSectionNames(promptText, slNames);
        if (targets.length === 0) {
          targets = slNames.filter((n) => /footer/i.test(n));
          if (targets.length === 0 && /<footer\b/i.test(html)) targets = ['footer'];
          if (targets.length === 0) {
            targets = slNames.filter((n) => /^(nav|header|hero)/i.test(n)).slice(0, 2);
          }
        }
        if (targets.length > 0) {
          html = forceAppendMissingDesignCopy(html, targets[0], designCopyLines);
          console.log('[pages/build] design-copy force place', {
            target: targets[0],
            lines: designCopyLines.length,
          });
        }
      }

      if (logoUrl || logoSvg) {
        const before = logoUrl ? html.includes(logoUrl) : false;
        html = forceEmbedLogoInHtml(html, logoUrl, logoUrl ? null : logoSvg);
        // Create: put brand mark on every nav/footer-like SL section that exists.
        const slNames = Array.from(html.matchAll(/<!--\s*SL:([a-z0-9_-]+)\s*-->/gi)).map((m) => m[1]);
        const createTargets = Array.from(
          new Set([
            ...slNames.filter((n) => /^(nav|header)/i.test(n) || /nav|header/i.test(n)),
            ...slNames.filter((n) => /footer/i.test(n)),
            ...(/<footer\b/i.test(html) ? (['footer'] as string[]) : []),
          ]),
        );
        if (createTargets.length === 0) createTargets.push('nav', 'footer');
        html = forceEmbedLogoIntoSections(html, createTargets, logoUrl, logoUrl ? null : logoSvg);
        const hasUrl = logoUrl ? html.includes(logoUrl) : /<svg\b/i.test(html);
        console.log('[pages/build] logo embed', {
          hadLogo: before,
          hasLogoAfter: hasUrl,
          createTargets,
          logoUrl: logoUrl ? logoUrl.slice(0, 120) : null,
          usedInlineSvgFallback: !logoUrl && !!logoSvg,
        });
        // Only block Done if the real logo URL never appears anywhere —
        // never error just because a oddly-named footer section was hard to hit.
        if (logoUrl && !hasUrl) {
          console.error('[pages/build] logo URL missing from HTML after embed attempts');
          sendSSE(controller, {
            type: 'error',
            message:
              "We couldn't place the real logo on the page cleanly. Try again, or attach the logo file directly.",
          });
          closeSSE(controller);
          return;
        }
      }
      if (footerContact) {
        html = forceEmbedFooterContactInHtml(html, footerContact);
      }

      // Strip any remaining STATUS comments before upload
      html = html.replace(/<!--\s*STATUS:[^>]*-->/g, '');

      // Every external <img> the model wrote is verified and re-hosted, so a
      // hotlink that 403s in the browser can't ship as a "successful" build.
      const assetScan = await verifyAndRehostHtmlImages({ pageSlug, html });
      html = assetScan.html;
      if (assetScan.rehosted.length > 0 || assetScan.broken.length > 0) {
        console.log('[pages/build] asset integrity', {
          rehosted: assetScan.rehosted.length,
          broken: assetScan.broken,
        });
      }

      // Requirements: turn the prompt into checkable asks, apply what we can
      // deterministically, and remember what still failed for an honest Done.
      const requirements = mergeRequirements(
        // Written by the model during the schema pass, so asks that no regex
        // here would recognise still get verified.
        parseModelRequirements(model_requirements, {
          knownSections: listSlSectionNames(html),
          // Only asset checks naming a URL this build actually embeds; the
          // model's source URLs are re-hosted, so checking those never passes.
          embeddableAssetUrls: [
            ...(logoUrl ? [logoUrl] : []),
            ...(hasImages ? (image_urls as string[]) : []),
          ],
        }),
        extractRequirements({
          prompt: promptText,
          assetUrls: logoUrl ? [logoUrl] : [],
          designCopyLines,
        }),
      );
      if (requirements.length > 0) {
        const enforced = enforceRequirements(html, requirements);
        html = enforced.html;
        if (enforced.applied.length > 0) {
          console.log('[pages/build] requirements enforced', enforced.applied);
        }
      }
      const requirementResults = checkRequirements(html, requirements);
      const unmet = describeUnmet(requirementResults);
      if (unmet) {
        console.warn('[pages/build] unmet requirements', {
          unmet,
          prompt: promptText.slice(0, 200),
        });
      }

      html = ensureClickToEditFields(html, enrichedSchema);

      const storagePath = `pages/${pageSlug}.html`;
      let htmlUrl = await uploadHtml(storagePath, html);

      // DISABLED runPostUploadNavLogoQa (build:visual-qa).
      // Live visual QA screenshots the uploaded HTML via ApiFlash, then rewrites
      // whole sections. A capture of an S3 NoSuchBucket error page was treated as
      // "the page is broken", so QA rewrote nav/hero, stripped data-field (killing
      // click-to-edit), and still reported Done. Routing/intent is now model-
      // classified; this pixel pass is optional polish and currently net-negative
      // (minutes of hang + destructive rewrites). Leave ai-visual-qa.ts in place
      // and turn the call site back on only after captures are proven to be our
      // actual page (skip error pages / tiny files) and rewrites keep data-field
      // + SL markers.

      const finalUnmet = requirements.length > 0
        ? describeUnmet(checkRequirements(html, requirements))
        : unmet;

      sendSSE(controller, {
        type: 'done',
        html_url: htmlUrl,
        slug: pageSlug,
        schema_json: enrichedSchema,
        ...(finalUnmet ? { unmet_requirements: finalUnmet } : {}),
        ...(assetScan.broken.length > 0 ? { broken_assets: assetScan.broken.length } : {}),
      });
      closeSSE(controller);
    } catch (err) {
      console.error('[pages/build]', err);
      sendSSE(controller, { type: 'error', message: 'Internal server error' });
      closeSSE(controller);
    }
  })();

  return response;
}
