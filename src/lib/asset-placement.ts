/**
 * Did the images the user imported from a link actually reach the page?
 *
 * The import pipeline (Drive folder / bucket / direct URL -> re-hosted on our
 * storage -> listed to the model) had no answer to that question. The model is
 * told to place a file only "when one of these fits a slot", which is correct:
 * a brief that forbids extra imagery, or four photos that suit nothing on the
 * page, should end with nothing placed. But the build then reported a plain
 * "Your page is ready!" and the imported files were simply absent, which is
 * indistinguishable from the fetch having failed. A user who watched four
 * thumbnails appear and then saw none of them on the page has no way to tell a
 * deliberate decline from a broken feature, and reads it as broken.
 *
 * So we count. Counting is done against the FINISHED HTML, never the schema:
 * the schema is what the model asked for, the HTML is what shipped, and the
 * builder between them is a separate AI call free to drop a URL.
 */

export interface LibraryAsset {
  url: string;
  name?: string;
}

export interface AssetPlacement {
  /** How many link-imported files were offered to this build. */
  imported: number;
  /** How many of them appear in the finished HTML. */
  placed: number;
  /** Filenames of the ones that did not, in the order they were imported. */
  unusedNames: string[];
}

/**
 * The storage object path — everything after `/object/public/`.
 *
 * Matched alongside the full URL because the URL as embedded is not always the
 * URL as handed over: an image optimizer prefix, a CDN host swap or a rewritten
 * origin all change the front of the string while leaving the object path
 * intact. This is still an exact substring of the same URL, not a fuzzy match —
 * a file either has its path in the document or it does not.
 */
function storageObjectPath(url: string): string | null {
  const m = /\/object\/public\/(.+)$/.exec(url);
  return m ? m[1] : null;
}

export function measureAssetPlacement(
  assets: LibraryAsset[],
  html: string,
): AssetPlacement {
  const unusedNames: string[] = [];
  let placed = 0;

  for (const asset of assets) {
    const objectPath = storageObjectPath(asset.url);
    const onPage = html.includes(asset.url) || (!!objectPath && html.includes(objectPath));
    if (onPage) placed++;
    else unusedNames.push(asset.name || 'image');
  }

  return { imported: assets.length, placed, unusedNames };
}

/** Cap on filenames listed back, so a 20-file import doesn't produce a wall. */
const MAX_NAMES_LISTED = 4;

/**
 * One sentence for the chat, or null when there is nothing worth saying.
 *
 * Silent on the all-placed case on purpose: the images are visible in the
 * preview, so announcing them is noise on the common path. The message exists
 * for the cases the user cannot see — a partial placement, and the total
 * decline that started all this.
 */
export function describeAssetPlacement(placement: AssetPlacement): string | null {
  const { imported, placed, unusedNames } = placement;
  if (imported === 0 || placed === imported) return null;

  const listed = unusedNames.slice(0, MAX_NAMES_LISTED).join(', ');
  const rest = unusedNames.length - MAX_NAMES_LISTED;
  const names = rest > 0 ? `${listed} and ${rest} more` : listed;

  if (placed === 0) {
    return imported === 1
      ? `The image from your link (${names}) isn't on the page — nothing here fitted it. Tell me where it should go and I'll place it.`
      : `None of the ${imported} images from your link are on the page — nothing here fitted them (${names}). Tell me where they should go and I'll place them.`;
  }

  return `${placed} of the ${imported} images from your link are on the page. Not used: ${names} — tell me where they should go and I'll add them.`;
}
