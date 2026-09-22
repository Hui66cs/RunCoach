import { expect, test } from '@playwright/test';

const noHeartRateCsv = `活动类型,日期,标题,距离,时间
跑步,2026-09-19 07:00:00,无心率合成跑,8.01,00:50:54
`;

test('trends page switches ranges, keeps URL state, and shows heart-rate empty state', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/trends');
  await expect(page.getByRole('heading', { name: '趋势' })).toBeVisible();
  await expect(page.getByText('所选范围内没有跑步活动')).toBeVisible();

  await page.goto('/imports');
  await page.getByLabel('导入活动 CSV').setInputFiles({
    name: 'no-hr.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(noHeartRateCsv),
  });
  await page.getByRole('button', { name: '开始导入' }).first().click();

  await page.goto('/trends');
  await expect(page.getByLabel('最近 12 周汇总')).toBeVisible();
  await expect(page.getByLabel('每周跑量趋势图表')).toBeVisible();
  await expect(page.getByLabel('周平均配速趋势图表')).toBeVisible();
  await expect(page.getByText('没有有效的活动平均心率')).toBeVisible();

  await page.getByRole('button', { name: '最近 26 周' }).click();
  await expect(page.getByLabel('最近 26 周汇总')).toBeVisible();
  await expect(page).toHaveURL(/\/trends\?weeks=26$/);
  await page.reload();
  await expect(page.getByLabel('最近 26 周汇总')).toBeVisible();

  await page.goto('/trends?weeks=13');
  await expect(page.getByLabel('最近 12 周汇总')).toBeVisible();
  await expect(page.getByLabel('周平均配速趋势图表')).toBeVisible();

  // Existing navigation keeps working, including the dashboard.
  await page.getByRole('link', { name: '概览' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await page.getByRole('link', { name: '活动' }).click();
  await expect(page.getByText('共 1 条活动')).toBeVisible();
  await page.getByRole('link', { name: '导入' }).click();
  await expect(page.getByLabel('导入活动 CSV')).toBeVisible();
  await page.getByRole('link', { name: '设置' }).click();
  await expect(page.getByLabel('最大心率')).toBeVisible();

  expect(pageErrors).toEqual([]);
});
