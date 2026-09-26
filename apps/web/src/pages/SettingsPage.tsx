import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AthleteSettings, AthleteSettingsPatch } from '@runcoach/shared';
import {
  clearAiKey,
  getAiKeyStatus,
  getAthleteSettings,
  saveAiKey,
  updateAthleteSettings,
} from '../api.js';
import {
  athleteProfileFormState,
  buildAthleteProfilePatch,
  type AthleteProfileFormState,
} from '../form-conversion.js';

const experienceOptions: Array<{ value: string; label: string }> = [
  { value: '', label: '未设置' },
  { value: 'BEGINNER', label: '入门' },
  { value: 'INTERMEDIATE', label: '有一定经验' },
  { value: 'ADVANCED', label: '进阶' },
];

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
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-3xl font-bold">运动员设置</h1>
        <p className="mt-2 text-slate-400">
          这些数据只保存在本机，用于确定性分析。不会根据年龄猜测最大心率。
        </p>
      </div>
      <form
        key={query.data.updatedAt}
        onSubmit={submit}
        className="grid gap-5 rounded-xl border border-slate-800 bg-slate-900 p-6 sm:grid-cols-2"
      >
        <h2 className="text-lg font-semibold sm:col-span-2">心率与分析设置</h2>
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
      <ProfileSection settings={query.data} />
      <AiKeySection />
    </div>
  );
}

/** DeepSeek key configuration for the training review (M6 Batch 5). The key
 * is stored server-side in the data directory; the UI only ever sees a
 * masked tail. Saving enables the integration without any .env editing. */
function AiKeySection() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: ['settings', 'ai-key'], queryFn: getAiKeyStatus });
  const [apiKey, setApiKey] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => saveAiKey(apiKey.trim()),
    onSuccess: async (data) => {
      setApiKey('');
      setFormError(null);
      setNotice(`已保存并启用（${data.maskedTail ?? '****'}）。发送前仍需在回顾页逐次确认。`);
      await client.invalidateQueries({ queryKey: ['settings', 'ai-key'] });
    },
    onError: (error) => {
      setNotice(null);
      setFormError(error.message);
    },
  });
  const clear = useMutation({
    mutationFn: clearAiKey,
    onSuccess: async () => {
      setApiKey('');
      setFormError(null);
      setNotice('已清除保存的 key。');
      await client.invalidateQueries({ queryKey: ['settings', 'ai-key'] });
    },
    onError: (error) => {
      setNotice(null);
      setFormError(error.message);
    },
  });

  const configured = (status.data?.maskedTail ?? null) !== null;
  return (
    <section className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900 p-6 sm:grid-cols-2">
      <h2 className="text-lg font-semibold sm:col-span-2">AI 回顾配置（DeepSeek）</h2>
      {status.isLoading && <p className="text-sm text-slate-400 sm:col-span-2">正在加载配置…</p>}
      {status.isError && (
        <p className="text-sm text-red-400 sm:col-span-2">{status.error.message}</p>
      )}
      {status.data !== undefined && (
        <p className="text-sm text-slate-300 sm:col-span-2" data-testid="ai-key-status">
          状态：{status.data.aiEnabled ? '已启用' : '未启用'} ·{' '}
          {status.data.maskedTail !== null
            ? `已配置（${status.data.maskedTail}，来源：${
                status.data.source === 'file' ? '本页设置' : '环境变量'
              }）`
            : '尚未配置 API key'}
        </p>
      )}
      <label className="text-sm sm:col-span-2">
        DeepSeek API key
        <input
          name="aiApiKey"
          type="password"
          autoComplete="off"
          maxLength={200}
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            setNotice(null);
            setFormError(null);
          }}
          placeholder="sk-..."
          className="mt-1 w-full rounded bg-slate-950 px-3 py-2"
        />
      </label>
      <p className="text-sm text-slate-400 sm:col-span-2">
        key 仅保存在本机数据目录（ai-provider.json），不会进入浏览器、日志或 Git；
        录入后训练回顾即可启用。发送数据仍受字段白名单限制，并在回顾页每次发送前 预览与确认。
      </p>
      <div className="flex flex-wrap gap-3 sm:col-span-2">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending || apiKey.trim() === ''}
          className="rounded bg-emerald-500 px-5 py-2 font-semibold text-slate-950 disabled:opacity-50"
        >
          {save.isPending ? '保存中…' : '保存并启用'}
        </button>
        <button
          type="button"
          onClick={() => clear.mutate()}
          disabled={clear.isPending || !configured}
          className="rounded border border-slate-600 px-5 py-2 text-sm disabled:opacity-50"
        >
          {clear.isPending ? '清除中…' : '清除'}
        </button>
      </div>
      <p
        aria-live="polite"
        className={`text-sm sm:col-span-2 ${formError !== null ? 'text-red-400' : 'text-emerald-400'}`}
      >
        {formError ?? notice}
      </p>
    </section>
  );
}

function ProfileSection({ settings }: { settings: AthleteSettings }) {
  const client = useQueryClient();
  const [state, setState] = useState<AthleteProfileFormState>(() =>
    athleteProfileFormState(settings),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Keep a ref of the last synced settings so a background refetch (e.g. after
  // saving the heart-rate form) refreshes the fields, while typing is never
  // interrupted.
  const syncedUpdatedAt = useRef(settings.updatedAt);
  const mutation = useMutation({
    mutationFn: (patch: AthleteSettingsPatch) => updateAthleteSettings(patch),
    onSuccess: async (data) => {
      setNotice('运动员档案已保存。');
      setFormError(null);
      await client.invalidateQueries({ queryKey: ['settings'] });
      syncedUpdatedAt.current = data.updatedAt;
      setState(athleteProfileFormState(data));
    },
    onError: (error) => {
      setNotice(null);
      setFormError(error.message);
    },
  });
  // When the settings row changes elsewhere (heart-rate save, another page),
  // refresh the profile fields; local edits during a pending save are kept.
  useEffect(() => {
    if (settings.updatedAt === syncedUpdatedAt.current) return;
    syncedUpdatedAt.current = settings.updatedAt;
    if (!mutation.isPending) {
      setState(athleteProfileFormState(settings));
      mutation.reset();
    }
  }, [settings, mutation]);

  const update = (patch: Partial<AthleteProfileFormState>) => {
    setState((current) => ({ ...current, ...patch }));
    setNotice(null);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { patch, error } = buildAthleteProfilePatch(state);
    if (error !== null) {
      setNotice(null);
      setFormError(error);
      return;
    }
    mutation.mutate(patch);
  };
  return (
    <form
      onSubmit={submit}
      className="grid gap-5 rounded-xl border border-slate-800 bg-slate-900 p-6 sm:grid-cols-2"
    >
      <h2 className="text-lg font-semibold sm:col-span-2">运动员档案</h2>
      <label className="text-sm">
        名称
        <input
          name="displayName"
          type="text"
          maxLength={80}
          value={state.displayName}
          onChange={(event) => update({ displayName: event.target.value })}
          className="mt-1 w-full rounded bg-slate-950 px-3 py-2"
        />
      </label>
      <label className="text-sm">
        跑步经验
        <select
          name="experienceLevel"
          value={state.experienceLevel}
          onChange={(event) => update({ experienceLevel: event.target.value })}
          className="mt-1 w-full rounded bg-slate-950 px-3 py-2"
        >
          {experienceOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm sm:col-span-2">
        主要训练目标
        <textarea
          name="primaryGoal"
          maxLength={200}
          rows={3}
          value={state.primaryGoal}
          onChange={(event) => update({ primaryGoal: event.target.value })}
          placeholder="例如：恢复稳定跑量，为 800 米比赛做准备"
          className="mt-1 w-full rounded bg-slate-950 px-3 py-2"
        />
      </label>
      <label className="text-sm">
        每周跑量目标（km）
        <input
          name="weeklyTargetKm"
          type="number"
          step="0.1"
          value={state.weeklyTargetKm}
          onChange={(event) => update({ weeklyTargetKm: event.target.value })}
          placeholder="例如：25.5"
          className="mt-1 w-full rounded bg-slate-950 px-3 py-2"
        />
      </label>
      <div className="sm:col-span-2 text-sm text-slate-400">
        空白字段保存为“未设置”；周跑量以 km 填写，本机以米存储。档案仅作记录，不生成训练建议。
      </div>
      <button
        disabled={mutation.isPending}
        className="w-fit rounded bg-emerald-500 px-5 py-2 font-semibold text-slate-950 disabled:opacity-50"
      >
        {mutation.isPending ? '保存中…' : '保存档案'}
      </button>
      <p aria-live="polite" className={formError !== null ? 'text-red-400' : 'text-emerald-400'}>
        {formError ?? notice}
      </p>
    </form>
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
