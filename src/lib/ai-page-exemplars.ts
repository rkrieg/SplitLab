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
    htmlSnippet: `
<style>
  @keyframes meFadeUp { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:translateY(0); } }
  .me-hero { background:#FAFAF7; color:#1A1A1A; padding:120px 8vw 100px; display:grid; grid-template-columns:1.1fr 0.9fr; gap:60px; align-items:center; }
  .me-hero .eyebrow { font:13px/1 -apple-system,system-ui,sans-serif; letter-spacing:.18em; text-transform:uppercase; color:#C9A876; margin-bottom:24px; opacity:0; animation:meFadeUp .8s ease forwards; animation-delay:.05s; }
  .me-hero h1 { font:64px/1.05 "Playfair Display",Georgia,serif; font-weight:500; margin:0 0 28px; max-width:11ch; opacity:0; animation:meFadeUp .8s ease forwards; animation-delay:.15s; }
  .me-hero p { font:18px/1.6 -apple-system,system-ui,sans-serif; color:#6B6B63; max-width:34ch; margin:0 0 36px; opacity:0; animation:meFadeUp .8s ease forwards; animation-delay:.3s; }
  .me-hero .cta { display:inline-block; font:14px -apple-system,system-ui,sans-serif; letter-spacing:.04em; color:#1A1A1A; text-decoration:none; padding-bottom:6px; border-bottom:1px solid #1A1A1A; transition:border-color .2s,color .2s; opacity:0; animation:meFadeUp .8s ease forwards; animation-delay:.45s; }
  .me-hero .cta:hover { border-color:#C9A876; color:#C9A876; }
  .me-hero .visual { aspect-ratio:4/5; background:linear-gradient(160deg,#EFEAE0,#DCD3C2); opacity:0; animation:meFadeUp 1s ease forwards; animation-delay:.2s; }
  .me-benefits { background:#FAFAF7; padding:0 8vw 120px; border-top:1px solid #E4DFD3; }
  .me-benefits .row { display:grid; grid-template-columns:repeat(3,1fr); gap:48px; padding-top:64px; }
  .me-benefits .item { border-top:1px solid #1A1A1A; padding-top:20px; opacity:0; animation:meFadeUp .7s ease forwards; }
  .me-benefits .item:nth-child(1) { animation-delay:.1s; }
  .me-benefits .item:nth-child(2) { animation-delay:.2s; }
  .me-benefits .item:nth-child(3) { animation-delay:.3s; }
  .me-benefits .item .num { font:13px -apple-system,system-ui,sans-serif; color:#C9A876; letter-spacing:.1em; }
  .me-benefits .item h3 { font:22px/1.3 "Playfair Display",Georgia,serif; font-weight:500; margin:14px 0 10px; }
  .me-benefits .item p { font:15px/1.6 -apple-system,system-ui,sans-serif; color:#6B6B63; margin:0; }
</style>
<section class="me-hero">
  <div>
    <div class="eyebrow">Est. 2019 — Atelier Studio</div>
    <h1>Considered design, made for the long term.</h1>
    <p>We partner with a small number of clients each year to build brands that don't need a redesign in eighteen months.</p>
    <a class="cta" href="#contact">Start a project &nbsp;&rarr;</a>
  </div>
  <div class="visual"></div>
</section>
<section class="me-benefits">
  <div class="row">
    <div class="item"><div class="num">01</div><h3>Strategy first</h3><p>Every engagement starts with a positioning document, not a moodboard.</p></div>
    <div class="item"><div class="num">02</div><h3>Small by design</h3><p>Four clients at a time, so nothing ships half-finished.</p></div>
    <div class="item"><div class="num">03</div><h3>Built to last</h3><p>Systems your team can run without us in the room.</p></div>
  </div>
</section>`.trim(),
  },

  bold_maximalist: {
    label: 'Bold / Maximalist',
    mood: 'Loud, energetic, impossible to scroll past. Big shapes, big type, big color contrast.',
    palette: { background: '#FFFFFF', text: '#0A0A0A', accent: '#FF3B30', secondaryAccent: '#FFD60A' },
    typography: { headline: '"Archivo Black", Inter, sans-serif', body: 'Inter, sans-serif' },
    layoutNotes: 'Oversized type, color-blocked sections, chunky pill buttons, slight card rotation, hard edges over soft shadows.',
    motionStyle: 'Energetic — punchy scale+fade entrance with a slight overshoot bounce, snappy ~400-500ms timing, confident hover transforms.',
    htmlSnippet: `
<style>
  @keyframes bmPop { from { opacity:0; transform:scale(.85); } to { opacity:1; transform:scale(1); } }
  @keyframes bmChipFloat { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-10px); } }
  .bm-hero { background:#0A0A0A; color:#fff; padding:100px 6vw; text-align:center; position:relative; overflow:hidden; }
  .bm-chip-wrap { position:absolute; opacity:0; animation:bmPop .5s cubic-bezier(.34,1.56,.64,1) forwards; z-index:2; }
  .bm-chip-wrap-1 { top:18%; left:6%; animation-delay:.5s; }
  .bm-chip-wrap-2 { top:24%; right:7%; animation-delay:.65s; }
  .bm-chip { display:inline-block; font:12px/1 Inter,sans-serif; font-weight:800; letter-spacing:.03em; padding:8px 14px; border-radius:999px; background:#FFD60A; color:#0A0A0A; animation:bmChipFloat 3.6s ease-in-out infinite; }
  .bm-chip-wrap-2 .bm-chip { background:#fff; animation-duration:4.2s; animation-delay:.3s; }
  .bm-hero .tag { display:inline-block; background:#FFD60A; color:#0A0A0A; font:13px/1 Inter,sans-serif; font-weight:800; letter-spacing:.04em; text-transform:uppercase; padding:8px 16px; border-radius:999px; margin-bottom:28px; opacity:0; animation:bmPop .5s cubic-bezier(.34,1.56,.64,1) forwards; }
  .bm-hero h1 { font:88px/0.95 "Archivo Black",Inter,sans-serif; margin:0 0 24px; opacity:0; animation:bmPop .5s cubic-bezier(.34,1.56,.64,1) forwards; animation-delay:.1s; }
  .bm-hero h1 span { color:#FF3B30; }
  .bm-hero p { font:19px/1.5 Inter,sans-serif; color:#C9C9C9; max-width:42ch; margin:0 auto 36px; opacity:0; animation:bmPop .5s cubic-bezier(.34,1.56,.64,1) forwards; animation-delay:.22s; }
  .bm-hero .cta { background:#FF3B30; color:#fff; font:16px Inter,sans-serif; font-weight:800; border:none; padding:18px 36px; border-radius:999px; cursor:pointer; transition:transform .15s; opacity:0; animation:bmPop .5s cubic-bezier(.34,1.56,.64,1) forwards; animation-delay:.32s; }
  .bm-hero .cta:hover { transform:scale(1.05) rotate(-1deg); }
  .bm-benefits { background:#FFD60A; padding:80px 6vw; }
  .bm-benefits .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:28px; max-width:1100px; margin:0 auto; }
  .bm-benefits .card { background:#0A0A0A; color:#fff; padding:32px; border-radius:4px; transform:rotate(-1deg); opacity:0; animation:bmPop .5s cubic-bezier(.34,1.56,.64,1) forwards; transition:box-shadow .2s; }
  .bm-benefits .card:nth-child(1) { animation-delay:.05s; }
  .bm-benefits .card:nth-child(2) { transform:rotate(1deg); background:#FF3B30; animation-delay:.15s; }
  .bm-benefits .card:nth-child(3) { animation-delay:.25s; }
  .bm-benefits .card:hover { box-shadow:0 10px 0 rgba(0,0,0,.15); }
  .bm-benefits .card h3 { font:26px "Archivo Black",Inter,sans-serif; margin:0 0 10px; }
  .bm-benefits .card p { font:15px/1.5 Inter,sans-serif; margin:0; opacity:.85; }
</style>
<section class="bm-hero">
  <!-- Placeholder proof-point text for THIS demo sneaker-drop business only.
       Real generation must replace with the actual business's real numbers — never copy "10K+ SOLD" / "4.9 RATING" onto an unrelated business. -->
  <div class="bm-chip-wrap bm-chip-wrap-1"><span class="bm-chip">10K+ SOLD</span></div>
  <div class="bm-chip-wrap bm-chip-wrap-2"><span class="bm-chip">★ 4.9 RATING</span></div>
  <span class="tag">Now Live</span>
  <h1>Stop blending in.<br/><span>Get loud.</span></h1>
  <p>The sneaker drop platform that sells out in minutes, not weeks.</p>
  <button class="cta">Claim Early Access</button>
</section>
<section class="bm-benefits">
  <div class="grid">
    <div class="card"><h3>Drop in seconds</h3><p>Queue thousands of buyers without the site falling over.</p></div>
    <div class="card"><h3>Zero bots</h3><p>Real fans get the drop, not scripts.</p></div>
    <div class="card"><h3>Built for hype</h3><p>Countdown, waitlist, and restock tools out of the box.</p></div>
  </div>
</section>`.trim(),
  },

  corporate_trust: {
    label: 'Corporate / Trust',
    mood: 'Professional, established, reassuring. Looks like it has a procurement department.',
    palette: { background: '#F4F6F8', text: '#101828', accent: '#2D7DD2', secondaryAccent: '#0F2A4A' },
    typography: { headline: 'Inter, sans-serif', body: 'Inter, sans-serif' },
    layoutNotes: 'Structured grid, icon-circle + text blocks, subtle card shadows, conservative spacing, no playful rotation or color noise.',
    motionStyle: 'Professional — smooth fade-up, moderate ~600ms timing, no overshoot or bounce. Reassuring, not flashy.',
    htmlSnippet: `
<style>
  @keyframes ctFadeUp { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:translateY(0); } }
  .ct-hero { background:linear-gradient(135deg,#0F2A4A,#16395E); color:#fff; padding:110px 6vw 90px; text-align:center; }
  .ct-hero h1 { font:50px/1.2 Inter,sans-serif; font-weight:700; max-width:18ch; margin:0 auto 20px; opacity:0; animation:ctFadeUp .6s ease-out forwards; animation-delay:.05s; }
  .ct-hero p { font:18px/1.6 Inter,sans-serif; color:#C7D5E5; max-width:46ch; margin:0 auto 32px; opacity:0; animation:ctFadeUp .6s ease-out forwards; animation-delay:.15s; }
  .ct-hero .cta { background:#2D7DD2; color:#fff; font:15px Inter,sans-serif; font-weight:600; border:none; padding:14px 30px; border-radius:8px; cursor:pointer; transition:background .2s; opacity:0; animation:ctFadeUp .6s ease-out forwards; animation-delay:.25s; }
  .ct-hero .cta:hover { background:#2569AD; }
  .ct-hero .badges { display:flex; gap:28px; justify-content:center; margin-top:48px; opacity:0; font:12px Inter,sans-serif; letter-spacing:.05em; color:#9FB3C8; animation:ctFadeUp .6s ease-out forwards; animation-delay:.35s; }
  .ct-features { background:#F4F6F8; padding:80px 6vw; }
  .ct-features .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:24px; max-width:1100px; margin:0 auto; }
  .ct-features .card { background:#fff; border-radius:12px; padding:32px; box-shadow:0 1px 3px rgba(16,24,40,.06), 0 1px 2px rgba(16,24,40,.04); opacity:0; animation:ctFadeUp .6s ease-out forwards; transition:transform .2s,box-shadow .2s; }
  .ct-features .card:nth-child(1) { animation-delay:.1s; }
  .ct-features .card:nth-child(2) { animation-delay:.2s; }
  .ct-features .card:nth-child(3) { animation-delay:.3s; }
  .ct-features .card:hover { transform:translateY(-3px); box-shadow:0 8px 20px rgba(16,24,40,.08); }
  .ct-features .icon { width:44px; height:44px; border-radius:10px; background:#E7F0FB; color:#2D7DD2; display:flex; align-items:center; justify-content:center; font:20px sans-serif; margin-bottom:18px; }
  .ct-features h3 { font:18px Inter,sans-serif; font-weight:600; margin:0 0 8px; color:#101828; }
  .ct-features p { font:14px/1.6 Inter,sans-serif; color:#475467; margin:0; }
</style>
<section class="ct-hero">
  <h1>Compliance software your auditors won't push back on.</h1>
  <p>SOC 2, ISO 27001, and HIPAA workflows for finance and healthcare teams, deployed by IT in under a day.</p>
  <button class="cta">Book a Demo</button>
  <div class="badges"><span>SOC 2 TYPE II</span><span>ISO 27001</span><span>HIPAA READY</span></div>
</section>
<section class="ct-features">
  <div class="grid">
    <div class="card"><div class="icon">&#9776;</div><h3>Audit trail built-in</h3><p>Every control mapped to evidence automatically, no spreadsheets.</p></div>
    <div class="card"><div class="icon">&#128274;</div><h3>SSO &amp; role controls</h3><p>Provisioned through your existing identity provider.</p></div>
    <div class="card"><div class="icon">&#128202;</div><h3>Reporting on demand</h3><p>Board-ready compliance reports generated in one click.</p></div>
  </div>
</section>`.trim(),
  },

  playful_funky: {
    label: 'Playful / Funky',
    mood: 'Quirky, approachable, a little weird on purpose. Feels handmade, not corporate.',
    palette: { background: '#FFF8F0', text: '#2B2B2B', accent: '#FF6F91', secondaryAccent: '#6FCF97' },
    typography: { headline: '"Poppins", Quicksand, sans-serif', body: '"Poppins", system-ui, sans-serif' },
    layoutNotes: 'Blobby border-radius shapes, rotated sticky-note cards, pill buttons, mixed pastel/bright accents, asymmetric tilt.',
    motionStyle: 'Bouncy — overshoot entrance, gentle floating blob loop, playful lift on hover. The page should feel alive, never static.',
    htmlSnippet: `
<style>
  @keyframes pfPop { from { opacity:0; transform:translateY(20px) scale(.9); } to { opacity:1; transform:translateY(0) scale(1); } }
  @keyframes pfFloat { 0%,100% { transform:translateY(0) rotate(0deg); } 50% { transform:translateY(-10px) rotate(3deg); } }
  .pf-hero { background:#FFF8F0; color:#2B2B2B; padding:100px 6vw; text-align:center; position:relative; }
  .pf-hero .blob { position:absolute; top:60px; right:8vw; width:280px; height:280px; background:#FFE066; border-radius:42% 58% 65% 35%/45% 45% 55% 55%; z-index:0; opacity:.7; animation:pfFloat 6s ease-in-out infinite; }
  .pf-hero .inner { position:relative; z-index:1; }
  .pf-hero h1 { font:58px/1.1 "Poppins",sans-serif; font-weight:700; max-width:16ch; margin:0 auto 20px; opacity:0; animation:pfPop .6s cubic-bezier(.34,1.56,.64,1) forwards; animation-delay:.1s; }
  .pf-hero h1 .hl { color:#FF6F91; }
  .pf-hero p { font:18px/1.6 "Poppins",sans-serif; color:#5C5C5C; max-width:38ch; margin:0 auto 32px; opacity:0; animation:pfPop .6s cubic-bezier(.34,1.56,.64,1) forwards; animation-delay:.25s; }
  .pf-hero .cta { background:#FF6F91; color:#fff; font:16px "Poppins",sans-serif; font-weight:600; border:none; padding:16px 34px; border-radius:999px; cursor:pointer; box-shadow:0 6px 0 #D94F72; transition:transform .12s; opacity:0; animation:pfPop .6s cubic-bezier(.34,1.56,.64,1) forwards; animation-delay:.4s; }
  .pf-hero .cta:hover { transform:translateY(2px); box-shadow:0 4px 0 #D94F72; }
  .pf-testimonials { background:#FFF8F0; padding:40px 6vw 100px; }
  .pf-testimonials .row { display:flex; gap:28px; justify-content:center; flex-wrap:wrap; }
  .pf-testimonials .note { width:260px; padding:24px; border-radius:18px; font:15px/1.6 "Poppins",sans-serif; transform:rotate(-3deg); opacity:0; animation:pfPop .5s cubic-bezier(.34,1.56,.64,1) forwards; transition:transform .2s; }
  .pf-testimonials .note:nth-child(1) { animation-delay:.1s; }
  .pf-testimonials .note:nth-child(2) { transform:rotate(2deg); animation-delay:.2s; }
  .pf-testimonials .note:nth-child(3) { transform:rotate(-1deg); animation-delay:.3s; }
  .pf-testimonials .note:hover { transform:translateY(-5px) rotate(0deg); }
  .pf-testimonials .note.mint { background:#E3F6EC; }
  .pf-testimonials .note.pink { background:#FFE7EC; }
  .pf-testimonials .note.yellow { background:#FFF3CF; }
  .pf-testimonials .name { font-weight:700; margin-top:12px; display:block; }
</style>
<section class="pf-hero">
  <div class="blob"></div>
  <div class="inner">
    <h1>Meal planning that doesn't feel like <span class="hl">homework</span>.</h1>
    <p>Tell us what's in your fridge. We'll tell you what's for dinner.</p>
    <button class="cta">Plan My Week &#127881;</button>
  </div>
</section>
<section class="pf-testimonials">
  <div class="row">
    <div class="note mint">"I haven't opened a delivery app in three weeks."<span class="name">— Priya</span></div>
    <div class="note pink">"My fridge has never been this organized, honestly."<span class="name">— Theo</span></div>
    <div class="note yellow">"Cooking five nights a week and actually enjoying it??"<span class="name">— Aisha</span></div>
  </div>
</section>`.trim(),
  },

  luxury_premium: {
    label: 'Luxury / Premium',
    mood: 'Exclusive, refined, quiet confidence. Every element earns its place.',
    palette: { background: '#0B0B0B', text: '#F5F0E6', accent: '#C9A227' },
    typography: { headline: '"Cormorant", "Playfair Display", serif', body: '"Helvetica Neue", Arial, sans-serif' },
    layoutNotes: 'Centered symmetric composition, thin gold hairlines, very low contrast hover transitions, extreme whitespace, no shadows or gradients beyond a single subtle vignette.',
    motionStyle: 'Extremely subtle — slow fade only (~1.1s), a faint upward drift at most, no bounce or scale ever. Restraint is the point.',
    htmlSnippet: `
<style>
  @keyframes lpFade { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
  .lp-hero { background:#0B0B0B; color:#F5F0E6; padding:140px 6vw 110px; text-align:center; }
  .lp-hero .mark { font:11px "Helvetica Neue",Arial,sans-serif; letter-spacing:.32em; text-transform:uppercase; color:#C9A227; margin-bottom:32px; opacity:0; animation:lpFade 1.1s ease forwards; }
  .lp-hero h1 { font:56px/1.25 "Cormorant","Playfair Display",serif; font-weight:400; max-width:22ch; margin:0 auto 28px; opacity:0; animation:lpFade 1.1s ease forwards; animation-delay:.2s; }
  .lp-hero .divider { width:48px; height:1px; background:#C9A227; margin:0 auto 28px; opacity:0; animation:lpFade 1.1s ease forwards; animation-delay:.4s; }
  .lp-hero p { font:16px/1.8 "Helvetica Neue",Arial,sans-serif; letter-spacing:.02em; color:#B8B0A0; max-width:36ch; margin:0 auto 40px; opacity:0; animation:lpFade 1.1s ease forwards; animation-delay:.5s; }
  .lp-hero .cta { display:inline-block; border:1px solid #C9A227; color:#F5F0E6; font:13px "Helvetica Neue",Arial,sans-serif; letter-spacing:.12em; text-transform:uppercase; text-decoration:none; padding:16px 40px; transition:background .25s,color .25s; opacity:0; animation:lpFade 1.1s ease forwards; animation-delay:.7s; }
  .lp-hero .cta:hover { background:#C9A227; color:#0B0B0A; }
  .lp-quote { background:#0B0B0B; padding:0 6vw 130px; text-align:center; border-top:1px solid #2A2A28; }
  .lp-quote .q { font:34px/1.5 "Cormorant","Playfair Display",serif; font-style:italic; color:#F5F0E6; max-width:46ch; margin:64px auto 24px; opacity:0; animation:lpFade 1.1s ease forwards; animation-delay:.1s; }
  .lp-quote .by { font:12px "Helvetica Neue",Arial,sans-serif; letter-spacing:.1em; text-transform:uppercase; color:#C9A227; opacity:0; animation:lpFade 1.1s ease forwards; animation-delay:.3s; }
</style>
<section class="lp-hero">
  <div class="mark">Maison Verrier — Est. 1987</div>
  <h1>Crystal, cut by hand, kept for generations.</h1>
  <div class="divider"></div>
  <p>Each piece is signed by the artisan who made it. We make under two thousand a year, by design.</p>
  <a class="cta" href="#collection">View the Collection</a>
</section>
<section class="lp-quote">
  <p class="q">"It's the only gift I've given that made my mother cry. Twice — once unwrapping it, once finding the maker's signature."</p>
  <div class="by">— A Private Client, London</div>
</section>`.trim(),
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
    htmlSnippet: `
<style>
  @keyframes tdFadeUp { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
  @keyframes tdBlink { 0%,50% { opacity:1; } 51%,100% { opacity:0; } }
  @keyframes tdPulse { 0%,100% { box-shadow:0 0 8px #3FB950; } 50% { box-shadow:0 0 2px #3FB950; } }
  .td-hero { background:#0D1117; color:#E6EDF3; padding:110px 6vw 90px; text-align:center; }
  .td-hero .pill { display:inline-flex; align-items:center; gap:8px; font:12px/1 "JetBrains Mono",monospace; color:#3FB950; border:1px solid #21372A; background:#0F1A12; padding:6px 14px; border-radius:999px; margin-bottom:28px; opacity:0; animation:tdFadeUp .5s ease forwards; }
  .td-hero .pill::before { content:""; width:6px; height:6px; border-radius:50%; background:#3FB950; animation:tdPulse 1.6s ease-in-out infinite; }
  .td-hero h1 { font:54px/1.2 Inter,sans-serif; font-weight:700; max-width:18ch; margin:0 auto 20px; opacity:0; animation:tdFadeUp .5s ease forwards; animation-delay:.08s; }
  .td-hero h1 .accent { color:#58A6FF; }
  .td-hero p { font:17px/1.6 Inter,sans-serif; color:#8B949E; max-width:42ch; margin:0 auto 34px; opacity:0; animation:tdFadeUp .5s ease forwards; animation-delay:.18s; }
  .td-hero .cta { background:#1F6FEB; color:#fff; font:15px Inter,sans-serif; font-weight:600; border:none; padding:14px 28px; border-radius:6px; cursor:pointer; box-shadow:0 0 0 1px #58A6FF inset, 0 0 24px rgba(88,166,255,.25); transition:transform .15s; opacity:0; animation:tdFadeUp .5s ease forwards; animation-delay:.28s; }
  .td-hero .cta:hover { transform:translateY(-2px); }
  .td-hero .term { margin:48px auto 0; max-width:560px; background:#161B22; border:1px solid #30363D; border-radius:8px; text-align:left; overflow:hidden; opacity:0; animation:tdFadeUp .5s ease forwards; animation-delay:.4s; }
  .td-hero .term .bar { display:flex; gap:6px; padding:10px 14px; background:#1B2128; border-bottom:1px solid #30363D; }
  .td-hero .term .bar span { width:10px; height:10px; border-radius:50%; background:#30363D; }
  .td-hero .term pre { margin:0; padding:18px; font:13px/1.7 "JetBrains Mono",monospace; color:#79C0FF; }
  .td-hero .term pre::after { content:"_"; animation:tdBlink 1s steps(1) infinite; }
  .td-rotating-status { transition:opacity .2s ease; }
  .td-features { background:#0D1117; padding:0 6vw 100px; }
  .td-features .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:20px; max-width:1100px; margin:0 auto; }
  .td-features .card { background:#161B22; border:1px solid #30363D; border-radius:10px; padding:26px; text-align:left; opacity:0; animation:tdFadeUp .5s ease forwards; transition:border-color .2s,transform .2s; }
  .td-features .card:hover { border-color:#58A6FF; transform:translateY(-2px); }
  .td-features .card:nth-child(1) { animation-delay:.1s; }
  .td-features .card:nth-child(2) { animation-delay:.2s; }
  .td-features .card:nth-child(3) { animation-delay:.3s; }
  .td-features .card .tag { font:11px "JetBrains Mono",monospace; color:#58A6FF; letter-spacing:.05em; }
  .td-features .card h3 { font:17px Inter,sans-serif; font-weight:600; margin:10px 0 8px; }
  .td-features .card p { font:13.5px/1.6 Inter,sans-serif; color:#8B949E; margin:0; }
</style>
<section class="td-hero">
  <span class="pill">v2.4 just shipped</span>
  <h1>Ship background jobs without <span class="accent">babysitting queues</span>.</h1>
  <p>Durable workers, retries, and observability — one binary, no Redis to manage.</p>
  <button class="cta">Get Started — Free</button>
  <div class="term">
    <div class="bar"><span></span><span></span><span></span></div>
    <pre>$ npx jobctl init
<span class="td-rotating-status">&#10003; workers running on :4173</span></pre>
  </div>
</section>
<section class="td-features">
  <div class="grid">
    <div class="card"><div class="tag">RELIABILITY</div><h3>At-least-once delivery</h3><p>Automatic retries with backoff, dead-letter queues included.</p></div>
    <div class="card"><div class="tag">OBSERVABILITY</div><h3>Built-in tracing</h3><p>Every job run is queryable, no separate APM to wire up.</p></div>
    <div class="card"><div class="tag">DX</div><h3>Single binary</h3><p>No Redis, no broker. Deploy it like any other service.</p></div>
  </div>
</section>
<script>
(function() {
  // Reference implementation of the decorative-JS guardrails: IIFE-scoped,
  // try/catch wrapped, only touches non-data-field decorative text, defensive
  // null-checks. See docs/decisions/ai-page-generation-quality.md.
  try {
    // Placeholder log lines for THIS demo dev-tool business only. Real
    // generation must replace with content relevant to the actual business
    // (e.g. a bakery page must never end up with "workers running" / "jobs
    // processed" just because technical_dark was the closest style match).
    var messages = [
      '\\u2713 workers running on :4173',
      '\\u2713 processed 1,204 jobs today',
      '\\u2713 0 failures in last 24h',
    ];
    var els = document.querySelectorAll('.td-rotating-status');
    if (!els.length) return;
    var i = 0;
    setInterval(function () {
      // A try/catch around the setInterval() call itself (above) does NOT
      // catch errors thrown inside this callback — it runs in a new call
      // stack later. Every callback needs its own try/catch.
      try {
        i = (i + 1) % messages.length;
        els.forEach(function (el) {
          if (!el) return;
          el.style.opacity = '0';
          setTimeout(function () {
            try {
              el.textContent = messages[i];
              el.style.opacity = '1';
            } catch (e) { /* never throw from inside the timeout */ }
          }, 200);
        });
      } catch (e) { /* never throw from inside the interval */ }
    }, 3000);
  } catch (e) { /* never throw from setup */ }
})();
</script>`.trim(),
  },
};
