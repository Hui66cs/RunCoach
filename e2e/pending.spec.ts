import { expect, test } from '@playwright/test';
import { ambiguousCsv, syntheticFit } from './fixtures.js';

test('imports route preserves pending attach and history workflow', async ({ page }) => {
  await page.goto('/imports');
  await page.getByLabel('导入活动 CSV').setInputFiles({
    name: 'ambiguous.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(ambiguousCsv),
  });
  await page.getByRole('button', { name: '开始导入' }).first().click();
  await page.getByLabel('导入 FIT').setInputFiles({
    name: 'ambiguous.fit',
    mimeType: 'application/octet-stream',
    buffer: syntheticFit,
  });
  await page.getByRole('button', { name: '开始导入' }).nth(1).click();
  await expect(page.getByText(/时间差/).first()).toBeVisible();
  await page.getByRole('button', { name: '合并到此活动' }).first().click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByText('当前没有待处理项目。')).toBeVisible();
  await expect(page.getByText(/导入历史/).first()).toBeVisible();
});
