'use client';

import { useState, useCallback } from 'react';
import type { UpgradeModalProps } from '@/components/upgrade/UpgradeModal';
import type { PlanId } from '@/lib/plans';

interface PlanLimitError {
  error: 'plan_limit_exceeded';
  limitType: string;
  current: number;
  max: number;
  plan: PlanId;
  planName: string;
  message: string;
}

export function isPlanLimitError(data: unknown): data is PlanLimitError {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as PlanLimitError).error === 'plan_limit_exceeded'
  );
}

export function usePlanLimit() {
  const [modalProps, setModalProps] = useState<Omit<UpgradeModalProps, 'isOpen' | 'onClose'> | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const handleLimitError = useCallback((data: PlanLimitError) => {
    setModalProps({
      limitType: data.limitType,
      current: data.current,
      max: data.max,
      plan: data.plan,
      planName: data.planName,
      message: data.message,
    });
    setIsOpen(true);
  }, []);

  const closeModal = useCallback(() => setIsOpen(false), []);

  async function guardedFetch(
    input: RequestInfo,
    init?: RequestInit
  ): Promise<Response> {
    const res = await fetch(input, init);
    if (res.status === 403) {
      const cloned = res.clone();
      try {
        const data = await cloned.json();
        if (isPlanLimitError(data)) {
          handleLimitError(data);
        }
      } catch {
      }
    }
    return res;
  }

  return {
    guardedFetch,
    isOpen,
    modalProps,
    closeModal,
    handleLimitError,
  };
}
