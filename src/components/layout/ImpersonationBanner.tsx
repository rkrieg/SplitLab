import { getImpersonationState } from '@/lib/impersonation';
import { rawQuery } from '@/lib/db';
import StopImpersonatingButton from './StopImpersonatingButton';

export default async function ImpersonationBanner() {
  const { active, targetUserId } = await getImpersonationState();
  if (!active || !targetUserId) return null;

  const rows = await rawQuery<{ name: string; email: string }>(
    'SELECT name, email FROM users WHERE id = $1',
    [targetUserId]
  );
  const target = rows[0];
  if (!target) return null;

  return (
    <div className="bg-amber-500 text-white px-4 py-2 flex items-center justify-between text-sm font-medium z-50 sticky top-0">
      <div className="flex items-center gap-2">
        <span className="text-lg">👁️</span>
        <span>
          You are viewing as <strong>{target.name}</strong> ({target.email})
        </span>
      </div>
      <StopImpersonatingButton />
    </div>
  );
}
