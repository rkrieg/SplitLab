export default function BillingLoading() {
  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="h-8 w-48 bg-slate-200 dark:bg-slate-700 rounded-lg animate-pulse" />
      <div className="card p-6 space-y-4">
        <div className="h-5 w-32 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
        <div className="h-4 w-64 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
        <div className="grid grid-cols-2 gap-3 mt-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-4 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
          ))}
        </div>
      </div>
      <div className="card p-6 space-y-3">
        <div className="h-5 w-40 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-4 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
        ))}
      </div>
    </div>
  );
}
