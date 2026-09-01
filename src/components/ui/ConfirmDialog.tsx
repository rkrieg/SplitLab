'use client';

import Modal from './Modal';
import Button from './Button';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  /** Danger by default — traffic-split changes use 'primary' instead. */
  confirmVariant?: 'primary' | 'danger';
  /** Blocks confirming, e.g. when the change can't be applied as asked. */
  confirmDisabled?: boolean;
  /** Extra detail under the description — a traffic-split before/after table. */
  children?: React.ReactNode;
  loading?: boolean;
}

export default function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Delete',
  confirmVariant = 'danger',
  confirmDisabled = false,
  children,
  loading = false,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <p className="text-slate-500 dark:text-slate-400 text-sm mb-4">{description}</p>
      {children && <div className="mb-6">{children}</div>}
      <div className="flex items-center justify-end gap-3">
        <Button variant="secondary" onClick={onClose} disabled={loading}>
          Cancel
        </Button>
        <Button variant={confirmVariant} onClick={onConfirm} loading={loading} disabled={confirmDisabled}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
