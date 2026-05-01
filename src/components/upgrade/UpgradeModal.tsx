'use client';

import { useEffect } from 'react';
import { PLANS, formatLimit, type PlanId } from '@/lib/plans';

export interface UpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  limitType: 'active_tests' | 'clients' | 'ai_generation' | string;
  current?: number;
  max?: number;
  plan?: PlanId;
  planName?: string;
  message?: string;
}

const LIMIT_META: Record<string, { icon: string; label: string }> = {
  active_tests: { icon: '🧪', label: 'Active Tests' },
  clients:      { icon: '🏢', label: 'Clients / Workspaces' },
  ai_generation:{ icon: '✨', label: 'AI Page Generation' },
};

const UPGRADE_PLANS: PlanId[] = ['pro', 'agency', 'scale'];

export default function UpgradeModal({
  isOpen,
  onClose,
  limitType,
  current,
  max,
  plan,
  planName,
  message,
}: UpgradeModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const meta = LIMIT_META[limitType] ?? { icon: '🚫', label: 'Feature' };
  const isUnlimited = max === undefined || max === Infinity || max === null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '20px',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: '#0f1117', border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '16px', padding: '36px', maxWidth: '480px', width: '100%',
        boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
        animation: 'upgradeIn .2s ease',
      }}>
        <style>{`@keyframes upgradeIn{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}`}</style>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
          <div style={{
            width: '48px', height: '48px', background: 'rgba(99,102,241,0.15)',
            border: '1px solid rgba(99,102,241,0.3)', borderRadius: '12px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px',
          }}>
            {meta.icon}
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'rgba(255,255,255,0.4)', fontSize: '20px', lineHeight: 1,
              padding: '4px',
            }}
          >✕</button>
        </div>

        <h2 style={{ color: '#fff', fontSize: '20px', fontWeight: 700, marginBottom: '8px' }}>
          {limitType === 'ai_generation' ? 'Upgrade to use AI Generation' : `${meta.label} limit reached`}
        </h2>

        <p style={{ color: 'rgba(255,255,255,0.55)', fontSize: '15px', lineHeight: 1.6, marginBottom: '24px' }}>
          {message ?? (
            limitType === 'ai_generation'
              ? `AI Page Generation is a paid feature. Upgrade your plan to start generating AI-powered variants.`
              : `Your ${planName ?? 'current'} plan includes ${isUnlimited ? 'unlimited' : formatLimit(max!)} ${meta.label.toLowerCase()}. Upgrade to unlock more.`
          )}
        </p>

        {!isUnlimited && typeof current === 'number' && typeof max === 'number' && max < Infinity && limitType !== 'ai_generation' && (
          <div style={{ marginBottom: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: 'rgba(255,255,255,0.4)', marginBottom: '6px' }}>
              <span>{meta.label}</span>
              <span>{current} / {formatLimit(max)}</span>
            </div>
            <div style={{ height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '99px', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: `${Math.min(100, (current / max) * 100)}%`,
                background: 'linear-gradient(90deg, #6366F1, #3D8BDA)',
                borderRadius: '99px',
              }} />
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '24px' }}>
          {UPGRADE_PLANS.map((p) => {
            const pl = PLANS[p];
            const isCurrent = p === plan;
            return (
              <div key={p} style={{
                border: `1px solid ${isCurrent ? 'rgba(99,102,241,0.6)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: '10px', padding: '12px 10px', textAlign: 'center',
                background: isCurrent ? 'rgba(99,102,241,0.08)' : 'transparent',
              }}>
                <div style={{ color: isCurrent ? '#818CF8' : 'rgba(255,255,255,0.6)', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                  {pl.name}
                </div>
                <div style={{ color: '#fff', fontSize: '18px', fontWeight: 700 }}>
                  ${pl.monthlyPrice}<span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>/mo</span>
                </div>
                <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: '11px', marginTop: '4px' }}>
                  {formatLimit(pl.maxActiveTests)} tests
                </div>
              </div>
            );
          })}
        </div>

        <a
          href="/#pricing"
          style={{
            display: 'block', textAlign: 'center', padding: '13px',
            background: 'linear-gradient(135deg, #6366F1, #3D8BDA)',
            color: '#fff', borderRadius: '10px', fontWeight: 600, fontSize: '15px',
            textDecoration: 'none', marginBottom: '10px',
          }}
        >
          View Pricing & Upgrade
        </a>
        <button
          onClick={onClose}
          style={{
            display: 'block', width: '100%', padding: '11px',
            background: 'transparent', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '10px', color: 'rgba(255,255,255,0.5)', cursor: 'pointer',
            fontSize: '14px',
          }}
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}
