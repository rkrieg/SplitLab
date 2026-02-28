import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { slugify } from '@/lib/utils';
import { z } from 'zod';

const createSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100).optional(),
  logo_url: z.string().url().optional().nullable(),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await db
    .from('clients')
    .select(`
      *,
      workspaces (
        id, name, slug, status,
        tests ( id, status )
      )
    `)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'admin' && session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const data = createSchema.parse(body);
    const slug = data.slug || slugify(data.name);

    // Check slug uniqueness
    const { data: existing } = await db
      .from('clients')
      .select('id')
      .eq('slug', slug)
      .single();
    if (existing) {
      return NextResponse.json({ error: 'Slug already in use' }, { status: 409 });
    }

    const { data: client, error } = await db
      .from('clients')
      .insert({ name: data.name, slug, logo_url: data.logo_url })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Auto-create a default workspace
    await db.from('workspaces').insert({
      client_id: client.id,
      name: data.name,
      slug: 'default',
    });

    return NextResponse.json(client, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
