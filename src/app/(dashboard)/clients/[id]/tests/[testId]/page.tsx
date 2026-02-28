import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
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

export default async function TestAnalyticsPage({
  params,
}: {
  params: { id: string; testId: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const test = await getTest(params.testId);
  if (!test) notFound();

  return (
    <div>
      <Header
        title={test.name}
        subtitle={`URL: ${test.url_path}`}
        actions={
          <Link href={`/clients/${params.id}/tests`} className="btn-secondary text-xs">
            <ArrowLeft size={14} /> Back to Tests
          </Link>
        }
      />
      <div className="p-6">
        <AnalyticsClient test={test} />
      </div>
    </div>
  );
}
