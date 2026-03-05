'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut, useSession } from 'next-auth/react';
import {
  LayoutDashboard,
  Building2,
  FlaskConical,
  FileCode2,
  Code2,
  Users,
  Settings,
  LogOut,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState } from 'react';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/clients', label: 'Clients', icon: Building2 },
  { href: '/tests', label: 'Tests', icon: FlaskConical },
  { href: '/pages', label: 'Pages', icon: FileCode2 },
  { href: '/scripts', label: 'Scripts', icon: Code2 },
  { href: '/team', label: 'Team', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === '/dashboard';
    return pathname.startsWith(href);
  }

  return (
    <aside className="w-60 min-h-screen bg-slate-900 border-r border-slate-800 flex flex-col">
      {/* Logo */}
      <div className="h-16 flex items-center px-5 border-b border-slate-800">
        <Link href="/dashboard" className="flex items-center">
          <svg width="140" height="32" viewBox="0 0 220 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="18" cy="24" r="16" fill="#3D8BDA" opacity="0.15"/>
            <circle cx="18" cy="24" r="14" stroke="#3D8BDA" strokeWidth="1.5"/>
            <path d="M20 12L13 26H18L15 36L24 22H19L20 12Z" fill="#3D8BDA"/>
            <text x="42" y="21" fontFamily="system-ui, sans-serif" fontWeight="700" fontSize="24" fill="white" letterSpacing="-0.5">Split</text>
            <text x="106" y="21" fontFamily="system-ui, sans-serif" fontWeight="600" fontSize="24" fill="#3D8BDA" letterSpacing="-0.5">Lab</text>
          </svg>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {navItems.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
              isActive(href)
                ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-600/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            )}
          >
            <Icon size={16} className="flex-shrink-0" />
            {label}
          </Link>
        ))}
      </nav>

      {/* User menu */}
      <div className="px-3 py-3 border-t border-slate-800">
        <button
          onClick={() => setUserMenuOpen(!userMenuOpen)}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-800 transition-colors"
        >
          <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
            {session?.user?.name?.[0]?.toUpperCase() || 'U'}
          </div>
          <div className="flex-1 text-left min-w-0">
            <p className="text-sm font-medium text-slate-200 truncate">
              {session?.user?.name || 'User'}
            </p>
            <p className="text-xs text-slate-500 capitalize truncate">
              {session?.user?.role || 'viewer'}
            </p>
          </div>
          <ChevronDown size={14} className="text-slate-500 flex-shrink-0" />
        </button>

        {userMenuOpen && (
          <div className="mt-1 bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
            <button
              onClick={() => signOut({ callbackUrl: '/login' })}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors"
            >
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
