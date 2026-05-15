import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import TeamClient from './TeamClient';

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
}

async function getUsers() {
  const { data } = await (db
    .from('users')
    .select('id, name, email, role, status, created_at')
    .order('created_at', { ascending: false }) as unknown as Promise<{ data: UserRow[] | null }>);
  return data ?? [];
}

export default async function TeamPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');
  if (!['admin', 'super_admin'].includes(session.user.role)) redirect('/dashboard');

  const users = await getUsers();

  return (
    <div>
      <Header title="Team" subtitle="Manage agency staff accounts" />
      <div className="p-6">
        <TeamClient initialUsers={users} currentUserId={session.user.id} />
      </div>
    </div>
  );
}
