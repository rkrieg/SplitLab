'use client';

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  Sparkles, Globe, Loader2, Check, X, RotateCcw,
  ChevronDown, ChevronUp, Rocket, ArrowLeft, Wand2,
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

type Step = 'input' | 'analyzed' | 'generating' | 'review';

export default function AIGenerateClient({ workspaceId, clientId, domain }: Props) {
  const router = useRouter();

  // Step state
  const [step, setStep] = useState<Step>('input');

  // Input step
  const [url, setUrl] = useState('');
  const [instructions, setInstructions] = useState('');
  const [scraping, setScraping] = useState(false);

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

  // Test creation
  const [testName, setTestName] = useState('');
  const [urlPath, setUrlPath] = useState('/');
  const [launching, setLaunching] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // ─── Step 1: Analyze Page ──────────────────────────────────────────────

  const handleAnalyze = useCallback(async () => {
    if (!url.trim()) return;
    setScraping(true);
    try {
      const res = await fetch('/api/ai/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Failed to analyze page');
        return;
      }
      const data = await res.json();
      setScrapedPageId(data.scraped_page_id);
      setScreenshotDesktop(data.screenshot_desktop);
      setAnalysis(data.analysis);
      // Pre-fill test name from analysis
      const offer = (data.analysis as Analysis)?.primary_offer;
      if (offer) setTestName(offer.slice(0, 60));
      setStep('analyzed');
    } catch {
      toast.error('Network error');
    } finally {
      setScraping(false);
    }
  }, [url]);

  // ─── Step 2: Generate Variants ─────────────────────────────────────────

  const handleGenerate = useCallback(async (testId: string) => {
    setGenerating(true);
    setVariants([]);
    setGenProgress('Starting generation...');
    setStep('generating');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scraped_page_id: scrapedPageId,
          test_id: testId,
          num_variants: 3,
          instructions: instructions.trim() || undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Generation failed');
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
              handleSSEEvent(eventType, data);
            } catch { /* skip malformed */ }
            eventType = '';
          }
        }
      }

      setStep('review');
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
        setGenProgress(`Generating "${data.label}"...`);
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
          approved: true, // default approved
        }]);
        setActiveTab(data.index as number);
        setGenProgress(`Variant "${data.label}" ready!`);
        break;
      case 'variant_error':
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

  // ─── Step 3: Launch Test ───────────────────────────────────────────────

  const approvedCount = variants.filter(v => v.approved && v.status === 'ready').length;

  const handleLaunch = useCallback(async () => {
    if (approvedCount < 2) {
      toast.error('Approve at least 2 variants');
      return;
    }
    setLaunching(true);
    try {
      // Create the test
      const approved = variants.filter(v => v.approved && v.status === 'ready');
      const weight = Math.floor(100 / (approved.length + 1)); // +1 for control
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

      // Add each approved AI variant
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

  // ─── First test creation for generate ──────────────────────────────────

  const handleStartGeneration = useCallback(async () => {
    // Create a draft test first to get a test_id for the generate endpoint
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

  // ─── Toggle helpers ────────────────────────────────────────────────────

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

  // ─── Render ────────────────────────────────────────────────────────────

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
                onClick={handleAnalyze}
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
              placeholder="E.g., Focus on the pricing section, use green CTA buttons, keep the hero image..."
              disabled={scraping}
            />
          </div>
        </div>
      )}

      {/* ═══ STEP 2: ANALYSIS RESULT ═══ */}
      {step === 'analyzed' && analysis && (
        <div className="card overflow-hidden">
          <div className="p-5 border-b border-slate-200 dark:border-slate-700">
            <h3 className="font-semibold text-slate-900 dark:text-slate-100">Page Analysis</h3>
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

            {/* Test config before generating */}
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
              <div className="h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#3D8BDA] rounded-full transition-all duration-500"
                  style={{ width: `${Math.max(10, (variants.length / 3) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-slate-400 text-center mt-2">
                {variants.length}/3 variants complete
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
                    onClick={() => setActiveTab(i)}
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
            {variants[activeTab] && (
              <div className="p-5 space-y-4">
                {variants[activeTab].status === 'error' ? (
                  <div className="text-center py-8">
                    <X size={32} className="mx-auto text-red-400 mb-2" />
                    <p className="text-red-400 font-medium">Generation Failed</p>
                    <p className="text-sm text-slate-500 mt-1">{variants[activeTab].error}</p>
                  </div>
                ) : (
                  <>
                    {/* Strategy & hypothesis */}
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="font-semibold text-slate-900 dark:text-slate-100">
                          {variants[activeTab].label}
                        </h3>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                          {variants[activeTab].impact_hypothesis}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          onClick={() => toggleApproval(activeTab)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                            variants[activeTab].approved
                              ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                              : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 border border-slate-300 dark:border-slate-600'
                          }`}
                        >
                          <Check size={12} /> {variants[activeTab].approved ? 'Approved' : 'Approve'}
                        </button>
                        <button
                          onClick={() => toggleApproval(activeTab)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                            !variants[activeTab].approved
                              ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                              : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 border border-slate-300 dark:border-slate-600'
                          }`}
                        >
                          <X size={12} /> Reject
                        </button>
                      </div>
                    </div>

                    {/* Preview iframe */}
                    <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-white">
                      <div className="bg-slate-100 dark:bg-slate-800 px-4 py-2 flex items-center gap-2 border-b border-slate-200 dark:border-slate-700">
                        <div className="flex gap-1.5">
                          <div className="w-2.5 h-2.5 rounded-full bg-red-400/50" />
                          <div className="w-2.5 h-2.5 rounded-full bg-yellow-400/50" />
                          <div className="w-2.5 h-2.5 rounded-full bg-green-400/50" />
                        </div>
                        <span className="text-xs text-slate-400 font-mono truncate flex-1 text-center">
                          {variants[activeTab].hosted_url}
                        </span>
                      </div>
                      <iframe
                        src={variants[activeTab].hosted_url}
                        className="w-full h-[500px] border-0"
                        title={`Preview: ${variants[activeTab].label}`}
                        sandbox="allow-scripts allow-same-origin"
                      />
                    </div>

                    {/* Changes summary */}
                    <div>
                      <button
                        onClick={() => toggleChanges(activeTab)}
                        className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 transition-colors"
                      >
                        {expandedChanges.has(activeTab) ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        Changes Summary ({variants[activeTab].changes_summary.length} changes)
                      </button>
                      {expandedChanges.has(activeTab) && (
                        <div className="mt-3 space-y-2">
                          {variants[activeTab].changes_summary.map((item, i) => (
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
