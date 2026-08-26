export type SSEEvent =
  | { type: 'status'; message: string }
  | { type: 'thinking'; message: string }
  | { type: 'section_status'; message: string }
  | { type: 'image_ready'; url: string }
  | { type: 'clarify'; message: string }
  | { type: 'error'; message: string }
  | {
      type: 'done';
      html_url: string;
      slug?: string;
      schema_json?: unknown;
      competitor_fetch_failed?: boolean;
      elapsed_ms?: number;
      already?: boolean;
      /**
       * Something the user ASKED FOR is not on the page. The client renders this
       * as "Partly done", so nothing else may travel here — see `notes`.
       */
      partial_message?: string;
      /**
       * The edit landed in full; here is something worth a look anyway (a
       * screenshot match that isn't exact, an image URL that didn't respond).
       *
       * Exists because there was no way to say "done, with a caveat". Caveats
       * were glued onto partial_message, so turns that did everything asked
       * reported "Partly done (not fully finished)" and users re-sent work that
       * had already landed. The follow-up route tried to fix this by emitting a
       * `warning` field — which was never in this type and never read by the
       * client, so the real warnings vanished instead. Spread properties skip
       * excess-property checks, which is why tsc never caught it.
       */
      notes?: string;
      /** Asks from the prompt the finished page still doesn't satisfy. */
      unmet_requirements?: string;
      /**
       * What the model that did the work says it did, in its own words.
       *
       * Every success message the user read used to be written by us — one
       * fixed sentence, "Done! The page has been updated.", printed whether the
       * turn moved a logo or rebuilt a hero. The model knew exactly what it had
       * changed and had nowhere to say it, because the rewrite contract asked
       * only for HTML. So the system did the thinking and we did all the
       * talking, which is what made it read like a script rather than an
       * assistant.
       *
       * Written by whichever rewrite did the work — the region rewrite or the
       * full-page one; both normalise it through normalizeEditorMessage so
       * there is one definition of how those words reach the chat.
       *
       * Absent whenever no model authored a sentence for this turn
       * (deterministic splices, or a model that simply omitted the field) —
       * the client then falls back to the fixed copy, exactly as before.
       */
      message?: string;
      /**
       * How an uploaded page came out of prep (schema-from-html only).
       *
       * 'patch'   — its layout comes from its markup, so any part of it can be
       *             edited in place and nothing about it was changed.
       * 'rebuild' — its layout is pixel coordinates in a stylesheet, so markup
       *             edits are inert and restructuring would overlap the
       *             original. Text/image/colour edits are still safe.
       *
       * See ai-page-layout.ts for how that is decided and why. Sent because the
       * page this was built for got a flat "Done preparing this page!" and then
       * had its hero stacked on top of itself — the user had no way to know
       * which kind of page they were editing.
       */
      prep_strategy?: 'patch' | 'rebuild';
      /** The plain-English version of prep_strategy, written for the chat. */
      prep_note?: string;
      /**
       * Machine-readable evidence behind prep_strategy === 'rebuild' (from
       * PageLayout.reasons in ai-page-layout.ts) — e.g. "62 of the page's 88
       * top-level blocks are placed at fixed left/top coordinates". Only sent
       * alongside prep_strategy 'rebuild'. Lets the client build a specific
       * prompt for the user's own AI tool instead of generic boilerplate.
       */
      rebuild_reasons?: string[];
      /**
       * Where the page as it was BEFORE a rebuild was saved (rebuild-flow only).
       *
       * A rebuild replaces the whole document, so there has to be a way back.
       * Test variants do not need this — their rebuild lands in the draft and
       * Discard draft is the undo — so it is only set for ordinary pages.
       */
      backup_html_url?: string;
      /** External images that failed verification and were left untouched. */
      broken_assets?: number;
      /**
       * Link-imported photos (Drive folder / bucket / direct URL) offered to
       * this build, and how many of them the finished HTML actually embeds.
       * Sent so the client can name a decline instead of leaving the user to
       * infer from an empty page that the import broke. Only present when the
       * turn had an imported library at all.
       */
      imported_assets?: number;
      placed_assets?: number;
      /** Filenames of the imported files that did not make it onto the page. */
      unused_asset_names?: string[];
      /**
       * Which Skills the build actually ran with, resolved SERVER-side — the
       * mandatory one is always in here even when the client sent nothing.
       * Ids for persistence, names for the "Built with" line.
       */
      skills_applied?: string[];
      skills_applied_names?: string[];
      /**
       * The style tag the build actually used — including the one the design
       * brief chose when the user left it on "Auto". Null only when no style
       * tag was in play at all (a competitor clone, or a follow-up told to
       * preserve the page's existing look).
       */
      style_applied?: string | null;
      /** True when `style_applied` was the model's pick rather than the user's. */
      style_auto?: boolean;
      /**
       * Per-check results of the selected skills, read from the finished HTML.
       *
       * DISPLAY ONLY. Nothing downstream reads this, no save is gated on it,
       * and a check that could not decide is simply absent rather than shown as
       * a failure — a wrong cross costs more trust than a missing row.
       */
      skill_scores?: {
        skillId: string;
        skillName: string;
        id: string;
        label: string;
        passed: boolean;
        detail: string;
      }[];
    };

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

const encoder = new TextEncoder();

export function createSSEStream(): {
  stream: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array>;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
  });
  return { stream, controller };
}

export function sendSSE(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: SSEEvent,
): void {
  try {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  } catch {
    // Stream may already be closed — swallow silently
  }
}

export function closeSSE(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try { controller.close(); } catch { /* already closed */ }
}

// SSE comment line (":" prefix) — valid per spec, keeps bytes flowing on the
// connection for idle-timeout proxies (e.g. Cloudflare) without ever reaching
// the client's event parser, since readSSEStream only reacts to "data: " lines.
export function sendSSEPing(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.enqueue(encoder.encode(`: ping\n\n`));
  } catch {
    // Stream may already be closed — swallow silently
  }
}
