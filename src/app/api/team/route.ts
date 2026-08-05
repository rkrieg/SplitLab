import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { PLAN_LIMITS } from '@/lib/plans';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { z } from 'zod';

const inviteSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email(),
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
    .map((m) => ({ ...(m.users as unknown as Record<string, unknown>), workspaceRole: m.role, pending: false }));

  // Existing users invited into a new workspace sit in pending_invites until
  // they accept — surface them too, so the manager doesn't see nothing happen.
  const { data: pendingRows } = await db
    .from('pending_invites')
    .select('user_id, role, users(id, name, email, status, created_at)')
    .in('workspace_id', workspaceIds);

  const pendingSeen = new Set<string>();
  const pending = (pendingRows ?? [])
    .filter((p) => {
      if (seen.has(p.user_id) || pendingSeen.has(p.user_id)) return false;
      pendingSeen.add(p.user_id);
      return true;
    })
    .map((p) => ({ ...(p.users as unknown as Record<string, unknown>), workspaceRole: p.role, pending: true }));

  return NextResponse.json([...members, ...pending]);
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

    // ── Look up existing user by email (a person may already have an account
    // via another client's team, or as an owner of their own clients) ────────
    const { data: existingUser } = await db
      .from('users')
      .select('id, name, email, status, created_at, role')
      .eq('email', data.email.toLowerCase())
      .single();

    // Admins are platform staff, not invitable as client team members.
    if (existingUser?.role === 'admin') {
      return NextResponse.json({ error: 'This email cannot be invited.' }, { status: 409 });
    }

    const workspaceIds = await getOwnerWorkspaceIds(session.user.id);

    let targetUser: { id: string; name: string; email: string; status: string; created_at: string };
    let isNewUser = false;

    if (existingUser) {
      targetUser = existingUser;

      // Already a member of (or already have a pending invite for) every
      // workspace this manager owns? Nothing to do.
      if (workspaceIds.length) {
        const [{ data: alreadyMember }, { data: alreadyPending }] = await Promise.all([
          db.from('workspace_members').select('workspace_id').eq('user_id', existingUser.id).in('workspace_id', workspaceIds),
          db.from('pending_invites').select('workspace_id').eq('user_id', existingUser.id).in('workspace_id', workspaceIds),
        ]);

        const covered = new Set([
          ...(alreadyMember?.map((m) => m.workspace_id) ?? []),
          ...(alreadyPending?.map((p) => p.workspace_id) ?? []),
        ]);
        if (workspaceIds.every((id) => covered.has(id))) {
          return NextResponse.json({ error: 'This person is already on your team, or already invited.' }, { status: 409 });
        }
      }
    } else {
      isNewUser = true;
      // Unusable placeholder password — the invited user sets their own via the setup link
      const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
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
      targetUser = newUser;
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';
    let emailError: string | null = null;

    if (isNewUser) {
      // Brand-new accounts have no password yet, so they can't access anything
      // until they click the setup link — that gate stands in for acceptance.
      if (workspaceIds.length) {
        await db.from('workspace_members').insert(
          workspaceIds.map((wsId) => ({
            workspace_id: wsId,
            user_id: targetUser.id,
            role: data.role,
          }))
        );
      }

      // ── Generate a password-setup token (expires in 7 days) ────────────────
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await db.from('password_resets').upsert({ user_id: targetUser.id, token, expires_at: expiresAt }, { onConflict: 'user_id' });
      const setupLink = `${appUrl}/reset-password?token=${token}`;

      try {
        const { sendInvitationEmail } = await import('@/lib/email');
        await sendInvitationEmail({
          toName: data.name,
          toEmail: data.email,
          setupLink,
          role: data.role,
        });
      } catch (err) {
        emailError = err instanceof Error ? err.message : 'Email send failed';
        console.error('[email] team invitation failed:', err);
      }
    } else {
      // Existing account can already log in — don't grant access until they
      // explicitly accept via the emailed link. Queue one pending invite per
      // new workspace, each with its own accept token.
      const { data: alreadyMember } = workspaceIds.length
        ? await db.from('workspace_members').select('workspace_id').eq('user_id', targetUser.id).in('workspace_id', workspaceIds)
        : { data: [] as { workspace_id: string }[] };
      const { data: alreadyPending } = workspaceIds.length
        ? await db.from('pending_invites').select('workspace_id').eq('user_id', targetUser.id).in('workspace_id', workspaceIds)
        : { data: [] as { workspace_id: string }[] };

      const covered = new Set([
        ...(alreadyMember?.map((m) => m.workspace_id) ?? []),
        ...(alreadyPending?.map((p) => p.workspace_id) ?? []),
      ]);
      const toInvite = workspaceIds.filter((id) => !covered.has(id));

      let acceptLink = `${appUrl}/login`;
      if (toInvite.length) {
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        // One token accepts all of this invite's new workspaces at once.
        await db.from('pending_invites').insert(
          toInvite.map((wsId) => ({
            workspace_id: wsId,
            user_id: targetUser.id,
            role: data.role,
            token,
            expires_at: expiresAt,
          }))
        );
        acceptLink = `${appUrl}/invite/accept?token=${token}`;
      }

      try {
        const { sendInvitationEmail } = await import('@/lib/email');
        await sendInvitationEmail({
          toName: targetUser.name,
          toEmail: targetUser.email,
          setupLink: acceptLink,
          role: data.role,
          existingAccount: true,
        });
      } catch (err) {
        emailError = err instanceof Error ? err.message : 'Email send failed';
        console.error('[email] team invitation (existing user) failed:', err);
      }
    }

    return NextResponse.json({ ...targetUser, workspaceRole: data.role, emailError, pending: !isNewUser }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
