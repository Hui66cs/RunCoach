import { expect, test, type Page } from '@playwright/test';

/** Counts real browser requests to the coach chat endpoint. */
function trackChatRequests(page: Page): { count: () => number } {
  let sent = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/ai/coach/chat') && request.method() === 'POST') sent += 1;
  });
  return { count: () => sent };
}

test('coach chat: ask, get a reply, persist across reload, and manage sessions', async ({
  page,
}) => {
  const chatRequests = trackChatRequests(page);
  // Cleanup leftover sessions from earlier runs so titles stay unique.
  const leftover = await page.request.get('/api/ai/coach/chat/sessions');
  for (const session of ((await leftover.json()) as { sessions: Array<{ id: string }> }).sessions) {
    await page.request.delete(`/api/ai/coach/chat/sessions/${session.id}`);
  }
  await page.goto('/coach');
  await expect(page.getByRole('heading', { name: 'AI 训练助手' })).toBeVisible();

  // First question: creates a session and returns a reply.
  await page.getByLabel('对话输入').fill('我最近的跑量怎么样？');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByTestId('coach-messages')).toContainText('我最近的跑量怎么样？');
  await expect(page.getByTestId('coach-messages')).toContainText('模拟回顾');
  await expect(page.getByTestId('coach-messages')).toContainText('AI 生成');
  expect(chatRequests.count()).toBe(1);

  // A follow-up in the same session carries the bounded history.
  await page.getByLabel('对话输入').fill('那和上个月比呢？');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByTestId('coach-messages')).toContainText('那和上个月比呢？');
  expect(chatRequests.count()).toBe(2);

  // Persistence: the session and both turns survive a reload.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'AI 训练助手' })).toBeVisible();
  await page.getByRole('button', { name: '我最近的跑量怎么样？', exact: true }).click();
  await expect(page.getByTestId('coach-messages')).toContainText('我最近的跑量怎么样？');
  await expect(page.getByTestId('coach-messages')).toContainText('模拟回顾');

  // Deleting the session removes it from the list and clears the view.
  await page.getByRole('button', { name: '删除会话 我最近的跑量怎么样？' }).click();
  await expect(page.getByRole('button', { name: '删除会话 我最近的跑量怎么样？' })).toHaveCount(0);
  await expect(page.getByTestId('coach-messages')).toContainText('开始一个新对话');
});

test('coach chat requires explicit sends: nothing fires while typing or browsing', async ({
  page,
}) => {
  const chatRequests = trackChatRequests(page);
  await page.goto('/coach');
  await expect(page.getByRole('heading', { name: 'AI 训练助手' })).toBeVisible();

  // Typing alone never sends; the send button stays disabled for empty input.
  await page.getByLabel('对话输入').fill('这个问题还没发送');
  await expect(page.getByRole('button', { name: '发送' })).toBeEnabled();
  expect(chatRequests.count()).toBe(0);

  // Leave without sending.
  await page.goto('/');
  expect(chatRequests.count()).toBe(0);
});

test('plan draft: explicit generate, preview, edit, and import via the existing API', async ({
  page,
}) => {
  test.setTimeout(60_000);
  let draftPosts = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/ai/coach/plan-draft') && request.method() === 'POST') {
      draftPosts += 1;
    }
  });

  // Entry point from the coach page; entering the page never generates.
  await page.goto('/coach');
  await page.getByTestId('coach-plan-draft-link').click();
  await expect(page.getByRole('heading', { name: '训练计划草稿' })).toBeVisible();
  expect(draftPosts).toBe(0);
  await page.getByLabel('计划范围').selectOption('7');
  expect(draftPosts).toBe(0);

  // Failure must not fake success: armed 429 first, then retry succeeds.
  await page.request.get('http://127.0.0.1:3117/__arm429');
  await page.getByTestId('draft-generate').click();
  await expect(page.getByTestId('draft-error')).toContainText('过于频繁');
  expect(draftPosts).toBe(1);
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByTestId('draft-meta')).toContainText('AI 生成');
  await expect(page.getByTestId('draft-meta')).toContainText('simulated-model');
  expect(draftPosts).toBe(2);

  // The mock draft has two items; read the horizon from the meta line instead
  // of hardcoding the run date.
  const meta = (await page.getByTestId('draft-meta').textContent()) ?? '';
  const range = /草稿区间 (\d{4}-\d{2}-\d{2}) 至 (\d{4}-\d{2}-\d{2})/.exec(meta);
  expect(range).not.toBeNull();
  const draftStart = range![1]!;
  const draftEnd = range![2]!;

  // Preview-edit: rename the first item, exclude the second one.
  const firstTitle = page.getByLabel('标题 模拟草稿：轻松跑');
  await firstTitle.fill('E2E 草稿轻松跑');
  await page.getByLabel('导入 模拟草稿：核心力量').uncheck();

  // Import only what the user confirmed; imported items leave the list, the
  // unselected one stays for reference.
  await page.getByTestId('draft-import').click();
  await expect(page.getByTestId('draft-import-result')).toContainText('已导入 1 条');
  await expect(page.getByLabel('标题 E2E 草稿轻松跑')).toHaveCount(0);
  await expect(page.getByLabel('标题 模拟草稿：核心力量')).toBeVisible();

  // The imported draft is a real planned workout served by the existing API.
  const calendar = await page.request.get(`/api/calendar?from=${draftStart}&to=${draftEnd}`);
  expect(calendar.ok()).toBe(true);
  const calendarBody = (await calendar.json()) as {
    plannedWorkouts: Array<{
      title: string;
      workoutType: string;
      targetDistanceMeters: number | null;
    }>;
  };
  const imported = calendarBody.plannedWorkouts.find((w) => w.title === 'E2E 草稿轻松跑');
  expect(imported).toBeDefined();
  expect(imported?.workoutType).toBe('EASY_RUN');
  expect(imported?.targetDistanceMeters).toBe(4000);
  expect(calendarBody.plannedWorkouts.some((w) => w.title === '模拟草稿：核心力量')).toBe(false);

  // Cleanup: only the data this test imported.
  const list = await page.request.get(`/api/calendar?from=${draftStart}&to=${draftEnd}`);
  const listBody = (await list.json()) as { plannedWorkouts: Array<{ id: string; title: string }> };
  for (const workout of listBody.plannedWorkouts) {
    if (workout.title === 'E2E 草稿轻松跑') {
      const deleted = await page.request.delete(`/api/planned-workouts/${workout.id}`);
      expect(deleted.ok()).toBe(true);
    }
  }
});
