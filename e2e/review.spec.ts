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

  // The preview carries the complete context, including eligibleCount, and
  // the exact raw JSON that will be sent.
  await expect(page.getByText('执行率基数（已完成+已跳过+已逾期）')).toBeVisible();
  await expect(page.getByTestId('review-raw-context')).toContainText('"eligibleCount"');
  await expect(page.getByTestId('review-raw-context')).toContainText('"windowStartLocalDate"');

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

test('a stale fingerprint is rejected in-page, re-previewed, and reconfirmed without reload', async ({
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
  const created = await page.request.post('/api/planned-workouts', {
    data: { scheduledLocalDate: today, workoutType: 'EASY_RUN', title: '指纹变化测试' },
  });
  const createdId = ((await created.json()) as { id: string }).id;

  // The server compares fingerprints and refuses the stale confirmation.
  await page.getByTestId('review-confirm').click();
  await expect(page.getByTestId('review-stale-recovery')).toBeVisible();
  expect(reviewRequests.count()).toBe(1);

  // In-page recovery: the preview is refetched (no reload, no page leave).
  // While refetching, confirming stays disabled; the refreshed context
  // includes the new plan count and requires a new explicit confirmation.
  const confirm = page.getByTestId('review-confirm');
  await expect(confirm).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByText(/统计窗口：\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/)).toBeVisible();
  const rawContext = await page.getByTestId('review-raw-context').textContent();
  expect(rawContext).not.toBeNull();
  const parsedContext = JSON.parse(rawContext!) as {
    planSummary: { plannedCount: number };
  };
  expect(parsedContext.planSummary.plannedCount).toBeGreaterThanOrEqual(1);

  // The new confirmation succeeds (one more review request in total).
  await confirm.click();
  await expect(page.getByTestId('review-result')).toBeVisible({ timeout: 10_000 });
  expect(reviewRequests.count()).toBe(2);

  // Cleanup: remove the plan this test created.
  const deleted = await page.request.delete(`/api/planned-workouts/${createdId}`);
  expect(deleted.ok()).toBe(true);
});

test('leaving without confirming sends nothing', async ({ page }) => {
  const reviewRequests = trackReviewRequests(page);
  await page.goto('/review');
  await expect(page.getByText('将发送的上下文（只读预览）')).toBeVisible();
  await page.goto('/');
  expect(reviewRequests.count()).toBe(0);
});
