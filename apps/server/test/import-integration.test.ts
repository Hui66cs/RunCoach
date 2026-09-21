import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NormalizedActivity } from '@runcoach/shared';
import { openDatabase, type DatabaseContext } from '../src/db/client.js';
import { applyMigrations } from '../src/db/migrate.js';
import { ActivityRepository } from '../src/repositories/activity-repository.js';
import type { RepositoryConflictError } from '../src/repositories/activity-repository.js';
import { ImportService } from '../src/services/import-service.js';
import { RawFileStore } from '../src/storage/raw-file-store.js';

const syntheticFitBase64 =
  'DgLeUjMBAAAuRklU7wNAAAAAAAUAAQIBAoQCAoQEBIYDBIwABP8AAQBntw9FAQAAAEEAABQABf0EhgUEhkkEhgMBAgQBAgFntw9FAAAAADwKAAB4UgFiug9FKA4DADwKAACRUgFevQ9FURwGADwKAACjUgFZwA9FeSoJADwKAACqUgFVww9FoTgMADwKAACWUkIAABMACv0EhgIEhgcEhggEhgkEhg8BAhABAgABAgEBAhkBAgJVww9FZ7cPRVSbLgBUmy4AoTgMAKO/CQEBQwAAEgAN/QSGAgSGBwSGCASGCQSGEAECEQECBQECBgECGQKEGgKEAAECAQECA1XDD0Vntw9FVJsuAFSbLgChOAwAo78BAAAAAQAIAUQAACIABv0EhgAEhgEChAIBAgMBAgQBAgRVww9FVJsuAAEAABoB54E=';

const csv = `活动类型,日期,我的最爱,标题,距离,热量消耗,时间,平均心率,最大心率,移动时间\n跑步,2026-09-18 17:24:55,否,合成测试跑步,8.01,500,00:50:54,150,180,00:50:33\n`;

const ambiguousCsv = `${csv.trimEnd()}\n${(csv.split('\n')[1] ?? '')
  .replace('17:24:55', '17:25:25')
  .replace('8.01', '8.02')}\n`;

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

  it('keeps CSV identity stable across rename and incremental exports', async () => {
    const first = await service.importCsv({
      buffer: Buffer.from(csv, 'utf8'),
      originalName: 'first.csv',
      mediaType: 'text/csv',
    });
    const originalId = first.items[0]?.activityId;
    const extraRow = (csv.split('\n')[1] ?? '')
      .replace('2026-09-18', '2026-09-19')
      .replace('8.01', '5.00');
    const expanded = `${csv.trimEnd()}\n${extraRow}\n`;
    const second = await service.importCsv({
      buffer: Buffer.from(expanded, 'utf8'),
      originalName: 'renamed.csv',
      mediaType: 'text/csv',
    });
    expect(second.items.map((item) => item.outcome)).toEqual(['DUPLICATE_SKIPPED', 'CREATED']);
    expect(repository.listActivities()).toHaveLength(2);
    expect(repository.listActivities().some((activity) => activity.id === originalId)).toBe(true);
  });

  it('refreshes changed CSV content in place and keeps USER provenance', async () => {
    const first = await service.importCsv({
      buffer: Buffer.from(csv, 'utf8'),
      originalName: 'first.csv',
      mediaType: 'text/csv',
    });
    const activityId = first.items[0]?.activityId;
    if (activityId === null || activityId === undefined) throw new Error('missing activity');
    repository.updateUserFields(activityId, { name: '用户名称', notes: '用户备注' });

    const refreshed = await service.importCsv({
      buffer: Buffer.from(csv.replace('8.01', '8.50'), 'utf8'),
      originalName: 'reordered-export.csv',
      mediaType: 'text/csv',
    });
    expect(refreshed.items[0]).toMatchObject({ outcome: 'REFRESHED', activityId });
    const activity = repository.getActivity(activityId);
    expect(activity?.distanceMeters).toBe(8500);
    expect(activity?.name).toBe('用户名称');
    expect(activity?.notes).toBe('用户备注');
    expect(activity?.provenance.name).toBe('USER');
    const sources = database.sqlite
      .prepare('SELECT active, normalized_payload FROM activity_sources ORDER BY created_at')
      .all() as Array<{ active: number; normalized_payload: string }>;
    expect(sources).toHaveLength(2);
    expect(sources.map((source) => source.active)).toEqual([0, 1]);
    expect(sources.every((source) => !source.normalized_payload.includes('"samples"'))).toBe(true);
    expect(sources.every((source) => !source.normalized_payload.includes('"laps"'))).toBe(true);
  });

  it('reports duplicate identities in one CSV instead of silently overwriting', async () => {
    const duplicated = `${csv.trimEnd()}\n${csv.split('\n')[1] ?? ''}\n`;
    const report = await service.importCsv({
      buffer: Buffer.from(duplicated, 'utf8'),
      originalName: 'collision.csv',
      mediaType: 'text/csv',
    });
    expect(report.items.map((item) => item.outcome)).toEqual(['CREATED', 'FAILED']);
    expect(repository.listActivities()).toHaveLength(1);
    expect(service.listHistory(20).jobs[0]?.items[1]?.errorCode).toBe('CSV_IDENTITY_COLLISION');
  });

  it('stores summary JSON and resolves a pending FIT by attach', async () => {
    await service.importCsv({
      buffer: Buffer.from(ambiguousCsv, 'utf8'),
      originalName: 'ambiguous.csv',
      mediaType: 'text/csv',
    });
    const fitReport = await service.importFit({
      buffer: Buffer.from(syntheticFitBase64, 'base64'),
      originalName: 'ambiguous.fit',
      mediaType: 'application/octet-stream',
    });
    expect(fitReport.items[0]?.outcome).toBe('PENDING_CONFIRMATION');
    const itemId = fitReport.items[0]?.itemId;
    if (itemId === undefined) throw new Error('missing pending item');
    const pending = service.listPending(20);
    expect(pending.total).toBe(1);
    const candidate = pending.items[0]?.candidates[0];
    if (candidate === undefined) throw new Error('missing candidate');
    const stored = database.sqlite
      .prepare('SELECT normalized_payload FROM import_items WHERE id = ?')
      .get(itemId) as { normalized_payload: string };
    expect(stored.normalized_payload).not.toContain('samples');
    expect(stored.normalized_payload).not.toContain('laps');

    const resolved = await service.resolveImport(itemId, {
      action: 'ATTACH',
      activityId: candidate.activityId,
    });
    expect(resolved.outcome).toBe('UPGRADED');
    expect(repository.getActivity(candidate.activityId)?.samples).toHaveLength(5);
    const replay = await service.resolveImport(itemId, {
      action: 'ATTACH',
      activityId: candidate.activityId,
    });
    expect(replay.idempotent).toBe(true);
  });

  it('resolves a pending FIT by skip without domain writes', async () => {
    await service.importCsv({
      buffer: Buffer.from(ambiguousCsv, 'utf8'),
      originalName: 'ambiguous.csv',
      mediaType: 'text/csv',
    });
    const fitReport = await service.importFit({
      buffer: Buffer.from(syntheticFitBase64, 'base64'),
      originalName: 'skip.fit',
      mediaType: 'application/octet-stream',
    });
    const itemId = fitReport.items[0]?.itemId;
    if (itemId === undefined) throw new Error('missing pending item');
    const before = repository.countRows();
    const skipped = await service.resolveImport(itemId, { action: 'SKIP' });
    expect(skipped.outcome).toBe('SKIPPED');
    expect(repository.countRows()).toEqual(before);
  });

  it('resolves pending FIT by create-new and rejects a different replay action', async () => {
    await service.importCsv({
      buffer: Buffer.from(ambiguousCsv, 'utf8'),
      originalName: 'ambiguous.csv',
      mediaType: 'text/csv',
    });
    const fitReport = await service.importFit({
      buffer: Buffer.from(syntheticFitBase64, 'base64'),
      originalName: 'create-new.fit',
      mediaType: 'application/octet-stream',
    });
    const itemId = fitReport.items[0]?.itemId;
    if (itemId === undefined) throw new Error('missing pending item');
    const created = await service.resolveImport(itemId, { action: 'CREATE_NEW' });
    expect(created.outcome).toBe('CREATED');
    expect(repository.listActivities()).toHaveLength(3);
    expect(repository.getActivity(created.activityId ?? '')?.samples).toHaveLength(5);
    await expect(service.resolveImport(itemId, { action: 'SKIP' })).rejects.toMatchObject({
      code: 'ALREADY_RESOLVED',
    } satisfies Partial<RepositoryConflictError>);
  });

  it('keeps a pending item retryable when its selected candidate version is stale', async () => {
    await service.importCsv({
      buffer: Buffer.from(ambiguousCsv, 'utf8'),
      originalName: 'ambiguous.csv',
      mediaType: 'text/csv',
    });
    const fitReport = await service.importFit({
      buffer: Buffer.from(syntheticFitBase64, 'base64'),
      originalName: 'stale.fit',
      mediaType: 'application/octet-stream',
    });
    const itemId = fitReport.items[0]?.itemId;
    const candidate = service.listPending(20).items[0]?.candidates[0];
    if (itemId === undefined || candidate === undefined) throw new Error('missing pending data');
    repository.updateUserFields(candidate.activityId, { notes: 'version bump' });

    await expect(
      service.resolveImport(itemId, { action: 'ATTACH', activityId: candidate.activityId }),
    ).rejects.toMatchObject({ code: 'STALE_CANDIDATE' } satisfies Partial<RepositoryConflictError>);
    expect(service.listPending(20).total).toBe(1);
    expect(service.getImportItem(itemId)).toMatchObject({ status: 'PENDING' });
  });

  it('revalidates and resolves legacy pending candidates without stored activity versions', async () => {
    await service.importCsv({
      buffer: Buffer.from(ambiguousCsv, 'utf8'),
      originalName: 'ambiguous.csv',
      mediaType: 'text/csv',
    });
    const fitReport = await service.importFit({
      buffer: Buffer.from(syntheticFitBase64, 'base64'),
      originalName: 'legacy-pending.fit',
      mediaType: 'application/octet-stream',
    });
    const itemId = fitReport.items[0]?.itemId;
    if (itemId === undefined) throw new Error('missing pending item');
    const row = database.sqlite
      .prepare('SELECT match_details FROM import_items WHERE id = ?')
      .get(itemId) as { match_details: string };
    const legacy = JSON.parse(row.match_details) as { candidates: Array<Record<string, unknown>> };
    for (const candidate of legacy.candidates) delete candidate.activityVersion;
    database.sqlite
      .prepare('UPDATE import_items SET match_details = ? WHERE id = ?')
      .run(JSON.stringify(legacy), itemId);

    const candidate = service.listPending(20).items[0]?.candidates[0];
    if (candidate === undefined) throw new Error('missing upgraded legacy candidate');
    const resolved = await service.resolveImport(itemId, {
      action: 'ATTACH',
      activityId: candidate.activityId,
    });
    expect(resolved.outcome).toBe('UPGRADED');
  });
});
