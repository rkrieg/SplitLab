import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { addDomainToVercel, removeDomainFromVercel, getDomainDnsHealth } from '@/lib/vercel';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { listDomains, addDomain, verifyDomain, deleteDomain } from '@/lib/services/domains';
import { logEvent } from '@/lib/log';
import { z } from 'zod';

const addSchema = z.object({
  domain: z.string().min(3).max(255),
});

const verifySchema = z.object({
  action: z.literal('verify'),
  domain_id: z.string().uuid(),
});

const updateSchema = z.object({
  action: z.literal('update'),
  domain_id: z.string().uuid(),
  domain: z.string().min(3).max(255),
});

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!await resolveWorkspaceRole(params.id, session.user.id, session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const listResult = await listDomains(params.id);
  if (!listResult.ok) return NextResponse.json({ error: listResult.error }, { status: listResult.status });
  const data = listResult.data as { id: string; domain: string; verified: boolean }[];

  const syncDns = req.nextUrl.searchParams.get('syncDns') === '1';
  if (!syncDns || !data?.length) {
    return NextResponse.json(data);
  }

  // Passive health check: GET /config only (no POST /verify — does not burn 50/hr quota)
  const dnsHealth: Record<string, { misconfigured: boolean; message: string }> = {};
  const result = [...data];

  for (const row of data) {
    if (!row.verified) continue;

    const health = await getDomainDnsHealth(row.domain);
    if (health.misconfigured !== true) continue;

    await db
      .from('domains')
      .update({ verified: false })
      .eq('id', row.id);

    await logEvent('domain_verification', 'warn', 'DNS misconfigured, marked unverified', {
      domain: row.domain, domainId: row.id, workspaceId: params.id, message: health.message,
    });

    const idx = result.findIndex((d) => d.id === row.id);
    if (idx >= 0) {
      result[idx] = { ...result[idx], verified: false };
    }

    // Prefer Vercel-derived message (e.g. Cloudflare proxy); stale-green fallback if empty
    dnsHealth[row.id] = {
      misconfigured: true,
      message:
        health.message ||
        'DNS records no longer point to SplitLab. Re-add the DNS record below, then click Verify DNS.',
    };
  }

  return NextResponse.json({ domains: result, dnsHealth });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const wsRole = await resolveWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!wsRole) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (wsRole !== 'manager') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json();

  // Verify action
  const verifyResult = verifySchema.safeParse(body);
  if (verifyResult.success) {
    const { domain_id } = verifyResult.data;
    const verifyResponse = await verifyDomain(params.id, domain_id);
    if (!verifyResponse.ok) return NextResponse.json({ error: verifyResponse.error }, { status: verifyResponse.status });
    return NextResponse.json(verifyResponse.data);
  }

  // Update action
  const updateResult = updateSchema.safeParse(body);
  if (updateResult.success) {
    const { domain_id, domain: newDomain } = updateResult.data;
    const { data: existing } = await db
      .from('domains')
      .select('domain')
      .eq('id', domain_id)
      .eq('workspace_id', params.id)
      .single();

    if (!existing) return NextResponse.json({ error: 'Domain not found' }, { status: 404 });

    await removeDomainFromVercel(existing.domain);
    await addDomainToVercel(newDomain);

    const { data: updated, error } = await db
      .from('domains')
      .update({
        domain: newDomain,
        cname_target: null,
        verified: false,
        verified_at: null,
        vercel_verification: null,
      })
      .eq('id', domain_id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(updated);
  }

  // Add domain
  const addResult = addSchema.safeParse(body);
  if (!addResult.success) {
    return NextResponse.json({ error: addResult.error.errors }, { status: 400 });
  }

  const addResponse = await addDomain(params.id, addResult.data.domain, session.user.role);
  if (!addResponse.ok) {
    return NextResponse.json({ error: addResponse.error, ...(addResponse.limitError ? { limitError: true } : {}) }, { status: addResponse.status });
  }
  return NextResponse.json(addResponse.data, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const wsRole = await resolveWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!wsRole || wsRole !== 'manager') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { domain_id } = await request.json();
  if (!domain_id) return NextResponse.json({ error: 'domain_id required' }, { status: 400 });

  const deleteResponse = await deleteDomain(params.id, domain_id);
  if (!deleteResponse.ok) return NextResponse.json({ error: deleteResponse.error }, { status: deleteResponse.status });
  return NextResponse.json({ ok: true });
}
