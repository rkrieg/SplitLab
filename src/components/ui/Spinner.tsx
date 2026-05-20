// Inline/button-level spinner. Use Loader2 (lucide) only for page-level Suspense fallbacks.
import { cn } from '@/lib/utils';

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizes = {
  sm: 'w-3 h-3 border-[1.5px]',
  md: 'w-4 h-4 border-2',
  lg: 'w-5 h-5 border-2',
};

export default function Spinner({ size = 'md', className }: SpinnerProps) {
  return (
    <span
      className={cn(
        'inline-block border-current border-t-transparent rounded-full animate-spin flex-shrink-0',
        sizes[size],
        className
      )}
    />
  );
}
