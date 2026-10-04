// Pure state helpers for the M7 plan-draft page (R3): stable client-side item
// IDs, the fixed import snapshot validated by the shared create schema, and
// result write-back by ID. Keeping this testable keeps the page component
// thin and guarantees the import path never depends on object identity,
// titles, or dates to tell items apart.

import {
  plannedWorkoutCreateSchema,
  type AiPlanDraftItem,
  type AiPlanDraftResponse,
  type PlannedWorkoutCreate,
} from '@runcoach/shared';
import { ApiError } from './api.js';

export interface DraftItemState extends AiPlanDraftItem {
  /** Stable client-side identity: assigned once per generated draft, kept
   * across edits and toggles, never sent to any API and never stored. */
  id: string;
  include: boolean;
}

export interface DraftItemValidationError {
  id: string;
  message: string;
}

export interface ImportSnapshotEntry {
  id: string;
  payload: PlannedWorkoutCreate;
}

export type BuildImportPlanResult =
  { ok: true; snapshot: ImportSnapshotEntry[] } | { ok: false; errors: DraftItemValidationError[] };

export interface ImportOutcome {
  id: string;
  ok: boolean;
  /** Sanitized user-facing failure reason (only meaningful when ok=false). */
  message?: string;
  /** True for transport failures: the server may or may not have committed
   * the row, so the user must check the calendar before retrying. */
  uncertain?: boolean;
}

export interface ImportItemError {
  message: string;
  uncertain: boolean;
}

let idCounter = 0;
/** Monotonic, collision-free within a page session. `crypto.randomUUID` is
 * used when available; the counter keeps tests and older browsers working. */
export function newDraftItemId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  idCounter += 1;
  return `draft-item-${idCounter}`;
}

/** Assigns fresh stable IDs to a newly generated draft; every item is
 * selected for import by default. */
export function createDraftItems(
  draft: AiPlanDraftResponse,
  idFactory: () => string = newDraftItemId,
): DraftItemState[] {
  return draft.items.map((item) => ({ ...item, id: idFactory(), include: true }));
}

/** Validates and freezes what the current import round will send. Uses the
 * shared create schema (the same one the server enforces), so an invalid
 * selection refuses the WHOLE round — no request is sent until the user
 * fixes it, and values are never silently corrected. */
export function buildImportPlan(items: DraftItemState[]): BuildImportPlanResult {
  const errors: DraftItemValidationError[] = [];
  const snapshot: ImportSnapshotEntry[] = [];
  for (const item of items) {
    if (!item.include) continue;
    const candidate: Record<string, unknown> = {
      scheduledLocalDate: item.scheduledLocalDate,
      workoutType: item.workoutType,
      title: item.title,
    };
    const notes = item.notes ?? null;
    if (notes !== null && notes.trim() !== '') candidate.notes = notes;
    if (item.targetDistanceMeters !== null && item.targetDistanceMeters !== undefined) {
      candidate.targetDistanceMeters = item.targetDistanceMeters;
    }
    if (item.targetDurationSeconds !== null && item.targetDurationSeconds !== undefined) {
      candidate.targetDurationSeconds = item.targetDurationSeconds;
    }
    const parsed = plannedWorkoutCreateSchema.safeParse(candidate);
    if (!parsed.success) {
      errors.push({ id: item.id, message: describeWorkoutIssues(parsed.error.issues) });
      continue;
    }
    snapshot.push({ id: item.id, payload: parsed.data });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, snapshot };
}

/** Writes this round's outcomes back by stable ID: imported items leave the
 * list, failures keep their exact fields and ID, and items that were not part
 * of the round (unselected, or from a newer draft) stay untouched. */
export function applyImportResults(
  items: DraftItemState[],
  results: ImportOutcome[],
): {
  items: DraftItemState[];
  itemErrors: Record<string, ImportItemError>;
  ok: number;
  failed: number;
} {
  const byId = new Map(results.map((result) => [result.id, result]));
  const itemErrors: Record<string, ImportItemError> = {};
  let ok = 0;
  let failed = 0;
  const next: DraftItemState[] = [];
  for (const item of items) {
    const outcome = byId.get(item.id);
    if (outcome === undefined) {
      next.push(item);
      continue;
    }
    if (outcome.ok) {
      ok += 1;
      continue;
    }
    failed += 1;
    next.push(item);
    itemErrors[item.id] = {
      message: outcome.message ?? '导入失败',
      uncertain: outcome.uncertain === true,
    };
  }
  return { items: next, itemErrors, ok, failed };
}

/** Classifies a rejected create request. Server responses carry a sanitized
 * message; transport errors leave the outcome unknown, and the user is told
 * to check the calendar rather than being shown a fabricated reason. */
export function describeImportFailure(error: unknown): {
  message: string;
  uncertain: boolean;
} {
  if (error instanceof ApiError) {
    return { message: error.message, uncertain: false };
  }
  return { message: '未能确认导入结果；重试前请检查日历', uncertain: true };
}

/** Maps Zod issues of the create schema to short user-facing messages. */
function describeWorkoutIssues(issues: Array<{ path: PropertyKey[]; code: string }>): string {
  const messages = issues.map((issue) => {
    const field = String(issue.path[0] ?? '');
    switch (field) {
      case 'title':
        return issue.code === 'too_big' ? '标题不能超过 120 字' : '标题不能为空';
      case 'notes':
        return '备注不能超过 2000 字';
      case 'scheduledLocalDate':
        return '日期无效或为空';
      case 'workoutType':
        return '训练类型无效';
      case 'targetDistanceMeters':
        return issue.code === 'too_big' ? '距离过大' : '距离必须是大于 0 的数字（km）';
      case 'targetDurationSeconds':
        return issue.code === 'too_big' ? '时长过大' : '时长必须是大于 0 的数字（分钟）';
      default:
        return '该条内容无效';
    }
  });
  return [...new Set(messages)].join('；');
}
