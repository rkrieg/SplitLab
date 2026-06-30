'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Sparkles, Send, Globe, Copy, Check, ChevronLeft, Loader2,
  Wand2, Layout, Palette, RefreshCw, Monitor, Smartphone,
  ExternalLink, RotateCcw, Plus, Download,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { cn } from '@/lib/utils';
import { VERTICAL_LABELS } from '@/lib/ai-page-verticals';
import { SAMPLE_PROMPTS } from '@/lib/ai-page-sample-prompts';

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
}

const BUILD_STEPS = [
  'Analyzing prompt',
  'Building structure',
  'Writing content',
  'Styling layout',
  'Saving page',
];

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

export default function AIBuilderClient({ workspaceId, clientId, clientName, initialPage, backPath }: Props) {
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>('prompt');
  const [pageName, setPageName] = useState('');
  const [vertical, setVertical] = useState<string>('lead_gen');
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [followUpInput, setFollowUpInput] = useState('');
  const [buildStep, setBuildStep] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>('desktop');

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
  const [competitorContext, setCompetitorContext] = useState<string | null>(null);

  const schemaRef = useRef<unknown>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const followUpRef = useRef<HTMLTextAreaElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Restore state from pre-created page
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
    setIframeSrc(`/api/pages/${pageId}/preview?t=${Date.now()}`);
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

  function animateBuildSteps() {
    let step = 0;
    setBuildStep(0);
    const interval = setInterval(() => {
      step++;
      if (step >= BUILD_STEPS.length) clearInterval(interval);
      else setBuildStep(step);
    }, 900);
    return () => clearInterval(interval);
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

    if (data.competitor_fetch_failed) {
      toast("Couldn't access that site — building from your description instead. Try attaching a screenshot for better results.", { icon: '⚠️' });
    } else if (data.competitor_context) {
      setCompetitorContext(data.competitor_context);
    }

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
    await runBuild(data.schema, updatedHistory, data.competitor_context ?? null);
  }

  async function runBuild(schema: unknown, history: { role: string; content: string; image_urls?: string[] }[], passedCompetitorContext?: string | null) {
    if (!pageId) return;
    setPhase('building');
    const cleanup = animateBuildSteps();

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
        // Replace blob preview URLs with real URLs in the chat message, then revoke blobs
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
        cleanup();
        toast.error(err instanceof Error ? err.message : 'Image upload failed');
        setPhase('prompt');
        return;
      }
    }

    // Step 2: build HTML (pass image URLs so Claude embeds them directly)
    const res = await fetch('/api/pages/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema_json: schema,
        user_prompt: prompt,
        workspace_id: workspaceId,
        ...(image_urls.length > 0 ? { image_urls } : {}),
        ...(passedCompetitorContext ? { competitor_context: passedCompetitorContext } : {}),
      }),
    });
    cleanup();
    setBuildStep(BUILD_STEPS.length - 1);
    if (!res.ok) {
      const err = await res.json();
      toast.error(err.error || 'Build failed');
      setPhase('prompt');
      return;
    }
    const { html_url, slug } = await res.json();

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
        slug,
        html_url,
        schema_json: schema,
        conversation_json: historyWithImages,
      }),
    });
    if (!patchRes.ok) {
      toast('Page built but metadata not saved — edits may not persist.', { icon: '⚠️' });
    }

    // Now update state — triggers iframe load after DB is updated
    setHtmlUrl(html_url);
    setSlug(slug);
    schemaRef.current = schema;
    setSchemaJson(schema);
    setPhase('editing');
    addMessage({ role: 'assistant', content: 'Your page is ready! Click any text in the preview to edit it, or ask me to make changes.' });
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim() || !pageName.trim()) return;
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
      const err = await res.json();
      toast.error(err.error || 'Edit failed');
      setPhase('editing');
      return;
    }
    const data = await res.json();
    if (data.competitor_fetch_failed) {
      toast("Couldn't access that site — applying changes from your description instead. Try attaching a screenshot for better results.", { icon: '⚠️' });
    }
    if (data.schema_json) { schemaRef.current = data.schema_json; setSchemaJson(data.schema_json); }
    setHtmlUrl(data.html_url + `?t=${Date.now()}`);
    if (!silent) {
      addMessage({ role: 'assistant', content: 'Done! The page has been updated.' });
    }
    setConversationJson(prev => [
      ...prev,
      { role: 'user', content: instruction },
      { role: 'assistant', content: JSON.stringify(data) },
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
    <div className="fixed inset-0 z-20 flex bg-slate-50 dark:bg-slate-900" style={{ left: '15rem' }}>
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

          {/* Loading / build progress */}
          {isLoading && (
            <div className="flex items-start gap-2.5">
              <div className="w-6 h-6 rounded-full bg-indigo-50 dark:bg-indigo-600/15 border border-indigo-100 dark:border-indigo-600/25 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Sparkles size={11} className="text-indigo-600 dark:text-indigo-400" />
              </div>
              <div className="flex-1 pt-0.5">
                {phase === 'building' ? (
                  <div className="space-y-2">
                    {BUILD_STEPS.map((step, i) => (
                      <div key={i} className={cn('flex items-center gap-2 text-xs transition-all', i <= buildStep ? 'text-slate-700 dark:text-slate-200' : 'text-slate-300 dark:text-slate-600')}>
                        {i < buildStep ? (
                          <Check size={11} className="text-green-500 flex-shrink-0" />
                        ) : i === buildStep ? (
                          <Loader2 size={11} className="animate-spin text-indigo-600 dark:text-indigo-400 flex-shrink-0" />
                        ) : (
                          <div className="w-[11px] h-[11px] rounded-full border border-slate-300 dark:border-slate-600 flex-shrink-0" />
                        )}
                        {step}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
                    <Loader2 size={11} className="animate-spin text-indigo-600 dark:text-indigo-400" />
                    {phase === 'publishing' ? 'Publishing…' : uploadingImage ? 'Uploading image…' : 'Thinking…'}
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
                  onChange={e => setPrompt(e.target.value)}
                  className="w-full bg-transparent px-3.5 pt-3 pb-2 text-sm text-slate-700 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none resize-none"
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
                  <button
                    type="submit"
                    disabled={!prompt.trim() || !pageName.trim()}
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
                  onChange={e => setFollowUpInput(e.target.value)}
                  disabled={isLoading}
                  className="w-full bg-transparent px-3.5 pt-3 pb-2 text-sm text-slate-700 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none resize-none disabled:opacity-40"
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

          {/* External link + download + publish */}
          <div className="flex items-center gap-2">
            {showPreview && iframeSrc && (
              <a
                href={iframeSrc}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500 hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors font-mono"
                title="Open preview"
              >
                <span>Preview URL</span>
                <ExternalLink size={13} className="shrink-0" />
              </a>
            )}
            {showPreview && (
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
                }}
                className="p-1.5 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                title="Download HTML"
              >
                <Download size={14} />
              </button>
            )}
            {slug && (
              <a
                href={phase === 'publishing' || isUnpublishing ? undefined : `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com'}/pages/${slug}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-disabled={phase === 'publishing' || isUnpublishing}
                className={cn(
                  'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-medium transition-colors text-white',
                  phase === 'publishing' || isUnpublishing
                    ? 'bg-slate-700 opacity-40 cursor-not-allowed pointer-events-none'
                    : 'bg-slate-700 hover:bg-slate-600'
                )}
              >
                <ExternalLink size={12} />
                Visit
              </a>
            )}
            {publishedUrl && (
              <>
                <button
                  onClick={copyUrl}
                  className="flex items-center gap-1.5 text-xs bg-green-600 hover:bg-green-500 text-white px-3 py-1.5 rounded-full font-medium transition-colors"
                >
                  {urlCopied ? <Check size={12} /> : <Copy size={12} />}
                  {urlCopied ? 'Copied!' : 'Copy URL'}
                </button>
                <button
                  onClick={handleUnpublish}
                  className="flex items-center gap-1.5 text-xs bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded-full font-medium transition-colors"
                >
                  Unpublish
                </button>
              </>
            )}
            <button
              onClick={() => setPublishConfirmOpen(true)}
              disabled={!showPreview || isLoading}
              className="flex items-center gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-full font-medium transition-colors shadow-md shadow-indigo-600/20"
            >
              {phase === 'publishing' ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
              {publishedUrl ? 'Update' : 'Publish'}
            </button>
          </div>
        </div>

        {/* Preview content */}
        <div className="flex-1 flex items-start justify-center overflow-auto p-5">
          {showPreview && iframeSrc ? (
            <div className={cn(
              'relative bg-white rounded-xl overflow-hidden shadow-xl ring-1 ring-black/5 dark:ring-white/5 transition-all duration-300 h-full',
              viewMode === 'mobile' ? 'w-[390px]' : 'w-full'
            )}>
              <iframe
                ref={iframeRef}
                src={iframeSrc}
                className="w-full h-full border-0 transition-opacity duration-500"
                style={{ opacity: iframeLoaded ? 1 : 0 }}
                title="Page preview"
                sandbox="allow-scripts allow-same-origin allow-forms"
                onLoad={() => setIframeLoaded(true)}
              />
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
