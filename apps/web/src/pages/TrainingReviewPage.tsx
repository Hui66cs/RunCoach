import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiReviewResponse, AiTrainingContext } from '@runcoach/shared';
import { ApiError, getAiContextPreview, requestAiReview } from '../api.js';
import { formatDistance, formatDuration, formatPace } from '../format.js';
import { reviewDataHints } from '../review-hints.js';

type WindowDays = 7 | 28;

interface ConfirmedReview {
  fingerprint: string;
  result: AiReviewResponse;
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-800 py-1.5 text-sm last:border-none">
      <span className="text-slate-400">{label}</span>
      <span className="font-medium text-slate-100">{value}</span>
    </div>
  );
}

function ContextDetails({ context }: { context: AiTrainingContext }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="rounded-lg border border-slate-800 p-4">
        <h4 className="mb-2 text-sm font-semibold text-slate-200">
          跑步汇总（{context.windowDays} 天）
        </h4>
        <StatRow label="跑步次数" value={`${context.running.runs}`} />
        <StatRow label="总距离" value={formatDistance(context.running.totalDistanceMeters)} />
        <StatRow
          label="总移动时长"
          value={formatDuration(context.running.totalMovingDurationSeconds)}
        />
        <StatRow
          label="平均配速"
          value={formatPace(context.running.averagePaceSecondsPerKilometer)}
        />
      </section>
      <section className="rounded-lg border border-slate-800 p-4">
        <h4 className="mb-2 text-sm font-semibold text-slate-200">计划执行（同期）</h4>
        <StatRow label="计划数" value={`${context.planSummary.plannedCount}`} />
        <StatRow label="已完成" value={`${context.planSummary.completedCount}`} />
        <StatRow label="其中已关联活动" value={`${context.planSummary.linkedCompletedCount}`} />
        <StatRow label="已跳过" value={`${context.planSummary.skippedCount}`} />
        <StatRow label="已逾期" value={`${context.planSummary.overdueCount}`} />
        <StatRow label="未到期" value={`${context.planSummary.upcomingCount}`} />
        <StatRow
          label="执行率基数（已完成+已跳过+已逾期）"
          value={`${context.planSummary.eligibleCount}`}
        />
        <StatRow
          label="执行率"
          value={
            context.planSummary.adherenceRate === null
              ? '暂无可计算计划'
              : `${(context.planSummary.adherenceRate * 100).toFixed(0)}%`
          }
        />
      </section>
      {context.weeklyVolumes.length > 0 && (
        <section className="rounded-lg border border-slate-800 p-4 md:col-span-2">
          <h4 className="mb-2 text-sm font-semibold text-slate-200">
            周汇总（仅完整落在窗口内的自然周）
          </h4>
          <ul className="grid gap-1 text-sm text-slate-300 sm:grid-cols-2">
            {context.weeklyVolumes.map((week) => (
              <li key={week.weekStartLocalDate}>
                {week.weekStartLocalDate} ~ {week.weekEndLocalDate}：{week.runs} 次 ·{' '}
                {formatDistance(week.totalDistanceMeters)} ·{' '}
                {formatDuration(week.totalMovingDurationSeconds)}
              </li>
            ))}
          </ul>
        </section>
      )}
      <details className="md:col-span-2">
        <summary className="cursor-pointer text-xs text-slate-400">
          原始上下文 JSON（与实际发送给模型的内容完全一致）
        </summary>
        <pre
          className="mt-2 overflow-x-auto rounded bg-slate-950 p-3 text-xs text-slate-300"
          data-testid="review-raw-context"
        >
          {JSON.stringify(context, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function TrainingReviewPage() {
  const [windowDays, setWindowDays] = useState<WindowDays>(28);
  const [confirmed, setConfirmed] = useState<ConfirmedReview | null>(null);
  const queryClient = useQueryClient();

  const preview = useQuery({
    queryKey: ['ai-context', windowDays],
    queryFn: () => getAiContextPreview(windowDays),
  });

  const review = useMutation({
    mutationFn: (fingerprint: string) =>
      requestAiReview({ windowDays, contextFingerprint: fingerprint }),
    onSuccess: (result, fingerprint) => {
      setConfirmed({ fingerprint, result });
    },
    onError: (error) => {
      // A stale-context rejection invalidates the confirmed fingerprint: clear
      // any state and re-fetch the preview in-page so the user can check the
      // new context and explicitly confirm again (no automatic provider call).
      // Other failures (429 etc.) keep the per-click retry behaviour.
      if (error instanceof ApiError && error.code === 'AI_CONTEXT_STALE') {
        setConfirmed(null);
        void queryClient.invalidateQueries({ queryKey: ['ai-context', windowDays] });
      }
    },
  });

  // Switching the window invalidates any previous confirmation: a new preview
  // (and a new explicit confirmation) is always required before sending.
  const reviewReset = review.reset;
  useEffect(() => {
    reviewReset();
    setConfirmed(null);
  }, [windowDays, reviewReset]);

  // If the preview refetches with a different fingerprint (data or canonical
  // today changed), the previously confirmed review is marked outdated and a
  // new confirmation is required.
  const reviewIsStale =
    confirmed !== null &&
    (review.isPending ||
      preview.data === undefined ||
      preview.data.contextFingerprint !== confirmed.fingerprint);

  // Deterministic pre-send hints, always derived from the currently displayed
  // preview context: switching the window or refetching updates them with the
  // new context and they never trigger a model call.
  const dataHints = preview.data === undefined ? [] : reviewDataHints(preview.data.context);
  const fingerprint = preview.data?.contextFingerprint ?? null;
  const aiEnabled = preview.data?.aiEnabled === true;
  // isFetching also disables confirming while a re-preview (e.g. after a 409
  // stale rejection) is in flight, so the old fingerprint can never be sent
  // again; the refreshed context always requires a fresh explicit click.
  const canConfirm =
    preview.isSuccess &&
    !preview.isFetching &&
    aiEnabled &&
    fingerprint !== null &&
    !review.isPending;

  const confirm = () => {
    if (!canConfirm || fingerprint === null) return;
    review.mutate(fingerprint);
  };

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-5">
        <h1 className="text-2xl font-bold">训练回顾</h1>
        <p className="mt-1 text-sm text-slate-400">
          先查看将发送的完整上下文，再逐次确认请求 AI 回顾。确认前不会向云端发送任何数据。
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="回顾范围">
        {([7, 28] as const).map((days) => (
          <button
            key={days}
            type="button"
            aria-pressed={windowDays === days}
            onClick={() => setWindowDays(days)}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${
              windowDays === days
                ? 'bg-emerald-500 text-slate-950'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            近 {days} 天
          </button>
        ))}
      </div>

      {preview.isLoading && (
        <p
          className="rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400"
          data-testid="review-preview-loading"
        >
          正在生成预览…
        </p>
      )}
      {preview.isError && (
        <div
          className="rounded-lg border border-red-800 bg-red-950/40 p-4"
          data-testid="review-preview-error"
        >
          <p className="text-sm text-red-300">预览加载失败：{preview.error.message}</p>
          <button
            type="button"
            onClick={() => void preview.refetch()}
            className="mt-2 rounded bg-slate-800 px-3 py-1.5 text-sm"
          >
            重试
          </button>
        </div>
      )}

      {preview.data !== undefined && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">将发送的上下文（只读预览）</h2>
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                aiEnabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-600/40 text-slate-300'
              }`}
              data-testid="review-ai-enabled"
            >
              {aiEnabled ? 'AI 回顾已启用' : 'AI 回顾未启用'}
            </span>
          </div>
          <p className="mb-3 text-sm text-slate-400">
            统计窗口：{preview.data.context.windowStartLocalDate} ~{' '}
            {preview.data.context.windowEndLocalDate}（今日{' '}
            {preview.data.context.generatedForLocalDate}，时区 UTC
            {preview.data.context.timezoneOffsetMinutes >= 0 ? '+' : ''}
            {preview.data.context.timezoneOffsetMinutes / 60}）
          </p>
          {dataHints.length > 0 && (
            <div
              className="mb-4 rounded-lg border border-sky-800/60 bg-sky-950/30 p-3 text-sm text-sky-200"
              data-testid="review-data-hints"
            >
              <p className="mb-1 font-medium">本次可回顾数据</p>
              <ul className="list-disc space-y-1 pl-5">
                {dataHints.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-sky-300/80">
                以上为确定性提示，仅基于本次预览的数值；你仍可自行确认发送。
              </p>
            </div>
          )}
          <p className="mb-4 rounded-lg border border-amber-700/60 bg-amber-950/30 p-3 text-sm text-amber-200">
            确认后，以下<b>仅这些数值汇总</b>将发送到 DeepSeek
            云端接口：跑步距离/时长/配速、完整周汇总与计划完成计数。不包含原始导入文件、GPS
            轨迹、samples、心率明细、每日状态或备注。云端可能按其条款处理输入，
            发送前请确认你接受这一点。
          </p>
          <ContextDetails context={preview.data.context} />

          {!aiEnabled && (
            <p className="mt-4 text-sm text-slate-400" data-testid="review-disabled-hint">
              AI 回顾未在服务端启用（需要在服务器 .env 中配置 DeepSeek key
              并开启开关）。你仍可以查看预览；确认发送暂不可用。
            </p>
          )}
          {reviewIsStale && confirmed !== null && (
            <p className="mt-4 text-sm text-amber-300" data-testid="review-stale-hint">
              预览后的数据已发生变化，之前的确认已失效。请检查新的预览并重新确认。
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={confirm}
              disabled={!canConfirm}
              data-testid="review-confirm"
              className="rounded-lg bg-sky-500 px-5 py-2.5 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {review.isPending ? '正在请求 AI 回顾…' : '确认并发送到 DeepSeek'}
            </button>
            {review.isError &&
              !(review.error instanceof ApiError && review.error.code === 'AI_CONTEXT_STALE') && (
                <span className="text-sm text-red-300" data-testid="review-error">
                  {review.error.message}
                </span>
              )}
            {review.isError &&
              review.error instanceof ApiError &&
              review.error.code === 'AI_CONTEXT_STALE' && (
                <span className="text-sm text-amber-300" data-testid="review-stale-recovery">
                  训练上下文已变化，已在页面内重新获取预览，请检查新内容后再次确认。
                </span>
              )}
            {review.isError &&
              !(review.error instanceof ApiError && review.error.code === 'AI_CONTEXT_STALE') && (
                <button
                  type="button"
                  onClick={confirm}
                  disabled={!canConfirm}
                  className="rounded border border-slate-600 px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  重试
                </button>
              )}
          </div>
        </section>
      )}

      {confirmed !== null && !reviewIsStale && (
        <section
          className="mt-5 rounded-xl border border-emerald-700/60 bg-slate-900 p-5"
          data-testid="review-result"
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="rounded bg-purple-500/25 px-2 py-0.5 text-xs font-semibold text-purple-300">
              AI 生成
            </span>
            <span className="text-xs text-slate-400">
              模型 {confirmed.result.model} · 生成于{' '}
              {new Date(confirmed.result.generatedAt).toLocaleString()}
            </span>
          </div>
          <p
            className="whitespace-pre-wrap text-sm leading-6 text-slate-100"
            data-testid="review-text"
          >
            {confirmed.result.review}
          </p>
          <p className="mt-3 text-xs text-slate-500">
            以上文字由 AI 撰写，仅供参考，不构成医疗建议，也不是 canonical
            数据；程序计算的训练数据请以上方预览为准。
          </p>
          <button
            type="button"
            onClick={() =>
              void queryClient.invalidateQueries({ queryKey: ['ai-context', windowDays] })
            }
            className="mt-3 rounded border border-slate-600 px-3 py-1.5 text-sm"
          >
            重新检查数据
          </button>
        </section>
      )}
    </div>
  );
}
