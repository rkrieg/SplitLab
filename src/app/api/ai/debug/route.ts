import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import Anthropic from '@anthropic-ai/sdk';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = process.env.ANTHROPIC_API_KEY;
  const trimmed = raw?.trim();

  const diagnostics: Record<string, unknown> = {
    key_exists: !!raw,
    key_length: raw?.length ?? 0,
    trimmed_length: trimmed?.length ?? 0,
    has_whitespace: raw !== trimmed,
    starts_with_sk: trimmed?.startsWith('sk-') ?? false,
    prefix: trimmed ? trimmed.slice(0, 12) + '...' : 'N/A',
    has_quotes: trimmed?.startsWith('"') || trimmed?.startsWith("'") || false,
    sdk_version: '0.78.0',
  };

  // Try a minimal API call
  if (trimmed) {
    try {
      const client = new Anthropic({ apiKey: trimmed });
      const res = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say "ok"' }],
      });
      diagnostics.api_test = 'SUCCESS';
      diagnostics.api_response = res.content[0];
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string; error?: unknown };
      diagnostics.api_test = 'FAILED';
      diagnostics.api_status = e.status;
      diagnostics.api_error = e.message;
    }
  }

  return NextResponse.json(diagnostics);
}
