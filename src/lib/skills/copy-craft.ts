import type { Skill } from './types';
import { findCtas, stripCode } from './check-utils';

/**
 * The words themselves — the one layer nothing else in the stack owns.
 *
 * Landing Page Generator decides what sections exist and in what order.
 * Anti-Slop bans visual cliches. Neither says anything about how a sentence is
 * written, so the model falls back to the register it was trained on: fluent,
 * confident, and completely interchangeable with every other AI page. A page
 * can pass every structural check we have and still read as machine-written.
 *
 * Rules distilled from the public copywriting skills (boraoztunc/skills,
 * coreyhaines31/marketingskills) and the standard direct-response canon.
 *
 * Most of this lands in the GENERATE block on purpose: the schema pass is where
 * the words are actually written. The build block only stops the model from
 * rewriting them back into buzzwords while it builds the markup.
 */

/**
 * Phrases that carry no information.
 *
 * Every entry is a word that survives being deleted — "a robust solution" and
 * "a solution" say the same thing. They are flagged, never auto-removed: if the
 * client's own supplied tagline contains one, LOCKED requires we reproduce it
 * verbatim, so the check names the word and lets a human judge.
 */
const HOLLOW_WORDS = [
  'unlock', 'seamless', 'seamlessly', 'cutting-edge', 'leverage', 'leveraging',
  'revolutionize', 'revolutionise', 'elevate', 'empower', 'robust', 'game-changing',
  'game changer', 'streamline', 'streamlined', 'world-class', 'best-in-class',
  'state-of-the-art', 'next-level', 'supercharge', 'unparalleled', 'synergy',
  'holistic', 'paradigm', 'turnkey', 'innovative', 'innovation-driven',
  'take it to the next level', "in today's fast-paced", 'harness the power',
  'transform your', 'redefine', 'reimagine',
];

const HOLLOW_RE = new RegExp(
  `\\b(${HOLLOW_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'gi',
);

/** CTA labels that describe navigation rather than a conversion. */
const WEAK_CTA_RE = /^(learn more|read more|click here|find out more|more info(rmation)?|see more|view more|discover more|explore|submit|send|continue)\b/i;

/** Visible page text, tags and code stripped, entities loosely decoded. */
function visibleText(html: string): string {
  return stripCode(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const copyCraft: Skill = {
  id: 'copy_craft',
  name: 'Copy Craft',
  description:
    'Bans hollow marketing language and forces concrete, specific writing — the difference between "unlock seamless solutions" and "we arrive in 45 minutes".',
  useFor:
    'Every page. Especially anywhere the complaint is that the writing sounds generic or AI-written.',
  notFor:
    'A page whose copy is supplied verbatim by the client and must not be rewritten.',
  defaultOn: true,

  generateBlock: `## How to write (mandatory)
The structure of this page is decided elsewhere. This section is about the sentences.

**Be specific, not impressive.** Every claim carries a number, a name, a place or a timeframe wherever the brief supplies one. "We answer in 45 minutes" beats "fast response". "Licensed plumbers across Austin" beats "serving your area". If the brief gives you no number, write the plain concrete fact instead — never inflate it into a vague superlative to fill the gap, and never invent the number.

**Write the benefit, not the feature.** The reader does not want "AI-powered scheduling"; they want "you stop losing Saturdays to the rota". Name the outcome in their life, then the feature that delivers it — in that order.

**Banned words.** These carry no information and mark the page as machine-written. Do not use any of them: unlock, seamless, cutting-edge, leverage, revolutionize, elevate, empower, robust, game-changing, streamline, world-class, best-in-class, state-of-the-art, next-level, supercharge, unparalleled, synergy, holistic, turnkey, innovative, "take it to the next level", "in today's fast-paced world", "harness the power of", "transform your business". If a sentence still says the same thing with the word deleted, the word was decoration.

**Sentence discipline.**
- Active voice. "We fix it" not "it will be fixed".
- Short sentences. Average under about 20 words; vary the length so it does not read like a list.
- Plain English: use, not utilize. Help, not facilitate. Buy, not purchase.
- No exclamation marks anywhere on the page. Enthusiasm comes from the claim, not the punctuation.
- Cut every filler qualifier: very, really, quite, truly, simply, just, actually, literally.

**The headline does one job.** It states what the visitor gets, in their words, in about 12 words or fewer. It is not the company's self-description and not a slogan. If the brief names the traffic source, the headline mirrors that wording (see message match).

**CTA labels are the outcome.** "Get my free quote", "Book the 15-minute call". Never "Learn more", "Click here", "Submit", "Explore".

**Read it back as the customer.** If a sentence could appear unchanged on a competitor's page in a different industry, it is saying nothing. Rewrite it or delete it.`,

  buildBlock: `## Copy discipline while building
- Reproduce the schema's copy as written. If you must generate any text the schema did not supply (a label, a caption, a microcopy line), it follows the same rules: specific, active, plain, no exclamation marks, and none of the banned buzzwords (unlock, seamless, cutting-edge, leverage, revolutionize, elevate, empower, robust, streamline, world-class, state-of-the-art, supercharge, innovative).
- Never pad a section with invented marketing sentences to make it look fuller. A short section is a layout problem, solved with scale and whitespace.
- Button labels state the outcome, never "Learn more", "Click here" or "Submit".`,

  checks: [
    {
      id: 'no_hollow_words',
      label: 'No hollow marketing words',
      run: (html) => {
        const text = visibleText(html);
        if (!text) return null;
        const hits = Array.from(text.matchAll(HOLLOW_RE)).map((m) => m[0].toLowerCase());
        const unique = Array.from(new Set(hits));
        return unique.length === 0
          ? { passed: true, detail: 'None of the banned buzzwords appear in the copy.' }
          : {
              passed: false,
              detail: `${unique.length} hollow word${unique.length === 1 ? '' : 's'} in the copy: ${unique.slice(0, 4).map((w) => `"${w}"`).join(', ')}${unique.length > 4 ? '…' : ''}.`,
            };
      },
    },
    {
      id: 'headline_length',
      label: 'Headline is short enough to read at a glance',
      run: (html) => {
        const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(stripCode(html))?.[1];
        if (!h1) return null;
        const words = h1.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean);
        if (words.length === 0) return null;
        return words.length <= 12
          ? { passed: true, detail: `Headline is ${words.length} words.` }
          : { passed: false, detail: `Headline is ${words.length} words — over the 12 a visitor reads before deciding to scroll.` };
      },
    },
    {
      id: 'no_exclamations',
      label: 'No exclamation marks',
      run: (html) => {
        const text = visibleText(html);
        if (!text) return null;
        const count = (text.match(/!/g) ?? []).length;
        return count === 0
          ? { passed: true, detail: 'No exclamation marks — the claims carry themselves.' }
          : { passed: false, detail: `${count} exclamation mark${count === 1 ? '' : 's'} in the copy.` };
      },
    },
    {
      id: 'sentence_length',
      label: 'Sentences stay short',
      run: (html) => {
        const paras = Array.from(stripCode(html).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi))
          .map((m) => m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' ');
        const sentences = paras.split(/[.?!]+\s/).map((s) => s.trim()).filter((s) => s.length > 0);
        // Below a handful of sentences the average is noise, not a signal.
        if (sentences.length < 3) return null;
        const avg =
          sentences.reduce((n, s) => n + s.split(/\s+/).filter(Boolean).length, 0) / sentences.length;
        const rounded = Math.round(avg);
        return avg <= 22
          ? { passed: true, detail: `Body copy averages ${rounded} words per sentence.` }
          : { passed: false, detail: `Body copy averages ${rounded} words per sentence — long enough to skim past.` };
      },
    },
    {
      id: 'cta_label_quality',
      label: 'CTA labels say what you get',
      run: (html) => {
        const ctas = findCtas(html);
        if (ctas.length === 0) return null;
        const weak = ctas.filter((c) => WEAK_CTA_RE.test(c.text));
        return weak.length === 0
          ? { passed: true, detail: `Every CTA names an outcome (e.g. "${ctas[0].text}").` }
          : {
              passed: false,
              detail: `${weak.length} CTA${weak.length === 1 ? '' : 's'} label${weak.length === 1 ? 's' : ''} the mechanism, not the outcome: "${weak[0].text}".`,
            };
      },
    },
  ],
};
