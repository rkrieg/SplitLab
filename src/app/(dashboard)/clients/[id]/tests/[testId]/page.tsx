import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import AnalyticsClient from './AnalyticsClient';

async function getTest(testId: string) {
  const { data, error } = await db
    .from('tests')
    .select('*, test_variants(*, pages(id, name)), conversion_goals(*)')
    .eq('id', testId)
    .single();
  if (error) return null;
  return data;
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

export default async function TestAnalyticsPage({
  params,
}: {
  params: { id: string; testId: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const test = await getTest(params.testId);
  if (!test) notFound();

  const { data: client } = await db.from('clients').select('name').eq('id', params.id).single();

  // Get workspace domain
  const { data: workspace } = await db.from('workspaces').select('id').eq('client_id', params.id).single();
  let domain: string | undefined;
  if (workspace) {
    const { data: domainData } = await db
      .from('domains')
      .select('domain, verified')
      .eq('workspace_id', workspace.id)
      .eq('verified', true)
      .limit(1)
      .single();
    if (domainData) domain = domainData.domain;
  }

  return (
    <AnalyticsClient
      test={test}
      appUrl={APP_URL}
      clientId={params.id}
      clientName={client?.name || 'Client'}
      domain={domain}
    />
  );
}
