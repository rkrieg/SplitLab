import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';
import { buildPageGenerationPrompt } from '@/lib/page-builder-prompts';
import { scorePage } from '@/lib/page-quality';
import { uploadHtml, downloadHtml } from '@/lib/storage';
import { searchImages } from '@/lib/unsplash';
import type { Vertical } from '@/types/page-builder';

export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'admin' && session.user.role !== 'manager')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const pageId = params.id;
  const { instructions, plan_only } = await request.json();

  const { data: page, error } = await db
    .from('pages')
    .select('*')
    .eq('id', pageId)
    .single();

  if (error || !page) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  const vertical = (page.vertical || 'local_services') as Vertical;

  // ── Plan-only mode: return what will be changed without applying ──
  if (instructions && plan_only) {
    let currentHtml: string;
    if (page.html_content) {
      currentHtml = page.html_content;
    } else {
      currentHtml = await downloadHtml(page.html_url);
    }

    // Extract a concise page structure summary (sections + key text)
    const sectionSummary = currentHtml
      .match(/data-sl-section=["']([^"']+)["']/g)
      ?.map(m => m.replace(/data-sl-section=["']/, '').replace(/["']$/, ''))
      ?.join(', ') || 'hero, content, cta';

    const planResponse = await ask(
      `You are analyzing a change request for an HTML landing page. Do NOT make changes — just plan what you would do.

## Page Sections
${sectionSummary}

## Page HTML (first 3000 chars for context)
${currentHtml.slice(0, 3000)}

## Requested Changes
${instructions}

## Task
Analyze the request and return a JSON object with:
- "summary": A 1-sentence plain-English description of what you will do
- "changes": An array of 2-6 specific changes you will make (be concise, e.g., "Add dark gradient overlay to hero background", "Change CTA button color from blue to red")
- "warnings": An array of things you will NOT touch that the user might expect you to change (e.g., "Will keep all existing headline text as-is", "Won't modify the testimonials section"). If nothing ambiguous, use an empty array.

Return ONLY valid JSON, no markdown fences.`,
      {
        model: 'claude-sonnet-4-20250514',
        maxTokens: 1024,
      }
    );

    let plan;
    try {
      let cleaned = planResponse.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
      }
      plan = JSON.parse(cleaned);
    } catch {
      plan = {
        summary: 'Apply the requested visual and structural changes.',
        changes: [instructions],
        warnings: [],
      };
    }

    return NextResponse.json({ plan });
  }

  let finalHtml: string;

  if (instructions) {
    // ── Edit mode: modify existing HTML based on instructions ──
    // Fetch the current page HTML and ask Claude to apply targeted changes
    let currentHtml: string;
    if (page.html_content) {
      currentHtml = page.html_content;
    } else {
      currentHtml = await downloadHtml(page.html_url);
    }

    const editResponse = await ask(
      `You are editing an existing HTML landing page. Apply ONLY the requested changes. Do NOT rewrite, rephrase, or alter any text, copy, headlines, descriptions, or content that is not explicitly mentioned in the instructions.

## Current Page HTML
${currentHtml}

## Requested Changes
${instructions}

## Critical Rules
1. ONLY change what the instructions specifically ask for
2. PRESERVE all existing text content, headlines, descriptions, CTAs, and copy EXACTLY as they are unless the instructions explicitly say to change them
3. Keep all data-sl-section and data-sl-editable attributes
4. Keep all existing images, links, and media unless told to change them
5. Keep all CSS classes and inline styles unless the instructions ask for visual changes
6. If the instructions ask for structural/visual changes (layout, colors, spacing, backgrounds), apply those WITHOUT touching the text content
7. Output the COMPLETE modified HTML document
8. No markdown code fences`,
      {
        model: 'claude-sonnet-4-20250514',
        maxTokens: 16384,
      }
    );

    finalHtml = editResponse.trim();
    if (finalHtml.startsWith('```')) {
      finalHtml = finalHtml.replace(/^```html?\n?/, '').replace(/\n?```$/, '');
    }
  } else {
    // ── Full regenerate: build a new page from scratch ──
    const imageUrls = await searchImages(page.prompt, vertical);

    const { system, user } = buildPageGenerationPrompt({
      userPrompt: page.prompt,
      vertical,
      brandSettings: page.brand_settings,
      imageUrls,
    });

    const html = await ask(user, {
      system,
      model: 'claude-opus-4-20250514',
      maxTokens: 16384,
    });

    finalHtml = html.trim();
    if (finalHtml.startsWith('```')) {
      finalHtml = finalHtml.replace(/^```html?\n?/, '').replace(/\n?```$/, '');
    }
  }

  const quality = scorePage(finalHtml, vertical);
  const newVersion = (page.version || 1) + 1;
  const storagePath = `pages/${page.workspace_id}/${pageId}.html`;
  const publicUrl = await uploadHtml(storagePath, finalHtml);

  await db.from('pages').update({
    html_url: publicUrl,
    html_content: finalHtml.length < 500_000 ? finalHtml : null,
    quality_score: quality.score,
    quality_details: quality.details,
    version: newVersion,
  }).eq('id', pageId);

  return NextResponse.json({
    page_id: pageId,
    version: newVersion,
    quality_score: quality.score,
  });
}
