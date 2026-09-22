import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PlannedWorkout, PlannedWorkoutCreate, PlannedWorkoutType } from '@runcoach/shared';

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

export function PlannedWorkoutDialog(props: {
  mode: 'create' | 'edit';
  workout: PlannedWorkout | null;
  defaultDate: string;
  busy: boolean;
  errorMessage: string | null;
  onClose: () => void;
  onSubmit: (values: PlannedWorkoutCreate) => void;
  onDelete?: (() => void) | undefined;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current === null) return;
    if (!ref.current.open) ref.current.showModal();
  }, []);
  const [formError, setFormError] = useState<string | null>(null);
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
        {formError !== null && <p className="mt-3 text-sm text-red-400">{formError}</p>}
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
            disabled={props.busy}
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
              disabled={props.busy}
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
            disabled={props.busy}
            className="rounded border border-slate-600 px-4 py-2"
          >
            关闭
          </button>
        </div>
      </div>
    </dialog>
  );
}
