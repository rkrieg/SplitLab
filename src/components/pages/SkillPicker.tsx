'use client';

import { useCallback, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Info, Lock } from 'lucide-react';
import { SKILL_CARDS, MAX_SKILLS, MANDATORY_SKILL_IDS, RECOMMENDED_SKILLS } from '@/lib/skills';
import AnchoredPanel from '@/components/ui/AnchoredPanel';
import { cn } from '@/lib/utils';

interface Props {
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

/**
 * Skills + Style pickers for the AI builder's first prompt.
 *
 * The point of this control is not configuration, it is agency: the client's
 * complaint was that the output did not feel directed by him. Every card
 * therefore states what it does, when to use it, and — the part that proves
 * the skills are genuinely different from each other — when NOT to.
 */
export default function SkillPicker({ selected, onChange, disabled }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setExpanded(false), []);

  const optionalSelectedCount = selected.filter((id) => !MANDATORY_SKILL_IDS.includes(id)).length;
  const activeCount = optionalSelectedCount + MANDATORY_SKILL_IDS.length;
  const atLimit = activeCount >= MAX_SKILLS;
  // A nudge, not a block. Past this point every extra rule block competes with
  // the others for the model's attention and rules start losing to each other
  // quietly — but nothing errors, so the user stays in charge of the call.
  const overRecommended = activeCount > RECOMMENDED_SKILLS;

  function toggle(id: string) {
    if (disabled) return;
    if (MANDATORY_SKILL_IDS.includes(id)) return;
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
      return;
    }
    if (atLimit) return;
    onChange([...selected, id]);
  }

  const activeNames = SKILL_CARDS.filter(
    (c) => c.mandatory || selected.includes(c.id),
  ).map((c) => c.name);

  return (
    // The card list is portalled (see AnchoredPanel). Expanding it inline used
    // to push the prompt textarea down inside a fixed-height column and squash
    // the chat above it; opening it upward in-flow then spilled it over the app
    // header instead. Out of flow entirely is the only version that holds while
    // the composer grows under it.
    <div>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-haspopup="true"
        aria-expanded={expanded}
        className={cn(
          'w-full flex items-center justify-between gap-2 px-3 py-2 text-left rounded-xl border bg-white dark:bg-slate-900/40',
          expanded
            ? 'border-indigo-500/40'
            : 'border-slate-200 dark:border-slate-800',
        )}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-[11px] text-gray-500 shrink-0">Skills:</span>
          <span className="text-[11px] font-medium text-slate-700 dark:text-slate-200 truncate">
            {activeNames.join(' · ')}
          </span>
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          {overRecommended && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              <AlertTriangle size={11} />
              {activeCount}
            </span>
          )}
          <ChevronDown
            size={13}
            className={cn('text-slate-400 transition-transform', expanded && 'rotate-180')}
          />
        </span>
      </button>

      <AnchoredPanel anchorRef={triggerRef} open={expanded} onClose={close} maxHeight={460}>
        <div className="p-3 space-y-2">
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Each skill adds rules to how the page is written, and is checked against the finished
            page. {RECOMMENDED_SKILLS} at a time works best.
          </p>

          {overRecommended && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2">
              <AlertTriangle size={13} className="mt-px shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-[11px] leading-snug text-amber-800 dark:text-amber-200">
                <span className="font-medium">{activeCount} skills selected.</span> Past{' '}
                {RECOMMENDED_SKILLS}, each set of rules gets less of the AI&apos;s attention and some
                start to get missed. Nothing will break — but you&apos;ll usually get a sharper page
                by unticking whatever this one doesn&apos;t need.
              </p>
            </div>
          )}

          <div className="grid gap-1.5">
            {SKILL_CARDS.map((card) => {
              const isOn = card.mandatory || selected.includes(card.id);
              const isBlocked = !isOn && !card.mandatory && atLimit;
              return (
                <div
                  key={card.id}
                  className={cn(
                    'rounded-lg border transition-colors',
                    isOn
                      ? 'border-indigo-500/40 bg-indigo-500/5'
                      : 'border-slate-200 dark:border-slate-700',
                    isBlocked && 'opacity-45',
                  )}
                >
                  <div className="flex items-start gap-2 p-2">
                    <button
                      type="button"
                      onClick={() => toggle(card.id)}
                      disabled={disabled || card.mandatory || isBlocked}
                      aria-pressed={isOn}
                      title={card.mandatory ? 'Always on' : isBlocked ? `Limit is ${MAX_SKILLS}` : undefined}
                      className={cn(
                        'mt-0.5 w-4 h-4 rounded shrink-0 border flex items-center justify-center',
                        isOn
                          ? 'bg-indigo-600 border-indigo-600 text-white'
                          : 'border-slate-300 dark:border-slate-600',
                        (card.mandatory || isBlocked) && 'cursor-not-allowed',
                      )}
                    >
                      {card.mandatory ? <Lock size={9} /> : isOn ? <Check size={11} /> : null}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12px] font-medium text-slate-800 dark:text-slate-100">
                          {card.name}
                        </span>
                        {card.mandatory && (
                          <span className="text-[9px] uppercase tracking-wide px-1 py-px rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                            Always on
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => setOpenCard(openCard === card.id ? null : card.id)}
                          className="ml-auto text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                          aria-label={`Details for ${card.name}`}
                        >
                          <Info size={12} />
                        </button>
                      </div>
                      <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400 mt-0.5">
                        {card.description}
                      </p>
                      {openCard === card.id && (
                        <dl className="mt-1.5 space-y-1 text-[11px] leading-snug">
                          <div>
                            <dt className="inline font-medium text-emerald-700 dark:text-emerald-400">Use for: </dt>
                            <dd className="inline text-slate-500 dark:text-slate-400">{card.useFor}</dd>
                          </div>
                          <div>
                            <dt className="inline font-medium text-amber-700 dark:text-amber-400">Not for: </dt>
                            <dd className="inline text-slate-500 dark:text-slate-400">{card.notFor}</dd>
                          </div>
                        </dl>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Only when there is something left to tick. With every skill
              already on, "that's the limit" reads as an error about a state the
              user did not cause. */}
          {atLimit && selected.length < SKILL_CARDS.length && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              That&apos;s the limit of {MAX_SKILLS}. Untick one to swap.
            </p>
          )}
        </div>
      </AnchoredPanel>
    </div>
  );
}
