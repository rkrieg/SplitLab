'use client';

import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { parseShadowContent } from '@/lib/html-clean';

export interface HtmlPreviewHandle {
  getHtml(): string;
  execFormat(command: string, value?: string): void;
  applyFontSize(px: string): void;
}

interface Props {
  html: string;
  editMode: boolean;
  className?: string;
  onSelectionChange?: (active: boolean, pos?: { x: number; y: number }) => void;
}

const HtmlPreview = forwardRef<HtmlPreviewHandle, Props>(function HtmlPreview(
  { html, editMode, className, onSelectionChange },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null);

  // ─── Expose imperative handle ─────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    getHtml() {
      const shadow = hostRef.current?.shadowRoot;
      if (!shadow) return html;
      // Strip contenteditable/outline styles before serialising
      shadow.querySelectorAll<HTMLElement>('[contenteditable]').forEach((el) => {
        el.removeAttribute('contenteditable');
        el.style.outline = '';
        el.style.cursor = '';
        el.style.borderRadius = '';
        el.style.minHeight = '';
      });
      return '<!DOCTYPE html>\n<html>\n<head></head>\n<body>\n' + shadow.innerHTML + '\n</body>\n</html>';
    },
    execFormat(command: string, value?: string) {
      document.execCommand(command, false, value ?? undefined);
    },
    applyFontSize(px: string) {
      const shadow = hostRef.current?.shadowRoot;
      if (!shadow) return;
      // Classic big-7 trick: insert font[size=7], then replace with span[style]
      document.execCommand('fontSize', false, '7');
      shadow.querySelectorAll<HTMLElement>('font[size="7"]').forEach((el) => {
        const span = document.createElement('span');
        span.style.fontSize = `${px}px`;
        el.parentNode?.insertBefore(span, el);
        while (el.firstChild) span.appendChild(el.firstChild);
        el.parentNode?.removeChild(el);
      });
    },
  }));

  // ─── (Re-)render HTML into shadow DOM ────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !html) return;

    let shadow = host.shadowRoot;
    if (!shadow) {
      shadow = host.attachShadow({ mode: 'open' });
    }

    const { combined } = parseShadowContent(html);
    shadow.innerHTML = combined;
  }, [html]);

  // ─── Toggle edit mode ────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    const shadow = host?.shadowRoot;
    if (!shadow) return;

    if (editMode) {
      // Enable CSS-based styling so execCommand produces <span style="..."> not <font>
      document.execCommand('styleWithCSS', false, 'true');

      // Make all block-level text elements editable (avoid nested contentEditables)
      const EDITABLE_SELECTOR = [
        'h1','h2','h3','h4','h5','h6',
        'p','li','td','th','blockquote',
        'figcaption','caption','button','a',
        '[data-editable]',
      ].join(',');

      shadow.querySelectorAll<HTMLElement>(EDITABLE_SELECTOR).forEach((el) => {
        el.contentEditable = 'true';
        el.style.outline = '1px dashed rgba(99,102,241,0.4)';
        el.style.cursor = 'text';
        el.style.borderRadius = '2px';
        el.style.minHeight = '1em';
      });

      const handleSelection = () => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          onSelectionChange?.(true, {
            x: rect.left + rect.width / 2,
            y: rect.top - 8,
          });
        } else {
          onSelectionChange?.(false);
        }
      };

      document.addEventListener('selectionchange', handleSelection);
      return () => document.removeEventListener('selectionchange', handleSelection);
    } else {
      shadow.querySelectorAll<HTMLElement>('[contenteditable]').forEach((el) => {
        el.removeAttribute('contenteditable');
        el.style.outline = '';
        el.style.cursor = '';
        el.style.borderRadius = '';
        el.style.minHeight = '';
      });
      onSelectionChange?.(false);
    }
  }, [editMode, html, onSelectionChange]);

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ display: 'block', width: '100%', minHeight: '600px', overflow: 'auto', background: '#fff' }}
    />
  );
});

export default HtmlPreview;
