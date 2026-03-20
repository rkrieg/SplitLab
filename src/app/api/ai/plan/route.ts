import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { ask } from '@/lib/claude';

export const maxDuration = 30;
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
  const { page_analysis, instructions } = body;

  const prompt = `You are planning A/B test variants for a landing page.

## Page Analysis
${JSON.stringify(page_analysis, null, 2)}

${instructions ? `## User's Custom Instructions\n${instructions}\n` : ''}

## Task
Create a test plan with 1-3 variant angles to test. For each variant, describe:
- The testing angle/hypothesis
- Specific changes that will be made (text, visual, structural)
- What will NOT be changed

Also generate an "editable_prompt" — a detailed, natural-language description of all the changes across all variants that the user can review and edit before generation begins. This should read like clear instructions to a designer.

Return ONLY valid JSON:
{
  "summary": "1-2 sentence overview of the testing strategy",
  "variants": [
    {
      "title": "Variant angle name",
      "hypothesis": "What we're testing and why",
      "changes": ["Specific change 1", "Specific change 2"],
      "preserves": ["What stays the same"]
    }
  ],
  "editable_prompt": "Detailed instructions describing all planned changes that the user can modify..."
}`;

  const response = await ask(prompt, {
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1024,
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
      summary: 'Generate A/B test variants to optimize conversion.',
      variants: [{ title: 'Conversion Optimization', hypothesis: 'Optimized copy and CTAs will increase conversions', changes: ['Optimize headlines', 'Improve CTAs'], preserves: ['Page layout', 'Images'] }],
      editable_prompt: instructions || 'Optimize headlines, CTAs, and body copy for better conversion rates.',
    };
  }

  return NextResponse.json({ plan });
}

async function handlePagePlan(body: Record<string, unknown>) {
  const { prompt: userPrompt, vertical, custom_vertical, brand_settings } = body;

  const prompt = `You are planning a landing page to build.

## User's Request
${userPrompt}

## Vertical: ${custom_vertical || vertical}
${brand_settings ? `## Brand Settings\n${JSON.stringify(brand_settings, null, 2)}` : ''}

## Task
Create a build plan showing what the landing page will include. Describe:
- The overall design direction and style
- Each section of the page (hero, features, testimonials, CTA, etc.)
- Key elements and content strategy

Also generate an "editable_prompt" — a detailed, natural-language brief that the user can review and edit before generation begins. This should read like a creative brief to a designer, with specifics about sections, content, style, and conversion strategy.

Return ONLY valid JSON:
{
  "summary": "1-2 sentence overview of the page being built",
  "sections": [
    {
      "title": "Section name (e.g., Hero, Features, Social Proof)",
      "description": "What this section will contain and its purpose"
    }
  ],
  "design_notes": "Overall design direction, colors, typography, mood",
  "editable_prompt": "Detailed creative brief describing the full page plan that the user can modify..."
}`;

  const response = await ask(prompt, {
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1024,
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
        { title: 'Features/Services', description: 'Key offerings and benefits' },
        { title: 'Social Proof', description: 'Testimonials or trust signals' },
        { title: 'CTA', description: 'Final conversion section' },
      ],
      design_notes: 'Professional, conversion-focused design',
      editable_prompt: String(userPrompt),
    };
  }

  return NextResponse.json({ plan });
}
