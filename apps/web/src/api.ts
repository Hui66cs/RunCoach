import type {
  ActivityDetail,
  ActivityListPage,
  ActivityPatch,
  ActivitySeriesResponse,
  AthleteSettings,
  AthleteSettingsPatch,
} from '@runcoach/shared';

export async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `请求失败：${response.status}`);
  }
  return (await response.json()) as T;
}
export function listActivities(params: URLSearchParams): Promise<ActivityListPage> {
  return request(`/api/activities?${params.toString()}`);
}
export function getActivity(id: string): Promise<ActivityDetail> {
  return request(`/api/activities/${id}`);
}
export function getActivitySeries(
  id: string,
  params: URLSearchParams,
): Promise<ActivitySeriesResponse> {
  return request(`/api/activities/${id}/series?${params.toString()}`);
}
export function updateActivity(id: string, patch: ActivityPatch): Promise<ActivityDetail> {
  return request(`/api/activities/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}
export function getAthleteSettings(): Promise<AthleteSettings> {
  return request('/api/settings/athlete');
}
export function updateAthleteSettings(patch: AthleteSettingsPatch): Promise<AthleteSettings> {
  return request('/api/settings/athlete', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}
