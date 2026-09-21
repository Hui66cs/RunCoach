import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getActivity, listActivities, updateActivity } from './api.js';
import { ImportPanel } from './components/ImportPanel.js';
import { ImportHistoryPanel } from './components/ImportHistoryPanel.js';
import { PendingImportsPanel } from './components/PendingImportsPanel.js';
import { listPending } from './imports-api.js';

const SeriesChart = lazy(async () => {
  const module = await import('./SeriesChart.js');
  return { default: module.SeriesChart };
});

function formatDistance(metres: number | null): string {
  return metres === null ? '—' : `${(metres / 1000).toFixed(2)} km`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = Math.round(seconds % 60);
  return [hours, minutes, remaining].map((value) => value.toString().padStart(2, '0')).join(':');
}

export function App() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<'activities' | 'pending' | 'history'>('activities');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activitiesQuery = useQuery({ queryKey: ['activities'], queryFn: listActivities });
  const pendingCountQuery = useQuery({ queryKey: ['imports', 'pending'], queryFn: listPending });
  const detailQuery = useQuery({
    queryKey: ['activity', selectedId],
    queryFn: () => getActivity(selectedId!),
    enabled: selectedId !== null,
  });

  useEffect(() => {
    if (selectedId === null && activitiesQuery.data?.[0] !== undefined) {
      setSelectedId(activitiesQuery.data[0].id);
    }
  }, [activitiesQuery.data, selectedId]);

  const editMutation = useMutation({
    mutationFn: ({ name, notes }: { name: string; notes: string }) =>
      updateActivity(selectedId!, { name, notes }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['activities'] });
      await queryClient.invalidateQueries({ queryKey: ['activity', selectedId] });
    },
  });

  const submitEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nameValue = data.get('name');
    const notesValue = data.get('notes');
    editMutation.mutate({
      name: typeof nameValue === 'string' ? nameValue : '',
      notes: typeof notesValue === 'string' ? notesValue : '',
    });
  };

  const detail = detailQuery.data;
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-7xl p-6">
        <header className="mb-8">
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-emerald-400">
            RunCoach Local
          </p>
          <h1 className="mt-2 text-3xl font-bold">导入与活动验证</h1>
          <p className="mt-2 text-slate-400">当前仅实现 CSV → FIT 原地升级纵向切片。</p>
        </header>
        <nav aria-label="导入管理视图" className="mb-6 flex flex-wrap gap-2">
          {(
            [
              ['activities', '活动'],
              ['pending', `待确认 (${pendingCountQuery.data?.total ?? 0})`],
              ['history', '导入历史'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
              className={`rounded px-4 py-2 ${view === key ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800'}`}
            >
              {label}
            </button>
          ))}
        </nav>
        {view === 'pending' && <PendingImportsPanel />}
        {view === 'history' && <ImportHistoryPanel />}
        {view === 'activities' && (
          <>
            <ImportPanel />
            <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
              <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <h2 className="mb-4 text-lg font-semibold">活动列表</h2>
                {activitiesQuery.isLoading && <p className="text-slate-400">加载中…</p>}
                <div className="space-y-2">
                  {activitiesQuery.data?.length === 0 && <p>尚未导入活动。</p>}
                  {activitiesQuery.data?.map((activity) => (
                    <button
                      key={activity.id}
                      type="button"
                      onClick={() => setSelectedId(activity.id)}
                      className={`w-full rounded-lg border p-3 text-left ${selectedId === activity.id ? 'border-emerald-500 bg-emerald-950/40' : 'border-slate-800 bg-slate-950'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">
                          {activity.name ?? activity.activityType}
                        </span>
                        <span className="text-xs text-slate-500">{activity.localDate}</span>
                      </div>
                      <p className="mt-2 text-sm text-slate-400">
                        {formatDistance(activity.distanceMeters)} ·{' '}
                        {formatDuration(activity.durationSeconds)}
                      </p>
                      <p className="mt-2 text-xs text-emerald-300">
                        {activity.sourceTypes.join(' + ')}
                        {activity.hasTimeSeries ? ' · 有时序' : ' · 无时序'}
                      </p>
                    </button>
                  ))}
                </div>
              </section>

              <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
                {!detail && <p className="text-slate-400">选择一条活动查看详情。</p>}
                {detail && (
                  <div className="space-y-6">
                    <div>
                      <h2 className="text-2xl font-semibold">
                        {detail.name ?? detail.activityType}
                      </h2>
                      <p className="mt-2 text-slate-400">
                        {formatDistance(detail.distanceMeters)} ·{' '}
                        {formatDuration(detail.durationSeconds)} · 平均心率{' '}
                        {detail.averageHeartRateBpm ?? '—'}
                      </p>
                    </div>
                    <form
                      key={detail.id}
                      onSubmit={submitEdit}
                      className="grid gap-3 rounded-lg bg-slate-950 p-4"
                    >
                      <label className="text-sm">
                        名称
                        <input
                          name="name"
                          defaultValue={detail.name ?? ''}
                          className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2"
                        />
                      </label>
                      <label className="text-sm">
                        备注
                        <textarea
                          name="notes"
                          defaultValue={detail.notes ?? ''}
                          className="mt-1 min-h-20 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2"
                        />
                      </label>
                      <button
                        type="submit"
                        className="w-fit rounded bg-emerald-500 px-4 py-2 font-medium text-slate-950"
                      >
                        保存用户字段
                      </button>
                    </form>
                    <div>
                      <h3 className="mb-2 font-semibold">来源</h3>
                      <div className="flex flex-wrap gap-2">
                        {detail.sources.map((source) => (
                          <span key={source.id} className="rounded bg-slate-800 px-3 py-1 text-sm">
                            {source.sourceType}
                            {source.fileSha256 ? ` · ${source.fileSha256.slice(0, 10)}…` : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <h3 className="mb-2 font-semibold">字段来源</h3>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(detail.provenance).map(([field, source]) => (
                          <span
                            key={field}
                            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300"
                          >
                            {field}: {source}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <h3 className="mb-2 font-semibold">合并审计</h3>
                      <div className="space-y-2">
                        {detail.mergeEvents.map((event) => (
                          <div key={event.id} className="rounded bg-slate-950 p-3 text-sm">
                            <span className="font-medium">{event.action}</span>
                            <span className="ml-2 text-slate-500">
                              {new Date(event.createdAt).toLocaleString()}
                            </span>
                            <p className="mt-1 text-slate-400">
                              变化字段：{event.changedFields.join('、') || '无'}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <h3 className="mb-2 font-semibold">Lap（{detail.laps.length}）</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="text-left text-slate-400">
                            <tr>
                              <th className="p-2">#</th>
                              <th>距离</th>
                              <th>时间</th>
                              <th>平均心率</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.laps.map((lap) => (
                              <tr key={lap.sequence} className="border-t border-slate-800">
                                <td className="p-2">{lap.sequence + 1}</td>
                                <td>{formatDistance(lap.distanceMeters ?? null)}</td>
                                <td>{formatDuration(lap.durationSeconds ?? null)}</td>
                                <td>{lap.averageHeartRateBpm ?? '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    {detail.samples.length > 0 && (
                      <div>
                        <h3 className="mb-2 font-semibold">
                          心率 / 速度曲线（{detail.samples.length} 点）
                        </h3>
                        <Suspense fallback={<p className="text-slate-400">正在加载曲线…</p>}>
                          <SeriesChart samples={detail.samples} />
                        </Suspense>
                      </div>
                    )}
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
