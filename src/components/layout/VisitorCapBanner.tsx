'use client';

import Link from 'next/link';

interface Props {
  used: number;
  limit: number;
  limitLabel: string;
}

export default function VisitorCapBanner({ used, limit, limitLabel }: Props) {
  const pct = Math.round((used / limit) * 100);
  const isOver = used >= limit;
  const isNearing = !isOver && pct >= 80;

  if (!isOver && !isNearing) return null;

  return (
    <div className={`w-full px-4 py-2.5 flex items-center justify-between gap-4 text-sm font-medium ${isOver ? 'bg-red-600 text-white' : 'bg-amber-500 text-white'}`}>
      <span>
        {isOver
          ? `Unique Visitor limit reached (${used.toLocaleString()} / ${limitLabel}/mo). New visitors are being served but not tracked.`
          : `Approaching visitor limit — ${used.toLocaleString()} / ${limitLabel} visitors used this month (${pct}%).`}
      </span>
      <Link
        href="/billing"
        className="shrink-0 rounded bg-white/20 hover:bg-white/30 px-3 py-1 text-white transition-colors"
      >
        Upgrade Plan →
      </Link>
    </div>
  );
}
