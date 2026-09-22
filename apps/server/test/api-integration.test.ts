import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ImportReport, NormalizedActivity } from '@runcoach/shared';
import { buildApp } from '../src/app.js';
import { openDatabase, type DatabaseContext } from '../src/db/client.js';
import { applyMigrations } from '../src/db/migrate.js';
import { ActivityRepository } from '../src/repositories/activity-repository.js';
import { ImportService } from '../src/services/import-service.js';
import { RawFileStore } from '../src/storage/raw-file-store.js';

function multipartFile(fileName: string, contentType: string, body: Buffer) {
  const boundary = `----runcoach-${Date.now()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    payload: Buffer.concat([prefix, body, suffix]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('import HTTP API', () => {
  let directory: string;
  let database: DatabaseContext;
  let app: FastifyInstance;
  let repository: ActivityRepository;
  let fileStore: RawFileStore;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-api-'));
    database = openDatabase(path.join(directory, 'runcoach.db'));
    applyMigrations(database.sqlite, path.resolve('apps/server/drizzle'));
    repository = new ActivityRepository(database.db);
    fileStore = new RawFileStore(directory);
    app = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 3100,
        dataDir: directory,
        databasePath: path.join(directory, 'runcoach.db'),
        localOffsetMinutes: 480,
        maxUploadBytes: 1024 * 1024,
      },
      repository,
      importService: new ImportService(repository, fileStore, 480),
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('accepts multipart CSV and exposes the created activity', async () => {
    const csv = Buffer.from(
      '活动类型,日期,标题,距离,时间\n跑步,2026-09-18 17:24:55,接口测试,8.01,00:50:54\n',
      'utf8',
    );
    const upload = multipartFile('Activities.csv', 'text/csv', csv);
    const importResponse = await app.inject({
      method: 'POST',
      url: '/api/imports/csv',
      ...upload,
    });
    expect(importResponse.statusCode).toBe(200);
    const report = importResponse.json<ImportReport>();
    expect(report.items[0]?.outcome).toBe('CREATED');

    const listResponse = await app.inject({ method: 'GET', url: '/api/activities' });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<{ items: unknown[] }>().items).toHaveLength(1);

    const historyResponse = await app.inject({
      method: 'GET',
      url: '/api/imports/history?limit=10',
    });
    expect(historyResponse.statusCode).toBe(200);
    expect(historyResponse.json<{ jobs: unknown[] }>().jobs).toHaveLength(1);

    const invalidResolve = await app.inject({
      method: 'POST',
      url: `/api/imports/items/${report.items[0]?.itemId}/resolve`,
      payload: { action: 'ATTACH', activityId: 'invalid' },
    });
    expect(invalidResolve.statusCode).toBe(400);
  });

  it('paginates and filters activities and rejects invalid queries', async () => {
    const header = '活动类型,日期,标题,距离,时间';
    const rows = [
      '跑步,2026-09-18 17:24:55,晨跑,8.01,00:50:54',
      '跑步,2026-09-19 07:00:00,节奏跑,5.00,00:25:00',
      '跑步,2026-10-01 08:00:00,十月长跑,12.00,01:10:00',
    ];
    const upload = multipartFile(
      'list.csv',
      'text/csv',
      Buffer.from(`${header}\n${rows.join('\n')}\n`),
    );
    expect(
      (await app.inject({ method: 'POST', url: '/api/imports/csv', ...upload })).statusCode,
    ).toBe(200);

    const first = await app.inject({ method: 'GET', url: '/api/activities?limit=2' });
    expect(first.statusCode).toBe(200);
    const page = first.json<{
      items: Array<{ name: string }>;
      total: number;
      nextCursor: string | null;
    }>();
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.nextCursor).toBeTypeOf('string');
    const second = await app.inject({
      method: 'GET',
      url: `/api/activities?limit=2&cursor=${page.nextCursor}`,
    });
    expect(second.json<{ items: unknown[] }>().items).toHaveLength(1);
    const filtered = await app.inject({
      method: 'GET',
      url: '/api/activities?q=%E8%8A%82%E5%A5%8F&dateFrom=2026-09-01&dateTo=2026-09-30&sourceType=CSV',
    });
    expect(
      filtered.json<{ items: Array<{ name: string }> }>().items.map((item) => item.name),
    ).toEqual(['节奏跑']);
    expect((await app.inject({ method: 'GET', url: '/api/activities?limit=0' })).statusCode).toBe(
      400,
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/activities?dateFrom=2026-10-01&dateTo=2026-09-01',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('returns an empty list and a summary-only activity without time series', async () => {
    const empty = await app.inject({ method: 'GET', url: '/api/activities' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json<{ items: unknown[]; total: number; nextCursor: string | null }>()).toEqual({
      items: [],
      total: 0,
      nextCursor: null,
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/activities?q=%E4%B8%8D%E5%AD%98%E5%9C%A8&dateFrom=2030-01-01',
        })
      ).json<{ items: unknown[] }>().items,
    ).toHaveLength(0);

    const upload = multipartFile(
      'summary-only.csv',
      'text/csv',
      Buffer.from(
        '活动类型,日期,标题,距离,时间\n跑步,2026-09-18 17:24:55,仅摘要,8.01,00:50:54\n',
        'utf8',
      ),
    );
    expect(
      (await app.inject({ method: 'POST', url: '/api/imports/csv', ...upload })).statusCode,
    ).toBe(200);

    const listed = await app.inject({ method: 'GET', url: '/api/activities' });
    const activity = listed
      .json<{ items: Array<{ id: string; hasTimeSeries: boolean }> }>()
      .items.at(0);
    expect(activity?.hasTimeSeries).toBe(false);

    const detail = await app.inject({ method: 'GET', url: `/api/activities/${activity?.id}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json<{
      laps: unknown[];
      analysis: { splits: { status: string; reason: string | null } };
      derivedSummary: { derivedMovingDurationSeconds: number | null };
    }>();
    expect(body).not.toHaveProperty('samples');
    expect(body.laps).toHaveLength(0);
    expect(body.analysis.splits.status).toBe('UNAVAILABLE');
    expect(body.analysis.splits.reason).not.toBeNull();
    expect(body.derivedSummary.derivedMovingDurationSeconds).toBeNull();

    const series = await app.inject({
      method: 'GET',
      url: `/api/activities/${activity?.id}/series`,
    });
    expect(series.statusCode).toBe(200);
    expect(series.json<{ points: unknown[]; totalPoints: number }>()).toMatchObject({
      totalPoints: 0,
      points: [],
    });
  });

  it('keeps detail bounded and serves SQL-ranged downsampled series', async () => {
    const stored = fileStore.save(
      Buffer.from('large synthetic fit'),
      'large.fit',
      'application/octet-stream',
    );
    const rawFileId = repository.ensureRawFile(stored);
    const jobId = repository.createImportJob('FIT', 'large.fit', rawFileId);
    const itemId = repository.createImportItem(jobId);
    const normalized: NormalizedActivity = {
      sourceType: 'FIT',
      sourceExternalId: null,
      activityType: 'RUN',
      startTimeUtc: '2026-09-20T00:00:00.000Z',
      originalStartTime: '2026-09-20T08:00:00+08:00',
      timezoneOffsetMinutes: 480,
      localDate: '2026-09-20',
      name: 'Large series',
      notes: null,
      distanceMeters: 20000,
      durationSeconds: 6000,
      movingDurationSeconds: 5900,
      averageHeartRateBpm: 150,
      maxHeartRateBpm: 180,
      deviceName: 'Synthetic',
      laps: [],
      rawSummary: {},
      samples: Array.from({ length: 10000 }, (_, sequence) => ({
        sequence,
        timestampUtc: new Date(Date.UTC(2026, 8, 20, 0, 0, sequence)).toISOString(),
        elapsedSeconds: sequence,
        distanceMeters: sequence * 2,
        speedMetersPerSecond: 2 + (sequence === 5000 ? 5 : 0),
        heartRateBpm: sequence === 5000 ? 190 : 150,
        cadenceStepsPerMinute: 170,
        powerWatts: 220,
        altitudeMeters: 50 + sequence / 1000,
      })),
    };
    const created = repository.createActivityFromSource({
      normalized,
      rawFileId,
      fileSha256: stored.sha256,
      rawPayload: {},
      importItemId: itemId,
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/activities/${created.activityId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<Record<string, unknown>>()).not.toHaveProperty('samples');
    const series = await app.inject({
      method: 'GET',
      url: `/api/activities/${created.activityId}/series?metrics=heartRate,pace&from=4000&to=6000&maxPoints=100`,
    });
    const body = series.json<{
      points: Array<{ elapsedSeconds: number }>;
      totalPoints: number;
      returnedPoints: number;
    }>();
    expect(series.statusCode).toBe(200);
    expect(body.totalPoints).toBe(2001);
    expect(body.returnedPoints).toBeLessThanOrEqual(100);
    expect(
      body.points.every((point) => point.elapsedSeconds >= 4000 && point.elapsedSeconds <= 6000),
    ).toBe(true);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/activities/${created.activityId}/series?from=20&to=10`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/activities/00000000-0000-4000-8000-000000000000/series',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('preserves requested-metric extrema in downsampled series regardless of other field magnitudes', async () => {
    const stored = fileStore.save(
      Buffer.from('extrema synthetic fit'),
      'extrema.fit',
      'application/octet-stream',
    );
    const rawFileId = repository.ensureRawFile(stored);
    const jobId = repository.createImportJob('FIT', 'extrema.fit', rawFileId);
    const itemId = repository.createImportItem(jobId);
    const normalized: NormalizedActivity = {
      sourceType: 'FIT',
      sourceExternalId: null,
      activityType: 'RUN',
      startTimeUtc: '2026-09-21T00:00:00.000Z',
      originalStartTime: '2026-09-21T08:00:00+08:00',
      timezoneOffsetMinutes: 480,
      localDate: '2026-09-21',
      name: 'Extrema series',
      notes: null,
      distanceMeters: 50000,
      durationSeconds: 1000,
      movingDurationSeconds: 990,
      averageHeartRateBpm: 150,
      maxHeartRateBpm: 195,
      deviceName: 'Synthetic',
      laps: [],
      rawSummary: {},
      samples: Array.from({ length: 1000 }, (_, sequence) => ({
        sequence,
        timestampUtc: new Date(Date.UTC(2026, 8, 21, 0, 0, sequence)).toISOString(),
        elapsedSeconds: sequence,
        distanceMeters: sequence * 50,
        speedMetersPerSecond: 3,
        heartRateBpm: sequence === 511 ? 195 : 150,
        cadenceStepsPerMinute: 170,
        powerWatts: sequence === 700 ? 450 : 220,
        altitudeMeters: 50,
      })),
    };
    const created = repository.createActivityFromSource({
      normalized,
      rawFileId,
      fileSha256: stored.sha256,
      rawPayload: {},
      importItemId: itemId,
    });

    const heartRateSeries = await app.inject({
      method: 'GET',
      url: `/api/activities/${created.activityId}/series?metrics=heartRate&maxPoints=50`,
    });
    expect(heartRateSeries.statusCode).toBe(200);
    const heartRateBody = heartRateSeries.json<{
      points: Array<{
        elapsedSeconds: number | null;
        heartRateBpm?: number | null;
        powerWatts?: number | null;
      }>;
      totalPoints: number;
      returnedPoints: number;
    }>();
    expect(heartRateBody.totalPoints).toBe(1000);
    expect(heartRateBody.returnedPoints).toBeLessThanOrEqual(50);
    expect(heartRateBody.points.some((point) => point.heartRateBpm === 195)).toBe(true);
    expect(heartRateBody.points[0]).not.toHaveProperty('powerWatts');

    const powerSeries = await app.inject({
      method: 'GET',
      url: `/api/activities/${created.activityId}/series?metrics=power&maxPoints=50`,
    });
    expect(powerSeries.statusCode).toBe(200);
    const powerBody = powerSeries.json<{
      points: Array<{ powerWatts?: number | null }>;
      totalPoints: number;
      returnedPoints: number;
    }>();
    expect(powerBody.returnedPoints).toBeLessThanOrEqual(50);
    expect(powerBody.points.some((point) => point.powerWatts === 450)).toBe(true);

    const ranged = await app.inject({
      method: 'GET',
      url: `/api/activities/${created.activityId}/series?metrics=heartRate&from=100&to=200&maxPoints=50`,
    });
    expect(ranged.statusCode).toBe(200);
    const rangedBody = ranged.json<{
      points: Array<{ elapsedSeconds: number | null; heartRateBpm?: number | null }>;
      totalPoints: number;
      returnedPoints: number;
    }>();
    expect(rangedBody.totalPoints).toBe(101);
    expect(rangedBody.returnedPoints).toBeLessThanOrEqual(50);
    expect(
      rangedBody.points.every(
        (point) =>
          point.elapsedSeconds !== null &&
          point.elapsedSeconds >= 100 &&
          point.elapsedSeconds <= 200,
      ),
    ).toBe(true);
  });

  it('returns meaningful GPS-only series points within bounds and SQL ranges', async () => {
    const stored = fileStore.save(
      Buffer.from('gps-only synthetic fit'),
      'gps-only.fit',
      'application/octet-stream',
    );
    const rawFileId = repository.ensureRawFile(stored);
    const jobId = repository.createImportJob('FIT', 'gps-only.fit', rawFileId);
    const itemId = repository.createImportItem(jobId);
    const normalized: NormalizedActivity = {
      sourceType: 'FIT',
      sourceExternalId: null,
      activityType: 'RUN',
      startTimeUtc: '2026-09-22T00:00:00.000Z',
      originalStartTime: '2026-09-22T08:00:00+08:00',
      timezoneOffsetMinutes: 480,
      localDate: '2026-09-22',
      name: 'GPS-only series',
      notes: null,
      distanceMeters: null,
      durationSeconds: 1000,
      movingDurationSeconds: null,
      averageHeartRateBpm: null,
      maxHeartRateBpm: null,
      deviceName: 'Synthetic',
      laps: [],
      rawSummary: {},
      samples: Array.from({ length: 1000 }, (_, sequence) => ({
        sequence,
        timestampUtc: new Date(Date.UTC(2026, 8, 22, 0, 0, sequence)).toISOString(),
        elapsedSeconds: sequence,
        latitudeDegrees: 30 + Math.min(sequence, 999 - sequence) * 0.0001,
        longitudeDegrees: 120 + sequence * 0.0001,
      })),
    };
    const created = repository.createActivityFromSource({
      normalized,
      rawFileId,
      fileSha256: stored.sha256,
      rawPayload: {},
      importItemId: itemId,
    });
    const peakLatitude = 30 + 499 * 0.0001;

    const gpsSeries = await app.inject({
      method: 'GET',
      url: `/api/activities/${created.activityId}/series?metrics=gps&maxPoints=50`,
    });
    expect(gpsSeries.statusCode).toBe(200);
    const gpsBody = gpsSeries.json<{
      points: Array<{
        sequence: number;
        elapsedSeconds: number | null;
        latitudeDegrees?: number | null;
        longitudeDegrees?: number | null;
        heartRateBpm?: number | null;
      }>;
      totalPoints: number;
      returnedPoints: number;
    }>();
    expect(gpsBody.totalPoints).toBe(1000);
    expect(gpsBody.returnedPoints).toBeLessThanOrEqual(50);
    expect(gpsBody.returnedPoints).toBeGreaterThan(2);
    expect(gpsBody.points[0]?.sequence).toBe(0);
    expect(gpsBody.points.at(-1)?.sequence).toBe(999);
    const sequences = gpsBody.points.map((point) => point.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(
      gpsBody.points.every(
        (point) => point.latitudeDegrees != null && point.longitudeDegrees != null,
      ),
    ).toBe(true);
    expect(gpsBody.points.some((point) => point.latitudeDegrees === peakLatitude)).toBe(true);
    expect(gpsBody.points[0]).not.toHaveProperty('heartRateBpm');

    const ranged = await app.inject({
      method: 'GET',
      url: `/api/activities/${created.activityId}/series?metrics=gps&from=100&to=200&maxPoints=50`,
    });
    expect(ranged.statusCode).toBe(200);
    const rangedBody = ranged.json<{
      points: Array<{
        sequence: number;
        elapsedSeconds: number | null;
        latitudeDegrees?: number | null;
      }>;
      totalPoints: number;
      returnedPoints: number;
    }>();
    expect(rangedBody.totalPoints).toBe(101);
    expect(rangedBody.returnedPoints).toBeLessThanOrEqual(50);
    expect(rangedBody.returnedPoints).toBeGreaterThan(2);
    expect(
      rangedBody.points.every(
        (point) =>
          point.elapsedSeconds !== null &&
          point.elapsedSeconds >= 100 &&
          point.elapsedSeconds <= 200 &&
          point.latitudeDegrees != null,
      ),
    ).toBe(true);
  });

  it('reads, validates, and partially updates athlete settings', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/settings/athlete' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json<{ maxHeartRateBpm: number | null }>().maxHeartRateBpm).toBeNull();
    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/settings/athlete',
      payload: { maxHeartRateBpm: 195 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ maxHeartRateBpm: number }>().maxHeartRateBpm).toBe(195);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/settings/athlete',
          payload: { maxHeartRateBpm: 300 },
        })
      ).statusCode,
    ).toBe(400);
  });
});
