import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { addDomainToVercel, removeDomainFromVercel, getDomainStatus } from '@/lib/vercel';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
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
  _req: NextRequest,
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
  return NextResponse.json(data);
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
        .update({ verified: true, verified_at: new Date().toISOString(), vercel_verification: null })
        .eq('id', domain_id);
    } else if (status.vercel_verification?.length) {
      await db
        .from('domains')
        .update({ vercel_verification: status.vercel_verification })
        .eq('id', domain_id);
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
