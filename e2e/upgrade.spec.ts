import { expect, test } from '@playwright/test';
import { matchingCsv, syntheticFit } from './fixtures.js';

test('formal activity workflow keeps M1 upgrade and enables M2 analysis/settings', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/imports');
  await page
    .getByLabel('导入活动 CSV')
    .setInputFiles({ name: 'public.csv', mimeType: 'text/csv', buffer: Buffer.from(matchingCsv) });
  await page.getByRole('button', { name: '开始导入' }).first().click();

  await page.goto('/activities?sourceType=CSV');
  await expect(page.getByText('共 1 条活动')).toBeVisible();
  await page.locator('a[href^="/activities/"]').first().click();
  await expect(page.getByLabel('活动时序图表')).toHaveCount(0);
  await expect(page.getByLabel('本地轨迹轮廓')).toHaveCount(0);

  await page.goto('/imports');
  await page.getByLabel('导入 FIT').setInputFiles({
    name: 'public.fit',
    mimeType: 'application/octet-stream',
    buffer: syntheticFit,
  });
  await page.getByRole('button', { name: '开始导入' }).nth(1).click();
  await page.goto('/activities');
  await expect(page.getByText(/CSV \+ FIT/)).toBeVisible();
  await page.getByLabel('搜索名称').fill('公开');
  await expect(page.getByText('共 1 条活动')).toBeVisible();
  await page.locator('a[href^="/activities/"]').first().click();
  const detailUrl = page.url();
  await expect(page.getByText('FIT 原生圈段')).toBeVisible();
  await expect(page.getByLabel('活动时序图表')).toBeVisible();
  await page.getByRole('button', { name: '功率' }).click();
  await page.getByRole('button', { name: '功率' }).click();
  await page.getByLabel('活动名称').fill('保留的 E2E 名称');
  await page.getByLabel('活动备注').fill('保留的 E2E 备注');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('活动名称')).toHaveValue('保留的 E2E 名称');
  await expect(page.getByLabel('活动备注')).toHaveValue('保留的 E2E 备注');

  await page.goto('/settings');
  await page.getByLabel('最大心率').fill('200');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText(/设置已保存/)).toBeVisible();
  await page.goto(detailUrl);
  await expect(page.getByText(/Z1/)).toBeVisible();
  expect(pageErrors).toEqual([]);
});
