'use client';

import { useEffect, useState } from 'react';

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(localStorage.getItem('sl-sidebar-collapsed') === 'true');

    function onToggle(e: Event) {
      setCollapsed((e as CustomEvent<boolean>).detail);
    }
    window.addEventListener('sl-sidebar-toggle', onToggle);
    return () => window.removeEventListener('sl-sidebar-toggle', onToggle);
  }, []);

  return collapsed;
}
