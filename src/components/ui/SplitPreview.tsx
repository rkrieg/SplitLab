'use client';

import { ArrowRight } from 'lucide-react';

export interface SplitPreviewRow {
  id: string;
  name: string;
  /** Weight the variant has right now. */
  before: number;
  /** Weight after the change. Null when the field is empty or unparseable. */
  after: number | null;
  /** True for the variant leaving the live split (archive or delete). */
  removed?: boolean;
}

/**
 * Before → after table for any change to a test's traffic split.
 *
 * Shown before archiving, deleting, or re-weighting a variant. A split change
 * moves real ad spend between pages, so it is never applied on a click alone —
 * the exact numbers are on screen first, and a drop like 100% → 14% is
 * impossible to do without seeing it.
 *
 * Pass `onDraftChange` to make the "after" column editable. The proportional
 * result is only ever the starting point: whoever is moving the traffic gets
 * to say exactly where it lands, as long as it still adds up to 100.
 */
export default function SplitPreview({
  rows,
  className = '',
  drafts,
  onDraftChange,
  total,
  error,
}: {
  rows: SplitPreviewRow[];
  className?: string;
  /** Raw input text per variant id — kept as strings so a field can be empty mid-typing. */
  drafts?: Record<string, string>;
  onDraftChange?: (id: string, value: string) => void;
  /** Sum of the drafts, or null if any of them is not a number yet. */
  total?: number | null;
  /** Why the split can't be applied. Shown under the table. */
  error?: string | null;
}) {
  if (rows.length === 0) return null;

  const editable = !!onDraftChange && !!drafts;
  const unchanged = rows.every((r) => !r.removed && r.after === r.before);

  return (
    <div className={className}>
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Traffic split</span>
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            {editable ? 'Now → After (editable)' : unchanged ? 'No traffic moves' : 'Now → After'}
          </span>
        </div>

        <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
          {rows.map((row) => {
            const removed = !!row.removed;
            const changed = !removed && row.after !== null && row.after !== row.before;
            const increased = !removed && row.after !== null && row.after > row.before;
            const afterTone = removed
              ? 'text-slate-400 dark:text-slate-500'
              : changed
                ? increased
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-amber-600 dark:text-amber-400'
                : 'text-slate-500 dark:text-slate-400';

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

                {editable && !removed ? (
                  <span className="flex items-center gap-1">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={drafts[row.id] ?? ''}
                      onChange={(e) => onDraftChange(row.id, e.target.value)}
                      aria-label={`Traffic weight for ${row.name}`}
                      className={`w-14 rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1 text-right text-sm font-medium tabular-nums focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 ${afterTone}`}
                    />
                    <span className="text-xs text-slate-400 dark:text-slate-500 w-3">%</span>
                  </span>
                ) : (
                  <span className={`tabular-nums w-12 text-right font-medium ${afterTone}`}>
                    {removed ? 'off' : row.after === null ? '—' : `${row.after}%`}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {editable && (
          <div
            className={`flex items-center justify-between px-3 py-2 border-t text-xs font-medium ${
              total === 100
                ? 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300'
                : 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400'
            }`}
          >
            <span>Total</span>
            <span className="tabular-nums">{total === null ? '—' : `${total}%`}</span>
          </div>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
