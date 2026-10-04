import { describe, expect, it } from 'vitest';
import type { AiPlanDraftResponse } from '@runcoach/shared';
import { ApiError } from './api.js';
import {
  applyImportResults,
  buildImportPlan,
  createDraftItems,
  describeImportFailure,
} from './plan-draft-state.js';

const DRAFT: AiPlanDraftResponse = {
  horizonDays: 7,
  draftStartLocalDate: '2026-10-04',
  draftEndLocalDate: '2026-10-10',
  items: [
    {
      scheduledLocalDate: '2026-10-05',
      workoutType: 'EASY_RUN',
      title: '轻松跑（同日同名 A）',
      notes: '第一条备注',
      targetDistanceMeters: 4000,
      targetDurationSeconds: 1500,
    },
    {
      scheduledLocalDate: '2026-10-05',
      workoutType: 'EASY_RUN',
      title: '轻松跑（同日同名 A）',
      notes: null,
      targetDistanceMeters: 6000,
      targetDurationSeconds: null,
    },
    {
      scheduledLocalDate: '2026-10-06',
      workoutType: 'STRENGTH',
      title: '力量 B',
      notes: null,
      targetDistanceMeters: null,
      targetDurationSeconds: 2700,
    },
  ],
  model: 'fake',
  generatedAt: '2026-10-04T00:00:00.000Z',
};

function sequentialIds(): () => string {
  let index = 0;
  return () => {
    index += 1;
    return `id-${index}`;
  };
}

describe('draft item identity', () => {
  it('assigns unique stable IDs that survive edits and toggles', () => {
    const items = createDraftItems(DRAFT, sequentialIds());
    expect(items.map((item) => item.id)).toEqual(['id-1', 'id-2', 'id-3']);
    // Editing every field and toggling selection keeps the IDs unchanged.
    const edited = items.map((item) =>
      item.id === 'id-2'
        ? { ...item, include: false, title: '改过的标题', scheduledLocalDate: '2026-10-09' }
        : { ...item, notes: '改过的备注' },
    );
    expect(edited.map((item) => item.id)).toEqual(['id-1', 'id-2', 'id-3']);
  });

  it('keeps same-date same-title items distinct', () => {
    const items = createDraftItems(DRAFT, sequentialIds());
    const plan = buildImportPlan(items);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot.map((entry) => entry.id)).toEqual(['id-1', 'id-2', 'id-3']);
    // The two identical-title rows still carry their own payloads.
    expect(plan.snapshot[0]?.payload.targetDistanceMeters).toBe(4000);
    expect(plan.snapshot[1]?.payload.targetDistanceMeters).toBe(6000);
  });
});

describe('import snapshot', () => {
  it('sends one validated payload per selected item, in list order', () => {
    const items = createDraftItems(DRAFT, sequentialIds());
    items[1] = { ...items[1]!, include: false };
    const plan = buildImportPlan(items);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot.map((entry) => entry.id)).toEqual(['id-1', 'id-3']);
    expect(plan.snapshot[0]?.payload).toEqual({
      scheduledLocalDate: '2026-10-05',
      workoutType: 'EASY_RUN',
      title: '轻松跑（同日同名 A）',
      notes: '第一条备注',
      targetDistanceMeters: 4000,
      targetDurationSeconds: 1500,
    });
    // Null optional fields are omitted, never sent as fabricated values.
    expect(plan.snapshot[1]?.payload).not.toHaveProperty('targetDistanceMeters');
  });

  it('keeps unedited unit values exactly as the draft returned them', () => {
    const items = createDraftItems(DRAFT, sequentialIds());
    const plan = buildImportPlan(items);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // 1500 s must not be rounded to 1500/60*60; 4000 m must not drift.
    expect(plan.snapshot[0]?.payload.targetDurationSeconds).toBe(1500);
    expect(plan.snapshot[0]?.payload.targetDistanceMeters).toBe(4000);
  });

  it('refuses the whole round when any selected item is invalid', () => {
    const items = createDraftItems(DRAFT, sequentialIds());
    items[0] = { ...items[0]!, title: '   ' }; // whitespace-only title
    items[2] = { ...items[2]!, scheduledLocalDate: '' };
    const plan = buildImportPlan(items);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors.map((error) => error.id)).toEqual(['id-1', 'id-3']);
    expect(plan.errors[0]?.message).toContain('标题不能为空');
    expect(plan.errors[1]?.message).toContain('日期无效');
  });

  it('reports over-limit notes and non-positive distances with their field names', () => {
    const items = createDraftItems(DRAFT, sequentialIds());
    items[0] = { ...items[0]!, notes: '长'.repeat(2001) };
    const plan = buildImportPlan(items);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors[0]?.message).toContain('备注不能超过 2000 字');

    const zeroDistance = [{ ...items[0], notes: null, targetDistanceMeters: 0 }];
    const zeroPlan = buildImportPlan(zeroDistance);
    expect(zeroPlan.ok).toBe(false);
    if (zeroPlan.ok) return;
    expect(zeroPlan.errors[0]?.message).toContain('距离');
  });
});

describe('import results by ID', () => {
  it('removes successes, keeps failures with their fields, leaves unselected untouched', () => {
    const items = createDraftItems(DRAFT, sequentialIds());
    const snapshotIds = ['id-1', 'id-3'];
    const results = [
      { id: snapshotIds[0]!, ok: true },
      { id: snapshotIds[1]!, ok: false, message: '计划训练内容无效' },
    ];
    const applied = applyImportResults(items, results);
    expect(applied.ok).toBe(1);
    expect(applied.failed).toBe(1);
    // Success removed, failure kept intact, unselected row untouched.
    expect(applied.items.map((item) => item.id)).toEqual(['id-2', 'id-3']);
    expect(applied.items[0]).toEqual(items[1]);
    expect(applied.items[1]).toEqual(items[2]);
    expect(applied.itemErrors['id-3']).toEqual({
      message: '计划训练内容无效',
      uncertain: false,
    });
    expect(applied.itemErrors['id-1']).toBeUndefined();
  });

  it('marks transport failures as uncertain and keeps the item', () => {
    const items = createDraftItems(DRAFT, sequentialIds());
    const applied = applyImportResults(items, [
      { id: 'id-1', ok: false, message: '未能确认导入结果；重试前请检查日历', uncertain: true },
    ]);
    expect(applied.items.map((item) => item.id)).toEqual(['id-1', 'id-2', 'id-3']);
    expect(applied.itemErrors['id-1']?.uncertain).toBe(true);
  });

  it('ignores stale results from a previous draft (unknown IDs)', () => {
    const regenerated = createDraftItems({ ...DRAFT, items: [DRAFT.items[0]!] }, () => 'new-id');
    const applied = applyImportResults(regenerated, [{ id: 'id-1', ok: true }]);
    expect(applied.ok).toBe(0);
    expect(applied.failed).toBe(0);
    expect(applied.items.map((item) => item.id)).toEqual(['new-id']);
  });
});

describe('failure classification', () => {
  it('uses the server message for API errors and a check-the-calendar hint otherwise', () => {
    expect(
      describeImportFailure(new ApiError('计划训练内容无效', 'INVALID_PLANNED_WORKOUT')),
    ).toEqual({
      message: '计划训练内容无效',
      uncertain: false,
    });
    expect(describeImportFailure(new TypeError('network down'))).toEqual({
      message: '未能确认导入结果；重试前请检查日历',
      uncertain: true,
    });
  });
});
