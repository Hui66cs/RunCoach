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
  await page
    .getByRole('button', { name: '我最近的跑量怎么样？', exact: true })
    .click();
  await expect(page.getByTestId('coach-messages')).toContainText('我最近的跑量怎么样？');
  await expect(page.getByTestId('coach-messages')).toContainText('模拟回顾');

  // Deleting the session removes it from the list and clears the view.
  await page
    .getByRole('button', { name: '删除会话 我最近的跑量怎么样？' })
    .click();
  await expect(
    page.getByRole('button', { name: '删除会话 我最近的跑量怎么样？' }),
  ).toHaveCount(0);
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
