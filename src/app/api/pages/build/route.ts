import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { isRateLimited, generatePageImages, userFacingAIErrorMessage } from '@/lib/ai-client';
import { uploadHtml } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { buildHtmlFromSchema } from '@/lib/ai-page-builder';
import { resolveSkills, runSkillChecks, skillIds, skillNames } from '@/lib/skills';
import { isStyleTag } from '@/lib/ai-page-exemplars';
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
import { extractDesignReferenceCopy } from '@/lib/ai-follow-up-helpers';
import { MAX_ATTACHMENTS } from '@/lib/ai-edit-intent';
import { forceAppendMissingDesignCopy } from '@/lib/ai-content-placement';
import { verifyAndRehostHtmlImages } from '@/lib/ai-asset-integrity';
import { measureAssetPlacement, type LibraryAsset } from '@/lib/asset-placement';
import { ensureClickToEditFields } from '@/lib/ai-data-field-stamp';
import { repairSlMarkers, markerCoverage, markerQuality } from '@/lib/ai-sl-markers';
import { analyzePageLayout } from '@/lib/ai-page-layout';
import {
  assetRequirements,
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
    competitor_palette: unknown,
    competitor_scrape_gaps: unknown,
    competitor_page_content: unknown,
    competitor_logo_url: unknown,
    competitor_logo_svg: unknown,
    competitor_footer_contact: unknown,
    design_copy_lines: unknown,
    reuse_reference_copy: unknown,
    design_copy_sections: unknown,
    minimal_shape: unknown,
    asset_library: unknown,
    selected_skills: unknown,
    selected_style: unknown,
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
      competitor_palette,
      competitor_scrape_gaps,
      competitor_page_content,
      competitor_logo_url,
      competitor_logo_svg,
      competitor_footer_contact,
      design_copy_lines,
      reuse_reference_copy,
      design_copy_sections,
      minimal_shape,
      asset_library,
      skills: selected_skills,
      style: selected_style,
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

  // Server-side validation of both picks. Unknown skill ids are dropped rather
  // than rejected, and an unknown style falls back to "Auto" (today's
  // design-brief call) — neither should ever fail a build the user is watching.
  const activeSkills = resolveSkills(selected_skills);
  const activeStyle = isStyleTag(selected_style) ? selected_style : null;

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

      const attachedImageUrls = Array.isArray(image_urls)
        ? (image_urls as string[]).filter((u) => typeof u === 'string' && u.trim().length > 0).slice(0, MAX_ATTACHMENTS)
        : [];
      const hasImages = attachedImageUrls.length > 0;
      const promptText = typeof user_prompt === 'string' ? user_prompt : '';
      // Only use explicit booleans from generate. Missing → false (no keyword guess).
      const reuseReferenceCopy =
        typeof reuse_reference_copy === 'boolean' ? reuse_reference_copy : false;
      let designCopyLines = !reuseReferenceCopy ? [] : Array.isArray(design_copy_lines)
        ? (design_copy_lines as unknown[])
            .filter((l): l is string => typeof l === 'string' && l.trim().length >= 6)
            .map((l) => l.replace(/\s+/g, ' ').trim())
            .slice(0, 12)
        : [];

      if (designCopyLines.length === 0 && hasImages && reuseReferenceCopy) {
        sendSSE(controller, { type: 'status', message: 'Reading design screenshot…' });
        designCopyLines = await extractDesignReferenceCopy({
          imageUrls: attachedImageUrls,
          prompt: promptText,
        });
        console.log('[pages/build] design-ref OCR', { lines: designCopyLines.length });
      }

      sendSSE(controller, { type: 'status', message: 'Building HTML...' });

      let statusBuffer = '';
      let html: string;
      // What the build ACTUALLY styled with. On "Auto" this is the design
      // brief's pick, which was previously reported nowhere at all.
      let resolvedStyle: string | null = activeStyle;
      let styleWasAuto = activeStyle === null;
      try {
        html = await buildHtmlFromSchema(enrichedSchema, {
          competitorScreenshots: Array.isArray(competitor_screenshots) ? competitor_screenshots as string[] : [],
          competitorCssTokens: typeof competitor_css_tokens === 'string' ? competitor_css_tokens : undefined,
          competitorPalette: typeof competitor_palette === 'string' ? competitor_palette : undefined,
          competitorScrapeGaps: typeof competitor_scrape_gaps === 'string' ? competitor_scrape_gaps : undefined,
          competitorPageContent: typeof competitor_page_content === 'string' ? competitor_page_content : undefined,
          realLogoUrl: logoUrl ?? undefined,
          userPrompt: promptText || undefined,
          imageUrls: attachedImageUrls,
          designReferenceCopy: designCopyLines,
          minimalShape: minimal_shape === true,
          skills: activeSkills,
          styleTag: activeStyle,
          onStyleResolved: (tag, source) => {
            resolvedStyle = tag;
            styleWasAuto = source === 'auto';
          },
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

      // Soft prove-it: push missing OCR lines into the section the MODEL named.
      //
      // This used to pick the target with keyword inference and, when that found
      // nothing, dump the screenshot's text into footer/nav/hero arbitrarily —
      // which is how a block of a reference page's copy ("Thanks for confirming…",
      // "You Are Through.") ended up appended to a hero nobody asked to change.
      // No resolved section now means no placement at all: leaving the model's
      // own layout alone is always better than stamping text somewhere random.
      if (designCopyLines.length > 0) {
        const slNames = Array.from(html.matchAll(/<!--\s*SL:([a-z0-9_-]+)\s*-->/gi)).map((m) => m[1]);
        const targets = (Array.isArray(design_copy_sections) ? design_copy_sections : [])
          .filter((n): n is string => typeof n === 'string')
          .filter((n) => slNames.includes(n));
        if (targets.length > 0) {
          html = forceAppendMissingDesignCopy(html, targets[0], designCopyLines);
          console.log('[pages/build] design-copy force place', {
            target: targets[0],
            lines: designCopyLines.length,
          });
        } else {
          console.log('[pages/build] design-copy not placed — no model-resolved target section', {
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

      // Where the model resolved a conflict between a design rule and what it
      // was handed, it says so here — see "When best practice and the request
      // disagree" in the build prompt. Read BEFORE the strip, because these
      // come off the page like STATUS comments and never render.
      //
      // The rule splits three ways, and which branch fires decides whether a
      // note shows up here at all:
      //
      //   what happened            | what it does            | note emitted?
      //   -------------------------|-------------------------|---------------
      //   the model invented it    | follows the design rule | NO — a note
      //                            |                         | about its own
      //                            |                         | first draft is
      //                            |                         | just noise
      //   the REFERENCE SITE does  | builds the better       | YES — "changed
      //   it                       | version, rule wins      | X, say the word
      //                            |                         | and it goes
      //                            |                         | back"
      //   the USER asked for it in | does it THEIR way,      | YES — "not what
      //   their own words          | rule loses              | I'd recommend,
      //                            |                         | here's the cost"
      //
      // Underneath: the more deliberately a thing was asked for, the more the
      // model obeys and the less it corrects. So an EMPTY buildNotes is a
      // meaningful result, not a failure — it usually means nothing the user
      // wrote deliberately was in conflict with anything.
      const buildNotes: string[] = [];
      html = html.replace(/<!--\s*NOTE:\s*([^>]*?)-->/g, (_full, msg: string) => {
        const text = msg.trim();
        if (text && !buildNotes.includes(text)) buildNotes.push(text);
        return '';
      });

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
            ...(hasImages ? attachedImageUrls : []),
          ],
        }),
        // Only the floor: an asset WE embedded must be present. The prompt-derived
        // checks that used to live here (CTA-ban keywords, quoted-phrase scraping)
        // guessed the user's meaning and invented requirements they never stated —
        // the model's own checklist above covers real asks.
        assetRequirements(logoUrl ? [logoUrl] : []),
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

      // The builder TYPES its own <!-- SL:name --> markers — the requirement is
      // prose in its prompt (see ai-page-builder.ts, "Section markers"), typed
      // by hand while writing a 900-line document, and nothing verified it.
      // A page shipped with 5 markers on 11 blocks: the six unmarked ones
      // rendered perfectly and were invisible to every edit. Asked to change
      // one, the product told the user to word it better. Checked here, in
      // code, before the page is ever stored.
      const markerFix = repairSlMarkers(html, enrichedSchema);
      if (markerFix.repaired.length > 0 || markerFix.skipped.length > 0) {
        console.warn('[pages/build] section markers repaired before save', {
          repaired: markerFix.repaired,
          structural: markerFix.structural,
          skipped: markerFix.skipped,
        });
      }
      html = markerFix.html;

      // How much of the page is addressable. Nobody had this number, and its
      // absence is why a two-thirds-invisible page shipped unnoticed: the only
      // symptom is edits that quietly do nothing, weeks later.
      const coverage = markerCoverage(html);
      if (coverage.unmarked.length > 0) {
        console.error('[pages/build] page has blocks no edit can reach', {
          blocks: coverage.blocks,
          marked: coverage.marked,
          unmarked: coverage.unmarked,
        });
      } else {
        console.log('[pages/build] marker coverage', {
          blocks: coverage.blocks,
          marked: coverage.marked,
        });
      }

      // Coverage only says every block is inside a box. It does not say the
      // boxes hold anything, and an empty box is a name the router can be lured
      // into with nothing behind it (see markerQuality for the page where that
      // happened). Measured here, NOT acted on: re-cutting boxes is only safe
      // at prep, before a schema, a chat history and click-to-edit fields are
      // keyed to these exact section names. Our own builder lays out in flow, so
      // both of these should always come back clean — the point is to find out
      // if that ever stops being true.
      const quality = markerQuality(html);
      if (!quality.ok) {
        console.error('[pages/build] section map has boxes an edit cannot use', {
          emptyBoxes: quality.empty,
          dominant: quality.dominant,
        });
      }
      const layout = analyzePageLayout(html);
      if (layout.kind !== 'flow') {
        console.error('[pages/build] generated page is not flow-layout', {
          positioned: layout.positioned,
          candidates: layout.candidates,
          containerHeightPx: layout.containerHeightPx,
          reasons: layout.reasons,
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

      // text_present only proves the model's OWN phrasing of an ask didn't
      // survive verbatim — the build pass is a separate AI call free to word
      // things differently, so a paraphrase reads as a false "not landed" on
      // content that's actually on the page. Structural kinds (asset missing,
      // CTA present, section not removed/changed, wrong color) stay user-facing
      // since those really do mean something was dropped, not just reworded.
      const finalUnmet = requirements.length > 0
        ? describeUnmet(checkRequirements(html, requirements).filter((r) => r.requirement.kind !== 'text_present'))
        : unmet;

      // Did the user's link-imported photos actually make it onto the page?
      //
      // Measured against `html` — what shipped — not against the schema the
      // model returned, because the builder is a separate AI call and a
      // generated_image_url it decides to skip never reaches the document.
      // Nothing is enforced here: a decline can be the right answer (a brief
      // that bans extra imagery, or files that suit no slot). The count exists
      // so the client can SAY so, since an unexplained absence reads as the
      // import having failed.
      const libraryForPlacement: LibraryAsset[] = Array.isArray(asset_library)
        ? (asset_library as unknown[]).filter(
            (a): a is LibraryAsset =>
              !!a && typeof a === 'object' && typeof (a as { url?: unknown }).url === 'string',
          )
        : [];
      const placement =
        libraryForPlacement.length > 0 ? measureAssetPlacement(libraryForPlacement, html) : null;
      if (placement) {
        console.log('[pages/build] asset library placement', {
          imported: placement.imported,
          placed: placement.placed,
          unused: placement.unusedNames,
        });
      }

      // Skill scores — display only.
      //
      // Read-only by construction (every check takes html and returns a
      // verdict; none of them return HTML), and wrapped here as well as inside
      // runSkillChecks. A number the user never sees is worth nothing next to a
      // build that completes: if this whole block throws, the page still saves
      // and the done event simply carries no scores.
      let skillScores: ReturnType<typeof runSkillChecks> = [];
      try {
        skillScores = runSkillChecks(activeSkills, html);
        console.log('[pages/build] skill scores', {
          skills: skillIds(activeSkills),
          style: resolvedStyle ?? 'none',
          stylePickedBy: styleWasAuto ? 'auto' : 'user',
          passed: skillScores.filter((r) => r.passed).length,
          failed: skillScores.filter((r) => !r.passed).map((r) => r.id),
        });
      } catch (err) {
        console.error('[pages/build] skill scoring failed, continuing without a score', err);
        skillScores = [];
      }

      sendSSE(controller, {
        type: 'done',
        html_url: htmlUrl,
        skills_applied: skillIds(activeSkills),
        skills_applied_names: skillNames(activeSkills),
        style_applied: resolvedStyle,
        style_auto: styleWasAuto,
        ...(skillScores.length > 0 ? { skill_scores: skillScores } : {}),
        slug: pageSlug,
        schema_json: enrichedSchema,
        ...(finalUnmet ? { unmet_requirements: finalUnmet } : {}),
        ...(assetScan.broken.length > 0 ? { broken_assets: assetScan.broken.length } : {}),
        // Capped at three even though the prompt asks for at most three: a model
        // that ignores the cap must not turn the chat reply into an essay.
        // One per line: two or three separate calls are a list the user scans,
        // not a paragraph they wade through.
        ...(buildNotes.length > 0 ? { notes: buildNotes.slice(0, 3).join('\n') } : {}),
        ...(placement
          ? { imported_assets: placement.imported, placed_assets: placement.placed, unused_asset_names: placement.unusedNames }
          : {}),
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
