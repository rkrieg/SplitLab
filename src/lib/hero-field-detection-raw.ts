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
import { extractJsonFromText } from '@/lib/ai-json';
// htmlparser2 + dom-serializer are CJS packages already installed as transitive deps
// (same pattern as inject-field-id/route.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseDocument } = require('htmlparser2') as typeof import('htmlparser2');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const render = require('dom-serializer').default as typeof import('dom-serializer').default;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const CANDIDATE_TAGS = ['h1', 'h2', 'h3', 'p', 'span', 'div', 'a', 'button', 'img'];
// Was 120 — found live (2026-07-31) against a real Unbounce-exported page
// (titan.html): heavy page-builder markup wraps every visual element in
// several nested boxes, so 327 candidate-tag elements appeared BEFORE the
// real hero content in document order. The true hero headline/CTA never
// reached the AI as candidates at all — it picked the closest-looking text
// from what it was given instead, silently mismatching the visible hero.
// Raised well past that observed count to give real-world page-builder
// exports enough headroom; still a heuristic cap, not a guarantee — an
// even more bloated page could still exceed it (accepted tradeoff, same
// cost/prompt-size class already flagged in docs/utm-personalization-v2-automation.md
// under "Cost/rate limiting").
const MAX_CANDIDATES = 400;
const MAX_TEXT_PREVIEW = 80;

interface Candidate {
  indexPath: string;
  tag: string;
  text?: string;
  src?: string;
  // indexPath of the nearest ANCESTOR that is also a candidate, if any — lets
  // the AI tell "this span IS the whole headline" apart from "this span is a
  // highlighted sub-phrase nested inside a larger heading/paragraph". Found
  // live (2026-07-31, titan.html): without this, a small gold-styled <span>
  // holding just "11% A Year Get A Check Every Month" was picked as
  // hero.headline instead of its parent <h2>, which wrapped the full
  // sentence ("We Loan Your Money To Real Estate Builders To Pay You 11% A
  // Year..."). Both the span and the h2 were separate flat candidates with
  // no indication one contained the other, so the AI had no way to prefer
  // the fuller element.
  parentIndexPath?: string;
  parentText?: string;
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

  function walk(nodes: Node[], prefix: number[], ancestorCandidate: Candidate | null) {
    if (candidates.length >= MAX_CANDIDATES) return;
    const elements = nodes.filter((n: { type: string }) => n.type === 'tag');
    elements.forEach((el, idx) => {
      if (candidates.length >= MAX_CANDIDATES) return;
      const path = [...prefix, idx];
      const indexPath = path.join('/');
      const tag = (el.name as string).toLowerCase();

      let nextAncestor = ancestorCandidate;
      if (CANDIDATE_TAGS.includes(tag)) {
        nodesByPath.set(indexPath, el);
        let entry: Candidate | null = null;
        if (tag === 'img') {
          const src = el.attribs?.src ?? '';
          if (src) entry = { indexPath, tag, src };
        } else {
          const text = textOf(el).slice(0, MAX_TEXT_PREVIEW);
          if (text) entry = { indexPath, tag, text };
        }
        if (entry) {
          if (ancestorCandidate) {
            entry.parentIndexPath = ancestorCandidate.indexPath;
            entry.parentText = ancestorCandidate.text;
          }
          candidates.push(entry);
          nextAncestor = entry;
        }
      }

      if (el.children) walk(el.children, path, nextAncestor);
    });
  }

  walk(rootChildren, [], null);
  return { candidates, nodesByPath };
}

// Deterministic fallback for headline/subhead: if the AI's picked element is
// an inline formatting tag (span/b/em/...) rather than an actual heading/
// paragraph, climb to the nearest h1-h6 ancestor instead. Found live
// (2026-07-31, titan.html): a prompt-only fix (giving the AI truncated
// parent-text context) still picked a small gold-styled <span> holding a
// sub-phrase of the sentence, because the sentence is split across three
// sibling <span> elements inside the <h2> — no single span wraps the full
// text, only the <h2> does. Relying on the model to read truncated text
// hints correctly was too fragile; walking the DOM to the real heading
// element is deterministic and can't misfire the way a text hint can. Capped
// hop count guards against pathological markup with no real heading ancestor
// nearby (falls through to the AI's original pick in that case). Scoped to
// headline/subhead only — cta_text and background_image are correctly small,
// specific elements and must not be widened.
const HEADING_ANCESTOR_MAX_HOPS = 6;
function findHeadingAncestor(el: Node): Node | null {
  let cur = el.parent as Node | null;
  let hops = 0;
  while (cur && hops < HEADING_ANCESTOR_MAX_HOPS) {
    if (cur.type === 'tag' && /^h[1-6]$/.test((cur.name as string).toLowerCase())) {
      return cur;
    }
    cur = cur.parent as Node | null;
    hops++;
  }
  return null;
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

// Container-first redesign (2026-07-31 follow-up). Previously the container
// was derived as a side effect of full field detection (find all 4 fields,
// compute their common ancestor) — a much harder/noisier AI task than "find
// the one wrapper element that is the hero section," and the two independent
// call sites in auto-personalize.ts (generateHeroRevamp/generateHeroOverrides)
// each ran it separately, non-deterministically, and disagreed with each
// other. See docs/utm-personalization-v2-automation.md, "decision to lead
// with revamp on raw HTML, container-first detection redesign".
//
// This section finds ONLY the container, from a small, shallow candidate set
// (block-level wrapper tags near the top of the doc, one line of context
// each) — much cheaper than the full leaf-level field candidate dump below,
// and a simpler/more reliable task for the model.
const CONTAINER_CANDIDATE_TAGS = ['section', 'div', 'header', 'main'];
const MAX_CONTAINER_CANDIDATES = 60;

interface ContainerCandidate {
  indexPath: string;
  tag: string;
  id?: string;
  className?: string;
  childTagCount: number;
  textPreview?: string;
}

function firstHeadingOrTextPreview(el: Node): string {
  const text = textOf(el);
  return text.slice(0, MAX_TEXT_PREVIEW);
}

// Shallow, depth-first scan for block-level wrapper candidates near the top
// of the document — deliberately not recursing into every leaf like
// collectCandidates below, since we only need to see wrapper shapes here,
// not individual text runs.
function collectContainerCandidates(rootChildren: Node[]): { candidates: ContainerCandidate[]; nodesByPath: Map<string, Node> } {
  const candidates: ContainerCandidate[] = [];
  const nodesByPath = new Map<string, Node>();

  function walk(nodes: Node[], prefix: number[]) {
    if (candidates.length >= MAX_CONTAINER_CANDIDATES) return;
    const elements = nodes.filter((n: { type: string }) => n.type === 'tag');
    elements.forEach((el, idx) => {
      if (candidates.length >= MAX_CONTAINER_CANDIDATES) return;
      const path = [...prefix, idx];
      const indexPath = path.join('/');
      const tag = (el.name as string).toLowerCase();

      if (CONTAINER_CANDIDATE_TAGS.includes(tag)) {
        const text = firstHeadingOrTextPreview(el);
        if (text) {
          nodesByPath.set(indexPath, el);
          candidates.push({
            indexPath,
            tag,
            id: el.attribs?.id || undefined,
            className: el.attribs?.class || undefined,
            childTagCount: countDescendantTags(el),
            textPreview: text,
          });
        }
      }

      if (el.children) walk(el.children, path);
    });
  }

  walk(rootChildren, []);
  return { candidates, nodesByPath };
}

async function identifyHeroContainer(candidates: ContainerCandidate[]): Promise<string | null> {
  const msg = await getClient().messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 50,
    // One-word-ish answer (an indexPath string or "null") — no reasoning
    // needed, same rationale as identifyHeroElements/judgeUtmRowsMatch above.
    thinking: { type: 'disabled' },
    system: `You are identifying the hero section WRAPPER of a landing page from a list of candidate block-level elements (each with indexPath, tag, id/class, a count of descendant tags, and a short text preview of what's inside it).

The hero section is the main above-the-fold block: it contains a headline, usually a CTA, sometimes a subheadline/image. Pick the SINGLE element that most tightly wraps just that content — not the whole page body, not a wrapper that also contains the nav bar or footer, not a wrapper so deep it only contains one sub-piece (e.g. just the headline alone).

Rules:
- Prefer the smallest element that still contains the full hero content (headline + CTA together, if both are present).
- Never pick an element whose text preview looks like navigation links, footer text/copyright, or an unrelated section further down the page.
- If no candidate looks like a plausible hero wrapper, return null.
- Return ONLY a JSON object: {"container": "<indexPath or null>"}. No explanation, no markdown, no code fences.`,
    messages: [
      {
        role: 'user',
        content: `Candidates:\n${JSON.stringify(candidates, null, 0)}`,
      },
    ],
  });

  const textBlock = msg.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    console.error(`[hero-field-detection-raw] identifyHeroContainer -> no text block in response stop_reason=${msg.stop_reason}`);
    return null;
  }

  try {
    const parsed = JSON.parse(extractJsonFromText(textBlock.text));
    const container = parsed && typeof parsed === 'object' ? parsed.container : null;
    return typeof container === 'string' ? container : null;
  } catch (err) {
    console.error('[hero-field-detection-raw] identifyHeroContainer -> failed to parse JSON response', err, textBlock.text);
    return null;
  }
}

function wrapWithHeroMarkers(container: Node): boolean {
  if (!container.children) return false;
  container.attribs = { ...container.attribs, 'data-hero-container': '1' };
  const parent = container.parent as Node | null;
  if (!parent || !parent.children) return false;
  const idx = (parent.children as Node[]).indexOf(container);
  if (idx === -1) return false;

  const openMarker = { type: 'comment', data: ' SL:hero ' } as unknown as Node;
  const closeMarker = { type: 'comment', data: ' /SL:hero ' } as unknown as Node;
  (parent.children as Node[]).splice(idx + 1, 0, closeMarker);
  (parent.children as Node[]).splice(idx, 0, openMarker);
  return true;
}

/**
 * Cheap, container-only raw-HTML detection: finds just the hero section's
 * wrapper element (not individual fields) via a small AI call over shallow
 * block-level candidates, then wraps it with the same `<!-- SL:hero -->`
 * marker + `data-hero-container="1"` attribute AI-generated pages already
 * carry. Meant to run at most once per page, ever — once persisted, every
 * later call (from either generateHeroRevamp or generateHeroOverrides) finds
 * the marker via detectHeroContainerFromHtml()'s fast regex path, same as an
 * AI-generated page, with zero further AI cost for container detection.
 *
 * Returns null if no candidates exist or no plausible container was found
 * (e.g. a page with no real hero section, or markup too flat/messy to
 * identify a sane wrapper) — callers should treat this as "container
 * detection unsupported for this page," not retry indefinitely.
 */
export async function detectHeroContainerRawHtml(html: string): Promise<{ updatedHtml: string } | null> {
  const dom = parseDocument(html);
  const htmlEl = (dom.children as Node[]).find((n: Node) => n.type === 'tag' && n.name === 'html');
  const rootChildren = htmlEl ? htmlEl.children : dom.children;

  const { candidates, nodesByPath } = collectContainerCandidates(rootChildren);
  if (candidates.length === 0) {
    console.log('[hero-field-detection-raw] detectHeroContainerRawHtml -> no container candidates found');
    return null;
  }

  let indexPath: string | null;
  try {
    indexPath = await identifyHeroContainer(candidates);
  } catch (err) {
    console.error(`[hero-field-detection-raw] identifyHeroContainer API call failed (candidates=${candidates.length})`, err);
    return null;
  }

  if (!indexPath) {
    console.log('[hero-field-detection-raw] detectHeroContainerRawHtml -> AI found no plausible container');
    return null;
  }

  const container = nodesByPath.get(indexPath);
  if (!container) {
    console.log('[hero-field-detection-raw] detectHeroContainerRawHtml -> AI returned an indexPath not in candidates, skipping');
    return null;
  }

  if (!wrapWithHeroMarkers(container)) {
    console.log('[hero-field-detection-raw] detectHeroContainerRawHtml -> could not splice markers around chosen container');
    return null;
  }

  const updatedHtml = render(dom, { decodeEntities: false });
  console.log('[hero-field-detection-raw] detectHeroContainerRawHtml -> container found and marked');
  return { updatedHtml };
}

/**
 * Duplicate-breakpoint-aware field detection scoped to an already-known hero
 * container (tagged `data-hero-container="1"` by detectHeroContainerRawHtml
 * above — this is the raw-HTML tier only; AI-generated pages already have
 * `data-field="hero.*"` baked in at generation time and are fully handled
 * by tier 1's attribute parser, so this function is never reached for them).
 * Only scans candidates within the container's subtree, so page-builder exports
 * with hundreds of candidate tags elsewhere on the page (the original
 * MAX_CANDIDATES problem) never reach the AI at all — cheaper prompt, and
 * the model only ever sees genuinely-hero-relevant elements.
 *
 * Unbounce/page-builder exports commonly duplicate the same heading/CTA
 * several times inside the hero wrapper itself, one per responsive
 * breakpoint (mobile/tablet/desktop), toggled via CSS visibility classes
 * rather than actually removed from the DOM. If only one such duplicate gets
 * tagged with data-field, a field-swap would silently leave the other
 * breakpoints showing stale default content. So once a field is identified,
 * every OTHER element in the container whose text matches it near-exactly is
 * tagged with the same data-field value too — utm-swap-script.ts must then
 * apply the swap to every matching element (querySelectorAll), not just one.
 *
 * Returns null if the container marker isn't present in this HTML, or if no
 * fields could be confidently identified within it.
 */
export async function detectHeroFieldsWithinContainer(
  html: string
): Promise<{ updatedHtml: string; selectors: HeroFieldSelectors } | null> {
  const dom = parseDocument(html);
  const htmlEl = (dom.children as Node[]).find((n: Node) => n.type === 'tag' && n.name === 'html');
  const rootChildren = htmlEl ? htmlEl.children : dom.children;

  let container: Node | null = null;
  function findContainer(nodes: Node[]) {
    for (const n of nodes) {
      if (container) return;
      if (n.type === 'tag') {
        if (n.attribs?.['data-hero-container'] === '1') {
          container = n;
          return;
        }
        if (n.children) findContainer(n.children);
      }
    }
  }
  findContainer(rootChildren);

  if (!container || !(container as Node).children) {
    console.log('[hero-field-detection-raw] detectHeroFieldsWithinContainer -> no data-hero-container element found in HTML');
    return null;
  }
  const containerNode = container as Node;

  const { candidates, nodesByPath } = collectCandidates(containerNode.children as Node[]);
  if (candidates.length === 0) {
    console.log('[hero-field-detection-raw] detectHeroFieldsWithinContainer -> no field candidates found inside container');
    return null;
  }

  let identified: Record<string, string | null>;
  try {
    identified = await identifyHeroElements(candidates);
  } catch (err) {
    console.error(`[hero-field-detection-raw] detectHeroFieldsWithinContainer identifyHeroElements failed (candidates=${candidates.length})`, err);
    return null;
  }

  // All elements in the container, for duplicate-text lookup below.
  const allContainerEls: Node[] = [];
  (function collectAll(nodes: Node[]) {
    for (const n of nodes) {
      if (n.type === 'tag') {
        allContainerEls.push(n);
        if (n.children) collectAll(n.children);
      }
    }
  })(containerNode.children as Node[]);

  let injectedAny = false;
  for (const key of HERO_FIELD_KEYS) {
    const indexPath = identified[key];
    if (!indexPath || typeof indexPath !== 'string') continue;

    let el = nodesByPath.get(indexPath);
    if (!el) continue;

    if (key === 'headline' || key === 'subhead') {
      const tag = (el.name as string | undefined)?.toLowerCase();
      if (tag !== 'p' && !(tag && /^h[1-6]$/.test(tag))) {
        const headingAncestor = findHeadingAncestor(el);
        if (headingAncestor) el = headingAncestor;
      }
    }

    el.attribs = { ...el.attribs, 'data-field': `hero.${key}` };
    injectedAny = true;

    // Tag near-duplicate elements (same tag, same non-empty text) as the
    // same field — responsive-breakpoint clones, see function doc above.
    // Images are matched by src instead of text; both are skipped if the
    // primary element's signal is empty (nothing meaningful to match on).
    if (el.name && (el.name as string).toLowerCase() !== 'img') {
      const primaryText = textOf(el);
      if (primaryText) {
        for (const other of allContainerEls) {
          if (other === el) continue;
          if ((other.name as string)?.toLowerCase() !== (el.name as string).toLowerCase()) continue;
          if (other.attribs?.['data-field']) continue; // already tagged (e.g. as a different field)
          if (textOf(other) === primaryText) {
            other.attribs = { ...other.attribs, 'data-field': `hero.${key}` };
          }
        }
      }
    } else {
      const primarySrc = el.attribs?.src;
      if (primarySrc) {
        for (const other of allContainerEls) {
          if (other === el) continue;
          if ((other.name as string)?.toLowerCase() !== 'img') continue;
          if (other.attribs?.['data-field']) continue;
          if (other.attribs?.src === primarySrc) {
            other.attribs = { ...other.attribs, 'data-field': `hero.${key}` };
          }
        }
      }
    }
  }

  if (!injectedAny) {
    console.log('[hero-field-detection-raw] detectHeroFieldsWithinContainer -> AI could not confidently match any hero field within container');
    return null;
  }

  const updatedHtml = render(dom, { decodeEntities: false });
  const selectors = detectHeroFieldsFromHtml(updatedHtml);
  if (!selectors) {
    console.error('[hero-field-detection-raw] detectHeroFieldsWithinContainer -> injected data-field attributes but re-parsing found none — should not happen');
    return null;
  }

  console.log(`[hero-field-detection-raw] detectHeroFieldsWithinContainer -> fields=${Object.keys(selectors).length}`);
  return { updatedHtml, selectors };
}

async function identifyHeroElements(candidates: Candidate[]): Promise<Record<string, string | null>> {
  const fieldDescriptions = HERO_FIELD_KEYS
    .map(key => `- "${key}" (${HERO_FIELD_CONFIG[key].type}): ${HERO_FIELD_CONFIG[key].label}`)
    .join('\n');

  const msg = await getClient().messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 512,
    // Extended thinking counts against max_tokens, and its length is not
    // predictable — found live (2026-07-31): this exact call, same page,
    // same candidates, non-deterministically hit stop_reason=max_tokens with
    // content_types=thinking, consuming the entire budget on reasoning and
    // leaving zero tokens for the actual JSON answer. `thinking: enabled`
    // with an explicit budget was tried as a fix but this model rejects it
    // outright (400: "thinking.type.enabled is not supported for this
    // model") — so disabled is used instead, same as the already-working
    // judgeUtmRowsMatch() call above, which has never hit this failure.
    thinking: { type: 'disabled' },
    system: `You are identifying the hero section of a landing page from a list of candidate DOM elements (each with its indexPath, tag, and a short text/src preview). The hero section is the main above-the-fold block: a headline, optionally a subheadline/supporting text, a primary call-to-action, and optionally a background/hero image.

Fields to identify:
${fieldDescriptions}

Rules:
- Only pick elements that are actually part of the hero section — never a nav link, footer text, an unrelated card, or a secondary/repeated CTA further down the page.
- Some candidates include "parentIndexPath"/"parentText": this means the candidate is nested inside another candidate element, and parentText is that parent's own text. For "headline" and "subhead", if a candidate's text is only a short sub-phrase of its parentText (e.g. a highlighted/bolded/colored span inside a larger sentence), prefer the PARENT element's indexPath instead — you want the element that contains the FULL headline/subhead sentence, not a styled fragment of it. Only pick the nested child directly if the parent's text is not meaningfully longer (i.e. the child effectively IS the whole heading).
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
  if (!textBlock || textBlock.type !== 'text') {
    console.error(`[hero-field-detection-raw] identifyHeroElements -> no text block in response stop_reason=${msg.stop_reason} content_types=${msg.content.map(b => b.type).join(',')} usage(in/out)=${msg.usage.input_tokens}/${msg.usage.output_tokens}`);
    return {};
  }

  try {
    const parsed = JSON.parse(extractJsonFromText(textBlock.text));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (err) {
    console.error('[hero-field-detection-raw] identifyHeroElements -> failed to parse JSON response', err, textBlock.text);
    return {};
  }
}

// Hero-container detection for raw HTML (2026-07-31 follow-up to the
// hero-revamp scope expansion — see docs/utm-personalization-v2-automation.md).
// AI-generated pages get a container marker for free (`<!-- SL:hero -->`,
// see hero-field-detection.ts); raw/uploaded HTML has none, so once the
// individual hero fields are identified above, we derive the container as
// their common DOM ancestor and inject the same kind of markers onto it —
// a `<!-- SL:hero -->...<!-- /SL:hero -->` comment wrap (so the existing,
// already-hardened `detectHeroContainerFromHtml()` regex just works, no new
// server-side extraction path needed) plus a `data-hero-container="1"`
// attribute (so the client-side swap script — which can't see HTML
// comments via querySelector — has a real DOM hook to replace at runtime;
// see utm-swap-script.ts).
const MIN_FIELDS_FOR_CONTAINER = 2;
const MAX_CONTAINER_DESCENDANT_TAGS = 80;

function countDescendantTags(node: Node): number {
  let count = 0;
  function walk(n: Node) {
    if (!n.children) return;
    for (const child of n.children as Node[]) {
      if (child.type === 'tag') count++;
      walk(child);
    }
  }
  walk(node);
  return count;
}

function ancestorChain(node: Node): Node[] {
  const chain: Node[] = [];
  let cur = node.parent as Node | null;
  while (cur) {
    chain.push(cur);
    cur = cur.parent as Node | null;
  }
  return chain; // nearest parent first, root last
}

/**
 * Finds the nearest common ancestor of a set of elements, then validates
 * it's plausible as a "hero container" rather than something far too broad
 * (the whole <body>, or a wrapper that also contains nav/footer content).
 * Returns null if no sane container can be found — callers must treat this
 * as "container detection unsupported for this page," not guess.
 */
function findHeroContainer(fieldEls: Node[]): Node | null {
  if (fieldEls.length < MIN_FIELDS_FOR_CONTAINER) return null;

  const chains = fieldEls.map(ancestorChain);
  const [first, ...rest] = chains;
  let container: Node | null = null;
  for (const candidate of first) {
    if (rest.every(chain => chain.includes(candidate))) {
      container = candidate;
      break;
    }
  }
  if (!container) return null;

  const tag = (container.name as string | undefined)?.toLowerCase();
  if (!tag || tag === 'html' || tag === 'body') return null; // too broad — not a real "section"

  // Reject if the candidate ancestor also wraps clearly non-hero landmarks —
  // a sign we've walked up too far (e.g. past the hero into a page-wide wrapper).
  let containsForeignLandmark = false;
  function scanForLandmarks(n: Node) {
    if (!n.children) return;
    for (const child of n.children as Node[]) {
      if (child.type === 'tag') {
        const childTag = (child.name as string).toLowerCase();
        if (childTag === 'nav' || childTag === 'footer' || childTag === 'header') {
          containsForeignLandmark = true;
        }
      }
      scanForLandmarks(child);
    }
  }
  scanForLandmarks(container);
  if (containsForeignLandmark) return null;

  if (countDescendantTags(container) > MAX_CONTAINER_DESCENDANT_TAGS) return null;

  return container;
}

/**
 * Identifies hero elements in raw/uploaded HTML via AI, injects
 * data-field="hero.X" attributes into the matched elements, and returns the
 * mutated HTML plus the resulting selector map (built by re-running the
 * same attribute-parser tier 1 uses, on the newly-injected markup).
 *
 * Also attempts hero-container detection (see findHeroContainer above) from
 * the same identified elements and, if a plausible container is found,
 * wraps it with `<!-- SL:hero -->` markers and tags it with
 * `data-hero-container="1"` in the same HTML mutation — so both field-swap
 * and full hero-section-revamp personalization can work on raw HTML pages,
 * not just AI-generated ones. `containerFound` tells the caller whether
 * this succeeded; it's independent of field detection succeeding (a page
 * can get fields without a confident container, or vice versa).
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
): Promise<{ updatedHtml: string; selectors: HeroFieldSelectors; containerFound: boolean } | null> {
  const dom = parseDocument(html);
  const htmlEl = (dom.children as Node[]).find((n: Node) => n.type === 'tag' && n.name === 'html');
  const rootChildren = htmlEl ? htmlEl.children : dom.children;

  const { candidates, nodesByPath } = collectCandidates(rootChildren);
  if (candidates.length === 0) {
    console.log('[hero-field-detection-raw] no candidate elements found in HTML');
    return null;
  }

  let identified: Record<string, string | null>;
  try {
    identified = await identifyHeroElements(candidates);
  } catch (err) {
    console.error(`[hero-field-detection-raw] identifyHeroElements API call failed (candidates=${candidates.length})`, err);
    return null;
  }

  let injectedAny = false;
  const identifiedEls: Node[] = [];
  for (const key of HERO_FIELD_KEYS) {
    const indexPath = identified[key];
    if (!indexPath || typeof indexPath !== 'string') continue;

    let el = nodesByPath.get(indexPath);
    if (!el) continue; // AI returned a path that doesn't match a real candidate — skip, don't guess

    if (key === 'headline' || key === 'subhead') {
      const tag = (el.name as string | undefined)?.toLowerCase();
      if (tag !== 'p' && !(tag && /^h[1-6]$/.test(tag))) {
        const headingAncestor = findHeadingAncestor(el);
        if (headingAncestor) el = headingAncestor;
      }
    }

    el.attribs = { ...el.attribs, 'data-field': `hero.${key}` };
    injectedAny = true;
    identifiedEls.push(el);
  }

  if (!injectedAny) {
    console.log('[hero-field-detection-raw] AI could not confidently match any hero field');
    return null;
  }

  let containerFound = false;
  const container = findHeroContainer(identifiedEls);
  if (container && container.children) {
    container.attribs = { ...container.attribs, 'data-hero-container': '1' };
    const parent = container.parent as Node | null;
    if (parent && parent.children) {
      const idx = (parent.children as Node[]).indexOf(container);
      if (idx !== -1) {
        // Plain comment-node objects — dom-serializer only reads `.type`/`.data`
        // for comments, no need to pull in the domhandler Comment class for
        // this (htmlparser2/dom-serializer are used here as loosely-typed CJS
        // deps already, same pattern as the rest of this file).
        const openMarker = { type: 'comment', data: ' SL:hero ' } as unknown as Node;
        const closeMarker = { type: 'comment', data: ' /SL:hero ' } as unknown as Node;
        (parent.children as Node[]).splice(idx + 1, 0, closeMarker);
        (parent.children as Node[]).splice(idx, 0, openMarker);
        containerFound = true;
      }
    }
  }

  const updatedHtml = render(dom, { decodeEntities: false });
  const selectors = detectHeroFieldsFromHtml(updatedHtml);
  if (!selectors) {
    console.error('[hero-field-detection-raw] injected data-field attributes but re-parsing them afterward found none — should not happen');
    return null;
  }

  console.log(`[hero-field-detection-raw] fields=${Object.keys(selectors).length} containerFound=${containerFound}`);
  return { updatedHtml, selectors, containerFound };
}
