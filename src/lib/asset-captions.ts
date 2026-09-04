import { askAI } from '@/lib/ai-client';
import { db } from '@/lib/supabase-server';

/**
 * One-line descriptions of link-imported images, so the model can choose from a
 * whole folder instead of the handful it could afford to LOOK at.
 *
 * A vision attachment costs ~1,600 tokens; a caption costs ~25. That is the
 * whole idea: caption once, cheaply, and the expensive build call then reads
 * every asset as text. Before this the build saw the first 8 images by
 * alphabetical accident and knew the rest only by filename, so a folder that
 * happened to start with icons spent its entire vision budget on icons.
 */

/** Cheap model, one small call per image. */
const CAPTION_MODEL = 'claude-haiku-4-5-20251001';
const CAPTION_MAX_TOKENS = 80;

/**
 * Captions run against images we have NOT downloaded — the provider fetches
 * each URL itself — so this bounds outbound requests, not memory.
 */
const CAPTION_CONCURRENCY = 20;

/**
 * Per-image wall clock. A batch advances only when its slowest call returns, so
 * without this one stalled image (a huge file the provider is still fetching,
 * or a retried connection drop) holds up twenty and can walk the whole route
 * past maxDuration. A timed-out image degrades to filename-only.
 */
const CAPTION_TIMEOUT_MS = 25_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('caption timed out')), ms);
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Truncation guard: a runaway caption would eat the build prompt's budget. */
export const MAX_CAPTION_CHARS = 120;

/**
 * What the caption model can actually open. Deliberately narrower than the
 * resolver's image list: SVG and TIFF are valid assets but not valid vision
 * input, and sending one fails the call rather than degrading it.
 */
const CAPTIONABLE_EXT_RE = /\.(png|jpe?g|webp|gif)(?:\?|#|$)/i;

const SYSTEM = `You label images for a landing-page builder.
Reply with ONE line, max 15 words, no preamble and no quotes.
Say what the image shows, then its type: photo, logo, icon, illustration, screenshot, texture, or background.
Example: wide shot of a smiling dental team in a bright reception — photo`;

export interface CaptionTarget {
  /** Stable cache key. The ResolvedAsset.url ref, e.g. `drive:abc` or an https URL. */
  ref: string;
  /** Filename, used as the fallback label when captioning is skipped or fails. */
  name: string;
  /** Fetchable URL handed to the model. Null when we cannot serve this asset. */
  imageUrl: string | null;
}

export interface CaptionResult {
  ref: string;
  name: string;
  /** Null when the image was not captionable, timed out, or the call failed. */
  caption: string | null;
}

export function isCaptionable(target: CaptionTarget): boolean {
  // Drive refs are `drive:<fileId>` with no extension — the filename lives in
  // `name`. Web/bucket refs often carry the extension on the URL itself.
  return (
    !!target.imageUrl &&
    (CAPTIONABLE_EXT_RE.test(target.ref) || CAPTIONABLE_EXT_RE.test(target.name))
  );
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/^["'\s-]+|["'\s]+$/g, '').slice(0, MAX_CAPTION_CHARS);
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/** Supabase rejects very large `in` lists, so reads and writes are chunked. */
const DB_CHUNK = 100;

async function readCache(refs: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let i = 0; i < refs.length; i += DB_CHUNK) {
    const chunk = refs.slice(i, i + DB_CHUNK);
    const { data, error } = await db
      .from('asset_captions')
      .select('source_ref, caption')
      .in('source_ref', chunk);
    // Best-effort: a cache miss costs money, a cache error must not cost the
    // user their import.
    if (error) {
      console.warn('[asset-captions] cache read failed', error.message);
      continue;
    }
    for (const row of data ?? []) found.set(row.source_ref as string, row.caption as string);
  }
  return found;
}

async function writeCache(rows: { source_ref: string; caption: string }[]): Promise<void> {
  for (let i = 0; i < rows.length; i += DB_CHUNK) {
    const { error } = await db
      .from('asset_captions')
      .upsert(rows.slice(i, i + DB_CHUNK), { onConflict: 'source_ref' });
    if (error) console.warn('[asset-captions] cache write failed', error.message);
  }
}

/**
 * Caption a list of assets, using the shared cache first.
 *
 * `deadlineAt` is a wall-clock stop: past it, remaining assets come back with a
 * null caption rather than the whole request being killed by the platform
 * mid-flight. A null caption is not a failure — the asset is still offered to
 * the model by filename, exactly as every asset was before this existed.
 */
export async function captionAssets(
  targets: CaptionTarget[],
  opts: { deadlineAt?: number } = {},
): Promise<{ results: CaptionResult[]; cached: number; generated: number; skipped: number }> {
  const deadlineAt = opts.deadlineAt ?? Number.POSITIVE_INFINITY;
  const byRef = new Map<string, CaptionResult>(
    targets.map((t) => [t.ref, { ref: t.ref, name: t.name, caption: null }]),
  );

  const captionable = targets.filter(isCaptionable);
  const cache = captionable.length > 0 ? await readCache(captionable.map((t) => t.ref)) : new Map();

  let cached = 0;
  const todo: CaptionTarget[] = [];
  for (const t of captionable) {
    const hit = cache.get(t.ref);
    if (hit) {
      byRef.set(t.ref, { ref: t.ref, name: t.name, caption: hit });
      cached++;
    } else {
      todo.push(t);
    }
  }

  const fresh: { source_ref: string; caption: string }[] = [];
  if (todo.length > 0) {
    await inBatches(todo, CAPTION_CONCURRENCY, async (t) => {
      if (Date.now() >= deadlineAt) return;
      try {
        const text = await withTimeout(
          askAI({
            system: SYSTEM,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'image', url: t.imageUrl as string },
                  { type: 'text', text: `Filename: ${t.name}` },
                ],
              },
            ],
            maxTokens: CAPTION_MAX_TOKENS,
            model: CAPTION_MODEL,
            label: 'asset-caption',
          }),
          CAPTION_TIMEOUT_MS,
        );
        const caption = clean(text);
        if (!caption) return;
        byRef.set(t.ref, { ref: t.ref, name: t.name, caption });
        fresh.push({ source_ref: t.ref, caption });
      } catch (err) {
        // One unreadable image must not fail the batch — it degrades to a
        // filename-only asset, which is what every asset used to be.
        console.warn('[asset-captions] caption failed', t.name, err instanceof Error ? err.message : err);
      }
    });
  }

  if (fresh.length > 0) await writeCache(fresh);

  return {
    results: targets.map((t) => byRef.get(t.ref) as CaptionResult),
    cached,
    generated: fresh.length,
    skipped: targets.length - captionable.length,
  };
}
