import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const raw = process.env.ANTHROPIC_API_KEY;
  const trimmed = raw?.trim();

  const diagnostics: Record<string, unknown> = {
    key_exists: !!raw,
    key_length: raw?.length ?? 0,
    trimmed_length: trimmed?.length ?? 0,
    has_whitespace: raw !== trimmed,
    starts_with_sk: trimmed?.startsWith('sk-') ?? false,
    // Show first 20 chars so we can verify it's the right key
    prefix: trimmed ? trimmed.slice(0, 20) + '...' : 'N/A',
    suffix: trimmed ? '...' + trimmed.slice(-6) : 'N/A',
    has_quotes: trimmed?.startsWith('"') || trimmed?.startsWith("'") || false,
  };

  // Try raw fetch (bypass SDK entirely)
  if (trimmed) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': trimmed,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Say ok' }],
        }),
      });
      const data = await res.json();
      diagnostics.raw_fetch_status = res.status;
      diagnostics.raw_fetch_ok = res.ok;
      if (res.ok) {
        diagnostics.api_test = 'SUCCESS';
        diagnostics.api_response = data.content?.[0];
      } else {
        diagnostics.api_test = 'FAILED';
        diagnostics.api_error = data;
      }
    } catch (err: unknown) {
      diagnostics.api_test = 'FETCH_ERROR';
      diagnostics.api_error = (err as Error).message;
    }
  }

  return NextResponse.json(diagnostics);
}
