'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  Wand2, Sparkles, Loader2, Check, Monitor, Smartphone, Tablet,
  Copy, ExternalLink, RotateCcw, Save, Bold, Italic, Type,
  ChevronDown, ChevronUp, RefreshCw, Pencil, FlaskConical,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import type { BuilderStep, Vertical, BrandSettings, QualityCheck } from '@/types/page-builder';

interface Props {
  workspaceId: string;
  clientId: string;
}

const VERTICALS: { value: Vertical; label: string; description: string; icon: string }[] = [
  { value: 'legal', label: 'Legal', description: 'Law firms, attorneys, legal services', icon: '⚖️' },
  { value: 'real_estate_financial', label: 'Real Estate / Financial', description: 'Agents, mortgage, financial planning', icon: '🏠' },
  { value: 'saas', label: 'SaaS', description: 'Software products, tech platforms', icon: '💻' },
  { value: 'local_services', label: 'Local Services', description: 'Plumbing, HVAC, cleaning, contractors', icon: '🔧' },
  { value: 'healthcare', label: 'Healthcare', description: 'Doctors, clinics, medical practices', icon: '🏥' },
  { value: 'ecommerce', label: 'E-Commerce', description: 'Online stores, retail brands, DTC', icon: '🛒' },
  { value: 'education', label: 'Education', description: 'Courses, training, schools, coaching', icon: '🎓' },
  { value: 'automotive', label: 'Automotive', description: 'Dealerships, car services, detailing', icon: '🚗' },
  { value: 'hospitality', label: 'Hospitality', description: 'Restaurants, hotels, travel, events', icon: '🍽️' },
  { value: 'fitness', label: 'Fitness / Wellness', description: 'Gyms, studios, personal trainers', icon: '💪' },
  { value: 'insurance', label: 'Insurance', description: 'Insurance agencies, brokerages', icon: '🛡️' },
  { value: 'nonprofit', label: 'Nonprofit', description: 'Charities, foundations, causes', icon: '❤️' },
  { value: 'agency', label: 'Agency', description: 'Marketing, creative, digital agencies', icon: '📈' },
  { value: 'construction', label: 'Construction', description: 'Contractors, remodeling, builders', icon: '🏗️' },
  { value: 'other', label: 'Other', description: 'Any other industry or business type', icon: '🏢' },
];

const TONES = ['professional', 'friendly', 'urgent', 'luxury', 'casual'] as const;

type PreviewDevice = 'desktop' | 'tablet' | 'mobile';

export default function PageBuilderClient({ workspaceId, clientId }: Props) {
  const router = useRouter();

  // Step state
  const [step, setStep] = useState<BuilderStep>('prompt');

  // Prompt step
  const [prompt, setPrompt] = useState('');
  const [vertical, setVertical] = useState<Vertical | null>(null);
  const [customVertical, setCustomVertical] = useState('');
  const [showBrand, setShowBrand] = useState(false);
  const [brandSettings, setBrandSettings] = useState<BrandSettings>({});

  // Generating step
  const [genStatus, setGenStatus] = useState('');
  const [imageCount, setImageCount] = useState(0);

  // Preview step
  const [pageId, setPageId] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [qualityScore, setQualityScore] = useState(0);
  const [qualityDetails, setQualityDetails] = useState<QualityCheck[]>([]);
  const [pageName, setPageName] = useState('');
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>('desktop');
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const [changeRequest, setChangeRequest] = useState('');
  const [showChangeBar, setShowChangeBar] = useState(false);
  const [changePlan, setChangePlan] = useState<{ summary: string; changes: string[]; warnings: string[] } | null>(null);
  const [planLoading, setPlanLoading] = useState(false);

  // Section regeneration
  const [hoveredSection, setHoveredSection] = useState<string | null>(null);
  const [regenSection, setRegenSection] = useState<string | null>(null);
  const [sectionInstructions, setSectionInstructions] = useState('');
  const [regeningSec, setRegeningSec] = useState(false);

  // Plan step
  const [planData, setPlanData] = useState<{ summary: string; sections: Array<{ title: string; description: string }>; design_notes: string; editable_prompt: string } | null>(null);
  const [editablePrompt, setEditablePrompt] = useState('');
  const [planLoading2, setPlanLoading2] = useState(false);
  const [planFeedback, setPlanFeedback] = useState('');

  // Published step
  const [publishedUrl, setPublishedUrl] = useState('');
  const [publishing, setPublishing] = useState(false);

  // Floating toolbar
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const completedRef = useRef(false);

  // ─── Preview Plan ─────────────────────────────────────────────────

  const handlePreviewPlan = useCallback(async (feedback?: string) => {
    if (!prompt.trim() || !vertical) return;
    setPlanLoading2(true);
    try {
      const res = await fetch('/api/ai/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'page',
          prompt: prompt.trim(),
          vertical,
          custom_vertical: vertical === 'other' && customVertical.trim() ? customVertical.trim() : undefined,
          brand_settings: Object.keys(brandSettings).length > 0 ? brandSettings : undefined,
          previous_plan: feedback ? planData : undefined,
          feedback: feedback || undefined,
        }),
      });
      if (!res.ok) {
        toast.error('Failed to generate plan');
        return;
      }
      const data = await res.json();
      setPlanData(data.plan);
      setEditablePrompt(data.plan.editable_prompt || prompt);
      setPlanFeedback('');
      setStep('plan');
    } catch {
      toast.error('Failed to generate plan');
    } finally {
      setPlanLoading2(false);
    }
  }, [prompt, vertical, customVertical, brandSettings, planData]);

  // ─── Generate Page ──────────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    if (!vertical) return;
    const finalPrompt = editablePrompt.trim() || prompt.trim();
    if (!finalPrompt) return;

    setStep('generating');
    setGenStatus('Starting...');
    completedRef.current = false;
    abortRef.current = new AbortController();

    try {
      const res = await fetch('/api/pages/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId,
          client_id: clientId,
          prompt: finalPrompt,
          vertical,
          custom_vertical: vertical === 'other' && customVertical.trim() ? customVertical.trim() : undefined,
          brand_settings: Object.keys(brandSettings).length > 0 ? brandSettings : undefined,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        let errMsg = 'Generation failed';
        try {
          const err = await res.json();
          errMsg = err.error || errMsg;
        } catch {
          errMsg = `Server error (${res.status})`;
        }
        console.error('[PageBuilder] API error:', res.status, errMsg);
        toast.error(errMsg);
        setStep('plan');
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        // Parse SSE event/data pairs correctly
        let i = 0;
        while (i < lines.length) {
          const line = lines[i];
          if (line.startsWith('event: ')) {
            const eventType = line.slice(7);
            if (i + 1 < lines.length && lines[i + 1].startsWith('data: ')) {
              try {
                const data = JSON.parse(lines[i + 1].slice(6));
                handleSSEEvent(eventType, data);
              } catch (e) {
                console.error('[PageBuilder] SSE parse error:', e, lines[i + 1]);
              }
              i += 2;
              continue;
            }
          }
          i++;
        }
      }

      // Stream ended — if we never got a 'complete' event, handleSSEEvent
      // would not have called setStep('preview'), so the component stays
      // on 'generating'. We can't read the React state here (stale closure),
      // so we use a ref to track whether complete was received.
      if (!completedRef.current) {
        console.error('[PageBuilder] Stream ended without complete event');
        toast.error('Generation ended unexpectedly. Check server logs.');
        setStep('prompt');
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : 'Generation failed';
      console.error('[PageBuilder] Error:', err);
      toast.error(msg);
      setStep('prompt');
    }
  }, [editablePrompt, prompt, vertical, brandSettings, workspaceId, clientId]);

  function handleSSEEvent(event: string, data: Record<string, unknown>) {
    switch (event) {
      case 'started':
        setGenStatus('Fetching images...');
        break;
      case 'images_fetched':
        setImageCount(data.count as number);
        setGenStatus(`Found ${data.count} images. Building prompt...`);
        break;
      case 'generating': {
        const statusMessages: Record<string, string> = {
          building_prompt: 'Building prompt...',
          calling_claude: 'Generating page with Claude Opus...',
          designing_with_stitch: 'Designing page with Google Stitch AI...',
          design_complete: 'Design ready! Optimizing for production...',
          refining_with_claude: 'Refining design with Claude...',
          stitch_fallback: 'Stitch unavailable, generating with Claude...',
        };
        setGenStatus(statusMessages[data.status as string] || 'Generating...');
        break;
      }
      case 'quality_scored':
        setQualityScore(data.score as number);
        setQualityDetails(data.details as QualityCheck[]);
        setGenStatus('Page generated! Saving...');
        break;
      case 'complete':
        completedRef.current = true;
        setPageId(data.page_id as string);
        setPreviewUrl(data.preview_url as string);
        setQualityScore(data.quality_score as number);
        setQualityDetails(data.quality_details as QualityCheck[]);
        setPageName(`AI Page - ${vertical}`);
        setStep('preview');
        toast.success('Page generated!');
        break;
      case 'error':
        console.error('[PageBuilder] Server error event:', data.error);
        toast.error(String(data.error));
        setStep('prompt');
        break;
    }
  }

  // ─── Inline Editor ──────────────────────────────────────────────────

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

      iframeDoc.querySelectorAll('[data-sl-editable]').forEach((el) => {
        (el as HTMLElement).contentEditable = 'true';
        (el as HTMLElement).style.outline = 'none';
        (el as HTMLElement).style.cursor = 'text';
      });

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
    handleIframeLoad();
    return () => iframe.removeEventListener('load', handleIframeLoad);
  }, [editMode]);

  // ─── Section hover detection ────────────────────────────────────────

  useEffect(() => {
    if (editMode || step !== 'preview') return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    function setupHover() {
      const iframeDoc = iframe!.contentDocument;
      if (!iframeDoc) return;

      const sections = iframeDoc.querySelectorAll('[data-sl-section]');
      sections.forEach((section) => {
        const el = section as HTMLElement;
        el.addEventListener('mouseenter', () => {
          setHoveredSection(el.getAttribute('data-sl-section'));
        });
        el.addEventListener('mouseleave', () => {
          setHoveredSection(null);
        });
      });
    }

    iframe.addEventListener('load', setupHover);
    setupHover();
    return () => iframe.removeEventListener('load', setupHover);
  }, [step, editMode]);

  function execCommand(command: string, value?: string) {
    const iframeDoc = iframeRef.current?.contentDocument;
    if (!iframeDoc) return;
    iframeDoc.execCommand(command, false, value);
  }

  // ─── Save edited HTML ──────────────────────────────────────────────

  async function handleSaveEdit() {
    const iframe = iframeRef.current;
    if (!iframe?.contentDocument) return;

    setSaving(true);
    try {
      const html = '<!DOCTYPE html>' + iframe.contentDocument.documentElement.outerHTML;
      const res = await fetch(`/api/pages/${pageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, name: pageName }),
      });
      if (!res.ok) {
        toast.error('Failed to save');
        return;
      }
      toast.success('Changes saved');
      setEditMode(false);
    } catch {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  }

  // ─── Plan changes before applying ─────────────────────────────────

  async function handlePlanChanges() {
    if (!changeRequest.trim()) return;
    setPlanLoading(true);
    setChangePlan(null);
    try {
      const res = await fetch(`/api/pages/${pageId}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions: changeRequest.trim(), plan_only: true }),
      });
      if (!res.ok) {
        toast.error('Failed to generate plan');
        return;
      }
      const data = await res.json();
      setChangePlan(data.plan);
    } catch {
      toast.error('Failed to generate plan');
    } finally {
      setPlanLoading(false);
    }
  }

  // ─── Regenerate full page ──────────────────────────────────────────

  async function handleRegenerate(instructions?: string) {
    setRegenerating(true);
    try {
      const res = await fetch(`/api/pages/${pageId}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions: instructions || undefined }),
      });
      if (!res.ok) {
        toast.error('Regeneration failed');
        return;
      }
      const data = await res.json();
      if (iframeRef.current) {
        iframeRef.current.src = previewUrl + '?v=' + data.version;
      }
      toast.success(instructions ? 'Changes applied!' : 'Page regenerated!');
      setChangeRequest('');
      setShowChangeBar(false);
      setChangePlan(null);
    } catch {
      toast.error('Regeneration failed');
    } finally {
      setRegenerating(false);
    }
  }

  // ─── Regenerate section ────────────────────────────────────────────

  async function handleRegenSection() {
    if (!regenSection || !sectionInstructions.trim()) return;
    setRegeningSec(true);
    try {
      const res = await fetch(`/api/pages/${pageId}/regenerate-section`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          section_id: regenSection,
          instructions: sectionInstructions.trim(),
        }),
      });
      if (!res.ok) {
        toast.error('Section regeneration failed');
        return;
      }
      const data = await res.json();
      if (iframeRef.current) {
        iframeRef.current.src = previewUrl + '?v=' + data.version;
      }
      toast.success(`Section "${regenSection}" regenerated`);
      setRegenSection(null);
      setSectionInstructions('');
    } catch {
      toast.error('Section regeneration failed');
    } finally {
      setRegeningSec(false);
    }
  }

  // ─── Publish ──────────────────────────────────────────────────────

  async function handlePublish() {
    setPublishing(true);
    try {
      const res = await fetch(`/api/pages/${pageId}/publish`, { method: 'POST' });
      if (!res.ok) {
        toast.error('Publishing failed');
        return;
      }
      const data = await res.json();
      setPublishedUrl(data.published_url);
      setStep('published');
      toast.success('Page published!');
    } catch {
      toast.error('Publishing failed');
    } finally {
      setPublishing(false);
    }
  }

  // ─── Create A/B Test ──────────────────────────────────────────────

  async function handleCreateTest() {
    try {
      const res = await fetch(`/api/pages/${pageId}/create-test`, { method: 'POST' });
      if (!res.ok) {
        toast.error('Failed to create test');
        return;
      }
      const data = await res.json();
      router.push(`/clients/${clientId}/tests/${data.test_id}`);
    } catch {
      toast.error('Failed to create test');
    }
  }

  // ─── Render: Prompt Step ──────────────────────────────────────────

  if (step === 'prompt') {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Vertical selector */}
        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">
            Choose a vertical
          </label>
          <div className="flex flex-wrap gap-2">
            {VERTICALS.map((v) => (
              <button
                key={v.value}
                onClick={() => setVertical(v.value)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm transition-all ${
                  vertical === v.value
                    ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400 font-medium'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600'
                }`}
                title={v.description}
              >
                <span>{v.icon}</span>
                {v.label}
              </button>
            ))}
          </div>
          {vertical === 'other' && (
            <div className="mt-3">
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                Describe your industry / business type
              </label>
              <input
                type="text"
                value={customVertical}
                onChange={(e) => setCustomVertical(e.target.value)}
                className="input-base text-sm w-full"
                placeholder="e.g., Pet grooming salon, Music production studio, Solar panel installation..."
              />
            </div>
          )}
        </div>

        {/* Prompt textarea */}
        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
            Describe your landing page
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="input-base w-full h-32 resize-y"
            placeholder="e.g., A landing page for a personal injury law firm in Miami. They specialize in car accidents and slip-and-fall cases. Target audience: accident victims looking for legal representation. Include a free consultation form and highlight their $50M+ in recovered settlements."
          />
        </div>

        {/* Brand settings (collapsible) */}
        <div className="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
          <button
            onClick={() => setShowBrand(!showBrand)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
          >
            <span>Brand Settings (optional)</span>
            {showBrand ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {showBrand && (
            <div className="px-4 pb-4 space-y-3 border-t border-slate-200 dark:border-slate-700 pt-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Company Name</label>
                  <input
                    type="text"
                    value={brandSettings.company_name || ''}
                    onChange={(e) => setBrandSettings({ ...brandSettings, company_name: e.target.value })}
                    className="input-base text-sm"
                    placeholder="Acme Law"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Phone</label>
                  <input
                    type="text"
                    value={brandSettings.phone || ''}
                    onChange={(e) => setBrandSettings({ ...brandSettings, phone: e.target.value })}
                    className="input-base text-sm"
                    placeholder="(555) 123-4567"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Primary Color</label>
                  <div className="flex gap-2">
                    <input
                      type="color"
                      value={brandSettings.primary_color || '#3D8BDA'}
                      onChange={(e) => setBrandSettings({ ...brandSettings, primary_color: e.target.value })}
                      className="w-10 h-9 rounded cursor-pointer border border-slate-200 dark:border-slate-700"
                    />
                    <input
                      type="text"
                      value={brandSettings.primary_color || ''}
                      onChange={(e) => setBrandSettings({ ...brandSettings, primary_color: e.target.value })}
                      className="input-base text-sm flex-1"
                      placeholder="#3D8BDA"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Secondary Color</label>
                  <div className="flex gap-2">
                    <input
                      type="color"
                      value={brandSettings.secondary_color || '#1e293b'}
                      onChange={(e) => setBrandSettings({ ...brandSettings, secondary_color: e.target.value })}
                      className="w-10 h-9 rounded cursor-pointer border border-slate-200 dark:border-slate-700"
                    />
                    <input
                      type="text"
                      value={brandSettings.secondary_color || ''}
                      onChange={(e) => setBrandSettings({ ...brandSettings, secondary_color: e.target.value })}
                      className="input-base text-sm flex-1"
                      placeholder="#1e293b"
                    />
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Logo URL</label>
                <input
                  type="url"
                  value={brandSettings.logo_url || ''}
                  onChange={(e) => setBrandSettings({ ...brandSettings, logo_url: e.target.value })}
                  className="input-base text-sm"
                  placeholder="https://example.com/logo.png"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Tone</label>
                <select
                  value={brandSettings.tone || ''}
                  onChange={(e) => setBrandSettings({ ...brandSettings, tone: e.target.value as BrandSettings['tone'] })}
                  className="input-base text-sm"
                >
                  <option value="">Select tone...</option>
                  {TONES.map((t) => (
                    <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Preview Plan button */}
        <div className="flex justify-end">
          <Button
            onClick={() => handlePreviewPlan()}
            disabled={!prompt.trim() || !vertical || planLoading2}
            className="px-6"
          >
            {planLoading2 ? (
              <><Loader2 size={16} className="animate-spin" /> Building Plan...</>
            ) : (
              <><Wand2 size={16} /> Preview Plan</>
            )}
          </Button>
        </div>
      </div>
    );
  }

  // ─── Render: Plan Step ──────────────────────────────────────────────

  if (step === 'plan' && planData) {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="card overflow-hidden">
          <div className="p-5 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-slate-900 dark:text-slate-100">Build Plan</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{planData.summary}</p>
            </div>
            <button
              onClick={() => setStep('prompt')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
            >
              <RotateCcw size={12} /> Back
            </button>
          </div>

          <div className="p-5 space-y-4">
            {/* Planned sections */}
            <div>
              <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Planned Sections</h4>
              <div className="space-y-2">
                {planData.sections.map((section, i) => (
                  <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
                    <span className="text-xs font-bold text-[#3D8BDA] bg-[#3D8BDA]/10 rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
                    <div>
                      <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{section.title}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{section.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Design notes */}
            {planData.design_notes && (
              <div>
                <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Design Direction</h4>
                <p className="text-sm text-slate-600 dark:text-slate-300">{planData.design_notes}</p>
              </div>
            )}

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
                  placeholder="e.g., Add a video hero, use a dark luxury theme, include client logos section..."
                  onKeyDown={(e) => e.key === 'Enter' && planFeedback.trim() && handlePreviewPlan(planFeedback.trim())}
                  disabled={planLoading2}
                />
                <button
                  onClick={() => handlePreviewPlan(planFeedback.trim())}
                  disabled={!planFeedback.trim() || planLoading2}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white bg-slate-600 hover:bg-slate-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {planLoading2 ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  Refine
                </button>
              </div>
            </div>

            {/* Editable prompt */}
            <div>
              <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
                Detailed Brief (edit to refine)
              </label>
              <textarea
                value={editablePrompt}
                onChange={(e) => setEditablePrompt(e.target.value)}
                className="input-base w-full h-40 resize-y text-sm"
                placeholder="Edit this brief to refine what gets built..."
              />
            </div>

            {/* Generate button */}
            <div className="flex justify-end">
              <Button onClick={handleGenerate} disabled={planLoading2} className="px-6">
                <Sparkles size={16} /> Generate Page
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Render: Generating Step ──────────────────────────────────────

  if (step === 'generating') {
    return (
      <div className="max-w-lg mx-auto text-center py-20">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-indigo-500/10 mb-6">
          <Sparkles size={28} className="text-indigo-400 animate-pulse" />
        </div>
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
          Building your landing page
        </h2>
        <p className="text-slate-500 dark:text-slate-400 mb-6">{genStatus}</p>

        {/* Progress bar */}
        <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2 overflow-hidden">
          <div
            className="h-full bg-indigo-500 rounded-full transition-all duration-1000"
            style={{
              width: step === 'generating' ? '70%' : '100%',
              animation: 'indeterminate 2s ease-in-out infinite',
            }}
          />
        </div>
        <style>{`
          @keyframes indeterminate {
            0% { margin-left: -30%; width: 30%; }
            50% { margin-left: 20%; width: 50%; }
            100% { margin-left: 100%; width: 30%; }
          }
        `}</style>

        {imageCount > 0 && (
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-4">
            Using {imageCount} images from Unsplash
          </p>
        )}
      </div>
    );
  }

  // ─── Render: Preview Step ─────────────────────────────────────────

  if (step === 'preview') {
    const deviceWidths: Record<PreviewDevice, string> = {
      desktop: '100%',
      tablet: '768px',
      mobile: '390px',
    };

    return (
      <div className="space-y-4">
        {/* Top bar */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            {/* Page name input */}
            <input
              type="text"
              value={pageName}
              onChange={(e) => setPageName(e.target.value)}
              className="input-base text-sm w-64"
              placeholder="Page name"
            />

            {/* Quality badge */}
            <button
              onClick={() => setShowQuality(!showQuality)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${
                qualityScore >= 80
                  ? 'bg-green-500/10 text-green-400'
                  : qualityScore >= 50
                  ? 'bg-amber-500/10 text-amber-400'
                  : 'bg-red-500/10 text-red-400'
              }`}
            >
              Quality: {qualityScore}/100
              {showQuality ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          </div>

          <div className="flex items-center gap-2">
            {/* Device toggle */}
            <div className="flex border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
              {([
                { value: 'desktop' as PreviewDevice, icon: Monitor, label: 'Desktop' },
                { value: 'tablet' as PreviewDevice, icon: Tablet, label: 'Tablet' },
                { value: 'mobile' as PreviewDevice, icon: Smartphone, label: 'Mobile' },
              ]).map(({ value, icon: Icon, label }) => (
                <button
                  key={value}
                  onClick={() => setPreviewDevice(value)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
                    previewDevice === value
                      ? 'bg-indigo-500/20 text-indigo-400'
                      : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700/50'
                  }`}
                  title={label}
                >
                  <Icon size={14} />
                </button>
              ))}
            </div>

            {/* Action buttons */}
            {editMode ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => setEditMode(false)}>Cancel</Button>
                <Button size="sm" onClick={handleSaveEdit} loading={saving}>
                  <Save size={14} /> Done
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" size="sm" onClick={() => setEditMode(true)}>
                  <Pencil size={14} /> Edit
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setShowChangeBar(!showChangeBar)}>
                  <Wand2 size={14} /> Request Changes
                </Button>
                <Button variant="secondary" size="sm" onClick={() => handleRegenerate()} loading={regenerating}>
                  <RotateCcw size={14} /> Regenerate
                </Button>
                <Button size="sm" onClick={handlePublish} loading={publishing}>
                  <ExternalLink size={14} /> Publish
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Quality details dropdown */}
        {showQuality && (
          <div className="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {qualityDetails.map((check) => (
                <div key={check.name} className="flex items-center gap-2 text-xs">
                  {check.passed ? (
                    <Check size={12} className="text-green-400 flex-shrink-0" />
                  ) : (
                    <span className="w-3 h-3 rounded-full bg-red-400/20 border border-red-400/50 flex-shrink-0" />
                  )}
                  <span className="text-slate-600 dark:text-slate-400">{check.name}</span>
                  <span className="text-slate-400 dark:text-slate-500 ml-auto">+{check.score}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Change request bar */}
        {showChangeBar && (
          <div className="bg-gradient-to-r from-purple-500/5 to-indigo-500/5 border border-indigo-500/20 rounded-xl p-4 space-y-3">
            <label className="block text-xs font-medium text-indigo-400 mb-2">
              Describe what you want changed
            </label>
            <div className="flex gap-3">
              <textarea
                value={changeRequest}
                onChange={(e) => { setChangeRequest(e.target.value); setChangePlan(null); }}
                className="input-base text-sm flex-1 h-20 resize-none"
                placeholder="e.g., Make the hero section darker with a gradient background. Add more testimonials. Make the CTA buttons larger and red. Remove the FAQ section."
                autoFocus
              />
              <div className="flex flex-col gap-2 justify-end">
                {!changePlan ? (
                  <Button
                    size="sm"
                    onClick={handlePlanChanges}
                    loading={planLoading}
                    disabled={!changeRequest.trim()}
                  >
                    <Wand2 size={14} /> Preview Changes
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => handleRegenerate(changeRequest)}
                    loading={regenerating}
                  >
                    <Check size={14} /> Apply Changes
                  </Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => { setShowChangeBar(false); setChangeRequest(''); setChangePlan(null); }}>
                  Cancel
                </Button>
              </div>
            </div>

            {/* Change plan confirmation */}
            {changePlan && (
              <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-4 space-y-3">
                <div>
                  <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wide mb-1">What I&apos;ll do</h4>
                  <p className="text-sm text-slate-400">{changePlan.summary}</p>
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-green-400 uppercase tracking-wide mb-1">Changes</h4>
                  <ul className="space-y-1">
                    {changePlan.changes.map((change, i) => (
                      <li key={i} className="text-sm text-slate-400 flex items-start gap-2">
                        <span className="text-green-400 mt-0.5 flex-shrink-0">+</span>
                        {change}
                      </li>
                    ))}
                  </ul>
                </div>
                {changePlan.warnings.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold text-amber-400 uppercase tracking-wide mb-1">Won&apos;t change</h4>
                    <ul className="space-y-1">
                      {changePlan.warnings.map((warning, i) => (
                        <li key={i} className="text-sm text-slate-500 flex items-start gap-2">
                          <span className="text-amber-400 mt-0.5 flex-shrink-0">—</span>
                          {warning}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Section regen modal */}
        {regenSection && (
          <div className="bg-indigo-500/5 border border-indigo-500/20 rounded-xl p-4 flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-indigo-400 mb-1">
                Regenerate "{regenSection}" section
              </label>
              <textarea
                value={sectionInstructions}
                onChange={(e) => setSectionInstructions(e.target.value)}
                className="input-base text-sm w-full h-20 resize-none"
                placeholder="Describe what you want changed in this section..."
                autoFocus
              />
            </div>
            <div className="flex gap-2 pb-0.5">
              <Button variant="secondary" size="sm" onClick={() => { setRegenSection(null); setSectionInstructions(''); }}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleRegenSection} loading={regeningSec} disabled={!sectionInstructions.trim()}>
                <RefreshCw size={14} /> Regenerate
              </Button>
            </div>
          </div>
        )}

        {/* Hovered section indicator */}
        {hoveredSection && !editMode && !regenSection && (
          <div className="flex items-center justify-between bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-2">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Section: <span className="font-medium text-slate-700 dark:text-slate-300">{hoveredSection}</span>
            </span>
            <button
              onClick={() => setRegenSection(hoveredSection)}
              className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
            >
              <RefreshCw size={12} /> Regenerate section
            </button>
          </div>
        )}

        {/* Preview iframe */}
        <div className="flex justify-center">
          <div
            className="bg-white rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden transition-all duration-300"
            style={{ width: deviceWidths[previewDevice], maxWidth: '100%' }}
          >
            <iframe
              ref={iframeRef}
              src={previewUrl}
              className="w-full border-0"
              style={{ height: '80vh' }}
              title="Page Preview"
            />
          </div>
        </div>

        {/* Floating toolbar */}
        {editMode && toolbarPos && (
          <div
            className="fixed z-50 bg-slate-900 rounded-lg shadow-xl border border-slate-700 px-2 py-1.5 flex items-center gap-1"
            style={{
              left: `${toolbarPos.x}px`,
              top: `${toolbarPos.y}px`,
              transform: 'translateX(-50%)',
            }}
          >
            <button onClick={() => execCommand('bold')} className="p-1.5 hover:bg-slate-700 rounded" title="Bold">
              <Bold size={14} className="text-slate-300" />
            </button>
            <button onClick={() => execCommand('italic')} className="p-1.5 hover:bg-slate-700 rounded" title="Italic">
              <Italic size={14} className="text-slate-300" />
            </button>
            <button onClick={() => execCommand('removeFormat')} className="p-1.5 hover:bg-slate-700 rounded" title="Clear formatting">
              <Type size={14} className="text-slate-300" />
            </button>
          </div>
        )}
      </div>
    );
  }

  // ─── Render: Published Step ───────────────────────────────────────

  if (step === 'published') {
    return (
      <div className="max-w-lg mx-auto text-center py-16">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-500/10 mb-6">
          <Check size={28} className="text-green-400" />
        </div>
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
          Page Published!
        </h2>
        <p className="text-slate-500 dark:text-slate-400 mb-6">
          Your landing page is now live and ready to receive traffic.
        </p>

        {/* Published URL */}
        <div className="flex items-center gap-2 bg-slate-100 dark:bg-slate-800 rounded-xl p-4 mb-6">
          <code className="flex-1 text-sm text-indigo-400 font-mono truncate text-left">
            {publishedUrl}
          </code>
          <button
            onClick={() => { navigator.clipboard.writeText(publishedUrl); toast.success('URL copied!'); }}
            className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
          >
            <Copy size={16} className="text-slate-400" />
          </button>
          <a
            href={publishedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
          >
            <ExternalLink size={16} className="text-slate-400" />
          </a>
        </div>

        <div className="flex justify-center gap-3">
          <Button variant="secondary" onClick={() => setStep('preview')}>
            Back to Preview
          </Button>
          <Button onClick={handleCreateTest}>
            <FlaskConical size={16} /> Create A/B Test
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
