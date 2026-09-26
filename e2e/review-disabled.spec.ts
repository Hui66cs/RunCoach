import { expect, test, type Page } from '@playwright/test';

function trackReviewRequests(page: Page): { count: () => number } {
  let sent = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/ai/review')) sent += 1;
  });
  return { count: () => sent };
}

test('preview-only flow with AI disabled: entering, switching the window, and leaving never call the model', async ({
  page,
}) => {
  const reviewRequests = trackReviewRequests(page);
  await page.goto('/review');
  await expect(page.getByRole('heading', { name: '训练回顾' })).toBeVisible();

  // The preview loads from /api/ai/context only — never /api/ai/review.
  await expect(page.getByText('将发送的上下文（只读预览）')).toBeVisible();
  await expect(page.getByTestId('review-ai-enabled')).toHaveText('AI 回顾未启用');
  await expect(page.getByText(/统计窗口：\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/)).toBeVisible();
  await expect(page.getByText(/仅这些数值汇总/)).toBeVisible();
  await expect(page.getByText(/将发送到 DeepSeek/)).toBeVisible();
  await expect(page.getByText(/跑步汇总（28 天）/)).toBeVisible();
  await expect(page.getByText('执行率基数（已完成+已跳过+已逾期）')).toBeVisible();
  await expect(page.getByTestId('review-raw-context')).toContainText('"eligibleCount"');

  // The deterministic data hints work without AI enabled and never send.
  await expect(page.getByTestId('review-data-hints')).toBeVisible();
  await expect(page.getByTestId('review-data-hints')).toContainText('没有跑步记录');
  await expect(page.getByTestId('review-data-hints')).toContainText('你仍可自行确认发送');

  // Confirming is impossible while the integration is disabled.
  await expect(page.getByTestId('review-confirm')).toBeDisabled();
  await expect(page.getByTestId('review-disabled-hint')).toContainText('AI 回顾未在服务端启用');

  // Switching the window only refetches the preview.
  await page.getByRole('button', { name: '近 7 天' }).click();
  await expect(page.getByText(/跑步汇总（7 天）/)).toBeVisible();
  await expect(page.getByTestId('review-confirm')).toBeDisabled();
  expect(reviewRequests.count()).toBe(0);

  // Leaving without confirming keeps the model request count at zero.
  await page.goto('/');
  expect(reviewRequests.count()).toBe(0);
});

test('configuring the DeepSeek key from the settings UI enables the review flow', async ({
  page,
}) => {
  // The AI env path is pinned off for this project, so enabling here can
  // only come from the settings-UI key (stored server-side in the data dir).
  await page.goto('/settings');
  await page.getByLabel('DeepSeek API key').fill('sk-e2e-ui-configured-key-0001');
  await page.getByRole('button', { name: '保存并启用' }).click();
  const statusRow = page.getByTestId('ai-key-status');
  await expect(statusRow).toContainText('已启用');
  await expect(statusRow).toContainText('****0001');
  await expect(statusRow).toContainText('本页设置');

  // The review page flips to enabled without any .env change.
  await page.goto('/review');
  await expect(page.getByTestId('review-ai-enabled')).toHaveText('AI 回顾已启用');
  await expect(page.getByTestId('review-confirm')).toBeEnabled();

  // One explicit confirmation sends exactly one request to the mock provider
  // through the real server adapter.
  await page.getByTestId('review-confirm').click();
  await expect(page.getByTestId('review-result')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('review-text')).toContainText('模拟回顾');

  // Clearing the key returns to the disabled state.
  await page.goto('/settings');
  await page.getByRole('button', { name: '清除' }).click();
  await expect(statusRow).toContainText('未启用');
  await page.goto('/review');
  await expect(page.getByTestId('review-ai-enabled')).toHaveText('AI 回顾未启用');
  await expect(page.getByTestId('review-confirm')).toBeDisabled();
});
