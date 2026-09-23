import { expect, test, type Page } from '@playwright/test';
import { matchingCsv } from './fixtures.js';

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Monday of the week containing `date` (mirrors apps/web/src/local-date.ts). */
function mondayOfSameWeek(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, weekday === 0 ? -6 : 1 - weekday);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
}

test('dashboard loads, shows the empty state, then stats, weekly trend, and recent activities', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await expect(page.getByText('还没有任何活动')).toBeVisible();

  // Even without any real activity the daily-loop cards stay visible.
  await expect(page.getByTestId('dashboard-status-card')).toBeVisible();
  await expect(page.getByTestId('dashboard-plans-card')).toBeVisible();
  await expect(page.getByTestId('dashboard-weekly-card')).toBeVisible();
  await expect(page.getByTestId('dashboard-upcoming-card')).toBeVisible();

  await page.goto('/imports');
  await page
    .getByLabel('导入活动 CSV')
    .setInputFiles({ name: 'public.csv', mimeType: 'text/csv', buffer: Buffer.from(matchingCsv) });
  await page.getByRole('button', { name: '开始导入' }).first().click();

  await page.goto('/');
  await expect(page.getByText('最近 7 天')).toBeVisible();
  await expect(page.getByText('最近 28 天')).toBeVisible();
  await expect(page.getByLabel('每周跑量趋势图表')).toBeVisible();
  await expect(page.getByText('公开合成跑步')).toBeVisible();

  await page.locator('a[href^="/activities/"]').first().click();
  await expect(page.getByRole('heading', { name: '公开合成跑步' })).toBeVisible();

  await page.getByRole('link', { name: '活动' }).click();
  await expect(page.getByText('共 1 条活动')).toBeVisible();
  await page.getByRole('link', { name: '导入' }).click();
  await expect(page.getByLabel('导入活动 CSV')).toBeVisible();
  await page.getByRole('link', { name: '设置' }).click();
  await expect(page.getByLabel('最大心率')).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('dashboard connects the daily loop: profile, today status, today plan, weekly target, upcoming plans', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // Set the athlete profile through the real settings flow; a weekly target
  // activates the weekly-distance card.
  await page.goto('/settings');
  await page.getByLabel('名称').fill('Hui');
  await page.getByLabel('主要训练目标').fill('为 800 米比赛做准备');
  await page.getByLabel('每周跑量目标（km）').fill('50');
  await page.getByRole('button', { name: '保存档案' }).click();
  await expect(page.getByText('运动员档案已保存。')).toBeVisible();

  await page.getByRole('link', { name: '概览' }).click();
  // The greeting and the goal come from the athlete settings.
  await expect(page.getByRole('heading', { name: '你好，Hui' })).toBeVisible();
  await expect(page.getByText('目标：为 800 米比赛做准备')).toBeVisible();

  // Canonical today is whatever the dashboard itself reports; every scenario
  // below derives from it and never hardcodes the real current date.
  const today = (await page.getByTestId('dashboard-today-date').textContent())?.trim() ?? '';
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // No status recorded yet: the card offers the canonical-date entry point.
  await expect(page.getByTestId('dashboard-status-card')).toContainText('今天尚未记录状态');
  const statusLink = page.getByRole('link', { name: '记录今日状态' });
  await expect(statusLink).toHaveAttribute('href', `/daily-status?date=${today}`);

  // Record today's status through the real daily-status page.
  await statusLink.click();
  await expect(page.getByRole('heading', { name: '每日状态' })).toBeVisible();
  await expect(page.getByTestId('daily-status-current-date')).toHaveText(`当前日期：${today}`);
  await page.getByRole('radio', { name: '睡眠质量 4' }).check();
  await page.getByRole('radio', { name: '疲劳程度 2' }).check();
  await page.getByLabel('静息心率（bpm，可选，30–220）').fill('52');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('daily-status-saved')).toBeVisible();

  // Back to the dashboard: the card now shows the recorded fields.
  await page.getByRole('link', { name: '概览' }).click();
  await expect(page.getByTestId('dashboard-status-card')).toContainText('4/5');
  await expect(page.getByTestId('dashboard-status-card')).toContainText('2/5');
  await expect(page.getByTestId('dashboard-status-card')).toContainText('52 bpm');
  await expect(page.getByRole('link', { name: '编辑今日状态' })).toHaveAttribute(
    'href',
    `/daily-status?date=${today}`,
  );

  // Create today's plans and boundary-case upcoming plans through the real
  // planned-workout API. The imported real activity (2026-09-18) is reused
  // for the linked-activity summary.
  const createPlan = async (payload: Record<string, unknown>): Promise<string> => {
    const response = await page.request.post('/api/planned-workouts', { data: payload });
    if (!response.ok()) {
      throw new Error(
        `创建计划失败 ${response.status()} ${JSON.stringify(payload)}: ${await response.text()}`,
      );
    }
    const body = (await response.json()) as { id: string };
    return body.id;
  };
  await createPlan({
    scheduledLocalDate: today,
    workoutType: 'EASY_RUN',
    title: '今日轻松跑',
    targetDistanceMeters: 5000,
  });
  await createPlan({ scheduledLocalDate: today, workoutType: 'STRENGTH', title: '今日力量' });
  const completedTodayId = await createPlan({
    scheduledLocalDate: today,
    workoutType: 'TEMPO_RUN',
    title: '今日节奏跑',
  });
  const activities = (await (await page.request.get('/api/activities?limit=5')).json()) as {
    items: Array<{ id: string; name: string }>;
  };
  const realActivity = activities.items.find((activity) => activity.name === '公开合成跑步');
  expect(realActivity).toBeDefined();
  const linked = await page.request.patch(`/api/planned-workouts/${completedTodayId}/completion`, {
    data: { completionStatus: 'COMPLETED', linkedActivityId: realActivity!.id },
  });
  if (!linked.ok()) {
    throw new Error(`关联失败 ${linked.status()}: ${await linked.text()}`);
  }

  // Upcoming boundary cases: beyond 7 days, and future plans that are
  // already COMPLETED or SKIPPED must all stay out of the upcoming list.
  await createPlan({
    scheduledLocalDate: addDays(today, 8),
    workoutType: 'EASY_RUN',
    title: '八天之外',
  });
  const completedFutureId = await createPlan({
    scheduledLocalDate: addDays(today, 1),
    workoutType: 'EASY_RUN',
    title: '未来已完成',
  });
  const skippedFutureId = await createPlan({
    scheduledLocalDate: addDays(today, 2),
    workoutType: 'EASY_RUN',
    title: '未来已跳过',
  });
  for (const [id, status] of [
    [completedFutureId, 'COMPLETED'],
    [skippedFutureId, 'SKIPPED'],
  ] as const) {
    // The strict completion contract: only COMPLETED carries linkedActivityId.
    const body =
      status === 'COMPLETED'
        ? { completionStatus: status, linkedActivityId: null }
        : { completionStatus: status };
    const patched = await page.request.patch(`/api/planned-workouts/${id}/completion`, {
      data: body,
    });
    if (!patched.ok()) {
      throw new Error(
        `完成状态修改失败 ${patched.status()} ${id} ${status}: ${await patched.text()}`,
      );
    }
  }
  for (let offset = 1; offset <= 6; offset += 1) {
    await createPlan({
      scheduledLocalDate: addDays(today, offset),
      workoutType: 'EASY_RUN',
      title: `未来计划 ${offset}`,
    });
  }

  // A full page reload proves everything above is persisted.
  await page.reload();
  await expect(page.getByRole('heading', { name: '你好，Hui' })).toBeVisible();
  await expect(page.getByTestId('dashboard-status-card')).toContainText('4/5');
  await expect(page.getByTestId('dashboard-status-card')).toContainText('2/5');
  await expect(page.getByTestId('dashboard-status-card')).toContainText('52 bpm');
  await expect(page.getByRole('link', { name: '编辑今日状态' })).toHaveAttribute(
    'href',
    `/daily-status?date=${today}`,
  );

  // Today's plan card shows every plan of the day with its own status and
  // the linked-activity summary; the activity itself is untouched.
  const plansCard = page.getByTestId('dashboard-plans-card');
  await expect(plansCard).toContainText('今日轻松跑');
  await expect(plansCard).toContainText('今日力量');
  await expect(plansCard).toContainText('今日节奏跑');
  await expect(plansCard.getByText('已完成', { exact: true })).toHaveCount(1);
  const linkedSummary = plansCard.getByText('已关联：');
  await expect(linkedSummary).toContainText('公开合成跑步');
  await expect(plansCard.getByRole('link', { name: '公开合成跑步' })).toHaveAttribute(
    'href',
    `/activities/${realActivity!.id}`,
  );
  const calendarLink = plansCard.getByRole('link', { name: '在日历中处理' });
  await expect(calendarLink).toHaveAttribute('href', `/calendar?month=${today.slice(0, 7)}`);

  // The weekly card counts only real RUN distances inside the current week.
  // The fixture activity is fixed at 2026-09-18, so whether it falls into the
  // current real week is decided here — never by the run date itself.
  const weekMonday = mondayOfSameWeek(today);
  const weekSunday = addDays(weekMonday, 6);
  const fixtureInWeek = '2026-09-18' >= weekMonday && '2026-09-18' <= weekSunday;
  const weeklyCard = page.getByTestId('dashboard-weekly-card');
  await expect(weeklyCard).toContainText('周目标 50.00 km');
  await expect(weeklyCard.getByTestId('dashboard-weekly-actual')).toHaveText(
    fixtureInWeek ? '8.01 km' : '0.00 km',
  );
  await expect(weeklyCard.getByTestId('dashboard-weekly-percent')).toContainText('已完成');

  // Upcoming plans: only PLANNED plans strictly after today and within 7
  // days, date-ordered, capped at five.
  const upcomingCard = page.getByTestId('dashboard-upcoming-card');
  await expect(upcomingCard.getByRole('listitem')).toHaveCount(5);
  await expect(upcomingCard.getByRole('listitem').first()).toContainText(addDays(today, 1));
  await expect(upcomingCard.getByRole('listitem').first()).toContainText('未来计划 1');
  await expect(upcomingCard.getByRole('listitem').last()).toContainText(addDays(today, 5));
  await expect(upcomingCard).not.toContainText('未来计划 6');
  await expect(upcomingCard).not.toContainText('八天之外');
  await expect(upcomingCard).not.toContainText('未来已完成');
  await expect(upcomingCard).not.toContainText('未来已跳过');
  await expect(upcomingCard.getByRole('link', { name: '在日历中查看' })).toHaveAttribute(
    'href',
    // The link must open the month of the FIRST truncated plan (today+6 here),
    // which can be a different month than the query window's end.
    `/calendar?month=${addDays(today, 6).slice(0, 7)}`,
  );

  // Above 100%: with a 1-meter target any real RUN distance in the current
  // week pushes the text percentage far beyond 100 while the progress bar and
  // its ARIA value stay capped at 100.
  await page.goto('/settings');
  await page.getByLabel('每周跑量目标（km）').fill('0.001');
  await page.getByRole('button', { name: '保存档案' }).click();
  await expect(page.getByText('运动员档案已保存。')).toBeVisible();
  await page.goto('/');
  if (fixtureInWeek) {
    await expect(page.getByTestId('dashboard-weekly-percent')).toContainText(/已完成 \d{3,}%/);
    await expect(page.getByRole('progressbar', { name: '本周跑量目标完成进度' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
  }

  // Without a display name the generic title is used, never an empty one.
  await page.goto('/settings');
  await page.getByLabel('名称').fill('');
  await page.getByRole('button', { name: '保存档案' }).click();
  await expect(page.getByText('运动员档案已保存。')).toBeVisible();
  await page.getByRole('link', { name: '概览' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '你好，' })).toHaveCount(0);

  // Small viewports must not overflow horizontally.
  await page.setViewportSize({ width: 375, height: 720 });
  await expectNoHorizontalOverflow(page);

  expect(pageErrors).toEqual([]);
});

test('dashboard daily cards degrade locally when their APIs fail', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // Simulated network failures for the three supporting APIs only — the
  // dashboard endpoint itself still succeeds, so the page must not go blank
  // and each failing card must show its own local error instead of fake data.
  await page.route('**/api/daily-status*', (route) => route.abort());
  await page.route('**/api/calendar*', (route) => route.abort());
  await page.route('**/api/settings/athlete*', (route) => route.abort());

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();

  // TanStack Query retries aborted requests a few times before surfacing the
  // error, so these assertions allow for that backoff window.
  await expect(page.getByTestId('dashboard-status-card')).toContainText('今日状态加载失败', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('dashboard-plans-card')).toContainText('今日计划加载失败', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('dashboard-upcoming-card')).toContainText('近期计划加载失败', {
    timeout: 20_000,
  });
  // A settings failure must show a failure state, never "尚未设置周跑量目标".
  await expect(page.getByTestId('dashboard-weekly-card')).toContainText('周目标设置加载失败', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('dashboard-weekly-card')).not.toContainText('尚未设置周跑量目标');
  // The historical sections still render (earlier scenarios in this project
  // have already imported a real activity).
  await expect(page.getByRole('heading', { name: '最近活动' })).toBeVisible();
  await expect(page.getByText('公开合成跑步')).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('weekly card shows an error instead of stale numbers when a cached refetch fails', async ({
  page,
}) => {
  await page.goto('/settings');
  await page.getByLabel('每周跑量目标（km）').fill('50');
  await page.getByRole('button', { name: '保存档案' }).click();
  await expect(page.getByText('运动员档案已保存。')).toBeVisible();

  // First load succeeds: the card shows the real numbers for the window.
  await page.goto('/');
  const weeklyCard = page.getByTestId('dashboard-weekly-card');
  await expect(weeklyCard).toContainText('周目标 50.00 km');
  await expect(weeklyCard.getByTestId('dashboard-weekly-actual')).toBeVisible();
  await expect(weeklyCard.getByRole('progressbar')).toBeVisible();

  // From here on every calendar request fails; a client-side round trip
  // remounts the card and forces a refetch of the cached query.
  await page.route('**/api/calendar*', (route) => route.abort());
  await page.getByRole('link', { name: '趋势' }).click();
  await expect(page.getByRole('heading', { name: '趋势' })).toBeVisible();
  await page.getByRole('link', { name: '概览' }).click();

  // The error takes precedence: the previous numbers and the progress bar
  // must not be shown as if they were still current.
  await expect(weeklyCard).toContainText('本周跑量数据加载失败', { timeout: 20_000 });
  await expect(weeklyCard.getByTestId('dashboard-weekly-actual')).toHaveCount(0);
  await expect(weeklyCard.getByText('已完成', { exact: true })).toHaveCount(0);
  await expect(weeklyCard.getByRole('progressbar')).toHaveCount(0);
  await expect(weeklyCard).not.toContainText('周目标 50.00 km');
});

test('weekly progress keeps the real text percentage but caps the bar at 100', async ({ page }) => {
  // Canonical today comes from the dashboard itself; a real RUN activity is
  // imported on that date through the normal CSV flow, so the current week
  // always contains a positive distance no matter when the test runs.
  await page.goto('/');
  const today = (await page.getByTestId('dashboard-today-date').textContent())?.trim() ?? '';
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await page.goto('/imports');
  await page.getByLabel('导入活动 CSV').setInputFiles({
    name: 'today.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      `活动类型,日期,标题,距离,时间\n跑步,${today} 08:00:00,本周合成跑步,3.00,00:20:00\n`,
    ),
  });
  await page.getByRole('button', { name: '开始导入' }).first().click();

  // A 1-meter target makes any real distance exceed 100%.
  await page.goto('/settings');
  await page.getByLabel('每周跑量目标（km）').fill('0.001');
  await page.getByRole('button', { name: '保存档案' }).click();
  await expect(page.getByText('运动员档案已保存。')).toBeVisible();

  await page.goto('/');
  const weeklyCard = page.getByTestId('dashboard-weekly-card');
  await expect(weeklyCard.getByTestId('dashboard-weekly-actual')).toBeVisible();
  await expect(weeklyCard.getByTestId('dashboard-weekly-percent')).toContainText(/已完成 \d{3,}%/);
  const bar = weeklyCard.getByRole('progressbar', { name: '本周跑量目标完成进度' });
  await expect(bar).toHaveAttribute('aria-valuenow', '100');
  await expect(bar.locator('div').first()).toHaveAttribute('style', /width:\s*100%/);
});
