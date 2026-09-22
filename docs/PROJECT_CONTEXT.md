# RunCoach Local 项目交接文档

> 建议落盘位置：`docs/PROJECT_CONTEXT.md`
> 项目仓库：<https://github.com/Hui66cs/RunCoach>（默认分支为 `master`）
> 当前基线：`master` 分支，当前里程碑 M4（训练日历与本地训练计划）。M1/M1.1/M2/M2.1/M3 均已完成并冻结；此前版本基于更早里程碑编写。
> 状态标记：**已实现**表示当前代码具备；**已决定、未实现**表示后续应遵守的设计；**不确定**表示必须重新查证，不能自行假设。

## 1. 项目总体目标

RunCoach Local 是一个面向单用户的本地优先跑步训练管理 Web 应用，主要运行于 Windows 11。它的长期目标是：统一接收 CSV、FIT 和未来的 ParroTao 活动摘要，在不制造重复活动的前提下形成 canonical activity；展示可靠的跑步记录、时序图表和确定性分析；随后再加入训练计划、状态跟踪和可替换的 AI 教练。

产品优先级是：

1. 数据正确性、可追溯性和隐私。
2. FIT 对较粗略 CSV/未来 API 摘要的原地升级。
3. 日常可用的活动浏览和跑步分析。
4. 训练计划与 AI 建议。

该项目不是社交平台，也不是云端多用户 SaaS。当前数据保存在用户本机。

## 2. 当前 scope 与暂不实现功能

### 已完成并冻结的 M1/M1.1 scope

- CSV、FIT 文件导入。
- canonical activity 与 immutable source 分离。
- CSV 稳定身份、增量刷新和历史 source revision。
- FIT SHA-256 幂等。
- CSV 活动被更具体的 FIT 原地升级。
- 自动匹配、待确认匹配、人工合并、创建新活动、跳过。
- 导入历史、失败原因、来源、字段 provenance、合并审计。
- 最小活动列表、活动详情、名称/备注编辑、lap 和心率/速度曲线。
- 单元、集成、私有样本 smoke test、Playwright E2E、GitHub Actions CI。

### 已完成并冻结的 M2 scope

- 正式路由和应用布局：`/activities`、`/activities/:activityId`、`/imports`、`/settings`。
- 可分页、筛选、搜索、无 source N+1 的活动列表。
- 不携带完整 samples 的活动详情接口，以及独立的有界 series API。
- 确定性单次活动分析：公里分段、前后半程、配速稳定性、心率区间、暂停/移动时间、有氧解耦的数据质量门槛。
- 单用户运动员设置（最大/静息/阈值心率、时区 offset、公制单位）。
- 服务端有界降采样（保留请求指标极值，含 GPS）、图表 zoom 驱动的范围刷新、离线轨迹轮廓。
- `0002_activity_analysis.sql` forward-only migration；单元、集成、Playwright、build、CI 覆盖。

### 已完成的 M2.1（性能与可靠性加固）

- 已建立可重复性能基线：`pnpm benchmark:m2`，结果记录于 `docs/M2_1_PERFORMANCE_BASELINE.md`。
- 结论：当前 50k samples 的 detail/series 耗时对本地单用户应用可接受，暂不继续提前优化。
- 已知性能风险保留供未来回归：`getActivity()` 为计算派生摘要与分析会读取该活动全部 samples，耗时随样本数近线性增长；`/series` 先在 SQL 中按范围过滤，但仍会把范围内全部行读入应用层降采样。

### 当前里程碑 M3（Dashboard 与跨活动趋势，进行中）

- Batch 1 已交付：`/` Dashboard 首页 + `GET /api/dashboard` 有界聚合 API。
  - 最近 7 天 / 28 天概览：跑步次数、总距离、总移动时长、平均配速；仅统计 `activityType = RUN`。
  - 最近 12 个自然周跑量趋势：周一开始、含当前周、无活动周补零。
  - 最近活动：最多 5 条，链接到既有详情页。
  - 统计口径：闭区间本地日期（“今天”由 athlete settings 的 timezoneOffsetMinutes 计算）；活动归属使用既有 `activities.local_date`；移动时长优先 `movingDurationSeconds`、回退 `durationSeconds`、缺失按 0；平均配速 = 总移动时长 / 总距离 × 1000，仅在总距离与总移动时长均为正时计算，否则为 null（时长缺失按 0 处理即返回 null，不会输出 0 配速）。
  - 聚合在 SQLite 按 `local_date` 分组完成，固定三条查询（athlete settings、按日聚合、最近活动），查询数量与活动数量无关，无逐活动 sources N+1，不返回 samples。
- Batch 2 已实现（等待 reviewer 验收）：`/trends` 跨活动趋势页 + `GET /api/trends?weeks=12|26|52`（非法值 400）。
  - 汇总卡片：总跑步次数、总距离、总移动时长、范围平均配速、有效平均心率。
  - 图表：周跑量（柱，km）+ 每周次数（折线，右轴整数）；周平均配速（min/km，反向轴，null 断开）；周平均心率（bpm，null 断开）。
  - 心率口径：对有效平均心率 > 0 且有效移动时长 > 0 的 RUN 按 `sum(hr × effectiveDuration) / sum(effectiveDuration)` 加权；无有效覆盖返回 null。
  - 范围 summary 使用整个范围的总和计算，不允许平均每周值。
  - 聚合复用 Dashboard 的按日 RUN 聚合（同一私有 helper，含心率加权列），固定两条查询（settings + 按日聚合），与活动数量无关；`weeklyPoints` 长度恰为请求的 weeks（≤52），旧→新排序，当前周为最后一项，无活动周补零。
  - 周期选择保存在 URL query（`?weeks=26`），非法值回退 12 周；12 周默认。
- Batch 3（其余跨活动趋势能力）尚未定义，范围需与 reviewer 确认。
- record 级心率趋势属于未来范围，M3 的心率口径基于活动级 canonical `averageHeartRateBpm`。

### 已验收完成的 M3

- Dashboard 首页（`/` + `GET /api/dashboard`）与 `/trends` 12/26/52 周跨活动趋势均已通过 reviewer 验收；M3 不再增加 Batch 3。

### 当前里程碑 M4（训练日历与本地训练计划，进行中）

- Batch 1 已实现（等待 reviewer 验收）：
  - `0003_training_calendar.sql`（forward-only）：新增 `planned_workouts` 表（id、scheduled_local_date、workout_type、title、notes、target_distance_meters、target_duration_seconds、created_at、updated_at）与 `scheduled_local_date` 索引；不改 activities，不复制实际活动。
  - `GET /api/calendar?from&to`：闭区间（最多 93 天），同时返回计划训练与有界实际活动摘要（无 samples/laps/sources），SQL 内过滤、固定两条查询。
  - `POST /api/planned-workouts`、`PATCH /api/planned-workouts/:id`（至少一个字段，更新 updatedAt）、`DELETE /api/planned-workouts/:id`（204；只删 planned workout，不影响活动或导入数据）。
  - 训练类型：EASY_RUN、LONG_RUN、TEMPO_RUN、INTERVAL_RUN、RECOVERY_RUN、RACE、STRENGTH、REST、OTHER；REST/STRENGTH/OTHER 允许无目标，跑步类型本批也不强制目标。
  - 单位语义：API 存储米、秒；前端输入 km 与小时/分钟，提交前换算；标题 trim 后 1–120 字符；notes ≤2000；目标必须是有限正数或空。
  - `/calendar` 月视图：周一为每周第一天，含相邻月补齐（35 或 42 天网格），月份保存在 URL（`?month=YYYY-MM`），非法回退当前月；窄屏为 agenda 列表；计划（绿）与实际活动（蓝）视觉区分，实际活动只读并链接到详情。
- Batch 2 尚未开始：计划完成状态、计划与实际活动关联、执行率与周汇总。

### 冻结不做（跨里程碑有效）

- AI 自动生成训练计划、DeepSeek/OpenAI 或其他模型接入。
- 手表下发或 Garmin Connect 写入。
- 成就系统。
- 每日状态/疲劳打卡。
- 训练日历和训练计划。
- ParroTao 在线同步的实际网络实现。
- DeepSeek、Codex App Server 或任何 AI 教练。
- 登录、多用户、社交、云同步。
- 在线地图瓦片服务。
- 备份/恢复、Windows 安装包和正式发布。
- 医疗诊断或伤病判断。

## 3. 当前完整技术栈

| 层         | 技术                                                                  |
| ---------- | --------------------------------------------------------------------- |
| Monorepo   | pnpm workspace，pnpm `10.17.1`                                        |
| Runtime    | Node.js `>=24 <25`，TypeScript `5.9`，ESM                             |
| Web        | React `19.1`、Vite `7.1`、TanStack Query `5.87`、Tailwind CSS `4.1`   |
| 图表       | ECharts `6.0`，core 按需注册，Canvas renderer，动态加载图表 chunk     |
| Server     | Fastify `5.6`、`@fastify/cors`、`@fastify/multipart`                  |
| Validation | Zod `4.1`                                                             |
| Database   | SQLite、`better-sqlite3 12.4`、Drizzle ORM `0.44`、Drizzle Kit `0.31` |
| CSV        | `csv-parse 6.1`                                                       |
| FIT        | 官方 `@garmin/fitsdk 21.208`                                          |
| Test       | Vitest `3.2`、Playwright `1.63`                                       |
| CI         | GitHub Actions；Node 24 + pnpm；常规 checks 与 Chromium E2E 分 job    |

默认开发地址：Web `127.0.0.1:5173`，API `127.0.0.1:3100`。开发数据默认位于 `.local-data`；生产目标路径是 `%LOCALAPPDATA%\RunCoach Local\data`。SQLite 开启 WAL、foreign keys、`synchronous=NORMAL`，连接超时 5 秒。

## 4. 重要 repo / 代码结构

```text
RunCoach/
├─ AGENTS.md                    # 长期约束；当前里程碑为 M2.1
├─ PLAN.md                      # 当前计划与验收状态
├─ README.md
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ PRODUCT_SPEC.md
│  ├─ IMPORT_AND_MERGE.md
│  ├─ M2_ACCEPTANCE.md          # M2 验收记录
│  ├─ M2_1_PERFORMANCE_BASELINE.md # M2.1 性能基线（第一批产出）
│  ├─ PROJECT_CONTEXT.md
│  └─ adr/                      # FIT decoder、SQLite driver、导入身份/决议 ADR
├─ apps/server/
│  ├─ drizzle/                  # 0000 initial、0001 import hardening、0002 activity analysis
│  └─ src/
│     ├─ app.ts                 # Fastify 路由和输入校验
│     ├─ config.ts              # 本地路径、端口、时区 offset、上传上限
│     ├─ db/{client,migrate,schema}.ts
│     ├─ repositories/activity-repository.ts
│     ├─ services/import-service.ts
│     ├─ storage/raw-file-store.ts
│     └─ errors.ts
├─ apps/web/src/
│  ├─ App.tsx                   # 正式路由壳（/、/activities、/imports、/settings）
│  ├─ api.ts / imports-api.ts
│  ├─ SeriesChart.tsx           # ECharts 有界曲线，zoom 驱动范围刷新
│  ├─ pages/                    # DashboardPage、TrendsPage、CalendarPage、ActivitiesPage、SettingsPage 等
│  ├─ format.ts
│  └─ components/               # PlannedWorkoutDialog、WeeklyVolumeChart、Import、Pending、History、ConfirmDialog、RoutePreview
├─ packages/shared/src/index.ts # Zod schema、domain types、API DTO
├─ packages/importers/src/
│  ├─ csv-adapter.ts
│  ├─ fit-adapter.ts
│  ├─ matching.ts
│  ├─ summary.ts / time.ts / types.ts
│  └─ *.test.ts
├─ packages/analytics/src/index.ts # downsampleSeries（按请求指标逐字段保留极值）与确定性分析
├─ scripts/
│  ├─ benchmark-m2.mjs          # M2.1 性能基准（临时数据库，pnpm benchmark:m2）
│  └─ run-e2e.mjs
├─ e2e/                         # synthetic fixtures、upgrade、pending
└─ .github/workflows/ci.yml
```

## 5. 核心数据模型

### canonical 与 source

- `activities`：对外展示的 canonical activity。保存类型、UTC 开始时间、原始时间、offset、local date、名称、备注、距离、总时长、移动时长、平均/最大心率、设备、是否有时序、主时序 source、版本号和时间戳。
- `activity_sources`：活动的来源记录。一个 canonical activity 可有多个 source。保存 `sourceType`、external ID、稳定 identity key、content/file SHA、raw file 引用、raw/normalized summary、active 标记。
- `raw_files`：原始文件元数据。文件按 SHA-256 content-addressed 保存于 `raw/{prefix}/{sha}.{ext}`。

### 时序、圈段和可追溯性

- `activity_samples`：sequence、timestamp、elapsed、distance、speed、heart rate、cadence、power、altitude、latitude、longitude；关联 activity 和 source。
- `activity_laps`：lap sequence、开始时间、时长、距离、平均/最大心率、平均速度。
- `activity_field_provenance`：重要 canonical 字段当前来自 USER/CSV/FIT/PARROTAO 中的哪一个 source。
- `activity_merge_events`：合并/创建/刷新事件，保存紧凑 before/after snapshot，用于计算 changed fields。

### 导入管理

- `import_jobs`：一次文件导入任务，含 source type、状态、原文件名、raw file、开始/完成时间。
- `import_items`：CSV 每行或 FIT 活动对应的处理项，含状态、outcome、activity/source、匹配分数与详情、compact normalized summary、错误、人工 resolution 和时间。

重要不变量：canonical activity 与 immutable import source 分开；完整 samples/laps 只放专用表，不复制进 normalized JSON；用户编辑字段不被后续导入覆盖。

## 6. 当前 API 与模块关键接口

### 当前 HTTP API

| 方法与路径                                | 当前行为                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /api/health`                         | 健康检查                                                                                          |
| `GET /api/dashboard`                      | 有界 Dashboard 聚合：7/28 天概览、12 自然周跑量、最近 5 条活动；不返回 samples，无 N+1            |
| `GET /api/trends`                         | 有界跨活动趋势：`weeks=12\|26\|52`（非法 400），周跑量/次数/配速/加权心率；不返回 samples，无 N+1 |
| `GET /api/calendar`                       | 闭区间日历投影（≤93 天）：计划训练 + 有界实际活动摘要；SQL 过滤，固定两条查询                     |
| `POST /api/planned-workouts`              | 创建计划训练，返回持久化后的完整记录                                                              |
| `PATCH /api/planned-workouts/:workoutId`  | 局部更新（至少一个字段），刷新 updatedAt；不存在 404                                              |
| `DELETE /api/planned-workouts/:workoutId` | 删除计划训练（204）；不影响活动或导入数据                                                         |
| `GET /api/activities`                     | 游标分页活动列表；支持 `limit/cursor/dateFrom/dateTo/activityType/sourceType/q`，无 N+1           |
| `GET /api/activities/:activityId`         | 返回活动、sources、laps、provenance、merge events、derivedSummary、analysis；**不含 samples**     |
| `PATCH /api/activities/:activityId`       | 修改名称/备注并标记 USER provenance                                                               |
| `GET /api/activities/:activityId/series`  | 有界时序：`metrics/from/to/maxPoints`，SQL 范围过滤 + 服务端确定性降采样，不返回完整 samples      |
| `GET /api/settings/athlete`               | 返回单行运动员设置                                                                                |
| `PATCH /api/settings/athlete`             | 局部更新运动员设置（最大/静息/阈值心率、时区 offset 等），至少一个字段                            |
| `POST /api/imports/csv`                   | 单文件 multipart CSV 导入                                                                         |
| `POST /api/imports/fit`                   | 单文件 multipart FIT 导入                                                                         |
| `GET /api/imports/pending?limit&cursor`   | 待确认项游标分页                                                                                  |
| `GET /api/imports/history?limit&cursor`   | 导入 job 历史游标分页                                                                             |
| `GET /api/imports/items/:itemId`          | 获取 pending 详情或已完成 item 摘要                                                               |
| `POST /api/imports/items/:itemId/resolve` | `ATTACH`、`CREATE_NEW`、`SKIP`                                                                    |

### 模块边界

1. CSV/FIT adapter 只负责把不可信外部输入缩窄并转成 `NormalizedActivity[]`，不写数据库。
2. `ImportService` 负责原始文件、adapter、幂等检查、匹配与 repository 调度。
3. `ActivityRepository` 负责查询和事务性持久化；匹配规则不应放入 HTTP handler。
4. `RawFileStore` 负责 content-addressed 落盘、路径约束、读取时 size/SHA 复验。
5. `packages/shared` 是跨 server/web/package 的 schema 与 DTO 唯一来源。
6. `packages/analytics` 只放确定性纯函数；不得依赖 UI 或 LLM。
7. Web 通过 TanStack Query 获取和失效活动、pending、history 数据。

## 7. M1/M1.1 已实现功能

- pnpm monorepo、TypeScript project references、统一 format/typecheck/lint/test/build。
- 中文 CSV adapter：BOM、严格列数、已验证中文列头、类型映射、单位转换、原始行保留。
- 官方 Garmin FIT SDK 解码 session/lap/record/device；验证 FIT header 和 CRC。
- 原始 CSV/FIT 文件按 SHA 保留；上传路径限制在 data root 内。
- stable CSV identity 与 content hash 分离：文件改名、行重排或列顺序变化不会产生新 canonical activity。
- 同一 CSV identity 内容变化时创建新的 immutable CSV source revision，旧 revision `active=false`，canonical ID 不变。
- FIT 重复 SHA 不重复写入 samples/laps。
- CSV 摘要匹配 FIT 后原地升级；canonical ID 保持不变。
- 字段优先级 `USER > FIT > PARROTAO > CSV`；FIT null 不覆盖已有非空值。
- 用户名称和备注编辑、USER provenance 和后续导入保护。
- source、provenance、merge event 审计。
- 待确认处理闭环和导入历史。
- 事务回滚：合并中途失败不会留下部分 source/sample/lap/provenance/audit/canonical 修改。
- 日志敏感 header redact，错误消息脱敏。
- GitHub Actions checks 和 Playwright E2E。

## 8. CSV / FIT / ParroTao API 导入链路

### CSV：已实现

1. 只接受 `.csv`。
2. 文件先由 `RawFileStore` 保存并登记 `raw_files`，再建立 `import_job`。
3. adapter 要求列：`活动类型`、`日期`、`标题`、`距离`、`时间`；可读取移动时间、平均/最大心率等已知列。
4. CSV 没有内置 timezone；使用 `RUNCOACH_LOCAL_OFFSET_MINUTES`，默认 `+08:00`，同时保存 original time、UTC、offset、local date。
5. identity key 当前为活动类型 + UTC 开始时间的稳定哈希，不依赖文件名、文件 SHA、行号和列顺序。
6. content SHA 基于排序后的完整行键值与 trim 后内容。
7. identity 不存在：创建 activity + CSV source。
8. identity 已存在且 content SHA 相同：`DUPLICATE_SKIPPED`。
9. identity 已存在但内容变化：`REFRESHED`，新建 source revision 并在允许的 provenance 范围内刷新 canonical 字段。
10. 同一 CSV 文件内 identity 冲突：该行 `FAILED / CSV_IDENTITY_COLLISION`，不静默覆盖。

### FIT：已实现

1. 只接受 `.fit`，原始文件先保留。
2. 根据 file SHA 查询现有 active FIT source；重复则 `DUPLICATE_SKIPPED`。
3. Garmin SDK 校验并解码；当前只接受恰好一个 session。
4. 规范化 session summary、laps、records、设备和 GPS。
5. 与现有 canonical activities 评分匹配。
6. 高置信唯一候选：`UPGRADED`，在事务中原地合并。
7. 中等置信或歧义：`PENDING_CONFIRMATION`，只保存 compact summary、匹配详情和 raw FIT；不把 samples/laps 复制进 pending JSON。
8. 无可靠候选：`CREATED` 新活动。
9. 人工 resolve 时重新读取 raw FIT，检查路径、size、SHA，重新解码后再进入事务。

### ParroTao API：已决定、未实现

当前只有 `PARROTAO` source type 和优先级预留；没有 adapter、HTTP client、认证配置、同步 endpoint、增量游标或外部 API schema。不要把它描述为已完成。

未来实现应遵循已确定方向：ParroTao 只作为活动摘要来源，使用稳定 external activity ID 做幂等和增量同步，规范化到相同 canonical 模型；优先级为 `FIT > PARROTAO > CSV`；之后导入更具体 FIT 时仍原地升级同一 canonical activity。ParroTao 的真实 endpoint、字段和认证方式目前**不确定，必须以实际 API 文档/响应验证，禁止猜测**。

## 9. 匹配、待确认、合并与创建新活动逻辑

### 当前匹配政策

- 只比较相同 `activityType`。
- 候选时间窗：30 分钟。
- 时间差、距离差、时长差、类型、设备加权，总分 100：
  - 时间 40；≤60 秒满分，15 分钟归零。
  - 距离 25；≤1% 满分，≥10% 归零。
  - 时长 20；≤1% 满分，≥10% 归零。
  - 类型 10。
  - 设备相同 5。
- 距离和时长都缺失时不是候选。
- 自动合并条件：最高分 ≥85、领先第二名 ≥15、且候选尚无 FIT source。
- 待确认条件：最高分 ≥65，但不满足自动合并；最多保存前 5 个候选。
- 低于 65：创建新活动。

### 待确认原因

- 候选已经包含不同 FIT source。
- 多个候选分数接近。
- 最高分处于需要用户确认的区间。

### 人工动作

- `ATTACH`：只能选择当时记录的候选；校验 candidate activity version，若活动已变化则返回 `STALE_CANDIDATE`，pending 保持可重试。
- `CREATE_NEW`：用重新验证、解码后的 FIT 创建独立 canonical activity。
- `SKIP`：不创建 domain 数据，保留导入与 resolution 审计。

resolution 先把 item 从 `PENDING` 原子 claim 为 `RESOLVING`，随后在同一写事务完成 source/canonical/series/provenance/audit/item。相同动作重复请求返回幂等结果；已用不同动作解决则 `ALREADY_RESOLVED`。同一 FIT 已被别处附加时拒绝重复处理。

## 10. 导入历史、失败原因与异常处理

- history 以 `import_job` 展示文件、source type、开始/结束、status、各 outcome 数量和 item。
- outcome 包括：`CREATED`、`REFRESHED`、`UPGRADED`、`DUPLICATE_SKIPPED`、`PENDING_CONFIRMATION`、`FAILED`、`SKIPPED`。
- job 状态包括：`RUNNING`、`COMPLETED`、`COMPLETED_WITH_ERRORS`、`FAILED`；当前正常代码主要使用前 3 种。
- pending/history 后端已有游标分页；当前前端只读取第一页，尚未提供“加载更多”。
- resolve 非冲突异常会在 pending item 写入 `RESOLVE_FAILED` 和脱敏错误，item 保持 pending 以便重试。
- 错误脱敏会替换 Windows 本地绝对路径、疑似 API key/authorization/cookie，并截断到 1000 字符。
- Fastify 日志 redact authorization、cookie、`x-ptts-access-key`；不应记录完整 GPS。
- invalid UUID、query、patch、resolution 返回 400；not found 返回 404；stale/already resolved 等冲突返回 409；未处理错误返回脱敏 500。

## 11. 当前活动详情和可视化能力（M2 后现状）

UI 已是正式路由应用：`/activities`（可分页筛选列表）、`/activities/:activityId`（正式详情页）、`/imports`（完整 M1.1 导入闭环）、`/settings`（运动员设置）；URL 直达和刷新均可用。

已实现：

- 活动列表：分页、日期/类型/来源/关键词筛选，筛选状态保存在 URL query 中。
- 活动详情：摘要卡片、字段 provenance、merge events、FIT 原生 lap 或派生公里分段。
- 确定性分析卡片：前后半程、配速稳定性、心率区间（需设置最大心率）、有氧解耦、暂停/移动时间；不可用时显示原因，不伪造数值。
- 名称和备注编辑，USER provenance 保护。
- 时序图表：配速（专用倒置 min/km 轴）、心率、步频、功率、海拔，data zoom 驱动服务端范围刷新。
- 离线 SVG 轨迹轮廓（RoutePreview）：仅本机绘制，不加载地图瓦片、不上传 GPS。
- 数据来源与极值保留的服务端降采样：series 请求按请求指标逐字段保留 bucket 极值（GPS 按纬度/经度分别选点），结果 bounded。

当前限制：detail API 为计算派生摘要和分析仍读取全部 samples；series 在 SQL 范围过滤后把范围内全部行读入应用层降采样。两者已纳入 M2.1 性能基线（`docs/M2_1_PERFORMANCE_BASELINE.md`），是否优化由后续批次决定。

## 12. 当前测试覆盖

### Importer/unit

- FIT 有效文件的 session/lap/record 解码。
- 高置信自动合并。
- 相近候选进入 pending。
- 低置信创建新活动。
- 自定义 candidate window 生效。

### Server integration

- CSV → FIT 原地升级、canonical ID 保持、用户字段保留、重复 FIT 跳过。
- 注入合并失败后的 source/sample/lap/canonical/audit 全事务回滚。
- CSV 文件改名和增量 export 下 identity 稳定。
- CSV 内容变化原地 refresh 且 USER provenance 保留。
- 同一 CSV identity collision 明确失败。
- pending 只存 summary JSON，并可 ATTACH。
- SKIP 不写 domain 数据。
- CREATE_NEW；相同动作幂等、不同动作 replay 冲突。
- stale candidate 保持可重试。
- legacy pending candidate 缺 activity version 时重新匹配验证。

### HTTP integration

- multipart CSV 导入、活动列表可见、history 可见、非法 resolution body 返回 400。

### Private samples

- `private-fixtures` 存在时，真实 CSV 全量导入、匹配 FIT 原地升级、不匹配 FIT 新建、真实 samples 数量检查。私有数据不提交。

### Playwright

1. `upgrade.spec.ts`：页面选择 CSV、导入；再选择 FIT；确认 CSV + FIT、lap、曲线；修改名称/备注；刷新后仍存在。
2. `pending.spec.ts`：制造歧义候选；进入待确认；查看时间/距离/时长差；选择候选并确认 ATTACH；pending 数归零。

当前 E2E 已覆盖 M2 正式路由（列表/筛选/详情直达、名称备注编辑、图表切换、设置驱动的心率区间）与导入闭环；尚未覆盖 CREATE_NEW、SKIP、history 展开、分页和错误路径。

## 13. ECharts 与前端工程优化现状

- 已使用 `echarts/core`，仅注册 `LineChart`、Grid、Legend、Tooltip、CanvasRenderer；未整包导入。
- `SeriesChart` 通过 React `lazy` + dynamic import 分 chunk。
- chart lifecycle 会注册/清除 resize listener 并 dispose instance。
- 前端已有 TanStack Query query invalidation。
- Import、Pending、History、ConfirmDialog 已从 App 拆分。

M2 已完成：正式 router、页面级组件拆分（pages/）、统一格式化工具（format.ts）、服务端有界降采样取代客户端抽样。页面级错误边界仍不是正式能力。

## 14. 已确定且不要重新讨论的架构/产品决定

1. 单用户、本地优先、默认只绑定 `127.0.0.1`；当前不做账号系统。
2. canonical activity 与 source 分离，一个活动允许多个来源。
3. 原始 CSV 行和 FIT 文件保留，source revision 不覆盖历史。
4. FIT 导入必须能够原地升级已有粗略活动，不能因为 CSV 已存在就拒绝 FIT。
5. 字段优先级固定为 `USER > FIT > PARROTAO > CSV`；null 不覆盖已有非空值。
6. 用户修改过的名称和备注必须保留。
7. 完整 FIT samples/laps 使用专用表和 raw FIT，不存进 source/pending JSON。
8. 合并必须事务化并保持 canonical activity ID。
9. 模糊匹配必须人工确认，禁止“猜一个”静默合并。
10. CSV identity 不依赖文件名、文件 hash、行号或列顺序。
11. 所有外部输入通过 Zod 或 adapter boundary narrowing；避免 `any`。
12. 确定性指标放 `packages/analytics` 纯函数实现；LLM 不参与指标计算。
13. ECharts 按需加载；不要重新改成完整 bundle。
14. GPS 不上传、不写入完整日志；M2 如做轨迹只做离线 SVG/Canvas 轮廓，不接外部地图。
15. 不自动 Git commit/push。
16. 历史 migration 不修改；新增 forward-only migration。

## 15. 已知 bug、限制与技术债

### 已知阻塞 bug

交接时没有已确认的 M1 阻塞 bug。若新环境出现失败，应先复现和记录，不要假定为既有结论。

### 明确限制/技术债（M2.1 开工时更新）

- M2.1 第一批已建立性能基线：detail 路径每次请求读取全部 samples 并在 JS 中计算派生摘要与分析，`/series` 在 SQL 范围过滤后把范围内全部行读入应用层降采样；两者耗时随样本数近线性增长（10k vs 50k 的测量数据见 `docs/M2_1_PERFORMANCE_BASELINE.md`）。是否引入缓存、预计算或新 migration 属于 M2.1 后续批次，由 reviewer 依据基线决定，本文不预设结论。
- history 逐 job 查询 items，存在 N+1；数据少时可用，但需关注扩展性。
- pending/history 后端有 next cursor，前端没有加载更多。
- `getImportItem()` 返回 `unknown`，共享响应类型不完整。
- 当前 FIT 每文件只支持一个 session。
- CSV adapter 只支持已验证的特定中文 header，不自动猜其他格式。
- CSV 无原生 timezone，依赖配置 offset；跨时区历史数据可能需要未来显式 mapping。
- CSV identity 是 `activityType + startTimeUtc`；同类型同一秒两条真实活动无法区分，会明确报 collision。
- 活动类型目前只有 `RUN / STRENGTH / OTHER`。
- 暂无删除活动、撤销误合并、备份/恢复。
- 页面级错误边界仍不是正式能力。
- Garmin FIT SDK 的许可证适用于当前私有/个人阶段；任何重新分发前必须重新评估，当前不支持正式 distribution。
- `0001_import_hardening.sql`、`0002_activity_analysis.sql` 均为 forward-only；升级旧数据前应备份 data directory。

## 16. M1 最终验收状态

M1/M1.1 已由用户和执行 Codex 确认完成并通过验收（历史提交 `07b9042`）。M2 已于 `e5e7239` 完成验收，记录见 `docs/M2_ACCEPTANCE.md`。仓库 CI 配置会运行：

```powershell
pnpm install --frozen-lockfile
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

目标 Windows/Node 24 环境还可运行 `pnpm test:private`。本交接文档编写过程只检查了当前代码结构和接口，没有重新执行整套测试；因此如果需要记录某一次 CI run 的 URL 或精确通过时间，当前为**不确定**，应去 GitHub Actions 查证。

M1 验收结论：可以进入 M2，不要再以“继续完善导入核心链路”为理由推迟正式活动与分析功能；但 M2 改动必须持续回归 M1 行为。

## 17. M2 开工可直接依赖的能力

- 统一的 `NormalizedActivity`、sample、lap 和 shared types。
- 已有完整 FIT 时序、心率、步频、功率、海拔、GPS 数据列。
- canonical activity、来源、字段 provenance、审计和 user field protection。
- 稳定的活动 ID，可直接作为正式详情路由参数。
- SQLite/Drizzle migration 和 repository 基础。
- TanStack Query 客户端和 Fastify API 框架。
- ECharts 按需动态加载基础。
- `packages/analytics` 独立包，可扩展纯函数分析。
- synthetic FIT/CSV fixtures、真实私有 smoke test 入口。
- Playwright harness 与 GitHub Actions E2E job。
- 成熟的导入页面组件，可迁移到 `/imports`，无需重写业务逻辑。

M2 应优先复用这些能力，而不是更换数据库、Web 框架、FIT decoder 或重新设计导入模型。

## 18. 后续开发必须遵守的原则

- 开工先阅读 `AGENTS.md`、`PLAN.md` 和本文件，并先解决文档 scope 冲突。
- 先写/调整 shared contract，再写 repository/service/API，最后接 UI。
- source adapter、normalization、matching、merge、persistence、HTTP、React 保持分层。
- 数据库保留完整数据；API 根据用途返回摘要或降采样结果。
- 时序范围先在 SQL 过滤，不能读完整表后再用 JavaScript 截取。
- 单位固定：米、秒、m/s、bpm、steps/min、watts、metres；展示层再格式化。
- UTC、original local time、offset、stable local date 继续同时保留。
- 派生指标不得伪装为原始 FIT 值；缺失数据不得显示成 0。
- 所有分析必须有数据质量门槛、unavailable reason 和边界测试。
- 新功能不得破坏 CSV→FIT 原地升级、用户字段保护、幂等和事务回滚。
- 不提交 `.env`、数据库、raw import、private fixtures、API key 或真实 GPS。
- 每个独立部分运行相关测试，完成前运行 format/typecheck/lint/unit/integration/E2E/build。
- 遇到普通实现选择做保守、可测试的决定；只有迁移风险、需求冲突或 scope 扩张才暂停询问。
- 完成报告必须说明接口、migration、算法定义、测试结果、未完成事项和风险。

## 附录 A：长期上下文落盘建议

本文件正文即建议写入 `docs/PROJECT_CONTEXT.md` 的长期项目上下文。落盘后：

1. 在 `AGENTS.md` 增加一条：开始工作前阅读 `docs/PROJECT_CONTEXT.md`。
2. `PLAN.md` 只维护当前里程碑任务与状态，本文件维护跨里程碑不变量和已有能力。
3. 每个里程碑完成后更新本文件的 API、schema、已知限制和验收提交，不记录聊天过程。
4. 若代码与本文件冲突，以已测试的代码和 migration 为准，并在同一 PR 修正文档。

## 附录 B：新 Chat 初始化上下文

```text
我们继续开发 RunCoach Local：一个 Windows 11 单用户、本地优先的跑步训练 Web 应用。仓库是 https://github.com/Hui66cs/RunCoach （默认分支 master）。M1/M1.1/M2 已完成并验收冻结，包括 CSV/FIT 导入、CSV→FIT 原地升级、稳定 CSV identity、待确认匹配、导入历史、事务/幂等、正式活动列表/详情/series/设置路由页、确定性分析与有界降采样。当前里程碑是 M2.1（性能与可靠性加固）：第一批（文档同步与 pnpm benchmark:m2 性能基线）已完成，下一步由 reviewer 依据 docs/M2_1_PERFORMANCE_BASELINE.md 选择热点后再分批优化。请先读取仓库中的 AGENTS.md、PLAN.md、docs/PROJECT_CONTEXT.md 和现有代码；不要重做已完成里程碑，不要在热点选定前决定优化方案；不进入 dashboard、训练计划、ParroTao 在线同步或 AI。
```
