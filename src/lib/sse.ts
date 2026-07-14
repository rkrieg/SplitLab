export type SSEEvent =
  | { type: 'status'; message: string }
  | { type: 'thinking'; message: string }
  | { type: 'section_status'; message: string }
  | { type: 'image_ready'; url: string }
  | { type: 'error'; message: string }
  | { type: 'done'; html_url: string; slug?: string; schema_json?: unknown; competitor_fetch_failed?: boolean };

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
