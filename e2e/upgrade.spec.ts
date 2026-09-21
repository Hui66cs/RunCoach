import { expect, test } from '@playwright/test';
import { matchingCsv, syntheticFit } from './fixtures.js';

test('CSV summary is upgraded in place by FIT and user fields persist', async ({ page }) => {
  await page.goto('/');
  await page
    .getByLabel('导入活动 CSV')
    .setInputFiles({ name: 'public.csv', mimeType: 'text/csv', buffer: Buffer.from(matchingCsv) });
  await page.getByRole('button', { name: '开始导入' }).first().click();
  await expect(page.getByText('CSV · 无时序')).toBeVisible();
  await page.getByLabel('导入 FIT').setInputFiles({
    name: 'public.fit',
    mimeType: 'application/octet-stream',
    buffer: syntheticFit,
  });
  await page.getByRole('button', { name: '开始导入' }).nth(1).click();
  await expect(page.getByText('CSV + FIT · 有时序')).toBeVisible();
  await expect(page.getByText('Lap（1）')).toBeVisible();
  await expect(page.getByLabel('心率与速度曲线')).toBeVisible();
  await page.getByLabel('名称').fill('保留的 E2E 名称');
  await page.getByLabel('备注').fill('保留的 E2E 备注');
  await page.getByRole('button', { name: '保存用户字段' }).click();
  await page.reload();
  await expect(page.getByLabel('名称')).toHaveValue('保留的 E2E 名称');
  await expect(page.getByLabel('备注')).toHaveValue('保留的 E2E 备注');
});
