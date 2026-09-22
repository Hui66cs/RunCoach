import type {
  ActivityDetail,
  ActivityListPage,
  ActivityPatch,
  ActivitySeriesResponse,
  AthleteSettings,
  AthleteSettingsPatch,
  CalendarQuery,
  CalendarResponse,
  DailyStatusEntry,
  DailyStatusRangeResponse,
  DailyStatusUpsert,
  DashboardResponse,
  PlannedWorkout,
  PlannedWorkoutCompletionPatch,
  PlannedWorkoutCreate,
  PlannedWorkoutPatch,
  TrainingSummaryQuery,
  TrainingSummaryResponse,
  TrendsQuery,
  TrendsResponse,
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
export function getDashboard(): Promise<DashboardResponse> {
  return request('/api/dashboard');
}
export function getTrends(query: TrendsQuery): Promise<TrendsResponse> {
  const params = new URLSearchParams({ weeks: String(query.weeks) });
  return request(`/api/trends?${params.toString()}`);
}
export function getCalendarRange(query: CalendarQuery): Promise<CalendarResponse> {
  const params = new URLSearchParams({ from: query.from, to: query.to });
  return request(`/api/calendar?${params.toString()}`);
}
export function getTrainingSummary(query: TrainingSummaryQuery): Promise<TrainingSummaryResponse> {
  const params = new URLSearchParams({ from: query.from, to: query.to });
  return request(`/api/training-summary?${params.toString()}`);
}
export function createPlannedWorkout(body: PlannedWorkoutCreate): Promise<PlannedWorkout> {
  return request('/api/planned-workouts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
export function updatePlannedWorkout(
  id: string,
  patch: PlannedWorkoutPatch,
): Promise<PlannedWorkout> {
  return request(`/api/planned-workouts/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}
export function updatePlannedWorkoutCompletion(
  id: string,
  patch: PlannedWorkoutCompletionPatch,
): Promise<PlannedWorkout> {
  return request(`/api/planned-workouts/${id}/completion`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}
export async function deletePlannedWorkout(id: string): Promise<void> {
  const response = await fetch(`/api/planned-workouts/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `请求失败：${response.status}`);
  }
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
export function getDailyStatusRange(localDate: string): Promise<DailyStatusRangeResponse> {
  const params = new URLSearchParams({ from: localDate, to: localDate });
  return request(`/api/daily-status?${params.toString()}`);
}
export function upsertDailyStatus(
  localDate: string,
  patch: DailyStatusUpsert,
): Promise<DailyStatusEntry> {
  return request(`/api/daily-status/${localDate}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}
export async function deleteDailyStatus(localDate: string): Promise<void> {
  const response = await fetch(`/api/daily-status/${localDate}`, { method: 'DELETE' });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `请求失败：${response.status}`);
  }
}
