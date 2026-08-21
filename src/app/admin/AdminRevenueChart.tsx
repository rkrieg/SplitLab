'use client';

import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

export interface RevenuePointDollars {
  label: string;
  collected: number; // dollars collected that month
  mrr: number;       // recurring revenue (dollars) active that month
}

export default function AdminRevenueChart({ data, available }: { data: RevenuePointDollars[]; available: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
      <h2 className="text-sm font-semibold mb-4">Revenue &amp; MRR (last 12 months)</h2>
      {!available ? (
        <p className="text-sm text-slate-400 py-10 text-center">
          Stripe isn&apos;t configured in this environment, so revenue can&apos;t be loaded here. It will populate on staging/production where the Stripe key is set.
        </p>
      ) : (
        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer>
            <ComposedChart data={data} margin={{ top: 5, right: 8, left: -4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" strokeOpacity={0.4} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} minTickGap={16} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} />
              <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `$${v.toLocaleString()}`} />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
                labelStyle={{ fontWeight: 600 }}
                formatter={(v: number, name: string) => [`$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, name]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="collected" name="Collected" fill="#22c55e" radius={[3, 3, 0, 0]} maxBarSize={22} />
              <Line type="monotone" dataKey="mrr" name="MRR (active)" stroke="#6366f1" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
