'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Sparkles, Send, Globe, Copy, Check, ChevronLeft, Loader2,
  Wand2, Layout, Palette, RefreshCw, Monitor, Smartphone,
  ExternalLink, RotateCcw, Plus, Download, Lock, ArrowRight,
  Sliders, Trash2, AlertTriangle, MoreHorizontal, MousePointer2, ChevronDown,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { cn } from '@/lib/utils';
import { VERTICAL_LABELS } from '@/lib/ai-page-verticals';
import { SAMPLE_PROMPTS } from '@/lib/ai-page-sample-prompts';
import { readSSEStream, type SSEEvent } from '@/lib/use-sse-stream';
import { LiveProgressPanel } from '@/components/ai/LiveProgressPanel';

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase =
  | 'prompt'
  | 'questions'
  | 'generating'
  | 'building'
  | 'editing'
  | 'publishing';

type ViewMode = 'desktop' | 'mobile';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  image_urls?: string[];
  isQuestions?: boolean;
  questions?: string[];
  elapsedMs?: number;
}

interface InitialPage {
  id: string;
  name: string;
  vertical: string;
  schema_json: unknown;
  conversation_json: { role: string; content: string; image_urls?: string[] }[] | null;
  html_url: string | null;
  slug: string | null;
  is_published: boolean;
  published_url: string | null;
  // Only meaningful for test-variant pages — edits accumulate here and never
  // touch the live columns above until the user replaces or forks (see
  // "Edit with AI" revision, 2026-07-27).
  draft_html_content?: string | null;
  draft_schema_json?: unknown;
}

interface Props {
  workspaceId: string;
  clientId: string;
  clientName: string;
  // Name of the specific test variant this page belongs to, when reached via
  // a test's "Edit using AI" button — shown alongside clientName (which is
  // set to the test's name in that case) so the breadcrumb reads as
  // "test / variant" instead of just "test".
  variantName?: string;
  initialPage?: InitialPage | null;
  backPath?: string;
  canUseAI?: boolean;
  // True when this page is the html source for a test_variants row.
  isTestVariantPage?: boolean;
  // False only for pages with no independent identity outside a test — raw
  // HTML pasted straight into a test's "Add Variant" flow. AI-generated
  // pages can always publish a standalone URL, even once linked to a test —
  // publishing and serving test traffic are independent concerns.
  canPublish?: boolean;
}

// Soft cap on the initial prompt — generous enough for a detailed multi-section
// brief, tight enough to keep the schema the AI generates within one response.
const MAX_PROMPT_LENGTH = 6000;


function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.');
  const result = { ...obj };
  let current: Record<string, unknown> = result;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const existing = current[key];
    if (Array.isArray(existing)) {
      current[key] = [...existing];
    } else if (typeof existing === 'object' && existing !== null) {
      current[key] = { ...(existing as Record<string, unknown>) };
    } else {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
  return result;
}

// ── Sample prompt chip ────────────────────────────────────────────────────────

function renderPromptWithHighlights(text: string) {
  const parts = text.split(/(\[[^\]]+\])/g);
  return parts.map((part, i) =>
    /^\[.+\]$/.test(part)
      ? <strong key={i} className="text-indigo-600 dark:text-indigo-400 font-semibold not-italic">{part}</strong>
      : <span key={i}>{part}</span>
  );
}

function SamplePromptChip({ vertical, onUse }: { vertical: string; onUse: (prompt: string) => void }) {
  const samplePrompt = SAMPLE_PROMPTS[vertical] ?? SAMPLE_PROMPTS['other'];
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="relative flex justify-end"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => onUse(samplePrompt)}
        className="inline-flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors"
      >
        <Sparkles size={10} />
        Try an example
      </button>

      {hovered && (
        <>
          {/* Transparent bridge covers the 8px gap between button and tooltip so mouseleave never fires mid-transit */}
          <div className="absolute bottom-full right-0 h-2 w-72 z-50" />
          <div className="absolute bottom-full right-0 mb-2 w-72 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700">
              <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Sample prompt</span>
              {/* <span className="text-[10px] text-indigo-600 dark:text-indigo-400">Click to use</span> */}
            </div>
            <p className="px-3 py-2.5 text-[11px] text-slate-300 leading-relaxed whitespace-pre-wrap max-h-56 overflow-y-auto">
              {renderPromptWithHighlights(samplePrompt)}
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function hasUnfilledPlaceholders(text: string): boolean {
  return /\[[^\]]+\]/.test(text);
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Compact AI-credit meter for the builder top bar — always visible so users
 * know where their monthly allowance stands while editing (Unbounce-style).
 * Small green bar that shifts amber→red as it fills. Hidden on plans with no
 * AI credits. Polls lightly so it reflects credits spent during the session.
 */
function AiCreditsMeter() {
  const [data, setData] = useState<{ creditsUsed: number; creditsIncluded: number; percentUsed: number } | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => {
      fetch('/api/ai-usage')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (active && d) setData(d); })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 20_000); // keep it roughly current as edits burn credits
    return () => { active = false; clearInterval(id); };
  }, []);

  if (!data || data.creditsIncluded <= 0) return null;
  const pct = Math.min(100, Math.round(data.percentUsed));
  const bar = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-green-500';

  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1 rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
      title={`${data.creditsUsed.toLocaleString()} of ${data.creditsIncluded.toLocaleString()} AI credits used this month`}
    >
      <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap">AI credits</span>
      <div className="w-16 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
        <div className={`h-full ${bar} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200 tabular-nums whitespace-nowrap">
        {data.creditsUsed.toLocaleString()}/{data.creditsIncluded.toLocaleString()}
      </span>
    </div>
  );
}

export default function AIBuilderClient({ workspaceId, clientId, clientName, variantName, initialPage, backPath, canUseAI = true, isTestVariantPage = false, canPublish = true }: Props) {
  const router = useRouter();

  // Variant pages ask the preview route for the in-progress draft; every
  // other page type (and every other caller of /preview, e.g. the UTM
  // picker) always sees the live HTML.
  function previewUrl(pid: string) {
    return isTestVariantPage
      ? `/api/pages/${pid}/preview?draft=1&t=${Date.now()}`
      : `/api/pages/${pid}/preview?t=${Date.now()}`;
  }

  if (!canUseAI) {
    return (
      <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-50 dark:bg-slate-900 transition-[left] duration-200" style={{ left: 'var(--sl-sidebar-w, 15rem)' }}>
        <div className="flex flex-col items-center text-center max-w-md px-6">
          <div className="w-16 h-16 rounded-2xl bg-indigo-50 dark:bg-indigo-600/10 border border-indigo-100 dark:border-indigo-600/20 flex items-center justify-center mb-5">
            <Lock size={26} className="text-indigo-500 dark:text-indigo-400" />
          </div>
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
            AI Page Builder is not available on your plan
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed mb-2">
            AI website generation is available on the <strong className="text-slate-700 dark:text-slate-300">Growth</strong>, <strong className="text-slate-700 dark:text-slate-300">Agency</strong>, and <strong className="text-slate-700 dark:text-slate-300">Scale</strong> plans.
          </p>
          <p className="text-sm text-slate-400 dark:text-slate-500 leading-relaxed mb-8">
            Upgrade to generate landing pages with AI, edit them with chat, and publish them directly as A/B test variants.
          </p>
          <a
            href="/billing"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors shadow-lg shadow-indigo-600/25"
          >
            Upgrade Plan
            <ArrowRight size={15} />
          </a>
          <button
            onClick={() => { router.push(backPath ?? `/clients/${clientId}/pages`); router.refresh(); }}
            className="mt-4 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          >
            ← Back to pages
          </button>
        </div>
      </div>
    );
  }

  const [phase, setPhase] = useState<Phase>('prompt');
  const [pageName, setPageName] = useState('');
  const [vertical, setVertical] = useState<string>('lead_gen');
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [followUpInput, setFollowUpInput] = useState('');
  const [buildEvents, setBuildEvents] = useState<SSEEvent[]>([]);
  const [followUpEvents, setFollowUpEvents] = useState<SSEEvent[] | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('desktop');
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });

  // Measure the available preview area so the desktop iframe can be rendered at a real
  // desktop width (1440px) and scaled down — otherwise the panel's actual width triggers
  // the page's own mobile/tablet CSS breakpoints even in "Desktop" mode.
  useEffect(() => {
    const el = previewWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setPreviewSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const DESKTOP_PREVIEW_WIDTH = 1440;
  const desktopScale = previewSize.width > 0 ? Math.min(1, previewSize.width / DESKTOP_PREVIEW_WIDTH) : 1;

  const [pageId, setPageId] = useState<string | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [htmlUrl, setHtmlUrl] = useState<string | null>(null);
  const [iframeSrc, setIframeSrc] = useState<string | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [schemaJson, setSchemaJson] = useState<unknown>(null);
  const [conversationJson, setConversationJson] = useState<{ role: string; content: string; image_urls?: string[] }[]>([]);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [urlCopied, setUrlCopied] = useState(false);
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);

  const [pendingImageField, setPendingImageField] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  // Variant pages only: true once any edit has landed in draft_* columns —
  // gates the Save (Replace / Save as New) controls and the confirm modal.
  const [hasDraft, setHasDraft] = useState(false);
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false);
  const [savingVariant, setSavingVariant] = useState<'replace' | 'new' | null>(null);
  const [saveAsNewOpen, setSaveAsNewOpen] = useState(false);
  const [newVariantForkName, setNewVariantForkName] = useState('');

  // Save as New Test / Save as a Variant — only reachable for pages that
  // aren't yet linked to any test (isTestVariantPage === false); once linked,
  // this whole toolbar branch stops rendering in favor of the Replace/Save as
  // New dropdown above.
  const [showCreateSaveMenu, setShowCreateSaveMenu] = useState(false);
  const [saveAsTestOpen, setSaveAsTestOpen] = useState(false);
  const [newTestName, setNewTestName] = useState('');
  const [newTestUrlPath, setNewTestUrlPath] = useState('/');
  const [savingAsTest, setSavingAsTest] = useState(false);
  const [saveAsVariantOpen, setSaveAsVariantOpen] = useState(false);
  const [workspaceTestsForSave, setWorkspaceTestsForSave] = useState<{ id: string; name: string; test_variants: { id: string }[] }[]>([]);
  const [loadingWorkspaceTests, setLoadingWorkspaceTests] = useState(false);
  const [selectedSaveTestId, setSelectedSaveTestId] = useState('');
  const [saveVariantName, setSaveVariantName] = useState('');
  const [savingAsVariant, setSavingAsVariant] = useState(false);

  // Out-of-credits upsell modal — opened when an edit is soft-capped (402 softCap).
  // Lets the user turn on metered overage (auto-bill) with a spend cap + reminder
  // threshold, then retries the blocked edit. Wired to PATCH /api/ai-usage.
  const [outOfCredits, setOutOfCredits] = useState<{ creditsUsed: number; creditsIncluded: number; retry: () => void } | null>(null);
  // Prepaid top-up amounts (cents) → credits, at $0.05/credit (keep in sync with
  // TOPUP_CENTS_PER_CREDIT server-side). Labels avoid em dashes on purpose.
  const TOPUP_OPTIONS = [
    { cents: 5000, label: '$50 (1,000 credits)' },
    { cents: 10000, label: '$100 (2,000 credits)' },
    { cents: 20000, label: '$200 (4,000 credits)' },
    { cents: 50000, label: '$500 (10,000 credits)' },
  ];
  const [ocAmountCents, setOcAmountCents] = useState(5000);
  const [ocBuying, setOcBuying] = useState(false);  // redirecting to Stripe
  const [ocSaving, setOcSaving] = useState(false);  // enabling auto-billing

  // Prepaid: send them to Stripe to buy credits; the webhook grants them on success.
  async function buyCredits() {
    setOcBuying(true);
    try {
      const res = await fetch('/api/ai-usage/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountCents: ocAmountCents, returnUrl: window.location.href }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.url) { window.location.href = d.url; return; }
      toast.error(d.error || 'Could not start checkout.');
    } catch {
      toast.error('Could not start checkout.');
    } finally {
      setOcBuying(false);
    }
  }

  // Alternative: pay only for what you use. Turns on overage capped at the amount
  // selected above, then retries the blocked edit.
  async function enableOverageAndRetry() {
    setOcSaving(true);
    try {
      const capCents = ocAmountCents;
      const res = await fetch('/api/ai-usage', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, capCents, notifyCents: capCents }),
      });
      if (!res.ok) throw new Error();
      const retry = outOfCredits?.retry;
      setOutOfCredits(null);
      toast.success(`You're all set. You can keep building up to $${(capCents / 100).toFixed(0)}.`);
      retry?.();
    } catch {
      toast.error('Could not update billing settings. Please try again.');
    } finally {
      setOcSaving(false);
    }
  }

  // Chat image attachments (paste / file-picker / drag-and-drop)
  const [chatImages, setChatImages] = useState<{ file: File; preview: string }[]>([]);
  const chatImageInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingChatImage, setIsDraggingChatImage] = useState(false);

  // Background schema synthesis for raw-HTML pages that arrive here without a
  // schema_json (e.g. test variants opened via "Edit using AI"). Isolated
  // from the normal generate→build flow — only ever fires for pages that
  // have HTML but no schema, and only once per page (guarded below and
  // idempotently on the server).
  const [preparingSchema, setPreparingSchema] = useState(false);
  // True when the schema-from-html prep failed (fetch error, SSE error
  // event, or thrown exception). Editing stays locked while this is true —
  // there is no valid schema to edit against — until a retry succeeds.
  const [schemaPrepFailed, setSchemaPrepFailed] = useState(false);
  // Live SSE checklist for the schema-from-html background prep — null when
  // idle/not applicable, [] once the stream opens, populated with status/
  // done/error events as they arrive. Separate from preparingSchema (which
  // only gates input disabling) since this drives the LiveProgressPanel.
  const [schemaEvents, setSchemaEvents] = useState<SSEEvent[] | null>(null);
  // Guards only the automatic first fire in the effect below — the "Try
  // again" retry calls runSchemaPrep() directly and must not be blocked by it.
  const schemaFromHtmlFiredRef = useRef(false);

  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [competitorScreenshots, setCompetitorScreenshots] = useState<string[] | null>(null);
  const [competitorCssTokens, setCompetitorCssTokens] = useState<string | null>(null);
  const [competitorPageContent, setCompetitorPageContent] = useState<string | null>(null);

  const schemaRef = useRef<unknown>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const followUpRef = useRef<HTMLTextAreaElement>(null);
  const FOLLOW_UP_MAX_HEIGHT = 240;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Restore state from pre-created page
  // Editing wipes UTM mappings/rules server-side — warn ONCE the first time edit
  // mode starts this session, not on every edit. (phase cycles editing→…→editing
  // per edit, which used to re-fire this toast each time.) The Save confirm modal
  // repeats the UTM-clear warning at replace time, so once here is enough.
  const utmWarnedRef = useRef(false);
  useEffect(() => {
    if (phase !== 'editing' || utmWarnedRef.current) return;
    utmWarnedRef.current = true;
    // Show it at most once per page — and remember across refreshes — so it stops
    // nagging on every edit. The Save confirm modal repeats the warning at replace time.
    const seenKey = `sl-utm-warned-${initialPage?.id ?? 'new'}`;
    try {
      if (localStorage.getItem(seenKey)) return;
      localStorage.setItem(seenKey, '1');
    } catch { /* ignore storage errors */ }
    toast(
      () => (
        <span className="text-xs">
          {isTestVariantPage ? (
            <>
              <strong>Replacing the live variant clears its UTM mappings and personalization rules.</strong>{' '}
              Edits stay in a draft until you replace the live variant — after that, re-map elements in UTM Personalization.
            </>
          ) : (
            <>
              <strong>Editing this page clears its UTM mappings and personalization rules.</strong>{' '}
              Re-map elements in UTM Personalization after any edit.
            </>
          )}
        </span>
      ),
      {
        id: 'utm-wipe-warning',
        icon: '⚠️',
        duration: Infinity,
        style: { background: 'rgb(254 243 199)', color: 'rgb(146 64 14)', maxWidth: '420px' },
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Dismiss the UTM warning only when leaving the builder — not on every phase
  // change — so it stays put once (until the user closes it) instead of flashing.
  useEffect(() => () => toast.dismiss('utm-wipe-warning'), []);

  // Returning from a Stripe credit top-up: confirm and strip the query param so
  // the meter (which polls /api/ai-usage) reflects the new balance on next tick.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const status = p.get('topup');
    if (!status) return;
    if (status === 'success') toast.success('Credits added. You can keep building.');
    p.delete('topup');
    const q = p.toString();
    window.history.replaceState({}, '', window.location.pathname + (q ? `?${q}` : ''));
  }, []);

  useEffect(() => {
    if (!initialPage) return;
    setPageId(initialPage.id);
    setPageName(initialPage.name);
    setVertical(initialPage.vertical);

    // Fresh page (just created from modal) — no HTML yet, stay in prompt phase
    if (!initialPage.html_url) return;

    // Variant pages resume from their draft (if one exists) rather than the
    // live schema, so the user picks up exactly where they left off.
    const hasExistingDraft = isTestVariantPage && !!initialPage.draft_html_content;
    setHasDraft(hasExistingDraft);
    const initialSchema = hasExistingDraft ? (initialPage.draft_schema_json ?? initialPage.schema_json) : initialPage.schema_json;
    setSchemaJson(initialSchema);
    schemaRef.current = initialSchema;
    const history = initialPage.conversation_json ?? [];
    setConversationJson(history);
    setHtmlUrl(initialPage.html_url);
    setSlug(initialPage.slug);
    if (initialPage.is_published && initialPage.published_url) {
      setPublishedUrl(initialPage.published_url);
    }
    setPhase('editing');

    // Walk history by role rather than assuming strict user/assistant alternation —
    // older pages saved through the clarifying-questions round contain a duplicated
    // user entry, and pair-wise iteration would render assistant JSON payloads as
    // user bubbles. Assistant entries are always raw JSON in storage, so they are
    // replaced with friendly canned text.
    const restored: Message[] = [];
    let assistantSeen = false;
    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      if (entry.role === 'user') {
        const prev = history[i - 1];
        if (prev && prev.role === 'user' && prev.content === entry.content) continue;
        const userEntry: Message = { role: 'user', content: entry.content };
        if (Array.isArray(entry.image_urls) && entry.image_urls.length > 0) userEntry.image_urls = entry.image_urls;
        restored.push(userEntry);
      } else {
        restored.push({
          role: 'assistant',
          content: assistantSeen
            ? 'Done! The page has been updated.'
            : `Got it! Built your ${VERTICAL_LABELS[initialPage.vertical] ?? 'new'} page.`,
        });
        assistantSeen = true;
      }
    }
    restored.push({
      role: 'assistant',
      content: (initialPage.draft_schema_json ?? initialPage.schema_json)
        ? 'Welcome back. Click any text in the preview to edit, or ask me to make changes.'
        : "This page hasn't been set up for AI editing yet — preparing it now. In the meantime, describe any change below and I'll apply it once ready.",
    });
    setMessages(restored);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Raw-HTML pages (e.g. test variants opened via "Edit using AI") land here
  // with html_url/html_content but no schema_json — WYSIWYG click-to-edit and
  // structural follow-up edits both need one. Synthesize it in the background
  // so the user can start typing immediately; chat submission is gated below
  // until this completes to avoid two concurrent writes to the same page row.
  // Extracted so both the automatic first-run effect below and the manual
  // "Try again" button (rendered when schemaPrepFailed is true) can invoke
  // the exact same prep flow. Does not consult schemaFromHtmlFiredRef —
  // that ref only exists to stop the effect from auto-firing twice, not to
  // block a deliberate retry.
  async function runSchemaPrep() {
    if (!initialPage || !initialPage.html_url) return;
    setPreparingSchema(true);
    setSchemaPrepFailed(false);
    setSchemaEvents([]);
    try {
      const res = await fetch(`/api/pages/${initialPage.id}/schema-from-html`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Couldn't prepare this page for AI editing.");
        setSchemaPrepFailed(true);
        return;
      }

      let resultSchemaJson: unknown;
      let resultHtmlUrl: string | undefined;
      let resultAlready = false;
      let resultElapsedMs: number | undefined;
      let streamFailed = false;

      // The route returns a plain JSON body for the "already prepared"
      // fast path (idempotency guard, before any SSE stream opens) and an
      // SSE stream for the real multi-minute pipeline — content-type tells
      // them apart, no change needed to the fast path's response shape.
      if (res.headers.get('content-type')?.includes('text/event-stream')) {
        await readSSEStream(res, (event) => {
          setSchemaEvents(prev => prev ? [...prev, event] : [event]);
          if (event.type === 'done') {
            resultSchemaJson = event.schema_json;
            resultHtmlUrl = event.html_url;
            resultAlready = !!event.already;
            resultElapsedMs = event.elapsed_ms;
          } else if (event.type === 'error') {
            streamFailed = true;
            toast.error(event.message || "Couldn't prepare this page for AI editing.");
          }
        });
        if (streamFailed) { setSchemaPrepFailed(true); return; }
      } else {
        const data = await res.json();
        resultSchemaJson = data.schema_json;
        resultHtmlUrl = data.html_url;
        resultAlready = !!data.already;
      }

      if (resultSchemaJson) {
        schemaRef.current = resultSchemaJson;
        setSchemaJson(resultSchemaJson);
      }
      if (resultHtmlUrl) {
        setHtmlUrl(`${resultHtmlUrl}?t=${Date.now()}`);
      }
      if (isTestVariantPage && !resultAlready) setHasDraft(true);
      // Transient confirmation only — the chat message below carries the
      // same info permanently, so this doesn't need to persist like the
      // UTM warning toast does (which stays until the user dismisses it).
      toast.success('This page is ready for AI editing.', {
        id: 'schema-from-html-ready',
        duration: 4000,
      });
      addMessage({ role: 'assistant', content: 'Done preparing this page! Click any text in the preview to edit it, or ask me to make changes.', elapsedMs: resultElapsedMs });
    } catch {
      toast.error("Couldn't prepare this page for AI editing.");
      setSchemaPrepFailed(true);
    } finally {
      setPreparingSchema(false);
      setSchemaEvents(null);
    }
  }

  useEffect(() => {
    if (!initialPage || !initialPage.html_url) return;
    if (initialPage.draft_schema_json ?? initialPage.schema_json) return;
    if (schemaFromHtmlFiredRef.current) return;
    schemaFromHtmlFiredRef.current = true;
    runSchemaPrep();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPage]);

  // Stable iframe src — points to preview route, refreshes when htmlUrl is available/changes
  useEffect(() => {
    if (!pageId || !htmlUrl) return;
    const src = previewUrl(pageId);
    setIframeSrc(src);
    setIframeLoaded(false);
  }, [pageId, htmlUrl]);

  // Fallback for iframeLoaded: the React onLoad prop can fail to fire even though the
  // frame's document has actually finished loading, so also listen natively and poll
  // readyState as a backstop.
  useEffect(() => {
    if (!iframeSrc) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    // readyState 'complete' fires once fonts/CSS/images are fetched, but the page still
    // needs a beat to actually paint (render-blocking @import fonts, fade-in animations
    // on load) — reveal a moment later so we don't flash its blank white background.
    let revealTimer: ReturnType<typeof setTimeout> | null = null;
    const markLoaded = () => {
      if (revealTimer) return;
      revealTimer = setTimeout(() => setIframeLoaded(true), 150);
    };
    iframe.addEventListener('load', markLoaded);

    const poll = setInterval(() => {
      try {
        if (iframe.contentDocument?.readyState === 'complete') {
          markLoaded();
          clearInterval(poll);
        }
      } catch {
        // cross-origin or not yet accessible — keep polling until timeout below
      }
    }, 250);

    const timeout = setTimeout(markLoaded, 8000);

    return () => {
      iframe.removeEventListener('load', markLoaded);
      clearInterval(poll);
      clearTimeout(timeout);
      if (revealTimer) clearTimeout(revealTimer);
    };
  }, [iframeSrc]);

  // postMessage: field edits + image clicks
  useEffect(() => {
    if (!pageId) return;
    const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function handleMessage(e: MessageEvent) {
      if (e.data?.type === 'sl_image_click') {
        setPendingImageField(e.data.field as string);
        imageInputRef.current?.click();
        return;
      }
      if (e.data?.type !== 'sl_field_edit') return;
      const { field, value } = e.data as { field: string; value: string };

      const updated = setNestedValue(
        (schemaRef.current as Record<string, unknown>) ?? {},
        field,
        value
      );
      schemaRef.current = updated;
      setSchemaJson(updated);

      const existing = saveTimers.get(field);
      if (existing) clearTimeout(existing);
      saveTimers.set(field, setTimeout(async () => {
        const html = getCleanHtml();
        await fetch(`/api/pages/${pageId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schema_json: updated,
            html_content: html,
            ...(isTestVariantPage ? { draft: true } : {}),
          }),
        });
        if (isTestVariantPage) setHasDraft(true);
        saveTimers.delete(field);
      }, 800));
    }

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      saveTimers.forEach(t => clearTimeout(t));
    };
  }, [pageId]);

  // Inject contentEditable after iframe loads
  useEffect(() => {
    if (!iframeLoaded || !iframeRef.current || phase !== 'editing') return;
    const doc = iframeRef.current.contentDocument;
    if (!doc) return;
    const script = doc.createElement('script');
    script.setAttribute('data-sl-editor', 'true');
    script.textContent = `
      (function() {
        var saveTimer;
        document.querySelectorAll('[data-field]').forEach(function(el) {
          if (el.tagName === 'IMG') {
            el.style.cursor = 'pointer';
            el.addEventListener('click', function() {
              window.parent.postMessage({ type: 'sl_image_click', field: el.getAttribute('data-field') }, '*');
            });
            el.addEventListener('mouseenter', function() { el.style.outline = '2px solid #3D8BDA'; });
            el.addEventListener('mouseleave', function() { el.style.outline = ''; });
            return;
          }
          el.contentEditable = 'true';
          el.style.outline = 'none';
          el.style.cursor = 'text';
          el.addEventListener('mouseenter', function() {
            el.style.boxShadow = '0 0 0 2px rgba(61,139,218,0.5)';
            el.style.borderRadius = '2px';
          });
          el.addEventListener('mouseleave', function() {
            if (document.activeElement !== el) el.style.boxShadow = '';
          });
          el.addEventListener('focus', function() {
            el.style.boxShadow = '0 0 0 2px #3D8BDA';
          });
          el.addEventListener('blur', function() {
            el.style.boxShadow = '';
            var field = el.getAttribute('data-field');
            var value = el.innerText;
            clearTimeout(saveTimer);
            saveTimer = setTimeout(function() {
              window.parent.postMessage({ type: 'sl_field_edit', field: field, value: value }, '*');
            }, 400);
          });
        });
      })();
    `;
    doc.body.appendChild(script);
  }, [iframeLoaded, phase]);

  // Auto-scroll chat
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, phase]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  function addMessage(msg: Message) {
    setMessages(prev => [...prev, msg]);
  }

  // The live iframe DOM has editor-only mutations baked in (contentEditable,
  // hover/focus outline styles, the injected editor <script>). Strip those
  // before persisting or downloading so they never leak into the page real
  // visitors see.
  function getCleanHtml(): string | null {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return null;
    const clone = doc.documentElement.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[data-sl-editor]').forEach(el => el.remove());
    clone.querySelectorAll('[data-field]').forEach((el) => {
      el.removeAttribute('contenteditable');
      const style = el as HTMLElement;
      style.style.outline = '';
      style.style.cursor = '';
      style.style.boxShadow = '';
      style.style.borderRadius = '';
    });
    return '<!DOCTYPE html>\n' + clone.outerHTML;
  }

  // ── Generate → Build ──────────────────────────────────────────────────────

  async function runGenerate(userPrompt: string, history: { role: string; content: string; image_urls?: string[] }[]) {
    setPhase('generating');
    const res = await fetch('/api/pages/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: userPrompt, vertical, conversation_json: history, workspace_id: workspaceId }),
    });
    if (!res.ok) {
      const err = await res.json();
      toast.error(err.error || 'Generation failed');
      setPhase(history.length > 0 ? 'questions' : 'prompt');
      return;
    }
    const data = await res.json();

    // Store competitor context for questions round trip (state persists across re-renders)
    if (data.competitor_screenshots) setCompetitorScreenshots(data.competitor_screenshots as string[]);
    if (data.competitor_css_tokens) setCompetitorCssTokens(data.competitor_css_tokens);
    if (data.competitor_page_content) setCompetitorPageContent(data.competitor_page_content);

    // Capture competitor data directly from response — React setState is async so reading
    // state immediately after set would still return the old null values.
    const freshCompetitorScreenshots = (data.competitor_screenshots as string[]) ?? null;
    const freshCompetitorCssTokens = (data.competitor_css_tokens as string) ?? null;
    const freshCompetitorPageContent = (data.competitor_page_content as string) ?? null;

    if (data.type === 'questions') {
      setQuestions(data.questions);
      setAnswers(new Array(data.questions.length).fill(''));
      addMessage({ role: 'assistant', content: 'I have a few questions to build the best page for you:', isQuestions: true, questions: data.questions });
      setPhase('questions');
      return;
    }
    addMessage({ role: 'assistant', content: `Got it! Building your ${VERTICAL_LABELS[vertical]} page now…` });
    const updatedHistory = [
      ...history,
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: JSON.stringify(data.schema) },
    ];
    setConversationJson(updatedHistory);
    await runBuild(data.schema, updatedHistory, freshCompetitorScreenshots, freshCompetitorCssTokens, freshCompetitorPageContent);
  }

  async function runBuild(schema: unknown, history: { role: string; content: string; image_urls?: string[] }[], freshScreenshots?: string[] | null, freshCssTokens?: string | null, freshPageContent?: string | null) {
    if (!pageId) return;
    setPhase('building');
    setBuildEvents([]);

    // Step 1: upload any attached images first
    let image_urls: string[] = [];
    if (chatImages.length > 0) {
      const attachedImages = chatImages;
      setChatImages([]);
      try {
        image_urls = await Promise.all(
          attachedImages.map(async ({ file }) => {
            const fd = new FormData();
            fd.append('file', file);
            const r = await fetch(`/api/pages/${pageId}/upload-chat-image`, { method: 'POST', body: fd });
            if (!r.ok) { const err = await r.json(); throw new Error(err.error || 'Image upload failed'); }
            const { url } = await r.json();
            return url as string;
          })
        );
        attachedImages.forEach(img => URL.revokeObjectURL(img.preview));
        setMessages(prev => {
          const updated = [...prev];
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === 'user') {
              updated[i] = { ...updated[i], image_urls };
              break;
            }
          }
          return updated;
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Image upload failed');
        setPhase('prompt');
        return;
      }
    }

    // Step 2: build HTML via SSE
    const res = await fetch('/api/pages/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema_json: schema,
        user_prompt: prompt,
        workspace_id: workspaceId,
        ...(image_urls.length > 0 ? { image_urls } : {}),
        ...((freshScreenshots ?? competitorScreenshots)?.length ? { competitor_screenshots: freshScreenshots ?? competitorScreenshots } : {}),
        ...(((freshCssTokens ?? competitorCssTokens)) ? { competitor_css_tokens: freshCssTokens ?? competitorCssTokens } : {}),
        ...(((freshPageContent ?? competitorPageContent)) ? { competitor_page_content: freshPageContent ?? competitorPageContent } : {}),
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Build failed' }));
      toast.error(err.error || 'Build failed');
      setPhase('prompt');
      return;
    }

    let htmlUrl: string | null = null;
    let finalSlug: string | null = null;
    let finalSchema: unknown = schema;
    let buildError = false;

    await readSSEStream(res, (event) => {
      setBuildEvents(prev => [...prev, event]);
      if (event.type === 'done') {
        htmlUrl = event.html_url;
        finalSlug = event.slug ?? null;
        finalSchema = event.schema_json ?? schema;
      } else if (event.type === 'error') {
        buildError = true;
        toast.error(event.message || 'Build failed');
      }
    });

    if (buildError || !htmlUrl) {
      setPhase('prompt');
      return;
    }

    // Attach image_urls to the last user entry in history before saving
    const historyWithImages = image_urls.length > 0
      ? history.map((entry, i) =>
          i === history.length - 2 && entry.role === 'user'
            ? { ...entry, image_urls }
            : entry
        )
      : history;

    // Step 3: PATCH first so DB has html_url before preview route is hit
    const patchRes = await fetch(`/api/pages/${pageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        slug: finalSlug,
        html_url: htmlUrl,
        schema_json: finalSchema,
        conversation_json: historyWithImages,
      }),
    });
    if (!patchRes.ok) {
      toast('Page built but metadata not saved — edits may not persist.', { icon: '⚠️' });
    }

    setHtmlUrl(htmlUrl);
    setSlug(finalSlug);
    schemaRef.current = finalSchema;
    setSchemaJson(finalSchema);
    setPhase('editing');
    addMessage({ role: 'assistant', content: 'Your page is ready! Click any text in the preview to edit it, or ask me to make changes.' });
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim() || !pageName.trim()) return;
    if (prompt.length > MAX_PROMPT_LENGTH) {
      toast.error(`Your prompt is ${prompt.length - MAX_PROMPT_LENGTH} characters over the limit — please shorten it.`);
      return;
    }
    if (hasUnfilledPlaceholders(prompt)) {
      toast.error('Please fill in the highlighted [placeholder] fields before building.');
      return;
    }
    const previewUrls = chatImages.map(img => img.preview);
    addMessage({ role: 'user', content: prompt, ...(previewUrls.length > 0 ? { image_urls: previewUrls } : {}) });
    await runGenerate(prompt, []);
  }

  async function handleAnswers(e: React.FormEvent) {
    e.preventDefault();
    const answersText = questions.map((q, i) => `${q}\n${answers[i] || '(no answer)'}`).join('\n\n');
    addMessage({ role: 'user', content: answersText });
    // Do NOT include answersText here — runGenerate appends it as the final user
    // entry itself; including it would duplicate the message and break the
    // user/assistant alternation in the saved conversation.
    const history = [
      { role: 'user', content: prompt },
      { role: 'assistant', content: JSON.stringify({ type: 'questions', questions }) },
    ];
    await runGenerate(answersText, history);
  }

  async function handleSurpriseMe() {
    addMessage({ role: 'user', content: 'Surprise me — just build the best default.' });
    const history = [
      { role: 'user', content: prompt },
      { role: 'assistant', content: JSON.stringify({ type: 'questions', questions }) },
    ];
    await runGenerate('Surprise me — just build the best default.', history);
  }

  function addChatImages(files: File[]) {
    setChatImages(prev => {
      const remaining = 3 - prev.length;
      if (remaining <= 0) { toast.error('Maximum 3 images per message'); return prev; }
      const toAdd = files.slice(0, remaining);
      if (files.length > remaining) toast.error(`Only ${remaining} more image${remaining === 1 ? '' : 's'} allowed`);
      return [
        ...prev,
        ...toAdd.map(f => ({ file: f, preview: URL.createObjectURL(f) })),
      ];
    });
  }

  function removeChatImage(index: number) {
    setChatImages(prev => {
      URL.revokeObjectURL(prev[index].preview);
      return prev.filter((_, i) => i !== index);
    });
  }

  function handleChatImagePaste(e: React.ClipboardEvent) {
    const imageFiles = Array.from(e.clipboardData.items)
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (imageFiles.length > 0) {
      e.preventDefault();
      addChatImages(imageFiles);
    }
  }

  function handleChatImagePicker(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) addChatImages(files);
    e.target.value = '';
  }

  function handleChatImageDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setIsDraggingChatImage(true);
  }

  function handleChatImageDragLeave(e: React.DragEvent<HTMLDivElement>) {
    // Only clear when the pointer actually leaves the box, not when it
    // crosses into a child element (dragenter/dragleave fire on every
    // child boundary too, which would otherwise flicker the highlight).
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDraggingChatImage(false);
  }

  function handleChatImageDrop(e: React.DragEvent) {
    if (e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    setIsDraggingChatImage(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length > 0) addChatImages(files);
  }

  async function sendFollowUp(
    instruction: string,
    images: { file: File; preview: string }[],
    pid: string,
    silent = false
  ) {
    if (!silent) {
      const previewUrls = images.map(img => img.preview);
      addMessage({ role: 'user', content: instruction, ...(previewUrls.length > 0 ? { image_urls: previewUrls } : {}) });
    }
    setPhase('generating');

    // Upload images and collect real URLs
    let image_urls: string[] = [];
    if (images.length > 0) {
      try {
        image_urls = await Promise.all(
          images.map(async ({ file }) => {
            const fd = new FormData();
            fd.append('file', file);
            const r = await fetch(`/api/pages/${pid}/upload-chat-image`, { method: 'POST', body: fd });
            if (!r.ok) { const err = await r.json(); throw new Error(err.error || 'Image upload failed'); }
            const { url } = await r.json();
            return url as string;
          })
        );
        // Replace blob preview URLs with real URLs, then revoke blobs
        images.forEach(img => URL.revokeObjectURL(img.preview));
        if (!silent) {
          setMessages(prev => {
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === 'user') {
                updated[i] = { ...updated[i], image_urls };
                break;
              }
            }
            return updated;
          });
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Image upload failed');
        setPhase('editing');
        return;
      }
    }

    setFollowUpEvents([]);

    const res = await fetch(`/api/pages/${pid}/follow-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: instruction,
        current_schema: schemaRef.current,
        ...(image_urls.length > 0 ? { image_urls } : {}),
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Edit failed' }));
      const message = err.error || 'Edit failed';
      if (err.limitError) {
        // Plan doesn't include AI editing — upsell to a higher tier.
        toast.error((t) => (
          <span>
            {message}{' '}
            <a
              href="/billing"
              onClick={() => toast.dismiss(t.id)}
              className="underline font-semibold"
            >
              Upgrade Plan
            </a>
          </span>
        ), { duration: 8000 });
      } else if (err.softCap) {
        // Out of AI credits / over the overage spend cap — open the upsell modal so
        // they can turn on overage and continue; on confirm we retry this same edit.
        setOutOfCredits({
          creditsUsed: err.usage?.creditsUsed ?? 0,
          creditsIncluded: err.usage?.creditsIncluded ?? 0,
          retry: () => sendFollowUp(instruction, images, pid, true),
        });
      } else {
        toast.error(message);
      }
      setFollowUpEvents(null);
      setPhase('editing');
      return;
    }

    type FollowUpDone = { html_url: string; schema_json?: unknown; competitor_fetch_failed?: boolean; elapsed_ms?: number };
    let doneData: FollowUpDone | null = null;
    let followUpError = false;
    let clarifyMessage: string | null = null;

    await readSSEStream(res, (event) => {
      setFollowUpEvents(prev => prev ? [...prev, event] : [event]);
      if (event.type === 'done') {
        doneData = {
          html_url: event.html_url,
          schema_json: event.schema_json,
          competitor_fetch_failed: event.competitor_fetch_failed,
          elapsed_ms: event.elapsed_ms,
        };
      } else if (event.type === 'clarify') {
        clarifyMessage = event.message || 'Which part of the page should I edit?';
      } else if (event.type === 'error') {
        followUpError = true;
        const msg = event.message || 'Edit failed';
        toast.error(msg);
        if (!silent) {
          addMessage({ role: 'assistant', content: msg });
        }
      }
    });

    setFollowUpEvents(null);

    if (clarifyMessage) {
      const clarifyText = clarifyMessage;
      if (!silent) {
        addMessage({ role: 'assistant', content: clarifyText });
      }
      setConversationJson(prev => [
        ...prev,
        { role: 'user', content: instruction },
        { role: 'assistant', content: clarifyText },
      ]);
      setPhase('editing');
      return;
    }

    if (followUpError || !doneData) {
      setPhase('editing');
      return;
    }

    const done = doneData as FollowUpDone;
    if (done.competitor_fetch_failed) {
      toast("Couldn't access that site — building from your description instead.", { icon: '⚠️' });
    }
    if (done.schema_json) { schemaRef.current = done.schema_json; setSchemaJson(done.schema_json); }
    setHtmlUrl(done.html_url + `?t=${Date.now()}`);
    if (isTestVariantPage) setHasDraft(true);
    // Server only emits `done` when HTML actually changed — never claim success otherwise.
    if (!silent) {
      addMessage({ role: 'assistant', content: 'Done! The page has been updated.', elapsedMs: done.elapsed_ms });
    }
    setConversationJson(prev => [
      ...prev,
      { role: 'user', content: instruction },
      { role: 'assistant', content: JSON.stringify(done) },
    ]);
    setPhase('editing');
  }

  async function handleFollowUp(e: React.FormEvent) {
    e.preventDefault();
    if ((!followUpInput.trim() && chatImages.length === 0) || !pageId || preparingSchema || schemaPrepFailed) return;
    const instruction = followUpInput.trim() || 'Please incorporate these reference images into the page.';
    const attachedImages = chatImages;
    setFollowUpInput('');
    setChatImages([]);
    if (followUpRef.current) followUpRef.current.style.height = 'auto';
    await sendFollowUp(instruction, attachedImages, pageId);
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !pendingImageField || !pageId) return;
    e.target.value = '';
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
    if (!allowed.includes(file.type)) { toast.error('Unsupported file type. Use JPEG, PNG, WebP, GIF, or SVG.'); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error('Image must be under 5MB.'); return; }
    setUploadingImage(true);
    addMessage({ role: 'user', content: `Uploading image for "${pendingImageField}"…` });
    const formData = new FormData();
    formData.append('file', file);
    formData.append('field_path', pendingImageField);
    const res = await fetch(`/api/pages/${pageId}/upload-image`, { method: 'POST', body: formData });
    setUploadingImage(false);
    setPendingImageField(null);
    if (!res.ok) { const err = await res.json(); toast.error(err.error || 'Image upload failed'); return; }
    const { html_url } = await res.json();
    setHtmlUrl(html_url + `?t=${Date.now()}`);
    if (isTestVariantPage) setHasDraft(true);
    addMessage({ role: 'assistant', content: 'Image updated! The preview has been refreshed.' });
  }

  async function handleReplaceVariant() {
    if (!pageId) return;
    setSavingVariant('replace');
    try {
      const res = await fetch(`/api/pages/${pageId}/replace-variant`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to replace the variant');
        return;
      }
      setReplaceConfirmOpen(false);
      toast.success('Live variant updated');
      router.push(backPath ?? `/clients/${clientId}/ai-pages`);
      router.refresh();
    } finally {
      setSavingVariant(null);
    }
  }

  function handleSaveAsNew() {
    setNewVariantForkName(`${variantName ?? 'Variant'} copy`);
    setSaveAsNewOpen(true);
  }

  async function handleConfirmSaveAsNew(e: React.FormEvent) {
    e.preventDefault();
    if (!pageId || !newVariantForkName.trim()) return;
    setSavingVariant('new');
    try {
      const res = await fetch(`/api/pages/${pageId}/save-as-new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newVariantForkName.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to save as a new variant');
        return;
      }
      setSaveAsNewOpen(false);
      toast.success('Added to the test as a new variant at 0% traffic');
      router.push(backPath ?? `/clients/${clientId}/ai-pages`);
      router.refresh();
    } finally {
      setSavingVariant(null);
    }
  }

  function openSaveAsTestModal() {
    setShowCreateSaveMenu(false);
    setNewTestName(pageName || 'New Test');
    setNewTestUrlPath('/');
    setSaveAsTestOpen(true);
  }

  async function handleConfirmSaveAsTest(e: React.FormEvent) {
    e.preventDefault();
    if (!pageId || !newTestName.trim() || !newTestUrlPath.trim()) return;
    setSavingAsTest(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/tests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newTestName.trim(),
          url_path: newTestUrlPath.trim(),
          variants: [{ name: 'Control', page_id: pageId, traffic_weight: 100, is_control: true }],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to create test');
        return;
      }
      const test = await res.json();
      toast.success('Test created');
      setSaveAsTestOpen(false);
      router.push(`/clients/${clientId}/tests/${test.id}`);
    } catch {
      toast.error('Unexpected error');
    } finally {
      setSavingAsTest(false);
    }
  }

  function nextSaveVariantName(test: { test_variants: { id: string }[] }) {
    const count = test.test_variants?.length ?? 0;
    return `Variant ${String.fromCharCode(65 + count)}`;
  }

  async function openSaveAsVariantModal() {
    setShowCreateSaveMenu(false);
    setSelectedSaveTestId('');
    setSaveVariantName('');
    setSaveAsVariantOpen(true);
    setLoadingWorkspaceTests(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/tests`);
      if (!res.ok) throw new Error();
      const tests = await res.json();
      setWorkspaceTestsForSave(tests);
      if (tests.length > 0) {
        setSelectedSaveTestId(tests[0].id);
        setSaveVariantName(nextSaveVariantName(tests[0]));
      }
    } catch {
      toast.error('Failed to load tests');
    } finally {
      setLoadingWorkspaceTests(false);
    }
  }

  function handleSelectSaveTest(testId: string) {
    setSelectedSaveTestId(testId);
    const test = workspaceTestsForSave.find((t) => t.id === testId);
    if (test) setSaveVariantName(nextSaveVariantName(test));
  }

  async function handleConfirmSaveAsVariant(e: React.FormEvent) {
    e.preventDefault();
    if (!pageId || !selectedSaveTestId || !saveVariantName.trim()) return;
    setSavingAsVariant(true);
    try {
      const res = await fetch(`/api/pages/${pageId}/save-as-variant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test_id: selectedSaveTestId, name: saveVariantName.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to add as a variant');
        return;
      }
      const { testId } = await res.json();
      toast.success('Added to the test as a new variant at 0% traffic');
      setSaveAsVariantOpen(false);
      router.push(`/clients/${clientId}/tests/${testId}`);
    } catch {
      toast.error('Unexpected error');
    } finally {
      setSavingAsVariant(false);
    }
  }

  async function handlePublish(id?: string) {
    const pid = id ?? pageId;
    if (!pid) return;
    setPhase('publishing');
    const res = await fetch(`/api/pages/${pid}/publish`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json();
      toast.error(err.error || 'Publish failed');
      setPhase('editing');
      return;
    }
    const { published_url } = await res.json();
    const wasAlreadyPublished = !!publishedUrl;
    setPublishedUrl(published_url);
    setPhase('editing');
    addMessage({
      role: 'assistant',
      content: wasAlreadyPublished
        ? 'Your changes are live.'
        : 'Your page is live! Copy the URL below and use it as a redirect variant in any test.',
    });
  }

  async function copyUrl() {
    if (!publishedUrl) return;
    await navigator.clipboard.writeText(publishedUrl);
    setUrlCopied(true);
    setTimeout(() => setUrlCopied(false), 2000);
  }

  const [isUnpublishing, setIsUnpublishing] = useState(false);

  const [showPageActions, setShowPageActions] = useState(false);
  const [showSaveMenu, setShowSaveMenu] = useState(false);

  async function handleUnpublish() {
    if (!pageId) return;
    setIsUnpublishing(true);
    const res = await fetch(`/api/pages/${pageId}/unpublish`, { method: 'POST' });
    setIsUnpublishing(false);
    if (!res.ok) {
      const err = await res.json();
      toast.error(err.error || 'Unpublish failed');
      return;
    }
    setPublishedUrl(null);
    addMessage({ role: 'assistant', content: 'Page unpublished. It will return a 404 until you publish again.' });
  }


  const isLoading = phase === 'generating' || phase === 'building' || phase === 'publishing' || uploadingImage;
  const showPreview = !!iframeSrc;

  return (
    <div className="fixed inset-0 z-20 flex bg-slate-50 dark:bg-slate-900 transition-[left] duration-200" style={{ left: 'var(--sl-sidebar-w, 15rem)' }}>
      <input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml" className="hidden" onChange={handleImageUpload} />

      {/* ── Left chat panel ── */}
      <div className="w-[380px] flex-shrink-0 flex flex-col bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800">

        {/* Panel header */}
        <div className="flex items-center gap-2 px-4 h-12 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
          <button
            onClick={() => { router.push(backPath ?? `/clients/${clientId}/pages`); router.refresh(); }}
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
          >
            <ChevronLeft size={14} />
            {clientName}
          </button>
          {variantName && (
            <>
              <span className="text-slate-300 dark:text-slate-700 text-xs">/</span>
              <span className="text-xs text-slate-500 dark:text-slate-400">{variantName}</span>
            </>
          )}
          <span className="text-slate-300 dark:text-slate-700 text-xs">/</span>
          <span className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
            <Sparkles size={12} className="text-indigo-600 dark:text-indigo-400" />
            AI Generate
          </span>
        </div>

        {/* Chat thread */}
        <div ref={threadRef} className="flex-1 overflow-y-auto px-4 py-5 space-y-5">

          {/* Welcome */}
          {phase === 'prompt' && messages.length === 0 && (
            <div className="text-center py-6">
              <div className="w-11 h-11 rounded-2xl bg-indigo-50 dark:bg-indigo-600/10 border border-indigo-100 dark:border-indigo-600/20 flex items-center justify-center mx-auto mb-3">
                <Wand2 size={20} className="text-indigo-600 dark:text-indigo-400" />
              </div>
              <p className="text-slate-700 dark:text-slate-200 font-medium text-sm mb-1">AI Page Builder</p>
              <p className="text-slate-400 dark:text-slate-500 text-xs leading-relaxed">Describe your landing page and I'll generate it.</p>
            </div>
          )}

          {/* Messages */}
          {messages.map((msg, i) => (
            <div key={i} className={cn('flex flex-col gap-1', msg.role === 'user' ? 'items-end' : 'items-start')}>
              {msg.role === 'user' ? (
                <div className="bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl rounded-tr-sm px-3.5 py-2.5 max-w-[88%]">
                  {msg.image_urls && msg.image_urls.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {msg.image_urls.map((url, idx) => (
                        <img key={idx} src={url} alt="" className="h-20 w-20 object-cover rounded-lg border border-white/10" />
                      ))}
                    </div>
                  )}
                  <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                </div>
              ) : (
                <div className="max-w-[92%] space-y-1.5">
                  <div className="flex items-start gap-2.5">
                    <div className="w-6 h-6 rounded-full bg-indigo-50 dark:bg-indigo-600/15 border border-indigo-100 dark:border-indigo-600/25 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Sparkles size={11} className="text-indigo-600 dark:text-indigo-400" />
                    </div>
                    <div className="flex-1">
                      {msg.isQuestions && msg.questions ? (
                        <div>
                          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-2">{msg.content}</p>
                          <ul className="space-y-1.5">
                            {msg.questions.map((q, qi) => (
                              <li key={qi} className="text-xs text-slate-500 dark:text-slate-400 flex gap-1.5">
                                <span className="text-indigo-600 dark:text-indigo-400 font-semibold flex-shrink-0">{qi + 1}.</span>
                                {q}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">{msg.content}</p>
                      )}
                    </div>
                  </div>
                  {/* Message actions */}
                  <div className="flex items-center gap-1.5 pl-8">
                    {typeof msg.elapsedMs === 'number' && (
                      <span className="text-[11px] text-amber-600 dark:text-amber-500">
                        {(msg.elapsedMs / 1000).toFixed(1)}s
                      </span>
                    )}
                    <button className="p-1 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400 transition-colors"><RotateCcw size={12} /></button>
                    {/* <button className="p-1 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400 transition-colors"><ThumbsUp size={12} /></button> */}
                    {/* <button className="p-1 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400 transition-colors"><ThumbsDown size={12} /></button> */}
                    <button
                      className="p-1 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400 transition-colors"
                      onClick={() => { navigator.clipboard.writeText(msg.content); toast.success('Copied'); }}
                    >
                      <Copy size={12} />
                    </button>
                    {/* <button className="p-1 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400 transition-colors"><MoreHorizontal size={12} /></button> */}
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Live follow-up progress panel — shown as assistant bubble while SSE streams */}
          {followUpEvents !== null && (
            <div className="flex items-start gap-2.5">
              <div className="w-6 h-6 rounded-full bg-indigo-50 dark:bg-indigo-600/15 border border-indigo-100 dark:border-indigo-600/25 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Sparkles size={11} className="text-indigo-600 dark:text-indigo-400" />
              </div>
              <div className="flex-1 pt-0.5">
                <LiveProgressPanel events={followUpEvents} />
              </div>
            </div>
          )}

          {/* Loading / build progress */}
          {isLoading && followUpEvents === null && (
            <div className="flex items-start gap-2.5">
              <div className="w-6 h-6 rounded-full bg-indigo-50 dark:bg-indigo-600/15 border border-indigo-100 dark:border-indigo-600/25 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Sparkles size={11} className="text-indigo-600 dark:text-indigo-400" />
              </div>
              <div className="flex-1 pt-0.5">
                {phase === 'building' ? (
                  <LiveProgressPanel events={buildEvents} />
                ) : (
                  <div className="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
                    <Loader2 size={11} className="animate-spin text-indigo-600 dark:text-indigo-400" />
                    {phase === 'publishing' ? 'Publishing…' : uploadingImage ? 'Uploading image…' : phase === 'generating' && /https?:\/\/[^\s]+/i.test(prompt) ? 'Fetching reference site…' : 'Thinking…'}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Background schema prep for raw-HTML pages — only shown before any real edit starts */}
          {preparingSchema && !isLoading && followUpEvents === null && (
            <div className="flex items-start gap-2.5">
              <div className="w-6 h-6 rounded-full bg-indigo-50 dark:bg-indigo-600/15 border border-indigo-100 dark:border-indigo-600/25 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Sparkles size={11} className="text-indigo-600 dark:text-indigo-400" />
              </div>
              <div className="flex-1 pt-0.5 space-y-2">
                {schemaEvents && schemaEvents.length > 0 ? (
                  <LiveProgressPanel events={schemaEvents} />
                ) : (
                  <div className="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
                    <Loader2 size={11} className="animate-spin text-indigo-600 dark:text-indigo-400" />
                    Preparing this page for editing…
                  </div>
                )}
                <p className="text-[11px] text-amber-600 dark:text-amber-400/80">
                  Please don&apos;t close this tab — we&apos;re working on your HTML.
                </p>
              </div>
            </div>
          )}

          {/* Prep failed — chat stays locked (see schemaPrepFailed gates below) until a retry succeeds */}
          {schemaPrepFailed && !isLoading && followUpEvents === null && (
            <div className="flex items-start gap-2.5">
              <div className="w-6 h-6 rounded-full bg-red-50 dark:bg-red-600/15 border border-red-100 dark:border-red-600/25 flex items-center justify-center flex-shrink-0 mt-0.5">
                <AlertTriangle size={11} className="text-red-600 dark:text-red-400" />
              </div>
              <div className="flex-1 pt-0.5 space-y-2">
                <p className="text-xs text-red-600 dark:text-red-400">
                  Couldn&apos;t prepare this page for editing.
                </p>
                <button
                  type="button"
                  onClick={() => runSchemaPrep()}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  <RefreshCw size={11} />
                  Try again
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Input area ── */}
        <div className="p-3 border-t border-slate-200 dark:border-slate-800 flex-shrink-0">
          <input
            ref={chatImageInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml"
            multiple
            className="hidden"
            onChange={handleChatImagePicker}
          />

          {/* Initial prompt form */}
          {phase === 'prompt' && (
            <form onSubmit={handleGenerate} className="space-y-2.5">
              <input
                type="text"
                value={pageName}
                onChange={e => setPageName(e.target.value)}
                className="input-base"
                placeholder="Page name (e.g. Summer Campaign)"
                required
              />
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-gray-500">Vertical:</span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-indigo-600/15 border border-indigo-600/30 text-indigo-600 dark:text-indigo-400">
                  {VERTICAL_LABELS[vertical] ?? vertical}
                </span>
              </div>
              <SamplePromptChip vertical={vertical} onUse={p => setPrompt(p)} />
              {/https?:\/\/[^\s]+/i.test(prompt) && (
                <div className="flex items-center gap-1.5 text-[11px] text-indigo-600 dark:text-indigo-400">
                  <Globe size={11} />
                  <span>We&apos;ll reference that site for inspiration</span>
                </div>
              )}
              <div
                onDragOver={handleChatImageDragOver}
                onDragLeave={handleChatImageDragLeave}
                onDrop={handleChatImageDrop}
                className={cn(
                  'bg-slate-50 dark:bg-slate-800 border rounded-2xl overflow-hidden focus-within:border-indigo-400 dark:focus-within:border-indigo-500 transition-colors',
                  isDraggingChatImage ? 'border-indigo-400 dark:border-indigo-500 ring-2 ring-indigo-400/30' : 'border-slate-200 dark:border-slate-700'
                )}
              >
                {chatImages.length > 0 && (
                  <div className="flex items-center gap-2 px-3.5 pt-2.5 flex-wrap">
                    {chatImages.map((img, i) => (
                      <div key={i} className="relative group w-14 h-14 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={img.preview} alt="" className="w-full h-full object-cover" />
                        <button
                          type="button"
                          onClick={() => removeChatImage(i)}
                          className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-xs font-bold"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  value={prompt}
                  onChange={e => {
                    setPrompt(e.target.value);
                    const el = e.target;
                    el.style.height = 'auto';
                    el.style.height = `${Math.min(el.scrollHeight, FOLLOW_UP_MAX_HEIGHT)}px`;
                  }}
                  className="w-full bg-transparent px-3.5 pt-3 pb-2 text-sm text-slate-700 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none resize-none overflow-y-auto"
                  style={{ maxHeight: FOLLOW_UP_MAX_HEIGHT }}
                  placeholder="Describe your landing page…"
                  rows={3}
                  required
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); }
                  }}
                  onPaste={handleChatImagePaste}
                />
                <div className="flex items-center justify-between px-3 pb-2.5">
                  <button
                    type="button"
                    disabled={chatImages.length >= 3}
                    onClick={() => chatImageInputRef.current?.click()}
                    className="text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Attach image (max 3)"
                  >
                    <Plus size={16} />
                  </button>
                  <span
                    className={cn(
                      'text-[11px] tabular-nums font-medium',
                      prompt.length > MAX_PROMPT_LENGTH
                        ? 'text-red-500'
                        : prompt.length >= MAX_PROMPT_LENGTH * 0.9
                        ? 'text-amber-500'
                        : 'text-slate-300 dark:text-slate-600'
                    )}
                  >
                    {MAX_PROMPT_LENGTH - prompt.length}
                  </span>
                  <button
                    type="submit"
                    disabled={!prompt.trim() || !pageName.trim() || prompt.length > MAX_PROMPT_LENGTH}
                    className="w-7 h-7 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed rounded-full flex items-center justify-center transition-colors"
                  >
                    <Send size={13} className="text-white" />
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Clarifying questions */}
          {phase === 'questions' && (
            <form onSubmit={handleAnswers} className="space-y-2.5">
              {questions.map((q, i) => (
                <div key={i}>
                  <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1 leading-relaxed">{q}</label>
                  <input
                    type="text"
                    value={answers[i]}
                    onChange={e => { const next = [...answers]; next[i] = e.target.value; setAnswers(next); }}
                    className="input-base"
                    placeholder="Your answer…"
                  />
                </div>
              ))}
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={handleSurpriseMe} className="flex-1 py-2 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 rounded-xl transition-colors">
                  Surprise me
                </button>
                <button type="submit" className="flex-1 py-2 text-xs btn-primary rounded-xl justify-center">
                  <Send size={11} /> Build page
                </button>
              </div>
            </form>
          )}

          {/* Follow-up / editing input */}
          {phase === 'editing' && (
            <form onSubmit={handleFollowUp}>
              <div
                onDragOver={handleChatImageDragOver}
                onDragLeave={handleChatImageDragLeave}
                onDrop={handleChatImageDrop}
                className={cn(
                  'bg-slate-50 dark:bg-slate-800 border rounded-2xl overflow-hidden focus-within:border-indigo-400 dark:focus-within:border-indigo-500 transition-colors',
                  isDraggingChatImage ? 'border-indigo-400 dark:border-indigo-500 ring-2 ring-indigo-400/30' : 'border-slate-200 dark:border-slate-700'
                )}
              >
                {/* Image thumbnails */}
                {chatImages.length > 0 && (
                  <div className="flex items-center gap-2 px-3.5 pt-2.5 flex-wrap">
                    {chatImages.map((img, i) => (
                      <div key={i} className="relative group w-14 h-14 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={img.preview} alt="" className="w-full h-full object-cover" />
                        <button
                          type="button"
                          onClick={() => removeChatImage(i)}
                          className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-xs font-bold"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  ref={followUpRef}
                  value={followUpInput}
                  onChange={e => {
                    setFollowUpInput(e.target.value);
                    const el = e.target;
                    el.style.height = 'auto';
                    el.style.height = `${Math.min(el.scrollHeight, FOLLOW_UP_MAX_HEIGHT)}px`;
                  }}
                  disabled={isLoading || preparingSchema || schemaPrepFailed}
                  className="w-full bg-transparent px-3.5 pt-3 pb-2 text-sm text-slate-700 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none resize-none disabled:opacity-40 overflow-y-auto"
                  style={{ maxHeight: FOLLOW_UP_MAX_HEIGHT }}
                  placeholder={schemaPrepFailed ? 'Preparation failed — try again above' : preparingSchema ? 'Preparing this page for editing…' : 'Ask Splitlab…'}
                  rows={2}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); }
                  }}
                  onPaste={handleChatImagePaste}
                />
                <div className="flex items-center justify-between px-3 pb-2.5">
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      disabled={isLoading || preparingSchema || schemaPrepFailed || chatImages.length >= 3}
                      onClick={() => chatImageInputRef.current?.click()}
                      className="p-1.5 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      title="Attach image (max 3)"
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="submit"
                      disabled={(!followUpInput.trim() && chatImages.length === 0) || isLoading || preparingSchema || schemaPrepFailed}
                      className="w-7 h-7 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed rounded-full flex items-center justify-center transition-colors"
                    >
                      <Send size={12} className="text-white" />
                    </button>
                  </div>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>

      {/* ── Right preview panel ── */}
      <div className="flex-1 flex flex-col bg-slate-100 dark:bg-slate-950 overflow-hidden">

        {/* Preview top bar */}
        <div className="flex items-center justify-between px-4 h-12 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex-shrink-0">
          {/* View mode toggle */}
          <div className="flex items-center gap-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg p-1 border border-slate-200 dark:border-slate-700">
            <button
              onClick={() => setViewMode('desktop')}
              className={cn('p-1.5 rounded-md transition-colors', viewMode === 'desktop' ? 'bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 shadow-sm' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300')}
            >
              <Monitor size={14} />
            </button>
            <button
              onClick={() => setViewMode('mobile')}
              className={cn('p-1.5 rounded-md transition-colors', viewMode === 'mobile' ? 'bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 shadow-sm' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300')}
            >
              <Smartphone size={14} />
            </button>
          </div>

          {/* Page name + refresh */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600 dark:text-slate-300 font-medium">{pageName || 'Homepage'}</span>
            {showPreview && (
              <button
                onClick={() => pageId && setIframeSrc(previewUrl(pageId))}
                title="Reload preview"
                aria-label="Reload preview"
                className="p-1 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
              >
                <RefreshCw size={13} />
              </button>
            )}
          </div>

          {/* Page actions */}
          <div className="flex items-center gap-2">
            {/* Always-visible AI credit meter (Unbounce-style) */}
            <AiCreditsMeter />
            {/* UTM Personalization button — links to dedicated picker page */}
            {phase === 'editing' && !!pageId && (
              <button
                onClick={() => router.push(`/clients/${clientId}/ai-pages/${pageId}/utm`)}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-medium border bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-400 hover:text-indigo-500 transition-colors"
              >
                <Sliders size={12} />
                UTM
              </button>
            )}
            {/* Back to Test + Replace/Save-as-New — pages already linked to a test */}
            {isTestVariantPage && showPreview && (
              <>
                {hasDraft && (
                  <span className="hidden sm:inline text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                    Unsaved draft — not live yet
                  </span>
                )}
                <button
                  onClick={() => { router.push(backPath ?? `/clients/${clientId}/ai-pages`); router.refresh(); }}
                  className="flex items-center gap-1.5 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600 px-3 py-1.5 rounded-full font-medium transition-colors"
                >
                  Back to Test
                </button>
                <div className="relative">
                  <button
                    onClick={() => setShowSaveMenu(v => !v)}
                    disabled={!hasDraft || savingVariant !== null}
                    title={!hasDraft ? 'Make an edit to enable Save' : undefined}
                    className="flex items-center gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-full font-medium transition-colors shadow-md shadow-emerald-600/20"
                  >
                    {savingVariant && <Loader2 size={12} className="animate-spin" />}
                    Save
                    <ChevronDown size={12} className={cn('transition-transform', showSaveMenu && 'rotate-180')} />
                  </button>
                  {showSaveMenu && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setShowSaveMenu(false)} />
                      <div className="absolute right-0 top-full mt-1 z-20 w-56 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-lg py-1 overflow-hidden">
                        <button
                          onClick={() => { setShowSaveMenu(false); setReplaceConfirmOpen(true); }}
                          className="w-full flex flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                        >
                          <span className="text-xs font-medium text-slate-700 dark:text-slate-200">Replace Current Variant</span>
                          <span className="text-[11px] text-slate-400 dark:text-slate-500">Overwrite what this test is serving live</span>
                        </button>
                        <button
                          onClick={() => { setShowSaveMenu(false); handleSaveAsNew(); }}
                          className="w-full flex flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                        >
                          <span className="text-xs font-medium text-slate-700 dark:text-slate-200">Save as New</span>
                          <span className="text-[11px] text-slate-400 dark:text-slate-500">Create a new variant on this test</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </>
            )}

            {/* Save as New Test / Save as a Variant — only for pages not yet linked to a test */}
            {!isTestVariantPage && showPreview && !!pageId && (
              <div className="relative">
                <button
                  onClick={() => setShowCreateSaveMenu(v => !v)}
                  disabled={isLoading}
                  className="flex items-center gap-1.5 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 rounded-full font-medium transition-colors"
                >
                  Save
                  <ChevronDown size={12} className={cn('transition-transform', showCreateSaveMenu && 'rotate-180')} />
                </button>
                {showCreateSaveMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setShowCreateSaveMenu(false)} />
                    <div className="absolute right-0 top-full mt-1 z-20 w-56 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-lg py-1 overflow-hidden">
                      <button
                        onClick={openSaveAsTestModal}
                        className="w-full flex flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                      >
                        <span className="text-xs font-medium text-slate-700 dark:text-slate-200">Save as a New Test</span>
                        <span className="text-[11px] text-slate-400 dark:text-slate-500">Create a new test with this page</span>
                      </button>
                      <button
                        onClick={openSaveAsVariantModal}
                        className="w-full flex flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                      >
                        <span className="text-xs font-medium text-slate-700 dark:text-slate-200">Save as a Variant</span>
                        <span className="text-[11px] text-slate-400 dark:text-slate-500">Add to an existing test at 0% traffic</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Primary publish/update button — independent of test-linkage.
                Publishing a standalone URL and serving as a test variant are
                separate concerns; only pages with no independent identity
                (raw HTML pasted into a test's "Add Variant" flow) have
                nothing meaningful to publish, so canPublish is false there. */}
            {canPublish && (
              <button
                onClick={() => setPublishConfirmOpen(true)}
                disabled={!showPreview || isLoading}
                className="flex items-center gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-full font-medium transition-colors shadow-md shadow-indigo-600/20"
              >
                {phase === 'publishing' ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
                {publishedUrl ? 'Update' : 'Publish'}
              </button>
            )}

            {/* More actions dropdown */}
            {showPreview && (
              <div className="relative">
                <button
                  onClick={() => setShowPageActions(v => !v)}
                  className="p-1.5 rounded-md text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  title="More actions"
                >
                  <MoreHorizontal size={15} />
                </button>
                {showPageActions && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setShowPageActions(false)} />
                    <div className="absolute right-0 top-full mt-1 z-20 w-44 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-lg py-1 overflow-hidden">
                      {slug && canPublish && (
                        <a
                          href={phase === 'publishing' || isUnpublishing ? undefined : `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com'}/pages/${slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => setShowPageActions(false)}
                          className="flex items-center gap-2 px-3 py-2 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                        >
                          <ExternalLink size={13} /> Visit page
                        </a>
                      )}
                      {publishedUrl && (
                        <button
                          onClick={() => { copyUrl(); setShowPageActions(false); }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                        >
                          {urlCopied ? <Check size={13} /> : <Copy size={13} />}
                          {urlCopied ? 'Copied!' : 'Copy URL'}
                        </button>
                      )}
                      {iframeSrc && (
                        <a
                          href={iframeSrc}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => setShowPageActions(false)}
                          className="flex items-center gap-2 px-3 py-2 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                        >
                          <ExternalLink size={13} /> Preview URL
                        </a>
                      )}
                      <button
                        onClick={() => {
                          const html = getCleanHtml();
                          if (!html) { toast.error('Preview not ready'); return; }
                          const blob = new Blob([html], { type: 'text/html' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `${pageName || 'page'}.html`;
                          a.click();
                          URL.revokeObjectURL(url);
                          setShowPageActions(false);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                      >
                        <Download size={13} /> Download HTML
                      </button>
                      {publishedUrl && (
                        <button
                          onClick={() => { handleUnpublish(); setShowPageActions(false); }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                        >
                          <Globe size={13} /> Unpublish
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Preview content */}
        <div ref={previewWrapRef} className={cn('flex items-start justify-center overflow-auto p-5', 'flex-1')}>
          {showPreview && iframeSrc ? (
            <div className={cn(
              'relative bg-white rounded-xl overflow-hidden shadow-xl ring-1 ring-black/5 dark:ring-white/5 transition-all duration-300 h-full',
              viewMode === 'mobile' ? 'w-[390px]' : 'w-full'
            )}>
              {viewMode === 'desktop' && desktopScale < 1 ? (
                <iframe
                  ref={iframeRef}
                  src={iframeSrc}
                  className="transition-opacity duration-500"
                  style={{
                    width: `${DESKTOP_PREVIEW_WIDTH}px`,
                    height: `${previewSize.height / desktopScale}px`,
                    transform: `scale(${desktopScale})`,
                    transformOrigin: 'top left',
                    border: 0,
                    opacity: iframeLoaded ? 1 : 0,
                  }}
                  title="Page preview"
                  sandbox="allow-scripts allow-same-origin allow-forms"
                  onLoad={() => setIframeLoaded(true)}
                />
              ) : (
                <iframe
                  ref={iframeRef}
                  src={iframeSrc}
                  className="w-full h-full border-0 transition-opacity duration-500"
                  style={{ opacity: iframeLoaded ? 1 : 0 }}
                  title="Page preview"
                  sandbox="allow-scripts allow-same-origin allow-forms"
                  onLoad={() => setIframeLoaded(true)}
                />
              )}
              {!iframeLoaded && (
                <div className="absolute inset-0 bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                  <Loader2 size={20} className="animate-spin text-slate-400" />
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center">
              {phase === 'building' ? (
                <div className="space-y-3">
                  <div className="w-14 h-14 rounded-2xl bg-indigo-50 dark:bg-indigo-600/10 border border-indigo-100 dark:border-indigo-600/20 flex items-center justify-center mx-auto">
                    <Layout size={22} className="text-indigo-600 dark:text-indigo-400 animate-pulse" />
                  </div>
                  <p className="text-slate-600 dark:text-slate-300 font-medium text-sm">Building your page…</p>
                  <p className="text-slate-400 dark:text-slate-500 text-xs">This may take a moment…</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="w-14 h-14 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center mx-auto shadow-sm">
                    <Palette size={22} className="text-slate-300 dark:text-slate-600" />
                  </div>
                  <p className="text-slate-400 dark:text-slate-500 font-medium text-sm">Preview will appear here</p>
                  <p className="text-slate-300 dark:text-slate-600 text-xs">Describe your page to get started</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Publish confirm dialog */}
      {publishConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPublishConfirmOpen(false)}>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="mb-5">
              <h3 className="text-slate-900 dark:text-slate-100 font-semibold text-base">{publishedUrl ? 'Republish' : 'Publish'}</h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">Your website URL</p>
            <div className="flex items-center justify-between bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 mb-5">
              <span className="text-sm font-mono text-slate-500 dark:text-slate-400 truncate">
                {(process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com').replace(/^https?:\/\//, '')}/pages/{slug ?? '…'}
              </span>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPublishConfirmOpen(false)} className="btn-secondary text-sm rounded-xl">Cancel</button>
              <button
                onClick={() => { setPublishConfirmOpen(false); handlePublish(); }}
                className="btn-primary text-sm rounded-xl"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {replaceConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => !savingVariant && setReplaceConfirmOpen(false)}>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="mb-3">
              <h3 className="text-slate-900 dark:text-slate-100 font-semibold text-base">Replace the live variant?</h3>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-5">
              This overwrites the HTML this test is currently serving to visitors with your draft. UTM field mappings and personalization rules for this page will be cleared.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setReplaceConfirmOpen(false)} disabled={!!savingVariant} className="btn-secondary text-sm rounded-xl">
                No, keep as draft
              </button>
              <button
                onClick={handleReplaceVariant}
                disabled={!!savingVariant}
                className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-sm px-4 py-2 rounded-xl font-medium transition-colors"
              >
                {savingVariant === 'replace' && <Loader2 size={13} className="animate-spin" />}
                Yes, replace it
              </button>
            </div>
          </div>
        </div>
      )}

      {saveAsNewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => !savingVariant && setSaveAsNewOpen(false)}>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="mb-3">
              <h3 className="text-slate-900 dark:text-slate-100 font-semibold text-base">Save as a new variant</h3>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
              This forks your draft into a new variant on this test at 0% traffic — the live variant and everyone else's traffic split stay untouched.
            </p>
            <form onSubmit={handleConfirmSaveAsNew}>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Variant Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={newVariantForkName}
                onChange={(e) => setNewVariantForkName(e.target.value)}
                className="input-base w-full"
                required
                autoFocus
              />
              <div className="flex justify-end gap-2 mt-5">
                <button type="button" onClick={() => setSaveAsNewOpen(false)} disabled={!!savingVariant} className="btn-secondary text-sm rounded-xl">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!!savingVariant || !newVariantForkName.trim()}
                  className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-xl font-medium transition-colors"
                >
                  {savingVariant === 'new' && <Loader2 size={13} className="animate-spin" />}
                  Save as New
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {outOfCredits && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => !ocSaving && setOutOfCredits(null)}>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2.5 mb-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-amber-100 dark:bg-amber-500/15 flex items-center justify-center">
                <Sparkles size={15} className="text-amber-600 dark:text-amber-400" />
              </div>
              <h3 className="text-slate-900 dark:text-slate-100 font-semibold text-base">You&apos;re out of AI credits</h3>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
              You&apos;ve used {outOfCredits.creditsUsed.toLocaleString()} of {outOfCredits.creditsIncluded.toLocaleString()} credits this month. Add more credits to keep building, or wait for your credits to reset when your plan renews next month.
            </p>

            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Add credits</label>
            <select value={ocAmountCents} onChange={(e) => setOcAmountCents(Number(e.target.value))} className="input-base w-full">
              {TOPUP_OPTIONS.map((o) => (
                <option key={o.cents} value={o.cents}>{o.label}</option>
              ))}
            </select>

            <button
              type="button"
              onClick={buyCredits}
              disabled={ocBuying || ocSaving}
              className="mt-3 w-full flex items-center justify-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm px-4 py-2.5 rounded-xl font-medium transition-colors"
            >
              {ocBuying && <Loader2 size={14} className="animate-spin" />}
              Add credits
            </button>

            <p className="text-center text-xs text-slate-500 dark:text-slate-400 mt-3">
              Prefer to pay only for what you use?{' '}
              <button
                type="button"
                onClick={enableOverageAndRetry}
                disabled={ocSaving || ocBuying}
                className="text-indigo-600 dark:text-indigo-400 hover:underline font-medium disabled:opacity-60"
              >
                {ocSaving ? 'Turning on…' : 'Turn on auto-billing'}
              </button>
            </p>

            <div className="flex justify-between items-center gap-2 mt-5 pt-4 border-t border-slate-100 dark:border-slate-800">
              <a href="/billing" className="text-xs text-slate-500 dark:text-slate-400 hover:text-indigo-500 underline">Or upgrade your plan</a>
              <button type="button" onClick={() => setOutOfCredits(null)} disabled={ocBuying || ocSaving} className="btn-secondary text-sm rounded-xl">Not now</button>
            </div>
          </div>
        </div>
      )}

      {saveAsTestOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => !savingAsTest && setSaveAsTestOpen(false)}>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="mb-3">
              <h3 className="text-slate-900 dark:text-slate-100 font-semibold text-base">Save as a New Test</h3>
            </div>
            <form onSubmit={handleConfirmSaveAsTest}>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Test Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={newTestName}
                onChange={(e) => setNewTestName(e.target.value)}
                className="input-base w-full mb-3"
                required
                autoFocus
              />
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                URL Path <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={newTestUrlPath}
                onChange={(e) => setNewTestUrlPath(e.target.value)}
                placeholder="/"
                className="input-base w-full"
                required
              />
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">
                This page will become the control variant at 100% traffic.
              </p>
              <div className="flex justify-end gap-2 mt-5">
                <button type="button" onClick={() => setSaveAsTestOpen(false)} disabled={savingAsTest} className="btn-secondary text-sm rounded-xl">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingAsTest || !newTestName.trim() || !newTestUrlPath.trim()}
                  className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-xl font-medium transition-colors"
                >
                  {savingAsTest && <Loader2 size={13} className="animate-spin" />}
                  Create Test
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {saveAsVariantOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => !savingAsVariant && setSaveAsVariantOpen(false)}>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="mb-3">
              <h3 className="text-slate-900 dark:text-slate-100 font-semibold text-base">Save as a Variant</h3>
            </div>
            {loadingWorkspaceTests ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 size={20} className="animate-spin text-slate-400" />
              </div>
            ) : workspaceTestsForSave.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No tests in this workspace yet. Create one first, or use &quot;Save as a New Test&quot; instead.
              </p>
            ) : (
              <form onSubmit={handleConfirmSaveAsVariant}>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Test</label>
                <select
                  value={selectedSaveTestId}
                  onChange={(e) => handleSelectSaveTest(e.target.value)}
                  className="input-base w-full mb-3"
                >
                  {workspaceTestsForSave.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Variant Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={saveVariantName}
                  onChange={(e) => setSaveVariantName(e.target.value)}
                  className="input-base w-full"
                  required
                />
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">
                  Added at 0% traffic — existing variants and traffic split stay untouched.
                </p>
                <div className="flex justify-end gap-2 mt-5">
                  <button type="button" onClick={() => setSaveAsVariantOpen(false)} disabled={savingAsVariant} className="btn-secondary text-sm rounded-xl">
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingAsVariant || !saveVariantName.trim()}
                    className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-xl font-medium transition-colors"
                  >
                    {savingAsVariant && <Loader2 size={13} className="animate-spin" />}
                    Add as Variant
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
