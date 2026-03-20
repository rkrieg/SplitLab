import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { ask } from '@/lib/claude';

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'admin' && session.user.role !== 'manager')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { instructions } = await request.json();
  if (!instructions?.trim()) {
    return NextResponse.json({ error: 'Instructions required' }, { status: 400 });
  }

  const response = await ask(
    `You are validating custom instructions for an A/B test variant generator. This tool can ONLY make text-based changes to a landing page — it does find-and-replace on visible text content. It CANNOT:
- Change visual design, colors, backgrounds, or layouts
- Redesign sections or restructure the page
- Add/remove images or change styling
- Modify CSS, fonts, or spacing

## User's Instructions
${instructions}

## Task
Analyze the instructions and return a JSON object:
{
  "valid": true/false (false if the instructions ask for things the variant generator cannot do),
  "interpretation": "1-sentence description of what you understand the user wants",
  "will_do": ["list of specific text changes that CAN be done, e.g., 'Test more action-oriented CTA button text', 'Rewrite section headlines to lead with benefits'"],
  "warnings": ["list of things the user seems to want that CANNOT be done with text-only changes, e.g., 'Cannot redesign the hero section layout — use the Page Builder for visual changes', 'Cannot change background colors or gradients'"]
}

If the instructions are purely about text/copy changes, set valid=true and warnings=[].
If they ask for ANY visual/structural changes, set valid=false and explain what can vs. can't be done.

Return ONLY valid JSON, no markdown fences.`,
    {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 512,
    }
  );

  let plan;
  try {
    let cleaned = response.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    }
    plan = JSON.parse(cleaned);
  } catch {
    plan = {
      valid: true,
      interpretation: 'Apply custom instructions to variant generation.',
      will_do: [instructions],
      warnings: [],
    };
  }

  return NextResponse.json(plan);
}
