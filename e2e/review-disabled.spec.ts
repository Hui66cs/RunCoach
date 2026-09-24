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
