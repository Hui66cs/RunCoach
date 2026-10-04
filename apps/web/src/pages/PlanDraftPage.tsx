import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createPlannedWorkout, getAiCoachContext, requestPlanDraft } from '../api.js';
import { ApiError } from '../api.js';
import type { AiPlanDraftResponse, PlannedWorkoutType } from '@runcoach/shared';
import { plannedWorkoutTypeSchema } from '@runcoach/shared';
import {
  applyImportResults,
  buildImportPlan,
  createDraftItems,
  describeImportFailure,
  type DraftItemState,
  type ImportItemError,
} from '../plan-draft-state.js';

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

const NOTES_MAX_CHARS = 2000;

/** AI training-plan drafts (M7 Batch 3, hardened in R3). The provider only
 * proposes items; everything is previewed and editable here, and importing
 * calls the existing planned-workout API once per confirmed item.
 *
 * R3 state rules: items carry stable client-side IDs (never titles/dates/
 * object identity); each import round freezes a validated snapshot of the
 * selected items and writes outcomes back by ID; while an operation is
 * pending every control that could change this round's ownership is locked
 * (edit, toggle, import, regenerate, horizon/instruction), with synchronous
 * re-entry guards so a double-click can never send twice. */
export function PlanDraftPage() {
  const client = useQueryClient();
  const [horizonDays, setHorizonDays] = useState<7 | 14>(7);
  const [instruction, setInstruction] = useState('');
  const [draft, setDraft] = useState<AiPlanDraftResponse | null>(null);
  const [items, setItems] = useState<DraftItemState[]>([]);
  const [generateError, setGenerateError] = useState<{
    message: string;
    retryable: boolean;
  } | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, ImportItemError>>({});
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: number; failed: number } | null>(null);
  const [completed, setCompleted] = useState(false);
  // Synchronous re-entry guards: button `disabled` alone cannot stop a
  // double-click that lands before React re-renders.
  const generateInFlight = useRef(false);
  const importInFlight = useRef(false);
  // Newer drafts invalidate in-flight rounds from earlier ones.
  const draftEpoch = useRef(0);

  const aiStatus = useQuery({ queryKey: ['ai-coach-context'], queryFn: getAiCoachContext });
  const aiEnabled = aiStatus.data?.aiEnabled !== false;

  const generate = useMutation({
    mutationFn: () =>
      requestPlanDraft({
        horizonDays,
        ...(instruction.trim() === '' ? {} : { instruction: instruction.trim() }),
      }),
    onSuccess: (data) => {
      draftEpoch.current += 1;
      setDraft(data);
      setItems(createDraftItems(data));
      setGenerateError(null);
      setItemErrors({});
      setBlockedMessage(null);
      setResult(null);
      setCompleted(false);
    },
    onError: (err) => {
      const retryable =
        err instanceof ApiError &&
        ['AI_TIMEOUT', 'AI_RATE_LIMITED', 'AI_PROVIDER_ERROR'].includes(err.code);
      setGenerateError({ message: err.message, retryable });
    },
    onSettled: () => {
      generateInFlight.current = false;
    },
  });

  const importSelected = useMutation({
    mutationFn: async ({
      snapshot,
      epoch,
    }: {
      snapshot: ReturnType<typeof buildImportPlan>;
      epoch: number;
    }) => {
      if (!snapshot.ok) {
        return { kind: 'invalid' as const, errors: snapshot.errors };
      }
      // Each request is sent exactly once, in snapshot order; outcomes are
      // matched back by the frozen IDs, never by object references.
      const settled = await Promise.allSettled(
        snapshot.snapshot.map((entry) => createPlannedWorkout(entry.payload)),
      );
      return {
        kind: 'settled' as const,
        epoch,
        snapshot,
        settled,
      };
    },
    onSuccess: async (outcome) => {
      if (outcome.kind === 'invalid') {
        setItemErrors(
          Object.fromEntries(
            outcome.errors.map((error) => [error.id, { message: error.message, uncertain: false }]),
          ),
        );
        setBlockedMessage(`有 ${outcome.errors.length} 项内容需要修正，本次未发送任何创建请求。`);
        setResult(null);
        return;
      }
      if (outcome.epoch !== draftEpoch.current) return; // stale round from an older draft
      const applied = applyImportResults(
        [...items],
        outcome.snapshot.snapshot.map((entry, index) => {
          const settled = outcome.settled[index];
          if (settled?.status === 'fulfilled') return { id: entry.id, ok: true };
          const failure = describeImportFailure(settled?.reason);
          return {
            id: entry.id,
            ok: false,
            message: failure.message,
            uncertain: failure.uncertain,
          };
        }),
      );
      setItems(applied.items);
      setItemErrors(applied.itemErrors);
      setBlockedMessage(null);
      setResult({ ok: applied.ok, failed: applied.failed });
      if (applied.failed === 0 && applied.ok > 0) setCompleted(true);
      if (applied.ok > 0) {
        await Promise.all([
          client.invalidateQueries({ queryKey: ['calendar'] }),
          client.invalidateQueries({ queryKey: ['calendar-plan'] }),
          client.invalidateQueries({ queryKey: ['training-summary'] }),
        ]);
      }
    },
    onSettled: () => {
      importInFlight.current = false;
    },
  });

  const generateBusy = generate.isPending;
  const importBusy = importSelected.isPending;
  const busy = generateBusy || importBusy;

  const startGenerate = () => {
    if (busy || generateInFlight.current) return;
    generateInFlight.current = true;
    generate.mutate();
  };
  const startImport = () => {
    if (busy || importInFlight.current) return;
    const plan = buildImportPlan(items);
    if (!plan.ok) {
      setItemErrors(
        Object.fromEntries(
          plan.errors.map((error) => [error.id, { message: error.message, uncertain: false }]),
        ),
      );
      setBlockedMessage(`有 ${plan.errors.length} 项内容需要修正，本次未发送任何创建请求。`);
      setResult(null);
      return;
    }
    importInFlight.current = true;
    setItemErrors({});
    setBlockedMessage(null);
    importSelected.mutate({ snapshot: plan, epoch: draftEpoch.current });
  };

  const updateItem = (id: string, patch: Partial<DraftItemState>) => {
    if (busy) return;
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
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
            disabled={busy}
            onChange={(event) => setHorizonDays(Number(event.target.value) as 7 | 14)}
            className="rounded bg-slate-950 px-2 py-1.5 text-sm disabled:opacity-50"
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
            disabled={busy}
            onChange={(event) => setInstruction(event.target.value)}
            className="min-w-0 flex-1 rounded bg-slate-950 px-3 py-1.5 text-sm disabled:opacity-50"
          />
          <button
            type="button"
            data-testid="draft-generate"
            disabled={busy || !aiEnabled}
            onClick={startGenerate}
            className="rounded bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-slate-950 disabled:opacity-50"
          >
            {generateBusy ? '生成中…' : '生成草稿'}
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
        {generateError !== null && (
          <p
            className="mt-2 rounded bg-red-950/40 px-3 py-2 text-sm text-red-300"
            data-testid="draft-error"
          >
            {generateError.message}
            {generateError.retryable && (
              <button
                type="button"
                onClick={startGenerate}
                disabled={busy}
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
              disabled={busy || selectedCount === 0}
              onClick={startImport}
              className="rounded bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-slate-950 disabled:opacity-50"
            >
              {importBusy ? '导入中…' : `导入所选（${selectedCount}）`}
            </button>
          </div>
          {blockedMessage !== null && (
            <p
              className="mb-3 rounded bg-amber-950/40 px-3 py-2 text-sm text-amber-200"
              data-testid="draft-blocked"
            >
              {blockedMessage}
            </p>
          )}
          {result !== null && (
            <p
              className="mb-3 rounded bg-slate-800 px-3 py-2 text-sm"
              data-testid="draft-import-result"
            >
              已导入 {result.ok} 条
              {result.failed > 0 ? `，失败 ${result.failed} 条（可修改后重试）` : '。'}
              {completed && <span data-testid="draft-complete">全部所选草稿已导入完成。</span>}
              <Link to="/calendar" className="ml-1 text-emerald-400 underline">
                前往日历查看
              </Link>
            </p>
          )}
          {items.length === 0 && completed && (
            <p className="text-sm text-slate-400" data-testid="draft-empty-after-import">
              本轮草稿已全部导入。你可以返回
              <Link to="/calendar" className="mx-1 text-emerald-400 underline">
                日历
              </Link>
              查看，或生成新草稿。
            </p>
          )}
          <ul className="space-y-2">
            {items.map((item) => (
              <li
                key={item.id}
                data-testid={`draft-item-${item.id}`}
                className={`grid grid-cols-2 gap-2 rounded-lg border p-3 md:grid-cols-[auto_9rem_7rem_1fr_6rem_5rem] md:items-center ${
                  itemErrors[item.id] !== undefined ? 'border-red-800' : 'border-slate-800'
                } ${item.include ? '' : 'opacity-50'}`}
              >
                <input
                  type="checkbox"
                  aria-label={`导入 ${item.title}`}
                  checked={item.include}
                  disabled={busy}
                  onChange={(event) => updateItem(item.id, { include: event.target.checked })}
                />
                <input
                  type="date"
                  aria-label={`日期 ${item.title}`}
                  value={item.scheduledLocalDate}
                  min={draft.draftStartLocalDate}
                  max={draft.draftEndLocalDate}
                  disabled={busy}
                  onChange={(event) =>
                    updateItem(item.id, { scheduledLocalDate: event.target.value })
                  }
                  className="rounded bg-slate-950 px-2 py-1 text-sm disabled:opacity-50"
                />
                <select
                  aria-label={`类型 ${item.title}`}
                  value={item.workoutType}
                  disabled={busy}
                  onChange={(event) =>
                    updateItem(item.id, {
                      workoutType: plannedWorkoutTypeSchema.parse(event.target.value),
                    })
                  }
                  className="rounded bg-slate-950 px-2 py-1 text-sm disabled:opacity-50"
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
                  disabled={busy}
                  onChange={(event) => updateItem(item.id, { title: event.target.value })}
                  className="rounded bg-slate-950 px-2 py-1 text-sm disabled:opacity-50"
                />
                <label className="flex items-center gap-1 text-xs text-slate-400">
                  km
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    aria-label={`距离（km） ${item.title}`}
                    disabled={busy}
                    value={
                      item.targetDistanceMeters === null || item.targetDistanceMeters === undefined
                        ? ''
                        : item.targetDistanceMeters / 1000
                    }
                    onChange={(event) =>
                      updateItem(item.id, {
                        targetDistanceMeters:
                          event.target.value === '' ? null : Number(event.target.value) * 1000,
                      })
                    }
                    className="w-full rounded bg-slate-950 px-2 py-1 text-sm disabled:opacity-50"
                  />
                </label>
                <label className="flex items-center gap-1 text-xs text-slate-400">
                  分钟
                  <input
                    type="number"
                    step="1"
                    min="0"
                    aria-label={`时长（分钟） ${item.title}`}
                    disabled={busy}
                    value={
                      item.targetDurationSeconds === null ||
                      item.targetDurationSeconds === undefined
                        ? ''
                        : Math.round(item.targetDurationSeconds / 60)
                    }
                    onChange={(event) =>
                      updateItem(item.id, {
                        targetDurationSeconds:
                          event.target.value === '' ? null : Number(event.target.value) * 60,
                      })
                    }
                    className="w-full rounded bg-slate-950 px-2 py-1 text-sm disabled:opacity-50"
                  />
                </label>
                <label className="col-span-2 flex items-center gap-2 text-xs text-slate-400 md:col-span-full">
                  备注
                  <input
                    type="text"
                    aria-label={`备注 ${item.title}`}
                    value={item.notes ?? ''}
                    maxLength={NOTES_MAX_CHARS}
                    disabled={busy}
                    placeholder="可留空"
                    onChange={(event) =>
                      updateItem(item.id, {
                        notes: event.target.value.trim() === '' ? null : event.target.value,
                      })
                    }
                    className="min-w-0 flex-1 rounded bg-slate-950 px-2 py-1 text-sm disabled:opacity-50"
                  />
                </label>
                {itemErrors[item.id] !== undefined && (
                  <p
                    role="alert"
                    data-testid={`draft-item-error-${item.id}`}
                    className={`col-span-2 text-xs md:col-span-full ${
                      itemErrors[item.id]?.uncertain ? 'text-amber-300' : 'text-red-300'
                    }`}
                  >
                    未能导入：{itemErrors[item.id]?.message}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
