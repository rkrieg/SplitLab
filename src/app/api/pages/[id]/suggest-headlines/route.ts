import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import Anthropic from '@anthropic-ai/sdk';

let anthropicClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

function getFieldGuidance(fieldKey: string): string {
  switch (fieldKey) {
    case 'headline':
      return '- Each variant must be under 10 words\n- Lead with the outcome or benefit, not the product name';
    case 'subhead':
      return '- Each variant must be 1 short sentence (under 20 words)\n- Support and expand on the headline, add a concrete detail or proof point';
    case 'cta_text':
      return '- Each variant must be 2-4 words\n- Action-oriented, imperative verb first (e.g. "Get Started", "Book a Demo")\n- No punctuation at the end';
    default:
      return '- Each variant must be under 15 words\n- Keep it consistent in tone with the rest of the page';
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, schema_json')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json();
  const { match_param, match_value, field_key, field_label, current_value } = body as {
    match_param: string;
    match_value: string;
    field_key: string;
    field_label: string;
    current_value: string;
  };

  if (!match_param || !match_value) {
    return NextResponse.json({ error: 'match_param and match_value are required' }, { status: 400 });
  }
  if (!field_key || !field_label) {
    return NextResponse.json({ error: 'field_key and field_label are required' }, { status: 400 });
  }

  const schema = (page.schema_json as Record<string, unknown> | null) ?? null;
  const hero = (schema?.hero as Record<string, unknown> | undefined) ?? {};
  const businessContext = schema
    ? `Business type: ${schema.vertical ?? 'Unknown'}
Original headline: "${hero.headline ?? ''}"
Original subhead: "${hero.subhead ?? ''}"
Original CTA: "${hero.cta_text ?? ''}"`
    : 'No business context available.';

  const fieldGuidance = getFieldGuidance(field_key);

  const msg = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: `You are a conversion copywriter for landing pages. Generate exactly 5 variants of the "${field_label}" element, tailored to visitors from a specific UTM segment.
Rules:
${fieldGuidance}
- Match the tone and subject matter of the business context provided — never generic filler
- Make each variant feel personal and relevant to that traffic source
- Return ONLY a valid JSON array of 5 strings with no explanation, no markdown, no code fences`,
    messages: [
      {
        role: 'user',
        content: `${businessContext}

Field being personalized: ${field_label}
Current value for this field: "${current_value || 'Not set — use the original as a starting point'}"
UTM segment: ${match_param} = ${match_value}

Generate 5 "${field_label}" variants for visitors arriving from this UTM segment.`,
      },
    ],
  });

  const raw = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';

  let suggestions: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      suggestions = parsed.filter((s): s is string => typeof s === 'string').slice(0, 5);
    }
  } catch {
    // Attempt to extract array if Haiku wrapped it in extra text
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          suggestions = parsed.filter((s): s is string => typeof s === 'string').slice(0, 5);
        }
      } catch { /* give up */ }
    }
  }

  if (suggestions.length === 0) {
    return NextResponse.json({ error: 'Failed to generate suggestions' }, { status: 500 });
  }

  return NextResponse.json({ suggestions });
}
