import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { z } from 'zod';

const PROXY_CNAME_TARGET = (process.env.PROXY_CNAME_TARGET || 'proxy.trysplitlab.com').toLowerCase();

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

async function checkCnamePointsToProxy(domain: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=CNAME`,
      { headers: { Accept: 'application/dns-json' } }
    );
    if (!res.ok) return false;
    const data = await res.json();
    const answers: Array<{ type: number; data: string }> = data.Answer || [];
    return answers.some(
      (a) => a.type === 5 && a.data.replace(/\.$/, '').toLowerCase() === PROXY_CNAME_TARGET
    );
  } catch {
    return false;
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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

      const cnameOk = await checkCnamePointsToProxy(domainRow.domain);

      if (cnameOk) {
        await db
          .from('domains')
          .update({ verified: true, verified_at: new Date().toISOString() })
          .eq('id', domain_id);

        return NextResponse.json({ verified: true });
      }

      return NextResponse.json({
        verified: false,
        status: 'pending_cname',
        message: `CNAME not detected yet. Make sure ${domainRow.domain} has a CNAME record pointing to ${PROXY_CNAME_TARGET}. DNS changes can take a few minutes to propagate.`,
      });
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
        .update({ domain: newDomain, verified: false, verified_at: null })
        .eq('id', domain_id)
        .eq('workspace_id', params.id)
        .select()
        .single() as unknown as Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>);

      if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
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
      .insert({
        workspace_id: params.id,
        domain,
        verified: false,
      })
      .select()
      .single() as unknown as Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json(newDomain, { status: 201 });

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

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
