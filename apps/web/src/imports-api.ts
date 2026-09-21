import type {
  ImportHistoryPage,
  ImportReport,
  PendingImportsPage,
  ResolveImportRequest,
  ResolveImportResult,
} from '@runcoach/shared';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `请求失败：${response.status}`);
  }
  return (await response.json()) as T;
}

export async function importFile(file: File, type: 'csv' | 'fit'): Promise<ImportReport> {
  const body = new FormData();
  body.append('file', file);
  return request<ImportReport>(`/api/imports/${type}`, { method: 'POST', body });
}

export function listPending(): Promise<PendingImportsPage> {
  return request<PendingImportsPage>('/api/imports/pending?limit=100');
}

export function listImportHistory(): Promise<ImportHistoryPage> {
  return request<ImportHistoryPage>('/api/imports/history?limit=50');
}

export function resolveImport(
  itemId: string,
  resolution: ResolveImportRequest,
): Promise<ResolveImportResult> {
  return request<ResolveImportResult>(`/api/imports/items/${itemId}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(resolution),
  });
}
