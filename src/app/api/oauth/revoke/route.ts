import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { hashToken } from '@/lib/mcp/tokens';

async function readBody(request: NextRequest): Promise<Record<string, string>> {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return await request.json();
  const form = await request.formData();
  const out: Record<string, string> = {};
  form.forEach((v, k) => { out[k] = String(v); });
  return out;
}

// RFC 7009 token revocation — accepts either an access or refresh token and
// revokes the whole pair, so a user (or Claude itself on disconnect) can
// immediately cut off access without waiting for natural expiry.
export async function POST(request: NextRequest) {
  const body = await readBody(request);
  const { token } = body;
  if (!token) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const hash = hashToken(token);
  const nowIso = new Date().toISOString();

  await db.from('oauth_tokens').update({ revoked_at: nowIso }).eq('access_token_hash', hash);
  await db.from('oauth_tokens').update({ revoked_at: nowIso }).eq('refresh_token_hash', hash);

  // RFC 7009: always return 200, even if the token was unknown/already revoked.
  return NextResponse.json({}, { status: 200 });
}
