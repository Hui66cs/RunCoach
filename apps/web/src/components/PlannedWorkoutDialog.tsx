import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type {
  CalendarActivitySummary,
  PlannedWorkout,
  PlannedWorkoutCompletionPatch,
  PlannedWorkoutCreate,
  PlannedWorkoutType,
} from '@runcoach/shared';
import { formatDistance, formatDuration } from '../format.js';
import { isOverdue } from '../local-date.js';

export const workoutTypeLabels: Record<PlannedWorkoutType, string> = {
  EASY_RUN: '轻松跑',
  LONG_RUN: '长距离跑',
  TEMPO_RUN: '节奏跑',
  INTERVAL_RUN: '间歇跑',
  RECOVERY_RUN: '恢复跑',
  RACE: '比赛',
  STRENGTH: '力量',
  REST: '休息',
  OTHER: '其他',
};

export const completionStatusLabels: Record<PlannedWorkout['completionStatus'], string> = {
  PLANNED: '待完成',
  COMPLETED: '已完成',
  SKIPPED: '已跳过',
};

export function plannedStatusBadge(workout: PlannedWorkout, today: string): string {
  if (workout.completionStatus === 'PLANNED' && isOverdue(workout.scheduledLocalDate, today)) {
    return '已逾期';
  }
  return completionStatusLabels[workout.completionStatus];
}

export function PlannedWorkoutDialog(props: {
  mode: 'create' | 'edit';
  workout: PlannedWorkout | null;
  defaultDate: string;
  today: string;
  activityCandidates: CalendarActivitySummary[];
  linkedActivity: CalendarActivitySummary | null;
  busy: boolean;
  completionBusy: boolean;
  errorMessage: string | null;
  completionError: string | null;
  onClose: () => void;
  onSubmit: (values: PlannedWorkoutCreate) => void;
  onCompletion: (request: PlannedWorkoutCompletionPatch) => void;
  onDelete?: (() => void) | undefined;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current === null) return;
    if (!ref.current.open) ref.current.showModal();
  }, []);
  const [formError, setFormError] = useState<string | null>(null);
  const [linkSelection, setLinkSelection] = useState<string>('');
  // Clear the picker once the link actually changes server-side so a failed
  // request keeps the user's selection while a success returns to placeholder.
  const linkedActivityId = props.workout?.linkedActivityId ?? null;
  useEffect(() => {
    setLinkSelection('');
  }, [linkedActivityId]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const data = new FormData(event.currentTarget);
    const field = (name: string): string => {
      const value = data.get(name);
      return typeof value === 'string' ? value.trim() : '';
    };
    const title = field('title');
    if (title.length === 0) {
      setFormError('请输入标题');
      return;
    }
    const distanceKm = field('targetDistanceKm');
    let targetDistanceMeters: number | null = null;
    if (distanceKm.length > 0) {
      const parsed = Number(distanceKm);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setFormError('目标距离必须是大于 0 的数字（单位 km）');
        return;
      }
      targetDistanceMeters = Math.round(parsed * 1000 * 100) / 100;
    }
    const hours = field('targetHours');
    const minutes = field('targetMinutes');
    let targetDurationSeconds: number | null = null;
    if (hours.length > 0 || minutes.length > 0) {
      const totalSeconds =
        (hours.length > 0 ? Number(hours) * 3600 : 0) +
        (minutes.length > 0 ? Number(minutes) * 60 : 0);
      if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
        setFormError('目标时长必须大于 0（填写小时或分钟）');
        return;
      }
      targetDurationSeconds = totalSeconds;
    }
    const notes = field('notes');
    props.onSubmit({
      scheduledLocalDate: field('scheduledLocalDate') || props.defaultDate,
      workoutType: field('workoutType') as PlannedWorkoutType,
      title,
      notes: notes.length > 0 ? notes : null,
      targetDistanceMeters,
      targetDurationSeconds,
    });
  };
  const hoursInitial = props.workout?.targetDurationSeconds
    ? Math.floor(props.workout.targetDurationSeconds / 3600)
    : '';
  const minutesInitial = props.workout?.targetDurationSeconds
    ? Math.round((props.workout.targetDurationSeconds % 3600) / 60)
    : '';
  const workout = props.workout;
  const isCompleted = workout?.completionStatus === 'COMPLETED';
  const isOverdueStatus =
    workout !== null &&
    workout.completionStatus === 'PLANNED' &&
    isOverdue(workout.scheduledLocalDate, props.today);
  const busy = props.busy || props.completionBusy;
  return (
    <dialog
      ref={ref}
      onCancel={props.onClose}
      className="rounded-xl bg-slate-900 p-0 text-slate-100 backdrop:bg-black/70"
    >
      <div className="max-w-md p-6">
        <h2 className="text-xl font-semibold">
          {props.mode === 'create' ? '新建计划训练' : '编辑计划训练'}
        </h2>
        {props.errorMessage !== null && (
          <p className="mt-3 text-sm text-red-400">{props.errorMessage}</p>
        )}
        {props.completionError !== null && (
          <p className="mt-3 text-sm text-red-400" data-testid="completion-error">
            {props.completionError}
          </p>
        )}
        {formError !== null && <p className="mt-3 text-sm text-red-400">{formError}</p>}
        {props.mode === 'edit' && workout !== null && (
          <section
            className="mt-4 rounded-lg border border-slate-700 bg-slate-950/60 p-3"
            aria-label="完成状态"
          >
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-slate-400">当前状态：</span>
              <span
                className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                  isCompleted
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : workout.completionStatus === 'SKIPPED'
                      ? 'bg-slate-500/20 text-slate-300'
                      : isOverdueStatus
                        ? 'bg-amber-500/20 text-amber-300'
                        : 'bg-sky-500/20 text-sky-300'
                }`}
                data-testid="completion-status"
              >
                {plannedStatusBadge(workout, props.today)}
              </span>
            </p>
            {workout.linkedActivityId !== null && (
              <div className="mt-2 rounded border border-sky-700/60 bg-sky-900/30 p-2 text-sm">
                <p className="text-xs text-sky-300">已关联实际活动</p>
                {props.linkedActivity !== null ? (
                  <Link
                    to={`/activities/${props.linkedActivity.id}`}
                    onClick={props.onClose}
                    className="mt-1 block font-medium text-sky-200 underline-offset-2 hover:underline"
                  >
                    {props.linkedActivity.name ?? '未命名活动'}（{props.linkedActivity.localDate}
                    {props.linkedActivity.distanceMeters != null
                      ? ` · ${formatDistance(props.linkedActivity.distanceMeters)}`
                      : ''}
                    {props.linkedActivity.durationSeconds != null
                      ? ` · ${formatDuration(props.linkedActivity.durationSeconds)}`
                      : ''}
                    ）
                  </Link>
                ) : (
                  <p className="mt-1 text-slate-400">关联的活动不在当前日历范围内。</p>
                )}
              </div>
            )}
            <div className="mt-3 grid gap-2">
              {workout.completionStatus === 'PLANNED' && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      props.onCompletion({ completionStatus: 'COMPLETED', linkedActivityId: null })
                    }
                    className="rounded bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
                  >
                    标记为已完成
                  </button>
                  <div className="grid gap-1">
                    <label className="text-sm text-slate-400" htmlFor="link-activity-select">
                      关联实际活动并完成
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <select
                        id="link-activity-select"
                        value={linkSelection}
                        onChange={(event) => setLinkSelection(event.target.value)}
                        disabled={busy || props.activityCandidates.length === 0}
                        className="min-w-0 flex-1 rounded bg-slate-950 px-3 py-2 text-sm"
                      >
                        <option value="">
                          {props.activityCandidates.length === 0
                            ? '当前范围内没有实际活动'
                            : '请选择实际活动'}
                        </option>
                        {props.activityCandidates.map((activity) => (
                          <option key={activity.id} value={activity.id}>
                            {activity.localDate} · {activity.name ?? '未命名活动'} ·{' '}
                            {activity.distanceMeters != null
                              ? formatDistance(activity.distanceMeters)
                              : '—'}
                            {activity.durationSeconds != null
                              ? ` · ${formatDuration(activity.durationSeconds)}`
                              : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busy || linkSelection === ''}
                        onClick={() =>
                          props.onCompletion({
                            completionStatus: 'COMPLETED',
                            linkedActivityId: linkSelection,
                          })
                        }
                        className="rounded bg-sky-500 px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
                      >
                        关联并完成
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => props.onCompletion({ completionStatus: 'SKIPPED' })}
                    className="rounded border border-slate-600 px-3 py-2 text-sm disabled:opacity-50"
                  >
                    标记为已跳过
                  </button>
                </>
              )}
              {isCompleted && (
                <>
                  <div className="grid gap-1">
                    <label className="text-sm text-slate-400" htmlFor="link-activity-select">
                      {workout.linkedActivityId === null ? '补充关联活动' : '更换关联活动'}
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <select
                        id="link-activity-select"
                        value={linkSelection}
                        onChange={(event) => setLinkSelection(event.target.value)}
                        disabled={busy || props.activityCandidates.length === 0}
                        className="min-w-0 flex-1 rounded bg-slate-950 px-3 py-2 text-sm"
                      >
                        <option value="">
                          {props.activityCandidates.length === 0
                            ? '当前范围内没有实际活动'
                            : '请选择实际活动'}
                        </option>
                        {props.activityCandidates.map((activity) => (
                          <option key={activity.id} value={activity.id}>
                            {activity.localDate} · {activity.name ?? '未命名活动'} ·{' '}
                            {activity.distanceMeters != null
                              ? formatDistance(activity.distanceMeters)
                              : '—'}
                            {activity.durationSeconds != null
                              ? ` · ${formatDuration(activity.durationSeconds)}`
                              : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busy || linkSelection === ''}
                        onClick={() =>
                          props.onCompletion({
                            completionStatus: 'COMPLETED',
                            linkedActivityId: linkSelection,
                          })
                        }
                        className="rounded bg-sky-500 px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
                      >
                        {workout.linkedActivityId === null ? '补充关联' : '更换关联'}
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => props.onCompletion({ completionStatus: 'PLANNED' })}
                    className="rounded border border-sky-600 px-3 py-2 text-sm text-sky-300 disabled:opacity-50"
                  >
                    恢复为待完成
                  </button>
                  {workout.linkedActivityId !== null && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        props.onCompletion({
                          completionStatus: 'COMPLETED',
                          linkedActivityId: null,
                        })
                      }
                      className="rounded border border-slate-600 px-3 py-2 text-sm disabled:opacity-50"
                    >
                      解除活动关联（保持已完成）
                    </button>
                  )}
                </>
              )}
              {workout.completionStatus === 'SKIPPED' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => props.onCompletion({ completionStatus: 'PLANNED' })}
                  className="rounded border border-sky-600 px-3 py-2 text-sm text-sky-300 disabled:opacity-50"
                >
                  恢复为待完成
                </button>
              )}
            </div>
          </section>
        )}
        <form onSubmit={submit} className="mt-4 grid max-h-[70vh] gap-3 overflow-y-auto pr-1">
          <label className="grid gap-1 text-sm">
            日期
            <input
              type="date"
              name="scheduledLocalDate"
              required
              defaultValue={props.workout?.scheduledLocalDate ?? props.defaultDate}
              className="rounded bg-slate-950 px-3 py-2"
            />
          </label>
          <label className="grid gap-1 text-sm">
            训练类型
            <select
              name="workoutType"
              defaultValue={props.workout?.workoutType ?? 'EASY_RUN'}
              className="rounded bg-slate-950 px-3 py-2"
            >
              {Object.entries(workoutTypeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            标题
            <input
              name="title"
              required
              maxLength={120}
              defaultValue={props.workout?.title ?? ''}
              placeholder="例如：轻松跑 5km"
              className="rounded bg-slate-950 px-3 py-2"
            />
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="grid gap-1 text-sm">
              目标距离 (km)
              <input
                type="number"
                name="targetDistanceKm"
                min="0.01"
                step="0.01"
                defaultValue={
                  props.workout?.targetDistanceMeters != null
                    ? props.workout.targetDistanceMeters / 1000
                    : ''
                }
                placeholder="可空"
                className="rounded bg-slate-950 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              目标小时
              <input
                type="number"
                name="targetHours"
                min="0"
                step="1"
                defaultValue={hoursInitial}
                placeholder="可空"
                className="rounded bg-slate-950 px-3 py-2"
              />
            </label>
            <label className="grid gap-1 text-sm">
              目标分钟
              <input
                type="number"
                name="targetMinutes"
                min="0"
                max="59"
                step="1"
                defaultValue={minutesInitial}
                placeholder="可空"
                className="rounded bg-slate-950 px-3 py-2"
              />
            </label>
          </div>
          <label className="grid gap-1 text-sm">
            备注
            <textarea
              name="notes"
              maxLength={2000}
              defaultValue={props.workout?.notes ?? ''}
              className="min-h-20 rounded bg-slate-950 px-3 py-2"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-emerald-500 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50"
          >
            {props.busy ? '保存中…' : '保存'}
          </button>
        </form>
        <div className="mt-4 flex justify-between">
          {props.mode === 'edit' && props.onDelete !== undefined ? (
            <button
              type="button"
              onClick={props.onDelete}
              disabled={busy}
              className="rounded border border-red-500/60 px-4 py-2 text-red-400 hover:bg-red-500/10"
            >
              删除
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={props.onClose}
            disabled={busy}
            className="rounded border border-slate-600 px-4 py-2"
          >
            关闭
          </button>
        </div>
      </div>
    </dialog>
  );
}
