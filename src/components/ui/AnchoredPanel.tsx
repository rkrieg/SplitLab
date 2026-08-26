'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

interface Props {
  /** The element the panel hangs off — usually the trigger button. */
  anchorRef: React.RefObject<HTMLElement>;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  /** Gap between the anchor and the panel, in px. */
  offset?: number;
  /** Never render taller than this, even with room to spare. */
  maxHeight?: number;
}

interface Position {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const VIEWPORT_MARGIN = 8;

/**
 * A dropdown panel that renders into document.body and positions itself with
 * fixed coordinates measured from its anchor.
 *
 * Absolutely-positioned dropdowns are fine until the thing they open from lives
 * inside a scrolling, fixed-height column — which is exactly where the builder's
 * Skills and Style controls sit, directly above a textarea that grows as the
 * user pastes. An in-flow panel then either got clipped by the column or, when
 * told to open upward, spilled straight over the app header.
 *
 * A portal takes it out of that stacking context entirely. The panel then:
 *  - opens downward when there is room, and flips up when there is not
 *  - shrinks to whatever space actually exists rather than overflowing
 *  - follows the anchor when the composer grows, the column scrolls, or the
 *    window resizes
 *
 * It also owns its own dismissal, because a parent testing
 * `rootRef.contains(event.target)` can never match a click inside a portal —
 * that check would close the panel the moment the user picked something.
 */
export default function AnchoredPanel({
  anchorRef,
  open,
  onClose,
  children,
  className,
  offset = 6,
  maxHeight = 420,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);

  useEffect(() => setMounted(true), []);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - offset - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - offset - VIEWPORT_MARGIN;
    // Prefer down. Flip only when below genuinely can't hold a usable panel and
    // above is roomier — flipping for a few pixels reads as jitter.
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const available = Math.max(120, Math.min(maxHeight, openUp ? spaceAbove : spaceBelow));
    setPos({
      top: openUp ? rect.top - offset - available : rect.bottom + offset,
      left: rect.left,
      width: rect.width,
      maxHeight: available,
    });
  }, [anchorRef, offset, maxHeight]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;

    // `true` for capture: the anchor sits inside a scrolling column, and a
    // scroll event on that column never bubbles to window.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);

    // The textarea below the anchor grows as the user types or pastes, which
    // moves the anchor without any scroll or resize firing.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reposition) : null;
    if (ro && anchor) {
      ro.observe(anchor);
      if (anchor.offsetParent instanceof Element) ro.observe(anchor.offsetParent);
    }

    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      ro?.disconnect();
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, anchorRef, onClose, reposition]);

  if (!mounted || !open || !pos) return null;

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        maxHeight: pos.maxHeight,
        // Above the builder's own overlays, below toasts and modals.
        zIndex: 60,
      }}
      className={cn(
        'overflow-y-auto overscroll-contain rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
