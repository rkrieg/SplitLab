'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { signOut, useSession } from 'next-auth/react';
import {
  LayoutDashboard,
  Building2,
  FileCode2,
  Code2,
  Users,
  Settings,
  LogOut,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  Check,
  Sun,
  Moon,
  Globe,
  CreditCard,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { cn, slugify } from '@/lib/utils';
import { PLAN_LIMITS } from '@/lib/plans';
import { useState, useEffect, useRef } from 'react';
import { useTheme } from 'next-themes';
import toast from 'react-hot-toast';
import Spinner from '@/components/ui/Spinner';

const COLLAPSE_DEFAULT_PATHS = ['/utm', '/pages/new'];

function shouldDefaultCollapsed(pathname: string) {
  return COLLAPSE_DEFAULT_PATHS.some((p) => pathname.includes(p));
}

interface Client {
  id: string;
  name: string;
  slug: string;
}

const globalNavItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/pages',     label: 'Pages',     icon: FileCode2 },
  { href: '/scripts',   label: 'Scripts',   icon: Code2 },
  { href: '/domains',   label: 'Domains',   icon: Globe },
  { href: '/team',      label: 'Team',      icon: Users },
  { href: '/billing',   label: 'Billing',   icon: CreditCard },
  { href: '/settings',  label: 'Settings',  icon: Settings },
];

function getClientNavItems(clientId: string, isViewer: boolean) {
  const items = [
    { href: `/clients/${clientId}/pages`,        label: 'Pages',       icon: FileCode2 },
    { href: `/clients/${clientId}/ai-pages`,      label: 'AI Pages',    icon: Sparkles },
    { href: `/clients/${clientId}/scripts`,      label: 'Scripts',     icon: Code2 },
    { href: `/clients/${clientId}/domains`,      label: 'Domains',     icon: Globe },
    { href: '/team',                             label: 'Team',        icon: Users },
    { href: '/billing',                          label: 'Billing',     icon: CreditCard },
    { href: `/clients/${clientId}/settings`,     label: 'Settings',    icon: Settings },
  ];
  return isViewer ? items.filter(i => i.href !== '/billing' && i.href !== '/team') : items;
}

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [clients, setClients] = useState<Client[]>([]);
  const [clientsLoaded, setClientsLoaded] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createClientError, setCreateClientError] = useState<{ message: string; isLimit: boolean } | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [clientToDelete, setClientToDelete] = useState<Client | null>(null);
  const [deleting, setDeleting] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => { setNavigating(false); }, [pathname]);

  // Initialize collapsed state: localStorage if set, otherwise path-based default
  useEffect(() => {
    const stored = localStorage.getItem('sl-sidebar-collapsed');
    if (stored !== null) {
      setCollapsed(stored === 'true');
    } else {
      setCollapsed(shouldDefaultCollapsed(pathname));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-collapse when navigating to collapse-default pages (only if not manually set)
  useEffect(() => {
    const stored = localStorage.getItem('sl-sidebar-collapsed');
    if (stored === null && shouldDefaultCollapsed(pathname)) {
      setCollapsed(true);
    }
  }, [pathname]);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('sl-sidebar-collapsed', String(next));
    window.dispatchEvent(new CustomEvent('sl-sidebar-toggle', { detail: next }));
  }

  // Parse selected client from pathname
  const clientMatch = pathname.match(/^\/clients\/([^/]+)/);
  const selectedClientId = clientMatch?.[1] || null;
  const selectedClient = clients.find((c) => c.id === selectedClientId) || null;

  const isAdmin   = session?.user?.role === 'admin';
  const isViewer  = session?.user?.role === 'viewer';
  const userPlan  = session?.user?.plan ?? 'free';
  // Show multi-client dropdown only for admins or plans that allow > 1 client
  const multiClientEnabled = isAdmin || (PLAN_LIMITS[userPlan]?.clients ?? 1) > 1;
  // Fetch clients on mount
  useEffect(() => {
    fetch('/api/clients')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setClients(data.map((c: Record<string, unknown>) => ({ id: c.id as string, name: c.name as string, slug: c.slug as string })));
        }
      })
      .catch(() => {})
      .finally(() => setClientsLoaded(true));
  }, []);

  // Single-client users: auto-navigate into their client workspace from global routes
  useEffect(() => {
    if (!multiClientEnabled && clients.length > 0) {
      const clientId = clients[0].id;
      if (pathname === '/dashboard') router.replace(`/clients/${clientId}/pages`);
      else if (pathname === '/domains') router.replace(`/clients/${clientId}/domains`);
      else if (pathname === '/pages') router.replace(`/clients/${clientId}/pages`);
      else if (pathname === '/scripts') router.replace(`/clients/${clientId}/scripts`);
      else if (pathname === '/settings') router.replace(`/clients/${clientId}/settings`);
    }
  }, [multiClientEnabled, clients, pathname, router]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const effectiveClient = selectedClient ?? (!multiClientEnabled && clients.length > 0 ? clients[0] : null);

  const navItems = effectiveClient
    ? getClientNavItems(effectiveClient.id, isViewer)
    : globalNavItems.filter(item => {
        if (item.href === '/team'    && isViewer)  return false; // not for viewers
        if (item.href === '/billing' && isViewer)  return false; // not for viewers
        return true;
      });

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === '/dashboard';
    // Exact match for routes that are prefixes of others
    if (href.endsWith('/pages') && !href.endsWith('/pages/new')) {
      return pathname === href;
    }
    return pathname.startsWith(href);
  }

  function selectClient(client: Client | null) {
    setDropdownOpen(false);
    setNavigating(true);
    if (client) {
      // Navigate to equivalent client-scoped route
      if (pathname.includes('/pages')) {
        router.push(`/clients/${client.id}/pages`);
      } else if (pathname.includes('/scripts')) {
        router.push(`/clients/${client.id}/scripts`);
      } else if (pathname.includes('/domains')) {
        router.push(`/clients/${client.id}/domains`);
      } else if (pathname.includes('/settings')) {
        router.push(`/clients/${client.id}/settings`);
      } else {
        router.push(`/clients/${client.id}/pages`);
      }
    } else {
      // All Clients
      if (pathname.includes('/pages')) {
        router.push('/pages');
      } else if (pathname.includes('/scripts')) {
        router.push('/scripts');
      } else if (pathname.includes('/domains')) {
        router.push('/domains');
      } else if (pathname.includes('/settings')) {
        router.push('/settings');
      } else {
        router.push('/dashboard');
      }
    }
  }

  async function handleCreateClient(e: React.FormEvent) {
    e.preventDefault();
    if (!newClientName.trim()) return;
    setCreating(true);
    setCreateClientError(null);
    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newClientName.trim(), slug: slugify(newClientName.trim()) }),
      });
      if (!res.ok) {
        const err = await res.json();
        const msg = err.error || 'Failed to create client';
        toast.error(msg);
        setCreateClientError({ message: msg, isLimit: !!err.limitError });
        return;
      }
      const client = await res.json();
      setClients((prev) => [{ id: client.id, name: client.name, slug: client.slug }, ...prev]);
      setCreateModalOpen(false);
      setNewClientName('');
      setCreateClientError(null);
      setDropdownOpen(false);
      toast.success(`Client "${client.name}" created`);
      router.push(`/clients/${client.id}/pages`);
    } catch {
      const msg = 'An unexpected error occurred';
      toast.error(msg);
      setCreateClientError({ message: msg, isLimit: false });
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteClient() {
    if (!clientToDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/clients/${clientToDelete.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to delete client');
        return;
      }
      const deletedId = clientToDelete.id;
      setClients((prev) => prev.filter((c) => c.id !== deletedId));
      toast.success(`Client "${clientToDelete.name}" deleted`);
      setClientToDelete(null);
      // If we were viewing the deleted client, navigate back to All Clients
      if (selectedClientId === deletedId) {
        router.push('/dashboard');
      }
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <aside className={cn(
      'min-h-screen bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col relative transition-all duration-200 flex-shrink-0',
      collapsed ? 'w-16' : 'w-60'
    )}>
      {/* Toggle button */}
      <button
        onClick={toggleCollapsed}
        className="absolute -right-3 top-6 z-10 w-6 h-6 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center shadow-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed
          ? <ChevronRight size={12} className="text-slate-500 dark:text-slate-400" />
          : <ChevronLeft size={12} className="text-slate-500 dark:text-slate-400" />
        }
      </button>

      {/* Logo */}
      <div className={cn('h-20 flex items-center border-b border-slate-200 dark:border-slate-800 overflow-hidden', collapsed ? 'px-3 justify-center' : 'px-5')}>
        <Link href="/dashboard" className="flex items-center">
          {collapsed ? (
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">S</div>
          ) : (
            <>
              <img src="/splitlab-logo-light.png" alt="SplitLab" className="dark:hidden" style={{ height: '80px', width: 'auto' }} />
              <img src="/splitlab-logo-dark.png" alt="SplitLab" className="hidden dark:block" style={{ height: '80px', width: 'auto' }} />
            </>
          )}
        </Link>
      </div>

      {/* Client Dropdown / Static label */}
      <div className={cn('pt-4 pb-2', collapsed ? 'px-2' : 'px-3')} ref={dropdownRef}>
        {multiClientEnabled ? (
          <>
            <button
              onClick={() => { if (!collapsed) setDropdownOpen(!dropdownOpen); else toggleCollapsed(); }}
              title={collapsed ? (selectedClient?.name ?? 'All Clients') : undefined}
              className={cn(
                'w-full flex items-center gap-2 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 transition-colors text-sm',
                collapsed ? 'px-2 py-2 justify-center' : 'px-3 py-2'
              )}
            >
              <Building2 size={14} className="text-slate-500 dark:text-slate-400 flex-shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1 text-left text-slate-800 dark:text-slate-200 truncate">
                    {selectedClient ? selectedClient.name : 'All Clients'}
                  </span>
                  {navigating
                    ? <Spinner size="sm" className="text-slate-400" />
                    : <ChevronDown size={14} className={cn('text-slate-400 dark:text-slate-500 transition-transform flex-shrink-0', dropdownOpen && 'rotate-180')} />
                  }
                </>
              )}
            </button>

            {dropdownOpen && !collapsed && (
              <div className="mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden shadow-xl z-50 relative">
                {/* All Clients option */}
                <button
                  onClick={() => selectClient(null)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors',
                    !selectedClient
                      ? 'text-indigo-400 bg-indigo-600/10'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                  )}
                >
                  <LayoutDashboard size={13} className="flex-shrink-0" />
                  <span className="flex-1 text-left">{isAdmin ? 'All Clients' : 'My Clients'}</span>
                  {!selectedClient && <Check size={13} className="text-indigo-400" />}
                </button>

                {/* Divider */}
                <div className="border-t border-slate-200 dark:border-slate-700" />

                {/* Client list */}
                <div className="max-h-48 overflow-y-auto">
                  {clients.map((client) => (
                    <div
                      key={client.id}
                      className={cn(
                        'group w-full flex items-center transition-colors',
                        selectedClientId === client.id
                          ? 'text-indigo-400 bg-indigo-600/10'
                          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                      )}
                    >
                      <button
                        onClick={() => selectClient(client)}
                        className="flex-1 min-w-0 flex items-center gap-2 pl-3 pr-1 py-2 text-sm"
                      >
                        <Building2 size={13} className="flex-shrink-0" />
                        <span className="flex-1 text-left truncate">{client.name}</span>
                        {selectedClientId === client.id && <Check size={13} className="text-indigo-400 flex-shrink-0" />}
                      </button>
                      {!isViewer && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setClientToDelete(client); }}
                          title="Delete client"
                          className="flex-shrink-0 p-2 mr-1 rounded text-slate-400 opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-500/10 transition-all"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {/* New Client button */}
                <div className="border-t border-slate-200 dark:border-slate-700">
                  <button
                    onClick={() => { setCreateModalOpen(true); setDropdownOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                  >
                    <Plus size={13} />
                    New Client
                  </button>
                </div>
              </div>
            )}
          </>
        ) : !clientsLoaded ? (
          /* Skeleton while clients load */
          <div className={cn('flex items-center gap-2 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700', collapsed ? 'px-2 py-2 justify-center' : 'px-3 py-2')}>
            <div className="w-4 h-4 rounded bg-slate-200 dark:bg-slate-700 animate-pulse flex-shrink-0" />
            {!collapsed && <div className="h-3 rounded bg-slate-200 dark:bg-slate-700 animate-pulse flex-1" />}
          </div>
        ) : (
          /* Static account label for single-client plans (free / pro) */
          <div
            title={collapsed ? (selectedClient?.name ?? clients[0]?.name ?? 'My Account') : undefined}
            className={cn('flex items-center gap-2 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm', collapsed ? 'px-2 py-2 justify-center' : 'px-3 py-2')}
          >
            <Building2 size={14} className="text-slate-500 dark:text-slate-400 flex-shrink-0" />
            {!collapsed && (
              <>
                <span className="flex-1 text-left text-slate-800 dark:text-slate-200 truncate">
                  {selectedClient ? selectedClient.name : (clients[0]?.name ?? 'My Account')}
                </span>
                {navigating && <Spinner size="sm" className="text-slate-400" />}
              </>
            )}
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className={cn('flex-1 py-2 space-y-0.5', collapsed ? 'px-2' : 'px-3')}>
        {!clientsLoaded && !multiClientEnabled ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className={cn('flex items-center rounded-lg', collapsed ? 'px-2 py-2 justify-center' : 'gap-3 px-3 py-2')}>
              <div className="w-4 h-4 rounded bg-slate-200 dark:bg-slate-700 animate-pulse flex-shrink-0" />
              {!collapsed && <div className="h-3 rounded bg-slate-200 dark:bg-slate-700 animate-pulse" style={{ width: `${55 + (i % 3) * 15}%` }} />}
            </div>
          ))
        ) : (
          navItems.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              title={collapsed ? label : undefined}
              className={cn(
                'flex items-center rounded-lg text-sm font-medium transition-colors',
                collapsed ? 'px-2 py-2 justify-center' : 'gap-3 px-3 py-2',
                isActive(href)
                  ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-600/30'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
              )}
            >
              <Icon size={16} className="flex-shrink-0" />
              {!collapsed && label}
            </Link>
          ))
        )}
      </nav>

      {/* User menu */}
      <div className={cn('py-3 border-t border-slate-200 dark:border-slate-800', collapsed ? 'px-2' : 'px-3')}>
        <button
          onClick={() => setUserMenuOpen(!userMenuOpen)}
          title={collapsed ? (session?.user?.name || 'User') : undefined}
          className={cn('w-full flex items-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors', collapsed ? 'px-2 py-2 justify-center' : 'gap-3 px-3 py-2')}
        >
          <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
            {session?.user?.name?.[0]?.toUpperCase() || 'U'}
          </div>
          {!collapsed && (
            <>
              <div className="flex-1 text-left min-w-0">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
                  {session?.user?.name || 'User'}
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500 capitalize truncate">
                  {session?.user?.role === 'viewer' ? 'Member' : (session?.user?.role || 'member')}
                </p>
              </div>
              <ChevronDown size={14} className="text-slate-400 dark:text-slate-500 flex-shrink-0" />
            </>
          )}
        </button>

        {userMenuOpen && (
          <div className={cn(
            'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden shadow-xl',
            collapsed
              ? 'absolute bottom-16 left-2 w-48 z-50'
              : 'mt-1'
          )}>
            {/* Current plan + upgrade — hidden for invited members (viewers) */}
            {!isViewer && (
              <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between gap-2">
                <span className="text-xs text-slate-500 dark:text-slate-400 capitalize">
                  {userPlan} plan
                </span>
                {!isAdmin && (
                  <Link
                    href="/billing"
                    onClick={() => setUserMenuOpen(false)}
                    className="text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    {userPlan === 'free' ? 'Upgrade' : 'Manage plan'}
                  </Link>
                )}
              </div>
            )}
            {mounted && (
              <button
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              >
                {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
                {theme === 'dark' ? 'Light mode' : 'Dark mode'}
              </button>
            )}
            <button
              onClick={() => signOut({ callbackUrl: '/login' })}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            >
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        )}
      </div>

      {/* Create Client Modal */}
      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => { setCreateModalOpen(false); setCreateClientError(null); }}>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-6 w-full max-w-sm mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-4">New Client</h3>
            <form onSubmit={handleCreateClient} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Client Name</label>
                <input
                  type="text"
                  value={newClientName}
                  onChange={(e) => setNewClientName(e.target.value)}
                  className="input-base"
                  placeholder="Acme Corp"
                  autoFocus
                  required
                />
              </div>
              {createClientError && (
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2.5 text-sm text-red-400">
                  {createClientError.message}
                  {createClientError.isLimit && (
                    <a href="/billing" className="block mt-1 text-indigo-400 underline underline-offset-2 text-xs font-medium">Upgrade Plan</a>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => { setCreateModalOpen(false); setCreateClientError(null); }} className="btn-secondary text-sm">Cancel</button>
                <button type="submit" disabled={creating} className="btn-primary text-sm">
                  {creating ? <><Spinner />Creating…</> : 'Create Client'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Client Modal */}
      {clientToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => !deleting && setClientToDelete(null)}>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-6 w-full max-w-sm mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">Delete Client</h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-1">
              Are you sure you want to delete <span className="font-medium text-slate-900 dark:text-slate-100">{clientToDelete.name}</span>?
            </p>
            <p className="text-sm text-red-400 mb-5">
              This permanently removes all workspaces, pages, tests, and data for this client. This cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setClientToDelete(null)} disabled={deleting} className="btn-secondary text-sm">Cancel</button>
              <button
                type="button"
                onClick={handleDeleteClient}
                disabled={deleting}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors disabled:opacity-60"
              >
                {deleting ? <><Spinner />Deleting…</> : 'Delete Client'}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
