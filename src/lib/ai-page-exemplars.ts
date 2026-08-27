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
  | 'warm_authority'
  | 'quiet_minimalism'
  | 'bauhaus_geometric'
  | 'brutalist_raw'
  | 'dieter_industrial'
  | 'zine_riso';

export interface StyleExemplar {
  label: string;
  mood: string;
  /**
   * Plain-language "who this is for", shown next to the label in the style
   * dropdown so a user can pick without knowing what "Bauhaus" means.
   *
   * Also read by the design-brief call when Style is left on "Auto": this and
   * `mood` are built into the style catalogue that call chooses from, so the
   * picker and Auto now read the same text rather than being two lists that
   * have to be kept in sync by hand.
   *
   * Write it as who the style suits, not as a list of industries to keyword
   * match — Auto is told to judge the buyer, and a bare vertical list invites
   * exactly the pattern-matching that put streetwear styling on a B2B service.
   */
  bestFor: string;
  /**
   * Hidden from "Auto" — the design-brief call never sees this style and can
   * never land on it, but a user can still choose it in the picker.
   *
   * For styles whose failure mode is embarrassing rather than merely bland: a
   * deliberately low-fidelity or novelty look applied to a business that needed
   * to seem trustworthy costs far more than a dull style does. Judgement lowers
   * the odds of that mistake; it does not lower its cost.
   */
  userPickOnly?: boolean;
  palette: { background: string; text: string; accent: string; secondaryAccent?: string };
  /**
   * The rest of the `:root` block the build prompt demands, pre-decided.
   *
   * SYSTEM_PROMPT requires a token block containing --bg-surface, --bg-elevated,
   * --border, --text-muted, --radius, --radius-lg, --radius-pill, --section-py,
   * --container and --shadow/--shadow-lg. Until these existed the exemplar
   * supplied only three colours, so the model invented the other ten on every
   * build — which is why the same style could come back rounded one run and
   * sharp the next. `palette` is what the style IS; `tokens` is the rest of the
   * system derived from it, so the two together are a complete :root.
   *
   * Values are CSS-ready strings. Keep them consistent with `geometry` below:
   * that field is the prose explanation of the same decision, and if the two
   * ever disagree the model gets contradictory instructions.
   */
  tokens: {
    surface: string;
    elevated: string;
    border: string;
    textMuted: string;
    radius: string;
    radiusLg: string;
    radiusPill: string;
    sectionPy: string;
    container: string;
    shadow: string;
    shadowLg: string;
  };
  typography: { headline: string; body: string };
  layoutNotes: string;
  /**
   * Corner radius, borders and shadows, in concrete numbers.
   *
   * Added after a `luxury_premium` build came back with hard edges nobody
   * asked for: seven of these twelve styles said nothing at all about corners,
   * so the model was free to invent geometry from mood alone — and a prompt
   * tail full of restraint rules makes "sharp" the obvious guess. Geometry is
   * the single most visible thing about a style and the easiest to state
   * exactly, so it is stated exactly.
   */
  geometry: string;
  /**
   * Actual sizes and weights, not just font families.
   *
   * The client's source library gives a type scale per style ("3-4 sizes,
   * weight contrast via bold not colour"); we were carrying only the family
   * names, which left hierarchy re-improvised on every build.
   */
  typeScale: string;
  /**
   * The two or three specific things that make this style itself.
   *
   * From the source file's central claim: "Swiss Editorial without numbered
   * sections and hairline rules is just generic minimal." Without these a
   * style collapses into the average of all the others.
   */
  signatureMoves: string;
  /** Explicit negatives. A style is defined as much by what it refuses. */
  avoid: string;
  /** Motion intensity this style should carry into the build prompt — CSS-only, no JS animation libraries. */
  motionStyle: string;
  htmlSnippet: string;
}

export const STYLE_EXEMPLARS: Record<StyleTag, StyleExemplar> = {
  minimal_editorial: {
    label: 'Minimal / Editorial',
    bestFor: 'Design studios, portfolios, boutique retail, artisan food & drink',
    mood: 'Airy, sophisticated, fashion-magazine restraint. Confidence through whitespace, not noise.',
    palette: { background: '#FAFAF7', text: '#1A1A1A', accent: '#C9A876', secondaryAccent: '#6B6B63' },
    typography: { headline: '"Playfair Display", Georgia, serif', body: '-apple-system, system-ui, sans-serif' },
    layoutNotes: 'Large type-scale jumps, thin hairline dividers, generous margins, asymmetric two-column hero, no card shadows or boxes.',
    motionStyle: 'Minimal — slow fade-up only, ~700-900ms staggered entrance, no bounce or scale. Motion should be felt, not noticed.',
    tokens: {
      surface: '#F2F1EC',
      elevated: '#FFFFFF',
      border: 'rgba(26,26,26,0.10)',
      textMuted: '#6B6B63',
      radius: '2px',
      radiusLg: '2px',
      radiusPill: '2px',
      sectionPy: 'clamp(96px, 12vw, 160px)',
      container: '1120px',
      shadow: 'none',
      shadowLg: 'none',
    },
    geometry: 'Sharp or near-sharp: 0-2px radius on everything, buttons included. Hairline 1px dividers instead of cards. No box-shadows at all — separation comes from whitespace.',
    typeScale: 'Big jumps, few steps: h1 clamp(3rem, 7vw, 5.5rem), h2 2rem, body 1.0625rem at a 65-70ch measure. Weight contrast via the serif\'s own weights, never via colour.',
    signatureMoves: 'Oversized section numerals (01, 02) set out in the margin; one full-bleed image breaking the text column; hairline rules between sections instead of cards.',
    avoid: 'Card shadows, coloured section backgrounds, icons as decoration, gradients, more than one accent colour.',
    htmlSnippet: '' // retired — replaced by SYSTEM_PROMPT layout rules, font library, and section variety blocks,
  },

  bold_maximalist: {
    label: 'Bold / Maximalist',
    bestFor: 'Gyms, streetwear, supplements, events, lead gen, info products',
    mood: 'Loud, energetic, impossible to scroll past. Big shapes, big type, big color contrast.',
    palette: { background: '#FFFFFF', text: '#0A0A0A', accent: '#FF3B30', secondaryAccent: '#FFD60A' },
    typography: { headline: '"Archivo Black", Inter, sans-serif', body: 'Inter, sans-serif' },
    layoutNotes: 'Oversized type, color-blocked sections, chunky pill buttons, slight card rotation, hard edges over soft shadows.',
    motionStyle: 'Energetic — punchy scale+fade entrance with a slight overshoot bounce, snappy ~400-500ms timing, confident hover transforms.',
    tokens: {
      surface: '#F2F2F2',
      elevated: '#FFFFFF',
      border: '#0A0A0A',
      textMuted: '#4A4A4A',
      radius: '0px',
      radiusLg: '0px',
      radiusPill: '999px',
      sectionPy: 'clamp(80px, 10vw, 140px)',
      container: '1280px',
      shadow: '6px 6px 0 #0A0A0A',
      shadowLg: '12px 12px 0 #0A0A0A',
    },
    geometry: 'Two extremes and nothing between: fully rounded pill buttons (border-radius: 999px) against hard 0px-radius colour blocks and cards. Any shadow is a hard offset (8px 8px 0) — never a soft blur.',
    typeScale: 'Extreme: h1 clamp(4rem, 12vw, 9rem) at 900 weight with -0.03em tracking; body stays a plain 1rem. The gap between them IS the design.',
    signatureMoves: 'One headline word knocked out in the accent colour at full-bleed scale; sections alternating solid colour edge to edge; an oversized repeated word or marquee as a divider.',
    avoid: 'Whitespace-led restraint, pastel colours, thin type weights, soft blur shadows, subtlety of any kind.',
    htmlSnippet: '' // retired — replaced by SYSTEM_PROMPT layout rules, font library, and section variety blocks,
  },

  corporate_trust: {
    label: 'Corporate / Trust',
    bestFor: 'Law firms, enterprise SaaS, compliance, HR software, B2B',
    mood: 'Professional, established, reassuring. Looks like it has a procurement department.',
    palette: { background: '#F4F6F8', text: '#101828', accent: '#2D7DD2', secondaryAccent: '#0F2A4A' },
    typography: { headline: 'Inter, sans-serif', body: 'Inter, sans-serif' },
    layoutNotes: 'Structured grid, icon-circle + text blocks, subtle card shadows, conservative spacing, no playful rotation or color noise.',
    motionStyle: 'Professional — smooth fade-up, moderate ~600ms timing, no overshoot or bounce. Reassuring, not flashy.',
    tokens: {
      surface: '#FFFFFF',
      elevated: '#FFFFFF',
      border: 'rgba(16,24,40,0.10)',
      textMuted: '#475467',
      radius: '6px',
      radiusLg: '8px',
      radiusPill: '999px',
      sectionPy: 'clamp(72px, 8vw, 112px)',
      container: '1200px',
      shadow: '0 1px 2px rgba(16,24,40,0.06)',
      shadowLg: '0 8px 24px rgba(16,24,40,0.10)',
    },
    geometry: 'Consistently soft: 8px radius on cards and inputs, 6px on buttons. Exactly two shadow depths — a resting 0 1px 2px and a raised 0 8px 24px on hover. Never sharp, never pill.',
    typeScale: 'Conservative four-step: h1 3rem / h2 1.875rem / h3 1.25rem / body 1rem. 600 weight for headings, 400 for body. Nothing above 3.5rem.',
    signatureMoves: 'A named-client logo strip directly under the hero; a three-column outcome grid carrying real numbers; a quiet stat band on the brand navy.',
    avoid: 'Rotation, pill buttons, neon accents, playful illustration, more than two shadow depths, anything that looks improvised.',
    htmlSnippet: '' // retired — replaced by SYSTEM_PROMPT layout rules, font library, and section variety blocks,
  },

  playful_funky: {
    label: 'Playful / Funky',
    bestFor: 'Consumer apps, food delivery, e-learning, products for kids',
    mood: 'Quirky, approachable, a little weird on purpose. Feels handmade, not corporate.',
    palette: { background: '#FFF8F0', text: '#2B2B2B', accent: '#FF6F91', secondaryAccent: '#6FCF97' },
    typography: { headline: '"Poppins", Quicksand, sans-serif', body: '"Poppins", system-ui, sans-serif' },
    layoutNotes: 'Blobby border-radius shapes, rotated sticky-note cards, pill buttons, mixed pastel/bright accents, asymmetric tilt.',
    motionStyle: 'Bouncy — overshoot entrance, gentle floating blob loop, playful lift on hover. The page should feel alive, never static.',
    tokens: {
      surface: '#FFFFFF',
      elevated: '#FFFFFF',
      border: 'rgba(43,43,43,0.12)',
      textMuted: '#6E6259',
      radius: '16px',
      radiusLg: '28px',
      radiusPill: '999px',
      sectionPy: 'clamp(72px, 9vw, 120px)',
      container: '1160px',
      shadow: '0 4px 0 rgba(43,43,43,0.12)',
      shadowLg: '0 10px 30px rgba(255,111,145,0.22)',
    },
    geometry: 'Very round everywhere: 24-32px on cards, full pills (999px) on buttons and tags, and the occasional organic blob radius (e.g. 60% 40% 55% 45%). No hard corners anywhere on the page.',
    typeScale: 'Chunky and friendly: h1 clamp(2.75rem, 6vw, 4.5rem) at 700, h2 2rem, body 1.0625rem at a generous 1.7 line-height.',
    signatureMoves: 'Cards rotated 1-3deg like stuck notes; an organic blob shape behind the hero image; a hand-drawn underline or circle on the key headline word.',
    avoid: 'Sharp corners, greyscale palettes, serif headlines, corporate stock photography, dense text blocks.',
    htmlSnippet: '' // retired — replaced by SYSTEM_PROMPT layout rules, font library, and section variety blocks,
  },

  luxury_premium: {
    label: 'Luxury / Premium',
    bestFor: 'Luxury goods, premium hotels, fine dining, jewellery',
    mood: 'Exclusive, refined, quiet confidence. Every element earns its place.',
    palette: { background: '#0B0B0B', text: '#F5F0E6', accent: '#C9A227' },
    typography: { headline: '"Cormorant", "Playfair Display", serif', body: '"Helvetica Neue", Arial, sans-serif' },
    layoutNotes: 'Centered symmetric composition, thin gold hairlines, very low contrast hover transitions, extreme whitespace, no shadows or gradients beyond a single subtle vignette.',
    motionStyle: 'Extremely subtle — slow fade only (~1.1s), a faint upward drift at most, no bounce or scale ever. Restraint is the point.',
    tokens: {
      surface: '#121212',
      elevated: '#181818',
      border: 'rgba(201,162,39,0.28)',
      textMuted: '#A39C8E',
      radius: '0px',
      radiusLg: '0px',
      radiusPill: '0px',
      sectionPy: 'clamp(112px, 14vw, 200px)',
      container: '1080px',
      shadow: 'none',
      shadowLg: 'none',
    },
    geometry: 'Sharp. 0px radius on cards, images and buttons — a rounded corner reads as cheap in this style. Separation comes from 1px hairline rules in the accent gold at low opacity. No shadows, ever.',
    typeScale: 'Two sizes and a whisper: h1 clamp(3rem, 6vw, 5rem) in the serif at 300-400 weight with 0.02em tracking; body 0.9375rem. Eyebrows in letter-spaced small caps at 0.75rem / 0.2em.',
    signatureMoves: 'A letter-spaced small-caps eyebrow above the headline with a single gold hairline under it; one full-bleed image given an entire viewport with nothing else on it; a centred symmetric hero.',
    avoid: 'Rounded corners, drop shadows, gradients, bright saturated accents, crowded sections, more than one CTA style.',
    htmlSnippet: '' // retired — replaced by SYSTEM_PROMPT layout rules, font library, and section variety blocks,
  },

  warm_clinical: {
    label: 'Warm / Clinical',
    bestFor: 'Healthcare, wellness, therapy, clinics, nutrition',
    mood: 'Clean, human, and reassuring. Feels like a trusted practitioner — approachable without being casual, professional without being cold.',
    palette: { background: '#F9FAFB', text: '#1A2332', accent: '#0EA5A0' },
    typography: { headline: '"DM Sans", sans-serif', body: '"Inter", system-ui, sans-serif' },
    layoutNotes: 'Generous whitespace, soft teal or sage accents, rounded cards, human photography placeholders, trust badges prominent near CTAs.',
    motionStyle: 'Gentle — soft fade-up at ~600ms, no bounce or overshoot. Motion should feel calm and reassuring, never energetic.',
    tokens: {
      surface: '#FFFFFF',
      elevated: '#FFFFFF',
      border: 'rgba(26,35,50,0.08)',
      textMuted: '#5A6B7B',
      radius: '12px',
      radiusLg: '16px',
      radiusPill: '999px',
      sectionPy: 'clamp(72px, 8vw, 112px)',
      container: '1160px',
      shadow: '0 4px 16px rgba(26,35,50,0.06)',
      shadowLg: '0 12px 32px rgba(26,35,50,0.10)',
    },
    geometry: 'Generously rounded and soft: 16px on cards, 12px on inputs, 999px pill buttons. One soft diffuse shadow (0 4px 16px rgba(0,0,0,.06)). Nothing sharp — sharpness reads as clinical in the cold sense.',
    typeScale: 'Calm and readable: h1 clamp(2.5rem, 5vw, 3.5rem) at 600, h2 1.75rem, body 1.0625rem at 1.7 line-height. Nothing shouty.',
    signatureMoves: 'A soft-cornered card pairing the practitioner photo with their credential; a reassurance line directly under every CTA; trust signals as quiet inline text rather than badge logos.',
    avoid: 'Sharp corners, dark backgrounds, red accents, dense clinical tables, stock photography of pills or lab equipment.',
    htmlSnippet: '',
  },

  friendly_local: {
    label: 'Friendly / Local',
    bestFor: 'Local services, trades, community businesses, nonprofits',
    mood: 'Warm, community-rooted, and approachable. Feels like a real person, not a corporation. Trustworthy through personality, not formality.',
    palette: { background: '#FFFBF5', text: '#2C1810', accent: '#E8650A' },
    typography: { headline: '"Poppins", sans-serif', body: '"Inter", system-ui, sans-serif' },
    layoutNotes: 'Warm amber/terracotta accents, rounded corners, friendly photography, clear contact info above fold, Google Maps embed or service area mention.',
    motionStyle: 'Warm and simple — gentle fade-up, no complexity. The page should feel welcoming, not slick.',
    tokens: {
      surface: '#FFFFFF',
      elevated: '#FFFFFF',
      border: 'rgba(44,24,16,0.10)',
      textMuted: '#6B5545',
      radius: '12px',
      radiusLg: '16px',
      radiusPill: '999px',
      sectionPy: 'clamp(64px, 8vw, 104px)',
      container: '1120px',
      shadow: '0 3px 12px rgba(44,24,16,0.08)',
      shadowLg: '0 10px 28px rgba(44,24,16,0.12)',
    },
    geometry: 'Rounded and approachable: 12-16px on cards and images, 999px pills on buttons. A single soft shadow. Nothing sharp-edged — sharpness reads as corporate here.',
    typeScale: 'Approachable: h1 clamp(2.5rem, 5.5vw, 3.75rem) at 700, h2 1.75rem, body 1.0625rem. The phone number is set at h3 scale — it is a headline in this style.',
    signatureMoves: 'The phone number as a headline-scale element in the hero; a real photograph of the actual team or shopfront; the service area written as a plain sentence rather than a map widget.',
    avoid: 'Sharp corners, dark backgrounds, corporate stock photography, jargon, sterile grey palettes.',
    htmlSnippet: '',
  },

  warm_authority: {
    label: 'Warm / Authority',
    bestFor: 'Education, coaching, real estate, financial advisory',
    mood: 'Trustworthy and expert, but human and approachable. Feels like a knowledgeable mentor, not a faceless institution. Confidence through clarity.',
    palette: { background: '#FAFAF7', text: '#1C2B3A', accent: '#2563EB' },
    typography: { headline: '"Fraunces", serif', body: '"DM Sans", sans-serif' },
    layoutNotes: 'Editorial serif headlines for authority, clean sans body for readability, credential badges and testimonials prominent, warm but structured layout.',
    motionStyle: 'Measured — smooth fade-up at ~650ms, slight stagger on lists and cards. Purposeful, not flashy.',
    tokens: {
      surface: '#FFFFFF',
      elevated: '#FFFFFF',
      border: 'rgba(28,43,58,0.10)',
      textMuted: '#56657A',
      radius: '8px',
      radiusLg: '12px',
      radiusPill: '999px',
      sectionPy: 'clamp(80px, 9vw, 128px)',
      container: '1140px',
      shadow: '0 2px 8px rgba(28,43,58,0.06)',
      shadowLg: '0 10px 28px rgba(28,43,58,0.10)',
    },
    geometry: 'Moderate and consistent: 10-12px on cards, 8px on buttons and inputs. Full-bleed images stay sharp-edged against the rounded content cards. One subtle shadow at rest.',
    typeScale: 'Editorial but restrained: h1 clamp(2.75rem, 5.5vw, 4rem) in the serif, h2 2rem, body 1.0625rem at 1.7 line-height on a 68ch measure.',
    signatureMoves: 'A credential line set under the name in the hero; a pull quote at 1.5x body scale between sections; a numbered process with the numeral set large in the margin.',
    avoid: 'Neon accents, playful rotation, dark backgrounds, icon-per-bullet lists, more than one serif family.',
    htmlSnippet: '',
  },

  technical_dark: {
    label: 'Technical / Dark (Dev Tool)',
    bestFor: 'Dev tools, AI products, APIs, infrastructure, technical B2B',
    mood: 'Modern dev-tool aesthetic, dark mode by default, precise and a little nerdy.',
    palette: { background: '#0D1117', text: '#E6EDF3', accent: '#58A6FF', secondaryAccent: '#3FB950' },
    typography: { headline: 'Inter, sans-serif', body: 'Inter, sans-serif' },
    layoutNotes: 'Grid-based, terminal-window motif, monospace accents for labels/code, subtle accent-color glow on key elements, hairline borders instead of shadows.',
    motionStyle: 'Techy — quick fade-up (~500ms), pulsing status dot, blinking terminal cursor. Precise, not bouncy.',
    tokens: {
      surface: '#161B22',
      elevated: '#1C2129',
      border: '#30363D',
      textMuted: '#8B949E',
      radius: '6px',
      radiusLg: '6px',
      radiusPill: '999px',
      sectionPy: 'clamp(72px, 8vw, 120px)',
      container: '1200px',
      shadow: 'none',
      shadowLg: '0 0 24px rgba(88,166,255,0.18)',
    },
    geometry: 'Tight and uniform: 4-6px radius on cards, inputs, buttons and code blocks alike. Definition comes from 1px hairline borders in a lighter surface tone, never from shadows.',
    typeScale: 'Compact and precise: h1 clamp(2.5rem, 5vw, 3.75rem) at 600 with -0.02em tracking, h2 1.75rem, body 0.9375rem. Labels and metadata in monospace at 0.75rem / 0.1em uppercase.',
    signatureMoves: 'A terminal or code block as the hero visual; monospace uppercase labels above each section; a hairline border grid with a faint accent glow on exactly one active element.',
    avoid: 'Light backgrounds, soft shadows, rounded pills, pastel accents, illustration, marketing gloss.',
    htmlSnippet: '' // retired — replaced by SYSTEM_PROMPT layout rules, font library, and section variety blocks,
  },
  // ── Added from the client's design-styles reference (2026-08-26) ──────────
  // Three schools our nine did not cover: Japanese quiet minimalism, structural
  // modernism, and brutalist web. Deliberately NOT added from that same file:
  // Swiss Editorial (a duplicate of minimal_editorial), Field.io motion poetics
  // (needs WebGL and heavy JS, which the no-external-JS lock forbids), and
  // Sagmeister-experimental / Y2K (both measurably hurt conversion on lead-gen
  // pages, which is what this product builds).
  //
  // Typefaces here are restricted to the Google Fonts in ai-page-fonts.ts —
  // the reference file names commercial faces (Tsukushi Mincho, Söhne,
  // PP Neue Montreal) we cannot serve.

  quiet_minimalism: {
    label: 'Quiet Minimalism',
    bestFor: 'Skincare, tea & ceramics, craft goods, product reveals, retreats',
    mood: 'Meditative, reverent, deliberately un-full. Confidence through emptiness — the Kenya Hara / MUJI lineage.',
    palette: { background: '#FBFAF8', text: '#2A2724', accent: '#8A8378' },
    typography: { headline: '"Cormorant Garamond", Georgia, serif', body: '"DM Sans", system-ui, sans-serif' },
    layoutNotes: 'Roughly 70% negative space. Small content islands with precise vertical rhythm. No more than two type sizes per section. Never pure black — warm ink instead. Captions smaller than feels comfortable. A single object framed by emptiness rather than a busy composition.',
    motionStyle: 'Almost none — a slow 900ms fade on entrance and nothing else. Motion should be invisible.',
    tokens: {
      surface: '#F5F3EF',
      elevated: '#FBFAF8',
      border: 'rgba(42,39,36,0.08)',
      textMuted: '#8A8378',
      radius: '0px',
      radiusLg: '2px',
      radiusPill: '2px',
      sectionPy: 'clamp(120px, 16vw, 224px)',
      container: '960px',
      shadow: 'none',
      shadowLg: 'none',
    },
    geometry: 'Sharp to barely-there: 0-2px radius. Nothing is a card. No borders, no shadows — the only separation on the page is space.',
    typeScale: 'Two sizes per section, maximum. h1 clamp(2rem, 4vw, 3rem) at 300 weight — smaller than instinct says. Body 0.9375rem. Captions 0.75rem in a lighter ink.',
    signatureMoves: 'A single object or image given an entire screen with nothing beside it; captions set smaller than feels comfortable; one section left almost entirely empty on purpose.',
    avoid: 'Saturated accents, pure black, more than two type sizes per section, cards, borders, shadows, any section that feels full.',
    htmlSnippet: '',
  },

  bauhaus_geometric: {
    label: 'Bauhaus / Geometric',
    bestFor: 'Arts programming, festivals, cultural institutions, bold campaigns',
    mood: 'Primary, architectural, confident. Shapes as composition, not decoration — the Mueller-Brockmann / Paula Scher lineage.',
    palette: { background: '#FFFFFF', text: '#111111', accent: '#E5322D', secondaryAccent: '#0B44E0' },
    typography: { headline: '"Poppins", Futura, sans-serif', body: '"Inter", system-ui, sans-serif' },
    layoutNotes: 'Circles, squares and hard diagonals as the primary structural elements, not background ornament. Type set as shape — large scale, tight tracking, occasionally rotated. Flat colour blocks in primary red / blue / yellow. No gradients, no 3D, no drop shadows. Illustration and shape over photography.',
    motionStyle: 'Deliberate and mechanical — shapes slide in on a straight line, 500ms, no easing overshoot, no bounce.',
    tokens: {
      surface: '#F2F2F2',
      elevated: '#FFFFFF',
      border: '#111111',
      textMuted: '#555555',
      radius: '0px',
      radiusLg: '0px',
      radiusPill: '999px',
      sectionPy: 'clamp(80px, 10vw, 140px)',
      container: '1240px',
      shadow: 'none',
      shadowLg: 'none',
    },
    geometry: 'Absolute: either 0px hard corners or perfect 50% circles, and nothing in between. No shadows, no gradients. A circle here is a composition element, not a rounded box.',
    typeScale: 'Type as shape: h1 clamp(3.5rem, 10vw, 8rem) at 700 with -0.02em tracking, sometimes rotated 90deg. Body a plain 1rem. No intermediate sizes.',
    signatureMoves: 'A giant primary-colour circle anchoring the hero composition; type rotated 90deg down a section edge; hard diagonal colour splits between sections.',
    avoid: 'Photography, gradients, 3D or perspective, drop shadows, rounded boxes, pastel or muted colours.',
    htmlSnippet: '',
  },

  brutalist_raw: {
    label: 'Brutalist / Raw',
    bestFor: 'Tools for thought, indie developer products, text-forward publications',
    mood: 'Raw, direct, anti-polish. Reads as a document rather than a designed page — the Are.na / Bloomberg-terminal lineage.',
    palette: { background: '#FFFFFF', text: '#000000', accent: '#0000EE' },
    typography: { headline: '"JetBrains Mono", ui-monospace, monospace', body: '"Inter", system-ui, sans-serif' },
    layoutNotes: 'Dense text, visible 1px borders, horizontal rules, real tables. Headings at near-body scale rather than display-dramatic. Zero border-radius, no shadows, no gradients. Link-blue accent used only on links. Long scroll, no hero apparatus.',
    motionStyle: 'None. No entrance animation at all — the style is the absence of polish. Hover states are instant colour swaps.',
    tokens: {
      surface: '#F6F6F6',
      elevated: '#FFFFFF',
      border: '#000000',
      textMuted: '#444444',
      radius: '0px',
      radiusLg: '0px',
      radiusPill: '0px',
      sectionPy: '40px',
      container: '760px',
      shadow: 'none',
      shadowLg: 'none',
    },
    geometry: 'Zero radius everywhere, without exception. Visible 1px solid borders around tables, inputs and buttons. No shadows, no gradients.',
    typeScale: 'Near-flat: h1 1.5rem, h2 1.25rem, body 1rem. Headings are bold, not big. Nothing display-scale anywhere on the page.',
    signatureMoves: 'A real <table> presenting the comparison or pricing; visible 1px borders around every block; a plain underlined link list where another style would use buttons.',
    avoid: 'Animation, rounded corners, shadows, gradients, hero apparatus, display-scale headings, any attempt to look polished.',
    htmlSnippet: '',
  },

  // ── User-pick-only styles (2026-08-26) ───────────────────────────────────
  // Marked `userPickOnly` below, which keeps them out of the style_tag union
  // and the style catalogue the design-brief call reads, so "Auto" can never
  // land on them — while the picker still offers them to a user who asks.
  // They are here because a user who wants them should be able to ask, not
  // because Auto should ever land one on a plumber. The exclusion is now
  // derived from that flag rather than from a hand-maintained list, so there
  // is no longer a second place to keep in sync.

  dieter_industrial: {
    label: 'Industrial / Functional',
    userPickOnly: true,
    bestFor: 'Hardware, tools, furniture, physical products, understated engineering brands',
    mood: 'Useful, honest, unobtrusive. Nothing decorative survives — the Braun / Vitsoe lineage. Confidence through function, never through persuasion.',
    palette: { background: '#F2F2F0', text: '#1C1C1C', accent: '#D8451E', secondaryAccent: '#7A7A78' },
    tokens: {
      surface: '#FFFFFF',
      elevated: '#FFFFFF',
      border: 'rgba(28,28,28,0.14)',
      textMuted: '#6E6E6B',
      radius: '2px',
      radiusLg: '2px',
      radiusPill: '2px',
      sectionPy: 'clamp(80px, 9vw, 128px)',
      container: '1080px',
      shadow: 'none',
      shadowLg: 'none',
    },
    typography: { headline: 'Inter, "Helvetica Neue", sans-serif', body: 'Inter, system-ui, sans-serif' },
    layoutNotes: 'Product-first. Generous whitespace framing a single hero object. Labels and specs in understated small type. Monochrome grey scale with exactly one functional accent. Nothing on the page that does not do a job.',
    geometry: 'Near-sharp: 2px radius on everything, buttons included. Definition comes from 1px hairline rules separating columns, never from shadows. No shadows at all.',
    typeScale: 'Two sizes and one weight step: h1 clamp(2.25rem, 4vw, 3.25rem) at 500, h2 1.5rem at 500, body 1rem at 400. Deliberately undramatic — the product is the hero, not the type.',
    signatureMoves: 'A single product given an entire frame against flat ground; a spec table set as a quiet composition rather than a data dump; hairline grid rules between columns; the accent colour used exactly once per screen, where it means something.',
    avoid: 'Decorative flourishes, marketing bombast, coloured section backgrounds, gradients, drop shadows, icons as ornament, more than one accent use per screen.',
    motionStyle: 'Almost none — a 300ms fade on entrance and instant, honest hover states. Motion is feedback, never decoration.',
    htmlSnippet: '',
  },

  zine_riso: {
    label: 'Zine / Risograph',
    userPickOnly: true,
    bestFor: 'Music, culture, indie brands, merch drops, events, "made by humans" positioning',
    mood: 'Handmade, immediate, low-fidelity on purpose. Looks printed in someone\'s kitchen — the independent zine / Rough Trade poster lineage.',
    palette: { background: '#F4F1E8', text: '#1B1B1B', accent: '#FF4D8D', secondaryAccent: '#0E7C7B' },
    tokens: {
      surface: '#EDE8DA',
      elevated: '#FFFFFF',
      border: '#1B1B1B',
      textMuted: '#5C5A52',
      radius: '0px',
      radiusLg: '0px',
      radiusPill: '0px',
      sectionPy: 'clamp(64px, 8vw, 112px)',
      container: '1080px',
      shadow: '4px 4px 0 #1B1B1B',
      shadowLg: '8px 8px 0 #FF4D8D',
    },
    typography: { headline: '"Bricolage Grotesque", Impact, sans-serif', body: '"Space Grotesk", system-ui, sans-serif' },
    layoutNotes: 'Collage-like and slightly off-kilter — hand-placed rather than grid-perfect. Two or three spot colours only, in a riso palette (flo-pink, teal, navy, yellow). Slight misregistration where blocks overlap is the point, not a mistake. Photographs treated with halftone or duotone, never left clean.',
    geometry: 'Zero radius throughout — this is printed, not rendered. Hard 2px black borders and hard offset shadows (4px 4px 0) in a spot colour. No blur and no soft edges anywhere on the page.',
    typeScale: 'Loud and uneven: h1 clamp(3rem, 9vw, 6.5rem) at 800, usually all-caps and tightly tracked; h2 1.75rem; body 1rem. The sizes deliberately do not form a neat scale.',
    signatureMoves: 'A halftone dot texture laid over an image (CSS repeating-radial-gradient with mix-blend-mode); spot-colour overprint where two blocks overlap; elements rotated 1-2deg as if hand-placed; typewriter-style captions under photographs.',
    avoid: 'Pixel-perfect alignment, gradients, soft shadows, glossy effects, rounded corners, corporate stock photography, anything that looks expensive.',
    motionStyle: 'Blunt — no easing curves, instant hover colour flips, at most a 1-2deg rotate on hover. Nothing smooth; smoothness reads as digital, and this is meant to read as printed.',
    htmlSnippet: '',
  },
};

/**
 * The style picker's options, in the order the dropdown shows them.
 *
 * Derived from STYLE_EXEMPLARS rather than hand-listed so a style added above
 * cannot be missing from the UI (that drift is exactly what happened to the
 * vertical list before ai-page-verticals.ts existed).
 *
 * `null` in the UI means "Auto" — the design-brief call picks, which is the
 * behaviour every page has had until now and stays the default.
 */
export const STYLE_TAG_VALUES = Object.keys(STYLE_EXEMPLARS) as StyleTag[];

export const STYLE_OPTIONS: { value: StyleTag; label: string; mood: string; bestFor: string }[] =
  STYLE_TAG_VALUES.map((value) => ({
    value,
    label: STYLE_EXEMPLARS[value].label,
    mood: STYLE_EXEMPLARS[value].mood,
    bestFor: STYLE_EXEMPLARS[value].bestFor,
  }));

/**
 * The styles "Auto" is allowed to choose from — everything except the
 * `userPickOnly` ones.
 *
 * The design-brief call builds both its style_tag union and its style
 * catalogue from this, so a style is hidden from Auto by setting one flag on
 * the exemplar and nowhere else.
 */
export const AUTO_STYLE_TAGS: StyleTag[] = STYLE_TAG_VALUES.filter(
  (tag) => !STYLE_EXEMPLARS[tag].userPickOnly,
);

export function isStyleTag(value: unknown): value is StyleTag {
  return typeof value === 'string' && value in STYLE_EXEMPLARS;
}
