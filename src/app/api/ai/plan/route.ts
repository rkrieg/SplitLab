import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';
import { prepareHtml } from '@/lib/variant-utils';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'admin' && session.user.role !== 'manager')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { type } = body;

  if (type === 'variant') {
    return handleVariantPlan(body);
  } else if (type === 'page') {
    return handlePagePlan(body);
  }

  return NextResponse.json({ error: 'Invalid type. Use "variant" or "page"' }, { status: 400 });
}

async function handleVariantPlan(body: Record<string, unknown>) {
  const { page_analysis, scraped_page_id, instructions, previous_plan, feedback } = body;

  // Fetch actual page HTML for context
  let pageHtmlContext = '';
  if (scraped_page_id) {
    const { data: scrapedPage } = await db
      .from('scraped_pages')
      .select('html, url')
      .eq('id', scraped_page_id as string)
      .single();
    if (scrapedPage?.html) {
      pageHtmlContext = `\n## Current Page HTML (abbreviated)\n${prepareHtml(scrapedPage.html).slice(0, 30000)}`;
    }
  }

  let prompt = `You are a senior CRO strategist planning A/B test variants for a real landing page. You must be HIGHLY SPECIFIC — reference actual elements, text, and sections from the page.

## Page Analysis
${JSON.stringify(page_analysis, null, 2)}
${pageHtmlContext}

${instructions ? `## User's Instructions\n${instructions}\n` : ''}`;

  // If this is a refinement based on feedback
  if (previous_plan && feedback) {
    prompt += `\n## Previous Plan
${JSON.stringify(previous_plan, null, 2)}

## User's Feedback on the Plan
"${feedback}"

Update the plan based on this feedback. Keep what the user liked, change what they asked to change, and add anything new they requested.\n`;
  }

  prompt += `
## Task
Create a detailed test plan. For EACH variant, be extremely specific:
- Reference actual text/elements from the page (e.g., "Change the hero headline 'FROM VISION TO VICTORY' to...")
- Describe visual changes if needed (hero image/video, background colors, section layouts)
- Explain the CRO hypothesis behind each change

Return ONLY valid JSON:
{
  "summary": "1-2 sentence strategy overview referencing the actual page",
  "variants": [
    {
      "title": "Descriptive variant name",
      "hypothesis": "Specific CRO hypothesis tied to this page",
      "changes": [
        "Change hero headline 'Current Text' to 'New Text' — reason",
        "Replace hero background image with video showing...",
        "Update CTA 'Get In Touch' to 'Get Your Free Audit' — more specific action",
        "Add urgency element below hero: 'Limited spots available this month'"
      ]
    }
  ],
  "editable_prompt": "A detailed, natural-language brief describing ALL planned changes. Written like instructions to a developer/designer. Include specific text replacements, visual changes, and structural modifications. The user will edit this before generation begins."
}`;

  const response = await ask(prompt, {
    model: 'claude-sonnet-4-20250514',
    maxTokens: 2048,
  });

  let plan;
  try {
    let cleaned = response.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    }
    plan = JSON.parse(cleaned);
  } catch {
    plan = {
      summary: 'Could not parse plan — please try again.',
      variants: [],
      editable_prompt: instructions || '',
    };
  }

  return NextResponse.json({ plan });
}

async function handlePagePlan(body: Record<string, unknown>) {
  const { prompt: userPrompt, vertical, custom_vertical, brand_settings, previous_plan, feedback } = body;

  let prompt = `You are a senior landing page strategist planning a high-converting page.

## User's Request
${userPrompt}

## Vertical: ${custom_vertical || vertical}
${brand_settings ? `## Brand Settings\n${JSON.stringify(brand_settings, null, 2)}` : ''}`;

  if (previous_plan && feedback) {
    prompt += `\n## Previous Plan
${JSON.stringify(previous_plan, null, 2)}

## User's Feedback
"${feedback}"

Update the plan based on this feedback. Keep what works, change what they asked to change, add anything new.\n`;
  }

  prompt += `
## Task
Create a detailed build plan. Be specific about:
- Each section: what it contains, its purpose, specific content ideas
- Design direction: colors, typography, imagery style, mood
- Conversion strategy: what makes a visitor take action

Return ONLY valid JSON:
{
  "summary": "1-2 sentence overview",
  "sections": [
    {
      "title": "Hero",
      "description": "Full-width hero with dark overlay video background of Phoenix skyline. Bold headline: 'Aggressive Criminal Defense When Your Freedom Is On The Line'. Subheadline with credentials. Primary CTA: 'Get Your Free Case Review'."
    }
  ],
  "design_notes": "Specific design direction — colors, fonts, imagery style, mood",
  "editable_prompt": "Detailed creative brief the user can edit. Written like instructions to a designer — include specific section details, content, imagery, and conversion elements."
}`;

  const response = await ask(prompt, {
    model: 'claude-sonnet-4-20250514',
    maxTokens: 2048,
  });

  let plan;
  try {
    let cleaned = response.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    }
    plan = JSON.parse(cleaned);
  } catch {
    plan = {
      summary: `Build a ${custom_vertical || vertical} landing page.`,
      sections: [
        { title: 'Hero', description: 'Main headline, value proposition, and primary CTA' },
        { title: 'Services', description: 'Key offerings' },
        { title: 'Social Proof', description: 'Testimonials' },
        { title: 'CTA', description: 'Final conversion section' },
      ],
      design_notes: 'Professional design',
      editable_prompt: String(userPrompt),
    };
  }

  return NextResponse.json({ plan });
}
