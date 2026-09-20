import type {
  ActivityDetail,
  ActivityListItem,
  ActivityPatch,
  ImportReport,
} from '@runcoach/shared';

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `请求失败：${response.status}`);
  }
  return (await response.json()) as T;
}

export async function listActivities(): Promise<ActivityListItem[]> {
  const response = await request<{ items: ActivityListItem[] }>('/api/activities');
  return response.items;
}

export function getActivity(activityId: string): Promise<ActivityDetail> {
  return request<ActivityDetail>(`/api/activities/${activityId}`);
}

export function updateActivity(activityId: string, patch: ActivityPatch): Promise<ActivityDetail> {
  return request<ActivityDetail>(`/api/activities/${activityId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function importFile(file: File, type: 'csv' | 'fit'): Promise<ImportReport> {
  const body = new FormData();
  body.append('file', file);
  return request<ImportReport>(`/api/imports/${type}`, { method: 'POST', body });
}
