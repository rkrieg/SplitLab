import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import TeamClient from './TeamClient';

async function getUsers() {
  const { data } = await db
    .from('users')
    .select('id, name, email, role, status, created_at')
    .order('created_at', { ascending: false });
  return data ?? [];
}

export default async function TeamPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');
  if (session.user.role !== 'admin') redirect('/dashboard');

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
