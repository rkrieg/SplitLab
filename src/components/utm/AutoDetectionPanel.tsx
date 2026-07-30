'use client';

import { useEffect, useState } from 'react';
import { Sparkles, Check, X, Loader2, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import { cn } from '@/lib/utils';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

// UTM Personalization V2 (auto-detection) — the in-screen detection card,
// chip field-selector, and AI content review/approval flow. Lives inside
// the existing per-variant UTM Personalization screen (UTMPickerClient),
// not a separate dashboard notification system.
// See docs/utm-personalization-v2-automation.md for the full design.

interface Detection {
  id: string;
  page_id: string;
  utm_sig: string;
  utm: Record<string, string>;
  distinct_visitor_count: number;
  status: string;
}

type Stage = 'collapsed' | 'select' | 'generating' | 'review';

const PRIMARY_FIELD_PRIORITY = ['utm_campaign', 'utm_medium', 'utm_source', 'utm_content', 'utm_term'];

function guessDefaultField(utm: Record<string, string>): string {
  for (const key of PRIMARY_FIELD_PRIORITY) {
    if (utm[key]) return key;
  }
  return Object.keys(utm)[0] ?? '';
}

interface CardProps {
  pageId: string;
  detection: Detection;
  hasTextFields: boolean;
  onResolved: (detectionId: string) => void;
  onRuleCreated: () => void;
}

function DetectionCard({ pageId, detection, hasTextFields, onResolved, onRuleCreated }: CardProps) {
  const [stage, setStage] = useState<Stage>('collapsed');
  const [selectedFields, setSelectedFields] = useState<Set<string>>(
    () => new Set([guessDefaultField(detection.utm)])
  );
  const [hint, setHint] = useState('');
  const [confirmingReject, setConfirmingReject] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  function toggleField(key: string) {
    setSelectedFields(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function reject() {
    setRejecting(true);
    try {
      const res = await fetch(`/api/pages/${pageId}/utm-detections`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ detection_id: detection.id, action: 'reject' }),
      });
      if (!res.ok) throw new Error('Failed to dismiss');
      onResolved(detection.id);
    } catch {
      toast.error('Failed to dismiss');
      setRejecting(false);
    }
  }

  async function generate() {
    if (selectedFields.size === 0) {
      toast.error('Select at least one parameter.');
      return;
    }
    setGenerating(true);
    setStage('generating');
    try {
      const conditions = Array.from(selectedFields).map(match_param => ({
        match_param,
        match_value: detection.utm[match_param],
      }));
      const res = await fetch(`/api/pages/${pageId}/personalization-rules/auto-generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conditions, hint }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate content');
      setOverrides(data.overrides_json ?? {});
      setStage('review');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate content');
      setStage('select');
    } finally {
      setGenerating(false);
    }
  }

  async function approve() {
    setApproving(true);
    try {
      const conditions = Array.from(selectedFields).map(match_param => ({
        match_param,
        match_value: detection.utm[match_param],
      }));
      const res = await fetch(`/api/pages/${pageId}/personalization-rules/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conditions, overrides_json: overrides, detection_id: detection.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save rule');
      toast.success('Personalization rule created');
      onResolved(detection.id);
      onRuleCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save rule');
      setApproving(false);
    }
  }

  return (
    <div className="rounded-xl border-2 border-indigo-400 dark:border-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setStage(s => (s === 'collapsed' ? 'select' : 'collapsed'))}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles size={14} className="text-indigo-500 flex-shrink-0" />
          <span className="text-xs font-medium text-indigo-700 dark:text-indigo-300 truncate">
            New traffic: {Object.entries(detection.utm).map(([k, v]) => `${k}=${v}`).join(', ')}
            <span className="text-indigo-400 dark:text-indigo-500 font-normal"> · {detection.distinct_visitor_count} visitors</span>
          </span>
        </div>
        <ChevronDown size={14} className={cn('flex-shrink-0 text-indigo-400 transition-transform', stage !== 'collapsed' && 'rotate-180')} />
      </button>

      {stage !== 'collapsed' && (
        <div className="px-3 pb-3 space-y-3">
          {!hasTextFields && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Map at least one text field above before personalizing this traffic.
            </p>
          )}

          {(stage === 'select' || stage === 'generating') && (
            <>
              <div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-1.5">
                  Personalize based on: (we pre-selected the most likely one)
                </p>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 mb-1.5">
                  Fewer selected = matches more visitors. More selected = matches only this exact combination.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(detection.utm).map(([key, value]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggleField(key)}
                      className={cn(
                        'text-[11px] px-2 py-1 rounded-lg border font-medium transition-colors',
                        selectedFields.has(key)
                          ? 'bg-indigo-600 border-indigo-600 text-white'
                          : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-300'
                      )}
                    >
                      {selectedFields.has(key) && <Check size={10} className="inline mr-1 -mt-0.5" />}
                      {key}={value}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-1.5">
                  Tell the AI what to say to these visitors (optional)
                </p>
                <textarea
                  value={hint}
                  onChange={e => setHint(e.target.value)}
                  placeholder='e.g. "emphasize free returns" — leave blank to let AI decide based on the values above'
                  rows={2}
                  className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-400 resize-none"
                />
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingReject(true)}
                  disabled={rejecting}
                  className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-40"
                >
                  {rejecting ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                  Dismiss
                </button>
                <ConfirmDialog
                  open={confirmingReject}
                  onClose={() => setConfirmingReject(false)}
                  onConfirm={() => {
                    setConfirmingReject(false);
                    reject();
                  }}
                  title="Dismiss this detection?"
                  description="This UTM combination won't be suggested again, even if traffic to it grows further. This can't be undone."
                  confirmLabel="Dismiss"
                  loading={rejecting}
                />
                <button
                  type="button"
                  onClick={generate}
                  disabled={generating || !hasTextFields}
                  className="flex-1 flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium disabled:opacity-40"
                >
                  {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                  {generating ? 'Generating…' : 'Generate preview'}
                </button>
              </div>
            </>
          )}

          {stage === 'review' && (
            <>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Shows to visitors where {Array.from(selectedFields).map(k => `${k} = "${detection.utm[k]}"`).join(' and ')}
              </p>
              <div className="space-y-2">
                {Object.entries(overrides).map(([key, value]) => (
                  <div key={key}>
                    <label className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">{key}</label>
                    <textarea
                      value={value}
                      onChange={e => setOverrides(o => ({ ...o, [key]: e.target.value }))}
                      rows={2}
                      className="w-full mt-0.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 dark:text-slate-200 focus:outline-none focus:border-indigo-400 resize-none"
                    />
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStage('select')}
                  className="text-xs px-3 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={approve}
                  disabled={approving}
                  className="flex-1 flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium disabled:opacity-40"
                >
                  {approving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  Approve & Publish
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface PanelProps {
  pageId: string;
  hasTextFields: boolean;
  onRuleCreated?: () => void;
}

export default function AutoDetectionPanel({ pageId, hasTextFields, onRuleCreated }: PanelProps) {
  const [detections, setDetections] = useState<Detection[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pages/${pageId}/utm-detections`)
      .then(res => res.json())
      .then(data => {
        if (!cancelled) setDetections((data.detections ?? []).filter((d: Detection) => d.status === 'notified'));
      })
      .catch(() => {
        if (!cancelled) setDetections([]);
      });
    return () => { cancelled = true; };
  }, [pageId]);

  function handleResolved(detectionId: string) {
    setDetections(prev => (prev ?? []).filter(d => d.id !== detectionId));
  }

  if (!detections || detections.length === 0) return null;

  return (
    <section className="space-y-2">
      {detections.map(d => (
        <DetectionCard
          key={d.id}
          pageId={pageId}
          detection={d}
          hasTextFields={hasTextFields}
          onResolved={handleResolved}
          onRuleCreated={() => onRuleCreated?.()}
        />
      ))}
    </section>
  );
}
