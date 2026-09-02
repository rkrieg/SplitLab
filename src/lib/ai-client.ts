import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { uploadImage } from '@/lib/storage';
import { logEvent } from '@/lib/log';
import { recordAiUsage, type UsageContext } from '@/lib/ai-usage';

/**
 * Provider-agnostic content shape used by every AI page-builder route.
 * Each adapter below translates this into its own wire format — callers
 * never construct Anthropic- or OpenAI-shaped blocks directly, so adding a
 * new provider later never requires touching the route files.
 */
export type AIContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'image_base64'; data: string; mediaType: string };

export type AIContent = string | AIContentBlock[];

export interface AIMessage {
  role: 'user' | 'assistant';
  content: AIContent;
}

export interface AskAIOptions {
  system: string;
  messages: AIMessage[];
  maxTokens: number;
  /** Rarely needed — overrides the active provider's default model for this one call. */
  model?: string;
  /**
   * Identifies which route/step made this call (e.g. "follow-up:structural-build",
   * "schema-from-html", "build"). Required in practice — every call site sets
   * this so a start/finish/error log can be traced back to a specific AI call
   * in a flow that makes several of them per request.
   */
  label: string;
  /**
   * When set, this call's token usage is metered against the account owner for
   * AI credits / overage billing. Recorded centrally here so every AI route is
   * counted in one place — even when a call truncates. Best-effort; never throws.
   */
  usage?: UsageContext;
  /**
   * Streaming only. Set when onChunk deltas are shown to the user as final
   * output, which makes a mid-stream restart visibly duplicate text. Default
   * (unset) allows retrying a dropped connection mid-stream, because the current
   * callers use onChunk purely for progress indicators.
   */
  streamChunksAreFinal?: boolean;
  /**
   * Streaming only. Called before a retry attempt so the caller can discard the
   * partial chunks it accumulated — everything delivered so far is void.
   */
  onStreamRestart?: () => void;
  /**
   * Hands over the model's reasoning for this call, once, after it completes.
   *
   * Opus 5 thinks by default, and thinking is where the work actually happens:
   * a section rewrite came back as a confident one-line account of a redesign
   * with no HTML attached, having spent ~1,700 of its ~1,800 output tokens
   * reasoning. Asked why, the honest answer was "we cannot tell" — the
   * reasoning was in the response object and we dropped it on the floor.
   *
   * Opt-in rather than always logged, because on a normal call it is a large
   * block of text nobody reads. Callers take it, hold it, and print it only on
   * the path where the reply turned out to be unusable.
   */
  onThinking?: (thinking: string) => void;
}

/**
 * Thrown when the provider stops generating because it hit maxTokens rather
 * than finishing naturally. The text collected so far is always a truncated,
 * mid-object fragment — callers must not attempt to JSON.parse it and should
 * surface a distinct "response too large" message instead of a generic parse
 * error.
 */
export class AIResponseTruncatedError extends Error {
  constructor(public readonly outputTokens: number, public readonly maxTokens: number) {
    super(`AI response was truncated at maxTokens (output=${outputTokens}, max=${maxTokens})`);
    this.name = 'AIResponseTruncatedError';
  }
}

// Which provider actually answers askAI() calls. Default is "anthropic" so
// existing production behavior is unchanged unless someone deliberately
// opts in to another provider (e.g. AI_PROVIDER=openai-compatible to point
// at a local Ollama model for dev/testing without spending API credits).
const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();

let anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set');
    // 15-min timeout: large full-page rewrites (32K output on a big page) can
    // run past the SDK/undici default (~5 min → "HTTP/2 stream timeout after
    // 300000"), which terminated long edits mid-stream. Streaming keeps the
    // connection active; this just lifts the hard ceiling.
    anthropicClient = new Anthropic({ apiKey, timeout: 15 * 60 * 1000, maxRetries: 1 });
  }
  return anthropicClient;
}

// Dead code — OpenAI-compatible text adapter (AI_PROVIDER=openai-compatible).
// AI_PROVIDER is not set in production so this path is never reached.
// Kept for future use if we ever want to test with a local Ollama or similar.
// let openaiTextClient: OpenAI | null = null;
// function getOpenAICompatibleClient(): OpenAI { ... }

let openaiImageClient: OpenAI | null = null;
function getOpenAIImageClient(): OpenAI {
  if (!openaiImageClient) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is not set');
    openaiImageClient = new OpenAI({ apiKey });
    // console.log('[getOpenAIImageClient] key prefix:', apiKey.slice(0, 12), '| baseURL:', openaiImageClient.baseURL);
  }
  return openaiImageClient;
}

function toAnthropicContent(content: AIContent): string | Anthropic.Messages.ContentBlockParam[] {
  if (typeof content === 'string') return content;
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text' as const, text: block.text };
    if (block.type === 'image_base64') return { type: 'image' as const, source: { type: 'base64' as const, media_type: block.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: block.data } };
    return { type: 'image' as const, source: { type: 'url' as const, url: block.url } };
  });
}

/** How many times to try a single AI call when the Anthropic TCP stream drops. */
const AI_TRANSIENT_MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True for the flaky undici / Anthropic wire failures we see in production
 * (`TypeError: terminated`, `UND_ERR_SOCKET`, "other side closed") — the
 * connection died, the request itself was fine. Never true for truncation,
 * auth, or ordinary 4xx API errors.
 */
export function isTransientAIConnectionError(err: unknown): boolean {
  if (err == null) return false;
  if (err instanceof AIResponseTruncatedError) return false;

  // Anthropic SDK APIError — only retry overload / upstream blips, never 4xx
  // (except 429, which is transient rate limiting).
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number') {
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529) {
      return true;
    }
    if (status >= 400 && status < 500) return false;
  }

  const TRANSIENT_CODE = /^(UND_ERR_SOCKET|ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)$/;
  const TRANSIENT_MSG = /terminated|other side closed|socket hang up|connection error|network error|fetch failed|econnreset|etimedout/i;

  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const obj = current as { message?: unknown; code?: unknown; name?: unknown; cause?: unknown };
    const message = typeof obj.message === 'string' ? obj.message : '';
    const code = typeof obj.code === 'string' ? obj.code : '';
    if (TRANSIENT_CODE.test(code) || TRANSIENT_MSG.test(message)) return true;
    // undici wraps the real SocketError under `.cause`
    current = obj.cause;
  }
  return false;
}

/**
 * True for Anthropic's "prompt is too long" / context-limit 400s — the
 * request itself was fine, the combined system+messages payload just
 * exceeded the model's context window (seen in practice on full-page
 * fallback calls for large/bloated pages). Callers use this to show a
 * specific, actionable message instead of a generic error.
 */
export function isPromptTooLongError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: unknown }).status;
  if (status !== 400) return false;
  const message = typeof (err as { message?: unknown }).message === 'string'
    ? (err as { message: string }).message
    : '';
  return /prompt is too long|exceed(?:s)? context limit|maximum context length|input length and max_tokens/i.test(message);
}

/**
 * Maps known AI / transport failures to short, user-facing copy.
 * Prefer this over a generic "Internal server error" in SSE/API handlers.
 */
export function userFacingAIErrorMessage(err: unknown): string {
  if (err instanceof AIResponseTruncatedError) {
    return 'Your instruction asked for more content than we can generate in one pass. Try a smaller or more specific edit.';
  }
  if (isPromptTooLongError(err)) {
    return 'This page is too large for a full-page edit. Try a more specific change (name the section or quote the text to change), or split the request into smaller edits.';
  }
  if (isTransientAIConnectionError(err)) {
    const status = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
    if (status === 429) {
      return 'Too many AI requests right now. Please wait a moment and try again.';
    }
    if (status === 503 || status === 529) {
      return 'The AI service is busy right now. Please try again in a moment.';
    }
    return 'The connection to the AI service dropped before the edit finished. Please try again.';
  }
  return 'Something went wrong while applying your edit. Please try again.';
}

async function askAnthropic(options: AskAIOptions): Promise<string> {
  const anthropic = getAnthropicClient();
  const model = options.model ?? process.env.ANTHROPIC_MODEL?.trim() ?? 'claude-opus-5';
  const callId = `${options.label}:${Date.now().toString(36)}`;
  const startedAt = Date.now();

  // Stream + collect the final message instead of a plain non-streaming
  // `.create()` call. At the max_tokens these routes use (8192/16000 for
  // build/follow-up), a non-streaming request risks hitting the SDK's HTTP
  // timeout before the full response arrives — streaming has no such
  // ceiling. Callers here still just get the final text back, unchanged.
  // Safe to retry the whole attempt: nothing is returned to the caller until
  // success, so a dropped Anthropic socket never leaks partial text.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= AI_TRANSIENT_MAX_ATTEMPTS; attempt++) {
    console.log(`[ai-client start] callId=${callId} label=${options.label} model=${model} maxTokens=${options.maxTokens} stream=false attempt=${attempt}/${AI_TRANSIENT_MAX_ATTEMPTS}`);
    try {
      const stream = anthropic.messages.stream({
        model,
        max_tokens: options.maxTokens,
        // These system prompts (section vocabulary, motion-safety rules) are
        // large and byte-identical across every generate/build/follow-up call.
        // Marking the block cacheable means repeat calls within the same
        // editing session pay ~10x less for it instead of full price every time.
        system: [{ type: 'text', text: options.system, cache_control: { type: 'ephemeral' } }],
        messages: options.messages.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
      });
      const response = await stream.finalMessage();

      const { input_tokens, output_tokens } = response.usage;
      // Meter usage centrally (before any truncation throw, so truncated calls
      // still count — we paid for those tokens). Fire-and-forget; never blocks.
      if (options.usage) void recordAiUsage(options.usage, model, input_tokens, output_tokens);
      console.log(`[AI tokens] callId=${callId} label=${options.label} elapsedMs=${Date.now() - startedAt} input=${input_tokens} output=${output_tokens} total=${input_tokens + output_tokens} model=${model} maxTokens=${options.maxTokens} stop_reason=${response.stop_reason} attempt=${attempt}`);
      // Before the truncation throw below: a call that ran out of room is
      // exactly one whose reasoning a caller may want to see.
      options.onThinking?.(thinkingText(response.content));

      if (response.stop_reason === 'max_tokens') {
        await logEvent('ai_call', 'warn', 'response truncated at maxTokens', {
          callId, label: options.label, model, elapsedMs: Date.now() - startedAt,
          inputTokens: input_tokens, outputTokens: output_tokens, maxTokens: options.maxTokens, attempt,
        });
        throw new AIResponseTruncatedError(output_tokens, options.maxTokens);
      }

      // Claude Opus 5 runs adaptive thinking by default (no `thinking` param
      // needed to trigger it), which puts a `thinking` block ahead of the
      // `text` block in `content` — content[0] is no longer reliably the answer.
      const block = response.content.find((b) => b.type === 'text');
      if (!block) {
        throw new Error(`No text block in Anthropic response (block types: ${response.content.map((b) => b.type).join(', ')})`);
      }
      await logEvent('ai_call', 'info', 'success', {
        callId, label: options.label, model, elapsedMs: Date.now() - startedAt,
        inputTokens: input_tokens, outputTokens: output_tokens, maxTokens: options.maxTokens,
        stopReason: response.stop_reason, attempt,
      });
      return block.text;
    } catch (err) {
      lastErr = err;
      if (err instanceof AIResponseTruncatedError) throw err;
      const retryable = isTransientAIConnectionError(err) && attempt < AI_TRANSIENT_MAX_ATTEMPTS;
      console.error(`[ai-client error] callId=${callId} label=${options.label} model=${model} elapsedMs=${Date.now() - startedAt} attempt=${attempt} retryable=${retryable}`, err);
      await logEvent('ai_call', retryable ? 'warn' : 'error', retryable ? 'transient error, retrying' : 'call failed', {
        callId, label: options.label, model, elapsedMs: Date.now() - startedAt, attempt, retryable,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      if (!retryable) throw err;
      const backoffMs = 1000 * attempt;
      console.warn(`[ai-client retry] callId=${callId} label=${options.label} attempt=${attempt}/${AI_TRANSIENT_MAX_ATTEMPTS} backoffMs=${backoffMs} reason=transient-connection`);
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

/**
 * The model's reasoning blocks, joined. Empty string when it did not think.
 *
 * Typed loosely on purpose: `thinking` blocks are a newer addition to the SDK's
 * content union, and this must not stop compiling on a version that predates
 * them or renames the field. A missing block is simply no reasoning to report.
 */
function thinkingText(content: ReadonlyArray<{ type: string }>): string {
  return content
    .map((b) => {
      const rec = b as { type: string; thinking?: unknown };
      return rec.type === 'thinking' && typeof rec.thinking === 'string' ? rec.thinking : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

async function askAnthropicStream(options: AskAIOptions, onChunk: (text: string) => void): Promise<string> {
  const anthropic = getAnthropicClient();
  const model = options.model ?? process.env.ANTHROPIC_MODEL?.trim() ?? 'claude-opus-5';
  const callId = `${options.label}:${Date.now().toString(36)}`;
  const startedAt = Date.now();

  // Retry ONLY when zero text_delta chunks were delivered to onChunk.
  // If we already streamed partial tokens to the client (follow-up/build SSE),
  // retrying would duplicate that text in the UI — so we fail closed instead.
  // The production schema-from-html failure mode is exactly zero chunks +
  // undici "terminated" / "other side closed", which is safe to retry.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= AI_TRANSIENT_MAX_ATTEMPTS; attempt++) {
    console.log(`[ai-client start] callId=${callId} label=${options.label} model=${model} maxTokens=${options.maxTokens} stream=true attempt=${attempt}/${AI_TRANSIENT_MAX_ATTEMPTS}`);

    const stream = anthropic.messages.stream({
      model,
      max_tokens: options.maxTokens,
      system: [{ type: 'text', text: options.system, cache_control: { type: 'ephemeral' } }],
      messages: options.messages.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
    });

    let fullText = '';
    let firstChunkAt: number | null = null;
    let chunkCount = 0;
    try {
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          if (firstChunkAt === null) {
            firstChunkAt = Date.now();
            console.log(`[ai-client first-chunk] callId=${callId} label=${options.label} timeToFirstChunkMs=${firstChunkAt - startedAt} attempt=${attempt}`);
          }
          chunkCount += 1;
          onChunk(event.delta.text);
          fullText += event.delta.text;
        }
      }

      if (firstChunkAt === null) {
        console.warn(`[ai-client warn] callId=${callId} label=${options.label} stream ended with zero text_delta chunks — elapsedMs=${Date.now() - startedAt} attempt=${attempt}`);
      }

      const response = await stream.finalMessage();
      const { input_tokens, output_tokens } = response.usage;
      // Meter usage centrally (before any truncation throw, so truncated calls
      // still count — we paid for those tokens). Fire-and-forget; never blocks.
      if (options.usage) void recordAiUsage(options.usage, model, input_tokens, output_tokens);
      console.log(`[AI tokens stream] callId=${callId} label=${options.label} elapsedMs=${Date.now() - startedAt} chunks=${chunkCount} input=${input_tokens} output=${output_tokens} total=${input_tokens + output_tokens} model=${model} maxTokens=${options.maxTokens} stop_reason=${response.stop_reason} attempt=${attempt}`);
      // Before the truncation throw below: a call that ran out of room is
      // exactly one whose reasoning a caller may want to see.
      options.onThinking?.(thinkingText(response.content));

      if (response.stop_reason === 'max_tokens') {
        await logEvent('ai_call', 'warn', 'response truncated at maxTokens', {
          callId, label: options.label, model, elapsedMs: Date.now() - startedAt, chunks: chunkCount,
          inputTokens: input_tokens, outputTokens: output_tokens, maxTokens: options.maxTokens, attempt,
        });
        throw new AIResponseTruncatedError(output_tokens, options.maxTokens);
      }

      await logEvent('ai_call', 'info', 'success', {
        callId, label: options.label, model, elapsedMs: Date.now() - startedAt, chunks: chunkCount,
        inputTokens: input_tokens, outputTokens: output_tokens, maxTokens: options.maxTokens,
        stopReason: response.stop_reason, attempt,
      });
      return fullText;
    } catch (err) {
      lastErr = err;
      if (err instanceof AIResponseTruncatedError) throw err;
      // A connection that dies mid-stream is still retryable: onChunk carries
      // cosmetic progress (STATUS comments, the one-shot "thinking" line), never
      // the answer — that is the return value, and a restart rebuilds it from
      // scratch. Losing a whole page build to one ECONNRESET at chunk 20 is a
      // far worse outcome than a repeated progress message. Callers that render
      // raw deltas to the user opt out with streamChunksAreFinal.
      const midStream = chunkCount > 0;
      const retryable =
        isTransientAIConnectionError(err) &&
        (!midStream || !options.streamChunksAreFinal) &&
        attempt < AI_TRANSIENT_MAX_ATTEMPTS;
      console.error(
        `[ai-client error] callId=${callId} label=${options.label} model=${model} elapsedMs=${Date.now() - startedAt} chunksReceived=${chunkCount} gotFirstChunk=${firstChunkAt !== null} attempt=${attempt} retryable=${retryable}`,
        err,
      );
      await logEvent('ai_call', retryable ? 'warn' : 'error', retryable ? 'transient error, retrying' : 'call failed', {
        callId, label: options.label, model, elapsedMs: Date.now() - startedAt, chunksReceived: chunkCount,
        gotFirstChunk: firstChunkAt !== null, attempt, retryable,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      if (!retryable) throw err;
      const backoffMs = 1000 * attempt;
      console.warn(`[ai-client retry] callId=${callId} label=${options.label} attempt=${attempt}/${AI_TRANSIENT_MAX_ATTEMPTS} backoffMs=${backoffMs} chunksDiscarded=${chunkCount} reason=${midStream ? 'transient-connection-mid-stream' : 'transient-connection-before-first-chunk'}`);
      options.onStreamRestart?.();
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

/**
 * Generates a single image from a text prompt (gpt-image-1) and uploads it to
 * Supabase Storage. Returns the public URL, or null if generation/upload
 * failed — callers decide how to handle that (skip, fall back, etc.).
 */
export async function generateAndUploadImage(
  prompt: string,
  pageSlug: string,
  quality: 'low' | 'medium' | 'high' = 'low',
): Promise<string | null> {
  const startedAt = Date.now();
  console.log(`[generateAndUploadImage start] pageSlug=${pageSlug} quality=${quality} prompt="${prompt.slice(0, 60)}…"`);
  try {
    const openai = getOpenAIImageClient();
    const result = await openai.images.generate({
      model: 'gpt-image-1',
      prompt,
      n: 1,
      size: '1024x1024',
      quality,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const item = result.data?.[0] as Record<string, unknown> | undefined;
    if (!item) return null;

    let buffer: ArrayBuffer;
    let mimeType = 'image/png';
    let ext = 'png';

    if (typeof item.url === 'string') {
      // URL response — fetch buffer immediately (URLs expire in ~1hr)
      const imgRes = await fetch(item.url);
      if (!imgRes.ok) return null;
      buffer = await imgRes.arrayBuffer();
      const ct = imgRes.headers.get('content-type') ?? '';
      if (ct.includes('webp')) { mimeType = 'image/webp'; ext = 'webp'; }
      else if (ct.includes('jpeg') || ct.includes('jpg')) { mimeType = 'image/jpeg'; ext = 'jpg'; }
    } else if (typeof item.b64_json === 'string') {
      // Base64 response
      const bytes = Buffer.from(item.b64_json, 'base64');
      buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    } else {
      return null;
    }

    const publicUrl = await uploadImage(pageSlug, buffer, mimeType, ext);
    console.log(`[generateAndUploadImage] uploaded image for prompt: "${prompt.slice(0, 60)}…" elapsedMs=${Date.now() - startedAt}`);
    await logEvent('ai_call', 'info', 'image generated', {
      label: 'generateAndUploadImage', pageSlug, quality, elapsedMs: Date.now() - startedAt,
    });
    return publicUrl;
  } catch (err) {
    const e = err as Record<string, unknown>;
    console.error('[generateAndUploadImage] image failed:', {
      message: (err as Error).message,
      status: e.status,
      type: e.type,
      code: e.code,
      elapsedMs: Date.now() - startedAt,
    });
    await logEvent('ai_call', 'error', 'image generation failed', {
      label: 'generateAndUploadImage', pageSlug, quality, elapsedMs: Date.now() - startedAt,
      errorMessage: (err as Error).message, status: e.status, type: e.type, code: e.code,
    });
    return null;
  }
}

/**
 * Walks a schema object, collects every node that has an image_prompt field
 * (up to 8), calls DALL-E 3 for each in parallel, uploads the result to
 * Supabase Storage, and injects generated_image_url back onto the same node.
 * Failures per image are swallowed — one bad DALL-E call never fails the build.
 */
export async function generatePageImages(
  schema: Record<string, unknown>,
  pageSlug: string,
  onImageReady?: (url: string) => void,
): Promise<Record<string, unknown>> {
  const jobs: Array<{ obj: Record<string, unknown>; prompt: string }> = [];

  function collect(node: unknown) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    const o = node as Record<string, unknown>;
    if (typeof o.image_prompt === 'string' && o.image_prompt && !o.generated_image_url) {
      jobs.push({ obj: o, prompt: o.image_prompt });
    }
    Object.values(o).forEach(collect);
  }
  collect(schema);

  const capped = jobs.slice(0, 8);
  console.log(`[generatePageImages] generating ${capped.length} image(s) for page ${pageSlug}`);
  const startedAt = Date.now();

  await Promise.all(
    capped.map(async ({ obj, prompt }) => {
      // Medium quality for create builds — low was a common client complaint
      // on first-paint pages. Edit-time image_generate still picks its own quality.
      const publicUrl = await generateAndUploadImage(prompt, pageSlug, 'high');
      if (!publicUrl) return;
      obj.generated_image_url = publicUrl;
      onImageReady?.(publicUrl);
    }),
  );

  console.log(`[generatePageImages] done for page ${pageSlug} elapsedMs=${Date.now() - startedAt}`);
  return schema;
}

const _rateLimitLog = new Map<string, number[]>();

/**
 * Returns true if the user has exceeded the allowed call rate.
 * Uses an in-memory sliding window — resets on server restart.
 */
export function isRateLimited(userId: string, maxCalls: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (_rateLimitLog.get(userId) ?? []).filter(t => now - t < windowMs);
  if (recent.length >= maxCalls) {
    _rateLimitLog.set(userId, recent);
    return true;
  }
  _rateLimitLog.set(userId, [...recent, now]);
  return false;
}

/**
 * Single entry point every AI page-builder route calls instead of touching
 * a provider SDK directly. Which provider actually runs is decided by
 * AI_PROVIDER (default: Anthropic) — adding/swapping providers is a .env
 * change only; callers never need to change.
 */
export async function askAI(options: AskAIOptions): Promise<string> {
  if (PROVIDER !== 'anthropic') {
    throw new Error(`AI_PROVIDER="${PROVIDER}" is not supported. Only "anthropic" is active in production.`);
  }
  return askAnthropic(options);
}

/**
 * Streaming variant of askAI. Calls onChunk for each text_delta token as it
 * arrives, then returns the full accumulated text. Retries transient
 * Anthropic connection drops only when no chunks have been delivered yet
 * (avoids duplicating partial SSE text to the client).
 */
export async function askAIStream(
  options: AskAIOptions,
  onChunk: (text: string) => void,
): Promise<string> {
  if (PROVIDER !== 'anthropic') {
    throw new Error(`AI_PROVIDER="${PROVIDER}" is not supported. Only "anthropic" is active in production.`);
  }
  return askAnthropicStream(options, onChunk);
}
