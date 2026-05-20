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

const CLIENT_SELECT = `
  *,
  workspaces (
    id, name, slug, status,
    tests ( id, status )
  )
`;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: userId, role } = session.user;

  if (role === 'admin') {
    const { data, error } = await db
      .from('clients')
      .select(CLIENT_SELECT)
      .order('created_at', { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  if (role === 'manager') {
    const { data, error } = await db
      .from('clients')
      .select(CLIENT_SELECT)
      .eq('owner_id', userId)
      .order('created_at', { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  // viewer: only clients they have workspace membership in
  const { data: memberships } = await db
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', userId);

  const workspaceIds = memberships?.map(m => m.workspace_id) ?? [];
  if (workspaceIds.length === 0) return NextResponse.json([]);

  const { data: workspaces } = await db
    .from('workspaces')
    .select('client_id')
    .in('id', workspaceIds);

  const clientIds = Array.from(new Set(workspaces?.map(w => w.client_id) ?? []));
  if (clientIds.length === 0) return NextResponse.json([]);

  const { data, error } = await db
    .from('clients')
    .select(CLIENT_SELECT)
    .in('id', clientIds)
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
      .insert({
        name: data.name,
        slug,
        logo_url: data.logo_url,
        owner_id: session.user.role === 'manager' ? session.user.id : null,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const { data: workspace } = await db.from('workspaces').insert({
      client_id: client.id,
      name: data.name,
      slug: 'default',
    }).select('id').single();

    // Add the creator as a manager in workspace_members so they appear in the members list
    if (workspace) {
      await db.from('workspace_members').insert({
        workspace_id: workspace.id,
        user_id: session.user.id,
        role: 'manager',
      });
    }

    return NextResponse.json(client, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
