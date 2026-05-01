'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  Sparkles, Globe, Loader2, Check, X, RotateCcw, RefreshCw,
  ChevronDown, ChevronUp, Rocket, ArrowLeft, Wand2,
  Monitor, Smartphone, Save, Download, Bold, Italic, Type,
  Underline, Strikethrough, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Eraser, Palette, Highlighter, Link,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import HtmlPreview, { type HtmlPreviewHandle } from '@/components/HtmlPreview';
import { usePlanLimit, isPlanLimitError } from '@/hooks/usePlanLimit';
import UpgradeModal from '@/components/upgrade/UpgradeModal';

function fixUrl(url: string): string {
  if (typeof window === 'undefined' || !url) return url;
  if (url.startsWith('/')) return window.location.origin + url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === '0.0.0.0' || parsed.port === '5000') {
      return window.location.origin + parsed.pathname + parsed.search + parsed.hash;
    }
  } catch { /* not a valid URL */ }
  return url;
}

interface ChangeItem {
  change: string;
  reason: string;
}

interface GeneratedVariant {
  index: number;
  variant_id: string;
  page_id: string;
  label: string;
  impact_hypothesis: string;
  changes_summary: ChangeItem[];
  serve_url: string;
  html: string;
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

type Step = 'input' | 'analyzed' | 'plan' | 'generating' | 'review' | 'cloning' | 'cloned';
type PreviewMode = 'desktop' | 'mobile';

export default function AIGenerateClient({ workspaceId, clientId, domain }: Props) {
  const router = useRouter();
  const { isOpen: limitModalOpen, modalProps: limitModalProps, closeModal: closeLimitModal, handleLimitError } = usePlanLimit();

  // Step state
  const [step, setStep] = useState<Step>('input');

  // Input step
  const [url, setUrl] = useState('');
  const [instructions, setInstructions] = useState('');
  const [scraping, setScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState('');

  // Plan step
  const [variantPlan, setVariantPlan] = useState<{ summary: string; variants: Array<{ title: string; hypothesis: string; changes: string[] }>; editable_prompt: string } | null>(null);
  const [editableInstructions, setEditableInstructions] = useState('');
  const [planLoading, setPlanLoading] = useState(false);
  const [planFeedback, setPlanFeedback] = useState('');

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
  const previewRef = useRef<HtmlPreviewHandle>(null);

  // Rich editor toolbar state
  const [textColor, setTextColor] = useState('#000000');
  const [highlightColor, setHighlightColor] = useState('#ffff00');
  const [fontFamily, setFontFamily] = useState('');
  const [fontSize, setFontSize] = useState('16');

  // Clone flow state
  const [clonedPageId, setClonedPageId] = useState('');
  const [clonedPageHtml, setClonedPageHtml] = useState('');
  const [clonedServeUrl, setClonedServeUrl] = useState('');
  const [clonedPageName, setClonedPageName] = useState('');
  const [cloneProgress, setCloneProgress] = useState('');
  const [cloneError, setCloneError] = useState('');
  const [cloneSaving, setCloneSaving] = useState(false);

  // Floating toolbar (kept for selection awareness only)
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  // Test creation
  const [testName, setTestName] = useState('');
  const [urlPath, setUrlPath] = useState('/');
  const [launching, setLaunching] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // ─── Toolbar commands ───────────────────────────────────────────────

  function execCommand(command: string, value?: string) {
    previewRef.current?.execFormat(command, value);
  }

  function applyFontSize(px: string) {
    if (!px || isNaN(Number(px))) return;
    previewRef.current?.applyFontSize(px);
  }

  function insertLink() {
    const sel = window.getSelection();
    const selectedText = sel && !sel.isCollapsed ? sel.toString() : '';
    const url = window.prompt('Enter URL:', 'https://');
    if (url) {
      if (selectedText) {
        execCommand('createLink', url);
      } else {
        const text = window.prompt('Link text:', url) || url;
        document.execCommand('insertHTML', false, `<a href="${url}" target="_blank">${text}</a>`);
      }
    }
  }

  // ─── Selection change handler passed to HtmlPreview ─────────────────

  const handleSelectionChange = useCallback(
    (active: boolean, pos?: { x: number; y: number }) => {
      setToolbarPos(active && pos ? pos : null);
    },
    []
  );

  // ─── Save edited HTML ───────────────────────────────────────────────

  async function handleSave() {
    const variant = variants[activeTab];
    if (!variant || variant.status !== 'ready') return;
    if (!previewRef.current) return;

    setSaving(true);
    try {
      const html = previewRef.current.getHtml();
      const res = await fetch(`/api/pages/${variant.page_id}`, {
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
      setVariants(prev => prev.map(v =>
        v.variant_id === variant.variant_id ? { ...v, html } : v
      ));
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
      const combinedInstructions = [
        variant.label ? `CRO STRATEGY: ${variant.label}\nHYPOTHESIS: ${variant.impact_hypothesis}` : '',
        regenInstructions.trim(),
      ].filter(Boolean).join('\n\n');

      const res = await fetch('/api/ai/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scraped_page_id: scrapedPageId,
          instructions: combinedInstructions || undefined,
          workspace_id: workspaceId,
          client_id: clientId,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Regeneration failed');
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) { toast.error('No response stream'); return; }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.trim()) continue;
          let eventType = '';
          let dataStr = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataStr = line.slice(6);
          }
          if (!dataStr) continue;
          try {
            const data = JSON.parse(dataStr);
            if (eventType === 'complete') {
              setVariants(prev => prev.map(v =>
                v.variant_id === variant.variant_id
                  ? {
                      ...v,
                      page_id: data.page_id as string,
                      serve_url: fixUrl(data.serve_url as string),
                      html: data.html as string,
                    }
                  : v
              ));
              toast.success('Variant regenerated!');
              setShowRegenInput(false);
              setRegenInstructions('');
            } else if (eventType === 'error') {
              toast.error((data.error as string) || 'Regeneration failed');
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch {
      toast.error('Regeneration failed');
    } finally {
      setRegenerating(false);
    }
  }

  // ─── Export HTML ────────────────────────────────────────────────────

  function handleExport() {
    const variant = variants[activeTab];
    if (!variant) return;

    const html = previewRef.current?.getHtml() || variant.html;
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
          num_variants: 3,
          instructions: editableInstructions.trim() || instructions.trim() || undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        try {
          const err = await res.json();
          if (isPlanLimitError(err)) {
            handleLimitError(err);
          } else {
            toast.error(err.error || 'Generation failed');
          }
        } catch { toast.error('Generation failed'); }
        setStep('analyzed');
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) { toast.error('No response stream'); setStep('analyzed'); return; }

      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

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
                  page_id: (data.page_id as string) || '',
                  label: data.label as string,
                  impact_hypothesis: data.impact_hypothesis as string,
                  changes_summary: data.changes_summary as ChangeItem[],
                  serve_url: fixUrl((data.serve_url as string) || (data.hosted_url as string)),
                  html: (data.html as string) || '',
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
          page_id: (data.page_id as string) || '',
          label: data.label as string,
          impact_hypothesis: data.impact_hypothesis as string,
          changes_summary: data.changes_summary as ChangeItem[],
          serve_url: fixUrl((data.serve_url as string) || (data.hosted_url as string)),
          html: (data.html as string) || '',
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
          page_id: '',
          label: data.label as string,
          impact_hypothesis: '',
          changes_summary: [],
          serve_url: '',
          html: '',
          status: 'error' as const,
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
    if (approvedCount < 1) {
      toast.error('Approve at least 1 variant');
      return;
    }
    setLaunching(true);
    try {
      const approved = variants.filter(v => v.approved && v.status === 'ready');
      const total = approved.length + 1; // +1 for control
      const weight = Math.floor(100 / total);
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
            ...approved.map(v => ({
              name: `AI: ${v.label}`,
              redirect_url: v.serve_url,
              proxy_mode: false,
              traffic_weight: weight,
              is_control: false,
            })),
          ],
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        if (isPlanLimitError(err)) {
          handleLimitError(err);
        } else {
          toast.error(err.error || 'Failed to create test');
        }
        return;
      }

      const test = await res.json();
      toast.success('Test created successfully!');
      router.push(`/clients/${clientId}/tests/${test.id}`);
    } catch {
      toast.error('Failed to launch test');
    } finally {
      setLaunching(false);
    }
  }, [variants, approvedCount, testName, urlPath, url, workspaceId, clientId, router]);

  // ─── Clone & Rebuild Page ───────────────────────────────────────────

  const handleClone = useCallback(async () => {
    setStep('cloning');
    setCloneProgress('Starting...');
    setCloneError('');

    try {
      const res = await fetch('/api/ai/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scraped_page_id: scrapedPageId,
          instructions: instructions.trim() || undefined,
          workspace_id: workspaceId,
          client_id: clientId,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Clone failed');
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
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.trim()) continue;
          let eventType = '';
          let dataStr = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataStr = line.slice(6);
          }
          if (!dataStr) continue;
          try {
            const data = JSON.parse(dataStr);
            if (eventType === 'started') setCloneProgress('Fetching images...');
            else if (eventType === 'images_fetched') setCloneProgress(`Found ${data.count as number} images. Building prompt...`);
            else if (eventType === 'generating') {
              const msgs: Record<string, string> = {
                building_prompt: 'Analyzing design and building prompt...',
                calling_claude: 'Generating full page with Claude AI...',
              };
              setCloneProgress(msgs[data.status as string] || 'Generating...');
            } else if (eventType === 'quality_scored') {
              setCloneProgress('Page generated! Saving...');
            } else if (eventType === 'complete') {
              setClonedPageId(data.page_id as string);
              setClonedPageHtml(data.html as string);
              setClonedServeUrl(fixUrl(data.serve_url as string));
              setClonedPageName(data.page_name as string);
              setStep('cloned');
              toast.success('Page rebuilt successfully!');
            } else if (eventType === 'error') {
              const errMsg = data.error as string;
              setCloneError(errMsg);
              toast.error(errMsg);
              setStep('analyzed');
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch {
      toast.error('Clone failed — please try again');
      setStep('analyzed');
    }
  }, [scrapedPageId, instructions, workspaceId, clientId]);

  async function handleCloneSave() {
    if (!clonedPageId || !previewRef.current) return;
    setCloneSaving(true);
    try {
      const html = previewRef.current.getHtml();
      const res = await fetch(`/api/pages/${clonedPageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html }),
      });
      if (!res.ok) {
        toast.error('Failed to save');
        return;
      }
      toast.success('Page saved!');
    } catch {
      toast.error('Failed to save');
    } finally {
      setCloneSaving(false);
    }
  }

  // ─── Preview Plan ───────────────────────────────────────────────────

  async function handlePreviewPlan(feedback?: string) {
    setPlanLoading(true);
    try {
      const res = await fetch('/api/ai/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'variant',
          page_analysis: analysis,
          scraped_page_id: scrapedPageId,
          instructions: instructions.trim() || undefined,
          previous_plan: feedback ? variantPlan : undefined,
          feedback: feedback || undefined,
        }),
      });
      if (!res.ok) {
        toast.error('Failed to generate plan');
        return;
      }
      const data = await res.json();
      setVariantPlan(data.plan);
      setEditableInstructions(data.plan.editable_prompt || instructions);
      setPlanFeedback('');
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
    <>
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

            {/* Two action paths */}
            <div className="border-t border-slate-200 dark:border-slate-700 pt-4">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">Choose how to proceed</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* Path 1: Clone & Rebuild */}
                <div className="rounded-xl border-2 border-[#3D8BDA]/40 bg-[#3D8BDA]/5 p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-[#3D8BDA]/20 flex items-center justify-center flex-shrink-0">
                      <Wand2 size={16} className="text-[#3D8BDA]" />
                    </div>
                    <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Rebuild & Customize Page</h4>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Recreate this page from scratch as a fully styled, editable website. Apply your custom instructions. Saves with a permanent URL.
                  </p>
                  <button
                    onClick={handleClone}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm text-white bg-[#3D8BDA] hover:bg-[#3578c0] transition-colors"
                  >
                    <Wand2 size={15} /> Rebuild Page with AI
                  </button>
                </div>

                {/* Path 2: A/B Variants */}
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-slate-200 dark:bg-slate-700 flex items-center justify-center flex-shrink-0">
                      <Sparkles size={16} className="text-slate-500 dark:text-slate-400" />
                    </div>
                    <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Generate A/B Test Variants</h4>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Keep the original design and generate optimized text variants for A/B testing (headline, CTA, copy).
                  </p>
                  <button
                    onClick={() => handlePreviewPlan()}
                    disabled={planLoading}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-500 disabled:opacity-50 transition-colors"
                  >
                    {planLoading ? (
                      <><Loader2 size={14} className="animate-spin" /> Building Plan...</>
                    ) : (
                      <><Sparkles size={14} /> Generate Variants</>
                    )}
                  </button>
                </div>
              </div>
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
                  <ul className="space-y-1 ml-8">
                    {v.changes.map((c, j) => (
                      <li key={j} className="text-sm text-slate-300 list-disc">
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            {/* Feedback input to refine the plan */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-4 space-y-2">
              <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                Request Changes to Plan
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={planFeedback}
                  onChange={(e) => setPlanFeedback(e.target.value)}
                  className="input-base text-sm flex-1"
                  placeholder="e.g., Also change the hero image/video, add a dark background, make CTAs red..."
                  onKeyDown={(e) => e.key === 'Enter' && planFeedback.trim() && handlePreviewPlan(planFeedback.trim())}
                  disabled={planLoading}
                />
                <button
                  onClick={() => handlePreviewPlan(planFeedback.trim())}
                  disabled={!planFeedback.trim() || planLoading}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white bg-slate-600 hover:bg-slate-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {planLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  Refine
                </button>
              </div>
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
                disabled={planLoading}
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg font-medium text-sm text-white bg-[#3D8BDA] hover:bg-[#3578c0] disabled:opacity-50 transition-colors"
              >
                <Sparkles size={16} /> Generate Variants
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ STEP: CLONING ═══ */}
      {step === 'cloning' && (
        <div className="card p-8">
          <div className="flex flex-col items-center justify-center space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-[#3D8BDA]/20 flex items-center justify-center">
              <Wand2 size={28} className="text-[#3D8BDA] animate-pulse" />
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-slate-900 dark:text-slate-100">Rebuilding Page</p>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{cloneProgress}</p>
            </div>
            <div className="w-full max-w-md">
              <div className="h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden relative">
                <div
                  className="h-full bg-[#3D8BDA] rounded-full absolute"
                  style={{ width: '40%', animation: 'indeterminate 1.5s ease-in-out infinite' }}
                />
              </div>
              <style>{`@keyframes indeterminate { 0% { left: -40%; } 100% { left: 110%; } }`}</style>
              <p className="text-xs text-slate-400 text-center mt-2">This usually takes 30–60 seconds</p>
            </div>
            {cloneError && (
              <div className="w-full max-w-md p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm text-center">
                {cloneError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ STEP: CLONED — Full page preview + editing ═══ */}
      {step === 'cloned' && clonedPageHtml && (
        <>
          <div className="card overflow-hidden">
            {/* Header */}
            <div className="p-5 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-slate-900 dark:text-slate-100">{clonedPageName || 'Rebuilt Page'}</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Fully styled, editable page — rebuilt from {url}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setStep('analyzed')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-slate-300 transition-colors"
                >
                  <RotateCcw size={12} /> Rebuild Again
                </button>
                <a
                  href={clonedServeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-emerald-500 hover:bg-emerald-600 transition-colors"
                >
                  <Rocket size={12} /> Open Live Page
                </a>
              </div>
            </div>

            <div className="p-5 space-y-4">
              {/* Toolbar row */}
              <div className="flex items-center justify-between gap-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg px-4 py-2 border border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-1 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-0.5">
                  <button
                    onClick={() => setPreviewMode('desktop')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${previewMode === 'desktop' ? 'bg-[#3D8BDA] text-white' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700'}`}
                  >
                    <Monitor size={13} /> Desktop
                  </button>
                  <button
                    onClick={() => setPreviewMode('mobile')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${previewMode === 'mobile' ? 'bg-[#3D8BDA] text-white' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700'}`}
                  >
                    <Smartphone size={13} /> Mobile
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setEditMode(!editMode)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${editMode ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-slate-300 transition-colors'}`}
                  >
                    <Type size={12} /> {editMode ? 'Editing' : 'Edit Text'}
                  </button>
                  {editMode && (
                    <Button
                      variant="primary"
                      size="sm"
                      loading={cloneSaving}
                      onClick={handleCloneSave}
                      className="!bg-[#3D8BDA] hover:!bg-[#3578c0]"
                    >
                      <Save size={12} /> Save
                    </Button>
                  )}
                  <button
                    onClick={() => {
                      const html = previewRef.current?.getHtml() || clonedPageHtml;
                      const blob = new Blob([html], { type: 'text/html' });
                      const a = document.createElement('a');
                      a.href = URL.createObjectURL(blob);
                      a.download = 'rebuilt-page.html';
                      a.click();
                      URL.revokeObjectURL(a.href);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-slate-300 transition-colors"
                  >
                    <Download size={12} /> Export
                  </button>
                </div>
              </div>

              {/* Rich editing toolbar */}
              {editMode && (
                <div className="flex items-center flex-wrap gap-1 bg-white dark:bg-slate-800 rounded-lg border border-indigo-300 dark:border-indigo-700 px-3 py-2 shadow-sm">
                  <select
                    value={fontFamily}
                    onChange={e => { setFontFamily(e.target.value); execCommand('fontName', e.target.value); }}
                    className="h-7 rounded border border-slate-200 dark:border-slate-700 bg-transparent text-xs text-slate-700 dark:text-slate-300 px-1 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer min-w-[110px]"
                  >
                    <option value="">Default Font</option>
                    <option value="Arial, sans-serif">Arial</option>
                    <option value="'Helvetica Neue', Helvetica, sans-serif">Helvetica Neue</option>
                    <option value="Georgia, serif">Georgia</option>
                    <option value="'Times New Roman', serif">Times New Roman</option>
                    <option value="Verdana, sans-serif">Verdana</option>
                  </select>
                  <div className="flex items-center gap-0.5 border border-slate-200 dark:border-slate-700 rounded h-7 overflow-hidden">
                    <input
                      type="number" min="8" max="200" value={fontSize}
                      onChange={e => setFontSize(e.target.value)}
                      onBlur={e => applyFontSize(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') applyFontSize(fontSize); }}
                      className="w-11 h-full bg-transparent text-xs text-slate-700 dark:text-slate-300 px-1.5 focus:outline-none"
                    />
                    <span className="text-[10px] text-slate-400 pr-1.5">px</span>
                  </div>
                  <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5" />
                  {[
                    { cmd: 'bold', icon: <Bold size={13} />, title: 'Bold' },
                    { cmd: 'italic', icon: <Italic size={13} />, title: 'Italic' },
                    { cmd: 'underline', icon: <Underline size={13} />, title: 'Underline' },
                  ].map(({ cmd, icon, title }) => (
                    <button key={cmd} onMouseDown={e => { e.preventDefault(); execCommand(cmd); }}
                      className="flex items-center justify-center w-7 h-7 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors" title={title}>
                      {icon}
                    </button>
                  ))}
                  <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5" />
                  {[
                    { cmd: 'justifyLeft', icon: <AlignLeft size={13} /> },
                    { cmd: 'justifyCenter', icon: <AlignCenter size={13} /> },
                    { cmd: 'justifyRight', icon: <AlignRight size={13} /> },
                  ].map(({ cmd, icon }) => (
                    <button key={cmd} onMouseDown={e => { e.preventDefault(); execCommand(cmd); }}
                      className="flex items-center justify-center w-7 h-7 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors">
                      {icon}
                    </button>
                  ))}
                  <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5" />
                  <label className="relative flex items-center justify-center w-7 h-7 rounded hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer" title="Text Color">
                    <Palette size={13} className="text-slate-600 dark:text-slate-300 pointer-events-none" />
                    <div className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-4 h-1 rounded-sm pointer-events-none" style={{ backgroundColor: textColor }} />
                    <input type="color" value={textColor} onChange={e => setTextColor(e.target.value)} onInput={e => execCommand('foreColor', (e.target as HTMLInputElement).value)} className="absolute inset-0 opacity-0 w-full h-full cursor-pointer" />
                  </label>
                  <div className="ml-auto text-[10px] text-indigo-400 font-medium flex items-center gap-1">
                    <Type size={10} /> Click any text to edit
                  </div>
                </div>
              )}

              {/* Page preview */}
              <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-white flex justify-center">
                <div className={previewMode === 'mobile' ? 'w-[390px]' : 'w-full'}>
                  <div className="bg-slate-100 dark:bg-slate-800 px-4 py-2 flex items-center gap-2 border-b border-slate-200 dark:border-slate-700">
                    <div className="flex gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-red-400/50" />
                      <div className="w-2.5 h-2.5 rounded-full bg-yellow-400/50" />
                      <div className="w-2.5 h-2.5 rounded-full bg-green-400/50" />
                    </div>
                    <span className="text-xs text-slate-400 font-mono truncate flex-1 text-center">{clonedServeUrl}</span>
                    {editMode && <span className="text-[10px] font-medium text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded">EDIT MODE</span>}
                  </div>
                  <HtmlPreview
                    ref={previewRef}
                    html={clonedPageHtml}
                    editMode={editMode}
                    className="w-full h-[700px]"
                    onSelectionChange={handleSelectionChange}
                  />
                </div>
              </div>

              {/* Page URL */}
              <div className="rounded-lg border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50 dark:bg-emerald-900/20 p-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider mb-0.5">Live Page URL</p>
                  <p className="text-sm font-mono text-emerald-800 dark:text-emerald-300 break-all">{clonedServeUrl}</p>
                  <p className="text-xs text-emerald-600 dark:text-emerald-500 mt-1">This URL is permanent and stays accessible</p>
                </div>
                <div className="flex flex-col gap-2 flex-shrink-0">
                  <a
                    href={clonedServeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white bg-emerald-500 hover:bg-emerald-600 transition-colors"
                  >
                    <Rocket size={14} /> Open Page
                  </a>
                  <button
                    onClick={handleCloneSave}
                    disabled={cloneSaving}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-slate-300 transition-colors disabled:opacity-50"
                  >
                    {cloneSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                    Save Edits
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
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

                    {/* ── Rich Editing Toolbar ── */}
                    {editMode && (
                      <div className="flex items-center flex-wrap gap-1 bg-white dark:bg-slate-800 rounded-lg border border-indigo-300 dark:border-indigo-700 px-3 py-2 shadow-sm">

                        {/* Font family */}
                        <select
                          value={fontFamily}
                          onChange={e => { setFontFamily(e.target.value); execCommand('fontName', e.target.value); }}
                          className="h-7 rounded border border-slate-200 dark:border-slate-700 bg-transparent text-xs text-slate-700 dark:text-slate-300 px-1 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer min-w-[110px]"
                          title="Font Family"
                        >
                          <option value="">Default Font</option>
                          <option value="Arial, sans-serif">Arial</option>
                          <option value="'Helvetica Neue', Helvetica, sans-serif">Helvetica Neue</option>
                          <option value="Georgia, serif">Georgia</option>
                          <option value="'Times New Roman', serif">Times New Roman</option>
                          <option value="'Courier New', monospace">Courier New</option>
                          <option value="Verdana, sans-serif">Verdana</option>
                          <option value="Trebuchet MS, sans-serif">Trebuchet MS</option>
                          <option value="Impact, fantasy">Impact</option>
                        </select>

                        {/* Font size */}
                        <div className="flex items-center gap-0.5 border border-slate-200 dark:border-slate-700 rounded h-7 overflow-hidden">
                          <input
                            type="number"
                            min="8"
                            max="200"
                            value={fontSize}
                            onChange={e => setFontSize(e.target.value)}
                            onBlur={e => applyFontSize(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') { applyFontSize(fontSize); (e.target as HTMLInputElement).blur(); } }}
                            className="w-11 h-full bg-transparent text-xs text-slate-700 dark:text-slate-300 px-1.5 focus:outline-none"
                            title="Font size (px)"
                          />
                          <span className="text-[10px] text-slate-400 pr-1.5 select-none">px</span>
                        </div>

                        <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5" />

                        {/* Style buttons */}
                        {[
                          { cmd: 'bold', icon: <Bold size={13} />, title: 'Bold (Ctrl+B)' },
                          { cmd: 'italic', icon: <Italic size={13} />, title: 'Italic (Ctrl+I)' },
                          { cmd: 'underline', icon: <Underline size={13} />, title: 'Underline (Ctrl+U)' },
                          { cmd: 'strikeThrough', icon: <Strikethrough size={13} />, title: 'Strikethrough' },
                        ].map(({ cmd, icon, title }) => (
                          <button
                            key={cmd}
                            onMouseDown={e => { e.preventDefault(); execCommand(cmd); }}
                            className="flex items-center justify-center w-7 h-7 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors"
                            title={title}
                          >
                            {icon}
                          </button>
                        ))}

                        <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5" />

                        {/* Alignment */}
                        {[
                          { cmd: 'justifyLeft', icon: <AlignLeft size={13} />, title: 'Align Left' },
                          { cmd: 'justifyCenter', icon: <AlignCenter size={13} />, title: 'Align Center' },
                          { cmd: 'justifyRight', icon: <AlignRight size={13} />, title: 'Align Right' },
                          { cmd: 'justifyFull', icon: <AlignJustify size={13} />, title: 'Justify' },
                        ].map(({ cmd, icon, title }) => (
                          <button
                            key={cmd}
                            onMouseDown={e => { e.preventDefault(); execCommand(cmd); }}
                            className="flex items-center justify-center w-7 h-7 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors"
                            title={title}
                          >
                            {icon}
                          </button>
                        ))}

                        <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5" />

                        {/* Text color */}
                        <label className="relative flex items-center justify-center w-7 h-7 rounded hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer transition-colors" title="Text Color">
                          <Palette size={13} className="text-slate-600 dark:text-slate-300 pointer-events-none" />
                          <div className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-4 h-1 rounded-sm pointer-events-none" style={{ backgroundColor: textColor }} />
                          <input
                            type="color"
                            value={textColor}
                            onChange={e => setTextColor(e.target.value)}
                            onInput={e => execCommand('foreColor', (e.target as HTMLInputElement).value)}
                            className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                          />
                        </label>

                        {/* Highlight / background color */}
                        <label className="relative flex items-center justify-center w-7 h-7 rounded hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer transition-colors" title="Highlight Color">
                          <Highlighter size={13} className="text-slate-600 dark:text-slate-300 pointer-events-none" />
                          <div className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-4 h-1 rounded-sm pointer-events-none" style={{ backgroundColor: highlightColor }} />
                          <input
                            type="color"
                            value={highlightColor}
                            onChange={e => setHighlightColor(e.target.value)}
                            onInput={e => execCommand('hiliteColor', (e.target as HTMLInputElement).value)}
                            className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                          />
                        </label>

                        <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5" />

                        {/* Insert link */}
                        <button
                          onMouseDown={e => { e.preventDefault(); insertLink(); }}
                          className="flex items-center justify-center w-7 h-7 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors"
                          title="Insert Link"
                        >
                          <Link size={13} />
                        </button>

                        {/* Clear formatting */}
                        <button
                          onMouseDown={e => { e.preventDefault(); execCommand('removeFormat'); }}
                          className="flex items-center justify-center w-7 h-7 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors"
                          title="Clear Formatting"
                        >
                          <Eraser size={13} />
                        </button>

                        <div className="ml-auto text-[10px] text-indigo-400 dark:text-indigo-500 font-medium flex items-center gap-1">
                          <Type size={10} /> Click any text on the page to edit
                        </div>
                      </div>
                    )}

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

                    {/* Inline HTML Preview (no iframe) */}
                    <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-white flex justify-center">
                      <div className={previewMode === 'mobile' ? 'w-[390px]' : 'w-full'}>
                        <div className="bg-slate-100 dark:bg-slate-800 px-4 py-2 flex items-center gap-2 border-b border-slate-200 dark:border-slate-700">
                          <div className="flex gap-1.5">
                            <div className="w-2.5 h-2.5 rounded-full bg-red-400/50" />
                            <div className="w-2.5 h-2.5 rounded-full bg-yellow-400/50" />
                            <div className="w-2.5 h-2.5 rounded-full bg-green-400/50" />
                          </div>
                          <span className="text-xs text-slate-400 font-mono truncate flex-1 text-center">
                            {activeVariant.serve_url || `${activeVariant.label} — AI Generated Variant`}
                          </span>
                          {editMode && (
                            <span className="text-[10px] font-medium text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded">
                              EDIT MODE
                            </span>
                          )}
                          {activeVariant.serve_url && (
                            <a
                              href={activeVariant.serve_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors"
                              title="Open live page in new tab"
                            >
                              <Rocket size={10} /> Open
                            </a>
                          )}
                        </div>
                        {activeVariant.html ? (
                          <HtmlPreview
                            ref={previewRef}
                            html={activeVariant.html}
                            editMode={editMode}
                            className="w-full h-[600px]"
                            onSelectionChange={handleSelectionChange}
                          />
                        ) : (
                          <div className="w-full h-[600px] flex items-center justify-center text-slate-400">
                            <Loader2 size={24} className="animate-spin" />
                          </div>
                        )}
                      </div>
                    </div>


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
    {limitModalOpen && limitModalProps && (
      <UpgradeModal
        isOpen={limitModalOpen}
        onClose={closeLimitModal}
        {...limitModalProps}
      />
    )}
    </>
  );
}
