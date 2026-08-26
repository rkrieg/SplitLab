'use client';

import { useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SkillScoreRow {
  skillId: string;
  skillName: string;
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

interface Props {
  scores: SkillScoreRow[];
  skillNames: string[];
  styleLabel: string | null;
  verticalLabel: string | null;
}

/**
 * "Built with" + the per-check result of the finished page.
 *
 * Display only. Nothing here blocks a save, triggers a rebuild, or changes the
 * page. A failed row is information the user can act on by asking for a change
 * in chat — which is why every row carries the detail sentence rather than just
 * a tick. A number with no explanation is the thing that erodes trust fastest.
 */
export default function SkillScorePanel({ scores, skillNames, styleLabel, verticalLabel }: Props) {
  const [open, setOpen] = useState(false);
  if (skillNames.length === 0) return null;

  const passed = scores.filter((s) => s.passed).length;
  const builtWith = [...skillNames, verticalLabel, styleLabel].filter(Boolean) as string[];

  return (
    <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        // Nothing to expand into after an edit clears the scores — the line
        // still names what built the page, it just stops pretending to open.
        disabled={scores.length === 0}
        className="w-full flex items-center gap-2 px-4 py-2 text-left disabled:cursor-default"
      >
        <span className="text-[11px] text-gray-500 shrink-0">Built with:</span>
        <span className="text-[11px] font-medium text-slate-700 dark:text-slate-200 truncate">
          {builtWith.join(' · ')}
        </span>
        {scores.length > 0 && (
          <span
            className={cn(
              'ml-auto shrink-0 text-[11px] font-medium px-1.5 py-0.5 rounded',
              passed === scores.length
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
            )}
          >
            {passed}/{scores.length} checks passed
          </span>
        )}
        {scores.length > 0 && (
          <ChevronDown
            size={13}
            className={cn('text-slate-400 shrink-0 transition-transform', open && 'rotate-180')}
          />
        )}
      </button>

      {open && scores.length > 0 && (
        <div className="px-4 pb-3 max-h-52 overflow-y-auto">
          <ul className="space-y-1.5">
            {scores.map((row) => (
              <li key={`${row.skillId}:${row.id}`} className="flex items-start gap-2">
                <span
                  className={cn(
                    'mt-0.5 w-4 h-4 rounded-full shrink-0 flex items-center justify-center',
                    row.passed
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
                  )}
                >
                  {row.passed ? <Check size={10} /> : <X size={10} />}
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-slate-700 dark:text-slate-200 leading-snug">
                    {row.label}
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                    {row.detail}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2 leading-snug">
            These are read from the finished HTML. They never change the page — ask in chat if you
            want something fixed.
          </p>
        </div>
      )}
    </div>
  );
}
