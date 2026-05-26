import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { PLAN_LIMITS } from '@/lib/plans';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

const inviteSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['manager', 'viewer']),
});

/** Returns all workspace IDs owned by a given manager (via their clients). */
async function getOwnerWorkspaceIds(userId: string): Promise<string[]> {
  const { data: clients } = await db
    .from('clients')
    .select('id')
    .eq('owner_id', userId);

  if (!clients?.length) return [];

  const { data: workspaces } = await db
    .from('workspaces')
    .select('id')
    .in('client_id', clients.map((c) => c.id));

  return workspaces?.map((w) => w.id) ?? [];
}

/** GET /api/team — list invited members for the current manager's workspaces */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'manager') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const workspaceIds = await getOwnerWorkspaceIds(session.user.id);
  if (!workspaceIds.length) return NextResponse.json([]);

  const { data: rows, error } = await db
    .from('workspace_members')
    .select('user_id, role, users(id, name, email, status, created_at)')
    .in('workspace_id', workspaceIds)
    .neq('user_id', session.user.id); // exclude the owner themselves

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Deduplicate — same user may appear in multiple workspace rows
  const seen = new Set<string>();
  const members = (rows ?? [])
    .filter((m) => {
      if (seen.has(m.user_id)) return false;
      seen.add(m.user_id);
      return true;
    })
    .map((m) => ({ ...(m.users as unknown as Record<string, unknown>), workspaceRole: m.role }));

  return NextResponse.json(members);
}

/** POST /api/team — invite a new team member */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'manager') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const body = await request.json();
    const data = inviteSchema.parse(body);

    // ── Plan limit check ────────────────────────────────────────────────────
    const plan = session.user.plan ?? 'free';
    const limit = PLAN_LIMITS[plan]?.teamSeats ?? 0;

    if (limit === 0) {
      return NextResponse.json(
        { error: 'Your plan does not include team seats. Please upgrade to invite members.' },
        { status: 403 }
      );
    }

    if (isFinite(limit)) {
      const workspaceIds = await getOwnerWorkspaceIds(session.user.id);
      if (workspaceIds.length) {
        const { data: memberRows } = await db
          .from('workspace_members')
          .select('user_id')
          .in('workspace_id', workspaceIds)
          .neq('user_id', session.user.id);

        const uniqueCount = new Set(memberRows?.map((m) => m.user_id)).size;
        if (uniqueCount >= limit) {
          return NextResponse.json(
            { error: `You have reached the team seat limit for your plan (${limit}). Please upgrade to add more members.` },
            { status: 403 }
          );
        }
      }
    }

    // ── Check email uniqueness ───────────────────────────────────────────────
    const { data: existing } = await db
      .from('users')
      .select('id')
      .eq('email', data.email.toLowerCase())
      .single();

    if (existing) {
      return NextResponse.json({ error: 'A user with this email already exists.' }, { status: 409 });
    }

    // ── Create user account (viewer globally — workspace role controls access) ─
    const passwordHash = await bcrypt.hash(data.password, 12);
    const { data: newUser, error: userError } = await db
      .from('users')
      .insert({
        name: data.name,
        email: data.email.toLowerCase(),
        password_hash: passwordHash,
        role: 'viewer',   // always viewer globally — workspace_members.role controls workspace access
        plan: 'free',
      })
      .select('id, name, email, status, created_at')
      .single();

    if (userError || !newUser) {
      return NextResponse.json({ error: userError?.message ?? 'Failed to create user' }, { status: 500 });
    }

    // ── Add to all workspaces owned by this manager ──────────────────────────
    const workspaceIds = await getOwnerWorkspaceIds(session.user.id);
    if (workspaceIds.length) {
      await db.from('workspace_members').insert(
        workspaceIds.map((wsId) => ({
          workspace_id: wsId,
          user_id: newUser.id,
          role: data.role,
        }))
      );
    }

    // ── Send invite email ────────────────────────────────────────────────────
    let emailError: string | null = null;
    try {
      const { sendInvitationEmail } = await import('@/lib/email');
      await sendInvitationEmail({
        toName: data.name,
        toEmail: data.email,
        temporaryPassword: data.password,
        role: data.role,
      });
    } catch (err) {
      emailError = err instanceof Error ? err.message : 'Email send failed';
      console.error('[email] team invitation failed:', err);
    }

    return NextResponse.json({ ...newUser, workspaceRole: data.role, emailError }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
