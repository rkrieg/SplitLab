import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { addDomainToVercel, removeDomainFromVercel, getDomainStatus, getDomainDnsHealth } from '@/lib/vercel';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
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

  const { data, error } = await db
    .from('domains')
    .select('*')
    .eq('workspace_id', params.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

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
    const { data: domain } = await db
      .from('domains')
      .select('domain')
      .eq('id', domain_id)
      .eq('workspace_id', params.id)
      .single();

    if (!domain) return NextResponse.json({ error: 'Domain not found' }, { status: 404 });

    const status = await getDomainStatus(domain.domain);
    if (status.verified) {
      await db
        .from('domains')
        .update({ verified: true, verified_at: new Date().toISOString() })
        .eq('id', domain_id);
    } else {
      const update: { verified: boolean; vercel_verification?: typeof status.vercel_verification } = {
        verified: false,
      };
      if (status.vercel_verification?.length) {
        update.vercel_verification = status.vercel_verification;
      }
      await db.from('domains').update(update).eq('id', domain_id);
    }
    return NextResponse.json({ verified: status.verified, status });
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

  // Enforce domain limit per plan (admins bypass).
  // Use workspace owner's plan — invited managers have plan:'free' on their own row.
  if (session.user.role !== 'admin') {
    const { data: wsData } = await db.from('workspaces').select('client_id').eq('id', params.id).single();
    let planOwnerId = session.user.id;
    if (wsData) {
      const { data: clientData } = await db.from('clients').select('owner_id').eq('id', wsData.client_id).single();
      if (clientData?.owner_id) planOwnerId = clientData.owner_id;
    }

    const { data: userRow } = await db.from('users').select('plan').eq('id', planOwnerId).single();
    const plan = userRow?.plan ?? 'free';
    const limit = PLAN_LIMITS[plan]?.domains ?? 0;

    if (limit === 0) {
      return NextResponse.json(
        { error: 'Your plan does not include custom domains. Please upgrade to add a domain.', limitError: true },
        { status: 403 }
      );
    }

    if (isFinite(limit)) {
      const { count } = await db
        .from('domains')
        .select('*', { count: 'exact', head: true })
        .eq('workspace_id', params.id);

      if ((count ?? 0) >= limit) {
        return NextResponse.json(
          { error: `You have reached the domain limit for your plan (${limit}). Please upgrade to add more domains.`, limitError: true },
          { status: 403 }
        );
      }
    }
  }

  const { domain } = addResult.data;
  const vercelResult = await addDomainToVercel(domain);

  const { data: created, error } = await db
    .from('domains')
    .insert({
      workspace_id: params.id,
      domain,
      cname_target: null,
      vercel_verification: vercelResult.verification?.length ? vercelResult.verification : null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(created, { status: 201 });
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

  const { data: domain } = await db
    .from('domains')
    .select('domain')
    .eq('id', domain_id)
    .eq('workspace_id', params.id)
    .single();

  if (!domain) return NextResponse.json({ error: 'Domain not found' }, { status: 404 });

  await removeDomainFromVercel(domain.domain);

  const { error } = await db.from('domains').delete().eq('id', domain_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
