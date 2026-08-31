/**
 * The ONE place that says what SplitLab can and cannot do.
 *
 * WHY THIS FILE EXISTS
 * This list used to be hand-typed bullets inside FOLLOW_UP_QUESTION_SYSTEM in
 * src/app/api/pages/[id]/follow-up/route.ts, read by exactly one code path —
 * the "user asked a pure question" branch. Two consequences:
 *
 *   1. The classifier never saw it. So "make the UTMs carry over to the
 *      Calendly box" was classified as a page edit, and the editor went and
 *      rewrote HTML for something that already happens on its own and cannot
 *      be delivered by editing HTML at all.
 *   2. Shipping a feature meant remembering to reword a paragraph buried in a
 *      6,000-line route. Forget, and the AI keeps telling clients the old
 *      story with total confidence.
 *
 * Both consumers now read from here. Ship something → change it here → every
 * answer is current.
 *
 * HOW TO KEEP IT HONEST
 * An AI that confidently promises a capability we do not have is far worse
 * than one that says "not yet". So: only write down what is actually true in
 * the code today, and put each exception NEXT TO its capability rather than in
 * a footnote — "it's automatic" with a silent asterisk is how a client finds
 * the asterisk in production instead of finding it here.
 *
 * These strings are read by models, not printed to users. They can be precise;
 * the prompts that consume them are separately instructed to answer the client
 * in plain, non-technical words.
 */

/**
 * What the AI builder can do to the PAGE. Everything here is a real edit — the
 * model changes HTML and the page looks different afterwards.
 *
 * Moved here verbatim from FOLLOW_UP_QUESTION_SYSTEM; deliberately unchanged
 * in substance, so nothing the assistant used to say about editing changes.
 */
export const BUILDER_CAPABILITIES = `- Edit any existing section: restyle, recolor, resize, rewrite copy, fix spacing/alignment, replace an image.
- Add brand-new sections, remove sections, reorder sections.
- Match a look from an attached screenshot or a reference site (design_reference), and fetch a real logo or content photos from a given site URL.
- Generate real photography for sections via AI image generation.
- Import the client's own images from a link — a public Google Drive folder, an S3/public bucket, a direct image URL, or any web page — using the link button next to the chat box. The files are re-hosted by SplitLab and can then be placed on the page. Never tell a user you have no way to pull from Google Drive or a bucket; you do.
- Use images imported earlier in this same conversation. If the user supplied files on a previous turn, they are listed for you by filename and URL and are still usable — do not claim they are gone or ask for a re-upload.`;

/**
 * What SplitLab does ON ITS OWN, once a page is live. None of this is a page
 * edit: it is built-in behaviour or a dashboard setting, so editing the page's
 * HTML cannot deliver it and trying only damages the page.
 *
 * This is also the list the intent classifier reads to recognise a request
 * that is phrased like an edit but is really about platform behaviour.
 */
export const PLATFORM_BEHAVIOURS = `- Lead capture: every form submission on a live page is captured into SplitLab's own Leads for that test. No setup, no code on the page — a form does not need an action or an endpoint for this to work.
- Lead forwarding: HubSpot, email notification, and webhook-to-any-URL integrations are turned on per test in the workspace's Integrations settings. Once on, every captured lead is forwarded automatically.
- UTM and ad-click tracking is automatic, and this is the one people most often ask us to "add" when it is already there:
  - When someone lands from an ad, the tracking params on that URL (utm_*, gclid, fbclid, msclkid, ttclid, hsa_* and the other ad-network click IDs, plus any custom param names registered for the workspace or test) are captured and remembered for 90 days, across pages.
  - They are stored with every lead that visitor later submits, so a lead is attributed to the ad that produced it even when the form is on a different page from the one they landed on.
  - They are added automatically to outbound destinations: links and buttons the visitor clicks, form submissions, links opened in a new tab, and embedded booking or form widgets in a frame (Calendly, HubSpot meetings, Typeform, and anything else loaded from another site).
  - On by default, and switchable off per test — "UTM & ad-click forwarding" in the test's Integrations settings.
  - Known exceptions, to be named rather than glossed over whenever this subject comes up: a button that moves the visitor by running JavaScript (rather than being an ordinary link) will not carry the params on older browsers; and a frame loaded from the SAME site as the page is left alone. A specific frame can also be excluded on purpose by putting data-sl-no-params on it, or on anything wrapping it.
- A/B testing itself: traffic is split between variants automatically, each visitor is assigned by the test's traffic weights and stays on the same variant on later visits. Pageviews, conversions and statistical significance are calculated by SplitLab.
- Publishing, custom domains, and workspace-wide scripts (analytics, pixels, chat widgets) are configured in the SplitLab dashboard, not by editing the page in this chat.`;

/**
 * What we genuinely do not do yet. Kept as its own export so it is impossible
 * to "update the capabilities" and quietly leave a stale promise behind.
 */
export const NOT_SUPPORTED = `- Wire an arbitrary custom submission endpoint directly into the page's own code from a chat instruction. Forms do not POST anywhere on their own — delivery goes through the Leads/Integrations path above instead.
- A built-in confirmation-email-on-submit beyond what the email integration sends.`;

/**
 * The whole picture, for a prompt that answers the client directly.
 *
 * The classifier gets PLATFORM_BEHAVIOURS on its own and not this — it has no
 * use for the builder list, since "not on the platform list" already means
 * "treat it as a normal edit", which is what it did before this existed.
 */
export function buildCapabilityBlock(): string {
  return `What this builder can actually do to the page right now, so you never overpromise:
${BUILDER_CAPABILITIES}

What SplitLab already does on its own, with no page edit involved. If a user asks for one of these, it ALREADY WORKS — say so, name the exceptions, and do not offer to build it:
${PLATFORM_BEHAVIOURS}

What we cannot do yet:
${NOT_SUPPORTED}`;
}
