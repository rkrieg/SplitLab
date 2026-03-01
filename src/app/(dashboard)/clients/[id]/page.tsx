import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import Header from '@/components/layout/Header';
import Link from 'next/link';
import { FlaskConical, FileCode2, Code2, Globe, ArrowLeft, ChevronRight } from 'lucide-react';
import { TestStatusBadge } from '@/components/ui/Badge';

async function getClient(id: string) {
  const { data, error } = await db
    .from('clients')
    .select(`
      *,
      workspaces (
        *,
        domains (*),
        tests ( id, name, status, url_path, created_at, updated_at ),
        pages ( id ),
        scripts ( id )
      )
    `)
    .eq('id', id)
    .single();

  if (error) return null;
  return data;
}

export default async function ClientDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const client = await getClient(params.id);
  if (!client) notFound();

  const workspace = client.workspaces?.[0];

  const quickLinks = [
    {
      href: `/clients/${client.id}/tests`,
      icon: FlaskConical,
      label: 'Tests',
      desc: 'Manage A/B tests',
      count: (workspace?.tests ?? []).length,
    },
    {
      href: `/clients/${client.id}/pages`,
      icon: FileCode2,
      label: 'Pages',
      desc: 'HTML landing pages',
      count: (workspace?.pages ?? []).length,
    },
    {
      href: `/clients/${client.id}/scripts`,
      icon: Code2,
      label: 'Scripts',
      desc: 'Tracking & analytics scripts',
      count: (workspace?.scripts ?? []).length,
    },
    {
      href: `/clients/${client.id}/domains`,
      icon: Globe,
      label: 'Domains',
      desc: 'Custom domain configuration',
      count: (workspace?.domains ?? []).length,
    },
  ];

  const recentTests = (workspace?.tests ?? [])
    .sort(
      (a: { created_at: string }, b: { created_at: string }) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
    .slice(0, 5);

  return (
    <div>
      <Header
        title={client.name}
        subtitle={`/${client.slug}`}
        actions={
          <Link href="/clients" className="btn-secondary text-xs">
            <ArrowLeft size={14} /> All Clients
          </Link>
        }
      />

      <div className="p-6 space-y-6">
        {/* Quick links */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {quickLinks.map(({ href, icon: Icon, label, desc, count }) => (
            <Link
              key={href}
              href={href}
              className="card p-4 hover:border-indigo-500/50 transition-colors group"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="w-9 h-9 rounded-lg bg-slate-700 flex items-center justify-center">
                  <Icon size={16} className="text-slate-400" />
                </div>
                {count !== null && (
                  <span className="text-slate-500 text-xs font-medium">{count}</span>
                )}
              </div>
              <p className="font-medium text-slate-200 text-sm">{label}</p>
              <p className="text-slate-500 text-xs mt-0.5">{desc}</p>
            </Link>
          ))}
        </div>

        {/* Recent tests */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-slate-100">Recent Tests</h2>
            <Link
              href={`/clients/${client.id}/tests`}
              className="text-sm text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
            >
              View all <ChevronRight size={14} />
            </Link>
          </div>

          {recentTests.length === 0 ? (
            <div className="card p-8 text-center">
              <FlaskConical className="mx-auto text-slate-600 mb-3" size={28} />
              <p className="text-slate-400 text-sm mb-3">No tests yet for this client.</p>
              <Link href={`/clients/${client.id}/tests`} className="btn-primary text-sm">
                Create First Test
              </Link>
            </div>
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700">
                    <th className="text-left px-5 py-3 text-slate-400 font-medium">Name</th>
                    <th className="text-left px-5 py-3 text-slate-400 font-medium">URL Path</th>
                    <th className="text-left px-5 py-3 text-slate-400 font-medium">Status</th>
                    <th className="text-left px-5 py-3 text-slate-400 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTests.map((test: { id: string; name: string; url_path: string; status: string }) => (
                    <tr key={test.id} className="border-b border-slate-700/50 hover:bg-slate-700/20">
                      <td className="px-5 py-3 text-slate-200 font-medium">{test.name}</td>
                      <td className="px-5 py-3 text-slate-400 font-mono text-xs">{test.url_path}</td>
                      <td className="px-5 py-3">
                        <TestStatusBadge status={test.status} />
                      </td>
                      <td className="px-5 py-3">
                        <Link
                          href={`/clients/${client.id}/tests/${test.id}`}
                          className="text-indigo-400 hover:text-indigo-300 text-xs"
                        >
                          Analytics →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
