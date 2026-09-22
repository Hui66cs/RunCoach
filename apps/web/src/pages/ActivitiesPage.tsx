import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { listActivities } from '../api.js';
import { averagePace, formatDistance, formatDuration, formatPace } from '../format.js';

export function ActivitiesPage() {
  const [search, setSearch] = useSearchParams();
  const params = new URLSearchParams(search);
  params.set('limit', '30');
  const query = useQuery({
    queryKey: ['activities', params.toString()],
    queryFn: () => listActivities(params),
  });
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'cursor') next.delete('cursor');
    setSearch(next);
  };
  const groups = new Map<string, NonNullable<typeof query.data>['items']>();
  for (const activity of query.data?.items ?? []) {
    const month = activity.localDate.slice(0, 7);
    groups.set(month, [...(groups.get(month) ?? []), activity]);
  }
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold">活动记录</h1>
        <p className="mt-2 text-slate-400">共 {query.data?.total ?? 0} 条活动</p>
      </header>
      <section
        className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4 sm:grid-cols-2 lg:grid-cols-5"
        aria-label="活动筛选"
      >
        <input
          aria-label="搜索名称"
          placeholder="搜索名称"
          value={search.get('q') ?? ''}
          onChange={(e) => update('q', e.target.value)}
          className="rounded bg-slate-950 px-3 py-2"
        />
        <input
          aria-label="开始日期"
          type="date"
          value={search.get('dateFrom') ?? ''}
          onChange={(e) => update('dateFrom', e.target.value)}
          className="rounded bg-slate-950 px-3 py-2"
        />
        <input
          aria-label="结束日期"
          type="date"
          value={search.get('dateTo') ?? ''}
          onChange={(e) => update('dateTo', e.target.value)}
          className="rounded bg-slate-950 px-3 py-2"
        />
        <select
          aria-label="活动类型"
          value={search.get('activityType') ?? ''}
          onChange={(e) => update('activityType', e.target.value)}
          className="rounded bg-slate-950 px-3 py-2"
        >
          <option value="">全部类型</option>
          <option value="RUN">跑步</option>
          <option value="STRENGTH">力量</option>
          <option value="OTHER">其他</option>
        </select>
        <select
          aria-label="来源"
          value={search.get('sourceType') ?? ''}
          onChange={(e) => update('sourceType', e.target.value)}
          className="rounded bg-slate-950 px-3 py-2"
        >
          <option value="">全部来源</option>
          <option value="CSV">CSV</option>
          <option value="FIT">FIT</option>
          <option value="PARROTAO">ParroTao</option>
        </select>
      </section>
      {query.isLoading && <State text="正在加载活动…" />}
      {query.isError && <State text={query.error.message} error />}
      {query.data?.items.length === 0 && <State text="没有符合条件的活动。" />}
      {[...groups].map(([month, items]) => (
        <section key={month}>
          <h2 className="mb-3 text-lg font-semibold text-slate-300">{month}</h2>
          <div className="space-y-3">
            {items.map((activity) => (
              <Link
                key={activity.id}
                to={`/activities/${activity.id}`}
                className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4 hover:border-emerald-700 sm:grid-cols-[1fr_repeat(4,auto)] sm:items-center"
              >
                <div>
                  <h3 className="font-semibold">{activity.name ?? '未命名活动'}</h3>
                  <p className="mt-1 text-sm text-slate-400">
                    {activity.localDate} · {activity.sourceTypes.join(' + ')} ·{' '}
                    {activity.hasTimeSeries ? '有时序' : '无时序'}
                  </p>
                </div>
                <Metric label="距离" value={formatDistance(activity.distanceMeters)} />
                <Metric label="时长" value={formatDuration(activity.durationSeconds)} />
                <Metric
                  label="平均配速"
                  value={formatPace(averagePace(activity.distanceMeters, activity.durationSeconds))}
                />
                <Metric
                  label="平均心率"
                  value={
                    activity.averageHeartRateBpm == null
                      ? '—'
                      : `${activity.averageHeartRateBpm} bpm`
                  }
                />
              </Link>
            ))}
          </div>
        </section>
      ))}
      {query.data?.nextCursor && (
        <button
          className="rounded bg-slate-800 px-4 py-2"
          onClick={() => update('cursor', query.data?.nextCursor ?? '')}
        >
          下一页
        </button>
      )}
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-24">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-sm">{value}</p>
    </div>
  );
}
function State({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <div
      className={`rounded-xl bg-slate-900 p-8 text-center ${error ? 'text-red-400' : 'text-slate-400'}`}
    >
      {text}
    </div>
  );
}
