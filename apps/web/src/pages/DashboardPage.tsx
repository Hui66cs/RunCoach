import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { DashboardPeriodSummary } from '@runcoach/shared';
import { getDashboard } from '../api.js';
import { formatDistance, formatDuration, formatPace } from '../format.js';

const WeeklyVolumeChart = lazy(async () => ({
  default: (await import('../components/WeeklyVolumeChart.js')).WeeklyVolumeChart,
}));

const typeLabels = { RUN: '跑步', STRENGTH: '力量', OTHER: '其他' } as const;

export function DashboardPage() {
  const query = useQuery({ queryKey: ['dashboard'], queryFn: getDashboard });
  if (query.isLoading) return <State text="正在加载概览…" />;
  if (query.isError || !query.data)
    return <State text={query.error?.message ?? '概览加载失败'} error />;
  const data = query.data;
  const hasNoActivities = data.recentActivities.length === 0;
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold">概览</h1>
        <p className="mt-2 text-slate-400">
          统计日期 {data.generatedForLocalDate} · 时区 UTC
          {data.timezoneOffsetMinutes >= 0 ? '+' : ''}
          {data.timezoneOffsetMinutes / 60}
        </p>
      </header>
      {hasNoActivities ? (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-10 text-center">
          <p className="text-lg font-semibold">还没有任何活动</p>
          <p className="mt-2 text-slate-400">
            先导入一条跑步记录，概览会在这里显示跑量统计和趋势。
          </p>
          <Link
            to="/imports"
            className="mt-4 inline-block rounded bg-emerald-500 px-4 py-2 font-semibold text-slate-950"
          >
            前往导入
          </Link>
        </section>
      ) : (
        <>
          <section className="grid gap-4 lg:grid-cols-2" aria-label="近期跑量概览">
            <PeriodCard title="最近 7 天" summary={data.last7Days} />
            <PeriodCard title="最近 28 天" summary={data.last28Days} />
          </section>
          {data.last28Days.runs === 0 && (
            <p className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
              最近 28 天没有跑步记录，以下趋势显示的是更早的历史跑量。
            </p>
          )}
          <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-lg font-semibold">最近 12 周跑量趋势</h2>
            <p className="mt-1 text-xs text-slate-500">
              自然周从周一开始，包含当前周；没有活动的周记为 0。
            </p>
            <Suspense fallback={<State text="正在加载趋势图…" />}>
              <WeeklyVolumeChart weeks={data.weeklyVolumes} />
            </Suspense>
          </section>
        </>
      )}
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">最近活动</h2>
          <Link to="/activities" className="text-sm text-emerald-400">
            查看全部
          </Link>
        </div>
        {hasNoActivities ? (
          <p className="mt-3 text-sm text-slate-400">暂无活动记录。</p>
        ) : (
          <div className="mt-3 space-y-2">
            {data.recentActivities.map((activity) => (
              <Link
                key={activity.id}
                to={`/activities/${activity.id}`}
                className="grid gap-2 rounded-lg border border-slate-800 p-3 hover:border-emerald-700 sm:grid-cols-[1fr_repeat(3,auto)] sm:items-center"
              >
                <div>
                  <h3 className="font-medium">{activity.name ?? '未命名活动'}</h3>
                  <p className="mt-1 text-xs text-slate-500">
                    {activity.localDate} · {typeLabels[activity.activityType]}
                  </p>
                </div>
                <RecentMetric label="距离" value={formatDistance(activity.distanceMeters)} />
                <RecentMetric
                  label="时长"
                  value={formatDuration(activity.movingDurationSeconds ?? activity.durationSeconds)}
                />
                <RecentMetric label="平均配速" value={formatPace(averagePaceOf(activity))} />
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function averagePaceOf(activity: {
  distanceMeters?: number | null | undefined;
  movingDurationSeconds?: number | null | undefined;
  durationSeconds?: number | null | undefined;
}): number | null {
  const duration = activity.movingDurationSeconds ?? activity.durationSeconds;
  return activity.distanceMeters != null && duration != null && activity.distanceMeters > 0
    ? (duration / activity.distanceMeters) * 1000
    : null;
}

function PeriodCard({ title, summary }: { title: string; summary: DashboardPeriodSummary }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="font-semibold">{title}</h2>
      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="跑步次数" value={`${summary.runs} 次`} />
        <Stat label="总距离" value={formatDistance(summary.totalDistanceMeters)} />
        <Stat label="总移动时长" value={formatDuration(summary.totalMovingDurationSeconds)} />
        <Stat label="平均配速" value={formatPace(summary.averagePaceSecondsPerKilometer)} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function RecentMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-20">
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
