import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { isRateLimited } from '@/lib/ai-client';
import { uploadHtml, downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan, resolveWorkspaceOwner } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { isTestVariantPage } from '@/lib/page-drafts';
import { createSSEStream, sendSSE, sendSSEPing, closeSSE, SSE_HEADERS } from '@/lib/sse';
import { checkAiAllowance } from '@/lib/ai-usage';
import { ensureClickToEditFields } from '@/lib/ai-data-field-stamp';
import { repairSlMarkers, markerQuality, dropEmptySectionMarkers } from '@/lib/ai-sl-markers';
import { analyzePageLayout } from '@/lib/ai-page-layout';
import { rebuildCoordinatePage, checkTranspile } from '@/lib/ai-page-transpile';
import { extractPageContent, extractedPageToSchema } from '@/lib/ai-page-extract';

export const dynamic = 'force-dynamic';
// No model call happens here any more — the rebuild is a transpile that runs in
// well under a second. The ceiling is for storage uploads on a very large page.
export const maxDuration = 120;

/**
 * Rebuild a coordinate-layout page as a flow-layout page.
 *
 * ── Why this route exists ──────────────────────────────────────────────────
 *
 * A page whose layout is per-element pixel coordinates cannot be edited by
 * rewriting its markup — the coordinates in the head stylesheet still decide
 * where everything goes, so new content lands ON TOP of the old instead of after
 * it. That is not a bug that can be patched around; the page has to be rebuilt
 * in flow layout before any structural edit can work. See ai-page-layout.ts for
 * how that verdict is reached and which builders produce such pages.
 *
 * ── What it does ───────────────────────────────────────────────────────────
 *
 * It transpiles. ai-page-transpile.ts reads the page's own stylesheet at desktop
 * width and copies every colour, background, font, size, weight, radius, text run
 * and asset URL across unchanged, rewriting only the positions — which become
 * sections, flex rows and proportional columns. No model is involved.
 *
 * It used to be a model call: extract the content, hand it to the page builder,
 * ask for "the same page in flow layout". The model designed its own page
 * instead. On a real rebuild it invented a palette (red buttons on white where the
 * original was gold on navy), swapped the typeface, dropped four images and a
 * video, and added copy that was never there. That was not a prompt problem —
 * there is nothing to decide here, because every answer is already written in the
 * page's stylesheet, and a model asked to recreate a page makes choices.
 *
 * Because everything is copied rather than written, the result is checked by
 * EXACT EQUALITY: every visible text run, every image URL, every embed URL that
 * the source shows at desktop width must appear in the output. Anything missing
 * throws the whole rebuild away and leaves the page untouched. The old version
 * could only manage "85% of the text survived" and could not check images at all.
 *
 * Never called on its own initiative — the editor asks the user first, and the
 * chat stays locked until they answer, because every request they could type
 * about a coordinate page is one that would silently fail.
 *
 * ── Getting back ───────────────────────────────────────────────────────────
 *
 * For a test variant the rebuild goes into the DRAFT, so the live variant keeps
 * serving the original and Discard draft is the undo. For any other page the
 * original HTML is copied to a `-before-rebuild.html` file in storage first, and
 * its URL is returned on the done event.
 */

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const startedAt = Date.now();

  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, html_url, html_content, schema_json, slug, draft_html_content, draft_schema_json')
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
        { status: 403 },
      );
    }
  }

  if (!page.html_url && !page.html_content && !page.draft_html_content) {
    return NextResponse.json({ error: 'Page has no HTML yet' }, { status: 400 });
  }

  // Rebuilding is a whole page generation, so it is rate-limited harder than a
  // normal edit — and it is never something a user needs twice in a minute.
  if (isRateLimited(session.user.id, 2, 60_000) || isRateLimited(session.user.id, 8, 3_600_000)) {
    return NextResponse.json({ error: 'Too many requests. Please wait a moment before trying again.' }, { status: 429 });
  }

  const isVariant = await isTestVariantPage(params.id);

  const { ownerId, plan: ownerPlanForUsage } = await resolveWorkspaceOwner(page.workspace_id);
  // The rebuild itself no longer spends AI credits — it is a transpile, not a model
  // call — so nothing is reported as usage afterwards. The allowance check stays
  // because it is also the plan gate for AI page editing, which is what the rebuild
  // exists to unlock: there is no point rebuilding a page for an account that
  // cannot then edit it.
  if (session.user.role !== 'admin') {
    const gate = await checkAiAllowance(ownerId, ownerPlanForUsage);
    if (!gate.allowed) {
      return NextResponse.json(
        {
          error: gate.reason === 'over_cap'
            ? 'You\'ve reached your AI overage spend cap. Raise it in Billing to continue.'
            : 'You\'re out of AI credits for this month. Enable overage in Billing to continue.',
          softCap: true,
          reason: gate.reason,
          usage: gate.summary,
          overage: gate.overage,
        },
        { status: 402 },
      );
    }
  }

  // ── Open SSE stream — no NextResponse.json after this point ───────────────
  const { stream, controller } = createSSEStream();
  const response = new Response(stream, { headers: SSE_HEADERS });

  void (async () => {
    const heartbeat = setInterval(() => sendSSEPing(controller), 15_000);
    try {
      sendSSE(controller, { type: 'status', message: 'Reading the original page…' });

      const originalHtml =
        (isVariant ? page.draft_html_content : null) ??
        page.html_content ??
        (page.html_url ? await downloadHtmlByPath(fileNameFromUrl(page.html_url)) : null);
      if (!originalHtml) {
        clearInterval(heartbeat);
        sendSSE(controller, { type: 'error', message: 'Could not load current HTML' });
        closeSSE(controller);
        return;
      }

      // No data-URI stripping here, unlike every other AI path: nothing is sent to
      // a model, so image bytes cost nothing. It also matters that they stay put —
      // exporters use a 1×1 base64 GIF as the `src` of every lazy-loaded image and
      // keep the real URL in `data-src-desktop-1x`. Replacing those GIFs with
      // placeholders would hide the fact that they are placeholders, and the
      // transpiler would copy the spacer instead of the photograph.

      // Refuse to rebuild a page that does not need rebuilding. A flow-layout
      // page can be patched in place with perfect fidelity, so replacing it with
      // a re-interpretation would destroy something for no gain.
      const layout = analyzePageLayout(originalHtml);
      if (layout.kind !== 'coordinate') {
        clearInterval(heartbeat);
        console.log('[rebuild-flow] refused — page is already flow layout', {
          pageId: params.id,
          reasons: layout.reasons,
        });
        sendSSE(controller, {
          type: 'error',
          message:
            'This page does not need rebuilding — its layout comes from its markup, so I can edit any part of it in place. Ask me for the change you want instead.',
        });
        closeSSE(controller);
        return;
      }

      sendSSE(controller, { type: 'status', message: 'Copying every heading, colour and image across…' });

      // Builds, then compares every run of text against the original's resolved
      // font, size and colour and fixes what does not match. Not a reject:
      // rejecting on a style difference would leave the user with a coordinate
      // page and a chat that cannot restructure it, which is not an outcome.
      const { result: transpiled, appearance, repairPasses } = await rebuildCoordinatePage(originalHtml);
      let rebuilt = transpiled.html;
      console.log('[rebuild-flow] transpiled', {
        pageId: params.id,
        sections: transpiled.sections.map((s) => s.name),
        texts: transpiled.copied.texts.length,
        images: transpiled.copied.images.length,
        embeds: transpiled.copied.embeds.length,
        fonts: transpiled.copied.fonts,
        hiddenSkipped: transpiled.hidden,
        bytes: rebuilt.length,
        appearanceCompared: appearance.compared,
        appearanceMismatches: appearance.mismatches.length,
        repairPasses,
        sampleMismatches: appearance.mismatches.slice(0, 5),
      });

      if (transpiled.sections.length === 0) {
        clearInterval(heartbeat);
        console.error('[rebuild-flow] nothing to rebuild on this page', { pageId: params.id });
        sendSSE(controller, {
          type: 'error',
          message:
            'I could not read any content off this page — its text may be drawn by JavaScript rather than written in the HTML. Nothing was changed.',
        });
        closeSSE(controller);
        return;
      }

      // ── Did everything come across? ──────────────────────────────────────
      //
      // An equality check, not a similarity score. The source is walked again,
      // independently of the transpiler, and every visible text run, image URL and
      // embed URL it finds has to be present in the output. One missing item
      // throws the rebuild away: a page that quietly lost its phone number is
      // worse than a page that was never rebuilt.
      sendSSE(controller, { type: 'status', message: 'Checking nothing was lost…' });
      const check = await checkTranspile(originalHtml, rebuilt);
      if (!check.ok) {
        clearInterval(heartbeat);
        console.error('[rebuild-flow] rejected — content did not survive, page left untouched', {
          pageId: params.id,
          missingTexts: check.missingTexts.length,
          missingImages: check.missingImages,
          missingEmbeds: check.missingEmbeds,
          missingIcons: check.missingIcons.length,
          missingFormFields: check.missingFormFields,
          sampleMissingText: check.missingTexts.slice(0, 5),
          sampleMissingIcon: check.missingIcons.slice(0, 1),
        });
        const lost = [
          check.missingTexts.length > 0
            ? `${check.missingTexts.length} of ${check.expected.texts.length} pieces of copy`
            : '',
          check.missingImages.length > 0
            ? `${check.missingImages.length} image${check.missingImages.length === 1 ? '' : 's'}`
            : '',
          check.missingEmbeds.length > 0
            ? `${check.missingEmbeds.length} video embed${check.missingEmbeds.length === 1 ? '' : 's'}`
            : '',
          check.missingIcons.length > 0
            ? `${check.missingIcons.length} icon${check.missingIcons.length === 1 ? '' : 's'}`
            : '',
          check.missingFormFields.length > 0
            ? `${check.missingFormFields.length} form field${check.missingFormFields.length === 1 ? '' : 's'}`
            : '',
        ].filter(Boolean).join(', ');
        sendSSE(controller, {
          type: 'error',
          message:
            `I rebuilt the page but ${lost} didn't come through, so I threw the rebuild away — your page is untouched. Try again, or go back.`,
        });
        closeSSE(controller);
        return;
      }

      // ── Make it editable ────────────────────────────────────────────────
      sendSSE(controller, { type: 'status', message: 'Making every section editable…' });

      // The schema is read back off the rebuilt page rather than carried over from
      // the original. It has to describe the markup being saved, since that is what
      // the click-to-edit stamp locates fields in and what the editor's field panel
      // reads; a schema built from the coordinate original would name sections that
      // no longer exist. The transpiler already wrapped every section in its
      // `<!-- SL:name -->` markers, so repairSlMarkers finds nothing to add.
      const schema = extractedPageToSchema(extractPageContent(rebuilt));

      const markerFix = repairSlMarkers(rebuilt, schema);
      if (markerFix.repaired.length > 0) {
        console.warn('[rebuild-flow] section markers repaired before save', {
          repaired: markerFix.repaired,
          skipped: markerFix.skipped,
        });
      }
      rebuilt = markerFix.html;

      const drop = dropEmptySectionMarkers(rebuilt);
      if (drop.dropped.length > 0) {
        console.warn('[rebuild-flow] dropped markers around empty boxes', { dropped: drop.dropped });
        rebuilt = drop.html;
      }
      const quality = markerQuality(rebuilt);
      if (!quality.ok) {
        console.error('[rebuild-flow] rebuilt page still has an awkward section map', {
          emptyBoxes: quality.empty,
          dominant: quality.dominant,
        });
      }

      rebuilt = ensureClickToEditFields(rebuilt, schema);

      // The rebuilt page must actually be flow layout, or nothing was gained.
      const newLayout = analyzePageLayout(rebuilt);
      if (newLayout.kind !== 'flow') {
        clearInterval(heartbeat);
        console.error('[rebuild-flow] rejected — rebuilt page is still coordinate-based', {
          pageId: params.id,
          reasons: newLayout.reasons,
        });
        sendSSE(controller, {
          type: 'error',
          message:
            'The rebuilt page came out with the same fixed-position layout as the original, so it would not have been any more editable. I threw it away — your page is untouched.',
        });
        closeSSE(controller);
        return;
      }

      sendSSE(controller, { type: 'status', message: 'Saving…' });

      const finalHtml = rebuilt;
      const finalSchema = schema;

      // Somewhere to go back to. A variant's live HTML is untouched either way
      // (the rebuild lands in the draft), so the backup is for every other page.
      let backupUrl: string | undefined;
      if (!isVariant) {
        try {
          backupUrl = await uploadHtml(
            `pages/${page.slug ?? params.id}-before-rebuild.html`,
            originalHtml,
          );
        } catch (err) {
          // A failed backup must not silently become a rebuild with no way back.
          clearInterval(heartbeat);
          console.error('[rebuild-flow] could not save a copy of the original, aborting', err);
          sendSSE(controller, {
            type: 'error',
            message: 'I could not save a backup copy of your original page, so I stopped before changing anything. Please try again.',
          });
          closeSSE(controller);
          return;
        }
      }

      let htmlUrl = page.html_url ?? '';
      const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (isVariant) {
        updatePayload.draft_html_content = finalHtml;
        updatePayload.draft_schema_json = finalSchema;
      } else {
        const storagePath = page.html_url
          ? fileNameFromUrl(page.html_url)
          : `pages/${page.workspace_id}/${params.id}.html`;
        htmlUrl = await uploadHtml(storagePath, finalHtml);
        updatePayload.html_url = htmlUrl;
        updatePayload.html_content = finalHtml.length < 500_000 ? finalHtml : null;
        updatePayload.schema_json = finalSchema;
        // The markup is entirely new, so any selector mapped against the old
        // markup is meaningless now.
        updatePayload.field_selectors_json = null;
      }

      await db.from('pages').update(updatePayload).eq('id', params.id);
      if (!isVariant) {
        await db.from('personalization_rules').delete().eq('page_id', params.id);
      }

      clearInterval(heartbeat);

      // Nothing was lost — the check above is a hard gate, so reaching here means
      // every text run, image and embed is present. The only thing worth telling
      // the user is what a transpile genuinely cannot carry over: the original page
      // builder's JavaScript. Its sliders, pop-ups and sticky bars are wired to the
      // per-element ids the rebuild has to drop, and keeping those ids would keep
      // the page unrestructurable — which is the entire reason for rebuilding.
      //
      // Styling is the other thing worth saying out loud, and only when there is
      // something to say: the appearance check compares every run of text against
      // the original's resolved font, size and colour, and anything it could not
      // reconcile after two repair passes is named rather than left for the user to
      // spot. Silence here means it matched.
      const notes = transpiled.warnings
        .filter((w) => w.startsWith('Interactive extras') || w.includes('could not be matched'))
        .join(' ') || undefined;

      console.log('[rebuild-flow] done', {
        pageId: params.id,
        isVariant,
        sections: transpiled.sections.length,
        texts: check.expected.texts.length,
        images: check.expected.images.length,
        embeds: check.expected.embeds.length,
        warnings: transpiled.warnings,
        elapsedMs: Date.now() - startedAt,
      });

      sendSSE(controller, {
        type: 'done',
        html_url: htmlUrl,
        schema_json: finalSchema,
        elapsed_ms: Date.now() - startedAt,
        prep_strategy: 'rebuild',
        // Short on purpose — see describePrepOutcome in ai-page-layout.ts. The long
        // version listed extraction counts, the reason the rebuild was needed and
        // the undo instructions in one paragraph, and nobody read it.
        prep_note:
          `Rebuilt as ${transpiled.sections.length} editable sections, copied across exactly — ` +
          `same colours, headings, images and video. Ask for any change now. ` +
          (isVariant
            ? 'Saved as a draft — Discard draft puts the original back.'
            : 'A copy of the original was saved first.'),
        ...(notes ? { notes } : {}),
        ...(backupUrl ? { backup_html_url: backupUrl } : {}),
      });
      closeSSE(controller);
    } catch (err) {
      clearInterval(heartbeat);
      console.error('[rebuild-flow]', err);
      sendSSE(controller, { type: 'error', message: 'Could not rebuild this page. Nothing was changed.' });
      closeSSE(controller);
    }
  })();

  return response;
}
