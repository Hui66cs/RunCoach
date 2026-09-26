import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createPlannedWorkout, getAiCoachContext, requestPlanDraft } from '../api.js';
import { ApiError } from '../api.js';
import type { AiPlanDraftItem, AiPlanDraftResponse } from '@runcoach/shared';
import { plannedWorkoutTypeSchema, type PlannedWorkoutType } from '@runcoach/shared';

const WORKOUT_TYPE_LABELS: Record<PlannedWorkoutType, string> = {
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

interface EditableDraftItem extends AiPlanDraftItem {
  include: boolean;
}

/** AI training-plan drafts (M7 Batch 3). The provider only proposes items;
 * everything is previewed and editable here, and importing calls the
 * existing planned-workout API per confirmed item. Nothing is written until
 * the user explicitly clicks 导入所选. */
export function PlanDraftPage() {
  const client = useQueryClient();
  const [horizonDays, setHorizonDays] = useState<7 | 14>(7);
  const [instruction, setInstruction] = useState('');
  const [draft, setDraft] = useState<AiPlanDraftResponse | null>(null);
  const [items, setItems] = useState<EditableDraftItem[]>([]);
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [importResult, setImportResult] = useState<{ ok: number; failed: number } | null>(null);

  const aiStatus = useQuery({ queryKey: ['ai-coach-context'], queryFn: getAiCoachContext });
  const aiEnabled = aiStatus.data?.aiEnabled !== false;

  const generate = useMutation({
    mutationFn: () =>
      requestPlanDraft({
        horizonDays,
        ...(instruction.trim() === '' ? {} : { instruction: instruction.trim() }),
      }),
    onSuccess: (data) => {
      setDraft(data);
      setItems(data.items.map((item) => ({ ...item, include: true })));
      setError(null);
      setImportResult(null);
    },
    onError: (err) => {
      const retryable =
        err instanceof ApiError &&
        ['AI_TIMEOUT', 'AI_RATE_LIMITED', 'AI_PROVIDER_ERROR'].includes(err.code);
      setError({ message: err.message, retryable });
    },
  });

  const importSelected = useMutation({
    mutationFn: async () => {
      const selected = items.filter((item) => item.include);
      const results = await Promise.allSettled(
        selected.map((item) =>
          createPlannedWorkout({
            scheduledLocalDate: item.scheduledLocalDate,
            workoutType: item.workoutType,
            title: item.title,
            notes: item.notes ?? undefined,
            targetDistanceMeters: item.targetDistanceMeters ?? undefined,
            targetDurationSeconds: item.targetDurationSeconds ?? undefined,
          }),
        ),
      );
      const failedItems = new Set(
        selected.filter((_, index) => results[index]?.status === 'rejected'),
      );
      return { ok: selected.length - failedItems.size, failedItems };
    },
    onSuccess: async (result) => {
      setImportResult({ ok: result.ok, failed: result.failedItems.size });
      // Imported items leave the list; unselected and failed ones stay.
      setItems((current) =>
        current.filter((item) => !item.include || result.failedItems.has(item)),
      );
      if (result.ok > 0) {
        await Promise.all([
          client.invalidateQueries({ queryKey: ['calendar'] }),
          client.invalidateQueries({ queryKey: ['calendar-plan'] }),
          client.invalidateQueries({ queryKey: ['training-summary'] }),
        ]);
      }
    },
  });

  const updateItem = (index: number, patch: Partial<EditableDraftItem>) => {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const selectedCount = items.filter((item) => item.include).length;

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-4">
        <h1 className="text-2xl font-bold">训练计划草稿</h1>
        <p className="text-sm text-slate-400">
          AI 根据你的训练记录提出计划建议。草稿仅供参考，只有你显式导入后才会写入日历。
        </p>
      </header>

      <section className="mb-4 rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-slate-300" htmlFor="draft-horizon">
            计划范围
          </label>
          <select
            id="draft-horizon"
            aria-label="计划范围"
            value={horizonDays}
            onChange={(event) => setHorizonDays(Number(event.target.value) as 7 | 14)}
            className="rounded bg-slate-950 px-2 py-1.5 text-sm"
          >
            <option value={7}>未来 7 天</option>
            <option value={14}>未来 14 天</option>
          </select>
          <input
            type="text"
            aria-label="偏好说明（可选）"
            placeholder="偏好说明（可选），例如：以轻松跑为主"
            maxLength={500}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            className="min-w-0 flex-1 rounded bg-slate-950 px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            data-testid="draft-generate"
            disabled={generate.isPending || !aiEnabled}
            onClick={() => generate.mutate()}
            className="rounded bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-slate-950 disabled:opacity-50"
          >
            {generate.isPending ? '生成中…' : '生成草稿'}
          </button>
        </div>
        {!aiEnabled && (
          <p className="mt-2 text-sm text-amber-200" data-testid="draft-disabled-hint">
            AI 回顾未启用。请先在
            <Link to="/settings" className="mx-1 underline">
              设置页
            </Link>
            配置 DeepSeek API key，再回来生成草稿。
          </p>
        )}
        {error !== null && (
          <p
            className="mt-2 rounded bg-red-950/40 px-3 py-2 text-sm text-red-300"
            data-testid="draft-error"
          >
            {error.message}
            {error.retryable && (
              <button
                type="button"
                onClick={() => generate.mutate()}
                disabled={generate.isPending}
                className="ml-2 rounded border border-slate-600 px-2 py-0.5 text-xs"
              >
                重试
              </button>
            )}
          </p>
        )}
      </section>

      {draft !== null && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-400" data-testid="draft-meta">
              <span className="mr-1 rounded bg-purple-500/20 px-1.5 py-0.5 text-purple-300">
                AI 生成
              </span>
              模型 {draft.model} · 生成于 {new Date(draft.generatedAt).toLocaleString()} · 草稿区间{' '}
              {draft.draftStartLocalDate} 至 {draft.draftEndLocalDate}
              。数值仅供参考，导入后可在日历中修改。
            </p>
            <button
              type="button"
              data-testid="draft-import"
              disabled={importSelected.isPending || selectedCount === 0}
              onClick={() => importSelected.mutate()}
              className="rounded bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-slate-950 disabled:opacity-50"
            >
              {importSelected.isPending ? '导入中…' : `导入所选（${selectedCount}）`}
            </button>
          </div>
          {importResult !== null && (
            <p
              className="mb-3 rounded bg-slate-800 px-3 py-2 text-sm"
              data-testid="draft-import-result"
            >
              已导入 {importResult.ok} 条
              {importResult.failed > 0 ? `，失败 ${importResult.failed} 条（可修改后重试）` : '。'}
              <Link to="/calendar" className="ml-1 text-emerald-400 underline">
                前往日历查看
              </Link>
            </p>
          )}
          <ul className="space-y-2">
            {items.map((item, index) => (
              <li
                key={index}
                className={`grid grid-cols-2 gap-2 rounded-lg border border-slate-800 p-3 md:grid-cols-[auto_9rem_7rem_1fr_6rem_5rem] md:items-center ${
                  item.include ? '' : 'opacity-50'
                }`}
              >
                <input
                  type="checkbox"
                  aria-label={`导入 ${item.title}`}
                  checked={item.include}
                  onChange={(event) => updateItem(index, { include: event.target.checked })}
                />
                <input
                  type="date"
                  aria-label={`日期 ${item.title}`}
                  value={item.scheduledLocalDate}
                  min={draft.draftStartLocalDate}
                  max={draft.draftEndLocalDate}
                  onChange={(event) =>
                    updateItem(index, { scheduledLocalDate: event.target.value })
                  }
                  className="rounded bg-slate-950 px-2 py-1 text-sm"
                />
                <select
                  aria-label={`类型 ${item.title}`}
                  value={item.workoutType}
                  onChange={(event) =>
                    updateItem(index, {
                      workoutType: plannedWorkoutTypeSchema.parse(event.target.value),
                    })
                  }
                  className="rounded bg-slate-950 px-2 py-1 text-sm"
                >
                  {(Object.keys(WORKOUT_TYPE_LABELS) as PlannedWorkoutType[]).map((type) => (
                    <option key={type} value={type}>
                      {WORKOUT_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  aria-label={`标题 ${item.title}`}
                  value={item.title}
                  maxLength={120}
                  onChange={(event) => updateItem(index, { title: event.target.value })}
                  className="rounded bg-slate-950 px-2 py-1 text-sm"
                />
                <label className="flex items-center gap-1 text-xs text-slate-400">
                  km
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    aria-label={`距离（km） ${item.title}`}
                    value={
                      item.targetDistanceMeters === null || item.targetDistanceMeters === undefined
                        ? ''
                        : item.targetDistanceMeters / 1000
                    }
                    onChange={(event) =>
                      updateItem(index, {
                        targetDistanceMeters:
                          event.target.value === '' ? null : Number(event.target.value) * 1000,
                      })
                    }
                    className="w-full rounded bg-slate-950 px-2 py-1 text-sm"
                  />
                </label>
                <label className="flex items-center gap-1 text-xs text-slate-400">
                  分钟
                  <input
                    type="number"
                    step="1"
                    min="0"
                    aria-label={`时长（分钟） ${item.title}`}
                    value={
                      item.targetDurationSeconds === null ||
                      item.targetDurationSeconds === undefined
                        ? ''
                        : Math.round(item.targetDurationSeconds / 60)
                    }
                    onChange={(event) =>
                      updateItem(index, {
                        targetDurationSeconds:
                          event.target.value === '' ? null : Number(event.target.value) * 60,
                      })
                    }
                    className="w-full rounded bg-slate-950 px-2 py-1 text-sm"
                  />
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
