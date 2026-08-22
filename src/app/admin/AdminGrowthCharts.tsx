'use client';

import {
  ResponsiveContainer, ComposedChart, Area, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

export interface GrowthPoint {
  label: string;      // e.g. "Aug 1"
  newUsers: number;   // signups that day
  cumulative: number; // total users through that day
}

export default function AdminGrowthCharts({ data }: { data: GrowthPoint[] }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
      <h2 className="text-sm font-semibold mb-4">User growth (last 90 days)</h2>
      <div style={{ width: '100%', height: 280 }}>
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 5, right: 8, left: -12, bottom: 0 }}>
            <defs>
              <linearGradient id="cumFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" strokeOpacity={0.4} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} interval="preserveStartEnd" minTickGap={28} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} />
            <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} allowDecimals={false} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
              labelStyle={{ fontWeight: 600 }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area yAxisId="right" type="monotone" dataKey="cumulative" name="Total users" stroke="#6366f1" strokeWidth={2} fill="url(#cumFill)" />
            <Bar yAxisId="left" dataKey="newUsers" name="New signups" fill="#22c55e" radius={[3, 3, 0, 0]} maxBarSize={14} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
