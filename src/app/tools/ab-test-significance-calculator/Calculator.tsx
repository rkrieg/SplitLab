'use client';

import { useState } from 'react';
import { confidencePercent } from '@/lib/stats';

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{label}</span>
      <input
        type="number"
        min="0"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#3D8BDA]"
      />
    </label>
  );
}

export default function Calculator() {
  const [cv, setCv] = useState('1000');   // control visitors
  const [cc, setCc] = useState('100');    // control conversions
  const [vv, setVv] = useState('1000');   // variant visitors
  const [vc, setVc] = useState('130');    // variant conversions

  const n = (s: string) => Math.max(0, Math.floor(Number(s) || 0));
  const controlV = n(cv), controlC = Math.min(n(cc), n(cv)), variantV = n(vv), variantC = Math.min(n(vc), n(vv));

  const controlRate = controlV > 0 ? (controlC / controlV) * 100 : 0;
  const variantRate = variantV > 0 ? (variantC / variantV) * 100 : 0;
  const uplift = controlRate > 0 ? ((variantRate - controlRate) / controlRate) * 100 : 0;
  const confidence = confidencePercent(controlV, controlC, variantV, variantC);
  const significant = confidence >= 95;
  const enoughData = controlV > 0 && variantV > 0;

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-3">
          <p className="text-sm font-semibold">Control (A)</p>
          <Field label="Visitors" value={cv} onChange={setCv} />
          <Field label="Conversions" value={cc} onChange={setCc} />
          <p className="text-xs text-slate-500 dark:text-slate-400">Conversion rate: <strong>{controlRate.toFixed(2)}%</strong></p>
        </div>
        <div className="space-y-3">
          <p className="text-sm font-semibold">Variant (B)</p>
          <Field label="Visitors" value={vv} onChange={setVv} />
          <Field label="Conversions" value={vc} onChange={setVc} />
          <p className="text-xs text-slate-500 dark:text-slate-400">Conversion rate: <strong>{variantRate.toFixed(2)}%</strong></p>
        </div>
      </div>

      <div className={`mt-6 rounded-lg p-4 text-center ${!enoughData ? 'bg-slate-100 dark:bg-slate-800' : significant ? 'bg-green-500/10 border border-green-500/30' : 'bg-amber-500/10 border border-amber-500/30'}`}>
        {!enoughData ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">Enter visitors and conversions for both variants.</p>
        ) : (
          <>
            <p className="text-3xl font-bold tabular-nums">
              {confidence.toFixed(1)}%
              <span className="text-sm font-medium text-slate-500 dark:text-slate-400"> confidence</span>
            </p>
            <p className={`mt-1 text-sm font-semibold ${significant ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}`}>
              {significant
                ? `Statistically significant — Variant B is ${uplift >= 0 ? 'up' : 'down'} ${Math.abs(uplift).toFixed(1)}%`
                : 'Not yet significant — keep the test running'}
            </p>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {significant
                ? 'You can be 95%+ confident this result is not due to chance.'
                : 'Below 95% confidence. Collect more data before calling a winner; early leads often reverse.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
