---
name: m6-batch5-ui-api-key
overview: 在设置页新增 DeepSeek API key 的 UI 配置（key 仅存于数据目录本地文件、服务端掩码回显、录入即启用真实调用），/review 页指向该入口；env 配置路径保持兼容。不改变 context 白名单、指纹确认流程与 provider 接口。
design:
  architecture:
    framework: react
  styleKeywords:
    - 延续现有深色设置页风格
    - 分区卡片
    - 内联反馈
  fontSystem:
    fontFamily: PingFang SC
    heading:
      size: 20px
      weight: 600
    subheading:
      size: 14px
      weight: 500
    body:
      size: 14px
      weight: 400
  colorSystem:
    primary:
      - '#34D399'
      - '#0EA5E9'
    background:
      - '#0F172A'
      - '#1E293B'
    text:
      - '#F1F5F9'
      - '#94A3B8'
    functional:
      - '#F87171'
      - '#FBBF24'
todos:
  - id: key-store
    content: 实现 AiKeyStore（ai-provider.json 原子读写、掩码、状态）与共享 schema（aiKeyStatusSchema、aiKeySaveSchema）及 key-store 单测
    status: completed
  - id: service-runtime
    content: AiReviewService 改为可变 enabled/provider 并新增 configureProvider/isEnabled；config.ts 暴露 ai.baseUrl；main.ts 按 文件key>envkey 优先级装配
    status: completed
    dependencies:
      - key-store
  - id: api-routes
    content: app.ts 新增 GET /api/settings/ai、PUT/DELETE /api/settings/ai-key（Zod 校验、key 永不回显）及 ai-key 集成测试（保存/清除/回落/无泄漏/禁用切换）
    status: completed
    dependencies:
      - service-runtime
  - id: web-ui
    content: api.ts 增加三个函数；SettingsPage 新增 AI 回顾配置区（掩码状态、保存、清除）；TrainingReviewPage 禁用态追加 /settings 配置入口链接
    status: completed
    dependencies:
      - api-routes
  - id: e2e
    content: review-disabled 项目注入本地 mock BASE_URL，新增 UI 配置 key → 启用 → 确认发送的 Playwright 全流程；既有 review/review-disabled 断言保持
    status: completed
    dependencies:
      - web-ui
  - id: docs
    content: PLAN/PROJECT_CONTEXT/AGENTS/README/.env.example 记录 Batch 5（UI 配置、存储文件、录入即启用、env 兼容与优先级）
    status: completed
    dependencies:
      - web-ui
  - id: verify
    content: 运行 pnpm format:check、typecheck、lint、test、build、test:e2e 并修复问题
    status: completed
    dependencies:
      - e2e
      - docs
---

## 产品概述

新增里程碑 M7「AI 训练助手」：在 M6 只读回顾的基础上，让 DeepSeek 能读取全部训练上下文（训练记录、个人历史 PB、每日状态与备注——用户已明确授权上云），支持带持久记忆的多轮对话交流，对训练表现做科学解读，并生成结构化训练计划草稿，经用户逐条预览确认后导入日历。

## 已确认的决策

- 上云数据范围：基础训练数据（活动列表：日期/类型/距离/时长/配速、PB、周/月汇总、计划执行情况）+ 每日状态量表与备注；仍排除 GPS 轨迹、逐点 samples、原始导入文件。
- 对话记忆：SQLite 持久会话，跨重启可查/可删，发送给模型的上下文窗口有界。
- 计划导入：AI 输出结构化计划草稿（Zod 校验），用户逐条预览/编辑/确认后经现有 POST /api/planned-workouts 写入日历，绝不静默写入。
- 节奏：分三批，每批单独验收。

## 核心功能（按批次）

- Batch 1（数据底座）：确定性聚合教练上下文——近 90 天活动摘要列表、RUN 各距离档 PB（3/5/10/21.1/42.2 km 最快配速及日期）、最长跑、52 周周跑量、计划执行汇总、近 28 天每日状态（含量表与备注）；新 API 与 /review 页完整预览展示。
- Batch 2（对话+记忆）：0006 migration（chat_sessions/chat_messages）、/api/ai/coach/chat（有界历史 + 教练上下文 + 系统口径提示词）、/coach 对话页（会话列表/消息/删除）。
- Batch 3（计划生成+导入）：/api/ai/coach/plan（JSON 输出 + Zod 草稿校验 + 日期/类型/目标约束）、对话页内草稿预览（逐条可编辑/勾选）、确认后批量写入日历并刷新查询。

## Tech Stack

沿用现有：Fastify + Zod + Drizzle/better-sqlite3、React + TanStack Query + Tailwind、Vitest、Playwright（本地 mock DeepSeek provider）。无新依赖。

## Implementation Approach

- **指标确定性**：PB、周量、执行率等全部由 SQL/纯函数计算（LLM 不算数），AI 只解释与建议——沿用 M6 架构规则。
- **上下文有界**：教练上下文各段设硬上限（活动摘要 ≤90 条、周量 ≤52 周、每日状态 ≤28 天、对话历史 ≤20 条且总字符 ≤16000），全部在 SQL/纯函数中过滤，无 N+1。
- **会话持久化**：0006_chat_sessions.sql（forward-only）：chat_sessions(id/title/created_at/updated_at) + chat_messages(id/session_id ON DELETE CASCADE/role/content ≤8000/created_at)，session_id+created_at 索引。
- **计划草稿**：adapter 请求启用 response_format json_object；服务端用 aiPlanDraftSchema（strictObject）校验，逐日校验 localDate ∈ [today+1, today+horizon]、workoutType ∈ 白名单、目标为正数；非法日丢弃并在响应中标记 discardedCount。
- **导入走既有 API**：前端逐条调用 POST /api/planned-workouts（复用其 Zod 校验与 updatedAt 语义），导入后失效 calendar/calendar-plan/training-summary 查询。
- **provider 复用**：DeepSeekReviewProvider + key-runtime 热切换 + mock provider（扩展：检测请求含 response_format 时返回合法计划 JSON）。

## 架构图

```mermaid
flowchart LR
  UI[/coach 对话页] -- POST /api/ai/coach/chat --> APP[app.ts]
  UI -- POST /api/ai/coach/plan + POST /api/planned-workouts --> APP
  APP --> CTX[coach-context 纯函数聚合<br/>活动/PB/周量/计划/每日状态]
  APP --> DB[(chat_sessions / chat_messages)]
  APP --> SVC[AiReviewService.provider]
  SVC --> DSP[DeepSeekReviewProvider 或 mock]
```

## Directory Structure

```
apps/server/drizzle/0006_chat_sessions.sql          # [NEW] 会话与消息表
apps/server/src/services/ai/coach-context.ts        # [NEW] 教练上下文纯函数（PB/汇总/每日状态）
apps/server/src/services/ai/coach-service.ts        # [NEW] 对话编排（有界历史/口径提示词）
apps/server/src/services/ai/plan-draft.ts           # [NEW] 计划草稿校验与解析
apps/server/src/repositories/chat-repository.ts     # [NEW] 会话/消息 CRUD
apps/server/test/ai-coach-context.test.ts           # [NEW] PB 与上下文边界测试
apps/server/test/ai-coach-chat.test.ts              # [NEW] 会话持久化/有界历史/无泄漏测试
apps/server/test/ai-coach-plan.test.ts              # [NEW] 草稿校验与日期边界测试
packages/shared/src/index.ts                        # [MODIFY] aiCoachContextSchema、chatSessionSchema、aiPlanDraftSchema 等
apps/server/src/app.ts                              # [MODIFY] coach 路由
apps/server/src/main.ts                             # [MODIFY] coach 服务装配
apps/web/src/api.ts / pages/CoachPage.tsx / App.tsx # [MODIFY/NEW] /coach 页面与导航
apps/server/src/db/schema.ts                        # [MODIFY] 会话/消息表映射
PLAN.md / docs/PROJECT_CONTEXT.md / AGENTS.md / README.md # [MODIFY] M7 范围与冻结边界修订记录
```

## Key Code Structures

```ts
// shared：教练上下文（全部数值确定性计算，有界）
aiCoachContextSchema = z.object({
  generatedForLocalDate: z.iso.date(), timezoneOffsetMinutes: z.number().int(),
  recentActivities: z.array(z.object({ localDate, activityType, distanceMeters, durationSeconds,
    movingDurationSeconds, averagePaceSecondsPerKilometer })).max(90),
  personalBests: z.array(z.object({ distanceBucketKm: z.number(), paceSecondsPerKilometer: z.number(),
    achievedOnLocalDate: z.iso.date() })).max(5),
  longestRun: z.object({ distanceMeters: z.number().nonnegative(), localDate: z.iso.date() }).nullable(),
  weeklyVolumes: z.array(dashboardWeeklyVolumeSchema).max(52),
  planSummary: trainingSummaryCountsSchema,
  dailyStatus: z.array(z.object({ localDate: z.iso.date(), sleepQuality/fatigueLevel/muscleSorenessLevel/
    stressLevel/motivationLevel: .nullable(), restingHeartRateBpm: .nullable(), notes: z.string().max(2000).nullable() })).max(28),
});
// shared：计划草稿
aiPlanDraftSchema = z.object({ planName: z.string().trim().min(1).max(80),
  days: z.array(z.strictObject({ localDate: z.iso.date(), workoutType: plannedWorkoutTypeSchema,
    title: z.string().trim().min(1).max(120), notes: z.string().max(2000).nullable().optional(),
    targetDistanceMeters: z.number().positive().optional(), targetDurationSeconds: z.number().positive().optional() })).min(1).max(28) });
```

## 设计方式

延续现有深色应用风格（slate 卡片 + emerald 强调 + 中文标签）。

- **/coach 页面**（Batch 2–3）：左侧会话列表（新建/选择/删除，移动端折叠为顶部下拉）；右侧消息流（用户右对齐气泡、AI 左对齐并带“AI 生成”badge 与模型名），底部输入框 + 发送按钮（pending 时禁用防重复）；顶部固定“数据范围”提示条（蓝）：本次对话将发送全部训练上下文与最近对话，附“查看将发送的预览”链接。计划草稿以卡片表格展示：每行日期/类型下拉/标题/目标（可编辑）+ 勾选框，“导入所选到日历”主按钮，导入结果逐行反馈（成功/失败原因）。
- **/review 增强**（Batch 1）：预览区新增“教练上下文”可展开段（PB 表格、52 周量、每日状态摘要），与原始 JSON 一样如实展示。
- 移动端单列堆叠、无横向溢出；全部交互用真实 button/input。
