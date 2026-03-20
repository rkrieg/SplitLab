const STITCH_URL = process.env.STITCH_HOST || 'https://stitch.googleapis.com/mcp';

function getApiKey(): string {
  const key = process.env.STITCH_API_KEY?.trim();
  if (!key) {
    throw new Error('STITCH_API_KEY environment variable is not set');
  }
  return key;
}

interface StitchRpcResponse {
  jsonrpc: string;
  id: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
  };
  error?: { code: number; message: string };
}

async function callStitch(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(STITCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Goog-Api-Key': getApiKey(),
    },
    body: JSON.stringify({
      method: 'tools/call',
      jsonrpc: '2.0',
      params: { name: toolName, arguments: args },
      id: 1,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => `Status ${response.status}`);
    throw new Error(`Stitch API error (${response.status}): ${errorText}`);
  }

  const data: StitchRpcResponse = await response.json();
  if (data.error) {
    throw new Error(`Stitch RPC error: ${data.error.message}`);
  }

  // MCP tools/call returns result.content array with text entries
  const textContent = data.result?.content?.find((c) => c.type === 'text');
  if (textContent?.text) {
    try {
      return JSON.parse(textContent.text);
    } catch {
      return textContent.text;
    }
  }

  return data.result;
}

interface StitchScreen {
  id: string;
  name: string;
  htmlCode?: { downloadUrl: string };
  screenshot?: { downloadUrl: string };
  prompt?: string;
}

interface StitchProject {
  name: string;
  projectId: string;
}

interface GenerateResult {
  screens: StitchScreen[];
  projectId: string;
  sessionId: string;
}

export async function createProject(title: string): Promise<StitchProject> {
  const result = (await callStitch('create_project', { title })) as Record<string, unknown>;
  const name = result.name as string;
  // Extract project ID from "projects/123456"
  const projectId = name.replace('projects/', '');
  return { name, projectId };
}

export async function generateScreen(
  projectId: string,
  prompt: string,
  options?: { deviceType?: string; modelId?: string }
): Promise<GenerateResult> {
  const result = (await callStitch('generate_screen_from_text', {
    projectId,
    prompt,
    deviceType: options?.deviceType || 'DESKTOP',
    modelId: options?.modelId || 'GEMINI_3_1_PRO',
  })) as Record<string, unknown>;

  // The response structure has outputComponents with design.screens
  const outputComponents = result.outputComponents as Array<Record<string, unknown>> | undefined;
  const designComponent = outputComponents?.find((c) => c.design);
  const design = designComponent?.design as Record<string, unknown> | undefined;
  const screens = (design?.screens as StitchScreen[]) || [];

  return {
    screens,
    projectId: (result.projectId as string) || projectId,
    sessionId: (result.sessionId as string) || '',
  };
}

export async function downloadScreenHtml(downloadUrl: string): Promise<string> {
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download Stitch HTML: ${response.status}`);
  }
  return response.text();
}
