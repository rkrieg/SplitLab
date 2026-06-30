import Anthropic from '@anthropic-ai/sdk';

const MIN_CONTENT_LENGTH = 200; // below this = bot block / empty SPA shell / error page

export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>)]+/gi) ?? [];
  return Array.from(new Set(matches));
}

/**
 * Fetches one or more competitor URLs via Claude's server-side web_fetch tool
 * and returns a prose summary of the visual design, section structure, layout
 * patterns, and copy tone. Returns null if the fetch fails, is blocked, or
 * returns too little content (JS SPA shell, Cloudflare wall, etc.).
 *
 * Callers must toast the user and fall back to the normal no-URL flow on null.
 */
export async function fetchCompetitorContent(urls: string[]): Promise<string | null> {
  if (urls.length === 0) return null;

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;

  try {
    const anthropic = new Anthropic({ apiKey });
    const model = process.env.ANTHROPIC_MODEL?.trim() ?? 'claude-sonnet-4-6';

    const urlList = urls.map((u, i) => `${i + 1}. ${u}`).join('\n');

    const response = await anthropic.messages.create({
      model,
      max_tokens: 2048,
      tools: [{ type: 'web_fetch_20260209' as const, name: 'web_fetch' }],
      messages: [
        {
          role: 'user',
          content: `Fetch the following URL(s) and analyze the website:\n${urlList}\n\nExtract and summarize (max 800 words total):\n1. Visual style — color palette (hex values if visible in CSS/inline styles), typography (font families, weight, size feel), overall aesthetic\n2. Section structure and order (e.g. hero → features → testimonials → pricing → contact)\n3. Layout patterns (split two-column hero, card grid, alternating rows, etc.)\n4. Tone of voice from the headlines and body copy\n5. Any standout design decisions worth replicating\n\nDo not include raw HTML or CSS. Return clean prose only.`,
        },
      ],
    });

    const textContent = response.content
      .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (textContent.length < MIN_CONTENT_LENGTH) return null;

    return textContent;
  } catch (err) {
    console.error('[fetchCompetitorContent] failed:', err);
    return null;
  }
}
