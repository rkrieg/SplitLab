/**
 * How much context a call can still afford.
 *
 * Deliberately dependency-free so it can be compiled and tested on its own —
 * the arithmetic here decides whether a model is shown the page or starved of
 * it, and that is worth checking with numbers rather than by reading.
 *
 * Why it exists: the region rewrite used to be handed a hardcoded "at most 60k
 * characters of page context", a number invented without knowing what a real
 * page weighs. A fixed budget is always a guess about somebody else's page.
 * Too small and the model cannot see something it needed — that is how "use
 * the image already in the hero" got answered with the user's own screenshot,
 * because the hero's HTML had been cut out of the payload. Too large and the
 * call dies outright.
 *
 * The real limit is arithmetic: the window, minus the room the reply needs,
 * minus what the call is already committed to sending.
 */

/** Context window of the models we run. Input and output share it. */
export const AI_CONTEXT_TOKENS = 200_000;

/**
 * Characters per token, for markup. Deliberately pessimistic: prose runs about
 * four, but HTML full of attributes, hex colours and class names runs denser,
 * so a low number here over-estimates the cost and errs toward a call that
 * fits.
 */
export const CHARS_PER_TOKEN = 3;

/** Roughly what one vision attachment costs, regardless of its file size. */
export const IMAGE_TOKENS = 1_600;

/**
 * Characters of extra context this call can still afford.
 *
 * Returns 0 when there is no room left — never a negative number, because a
 * caller doing `slice(0, budget)` with one would silently send nothing, which
 * is the starvation bug wearing a different hat.
 */
export function remainingInputChars(opts: {
  /** Characters this call is already committed to sending. */
  usedChars: number;
  /** The call's maxTokens — the answer has to fit in the same window. */
  reservedOutputTokens: number;
  /** Vision attachments on this call. */
  images?: number;
  /** Headroom for the system prompt and our own estimation error. */
  safetyTokens?: number;
}): number {
  const { usedChars, reservedOutputTokens, images = 0, safetyTokens = 8_000 } = opts;
  const spent =
    Math.ceil(usedChars / CHARS_PER_TOKEN) +
    images * IMAGE_TOKENS +
    reservedOutputTokens +
    safetyTokens;
  return Math.max(0, (AI_CONTEXT_TOKENS - spent) * CHARS_PER_TOKEN);
}
