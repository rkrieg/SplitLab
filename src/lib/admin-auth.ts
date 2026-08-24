import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';

/**
 * Gate for the /admin portal. Only `admin`-role accounts may enter; everyone
 * else is bounced. Call at the top of every admin page/layout for defense in
 * depth (don't rely on the layout alone to block child pages).
 */
export async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin') redirect('/dashboard');
  return session;
}
