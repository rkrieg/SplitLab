import type { Skill } from './types';
import { bytes, findImages, formatKb, imageIsSized, attrValue, hasAttr } from './check-utils';

/**
 * Core Web Vitals, distilled from the client's landing-page-generator skill.
 *
 * Everything here is genuinely checkable from the HTML we ship — layout shift
 * comes from unsized images, and lazy-loading is an attribute. We deliberately
 * do NOT claim an LCP or FID number: we cannot measure either without loading
 * the page in a browser, and a made-up millisecond figure would be the exact
 * kind of confident-but-wrong number this whole feature exists to stop.
 */

export const speedStability: Skill = {
  id: 'speed_stability',
  name: 'Speed & Stability',
  description:
    'Every image sized so nothing jumps while the page loads, below-the-fold images deferred, and page weight kept down.',
  useFor: 'Paid-traffic pages, mobile-heavy audiences, image-rich pages where a slow load costs clicks.',
  notFor: 'A short, text-only page with one or two images — there is nothing here for it to fix.',
  defaultOn: true,

  generateBlock: '',

  buildBlock: `## Speed and layout stability
- Every <img> carries explicit width and height attributes (or an inline aspect-ratio) so the browser reserves the space before the file arrives. An unsized image is the single biggest cause of content jumping while a page loads.
- The hero image loads eagerly: loading="eager" and fetchpriority="high". It is the largest paint on the page and deferring it makes the page feel slower, not faster.
- Every image below the hero carries loading="lazy" and decoding="async".
- Any embedded video or iframe is wrapped in a fixed aspect-ratio box so it cannot resize the page when it loads.
- Keep the document lean: no duplicated CSS blocks, no unused keyframes, no font weights you never set. Every font family you @import must actually be used.`,

  checks: [
    {
      id: 'images_sized',
      label: 'Images reserve their space (no layout jump)',
      run: (html) => {
        const imgs = findImages(html);
        if (imgs.length === 0) return null;
        const unsized = imgs.filter((i) => !imageIsSized(i.attrs));
        return unsized.length === 0
          ? {
              passed: true,
              detail:
                imgs.length === 1
                  ? 'The page\'s one image declares its dimensions.'
                  : `All ${imgs.length} images declare their dimensions.`,
            }
          : { passed: false, detail: `${unsized.length} of ${imgs.length} images have no declared size — those can shift the layout as they load.` };
      },
    },
    {
      id: 'lazy_below_hero',
      label: 'Below-the-hero images deferred',
      run: (html) => {
        const imgs = findImages(html);
        // The first image is the hero and must NOT be lazy — nothing to judge
        // on a page with only one.
        if (imgs.length < 2) return null;
        const rest = imgs.slice(1);
        const eager = rest.filter((i) => (attrValue(i.attrs, 'loading') ?? '').toLowerCase() !== 'lazy');
        return eager.length === 0
          ? {
              passed: true,
              detail:
                rest.length === 1
                  ? 'The one image below the hero loads lazily.'
                  : `All ${rest.length} images below the hero load lazily.`,
            }
          : { passed: false, detail: `${eager.length} of ${rest.length} images below the hero load eagerly.` };
      },
    },
    {
      id: 'hero_image_priority',
      label: 'Hero image loads first',
      run: (html) => {
        const imgs = findImages(html);
        if (imgs.length === 0) return null;
        const hero = imgs[0];
        const lazy = (attrValue(hero.attrs, 'loading') ?? '').toLowerCase() === 'lazy';
        if (lazy) return { passed: false, detail: 'The first image on the page is lazy-loaded, which delays the largest paint.' };
        return {
          passed: true,
          detail: hasAttr(hero.attrs, 'fetchpriority')
            ? 'Hero image is eager and marked high priority.'
            : 'Hero image loads eagerly.',
        };
      },
    },
    {
      id: 'page_weight',
      label: 'Document weight',
      run: (html) => {
        const size = bytes(html);
        // The HTML document only — images are hosted separately and are not in
        // this number. Say so, so nobody reads it as total page weight.
        return size <= 500 * 1024
          ? { passed: true, detail: `${formatKb(size)} of HTML/CSS (images not included).` }
          : { passed: false, detail: `${formatKb(size)} of HTML/CSS — over the 500 KB we aim for (images not included).` };
      },
    },
  ],
};
