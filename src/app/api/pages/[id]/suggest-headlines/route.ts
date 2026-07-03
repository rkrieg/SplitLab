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
  const { match_param, match_value, current_headline, page_context } = body as {
    match_param: string;
    match_value: string;
    current_headline: string;
    page_context: string;
  };

  if (!match_param || !match_value) {
    return NextResponse.json({ error: 'match_param and match_value are required' }, { status: 400 });
  }

  const msg = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: `You are a conversion copywriter. Generate exactly 5 short, punchy landing page headline variants tailored to visitors from a specific UTM segment.
Rules:
- Each headline must be under 10 words
- Make each one feel personal and relevant to that traffic source
- Return ONLY a valid JSON array of 5 strings with no explanation, no markdown, no code fences`,
    messages: [
      {
        role: 'user',
        content: `Page context: ${page_context || 'No additional context provided.'}
Current headline: "${current_headline || 'No headline set'}"
UTM segment: ${match_param} = ${match_value}

Generate 5 headline variants for visitors from this UTM segment.`,
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
