/**
 * Hardcoded style exemplar library for AI page generation.
 *
 * Consumed by the design-brief step: the brief classifies a prompt's freeform
 * wording ("funky", "sleek", "corporate"...) into one of the StyleTag values
 * below, then code does a plain lookup — STYLE_EXEMPLARS[tag] — to pull 1-2
 * reference snippets into the `build` prompt for taste calibration. No search,
 * no embeddings. See docs/decisions/ai-page-generation-quality.md.
 *
 * Each snippet is hero + one supporting section only — enough to demonstrate
 * spacing, type scale, color usage and hierarchy for that style. They are NOT
 * templates to copy structurally, and they have NOT been visually verified by
 * rendering in a browser (no rendering tool in the authoring environment).
 * Open the matching file in docs/decisions/ai-page-exemplars/<tag>.html before
 * wiring any of these into a live prompt — fix anything that looks off there,
 * not by guessing again from the code.
 *
 * NOT JUST STRUCTURE — CONTENT TOO. Every literal string in these snippets
 * (headlines, names, chip/badge labels like "10K+ SOLD" or "AWS", the
 * rotating terminal messages) is a craft placeholder for THIS demo business
 * only. Whoever wires STYLE_EXEMPLARS into the `build` prompt MUST instruct
 * Claude to regenerate all such text from the real business being built —
 * never echo exemplar text verbatim onto an unrelated business (e.g. a
 * bakery page must not end up with "React" / "AWS" chips just because
 * technical_dark was the closest style match). See "Exemplars are not page
 * templates, and decorative content is not literal" in
 * docs/decisions/ai-page-generation-quality.md.
 *
 * This is a closed, hand-curated list — not a knowledge base. Add new styles
 * here as code, reviewed like any other prompt change.
 */

export type StyleTag =
  | 'minimal_editorial'
  | 'bold_maximalist'
  | 'corporate_trust'
  | 'playful_funky'
  | 'luxury_premium'
  | 'technical_dark'
  | 'warm_clinical'
  | 'friendly_local'
  | 'warm_authority';

export interface StyleExemplar {
  label: string;
  mood: string;
  palette: { background: string; text: string; accent: string; secondaryAccent?: string };
  typography: { headline: string; body: string };
  layoutNotes: string;
  /** Motion intensity this style should carry into the build prompt — CSS-only, no JS animation libraries. */
  motionStyle: string;
  htmlSnippet: string;
}

export const STYLE_EXEMPLARS: Record<StyleTag, StyleExemplar> = {
  minimal_editorial: {
    label: 'Minimal / Editorial',
    mood: 'Airy, sophisticated, fashion-magazine restraint. Confidence through whitespace, not noise.',
    palette: { background: '#FAFAF7', text: '#1A1A1A', accent: '#C9A876', secondaryAccent: '#6B6B63' },
    typography: { headline: '"Playfair Display", Georgia, serif', body: '-apple-system, system-ui, sans-serif' },
    layoutNotes: 'Large type-scale jumps, thin hairline dividers, generous margins, asymmetric two-column hero, no card shadows or boxes.',
    motionStyle: 'Minimal — slow fade-up only, ~700-900ms staggered entrance, no bounce or scale. Motion should be felt, not noticed.',
    htmlSnippet: '' // retired — replaced by SYSTEM_PROMPT layout rules, font library, and section variety blocks,
  },

  bold_maximalist: {
    label: 'Bold / Maximalist',
    mood: 'Loud, energetic, impossible to scroll past. Big shapes, big type, big color contrast.',
    palette: { background: '#FFFFFF', text: '#0A0A0A', accent: '#FF3B30', secondaryAccent: '#FFD60A' },
    typography: { headline: '"Archivo Black", Inter, sans-serif', body: 'Inter, sans-serif' },
    layoutNotes: 'Oversized type, color-blocked sections, chunky pill buttons, slight card rotation, hard edges over soft shadows.',
    motionStyle: 'Energetic — punchy scale+fade entrance with a slight overshoot bounce, snappy ~400-500ms timing, confident hover transforms.',
    htmlSnippet: '' // retired — replaced by SYSTEM_PROMPT layout rules, font library, and section variety blocks,
  },

  corporate_trust: {
    label: 'Corporate / Trust',
    mood: 'Professional, established, reassuring. Looks like it has a procurement department.',
    palette: { background: '#F4F6F8', text: '#101828', accent: '#2D7DD2', secondaryAccent: '#0F2A4A' },
    typography: { headline: 'Inter, sans-serif', body: 'Inter, sans-serif' },
    layoutNotes: 'Structured grid, icon-circle + text blocks, subtle card shadows, conservative spacing, no playful rotation or color noise.',
    motionStyle: 'Professional — smooth fade-up, moderate ~600ms timing, no overshoot or bounce. Reassuring, not flashy.',
    htmlSnippet: '' // retired — replaced by SYSTEM_PROMPT layout rules, font library, and section variety blocks,
  },

  playful_funky: {
    label: 'Playful / Funky',
    mood: 'Quirky, approachable, a little weird on purpose. Feels handmade, not corporate.',
    palette: { background: '#FFF8F0', text: '#2B2B2B', accent: '#FF6F91', secondaryAccent: '#6FCF97' },
    typography: { headline: '"Poppins", Quicksand, sans-serif', body: '"Poppins", system-ui, sans-serif' },
    layoutNotes: 'Blobby border-radius shapes, rotated sticky-note cards, pill buttons, mixed pastel/bright accents, asymmetric tilt.',
    motionStyle: 'Bouncy — overshoot entrance, gentle floating blob loop, playful lift on hover. The page should feel alive, never static.',
    htmlSnippet: '' // retired — replaced by SYSTEM_PROMPT layout rules, font library, and section variety blocks,
  },

  luxury_premium: {
    label: 'Luxury / Premium',
    mood: 'Exclusive, refined, quiet confidence. Every element earns its place.',
    palette: { background: '#0B0B0B', text: '#F5F0E6', accent: '#C9A227' },
    typography: { headline: '"Cormorant", "Playfair Display", serif', body: '"Helvetica Neue", Arial, sans-serif' },
    layoutNotes: 'Centered symmetric composition, thin gold hairlines, very low contrast hover transitions, extreme whitespace, no shadows or gradients beyond a single subtle vignette.',
    motionStyle: 'Extremely subtle — slow fade only (~1.1s), a faint upward drift at most, no bounce or scale ever. Restraint is the point.',
    htmlSnippet: '' // retired — replaced by SYSTEM_PROMPT layout rules, font library, and section variety blocks,
  },

  warm_clinical: {
    label: 'Warm / Clinical',
    mood: 'Clean, human, and reassuring. Feels like a trusted practitioner — approachable without being casual, professional without being cold.',
    palette: { background: '#F9FAFB', text: '#1A2332', accent: '#0EA5A0' },
    typography: { headline: '"DM Sans", sans-serif', body: '"Inter", system-ui, sans-serif' },
    layoutNotes: 'Generous whitespace, soft teal or sage accents, rounded cards, human photography placeholders, trust badges prominent near CTAs.',
    motionStyle: 'Gentle — soft fade-up at ~600ms, no bounce or overshoot. Motion should feel calm and reassuring, never energetic.',
    htmlSnippet: '',
  },

  friendly_local: {
    label: 'Friendly / Local',
    mood: 'Warm, community-rooted, and approachable. Feels like a real person, not a corporation. Trustworthy through personality, not formality.',
    palette: { background: '#FFFBF5', text: '#2C1810', accent: '#E8650A' },
    typography: { headline: '"Poppins", sans-serif', body: '"Inter", system-ui, sans-serif' },
    layoutNotes: 'Warm amber/terracotta accents, rounded corners, friendly photography, clear contact info above fold, Google Maps embed or service area mention.',
    motionStyle: 'Warm and simple — gentle fade-up, no complexity. The page should feel welcoming, not slick.',
    htmlSnippet: '',
  },

  warm_authority: {
    label: 'Warm / Authority',
    mood: 'Trustworthy and expert, but human and approachable. Feels like a knowledgeable mentor, not a faceless institution. Confidence through clarity.',
    palette: { background: '#FAFAF7', text: '#1C2B3A', accent: '#2563EB' },
    typography: { headline: '"Fraunces", serif', body: '"DM Sans", sans-serif' },
    layoutNotes: 'Editorial serif headlines for authority, clean sans body for readability, credential badges and testimonials prominent, warm but structured layout.',
    motionStyle: 'Measured — smooth fade-up at ~650ms, slight stagger on lists and cards. Purposeful, not flashy.',
    htmlSnippet: '',
  },

  technical_dark: {
    label: 'Technical / Dark (Dev Tool)',
    mood: 'Modern dev-tool aesthetic, dark mode by default, precise and a little nerdy.',
    palette: { background: '#0D1117', text: '#E6EDF3', accent: '#58A6FF', secondaryAccent: '#3FB950' },
    typography: { headline: 'Inter, sans-serif', body: 'Inter, sans-serif' },
    layoutNotes: 'Grid-based, terminal-window motif, monospace accents for labels/code, subtle accent-color glow on key elements, hairline borders instead of shadows.',
    motionStyle: 'Techy — quick fade-up (~500ms), pulsing status dot, blinking terminal cursor. Precise, not bouncy.',
    htmlSnippet: '' // retired — replaced by SYSTEM_PROMPT layout rules, font library, and section variety blocks,
  },
};
