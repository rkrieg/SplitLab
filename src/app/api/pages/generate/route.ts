import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { askAI } from '@/lib/ai-client';
import { VERTICAL_VALUES } from '@/lib/ai-page-verticals';
import { SECTION_VOCABULARY, VERTICAL_PRIORITY_HINTS } from '@/lib/ai-page-vocabulary';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

const SECTION_TYPES_BLOCK = SECTION_VOCABULARY
  .map(s => `- ${s.schemaExample}\n  Use when: ${s.whenToUse}`)
  .join('\n');

const SYSTEM_PROMPT = `You are an AI landing page builder. Your job is to either ask clarifying questions or generate a page schema — never both, never anything else.

## Output rules
- Return JSON only. No explanation, no markdown fences, no extra text.
- Two valid output shapes:

Shape 1 — clarifying questions (only when prompt is too vague):
{"type":"questions","questions":["question 1","question 2","question 3"]}

Shape 2 — page schema (when you have enough to build):
{"type":"schema","schema":{...}}

## When to ask questions vs build immediately
Ask questions ONLY if the prompt is missing ALL of: a goal, specific sections, or business details.
If the user says "surprise me" or "just build it" — generate the best default schema for the vertical. Never ask again.
Maximum 1 round of questions, maximum 3 questions per round.

## Schema structure
{
  "vertical": "<short free-text description of the inferred business type, e.g. 'boutique skincare ecommerce' or 'B2B compliance SaaS'>",
  "hero": {
    "headline": "...",
    "subhead": "...",
    "cta_text": "...",
    "cta_url": "#contact"
  },
  "sections": [ ...section objects... ],
  "footer": {
    "copyright": "...",
    "links": ["Privacy Policy", "Terms of Service"]
  }
}

## Section types (available moves — pick a varied combination per page, not the same 4-5 every time)
${SECTION_TYPES_BLOCK}

## Content rules
- Write real, compelling copy based on the business. No placeholders, no lorem ipsum.
- The user has pre-selected a vertical — treat it as a bias toward certain section types (see the per-vertical hint appended below), not a fixed template. Refine based on the specific prompt.
- Pick 4-7 sections beyond hero/footer. More variety across pages is better than defaulting to the same shape every time.`;

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { prompt, vertical, conversation_json, workspace_id } = await request.json();

    if (!workspace_id || typeof workspace_id !== 'string') {
      return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
    }
    const wsRole = await resolveWorkspaceRole(workspace_id, session.user.id, session.user.role);
    if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const selectedVertical: string | null = VERTICAL_VALUES.includes(vertical) ? vertical : null;
    const priorityHint = selectedVertical ? VERTICAL_PRIORITY_HINTS[selectedVertical] : null;

    const systemPrompt = selectedVertical
      ? `${SYSTEM_PROMPT}\n\nThe user selected vertical: ${selectedVertical}.${priorityHint ? ` ${priorityHint}` : ''}`
      : SYSTEM_PROMPT;

    const history: { role: 'user' | 'assistant'; content: string }[] = Array.isArray(conversation_json)
      ? conversation_json
      : [];

    const messages: { role: 'user' | 'assistant'; content: string }[] = [
      ...history,
      { role: 'user', content: prompt },
    ];

    const text = await askAI({ system: systemPrompt, messages, maxTokens: 4096 });

    let parsed: { type: 'questions' | 'schema'; questions?: string[]; schema?: unknown };
    try {
      const raw = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'AI provider returned invalid JSON', raw: text }, { status: 500 });
    }

    if (parsed.type !== 'questions' && parsed.type !== 'schema') {
      return NextResponse.json({ error: 'Unexpected response shape', raw: text }, { status: 500 });
    }

    return NextResponse.json(parsed);
  } catch (err) {
    console.error('[pages/generate]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
