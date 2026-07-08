'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Sparkles, Send, Globe, Copy, Check, ChevronLeft, Loader2,
  Wand2, Layout, Palette, RefreshCw, Monitor, Smartphone,
  ExternalLink, RotateCcw, Plus, Download, Lock, ArrowRight,
  Sliders, Trash2, AlertTriangle, MoreHorizontal, MousePointer2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { cn } from '@/lib/utils';
import { useSidebarCollapsed } from '@/lib/use-sidebar-collapsed';
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
}

interface Props {
  workspaceId: string;
  clientId: string;
  clientName: string;
  initialPage?: InitialPage | null;
  backPath?: string;
  canUseAI?: boolean;
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
      ? <strong key={i} className="text-indigo-400 font-semibold not-italic">{part}</strong>
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
        className="inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
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
              {/* <span className="text-[10px] text-indigo-400">Click to use</span> */}
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

export default function AIBuilderClient({ workspaceId, clientId, clientName, initialPage, backPath, canUseAI = true }: Props) {
  const router = useRouter();
  const sidebarCollapsed = useSidebarCollapsed();

  if (!canUseAI) {
    return (
      <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-50 dark:bg-slate-900 transition-[left] duration-200" style={{ left: sidebarCollapsed ? '4rem' : '15rem' }}>
        <div className="flex flex-col items-center text-center max-w-md px-6">
          <div className="w-16 h-16 rounded-2xl bg-indigo-50 dark:bg-indigo-600/10 border border-indigo-100 dark:border-indigo-600/20 flex items-center justify-center mb-5">
            <Lock size={26} className="text-indigo-500 dark:text-indigo-400" />
          </div>
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
            AI Page Builder is not available on your plan
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed mb-2">
            AI website generation is available on the <strong className="text-slate-700 dark:text-slate-300">Agency</strong> and <strong className="text-slate-700 dark:text-slate-300">Scale</strong> plans.
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
            onClick={() => router.push(backPath ?? `/clients/${clientId}/pages`)}
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

  // Chat image attachments (paste / file-picker)
  const [chatImages, setChatImages] = useState<{ file: File; preview: string }[]>([]);
  const chatImageInputRef = useRef<HTMLInputElement>(null);

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
  // Editing wipes UTM mappings/rules server-side — warn once when edit mode starts,
  // in a toast the user can dismiss (stays up until they do)
  useEffect(() => {
    if (phase !== 'editing') return;
    toast(
      t => (
        <div className="flex items-start gap-2">
          <span className="text-xs">
            <strong>Editing this page clears its UTM field mappings and personalization rules.</strong>{' '}
            After any chat or on-page edit you will need to re-map elements and re-create rules in UTM Personalization.
          </span>
          <button
            onClick={() => toast.dismiss(t.id)}
            className="flex-shrink-0 text-amber-700/60 hover:text-amber-800 font-bold"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      ),
      {
        id: 'utm-wipe-warning',
        icon: '⚠️',
        duration: Infinity,
        style: { background: 'rgb(254 243 199)', color: 'rgb(146 64 14)', maxWidth: '420px' },
      }
    );
    return () => toast.dismiss('utm-wipe-warning');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (!initialPage) return;
    setPageId(initialPage.id);
    setPageName(initialPage.name);
    setVertical(initialPage.vertical);

    // Fresh page (just created from modal) — no HTML yet, stay in prompt phase
    if (!initialPage.html_url) return;

    setSchemaJson(initialPage.schema_json);
    schemaRef.current = initialPage.schema_json;
    const history = initialPage.conversation_json ?? [];
    setConversationJson(history);
    setHtmlUrl(initialPage.html_url);
    setSlug(initialPage.slug);
    if (initialPage.is_published && initialPage.published_url) {
      setPublishedUrl(initialPage.published_url);
    }
    setPhase('editing');

    const restored: Message[] = [];
    for (let i = 0; i < history.length; i += 2) {
      const userMsg = history[i];
      const assistantMsg = history[i + 1];
      if (!userMsg) break;
      const userEntry: Message = { role: 'user', content: userMsg.content };
      if (Array.isArray(userMsg.image_urls) && userMsg.image_urls.length > 0) userEntry.image_urls = userMsg.image_urls;
      restored.push(userEntry);
      if (assistantMsg) {
        const isFirst = i === 0;
        restored.push({
          role: 'assistant',
          content: isFirst
            ? `Got it! Built your ${VERTICAL_LABELS[initialPage.vertical] ?? initialPage.vertical} page.`
            : 'Done! The page has been updated.',
        });
      }
    }
    restored.push({ role: 'assistant', content: 'Welcome back. Click any text in the preview to edit, or ask me to make changes.' });
    setMessages(restored);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable iframe src — points to preview route, refreshes when htmlUrl is available/changes
  useEffect(() => {
    if (!pageId || !htmlUrl) return;
    const src = `/api/pages/${pageId}/preview?t=${Date.now()}`;
    setIframeSrc(src);
    setIframeLoaded(false);
  }, [pageId, htmlUrl]);

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
          body: JSON.stringify({ schema_json: updated, html_content: html }),
        });
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
    const history = [
      { role: 'user', content: prompt },
      { role: 'assistant', content: JSON.stringify({ type: 'questions', questions }) },
      { role: 'user', content: answersText },
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
      toast.error(err.error || 'Edit failed');
      setFollowUpEvents(null);
      setPhase('editing');
      return;
    }

    type FollowUpDone = { html_url: string; schema_json?: unknown; competitor_fetch_failed?: boolean };
    let doneData: FollowUpDone | null = null;
    let followUpError = false;

    await readSSEStream(res, (event) => {
      setFollowUpEvents(prev => prev ? [...prev, event] : [event]);
      if (event.type === 'done') {
        doneData = {
          html_url: event.html_url,
          schema_json: event.schema_json,
          competitor_fetch_failed: event.competitor_fetch_failed,
        };
      } else if (event.type === 'error') {
        followUpError = true;
        toast.error(event.message || 'Edit failed');
      }
    });

    setFollowUpEvents(null);

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
    if (!silent) {
      addMessage({ role: 'assistant', content: 'Done! The page has been updated.' });
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
    if ((!followUpInput.trim() && chatImages.length === 0) || !pageId) return;
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
    addMessage({ role: 'assistant', content: 'Image updated! The preview has been refreshed.' });
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
    <div className="fixed inset-0 z-20 flex bg-slate-50 dark:bg-slate-900 transition-[left] duration-200" style={{ left: sidebarCollapsed ? '4rem' : '15rem' }}>
      <input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml" className="hidden" onChange={handleImageUpload} />

      {/* ── Left chat panel ── */}
      <div className="w-[380px] flex-shrink-0 flex flex-col bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800">

        {/* Panel header */}
        <div className="flex items-center gap-2 px-4 h-12 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
          <button
            onClick={() => router.push(backPath ?? `/clients/${clientId}/pages`)}
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
          >
            <ChevronLeft size={14} />
            {clientName}
          </button>
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
                  <div className="flex items-center gap-0.5 pl-8">
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
                <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-indigo-600/15 border border-indigo-600/30 text-indigo-400">
                  {VERTICAL_LABELS[vertical] ?? vertical}
                </span>
              </div>
              <SamplePromptChip vertical={vertical} onUse={p => setPrompt(p)} />
              {/https?:\/\/[^\s]+/i.test(prompt) && (
                <div className="flex items-center gap-1.5 text-[11px] text-indigo-400">
                  <Globe size={11} />
                  <span>We&apos;ll reference that site for inspiration</span>
                </div>
              )}
              <div className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden focus-within:border-indigo-400 dark:focus-within:border-indigo-500 transition-colors">
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
              <div className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden focus-within:border-indigo-400 dark:focus-within:border-indigo-500 transition-colors">
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
                  disabled={isLoading}
                  className="w-full bg-transparent px-3.5 pt-3 pb-2 text-sm text-slate-700 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none resize-none disabled:opacity-40 overflow-y-auto"
                  style={{ maxHeight: FOLLOW_UP_MAX_HEIGHT }}
                  placeholder="Ask Splitlab…"
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
                      disabled={isLoading || chatImages.length >= 3}
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
                      disabled={(!followUpInput.trim() && chatImages.length === 0) || isLoading}
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
                onClick={() => pageId && setIframeSrc(`/api/pages/${pageId}/preview?t=${Date.now()}`)}
                className="p-1 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
              >
                <RefreshCw size={13} />
              </button>
            )}
          </div>

          {/* Page actions */}
          <div className="flex items-center gap-2">
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
            {/* Primary publish/update button */}
            <button
              onClick={() => setPublishConfirmOpen(true)}
              disabled={!showPreview || isLoading}
              className="flex items-center gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-full font-medium transition-colors shadow-md shadow-indigo-600/20"
            >
              {phase === 'publishing' ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
              {publishedUrl ? 'Update' : 'Publish'}
            </button>

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
                      {slug && (
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
    </div>
  );
}
