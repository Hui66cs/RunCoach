import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PendingImportView, ResolveImportRequest } from '@runcoach/shared';
import { listPending, resolveImport } from '../imports-api.js';
import { ConfirmDialog } from './ConfirmDialog.js';

interface PendingAction {
  item: PendingImportView;
  request: ResolveImportRequest;
  description: string;
}

export function PendingImportsPanel() {
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const query = useQuery({ queryKey: ['imports', 'pending'], queryFn: listPending });
  const mutation = useMutation({
    mutationFn: ({ item, request }: PendingAction) => resolveImport(item.itemId, request),
    onSuccess: async () => {
      setPendingAction(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['imports'] }),
        queryClient.invalidateQueries({ queryKey: ['activities'] }),
        queryClient.invalidateQueries({ queryKey: ['activity'] }),
        // A resolved import adds a real activity, which affects the
        // Dashboard's recent stats and weekly distance.
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['calendar-plan'] }),
      ]);
    },
  });
  if (query.isLoading) return <p className="text-slate-400">正在加载待确认项目…</p>;
  if (query.isError) return <p className="text-red-400">{query.error.message}</p>;
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">待确认匹配（{query.data?.total ?? 0}）</h2>
      {query.data?.items.length === 0 && (
        <p className="rounded-xl bg-slate-900 p-5 text-slate-400">当前没有待处理项目。</p>
      )}
      {query.data?.items.map((item) => (
        <PendingCard
          key={item.itemId}
          item={item}
          busy={mutation.isPending && pendingAction?.item.itemId === item.itemId}
          onAction={setPendingAction}
        />
      ))}
      {mutation.error && (
        <p aria-live="polite" className="text-red-400">
          处理失败：{mutation.error.message}
        </p>
      )}
      <ConfirmDialog
        open={pendingAction !== null}
        title="确认处理待匹配活动"
        description={pendingAction?.description ?? ''}
        busy={mutation.isPending}
        onCancel={() => !mutation.isPending && setPendingAction(null)}
        onConfirm={() => pendingAction && mutation.mutate(pendingAction)}
      />
    </section>
  );
}

function PendingCard({
  item,
  busy,
  onAction,
}: {
  item: PendingImportView;
  busy: boolean;
  onAction: (action: PendingAction) => void;
}) {
  return (
    <article className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{item.originalFileName}</p>
          <p className="text-sm text-slate-400">
            {item.summary.localDate} · {(item.summary.distanceMeters ?? 0) / 1000} km ·{' '}
            {item.reason}
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onAction({
              item,
              request: { action: 'CREATE_NEW' },
              description: '将此 FIT 作为新的独立活动创建？',
            })
          }
          className="rounded border border-slate-600 px-3 py-2 disabled:opacity-50"
        >
          作为新活动创建
        </button>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {item.candidates.map((candidate) => (
          <div key={candidate.activityId} className="rounded-lg bg-slate-950 p-4">
            <div className="flex justify-between gap-2">
              <span>{candidate.activity.name ?? candidate.activity.activityType}</span>
              <strong>{candidate.score.toFixed(1)} 分</strong>
            </div>
            <p className="mt-2 text-sm text-slate-400">
              时间差 {Math.round(candidate.timeDifferenceSeconds)} 秒 · 距离差{' '}
              {candidate.distanceDifferenceRatio === null
                ? '—'
                : `${(candidate.distanceDifferenceRatio * 100).toFixed(1)}%`}{' '}
              · 时长差{' '}
              {candidate.durationDifferenceRatio === null
                ? '—'
                : `${(candidate.durationDifferenceRatio * 100).toFixed(1)}%`}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              时间 {candidate.components.time.toFixed(1)} / 距离{' '}
              {candidate.components.distance.toFixed(1)} / 时长{' '}
              {candidate.components.duration.toFixed(1)} / 类型{' '}
              {candidate.components.type.toFixed(1)} / 设备 {candidate.components.device.toFixed(1)}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                onAction({
                  item,
                  request: { action: 'ATTACH', activityId: candidate.activityId },
                  description: `将 FIT 合并到“${candidate.activity.name ?? candidate.activity.localDate}”？`,
                })
              }
              className="mt-3 rounded bg-emerald-500 px-3 py-2 font-medium text-slate-950 disabled:opacity-50"
            >
              合并到此活动
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          onAction({
            item,
            request: { action: 'SKIP' },
            description: '跳过后不会创建活动或来源，但会保留导入审计。',
          })
        }
        className="mt-4 text-sm text-slate-400 underline disabled:opacity-50"
      >
        跳过此项目
      </button>
    </article>
  );
}
