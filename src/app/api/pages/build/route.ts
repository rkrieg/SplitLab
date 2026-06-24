import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getClient } from '@/lib/claude';
import { uploadHtml } from '@/lib/storage';

const SYSTEM_PROMPT = `You are an expert HTML/CSS developer building high-converting landing pages.

## Output rules
- Return raw HTML only. No explanation, no markdown fences, no extra text.
- The output must be a complete, self-contained HTML document starting with <!DOCTYPE html>.

## Required structure
- Full <head> with: charset, viewport, descriptive <title>, <meta name="description">, Open Graph tags
- All CSS must be inline in a <style> tag in <head> — no external stylesheets, no CDN links
- <!-- TRACKER_PLACEHOLDER --> comment just before </body> — tracker.js will be injected here on publish

## data-field attributes
Every piece of editable text or image must have a data-field attribute matching its schema key.
Examples:
- <h1 data-field="hero.headline">Headline text</h1>
- <p data-field="hero.subhead">Subhead text</p>
- <a data-field="hero.cta_text" href="...">CTA text</a>
- <img data-field="hero.background_image" src="..." />
- Section items use indexed keys: data-field="benefits.items.0", data-field="benefits.items.1"
- Testimonial fields: data-field="social_proof.testimonials.0.name", data-field="social_proof.testimonials.0.quote"
- FAQ fields: data-field="faq.items.0.q", data-field="faq.items.0.a"

## Design rules
- Fully responsive — mobile-first, works on all screen sizes
- Dark, modern aesthetic with strong contrast
- Use CSS gradients as background fallbacks for any image fields with null values
- Hero section must be visually striking — full-width, gradient or dark background, large headline
- Forms must be styled and functional (HTML only — no JS submission logic needed)
- CTAs must be prominent with hover states
- Typography: system font stack, clear hierarchy

## Image fallbacks
If a schema field for an image is null or missing, use a CSS gradient background instead. Never use placeholder image URLs.`;

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { schema_json, slug } = await request.json();

    if (!schema_json || typeof schema_json !== 'object') {
      return NextResponse.json({ error: 'schema_json is required' }, { status: 400 });
    }

    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Build the landing page for this schema:\n\n${JSON.stringify(schema_json, null, 2)}`,
        },
      ],
    });

    const block = response.content[0];
    if (block.type !== 'text') {
      return NextResponse.json({ error: 'Unexpected response from Claude' }, { status: 500 });
    }

    let html = block.text.trim();

    // Strip markdown fences Claude occasionally wraps output in despite instructions
    if (html.startsWith('```')) {
      html = html.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    }

    if (!html.startsWith('<!DOCTYPE') && !html.startsWith('<html')) {
      return NextResponse.json({ error: 'Claude returned invalid HTML', raw: html.slice(0, 500) }, { status: 500 });
    }

    const pageSlug = slug ?? crypto.randomUUID();
    const storagePath = `pages/${pageSlug}.html`;
    const htmlUrl = await uploadHtml(storagePath, html);

    return NextResponse.json({ html_url: htmlUrl, slug: pageSlug });
  } catch (err) {
    console.error('[pages/build]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
