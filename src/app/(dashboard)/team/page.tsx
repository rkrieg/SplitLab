import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { PLAN_LIMITS } from '@/lib/plans';
import Header from '@/components/layout/Header';
import TeamClient from './TeamClient';
import ManagerTeamClient from './ManagerTeamClient';

// ── Admin view: all platform users ──────────────────────────────────────────
async function getAllUsers() {
  const { data } = await db
    .from('users')
    .select('id, name, email, role, status, created_at')
    .order('created_at', { ascending: false });
  return data ?? [];
}

// ── Manager view: their invited team members ─────────────────────────────────
async function getTeamMembers(userId: string) {
  const { data: clients } = await db
    .from('clients')
    .select('id')
    .eq('owner_id', userId);

  if (!clients?.length) return [];

  const { data: workspaces } = await db
    .from('workspaces')
    .select('id')
    .in('client_id', clients.map((c) => c.id));

  const workspaceIds = workspaces?.map((w) => w.id) ?? [];
  if (!workspaceIds.length) return [];

  const { data: rows } = await db
    .from('workspace_members')
    .select('user_id, role, users(id, name, email, status, created_at)')
    .in('workspace_id', workspaceIds)
    .neq('user_id', userId);

  // Deduplicate by user_id
  const seen = new Set<string>();
  return (rows ?? [])
    .filter((m) => {
      if (seen.has(m.user_id)) return false;
      seen.add(m.user_id);
      return true;
    })
    .map((m) => ({ ...(m.users as unknown as Record<string, unknown>), workspaceRole: m.role })) as Array<{
      id: string; name: string; email: string; status: string; created_at: string; workspaceRole: 'manager' | 'viewer';
    }>;
}

export default async function TeamPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  // Viewers have no team management capability
  if (session.user.role === 'viewer') redirect('/dashboard');

  // ── Admin view ───────────────────────────────────────────────────────────
  if (session.user.role === 'admin') {
    const users = await getAllUsers();
    return (
      <div>
        <Header title="Team" subtitle="Manage agency staff accounts" />
        <div className="p-6">
          <TeamClient initialUsers={users} currentUserId={session.user.id} />
        </div>
      </div>
    );
  }

  // ── Manager view ─────────────────────────────────────────────────────────
  const members = await getTeamMembers(session.user.id);
  const plan = session.user.plan ?? 'free';
  const seatLimit = PLAN_LIMITS[plan]?.teamSeats ?? 0;

  return (
    <div>
      <Header title="Team" subtitle="Invite collaborators to your account" />
      <div className="p-6">
        <ManagerTeamClient
          initialMembers={members}
          seatLimit={seatLimit}
          currentUserId={session.user.id}
        />
      </div>
    </div>
  );
}
