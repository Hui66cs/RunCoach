import { expect, test } from '@playwright/test';
import { matchingCsv } from './fixtures.js';

test('dashboard loads, shows the empty state, then stats, weekly trend, and recent activities', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await expect(page.getByText('还没有任何活动')).toBeVisible();

  await page.goto('/imports');
  await page
    .getByLabel('导入活动 CSV')
    .setInputFiles({ name: 'public.csv', mimeType: 'text/csv', buffer: Buffer.from(matchingCsv) });
  await page.getByRole('button', { name: '开始导入' }).first().click();

  await page.goto('/');
  await expect(page.getByText('最近 7 天')).toBeVisible();
  await expect(page.getByText('最近 28 天')).toBeVisible();
  await expect(page.getByLabel('每周跑量趋势图表')).toBeVisible();
  await expect(page.getByText('公开合成跑步')).toBeVisible();

  await page.locator('a[href^="/activities/"]').first().click();
  await expect(page.getByRole('heading', { name: '公开合成跑步' })).toBeVisible();

  await page.getByRole('link', { name: '活动' }).click();
  await expect(page.getByText('共 1 条活动')).toBeVisible();
  await page.getByRole('link', { name: '导入' }).click();
  await expect(page.getByLabel('导入活动 CSV')).toBeVisible();
  await page.getByRole('link', { name: '设置' }).click();
  await expect(page.getByLabel('最大心率')).toBeVisible();

  expect(pageErrors).toEqual([]);
});
