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
      body: JSON.stringify({ name: domain, ...(process.env.VERCEL_GIT_COMMIT_REF ? { gitBranch: process.env.VERCEL_GIT_COMMIT_REF } : {}) }),
    }
  );

  const data = await res.json().catch(() => ({}));

  // Domain claimed by another project — return TXT verification from error body
  if (!res.ok && data?.error?.code === 'existing_project_domain') {
    return { verification: data.verification || [] };
  }

  // Any other non-success that isn't 409
  if (!res.ok && res.status !== 409) {
    throw new Error(data?.error?.message || `Vercel API error (${res.status})`);
  }

  // 200 (added) or 409 (already in project) — always GET current domain state.
  // Vercel doesn't reliably include verification records in the POST response,
  // and 409 means we skipped the POST body entirely.
  const domainRes = await fetch(
    `${VERCEL_API_BASE}/v9/projects/${getProjectId()}/domains/${domain}`,
    { method: 'GET', headers: headers() }
  );
  const domainData = await domainRes.json().catch(() => ({}));
  return { verification: domainData.verification || [] };
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

  // Missing TXT record — parent domain is in a different Vercel project/team
  if (!verifyRes.ok && verifyData?.error?.code === 'missing_txt_record') {
    const domainRes = await fetch(
      `${VERCEL_API_BASE}/v9/projects/${getProjectId()}/domains/${domain}`,
      { method: 'GET', headers: headers() }
    );
    const domainData = await domainRes.json().catch(() => ({}));
    return {
      verified: false,
      status: 'needs_txt',
      message: 'Vercel requires a TXT record to verify ownership of this subdomain (because the parent domain is in a different project). Add the record below in your Vercel DNS panel, then click Verify DNS again.',
      vercel_verification: domainData.verification || [],
    };
  }

  // Vercel sometimes returns 200 with an error body for TXT record issues
  const txtErrorCodes = ['incorrect_txt_record', 'missing_txt_record'];
  if (verifyData?.error?.code && txtErrorCodes.includes(verifyData.error.code)) {
    const domainRes = await fetch(
      `${VERCEL_API_BASE}/v9/projects/${getProjectId()}/domains/${domain}`,
      { method: 'GET', headers: headers() }
    );
    const domainData = await domainRes.json().catch(() => ({}));
    return {
      verified: false,
      status: 'needs_txt',
      message: verifyData.error.message || 'Incorrect or missing TXT record. Add the record below, then click Verify DNS again.',
      vercel_verification: domainData.verification || [],
    };
  }

  if (verifyRes.ok && (verifyData.domain?.verified === true || verifyData.verified === true)) {
    return {
      verified: true,
      status: 'valid',
      message: 'Domain is verified and serving traffic.',
    };
  }

  // Verify returned error with verification records
  if (!verifyRes.ok && verifyData?.verification?.length > 0) {
    return {
      verified: false,
      status: 'needs_txt',
      message: 'Vercel requires a TXT record to verify ownership. Add the record below in your Vercel DNS panel, then click Verify DNS again.',
      vercel_verification: verifyData.verification,
    };
  }

  // Step 2: Check DNS config — ground truth for whether DNS is correctly pointing to Vercel
  const configRes = await fetch(
    `${VERCEL_API_BASE}/v6/domains/${domain}/config`,
    { method: 'GET', headers: headers() }
  );

  if (configRes.ok) {
    const config = await configRes.json();

    if (config.misconfigured === false) {
      return {
        verified: true,
        status: 'valid',
        message: 'Domain is verified and serving traffic.',
      };
    }

    if (config.misconfigured === true) {
      const isCloudflareProxy = config.cnames?.some((c: string) => /cloudflare/.test(c));
      return {
        verified: false,
        status: 'misconfigured',
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
