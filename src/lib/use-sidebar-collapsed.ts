'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

const COLLAPSE_DEFAULT_PATHS = ['/utm', '/pages/new'];

function shouldDefaultCollapsed(pathname: string) {
  return COLLAPSE_DEFAULT_PATHS.some((p) => pathname.includes(p));
}

export function useSidebarCollapsed() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('sl-sidebar-collapsed');
    // Mirror Sidebar.tsx: explicit user preference wins, otherwise fall back
    // to the same path-based default so the content pane never renders wider
    // than the sidebar it's supposed to sit next to on first paint.
    setCollapsed(stored !== null ? stored === 'true' : shouldDefaultCollapsed(pathname));

    function onToggle(e: Event) {
      setCollapsed((e as CustomEvent<boolean>).detail);
    }
    window.addEventListener('sl-sidebar-toggle', onToggle);
    return () => window.removeEventListener('sl-sidebar-toggle', onToggle);
  }, [pathname]);

  return collapsed;
}
