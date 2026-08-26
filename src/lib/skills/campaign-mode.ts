import type { Skill } from './types';
import { findCtas, stripCode } from './check-utils';

/**
 * The "no exits" page: paid traffic arrives with one job, and every link that
 * is not that job is a way to leave.
 *
 * This one contradicts a base-prompt DEFAULT (we normally add a sticky nav).
 * That is allowed and intended — nav is on the NOT-locked list, so a skill may
 * override it. It contradicts no LOCKED rule: the footer keeps its legal links,
 * because removing those is a legal problem, not a conversion win.
 */

export const campaignMode: Skill = {
  id: 'campaign_mode',
  name: 'Campaign Mode',
  description:
    'Strips every exit from the page: no nav, no footer links except legal, and one single CTA destination throughout.',
  useFor: 'Paid ads, email campaigns, webinar sign-ups, lead magnets — anywhere you paid for the click.',
  notFor:
    'A homepage, a multi-product site, or any page where visitors are meant to browse. It will remove navigation they need.',

  generateBlock: `## Campaign page — no exits
This page receives paid or campaign traffic. Do not include a nav section. The footer carries the copyright and legal links only — no sitemap, no social links, no "About us". Every CTA in the schema points at the same conversion target.`,

  buildBlock: `## Campaign page — no exits (overrides the default page chrome)
- **No navigation bar of any kind** — not sticky, not static, not a hamburger. Do NOT add one even though a landing page normally gets one. A logo alone at the top is fine and is not navigation.
- **Footer carries legal only**: copyright line, privacy, terms. No column of site links, no social icons, no secondary menu.
- **One CTA destination.** Every button and every link that reads as a call to action resolves to the same href. An anchor to the form section further down the page counts as the same destination as the form itself.
- Non-CTA links are still allowed where they are not exits: a phone number, an email address, a legal page.
- Because the page has no nav, the hero carries the whole burden of orientation — make the H1 state plainly what this is and who it is for.`,

  checks: [
    {
      id: 'no_nav',
      label: 'No navigation bar',
      run: (html) => {
        const body = stripCode(html);
        const hasNavTag = /<nav\b/i.test(body);
        const hasNavMarker = /<!--\s*SL:(nav|header)[a-z0-9_-]*\s*-->/i.test(html);
        return hasNavTag || hasNavMarker
          ? { passed: false, detail: 'A navigation bar is still on the page.' }
          : { passed: true, detail: 'No navigation — nothing to click away with.' };
      },
    },
    {
      id: 'single_cta_target',
      label: 'One CTA destination',
      run: (html) => {
        const targets = new Set(
          findCtas(html)
            .map((c) => (c.href ?? '').trim())
            .filter((h) => h && h !== '#')
            // A form-submit button has no href and is the destination itself.
            .map((h) => h.replace(/[?#].*$/, '') || h),
        );
        if (targets.size === 0) return null;
        return targets.size === 1
          ? { passed: true, detail: `Every CTA points at ${Array.from(targets)[0]}.` }
          : { passed: false, detail: `${targets.size} different CTA destinations: ${Array.from(targets).slice(0, 3).join(', ')}.` };
      },
    },
    {
      id: 'footer_legal_only',
      label: 'Footer has no exit links',
      run: (html) => {
        const footer = /<footer\b[\s\S]*?<\/footer>/i.exec(stripCode(html))?.[0];
        if (!footer) return null;
        const links = Array.from(footer.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)).map((m) =>
          m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
        );
        const allowed = /(privacy|terms|cookie|legal|disclaimer|accessibility|imprint|@|\+?\d[\d\s().-]{6,})/i;
        const exits = links.filter((t) => t && !allowed.test(t));
        return exits.length === 0
          ? { passed: true, detail: `Footer carries ${links.length} link${links.length === 1 ? '' : 's'}, all legal or contact.` }
          : { passed: false, detail: `${exits.length} non-legal footer link${exits.length === 1 ? '' : 's'}: ${exits.slice(0, 3).join(', ')}.` };
      },
    },
  ],
};
