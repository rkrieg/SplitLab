'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

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

/**
 * Build the srcdoc string for the iframe.
 * We preserve scripts so the page renders exactly as it would in a real browser
 * (navbar scroll behaviour, hamburger menu, animations, etc.).
 * A <base> tag is kept if present so relative assets resolve correctly.
 */
function buildSrcdoc(rawHtml: string): string {
  if (!rawHtml) return '';

  // Already a complete document — use as-is
  if (/^\s*<!DOCTYPE\s+html/i.test(rawHtml) || /^\s*<html/i.test(rawHtml)) {
    return rawHtml;
  }

  // Fragment fallback: wrap in a minimal document
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0">${rawHtml}</body>
</html>`;
}

const HtmlPreview = forwardRef<HtmlPreviewHandle, Props>(function HtmlPreview(
  { html, editMode, className, onSelectionChange },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const srcdoc = buildSrcdoc(html);

  useImperativeHandle(ref, () => ({
    getHtml() {
      try {
        const doc = iframeRef.current?.contentDocument;
        if (!doc) return html;
        return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
      } catch {
        return html;
      }
    },
    execFormat(command: string, value?: string) {
      try {
        const doc = iframeRef.current?.contentDocument;
        doc?.execCommand(command, false, value ?? undefined);
      } catch { /* ignore */ }
    },
    applyFontSize(px: string) {
      try {
        const doc = iframeRef.current?.contentDocument;
        if (!doc) return;
        doc.execCommand('fontSize', false, '7');
        doc.querySelectorAll<HTMLElement>('font[size="7"]').forEach((el) => {
          const span = doc.createElement('span');
          span.style.fontSize = `${px}px`;
          el.parentNode?.insertBefore(span, el);
          while (el.firstChild) span.appendChild(el.firstChild);
          el.parentNode?.removeChild(el);
        });
      } catch { /* ignore */ }
    },
  }));

  // Apply / remove edit mode whenever editMode or html changes
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    function applyEditMode() {
      const doc = iframe!.contentDocument;
      if (!doc) return;
      try {
        if (editMode) {
          doc.designMode = 'on';
        } else {
          doc.designMode = 'off';
          onSelectionChange?.(false);
        }
      } catch { /* cross-origin sandbox — ignore */ }
    }

    applyEditMode();
    iframe.addEventListener('load', applyEditMode);
    return () => iframe.removeEventListener('load', applyEditMode);
  }, [editMode, html, onSelectionChange]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcdoc}
      className={className}
      title="Page Preview"
      sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals"
      style={{
        display: 'block',
        width: '100%',
        minHeight: '80vh',
        border: 'none',
        background: '#fff',
      }}
    />
  );
});

export default HtmlPreview;
