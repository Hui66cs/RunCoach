import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ImportReport } from '@runcoach/shared';
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

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runcoach-api-'));
    database = openDatabase(path.join(directory, 'runcoach.db'));
    applyMigrations(database.sqlite, path.resolve('apps/server/drizzle'));
    const repository = new ActivityRepository(database.db);
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
      importService: new ImportService(repository, new RawFileStore(directory), 480),
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
});
