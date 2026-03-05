import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { addDomainToVercel, removeDomainFromVercel, getDomainStatus } from '@/lib/vercel';
import { z } from 'zod';

const APP_HOSTNAME = process.env.APP_HOSTNAME || 'cname.vercel-dns.com';

const addSchema = z.object({
  domain: z.string().min(3).max(255),
});

const verifySchema = z.object({
  action: z.literal('verify'),
  domain_id: z.string().uuid(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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

  try {
    const body = await request.json();

    // ── Verify action ──
    if (body.action === 'verify') {
      const { domain_id } = verifySchema.parse(body);

      const { data: domainRow, error: fetchErr } = await db
        .from('domains')
        .select('id, domain')
        .eq('id', domain_id)
        .eq('workspace_id', params.id)
        .single();

      if (fetchErr || !domainRow) {
        return NextResponse.json({ error: 'Domain not found' }, { status: 404 });
      }

      const status = await getDomainStatus(domainRow.domain);

      if (status.verified) {
        await db
          .from('domains')
          .update({ verified: true, verified_at: new Date().toISOString() })
          .eq('id', domain_id);
      }

      return NextResponse.json({
        verified: status.verified,
        status: status.status,
        message: status.message,
      });
    }

    // ── Add domain ──
    const { domain } = addSchema.parse(body);

    const { data: existing } = await db
      .from('domains')
      .select('id')
      .eq('domain', domain)
      .single();

    if (existing) {
      return NextResponse.json({ error: 'Domain already registered' }, { status: 409 });
    }

    // Register with Vercel first
    try {
      await addDomainToVercel(domain);
    } catch (vercelErr: unknown) {
      const msg = vercelErr instanceof Error ? vercelErr.message : 'Vercel API error';
      return NextResponse.json(
        { error: `Failed to register domain with Vercel: ${msg}` },
        { status: 502 }
      );
    }

    const { data: newDomain, error } = await db
      .from('domains')
      .insert({
        workspace_id: params.id,
        domain,
        cname_target: APP_HOSTNAME,
        verified: false,
      })
      .select()
      .single();

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

    // Fetch domain name for Vercel API
    const { data: domainRow, error: fetchErr } = await db
      .from('domains')
      .select('domain')
      .eq('id', domain_id)
      .eq('workspace_id', params.id)
      .single();

    if (fetchErr || !domainRow) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 });
    }

    // Remove from Vercel first
    try {
      await removeDomainFromVercel(domainRow.domain);
    } catch (vercelErr: unknown) {
      const msg = vercelErr instanceof Error ? vercelErr.message : 'Vercel API error';
      return NextResponse.json(
        { error: `Failed to remove domain from Vercel: ${msg}` },
        { status: 502 }
      );
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
