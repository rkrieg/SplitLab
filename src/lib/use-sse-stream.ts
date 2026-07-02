import type { SSEEvent } from '@/lib/sse';

export type { SSEEvent };

/**
 * Reads an SSE response body as a ReadableStream, parses each `data: {...}` line,
 * and calls onEvent for each parsed event. Handles partial chunks correctly by
 * buffering across chunk boundaries before splitting on `\n\n`.
 */
export async function readSSEStream(
  response: Response,
  onEvent: (event: SSEEvent) => void,
): Promise<void> {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double newline — SSE message separator
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? ''; // last part may be an incomplete message

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        for (const line of trimmed.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6)) as SSEEvent;
              onEvent(event);
            } catch {
              // Ignore malformed events
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
