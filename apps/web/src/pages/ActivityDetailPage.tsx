import { lazy, Suspense, useCallback, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { SeriesMetric } from '@runcoach/shared';
import { getActivity, getActivitySeries, updateActivity } from '../api.js';
import { averagePace, dash, formatDistance, formatDuration, formatPace } from '../format.js';
import { RoutePreview } from '../components/RoutePreview.js';

const SeriesChart = lazy(async () => ({
  default: (await import('../SeriesChart.js')).SeriesChart,
}));
const selectable: Array<{ metric: SeriesMetric; label: string }> = [
  { metric: 'pace', label: '配速' },
  { metric: 'heartRate', label: '心率' },
  { metric: 'cadence', label: '步频' },
  { metric: 'power', label: '功率' },
  { metric: 'altitude', label: '海拔' },
];

export function ActivityDetailPage() {
  const { activityId = '' } = useParams();
  const client = useQueryClient();
  const [metrics, setMetrics] = useState<SeriesMetric[]>(selectable.map((item) => item.metric));
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const detail = useQuery({
    queryKey: ['activity', activityId],
    queryFn: () => getActivity(activityId),
    enabled: activityId !== '',
  });
  const seriesParams = new URLSearchParams({
    metrics: [...metrics, 'gps'].join(','),
    maxPoints: range ? '2500' : '1000',
  });
  if (range) {
    seriesParams.set('from', String(range.from));
    seriesParams.set('to', String(range.to));
  }
  const series = useQuery({
    queryKey: ['activity', activityId, 'series', seriesParams.toString()],
    queryFn: () => getActivitySeries(activityId, seriesParams),
    enabled: activityId !== '' && detail.data?.hasTimeSeries === true,
  });
  const edit = useMutation({
    mutationFn: (patch: { name: string; notes: string }) => updateActivity(activityId, patch),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['activity', activityId] }),
        client.invalidateQueries({ queryKey: ['activities'] }),
      ]);
    },
  });
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = data.get('name');
    const notes = data.get('notes');
    edit.mutate({
      name: typeof name === 'string' ? name : '',
      notes: typeof notes === 'string' ? notes : '',
    });
  };
  const zoom = useCallback((from: number, to: number) => setRange({ from, to }), []);
  if (detail.isLoading) return <State text="正在加载活动详情…" />;
  if (detail.isError || !detail.data)
    return <State text={detail.error?.message ?? '活动不存在'} error />;
  const activity = detail.data;
  const splits =
    activity.laps.length > 0
      ? activity.laps.map((lap) => ({
          ...lap,
          partial: false,
          paceSecondsPerKilometer: averagePace(lap.distanceMeters, lap.durationSeconds),
        }))
      : (activity.analysis.splits.value ?? []);
  return (
    <div className="space-y-6">
      <Link to="/activities" className="text-sm text-emerald-400">
        ← 返回活动列表
      </Link>
      <header>
        <p className="text-sm text-slate-400">
          {activity.localDate} · {activity.activityType}
        </p>
        <h1 className="mt-1 text-3xl font-bold">{activity.name ?? '未命名活动'}</h1>
      </header>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card label="距离" value={formatDistance(activity.distanceMeters)} />
        <Card label="总时长" value={formatDuration(activity.durationSeconds)} />
        <Card
          label="移动时长"
          value={formatDuration(
            activity.movingDurationSeconds ?? activity.derivedSummary.derivedMovingDurationSeconds,
          )}
          derived={activity.movingDurationSeconds == null}
        />
        <Card
          label="平均配速"
          value={formatPace(averagePace(activity.distanceMeters, activity.durationSeconds))}
        />
        <Card
          label="平均 / 最大心率"
          value={
            activity.averageHeartRateBpm == null
              ? dash
              : `${activity.averageHeartRateBpm} / ${activity.maxHeartRateBpm ?? dash} bpm`
          }
        />
        <Card
          label="平均步频"
          value={
            activity.derivedSummary.averageCadenceStepsPerMinute == null
              ? dash
              : `${Math.round(activity.derivedSummary.averageCadenceStepsPerMinute)} spm`
          }
          derived
        />
        <Card
          label="平均功率"
          value={
            activity.derivedSummary.averagePowerWatts == null
              ? dash
              : `${Math.round(activity.derivedSummary.averagePowerWatts)} W`
          }
          derived
        />
        <Card
          label="累计爬升"
          value={
            activity.derivedSummary.elevationGainMeters == null
              ? dash
              : `${Math.round(activity.derivedSummary.elevationGainMeters)} m`
          }
          derived
        />
      </section>
      <form
        key={`${activity.id}-${activity.userEditedName}-${activity.userEditedNotes}`}
        onSubmit={save}
        className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900 p-5"
      >
        <h2 className="text-lg font-semibold">名称与备注</h2>
        <input
          name="name"
          aria-label="活动名称"
          defaultValue={activity.name ?? ''}
          className="rounded bg-slate-950 px-3 py-2"
        />
        <textarea
          name="notes"
          aria-label="活动备注"
          defaultValue={activity.notes ?? ''}
          className="min-h-24 rounded bg-slate-950 px-3 py-2"
        />
        <div className="flex items-center gap-4">
          <button
            disabled={edit.isPending}
            className="rounded bg-emerald-500 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50"
          >
            {edit.isPending ? '保存中…' : '保存'}
          </button>
          <span aria-live="polite" className={edit.isError ? 'text-red-400' : 'text-emerald-400'}>
            {edit.isSuccess ? '已保存' : edit.error?.message}
          </span>
        </div>
      </form>
      {splits.length > 0 && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-lg font-semibold">
            {activity.laps.length > 0 ? 'FIT 原生圈段' : '派生公里分段'}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            {activity.laps.length > 0
              ? '来自 FIT lap 数据。'
              : '按累计距离插值，仅用于分析，不是 FIT 原生 lap。'}
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-400">
                <tr>
                  <th className="p-2">#</th>
                  <th>距离</th>
                  <th>时长</th>
                  <th>平均配速</th>
                  <th>平均心率</th>
                </tr>
              </thead>
              <tbody>
                {splits.map((split, index) => (
                  <tr key={index} className="border-t border-slate-800">
                    <td className="p-2">
                      {index + 1}
                      {'partial' in split && split.partial ? '（部分）' : ''}
                    </td>
                    <td>{formatDistance(split.distanceMeters)}</td>
                    <td>{formatDuration(split.durationSeconds)}</td>
                    <td>{formatPace(split.paceSecondsPerKilometer)}</td>
                    <td>
                      {split.averageHeartRateBpm == null
                        ? dash
                        : `${Math.round(split.averageHeartRateBpm)} bpm`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <Analysis activity={activity} />
      {activity.hasTimeSeries && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">时序图表</h2>
            {range && (
              <button onClick={() => setRange(null)} className="text-sm text-emerald-400">
                恢复全程
              </button>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {selectable.map((item) => (
              <button
                key={item.metric}
                onClick={() =>
                  setMetrics((current) =>
                    current.includes(item.metric)
                      ? current.filter((metric) => metric !== item.metric)
                      : [...current, item.metric],
                  )
                }
                className={`rounded px-3 py-1 text-sm ${metrics.includes(item.metric) ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800'}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          {series.isLoading && <State text="正在加载曲线…" />}
          {series.isError && <State text={series.error.message} error />}
          {series.data && (
            <Suspense fallback={<State text="正在加载图表组件…" />}>
              <SeriesChart points={series.data.points} metrics={metrics} onRangeChange={zoom} />
            </Suspense>
          )}
        </section>
      )}
      {series.data && <RoutePreview points={series.data.points} />}
      <details className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <summary className="cursor-pointer font-semibold">数据详情</summary>
        <div className="mt-4 space-y-4 text-sm">
          <p>来源：{activity.sourceTypes.join(' + ')}</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(activity.provenance).map(([field, source]) => (
              <span key={field} className="rounded bg-slate-950 px-2 py-1">
                {field}: {source}
              </span>
            ))}
          </div>
          <div>
            {activity.mergeEvents.map((event) => (
              <p key={event.id}>
                {new Date(event.createdAt).toLocaleString()} · {event.action} ·{' '}
                {event.changedFields.join('、') || '无字段变化'}
              </p>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}

function Analysis({
  activity,
}: {
  activity: NonNullable<ReturnType<typeof getActivity> extends Promise<infer T> ? T : never>;
}) {
  const half = activity.analysis.halfComparison;
  const stability = activity.analysis.paceStability;
  const drift = activity.analysis.aerobicDecoupling;
  return (
    <section className="grid gap-4 md:grid-cols-2">
      <AnalysisCard
        title="前后半程"
        text={
          half.value
            ? `后半程配速变化 ${half.value.paceChangePercent?.toFixed(1) ?? dash}%`
            : (half.reason ?? dash)
        }
      />
      <AnalysisCard
        title="配速稳定性"
        text={
          stability.value
            ? `${stability.value.conclusion} · CV ${(stability.value.coefficientOfVariation * 100).toFixed(1)}%`
            : (stability.reason ?? dash)
        }
      />
      <AnalysisCard
        title="心率区间"
        text={
          activity.analysis.heartRateZones.value
            ? activity.analysis.heartRateZones.value
                .map((zone) => `Z${zone.zone} ${formatDuration(zone.durationSeconds)}`)
                .join(' · ')
            : (activity.analysis.heartRateZones.reason ?? dash)
        }
      />
      <AnalysisCard
        title="有氧解耦（实验性）"
        text={
          drift.value
            ? `${drift.value.percent.toFixed(1)}% · ${drift.value.direction}`
            : (drift.reason ?? dash)
        }
      />
    </section>
  );
}
function Card({
  label,
  value,
  derived = false,
}: {
  label: string;
  value: string;
  derived?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <p className="text-xs text-slate-500">
        {label}
        {derived ? ' · 派生' : ''}
      </p>
      <p className="mt-2 text-xl font-semibold">{value}</p>
    </div>
  );
}
function AnalysisCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-slate-300">{text}</p>
    </div>
  );
}
function State({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <div className={`p-6 text-center ${error ? 'text-red-400' : 'text-slate-400'}`}>{text}</div>
  );
}
