'use client';

import { useEffect, useState } from 'react';
import { Sparkles, Plus, Trash2, Loader2, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { cn } from '@/lib/utils';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

// UTM Personalization V2 pivot (2026-07-30). See docs/utm-personalization-v2-automation.md,
// "PIVOT" section. Replaces the old traffic-reactive value-chip + approval
// flow (AutoDetectionPanel) — the user now defines a rule upfront (which
// field(s) to watch + an optional loose hint), and a background job judges
// new incoming values against it and publishes matched content automatically,
// with no review/approval step.

const FIELD_OPTIONS = [
  'utm_campaign', 'utm_medium', 'utm_source', 'utm_content', 'utm_term',
  'ad_id', 'adset_id', 'campaign_id', 'creative_id', 'placement_id',
];

interface AutoRule {
  id: string;
  fields: string[];
  hint: string;
  enabled: boolean;
  created_at: string;
}

interface Props {
  pageId: string;
}

export default function AutoRulesPanel({ pageId }: Props) {
  const [rules, setRules] = useState<AutoRule[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [hint, setHint] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pages/${pageId}/auto-rules`)
      .then(res => res.json())
      .then(data => { if (!cancelled) setRules(data.rules ?? []); })
      .catch(() => { if (!cancelled) setRules([]); });
    return () => { cancelled = true; };
  }, [pageId]);

  function toggleField(f: string) {
    setSelectedFields(prev => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  }

  async function saveRule() {
    if (selectedFields.size === 0) {
      toast.error('Select at least one UTM field.');
      return;
    }
    if (hint.trim().length < 3) {
      toast.error('Describe what to look for (at least a few words) — this guides the AI judgment.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/pages/${pageId}/auto-rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: Array.from(selectedFields), hint }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save rule');
      setRules(prev => [data.rule, ...(prev ?? [])]);
      setCreating(false);
      setSelectedFields(new Set());
      setHint('');
      toast.success('Auto-personalization rule saved. New matching traffic will be personalized automatically.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save rule');
    } finally {
      setSaving(false);
    }
  }

  async function deleteRule(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/pages/${pageId}/auto-rules?rule_id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete rule');
      setRules(prev => (prev ?? []).filter(r => r.id !== id));
    } catch {
      toast.error('Failed to delete rule');
    } finally {
      setDeletingId(null);
      setConfirmingDeleteId(null);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-400">
        Pick which UTM field(s) to watch and, optionally, what to look for. New matching
        traffic is personalized and published automatically — no review step.
      </p>

      {rules === null ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : (
        rules.map(r => (
          <div key={r.id} className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">
                Watching: {r.fields.join(' + ')}
              </p>
              {r.hint && <p className="text-xs text-slate-400 truncate mt-0.5">"{r.hint}"</p>}
            </div>
            <button
              onClick={() => setConfirmingDeleteId(r.id)}
              disabled={deletingId === r.id}
              className="p-1 text-red-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors flex-shrink-0"
              title="Remove rule"
            >
              {deletingId === r.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            </button>
            <ConfirmDialog
              open={confirmingDeleteId === r.id}
              onClose={() => setConfirmingDeleteId(null)}
              onConfirm={() => deleteRule(r.id)}
              title="Remove this auto-personalization rule?"
              description="Future matching traffic will no longer be personalized. Rules/content already published from this rule stay live."
              confirmLabel="Remove"
              loading={deletingId === r.id}
            />
          </div>
        ))
      )}

      {creating ? (
        <div className="p-3 rounded-xl border-2 border-indigo-400 dark:border-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 space-y-2.5">
          <div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-1.5">Watch these field(s):</p>
            <div className="flex flex-wrap gap-1.5">
              {FIELD_OPTIONS.map(f => (
                <button
                  key={f}
                  type="button"
                  onClick={() => toggleField(f)}
                  className={cn(
                    'text-[11px] px-2 py-1 rounded-lg border font-medium transition-colors',
                    selectedFields.has(f)
                      ? 'bg-indigo-600 border-indigo-600 text-white'
                      : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-300'
                  )}
                >
                  {selectedFields.has(f) && <Check size={10} className="inline mr-1 -mt-0.5" />}
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-1.5">What should AI look for?</p>
            <textarea
              value={hint}
              onChange={e => setHint(e.target.value)}
              placeholder='e.g. "roofers" or "location: United States"'
              rows={2}
              required
              className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-400 resize-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setCreating(false); setSelectedFields(new Set()); setHint(''); }}
              className="text-xs px-3 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveRule}
              disabled={saving}
              className="flex-1 flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium disabled:opacity-40"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              Save rule
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="w-full flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-indigo-300 hover:text-indigo-500"
        >
          <Plus size={12} /> Add auto-personalization rule
        </button>
      )}
    </div>
  );
}
