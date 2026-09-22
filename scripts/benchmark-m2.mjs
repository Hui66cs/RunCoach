#!/usr/bin/env node
// M2.1 performance baseline benchmark.
//
// Runs against a throwaway SQLite database in a temporary directory, applies
// the existing migrations, writes synthetic activities through the real
// production repository code, and measures list/detail/series read paths.
// It never reads or writes the developer's real data directory and always
// cleans up after itself. The output is a human-readable summary plus a
// structured JSON block built from the same measurements; the exit code
// reflects success or failure.
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
const REQUIRED_JSON_FIELDS = ['meta', 'operations', 'validations', 'cleanupVerified'];
// Every operation that must appear in the JSON output: [name, scale|null].
const EXPECTED_OPERATIONS = [
  ['createActivity', 'medium'],
  ['createActivity', 'large'],
  ['listActivitiesPage.firstPage', null],
  ['listActivitiesPage.filtered', null],
  ['getActivity', 'medium'],
  ['getActivity', 'large'],
  ['getActivitySeries.fullRange', 'medium'],
  ['getActivitySeries.fullRange', 'large'],
  ['getActivitySeries.ranged10Percent', 'medium'],
  ['getActivitySeries.ranged10Percent', 'large'],
];

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

// One uncounted warmup run (its result is returned for correctness checks),
// then `runs` measured runs.
function warmupAndMeasure(runs, operation) {
  tracker.reset();
  const warmupResult = operation();
  return { stats: measure(runs, operation), warmupResult };
}

const startedAt = new Date().toISOString();
const totalStart = performance.now();
let directory = null;
let database = null;
let tracker = null;

const result = {
  meta: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    osRelease: os.release(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    startedAt,
    benchmarkVersion: 2,
    runsPerRead: READ_RUNS,
    runsPerWrite: WRITE_RUNS,
    scales: SCALES.map((scale) => scale.sampleCount),
    seriesMetrics: SERIES_METRICS,
    maxPoints: MAX_POINTS,
    sqlQueryCounting:
      '通过包装 better-sqlite3 Database.prepare 统计预处理语句次数；事务的 BEGIN/COMMIT 等 exec 调用不计入。',
  },
  operations: [],
  validations: { checks: [], allPassed: true },
  cleanupVerified: false,
};

function check(name, passed, detail = null) {
  result.validations.checks.push(passed ? { name, passed: true } : { name, passed: false, detail });
  return Boolean(passed);
}

try {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-benchmark-'));
  database = openDatabase(path.join(directory, 'benchmark.db'));
  applyMigrations(database.sqlite, resolveMigrationsDirectory());
  tracker = createQueryTracker(database.sqlite);
  const repository = new ActivityRepository(database.db);

  // 1. Write path: one warmup creation per scale (runIndex 0, not measured),
  //    then WRITE_RUNS measured creations through the real repository.
  const activityIds = {};
  for (const scale of SCALES) {
    const timings = [];
    const sqlCounts = [];
    for (let runIndex = 0; runIndex <= WRITE_RUNS; runIndex += 1) {
      const source = prepareSource(repository, `${scale.name}-${runIndex}`);
      const normalized = syntheticActivity({
        name: scale.name,
        sampleCount: scale.sampleCount,
        runIndex,
      });
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
      if (runIndex > 0) {
        timings.push(elapsed);
        sqlCounts.push(tracker.count);
      }
      if (runIndex === WRITE_RUNS) activityIds[scale.name] = created.activityId;
    }
    result.operations.push({
      name: 'createActivity',
      scale: scale.name,
      sampleCount: scale.sampleCount,
      medianMs: median(timings),
      minMs: Math.min(...timings),
      maxMs: Math.max(...timings),
      sqlQueries: median(sqlCounts),
    });
  }

  // 2. listActivitiesPage: first page and common filters.
  {
    const { stats, warmupResult } = warmupAndMeasure(READ_RUNS, () =>
      repository.listActivitiesPage({ limit: 30 }),
    );
    check(
      'listActivitiesPage.total',
      warmupResult.total >= SCALES.length * (WRITE_RUNS + 1),
      `total=${warmupResult.total}`,
    );
    check(
      'listActivitiesPage.firstPageLimit',
      warmupResult.items.length <= 30,
      `items=${warmupResult.items.length}`,
    );
    result.operations.push({ name: 'listActivitiesPage.firstPage', ...stats });
  }
  {
    const { stats } = warmupAndMeasure(READ_RUNS, () =>
      repository.listActivitiesPage({
        limit: 30,
        dateFrom: '2026-01-01',
        dateTo: '2026-12-31',
        activityType: 'RUN',
        sourceType: 'FIT',
      }),
    );
    result.operations.push({ name: 'listActivitiesPage.filtered', ...stats });
  }

  // 3. getActivity on both scales.
  for (const scale of SCALES) {
    const { stats, warmupResult } = warmupAndMeasure(READ_RUNS, () =>
      repository.getActivity(activityIds[scale.name]),
    );
    check(`getActivity.${scale.name}.returns`, warmupResult !== null);
    check(
      `getActivity.${scale.name}.noSamples`,
      warmupResult !== null && !('samples' in warmupResult),
    );
    result.operations.push({
      name: 'getActivity',
      scale: scale.name,
      sampleCount: scale.sampleCount,
      ...stats,
    });
  }

  // 4. Full-range series on both scales.
  for (const scale of SCALES) {
    const query = { metrics: SERIES_METRICS, maxPoints: MAX_POINTS };
    const { stats, warmupResult: series } = warmupAndMeasure(READ_RUNS, () =>
      repository.getActivitySeries(activityIds[scale.name], query),
    );
    check(`series.${scale.name}.fullRange.returns`, series !== null);
    if (series !== null) {
      check(
        `series.${scale.name}.fullRange.bounded`,
        series.returnedPoints <= MAX_POINTS,
        `returnedPoints=${series.returnedPoints}`,
      );
      check(
        `series.${scale.name}.fullRange.totalPoints`,
        series.totalPoints === scale.sampleCount,
        `totalPoints=${series.totalPoints}`,
      );
      const first = series.points[0];
      const last = series.points.at(-1);
      check(
        `series.${scale.name}.fullRange.endpoints`,
        first?.sequence === 0 && last?.sequence === scale.sampleCount - 1,
      );
      check(
        `series.${scale.name}.fullRange.ordered`,
        series.points.every(
          (point, index) => index === 0 || point.sequence > series.points[index - 1].sequence,
        ),
      );
      check(
        `series.${scale.name}.fullRange.requestedFields`,
        series.points.every(
          (point) =>
            'paceSecondsPerKilometer' in point &&
            'heartRateBpm' in point &&
            'latitudeDegrees' in point &&
            'longitudeDegrees' in point,
        ),
      );
    }
    result.operations.push({
      name: 'getActivitySeries.fullRange',
      scale: scale.name,
      sampleCount: scale.sampleCount,
      ...stats,
    });
  }

  // 5. Narrow-range series (~10% of the activity) on both scales.
  for (const scale of SCALES) {
    const span = Math.floor(scale.sampleCount * 0.1);
    const from = Math.floor(scale.sampleCount * 0.45);
    const to = from + span;
    const query = { metrics: SERIES_METRICS, from, to, maxPoints: MAX_POINTS };
    const { stats, warmupResult: series } = warmupAndMeasure(READ_RUNS, () =>
      repository.getActivitySeries(activityIds[scale.name], query),
    );
    check(`series.${scale.name}.ranged.returns`, series !== null);
    if (series !== null) {
      check(
        `series.${scale.name}.ranged.bounded`,
        series.returnedPoints <= MAX_POINTS,
        `returnedPoints=${series.returnedPoints}`,
      );
      check(
        `series.${scale.name}.ranged.totalPoints`,
        series.totalPoints === to - from + 1,
        `totalPoints=${series.totalPoints}`,
      );
      check(
        `series.${scale.name}.ranged.withinRange`,
        series.points.every((point) => point.elapsedSeconds >= from && point.elapsedSeconds <= to),
      );
      check(
        `series.${scale.name}.ranged.endpoints`,
        series.points[0]?.sequence === from && series.points.at(-1)?.sequence === to,
      );
    }
    result.operations.push({
      name: 'getActivitySeries.ranged10Percent',
      scale: scale.name,
      sampleCount: scale.sampleCount,
      from,
      to,
      ...stats,
    });
  }

  result.totalDurationMs = Math.round(performance.now() - totalStart);
} catch (error) {
  check('benchmark.exception', false, String(error?.stack ?? error));
} finally {
  try {
    database?.close();
  } catch (error) {
    check('database.close', false, String(error?.message ?? error));
  }
  if (directory !== null) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      result.cleanupVerified = !fs.existsSync(directory);
      check('cleanup.verified', result.cleanupVerified, directory);
    } catch (error) {
      check('cleanup.verified', false, String(error?.message ?? error));
    }
  } else {
    check('cleanup.verified', false, '临时目录从未创建');
  }
}

// Structural self-validation: the JSON output must be complete and sane.
check(
  'json.requiredFields',
  REQUIRED_JSON_FIELDS.every((field) => field in result),
);
check(
  'json.operationsCount',
  result.operations.length === EXPECTED_OPERATIONS.length,
  `got ${result.operations.length}`,
);
for (const [name, scale] of EXPECTED_OPERATIONS) {
  const label = scale === null ? name : `${name}.${scale}`;
  const entry = result.operations.find(
    (operation) =>
      operation.name === name &&
      (scale === null ? operation.scale === undefined : operation.scale === scale),
  );
  if (!check(`operations.${label}.present`, entry !== undefined)) continue;
  const finiteNonNegative = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  check(
    `operations.${label}.timingsSane`,
    finiteNonNegative(entry.medianMs) &&
      finiteNonNegative(entry.minMs) &&
      finiteNonNegative(entry.maxMs) &&
      entry.minMs <= entry.medianMs &&
      entry.medianMs <= entry.maxMs,
    JSON.stringify({ minMs: entry.minMs, medianMs: entry.medianMs, maxMs: entry.maxMs }),
  );
}
result.validations.allPassed = result.validations.checks.every((entry) => entry.passed);

if (!result.validations.allPassed) {
  console.error('\n=== benchmark 校验失败 ===');
  for (const entry of result.validations.checks) {
    if (!entry.passed) console.error(`- ${entry.name}${entry.detail ? `: ${entry.detail}` : ''}`);
  }
  process.exit(1);
}

console.log('=== RunCoach M2 performance baseline ===');
console.log(`node ${result.meta.node} on ${result.meta.platform} (${result.meta.cpu})`);
console.log(`started at ${result.meta.startedAt}, total ${Math.round(result.totalDurationMs)} ms`);
console.log('');
for (const operation of result.operations) {
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
console.log(
  `validations: ${result.validations.checks.length} checks, allPassed=${result.validations.allPassed}`,
);
console.log('--- JSON ---');
console.log(JSON.stringify(result, null, 2));
