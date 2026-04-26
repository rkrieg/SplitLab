import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import PagesClient from './PagesClient';

async function getWorkspaceForClient(clientId: string): Promise<{ id: string; name: string } | null> {
  const { data } = await db
    .from('workspaces')
    .select('id, name')
    .eq('client_id', clientId)
    .single() as unknown as { data: { id: string; name: string } | null };
  return data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getTests(workspaceId: string): Promise<any[]> {
  const { data } = await db
    .from('tests')
    .select('*, test_variants(*), conversion_goals(*)')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false }) as unknown as { data: unknown[] | null };
  return (data ?? []) as unknown[];
}

async function getDomain(workspaceId: string): Promise<{ domain: string; verified: boolean } | null> {
  const { data } = await db
    .from('domains')
    .select('domain, verified')
    .eq('workspace_id', workspaceId)
    .limit(1)
    .single() as unknown as { data: { domain: string; verified: boolean } | null };
  return data;
}

async function getStats(testIds: string[]): Promise<Record<string, { views: number; conversions: number }>> {
  if (testIds.length === 0) return {};
  const { data: events } = await db
    .from('events')
    .select('test_id, type')
    .in('test_id', testIds) as unknown as { data: Array<{ test_id: string; type: string }> | null };
  const map: Record<string, { views: number; conversions: number }> = {};
  for (const ev of events || []) {
    if (!map[ev.test_id]) map[ev.test_id] = { views: 0, conversions: 0 };
    if (ev.type === 'pageview') map[ev.test_id].views++;
    else if (ev.type === 'conversion') map[ev.test_id].conversions++;
  }
  return map;
}

export default async function PagesPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const workspace = await getWorkspaceForClient(params.id);
  if (!workspace) notFound();

  const { data: client } = await db.from('clients').select('name').eq('id', params.id).single() as unknown as { data: { name: string } | null };
  const [tests, domain] = await Promise.all([
    getTests(workspace.id),
    getDomain(workspace.id),
  ]);

  const testIds = (tests as Array<{ id: string }>).map((t) => t.id);
  const stats = await getStats(testIds);

  return (
    <div>
      <Header title="Pages" subtitle={client?.name} />
      <div className="p-6">
        <PagesClient
          tests={tests}
          workspaceId={workspace.id}
          clientId={params.id}
          canManage={session.user.role !== 'viewer'}
          domain={domain?.verified ? domain.domain : undefined}
          stats={stats}
        />
      </div>
    </div>
  );
}
