import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { generateClientId, generateToken, hashToken } from '@/lib/mcp/tokens';
import { z } from 'zod';

// Dynamic Client Registration (RFC 7591) — lets Claude Desktop/Code/claude.ai
// (or ChatGPT) self-register on first connect, without a manual developer
// portal step. Public clients (Claude Desktop, using PKCE) register with
// token_endpoint_auth_method: 'none' and get no secret; anything else gets
// one, returned once and never stored/returned again in plaintext.
const registerSchema = z.object({
  client_name: z.string().min(1).max(255),
  redirect_uris: z.array(z.string().url()).min(1),
  token_endpoint_auth_method: z.enum(['none', 'client_secret_post']).optional().default('none'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const data = registerSchema.parse(body);

    const clientId = generateClientId();
    let clientSecret: string | null = null;
    let clientSecretHash: string | null = null;

    if (data.token_endpoint_auth_method === 'client_secret_post') {
      clientSecret = generateToken('mcp_secret');
      clientSecretHash = hashToken(clientSecret);
    }

    const { error } = await db.from('oauth_clients').insert({
      id: clientId,
      client_secret_hash: clientSecretHash,
      client_name: data.client_name,
      redirect_uris: data.redirect_uris,
    });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json(
      {
        client_id: clientId,
        client_secret: clientSecret ?? undefined,
        client_name: data.client_name,
        redirect_uris: data.redirect_uris,
        token_endpoint_auth_method: data.token_endpoint_auth_method,
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
