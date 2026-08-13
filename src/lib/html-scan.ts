// The slim entry point skips cheerio's fromURL()/undici dependency (network
// fetching we never use) — the full package pulls in undici, which ships
// syntax Next's webpack/SWC loader can't parse inside node_modules.
import * as cheerio from 'cheerio/slim';

/**
 * Static-HTML mirror of tracker.js's live-browser scan (collectElements() in
 * src/app/tracker.js/route.ts). Same selector priority (id: > name: >
 * text: > fields:/nth:), same caps, same field-signature logic for forms —
 * kept in sync deliberately so a goal's selector means the same thing
 * whether it came from a human's live "Scan Page" run or this static parse.
 *
 * Deliberately NOT equivalent: this only sees markup literally present in
 * the HTML string. Anything injected/rendered by client-side JS after page
 * load (or only revealed after user interaction, e.g. a later step of a
 * multi-step form) is invisible here — that gap can only be closed by an
 * actual browser render, which is what the live scan is for.
 */

export interface ScanElement {
  type: 'form' | 'button' | 'call' | 'link' | 'toggle';
  id: string | null;
  text: string | null;
  selector?: string | null;
}

const MAX_ID_LEN = 255;
const MAX_NAME_LEN = 150;
const MAX_TEXT_LEN = 100;
const MAX_FIELDS_LEN = 300;
const MAX_FIELD_KEY_LEN = 80;
const MAX_ELEMENTS = 500; // matches /api/scan's elementSchema array cap

function cleanText(value: string | undefined | null): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

type Cheerio$ = ReturnType<typeof cheerio.load>;
type CheerioEl = ReturnType<Cheerio$>;

function formFieldSignature($form: CheerioEl, $: Cheerio$): string | null {
  const seen = new Set<string>();
  const fields: string[] = [];
  $form.find('input, select, textarea').each((_, el) => {
    const $field = $(el);
    const tag = (el as unknown as { tagName?: string }).tagName?.toLowerCase() || '';
    const type = ($field.attr('type') || '').toLowerCase();
    if (['password', 'hidden', 'submit', 'button', 'reset', 'file'].includes(type)) return;
    const key = cleanText($field.attr('name') || $field.attr('id') || $field.attr('placeholder') || $field.attr('aria-label') || type || tag);
    const encoded = key ? encodeURIComponent(key.toLowerCase().slice(0, MAX_FIELD_KEY_LEN)) : null;
    if (!encoded || seen.has(encoded)) return;
    seen.add(encoded);
    fields.push(encoded);
  });
  if (!fields.length) return null;
  const sig = fields.sort().join('|');
  return sig.length > MAX_FIELDS_LEN ? sig.slice(0, MAX_FIELDS_LEN) : sig;
}

function formId($form: CheerioEl): string | null {
  return ($form.attr('id') || '').slice(0, MAX_ID_LEN) || null;
}

function formName($form: CheerioEl): string | null {
  return ($form.attr('name') || '').slice(0, MAX_NAME_LEN) || null;
}

function formSubmitText($form: CheerioEl): string | null {
  const submit = $form.find("button[type='submit'], input[type='submit'], button:not([type]), [role='button']").first();
  if (!submit.length) return null;
  const t = cleanText(submit.text() || submit.attr('value') || submit.attr('aria-label') || '');
  return t ? t.slice(0, MAX_TEXT_LEN) : null;
}

function buttonVisibleText($btn: CheerioEl): string | null {
  const t = cleanText($btn.text() || $btn.attr('value') || '');
  return t ? t.slice(0, MAX_TEXT_LEN) : null;
}

function toggleAssociatedLabel($cb: CheerioEl, $: Cheerio$): string | null {
  const aria = cleanText($cb.attr('aria-label') || '');
  if (aria) return aria.slice(0, MAX_TEXT_LEN);
  const name = ($cb.attr('name') || '').slice(0, MAX_NAME_LEN) || null;
  if (name) return name;
  const cid = $cb.attr('id') || null;
  if (cid) {
    let found: string | null = null;
    $('label[for]').each((_, labelEl) => {
      if (found) return;
      const $label = $(labelEl);
      if ($label.attr('for') === cid) {
        const t = cleanText($label.text()).slice(0, MAX_TEXT_LEN);
        if (t) found = t;
      }
    });
    if (found) return found;
  }
  const $parentLabel = $cb.closest('label');
  if ($parentLabel.length) {
    const pt = cleanText($parentLabel.text()).slice(0, MAX_TEXT_LEN);
    if (pt) return pt;
  }
  return null;
}

export function scanHtmlElements(html: string): ScanElement[] {
  const $ = cheerio.load(html);
  const elements: ScanElement[] = [];

  // --- forms ---
  const forms = $('form');
  const formCounts: Record<string, number> = {};
  const inc = (key: string | null) => { if (key) formCounts[key] = (formCounts[key] || 0) + 1; };
  forms.each((_, el) => {
    const $form = $(el);
    inc(formName($form) ? 'name:' + formName($form) : null);
    const st = formSubmitText($form);
    inc(st ? 'text:' + st.toLowerCase() : null);
    const fs = formFieldSignature($form, $);
    inc(fs ? 'fields:' + fs : null);
  });

  forms.each((idx, el) => {
    const $form = $(el);
    const fid = formId($form);
    const name = formName($form);
    const submitText = formSubmitText($form);
    const fields = formFieldSignature($form, $);
    let selector: string;
    if (fid) selector = 'id:' + fid;
    else if (name && formCounts['name:' + name] === 1) selector = 'name:' + name;
    else if (submitText && formCounts['text:' + submitText.toLowerCase()] === 1) selector = 'text:' + submitText;
    else if (fields && formCounts['fields:' + fields] === 1) selector = 'fields:' + fields;
    else selector = 'nth:' + idx;

    let label: string;
    if (fid) label = ('#' + fid).slice(0, 100);
    else if (name) label = name.slice(0, 100);
    else if (selector.startsWith('fields:')) {
      label = selector.slice(7).split('|').map((k) => decodeURIComponent(k)).join(', ').slice(0, 100) || 'Form';
    } else if (selector.startsWith('nth:')) {
      label = 'Form #' + (idx + 1);
    } else {
      label = submitText ? `Form ("${submitText}")`.slice(0, 100) : 'Form';
    }

    elements.push({ type: 'form', id: fid, text: label, selector });
  });

  // --- buttons (button, [role=button], [role=switch], input[type=submit/button]) ---
  const buttons = $("button, [role='button'], [role='switch'], input[type='submit'], input[type='button']");
  const buttonNameCounts: Record<string, number> = {};
  buttons.each((_, el) => {
    const $btn = $(el);
    const bn = ($btn.attr('name') || '').slice(0, MAX_NAME_LEN) || null;
    if (bn) buttonNameCounts[bn] = (buttonNameCounts[bn] || 0) + 1;
  });
  buttons.each((_, el) => {
    const $btn = $(el);
    const bid = ($btn.attr('id') || '').slice(0, MAX_ID_LEN) || null;
    const text = buttonVisibleText($btn);
    const name = ($btn.attr('name') || '').slice(0, MAX_NAME_LEN) || null;
    const aria = cleanText($btn.attr('aria-label') || '').slice(0, MAX_TEXT_LEN) || null;

    let selector: string | null;
    if (bid) selector = 'id:' + bid;
    else if (text) selector = 'text:' + text;
    else if (name && buttonNameCounts[name] === 1) selector = 'name:' + name;
    else if (aria) selector = 'text:' + aria;
    else selector = null;

    let label: string;
    if (bid) label = ('#' + bid).slice(0, 100);
    else if (text) label = text;
    else if (selector?.startsWith('name:')) label = selector.slice(5);
    else if (selector?.startsWith('text:')) label = selector.slice(5);
    else label = 'Button';

    elements.push({ type: 'button', id: bid, text: label, selector });
  });

  // --- toggles (real checkboxes only — [role=switch] is swept into buttons above, matching live scan) ---
  const checkboxes = $("input[type='checkbox']");
  checkboxes.each((_, el) => {
    const $cb = $(el);
    const cid = ($cb.attr('id') || '').slice(0, MAX_ID_LEN) || null;
    const aria = cleanText($cb.attr('aria-label') || '').slice(0, MAX_TEXT_LEN) || null;
    const name = ($cb.attr('name') || '').slice(0, MAX_NAME_LEN) || null;
    const assocLabel = toggleAssociatedLabel($cb, $);

    let selector: string | null;
    if (cid) selector = 'id:' + cid;
    else if (aria) selector = 'text:' + aria;
    else if (name) selector = 'name:' + name;
    else selector = assocLabel ? 'text:' + assocLabel : null;

    let label: string;
    if (cid) label = ('#' + cid).slice(0, 100);
    else if (selector?.startsWith('name:')) label = selector.slice(5);
    else if (selector?.startsWith('text:')) label = selector.slice(5);
    else label = assocLabel || 'Toggle';

    elements.push({ type: 'toggle', id: cid, text: label, selector });
  });

  // --- links (anchors with a real href; tel: links become type "call") ---
  $('a').each((_, el) => {
    const $link = $(el);
    const href = $link.attr('href') || '';
    if (!href || href.charAt(0) === '#' || href.indexOf('javascript:') === 0) return;
    const type: 'call' | 'link' = href.indexOf('tel:') === 0 ? 'call' : 'link';
    elements.push({
      type,
      id: $link.attr('id') || null,
      text: cleanText($link.text() || href).slice(0, MAX_TEXT_LEN) || null,
    });
  });

  return elements.slice(0, MAX_ELEMENTS);
}
