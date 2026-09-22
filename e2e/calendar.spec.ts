import { expect, test, type Page } from '@playwright/test';
import { matchingCsv, secondActivityCsv } from './fixtures.js';

async function cleanupPlannedWorkouts(page: Page): Promise<void> {
  // The e2e data directory persists across runs; remove any planned workouts
  // left over from previous runs so counts and link conflicts stay
  // deterministic. Actual activities are identity-deduplicated on import.
  const leftover = await page.request.get('/api/calendar?from=2026-08-01&to=2026-10-31');
  if (leftover.ok()) {
    const body = (await leftover.json()) as { plannedWorkouts?: Array<{ id: string }> };
    for (const workout of body.plannedWorkouts ?? []) {
      await page.request.delete(`/api/planned-workouts/${workout.id}`);
    }
  }
}

test('training calendar supports planned workout CRUD and shows real activities', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // Default month view; the URL keeps the month after the first visit.
  await page.goto('/calendar');
  await expect(page.getByRole('heading', { name: '训练日历' })).toBeVisible();
  await expect(page).toHaveURL(/\/calendar\?month=\d{4}-\d{2}$/);
  await cleanupPlannedWorkouts(page);

  // All fixed-date CRUD below targets September 2026 so the test never depends
  // on the current system date; navigate there explicitly first.
  await page.goto('/calendar?month=2026-09');
  await expect(page.locator('[data-month]')).toHaveAttribute('data-month', '2026-09');

  // Create a planned easy run on 2026-09-20 with distance and duration goals.
  await page.getByRole('button', { name: '添加训练', exact: true }).click();
  await page.getByLabel('日期').fill('2026-09-20');
  await page.getByLabel('训练类型').selectOption('EASY_RUN');
  await page.getByLabel('标题').fill('E2E 轻松跑');
  await page.getByLabel('目标距离 (km)').fill('5');
  await page.getByLabel('目标小时').fill('0');
  await page.getByLabel('目标分钟').fill('30');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('E2E 轻松跑').first()).toBeVisible();

  // Edit the target distance through the normal metadata PATCH flow.
  await page
    .getByTitle(/E2E 轻松跑（(待完成|已逾期)，点击编辑）/)
    .first()
    .click();
  await page.getByLabel('目标距离 (km)').fill('6.5');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTitle(/E2E 轻松跑（(待完成|已逾期)，点击编辑）/).first()).toBeVisible();

  // Import two real activities through the normal CSV flow.
  await page.goto('/imports');
  await page
    .getByLabel('导入活动 CSV')
    .setInputFiles({ name: 'public.csv', mimeType: 'text/csv', buffer: Buffer.from(matchingCsv) });
  await page.getByRole('button', { name: '开始导入' }).first().click();
  await page.getByLabel('导入活动 CSV').setInputFiles({
    name: 'second.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(secondActivityCsv),
  });
  await page.getByRole('button', { name: '开始导入' }).first().click();

  await page.goto('/calendar?month=2026-09');
  const activityEntry = page.getByTitle('公开合成跑步（点击查看详情）', { exact: true }).first();
  await expect(activityEntry).toBeVisible();

  // Link the plan to the imported activity and complete it.
  await page
    .getByTitle(/E2E 轻松跑（(待完成|已逾期)，点击编辑）/)
    .first()
    .click();
  await page.getByLabel('关联实际活动并完成', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: '关联并完成' }).click();
  // The dialog shows the refreshed status and the linked activity summary.
  await expect(page.getByTestId('completion-status')).toHaveText('已完成');
  await expect(page.getByText('已关联实际活动')).toBeVisible();
  await expect(page.locator('dialog').getByRole('link', { name: /公开合成跑步/ })).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).click();

  // The calendar entry shows the completed badge and the monthly adherence
  // updates: 1 plan, 1 completed, 100%.
  await expect(page.getByTitle('E2E 轻松跑（已完成，点击编辑）').first()).toBeVisible();
  await expect(page.getByTestId('summary-planned-count')).toHaveText('1');
  await expect(page.getByTestId('summary-completed-count')).toHaveText('1');
  await expect(page.getByTestId('summary-skipped-overdue')).toHaveText('0 / 0');
  await expect(page.getByTestId('adherence-rate')).toHaveText('100%');
  await expect(page.getByText('按周汇总')).toBeVisible();

  // The summary's generatedForLocalDate is the athlete-timezone today the
  // server used; the page's today highlight must match the same day.
  const generatedFor = await page.getByTestId('summary-generated-for').textContent();
  expect(generatedFor).toMatch(/^截至 \d{4}-\d{2}-\d{2}$/);
  const todayIso = generatedFor!.replace('截至 ', '');
  if (todayIso.startsWith('2026-09')) {
    await expect(page.getByTestId('today-cell')).toContainText(todayIso.slice(8));
  }

  // A reload keeps the status and the link.
  await page.reload();
  await expect(page.getByTitle('E2E 轻松跑（已完成，点击编辑）').first()).toBeVisible();
  await page.getByTitle('E2E 轻松跑（已完成，点击编辑）').first().click();
  await expect(page.getByTestId('completion-status')).toHaveText('已完成');
  await expect(page.getByText('已关联实际活动')).toBeVisible();

  // The linked activity detail is still reachable from the dialog.
  await page
    .locator('dialog')
    .getByRole('link', { name: /公开合成跑步/ })
    .click();
  await expect(page.getByRole('heading', { name: '公开合成跑步' })).toBeVisible();

  // Create a second plan.
  await page.goto('/calendar?month=2026-09');
  await page.getByRole('button', { name: '添加训练', exact: true }).click();
  await page.getByLabel('日期').fill('2026-09-21');
  await page.getByLabel('标题').fill('E2E 休息日');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTitle(/E2E 休息日（(待完成|已逾期)，点击编辑）/).first()).toBeVisible();

  // While it is still PLANNED, linking the already-linked activity must
  // surface the server's 409 as an understandable error.
  await page
    .getByTitle(/E2E 休息日（(待完成|已逾期)，点击编辑）/)
    .first()
    .click();
  await page.getByLabel('关联实际活动并完成', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: '关联并完成' }).click();
  await expect(page.getByTestId('completion-error')).toHaveText('该实际活动已关联其他计划训练');
  await expect(page.getByTestId('completion-status')).toHaveText(/待完成|已逾期/);

  // Mark it skipped instead.
  await page.getByRole('button', { name: '标记为已跳过' }).click();
  await expect(page.getByTestId('completion-status')).toHaveText('已跳过');
  await page.getByRole('button', { name: '关闭' }).click();

  // Summary updates: 2 plans, 1 completed, 1 skipped, 50%.
  await expect(page.getByTestId('summary-planned-count')).toHaveText('2');
  await expect(page.getByTestId('summary-completed-count')).toHaveText('1');
  await expect(page.getByTestId('summary-skipped-overdue')).toHaveText('1 / 0');
  await expect(page.getByTestId('adherence-rate')).toHaveText('50%');

  // Restore the skipped plan to PLANNED; the badge falls back to 待完成 or
  // 已逾期 depending on the real current date, and the skipped count drops.
  await page.getByTitle('E2E 休息日（已跳过，点击编辑）').first().click();
  await page.getByRole('button', { name: '恢复为待完成' }).click();
  await expect(page.getByTestId('completion-status')).toHaveText(/待完成|已逾期/);
  await page.getByRole('button', { name: '关闭' }).click();
  await expect(page.getByTitle(/E2E 休息日（(待完成|已逾期)，点击编辑）/).first()).toBeVisible();
  await expect(page.getByTestId('summary-completed-count')).toHaveText('1');
  await expect(page.getByTestId('summary-skipped-overdue')).toHaveText(/0 \/ [01]/);
  await expect(page.getByTestId('adherence-rate')).toHaveText(/^(50|100)%$/);

  // Deleting the restored plan never touches the actual activity.
  await page
    .getByTitle(/E2E 休息日（(待完成|已逾期)，点击编辑）/)
    .first()
    .click();
  await page.getByRole('button', { name: '删除' }).click();
  await expect(page.getByText(/将删除 2026-09-21 的「E2E 休息日」/)).toBeVisible();
  await page.getByRole('button', { name: '确认' }).click();
  await expect(page.getByText('E2E 休息日')).toHaveCount(0);

  // The linked activity and the completed plan survive the delete.
  await expect(page.getByTitle('E2E 轻松跑（已完成，点击编辑）').first()).toBeVisible();
  await expect(
    page.getByTitle('公开合成跑步（点击查看详情）', { exact: true }).filter({ visible: true }),
  ).toHaveCount(1);

  // Month navigation updates the URL; unknown month param falls back.
  await page.getByRole('button', { name: '下一月 →' }).click();
  await expect(page).toHaveURL(/month=2026-10/);
  await page.goto('/calendar?month=invalid');
  await expect(page.locator('[data-month]')).toHaveAttribute('data-month', /^\d{4}-\d{2}$/);
  // A valid month parameter is never overridden by the fallback month.
  await page.goto('/calendar?month=2026-09');
  await expect(page.locator('[data-month]')).toHaveAttribute('data-month', '2026-09');

  // Existing navigation keeps working.
  await page.getByRole('link', { name: '概览' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await page.getByRole('link', { name: '趋势' }).click();
  await expect(page.getByRole('heading', { name: '趋势' })).toBeVisible();
  await page.getByRole('link', { name: '活动' }).click();
  await expect(page.getByText('共 2 条活动')).toBeVisible();
  await page.getByRole('link', { name: '导入' }).click();
  await expect(page.getByLabel('导入活动 CSV')).toBeVisible();
  await page.getByRole('link', { name: '设置' }).click();
  await expect(page.getByLabel('最大心率')).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('a completed planned workout can attach and swap its linked activity directly', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/calendar?month=2026-09');
  await cleanupPlannedWorkouts(page);

  // Make sure both real activities exist via the normal import flow.
  await page.goto('/imports');
  await page
    .getByLabel('导入活动 CSV')
    .setInputFiles({ name: 'public.csv', mimeType: 'text/csv', buffer: Buffer.from(matchingCsv) });
  await page.getByRole('button', { name: '开始导入' }).first().click();
  await page.getByLabel('导入活动 CSV').setInputFiles({
    name: 'second.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(secondActivityCsv),
  });
  await page.getByRole('button', { name: '开始导入' }).first().click();

  // Create a plan and complete it manually, without any linked activity.
  await page.goto('/calendar?month=2026-09');
  await page.getByRole('button', { name: '添加训练', exact: true }).click();
  await page.getByLabel('日期').fill('2026-09-16');
  await page.getByLabel('标题').fill('E2E 补充关联');
  await page.getByRole('button', { name: '保存' }).click();
  await page
    .getByTitle(/E2E 补充关联（(待完成|已逾期)，点击编辑）/)
    .first()
    .click();
  await page.getByRole('button', { name: '标记为已完成' }).click();
  await expect(page.getByTestId('completion-status')).toHaveText('已完成');
  await expect(page.getByText('已关联实际活动')).toHaveCount(0);

  // Attach an activity directly while staying COMPLETED — no restore needed.
  await page.getByLabel('补充关联活动', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: '补充关联', exact: true }).click();
  await expect(page.getByTestId('completion-status')).toHaveText('已完成');
  await expect(page.getByText('已关联实际活动')).toBeVisible();
  await expect(
    page.locator('dialog').getByRole('link', { name: /公开合成跑步（2026-09-18/ }),
  ).toBeVisible();

  // Swap directly to the second activity; the status stays COMPLETED.
  await page.getByLabel('更换关联活动', { exact: true }).selectOption({ index: 2 });
  await page.getByRole('button', { name: '更换关联', exact: true }).click();
  await expect(page.getByTestId('completion-status')).toHaveText('已完成');
  await expect(
    page.locator('dialog').getByRole('link', { name: /公开合成跑步二（2026-09-19/ }),
  ).toBeVisible();

  // A reload keeps the swapped link.
  await page.reload();
  await page.getByTitle('E2E 补充关联（已完成，点击编辑）').first().click();
  await expect(page.getByTestId('completion-status')).toHaveText('已完成');
  await expect(
    page.locator('dialog').getByRole('link', { name: /公开合成跑步二（2026-09-19/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).click();

  // The original activities were never modified or deleted by the linking.
  await page.goto('/activities');
  await expect(page.getByText('公开合成跑步', { exact: true })).toBeVisible();
  await expect(page.getByText('公开合成跑步二', { exact: true })).toBeVisible();
  await page
    .getByRole('link', { name: /公开合成跑步 2026-09-18/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: '公开合成跑步', exact: true })).toBeVisible();

  // A conflict while another plan links the same activity still surfaces 409.
  await page.goto('/calendar?month=2026-09');
  await page.getByRole('button', { name: '添加训练', exact: true }).click();
  await page.getByLabel('日期').fill('2026-09-15');
  await page.getByLabel('标题').fill('E2E 冲突关联');
  await page.getByRole('button', { name: '保存' }).click();
  await page
    .getByTitle(/E2E 冲突关联（(待完成|已逾期)，点击编辑）/)
    .first()
    .click();
  await page.getByLabel('关联实际活动并完成', { exact: true }).selectOption({ index: 2 });
  await page.getByRole('button', { name: '关联并完成' }).click();
  await expect(page.getByTestId('completion-error')).toHaveText('该实际活动已关联其他计划训练');

  expect(pageErrors).toEqual([]);
});
