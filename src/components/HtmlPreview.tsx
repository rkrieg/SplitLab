'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
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

/**
 * Build a self-contained, script-free HTML document suitable for srcdoc.
 * parseShadowContent strips <script> tags and extracts <style>/<link> blocks
 * so we can reconstruct a clean document where body-scoped CSS applies
 * correctly (unlike shadow DOM which drops <html>/<body> elements).
 */
function buildSrcdoc(rawHtml: string): string {
  if (!rawHtml) return '';

  // If the raw HTML already looks like a complete document, use it directly
  // after stripping scripts for safety.
  const cleaned = rawHtml
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');

  // If it's a proper <!DOCTYPE html> doc, return as-is (scripts stripped)
  if (/^\s*<!DOCTYPE\s+html/i.test(cleaned) || /^\s*<html/i.test(cleaned)) {
    return cleaned;
  }

  // Otherwise treat as a fragment — wrap with head/body
  const { styles, body } = parseShadowContent(rawHtml);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${styles}
</head>
<body style="margin:0">${body}</body>
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

    // Apply immediately in case the doc is already loaded
    applyEditMode();
    // Also apply after the next load (srcdoc swap resets the document)
    iframe.addEventListener('load', applyEditMode);
    return () => iframe.removeEventListener('load', applyEditMode);
  }, [editMode, html, onSelectionChange]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcdoc}
      className={className}
      title="Page Preview"
      // allow-same-origin lets us access contentDocument for designMode / getHtml()
      // allow-popups lets CTA links open in a new tab (harmless in preview)
      sandbox="allow-same-origin allow-popups"
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
