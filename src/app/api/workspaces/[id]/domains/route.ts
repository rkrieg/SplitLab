import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { z } from 'zod';

const APP_HOSTNAME = process.env.APP_HOSTNAME || 'splitlab.agency';

const addSchema = z.object({
  domain: z.string().min(3).max(255),
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
    const { domain } = addSchema.parse(body);

    const { data: existing } = await db
      .from('domains')
      .select('id')
      .eq('domain', domain)
      .single();

    if (existing) {
      return NextResponse.json({ error: 'Domain already registered' }, { status: 409 });
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
