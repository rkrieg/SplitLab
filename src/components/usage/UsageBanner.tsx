'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, TrendingUp, Users, FlaskConical, Building2, ArrowRight } from 'lucide-react';
import Link from 'next/link';

interface UsageStat {
  used: number;
  limit: number;
  pct: number;
  limitLabel: string;
}

interface UsageData {
  plan: string;
  planName: string;
  visitors: UsageStat;
  tests: UsageStat;
  clients: UsageStat;
  seats: UsageStat;
}

function MeterBar({ pct, limit }: { pct: number; limit: number }) {
  const isUnlimited = limit === Infinity || limit > 999_999_999;
  if (isUnlimited) return (
    <div className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
      <div className="h-full bg-green-500 rounded-full" style={{ width: '10%' }} />
    </div>
  );
  const color = pct >= 100 ? 'bg-red-500' : pct >= 90 ? 'bg-red-400' : pct >= 70 ? 'bg-amber-400' : 'bg-green-500';
  return (
    <div className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
      <div className={`h-full ${color} rounded-full transition-all duration-500`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

export default function UsageBanner() {
  const [usage, setUsage] = useState<UsageData | null>(null);

  useEffect(() => {
    fetch('/api/usage')
      .then((r) => r.json())
      .then(setUsage)
      .catch(() => {});
  }, []);

  if (!usage) return null;

  const visitorPct = usage.visitors.pct;
  const isAtLimit = visitorPct >= 100;
  const isNearLimit = visitorPct >= 90;
  const isWarning = visitorPct >= 70;

  const bannerBg = isAtLimit
    ? 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30'
    : isNearLimit
    ? 'bg-orange-50 dark:bg-orange-500/10 border-orange-200 dark:border-orange-500/30'
    : isWarning
    ? 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30'
    : null;

  const iconColor = isAtLimit
    ? 'text-red-500'
    : isNearLimit
    ? 'text-orange-500'
    : 'text-amber-500';

  return (
    <div className="space-y-3">
      {/* Warning banner when near/at limit */}
      {bannerBg && (
        <div className={`rounded-xl border p-4 flex items-start gap-3 ${bannerBg}`}>
          <AlertTriangle size={16} className={`mt-0.5 flex-shrink-0 ${iconColor}`} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {isAtLimit
                ? '🚨 Visitor limit reached — tests are paused'
                : isNearLimit
                ? `⚠️ Almost at your visitor limit (${visitorPct}% used)`
                : `Heads up — you've used ${visitorPct}% of your monthly visitors`}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {isAtLimit
                ? 'Your A/B tests have stopped serving traffic. Upgrade now to resume.'
                : 'Upgrade your plan to avoid your tests being paused mid-month.'}
            </p>
          </div>
          <Link
            href="/billing"
            className="flex-shrink-0 flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            Upgrade <ArrowRight size={12} />
          </Link>
        </div>
      )}

      {/* Usage meters */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">Plan Usage</span>
            <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 uppercase tracking-wide">{usage.planName}</span>
          </div>
          <Link href="/billing" className="text-xs text-indigo-500 dark:text-indigo-400 hover:underline">Upgrade →</Link>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
          {/* Visitors */}
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <TrendingUp size={11} className="text-slate-400" />
              <span className="text-[11px] text-slate-500 dark:text-slate-400">Visitors / mo</span>
            </div>
            <div className="flex items-center gap-2">
              <MeterBar pct={usage.visitors.pct} limit={usage.visitors.limit} />
              <span className="text-[11px] font-medium text-slate-700 dark:text-slate-300 whitespace-nowrap tabular-nums">
                {usage.visitors.limit > 999_999_999 ? `${usage.visitors.used.toLocaleString()} / ∞` : `${usage.visitors.used.toLocaleString()} / ${usage.visitors.limitLabel}`}
              </span>
            </div>
          </div>

          {/* Tests */}
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <FlaskConical size={11} className="text-slate-400" />
              <span className="text-[11px] text-slate-500 dark:text-slate-400">Active Tests</span>
            </div>
            <div className="flex items-center gap-2">
              <MeterBar pct={usage.tests.pct} limit={usage.tests.limit} />
              <span className="text-[11px] font-medium text-slate-700 dark:text-slate-300 whitespace-nowrap tabular-nums">
                {usage.tests.limit > 999_999_999 ? `${usage.tests.used} / ∞` : `${usage.tests.used} / ${usage.tests.limitLabel}`}
              </span>
            </div>
          </div>

          {/* Clients */}
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <Building2 size={11} className="text-slate-400" />
              <span className="text-[11px] text-slate-500 dark:text-slate-400">Clients</span>
            </div>
            <div className="flex items-center gap-2">
              <MeterBar pct={usage.clients.pct} limit={usage.clients.limit} />
              <span className="text-[11px] font-medium text-slate-700 dark:text-slate-300 whitespace-nowrap tabular-nums">
                {usage.clients.limit > 999_999_999 ? `${usage.clients.used} / ∞` : `${usage.clients.used} / ${usage.clients.limitLabel}`}
              </span>
            </div>
          </div>

          {/* Team Seats */}
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <Users size={11} className="text-slate-400" />
              <span className="text-[11px] text-slate-500 dark:text-slate-400">Team Seats</span>
            </div>
            <div className="flex items-center gap-2">
              <MeterBar pct={usage.seats.pct} limit={usage.seats.limit} />
              <span className="text-[11px] font-medium text-slate-700 dark:text-slate-300 whitespace-nowrap tabular-nums">
                {usage.seats.limit > 999_999_999 ? `${usage.seats.used} / ∞` : `${usage.seats.used} / ${usage.seats.limitLabel}`}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
