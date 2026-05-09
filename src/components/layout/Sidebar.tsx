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
  Shield,
  type LucideIcon,
} from 'lucide-react';
import { cn, slugify } from '@/lib/utils';
import { useState, useEffect, useRef } from 'react';
import { useTheme } from 'next-themes';
import toast from 'react-hot-toast';
import { usePlanLimit, isPlanLimitError } from '@/hooks/usePlanLimit';
import UpgradeModal from '@/components/upgrade/UpgradeModal';

interface Client {
  id: string;
  name: string;
  slug: string;
}

interface NavItem { href: string; label: string; icon: LucideIcon; exact?: boolean; }

const globalNavItems: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/pages', label: 'Pages', icon: FileCode2 },
  { href: '/scripts', label: 'Scripts', icon: Code2 },
  { href: '/domains', label: 'Domains', icon: Globe },
  { href: '/team', label: 'Team', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
];

function getClientNavItems(clientId: string): NavItem[] {
  return [
    { href: `/clients/${clientId}/pages`, label: 'Pages', icon: FileCode2, exact: true },
    { href: `/clients/${clientId}/scripts`, label: 'Scripts', icon: Code2 },
    { href: `/clients/${clientId}/domains`, label: 'Domains', icon: Globe },
    { href: `/clients/${clientId}/settings`, label: 'Settings', icon: Settings },
  ];
}

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [clients, setClients] = useState<Client[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [creating, setCreating] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { guardedFetch, isOpen: limitModalOpen, modalProps: limitModalProps, closeModal: closeLimitModal } = usePlanLimit();

  useEffect(() => setMounted(true), []);

  // Parse selected client from pathname
  const clientMatch = pathname.match(/^\/clients\/([^/]+)/);
  const selectedClientId = clientMatch?.[1] || null;
  const selectedClient = clients.find((c) => c.id === selectedClientId) || null;

  // Fetch clients on mount
  useEffect(() => {
    fetch('/api/clients')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setClients(data.map((c: Record<string, unknown>) => ({ id: c.id as string, name: c.name as string, slug: c.slug as string })));
        }
      })
      .catch(() => {});
  }, []);

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

  const navItems = selectedClient
    ? getClientNavItems(selectedClient.id)
    : globalNavItems;

  function isActive(href: string, exact = false) {
    if (href === '/dashboard' || exact) return pathname === href;
    return pathname.startsWith(href);
  }

  function selectClient(client: Client | null) {
    setDropdownOpen(false);
    if (client) {
      // Navigate to the equivalent client-scoped route, preserving context
      if (pathname.includes('/domains')) {
        router.push(`/clients/${client.id}/domains`);
      } else if (pathname.includes('/scripts')) {
        router.push(`/clients/${client.id}/scripts`);
      } else if (pathname.includes('/settings')) {
        router.push(`/clients/${client.id}/settings`);
      } else {
        // pages, dashboard, team, or anything else → go to client pages
        router.push(`/clients/${client.id}/pages`);
      }
    } else {
      // Switch to All Clients — land on the matching global page
      if (pathname.includes('/domains')) {
        router.push('/domains');
      } else if (pathname.includes('/scripts')) {
        router.push('/scripts');
      } else if (pathname.includes('/settings')) {
        router.push('/settings');
      } else if (pathname.includes('/pages')) {
        router.push('/pages');
      } else {
        router.push('/dashboard');
      }
    }
  }

  async function handleCreateClient(e: React.FormEvent) {
    e.preventDefault();
    if (!newClientName.trim()) return;
    setCreating(true);
    try {
      const res = await guardedFetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newClientName.trim(), slug: slugify(newClientName.trim()) }),
      });
      if (!res.ok) {
        const err = await res.json();
        if (!isPlanLimitError(err)) toast.error(err.error || 'Failed to create client');
        setCreateModalOpen(false);
        return;
      }
      const client = await res.json();
      setClients((prev) => [{ id: client.id, name: client.name, slug: client.slug }, ...prev]);
      setCreateModalOpen(false);
      setNewClientName('');
      setDropdownOpen(false);
      toast.success(`Client "${client.name}" created`);
      router.push(`/clients/${client.id}/pages`);
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
    <aside className="w-60 min-h-screen bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col">
      {/* Logo */}
      <div className="h-16 flex items-center px-4 border-b border-slate-200 dark:border-slate-800">
        <Link href="/dashboard" className="flex items-center">
          <img src="/splitlab-logo-light.png" alt="SplitLab" className="dark:hidden" style={{height:'68px',width:'auto'}} />
          <img src="/splitlab-logo-dark.png" alt="SplitLab" className="hidden dark:block" style={{height:'68px',width:'auto'}} />
        </Link>
      </div>

      {/* Client Dropdown */}
      <div className="px-3 pt-4 pb-2" ref={dropdownRef}>
        <button
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 transition-colors text-sm"
        >
          <Building2 size={14} className="text-slate-500 dark:text-slate-400 flex-shrink-0" />
          <span className="flex-1 text-left text-slate-800 dark:text-slate-200 truncate">
            {selectedClient ? selectedClient.name : 'All Clients'}
          </span>
          <ChevronDown size={14} className={cn('text-slate-400 dark:text-slate-500 transition-transform flex-shrink-0', dropdownOpen && 'rotate-180')} />
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
              <span className="flex-1 text-left">All Clients</span>
              {!selectedClient && <Check size={13} className="text-indigo-400" />}
            </button>

            {/* Divider */}
            <div className="border-t border-slate-200 dark:border-slate-700" />

            {/* Client list */}
            <div className="max-h-48 overflow-y-auto">
              {clients.map((client) => (
                <button
                  key={client.id}
                  onClick={() => selectClient(client)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors',
                    selectedClientId === client.id
                      ? 'text-indigo-400 bg-indigo-600/10'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                  )}
                >
                  <Building2 size={13} className="flex-shrink-0" />
                  <span className="flex-1 text-left truncate">{client.name}</span>
                  {selectedClientId === client.id && <Check size={13} className="text-indigo-400" />}
                </button>
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
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-2 space-y-0.5">
        {navItems.map(({ href, label, icon: Icon, exact }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
              isActive(href, !!exact)
                ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-600/30'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
            )}
          >
            <Icon size={16} className="flex-shrink-0" />
            {label}
          </Link>
        ))}

        {/* Super Admin link */}
        {session?.user?.role === 'super_admin' && (
          <>
            <div className="pt-3 pb-1 px-3">
              <p className="text-xs font-semibold text-slate-400 dark:text-slate-600 uppercase tracking-wider">Super Admin</p>
            </div>
            <Link
              href="/admin"
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                isActive('/admin')
                  ? 'bg-amber-500/15 text-amber-500 border border-amber-500/30'
                  : 'text-amber-600 dark:text-amber-500 hover:bg-amber-500/10 hover:text-amber-500'
              )}
            >
              <Shield size={16} className="flex-shrink-0" />
              All Accounts
            </Link>
          </>
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
              {session?.user?.role || 'viewer'}
            </p>
          </div>
          <ChevronDown size={14} className="text-slate-400 dark:text-slate-500 flex-shrink-0" />
        </button>

        {userMenuOpen && (
          <div className="mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setCreateModalOpen(false)}>
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
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setCreateModalOpen(false)} className="btn-secondary text-sm">Cancel</button>
                <button type="submit" disabled={creating} className="btn-primary text-sm">
                  {creating ? 'Creating...' : 'Create Client'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </aside>
    {limitModalOpen && limitModalProps && (
      <UpgradeModal
        isOpen={limitModalOpen}
        onClose={closeLimitModal}
        {...limitModalProps}
      />
    )}
  </>
  );
}
