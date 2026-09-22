# M2.1 performance baseline

本文记录 M2.1 第一批建立的、可重复的长活动性能基线。它只用于形成证据和选择后续优化热点；**它不是 CI 性能 SLA**，仓库中不存在任何依赖机器速度的绝对耗时断言。不同机器（尤其是磁盘与 CPU 单核性能）的结果可能差异很大，比较时应以同一台机器上的相对变化为准。

## 测试对象与环境

- 测试提交 SHA：`e5e7239`（M2完成）。测量时工作区还包含本批次自身的未提交改动（benchmark 工具与文档），生产代码与 `e5e7239` 完全一致。
- Node：v24.18.0
- 平台：win32 x64，Windows 10.0.26200
- CPU：AMD Ryzen 7 8845HS
- 运行方式：仓库根目录 `pnpm benchmark:m2`
- 基准总耗时：约 7.7 s；临时数据库自动清理，`cleanupVerified: true`

## 方法

- 在 `os.tmpdir()` 下创建一次性目录与 SQLite 数据库，运行现有 migrations（`0000`–`0002`），全程不读写 `.local-data` 或用户真实数据目录，运行结束删除全部临时文件。
- 数据全部为合成 RUN 活动，通过生产路径 `ActivityRepository.createActivityFromSource` 写入；每个 sample 包含 sequence、timestampUtc、elapsedSeconds、distanceMeters、speedMetersPerSecond、heartRateBpm、cadenceStepsPerMinute、altitudeMeters 及合成 GPS（直线轨迹，无真实路线）。
- 两档规模：medium 10,000 samples；large 50,000 samples。
- 每项操作先预热 1 次，再正式测量（读操作 7 次、写操作 3 次），报告 median/min/max；计时使用 `performance.now()`。
- 读取路径全部调用真实 `listActivitiesPage()` / `getActivity()` / `getActivitySeries()`，无 mock、无重实现。
- SQL 查询数量通过包装 `better-sqlite3` 的 `Database.prepare` 统计（基准侧包装，无生产代码侵入）。局限：事务的 `BEGIN/COMMIT` 等通过 `exec` 执行的语句不计入，因此数字是每次操作的预处理语句次数下限。

## 基线结果

| 操作                                        | 规模     | median (ms) | min (ms) | max (ms) | ~queries/run |
| ------------------------------------------- | -------- | ----------: | -------: | -------: | -----------: |
| createActivity                              | 10,000   |      207.94 |   178.12 |   212.49 |           33 |
| createActivity                              | 50,000   |      979.89 |   969.38 |   985.35 |          113 |
| listActivitiesPage 首页                     | 8 个活动 |        0.32 |     0.30 |     1.05 |            3 |
| listActivitiesPage（date/type/source 筛选） | 8 个活动 |        0.39 |     0.34 |     0.55 |            3 |
| getActivity                                 | 10,000   |       21.82 |    21.34 |    23.99 |            8 |
| getActivity                                 | 50,000   |      157.58 |   151.99 |   172.17 |            8 |
| getActivitySeries 全范围                    | 10,000   |       18.88 |    16.57 |    28.21 |            2 |
| getActivitySeries 全范围                    | 50,000   |       96.65 |    88.06 |   108.44 |            2 |
| getActivitySeries 范围 10%（4500..5500）    | 10,000   |        2.03 |     1.78 |     6.71 |            2 |
| getActivitySeries 范围 10%（22500..27500）  | 50,000   |        8.68 |     8.42 |     9.64 |            2 |

series 请求统一为 `metrics=pace,heartRate,gps`、`maxPoints=1000`。测量过程中同时验证了：`returnedPoints <= maxPoints`、范围过滤后 `totalPoints` 与行数一致、首尾点保留、点序严格递增、请求字段齐全、detail 响应不含 samples。以上校验在本机全部通过。

## 观察到的热点

以下区分“测量结果”与“代码推断”：

**来自测量：**

1. `getActivity` 随样本数近线性增长：10k 约 22 ms，50k 约 158 ms（约 7 倍），而查询次数固定为约 8 条——增长来自单条大结果集的处理而非查询次数。
2. `/series` 全范围同样近线性：10k 约 19 ms，50k 约 97 ms（约 5 倍），查询次数仅约 2 条。
3. 范围过滤到 10% 后耗时降至全范围的约 1/9–1/11（2.0 ms / 8.7 ms），说明 SQL 范围过滤本身有效，series 的成本与范围内行数成正比。
4. 活动列表（首页与常用筛选）在当前数据量下都在亚毫秒级，不构成热点。
5. 写入路径：50k 样本创建约 1 s，包含约 113 条语句（约 100 条为 500 行/批的 sample 批量 insert）。

**代码推断（未单独测量，仅基于上述测量与代码阅读）：**

- `getActivity` 的近线性增长主要来自读取该活动全部 samples 并在 JS 中计算派生摘要与分析（`deriveKilometerSplits`、`segments` 等纯函数遍历）。detail 的查询次数固定，符合“一条全量 samples SELECT + 纯计算”的结构。
- `/series` 的增长来自范围内全行读取 + 应用层降采样与 point 映射；范围为 10% 时成本按比例下降，符合该结构。
- `createActivity` 的耗时主要为分批 insert 与事务本身，未见异常。

未发现需要在本次批次内修复的功能性 bug。

## 下一批可能的优化候选（仅列举，不做决定）

是否优化、优化哪一项、采用何种方案，应由 reviewer 依据本基线选择：

- detail 路径：减少每次请求重复计算的方式（例如派生摘要的缓存/预计算，或其他等价方案）。
- series 路径：范围读取与降采样之间的工作分配方式。
- 写入路径：sample 批量插入的批大小与事务粒度。
- 以上均可能涉及新的 migration 或缓存结构，本批次未做任何此类改动，也不预设结论。

## 已知限制

- 本基线是单机单次运行的快照；结果对磁盘（WAL 同步策略）、CPU 频率与后台负载敏感。
- SQL 查询计数是近似下限（`exec` 不计入），仅用于结构性对比，不是精确的语句总数。
- 基准不测量 HTTP 序列化与前端渲染，只覆盖 repository 层；端到端耗时只会更高。
