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

export interface VercelDomainAddResult {
  verification?: Array<{ type: string; domain: string; value: string }>;
}

export async function addDomainToVercel(domain: string): Promise<VercelDomainAddResult> {
  const res = await fetch(
    `${VERCEL_API_BASE}/v10/projects/${getProjectId()}/domains`,
    {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: domain }),
    }
  );

  const data = await res.json().catch(() => ({}));

  // 409 = already exists on this project — idempotent success
  if (res.status === 409) return {};

  // Domain claimed by another project — return TXT verification requirements
  if (!res.ok && data?.error?.code === 'existing_project_domain') {
    return { verification: data.verification || [] };
  }

  if (!res.ok) {
    throw new Error(data?.error?.message || `Vercel API error (${res.status})`);
  }

  return { verification: data.verification || [] };
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
  status: 'valid' | 'pending_verification' | 'misconfigured' | 'needs_txt';
  message: string;
  vercel_verification?: Array<{ type: string; domain: string; value: string }>;
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

  const verifyData = await verifyRes.json().catch(() => ({}));

  // Domain claimed by another Vercel project — fetch fresh TXT requirements
  if (!verifyRes.ok && verifyData?.error?.code === 'existing_project_domain') {
    const domainRes = await fetch(
      `${VERCEL_API_BASE}/v9/projects/${getProjectId()}/domains/${domain}`,
      { method: 'GET', headers: headers() }
    );
    const domainData = await domainRes.json().catch(() => ({}));
    return {
      verified: false,
      status: 'needs_txt',
      message: 'This domain belongs to another Vercel project. Add the TXT record below to complete verification.',
      vercel_verification: domainData.verification || [],
    };
  }

  // Missing TXT record — Vercel requires ownership verification via TXT before accepting the domain.
  // This happens when the parent domain is in a different Vercel project/team.
  if (!verifyRes.ok && verifyData?.error?.code === 'missing_txt_record') {
    // Fetch the domain config to get the exact TXT record required
    const domainRes = await fetch(
      `${VERCEL_API_BASE}/v9/projects/${getProjectId()}/domains/${domain}`,
      { method: 'GET', headers: headers() }
    );
    const domainData = await domainRes.json().catch(() => ({}));
    const verification = domainData.verification || [];
    return {
      verified: false,
      status: 'needs_txt',
      message: 'Vercel requires a TXT record to verify ownership of this subdomain (because the parent domain is in a different project). Add the record below in your Vercel DNS panel, then click Verify DNS again.',
      vercel_verification: verification,
    };
  }

  if (verifyRes.ok && (verifyData.domain?.verified === true || verifyData.verified === true)) {
    return {
      verified: true,
      status: 'valid',
      message: 'Domain is verified and serving traffic.',
    };
  }

  // Verify returned ok but not yet verified — check if verification records are present
  if (!verifyRes.ok && verifyData?.verification?.length > 0) {
    return {
      verified: false,
      status: 'needs_txt',
      message: 'Vercel requires a TXT record to verify ownership. Add the record below in your Vercel DNS panel, then click Verify DNS again.',
      vercel_verification: verifyData.verification,
    };
  }

  // Step 2: Check DNS config for more detail
  const configRes = await fetch(
    `${VERCEL_API_BASE}/v6/domains/${domain}/config`,
    { method: 'GET', headers: headers() }
  );

  if (configRes.ok) {
    const config = await configRes.json();
    if (config.misconfigured === true) {
      // Check for Cloudflare proxy as common cause
      const isCloudflareProxy = config.cnames?.some((c: string) => /cloudflare/.test(c));
      return {
        verified: false,
        status: 'misconfigured',
        misconfigured_detail: isCloudflareProxy ? 'cloudflare_proxy' : 'wrong_record',
        message: isCloudflareProxy
          ? 'Your domain is proxied through Cloudflare. Set the DNS record to "DNS only" (grey cloud) and try again.'
          : 'DNS records not found or incorrect. Double-check the CNAME record and try again.',
      };
    }
  }

  return {
    verified: false,
    status: 'pending_verification',
    message: 'DNS records detected. Verification pending — this can take a few minutes. Try again shortly.',
  };
}
