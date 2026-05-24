import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { slugify } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const signupSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  plan: z.enum(['free', 'pro', 'agency', 'scale']).optional().default('free'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const data = signupSchema.parse(body);

    const { data: existing } = await db
      .from('users')
      .select('id')
      .eq('email', data.email.toLowerCase())
      .single();

    if (existing) {
      return NextResponse.json(
        { error: 'An account with this email already exists' },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(data.password, 12);

    const { data: user, error } = await db
      .from('users')
      .insert({
        name: data.name,
        email: data.email.toLowerCase(),
        password_hash: passwordHash,
        role: 'manager',
        plan: data.plan,
      })
      .select('id, name, email, role, status, created_at')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Auto-create default client for new user ("[FirstName]'s Account")
    const firstName = data.name.trim().split(' ')[0];
    const clientName = `${firstName}'s Account`;
    const clientSlug = slugify(clientName) + '-' + user!.id.slice(0, 8);

    const { data: client } = await db.from('clients').insert({
      name: clientName,
      slug: clientSlug,
      owner_id: user!.id,
    }).select('id').single();

    if (client) {
      const { data: workspace } = await db.from('workspaces').insert({
        client_id: client.id,
        name: clientName,
        slug: 'default',
      }).select('id').single();

      if (workspace) {
        await db.from('workspace_members').insert({
          workspace_id: workspace.id,
          user_id: user!.id,
          role: 'manager',
        });
      }
    }

    return NextResponse.json({ ...user, defaultClientId: client?.id ?? null }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.errors[0]?.message || 'Validation failed' },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
