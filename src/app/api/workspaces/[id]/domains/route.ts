import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { addDomainToVercel, removeDomainFromVercel, getDomainStatus } from '@/lib/vercel';
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

const fallbackSchema = z.object({
  action: z.literal('set_fallback'),
  domain_id: z.string().uuid(),
  fallback_url: z.string().url().or(z.literal('')),
});

async function requireMembership(workspaceId: string, userId: string) {
  const { data } = await db
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .single();
  return data;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!await requireMembership(params.id, session.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { data, error } = await (db
    .from('domains')
    .select('*')
    .eq('workspace_id', params.id)
    .order('created_at', { ascending: false }) as unknown as Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!await requireMembership(params.id, session.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();

    // ── Verify action ──
    if (body.action === 'verify') {
      const { domain_id } = verifySchema.parse(body);

      const { data: domainRow, error: fetchErr } = await (db
        .from('domains')
        .select('id, domain')
        .eq('id', domain_id)
        .eq('workspace_id', params.id)
        .single() as unknown as Promise<{ data: { id: string; domain: string } | null; error: { message: string } | null }>);

      if (fetchErr || !domainRow) {
        return NextResponse.json({ error: 'Domain not found' }, { status: 404 });
      }

      const result = await getDomainStatus(domainRow.domain);

      if (result.verified) {
        await db
          .from('domains')
          .update({ verified: true, verified_at: new Date().toISOString(), vercel_verification: null })
          .eq('id', domain_id);
      } else if (result.status === 'needs_txt' && result.vercel_verification?.length) {
        await db
          .from('domains')
          .update({ vercel_verification: result.vercel_verification })
          .eq('id', domain_id);
      }

      return NextResponse.json(result);
    }

    // ── Set fallback URL ──
    if (body.action === 'set_fallback') {
      const { domain_id, fallback_url } = fallbackSchema.parse(body);
      const { error: updateErr } = await db
        .from('domains')
        .update({ fallback_url: fallback_url || null })
        .eq('id', domain_id)
        .eq('workspace_id', params.id);
      if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    // ── Update domain (rename) ──
    if (body.action === 'update') {
      const { domain_id, domain: newDomain } = updateSchema.parse(body);

      const { data: oldRow, error: fetchErr } = await (db
        .from('domains')
        .select('id, domain')
        .eq('id', domain_id)
        .eq('workspace_id', params.id)
        .single() as unknown as Promise<{ data: { id: string; domain: string } | null; error: { message: string } | null }>);

      if (fetchErr || !oldRow) {
        return NextResponse.json({ error: 'Domain not found' }, { status: 404 });
      }

      if (oldRow.domain === newDomain) {
        return NextResponse.json({ error: 'Domain unchanged' }, { status: 400 });
      }

      const { data: existing } = await (db
        .from('domains')
        .select('id')
        .eq('domain', newDomain)
        .single() as unknown as Promise<{ data: { id: string } | null; error: unknown }>);

      if (existing) {
        return NextResponse.json({ error: 'Domain already registered' }, { status: 409 });
      }

      const { data: updated, error: updateErr } = await (db
        .from('domains')
        .update({ domain: newDomain, verified: false, verified_at: null, vercel_verification: null })
        .eq('id', domain_id)
        .eq('workspace_id', params.id)
        .select()
        .single() as unknown as Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>);

      if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

      try {
        await removeDomainFromVercel(oldRow.domain);
        const result = await addDomainToVercel(newDomain);
        const vercelVerification = result.verification || [];
        if (vercelVerification.length > 0 && updated) {
          await db
            .from('domains')
            .update({ vercel_verification: vercelVerification })
            .eq('id', domain_id);
        }
      } catch (e) {
        console.warn('[domains] Vercel re-register failed:', (e as Error).message);
      }

      return NextResponse.json(updated);
    }

    // ── Add domain ──
    const { domain } = addSchema.parse(body);

    const { data: existing } = await (db
      .from('domains')
      .select('id')
      .eq('domain', domain)
      .single() as unknown as Promise<{ data: { id: string } | null; error: unknown }>);

    if (existing) {
      return NextResponse.json({ error: 'Domain already registered' }, { status: 409 });
    }

    const { data: newDomain, error } = await (db
      .from('domains')
      .insert({ workspace_id: params.id, domain, verified: false })
      .select()
      .single() as unknown as Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    let vercelVerification: Array<{ type: string; domain: string; value: string }> = [];
    try {
      const result = await addDomainToVercel(domain);
      vercelVerification = result.verification || [];
    } catch (e) {
      console.warn('[domains] addDomainToVercel failed:', (e as Error).message);
    }

    if (vercelVerification.length > 0 && newDomain) {
      await db
        .from('domains')
        .update({ vercel_verification: vercelVerification })
        .eq('id', (newDomain as unknown as { id: string }).id);
    }

    return NextResponse.json({ ...newDomain, vercel_verification: vercelVerification }, { status: 201 });

  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!await requireMembership(params.id, session.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { domain_id } = await request.json();
    if (!domain_id) {
      return NextResponse.json({ error: 'domain_id is required' }, { status: 400 });
    }

    const { data: domainToDelete, error: fetchErr } = await (db
      .from('domains')
      .select('domain')
      .eq('id', domain_id)
      .eq('workspace_id', params.id)
      .single() as unknown as Promise<{ data: { domain: string } | null; error: { message: string } | null }>);

    if (fetchErr || !domainToDelete) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 });
    }

    const { error } = await db
      .from('domains')
      .delete()
      .eq('id', domain_id)
      .eq('workspace_id', params.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    try { await removeDomainFromVercel(domainToDelete.domain); } catch (e) {
      console.warn('[domains] removeDomainFromVercel failed:', (e as Error).message);
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
