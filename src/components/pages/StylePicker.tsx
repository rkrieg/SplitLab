'use client';

import { useCallback, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { STYLE_OPTIONS } from '@/lib/ai-page-exemplars';
import AnchoredPanel from '@/components/ui/AnchoredPanel';
import { cn } from '@/lib/utils';

interface Props {
  value: string | null;
  onChange: (style: string | null) => void;
  disabled?: boolean;
}

/**
 * Visual style for the page — its own control, deliberately not part of the
 * Skills panel.
 *
 * A style is not a skill: skills are rules about how the page is written and
 * are multi-select, a style is one aesthetic and is single-select. Nesting the
 * two implied Style was a fifth skill, and hid it behind a panel you had to
 * open before you could see the most visible choice on the screen.
 *
 * A custom listbox rather than a native <select>, because each row is a label
 * plus a smaller, lighter "who it's for" line and an <option> cannot carry two
 * type styles. The list itself is portalled (see AnchoredPanel) so it is not
 * clipped by, and cannot spill out of, the scrolling column it sits in.
 */
export default function StylePicker({ value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  const selected = value ? STYLE_OPTIONS.find((o) => o.value === value) ?? null : null;

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2 text-left rounded-xl border bg-white dark:bg-slate-900/40 disabled:opacity-50',
          open ? 'border-indigo-500/40' : 'border-slate-200 dark:border-slate-800',
        )}
      >
        <span className="text-[11px] text-gray-500 shrink-0">Style:</span>
        <span className="text-[11px] font-medium text-slate-700 dark:text-slate-200 truncate">
          {selected ? selected.label : 'Auto'}
        </span>
        <ChevronDown
          size={13}
          className={cn('ml-auto shrink-0 text-slate-400 transition-transform', open && 'rotate-180')}
        />
      </button>

      <AnchoredPanel anchorRef={triggerRef} open={open} onClose={close}>
        <ul
          role="listbox"
          aria-label="Page style"
          className="divide-y divide-slate-100 dark:divide-slate-800"
        >
          <li>
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              onClick={() => { onChange(null); setOpen(false); }}
              className={cn(
                'w-full text-left px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-800',
                value === null && 'bg-indigo-500/10',
              )}
            >
              <span className="block text-[12px] font-medium text-slate-800 dark:text-slate-100">
                Auto
              </span>
              <span className="block text-[10px] leading-snug text-slate-400 dark:text-slate-500">
                Let the AI pick the style that fits the business
              </span>
            </button>
          </li>
          {STYLE_OPTIONS.map((opt) => (
            <li key={opt.value}>
              <button
                type="button"
                role="option"
                aria-selected={value === opt.value}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                className={cn(
                  'w-full text-left px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-800',
                  value === opt.value && 'bg-indigo-500/10',
                )}
              >
                <span className="block text-[12px] font-medium text-slate-800 dark:text-slate-100">
                  {opt.label}
                </span>
                <span className="block text-[10px] leading-snug text-slate-400 dark:text-slate-500">
                  {opt.bestFor}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </AnchoredPanel>

      {!open && (
        <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1 leading-snug px-0.5">
          {selected
            ? selected.mood
            : 'The style is chosen from the business you describe. The finished page tells you which one it picked.'}
        </p>
      )}
    </div>
  );
}
