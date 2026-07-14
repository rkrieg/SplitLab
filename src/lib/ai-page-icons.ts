/**
 * Icon library configuration for AI page generation.
 *
 * Provides Font Awesome 6 Free via CDN. Claude picks icons freely based on
 * business context — no curated list needed since Claude knows FA icon names
 * from training data. This file just supplies the CDN URL and usage rules
 * that get injected into the build system prompt.
 */

export interface IconLibrary {
  name: string;
  cdnUrl: string;
  usageSyntax: string;
  instructions: string;
}

export const ICON_LIBRARY: IconLibrary = {
  name: 'Font Awesome 6 Free',
  cdnUrl: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css',
  usageSyntax: '<i class="fa-solid fa-icon-name"></i> or <i class="fa-regular fa-icon-name"></i>',
  instructions: `Use icons freely wherever they improve clarity, visual hierarchy, or UX — feature lists, benefits, stats, contact details, navigation, CTAs, testimonial star ratings, and section headers. Add CSS hover effects on interactive icons where it enhances the experience. Pick icons that are semantically relevant to the business and content — a law firm gets scales and shields, a gym gets dumbbells and fire, a SaaS gets bolts and charts. Never place icons purely for decoration with no meaning. Every icon must earn its place.`,
};

/**
 * Serializes ICON_LIBRARY into a prompt-ready block injected into the
 * build system prompt. Claude reads this to know where to load icons from
 * and how to use them freely throughout the page.
 */
export function buildIconLibraryBlock(): string {
  return `## Icons — use freely to enhance UX and visual quality
Load ${ICON_LIBRARY.name} by adding this tag in <head> (after the Google Fonts @import, before </head>):
<link rel="stylesheet" href="${ICON_LIBRARY.cdnUrl}">

Syntax: ${ICON_LIBRARY.usageSyntax}

${ICON_LIBRARY.instructions}`;
}
