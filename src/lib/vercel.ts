const VERCEL_API_BASE = 'https://api.vercel.com';

function getToken(): string {
  const token = process.env.VERCEL_API_TOKEN;
  if (!token) throw new Error('Missing VERCEL_API_TOKEN environment variable');
  return token;
}

function getProjectId(): string {
  const id = process.env.VERCEL_PROJECT_ID;
  if (!id) throw new Error('Missing VERCEL_PROJECT_ID environment variable');
  return id;
}

function headers(): HeadersInit {
  return {
    Authorization: `Bearer ${getToken()}`,
    'Content-Type': 'application/json',
  };
}

export async function addDomainToVercel(domain: string): Promise<void> {
  const res = await fetch(
    `${VERCEL_API_BASE}/v10/projects/${getProjectId()}/domains`,
    {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: domain }),
    }
  );

  // 409 = already exists on this project — idempotent success
  if (res.status === 409) return;

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Vercel API error (${res.status})`);
  }
}

export async function removeDomainFromVercel(domain: string): Promise<void> {
  const res = await fetch(
    `${VERCEL_API_BASE}/v9/projects/${getProjectId()}/domains/${domain}`,
    {
      method: 'DELETE',
      headers: headers(),
    }
  );

  // 404 = already gone — idempotent success
  if (res.status === 404) return;

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Vercel API error (${res.status})`);
  }
}

export interface DomainStatus {
  verified: boolean;
  status: 'valid' | 'pending_verification' | 'misconfigured';
  message: string;
}

export async function getDomainStatus(domain: string): Promise<DomainStatus> {
  // Step 1: Trigger Vercel's verify check
  const verifyRes = await fetch(
    `${VERCEL_API_BASE}/v9/projects/${getProjectId()}/domains/${domain}/verify`,
    { method: 'POST', headers: headers() }
  );

  if (verifyRes.status === 404) {
    return {
      verified: false,
      status: 'misconfigured',
      message: 'Domain not found in Vercel project. Try removing and re-adding it.',
    };
  }

  if (verifyRes.ok) {
    const data = await verifyRes.json();
    if (data.domain?.verified === true || data.verified === true) {
      return {
        verified: true,
        status: 'valid',
        message: 'Domain is verified and serving traffic.',
      };
    }
  }

  // Step 2: Check DNS config for more detail
  const configRes = await fetch(
    `${VERCEL_API_BASE}/v6/domains/${domain}/config`,
    { method: 'GET', headers: headers() }
  );

  if (configRes.ok) {
    const config = await configRes.json();
    if (config.misconfigured === true) {
      return {
        verified: false,
        status: 'misconfigured',
        message: 'DNS records not configured correctly. Ensure CNAME points to cname.vercel-dns.com.',
      };
    }
  }

  return {
    verified: false,
    status: 'pending_verification',
    message: 'DNS records detected. Verification pending — this can take up to 48 hours.',
  };
}
