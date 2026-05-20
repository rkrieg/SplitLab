import { Loader2 } from 'lucide-react';

export default function DashboardLoading() {
  return (
    <div className="flex-1 flex items-center justify-center min-h-[60vh]">
      <Loader2 className="w-7 h-7 text-indigo-500 animate-spin" />
    </div>
  );
}
