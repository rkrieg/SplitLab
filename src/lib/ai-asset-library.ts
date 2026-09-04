/**
 * The client's own images, rendered as prompt text.
 *
 * One builder for every route that offers the library to a model, so the build
 * and the edits describe the same assets the same way — and so the cost of
 * doing it is bounded in one place instead of three.
 */

export interface LibraryEntry {
  url: string;
  name: string;
  /** One-line description from the caption pass. Absent for older pages. */
  caption?: string | null;
}

/**
 * Ceiling on the asset list, in characters. Sized to fit MAX_LIBRARY_IMPORT
 * (500) whole, which is the promise — nothing is dropped for space at the size
 * a link can actually deliver.
 *
 * The arithmetic, because guessing it wrong is what this whole change fixes.
 * One line is `n. filename — caption — url`: ~220 chars, and the URL is the
 * bigger half of it (a signed Drive proxy URL is ~115 on its own; the caption
 * is capped at 120). 500 lines is ~110k chars, ~37k tokens at 3 chars/token.
 *
 * Against the build call's ~64k tokens of input room (200k window, less the
 * 128k output reservation and 8k safety), a full 500-asset library leaves
 * ~16k tokens for the reference scrape. That is the real trade, it is charged
 * honestly through remainingInputChars, and the scrape trims itself to fit
 * rather than the call failing.
 */
export const MAX_LIBRARY_BLOCK_CHARS = 115_000;

export interface LibraryBlock {
  /** Numbered "name — description — url" lines. Empty when nothing fits. */
  lines: string;
  included: number;
  dropped: number;
  chars: number;
}

export function buildLibraryBlock(
  assets: LibraryEntry[],
  maxChars: number = MAX_LIBRARY_BLOCK_CHARS,
): LibraryBlock {
  const out: string[] = [];
  let chars = 0;
  let included = 0;

  for (const a of assets) {
    const caption = a.caption?.trim();
    const line = `${included + 1}. ${a.name}${caption ? ` — ${caption}` : ''} — ${a.url}`;
    if (chars + line.length + 1 > maxChars) break;
    out.push(line);
    chars += line.length + 1;
    included++;
  }

  return { lines: out.join('\n'), included, dropped: assets.length - included, chars };
}
