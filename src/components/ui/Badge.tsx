import { cn } from '@/lib/utils';

type BadgeVariant =
  | 'default'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'purple';

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

const variants: Record<BadgeVariant, string> = {
  default: 'bg-slate-700 text-slate-300',
  success: 'bg-green-500/20 text-green-400 border border-green-500/30',
  warning: 'bg-amber-500/20 text-amber-400 border border-amber-500/30',
  danger: 'bg-red-500/20 text-red-400 border border-red-500/30',
  info: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  purple: 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30',
};

export default function Badge({
  variant = 'default',
  children,
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        'badge',
        variants[variant],
        className
      )}
    >
      {children}
    </span>
  );
}

export function TestStatusBadge({ status }: { status: string }) {
  const map: Record<string, BadgeVariant> = {
    draft: 'default',
    active: 'success',
    paused: 'warning',
    completed: 'info',
  };
  return <Badge variant={map[status] || 'default'}>{status}</Badge>;
}
