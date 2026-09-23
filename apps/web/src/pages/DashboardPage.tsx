import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type {
  CalendarPlannedWorkout,
  DashboardPeriodSummary,
  DailyStatusEntry,
} from '@runcoach/shared';
import { getCalendarRange, getDailyStatusRange, getDashboard, getAthleteSettings } from '../api.js';
import { formatDistance, formatDuration, formatPace } from '../format.js';
import { monthOf } from '../local-date.js';
import {
  dashboardPlanWindow,
  todaysPlannedWorkouts,
  upcomingPlannedWorkouts,
  weeklyRunDistanceMeters,
  weeklyTargetPercent,
} from '../dashboard-plan.js';
import { dailyStatusScales } from '../form-conversion.js';
import { plannedStatusBadge, workoutTypeLabels } from '../components/PlannedWorkoutDialog.js';

const WeeklyVolumeChart = lazy(async () => ({
  default: (await import('../components/WeeklyVolumeChart.js')).WeeklyVolumeChart,
}));

const typeLabels = { RUN: '跑步', STRENGTH: '力量', OTHER: '其他' } as const;

export function DashboardPage() {
  const query = useQuery({ queryKey: ['dashboard'], queryFn: getDashboard });
  const settingsQuery = useQuery({
    queryKey: ['settings', 'athlete'],
    queryFn: getAthleteSettings,
  });
  if (query.isLoading) return <State text="正在加载概览…" />;
  if (query.isError || !query.data)
    return <State text={query.error?.message ?? '概览加载失败'} error />;
  const data = query.data;
  // The dashboard response is the single source of canonical "today".
  const today = data.generatedForLocalDate;
  const window = dashboardPlanWindow(today);
  const displayName = settingsQuery.data?.displayName ?? null;
  const primaryGoal = settingsQuery.data?.primaryGoal ?? null;
  const hasNoActivities = data.recentActivities.length === 0;
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold">
          {displayName !== null ? `你好，${displayName}` : '概览'}
        </h1>
        <p className="mt-2 text-slate-400">
          统计日期 <span data-testid="dashboard-today-date">{data.generatedForLocalDate}</span> ·
          时区 UTC
          {data.timezoneOffsetMinutes >= 0 ? '+' : ''}
          {data.timezoneOffsetMinutes / 60}
          {primaryGoal !== null && <span className="ml-2">· 目标：{primaryGoal}</span>}
        </p>
      </header>

      {/* 日常训练闭环：即使还没有任何实际活动也始终可见 */}
      <section className="grid gap-4 lg:grid-cols-2" aria-label="今日训练概览">
        <TodayStatusCard today={today} />
        <TodayPlansCard today={today} />
        <WeeklyTargetCard
          today={today}
          weekMonday={window.weekMonday}
          weekSunday={window.weekSunday}
          targetMeters={settingsQuery.data?.weeklyDistanceTargetMeters ?? null}
          settingsStatus={
            settingsQuery.isLoading ? 'loading' : settingsQuery.isError ? 'error' : 'ready'
          }
          settingsErrorMessage={settingsQuery.error?.message ?? null}
        />
        <UpcomingPlansCard today={today} />
      </section>

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

function TodayStatusCard({ today }: { today: string }) {
  const query = useQuery({
    queryKey: ['daily-status', today],
    queryFn: () => getDailyStatusRange(today),
  });
  // Only a response for exactly the canonical today may fill the card.
  const entry: DailyStatusEntry | null =
    query.data !== undefined && query.data.from === today ? (query.data.items[0] ?? null) : null;
  const linkLabel = entry === null ? '记录今日状态' : '编辑今日状态';
  return (
    <div
      className="rounded-xl border border-slate-800 bg-slate-900 p-5"
      data-testid="dashboard-status-card"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">今日状态</h2>
        <Link to={`/daily-status?date=${today}`} className="text-sm text-emerald-400">
          {linkLabel}
        </Link>
      </div>
      {query.isLoading && <p className="mt-3 text-sm text-slate-400">正在加载今日状态…</p>}
      {query.isError && (
        <p className="mt-3 text-sm text-red-400">
          今日状态加载失败{query.error?.message ? `（${query.error.message}）` : ''}
        </p>
      )}
      {entry === null && !query.isError && !query.isLoading && (
        <p className="mt-3 text-sm text-slate-400">今天尚未记录状态。</p>
      )}
      {entry !== null && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          {dailyStatusScales.map((scale) => (
            <div key={scale.field}>
              <dt className="text-xs text-slate-500">{scale.label}</dt>
              <dd className="mt-0.5 font-medium">
                {entry[scale.field] != null ? `${entry[scale.field]}/5` : '未填写'}
              </dd>
            </div>
          ))}
          <div>
            <dt className="text-xs text-slate-500">静息心率</dt>
            <dd className="mt-0.5 font-medium">
              {entry.restingHeartRateBpm != null ? `${entry.restingHeartRateBpm} bpm` : '未填写'}
            </dd>
          </div>
          <div className="col-span-2 sm:col-span-3">
            <dt className="text-xs text-slate-500">备注</dt>
            <dd className="mt-0.5">{entry.notes ?? '未填写'}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function TodayPlansCard({ today }: { today: string }) {
  const window = dashboardPlanWindow(today);
  const query = useQuery({
    queryKey: ['calendar-plan', window.rangeFrom, window.rangeTo],
    queryFn: () => getCalendarRange({ from: window.rangeFrom, to: window.rangeTo }),
  });
  const calendarData = query.data?.from === window.rangeFrom ? query.data : null;
  const todays =
    calendarData === null ? [] : todaysPlannedWorkouts(calendarData.plannedWorkouts, today);
  const month = monthOf(today);
  return (
    <div
      className="rounded-xl border border-slate-800 bg-slate-900 p-5"
      data-testid="dashboard-plans-card"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">今日训练</h2>
        <Link to={`/calendar?month=${month}`} className="text-sm text-emerald-400">
          在日历中处理
        </Link>
      </div>
      {query.isLoading && <p className="mt-3 text-sm text-slate-400">正在加载今日计划…</p>}
      {query.isError && (
        <p className="mt-3 text-sm text-red-400">
          今日计划加载失败{query.error?.message ? `（${query.error.message}）` : ''}
        </p>
      )}
      {todays.length === 0 && !query.isError && !query.isLoading && (
        <p className="mt-3 text-sm text-slate-400">今天没有计划训练。</p>
      )}
      {todays.length > 0 && (
        <ul className="mt-3 space-y-2">
          {todays.map((plan) => (
            <TodayPlanItem key={plan.id} plan={plan} today={today} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TodayPlanItem({ plan, today }: { plan: CalendarPlannedWorkout; today: string }) {
  const targetParts: string[] = [];
  if (plan.targetDistanceMeters != null)
    targetParts.push(`目标 ${formatDistance(plan.targetDistanceMeters)}`);
  if (plan.targetDurationSeconds != null)
    targetParts.push(`目标 ${formatDuration(plan.targetDurationSeconds)}`);
  return (
    <li className="rounded-lg border border-slate-800 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500">{plannedStatusBadge(plan, today)}</span>
        <span className="font-medium">{plan.title}</span>
        <span className="text-xs text-slate-500">{workoutTypeLabels[plan.workoutType]}</span>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        {targetParts.length > 0 ? targetParts.join(' · ') : '无目标'}
      </p>
      {plan.linkedActivity !== null && (
        <p className="mt-1 text-xs text-sky-300">
          已关联：
          <Link
            to={`/activities/${plan.linkedActivity.id}`}
            className="underline-offset-2 hover:underline"
          >
            {plan.linkedActivity.name ?? '未命名活动'}
          </Link>
        </p>
      )}
    </li>
  );
}

function WeeklyTargetCard({
  today,
  weekMonday,
  weekSunday,
  targetMeters,
  settingsStatus,
  settingsErrorMessage,
}: {
  today: string;
  weekMonday: string;
  weekSunday: string;
  targetMeters: number | null;
  settingsStatus: 'loading' | 'error' | 'ready';
  settingsErrorMessage: string | null;
}) {
  const window = dashboardPlanWindow(today);
  const query = useQuery({
    queryKey: ['calendar-plan', window.rangeFrom, window.rangeTo],
    queryFn: () => getCalendarRange({ from: window.rangeFrom, to: window.rangeTo }),
  });
  // The real distance is only computed from a SUCCESSFUL response that
  // matches the requested window. A failed refetch (even with the previous
  // success still cached for the same window) must surface the error alone —
  // the stale numbers are never shown alongside it as if they were current.
  const calendarReady = query.isSuccess && query.data.from === window.rangeFrom;
  const hasTarget = settingsStatus === 'ready' && targetMeters != null;
  const percent =
    hasTarget && calendarReady
      ? weeklyTargetPercent(
          weeklyRunDistanceMeters(query.data?.activities ?? [], weekMonday, weekSunday),
          targetMeters,
        )
      : 0;
  return (
    <div
      className="rounded-xl border border-slate-800 bg-slate-900 p-5"
      data-testid="dashboard-weekly-card"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">本周跑量</h2>
        {settingsStatus === 'ready' && targetMeters === null && (
          <Link to="/settings" className="text-sm text-emerald-400">
            前往设置
          </Link>
        )}
      </div>
      {settingsStatus === 'loading' && (
        <p className="mt-3 text-sm text-slate-400">正在加载周目标…</p>
      )}
      {settingsStatus === 'error' && (
        <p className="mt-3 text-sm text-red-400" data-testid="dashboard-weekly-settings-error">
          周目标设置加载失败
          {settingsErrorMessage !== null ? `（${settingsErrorMessage}）` : ''}
        </p>
      )}
      {settingsStatus === 'ready' && targetMeters === null && (
        <p className="mt-3 text-sm text-slate-400">
          尚未设置周跑量目标。可在设置中添加，本应用不会自动生成目标。
        </p>
      )}
      {hasTarget && query.isLoading && (
        <p className="mt-3 text-sm text-slate-400">正在加载本周跑量…</p>
      )}
      {hasTarget && query.isError && (
        <p className="mt-3 text-sm text-red-400" data-testid="dashboard-weekly-error">
          本周跑量数据加载失败{query.error?.message ? `（${query.error.message}）` : ''}
        </p>
      )}
      {hasTarget && !query.isLoading && !query.isError && !calendarReady && (
        <p className="mt-3 text-sm text-slate-400">正在加载本周跑量…</p>
      )}
      {hasTarget && calendarReady && (
        <div className="mt-3">
          <p className="text-sm text-slate-300">
            本周实际{' '}
            <span data-testid="dashboard-weekly-actual">
              {formatDistance(
                weeklyRunDistanceMeters(query.data?.activities ?? [], weekMonday, weekSunday),
              )}
            </span>{' '}
            · 周目标 {formatDistance(targetMeters)}
          </p>
          <div
            className="mt-2 h-2 w-full overflow-hidden rounded bg-slate-800"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, Math.round(percent))}
            aria-label="本周跑量目标完成进度"
          >
            <div
              className="h-full rounded bg-emerald-500"
              style={{ width: `${Math.min(100, percent)}%` }}
            />
          </div>
          {/* The text keeps the real percentage even above 100%; only the bar
              and its ARIA value are capped so the layout cannot overflow. */}
          <p className="mt-1 text-xs text-slate-500" data-testid="dashboard-weekly-percent">
            已完成 {Math.round(percent)}%（仅统计实际 RUN 距离）
          </p>
        </div>
      )}
    </div>
  );
}

function UpcomingPlansCard({ today }: { today: string }) {
  const window = dashboardPlanWindow(today);
  const query = useQuery({
    queryKey: ['calendar-plan', window.rangeFrom, window.rangeTo],
    queryFn: () => getCalendarRange({ from: window.rangeFrom, to: window.rangeTo }),
  });
  const calendarData = query.data?.from === window.rangeFrom ? query.data : null;
  const upcoming = upcomingPlannedWorkouts(calendarData?.plannedWorkouts ?? [], today);
  // When plans were cut off, open the calendar on the month of the FIRST
  // truncated plan (which may lie in the next month), so the user actually
  // sees at least that item after clicking.
  const month = monthOf(upcoming.firstTruncatedLocalDate ?? window.rangeTo);
  return (
    <div
      className="rounded-xl border border-slate-800 bg-slate-900 p-5"
      data-testid="dashboard-upcoming-card"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">近期计划</h2>
        {upcoming.hasMore && (
          <Link to={`/calendar?month=${month}`} className="text-sm text-emerald-400">
            在日历中查看
          </Link>
        )}
      </div>
      {query.isLoading && <p className="mt-3 text-sm text-slate-400">正在加载近期计划…</p>}
      {query.isError && (
        <p className="mt-3 text-sm text-red-400">
          近期计划加载失败{query.error?.message ? `（${query.error.message}）` : ''}
        </p>
      )}
      {upcoming.items.length === 0 && !query.isError && !query.isLoading && (
        <p className="mt-3 text-sm text-slate-400">未来 7 天没有计划训练。</p>
      )}
      {upcoming.items.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm">
          {upcoming.items.map((plan) => (
            <li key={plan.id} className="rounded-lg border border-slate-800 p-3">
              <p className="font-medium">{plan.title}</p>
              <p className="mt-1 text-xs text-slate-500">
                {plan.scheduledLocalDate} · {workoutTypeLabels[plan.workoutType]}
                {plan.targetDistanceMeters != null
                  ? ` · 目标 ${formatDistance(plan.targetDistanceMeters)}`
                  : ''}
                {plan.targetDurationSeconds != null
                  ? ` · 目标 ${formatDuration(plan.targetDurationSeconds)}`
                  : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function averagePaceOf(activity: {
  distanceMeters?: number | null | undefined;
  movingDurationSeconds?: number | null | undefined;
  durationSeconds?: number | null | undefined;
}): number | null {
  const duration = activity.movingDurationSeconds ?? activity.durationSeconds;
  const distance = activity.distanceMeters;
  // A meaningful pace needs both positive distance and positive effective
  // duration; null/undefined/0 must render as "—" instead of 0:00/km.
  if (
    typeof distance !== 'number' ||
    !Number.isFinite(distance) ||
    distance <= 0 ||
    typeof duration !== 'number' ||
    !Number.isFinite(duration) ||
    duration <= 0
  )
    return null;
  return (duration / distance) * 1000;
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
