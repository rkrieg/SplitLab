import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
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

function getCnameTarget(): string {
  // CNAME_TARGET is what clients point their DNS at (the SplitLab ingress hostname).
  // Falls back to cname.trysplitlab.com for branded white-label DNS.
  return (
    process.env.CNAME_TARGET ||
    'cname.trysplitlab.com'
  );
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

      // Check DNS: look for CNAME or A record pointing to our app
      const target = getCnameTarget();
      let dnsOk = false;
      try {
        // Check CNAME first
        const cnameRes = await fetch(
          `https://dns.google/resolve?name=${encodeURIComponent(domainRow.domain)}&type=CNAME`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (cnameRes.ok) {
          const cnameData = await cnameRes.json();
          const cnameAnswers: Array<{ data: string }> = cnameData.Answer || [];
          dnsOk = cnameAnswers.some((a) =>
            a.data.replace(/\.$/, '') === target.replace(/\.$/, '')
          );
        }

        // If no CNAME match, also resolve the target to IPs and check A records
        if (!dnsOk) {
          const [domainARes, targetARes] = await Promise.all([
            fetch(`https://dns.google/resolve?name=${encodeURIComponent(domainRow.domain)}&type=A`, { signal: AbortSignal.timeout(5000) }),
            fetch(`https://dns.google/resolve?name=${encodeURIComponent(target)}&type=A`, { signal: AbortSignal.timeout(5000) }),
          ]);
          if (domainARes.ok && targetARes.ok) {
            const domainIPs: string[] = ((await domainARes.json()).Answer || []).map((a: { data: string }) => a.data);
            const targetIPs: string[] = ((await targetARes.json()).Answer || []).map((a: { data: string }) => a.data);
            dnsOk = domainIPs.some((ip) => targetIPs.includes(ip));
          }
        }
      } catch {
        // DNS check timed out — treat as pending
      }

      if (dnsOk) {
        await db
          .from('domains')
          .update({ verified: true, verified_at: new Date().toISOString() })
          .eq('id', domain_id);
      }

      return NextResponse.json({
        verified: dnsOk,
        status: dnsOk ? 'valid' : 'pending_verification',
        message: dnsOk
          ? 'Domain is verified and serving traffic.'
          : `DNS not detected yet. Add a CNAME record: ${domainRow.domain} → ${target}`,
      });
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
        cname_target: getCnameTarget(),
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

    const { error: fetchErr } = await (db
      .from('domains')
      .select('domain')
      .eq('id', domain_id)
      .eq('workspace_id', params.id)
      .single() as unknown as Promise<{ data: unknown; error: { message: string } | null }>);

    if (fetchErr) {
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
