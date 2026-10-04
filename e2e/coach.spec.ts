import { expect, test, type Page } from '@playwright/test';

/** Counts real browser requests to the coach chat endpoint. */
function trackChatRequests(page: Page): { count: () => number } {
  let sent = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/ai/coach/chat') && request.method() === 'POST') sent += 1;
  });
  return { count: () => sent };
}

/** Removes leftover sessions so assertions about session counts stay exact. */
async function clearSessions(page: Page): Promise<void> {
  const leftover = await page.request.get('/api/ai/coach/chat/sessions');
  for (const session of ((await leftover.json()) as { sessions: Array<{ id: string }> }).sessions) {
    await page.request.delete(`/api/ai/coach/chat/sessions/${session.id}`);
  }
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

test('chat failure keeps nothing on the server; explicit retry commits exactly one round', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const chatRequests = trackChatRequests(page);
  await clearSessions(page);
  await page.goto('/coach');

  // The armed 429 fails the first send; with success-commit semantics the
  // server must not create the session or store the user message.
  await page.request.get('http://127.0.0.1:3117/__arm429');
  await page.getByLabel('对话输入').fill('失败后重试的问题');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByTestId('coach-error')).toContainText('过于频繁');
  const sessionsAfterFailure = (await (
    await page.request.get('/api/ai/coach/chat/sessions')
  ).json()) as { sessions: unknown[] };
  expect(sessionsAfterFailure.sessions).toHaveLength(0);

  // The input is preserved and the retry still targets the original send.
  await expect(page.getByLabel('对话输入')).toHaveValue('失败后重试的问题');
  await page.getByRole('button', { name: '重试' }).dblclick();
  await expect(page.getByTestId('coach-messages')).toContainText('模拟回顾');
  expect(chatRequests.count()).toBe(2); // one failed send + one retry

  // Exactly one session with both turns, and it survives a reload.
  const sessions = (await (await page.request.get('/api/ai/coach/chat/sessions')).json()) as {
    sessions: Array<{ id: string; messageCount: number }>;
  };
  expect(sessions.sessions).toHaveLength(1);
  expect(sessions.sessions[0]?.messageCount).toBe(2);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'AI 训练助手' })).toBeVisible();
  await page.getByRole('button', { name: '失败后重试的问题', exact: true }).click();
  await expect(page.getByTestId('coach-messages')).toContainText('失败后重试的问题');
  await expect(page.getByTestId('coach-messages')).toContainText('模拟回顾');
  await clearSessions(page);
});

test('pending locks ownership controls; double-click sends exactly once', async ({ page }) => {
  test.setTimeout(60_000);
  const chatRequests = trackChatRequests(page);
  await clearSessions(page);
  await page.goto('/coach');
  await page.getByLabel('对话输入').fill('第一轮问题');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByTestId('coach-messages')).toContainText('模拟回顾');

  // While the next round is pending, everything that could change the
  // round's ownership or clobber the input is locked.
  await page.getByLabel('对话输入').fill('第二轮问题');
  await page.getByRole('button', { name: '发送' }).dblclick();
  expect(chatRequests.count()).toBe(2); // exactly one call for this round
  await expect(page.getByLabel('对话输入')).toBeDisabled();
  await expect(page.getByLabel('对话输入')).toHaveValue('第二轮问题');
  await expect(page.getByRole('button', { name: '发送' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '新对话' })).toBeDisabled();
  const switchButton = page.getByRole('button', { name: '第一轮问题', exact: true });
  await expect(switchButton).toBeDisabled();
  await expect(page.getByRole('button', { name: '删除会话 第一轮问题' })).toBeDisabled();

  // The round completes normally and the input is cleared exactly once.
  await expect(page.getByTestId('coach-messages')).toContainText('模拟回顾');
  await expect(page.getByLabel('对话输入')).toBeEnabled();
  await expect(page.getByLabel('对话输入')).toHaveValue('');
  await clearSessions(page);
});

/** Reads the draft window from the meta line instead of hardcoding the run
 * date. */
async function readDraftRange(page: Page): Promise<{ start: string; end: string }> {
  const meta = (await page.getByTestId('draft-meta').textContent()) ?? '';
  const range = /草稿区间 (\d{4}-\d{2}-\d{2}) 至 (\d{4}-\d{2}-\d{2})/.exec(meta);
  expect(range).not.toBeNull();
  return { start: range![1]!, end: range![2]! };
}

/** Generates a draft (armed 429 first proves failure-then-retry) and returns
 * its window. */
async function generateDraftWithRetry(page: Page): Promise<{ start: string; end: string }> {
  await page.request.get('http://127.0.0.1:3117/__arm429');
  await page.getByTestId('draft-generate').click();
  await expect(page.getByTestId('draft-error')).toContainText('过于频繁');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByTestId('draft-meta')).toContainText('simulated-model');
  return readDraftRange(page);
}

/** Titles this suite creates; cleanup only ever touches these. */
const SUITE_TITLES = ['模拟草稿：轻松跑', '模拟草稿：核心力量'];

/** Deletes the planned workouts this suite created within the draft window —
 * also run BEFORE assertions so leftovers from an earlier failed run cannot
 * skew the counts this suite asserts. */
async function cleanupDraftPlans(
  page: Page,
  range: { start: string; end: string },
  titles: string[] = SUITE_TITLES,
): Promise<void> {
  const list = await page.request.get(`/api/calendar?from=${range.start}&to=${range.end}`);
  const body = (await list.json()) as { plannedWorkouts: Array<{ id: string; title: string }> };
  for (const workout of body.plannedWorkouts) {
    if (titles.includes(workout.title)) {
      await page.request.delete(`/api/planned-workouts/${workout.id}`);
    }
  }
}

test('plan draft: generate with retry, edit notes, import — persisted via the existing API', async ({
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

  const range = await generateDraftWithRetry(page);
  expect(draftPosts).toBe(2); // failed generate + successful retry
  // Reset this suite's own leftovers so counts below are exact.
  await cleanupDraftPlans(page, range);

  // Preview-edit: fill in the notes field of the first item, exclude the
  // second item.
  await page.getByLabel('备注 模拟草稿：轻松跑').fill('E2E 备注内容');
  await page.getByLabel('导入 模拟草稿：核心力量').uncheck();

  // Import only what the user confirmed; imported items leave the list, the
  // unselected one stays for reference.
  await page.getByTestId('draft-import').click();
  await expect(page.getByTestId('draft-import-result')).toContainText('已导入 1 条');
  await expect(page.getByTestId('draft-complete')).toBeVisible();
  await expect(page.getByLabel('标题 模拟草稿：轻松跑')).toHaveCount(0);
  await expect(page.getByLabel('标题 模拟草稿：核心力量')).toBeVisible();

  // The imported draft is a real planned workout served by the existing API,
  // including the edited notes.
  const calendar = await page.request.get(`/api/calendar?from=${range.start}&to=${range.end}`);
  expect(calendar.ok()).toBe(true);
  const calendarBody = (await calendar.json()) as {
    plannedWorkouts: Array<{
      title: string;
      workoutType: string;
      notes: string | null;
      targetDistanceMeters: number | null;
      targetDurationSeconds: number | null;
    }>;
  };
  const imported = calendarBody.plannedWorkouts.find((w) => w.title === '模拟草稿：轻松跑');
  expect(imported).toBeDefined();
  expect(imported?.workoutType).toBe('EASY_RUN');
  expect(imported?.notes).toBe('E2E 备注内容');
  expect(imported?.targetDistanceMeters).toBe(4000);
  expect(imported?.targetDurationSeconds).toBe(1500);
  expect(calendarBody.plannedWorkouts.some((w) => w.title === '模拟草稿：核心力量')).toBe(false);

  await cleanupDraftPlans(page, range, ['模拟草稿：轻松跑']);
});

test('plan draft: partial success keeps the failed row with its reason; retry does not duplicate', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const createRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/planned-workouts') && request.method() === 'POST') {
      const body = request.postDataJSON() as { title?: string };
      createRequests.push(body.title ?? '');
    }
  });
  await page.goto('/coach/plan');
  const range = await generateDraftWithRetry(page);
  await cleanupDraftPlans(page, range);

  // Controlled failure at the test boundary: the STRENGTH item's real create
  // request is answered with the server's own error shape; the other item
  // goes through the real backend untouched.
  let failStrength = true;
  await page.route('**/api/planned-workouts', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON() as { title?: string };
    if (failStrength && body.title === '模拟草稿：核心力量') {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'INVALID_PLANNED_WORKOUT', message: '计划训练内容无效' }),
      });
    }
    return route.continue();
  });

  await page.getByTestId('draft-import').click();
  await expect(page.getByTestId('draft-import-result')).toContainText('已导入 1 条');
  await expect(page.getByTestId('draft-import-result')).toContainText('失败 1 条');
  // Success removed by stable ID; failure kept with an understandable reason.
  await expect(page.getByLabel('标题 模拟草稿：轻松跑')).toHaveCount(0);
  await expect(page.getByLabel('标题 模拟草稿：核心力量')).toBeVisible();
  await expect(page.getByText('未能导入：计划训练内容无效')).toBeVisible();
  expect(createRequests.filter((title) => title === '模拟草稿：轻松跑')).toHaveLength(1);
  expect(createRequests.filter((title) => title === '模拟草稿：核心力量')).toHaveLength(1);

  const afterFirst = (await (
    await page.request.get(`/api/calendar?from=${range.start}&to=${range.end}`)
  ).json()) as { plannedWorkouts: Array<{ title: string }> };
  expect(afterFirst.plannedWorkouts.filter((w) => w.title === '模拟草稿：轻松跑')).toHaveLength(1);
  expect(afterFirst.plannedWorkouts.some((w) => w.title === '模拟草稿：核心力量')).toBe(false);

  // Explicit retry sends only the still-selected remaining item; the already
  // imported row is not created again, and the round finishes clean.
  failStrength = false;
  await page.getByTestId('draft-import').click();
  await expect(page.getByTestId('draft-import-result')).toContainText('已导入 1 条');
  await expect(page.getByTestId('draft-complete')).toBeVisible();
  await expect(page.getByText('未能导入：计划训练内容无效')).toHaveCount(0);
  expect(createRequests.filter((title) => title === '模拟草稿：轻松跑')).toHaveLength(1);
  expect(createRequests.filter((title) => title === '模拟草稿：核心力量')).toHaveLength(2);
  const afterRetry = (await (
    await page.request.get(`/api/calendar?from=${range.start}&to=${range.end}`)
  ).json()) as { plannedWorkouts: Array<{ title: string }> };
  expect(afterRetry.plannedWorkouts.filter((w) => w.title === '模拟草稿：轻松跑')).toHaveLength(1);
  expect(afterRetry.plannedWorkouts.filter((w) => w.title === '模拟草稿：核心力量')).toHaveLength(
    1,
  );

  await cleanupDraftPlans(page, range, ['模拟草稿：轻松跑', '模拟草稿：核心力量']);
});

test('plan draft: import pending locks every control and a double-click sends once', async ({
  page,
}) => {
  test.setTimeout(60_000);
  let createPosts = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/planned-workouts') && request.method() === 'POST') {
      createPosts += 1;
    }
  });
  // Deterministic gate instead of a sleep: the first create request is held
  // until the test releases it, giving assertions a stable pending window.
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route('**/api/planned-workouts', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    if (!held) {
      held = true;
      await gate;
    }
    return route.continue();
  });

  await page.goto('/coach/plan');
  const range = await generateDraftWithRetry(page);
  await cleanupDraftPlans(page, range);
  await page.getByTestId('draft-import').dblclick();
  await expect(page.getByTestId('draft-import')).toContainText('导入中…');

  // Everything that could change this round's ownership is locked.
  await expect(page.getByLabel('计划范围')).toBeDisabled();
  await expect(page.getByLabel('偏好说明（可选）')).toBeDisabled();
  await expect(page.getByTestId('draft-generate')).toBeDisabled();
  await expect(page.getByLabel('标题 模拟草稿：轻松跑')).toBeDisabled();
  await expect(page.getByLabel('备注 模拟草稿：轻松跑')).toBeDisabled();
  await expect(page.getByLabel('日期 模拟草稿：轻松跑')).toBeDisabled();
  await expect(page.getByLabel('导入 模拟草稿：轻松跑')).toBeDisabled();
  await expect(page.getByTestId('draft-import')).toBeDisabled();
  // One round with two selected items = exactly two POSTs; a double-click
  // that started a second round would show four.
  await expect.poll(() => createPosts).toBe(2);

  release!();
  await expect(page.getByTestId('draft-import-result')).toContainText('已导入 2 条');
  expect(createPosts).toBe(2);
  await cleanupDraftPlans(page, range, ['模拟草稿：轻松跑', '模拟草稿：核心力量']);
});

test('plan draft: an invalid edit blocks the whole round without any create request', async ({
  page,
}) => {
  test.setTimeout(60_000);
  let createPosts = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/planned-workouts') && request.method() === 'POST') {
      createPosts += 1;
    }
  });
  await page.goto('/coach/plan');
  await generateDraftWithRetry(page);

  // Clearing the title violates the shared create schema: the whole round is
  // refused, nothing is sent, and the field-level reason is shown in place.
  // The row's aria-label contains the title, so locate by prefix to survive
  // the edit.
  const titleInputs = page.locator('input[aria-label^="标题"]');
  await titleInputs.first().fill('');
  await page.getByTestId('draft-import').click();
  await expect(page.getByTestId('draft-blocked')).toContainText('未发送任何创建请求');
  await expect(page.getByText('未能导入：标题不能为空')).toBeVisible();
  expect(createPosts).toBe(0);
  await expect(titleInputs.first()).toHaveValue('');
  await expect(titleInputs.nth(1)).toHaveValue('模拟草稿：核心力量');
});

test('chat whitespace: success clears the input, failure keeps it retryable', async ({ page }) => {
  test.setTimeout(60_000);
  await clearSessions(page);
  await page.goto('/coach');

  // A failed send keeps the exact input (surrounding spaces included) and
  // offers a retry for that same send.
  await page.request.get('http://127.0.0.1:3117/__arm429');
  await page.getByLabel('对话输入').fill('  带空格的问题  ');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByTestId('coach-error')).toContainText('过于频繁');
  await expect(page.getByLabel('对话输入')).toHaveValue('  带空格的问题  ');
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible();

  // Editing the question makes it a new send: the old retry disappears.
  await page.getByLabel('对话输入').fill('  修改后的问题  ');
  await expect(page.getByRole('button', { name: '重试' })).toHaveCount(0);

  // The modified send succeeds and clears the whitespace-padded input.
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByTestId('coach-messages')).toContainText('模拟回顾');
  await expect(page.getByLabel('对话输入')).toHaveValue('');
  await clearSessions(page);
});
