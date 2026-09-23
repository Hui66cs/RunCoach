import { expect, test, type Page } from '@playwright/test';

/** Counts real browser requests to the review endpoint. */
function trackReviewRequests(page: Page): { count: () => number } {
  let sent = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/ai/review')) sent += 1;
  });
  return { count: () => sent };
}

test('failure surfaces a readable error and retry succeeds', async ({ page }) => {
  const reviewRequests = trackReviewRequests(page);
  await page.goto('/review');
  await expect(page.getByText('将发送的上下文（只读预览）')).toBeVisible();
  await expect(page.getByTestId('review-ai-enabled')).toHaveText('AI 回顾已启用');

  // First confirmation: the mock provider answers 429 once.
  await page.getByTestId('review-confirm').click();
  await expect(page.getByTestId('review-error')).toHaveText('AI 服务请求过于频繁，请稍后再试');
  expect(reviewRequests.count()).toBe(1);

  // The retry is a new explicit confirmation and succeeds.
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByTestId('review-result')).toBeVisible();
  await expect(page.getByText('AI 生成')).toBeVisible();
  await expect(page.getByTestId('review-result')).toContainText('模型 simulated-model');
  await expect(page.getByTestId('review-text')).toContainText('模拟回顾');
  await expect(page.getByText(/不构成医疗建议|不是 canonical 数据/)).toBeVisible();
  expect(reviewRequests.count()).toBe(2);
});

test('double clicks are guarded: one confirmation sends exactly one request', async ({ page }) => {
  const reviewRequests = trackReviewRequests(page);
  await page.goto('/review');
  await expect(page.getByText('将发送的上下文（只读预览）')).toBeVisible();

  const confirm = page.getByTestId('review-confirm');
  await confirm.click();
  // While pending the button is disabled, so a second click cannot fire.
  await expect(confirm).toBeDisabled();
  await expect(page.getByText('正在请求 AI 回顾…')).toBeVisible();
  await expect(confirm).toBeDisabled();
  await expect(page.getByTestId('review-result')).toBeVisible({ timeout: 10_000 });
  expect(reviewRequests.count()).toBe(1);
});

test('a changed context after preview is rejected and requires a new confirmation', async ({
  page,
}) => {
  const reviewRequests = trackReviewRequests(page);
  await page.goto('/review');
  await expect(page.getByText('将发送的上下文（只读预览）')).toBeVisible();

  // The data changes after the preview: a new planned workout lands today
  // (the date comes from the preview itself, never hardcoded).
  const todayText = await page
    .getByText(/统计窗口：\d{4}-\d{2}-\d{2} ~ (\d{4}-\d{2}-\d{2})/)
    .textContent();
  const today = /~ (\d{4}-\d{2}-\d{2})/.exec(todayText ?? '')?.[1] ?? '';
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await page.request.post('/api/planned-workouts', {
    data: { scheduledLocalDate: today, workoutType: 'EASY_RUN', title: '指纹变化测试' },
  });

  // The server compares fingerprints and refuses the stale confirmation.
  await page.getByTestId('review-confirm').click();
  await expect(page.getByTestId('review-error')).toHaveText('训练上下文已变化，请重新预览并确认');
  expect(reviewRequests.count()).toBe(1);

  // A reload fetches a fresh preview; a new confirmation succeeds.
  await page.reload();
  await expect(page.getByText('将发送的上下文（只读预览）')).toBeVisible();
  await page.getByTestId('review-confirm').click();
  await expect(page.getByTestId('review-result')).toBeVisible({ timeout: 10_000 });
  expect(reviewRequests.count()).toBe(2);
});

test('leaving without confirming sends nothing', async ({ page }) => {
  const reviewRequests = trackReviewRequests(page);
  await page.goto('/review');
  await expect(page.getByText('将发送的上下文（只读预览）')).toBeVisible();
  await page.goto('/');
  expect(reviewRequests.count()).toBe(0);
});
