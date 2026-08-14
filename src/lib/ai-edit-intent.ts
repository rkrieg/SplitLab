/**
 * One model call that answers "what is this person asking for?" — replacing the
 * pile of keyword gates that used to decide it.
 *
 * Why this exists: routing used to be decided by hand-written regex before any
 * model saw the message. "make the footer look like this" matched; "also match
 * the footer with screenshot" did not, so an identical request took the generic
 * path, got no design targeting, and ended in "No changes were applied". Every
 * new phrasing needed a new pattern, and the patterns could never cover what
 * real users type.
 *
 * Division of labour, deliberately:
 *   - the MODEL interprets the message (this file) and declares what to check,
 *   - deterministic code applies the edit and verifies those checks.
 * The model never grades its own work — that is how "Done!" once shipped a page
 * with a dead logo. See ai-page-requirements.ts for the checking side.
 *
 * Fail-open by design: when the call fails, times out, or returns junk, callers
 * fall back to the old keyword gates. A classification outage must degrade
 * routing quality, never break editing.
 */

import { askAI, type AIContent, type AIContentBlock } from '@/lib/ai-client';
import type { UsageContext } from '@/lib/ai-usage';
import { parseModelRequirements, type PageRequirement } from '@/lib/ai-page-requirements';
import type { ContentReuseIntent } from '@/lib/ai-content-placement';

/** What one attached image is for. Mirrors the roles the edit paths act on. */
export type AttachmentRole = 'design_reference' | 'bug_report' | 'content_asset';

/**
 * What KIND of job one ask is. Without this every ask was assumed to be "edit
 * an existing section", because that was the only shape the executor had — so
 * "add a section like this image" was carried out as "edit the hero", and the
 * new content was nested inside the hero's flex row instead of appended to the
 * page. "add" is the ask that legitimately has no existing target.
 */
export type EditAskOp = 'edit' | 'add' | 'remove' | 'reorder';

export interface EditAsk {
  /** Self-contained instruction for this one ask. */
  instruction: string;
  /** SL section names this ask targets; empty when unknown. */
  sections: string[];
  /** The kind of job. Defaults to 'edit' — the safe, non-structural read. */
  op: EditAskOp;
  /**
   * THIS ask means "make it look like the attachment" (recreate the section
   * from the image). Per-ask on purpose: the message-level designReference flag
   * used to be stamped onto every step of a multi-ask edit, so "increase the
   * footer logo size slightly and add a section like this image" told the
   * footer step to recreate itself from a property-photo screenshot. The footer
   * lost 6 images, 4 headings and 14 click-to-edit fields, and the logo never
   * got bigger. One ask referencing an image does not license rebuilding the
   * sections the other asks touch.
   */
  designMatch: boolean;
  /**
   * How many NEW sections this ask creates. Only meaningful for op 'add'.
   * "add 2 sections like this" is 2 — the insert path used to build exactly
   * one no matter what was asked for, and silently dropped the rest.
   */
  count: number;
  /**
   * Which attachments belong to THIS ask, as 0-based indexes into the images
   * the user sent. Empty means "all of them / none in particular".
   *
   * attachmentRoles says what each image IS (a design to copy, a bug report, an
   * asset to embed) but never which ask it belongs TO, so every step was handed
   * every image. "Make the footer like this and the nav like that" gave the
   * footer step both screenshots and nothing to tell them apart.
   */
  imageIndexes: number[];
}

export interface EditIntent {
  /** The user wants the page (or a section) to LOOK like an attachment/reference. */
  designReference: boolean;
  /** The words visible in the reference are content to reproduce, not just style. */
  reuseReferenceCopy: boolean;
  /** An attachment shows a defect on OUR page rather than a target to copy. */
  bugReport: boolean;
  /** Per-attachment role, in the order the URLs were passed. */
  attachmentRoles: AttachmentRole[];
  /** Distinct asks in the message — a multi-part request is where asks get dropped. */
  asks: EditAsk[];
  /**
   * Standing conditions on the OTHER asks — "keep the dark theme", "don't
   * touch the nav", "same fonts". These are not work items. Treated as asks
   * they produced a step that correctly changed nothing, which the verifier
   * then reported as a failed edit; and, being absent from the other steps,
   * a design-match step could rebuild a section from a light-themed
   * screenshot and flip the very theme the user asked us to keep.
   */
  constraints: string[];
  /** Union of every ask's sections, resolved against the live page. */
  targetSections: string[];
  /** The ask needs a full-page rebuild (new sections, whole-page redesign). */
  fullRebuild: boolean;
  /** The message points at a URL/asset supplied in an earlier turn. */
  usesEarlierSource: boolean;
  /** A site URL to source brand assets from (this message or an earlier one). */
  sourceUrl: string | null;
  /**
   * What the user wants taken FROM that site: the real logo file, content
   * photos, or nothing (the URL is just a look to imitate). This is the
   * difference between fetching the brand's actual logo and having the model
   * invent one from a screenshot.
   */
  assetSource: 'logo' | 'content_images' | null;
  /** Checks the finished HTML must satisfy — verified by code, not by the model. */
  requirements: PageRequirement[];
  /**
   * "put the logo/this text/this image into section X" — reusing something
   * already on the page rather than generating anything new. Null when the
   * message isn't asking for that.
   */
  contentReuse: ContentReuseIntent | null;
  /** Low confidence is fine — proceed with the best guess instead of asking. */
  proceedAnyway: boolean;
  /**
   * The user is deliberately deleting something. Preservation stands down —
   * restoring what they asked us to remove is worse than the loss it guards.
   */
  removalIntent: boolean;
  /**
   * The user is deliberately swapping one asset for another ("nav logo same as
   * the footer's"). The old asset disappearing is the point, not damage.
   */
  intentionalAssetReplace: boolean;
  /**
   * Create path: the user asked for stats / testimonials / logo walls / awards.
   * When false we strip social proof the model invented, so inventing "trusted
   * by 500 companies" for a brand that never said so can't ship.
   */
  wantsSocialProof: boolean;
}

const SYSTEM = `You classify a single edit request for an AI landing-page builder. You do NOT edit anything and you do NOT judge the result — you only describe what the user is asking for, so the right code path runs.

Respond with ONLY a JSON object. Begin with { and end with }. No prose, no markdown fences.

{
  "design_reference": true|false,
  "reuse_reference_copy": true|false,
  "bug_report": true|false,
  "attachment_roles": ["design_reference"|"bug_report"|"content_asset", ...],
  "asks": [{ "instruction": "<one self-contained ask>", "sections": ["<sl section name>"], "op": "edit"|"add"|"remove"|"reorder", "count": 1, "design_match": true|false, "image_indexes": [1] }],
  "constraints": ["<a condition on the other asks, not a job of its own>", ...],
  "full_rebuild": true|false,
  "uses_earlier_source": true|false,
  "source_url": "<url or null>",
  "asset_source": "logo"|"content_images"|null,
  "content_reuse": { "kind": "logo"|"text"|"image", "targets": ["<sl section name>", ...], "text_payload": "<exact copy or null>", "source_section_hint": "<sl section name or null>" } | null,
  "proceed_anyway": true|false,
  "removal_intent": true|false,
  "intentional_asset_replace": true|false,
  "wants_social_proof": true|false,
  "requirements": [ ... ]
}

Field meanings:
- "design_reference": the user wants the page, or a named part of it, to LOOK like an attached image or a referenced site. True for "make our footer like this", "also match the footer with screenshot", "make the footer similar to screenshot", "same vibe as the pic", "copy this bottom bar" — the wording does not matter, the intent does.
- "reuse_reference_copy": the WORDS visible in the reference must appear on the page (cloning a footer's legal text, "use the copy from this"). FALSE when the user supplies their own copy or caps the scope ("except it should say X", "nothing else is required") — putting the reference's words on the page then is wrong.
- "bug_report": an attachment shows something broken/ugly on OUR OWN page (the user is complaining), rather than a design to copy. Both can be true when the user complains AND points at a reference.
- "attachment_roles": one entry per attached image, in order. "content_asset" means the image itself belongs on the page (a logo, a photo to embed).
- "asks": split the message into distinct asks. "make the footer like this and in nav increase the logo size" is TWO asks. Use section names EXACTLY as listed when you can map the user's words to them. "everywhere" / "all logos" / "the top bar" / "the bottom" ARE mappable — put the matching live names (nav, footer, hero, …) on that ask. Never leave "sections" empty just because the user did not type the internal name. Never invent a name that is not in the list.
- "op" on each ask — what KIND of job it is. This decides whether we modify a section or build a new one, so it matters more than the wording:
  - "edit": change something that already exists (restyle, recolour, resize, rewrite copy, fix spacing, align, replace an image). This is the default and covers most asks.
  - "add": CREATE a section that is not on the page yet — "add a section like this image", "add an FAQ below the hero", "add 2 sections". An "add" ask has NO existing target, so for op "add" leaving "sections" EMPTY is correct and expected: put the section it should sit NEXT TO in "sections" if the user said where ("add an FAQ below the hero" → ["hero"]), and otherwise leave it empty. Never name a section just to fill the field on an "add" — naming one makes us edit that section instead of creating a new one, which nests the new content inside it and wrecks the layout.
  - "remove": delete an existing whole section. Put that section in "sections".
  - "reorder": move existing sections around.
- "count" on each ask: how many NEW sections an "add" creates ("add 2 sections like this" → 2). 1 for everything else. Never 0.
- "design_match" on each ask: true ONLY when THIS ask means "make it look like the attached image" — recreate that section's layout and structure from the picture. Judge each ask separately. In "increase the footer logo size slightly and add a section like this image", the ADD ask is design_match true and the footer ask is FALSE — the footer is a small resize, and rebuilding it from an unrelated screenshot would destroy it. A resize, recolour, spacing tweak or copy edit is design_match false even when the same message also contains a reference image.
- "image_indexes" on each ask: which attached images that ask refers to, numbered from 1 in the order they were attached. "make the footer like this and the nav like that" with two screenshots is [1] on the footer ask and [2] on the nav ask. Leave it [] when the ask refers to no image, or when a single image applies to everything. Getting this right stops one ask's reference from being handed to an unrelated ask.
- "constraints": standing conditions that qualify the OTHER asks rather than being work of their own — "keep the dark theme we have", "don't touch the nav", "same fonts", "keep it on one page". Put the condition here, NOT in "asks". A constraint is something that can already be true; an ask is something we must change. If the user's whole message is a constraint with nothing to change, then it IS the ask — do not empty "asks" to fill this. Copy the user's own words.
- "full_rebuild": true only for whole-page work (redesign the page, clone another site, add several new sections).
- "uses_earlier_source": the user refers to a SITE they gave earlier ("the website i gave you", "get the logo from that url") — NOT "the screenshot i gave you". A screenshot is an attachment, not a source URL.
- "source_url": a site URL to take brand assets from — from this message, or the earlier one when uses_earlier_source is true and it is listed in the context below. Otherwise null.
- "asset_source": what must be fetched from that site. "logo" when the user wants the REAL logo file ("use the logo from this site", "the logo is still wrong", "get their actual logo"). "content_images" when they want photos/images from it. null when the site is only a look to imitate — nothing is downloaded. null when this turn is about a screenshot/color, not fetching the site.
- "content_reuse": the user wants something ALREADY ON THE PAGE reused elsewhere — never invent or generate anything new for this. "kind": "logo" ONLY for placing/copying the existing logo into another section ("put the logo in the footer too"). NOT for recoloring ("make the logo white everywhere") and NOT for resizing ("increase the logo size", "update the size of footer logo") — those are normal style asks; put nav/footer/hero on that ask's sections instead. "text" for "copy the hero headline to the footer". "image" for reusing an existing photo. null when nothing is being reused.
  For logo/image reuse: set "source_section_hint" to the section they want to COPY FROM ("navbar logo same as footer" → source_section_hint "footer", targets ["nav"]). Never assume nav is the source. "targets" are destinations only. "footer logo" alone means the logo in the footer (a style target), NOT a copy source.
- "removal_intent": the user is deliberately deleting something ("remove this", "get rid of the strip", "no buttons"). We use this to stand down the guard that restores content an edit destroyed — so set it true whenever removal is genuinely intended, and false otherwise.
- "wants_social_proof": the user asked for stats, KPIs, testimonials, reviews, client logos, awards or "trusted by" content — including numbers they supplied themselves. False means we strip any such section the builder invented, so fabricated credibility claims never ship.
- "intentional_asset_replace": the user is deliberately swapping one image/logo for another ("navbar logo same as footer", "replace the hero photo with this"). The old asset vanishing is intended, not damage.
- "proceed_anyway": true when the user explicitly says to just decide/pick for them ("you decide", "feel free", "surprise me", "whichever") or this message is answering a clarifying question WE just asked — proceed on the best interpretation instead of asking another question.

Then the checklist, which is how we avoid telling the user "Done" when part of their request was silently dropped:
`;

/** One section, described well enough to be recognised in a screenshot. */
export interface SectionOutlineEntry {
  name: string;
  /** Visible text of the section, already tag-stripped. */
  text: string;
}

/** Hard cap per section so a long page can't blow up the classification call. */
const OUTLINE_CHARS_PER_SECTION = 320;
const OUTLINE_MAX_SECTIONS = 24;

/**
 * Turn the live sections into a compact "what is actually on this page" outline.
 *
 * Without this the classifier saw only bare section NAMES ("nav, hero, footer")
 * and had no way to connect them to anything the user pointed at. "remove this"
 * with a screenshot of a strip was unanswerable: the model could see the picture
 * and the list of names, and nothing linking the two — so it correctly returned
 * no target, and the edit became a silent no-op. Section text is what lets it
 * say "that grey strip with 'Back to Focused Capital' is the nav".
 */
export function buildSectionOutline(sections: SectionOutlineEntry[]): string {
  if (sections.length === 0) return '(no sections detected)';
  return sections
    .slice(0, OUTLINE_MAX_SECTIONS)
    .map(({ name, text }) => {
      const clean = text.replace(/\s+/g, ' ').trim();
      const snippet =
        clean.length > OUTLINE_CHARS_PER_SECTION
          ? `${clean.slice(0, OUTLINE_CHARS_PER_SECTION)}…`
          : clean || '(no visible text)';
      return `- ${name}: ${snippet}`;
    })
    .join('\n');
}

/**
 * Which sections does ONE ask target? A narrow second opinion for when the main
 * classification left an ask's sections empty.
 *
 * This exists so nothing falls back to keyword matching. The old fallback ran
 * `inferTargetSectionNames` — a regex over the prompt — and whatever it matched
 * is where the edit landed. Returning [] here is a valid, honest answer: the
 * caller then asks the user instead of dropping an edit somewhere arbitrary.
 */
export async function resolveSectionsForAsk(opts: {
  instruction: string;
  sectionOutline: SectionOutlineEntry[];
  imageUrls?: string[];
  usage?: UsageContext;
  label?: string;
}): Promise<string[]> {
  const instruction = opts.instruction.trim();
  if (!instruction || opts.sectionOutline.length === 0) return [];

  const known = opts.sectionOutline.map((s) => s.name);
  const images = (opts.imageUrls ?? []).slice(0, 2);
  const userContent: AIContent = [
    ...images.map((url): AIContentBlock => ({ type: 'image', url })),
    {
      type: 'text',
      text: [
        'Sections on the page and what each one currently contains:',
        buildSectionOutline(opts.sectionOutline),
        '',
        images.length > 0
          ? 'The attached image is usually a crop of THIS page — match it to a section above.'
          : '',
        `Which of those sections does this ask apply to?\n${instruction}`,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];

  try {
    const text = await askAI({
      system:
        'You map one edit request to the sections of a landing page it affects. Reply with ONLY a JSON array of section names taken exactly from the provided list, most relevant first, e.g. ["footer"] or ["nav","footer"]. Reply [] if you genuinely cannot tell — a wrong guess puts the user\'s edit in the wrong place. Never invent a name that is not in the list.',
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 300,
      label: opts.label ?? 'edit-intent:resolve-sections',
      usage: opts.usage,
    });
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string') continue;
      const hit = known.find((k) => k.toLowerCase() === entry.trim().toLowerCase());
      if (hit && !out.includes(hit)) out.push(hit);
    }
    return out.slice(0, 4);
  } catch (err) {
    console.error('[edit-intent] section resolution failed — caller must not guess', err);
    return [];
  }
}

/**
 * Build the classification call: the prompt, up to two attachments, and an
 * outline of what each section actually contains (see buildSectionOutline —
 * names alone made every "this"/"that strip" ask unresolvable).
 */
export async function classifyEditIntent(opts: {
  prompt: string;
  /** Live SL section names — the only names the model may target. */
  sectionNames: string[];
  /**
   * Live sections with their visible text, so an attachment or a demonstrative
   * ("this", "that bar") can be matched to a real section.
   */
  sectionOutline?: SectionOutlineEntry[];
  /** Attached image URLs for this message, in order. */
  imageUrls?: string[];
  /** Site URLs seen in earlier turns, oldest first. */
  earlierUrls?: string[];
  /** URLs already in the page we could be asked to keep/verify. */
  embeddableAssetUrls?: string[];
  requirementInstruction: string;
  usage?: UsageContext;
  label?: string;
}): Promise<EditIntent | null> {
  const prompt = opts.prompt.trim();
  if (!prompt) return null;

  const images = (opts.imageUrls ?? []).slice(0, 2);
  const outline = opts.sectionOutline && opts.sectionOutline.length > 0
    ? buildSectionOutline(opts.sectionOutline)
    : null;
  const context = [
    `Sections on the page (use these names exactly): ${opts.sectionNames.length > 0 ? opts.sectionNames.join(', ') : '(none detected)'}`,
    ...(outline
      ? [
          '',
          'What each section actually contains right now — use this to work out which section the user is pointing at, especially for an attached screenshot or words like "this", "that strip", "the bar at the top":',
          outline,
          '',
        ]
      : []),
    `Images attached to THIS message: ${images.length}`,
    ...(images.length > 0
      ? [
          'An attached image is usually a crop of THIS page. Compare it against the section outline above and put the matching section name on the ask. Only leave sections empty if the image genuinely matches nothing in the outline.',
        ]
      : []),
    opts.earlierUrls && opts.earlierUrls.length > 0
      ? `URLs the user gave in earlier messages (most recent last): ${opts.earlierUrls.slice(-4).join(', ')}`
      : 'URLs the user gave in earlier messages: (none)',
    '',
    `User message:\n${prompt}`,
  ].join('\n');

  const userContent: AIContent = [
    ...images.map((url): AIContentBlock => ({ type: 'image', url })),
    { type: 'text', text: context },
  ];

  let text: string;
  try {
    text = await askAI({
      system: SYSTEM + opts.requirementInstruction,
      messages: [{ role: 'user', content: userContent }],
      // Requirements checklist + asks can exceed 2k; truncation used to force
      // the keyword fallback and silently mis-route design vs bug.
      maxTokens: 8000,
      label: opts.label ?? 'edit-intent',
      usage: opts.usage,
    });
  } catch (err) {
    console.error('[edit-intent] classification call failed — caller should clarify or decide', err);
    return null;
  }

  const raw = parseJsonObject(text);
  if (!raw) {
    console.error('[edit-intent] unparseable classification — caller should clarify or decide', {
      preview: text.slice(0, 200),
    });
    return null;
  }

  return normalizeIntent(raw, { ...opts, prompt });
}

/** Validate/clamp the model's answer against what actually exists on the page. */
export function normalizeIntent(
  raw: Record<string, unknown>,
  opts: {
    prompt?: string;
    sectionNames: string[];
    imageUrls?: string[];
    earlierUrls?: string[];
    embeddableAssetUrls?: string[];
  },
): EditIntent {
  const known = opts.sectionNames;
  const resolveSections = (v: unknown): string[] => {
    const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
    const out: string[] = [];
    for (const entry of arr) {
      if (typeof entry !== 'string') continue;
      const hit = known.find((k) => k.toLowerCase() === entry.trim().toLowerCase());
      if (hit && !out.includes(hit)) out.push(hit);
    }
    return out;
  };

  const imageCountForAsks = (opts.imageUrls ?? []).length;
  const asks: EditAsk[] = [];
  const rawAsks = Array.isArray(raw.asks) ? raw.asks : [];
  for (const entry of rawAsks) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const instruction = typeof rec.instruction === 'string' ? rec.instruction.trim() : '';
    if (!instruction) continue;
    // Model-resolved only. A keyword fill-in here defeated the whole contract:
    // an empty list must mean "could not tell" so the caller can re-ask the
    // model (resolveSectionsForAsk) or ask the user — not land the edit on
    // whichever section name happened to appear in their wording.
    const rawOp = typeof rec.op === 'string' ? rec.op.trim().toLowerCase() : '';
    // 'edit' is the safe default: it modifies what is there rather than
    // creating or deleting. An unrecognised op must never fall through to a
    // structural change the user did not clearly ask for.
    const op: EditAskOp =
      rawOp === 'add' || rawOp === 'remove' || rawOp === 'reorder' ? rawOp : 'edit';
    const rawCount = typeof rec.count === 'number' ? Math.floor(rec.count) : 1;
    const count = op === 'add' ? Math.min(Math.max(rawCount, 1), 4) : 1;
    asks.push({
      instruction,
      sections: resolveSections(rec.sections),
      op,
      count,
      // Absent/garbled means false. "Recreate this section from the picture" is
      // the most destructive thing a step can do — it must be asked for, never
      // assumed from a missing field.
      designMatch: truthy(rec.design_match),
      // 1-based in the prompt (matching how attachments are described to the
      // user), 0-based here. Out-of-range entries are dropped rather than
      // clamped — pointing at an image that does not exist is not a near-miss.
      imageIndexes: (Array.isArray(rec.image_indexes) ? rec.image_indexes : [])
        .map((n) => (typeof n === 'number' ? Math.floor(n) - 1 : -1))
        .filter((n, i, arr) => n >= 0 && n < imageCountForAsks && arr.indexOf(n) === i)
        .slice(0, 3),
    });
    if (asks.length >= 6) break;
  }

  const constraints: string[] = [];
  const rawConstraints = Array.isArray(raw.constraints) ? raw.constraints : [];
  for (const entry of rawConstraints) {
    if (typeof entry !== 'string') continue;
    const text = entry.trim();
    if (text && !constraints.includes(text)) constraints.push(text);
    if (constraints.length >= 6) break;
  }

  const imageCount = (opts.imageUrls ?? []).slice(0, 2).length;
  const roles: AttachmentRole[] = [];
  const rawRoles = Array.isArray(raw.attachment_roles) ? raw.attachment_roles : [];
  for (let i = 0; i < imageCount; i++) {
    const r = rawRoles[i];
    roles.push(
      r === 'bug_report' || r === 'content_asset' || r === 'design_reference'
        ? r
        : 'design_reference',
    );
  }

  // A source URL is only usable if the user actually gave it to us: this message
  // or an earlier turn. Never a URL the model recalled or invented.
  const claimedUrl = typeof raw.source_url === 'string' ? raw.source_url.trim() : '';
  const allowedUrls = opts.earlierUrls ?? [];
  const sourceUrl =
    /^https?:\/\//i.test(claimedUrl) &&
    (allowedUrls.includes(claimedUrl) || allowedUrls.length === 0)
      ? claimedUrl
      : allowedUrls.length > 0 && truthy(raw.uses_earlier_source)
        ? allowedUrls[allowedUrls.length - 1]
        : null;

  const designReference = truthy(raw.design_reference) || roles.includes('design_reference');
  const assetSource =
    raw.asset_source === 'logo' || raw.asset_source === 'content_images'
      ? raw.asset_source
      : null;

  const rawReuse = asRecord(raw.content_reuse);
  let contentReuse: ContentReuseIntent | null =
    rawReuse && (rawReuse.kind === 'logo' || rawReuse.kind === 'text' || rawReuse.kind === 'image')
      ? {
          kind: rawReuse.kind,
          targets: resolveSections(rawReuse.targets),
          textPayload:
            typeof rawReuse.text_payload === 'string' && rawReuse.text_payload.trim()
              ? rawReuse.text_payload.trim()
              : null,
          sourceSectionHint: resolveSections(rawReuse.source_section_hint)[0] ?? null,
        }
      : null;
  // Two keyword overrides used to sit here, inside the classifier — the worst
  // possible place, because they silently overruled the model's own answer:
  //
  //   1. isLogoStyleAsk(prompt) cancelled a "logo" content-reuse. The system
  //      prompt now states outright that recolouring/resizing is a style ask,
  //      not reuse, so the model answers it directly.
  //   2. inferTargetSectionNames(prompt) filled in sections whenever the model
  //      returned none — re-introducing keyword section-guessing at the very
  //      heart of the design. An empty list is an honest "I could not tell";
  //      callers answer it with resolveSectionsForAsk() or by asking the user.
  //
  // 'add' asks are excluded on purpose. Their "sections" is an ANCHOR — where
  // the new section should sit — not something to edit. Folding anchors in here
  // is what turned "add a section like this image" into "edit the hero": the
  // union pinned hero as a patch target, the dispatcher was skipped, and the
  // new content was written inside the hero instead of beside it.
  const targetSections = Array.from(
    new Set(asks.filter((a) => a.op !== 'add').flatMap((a) => a.sections)),
  );

  return {
    designReference,
    // Style-only references must not stamp the reference's words onto the page.
    reuseReferenceCopy: truthy(raw.reuse_reference_copy),
    bugReport: truthy(raw.bug_report) || roles.includes('bug_report'),
    attachmentRoles: roles,
    asks,
    constraints,
    targetSections: targetSections.slice(0, 6),
    fullRebuild: truthy(raw.full_rebuild),
    usesEarlierSource: truthy(raw.uses_earlier_source),
    sourceUrl,
    assetSource,
    contentReuse,
    proceedAnyway: truthy(raw.proceed_anyway),
    removalIntent: truthy(raw.removal_intent),
    intentionalAssetReplace: truthy(raw.intentional_asset_replace),
    wantsSocialProof: truthy(raw.wants_social_proof),
    requirements: parseModelRequirements(raw.requirements, {
      knownSections: known,
      embeddableAssetUrls: opts.embeddableAssetUrls,
    }),
  };
}

/**
 * Map intent attachment roles onto image URLs for the follow-up pipeline.
 * Intent wins: a message-level design_reference must not be flipped to
 * bug_reference because one ask also said "logo".
 */
export function imageRolesFromIntent(
  intent: EditIntent,
  imageUrls: string[],
): Array<{ url: string; role: 'design_reference' | 'bug_reference' | 'content_asset' }> {
  return imageUrls.map((url, i) => {
    const raw = intent.attachmentRoles[i];
    let role: 'design_reference' | 'bug_reference' | 'content_asset' =
      raw === 'content_asset'
        ? 'content_asset'
        : raw === 'bug_report'
          ? 'bug_reference'
          : raw === 'design_reference'
            ? 'design_reference'
            : intent.designReference
              ? 'design_reference'
              : intent.bugReport
                ? 'bug_reference'
                : 'design_reference';
    if (intent.designReference && role === 'bug_reference') {
      role = 'design_reference';
    }
    return { url, role };
  });
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}

/** Tolerant JSON extraction — the same shape of leniency the routing pass uses. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = trimmed.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
