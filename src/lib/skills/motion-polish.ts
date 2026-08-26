import type { Skill } from './types';
import { styleText } from './check-utils';

/**
 * Motion and interaction — how the page feels under a cursor and a scroll.
 *
 * Our LOCKED rules already require prefers-reduced-motion and a self-completing
 * fallback for scroll reveals, but those are safety rails: they say what motion
 * must not break, never what good motion is. A page with no considered
 * interaction reads as a template even when it looks correct in a screenshot.
 *
 * Timings distilled from the public motion skills (LottieFiles motion-design,
 * Emil Kowalski's animation course as packaged for agents).
 *
 * Everything here is CSS-only by necessity: LOCKED forbids external JavaScript,
 * so entrances are animation + animation-delay (which self-complete) rather
 * than IntersectionObserver reveals.
 */

/** transition/animation durations declared anywhere in the CSS. */
function declaredDurationsMs(css: string): number[] {
  const out: number[] = [];
  const re = /(?:transition|animation)(?:-duration)?\s*:\s*([^;}]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    for (const t of Array.from(m[1].matchAll(/(\d*\.?\d+)\s*(ms|s)\b/gi))) {
      const n = parseFloat(t[1]);
      if (!Number.isFinite(n)) continue;
      out.push(t[2].toLowerCase() === 's' ? n * 1000 : n);
    }
  }
  return out;
}

/** Properties that force layout on every frame instead of running on the GPU. */
const LAYOUT_PROPS = /\b(width|height|top|left|right|bottom|margin|margin-top|margin-left|padding|font-size)\b/i;

export const motionPolish: Skill = {
  id: 'motion_polish',
  name: 'Motion Polish',
  description:
    'Gives the page considered interaction: hover and pressed states on everything clickable, one consistent easing and timing, and reveals that stagger instead of popping in.',
  useFor: 'Brand, premium and design-led pages where "does this feel expensive" is part of the job.',
  notFor: 'A plain lead-capture page where the only thing that matters is the form, or a page for an audience on slow devices.',
  defaultOn: true,

  generateBlock: '',

  buildBlock: `## Motion and interaction
All motion here is CSS only — no JavaScript, no libraries.

**Timing.** Use one scale across the whole page and do not vary it per element:
- Micro-interactions (hover, button press, toggle): 150-250ms
- Standard transitions (a panel, a reveal, an accordion): 200-350ms
- Anything orchestrated across several elements: 400-600ms, never above 600ms
- Exits are faster than entrances (enter 300ms, exit 200ms)

**Easing.** Never \`linear\` except on a progress bar or an infinite loop.
- Entrances decelerate: \`cubic-bezier(0.16, 1, 0.3, 1)\` or \`ease-out\`
- Exits accelerate: \`ease-in\`
- Something moving from one place to another while staying on screen: \`ease-in-out\`
Declare the curve once as a CSS custom property (e.g. \`--ease: cubic-bezier(0.16, 1, 0.3, 1)\`) and reference it everywhere, so the whole page moves with one personality.

**Only animate transform and opacity.** Never transition width, height, top, left, margin, padding or font-size — each one forces the browser to re-lay-out the page on every frame and produces visible stutter on mid-range phones. Move things with \`translate\`, size them with \`scale\`.

**Interaction states are mandatory on every clickable element** (buttons, nav links, cards that act as links):
- \`:hover\` — a small lift (\`translateY(-1px)\` to \`-2px\`) or a colour shift, arriving instantly and fading back over ~150ms
- \`:active\` — a compression, \`scale(0.97)\` to \`scale(0.98)\`, so a click feels physical
- \`:focus-visible\` keeps its visible ring (locked rule) and is never removed to make hover look tidier

**Entrances.** Fade and rise: \`opacity: 0; transform: translateY(8px)\` to \`opacity: 1; transform: none\`. Movement is 4-16px for micro-interactions, 20-40px for a section reveal — never a large slide across the screen. Where a group of items appears together, stagger them 30-60ms apart, and only for groups of 3-7 items; more than that and the last one arrives late enough to feel broken.

**Restraint.** Motion marks what changed. A page where everything moves has told the visitor nothing. Nothing loops or pulses continuously except a genuine loading indicator.

**Reduced motion.** The \`prefers-reduced-motion\` block (locked rule) must disable all of the above, leaving every element in its final, visible state.`,

  checks: [
    {
      id: 'interactive_states',
      label: 'Hover and pressed states on clickable elements',
      run: (html) => {
        const css = styleText(html);
        if (!css) return null;
        const hover = /:hover\b/i.test(css);
        const active = /:active\b/i.test(css);
        if (hover && active) return { passed: true, detail: 'Both hover and pressed states are defined.' };
        if (hover) return { passed: false, detail: 'Hover states exist but nothing responds to a click — no :active state.' };
        return { passed: false, detail: 'No hover states — clickable elements do not respond to the cursor.' };
      },
    },
    {
      id: 'easing_declared',
      label: 'Deliberate easing, not the browser default',
      run: (html) => {
        const css = styleText(html);
        if (!css) return null;
        // Nothing animated at all is a valid choice and not a failure.
        if (!/\b(transition|animation)\s*:/i.test(css)) return null;
        const custom = /cubic-bezier\s*\(/i.test(css);
        const named = /\b(ease-out|ease-in-out|ease-in)\b/i.test(css);
        const linearOnly = /linear/i.test(css) && !custom && !named;
        if (custom) return { passed: true, detail: 'A custom easing curve is defined and used.' };
        if (named) return { passed: true, detail: 'Named easing curves (ease-out / ease-in) are used rather than the default.' };
        return {
          passed: false,
          detail: linearOnly
            ? 'Motion uses linear easing, which reads as mechanical.'
            : 'Transitions declare no easing, so everything uses the browser default.',
        };
      },
    },
    {
      id: 'gpu_safe_properties',
      label: 'Animates only transform and opacity',
      run: (html) => {
        const css = styleText(html);
        if (!css) return null;
        const declarations = Array.from(css.matchAll(/transition(?:-property)?\s*:\s*([^;}]+)/gi)).map(
          (m) => m[1],
        );
        if (declarations.length === 0) return null;
        const offenders = Array.from(
          new Set(
            declarations
              .flatMap((d) => d.split(','))
              .map((d) => LAYOUT_PROPS.exec(d)?.[0]?.toLowerCase())
              .filter((v): v is string => Boolean(v)),
          ),
        );
        return offenders.length === 0
          ? { passed: true, detail: 'Transitions stay on transform/opacity and colour, which do not stutter.' }
          : {
              passed: false,
              detail: `${offenders.map((o) => `"${o}"`).join(', ')} ${offenders.length === 1 ? 'is' : 'are'} transitioned — those force a re-layout on every frame.`,
            };
      },
    },
    {
      id: 'duration_sane',
      label: 'Nothing takes too long',
      run: (html) => {
        const css = styleText(html);
        if (!css) return null;
        const durations = declaredDurationsMs(css);
        if (durations.length === 0) return null;
        // Infinite loops (a spinner, an ambient drift) are legitimately long
        // and are not what this check is about, but we cannot tie a duration
        // back to its animation-iteration-count by regex — so we only flag the
        // clearly excessive, above one full second.
        const slow = durations.filter((d) => d > 1000);
        const longest = Math.max(...durations);
        return slow.length === 0
          ? { passed: true, detail: `Longest declared duration is ${Math.round(longest)}ms.` }
          : {
              passed: false,
              detail: `${slow.length} animation${slow.length === 1 ? '' : 's'} run${slow.length === 1 ? 's' : ''} over a second (longest ${Math.round(longest)}ms) — long enough for a visitor to wait on it.`,
            };
      },
    },
    {
      id: 'reduced_motion',
      label: 'Respects reduced-motion settings',
      run: (html) => {
        const css = styleText(html);
        if (!css) return null;
        if (!/\b(transition|animation)\s*:/i.test(css)) return null;
        return /prefers-reduced-motion/i.test(css)
          ? { passed: true, detail: 'Animation is disabled for visitors who ask for reduced motion.' }
          : { passed: false, detail: 'No prefers-reduced-motion block — animation plays regardless of the visitor\'s setting.' };
      },
    },
  ],
};
