import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  CalendarPlannedWorkout,
  CalendarResponse,
  PlannedWorkoutCompletionPatch,
  PlannedWorkoutCreate,
  PlannedWorkoutPatch,
  TrainingSummaryWeeklyRollup,
} from '@runcoach/shared';
import {
  createPlannedWorkout,
  deletePlannedWorkout,
  getAthleteSettings,
  getCalendarRange,
  getTrainingSummary,
  updatePlannedWorkout,
  updatePlannedWorkoutCompletion,
} from '../api.js';
import { formatDistance, formatDuration } from '../format.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import {
  PlannedWorkoutDialog,
  plannedStatusBadge,
  workoutTypeLabels,
} from '../components/PlannedWorkoutDialog.js';
import {
  browserOffsetMinutes,
  canonicalMonth,
  isOverdue,
  localDateFromEpoch,
} from '../local-date.js';

const activityTypeLabels: Record<string, string> = {
  RUN: '跑步',
  STRENGTH: '力量',
  OTHER: '其他',
};

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function isoDayOfWeek(date: string): number {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function addMonths(month: string, delta: number): string {
  const [year, monthPart] = month.split('-').map(Number) as [number, number];
  const next = new Date(Date.UTC(year, monthPart - 1 + delta, 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}`;
}

interface MonthGrid {
  from: string;
  to: string;
  dates: string[];
  monthDates: string[];
}

function monthGrid(month: string): MonthGrid {
  const first = `${month}-01`;
  const lead = isoDayOfWeek(first) - 1;
  const total = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const rows = Math.ceil((lead + total) / 7);
  const from = addDays(first, -lead);
  const dates = Array.from({ length: rows * 7 }, (_, index) => addDays(from, index));
  const monthDates = Array.from({ length: total }, (_, index) => addDays(first, index));
  return { from, to: addDays(from, rows * 7 - 1), dates, monthDates };
}

function targetSummary(workout: CalendarPlannedWorkout): string {
  if (workout.workoutType === 'REST') return '休息日';
  const parts: string[] = [];
  if (workout.targetDistanceMeters != null)
    parts.push(formatDistance(workout.targetDistanceMeters));
  if (workout.targetDurationSeconds != null)
    parts.push(formatDuration(workout.targetDurationSeconds));
  return parts.length > 0 ? parts.join(' · ') : '无目标';
}

function plannedEntryClasses(workout: CalendarPlannedWorkout, today: string, compact: boolean) {
  const base = `block w-full rounded border px-1.5 text-left ${compact ? 'py-0.5' : 'py-1'}`;
  if (workout.completionStatus === 'COMPLETED') {
    return `${base} border-emerald-500/80 bg-emerald-800/40 hover:border-emerald-400`;
  }
  if (workout.completionStatus === 'SKIPPED') {
    return `${base} border-slate-600/70 bg-slate-800/40 opacity-70 hover:border-slate-400`;
  }
  if (workout.completionStatus === 'PLANNED' && isOverdue(workout.scheduledLocalDate, today)) {
    return `${base} border-amber-600/70 bg-amber-900/30 hover:border-amber-400`;
  }
  return `${base} border-emerald-700/60 bg-emerald-900/30 hover:border-emerald-500`;
}

function plannedBadgeClasses(workout: CalendarPlannedWorkout, today: string) {
  if (workout.completionStatus === 'COMPLETED') return 'bg-emerald-500/30 text-emerald-200';
  if (workout.completionStatus === 'SKIPPED') return 'bg-slate-500/30 text-slate-300';
  if (workout.completionStatus === 'PLANNED' && isOverdue(workout.scheduledLocalDate, today)) {
    return 'bg-amber-500/20 text-amber-300';
  }
  return 'bg-emerald-500/20 text-emerald-300';
}

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(0)}%`;
}

function weekLabel(rollup: TrainingSummaryWeeklyRollup): string {
  return `${rollup.weekStartLocalDate.slice(5)} ~ ${rollup.weekEndLocalDate.slice(5)}`;
}

export function CalendarPage() {
  const [search, setSearch] = useSearchParams();
  // Canonical "today" comes from the athlete settings timezone offset — the
  // same source the server uses for training-summary's overdue/upcoming
  // classification — never from the browser timezone. While settings are
  // loading (or failed) the browser offset is a deterministic fallback, and
  // the classification switches once settings resolve.
  const settingsQuery = useQuery({
    queryKey: ['settings', 'athlete'],
    queryFn: getAthleteSettings,
  });
  const nowMs = Date.now();
  const canonicalToday = localDateFromEpoch(
    nowMs,
    settingsQuery.data?.timezoneOffsetMinutes ?? browserOffsetMinutes(nowMs),
  );
  const today = canonicalToday;
  const monthParam = search.get('month');
  const monthParamValid = monthParam !== null && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam);
  // A valid ?month=YYYY-MM always wins; only a missing or invalid parameter
  // falls back to the athlete-timezone current month.
  const month = monthParamValid
    ? monthParam
    : canonicalMonth(
        nowMs,
        settingsQuery.data?.timezoneOffsetMinutes ?? browserOffsetMinutes(nowMs),
      );
  const selectMonth = (next: string) => {
    const params = new URLSearchParams(search);
    params.set('month', next);
    setSearch(params);
  };
  // Keep the URL in sync so a default or corrected month survives a reload.
  // The replace runs once the settings request has settled, so the fallback
  // month is final and the effect cannot loop: after the replace the parameter
  // is valid and wins over any fallback.
  useEffect(() => {
    if (!monthParamValid && (settingsQuery.isSuccess || settingsQuery.isError)) {
      const params = new URLSearchParams(search);
      params.set('month', month);
      setSearch(params, { replace: true });
    }
  }, [month, monthParam, monthParamValid, search, settingsQuery.isError, settingsQuery.isSuccess]);
  const grid = monthGrid(month);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['calendar', grid.from, grid.to],
    queryFn: () => getCalendarRange({ from: grid.from, to: grid.to }),
    placeholderData: keepPreviousData,
  });
  // Monthly adherence uses the real first-to-last month dates so adjacent
  // filler days from the grid never leak into the month rate.
  const monthFrom = grid.monthDates[0]!;
  const monthTo = grid.monthDates[grid.monthDates.length - 1]!;
  const summaryQuery = useQuery({
    queryKey: ['training-summary', monthFrom, monthTo],
    queryFn: () => getTrainingSummary({ from: monthFrom, to: monthTo }),
  });

  const [editor, setEditor] = useState<
    { mode: 'create'; date: string } | { mode: 'edit'; workout: CalendarPlannedWorkout } | null
  >(null);
  const [pendingDelete, setPendingDelete] = useState<CalendarPlannedWorkout | null>(null);

  const invalidateCalendarData = () => {
    void client.invalidateQueries({ queryKey: ['calendar'] });
    void client.invalidateQueries({ queryKey: ['training-summary'] });
  };

  const createMutation = useMutation({
    mutationFn: (body: PlannedWorkoutCreate) => createPlannedWorkout(body),
    onSuccess: () => {
      invalidateCalendarData();
      setEditor(null);
    },
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PlannedWorkoutPatch }) =>
      updatePlannedWorkout(id, patch),
    onSuccess: () => {
      invalidateCalendarData();
      setEditor(null);
    },
  });
  const completionMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PlannedWorkoutCompletionPatch }) =>
      updatePlannedWorkoutCompletion(id, patch),
    onSuccess: () => {
      invalidateCalendarData();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deletePlannedWorkout(id),
    onSuccess: () => {
      invalidateCalendarData();
      setPendingDelete(null);
    },
  });
  const busy = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;
  const completionBusy = completionMutation.isPending;
  const dialogError = createMutation.error?.message ?? updateMutation.error?.message ?? null;
  const completionError = completionMutation.error?.message ?? null;
  const deleteError = deleteMutation.error?.message ?? null;

  const data = query.data;
  const plannedByDate = new Map<string, CalendarPlannedWorkout[]>();
  const activitiesByDate = new Map<string, CalendarResponse['activities']>();
  for (const workout of data?.plannedWorkouts ?? []) {
    plannedByDate.set(workout.scheduledLocalDate, [
      ...(plannedByDate.get(workout.scheduledLocalDate) ?? []),
      workout,
    ]);
  }
  for (const activity of data?.activities ?? []) {
    activitiesByDate.set(activity.localDate, [
      ...(activitiesByDate.get(activity.localDate) ?? []),
      activity,
    ]);
  }
  const monthHasContent =
    grid.monthDates.some((date) => plannedByDate.has(date)) ||
    grid.monthDates.some((date) => activitiesByDate.has(date));

  const renderPlanned = (workout: CalendarPlannedWorkout, compact: boolean) => (
    <button
      key={workout.id}
      type="button"
      onClick={() => setEditor({ mode: 'edit', workout })}
      className={plannedEntryClasses(workout, today, compact)}
      title={`${workout.title}（${plannedStatusBadge(workout, today)}，点击编辑）`}
    >
      <span className="flex items-center gap-1">
        <span
          className={`rounded px-1 text-[10px] font-semibold ${plannedBadgeClasses(workout, today)}`}
        >
          {plannedStatusBadge(workout, today)}
        </span>
        <span
          className={`truncate text-xs font-medium ${
            workout.completionStatus === 'SKIPPED' ? 'line-through' : ''
          }`}
        >
          {workout.title}
        </span>
      </span>
      <span className="mt-0.5 block truncate text-[11px] text-slate-400">
        {workoutTypeLabels[workout.workoutType]} · {targetSummary(workout)}
      </span>
    </button>
  );

  const renderActivity = (activity: CalendarResponse['activities'][number], compact: boolean) => (
    <Link
      key={activity.id}
      to={`/activities/${activity.id}`}
      className={`block w-full rounded border border-sky-700/60 bg-sky-900/30 px-1.5 text-left hover:border-sky-500 ${compact ? 'py-0.5' : 'py-1'}`}
      title={`${activity.name ?? '未命名活动'}（点击查看详情）`}
    >
      <span className="flex items-center gap-1">
        <span className="rounded bg-sky-500/20 px-1 text-[10px] text-sky-300">实际</span>
        <span className="truncate text-xs font-medium">{activity.name ?? '未命名活动'}</span>
      </span>
      <span className="mt-0.5 block truncate text-[11px] text-slate-400">
        {activityTypeLabels[activity.activityType]}
        {activity.distanceMeters != null ? ` · ${formatDistance(activity.distanceMeters)}` : ''}
        {activity.durationSeconds != null ? ` · ${formatDuration(activity.durationSeconds)}` : ''}
      </span>
    </Link>
  );

  const summary = summaryQuery.data;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">训练日历</h1>
          <p className="mt-2 text-slate-400">
            计划训练与实际活动按本地日期展示；计划按状态标注，蓝色为实际活动。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => selectMonth(addMonths(month, -1))}
            className="rounded bg-slate-800 px-3 py-2 text-sm"
          >
            ← 上一月
          </button>
          <button
            onClick={() => selectMonth(today.slice(0, 7))}
            className="rounded bg-slate-800 px-3 py-2 text-sm"
          >
            今天
          </button>
          <button
            onClick={() => selectMonth(addMonths(month, 1))}
            className="rounded bg-slate-800 px-3 py-2 text-sm"
          >
            下一月 →
          </button>
          <button
            onClick={() => setEditor({ mode: 'create', date: today })}
            className="rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950"
          >
            添加训练
          </button>
        </div>
      </header>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold" data-month={month}>
          {month}
        </h2>
        {query.isPlaceholderData && (
          <span aria-live="polite" className="text-sm text-slate-500">
            正在更新…
          </span>
        )}
      </div>

      {/* 本月执行汇总：只统计月首到月末的计划 */}
      <section
        className="rounded-xl border border-slate-800 bg-slate-900 p-4"
        aria-label="本月训练执行汇总"
        data-testid="training-summary"
      >
        <h3 className="text-base font-semibold">
          本月执行（{monthFrom} ~ {monthTo}）
          {summary !== undefined && (
            <span
              className="ml-2 text-xs font-normal text-slate-500"
              data-testid="summary-generated-for"
            >
              截至 {summary.generatedForLocalDate}
            </span>
          )}
        </h3>
        {summaryQuery.isLoading && <p className="mt-3 text-sm text-slate-400">正在加载训练汇总…</p>}
        {summaryQuery.isError && (
          <p className="mt-3 text-sm text-red-400">
            {summaryQuery.error?.message ?? '训练汇总加载失败'}
          </p>
        )}
        {summary !== undefined && summary.summary.plannedCount === 0 && (
          <p className="mt-3 text-sm text-slate-400">本月暂无计划训练，执行率暂无可计算计划。</p>
        )}
        {summary !== undefined && summary.summary.plannedCount > 0 && (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <SummaryStat
                label="本月计划"
                value={`${summary.summary.plannedCount}`}
                data-testid="summary-planned-count"
              />
              <SummaryStat
                label="已完成"
                value={`${summary.summary.completedCount}`}
                data-testid="summary-completed-count"
              />
              <SummaryStat
                label="已跳过 / 逾期"
                value={`${summary.summary.skippedCount} / ${summary.summary.overdueCount}`}
                data-testid="summary-skipped-overdue"
              />
              <SummaryStat
                label="执行率"
                value={
                  summary.summary.adherenceRate === null
                    ? '暂无可计算计划'
                    : `${(summary.summary.adherenceRate * 100).toFixed(0)}%`
                }
                data-testid="adherence-rate"
              />
            </div>
            <div className="mt-4">
              <p className="text-sm font-semibold text-slate-300">按周汇总</p>
              {/* 桌面端紧凑表格 */}
              <table className="mt-2 hidden w-full text-left text-xs md:table">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1 pr-2 font-normal">周</th>
                    <th className="py-1 pr-2 font-normal">计划</th>
                    <th className="py-1 pr-2 font-normal">完成</th>
                    <th className="py-1 pr-2 font-normal">跳过</th>
                    <th className="py-1 pr-2 font-normal">逾期</th>
                    <th className="py-1 pr-2 font-normal">待完成</th>
                    <th className="py-1 font-normal">执行率</th>
                  </tr>
                </thead>
                <tbody className="text-slate-300">
                  {summary.weeklyRollups.map((rollup) => (
                    <tr key={rollup.weekStartLocalDate} className="border-t border-slate-800">
                      <td className="py-1 pr-2">{weekLabel(rollup)}</td>
                      <td className="py-1 pr-2">{rollup.plannedCount}</td>
                      <td className="py-1 pr-2">{rollup.completedCount}</td>
                      <td className="py-1 pr-2">{rollup.skippedCount}</td>
                      <td className="py-1 pr-2">{rollup.overdueCount}</td>
                      <td className="py-1 pr-2">
                        {rollup.plannedCount - rollup.completedCount - rollup.skippedCount}
                      </td>
                      <td className="py-1">{formatRate(rollup.adherenceRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* 窄屏：紧凑列表，不依赖横向滚动或 hover */}
              <ul className="mt-2 space-y-1 text-xs text-slate-300 md:hidden">
                {summary.weeklyRollups.map((rollup) => (
                  <li key={rollup.weekStartLocalDate} className="rounded bg-slate-950/60 p-2">
                    <p className="font-medium text-slate-200">{weekLabel(rollup)}</p>
                    <p className="mt-1 text-slate-400">
                      计划 {rollup.plannedCount} · 完成 {rollup.completedCount} · 跳过{' '}
                      {rollup.skippedCount} · 逾期 {rollup.overdueCount} · 执行率{' '}
                      {formatRate(rollup.adherenceRate)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </section>

      {query.isLoading && <State text="正在加载日历…" />}
      {query.isError && <State text={query.error?.message ?? '日历加载失败'} error />}
      {data !== undefined && !monthHasContent && (
        <p className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
          本月暂无计划训练或实际活动。点击某一天的“+”或右上角“添加训练”创建计划。
        </p>
      )}
      {data !== undefined && (
        <>
          {/* 桌面端：完整月历网格 */}
          <div className="hidden md:block">
            <div className="grid grid-cols-7 gap-1 text-center text-xs text-slate-400">
              {['一', '二', '三', '四', '五', '六', '日'].map((label) => (
                <div key={label} className="py-1">
                  周{label}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {grid.dates.map((date) => {
                const inMonth = date.startsWith(month);
                const isToday = date === today;
                return (
                  <div
                    key={date}
                    data-testid={isToday ? 'today-cell' : undefined}
                    className={`min-h-28 rounded-lg border p-1.5 ${
                      inMonth
                        ? 'border-slate-800 bg-slate-900'
                        : 'border-slate-900 bg-slate-950/60 opacity-50'
                    } ${isToday ? 'ring-1 ring-emerald-500' : ''}`}
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <span
                        className={`text-xs ${isToday ? 'font-bold text-emerald-400' : 'text-slate-400'}`}
                      >
                        {date.slice(8)}
                      </span>
                      {inMonth && (
                        <button
                          type="button"
                          aria-label={`在 ${date} 添加训练`}
                          className="rounded px-1 text-xs text-slate-500 hover:bg-slate-800 hover:text-emerald-400"
                          onClick={() => setEditor({ mode: 'create', date })}
                        >
                          +
                        </button>
                      )}
                    </div>
                    <div className="space-y-1">
                      {(plannedByDate.get(date) ?? []).map((workout) =>
                        renderPlanned(workout, true),
                      )}
                      {(activitiesByDate.get(date) ?? []).map((activity) =>
                        renderActivity(activity, true),
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {/* 窄屏：按日期排列的 agenda 视图 */}
          <div className="space-y-3 md:hidden">
            {grid.monthDates.map((date) => {
              const planned = plannedByDate.get(date) ?? [];
              const dayActivities = activitiesByDate.get(date) ?? [];
              if (planned.length === 0 && dayActivities.length === 0) return null;
              return (
                <div key={date} className="rounded-xl border border-slate-800 bg-slate-900 p-3">
                  <p className="mb-2 text-sm font-semibold text-slate-300">
                    {date}
                    {date === today && <span className="ml-2 text-xs text-emerald-400">今天</span>}
                  </p>
                  <div className="space-y-1.5">
                    {planned.map((workout) => renderPlanned(workout, false))}
                    {dayActivities.map((activity) => renderActivity(activity, false))}
                  </div>
                </div>
              );
            })}
            {!monthHasContent && (
              <p className="rounded-xl bg-slate-900 p-6 text-center text-sm text-slate-400">
                本月暂无内容。
              </p>
            )}
          </div>
        </>
      )}

      {editor !== null && (
        <PlannedWorkoutDialog
          key={editor.mode === 'edit' ? editor.workout.id : editor.date}
          mode={editor.mode}
          workout={
            editor.mode === 'edit'
              ? (data?.plannedWorkouts.find((entry) => entry.id === editor.workout.id) ??
                editor.workout)
              : null
          }
          defaultDate={editor.mode === 'create' ? editor.date : editor.workout.scheduledLocalDate}
          today={today}
          activityCandidates={data?.activities ?? []}
          linkedActivity={
            editor.mode === 'edit'
              ? (
                  data?.plannedWorkouts.find((entry) => entry.id === editor.workout.id) ??
                  editor.workout
                ).linkedActivity
              : null
          }
          busy={busy}
          completionBusy={completionBusy}
          errorMessage={dialogError}
          completionError={completionError}
          onClose={() => {
            createMutation.reset();
            updateMutation.reset();
            completionMutation.reset();
            setEditor(null);
          }}
          onSubmit={(values) => {
            createMutation.reset();
            updateMutation.reset();
            if (editor.mode === 'create') createMutation.mutate(values);
            else updateMutation.mutate({ id: editor.workout.id, patch: values });
          }}
          onCompletion={(request) => {
            if (editor.mode !== 'edit') return;
            completionMutation.reset();
            completionMutation.mutate({ id: editor.workout.id, patch: request });
          }}
          onDelete={
            editor.mode === 'edit'
              ? () => {
                  const workout = editor.workout;
                  setEditor(null);
                  setPendingDelete(workout);
                }
              : undefined
          }
        />
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除计划训练"
        description={
          pendingDelete === null
            ? ''
            : `将删除 ${pendingDelete.scheduledLocalDate} 的「${pendingDelete.title}」。此操作不可撤销，且不会影响任何实际活动。`
        }
        busy={deleteMutation.isPending}
        onConfirm={() => {
          if (pendingDelete !== null) deleteMutation.mutate(pendingDelete.id);
        }}
        onCancel={() => {
          deleteMutation.reset();
          setPendingDelete(null);
        }}
      />
      {deleteError !== null && <State text={deleteError} error />}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  'data-testid': testId,
}: {
  label: string;
  value: string;
  'data-testid'?: string;
}) {
  return (
    <div className="rounded-lg bg-slate-950/60 p-2">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-slate-100" data-testid={testId}>
        {value}
      </p>
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
