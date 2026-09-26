import type {
  ActivityDetail,
  ActivityListPage,
  ActivityPatch,
  ActivitySeriesResponse,
  AiChatResponse,
  AiCoachContextResponse,
  AiContextPreviewResponse,
  AiKeyStatus,
  AiReviewResponse,
  AthleteSettings,
  ChatMessagesResponse,
  ChatSessionList,
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

/** Request failure carrying the server's error code (e.g. AI_CONTEXT_STALE). */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
      code?: string;
    } | null;
    throw new ApiError(body?.message ?? `请求失败：${response.status}`, body?.code ?? 'UNKNOWN');
  }
  // 204 (and other empty bodies) have no JSON payload.
  if (response.status === 204) return undefined as T;
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
export function getAiContextPreview(windowDays: 7 | 28): Promise<AiContextPreviewResponse> {
  return request('/api/ai/context', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ windowDays }),
  });
}
export function getAiCoachContext(): Promise<AiCoachContextResponse> {
  return request('/api/ai/coach-context');
}
export function sendCoachChat(input: {
  message: string;
  sessionId?: string;
}): Promise<AiChatResponse> {
  return request('/api/ai/coach/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}
export function listCoachSessions(): Promise<ChatSessionList> {
  return request('/api/ai/coach/chat/sessions');
}
export function getCoachMessages(sessionId: string): Promise<ChatMessagesResponse> {
  return request(`/api/ai/coach/chat/sessions/${sessionId}/messages`);
}
export function deleteCoachSession(sessionId: string): Promise<void> {
  return request(`/api/ai/coach/chat/sessions/${sessionId}`, { method: 'DELETE' });
}
export function getAiKeyStatus(): Promise<AiKeyStatus> {
  return request('/api/settings/ai');
}
export function saveAiKey(apiKey: string): Promise<AiKeyStatus> {
  return request('/api/settings/ai-key', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
}
export function clearAiKey(): Promise<AiKeyStatus> {
  return request('/api/settings/ai-key', { method: 'DELETE' });
}
export function requestAiReview(body: {
  windowDays: 7 | 28;
  contextFingerprint: string;
}): Promise<AiReviewResponse> {
  return request('/api/ai/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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
