/**
 * The rules a skill may never override.
 *
 * These are not new behaviour — every line below is already enforced somewhere
 * in the base prompts or by a downstream guard in the build route. They are
 * gathered and named here for one reason: skills are appended LAST and each
 * ends with "you override the defaults above", so without an explicitly
 * non-negotiable block, a skill could talk the model out of a rule that a
 * later piece of CODE depends on.
 *
 * The test for whether a rule belongs here is not "is it important" — it is
 * "does something downstream break, or does the page lie, if the model ignores
 * it". Taste never belongs here.
 *
 * NOT locked, and deliberately so — a skill IS allowed to override these:
 * sticky nav, section count and mix, hero layout, how often the CTA repeats,
 * where social proof sits, padding rhythm, icon usage, image count.
 *
 * Palette and typography WERE on this list and are not anymore: a chosen
 * style's exact colors/fonts kept losing to whatever the model felt "fit"
 * the business better, on both manual picks and Auto. Layout rhythm,
 * geometry and signature moves from a style stay soft guidance — only the
 * palette and typeface are locked now. See STYLE below.
 */

const TRUTH = `### Truth (never overridable)
- Never invent statistics, testimonials, client logos, awards, "as seen in" bars, review counts, customer numbers, prices, or guarantees. If the brief did not supply it, it does not go on the page.
- Never add urgency, a countdown, or a deadline unless the brief states a real one.
- Legal, compliance and copyright copy quoted in the brief is reproduced byte-for-byte. Never paraphrase or shorten it.
- No bracket placeholders, no lorem ipsum, no invented URLs, no fake email addresses on the finished page.`;

const ASSETS = `### Supplied assets (never overridable)
- An image the user supplied is used exactly as given, at the placement stated. Never substitute a different URL for it, and never invent an image URL.
- A screenshot of a website is never used as a logo or as a content photograph.
- A supplied logo appears at its given URL, on a transparent background, with no box behind it.`;

const EDITABILITY = `### Editability (never overridable)
- Every top-level block of the page sits inside a <!-- SL:name --> section marker. A block outside a marker is invisible to every later edit.
- Every text element that a user could want to change carries a data-field attribute.
- Normal document flow only. No absolutely-positioned page layout, no fixed pixel coordinates for structure.
- The <!-- TRACKER_PLACEHOLDER --> comment stays in the document.`;

const RUNTIME = `### Runtime safety (never overridable)
- No external JavaScript, no third-party scripts, no CDN libraries, no analytics tags. The only script tag permitted is inline JSON-LD structured data.
- All CSS is inline in a <style> block in the document. No external stylesheets other than a Google Fonts link.
- Any scroll-triggered reveal must have a self-completing fallback so content is never permanently invisible if the trigger does not fire.
- Video and iframe embeds are locked to a fixed aspect ratio.`;

const ACCESSIBILITY = `### Accessibility floor (never overridable)
- Accent and body text meet 4.5:1 contrast against their own background; large and muted text meets 3:1.
- Every card, panel and coloured section declares its own text colour rather than inheriting one that may not contrast.
- Form inputs are at least 16px so mobile browsers do not zoom on focus. Tap targets are at least 44x44px.
- No horizontal scrolling at 360px wide.
- Visible :focus-visible styling on every interactive element, and a prefers-reduced-motion block that disables non-essential animation.`;

const HONESTY = `### Honest output (never overridable)
- Never report a section as built when it was not. If part of the brief could not be satisfied, leave it out rather than faking it.`;

const STYLE = `### Style palette and typography (never overridable)
- If the user message contains a "## Style reference" block, its palette hex values (background, text, accent, secondary) and its "Use EXACTLY these values" token block are locked exactly as given — do not substitute different colors because another shade feels like a better fit for the business.
- That block's typography (headline and body font family) is locked exactly as given — do not substitute a different font family.
- Everything else in that block — layout rhythm, geometry, signature moves — stays guidance, not a lock. Adapt those to the business as needed.`;

export const LOCKED_RULES_BUILD = `

# LOCKED RULES — these outrank everything below, including any selected skill
The instructions further down may adjust taste, structure, section mix and emphasis. They may never relax anything in this block. If a later instruction conflicts with this block, this block wins.

${TRUTH}

${ASSETS}

${EDITABILITY}

${RUNTIME}

${ACCESSIBILITY}

${HONESTY}

${STYLE}`;

/**
 * The schema pass writes content, not markup, so the markup-level locks (SL
 * markers, inline CSS, contrast) have nothing to bind to here. Including them
 * would be prompt weight the model cannot act on.
 */
export const LOCKED_RULES_GENERATE = `

# LOCKED RULES — these outrank everything below, including any selected skill
The instructions further down may adjust structure, section mix and emphasis. They may never relax anything in this block. If a later instruction conflicts with this block, this block wins.

${TRUTH}

${ASSETS}

${HONESTY}`;
