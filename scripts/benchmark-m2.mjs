#!/usr/bin/env node
// M2.1 performance baseline benchmark.
//
// Runs against a throwaway SQLite database in a temporary directory, applies
// the existing migrations, writes synthetic activities through the real
// production repository code, and measures list/detail/series read paths.
// It never reads or writes the developer's real data directory and always
// cleans up after itself. The output is a human-readable summary plus a
// structured JSON block; the exit code reflects success or failure.
//
// This benchmark is a baseline measurement tool, not a CI performance SLA.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';

const serverDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps/server/dist',
);

if (!fs.existsSync(path.join(serverDist, 'repositories', 'activity-repository.js'))) {
  console.error(
    'apps/server/dist 不存在。请先运行: pnpm build:packages && pnpm --filter @runcoach/server build',
  );
  process.exit(1);
}

const { openDatabase } = await import(pathToFileURL(path.join(serverDist, 'db', 'client.js')).href);
const { applyMigrations, resolveMigrationsDirectory } = await import(
  pathToFileURL(path.join(serverDist, 'db', 'migrate.js')).href
);
const { ActivityRepository } = await import(
  pathToFileURL(path.join(serverDist, 'repositories', 'activity-repository.js')).href
);

const READ_RUNS = 7;
const WRITE_RUNS = 3;
const SCALES = [
  { name: 'medium', sampleCount: 10_000 },
  { name: 'large', sampleCount: 50_000 },
];
const SERIES_METRICS = ['pace', 'heartRate', 'gps'];
const MAX_POINTS = 1000;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

function syntheticActivity({ name, sampleCount, runIndex }) {
  const startTimeUtc = '2026-01-15T00:00:00.000Z';
  const samples = Array.from({ length: sampleCount }, (_, sequence) => {
    const progress = sequence / Math.max(1, sampleCount - 1);
    return {
      sequence,
      timestampUtc: new Date(Date.parse(startTimeUtc) + sequence * 1000).toISOString(),
      elapsedSeconds: sequence,
      distanceMeters: sequence * 2,
      speedMetersPerSecond: Number((2 + Math.sin(progress * Math.PI * 20) * 0.5).toFixed(3)),
      heartRateBpm: 140 + Math.round(Math.sin(progress * Math.PI * 8) * 20),
      cadenceStepsPerMinute: Number((170 + Math.sin(progress * Math.PI * 12) * 5).toFixed(2)),
      altitudeMeters: Number((50 + Math.sin(progress * Math.PI * 6) * 30).toFixed(2)),
      latitudeDegrees: Number((30 + progress * 0.02).toFixed(6)),
      longitudeDegrees: Number((120 + progress * 0.02).toFixed(6)),
    };
  });
  return {
    sourceType: 'FIT',
    sourceExternalId: `${name}-external-${runIndex}`,
    sourceIdentityKey: `${name}-identity-${runIndex}`,
    activityType: 'RUN',
    startTimeUtc,
    originalStartTime: '2026-01-15T08:00:00+08:00',
    timezoneOffsetMinutes: 480,
    localDate: '2026-01-15',
    name: `${name} synthetic ${runIndex}`,
    notes: null,
    distanceMeters: (sampleCount - 1) * 2,
    durationSeconds: sampleCount - 1,
    movingDurationSeconds: sampleCount - 1,
    averageHeartRateBpm: 140,
    maxHeartRateBpm: 160,
    deviceName: 'Benchmark',
    laps: [],
    rawSummary: {},
    samples,
  };
}

function prepareSource(repository, label) {
  const stored = {
    id: randomUUID(),
    sha256: createHash('sha256').update(label).digest('hex'),
    relativePath: `raw/benchmark/${label}.fit`,
    originalName: `${label}.fit`,
    mediaType: 'application/octet-stream',
    byteLength: 1,
  };
  const rawFileId = repository.ensureRawFile(stored);
  const jobId = repository.createImportJob('FIT', stored.originalName, rawFileId);
  const itemId = repository.createImportItem(jobId);
  return {
    stored,
    rawFileId,
    itemId,
    fileSha256: stored.sha256,
    rawPayload: {},
  };
}

function createQueryTracker(sqlite) {
  let count = 0;
  const originalPrepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = (...args) => {
    count += 1;
    return originalPrepare(...args);
  };
  return {
    reset: () => {
      count = 0;
    },
    get count() {
      return count;
    },
  };
}

function measure(runs, operation) {
  const timings = [];
  let sqlQueries = null;
  for (let index = 0; index < runs; index += 1) {
    tracker.reset();
    const start = performance.now();
    operation();
    const end = performance.now();
    timings.push(end - start);
    sqlQueries = tracker.count;
  }
  return {
    medianMs: median(timings),
    minMs: Math.min(...timings),
    maxMs: Math.max(...timings),
    sqlQueries,
  };
}

function assert(condition, message, failures) {
  if (!condition) failures.push(message);
}

const failures = [];
const operations = [];
const trackerByDb = new WeakMap();

function track(database) {
  tracker = createQueryTracker(database.sqlite);
  trackerByDb.set(database, tracker);
  return tracker;
}

let tracker = null;
// measure() closes over the module-level tracker; set it after the DB opens.
function measureOn(database, runs, operation) {
  tracker = trackerByDb.get(database);
  return measure(runs, operation);
}

// --- main ---

const startedAt = new Date().toISOString();
const totalStart = performance.now();
let directory = null;
let database = null;
const result = {
  meta: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    osRelease: os.release(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    startedAt,
    benchmarkVersion: 1,
    runsPerRead: READ_RUNS,
    runsPerWrite: WRITE_RUNS,
    scales: SCALES.map((scale) => scale.sampleCount),
    seriesMetrics: SERIES_METRICS,
    maxPoints: MAX_POINTS,
    sqlQueryCounting:
      '通过包装 better-sqlite3 Database.prepare 统计预处理语句次数；事务的 BEGIN/COMMIT 等 exec 调用不计入。',
  },
  operations: [],
  validations: { passed: [], failed: failures },
  cleanupVerified: false,
};

try {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-benchmark-'));
  database = openDatabase(path.join(directory, 'benchmark.db'));
  applyMigrations(database.sqlite, resolveMigrationsDirectory());
  track(database);
  const repository = new ActivityRepository(database.db);

  // 1. Write path: create synthetic activities through the real repository.
  const activityIds = {};
  for (const scale of SCALES) {
    for (let runIndex = 0; runIndex <= WRITE_RUNS; runIndex += 1) {
      const source = prepareSource(repository, `${scale.name}-${runIndex}`);
      const normalized = syntheticActivity({
        name: scale.name,
        sampleCount: scale.sampleCount,
        runIndex,
      });
      const isMeasured = runIndex > 0;
      tracker.reset();
      const start = performance.now();
      const created = repository.createActivityFromSource({
        normalized,
        rawFileId: source.rawFileId,
        fileSha256: source.fileSha256,
        rawPayload: source.rawPayload,
        importItemId: source.itemId,
      });
      const elapsed = performance.now() - start;
      if (isMeasured) {
        let entry = operations.find(
          (operation) => operation.name === 'createActivity' && operation.scale === scale.name,
        );
        if (entry === undefined) {
          entry = {
            name: 'createActivity',
            scale: scale.name,
            sampleCount: scale.sampleCount,
            timings: [],
            sqlQueries: [],
          };
          operations.push(entry);
        }
        entry.timings.push(elapsed);
        entry.sqlQueries.push(tracker.count);
      }
      if (runIndex === WRITE_RUNS) activityIds[scale.name] = created.activityId;
    }
  }
  for (const operation of operations.filter((entry) => entry.name === 'createActivity')) {
    operation.medianMs = median(operation.timings);
    operation.minMs = Math.min(...operation.timings);
    operation.maxMs = Math.max(...operation.timings);
    operation.sqlQueries = median(operation.sqlQueries);
    delete operation.timings;
  }

  const listQuery = repository.listActivitiesPage({ limit: 30 });
  assert(
    listQuery.total >= SCALES.length * (WRITE_RUNS + 1),
    'listActivitiesPage total 不符合预期',
    failures,
  );
  assert(listQuery.items.length <= 30, 'listActivitiesPage 首页超过 limit', failures);

  // 2. listActivitiesPage: first page and common filters.
  operations.push({
    name: 'listActivitiesPage.firstPage',
    ...measureOn(database, READ_RUNS, () => repository.listActivitiesPage({ limit: 30 })),
  });
  operations.push({
    name: 'listActivitiesPage.filtered',
    ...measureOn(database, READ_RUNS, () =>
      repository.listActivitiesPage({
        limit: 30,
        dateFrom: '2026-01-01',
        dateTo: '2026-12-31',
        activityType: 'RUN',
        sourceType: 'FIT',
      }),
    ),
  });

  // 3. getActivity on both scales.
  for (const scale of SCALES) {
    const detail = repository.getActivity(activityIds[scale.name]);
    assert(detail !== null, `getActivity(${scale.name}) 返回空`, failures);
    assert(!('samples' in detail), `getActivity(${scale.name}) 响应包含 samples`, failures);
    operations.push({
      name: 'getActivity',
      scale: scale.name,
      sampleCount: scale.sampleCount,
      ...measureOn(database, READ_RUNS, () => repository.getActivity(activityIds[scale.name])),
    });
  }

  // 4. Full-range series on both scales.
  for (const scale of SCALES) {
    const query = { metrics: SERIES_METRICS, maxPoints: MAX_POINTS };
    const series = repository.getActivitySeries(activityIds[scale.name], query);
    assert(series !== null, `getActivitySeries(${scale.name}) 返回空`, failures);
    assert(series.returnedPoints <= MAX_POINTS, `${scale.name} series 超过 maxPoints`, failures);
    assert(
      series.totalPoints === scale.sampleCount,
      `${scale.name} series totalPoints 错误`,
      failures,
    );
    assert(
      series.points[0].sequence === 0 && series.points.at(-1).sequence === scale.sampleCount - 1,
      `${scale.name} series 未保留首尾点`,
      failures,
    );
    assert(
      series.points.every(
        (point, index) => index === 0 || point.sequence > series.points[index - 1].sequence,
      ),
      `${scale.name} series 顺序错误`,
      failures,
    );
    assert(
      series.points.every(
        (point) =>
          'paceSecondsPerKilometer' in point &&
          'heartRateBpm' in point &&
          'latitudeDegrees' in point &&
          'longitudeDegrees' in point,
      ),
      `${scale.name} series 缺少请求字段`,
      failures,
    );
    operations.push({
      name: 'getActivitySeries.fullRange',
      scale: scale.name,
      sampleCount: scale.sampleCount,
      ...measureOn(database, READ_RUNS, () =>
        repository.getActivitySeries(activityIds[scale.name], query),
      ),
    });
  }

  // 5. Narrow-range series (~10% of the activity) on both scales.
  for (const scale of SCALES) {
    const span = Math.floor(scale.sampleCount * 0.1);
    const from = Math.floor(scale.sampleCount * 0.45);
    const to = from + span;
    const query = { metrics: SERIES_METRICS, from, to, maxPoints: MAX_POINTS };
    const series = repository.getActivitySeries(activityIds[scale.name], query);
    assert(series !== null, `ranged series(${scale.name}) 返回空`, failures);
    assert(
      series.returnedPoints <= MAX_POINTS,
      `${scale.name} ranged series 超过 maxPoints`,
      failures,
    );
    assert(
      series.totalPoints === to - from + 1,
      `${scale.name} ranged series totalPoints 与 SQL 范围不符`,
      failures,
    );
    assert(
      series.points.every((point) => point.elapsedSeconds >= from && point.elapsedSeconds <= to),
      `${scale.name} ranged series 超出 from/to`,
      failures,
    );
    assert(
      series.points[0].sequence === from && series.points.at(-1).sequence === to,
      `${scale.name} ranged series 未保留范围内首尾点`,
      failures,
    );
    operations.push({
      name: 'getActivitySeries.ranged10Percent',
      scale: scale.name,
      sampleCount: scale.sampleCount,
      from,
      to,
      ...measureOn(database, READ_RUNS, () =>
        repository.getActivitySeries(activityIds[scale.name], query),
      ),
    });
  }

  result.totalDurationMs = Math.round(performance.now() - totalStart);
} catch (error) {
  failures.push(`benchmark 异常: ${error?.stack ?? error}`);
} finally {
  try {
    database?.close();
  } catch {
    failures.push('关闭数据库失败');
  }
  if (directory !== null) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      result.cleanupVerified = !fs.existsSync(directory);
      if (!result.cleanupVerified) failures.push('临时目录未清理');
    } catch (error) {
      failures.push(`清理临时目录失败: ${error?.message ?? error}`);
    }
  }
}

const requiredJsonFields = ['meta', 'operations', 'validations', 'cleanupVerified'];
for (const field of requiredJsonFields) {
  if (!(field in result)) failures.push(`输出 JSON 缺少字段 ${field}`);
}

if (failures.length > 0) {
  console.error('\n=== benchmark 校验失败 ===');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('=== RunCoach M2 performance baseline ===');
console.log(`node ${result.meta.node} on ${result.meta.platform} (${result.meta.cpu})`);
console.log(`started at ${result.meta.startedAt}, total ${Math.round(result.totalDurationMs)} ms`);
console.log('');
for (const operation of operations) {
  const scope =
    operation.scale === undefined ? '' : ` [${operation.scale} ${operation.sampleCount}]`;
  const range = operation.from === undefined ? '' : ` (${operation.from}..${operation.to})`;
  const sql =
    operation.sqlQueries === null || operation.sqlQueries === undefined
      ? ''
      : `, ~${operation.sqlQueries} queries/run`;
  console.log(
    `${operation.name}${scope}${range}: median ${operation.medianMs.toFixed(2)} ms, min ${operation.minMs.toFixed(2)} ms, max ${operation.maxMs.toFixed(2)} ms${sql}`,
  );
}
console.log('');
console.log('--- JSON ---');
console.log(JSON.stringify(result, null, 2));
