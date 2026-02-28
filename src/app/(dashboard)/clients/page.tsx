import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import ClientsClient from './ClientsClient';

async function getClients() {
  const { data } = await db
    .from('clients')
    .select(`
      *,
      workspaces (
        id, name, status,
        tests ( id, status )
      )
    `)
    .order('created_at', { ascending: false });
  return data ?? [];
}

export default async function ClientsPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const clients = await getClients();

  return (
    <div>
      <Header title="Clients" subtitle="Manage all client workspaces" />
      <div className="p-6">
        <ClientsClient
          initialClients={clients}
          canManage={session.user.role !== 'viewer'}
        />
      </div>
    </div>
  );
}
