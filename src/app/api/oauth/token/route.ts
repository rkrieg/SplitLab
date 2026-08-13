import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { generateToken, hashToken, verifyPkce } from '@/lib/mcp/tokens';

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d

async function readBody(request: NextRequest): Promise<Record<string, string>> {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await request.json();
  }
  const form = await request.formData();
  const out: Record<string, string> = {};
  form.forEach((v, k) => { out[k] = String(v); });
  return out;
}

function tokenErrorResponse(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

async function issueTokenPair(clientId: string, userId: string, scope: string) {
  const accessToken = generateToken('mcp_at');
  const refreshToken = generateToken('mcp_rt');
  const now = Date.now();

  const { data: row, error } = await db
    .from('oauth_tokens')
    .insert({
      access_token_hash: hashToken(accessToken),
      refresh_token_hash: hashToken(refreshToken),
      client_id: clientId,
      user_id: userId,
      scope,
      expires_at: new Date(now + ACCESS_TOKEN_TTL_MS).toISOString(),
      refresh_expires_at: new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(),
    })
    .select('id')
    .single();

  if (error || !row) return null;

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    refresh_token: refreshToken,
    scope,
  };
}

export async function POST(request: NextRequest) {
  let body: Record<string, string>;
  try {
    body = await readBody(request);
  } catch {
    return tokenErrorResponse('invalid_request');
  }

  const grantType = body.grant_type;

  if (grantType === 'authorization_code') {
    const { code, redirect_uri, client_id, code_verifier } = body;
    if (!code || !redirect_uri || !client_id || !code_verifier) return tokenErrorResponse('invalid_request');

    const { data: authCode } = await db
      .from('oauth_authorization_codes')
      .select('*')
      .eq('code', code)
      .single();

    if (!authCode) return tokenErrorResponse('invalid_grant');
    if (authCode.consumed_at) return tokenErrorResponse('invalid_grant'); // single-use
    if (new Date(authCode.expires_at).getTime() < Date.now()) return tokenErrorResponse('invalid_grant');
    if (authCode.client_id !== client_id) return tokenErrorResponse('invalid_grant');
    if (authCode.redirect_uri !== redirect_uri) return tokenErrorResponse('invalid_grant');
    if (!verifyPkce(code_verifier, authCode.code_challenge)) return tokenErrorResponse('invalid_grant');

    // Mark consumed before issuing tokens so a retry/replay can't double-spend the code.
    await db.from('oauth_authorization_codes').update({ consumed_at: new Date().toISOString() }).eq('code', code);

    const tokens = await issueTokenPair(client_id, authCode.user_id, authCode.scope);
    if (!tokens) return tokenErrorResponse('server_error', 500);
    return NextResponse.json(tokens);
  }

  if (grantType === 'refresh_token') {
    const { refresh_token, client_id } = body;
    if (!refresh_token || !client_id) return tokenErrorResponse('invalid_request');

    const refreshHash = hashToken(refresh_token);
    const { data: tokenRow } = await db
      .from('oauth_tokens')
      .select('*')
      .eq('refresh_token_hash', refreshHash)
      .single();

    if (!tokenRow) return tokenErrorResponse('invalid_grant');
    if (tokenRow.revoked_at) return tokenErrorResponse('invalid_grant');
    if (tokenRow.client_id !== client_id) return tokenErrorResponse('invalid_grant');
    if (tokenRow.refresh_expires_at && new Date(tokenRow.refresh_expires_at).getTime() < Date.now()) {
      return tokenErrorResponse('invalid_grant');
    }

    // Rotate: revoke the old pair, issue a fresh one.
    await db.from('oauth_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', tokenRow.id);

    const tokens = await issueTokenPair(client_id, tokenRow.user_id, tokenRow.scope);
    if (!tokens) return tokenErrorResponse('server_error', 500);
    return NextResponse.json(tokens);
  }

  return tokenErrorResponse('unsupported_grant_type');
}
