import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { randomBytes } from 'crypto';
import { z } from 'zod';

const schema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(255),
  role: z.enum(['manager', 'viewer']),
});

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Verify requester is a member of this workspace
  const { data: membership } = await db
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', params.id)
    .eq('user_id', session.user.id)
    .single();
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

  // Check if user already exists
  const { data: existingUser } = await (db
    .from('users')
    .select('id, name, email, role, status')
    .eq('email', body.email.toLowerCase())
    .single() as unknown as Promise<{ data: { id: string; name: string; email: string; role: string; status: string } | null }>);

  let userId: string;
  let inviteUrl: string | null = null;
  let isExisting = false;

  if (existingUser) {
    userId = existingUser.id;
    isExisting = true;
  } else {
    // Create new user with invite token
    const inviteToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: newUser, error: createErr } = await (db
      .from('users')
      .insert({
        name: body.name,
        email: body.email.toLowerCase(),
        password_hash: '',
        role: 'manager',
        status: 'invited',
        invite_token: inviteToken,
        invite_expires_at: expiresAt,
      })
      .select('id')
      .single() as unknown as Promise<{ data: { id: string } | null; error: { message: string } | null }>);

    if (createErr || !newUser) {
      return NextResponse.json({ error: createErr?.message ?? 'Failed to create user' }, { status: 500 });
    }
    userId = newUser.id;
    inviteUrl = `${APP_URL}/invites/${inviteToken}`;
  }

  // Check if already a member of this workspace
  const { data: existingMember } = await db
    .from('workspace_members')
    .select('id, role')
    .eq('workspace_id', params.id)
    .eq('user_id', userId)
    .single();

  if (existingMember) {
    return NextResponse.json({ error: 'This user is already a member of this workspace' }, { status: 409 });
  }

  // Add to workspace
  const { data: member, error: memberErr } = await (db
    .from('workspace_members')
    .insert({ workspace_id: params.id, user_id: userId, role: body.role })
    .select('id, role, user_id')
    .single() as unknown as Promise<{ data: { id: string; role: string; user_id: string } | null; error: { message: string } | null }>);

  if (memberErr || !member) {
    return NextResponse.json({ error: memberErr?.message ?? 'Failed to add member' }, { status: 500 });
  }

  return NextResponse.json({
    id: member.id,
    role: member.role,
    user_id: userId,
    name: body.name,
    email: body.email.toLowerCase(),
    status: isExisting ? 'active' : 'invited',
    invite_url: inviteUrl,
    is_existing_user: isExisting,
  }, { status: 201 });
}
