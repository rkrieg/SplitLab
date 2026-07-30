// UTM Personalization V2 — hero auto-field-mapping, raw/uploaded-HTML tier.
// See docs/utm-personalization-v2-automation.md ("Hero auto-field-mapping design").
//
// Raw/uploaded HTML has no data-field markup to read (unlike AI-generated
// pages — see hero-field-detection.ts for that tier). This tier makes an AI
// call to identify which elements *are* the hero heading/subhead/CTA/image,
// then injects data-field="hero.X" attributes into the stored HTML so the
// exact same attribute-parser from hero-field-detection.ts can build the
// selector map afterward — no separate selector-building path needed.
//
// data-field is used instead of a new `id` because a DOM element can only
// carry one id, and the manual "Map Elements" flow may have already
// injected one on this exact element (inject-field-id/route.ts). Using a
// different attribute namespace avoids any collision with manual mapping,
// regardless of whether it has touched this element or not.

import Anthropic from '@anthropic-ai/sdk';
import { HERO_FIELD_CONFIG, HERO_FIELD_KEYS, detectHeroFieldsFromHtml, type HeroFieldSelectors } from '@/lib/hero-field-detection';
// htmlparser2 + dom-serializer are CJS packages already installed as transitive deps
// (same pattern as inject-field-id/route.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseDocument } = require('htmlparser2') as typeof import('htmlparser2');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const render = require('dom-serializer').default as typeof import('dom-serializer').default;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const CANDIDATE_TAGS = ['h1', 'h2', 'h3', 'p', 'span', 'div', 'a', 'button', 'img'];
const MAX_CANDIDATES = 120;
const MAX_TEXT_PREVIEW = 80;

interface Candidate {
  indexPath: string;
  tag: string;
  text?: string;
  src?: string;
}

function textOf(el: Node): string {
  let out = '';
  function walk(node: Node) {
    if (node.type === 'text') out += node.data;
    else if (node.children) node.children.forEach(walk);
  }
  walk(el);
  return out.replace(/\s+/g, ' ').trim();
}

// Collects candidate elements from roughly the first screenful of markup
// (first CANDIDATE_TAGS matches, depth-first, capped) — the hero section is
// always near the top of the document, so there's no need to scan the
// entire page and risk picking a footer CTA or an unrelated image.
function collectCandidates(rootChildren: Node[]): { candidates: Candidate[]; nodesByPath: Map<string, Node> } {
  const candidates: Candidate[] = [];
  const nodesByPath = new Map<string, Node>();

  function walk(nodes: Node[], prefix: number[]) {
    if (candidates.length >= MAX_CANDIDATES) return;
    const elements = nodes.filter((n: { type: string }) => n.type === 'tag');
    elements.forEach((el, idx) => {
      if (candidates.length >= MAX_CANDIDATES) return;
      const path = [...prefix, idx];
      const indexPath = path.join('/');
      const tag = (el.name as string).toLowerCase();

      if (CANDIDATE_TAGS.includes(tag)) {
        nodesByPath.set(indexPath, el);
        if (tag === 'img') {
          const src = el.attribs?.src ?? '';
          if (src) candidates.push({ indexPath, tag, src });
        } else {
          const text = textOf(el).slice(0, MAX_TEXT_PREVIEW);
          if (text) candidates.push({ indexPath, tag, text });
        }
      }

      if (el.children) walk(el.children, path);
    });
  }

  walk(rootChildren, []);
  return { candidates, nodesByPath };
}

let anthropicClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

async function identifyHeroElements(candidates: Candidate[]): Promise<Record<string, string | null>> {
  const fieldDescriptions = HERO_FIELD_KEYS
    .map(key => `- "${key}" (${HERO_FIELD_CONFIG[key].type}): ${HERO_FIELD_CONFIG[key].label}`)
    .join('\n');

  const msg = await getClient().messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 512,
    system: `You are identifying the hero section of a landing page from a list of candidate DOM elements (each with its indexPath, tag, and a short text/src preview). The hero section is the main above-the-fold block: a headline, optionally a subheadline/supporting text, a primary call-to-action, and optionally a background/hero image.

Fields to identify:
${fieldDescriptions}

Rules:
- Only pick elements that are actually part of the hero section — never a nav link, footer text, an unrelated card, or a secondary/repeated CTA further down the page.
- If you are not confident an element matches a field, return null for that field rather than guessing.
- If there is no identifiable hero section at all, return null for every field.
- Return ONLY a valid JSON object mapping each of the ${HERO_FIELD_KEYS.length} field keys above to either the exact indexPath string of the matching candidate, or null. No explanation, no markdown, no code fences.`,
    messages: [
      {
        role: 'user',
        content: `Candidates:\n${JSON.stringify(candidates, null, 0)}`,
      },
    ],
  });

  const textBlock = msg.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return {};

  try {
    const cleaned = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(cleaned);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Identifies hero elements in raw/uploaded HTML via AI, injects
 * data-field="hero.X" attributes into the matched elements, and returns the
 * mutated HTML plus the resulting selector map (built by re-running the
 * same attribute-parser tier 1 uses, on the newly-injected markup).
 *
 * Returns null if no hero elements could be confidently identified (no hero
 * section, or ambiguous/messy markup) — callers should treat that as a
 * clean "detection failed," not throw, and fall back to manual mapping.
 *
 * Does not write anything to the database — callers are responsible for
 * persisting the returned HTML and selectors as a single atomic update.
 */
export async function detectAndInjectHeroFieldsRawHtml(
  html: string
): Promise<{ updatedHtml: string; selectors: HeroFieldSelectors } | null> {
  const dom = parseDocument(html);
  const htmlEl = (dom.children as Node[]).find((n: Node) => n.type === 'tag' && n.name === 'html');
  const rootChildren = htmlEl ? htmlEl.children : dom.children;

  const { candidates, nodesByPath } = collectCandidates(rootChildren);
  if (candidates.length === 0) return null;

  let identified: Record<string, string | null>;
  try {
    identified = await identifyHeroElements(candidates);
  } catch {
    return null;
  }

  let injectedAny = false;
  for (const key of HERO_FIELD_KEYS) {
    const indexPath = identified[key];
    if (!indexPath || typeof indexPath !== 'string') continue;

    const el = nodesByPath.get(indexPath);
    if (!el) continue; // AI returned a path that doesn't match a real candidate — skip, don't guess

    el.attribs = { ...el.attribs, 'data-field': `hero.${key}` };
    injectedAny = true;
  }

  if (!injectedAny) return null;

  const updatedHtml = render(dom, { decodeEntities: false });
  const selectors = detectHeroFieldsFromHtml(updatedHtml);
  if (!selectors) return null;

  return { updatedHtml, selectors };
}
