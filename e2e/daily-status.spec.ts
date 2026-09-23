import { expect, test, type Page } from '@playwright/test';

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
}

test('settings page edits and persists the athlete profile without touching other settings', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // Keep a heart-rate value around to prove the profile form never overwrites
  // the existing analysis settings.
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: '运动员设置' })).toBeVisible();
  await page.getByLabel('最大心率').fill('190');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('设置已保存，活动分析已刷新。')).toBeVisible();

  // Fill the athlete profile: km input is decimal, stored as meters.
  await page.getByLabel('名称').fill('跑者甲');
  await page.getByLabel('跑步经验').selectOption({ label: '有一定经验' });
  await page.getByLabel('主要训练目标').fill('为 800 米比赛做准备');
  await page.getByLabel('每周跑量目标（km）').fill('25.5');
  await page.getByRole('button', { name: '保存档案' }).click();
  await expect(page.getByText('运动员档案已保存。')).toBeVisible();

  // Everything survives a reload and the stored meters render back as km.
  await page.reload();
  await expect(page.getByLabel('最大心率')).toHaveValue('190');
  await expect(page.getByLabel('名称')).toHaveValue('跑者甲');
  await expect(page.getByLabel('跑步经验')).toHaveValue('INTERMEDIATE');
  await expect(page.getByLabel('主要训练目标')).toHaveValue('为 800 米比赛做准备');
  await expect(page.getByLabel('每周跑量目标（km）')).toHaveValue('25.5');

  // Frontend validation blocks an invalid weekly target before any request.
  await page.getByLabel('每周跑量目标（km）').fill('0');
  await page.getByRole('button', { name: '保存档案' }).click();
  await expect(page.getByText('每周跑量目标必须大于 0 km')).toBeVisible();
  await page.getByLabel('每周跑量目标（km）').fill('1000.1');
  await page.getByRole('button', { name: '保存档案' }).click();
  await expect(page.getByText('每周跑量目标不能超过 1000 km')).toBeVisible();

  // Clear every profile field and verify the cleared state persists while the
  // heart-rate and timezone settings stay untouched.
  await page.getByLabel('名称').fill('');
  await page.getByLabel('跑步经验').selectOption({ label: '未设置' });
  await page.getByLabel('主要训练目标').fill('');
  await page.getByLabel('每周跑量目标（km）').fill('');
  await page.getByRole('button', { name: '保存档案' }).click();
  await expect(page.getByText('运动员档案已保存。')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('名称')).toHaveValue('');
  await expect(page.getByLabel('跑步经验')).toHaveValue('');
  await expect(page.getByLabel('主要训练目标')).toHaveValue('');
  await expect(page.getByLabel('每周跑量目标（km）')).toHaveValue('');
  await expect(page.getByLabel('最大心率')).toHaveValue('190');
  await expect(page.getByLabel('本地 UTC offset（分钟）')).toHaveValue('480');

  expect(pageErrors).toEqual([]);
});

test('daily status page creates, edits, isolates per date, and deletes entries', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // The main navigation exposes the page; the fixed fixture date keeps the
  // test independent of the current real date.
  await page.goto('/daily-status?date=2026-09-22');
  await expect(page.getByRole('heading', { name: '每日状态' })).toBeVisible();
  await expect(page.getByText('不生成医疗结论')).toBeVisible();
  await expect(page.getByTestId('daily-status-current-date')).toHaveText('当前日期：2026-09-22');
  await expect(page.getByTestId('daily-status-empty')).toBeVisible();

  // Create a record with scale directions visible next to the options.
  await expect(page.getByText('睡眠质量（1 很差，5 很好）')).toBeVisible();
  await page.getByRole('radio', { name: '睡眠质量 4' }).check();
  await page.getByRole('radio', { name: '疲劳程度 2' }).check();
  await page.getByRole('radio', { name: '训练意愿 5' }).check();
  await page.getByLabel('静息心率（bpm，可选，30–220）').fill('52');
  await page.getByLabel('备注（可选）').fill('感觉不错');
  await expect(page.getByText('4/2000')).toBeVisible();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('daily-status-saved')).toBeVisible();

  // Frontend validation blocks an invalid resting heart rate.
  await page.getByLabel('静息心率（bpm，可选，30–220）').fill('250');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('daily-status-error')).toHaveText(
    '静息心率必须是 30–220 之间的整数 bpm',
  );

  // The record persists across a reload.
  await page.reload();
  await expect(page.getByRole('radio', { name: '睡眠质量 4' })).toBeChecked();
  await expect(page.getByRole('radio', { name: '疲劳程度 2' })).toBeChecked();
  await expect(page.getByLabel('静息心率（bpm，可选，30–220）')).toHaveValue('52');
  await expect(page.getByLabel('备注（可选）')).toHaveValue('感觉不错');

  // Modify one field; the others stay unchanged.
  await page.getByRole('radio', { name: '睡眠质量 5' }).check();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('daily-status-saved')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('radio', { name: '睡眠质量 5' })).toBeChecked();
  await expect(page.getByRole('radio', { name: '疲劳程度 2' })).toBeChecked();
  await expect(page.getByLabel('备注（可选）')).toHaveValue('感觉不错');

  // Clear fields via 未填写 and empty inputs while keeping 疲劳程度 2 so the
  // form stays meaningful; the cleared values must persist as empty.
  await page.getByRole('radio', { name: '睡眠质量 未填写' }).check();
  await page.getByRole('radio', { name: '训练意愿 未填写' }).check();
  await page.getByLabel('静息心率（bpm，可选，30–220）').fill('');
  await page.getByLabel('备注（可选）').fill('');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('daily-status-saved')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('radio', { name: '睡眠质量 未填写' })).toBeChecked();
  for (const value of ['1', '2', '3', '4', '5']) {
    await expect(page.getByRole('radio', { name: `睡眠质量 ${value}` })).not.toBeChecked();
  }
  await expect(page.getByRole('radio', { name: '疲劳程度 2' })).toBeChecked();
  await expect(page.getByLabel('静息心率（bpm，可选，30–220）')).toHaveValue('');
  await expect(page.getByLabel('备注（可选）')).toHaveValue('');

  // Clearing the last scale makes the form fully empty: saving is blocked with
  // guidance instead of creating an all-null record.
  await page.getByRole('radio', { name: '疲劳程度 未填写' }).check();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('daily-status-error')).toHaveText(
    '请先填写至少一项内容；如需清空当天记录，请使用删除按钮。',
  );

  // Switch to another day via the date input: the empty form must not leak
  // the previous date's data.
  await page.getByLabel('日期').fill('2026-09-21');
  await expect(page.getByTestId('daily-status-current-date')).toHaveText('当前日期：2026-09-21');
  await expect(page.getByTestId('daily-status-empty')).toBeVisible();
  await expect(page.getByLabel('备注（可选）')).toHaveValue('');
  await expect(page.getByRole('radio', { name: '疲劳程度 2' })).not.toBeChecked();
  await expect(page.getByRole('button', { name: '删除当天记录' })).toHaveCount(0);

  // All-empty save is blocked here too.
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('daily-status-error')).toHaveText(
    '请先填写至少一项内容；如需清空当天记录，请使用删除按钮。',
  );

  // Returning to the original fixed date via the date input (never via the
  // real-current-date 今天 button) shows its own persisted record.
  await page.getByLabel('日期').fill('2026-09-22');
  await expect(page.getByTestId('daily-status-current-date')).toHaveText('当前日期：2026-09-22');
  await expect(page.getByRole('radio', { name: '疲劳程度 2' })).toBeChecked();
  await expect(page.getByRole('radio', { name: '睡眠质量 未填写' })).toBeChecked();
  await expect(page.getByLabel('备注（可选）')).toHaveValue('');

  // Delete with confirmation; afterwards the day is empty again.
  await page.getByRole('button', { name: '删除当天记录' }).click();
  await expect(page.getByText('将只删除 2026-09-22 的每日状态记录')).toBeVisible();
  await page.getByRole('button', { name: '确认' }).click();
  await expect(page.getByTestId('daily-status-empty')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('daily-status-empty')).toBeVisible();
  await expect(page.getByRole('button', { name: '删除当天记录' })).toHaveCount(0);

  // Small viewports must not overflow horizontally.
  await page.setViewportSize({ width: 375, height: 720 });
  await expectNoHorizontalOverflow(page);

  expect(pageErrors).toEqual([]);
});

test('the 今天 button jumps to the athlete-timezone today without hardcoding a date', async ({
  page,
}) => {
  await page.goto('/daily-status?date=2026-09-22');
  await expect(page.getByTestId('daily-status-current-date')).toBeVisible();
  // Canonical today is whatever the date input allows as its maximum; the
  // test never hardcodes the real current date.
  const max = await page.getByLabel('日期').getAttribute('max');
  expect(max).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await page.getByRole('button', { name: '今天' }).click();
  await expect(page.getByTestId('daily-status-current-date')).toHaveText(`当前日期：${max}`);
  await expect(page).toHaveURL(new RegExp(`date=${max}$`));
});
