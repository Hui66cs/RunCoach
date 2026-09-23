import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { DailyStatusEntry, DailyStatusUpsert } from '@runcoach/shared';
import {
  deleteDailyStatus,
  getAthleteSettings,
  getDailyStatusRange,
  upsertDailyStatus,
} from '../api.js';
import { browserOffsetMinutes, isValidLocalDate, localDateFromEpoch } from '../local-date.js';
import {
  buildDailyStatusUpsert,
  dailyStatusFormState,
  dailyStatusScales as scales,
  type DailyStatusFormState,
} from '../form-conversion.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';

const EMPTY_FORM_HINT = '请先填写至少一项内容；如需清空当天记录，请使用删除按钮。';

export function DailyStatusPage() {
  const [search, setSearch] = useSearchParams();
  const dateParam = search.get('date');
  const dateParamValid = dateParam !== null && isValidLocalDate(dateParam);
  // Canonical "today" uses the athlete settings timezone offset — the same
  // rule as the calendar page and the server — with the deterministic browser
  // offset only as a fallback while settings load.
  const settingsQuery = useQuery({
    queryKey: ['settings', 'athlete'],
    queryFn: getAthleteSettings,
  });
  const nowMs = Date.now();
  const today = localDateFromEpoch(
    nowMs,
    settingsQuery.data?.timezoneOffsetMinutes ?? browserOffsetMinutes(nowMs),
  );
  // A valid ?date= always wins; only a missing or invalid parameter falls back
  // to the athlete-timezone today.
  const date = dateParamValid ? dateParam : today;
  const selectDate = (next: string) => {
    const params = new URLSearchParams(search);
    params.set('date', next);
    setSearch(params);
  };
  // Normalize the URL once the settings request settles; the replace cannot
  // loop because the parameter becomes valid and then always wins.
  useEffect(() => {
    if (!dateParamValid && (settingsQuery.isSuccess || settingsQuery.isError)) {
      const params = new URLSearchParams(search);
      params.set('date', date);
      setSearch(params, { replace: true });
    }
  }, [
    date,
    dateParam,
    dateParamValid,
    search,
    setSearch,
    settingsQuery.isError,
    settingsQuery.isSuccess,
  ]);

  const client = useQueryClient();
  const entryQuery = useQuery({
    queryKey: ['daily-status', date],
    queryFn: () => getDailyStatusRange(date),
  });
  // Only trust a response that belongs to the currently selected date so a
  // slow previous-date response can never fill the form of a new date.
  const dataReady = entryQuery.data !== undefined && entryQuery.data.from === date;
  const entry: DailyStatusEntry | null = dataReady ? (entryQuery.data?.items[0] ?? null) : null;

  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const saveMutation = useMutation({
    mutationFn: ({ localDate, upsert }: { localDate: string; upsert: DailyStatusUpsert }) =>
      upsertDailyStatus(localDate, upsert),
    onSuccess: () => {
      setFormError(null);
      void client.invalidateQueries({ queryKey: ['daily-status'] });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (localDate: string) => deleteDailyStatus(localDate),
    onSuccess: () => {
      setFormError(null);
      void client.invalidateQueries({ queryKey: ['daily-status'] });
    },
  });
  // Reset transient mutation feedback when navigating to another date.
  useEffect(() => {
    saveMutation.reset();
    deleteMutation.reset();
    setFormError(null);
    setConfirmingDelete(false);
  }, [date]);

  const handleSave = (state: DailyStatusFormState) => {
    const { upsert, error } = buildDailyStatusUpsert(state);
    if (error !== null) {
      setFormError(error);
      return;
    }
    if (upsert === null) {
      setFormError(EMPTY_FORM_HINT);
      return;
    }
    saveMutation.mutate({ localDate: date, upsert });
  };

  const saveError = formError ?? saveMutation.error?.message ?? null;
  const deleteError = confirmingDelete ? null : (deleteMutation.error?.message ?? null);
  const busy = saveMutation.isPending || deleteMutation.isPending;

  return (
    <div className="max-w-2xl space-y-5">
      <header>
        <h1 className="text-3xl font-bold">每日状态</h1>
        <p className="mt-2 text-slate-400">
          记录主观感受，帮助回顾训练背景。这里只保存你的输入，不生成医疗结论，也不决定你是否应该训练。
        </p>
      </header>
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            日期
            <input
              type="date"
              value={date}
              max={today}
              onChange={(event) => {
                const next = event.target.value;
                if (isValidLocalDate(next)) selectDate(next);
              }}
              className="mt-1 block rounded bg-slate-950 px-3 py-2"
            />
          </label>
          <button
            type="button"
            onClick={() => selectDate(today)}
            className="rounded bg-slate-800 px-3 py-2 text-sm"
          >
            今天
          </button>
          <span className="text-sm text-slate-400" data-testid="daily-status-current-date">
            当前日期：{date}
          </span>
        </div>
      </section>

      {entryQuery.isError && (
        <p className="rounded-xl bg-slate-900 p-4 text-red-400">
          {entryQuery.error?.message ?? '每日状态加载失败'}
        </p>
      )}
      {!entryQuery.isError && !dataReady && <p className="text-slate-400">正在加载每日状态…</p>}
      {dataReady && (
        <DailyStatusForm
          key={`${date}:${entry?.updatedAt ?? 'empty'}`}
          entry={entry}
          busy={busy}
          errorMessage={saveError}
          onSave={handleSave}
          onDelete={() => setConfirmingDelete(true)}
        />
      )}
      {saveMutation.isSuccess && !saveMutation.isPending && (
        <p aria-live="polite" className="text-emerald-400" data-testid="daily-status-saved">
          已保存。
        </p>
      )}
      {deleteError !== null && <p className="text-red-400">{deleteError}</p>}

      <ConfirmDialog
        open={confirmingDelete}
        title="删除每日状态"
        description={`将只删除 ${date} 的每日状态记录，不影响任何实际活动、计划训练或其他日期。`}
        busy={deleteMutation.isPending}
        onConfirm={() => {
          setConfirmingDelete(false);
          deleteMutation.mutate(date);
        }}
        onCancel={() => {
          deleteMutation.reset();
          setConfirmingDelete(false);
        }}
      />
    </div>
  );
}

function DailyStatusForm(props: {
  entry: DailyStatusEntry | null;
  busy: boolean;
  errorMessage: string | null;
  onSave: (state: DailyStatusFormState) => void;
  onDelete: () => void;
}) {
  const [state, setState] = useState<DailyStatusFormState>(() => dailyStatusFormState(props.entry));
  const entry = props.entry;
  const update = (patch: Partial<DailyStatusFormState>) =>
    setState((current) => ({ ...current, ...patch }));
  const notesLength = state.notes.length;
  return (
    <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-5">
      {entry === null && (
        <p
          className="rounded-lg bg-slate-950/60 p-3 text-sm text-slate-400"
          data-testid="daily-status-empty"
        >
          当天尚未记录。
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {scales.map((scale) => (
          <fieldset key={scale.field} className="rounded-lg border border-slate-800 p-3">
            <legend className="px-1 text-sm font-medium text-slate-200">
              {scale.label}（{scale.description}）
            </legend>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {['', 1, 2, 3, 4, 5].map((value) => {
                const rawValue = String(value);
                const checked = state[scale.field] === rawValue;
                const isUnset = value === '';
                return (
                  <label
                    key={rawValue}
                    className={`flex cursor-pointer flex-col items-center rounded border px-2 py-1 text-xs ${
                      checked
                        ? isUnset
                          ? 'border-slate-400 bg-slate-700/60 text-slate-200'
                          : 'border-emerald-500 bg-emerald-500/20 text-emerald-200'
                        : 'border-slate-700 text-slate-400 hover:border-slate-500'
                    }`}
                  >
                    <input
                      type="radio"
                      name={scale.field}
                      value={rawValue}
                      checked={checked}
                      onChange={() => update({ [scale.field]: rawValue })}
                      aria-label={isUnset ? `${scale.label} 未填写` : `${scale.label} ${value}`}
                      className="accent-emerald-500"
                    />
                    <span>{isUnset ? '—' : value}</span>
                    <span className="text-[10px] text-slate-500">
                      {isUnset ? '未填写' : scale.hints[Number(value) - 1]}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
        <label className="text-sm">
          静息心率（bpm，可选，30–220）
          <input
            type="number"
            step={1}
            value={state.restingHeartRateBpm}
            onChange={(event) => update({ restingHeartRateBpm: event.target.value })}
            placeholder="可空"
            className="mt-1 w-full rounded bg-slate-950 px-3 py-2"
          />
        </label>
      </div>
      <label className="block text-sm">
        备注（可选）
        <textarea
          value={state.notes}
          maxLength={2000}
          rows={3}
          onChange={(event) => update({ notes: event.target.value })}
          className="mt-1 w-full rounded bg-slate-950 px-3 py-2"
        />
        <span className="mt-1 block text-xs text-slate-500">{notesLength}/2000</span>
      </label>
      {props.errorMessage !== null && (
        <p className="text-sm text-red-400" data-testid="daily-status-error">
          {props.errorMessage}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={props.busy}
          onClick={() => props.onSave(state)}
          className="rounded bg-emerald-500 px-5 py-2 font-semibold text-slate-950 disabled:opacity-50"
        >
          {props.busy ? '保存中…' : '保存'}
        </button>
        {entry !== null && (
          <button
            type="button"
            disabled={props.busy}
            onClick={props.onDelete}
            className="rounded border border-red-500/60 px-4 py-2 text-sm text-red-400 hover:bg-red-500/10 disabled:opacity-50"
          >
            删除当天记录
          </button>
        )}
      </div>
    </section>
  );
}
