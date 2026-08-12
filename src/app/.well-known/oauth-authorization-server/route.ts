import { NextResponse } from 'next/server';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

// RFC 8414 authorization server metadata — lets MCP clients (Claude
// Desktop/Code/claude.ai, ChatGPT) auto-discover the OAuth endpoints instead
// of needing them hardcoded, when they resolve this off SplitLab's origin.
export async function GET() {
  return NextResponse.json({
    issuer: APP_URL,
    authorization_endpoint: `${APP_URL}/api/oauth/authorize`,
    token_endpoint: `${APP_URL}/api/oauth/token`,
    registration_endpoint: `${APP_URL}/api/oauth/register`,
    revocation_endpoint: `${APP_URL}/api/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  });
}
