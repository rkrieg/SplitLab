import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { downloadHtmlByPath, fileNameFromUrl, uploadHtml } from '@/lib/storage';
import { detectHeroFieldsFromHtml, type HeroFieldSelectors } from '@/lib/hero-field-detection';
import { detectAndInjectHeroFieldsRawHtml } from '@/lib/hero-field-detection-raw';
import { readFieldValueFromHtml } from '@/lib/html-field-read';
import Anthropic from '@anthropic-ai/sdk';

// UTM Personalization V2 (auto-detection) — content generation for a
// detected UTM combination. Mirrors the existing manual "AI Suggest" route
// (suggest-headlines/route.ts: reads current live field values first, per-
// field word-limit guidance), but:
//   - generates all of a page's mapped fields in one call instead of 5
//     variants of a single field, since this content may go live with
//     lighter human review than the manual flow
//   - uses Sonnet instead of Haiku for that reason
// See docs/utm-personalization-v2-automation.md.

let anthropicClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

type StoredFieldSelectors = Record<string, { selector: string; type: 'text' | 'image'; label: string }>;

function getFieldGuidance(fieldKey: string): string {
  switch (fieldKey) {
    case 'headline':
      return 'Under 10 words. Lead with the outcome or benefit, not the product name.';
    case 'subhead':
      return '1 short sentence, under 20 words. Support and expand on the headline with a concrete detail.';
    case 'cta_text':
      return '2-4 words. Action-oriented, imperative verb first (e.g. "Get Started"). No end punctuation.';
    default:
      return 'Under 15 words. Keep it consistent in tone with the rest of the page.';
  }
}

interface Condition {
  match_param: string;
  match_value: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, schema_json, field_selectors_json, auto_field_selectors_json, html_content, html_url')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json();
  const conditions = body.conditions as Condition[] | undefined;
  const hint = typeof body.hint === 'string' ? body.hint.trim().slice(0, 500) : '';

  if (!Array.isArray(conditions) || conditions.length === 0) {
    return NextResponse.json({ error: 'conditions is required' }, { status: 400 });
  }

  // Hero auto-mapping: this endpoint only ever uses auto_field_selectors_json
  // (either already detected on a prior call, or detected below via tier 1/2).
  // It deliberately does NOT fall back to manual field_selectors_json if
  // detection fails — silently swapping in a different, independent store
  // would be confusing (this is the AUTO flow; manual mapping is a separate
  // system with its own UI). If neither tier can identify a hero section,
  // that's surfaced as an explicit "detection failed" error below instead.
  let heroFieldSelectors = (page.auto_field_selectors_json as HeroFieldSelectors | null) ?? null;

  // Fetched once, reused for tier 1/2 detection and for reading current
  // live field values below (kept in sync with whichever HTML ends up live
  // after a possible raw-HTML injection write).
  let html = page.html_content as string | null;
  if (!html && page.html_url) {
    try {
      html = await downloadHtmlByPath(fileNameFromUrl(page.html_url as string));
    } catch {
      html = null;
    }
  }

  if (!heroFieldSelectors && html) {
    // Tier 1: AI-generated pages already carry data-field="hero.*" — just parse it.
    const tier1 = detectHeroFieldsFromHtml(html);
    if (tier1) {
      const { error: saveError } = await db
        .from('pages')
        .update({ auto_field_selectors_json: tier1 })
        .eq('id', params.id);
      if (!saveError) heroFieldSelectors = tier1;
    } else {
      // Tier 2: raw/uploaded HTML has no such markup — ask AI to identify
      // the hero elements and inject data-field attributes, then persist
      // the mutated HTML and the resulting selectors as a single atomic
      // write (a partial write here would leave broken mappings — see
      // edge case 2 in the design doc).
      let tier2: { updatedHtml: string; selectors: HeroFieldSelectors } | null = null;
      try {
        tier2 = await detectAndInjectHeroFieldsRawHtml(html);
      } catch {
        tier2 = null; // ambiguous/failed detection — fall through to manual mapping, not an error
      }

      if (tier2) {
        const updatePayload: Record<string, unknown> = {
          html_content: tier2.updatedHtml,
          auto_field_selectors_json: tier2.selectors,
        };
        // Mirror the existing live-HTML-replace pattern (route.ts) — if this
        // page has a storage file, it must be re-uploaded too, or serve/
        // preview would keep reading the pre-injection HTML from storage.
        if (page.html_url) {
          try {
            updatePayload.html_url = await uploadHtml(fileNameFromUrl(page.html_url as string), tier2.updatedHtml);
          } catch {
            // Storage upload failed — abort the whole write rather than saving
            // selectors that point at markup the storage file doesn't have yet.
            tier2 = null;
          }
        }

        if (tier2) {
          const { error: saveError } = await db.from('pages').update(updatePayload).eq('id', params.id);
          if (!saveError) {
            heroFieldSelectors = tier2.selectors;
            html = tier2.updatedHtml;
          }
        }
      }
    }
  }

  if (!heroFieldSelectors) {
    // Both tiers ran (or there was no HTML to run them on) and neither could
    // identify a hero section — edge cases 3/4 in the design doc (no hero
    // section on this page, or markup too ambiguous to confidently map).
    // Explicit, distinct error rather than silently trying manual mapping.
    return NextResponse.json(
      { error: 'Could not automatically detect this page\'s hero fields. This page may not have a clear hero section, or its layout is too ambiguous to map automatically.' },
      { status: 422 }
    );
  }

  const fieldSelectors: StoredFieldSelectors = heroFieldSelectors;
  const textFields = Object.entries(fieldSelectors).filter(([, f]) => f.type === 'text');

  if (textFields.length === 0) {
    return NextResponse.json({ error: 'This page has no mapped text fields to personalize yet.' }, { status: 400 });
  }

  const schema = (page.schema_json as Record<string, unknown> | null) ?? null;
  const hero = (schema?.hero as Record<string, unknown> | undefined) ?? {};

  // Read each field's actual current value straight from the live HTML via
  // its selector — schema_json.hero only covers AI-generated pages' fixed
  // hero.* keys and is never populated for raw-HTML/manual field keys, so
  // relying on it alone left "current content" blank for anything outside
  // that one case. Falls back to schema_json.hero, then blank, if the
  // selector can't be resolved (e.g. storage fetch failed above).
  function currentValueOf(key: string, f: { selector: string; type: 'text' | 'image' }): string {
    if (html) {
      const val = readFieldValueFromHtml(html, f.selector, f.type);
      if (val) return val;
    }
    return (hero[key] as string) ?? '';
  }

  const conditionDescription = conditions
    .map(c => `${c.match_param} = "${c.match_value}"`)
    .join(' AND ');

  const currentContent = textFields
    .map(([key, f]) => `- ${f.label} (key: "${key}"): "${currentValueOf(key, f)}"`)
    .join('\n');

  const fieldRules = textFields
    .map(([key, f]) => `- "${key}" (${f.label}): ${getFieldGuidance(key)}`)
    .join('\n');

  const msg = await getClient().messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    system: `You are a conversion copywriter for landing pages. This content will be shown automatically to visitors matched by a UTM rule, with limited or no human review before it goes live — be conservative, on-brand, and never invent claims not implied by the original content.

Business type: ${schema?.vertical ?? 'Unknown'}

Current live content for this page's mapped fields:
${currentContent}

Rewrite these fields for visitors matched by: ${conditionDescription}
${hint ? `Additional direction from the user: ${hint}` : 'No additional direction was given — infer the intent from the UTM value(s) above (e.g. an audience name, or a messaging angle like "affordable" or "guarantee").'}

Per-field rules:
${fieldRules}

Rules:
- Keep the same subject matter and offer as the original — only shift emphasis/angle, never invent new claims, prices, or guarantees not implied by the current content.
- Return ONLY a valid JSON object mapping each field key to its new string value, no explanation, no markdown, no code fences. Include every field key listed above, even if unchanged.`,
    messages: [
      {
        role: 'user',
        content: 'Generate the personalized field values now.',
      },
    ],
  });

  const textBlock = msg.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return NextResponse.json({ error: 'AI did not return usable content' }, { status: 502 });
  }

  let overrides: Record<string, string>;
  try {
    const cleaned = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    overrides = JSON.parse(cleaned);
  } catch {
    return NextResponse.json({ error: 'AI returned invalid JSON' }, { status: 502 });
  }

  return NextResponse.json({ overrides_json: overrides });
}
