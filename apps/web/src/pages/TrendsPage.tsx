import { lazy, Suspense } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { TrendsWeeklyPoint } from '@runcoach/shared';
import { getTrends } from '../api.js';
import { formatDistance, formatDuration, formatPace } from '../format.js';
import { dash } from '../format.js';

const WeeklyVolumeChart = lazy(async () => ({
  default: (await import('../components/WeeklyVolumeChart.js')).WeeklyVolumeChart,
}));
const WeeklyPaceChart = lazy(async () => ({
  default: (await import('../components/TrendCharts.js')).WeeklyPaceChart,
}));
const WeeklyHeartRateChart = lazy(async () => ({
  default: (await import('../components/TrendCharts.js')).WeeklyHeartRateChart,
}));

const WEEK_OPTIONS = [12, 26, 52] as const;
type WeekOption = (typeof WEEK_OPTIONS)[number];

function parseWeeksParam(value: string | null): WeekOption {
  const parsed = Number(value);
  return (WEEK_OPTIONS as readonly number[]).includes(parsed) ? (parsed as WeekOption) : 12;
}

export function TrendsPage() {
  const [search, setSearch] = useSearchParams();
  const weeks = parseWeeksParam(search.get('weeks'));
  const query = useQuery({
    queryKey: ['trends', weeks],
    queryFn: () => getTrends({ weeks }),
    placeholderData: keepPreviousData,
  });
  const selectWeeks = (next: WeekOption) => {
    const params = new URLSearchParams(search);
    if (next === 12) params.delete('weeks');
    else params.set('weeks', String(next));
    setSearch(params);
  };
  const data = query.data;
  const hasNoRuns = data !== undefined && data.summary.runs === 0;
  const hasPace = (points: TrendsWeeklyPoint[]) =>
    points.some((point) => point.averagePaceSecondsPerKilometer != null);
  const hasHeartRate = (points: TrendsWeeklyPoint[]) =>
    points.some((point) => point.averageHeartRateBpm != null);
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold">趋势</h1>
        <p className="mt-2 text-slate-400">
          跨活动跑量与配速趋势，仅统计跑步活动；自然周从周一开始。
        </p>
      </header>
      <section className="flex flex-wrap gap-2" aria-label="时间范围选择">
        {WEEK_OPTIONS.map((option) => (
          <button
            key={option}
            onClick={() => selectWeeks(option)}
            aria-pressed={weeks === option}
            className={`rounded px-4 py-2 text-sm font-medium ${weeks === option ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            最近 {option} 周
          </button>
        ))}
        {query.isPlaceholderData && (
          <span aria-live="polite" className="self-center text-sm text-slate-500">
            正在更新…
          </span>
        )}
      </section>
      {query.isLoading && <State text="正在加载趋势…" />}
      {query.isError && <State text={query.error?.message ?? '趋势加载失败'} error />}
      {data && hasNoRuns && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-10 text-center">
          <p className="text-lg font-semibold">所选范围内没有跑步活动</p>
          <p className="mt-2 text-slate-400">导入跑步记录后，这里会显示周跑量、配速和心率趋势。</p>
          <Link
            to="/imports"
            className="mt-4 inline-block rounded bg-emerald-500 px-4 py-2 font-semibold text-slate-950"
          >
            前往导入
          </Link>
        </section>
      )}
      {data && !hasNoRuns && (
        <>
          <section
            className="grid grid-cols-2 gap-4 rounded-xl border border-slate-800 bg-slate-900 p-5 sm:grid-cols-5"
            aria-label={`最近 ${weeks} 周汇总`}
          >
            <Stat label="总跑步次数" value={`${data.summary.runs} 次`} />
            <Stat label="总距离" value={formatDistance(data.summary.totalDistanceMeters)} />
            <Stat
              label="总移动时长"
              value={formatDuration(data.summary.totalMovingDurationSeconds)}
            />
            <Stat
              label="平均配速"
              value={formatPace(data.summary.averagePaceSecondsPerKilometer)}
            />
            <Stat
              label="平均心率"
              value={
                data.summary.averageHeartRateBpm == null
                  ? dash
                  : `${Math.round(data.summary.averageHeartRateBpm)} bpm`
              }
            />
          </section>
          <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-lg font-semibold">周跑量与频率</h2>
            <p className="mt-1 text-xs text-slate-500">
              柱状为每周跑量（km），折线为每周跑步次数；tooltip 含移动时长。无活动的周记为 0。
            </p>
            <Suspense fallback={<State text="正在加载图表…" />}>
              <WeeklyVolumeChart weeks={data.weeklyPoints} />
            </Suspense>
          </section>
          <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-lg font-semibold">周平均配速</h2>
            <p className="mt-1 text-xs text-slate-500">
              单位 min/km，越快越靠上；无有效配速的周断开显示，不计为 0。
            </p>
            {hasPace(data.weeklyPoints) ? (
              <Suspense fallback={<State text="正在加载图表…" />}>
                <WeeklyPaceChart points={data.weeklyPoints} weeks={weeks} />
              </Suspense>
            ) : (
              <p className="mt-3 text-sm text-slate-400">
                所选范围内没有可计算的周平均配速（缺少有效距离或有效移动时长）。
              </p>
            )}
          </section>
          <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-lg font-semibold">周平均心率</h2>
            <p className="mt-1 text-xs text-slate-500">
              单位 bpm，按有效移动时长加权；缺失心率的周断开显示，不计为 0。
            </p>
            {hasHeartRate(data.weeklyPoints) ? (
              <Suspense fallback={<State text="正在加载图表…" />}>
                <WeeklyHeartRateChart points={data.weeklyPoints} weeks={weeks} />
              </Suspense>
            ) : (
              <p className="mt-3 text-sm text-slate-400">
                所选范围内没有有效的活动平均心率，无法计算周平均心率趋势。
              </p>
            )}
          </section>
        </>
      )}
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

function State({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <div
      className={`rounded-xl bg-slate-900 p-8 text-center ${error ? 'text-red-400' : 'text-slate-400'}`}
    >
      {text}
    </div>
  );
}
