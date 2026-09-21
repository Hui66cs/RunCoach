import { useQuery } from '@tanstack/react-query';
import { listImportHistory } from '../imports-api.js';

export function ImportHistoryPanel() {
  const query = useQuery({ queryKey: ['imports', 'history'], queryFn: listImportHistory });
  if (query.isLoading) return <p className="text-slate-400">正在加载导入历史…</p>;
  if (query.isError) return <p className="text-red-400">{query.error.message}</p>;
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">导入历史</h2>
      {query.data?.jobs.map((job) => (
        <details key={job.jobId} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <summary className="cursor-pointer">
            <span className="font-medium">{job.originalFileName}</span>
            <span className="ml-3 text-sm text-slate-400">
              {job.sourceType} · {new Date(job.createdAt).toLocaleString()} · {job.status}
            </span>
            {job.requiresAction && (
              <span className="ml-2 rounded bg-amber-500/20 px-2 py-1 text-xs text-amber-300">
                待处理
              </span>
            )}
          </summary>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {Object.entries(job.counts).map(([outcome, count]) => (
              <span key={outcome} className="rounded bg-slate-950 px-2 py-1">
                {outcome}: {count}
              </span>
            ))}
          </div>
          <div className="mt-3 space-y-2">
            {job.items.map((item) => (
              <p key={item.itemId} className="text-sm text-slate-400">
                {item.outcome ?? item.status}
                {item.activityId ? ` · 活动 ${item.activityId.slice(0, 8)}` : ''}
                {item.errorMessage ? ` · ${item.errorMessage}` : ''}
              </p>
            ))}
          </div>
        </details>
      ))}
    </section>
  );
}
