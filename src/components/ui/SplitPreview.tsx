'use client';

import { ArrowRight } from 'lucide-react';

export interface SplitPreviewRow {
  id: string;
  name: string;
  /** Weight the variant has right now. */
  before: number;
  /** Weight after the change, or null if it is leaving the live split. */
  after: number | null;
}

/**
 * Before → after table for any change to a test's traffic split.
 *
 * Shown before archiving, deleting, or re-weighting a variant, and live while
 * adding one. A split change moves real ad spend between pages, so it is never
 * applied on a click alone — the exact numbers are on screen first, and a drop
 * like 100% → 14% is impossible to do without seeing it.
 */
export default function SplitPreview({
  rows,
  className = '',
}: {
  rows: SplitPreviewRow[];
  className?: string;
}) {
  if (rows.length === 0) return null;

  const unchanged = rows.every((r) => r.after === r.before);

  return (
    <div className={`rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden ${className}`}>
      <div className="flex items-center justify-between px-3 py-2 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Traffic split</span>
        <span className="text-[11px] text-slate-400 dark:text-slate-500">
          {unchanged ? 'No traffic moves' : 'Now → After'}
        </span>
      </div>
      <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
        {rows.map((row) => {
          const removed = row.after === null;
          const changed = !removed && row.after !== row.before;
          const increased = !removed && row.after !== null && row.after > row.before;
          return (
            <div key={row.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span
                className={`flex-1 truncate ${removed ? 'text-slate-400 dark:text-slate-500 line-through' : 'text-slate-700 dark:text-slate-200'}`}
                title={row.name}
              >
                {row.name}
              </span>
              <span className="tabular-nums text-slate-400 dark:text-slate-500 w-10 text-right">
                {row.before}%
              </span>
              <ArrowRight size={12} className="text-slate-300 dark:text-slate-600 flex-shrink-0" />
              <span
                className={`tabular-nums w-12 text-right font-medium ${
                  removed
                    ? 'text-slate-400 dark:text-slate-500'
                    : changed
                      ? increased
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-amber-600 dark:text-amber-400'
                      : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {removed ? 'off' : `${row.after}%`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
