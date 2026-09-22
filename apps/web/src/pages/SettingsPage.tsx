import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { getAthleteSettings, updateAthleteSettings } from '../api.js';

export function SettingsPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['settings', 'athlete'], queryFn: getAthleteSettings });
  const mutation = useMutation({
    mutationFn: updateAthleteSettings,
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['settings'] }),
        client.invalidateQueries({ queryKey: ['activity'] }),
      ]);
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nullableNumber = (key: string) => {
      const value = data.get(key);
      return typeof value === 'string' && value !== '' ? Number(value) : null;
    };
    mutation.mutate({
      maxHeartRateBpm: nullableNumber('maxHeartRateBpm'),
      restingHeartRateBpm: nullableNumber('restingHeartRateBpm'),
      thresholdHeartRateBpm: nullableNumber('thresholdHeartRateBpm'),
      timezoneOffsetMinutes: Number(data.get('timezoneOffsetMinutes')),
    });
  };
  if (query.isLoading) return <p>正在加载设置…</p>;
  if (query.isError || !query.data)
    return <p className="text-red-400">{query.error?.message ?? '设置不可用'}</p>;
  return (
    <div className="max-w-2xl">
      <h1 className="text-3xl font-bold">运动员设置</h1>
      <p className="mt-2 text-slate-400">
        这些数据只保存在本机，用于确定性分析。不会根据年龄猜测最大心率。
      </p>
      <form
        key={query.data.updatedAt}
        onSubmit={submit}
        className="mt-6 grid gap-5 rounded-xl border border-slate-800 bg-slate-900 p-6 sm:grid-cols-2"
      >
        <NumberField
          name="maxHeartRateBpm"
          label="最大心率"
          value={query.data.maxHeartRateBpm}
          min={100}
          max={240}
        />
        <NumberField
          name="restingHeartRateBpm"
          label="静息心率"
          value={query.data.restingHeartRateBpm}
          min={30}
          max={120}
        />
        <NumberField
          name="thresholdHeartRateBpm"
          label="阈值心率（可选）"
          value={query.data.thresholdHeartRateBpm}
          min={80}
          max={230}
        />
        <NumberField
          name="timezoneOffsetMinutes"
          label="本地 UTC offset（分钟）"
          value={query.data.timezoneOffsetMinutes}
          min={-840}
          max={840}
        />
        <div className="sm:col-span-2 text-sm text-slate-400">
          心率区间：最大心率百分比 · 距离单位：公制
        </div>
        <button
          disabled={mutation.isPending}
          className="w-fit rounded bg-emerald-500 px-5 py-2 font-semibold text-slate-950 disabled:opacity-50"
        >
          {mutation.isPending ? '保存中…' : '保存设置'}
        </button>
        <p aria-live="polite" className={mutation.isError ? 'text-red-400' : 'text-emerald-400'}>
          {mutation.isSuccess ? '设置已保存，活动分析已刷新。' : mutation.error?.message}
        </p>
      </form>
    </div>
  );
}

function NumberField({
  name,
  label,
  value,
  min,
  max,
}: {
  name: string;
  label: string;
  value: number | null;
  min: number;
  max: number;
}) {
  return (
    <label className="text-sm">
      {label}
      <input
        name={name}
        type="number"
        defaultValue={value ?? ''}
        min={min}
        max={max}
        className="mt-1 w-full rounded bg-slate-950 px-3 py-2"
      />
    </label>
  );
}
