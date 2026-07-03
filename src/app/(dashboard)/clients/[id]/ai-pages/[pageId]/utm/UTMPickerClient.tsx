'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft, Plus, Trash2, Check, Loader2, Sparkles,
  ExternalLink, AlertTriangle, MousePointer2, X, Image as ImageIcon, Type,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { cn } from '@/lib/utils';
import type { UTMRule, FieldMapping } from './page';

export type StoredFieldSelectors = Record<string, { selector: string; type: 'text' | 'image'; label: string }>;

// Internal field state — extends FieldMapping with HTML injection metadata
interface Field extends FieldMapping {
  _indexPath?: string;    // HTML pages: index path for server-side ID injection
  _generatedId?: string;  // HTML pages: the sl-f-xxx ID already set in live DOM
}

interface PageInfo {
  id: string;
  name: string;
  slug: string | null;
  isAiPage: boolean;
  fieldSelectors: StoredFieldSelectors;
  isPublished: boolean;
  publishedUrl: string | null;
}

interface Props {
  clientId: string;
  page: PageInfo;
  initialRules: UTMRule[];
  appUrl: string;
}

const UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

// Default fields for AI pages — pre-seeded with data-field selectors
const AI_DEFAULT_FIELDS: Field[] = [
  { key: 'headline',   label: 'Headline',   selector: '[data-field="hero.headline"]',        type: 'text'  },
  { key: 'subhead',    label: 'Subhead',    selector: '[data-field="hero.subhead"]',          type: 'text'  },
  { key: 'cta_text',   label: 'CTA Text',   selector: '[data-field="hero.cta_text"]',         type: 'text'  },
  { key: 'hero_image', label: 'Hero Image', selector: '[data-field="hero.background_image"]', type: 'image' },
];

const AI_DEFAULT_KEYS = new Set(AI_DEFAULT_FIELDS.map(f => f.key));

function labelToKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'field';
}

/** Picker script for AI pages — uses data-field attribute if present, else CSS selector */
function buildAiPickerScript(activeField: string): string {
  return `
(function(){
  if(window.__slPickerActive) return;
  window.__slPickerActive = true;
  var activeField = ${JSON.stringify(activeField)};
  var highlighted = null;

  function highlight(el) {
    if(highlighted && highlighted !== el) highlighted.style.outline = '';
    highlighted = el;
    if(el) el.style.outline = '2px solid #3D8BDA';
  }

  document.addEventListener('mouseover', function(e) {
    var el = e.target;
    if(el === document.body || el === document.documentElement) return;
    highlight(el);
  }, true);

  document.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    while(el && el !== document.body) {
      var tag = el.tagName;
      if(['H1','H2','H3','H4','H5','H6','P','A','BUTTON','SPAN','LI','DIV','IMG'].indexOf(tag) !== -1) break;
      el = el.parentElement;
    }
    if(!el || el === document.body) return;

    var isImg = el.tagName === 'IMG';
    var dataField = el.getAttribute('data-field');
    var selector = dataField
      ? '[data-field="' + dataField + '"]'
      : generateSelector(el);

    var preview = isImg
      ? (el.alt || el.src || 'image element')
      : (el.textContent ? el.textContent.trim().slice(0, 100) : '');

    window.parent.postMessage({
      type: 'sl-element-picked',
      field: activeField,
      selector: selector,
      preview: preview,
      elementType: isImg ? 'image' : 'text',
    }, '*');
  }, true);

  function generateSelector(el) {
    if(el.id) return '#' + el.id;
    var parts = [];
    var cur = el;
    for(var i = 0; i < 4 && cur && cur !== document.body; i++) {
      var part = cur.tagName.toLowerCase();
      if(cur.id) { parts.unshift('#' + cur.id); break; }
      var cls = Array.from(cur.classList).filter(function(c){ return /^[a-z]/i.test(c); }).slice(0,2).join('.');
      if(cls) part += '.' + cls;
      var siblings = cur.parentElement ? Array.from(cur.parentElement.children).filter(function(s){ return s.tagName === cur.tagName; }) : [];
      if(siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
      parts.unshift(part);
      cur = cur.parentElement;
      if(document.querySelectorAll(parts.join(' > ')).length === 1) break;
    }
    return parts.join(' > ');
  }
})();
`;
}

/** Picker script for HTML pages — generates a stable sl-f-xxx ID, injects it into the live DOM,
 *  and sends the index path so the server can inject the same ID into stored html_content on Save. */
function buildHtmlPickerScript(activeField: string): string {
  return `
(function(){
  if(window.__slPickerActive) return;
  window.__slPickerActive = true;
  var activeField = ${JSON.stringify(activeField)};
  var highlighted = null;

  function highlight(el) {
    if(highlighted && highlighted !== el) highlighted.style.outline = '';
    highlighted = el;
    if(el) el.style.outline = '2px solid #3D8BDA';
  }

  document.addEventListener('mouseover', function(e) {
    var el = e.target;
    if(el === document.body || el === document.documentElement) return;
    highlight(el);
  }, true);

  document.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    while(el && el !== document.body) {
      var tag = el.tagName;
      if(['H1','H2','H3','H4','H5','H6','P','A','BUTTON','SPAN','LI','DIV','IMG'].indexOf(tag) !== -1) break;
      el = el.parentElement;
    }
    if(!el || el === document.body) return;

    var isImg = el.tagName === 'IMG';

    // Generate a stable ID and inject it into the live DOM so querySelector works immediately
    var generatedId = el.id && el.id.startsWith('sl-f-')
      ? el.id
      : 'sl-f-' + Math.random().toString(36).slice(2, 8);
    el.id = generatedId;

    // Index path: walk up the DOM tree recording child indices — used by server to locate element in raw HTML
    var indexPath = getIndexPath(el);

    var preview = isImg
      ? (el.alt || el.src || 'image element')
      : (el.textContent ? el.textContent.trim().slice(0, 100) : '');

    window.parent.postMessage({
      type: 'sl-element-picked',
      field: activeField,
      selector: '#' + generatedId,
      indexPath: indexPath,
      generatedId: generatedId,
      preview: preview,
      elementType: isImg ? 'image' : 'text',
    }, '*');
  }, true);

  function getIndexPath(el) {
    var path = [];
    var cur = el;
    while(cur && cur !== document.documentElement) {
      var idx = 0;
      var sib = cur.previousElementSibling;
      while(sib) { idx++; sib = sib.previousElementSibling; }
      path.unshift(idx);
      cur = cur.parentElement;
    }
    return path.join('/');
  }
})();
`;
}

export default function UTMPickerClient({ clientId, page, initialRules, appUrl }: Props) {
  const router = useRouter();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const isHtmlPage = !page.isAiPage;

  // ── Field mappings ──
  const [fields, setFields] = useState<Field[]>(() => {
    const stored = page.fieldSelectors;
    if (Object.keys(stored).length > 0) {
      return Object.entries(stored).map(([key, val]) => ({
        key,
        label: val.label || key,
        selector: val.selector,
        type: val.type,
      }));
    }
    // AI pages: seed with default fields so user sees them without picking
    if (!isHtmlPage) return AI_DEFAULT_FIELDS;
    // HTML pages: start empty — user picks everything
    return [];
  });

  // Preview text shown next to each mapped field — seed from saved fallback rule on mount
  const [fieldPreviews, setFieldPreviews] = useState<Record<string, string>>(() => {
    const fallback = initialRules.find(r => r.is_fallback);
    return (fallback?.overrides_json as Record<string, string>) ?? {};
  });

  const [activePickKey, setActivePickKey] = useState<string | null>(null);
  const [globalPickMode, setGlobalPickMode] = useState(false);
  const [pendingPick, setPendingPick] = useState<{
    selector: string;
    type: 'text' | 'image';
    preview: string;
    indexPath?: string;
    generatedId?: string;
  } | null>(null);
  const [pendingLabel, setPendingLabel] = useState('');
  const pendingLabelRef = useRef<HTMLInputElement>(null);

  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingSelectors, setSavingSelectors] = useState(false);
  const [utmSimulator, setUtmSimulator] = useState('default');
  const [suggestLoading, setSuggestLoading] = useState<number | null>(null);
  const [suggestPopover, setSuggestPopover] = useState<{ idx: number; suggestions: string[] } | null>(null);

  const [rules, setRules] = useState<UTMRule[]>(() => {
    if (initialRules.length > 0) return initialRules;
    return [{ match_param: 'utm_source', match_value: '', is_fallback: true, priority: 99, overrides_json: {} }];
  });

  const previewSrc = utmSimulator !== 'default'
    ? (page.slug
      ? `${appUrl}/pages/${page.slug}?${utmSimulator}`
      : `/api/pages/${page.id}/preview?${utmSimulator}`)
    : `/api/pages/${page.id}/preview`;

  // Reset loaded state and force-show after 6s whenever the preview URL changes
  useEffect(() => {
    setIframeLoaded(false);
    const t = setTimeout(() => setIframeLoaded(true), 6000);
    return () => clearTimeout(t);
  }, [previewSrc]);

  // After iframe loads, read current page content for all mapped fields → populate Default card
  useEffect(() => {
    if (!iframeLoaded || !iframeRef.current) return;
    const doc = iframeRef.current.contentDocument;
    if (!doc || !doc.body) return;

    const currentContent: Record<string, string> = {};
    for (const f of fields) {
      if (!f.selector) continue;
      try {
        const el = doc.querySelector(f.selector);
        if (!el) continue;
        const val = f.type === 'image' || (el as HTMLElement).tagName === 'IMG'
          ? (el as HTMLImageElement).src
          : (el.textContent?.trim() ?? '');
        if (val) currentContent[f.key] = val;
      } catch { /* invalid selector */ }
    }

    if (Object.keys(currentContent).length > 0) {
      setFieldPreviews(prev => ({ ...currentContent, ...prev }));
      setRules(prev => prev.map(r =>
        r.is_fallback
          ? { ...r, overrides_json: { ...currentContent, ...r.overrides_json } }
          : r
      ));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iframeLoaded]);

  // Inject picker script when activePickKey or globalPickMode changes
  useEffect(() => {
    if (!iframeRef.current || !iframeLoaded) return;
    const doc = iframeRef.current.contentDocument;
    if (!doc) return;

    doc.querySelectorAll('[data-sl-picker]').forEach(s => s.remove());
    if (doc.body) doc.body.querySelectorAll('*').forEach(el => ((el as HTMLElement).style.outline = ''));
    try { (iframeRef.current.contentWindow as unknown as Record<string, unknown>).__slPickerActive = false; } catch { /* cross-origin */ }

    const pickField = activePickKey ?? (globalPickMode ? '__new__' : null);
    if (!pickField) return;

    const script = doc.createElement('script');
    script.setAttribute('data-sl-picker', '1');
    script.textContent = isHtmlPage
      ? buildHtmlPickerScript(pickField)
      : buildAiPickerScript(pickField);
    doc.body.appendChild(script);
  }, [activePickKey, globalPickMode, iframeLoaded, isHtmlPage]);

  // Listen for postMessage from picker
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (!e.data || e.data.type !== 'sl-element-picked') return;
      const { field, selector, preview, elementType, indexPath, generatedId } = e.data as {
        field: string; selector: string; preview: string; elementType: 'text' | 'image';
        indexPath?: string; generatedId?: string;
      };
      if (field === '__new__') {
        setGlobalPickMode(false);
        setPendingPick({ selector, type: elementType, preview, indexPath, generatedId });
        setPendingLabel('');
        setTimeout(() => pendingLabelRef.current?.focus(), 50);
      } else {
        setFields(prev => prev.map(f =>
          f.key === field
            ? { ...f, selector, type: elementType, _indexPath: indexPath, _generatedId: generatedId }
            : f
        ));
        setFieldPreviews(prev => ({ ...prev, [field]: preview }));
        if (elementType === 'text' && preview) {
          setRules(prev => prev.map(r =>
            r.is_fallback ? { ...r, overrides_json: { ...r.overrides_json, [field]: preview } } : r
          ));
        }
        setActivePickKey(null);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // ── Field management ──
  function confirmPendingField() {
    const label = pendingLabel.trim();
    if (!label || !pendingPick) return;
    let key = labelToKey(label);
    const existing = fields.map(f => f.key);
    let uniqueKey = key;
    let i = 2;
    while (existing.includes(uniqueKey)) uniqueKey = `${key}_${i++}`;
    setFields(prev => [...prev, {
      key: uniqueKey,
      label,
      selector: pendingPick.selector,
      type: pendingPick.type,
      _indexPath: pendingPick.indexPath,
      _generatedId: pendingPick.generatedId,
    }]);
    setFieldPreviews(prev => ({ ...prev, [uniqueKey]: pendingPick.preview }));
    if (pendingPick.type === 'text' && pendingPick.preview) {
      setRules(prev => prev.map(r =>
        r.is_fallback ? { ...r, overrides_json: { ...r.overrides_json, [uniqueKey]: pendingPick.preview } } : r
      ));
    }
    setPendingPick(null);
    setPendingLabel('');
  }

  function removeField(key: string) {
    setFields(prev => prev.filter(f => f.key !== key));
    setFieldPreviews(prev => { const n = { ...prev }; delete n[key]; return n; });
    if (activePickKey === key) setActivePickKey(null);
    setRules(prev => prev.map(r => {
      const o = { ...r.overrides_json };
      delete o[key];
      return { ...r, overrides_json: o };
    }));
  }

  async function saveSelectors() {
    setSavingSelectors(true);
    try {
      // For HTML pages: first inject IDs into stored html_content for any newly picked fields
      if (isHtmlPage) {
        const fieldsToInject = fields.filter(f => f._indexPath && f._generatedId);
        if (fieldsToInject.length > 0) {
          const res = await fetch(`/api/pages/${page.id}/inject-field-id`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              injections: fieldsToInject.map(f => ({
                generatedId: f._generatedId,
                indexPath: f._indexPath,
                fieldKey: f.key,
                label: f.label,
                type: f.type,
              })),
            }),
          });
          if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to inject IDs');
          // Clear pending injection metadata
          setFields(prev => prev.map(f => ({ ...f, _indexPath: undefined, _generatedId: undefined })));
        }
      }

      // Save field selectors to field_selectors_json
      const payload: StoredFieldSelectors = {};
      for (const f of fields) {
        if (f.selector) payload[f.key] = { selector: f.selector, type: f.type, label: f.label };
      }
      const res = await fetch(`/api/pages/${page.id}/field-selectors`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field_selectors: payload }),
      });
      if (!res.ok) throw new Error((await res.json()).error);

      // Also persist rules so the auto-detected fallback text survives refresh
      const validNonFallback = nonFallbackRules.filter(r => r.match_value?.trim());
      const rulesToSave = [...validNonFallback, ...(fallbackRule ? [fallbackRule] : [])];
      await fetch(`/api/pages/${page.id}/personalization-rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: rulesToSave }),
      });

      toast.success('Element mappings saved.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save mappings.');
    } finally {
      setSavingSelectors(false);
    }
  }

  // ── Rules ──
  function addRule() {
    if (rules.filter(r => !r.is_fallback).length >= 20) return;
    setRules(prev => {
      const nonFallback = prev.filter(r => !r.is_fallback);
      const fallback = prev.find(r => r.is_fallback);
      const newRule: UTMRule = { match_param: 'utm_source', match_value: '', is_fallback: false, priority: nonFallback.length, overrides_json: {} };
      return fallback ? [...nonFallback, newRule, fallback] : [...nonFallback, newRule];
    });
  }

  function removeRule(idx: number) {
    setRules(prev => prev.filter((_, i) => i !== idx));
  }

  function updateRule(idx: number, patch: Partial<UTMRule>) {
    setRules(prev => prev.map((r, i) => i !== idx ? r : { ...r, ...patch }));
  }

  function updateRuleOverride(idx: number, fieldKey: string, value: string) {
    setRules(prev => prev.map((r, i) => i !== idx ? r : { ...r, overrides_json: { ...r.overrides_json, [fieldKey]: value } }));
  }

  async function saveRules() {
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (r.is_fallback) continue;
      if (!r.match_value?.trim()) {
        toast.error(`Rule ${i + 1}: fill in the UTM value (e.g. "google", "facebook") in the "When utm_source =" field.`, { duration: 5000 });
        return;
      }
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/pages/${page.id}/personalization-rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      toast.success('UTM rules saved.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save rules.');
    } finally {
      setSaving(false);
    }
  }

  async function suggestHeadlines(idx: number) {
    const rule = rules[idx];
    if (!rule || !rule.match_value?.trim()) { toast.error('Fill in the UTM value first'); return; }
    setSuggestLoading(idx);
    setSuggestPopover(null);
    try {
      const res = await fetch(`/api/pages/${page.id}/suggest-headlines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          match_param: rule.match_param,
          match_value: rule.match_value,
          current_headline: rule.overrides_json['headline'] ?? '',
          page_context: `Page: ${page.name}`,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.suggestions) { toast.error('Could not generate suggestions'); return; }
      setSuggestPopover({ idx, suggestions: data.suggestions });
    } catch {
      toast.error('Could not generate suggestions');
    } finally {
      setSuggestLoading(null);
    }
  }

  const nonFallbackRules = rules.filter(r => !r.is_fallback);
  const fallbackRule = rules.find(r => r.is_fallback);
  const mappedFields = fields.filter(f => f.selector);
  const headlineKey = fields.find(f => f.key === 'headline') ? 'headline' : null;

  function renderRuleFields(ruleIdx: number) {
    const rule = rules[ruleIdx];
    return (
      <div className="p-4 space-y-3">
        {mappedFields.length === 0 && (
          <p className="text-xs text-slate-400 italic">Map elements above first, then set content overrides here.</p>
        )}
        {mappedFields.map(f => (
          <div key={f.key}>
            <label className="flex items-center gap-1.5 text-xs text-slate-400 mb-1">
              {f.type === 'image' ? <ImageIcon size={11} /> : <Type size={11} />}
              {f.label}
            </label>
            <div className="relative">
              <input
                type={f.type === 'image' ? 'url' : 'text'}
                value={rule.overrides_json[f.key] ?? ''}
                onChange={e => updateRuleOverride(ruleIdx, f.key, e.target.value)}
                placeholder={f.type === 'image' ? 'https://...' : `Override ${f.label}`}
                className={cn(
                  'w-full bg-slate-50 dark:bg-slate-800 border rounded-lg px-3 py-2 text-xs text-slate-700 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-400',
                  f.type === 'image' && rule.overrides_json[f.key] && !rule.overrides_json[f.key].startsWith('https://')
                    ? 'border-red-400'
                    : 'border-slate-200 dark:border-slate-700'
                )}
              />
              {f.key === headlineKey && (
                <button
                  onClick={() => suggestHeadlines(ruleIdx)}
                  disabled={suggestLoading === ruleIdx}
                  title="AI suggest"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-indigo-400 hover:text-indigo-500 disabled:opacity-50"
                >
                  {suggestLoading === ruleIdx ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                </button>
              )}
              {suggestPopover?.idx === ruleIdx && f.key === headlineKey && (
                <div className="absolute left-0 top-full mt-1 z-50 w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 dark:border-slate-700">
                    <span className="text-xs text-slate-400 font-medium">AI suggestions</span>
                    <button onClick={() => setSuggestPopover(null)} className="text-slate-400 hover:text-slate-600 text-xs">✕</button>
                  </div>
                  {suggestPopover.suggestions.map((s, si) => (
                    <button
                      key={si}
                      onClick={() => { updateRuleOverride(ruleIdx, 'headline', s); setSuggestPopover(null); }}
                      className="w-full text-left px-3 py-2.5 text-xs text-slate-700 dark:text-slate-200 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors border-b border-slate-50 dark:border-slate-700/50 last:border-0"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  const backHref = page.isAiPage
    ? `/clients/${clientId}/ai-pages`
    : `/clients/${clientId}/pages`;

  return (
    <div className="fixed inset-0 z-20 flex bg-slate-50 dark:bg-slate-900" style={{ left: '15rem' }}>

      {/* ── Left sidebar ── */}
      <div className="w-[420px] flex-shrink-0 flex flex-col bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-2 px-4 h-12 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
          <button
            onClick={() => router.push(backHref)}
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
          >
            <ChevronLeft size={14} />
            Back
          </button>
          <span className="text-slate-300 dark:text-slate-700 text-xs">/</span>
          <span className="text-xs text-slate-500 dark:text-slate-400 truncate">{page.name}</span>
          <span className="text-slate-300 dark:text-slate-700 text-xs">/</span>
          <span className="text-xs font-medium text-slate-700 dark:text-slate-200">UTM Personalization</span>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">

          {/* ── Map Elements ── */}
          <section>
            <div className="flex items-center justify-between mb-1">
              <div>
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Map Elements</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {isHtmlPage ? 'Click any element in the preview to map it.' : 'Click any element in the preview to map it.'}
                </p>
              </div>
              <button
                onClick={saveSelectors}
                disabled={savingSelectors}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600 disabled:opacity-40 text-white font-medium transition-colors"
              >
                {savingSelectors ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                Save
              </button>
            </div>

            <div className="space-y-2 mt-3">
              {fields.map(f => {
                const isDefault = page.isAiPage && AI_DEFAULT_KEYS.has(f.key);
                return (
                  <div key={f.key} className="flex items-center gap-2 p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        {f.type === 'image' ? <ImageIcon size={11} className="text-slate-400 flex-shrink-0" /> : <Type size={11} className="text-slate-400 flex-shrink-0" />}
                        <p className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">{f.label}</p>
                      </div>
                      {f.selector ? (
                        <p className="text-xs text-slate-400 truncate mt-0.5 pl-4">
                          {fieldPreviews[f.key] ? `"${fieldPreviews[f.key]}"` : f.selector}
                        </p>
                      ) : (
                        <p className="text-xs text-slate-300 dark:text-slate-600 mt-0.5 pl-4">Not mapped — click Pick</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => setActivePickKey(activePickKey === f.key ? null : f.key)}
                        className={cn(
                          'flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium transition-colors',
                          activePickKey === f.key
                            ? 'bg-indigo-600 text-white'
                            : f.selector
                              ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 border border-green-200 dark:border-green-700/40'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-indigo-50 hover:text-indigo-500'
                        )}
                      >
                        {activePickKey === f.key ? (
                          <><MousePointer2 size={11} /> Picking…</>
                        ) : f.selector ? (
                          <><Check size={11} /> Mapped</>
                        ) : (
                          <><MousePointer2 size={11} /> Pick</>
                        )}
                      </button>
                      {/* Default AI fields cannot be removed; all HTML fields can */}
                      {!isDefault && (
                        <button
                          onClick={() => removeField(f.key)}
                          className="p-1 text-slate-400 hover:text-red-400 transition-colors"
                          title="Remove field"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Pending pick — name the element just clicked */}
              {pendingPick && (
                <div className="p-3 rounded-xl border-2 border-indigo-400 dark:border-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 space-y-2">
                  <p className="text-xs font-medium text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
                    {pendingPick.type === 'image' ? <ImageIcon size={12} /> : <Type size={12} />}
                    Element selected — give it a name
                  </p>
                  <p className="text-xs text-slate-400 truncate">"{pendingPick.preview}"</p>
                  <div className="flex gap-2">
                    <input
                      ref={pendingLabelRef}
                      type="text"
                      value={pendingLabel}
                      onChange={e => setPendingLabel(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') confirmPendingField(); if (e.key === 'Escape') { setPendingPick(null); setPendingLabel(''); } }}
                      placeholder="e.g. Nav CTA, Badge Text, Hero Title"
                      className="flex-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-400"
                    />
                    <button onClick={confirmPendingField} disabled={!pendingLabel.trim()} className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white disabled:opacity-40 font-medium flex-shrink-0">
                      Save
                    </button>
                    <button onClick={() => { setPendingPick(null); setPendingLabel(''); }} className="text-slate-400 hover:text-slate-600 flex-shrink-0">
                      <X size={13} />
                    </button>
                  </div>
                </div>
              )}

              {/* Pick Element button */}
              {!pendingPick && (
                <button
                  onClick={() => { setGlobalPickMode(m => !m); setActivePickKey(null); }}
                  className={cn(
                    'w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl border text-xs font-medium transition-colors',
                    globalPickMode
                      ? 'border-indigo-500 bg-indigo-600 text-white animate-pulse'
                      : 'border-dashed border-slate-300 dark:border-slate-700 text-slate-400 hover:text-indigo-500 hover:border-indigo-400'
                  )}
                >
                  <MousePointer2 size={12} />
                  {globalPickMode ? 'Click any element on the page…' : 'Pick Element from Page'}
                </button>
              )}
            </div>

            {(activePickKey || globalPickMode) && !pendingPick && (
              <div className="mt-2 flex items-center gap-2 text-xs text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-700/40 rounded-lg px-3 py-2">
                <MousePointer2 size={13} className="animate-pulse" />
                {activePickKey
                  ? <>Click the <strong className="mx-1">{fields.find(f => f.key === activePickKey)?.label}</strong> element in the preview.</>
                  : <>Click any text, heading, button, or image on the page.</>
                }
                <button onClick={() => { setActivePickKey(null); setGlobalPickMode(false); }} className="ml-auto text-slate-400 hover:text-slate-600"><X size={12} /></button>
              </div>
            )}
          </section>

          {/* ── UTM Rules ── */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">UTM Rules</h3>
                <p className="text-xs text-slate-400 mt-0.5">Swap content based on UTM params in the visitor URL.</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={addRule}
                  disabled={nonFallbackRules.length >= 20}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-medium transition-colors"
                >
                  <Plus size={12} /> Add Rule
                </button>
                <button
                  onClick={saveRules}
                  disabled={saving}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600 disabled:opacity-40 text-white font-medium transition-colors"
                >
                  {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                  Save
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {rules.map((rule, idx) => rule.is_fallback ? null : (
                <div key={idx} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-visible">
                  <div className="px-4 pt-2.5 pb-2 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 rounded-t-xl space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-slate-400 font-medium flex-shrink-0">When</span>
                      <select
                        value={rule.match_param}
                        onChange={e => updateRule(idx, { match_param: e.target.value })}
                        className="flex-shrink-0 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-700 dark:text-slate-200 focus:outline-none focus:border-indigo-400"
                      >
                        {UTM_PARAMS.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                      <span className="text-xs text-slate-400 flex-shrink-0">=</span>
                      <input
                        type="text"
                        value={rule.match_value ?? ''}
                        onChange={e => updateRule(idx, { match_value: e.target.value })}
                        placeholder="e.g. facebook"
                        className="min-w-0 flex-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-700 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-400"
                      />
                    </div>
                    <div className="flex items-center justify-end gap-1">
                      {rule.match_value && (
                        <a
                          href={page.slug
                            ? `${appUrl}/pages/${page.slug}?${rule.match_param}=${encodeURIComponent(rule.match_value)}`
                            : `/api/pages/${page.id}/preview?${rule.match_param}=${encodeURIComponent(rule.match_value)}`}
                          target="_blank" rel="noopener noreferrer"
                          className="p-1 text-slate-400 hover:text-indigo-500 rounded transition-colors inline-flex"
                          title="Preview this variant"
                        >
                          <ExternalLink size={13} />
                        </a>
                      )}
                      <button onClick={() => removeRule(idx)} className="p-1 text-red-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  {renderRuleFields(idx)}
                </div>
              ))}

              {/* Default (fallback) card */}
              {fallbackRule && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 opacity-80">
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 rounded-t-xl">
                    <div>
                      <span className="text-xs font-medium text-slate-500 dark:text-slate-400 italic">Default — shown when no rule matches</span>
                      <p className="text-xs text-slate-400 mt-0.5">Current page content (auto-detected)</p>
                    </div>
                    <a
                      href={page.slug ? `${appUrl}/pages/${page.slug}` : `/api/pages/${page.id}/preview`}
                      target="_blank" rel="noopener noreferrer"
                      className="p-1 text-slate-400 hover:text-indigo-500 inline-flex"
                      title="Preview default"
                    >
                      <ExternalLink size={13} />
                    </a>
                  </div>
                  <div className="p-4 space-y-3">
                    {mappedFields.length === 0 && (
                      <p className="text-xs text-slate-400 italic">Map elements above to see current content.</p>
                    )}
                    {mappedFields.map(f => (
                      <div key={f.key}>
                        <label className="flex items-center gap-1.5 text-xs text-slate-400 mb-1">
                          {f.type === 'image' ? <ImageIcon size={11} /> : <Type size={11} />}
                          {f.label}
                        </label>
                        <input
                          type="text"
                          value={fallbackRule.overrides_json[f.key] ?? ''}
                          readOnly
                          disabled
                          className="w-full bg-slate-100 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-400 dark:text-slate-500 cursor-not-allowed select-none"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* ── Right: page preview ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center gap-3 px-4 h-12 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex-shrink-0">
          <span className="text-xs text-slate-400">Preview as:</span>
          <select
            value={utmSimulator}
            onChange={e => setUtmSimulator(e.target.value)}
            className="text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 text-slate-600 dark:text-slate-300 focus:outline-none focus:border-indigo-400"
          >
            <option value="default">Default</option>
            {nonFallbackRules.filter(r => r.match_value).map((r, i) => (
              <option key={i} value={`${r.match_param}=${r.match_value}`}>
                {r.match_param} = {r.match_value}
              </option>
            ))}
          </select>
          {utmSimulator !== 'default' && (
            <span className="text-xs text-amber-500 flex items-center gap-1">
              <AlertTriangle size={11} /> Previewing UTM variant
            </span>
          )}
          {(activePickKey || globalPickMode) && !pendingPick && (
            <span className="ml-auto text-xs text-indigo-600 dark:text-indigo-400 flex items-center gap-1 animate-pulse">
              <MousePointer2 size={12} />
              {activePickKey
                ? <>Click <strong className="ml-1">{fields.find(f => f.key === activePickKey)?.label}</strong> on the page</>
                : <>Click any element on the page</>
              }
            </span>
          )}
        </div>

        <div className="flex-1 overflow-hidden bg-slate-100 dark:bg-slate-950 flex items-start justify-center p-5">
          <div className="relative w-full h-full bg-white rounded-xl overflow-hidden shadow-xl ring-1 ring-black/5 dark:ring-white/5">
            <iframe
              key={previewSrc}
              ref={iframeRef}
              src={previewSrc}
              className="w-full h-full border-0"
              style={{ opacity: iframeLoaded ? 1 : 0, cursor: (activePickKey || globalPickMode) ? 'crosshair' : 'default' }}
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
        </div>
      </div>
    </div>
  );
}
