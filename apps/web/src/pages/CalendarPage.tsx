import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  CalendarResponse,
  PlannedWorkout,
  PlannedWorkoutCreate,
  PlannedWorkoutPatch,
} from '@runcoach/shared';
import {
  createPlannedWorkout,
  deletePlannedWorkout,
  getCalendarRange,
  updatePlannedWorkout,
} from '../api.js';
import { formatDistance, formatDuration } from '../format.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { PlannedWorkoutDialog, workoutTypeLabels } from '../components/PlannedWorkoutDialog.js';

const activityTypeLabels: Record<string, string> = {
  RUN: '跑步',
  STRENGTH: '力量',
  OTHER: '其他',
};

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function todayLocalDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function currentMonth(): string {
  return todayLocalDate().slice(0, 7);
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

function targetSummary(workout: PlannedWorkout): string {
  if (workout.workoutType === 'REST') return '休息日';
  const parts: string[] = [];
  if (workout.targetDistanceMeters != null)
    parts.push(formatDistance(workout.targetDistanceMeters));
  if (workout.targetDurationSeconds != null)
    parts.push(formatDuration(workout.targetDurationSeconds));
  return parts.length > 0 ? parts.join(' · ') : '无目标';
}

export function CalendarPage() {
  const [search, setSearch] = useSearchParams();
  const monthParam = search.get('month');
  const month =
    monthParam !== null && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam) ? monthParam : currentMonth();
  const selectMonth = (next: string) => {
    const params = new URLSearchParams(search);
    params.set('month', next);
    setSearch(params);
  };
  // Keep the URL in sync so a default or corrected month survives a reload.
  useEffect(() => {
    if (monthParam !== month) {
      const params = new URLSearchParams(search);
      params.set('month', month);
      setSearch(params, { replace: true });
    }
  }, [month, monthParam]);
  const grid = monthGrid(month);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['calendar', grid.from, grid.to],
    queryFn: () => getCalendarRange({ from: grid.from, to: grid.to }),
    placeholderData: keepPreviousData,
  });

  const [editor, setEditor] = useState<
    { mode: 'create'; date: string } | { mode: 'edit'; workout: PlannedWorkout } | null
  >(null);
  const [pendingDelete, setPendingDelete] = useState<PlannedWorkout | null>(null);

  const createMutation = useMutation({
    mutationFn: (body: PlannedWorkoutCreate) => createPlannedWorkout(body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['calendar'] });
      setEditor(null);
    },
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PlannedWorkoutPatch }) =>
      updatePlannedWorkout(id, patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['calendar'] });
      setEditor(null);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deletePlannedWorkout(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['calendar'] });
      setPendingDelete(null);
    },
  });
  const busy = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;
  const dialogError = createMutation.error?.message ?? updateMutation.error?.message ?? null;
  const deleteError = deleteMutation.error?.message ?? null;

  const data = query.data;
  const plannedByDate = new Map<string, PlannedWorkout[]>();
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

  const renderPlanned = (workout: PlannedWorkout, compact: boolean) => (
    <button
      key={workout.id}
      type="button"
      onClick={() => setEditor({ mode: 'edit', workout })}
      className={`block w-full rounded border border-emerald-700/60 bg-emerald-900/30 px-1.5 text-left hover:border-emerald-500 ${compact ? 'py-0.5' : 'py-1'}`}
      title={`${workout.title}（点击编辑）`}
    >
      <span className="flex items-center gap-1">
        <span className="rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-300">计划</span>
        <span className="truncate text-xs font-medium">{workout.title}</span>
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

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">训练日历</h1>
          <p className="mt-2 text-slate-400">
            计划训练与实际活动按本地日期展示；绿色为计划，蓝色为实际活动。
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
            onClick={() => selectMonth(currentMonth())}
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
            onClick={() => setEditor({ mode: 'create', date: todayLocalDate() })}
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
                const isToday = date === todayLocalDate();
                return (
                  <div
                    key={date}
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
                    {date === todayLocalDate() && (
                      <span className="ml-2 text-xs text-emerald-400">今天</span>
                    )}
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
          workout={editor.mode === 'edit' ? editor.workout : null}
          defaultDate={editor.mode === 'create' ? editor.date : editor.workout.scheduledLocalDate}
          busy={busy}
          errorMessage={dialogError}
          onClose={() => {
            createMutation.reset();
            updateMutation.reset();
            setEditor(null);
          }}
          onSubmit={(values) => {
            createMutation.reset();
            updateMutation.reset();
            if (editor.mode === 'create') createMutation.mutate(values);
            else updateMutation.mutate({ id: editor.workout.id, patch: values });
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

function State({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <div
      className={`rounded-xl bg-slate-900 p-8 text-center ${error ? 'text-red-400' : 'text-slate-400'}`}
    >
      {text}
    </div>
  );
}
