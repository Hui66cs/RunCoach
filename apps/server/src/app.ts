import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { activityPatchSchema } from '@runcoach/shared';
import type { AppConfig } from './config.js';
import type { ActivityRepository } from './repositories/activity-repository.js';
import type { ImportService } from './services/import-service.js';

interface AppDependencies {
  config: AppConfig;
  repository: ActivityRepository;
  importService: ImportService;
}

const activityParamsSchema = z.object({ activityId: z.string().uuid() });

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.x-ptts-access-key'],
    },
    bodyLimit: dependencies.config.maxUploadBytes,
  });
  await app.register(cors, { origin: ['http://127.0.0.1:5173', 'http://localhost:5173'] });
  await app.register(multipart, {
    limits: { files: 1, fileSize: dependencies.config.maxUploadBytes },
  });

  app.get('/api/health', () => ({ status: 'ok' }));

  app.get('/api/activities', () => ({ items: dependencies.repository.listActivities() }));

  app.get('/api/activities/:activityId', async (request, reply) => {
    const parsed = activityParamsSchema.safeParse(request.params);
    if (!parsed.success)
      return reply.code(400).send({ code: 'INVALID_ACTIVITY_ID', message: '活动 ID 无效' });
    const activity = dependencies.repository.getActivity(parsed.data.activityId);
    if (activity === null)
      return reply.code(404).send({ code: 'NOT_FOUND', message: '活动不存在' });
    return activity;
  });

  app.patch('/api/activities/:activityId', async (request, reply) => {
    const parsedParams = activityParamsSchema.safeParse(request.params);
    const parsedBody = activityPatchSchema.safeParse(request.body);
    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({ code: 'INVALID_ACTIVITY_PATCH', message: '活动修改内容无效' });
    }
    try {
      dependencies.repository.updateUserFields(parsedParams.data.activityId, parsedBody.data);
      return dependencies.repository.getActivity(parsedParams.data.activityId);
    } catch (error) {
      return reply.code(404).send({
        code: 'NOT_FOUND',
        message: error instanceof Error ? error.message : '活动不存在',
      });
    }
  });

  app.post('/api/imports/csv', async (request, reply) => {
    const part = await request.file();
    if (part === undefined)
      return reply.code(400).send({ code: 'FILE_REQUIRED', message: '请选择 CSV 文件' });
    const buffer = await part.toBuffer();
    const report = await dependencies.importService.importCsv({
      buffer,
      originalName: part.filename,
      mediaType: part.mimetype,
    });
    return report;
  });

  app.post('/api/imports/fit', async (request, reply) => {
    const part = await request.file();
    if (part === undefined)
      return reply.code(400).send({ code: 'FILE_REQUIRED', message: '请选择 FIT 文件' });
    const buffer = await part.toBuffer();
    const report = await dependencies.importService.importFit({
      buffer,
      originalName: part.filename,
      mediaType: part.mimetype,
    });
    return report;
  });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : '未知服务器错误';
    app.log.error({ error: message }, '请求处理失败');
    void reply.code(500).send({ code: 'INTERNAL_ERROR', message });
  });
  return app;
}
