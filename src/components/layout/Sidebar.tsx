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
  Plus,
  Check,
  Sun,
  Moon,
  Globe,
  CreditCard,
  Trash2,
  Gift,
} from 'lucide-react';
import { cn, slugify } from '@/lib/utils';
import { PLAN_LIMITS } from '@/lib/plans';
import { useState, useEffect, useRef } from 'react';
import { useTheme } from 'next-themes';
import toast from 'react-hot-toast';
import Spinner from '@/components/ui/Spinner';

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
  { href: '/affiliates',label: 'Affiliates',icon: Gift },
  { href: '/settings',  label: 'Settings',  icon: Settings },
];

function getClientNavItems(clientId: string, isViewer: boolean) {
  const items = [
    { href: `/clients/${clientId}/pages`,    label: 'Pages',    icon: FileCode2 },
    { href: `/clients/${clientId}/scripts`,  label: 'Scripts',  icon: Code2 },
    { href: `/clients/${clientId}/domains`,  label: 'Domains',  icon: Globe },
    { href: '/team',                         label: 'Team',     icon: Users },
    { href: '/billing',                      label: 'Billing',  icon: CreditCard },
    { href: `/clients/${clientId}/settings`, label: 'Settings', icon: Settings },
  ];
  return isViewer ? items.filter(i => i.href !== '/billing' && i.href !== '/team') : items;
}

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
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
        if (item.href === '/team'       && isViewer) return false; // not for viewers
        if (item.href === '/billing'    && isViewer) return false; // not for viewers
        if (item.href === '/affiliates' && !isAdmin) return false; // admin-only
        return true;
      });

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === '/dashboard';
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
    <aside className="w-60 min-h-screen bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col">
      {/* Logo */}
      <div className="h-20 flex items-center px-5 border-b border-slate-200 dark:border-slate-800">
        <Link href="/dashboard" className="flex items-center">
          {/* <svg width="140" height="32" ...>...</svg> */}
          <img src="/splitlab-logo-light.png" alt="SplitLab" className="dark:hidden" style={{ height: '80px', width: 'auto' }} />
          <img src="/splitlab-logo-dark.png" alt="SplitLab" className="hidden dark:block" style={{ height: '80px', width: 'auto' }} />
        </Link>
      </div>

      {/* Client Dropdown / Static label */}
      <div className="px-3 pt-4 pb-2" ref={dropdownRef}>
        {multiClientEnabled ? (
          <>
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 transition-colors text-sm"
            >
              <Building2 size={14} className="text-slate-500 dark:text-slate-400 flex-shrink-0" />
              <span className="flex-1 text-left text-slate-800 dark:text-slate-200 truncate">
                {selectedClient ? selectedClient.name : 'All Clients'}
              </span>
              {navigating
                ? <Spinner size="sm" className="text-slate-400" />
                : <ChevronDown size={14} className={cn('text-slate-400 dark:text-slate-500 transition-transform flex-shrink-0', dropdownOpen && 'rotate-180')} />
              }
            </button>

            {dropdownOpen && (
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
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
            <div className="w-4 h-4 rounded bg-slate-200 dark:bg-slate-700 animate-pulse flex-shrink-0" />
            <div className="h-3 rounded bg-slate-200 dark:bg-slate-700 animate-pulse flex-1" />
          </div>
        ) : (
          /* Static account label for single-client plans (free / pro) */
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm">
            <Building2 size={14} className="text-slate-500 dark:text-slate-400 flex-shrink-0" />
            <span className="flex-1 text-left text-slate-800 dark:text-slate-200 truncate">
              {selectedClient ? selectedClient.name : (clients[0]?.name ?? 'My Account')}
            </span>
            {navigating && <Spinner size="sm" className="text-slate-400" />}
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-2 space-y-0.5">
        {!clientsLoaded && !multiClientEnabled ? (
          // Show skeleton while clients load to prevent Dashboard flash
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2 rounded-lg">
              <div className="w-4 h-4 rounded bg-slate-200 dark:bg-slate-700 animate-pulse flex-shrink-0" />
              <div className="h-3 rounded bg-slate-200 dark:bg-slate-700 animate-pulse" style={{ width: `${55 + (i % 3) * 15}%` }} />
            </div>
          ))
        ) : (
          navItems.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                isActive(href)
                  ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-600/30'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
              )}
            >
              <Icon size={16} className="flex-shrink-0" />
              {label}
            </Link>
          ))
        )}
      </nav>

      {/* User menu */}
      <div className="px-3 py-3 border-t border-slate-200 dark:border-slate-800">
        <button
          onClick={() => setUserMenuOpen(!userMenuOpen)}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        >
          <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
            {session?.user?.name?.[0]?.toUpperCase() || 'U'}
          </div>
          <div className="flex-1 text-left min-w-0">
            <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
              {session?.user?.name || 'User'}
            </p>
            <p className="text-xs text-slate-400 dark:text-slate-500 capitalize truncate">
              {session?.user?.role === 'viewer' ? 'Member' : (session?.user?.role || 'member')}
            </p>
          </div>
          <ChevronDown size={14} className="text-slate-400 dark:text-slate-500 flex-shrink-0" />
        </button>

        {userMenuOpen && (
          <div className="mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
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
