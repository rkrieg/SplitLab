'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  Sparkles, Globe, Loader2, Check, X, RotateCcw,
  ChevronDown, ChevronUp, Rocket, ArrowLeft, Wand2,
  Monitor, Smartphone, Save, Download, Bold, Italic, Type,
} from 'lucide-react';
import Button from '@/components/ui/Button';

interface ChangeItem {
  change: string;
  reason: string;
}

interface GeneratedVariant {
  index: number;
  variant_id: string;
  label: string;
  impact_hypothesis: string;
  changes_summary: ChangeItem[];
  hosted_url: string;
  status: 'ready' | 'error';
  error?: string;
  approved: boolean;
}

interface Analysis {
  page_type?: string;
  primary_offer?: string;
  target_audience?: string;
  cta_strategy?: string;
  tone_of_voice?: string;
  color_palette?: string[];
  [key: string]: unknown;
}

interface Props {
  workspaceId: string;
  clientId: string;
  domain?: string;
}

type Step = 'input' | 'analyzed' | 'plan' | 'generating' | 'review';
type PreviewMode = 'desktop' | 'mobile';

export default function AIGenerateClient({ workspaceId, clientId, domain }: Props) {
  const router = useRouter();

  // Step state
  const [step, setStep] = useState<Step>('input');

  // Input step
  const [url, setUrl] = useState('');
  const [instructions, setInstructions] = useState('');
  const [scraping, setScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState('');

  // Plan step
  const [variantPlan, setVariantPlan] = useState<{ summary: string; variants: Array<{ title: string; hypothesis: string; changes: string[]; preserves: string[] }>; editable_prompt: string } | null>(null);
  const [editableInstructions, setEditableInstructions] = useState('');
  const [planLoading, setPlanLoading] = useState(false);

  // Analysis result
  const [scrapedPageId, setScrapedPageId] = useState('');
  const [screenshotDesktop, setScreenshotDesktop] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);

  // Generation
  const [variants, setVariants] = useState<GeneratedVariant[]>([]);
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState('');
  const [activeTab, setActiveTab] = useState(0);
  const [expandedChanges, setExpandedChanges] = useState<Set<number>>(new Set());

  // Preview & editing
  const [previewMode, setPreviewMode] = useState<PreviewMode>('desktop');
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenInstructions, setRegenInstructions] = useState('');
  const [showRegenInput, setShowRegenInput] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Floating toolbar
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  // Test creation
  const [testName, setTestName] = useState('');
  const [urlPath, setUrlPath] = useState('/');
  const [launching, setLaunching] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // ─── Inline Editor: listen for selection in iframe ──────────────────

  useEffect(() => {
    if (!editMode) {
      setToolbarPos(null);
      return;
    }

    const iframe = iframeRef.current;
    if (!iframe) return;

    function handleIframeLoad() {
      const iframeDoc = iframe!.contentDocument;
      if (!iframeDoc) return;

      // Make editable elements contentEditable
      const editables = iframeDoc.querySelectorAll('[data-sl-editable]');
      editables.forEach((el) => {
        (el as HTMLElement).contentEditable = 'true';
        (el as HTMLElement).style.outline = 'none';
        (el as HTMLElement).style.cursor = 'text';
      });

      // Listen for selection changes to show toolbar
      iframeDoc.addEventListener('selectionchange', () => {
        const sel = iframeDoc.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) {
          setToolbarPos(null);
          return;
        }
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const iframeRect = iframe!.getBoundingClientRect();
        setToolbarPos({
          x: iframeRect.left + rect.left + rect.width / 2,
          y: iframeRect.top + rect.top - 48,
        });
      });
    }

    iframe.addEventListener('load', handleIframeLoad);
    // Also try immediately in case already loaded
    handleIframeLoad();

    return () => {
      iframe.removeEventListener('load', handleIframeLoad);
    };
  }, [editMode, activeTab]);

  // ─── Toolbar commands ───────────────────────────────────────────────

  function execCommand(command: string, value?: string) {
    const iframeDoc = iframeRef.current?.contentDocument;
    if (!iframeDoc) return;
    iframeDoc.execCommand(command, false, value);
  }

  // ─── Save edited HTML ───────────────────────────────────────────────

  async function handleSave() {
    const iframe = iframeRef.current;
    if (!iframe?.contentDocument) return;
    const variant = variants[activeTab];
    if (!variant || variant.status !== 'ready') return;

    setSaving(true);
    try {
      const html = '<!DOCTYPE html>' + iframe.contentDocument.documentElement.outerHTML;
      const res = await fetch(`/api/ai/variants/${variant.variant_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Failed to save');
        return;
      }
      const data = await res.json();
      toast.success(`Saved (v${data.version})`);
    } catch {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  }

  // ─── Regenerate variant ─────────────────────────────────────────────

  async function handleRegenerate() {
    const variant = variants[activeTab];
    if (!variant || variant.status !== 'ready') return;

    setRegenerating(true);
    try {
      const res = await fetch(`/api/ai/variants/${variant.variant_id}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instructions: regenInstructions.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Regeneration failed');
        return;
      }
      const data = await res.json();
      // Update variant in state
      setVariants(prev => prev.map(v =>
        v.variant_id === variant.variant_id
          ? {
              ...v,
              label: data.label || v.label,
              impact_hypothesis: data.impact_hypothesis || v.impact_hypothesis,
              changes_summary: data.changes_summary || v.changes_summary,
            }
          : v
      ));
      // Reload iframe
      if (iframeRef.current) {
        iframeRef.current.src = variant.hosted_url + '?v=' + data.version;
      }
      toast.success('Variant regenerated!');
      setShowRegenInput(false);
      setRegenInstructions('');
    } catch {
      toast.error('Regeneration failed');
    } finally {
      setRegenerating(false);
    }
  }

  // ─── Export HTML ────────────────────────────────────────────────────

  function handleExport() {
    const iframe = iframeRef.current;
    if (!iframe?.contentDocument) return;
    const variant = variants[activeTab];
    if (!variant) return;

    const html = '<!DOCTYPE html>' + iframe.contentDocument.documentElement.outerHTML;
    const blob = new Blob([html], { type: 'text/html' });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `variant-${variant.label.toLowerCase().replace(/\s+/g, '-')}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);
    toast.success('HTML exported');
  }

  // ─── Step 1: Analyze Page ──────────────────────────────────────────

  const handleAnalyze = useCallback(async (forceRefresh = false) => {
    if (!url.trim()) return;
    setScraping(true);
    setScrapeError('');
    try {
      const res = await fetch('/api/ai/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), force: forceRefresh }),
      });
      if (!res.ok) {
        let errMsg = 'Failed to analyze page';
        try {
          const err = await res.json();
          errMsg = err.error || errMsg;
        } catch { /* non-JSON error body */ }
        setScrapeError(errMsg);
        toast.error(errMsg);
        return;
      }
      const data = await res.json();
      setScrapedPageId(data.scraped_page_id);
      setScreenshotDesktop(data.screenshot_desktop);
      setAnalysis(data.analysis);
      const offer = (data.analysis as Analysis)?.primary_offer;
      if (offer) setTestName(offer.slice(0, 60));
      setStep('analyzed');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Network error — check your connection';
      setScrapeError(msg);
      toast.error(msg);
    } finally {
      setScraping(false);
    }
  }, [url]);

  // ─── Step 2: Generate Variants ─────────────────────────────────────

  const handleGenerate = useCallback(async (testId: string) => {
    setGenerating(true);
    setVariants([]);
    setGenProgress('Starting generation...');
    setStep('generating');

    const controller = new AbortController();
    abortRef.current = controller;

    // Track variants locally so we don't depend on React state batching
    const collectedVariants: GeneratedVariant[] = [];

    try {
      const res = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scraped_page_id: scrapedPageId,
          test_id: testId,
          num_variants: 1,
          instructions: editableInstructions.trim() || instructions.trim() || undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let errMsg = 'Generation failed';
        try {
          const err = await res.json();
          errMsg = err.error || errMsg;
        } catch { /* non-JSON body */ }
        toast.error(errMsg);
        setStep('analyzed');
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) { toast.error('No response stream'); setStep('analyzed'); return; }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === 'variant_ready') {
                collectedVariants.push({
                  index: data.index as number,
                  variant_id: data.variant_id as string,
                  label: data.label as string,
                  impact_hypothesis: data.impact_hypothesis as string,
                  changes_summary: data.changes_summary as ChangeItem[],
                  hosted_url: data.hosted_url as string,
                  status: 'ready',
                  approved: true,
                });
              }
              handleSSEEvent(eventType, data);
            } catch { /* skip malformed */ }
            eventType = '';
          }
        }
      }

      // Use locally tracked variants instead of React state
      const ready = collectedVariants.filter(v => v.status === 'ready');
      if (ready.length > 0) {
        setStep('review');
      } else {
        toast.error('All variants failed to generate. Please try again.');
        setStep('analyzed');
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        toast.error('Generation failed');
        setStep('analyzed');
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }, [scrapedPageId, instructions]);

  function handleSSEEvent(event: string, data: Record<string, unknown>) {
    switch (event) {
      case 'started':
        setGenProgress(`Generating ${data.total_variants} variants...`);
        break;
      case 'generating':
        setGenProgress('Generating all variants...');
        break;
      case 'variant_ready':
        setVariants(prev => [...prev, {
          index: data.index as number,
          variant_id: data.variant_id as string,
          label: data.label as string,
          impact_hypothesis: data.impact_hypothesis as string,
          changes_summary: data.changes_summary as ChangeItem[],
          hosted_url: data.hosted_url as string,
          status: 'ready',
          approved: true,
        }]);
        setActiveTab(data.index as number);
        setGenProgress(`Variant "${data.label}" ready!`);
        break;
      case 'variant_error':
        toast.error(`Variant "${data.label}" failed: ${data.error}`);
        setVariants(prev => [...prev, {
          index: data.index as number,
          variant_id: '',
          label: data.label as string,
          impact_hypothesis: '',
          changes_summary: [],
          hosted_url: '',
          status: 'error',
          error: data.error as string,
          approved: false,
        }]);
        break;
      case 'complete':
        setGenProgress(`Done! ${data.succeeded}/${data.total} variants generated.`);
        break;
    }
  }

  // ─── Step 3: Launch Test ───────────────────────────────────────────

  const approvedCount = variants.filter(v => v.approved && v.status === 'ready').length;

  const handleLaunch = useCallback(async () => {
    if (approvedCount < 2) {
      toast.error('Approve at least 2 variants');
      return;
    }
    setLaunching(true);
    try {
      const approved = variants.filter(v => v.approved && v.status === 'ready');
      const weight = Math.floor(100 / (approved.length + 1));
      const controlWeight = 100 - weight * approved.length;

      const res = await fetch(`/api/workspaces/${workspaceId}/tests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: testName || 'AI Generated Test',
          url_path: urlPath,
          variants: [
            {
              name: 'Control (Original)',
              redirect_url: url.trim(),
              proxy_mode: true,
              traffic_weight: controlWeight,
              is_control: true,
            },
          ],
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Failed to create test');
        return;
      }

      const test = await res.json();

      for (const variant of approved) {
        await fetch(`/api/tests/${test.id}/variants`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `AI: ${variant.label}`,
            redirect_url: variant.hosted_url,
            proxy_mode: false,
            traffic_weight: weight,
          }),
        });
      }

      toast.success('Test created successfully!');
      router.push(`/clients/${clientId}/tests/${test.id}`);
    } catch {
      toast.error('Failed to launch test');
    } finally {
      setLaunching(false);
    }
  }, [variants, approvedCount, testName, urlPath, url, workspaceId, clientId, router]);

  // ─── Preview Plan ───────────────────────────────────────────────────

  async function handlePreviewPlan() {
    setPlanLoading(true);
    try {
      const res = await fetch('/api/ai/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'variant',
          page_analysis: analysis,
          instructions: instructions.trim() || undefined,
        }),
      });
      if (!res.ok) {
        toast.error('Failed to generate plan');
        return;
      }
      const data = await res.json();
      setVariantPlan(data.plan);
      setEditableInstructions(data.plan.editable_prompt || instructions);
      setStep('plan');
    } catch {
      toast.error('Failed to generate plan');
    } finally {
      setPlanLoading(false);
    }
  }

  // ─── First test creation for generate ──────────────────────────────

  const handleStartGeneration = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/tests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: testName || 'AI Generated Test',
          url_path: urlPath,
          variants: [{
            name: 'Control (Original)',
            redirect_url: url.trim(),
            proxy_mode: true,
            traffic_weight: 100,
            is_control: true,
          }],
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Failed to create test');
        return;
      }
      const test = await res.json();
      handleGenerate(test.id);
    } catch {
      toast.error('Failed to create test');
    }
  }, [workspaceId, testName, urlPath, url, handleGenerate]);

  // ─── Toggle helpers ────────────────────────────────────────────────

  function toggleApproval(index: number) {
    setVariants(prev => prev.map(v =>
      v.index === index ? { ...v, approved: !v.approved } : v
    ));
  }

  function toggleChanges(index: number) {
    setExpandedChanges(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  // ─── Render ────────────────────────────────────────────────────────

  const activeVariant = variants[activeTab];

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Back link */}
      <button
        onClick={() => router.push(`/clients/${clientId}/pages`)}
        className="flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
      >
        <ArrowLeft size={14} /> Back to Pages
      </button>

      {/* ═══ STEP 1: URL INPUT ═══ */}
      {(step === 'input' || step === 'analyzed') && (
        <div className="card p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#3D8BDA]/20 flex items-center justify-center">
              <Sparkles size={20} className="text-[#3D8BDA]" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                AI Variant Generator
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Paste a landing page URL and we&apos;ll generate optimized variants
              </p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Landing Page URL
            </label>
            <div className="flex gap-3">
              <div className="relative flex-1">
                <Globe size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="input-base pl-10 font-mono text-sm"
                  placeholder="https://example.com/landing-page"
                  disabled={scraping}
                  onKeyDown={(e) => e.key === 'Enter' && handleAnalyze()}
                />
              </div>
              <button
                onClick={() => handleAnalyze()}
                disabled={!url.trim() || scraping}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-lg font-medium text-sm text-white bg-[#3D8BDA] hover:bg-[#3578c0] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {scraping ? (
                  <><Loader2 size={16} className="animate-spin" /> Analyzing...</>
                ) : (
                  <><Wand2 size={16} /> Analyze Page</>
                )}
              </button>
            </div>
            {scrapeError && (
              <div className="mt-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                <strong>Error:</strong> {scrapeError}
              </div>
            )}
          </div>

          {/* Optional instructions */}
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Custom Instructions <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              className="input-base w-full h-20 resize-y text-sm"
              placeholder="E.g., Redesign the hero section with a high-end look, make CTAs more action-oriented, change the color scheme to dark mode..."
              disabled={scraping}
            />
          </div>
        </div>
      )}

      {/* ═══ STEP 2: ANALYSIS RESULT ═══ */}
      {step === 'analyzed' && analysis && (
        <div className="card overflow-hidden">
          <div className="p-5 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
            <h3 className="font-semibold text-slate-900 dark:text-slate-100">Page Analysis</h3>
            <button
              onClick={() => handleAnalyze(true)}
              disabled={scraping}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 transition-colors disabled:opacity-50"
            >
              <RotateCcw size={12} /> Re-analyze
            </button>
          </div>
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Screenshot */}
              {screenshotDesktop && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-white">
                  <img
                    src={screenshotDesktop}
                    alt="Desktop screenshot"
                    className="w-full h-auto max-h-[400px] object-cover object-top"
                  />
                </div>
              )}

              {/* Analysis details */}
              <div className="space-y-3">
                {analysis.page_type && (
                  <div>
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">Type</span>
                    <p className="text-sm text-slate-800 dark:text-slate-200 mt-0.5">{String(analysis.page_type)}</p>
                  </div>
                )}
                {analysis.primary_offer && (
                  <div>
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">Primary Offer</span>
                    <p className="text-sm text-slate-800 dark:text-slate-200 mt-0.5">{String(analysis.primary_offer)}</p>
                  </div>
                )}
                {analysis.target_audience && (
                  <div>
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">Target Audience</span>
                    <p className="text-sm text-slate-800 dark:text-slate-200 mt-0.5">{String(analysis.target_audience)}</p>
                  </div>
                )}
                {analysis.cta_strategy && (
                  <div>
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">CTA Strategy</span>
                    <p className="text-sm text-slate-800 dark:text-slate-200 mt-0.5">{String(analysis.cta_strategy)}</p>
                  </div>
                )}
                {analysis.tone_of_voice && (
                  <div>
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">Tone</span>
                    <p className="text-sm text-slate-800 dark:text-slate-200 mt-0.5 capitalize">{String(analysis.tone_of_voice)}</p>
                  </div>
                )}
                {Array.isArray(analysis.color_palette) && analysis.color_palette.length > 0 && (
                  <div>
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">Colors</span>
                    <div className="flex gap-1.5 mt-1">
                      {(analysis.color_palette as string[]).map((color, i) => (
                        <div key={i} className="w-6 h-6 rounded border border-slate-300 dark:border-slate-600" style={{ backgroundColor: color }} title={color} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Test config */}
            <div className="border-t border-slate-200 dark:border-slate-700 pt-4 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Test Name</label>
                  <input
                    type="text"
                    value={testName}
                    onChange={(e) => setTestName(e.target.value)}
                    className="input-base text-sm"
                    placeholder="My A/B Test"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">URL Path</label>
                  <input
                    type="text"
                    value={urlPath}
                    onChange={(e) => setUrlPath(e.target.value)}
                    className="input-base font-mono text-sm"
                    placeholder="/"
                  />
                  {domain && (
                    <p className="text-slate-400 text-xs mt-0.5 font-mono">{domain}{urlPath}</p>
                  )}
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                onClick={handlePreviewPlan}
                disabled={planLoading}
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg font-medium text-sm text-white bg-[#3D8BDA] hover:bg-[#3578c0] disabled:opacity-50 transition-colors"
              >
                {planLoading ? (
                  <><Loader2 size={16} className="animate-spin" /> Building Plan...</>
                ) : (
                  <><Wand2 size={16} /> Preview Plan</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ STEP 2.5: PLAN ═══ */}
      {step === 'plan' && variantPlan && (
        <div className="card overflow-hidden">
          <div className="p-5 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-slate-900 dark:text-slate-100">Test Plan</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{variantPlan.summary}</p>
            </div>
            <button
              onClick={() => setStep('analyzed')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
            >
              <RotateCcw size={12} /> Back
            </button>
          </div>

          <div className="p-5 space-y-4">
            {/* Planned variants */}
            <div className="space-y-3">
              {variantPlan.variants.map((v, i) => (
                <div key={i} className="rounded-lg border border-slate-200 dark:border-slate-700 p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-[#3D8BDA] bg-[#3D8BDA]/10 rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0">{i + 1}</span>
                    <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-200">{v.title}</h4>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{v.hypothesis}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {v.changes.map((c, j) => (
                      <span key={j} className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-green-500/10 text-green-400 border border-green-500/20">
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Editable instructions */}
            <div>
              <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
                Detailed Instructions (edit to refine)
              </label>
              <textarea
                value={editableInstructions}
                onChange={(e) => setEditableInstructions(e.target.value)}
                className="input-base w-full h-32 resize-y text-sm"
                placeholder="Edit these instructions to refine what changes get made..."
              />
            </div>

            {/* Generate button */}
            <div className="flex justify-end">
              <button
                onClick={handleStartGeneration}
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg font-medium text-sm text-white bg-[#3D8BDA] hover:bg-[#3578c0] transition-colors"
              >
                <Sparkles size={16} /> Generate Variants
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ STEP 3: GENERATING ═══ */}
      {step === 'generating' && (
        <div className="card p-8">
          <div className="flex flex-col items-center justify-center space-y-4">
            <div className="relative">
              <div className="w-16 h-16 rounded-2xl bg-[#3D8BDA]/20 flex items-center justify-center">
                <Sparkles size={28} className="text-[#3D8BDA] animate-pulse" />
              </div>
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-slate-900 dark:text-slate-100">Generating Variants</p>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{genProgress}</p>
            </div>
            <div className="w-full max-w-md">
              <div className="h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden relative">
                {variants.filter(v => v.status === 'ready').length === 0 ? (
                  <div
                    className="h-full bg-[#3D8BDA] rounded-full absolute"
                    style={{
                      width: '30%',
                      animation: 'indeterminate 1.5s ease-in-out infinite',
                    }}
                  />
                ) : (
                  <div
                    className="h-full bg-[#3D8BDA] rounded-full transition-all duration-500"
                    style={{ width: '100%' }}
                  />
                )}
              </div>
              <style>{`
                @keyframes indeterminate {
                  0% { left: -30%; }
                  100% { left: 100%; }
                }
              `}</style>
              <p className="text-xs text-slate-400 text-center mt-2">
                {variants.filter(v => v.status === 'ready').length}/1 variants complete
              </p>
            </div>

            {/* Show variants as they arrive */}
            {variants.length > 0 && (
              <div className="w-full space-y-2 mt-4">
                {variants.map(v => (
                  <div
                    key={v.index}
                    className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border ${
                      v.status === 'ready'
                        ? 'border-green-500/30 bg-green-500/5'
                        : 'border-red-500/30 bg-red-500/5'
                    }`}
                  >
                    {v.status === 'ready' ? (
                      <Check size={16} className="text-green-400" />
                    ) : (
                      <X size={16} className="text-red-400" />
                    )}
                    <span className="text-sm text-slate-700 dark:text-slate-300">{v.label}</span>
                    {v.status === 'error' && (
                      <span className="text-xs text-red-400 ml-auto">{v.error}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ STEP 4: REVIEW VARIANTS ═══ */}
      {step === 'review' && variants.length > 0 && (
        <>
          {/* Variant tabs */}
          <div className="card overflow-hidden">
            <div className="border-b border-slate-200 dark:border-slate-700">
              <div className="flex">
                {variants.map((v, i) => (
                  <button
                    key={i}
                    onClick={() => { setActiveTab(i); setEditMode(false); setShowRegenInput(false); }}
                    className={`flex-1 px-4 py-3 text-sm font-medium transition-colors border-b-2 ${
                      activeTab === i
                        ? 'border-[#3D8BDA] text-[#3D8BDA]'
                        : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                    }`}
                  >
                    <div className="flex items-center justify-center gap-2">
                      {v.status === 'ready' ? (
                        v.approved ? (
                          <Check size={14} className="text-green-400" />
                        ) : (
                          <X size={14} className="text-slate-400" />
                        )
                      ) : (
                        <X size={14} className="text-red-400" />
                      )}
                      Variant {String.fromCharCode(65 + i)}
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">{v.label}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Active variant content */}
            {activeVariant && (
              <div className="p-5 space-y-4">
                {activeVariant.status === 'error' ? (
                  <div className="text-center py-8">
                    <X size={32} className="mx-auto text-red-400 mb-2" />
                    <p className="text-red-400 font-medium">Generation Failed</p>
                    <p className="text-sm text-slate-500 mt-1">{activeVariant.error}</p>
                  </div>
                ) : (
                  <>
                    {/* Strategy & hypothesis + action buttons */}
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="font-semibold text-slate-900 dark:text-slate-100">
                          {activeVariant.label}
                        </h3>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                          {activeVariant.impact_hypothesis}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          onClick={() => toggleApproval(activeTab)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                            activeVariant.approved
                              ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                              : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 border border-slate-300 dark:border-slate-600'
                          }`}
                        >
                          <Check size={12} /> {activeVariant.approved ? 'Approved' : 'Approve'}
                        </button>
                        <button
                          onClick={() => toggleApproval(activeTab)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                            !activeVariant.approved
                              ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                              : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 border border-slate-300 dark:border-slate-600'
                          }`}
                        >
                          <X size={12} /> Reject
                        </button>
                      </div>
                    </div>

                    {/* Toolbar row: preview mode, edit toggle, actions */}
                    <div className="flex items-center justify-between gap-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg px-4 py-2 border border-slate-200 dark:border-slate-700">
                      {/* Preview mode toggle */}
                      <div className="flex items-center gap-1 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-0.5">
                        <button
                          onClick={() => setPreviewMode('desktop')}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                            previewMode === 'desktop'
                              ? 'bg-[#3D8BDA] text-white'
                              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                          }`}
                        >
                          <Monitor size={13} /> Desktop
                        </button>
                        <button
                          onClick={() => setPreviewMode('mobile')}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                            previewMode === 'mobile'
                              ? 'bg-[#3D8BDA] text-white'
                              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                          }`}
                        >
                          <Smartphone size={13} /> Mobile
                        </button>
                      </div>

                      {/* Action buttons */}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setEditMode(!editMode)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                            editMode
                              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                              : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
                          }`}
                        >
                          <Type size={12} /> {editMode ? 'Editing' : 'Edit Text'}
                        </button>
                        {editMode && (
                          <Button
                            variant="primary"
                            size="sm"
                            loading={saving}
                            onClick={handleSave}
                            className="!bg-[#3D8BDA] hover:!bg-[#3578c0]"
                          >
                            <Save size={12} /> Save
                          </Button>
                        )}
                        <button
                          onClick={() => setShowRegenInput(!showRegenInput)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
                        >
                          <RotateCcw size={12} /> Regenerate
                        </button>
                        <button
                          onClick={handleExport}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
                        >
                          <Download size={12} /> Export
                        </button>
                      </div>
                    </div>

                    {/* Regenerate instructions input */}
                    {showRegenInput && (
                      <div className="flex gap-3 items-end bg-slate-50 dark:bg-slate-800/50 rounded-lg p-4 border border-slate-200 dark:border-slate-700">
                        <div className="flex-1">
                          <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                            Regeneration instructions (optional)
                          </label>
                          <textarea
                            value={regenInstructions}
                            onChange={(e) => setRegenInstructions(e.target.value)}
                            className="input-base w-full h-16 resize-y text-sm"
                            placeholder="E.g., Make the headline more urgent, change CTA color to red..."
                          />
                        </div>
                        <Button
                          variant="primary"
                          size="sm"
                          loading={regenerating}
                          onClick={handleRegenerate}
                          className="!bg-[#3D8BDA] hover:!bg-[#3578c0] flex-shrink-0"
                        >
                          <RotateCcw size={12} /> Regenerate
                        </Button>
                      </div>
                    )}

                    {/* Preview iframe */}
                    <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-white flex justify-center">
                      <div className={previewMode === 'mobile' ? 'w-[390px]' : 'w-full'}>
                        <div className="bg-slate-100 dark:bg-slate-800 px-4 py-2 flex items-center gap-2 border-b border-slate-200 dark:border-slate-700">
                          <div className="flex gap-1.5">
                            <div className="w-2.5 h-2.5 rounded-full bg-red-400/50" />
                            <div className="w-2.5 h-2.5 rounded-full bg-yellow-400/50" />
                            <div className="w-2.5 h-2.5 rounded-full bg-green-400/50" />
                          </div>
                          <span className="text-xs text-slate-400 font-mono truncate flex-1 text-center">
                            {activeVariant.hosted_url}
                          </span>
                          {editMode && (
                            <span className="text-[10px] font-medium text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded">
                              EDIT MODE
                            </span>
                          )}
                        </div>
                        <iframe
                          ref={iframeRef}
                          src={activeVariant.hosted_url}
                          className="w-full h-[600px] border-0"
                          title={`Preview: ${activeVariant.label}`}
                          sandbox="allow-scripts allow-same-origin"
                        />
                      </div>
                    </div>

                    {/* Floating toolbar for text editing */}
                    {editMode && toolbarPos && (
                      <div
                        ref={toolbarRef}
                        className="fixed z-50 flex items-center gap-1 bg-slate-900 rounded-lg shadow-xl px-2 py-1.5 border border-slate-700"
                        style={{
                          left: `${toolbarPos.x}px`,
                          top: `${toolbarPos.y}px`,
                          transform: 'translateX(-50%)',
                        }}
                      >
                        <button
                          onClick={() => execCommand('bold')}
                          className="p-1.5 rounded hover:bg-slate-700 text-white transition-colors"
                          title="Bold"
                        >
                          <Bold size={14} />
                        </button>
                        <button
                          onClick={() => execCommand('italic')}
                          className="p-1.5 rounded hover:bg-slate-700 text-white transition-colors"
                          title="Italic"
                        >
                          <Italic size={14} />
                        </button>
                        <div className="w-px h-5 bg-slate-600 mx-1" />
                        <button
                          onClick={() => execCommand('fontSize', '5')}
                          className="p-1.5 rounded hover:bg-slate-700 text-white transition-colors text-xs font-bold"
                          title="Increase size"
                        >
                          A+
                        </button>
                        <button
                          onClick={() => execCommand('fontSize', '2')}
                          className="p-1.5 rounded hover:bg-slate-700 text-white transition-colors text-xs"
                          title="Decrease size"
                        >
                          A-
                        </button>
                      </div>
                    )}

                    {/* Changes summary */}
                    <div>
                      <button
                        onClick={() => toggleChanges(activeTab)}
                        className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 transition-colors"
                      >
                        {expandedChanges.has(activeTab) ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        Changes Summary ({activeVariant.changes_summary.length} changes)
                      </button>
                      {expandedChanges.has(activeTab) && (
                        <div className="mt-3 space-y-2">
                          {activeVariant.changes_summary.map((item, i) => (
                            <div
                              key={i}
                              className="flex gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700"
                            >
                              <div className="w-1 rounded-full bg-[#3D8BDA] flex-shrink-0" />
                              <div>
                                <p className="text-sm text-slate-800 dark:text-slate-200">{item.change}</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{item.reason}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Bottom bar: Launch test */}
          <div className="card p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-700 dark:text-slate-300">
                  <span className="font-semibold">{approvedCount}</span> variant{approvedCount !== 1 ? 's' : ''} approved
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {approvedCount < 2
                    ? 'Approve at least 2 variants to launch a test'
                    : `Original page + ${approvedCount} AI variants will be split-tested`}
                </p>
              </div>
              <button
                onClick={handleLaunch}
                disabled={approvedCount < 2 || launching}
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg font-medium text-sm text-white bg-[#3D8BDA] hover:bg-[#3578c0] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {launching ? (
                  <><Loader2 size={16} className="animate-spin" /> Creating...</>
                ) : (
                  <><Rocket size={16} /> Launch Test with {approvedCount} Variants</>
                )}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
