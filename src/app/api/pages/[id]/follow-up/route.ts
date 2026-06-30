import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { askAI, isRateLimited, type AIContent, type AIContentBlock } from '@/lib/ai-client';
import { uploadHtml, downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { extractUrls, fetchCompetitorContent } from '@/lib/ai-competitor-fetch';

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
- All CSS inline in <style> tag, fully responsive

## Motion — safety is non-negotiable
- If the instruction asks for a specific visual/animation effect, implement it faithfully.
- Default to CSS-only motion (@keyframes/transition) — this covers nearly every effect. Only reach for JS if CSS genuinely cannot do it (e.g. cycling through multiple distinct text/content values over time). If you are not fully confident the JS you'd write is safe, do NOT add it — a working CSS-only effect beats a risky JS one. Never crash the page.
- If you do add decorative JS, copy this exact skeleton and only fill in the marked parts. Every callback gets its OWN try/catch — a try/catch around the setup code does NOT catch errors thrown later inside a setInterval/setTimeout callback, because those run in a new call stack:

<script>
(function () {
  try {
    var els = document.querySelectorAll('.YOUR-DECORATIVE-CLASS'); // must never select a data-field element
    if (!els.length) return;
    setInterval(function () {
      try {
        // your cycling logic here — wrap any nested setTimeout callback in its own try/catch too
      } catch (e) { /* never throw from inside the interval */ }
    }, 3000);
  } catch (e) { /* never throw from setup */ }
})();
</script>

- Never select or modify any element carrying a data-field attribute — that's user-editable content and must always stay visible/clickable.
- Never add an external <script src> to a third-party domain.
- Never include JavaScript copied verbatim from the instruction — always write your own minimal implementation inside the skeleton above.`;

function minifyHtmlForModel(html: string): string {
  return html
    .replace(/<!--(?!.*TRACKER_PLACEHOLDER)[\s\S]*?-->/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

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

  // Plan gate — before rate limiter so blocked users don't consume a slot
  if (session.user.role !== 'admin') {
    const ownerPlan = await resolveOwnerPlan(page.workspace_id);
    if (!PLAN_LIMITS[ownerPlan]?.aiPages) {
      return NextResponse.json(
        { error: 'AI page editing requires an Agency or Scale plan. Please upgrade to use this feature.', limitError: true },
        { status: 403 }
      );
    }
  }

  if (isRateLimited(session.user.id, 5, 60_000) || isRateLimited(session.user.id, 30, 3_600_000)) {
    return NextResponse.json({ error: 'You\'re sending messages too fast. Please wait a moment before trying again.' }, { status: 429 });
  }

  if (!page.html_url && !page.html_content) {
    return NextResponse.json({ error: 'Page has not been built yet' }, { status: 400 });
  }

  try {
    const { prompt, current_schema, current_html, image_urls } = await request.json();

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    if (image_urls !== undefined && (!Array.isArray(image_urls) || image_urls.length > 3)) {
      return NextResponse.json({ error: 'image_urls must be an array of at most 3 URLs' }, { status: 400 });
    }

    const schema = current_schema ?? page.schema_json;
    const html = current_html ?? page.html_content ?? (page.html_url ? await downloadHtmlByPath(fileNameFromUrl(page.html_url)) : null);
    // Always read from DB — client state may not have image_urls persisted in history entries
    const history: { role: 'user' | 'assistant'; content: string; image_urls?: string[] }[] =
      Array.isArray(page.conversation_json) ? page.conversation_json : [];

    if (!html) return NextResponse.json({ error: 'Could not load current HTML' }, { status: 400 });

    const htmlForModel = minifyHtmlForModel(
      html.replace(/<script src="[^"]+\/tracker\.js"><\/script>/, '<!-- TRACKER_PLACEHOLDER -->')
    );

    // Fetch competitor site(s) if the instruction contains URLs
    const mentionedUrls = extractUrls(prompt);
    const competitorContext = mentionedUrls.length > 0 ? await fetchCompetitorContent(mentionedUrls) : null;

    const urlNote = Array.isArray(image_urls) && image_urls.length > 0
      ? `\n\nUse EXACTLY these image URLs in the HTML (do not invent or substitute any other URLs):\n${(image_urls as string[]).map((u, i) => `Image ${i + 1}: ${u}`).join('\n')}`
      : '';
    const competitorNote = competitorContext
      ? `\n\n## Reference site analysis\nThe user referenced a site for style inspiration. Use this to inform the visual changes — keep all existing content but update the design direction accordingly:\n${competitorContext}`
      : '';
    const textContent = `Current schema:\n${JSON.stringify(schema, null, 2)}\n\nCurrent HTML:\n${htmlForModel}\n\nInstruction: ${prompt}${urlNote}${competitorNote}`;

    const userContent: AIContent =
      Array.isArray(image_urls) && image_urls.length > 0
        ? [
            ...image_urls.map((url: string): AIContentBlock => ({ type: 'image', url })),
            { type: 'text', text: textContent },
          ]
        : textContent;

    // Prior turns are replayed as plain text only — past image attachments
    // aren't re-sent as vision blocks here, only the current turn's images are.
    const text = await askAI({
      system: SYSTEM_PROMPT,
      messages: [
        ...history.map(({ role, content }) => ({ role, content })),
        { role: 'user' as const, content: userContent },
      ],
      maxTokens: 16000,
    });

    let raw = text.trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    }

    let parsed: { type: 'structural' | 'style'; schema_json?: unknown; html: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'AI provider returned invalid JSON', raw: raw.slice(0, 500) }, { status: 500 });
    }

    if (!parsed.html || (!parsed.html.startsWith('<!DOCTYPE') && !parsed.html.startsWith('<html'))) {
      return NextResponse.json({ error: 'AI provider returned invalid HTML' }, { status: 500 });
    }

    // Re-upload HTML to the same storage path
    const storagePath = fileNameFromUrl(page.html_url);
    const htmlUrl = await uploadHtml(storagePath, parsed.html);

    // Append to conversation history — include image_urls so they can be shown in chat on restore
    const userEntry: Record<string, unknown> = { role: 'user', content: prompt };
    if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
    const updatedConversation = [
      ...history,
      userEntry,
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
    if (mentionedUrls.length > 0 && !competitorContext) result.competitor_fetch_failed = true;

    return NextResponse.json(result);
  } catch (err) {
    console.error('[pages/follow-up]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
