import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is not set");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

export async function ask(
  prompt: string,
  options?: {
    system?: string;
    maxTokens?: number;
    model?: string;
  }
): Promise<string> {
  const anthropic = getClient();

  // Use streaming to avoid 10-minute timeout on long-running requests
  const stream = anthropic.messages.stream({
    model: options?.model ?? "claude-sonnet-4-20250514",
    max_tokens: options?.maxTokens ?? 1024,
    ...(options?.system ? { system: options.system } : {}),
    messages: [{ role: "user", content: prompt }],
  });

  const response = await stream.finalMessage();

  const block = response.content[0];
  if (block.type === "text") {
    return block.text;
  }
  throw new Error(`Unexpected response block type: ${block.type}`);
}

export { getClient };
