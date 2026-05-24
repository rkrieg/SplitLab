import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import ClientSettingsClient from './ClientSettingsClient';

export default async function ClientSettingsPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const { data: client } = await db.from('clients').select('*').eq('id', params.id).single();
  if (!client) notFound();

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

  return (
    <div>
      <Header title="Settings" subtitle={client.name} />
      <div className="p-6">
        <ClientSettingsClient
          client={client}
          appUrl={appUrl}
          canManage={session.user.role !== 'viewer'}
        />
      </div>
    </div>
  );
}
