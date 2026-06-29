import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

/**
 * Provider-agnostic content shape used by every AI page-builder route.
 * Each adapter below translates this into its own wire format — callers
 * never construct Anthropic- or OpenAI-shaped blocks directly, so adding a
 * new provider later never requires touching the route files.
 */
export type AIContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string };

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

let openaiClient: OpenAI | null = null;
function getOpenAICompatibleClient(): OpenAI {
  if (!openaiClient) {
    // This adapter is provider-agnostic — it works with any backend that
    // speaks the OpenAI wire format (Gemini, Groq, Together, Ollama, vLLM,
    // OpenRouter, OpenAI's own API, ...), all selected purely by AI_BASE_URL.
    // OpenAI's own API is the ONLY one that can leave AI_BASE_URL unset, and only
    // because the `openai` npm package itself happens to default to
    // https://api.openai.com/v1 when no baseURL is given — that's a quirk of
    // the package, not special treatment on our end. Every other provider
    // (including Gemini, via https://generativelanguage.googleapis.com/v1beta/openai/)
    // must set AI_BASE_URL explicitly since nothing else has a built-in default.
    const baseURL = process.env.AI_BASE_URL?.trim() || undefined;
    // Local providers (e.g. Ollama) don't check the key at all — any
    // non-empty string works. Every hosted provider (OpenAI's own API, Gemini,
    // Groq, Together, OpenRouter, etc.) needs a real key here.
    const apiKey = process.env.AI_API_KEY?.trim() || 'not-needed';
    openaiClient = new OpenAI({ apiKey, baseURL });
  }
  return openaiClient;
}

function toAnthropicContent(content: AIContent): string | Anthropic.Messages.ContentBlockParam[] {
  if (typeof content === 'string') return content;
  return content.map((block) =>
    block.type === 'text'
      ? { type: 'text' as const, text: block.text }
      : { type: 'image' as const, source: { type: 'url' as const, url: block.url } }
  );
}

function toOpenAIContent(content: AIContent): string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> {
  if (typeof content === 'string') return content;
  return content.map((block) =>
    block.type === 'text'
      ? { type: 'text' as const, text: block.text }
      : { type: 'image_url' as const, image_url: { url: block.url } }
  );
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
  const block = response.content[0];
  if (block.type !== 'text') {
    throw new Error(`Unexpected response block type from Anthropic: ${block.type}`);
  }
  return block.text;
}

async function askOpenAICompatible(options: AskAIOptions): Promise<string> {
  const openai = getOpenAICompatibleClient();
  const model = options.model ?? process.env.AI_MODEL?.trim();
  if (!model) {
    throw new Error('AI_MODEL environment variable is not set (required when AI_PROVIDER is not "anthropic")');
  }

  // Chat Completions has no separate system-prompt field — it's a
  // role:"system" entry placed ahead of the conversation history.
  // Cast needed because TS can't verify a single mapped object with a
  // union-typed `role` field structurally matches OpenAI's discriminated
  // ChatCompletionMessageParam union — safe here since our app never puts
  // image content on an assistant-role history entry.
  const response = await openai.chat.completions.create({
    model,
    max_tokens: options.maxTokens,
    messages: [
      { role: 'system', content: options.system },
      ...options.messages.map((m) => ({ role: m.role, content: toOpenAIContent(m.content) })),
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  });

  const text = response.choices[0]?.message?.content;
  if (!text) {
    throw new Error('Unexpected empty response from OpenAI-compatible provider');
  }
  return text;
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
  return PROVIDER === 'anthropic' ? askAnthropic(options) : askOpenAICompatible(options);
}
