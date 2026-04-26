import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import AnalyticsClient from './AnalyticsClient';

interface Variant {
  id: string;
  name: string;
  is_control: boolean;
  traffic_weight: number;
  redirect_url?: string | null;
  proxy_mode?: boolean;
  pages?: { id: string; name: string } | null;
  tracking_verified?: boolean | null;
  is_ai_generated?: boolean;
  variant_type?: string;
  hosted_url?: string | null;
}

interface Goal {
  id: string;
  name: string;
  type: string;
  selector: string | null;
  url_pattern: string | null;
  is_primary: boolean;
}

interface Test {
  id: string;
  name: string;
  url_path: string;
  status: string;
  head_scripts?: string | null;
  test_variants?: Variant[];
  conversion_goals?: Goal[];
}

async function getTest(testId: string): Promise<Test | null> {
  const { data, error } = await db
    .from('tests')
    .select('*, test_variants(*, pages(id, name)), conversion_goals(*)')
    .eq('id', testId)
    .single() as unknown as { data: Test | null; error: unknown };
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

  const { data: client } = await db.from('clients').select('name').eq('id', params.id).single() as unknown as { data: { name: string } | null };

  // Get workspace domain
  const { data: workspace } = await db.from('workspaces').select('id').eq('client_id', params.id).single() as unknown as { data: { id: string } | null };
  let domain: string | undefined;
  if (workspace) {
    const { data: domainData } = await db
      .from('domains')
      .select('domain, verified')
      .eq('workspace_id', workspace.id)
      .limit(1)
      .single() as unknown as { data: { domain: string; verified: boolean } | null };
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
