import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getClient } from '@/lib/claude';

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
  "vertical": "legal" | "saas" | "local" | "ecommerce" | "other",
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

## Section types (use only these)
- { "type": "benefits", "headline": "...", "items": ["...", "..."] }
- { "type": "social_proof", "headline": "...", "testimonials": [{ "name": "...", "quote": "..." }] }
- { "type": "pricing", "headline": "...", "tiers": [{ "name": "...", "price": "...", "features": ["..."] }] }
- { "type": "form", "headline": "...", "fields": ["name", "email", "phone"], "submit_text": "..." }
- { "type": "faq", "headline": "...", "items": [{ "q": "...", "a": "..." }] }
- { "type": "team", "headline": "...", "members": [{ "name": "...", "role": "...", "bio": "..." }] }
- { "type": "video", "headline": "...", "video_url": null, "caption": "..." }

## Content rules
- Write real, compelling copy based on the business. No placeholders, no lorem ipsum.
- The user has pre-selected a vertical — treat it as a strong structural bias but refine based on prompt context.
- Default section sets:
  - lead_gen: hero, benefits, social_proof, form, footer
  - saas: hero, benefits, pricing, faq, footer
  - local: hero, benefits, form, footer`;

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { prompt, vertical, conversation_json } = await request.json();

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const validVerticals = ['lead_gen', 'saas', 'local'] as const;
    type Vertical = typeof validVerticals[number];
    const selectedVertical: Vertical | null = validVerticals.includes(vertical) ? vertical : null;

    const systemPrompt = selectedVertical
      ? `${SYSTEM_PROMPT}\n\nThe user selected vertical: ${selectedVertical}. Use this as the primary structural bias.`
      : SYSTEM_PROMPT;

    const history: { role: 'user' | 'assistant'; content: string }[] = Array.isArray(conversation_json)
      ? conversation_json
      : [];

    const messages: { role: 'user' | 'assistant'; content: string }[] = [
      ...history,
      { role: 'user', content: prompt },
    ];

    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    });

    const block = response.content[0];
    if (block.type !== 'text') {
      return NextResponse.json({ error: 'Unexpected response from Claude' }, { status: 500 });
    }

    let parsed: { type: 'questions' | 'schema'; questions?: string[]; schema?: unknown };
    try {
      const raw = block.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'Claude returned invalid JSON', raw: block.text }, { status: 500 });
    }

    if (parsed.type !== 'questions' && parsed.type !== 'schema') {
      return NextResponse.json({ error: 'Unexpected response shape', raw: block.text }, { status: 500 });
    }

    return NextResponse.json(parsed);
  } catch (err) {
    console.error('[pages/generate]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
