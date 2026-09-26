# RunCoach Local Plan

## Approved milestone

M1/M1.1 and M2 are complete and frozen. M2.1 is complete: a repeatable performance baseline was established and accepted; premature optimization is deferred and the baseline remains in `docs/M2_1_PERFORMANCE_BASELINE.md`. M3 is complete and reviewer-accepted: Dashboard homepage, 12/26/52-week cross-activity trends, and activity-level canonical average heart rate weighted by effective moving duration; record-level heart-rate trends are explicitly future scope.

M4 (training calendar and local training plans) has completed stage acceptance with the verdict PASS WITH FOLLOW-UP: Batch 1 (calendar, planned-workout CRUD, calendar projection) and Batch 2 (plan completion status, manual one-to-one plan-to-activity links, adherence rate, weekly rollups) are both accepted at milestone-stage level, with follow-up items recorded for future batches.

The approved current milestone is M6: bounded training context and a server-side, read-only DeepSeek training review. M1–M5 are stage-complete and frozen (M5 Batch 4 is reviewer-accepted); M6 Batch 1 and Batch 2 are stage-accepted with the verdict PASS WITH FOLLOW-UP, and M6 stage acceptance is the reviewer's call. M5's overall goal was the daily-use loop — open the app, see today's plan, record daily status, complete the training, and link the activity — with all determinism, privacy, and no-medical rules intact.

M6 (approved): bounded training context and a server-side, read-only DeepSeek review — the narrowest possible AI step. It generates a whitelisted numeric context from existing deterministic aggregates and lets the user explicitly request a natural-language review; it does not generate plans, adjust training, score readiness, or send anything automatically.

### M6 scope and batches

1. [x] Batch 1: bounded AI context and DeepSeek server-side read-only integration. **Stage-accepted (verdict: PASS WITH FOLLOW-UP).** Delivered:
   - `AiTrainingContext` (shared Zod schema): an explicit whitelist — canonical `generatedForLocalDate`/`timezoneOffsetMinutes`, `windowDays` (7 or 28), inclusive `windowStartLocalDate`/`windowEndLocalDate`, the matching dashboard 7/28-day run summary (runs, total distance/moving duration, average pace), Monday-start weekly volumes **fully contained** in the window (partial boundary weeks are dropped, never clipped, so no sent number covers out-of-window dates), and the training-summary counts. Structurally excludes raw imports, samples, GPS, heart rate, daily-status scales, activity names, notes, profile text, and secrets; note that running aggregates may still be regarded as health-related data, and whether to send them stays the user's own decision.
   - `POST /api/ai/review`: user-triggered only; body `{windowDays: 7|28, contextFingerprint}` (windowDays default 28, fingerprint required) via `aiReviewRequestSchema`; response `aiReviewResponseSchema` (`context`, `review` trimmed 1–`MAX_AI_REVIEW_CHARS`(4000) chars, `model` ≤100 chars, `generatedAt`). Context is built from `getDashboard(today)` + `getTrainingSummary` with the same canonical today; the provider prompt is assembled server-side from the context JSON only.
   - `POST /api/ai/context`: read-only preview returning `aiContextPreviewResponseSchema` (`context`, `aiEnabled`, `contextFingerprint`) — built by the exact same code path as the review but never calls the provider, and works while the integration is disabled, so the UI shows users precisely what would be sent and requires an explicit confirmation step before calling `/api/ai/review`.
   - `TrainingReviewProvider` interface (`apps/server/src/services/ai/provider.ts`) with the `DeepSeekReviewProvider` chat-completions adapter (model `deepseek-flash`, verified against the official Chat Completions docs: `POST {baseUrl}/chat/completions`, `max_tokens` supported): timeout via AbortController, Zod-parsed upstream responses at the boundary, the API key used only in the Authorization header (never logged, never sent to the frontend, never committed).
   - Config (`RUNCOACH_AI_ENABLED`/`RUNCOACH_AI_PROVIDER`/`RUNCOACH_DEEPSEEK_API_KEY`/`RUNCOACH_DEEPSEEK_BASE_URL`/`RUNCOACH_AI_TIMEOUT_MS`/`RUNCOACH_AI_MAX_OUTPUT_TOKENS`): real calls require the explicit flag, the deepseek provider, and a non-empty key — a blank key is treated as absent and never blocks startup; disabled by default. `.env.example` documents that DeepSeek's terms permit de-identified use of inputs for model improvement, that the enable switch only permits calls (it is not the user's per-send confirmation), and that running aggregates may be regarded as health-related data.
   - Stable sanitized errors: 503 `AI_DISABLED`, 400 `INVALID_AI_REVIEW_REQUEST`, 504 `AI_TIMEOUT`, 429 `AI_RATE_LIMITED`, 502 `AI_PROVIDER_ERROR`/`AI_EMPTY_RESPONSE`/`AI_INVALID_OUTPUT`; no upstream body, key, or path ever reaches a client message; no code path writes to SQLite; no chat history table.
2. [x] Batch 2: 训练回顾页面与发送前确认。**Stage-accepted (verdict: PASS WITH FOLLOW-UP).** Delivered:
   - `/review` route + 回顾 navigation entry: window selector (7/28 days) fetches **only** the read-only preview (`POST /api/ai/context`) — entering, switching, or refreshing never calls `/api/ai/review`; the preview shows the exact date range, every field that will be sent, and a “数据将发送到 DeepSeek 云端” notice including the terms caveat and that running aggregates may be sensitive. Loading/empty/error/AI-disabled/pending/success/retry states are all explicit; small screens stay single-column.
   - Per-send confirmation: the confirm button is disabled while the preview loads/failed, while a request is pending (double-click guard), or while AI is disabled; each explicit click sends one `POST /api/ai/review` carrying the preview's `contextFingerprint`; the server recomputes the fingerprint and rejects stale confirmations with 409 `AI_CONTEXT_STALE` **before** calling the provider, so changed data or canonical today force a new preview + confirmation. No long-lived authorization state is stored anywhere; cancelling (not confirming) sends zero requests.
   - Result presentation: the text is labelled AI 生成 with the actual model name and generation time; program-computed stats remain in the preview panel as the canonical numbers, and the AI text is explicitly informational (never canonical data, never medical advice).
   - E2E without a real key: a `review` project runs against a **local mock DeepSeek provider** (`e2e/mock-deepseek.mjs`) so the real adapter, config, fingerprint guard, and UI are exercised end to end (429→retry→success, double-click guard, stale fingerprint 409, cancel = zero model calls); a `review-disabled` project covers the preview-only/disabled state. CI never depends on a real key.
   - Batch 2 rework: after a 409 `AI_CONTEXT_STALE` the page clears the old confirmation and re-fetches the preview in-page (confirm disabled while refetching, so the old fingerprint can never be re-sent; the refreshed context still needs a fresh explicit confirmation), retryable errors keep the 重试 button; the preview now shows every `AiTrainingContext` field including `eligibleCount` plus an expandable raw-context JSON identical to the prompt payload; `scripts/run-e2e.mjs` wipes `.e2e-data-review`/`.e2e-data-review-disabled` before and after runs and the stale test deletes the plan it creates, so repeated E2E runs stay clean.
   - Terms wording fixed across `.env.example`/PLAN/PROJECT_CONTEXT/AGENTS: the de-identification/training clause is cited to its public source (2025-09-05《DeepSeek 用户协议》4.3) as possibly outdated — users must re-check the latest terms; running aggregates may still be sensitive; the server enable switch is not a per-send confirmation.
3. [x] Batch 3: DeepSeek 回顾的事实口径提示词。**Stage-accepted (verdict: PASS WITH FOLLOW-UP).** The server-side system prompt (`reviewSystemPrompt`) now encodes: 7/28-day aggregates cover the rolling `windowStartLocalDate`..`windowEndLocalDate` range and must be described by actual dates or “近 7 天/近 28 天” (never “本周/本月”); `weeklyVolumes` contains only fully contained natural weeks, so an empty array never means “no running” (judge from `running`); adherence is explained strictly by the `eligibleCount`/`completedCount`/`adherenceRate` semantics, with eligible 0 or a null rate meaning “暂无可计算执行率的计划” and today-or-future PLANNED plans never judged as missed; the model must distinguish “数据为 0”, “该指标暂无可计算结果” and “上下文未提供该信息”, never invent facts; medical/injury/unrequested-plan prohibitions stay. Deterministic tests assert the rules verbatim in the prompt and the four boundary facts in the sent JSON. No context fields, API contract, schema, or whitelist changes.
4. [x] Batch 4: 训练回顾的稀疏数据发送前提示。**Implemented, awaiting reviewer acceptance.** The preview panel shows deterministic “本次可回顾数据” hints derived purely from the returned `AiTrainingContext` (`apps/web/src/review-hints.ts` + unit tests): runs 0 → 该窗口没有跑步记录; eligible 0 / null rate → 没有可计算的计划执行率，尚未到期的计划不属于未完成或未达标; runs exist but weeklyVolumes empty → 只说明窗口内没有完整自然周汇总，绝不表述为缺少跑步数据; sparse (no runs and no evaluable plans) → a restrained reminder that the AI review will mostly restate the numbers. Hints always render from the currently displayed preview (window switch/refetch/fingerprint change updates them), never trigger `/api/ai/review`, and never block an explicit confirmation. E2E covers the sparse flow in both enabled and disabled projects; unit tests cover the four data scenarios. No context fields, API, schema, or migration changes.
5. [x] Batch 5: 设置页 UI 配置 DeepSeek API key。**Implemented, awaiting reviewer acceptance.** Delivered:
   - `AiKeyStore` (`apps/server/src/services/ai/key-store.ts`): the UI-configured key lives in `ai-provider.json` inside the data directory (gitignored via the `.local-data` / `.e2e-data-*` globs), written atomically (tmp + rename); it never enters the browser, logs, or Git, and `maskKey` exposes at most the last 4 characters.
   - `POST /api/settings/ai` status / `PUT /api/settings/ai-key` / `DELETE /api/settings/ai-key` (`aiKeyStatusSchema` / `aiKeySaveSchema`, key 20–200 chars after trim): responses carry only `{aiEnabled, provider, source: 'file'|'env'|null, maskedTail}` — the full key is write-only and never echoed; invalid keys are rejected with 400 `INVALID_AI_KEY` without state changes.
   - Resolution priority: settings-UI key file > env key > disabled (`createAiKeysRuntime`, injectable provider factory for tests). A UI key enables the integration without the `RUNCOACH_AI_ENABLED` flag (recording the key through the confirmed UI flow is the informed opt-in); clearing falls back to the env path with its own flag semantics or to disabled. The env path remains fully supported and unchanged.
   - `/settings` gains an “AI 回顾配置（DeepSeek）” section (masked status, password input, 保存并启用/清除 with inline feedback); `/review`'s disabled hint links there. Sending still requires the per-request preview + fingerprint confirmation; no automatic sends, no browser-side keys.
   - E2E: the review-disabled project pins the env path off and points the provider at the local mock, then covers UI key save → enabled → confirmed send → clear → disabled. CI still needs no real key.
6. [ ] Batch 6+ (not started, not designed): additional providers must be approved separately.

## Approved milestone M7: AI 训练助手（对话式教练）

The owner approved expanding the AI scope (M6 Batch 5 rework discussion, 2026-09-26): the coach may read the full training context and converse, generate training-plan drafts, and hold persistent chat memory. Data scope authorized by the owner: basic training data (history activity summaries with dates/types/distances/durations/pace, deterministic personal bests, weekly/monthly volumes, plan adherence), daily-status scales AND notes (highest sensitivity, explicitly opted in), and activity-level average heart rate. Still never sent: GPS tracks, raw samples, raw imports, device info, activity names. Metrics remain deterministic (the LLM explains, never computes canonical numbers); chat is user-triggered only.

### M7 scope and batches

1. [x] Batch 1: expanded coach context. **Implemented, awaiting reviewer acceptance.** Delivered:
   - `AiCoachContext` (shared schema): canonical date/offset; all-time RUN totals with first-activity date; deterministic personal bests (LONGEST_DISTANCE, LONGEST_DURATION with moving-duration fallback, FASTEST_AVG_PACE over runs ≥ 1 km, BIGGEST_WEEK_DISTANCE from the 52-week volumes; earliest-date tie-breaking); bounded most-recent-60 activity summaries (whitelisted fields only, newest first, total count included); 52 weekly volumes; last-28-days plan summary; last-28-days daily status (scales + resting HR + notes, explicitly authorized).
   - `GET /api/ai/coach-context`: read-only, deterministic, never calls the provider, works while disabled; response `{context, aiEnabled}`. Structurally excludes names, notes on activities, GPS, samples, device info.
   - `/review` shows the coach context in an expandable, clearly labelled panel ("AI 助手上下文预览") with a sensitivity note about daily status/notes.
   - Tests: empty-database shape, PB boundaries incl. non-RUN exclusion, whitelist/bounding (65 activities → 60 + total), daily-status window inclusion.
2. [x] Batch 2: persistent conversational coach. **Implemented, awaiting reviewer acceptance.** Delivered:
   - `0006_ai_chat.sql` (forward-only): `chat_sessions` + `chat_messages` (role CHECK, `ON DELETE CASCADE`, session/updated indexes); single-user, no athlete columns.
   - `ChatRepository` (sessions CRUD, bounded recent-messages window) and `CoachChatService`: each user message snapshots the deterministic coach context (same builder as Batch 1), sends [rules+context] + last `MAX_CHAT_HISTORY_TURNS` (20) messages + the new message to the provider, persists both turns; unknown session → 404 `SESSION_NOT_FOUND`.
   - APIs: `POST /api/ai/coach/chat`, `GET /api/ai/coach/chat/sessions`, `GET .../sessions/:sessionId/messages`, `DELETE .../sessions/:sessionId` (204/404). Zod-validated (`aiChatRequestSchema`, replies ≤ `MAX_AI_REVIEW_CHARS`).
   - `/coach` page (nav 教练): session list with delete, message stream with AI 生成 labels, input with pending/error/retry states, persistence across reloads; typing and browsing never send — only explicit sends do.
   - Provider interface extended with optional bounded `history`; the DeepSeek adapter maps turns to chat messages. Tests: session persistence (incl. close-and-reopen), bounded history window, newest-first ordering with counts, validation and disabled-state errors.
3. [ ] Batch 3: AI training-plan drafts (structured Zod-validated output, preview/edit/confirm, import via the existing planned-workout API).

### M3 scope and batches (completed and reviewer-accepted)

1. [x] Batch 1: Dashboard homepage — `/` route, `GET /api/dashboard` (bounded, SQLite-aggregated), 7/28-day summaries, 12-week Monday-start volume trend with zero-filled weeks, up to five recent activities, and full loading/error/empty states.
2. [x] Batch 2: cross-activity trends — `/trends` with 12/26/52-week ranges, weekly volume/runs/pace/heart-rate trends.

M3 statistics scope: only `activityType = RUN` counts towards volume; windows are closed intervals of local dates ending today (derived from athlete settings timezone offset); activities are attributed by existing `activities.local_date`; moving duration falls back to duration; average pace is summed duration over summed distance. Trends added duration-weighted weekly/range heart rate: `sum(averageHeartRate × effectiveDuration) / sum(effectiveDuration)` over RUN activities with positive heart rate and positive effective duration, null without valid coverage; range summaries use range totals, never averages of weekly values. Trends reuses the dashboard's daily RUN aggregation so the two pages cannot drift.

### M4 scope and batches

1. [x] Batch 1: training calendar (`/calendar`), `0003_training_calendar.sql` with the `planned_workouts` table, planned-workout CRUD APIs, and the calendar projection of actual activities. **Stage-accepted (M4 verdict: PASS WITH FOLLOW-UP).**
2. [x] Batch 2: plan completion status, manual one-to-one plan-to-activity links, adherence rate, and weekly rollups. **Stage-accepted (M4 verdict: PASS WITH FOLLOW-UP).**

M4 Batch 2 design record:

- `0004_plan_completion.sql` (forward-only) adds `completion_status TEXT NOT NULL DEFAULT 'PLANNED'` and `linked_activity_id TEXT NULL REFERENCES activities(id) ON DELETE SET NULL` to `planned_workouts`, plus a partial unique index on `linked_activity_id` (one activity links to at most one plan; multiple NULLs allowed) and a `(scheduled_local_date, completion_status)` index for bounded rollups. Migrations 0000–0003 are untouched; legacy rows upgrade to `PLANNED` and re-running the migration set is idempotent.
- Status model: `PLANNED | COMPLETED | SKIPPED`. Linking an activity forces `COMPLETED`; `COMPLETED` may be manual (`linkedActivityId = null`); moving to `PLANNED` or `SKIPPED` always clears the link; the link can be swapped or removed; deleting a plan never touches the activity, sources, samples, laps, or import history. If the underlying activity is deleted, the foreign key sets the link to null and `COMPLETED` degrades to manual completion. "已逾期" (overdue) is a derived display of `PLANNED + scheduledLocalDate < today`, not a stored state.
- `PATCH /api/planned-workouts/:workoutId/completion` accepts a discriminated union (`{completionStatus:"PLANNED"}`, `{completionStatus:"SKIPPED"}`, `{completionStatus:"COMPLETED", linkedActivityId: string|null}`); status and link changes run in one transaction; missing plan 404, missing activity 404 `ACTIVITY_NOT_FOUND`, activity already linked to another plan 409 `ACTIVITY_ALREADY_LINKED` (no silent takeover). The ordinary PATCH keeps handling metadata fields only.
- `GET /api/training-summary?from&to`: closed interval, `from <= to`, at most 93 days, else 400. Returns `from`, `to`, `generatedForLocalDate`, `timezoneOffsetMinutes`, `summary`, `weeklyRollups`. "Today" is derived from the athlete settings `timezoneOffsetMinutes`, never server UTC. `eligibleCount = completedCount + skippedCount + overdueCount`; `adherenceRate = completedCount / eligibleCount`, a 0–1 fraction formatted by the frontend, `null` when `eligibleCount` is 0 (never 0/NaN/Infinity). Plans still `PLANNED` on today or later count as upcoming, never overdue, and never lower the current rate; manual and linked completions both count; all workout types (including REST/STRENGTH) use the same status semantics. Weekly rollups are Monday-start natural weeks covering every week intersecting the range (labels may extend past the range, counts only include `[from, to]`), oldest first, zero-filled weeks included.
- Frontend canonical today: the calendar page derives "today" with the same athlete settings `timezoneOffsetMinutes` as the server (`epochMs + offset` shifted to a UTC date in `apps/web/src/local-date.ts`, never the browser timezone). This feeds the default/fallback month, the 今天 button, the 添加训练 default date, the today highlight, and the 待完成/已逾期 badges, so a plan shown as 已逾期 can never be counted as upcoming by the same page's summary; the summary's `generatedForLocalDate` is rendered as visible proof of the shared source. A valid `?month=YYYY-MM` always wins; only a missing or invalid parameter falls back to the athlete-timezone current month, with a deterministic browser-offset fallback while settings load and a single URL replace once they settle.
- The calendar projection now carries `linkedActivity: CalendarActivitySummary | null` for in-range plans — a bounded summary (no samples/laps/sources) returned even when the linked activity's own date lies outside the queried range. Calendar and training summary keep a fixed query count independent of plan/activity counts and never read samples.
- Frontend: plan entries show text badges (待完成/已完成/已跳过/已逾期) with distinct styles; the plan editor offers 标记为已完成, 关联实际活动并完成 (PLANNED), 标记为已跳过, 恢复为待完成, 解除活动关联（保持已完成）, and — for COMPLETED plans — a direct 补充关联活动 (no link yet) / 更换关联活动 (already linked) picker that attaches or swaps the activity without restoring to PLANNED; SKIPPED must be restored before linking. Candidates are the in-range activities; 409 errors surface as readable messages; metadata form state is never submitted by completion actions. The calendar page requests the training summary over the real month first-to-last dates (grid filler days excluded) and shows 本月计划数/已完成数/已跳过与逾期数/执行率 plus a weekly rollup table, with loading, error, empty, and `adherenceRate = null` ("暂无可计算计划") states; mobile uses a stacked list with no horizontal overflow.
- Still out of scope: automatic matching/suggestions, drag-and-drop or batch completion, one-plan-to-many-activities links, AI-generated plans, watch/Garmin writes, and all excluded items below.

M4 excludes AI-generated plans, watch/Garmin Connect writes, and all other items in the excluded list below.

### M5 scope and batches

Overall goal: complete the athlete profile and daily training context, then connect daily status, today's plan, and recent plans into the Dashboard so the daily loop becomes: open the app → view the plan → record status → complete the training → link the activity.

1. [x] Batch 1: athlete profile fields and daily status data/API foundation — **reviewer-accepted**. Delivered:
   - `0005_daily_training_context.sql` (forward-only, 0000–0004 untouched): adds `display_name`, `experience_level` (`BEGINNER|INTERMEDIATE|ADVANCED`, nullable), `primary_goal`, and `weekly_distance_target_meters` (positive integer ≤ 1,000,000 meters, frontend converts to km) to `athlete_settings`; creates `daily_status_entries` with a unique `local_date` index, five nullable 1–5 self-report scales (sleep quality, fatigue, muscle soreness, stress, motivation), resting heart rate 30–220, notes ≤ 2000 chars, and DB CHECK constraints. No `athleteId`, no readiness/recovery/injury-risk fields.
   - `PATCH /api/settings/athlete` (existing endpoint) now also accepts the profile fields; explicit `null` clears them; trimmed empty strings are rejected so empty values never reach the database.
   - `GET /api/daily-status?from&to`: closed local-date range, `from <= to`, at most 93 days, ascending by `local_date`, no zero-filling; invalid query → `400 INVALID_DAILY_STATUS_QUERY`.
   - `PUT /api/daily-status/:localDate`: atomic upsert keyed by the unique date (repeat submissions never create a second row); `createdAt` survives updates, `updatedAt` refreshes; absent fields keep their value, explicit `null` clears a field; at least one editable field required; unknown fields rejected; invalid date/body → `400 INVALID_DAILY_STATUS`.
   - `DELETE /api/daily-status/:localDate`: 204 on success, `404 NOT_FOUND` when missing; never touches activities, planned workouts, sources, samples, laps, or import history.
   - Range queries filter in SQL over the unique `local_date` index with a fixed query count (no N+1) and never read samples.
2. [x] Batch 2: frontend entry points for the athlete profile and daily status — **reviewer-accepted**. Delivered:
   - `/settings`: an athlete profile section editing `displayName`, `experienceLevel`, `primaryGoal`, and `weeklyDistanceTargetMeters` (km input, integer meters on the wire, blank sends null to clear). Profile saves PATCH profile fields only, so the existing heart-rate/timezone form and its data are never overwritten; loading never clobbers existing values; success/error feedback is in Chinese and fields refill after reload.
   - `/daily-status` route + 状态 navigation entry: date picker (valid `?date=YYYY-MM-DD` always wins; missing/invalid falls back to the athlete-timezone canonical today via `apps/web/src/local-date.ts`, browser-offset fallback while settings load, single URL replace; date input max = canonical today; 今天 button), five 1–5 scales with visible direction labels, resting heart rate 30–220 bpm with frontend validation, notes with char count (blank normalized to null by the shared schema), save/edit/delete through `GET/PUT/DELETE /api/daily-status` with the query cache keyed by date; loading/error/empty ("当天尚未记录")/saving/delete-confirm states; a fully empty form is blocked with guidance instead of creating an all-null row; date switching never leaks another date's data; mobile has no horizontal overflow.
   - The Dashboard daily-status card, today's plan, and recent plans listed here as future work were delivered in Batch 3 (see below).
3. [x] Batch 3: Dashboard 日常训练闭环整合 — **reviewer-accepted**. Delivered:
   - Frontend composition of existing APIs only (`/api/dashboard`, `/api/settings/athlete`, `/api/daily-status`, `/api/calendar`); no new endpoint, schema, or contract change.
   - Canonical today for the whole page is `dashboard.generatedForLocalDate`; a new pure module `apps/web/src/dashboard-plan.ts` derives the bounded calendar window (`from` = current week Monday, `to` = max(week Sunday, today + 7 days), ≤14 inclusive dates) and selects today's plans, upcoming plans (PLANNED only, next 7 local days excluding today, date/title/id order, max 5 with hasMore), and the week's positive finite RUN distance (planned targets never count). All helpers have Vitest coverage including Monday boundaries and year rollover.
   - Dashboard cards: personalized greeting (你好，{displayName}，falls back to 概览) with the primary goal as secondary text; 今日状态 (today = canonical date, 未记录 → 记录今日状态 link carrying the date, recorded → non-null fields shown with nulls as 未填写, local error only in the card); 今日训练 (all of today's plans with title/type/target/status badge and linked-activity links; 在日历中处理 link to the month); 本周跑量 (actual vs profile target with percentage; the progress bar is capped at 100% while the text may exceed it; no target → settings link, never a generated one); 近期计划 (max 5 + 在日历中查看 when more, explicit empty state).
   - All daily-loop cards remain visible with zero activities; the existing 7/28-day stats, 12-week trend, import guide, and recent activities are unchanged.
   - Still not implemented: readiness/recovery scores, training advice, medical conclusions, automatic plan adjustments — permanently out of scope.

M5 still excludes: readiness/recovery composite scores, training advice or automatic plan adjustments, medical or injury judgements, auto-linking plans to activities, and every item in the excluded list below.

### M2 included

- Routed `/activities`, `/activities/:activityId`, `/imports`, and `/settings` application pages.
- Cursor-paginated and filterable activities without source N+1 queries.
- Activity detail metadata separated from bounded, range-filtered series endpoints.
- Deterministic splits, half comparison, pace stability, heart-rate zones, aerobic decoupling, and pause analysis.
- Local athlete settings for heart-rate analysis, metric units, and UTC offset.
- Native FIT laps plus clearly labelled derived kilometre splits, chart zoom refinement, and offline route outline.
- Unit, API/integration, Playwright, build, and CI coverage while preserving all M1/M1.1 behavior.

### Excluded

- AI-generated training plans, readiness/recovery scoring, additional LLM providers beyond the M6 Batch 1 server-side read-only DeepSeek review, chat or memory features, daily check-ins, ParroTao online synchronization, watch or Garmin Connect writes, authentication/multi-user, cloud synchronization, social features, online maps, installers, medical diagnosis, and injury advice.

## Acceptance flow

M1/M1.1 import and merge acceptance:

1. Import a CSV row and create one activity without time-series data.
2. Import its matching FIT file and retain the canonical activity ID.
3. Confirm sources are CSV and FIT, `hasTimeSeries` is true, and samples/laps exist.
4. Confirm FIT summary fields win while user-edited name and notes remain unchanged.
5. Confirm raw CSV data and FIT file remain available.
6. Re-import the FIT and receive an idempotent duplicate result without new samples.
7. Inject a merge failure and confirm the entire database transaction rolls back.

M2 acceptance, recorded results, and manual verification steps: `docs/M2_ACCEPTANCE.md`.

## Status

- [x] Requirements and architecture approved.
- [x] Workspace and persistent documentation.
- [x] Database schema and migration.
- [x] Import adapters, matching, merge, and audit.
- [x] REST API and minimal UI.
- [x] Automated verification, real private-sample smoke test, and handoff documentation.
- [x] M1.1 stable CSV identity, immutable refresh revisions, and compact source summaries.
- [x] M1.1 pending query/resolve loop, import history, UI, and Playwright/CI coverage.
- [x] M2 shared contracts, forward migration, and deterministic analytics.
- [x] M2 paginated activity and bounded series APIs plus athlete settings.
- [x] M2 routed application UI, charts, splits, route outline, and data details.
- [x] M2 final full-suite/private-fixture acceptance and handoff documentation.
- [x] M2.1 documentation sync and repeatable M2 performance baseline.
- [x] M2.1 closed: baseline accepted, premature optimization deferred with risks recorded.
- [x] M3 Batch 1: Dashboard homepage with bounded dashboard API, stats, weekly trend, and recent activities.
- [x] M3 Batch 2 and M3 acceptance: cross-activity trends page verified by reviewer.
- [x] M4 Batch 1: training calendar, planned-workout CRUD, and calendar projection (stage-accepted; M4 verdict PASS WITH FOLLOW-UP).
- [x] M4 Batch 2: plan completion status, one-to-one manual activity links, adherence rate, weekly rollups, and E2E coverage (stage-accepted; M4 verdict PASS WITH FOLLOW-UP).
- [x] M4 stage acceptance recorded (PASS WITH FOLLOW-UP); M5 approved as the current milestone.
- [x] M5 Batch 1: athlete profile fields and daily status data/API foundation (reviewer-accepted).
- [x] M5 Batch 2: `/settings` athlete profile form and `/daily-status` create/edit/delete page (reviewer-accepted).
- [x] M5 Batch 3: Dashboard daily-loop integration (reviewer-accepted).
- [x] M5 Batch 4: daily-loop regression closeout — cross-page React Query invalidation plus a full real-flow closed-loop E2E (reviewer-accepted; M5 stage-complete).
- [x] M6 Batch 1: bounded training context and server-side read-only DeepSeek integration (stage-accepted; verdict PASS WITH FOLLOW-UP).
- [x] M6 Batch 2: 训练回顾页面、发送前确认与本地 mock provider E2E (stage-accepted; verdict PASS WITH FOLLOW-UP).
- [x] M6 Batch 3: 回顾事实口径提示词 (stage-accepted; verdict PASS WITH FOLLOW-UP).
- [x] M6 Batch 4: 稀疏数据发送前提示 (implemented, awaiting reviewer acceptance; M6 as a whole is not yet accepted).
- [x] M6 Batch 5: 设置页 UI 配置 DeepSeek key、数据目录 key 文件与运行时启用 (implemented, awaiting reviewer acceptance; M6 as a whole is not yet accepted).
- [x] M7 Batch 1: expanded coach context with personal bests and authorized daily-status data (implemented, awaiting reviewer acceptance; M7 as a whole is not yet accepted).
- [x] M7 Batch 2: persistent conversational coach — chat sessions/messages in SQLite, bounded history, /coach page (implemented, awaiting reviewer acceptance; M7 as a whole is not yet accepted).
- Real DeepSeek smoke evidence (user-performed manual test, not executed by the implementation agent): in an isolated synthetic data directory with a locally configured key, the review page returned a result from `deepseek-flash`, the browser `POST /api/ai/review` returned 200, and the screenshot shows the request took about 2.59 seconds. No key, raw request body, or personal data was committed or shared.

## M2 implementation record

- `0002_activity_analysis.sql` adds the one-row athlete settings table and list/source/series indexes without altering earlier migrations.
- Activity metadata no longer contains samples. `/series` validates requested metrics/range, filters in SQLite, and returns at most `maxPoints` extrema-preserving points.
- Deterministic analysis lives in `packages/analytics`; imported canonical values remain unchanged and derived values are labelled.
- The React application now routes `/activities`, `/activities/:activityId`, `/imports`, and `/settings`; the complete M1.1 import loop remains under `/imports`.
- Final acceptance on the M2 working tree: 27 public tests, 1 private-fixture smoke test, 2 Playwright flows, and all build/format/lint/typecheck commands pass. See `docs/M2_ACCEPTANCE.md` for the recorded results, API changes, and manual acceptance steps.
- Charts render pace on a dedicated inverted `min/km` axis so no series shows raw seconds per kilometre.

## Known constraints

- The project is private/personal, so the Garmin SDK license is acceptable for this milestone. Reassess before any redistribution.
- The supplied CSV has no explicit timezone. This adapter interprets its timestamps with the configured local offset, defaulting to `+08:00`, and records that the offset was configured rather than present in the source.
- Raw private samples live under `private-fixtures/` and are never committed.
- Migration `0001_import_hardening.sql` is forward-only. Back up the data directory before applying it; restoring that backup is the rollback strategy.
- Stable Drizzle 0.44 does not expose the later `node:sqlite` adapter, so this slice uses its supported `better-sqlite3` adapter. The native package installed successfully on the target Windows/Node 24 environment.
