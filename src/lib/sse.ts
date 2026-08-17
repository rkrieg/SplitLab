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
      /** External images that failed verification and were left untouched. */
      broken_assets?: number;
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
