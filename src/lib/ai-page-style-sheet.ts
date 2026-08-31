/**
 * The visual identity of one generated page, as data.
 *
 * This is the same shape the hand-written STYLE_EXEMPLARS carry, lifted out so
 * that a sheet can also be INVENTED for a specific business instead of only
 * looked up from the twelve. Both sources produce this object, and one renderer
 * turns it into the "## Style reference" block — so the locked rules, the token
 * block and everything downstream cannot tell the two apart.
 *
 * Why invent at all: a closed list of twelve means every gym that reaches
 * `bold_maximalist` gets the same red, the same yellow and the same font, no
 * matter how different the two businesses are. The list raises the floor on
 * taste and lowers the ceiling on variety to twelve. Inventing keeps the floor
 * (the sheet is still decided up front, still locked, still followed the whole
 * way down) and removes the ceiling.
 *
 * Nothing here trusts the model. A sheet that fails validation is discarded and
 * the caller falls back to the twelve, because a page built on an unreadable
 * palette or a font that will not load is worse than a page that looks like
 * another page.
 */

import { FONT_LIBRARY } from "@/lib/ai-page-fonts";

export interface PageStyleSheet {
  /** Short human name for this look — shown in the "Built with" strip. */
  label: string;
  mood: string;
  palette: {
    background: string;
    text: string;
    accent: string;
    secondaryAccent?: string;
  };
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
  typeScale: string;
  geometry: string;
  layoutNotes: string;
  signatureMoves: string;
  avoid: string;
  motionStyle: string;
  aestheticTarget: string;
}

const HEADLINE_FONTS = Object.keys(FONT_LIBRARY.headline);
const BODY_FONTS = Object.keys(FONT_LIBRARY.body);

/**
 * The JSON contract handed to the design-brief call.
 *
 * Font names are interpolated from FONT_LIBRARY rather than typed out, for the
 * same reason the style catalogue is generated from AUTO_STYLE_TAGS: two lists
 * that have to be kept in sync by hand will not stay in sync.
 */
export const STYLE_SHEET_JSON_SPEC = `  "style_sheet": {
    "label": "2-4 word name for this look, specific to this business (e.g. 'Chalk and Oxblood', 'Acid Industrial') — never a category word like 'Modern' or 'Bold'",
    "mood": "one sentence: what this page should feel like to the buyer",
    "palette": {
      "background": "#RRGGBB — the page ground",
      "text": "#RRGGBB — body and headline text on that ground",
      "accent": "#RRGGBB — the one colour that carries CTAs and emphasis",
      "secondaryAccent": "#RRGGBB — a second colour used sparingly, or omit this key"
    },
    "tokens": {
      "surface": "#RRGGBB — cards and panels sitting on the ground",
      "elevated": "#RRGGBB — the layer above a surface",
      "border": "#RRGGBB — hairlines and card edges",
      "textMuted": "#RRGGBB — captions, labels, secondary text",
      "radius": "CSS length, e.g. '0px' or '10px'",
      "radiusLg": "CSS length for large surfaces",
      "radiusPill": "CSS length for fully rounded elements, usually '999px'",
      "sectionPy": "CSS clamp() for vertical section padding",
      "container": "CSS length for max content width, e.g. '1200px'",
      "shadow": "full CSS box-shadow value, or 'none'",
      "shadowLg": "full CSS box-shadow value, or 'none'"
    },
    "typography": {
      "headline": "full CSS font stack whose FIRST family is one of: ${HEADLINE_FONTS.join(", ")}",
      "body": "full CSS font stack whose FIRST family is one of: ${BODY_FONTS.join(", ")}"
    },
    "typeScale": "one sentence: the h1 size/weight/tracking and how far body sits below it",
    "geometry": "one sentence: corners, borders and shadows as a single consistent decision",
    "layoutNotes": "one sentence: the layout rhythm this page runs on",
    "signatureMoves": "2-3 specific visual moves that make this page recognisable, semicolon separated",
    "avoid": "what would break this look — the things a generic page would do here",
    "motionStyle": "one sentence: motion intensity and timing",
    "aestheticTarget": "'Think X, Y, Z' — two or three real brands, places or printed objects this look maps to"
  },`;

/**
 * The rules that stop "invent a look" collapsing back into the same three
 * pages. Stated as outcomes to reject, never as styles to produce: a rule that
 * named a mechanism would make every invented sheet obey the same mechanism,
 * which is the problem it is meant to solve.
 */
export const STYLE_SHEET_RULES = `## How to write the style sheet
- Then apply the test that matters: if the company name were swapped for a competitor's and the page still looked right, the sheet is wrong. Rewrite it.
- The palette must come from this business's own world — its materials, its setting, what its buyer already looks at — not from what landing pages tend to look like. The same is true of the type and the geometry.
- Do not reach for the look you would produce for any similar brief. If your first instinct is a cream or off-white ground with a serif headline and a warm gold or terracotta accent, or near-black with one loud neon accent, or a hairline zero-radius newspaper grid, treat that as a signal you answered from habit, and answer again from the business. Any of the three is allowed only when this specific business genuinely calls for it.
- Commit. Every value has to belong to one system: a page that hedges between two looks reads as generic even when neither look is.
- Contrast is not negotiable. Text must be plainly readable on the background, and the accent must be clearly visible against it. A sheet that fails this is discarded and the page falls back to a stock look.
- If the request or the schema already gives brand colours or font names, use those exactly and build the rest of the sheet around them. Never invent over a brand the user handed you.`;

// ── Validation ────────────────────────────────────────────────────────────

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value.trim());
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function expandHex(hex: string): [number, number, number] {
  const h = hex.trim().slice(1);
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const channels = expandHex(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio between two hex colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The first family in a CSS font stack, unquoted.
 * `"Bebas Neue", Impact, sans-serif` -> `Bebas Neue`.
 */
function firstFamily(stack: string): string {
  const first = stack.split(",")[0] ?? "";
  return first
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

/**
 * Turn the model's JSON into a sheet, or return null with a reason logged.
 *
 * Every rejection here costs the page its invented identity and falls back to
 * a stock style, so each check earns its place by describing a page that would
 * actually be broken: colours that are not colours, text that cannot be read,
 * or a font with no @import URL and no measured width metrics (which the hero
 * H1 sizing depends on).
 */
export function parseStyleSheet(raw: unknown): PageStyleSheet | null {
  const reject = (why: string): null => {
    console.warn(
      "[style-sheet] invented sheet rejected, falling back to a stock style:",
      why,
    );
    return null;
  };

  if (!raw || typeof raw !== "object") return reject("not an object");
  const s = raw as Record<string, unknown>;
  const palette = s.palette as Record<string, unknown> | undefined;
  const tokens = s.tokens as Record<string, unknown> | undefined;
  const typography = s.typography as Record<string, unknown> | undefined;
  if (!palette || !tokens || !typography)
    return reject("missing palette, tokens or typography");

  for (const key of ["background", "text", "accent"] as const) {
    if (!isHex(palette[key]))
      return reject(`palette.${key} is not a hex colour`);
  }
  if (
    palette.secondaryAccent !== undefined &&
    palette.secondaryAccent !== "" &&
    !isHex(palette.secondaryAccent)
  ) {
    return reject("palette.secondaryAccent is not a hex colour");
  }
  for (const key of ["surface", "elevated", "border", "textMuted"] as const) {
    if (!isHex(tokens[key])) return reject(`tokens.${key} is not a hex colour`);
  }
  // Free-form CSS values — a shadow is "6px 6px 0 #0A0A0A" or "none", and a
  // section padding is a clamp(). Only presence is checkable here.
  for (const key of [
    "radius",
    "radiusLg",
    "radiusPill",
    "sectionPy",
    "container",
    "shadow",
    "shadowLg",
  ] as const) {
    if (!isText(tokens[key])) return reject(`tokens.${key} is empty`);
  }

  if (!isText(typography.headline) || !isText(typography.body))
    return reject("typography is empty");
  const headlineStack = (typography.headline as string).trim();
  const bodyStack = (typography.body as string).trim();
  const headlineFamily = firstFamily(headlineStack);
  const bodyFamily = firstFamily(bodyStack);
  if (!(headlineFamily in FONT_LIBRARY.headline)) {
    return reject(
      `headline font "${headlineFamily}" is not in the font library`,
    );
  }
  if (!(bodyFamily in FONT_LIBRARY.body)) {
    return reject(`body font "${bodyFamily}" is not in the font library`);
  }

  const prose = [
    "label",
    "mood",
    "typeScale",
    "geometry",
    "layoutNotes",
    "signatureMoves",
    "avoid",
    "motionStyle",
    "aestheticTarget",
  ] as const;
  for (const key of prose) {
    if (!isText(s[key])) return reject(`${key} is empty`);
  }

  // Readability. 4.5:1 is the WCAG AA floor for body text; 3:1 is the floor
  // for a UI element that has to be findable, which is what the accent is
  // doing when it carries the CTA. Muted text is held to 3:1 rather than 4.5
  // because it is captions and labels, and holding it to body-text contrast
  // would reject every palette that has a muted tier at all.
  const bg = (palette.background as string).trim();
  const text = (palette.text as string).trim();
  const accent = (palette.accent as string).trim();
  const muted = (tokens.textMuted as string).trim();
  if (contrastRatio(text, bg) < 4.5) {
    return reject(
      `text ${text} on background ${bg} is only ${contrastRatio(text, bg).toFixed(2)}:1`,
    );
  }
  if (contrastRatio(accent, bg) < 3) {
    return reject(
      `accent ${accent} on background ${bg} is only ${contrastRatio(accent, bg).toFixed(2)}:1`,
    );
  }
  if (contrastRatio(muted, bg) < 3) {
    return reject(
      `muted text ${muted} on background ${bg} is only ${contrastRatio(muted, bg).toFixed(2)}:1`,
    );
  }

  const secondary = isHex(palette.secondaryAccent)
    ? (palette.secondaryAccent as string).trim()
    : undefined;
  const tok = (key: keyof PageStyleSheet["tokens"]): string =>
    String(tokens[key]).trim();
  const prop = (key: string): string => String(s[key]).trim();

  return {
    label: prop("label"),
    mood: prop("mood"),
    palette: {
      background: bg,
      text,
      accent,
      ...(secondary ? { secondaryAccent: secondary } : {}),
    },
    tokens: {
      surface: tok("surface"),
      elevated: tok("elevated"),
      border: tok("border"),
      textMuted: muted,
      radius: tok("radius"),
      radiusLg: tok("radiusLg"),
      radiusPill: tok("radiusPill"),
      sectionPy: tok("sectionPy"),
      container: tok("container"),
      shadow: tok("shadow"),
      shadowLg: tok("shadowLg"),
    },
    typography: { headline: headlineStack, body: bodyStack },
    typeScale: prop("typeScale"),
    geometry: prop("geometry"),
    layoutNotes: prop("layoutNotes"),
    signatureMoves: prop("signatureMoves"),
    avoid: prop("avoid"),
    motionStyle: prop("motionStyle"),
    aestheticTarget: prop("aestheticTarget"),
  };
}

/**
 * The `pages.style` value for an invented sheet.
 *
 * Prefixed so it can never collide with a StyleTag: isStyleTag() rejects it,
 * which means a later rebuild that reads this column back falls through to
 * Auto — exactly what a page with no stored style does today. The label rides
 * along only so the "Built with" strip has something to show.
 */
export const CUSTOM_STYLE_PREFIX = "custom:";

export function customStyleValue(sheet: PageStyleSheet): string {
  return `${CUSTOM_STYLE_PREFIX}${sheet.label}`;
}
