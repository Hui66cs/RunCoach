import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NormalizedActivity } from '@runcoach/shared';
import { openDatabase, type DatabaseContext } from '../src/db/client.js';
import { applyMigrations } from '../src/db/migrate.js';
import { ActivityRepository } from '../src/repositories/activity-repository.js';
import { ImportService } from '../src/services/import-service.js';
import { RawFileStore } from '../src/storage/raw-file-store.js';

const syntheticFitBase64 =
  'DgLeUjMBAAAuRklU7wNAAAAAAAUAAQIBAoQCAoQEBIYDBIwABP8AAQBntw9FAQAAAEEAABQABf0EhgUEhkkEhgMBAgQBAgFntw9FAAAAADwKAAB4UgFiug9FKA4DADwKAACRUgFevQ9FURwGADwKAACjUgFZwA9FeSoJADwKAACqUgFVww9FoTgMADwKAACWUkIAABMACv0EhgIEhgcEhggEhgkEhg8BAhABAgABAgEBAhkBAgJVww9FZ7cPRVSbLgBUmy4AoTgMAKO/CQEBQwAAEgAN/QSGAgSGBwSGCASGCQSGEAECEQECBQECBgECGQKEGgKEAAECAQECA1XDD0Vntw9FVJsuAFSbLgChOAwAo78BAAAAAQAIAUQAACIABv0EhgAEhgEChAIBAgMBAgQBAgRVww9FVJsuAAEAABoB54E=';

const csv = `活动类型,日期,我的最爱,标题,距离,热量消耗,时间,平均心率,最大心率,移动时间\n跑步,2026-09-18 17:24:55,否,合成测试跑步,8.01,500,00:50:54,150,180,00:50:33\n`;

describe('CSV to FIT integration', () => {
  let directory: string;
  let database: DatabaseContext;
  let repository: ActivityRepository;
  let fileStore: RawFileStore;
  let service: ImportService;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-test-'));
    database = openDatabase(path.join(directory, 'runcoach.db'));
    applyMigrations(database.sqlite, path.resolve('apps/server/drizzle'));
    repository = new ActivityRepository(database.db);
    fileStore = new RawFileStore(directory);
    service = new ImportService(repository, fileStore, 480);
  });

  afterEach(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('upgrades a CSV activity in place, preserves user fields, and skips duplicate FIT', async () => {
    const csvReport = await service.importCsv({
      buffer: Buffer.from(csv, 'utf8'),
      originalName: 'Activities.csv',
      mediaType: 'text/csv',
    });
    expect(csvReport.items).toHaveLength(1);
    expect(csvReport.items[0]?.outcome).toBe('CREATED');
    const canonicalId = csvReport.items[0]?.activityId;
    expect(canonicalId).toBeTypeOf('string');
    if (canonicalId === null || canonicalId === undefined) throw new Error('缺少 canonical ID');

    const csvOnly = repository.getActivity(canonicalId);
    expect(csvOnly?.hasTimeSeries).toBe(false);
    expect(csvOnly?.samples).toHaveLength(0);
    expect(csvOnly?.sourceTypes).toEqual(['CSV']);
    expect(csvOnly?.sources[0]?.rawFilePath).not.toBeNull();
    expect(fs.existsSync(path.join(directory, csvOnly?.sources[0]?.rawFilePath ?? 'missing'))).toBe(
      true,
    );

    repository.updateUserFields(canonicalId, { name: '我的保留名称', notes: '我的保留备注' });

    const fitBuffer = Buffer.from(syntheticFitBase64, 'base64');
    const fitReport = await service.importFit({
      buffer: fitBuffer,
      originalName: 'matching.fit',
      mediaType: 'application/octet-stream',
    });
    expect(fitReport.items[0]).toMatchObject({
      outcome: 'UPGRADED',
      activityId: canonicalId,
      canonicalActivityIdBefore: canonicalId,
    });

    const upgraded = repository.getActivity(canonicalId);
    expect(repository.listActivities()).toHaveLength(1);
    expect(upgraded?.sourceTypes).toEqual(['CSV', 'FIT']);
    expect(upgraded?.hasTimeSeries).toBe(true);
    expect(upgraded?.samples).toHaveLength(5);
    expect(upgraded?.laps).toHaveLength(1);
    expect(upgraded?.distanceMeters).toBeCloseTo(8009.29, 2);
    expect(upgraded?.durationSeconds).toBeCloseTo(3054.42, 2);
    expect(upgraded?.name).toBe('我的保留名称');
    expect(upgraded?.notes).toBe('我的保留备注');
    expect(upgraded?.provenance['name']).toBe('USER');
    expect(upgraded?.provenance['distanceMeters']).toBe('FIT');
    const fitPath = upgraded?.sources.find((source) => source.sourceType === 'FIT')?.rawFilePath;
    expect(fitPath).not.toBeNull();
    expect(fs.existsSync(path.join(directory, fitPath ?? 'missing'))).toBe(true);

    const countsBeforeDuplicate = repository.countRows();
    const duplicateReport = await service.importFit({
      buffer: fitBuffer,
      originalName: 'matching.fit',
      mediaType: 'application/octet-stream',
    });
    expect(duplicateReport.items[0]?.outcome).toBe('DUPLICATE_SKIPPED');
    expect(repository.countRows()).toEqual(countsBeforeDuplicate);
  });

  it('rolls back source, samples, laps, canonical changes, and audit after a merge failure', () => {
    const csvNormalized: NormalizedActivity = {
      sourceType: 'CSV',
      sourceExternalId: `rollback:${randomUUID()}`,
      activityType: 'RUN',
      startTimeUtc: '2026-09-19T00:00:00.000Z',
      originalStartTime: '2026-09-19 08:00:00',
      timezoneOffsetMinutes: 480,
      localDate: '2026-09-19',
      name: '回滚目标',
      notes: null,
      distanceMeters: 5000,
      durationSeconds: 1800,
      movingDurationSeconds: 1790,
      averageHeartRateBpm: 140,
      maxHeartRateBpm: 160,
      deviceName: null,
      samples: [],
      laps: [],
      rawSummary: { rowNumber: 2 },
    };
    const csvStored = fileStore.save(Buffer.from('rollback csv'), 'rollback.csv', 'text/csv');
    const csvRawId = repository.ensureRawFile(csvStored);
    const csvJob = repository.createImportJob('CSV', 'rollback.csv', csvRawId);
    const csvItem = repository.createImportItem(csvJob, 2);
    const created = repository.createActivityFromSource({
      normalized: csvNormalized,
      rawFileId: csvRawId,
      fileSha256: csvStored.sha256,
      rawPayload: csvNormalized.rawSummary,
      importItemId: csvItem,
    });

    const fitNormalized: NormalizedActivity = {
      ...csvNormalized,
      sourceType: 'FIT',
      sourceExternalId: null,
      distanceMeters: 5020,
      samples: [
        {
          sequence: 0,
          timestampUtc: csvNormalized.startTimeUtc,
          heartRateBpm: 145,
        },
      ],
      laps: [{ sequence: 0, distanceMeters: 5020, durationSeconds: 1800 }],
      rawSummary: { recordCount: 1 },
    };
    const fitBytes = Buffer.from('unique rollback fit payload');
    const fitStored = fileStore.save(fitBytes, 'rollback.fit', 'application/octet-stream');
    const fitRawId = repository.ensureRawFile(fitStored);
    const fitJob = repository.createImportJob('FIT', 'rollback.fit', fitRawId);
    const fitItem = repository.createImportItem(fitJob);
    const beforeCounts = repository.countRows();
    const beforeActivity = repository.getActivity(created.activityId);

    expect(() =>
      repository.mergeSourceIntoActivity(
        created.activityId,
        {
          normalized: fitNormalized,
          rawFileId: fitRawId,
          fileSha256: createHash('sha256').update(fitBytes).digest('hex').toUpperCase(),
          rawPayload: fitNormalized.rawSummary,
          importItemId: fitItem,
        },
        {
          afterSeriesInserted: () => {
            throw new Error('injected merge failure');
          },
        },
      ),
    ).toThrow('injected merge failure');

    expect(repository.countRows()).toEqual(beforeCounts);
    expect(repository.getActivity(created.activityId)).toEqual(beforeActivity);
  });
});
