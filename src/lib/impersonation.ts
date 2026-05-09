import { headers } from 'next/headers';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export const IMP_COOKIE = 'sl_imp';
export const IMP_HEADER = 'x-sl-impersonating';

// Returns the effective user ID:
// - If super_admin is impersonating someone → returns the target user's ID
// - Otherwise → returns the real session user ID
export async function getEffectiveUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;

  if (session.user.role === 'super_admin') {
    try {
      const headersList = headers();
      const impersonating = headersList.get(IMP_HEADER);
      if (impersonating) return impersonating;
    } catch {
      // headers() not available in this context
    }
  }

  return session.user.id;
}

// Returns impersonation state for showing the banner
export async function getImpersonationState(): Promise<{
  active: boolean;
  targetUserId: string | null;
}> {
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'super_admin') return { active: false, targetUserId: null };

  try {
    const headersList = headers();
    const targetUserId = headersList.get(IMP_HEADER);
    return { active: !!targetUserId, targetUserId: targetUserId ?? null };
  } catch {
    return { active: false, targetUserId: null };
  }
}
