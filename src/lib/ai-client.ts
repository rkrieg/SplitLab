import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { uploadImage } from '@/lib/storage';

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
    anthropicClient = new Anthropic({ apiKey });
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


async function askAnthropic(options: AskAIOptions): Promise<string> {
  const anthropic = getAnthropicClient();
  const model = options.model ?? process.env.ANTHROPIC_MODEL?.trim() ?? 'claude-sonnet-4-6';

  // Stream + collect the final message instead of a plain non-streaming
  // `.create()` call. At the max_tokens these routes use (8192/16000 for
  // build/follow-up), a non-streaming request risks hitting the SDK's HTTP
  // timeout before the full response arrives — streaming has no such
  // ceiling. Callers here still just get the final text back, unchanged.
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
  console.log(`[AI tokens] input=${input_tokens} output=${output_tokens} total=${input_tokens + output_tokens} model=${model} maxTokens=${options.maxTokens} stop_reason=${response.stop_reason}`);

  if (response.stop_reason === 'max_tokens') {
    throw new AIResponseTruncatedError(output_tokens, options.maxTokens);
  }

  const block = response.content[0];
  if (block.type !== 'text') {
    throw new Error(`Unexpected response block type from Anthropic: ${block.type}`);
  }
  return block.text;
}

async function askAnthropicStream(options: AskAIOptions, onChunk: (text: string) => void): Promise<string> {
  const anthropic = getAnthropicClient();
  const model = options.model ?? process.env.ANTHROPIC_MODEL?.trim() ?? 'claude-sonnet-4-6';

  const stream = anthropic.messages.stream({
    model,
    max_tokens: options.maxTokens,
    system: [{ type: 'text', text: options.system, cache_control: { type: 'ephemeral' } }],
    messages: options.messages.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
  });

  let fullText = '';
  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      onChunk(event.delta.text);
      fullText += event.delta.text;
    }
  }

  const response = await stream.finalMessage();
  const { input_tokens, output_tokens } = response.usage;
  console.log(`[AI tokens stream] input=${input_tokens} output=${output_tokens} total=${input_tokens + output_tokens} model=${model} maxTokens=${options.maxTokens} stop_reason=${response.stop_reason}`);

  if (response.stop_reason === 'max_tokens') {
    throw new AIResponseTruncatedError(output_tokens, options.maxTokens);
  }

  return fullText;
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

  await Promise.all(
    capped.map(async ({ obj, prompt }) => {
      try {
        const openai = getOpenAIImageClient();
        const result = await openai.images.generate({
          model: 'gpt-image-1',
          prompt,
          n: 1,
          size: '1024x1024',
          quality: 'low',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        const item = result.data?.[0] as Record<string, unknown> | undefined;
        if (!item) return;

        let buffer: ArrayBuffer;
        let mimeType = 'image/png';
        let ext = 'png';

        if (typeof item.url === 'string') {
          // URL response — fetch buffer immediately (URLs expire in ~1hr)
          const imgRes = await fetch(item.url);
          if (!imgRes.ok) return;
          buffer = await imgRes.arrayBuffer();
          const ct = imgRes.headers.get('content-type') ?? '';
          if (ct.includes('webp')) { mimeType = 'image/webp'; ext = 'webp'; }
          else if (ct.includes('jpeg') || ct.includes('jpg')) { mimeType = 'image/jpeg'; ext = 'jpg'; }
        } else if (typeof item.b64_json === 'string') {
          // Base64 response
          const bytes = Buffer.from(item.b64_json, 'base64');
          buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        } else {
          return;
        }

        const publicUrl = await uploadImage(pageSlug, buffer, mimeType, ext);
        obj.generated_image_url = publicUrl;
        onImageReady?.(publicUrl);
        console.log(`[generatePageImages] uploaded image for prompt: "${prompt.slice(0, 60)}…"`);
      } catch (err) {
        const e = err as Record<string, unknown>;
        console.error('[generatePageImages] image failed, skipping:', {
          message: (err as Error).message,
          status: e.status,
          type: e.type,
          code: e.code,
        });
      }
    }),
  );

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
 * arrives, then returns the full accumulated text. Does not modify askAI().
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
