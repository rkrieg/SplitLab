import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import Header from '@/components/layout/Header';
import SettingsClient from './SettingsClient';

export default async function SettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  return (
    <div>
      <Header title="Settings" subtitle="Account and platform configuration" />
      <div className="p-6">
        <SettingsClient user={{ id: session.user.id, name: session.user.name, email: session.user.email, role: session.user.role }} />
      </div>
    </div>
  );
}
