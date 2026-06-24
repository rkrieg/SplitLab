import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { getClient } from '@/lib/claude';
import { uploadHtml, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

const SYSTEM_PROMPT = `You are editing an existing landing page. The user will give you an instruction to modify the page.

## Your job
1. Decide if the change is structural or a style/content patch.
   - Structural: adds, removes, or reorders sections (the schema changes)
   - Style/patch: changes text copy, colors, fonts, spacing, button labels, images (schema shape stays the same)

2. Return JSON only. No explanation, no markdown fences, no extra text.

## Output shapes

Structural change:
{"type":"structural","schema_json":{...updated full schema...},"html":"<!DOCTYPE html>...full regenerated HTML..."}

Style/patch change:
{"type":"style","html":"<!DOCTYPE html>...full patched HTML..."}

## HTML rules (apply to both types)
- Return the complete HTML document every time — never a partial snippet
- Keep all existing data-field attributes intact
- For structural changes, add data-field attributes to any new elements
- <!-- TRACKER_PLACEHOLDER --> must remain just before </body>
- All CSS inline in <style> tag, fully responsive`;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, html_url, html_content, schema_json, conversation_json, slug')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const { prompt, current_schema, current_html, conversation_json } = await request.json();

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const schema = current_schema ?? page.schema_json;
    const html = current_html ?? page.html_content ?? (page.html_url ? await fetch(page.html_url).then(r => r.text()) : null);
    const history: { role: 'user' | 'assistant'; content: string }[] = Array.isArray(conversation_json)
      ? conversation_json
      : Array.isArray(page.conversation_json)
      ? page.conversation_json
      : [];

    if (!html) return NextResponse.json({ error: 'Could not load current HTML' }, { status: 400 });

    const userMessage = `Current schema:\n${JSON.stringify(schema, null, 2)}\n\nCurrent HTML:\n${html}\n\nInstruction: ${prompt}`;

    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [
        ...history,
        { role: 'user', content: userMessage },
      ],
    });

    const block = response.content[0];
    if (block.type !== 'text') {
      return NextResponse.json({ error: 'Unexpected response from Claude' }, { status: 500 });
    }

    let raw = block.text.trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    }

    let parsed: { type: 'structural' | 'style'; schema_json?: unknown; html: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'Claude returned invalid JSON', raw: raw.slice(0, 500) }, { status: 500 });
    }

    if (!parsed.html || (!parsed.html.startsWith('<!DOCTYPE') && !parsed.html.startsWith('<html'))) {
      return NextResponse.json({ error: 'Claude returned invalid HTML' }, { status: 500 });
    }

    // Re-upload HTML to the same storage path
    const storagePath = fileNameFromUrl(page.html_url);
    const htmlUrl = await uploadHtml(storagePath, parsed.html);

    // Append to conversation history
    const updatedConversation = [
      ...history,
      { role: 'user', content: prompt },
      { role: 'assistant', content: JSON.stringify({ type: parsed.type, schema_json: parsed.schema_json ?? schema }) },
    ];

    // Build DB update payload
    const updatePayload: Record<string, unknown> = {
      html_url: htmlUrl,
      html_content: parsed.html.length < 500_000 ? parsed.html : null,
      conversation_json: updatedConversation,
      updated_at: new Date().toISOString(),
    };

    if (parsed.type === 'structural' && parsed.schema_json) {
      updatePayload.schema_json = parsed.schema_json;
    }

    await db.from('pages').update(updatePayload).eq('id', params.id);

    const result: Record<string, unknown> = { html_url: htmlUrl };
    if (parsed.type === 'structural') result.schema_json = parsed.schema_json;

    return NextResponse.json(result);
  } catch (err) {
    console.error('[pages/follow-up]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
