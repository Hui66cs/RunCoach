import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseContext } from '../src/db/client.js';
import { applyMigrations } from '../src/db/migrate.js';
import { ActivityRepository } from '../src/repositories/activity-repository.js';
import { ImportService } from '../src/services/import-service.js';
import { RawFileStore } from '../src/storage/raw-file-store.js';

const fixtures = path.resolve('private-fixtures');
const required = ['Activities.csv', 'exist_test.fit', 'non_exist_test.fit'];
const available = required.every((file) => fs.existsSync(path.join(fixtures, file)));

describe.skipIf(!available)('private real samples', () => {
  let directory: string;
  let database: DatabaseContext;
  let repository: ActivityRepository;
  let service: ImportService;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-private-'));
    database = openDatabase(path.join(directory, 'runcoach.db'));
    applyMigrations(database.sqlite, path.resolve('apps/server/drizzle'));
    repository = new ActivityRepository(database.db);
    service = new ImportService(repository, new RawFileStore(directory), 480);
  });

  afterAll(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('imports all real CSV rows, upgrades the matching FIT, and creates the unrelated FIT', async () => {
    const csvBuffer = fs.readFileSync(path.join(fixtures, 'Activities.csv'));
    const csvReport = await service.importCsv({
      buffer: csvBuffer,
      originalName: 'Activities.csv',
      mediaType: 'text/csv',
    });
    expect(csvReport.status).toBe('COMPLETED');
    expect(csvReport.items).toHaveLength(65);
    expect(repository.listActivities()).toHaveLength(65);
    const matchingActivityId = csvReport.items[0]?.activityId;
    if (matchingActivityId === null || matchingActivityId === undefined) {
      throw new Error('真实 CSV 第一行没有 activity ID');
    }
    repository.updateUserFields(matchingActivityId, {
      name: '真实样本保留名称',
      notes: '真实样本保留备注',
    });

    const matchingFit = fs.readFileSync(path.join(fixtures, 'non_exist_test.fit'));
    const upgradedReport = await service.importFit({
      buffer: matchingFit,
      originalName: 'non_exist_test.fit',
      mediaType: 'application/octet-stream',
    });
    if (upgradedReport.items[0]?.outcome === 'FAILED') {
      throw new Error(`真实 FIT 导入失败：${upgradedReport.items[0].message}`);
    }
    expect(upgradedReport.items[0]).toMatchObject({
      outcome: 'UPGRADED',
      activityId: matchingActivityId,
    });
    expect(repository.listActivities()).toHaveLength(65);
    const upgraded = repository.getActivity(matchingActivityId);
    expect(upgraded?.sourceTypes).toEqual(['CSV', 'FIT']);
    expect(upgraded?.samples).toHaveLength(3055);
    expect(upgraded?.laps).toHaveLength(9);
    expect(upgraded?.name).toBe('真实样本保留名称');
    expect(upgraded?.notes).toBe('真实样本保留备注');

    const duplicate = await service.importFit({
      buffer: matchingFit,
      originalName: 'non_exist_test.fit',
      mediaType: 'application/octet-stream',
    });
    expect(duplicate.items[0]?.outcome).toBe('DUPLICATE_SKIPPED');
    expect(repository.getActivity(matchingActivityId)?.samples).toHaveLength(3055);

    const unrelatedFit = fs.readFileSync(path.join(fixtures, 'exist_test.fit'));
    const created = await service.importFit({
      buffer: unrelatedFit,
      originalName: 'exist_test.fit',
      mediaType: 'application/octet-stream',
    });
    expect(created.items[0]?.outcome).toBe('CREATED');
    expect(repository.listActivities()).toHaveLength(66);
  });
});
