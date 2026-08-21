import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import LandingPage from './LandingPage';
import StructuredData from '@/components/seo/StructuredData';

export default async function RootPage() {
  const session = await getServerSession(authOptions);
  if (session) redirect('/dashboard');
  return (
    <>
      <StructuredData />
      <LandingPage />
    </>
  );
}
