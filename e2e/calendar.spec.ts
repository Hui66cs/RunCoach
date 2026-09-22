import { expect, test } from '@playwright/test';
import { matchingCsv } from './fixtures.js';

test('training calendar supports planned workout CRUD and shows real activities', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // Default month view; the URL keeps the month after the first visit.
  await page.goto('/calendar');
  await expect(page.getByRole('heading', { name: '训练日历' })).toBeVisible();
  await expect(page).toHaveURL(/\/calendar\?month=\d{4}-\d{2}$/);

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

  // Edit the title and target distance.
  await page.getByTitle('E2E 轻松跑（点击编辑）').first().click();
  await page.getByLabel('标题').fill('E2E 轻松跑（修改）');
  await page.getByLabel('目标距离 (km)').fill('6.5');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('E2E 轻松跑（修改）').first()).toBeVisible();

  // Create a REST day without targets.
  await page.getByRole('button', { name: '添加训练', exact: true }).click();
  await page.getByLabel('日期').fill('2026-09-21');
  await page.getByLabel('训练类型').selectOption('REST');
  await page.getByLabel('标题').fill('E2E 休息日');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('E2E 休息日').first()).toBeVisible();

  // Import a real activity and open it from the calendar month view.
  await page.goto('/imports');
  await page
    .getByLabel('导入活动 CSV')
    .setInputFiles({ name: 'public.csv', mimeType: 'text/csv', buffer: Buffer.from(matchingCsv) });
  await page.getByRole('button', { name: '开始导入' }).first().click();

  await page.goto('/calendar?month=2026-09');
  const activityEntry = page.getByTitle('公开合成跑步（点击查看详情）').first();
  await expect(activityEntry).toBeVisible();
  await activityEntry.click();
  await expect(page.getByRole('heading', { name: '公开合成跑步' })).toBeVisible();

  // Delete the planned workout through the confirmation dialog.
  await page.goto('/calendar?month=2026-09');
  await page.getByTitle('E2E 休息日（点击编辑）').first().click();
  await page.getByRole('button', { name: '删除' }).click();
  await expect(page.getByText('将删除 2026-09-21 的「E2E 休息日」')).toBeVisible();
  await page.getByRole('button', { name: '确认' }).click();
  await expect(page.getByText('E2E 休息日')).toHaveCount(0);

  // Planned workout still exists after deleting the other one; activity remains.
  await expect(page.getByText('E2E 轻松跑（修改）').first()).toBeVisible();
  await expect(
    page.getByTitle('公开合成跑步（点击查看详情）').filter({ visible: true }),
  ).toHaveCount(1);

  // Month navigation updates the URL; unknown month param falls back.
  await page.getByRole('button', { name: '下一月 →' }).click();
  await expect(page).toHaveURL(/month=2026-10/);
  await page.goto('/calendar?month=invalid');
  await expect(page.locator('[data-month]')).toHaveAttribute('data-month', /^\d{4}-\d{2}$/);

  // Existing navigation keeps working.
  await page.getByRole('link', { name: '概览' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await page.getByRole('link', { name: '趋势' }).click();
  await expect(page.getByRole('heading', { name: '趋势' })).toBeVisible();
  await page.getByRole('link', { name: '活动' }).click();
  await expect(page.getByText('共 1 条活动')).toBeVisible();
  await page.getByRole('link', { name: '导入' }).click();
  await expect(page.getByLabel('导入活动 CSV')).toBeVisible();
  await page.getByRole('link', { name: '设置' }).click();
  await expect(page.getByLabel('最大心率')).toBeVisible();

  expect(pageErrors).toEqual([]);
});
