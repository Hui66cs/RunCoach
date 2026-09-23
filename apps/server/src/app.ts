import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  activityListQuerySchema,
  activityPatchSchema,
  activitySeriesQuerySchema,
  aiContextPreviewResponseSchema,
  aiReviewRequestSchema,
  aiReviewResponseSchema,
  athleteSettingsPatchSchema,
  calendarQuerySchema,
  calendarResponseSchema,
  dailyStatusRangeQuerySchema,
  dailyStatusRangeResponseSchema,
  dailyStatusEntrySchema,
  dailyStatusUpsertSchema,
  dashboardResponseSchema,
  plannedWorkoutCompletionPatchSchema,
  plannedWorkoutCreateSchema,
  plannedWorkoutPatchSchema,
  plannedWorkoutSchema,
  resolveImportSchema,
  trainingSummaryQuerySchema,
  trainingSummaryResponseSchema,
  trendsQuerySchema,
  trendsResponseSchema,
} from '@runcoach/shared';
import type { AppConfig } from './config.js';
import type { ActivityRepository } from './repositories/activity-repository.js';
import type { ImportService } from './services/import-service.js';
import type { AiReviewService } from './services/ai/ai-review-service.js';
import { AiServiceError } from './services/ai/ai-review-service.js';
import { RepositoryConflictError } from './repositories/activity-repository.js';
import { sanitizeErrorMessage } from './errors.js';

interface AppDependencies {
  config: AppConfig;
  repository: ActivityRepository;
  importService: ImportService;
  /** Optional: absent (the default in tests) keeps the AI review disabled. */
  aiReview?: AiReviewService;
}

const aiServiceErrorStatus: Record<string, number> = {
  AI_DISABLED: 503,
  AI_TIMEOUT: 504,
  AI_RATE_LIMITED: 429,
  AI_PROVIDER_ERROR: 502,
  AI_EMPTY_RESPONSE: 502,
  AI_INVALID_OUTPUT: 502,
};

const activityParamsSchema = z.object({ activityId: z.string().uuid() });
const itemParamsSchema = z.object({ itemId: z.string().uuid() });
const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

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

  app.get('/api/activities', async (request, reply) => {
    const query = activityListQuerySchema.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ code: 'INVALID_QUERY', message: '活动筛选参数无效' });
    return dependencies.repository.listActivitiesPage(query.data);
  });

  app.get('/api/activities/:activityId', async (request, reply) => {
    const parsed = activityParamsSchema.safeParse(request.params);
    if (!parsed.success)
      return reply.code(400).send({ code: 'INVALID_ACTIVITY_ID', message: '活动 ID 无效' });
    const activity = dependencies.repository.getActivity(parsed.data.activityId);
    if (activity === null)
      return reply.code(404).send({ code: 'NOT_FOUND', message: '活动不存在' });
    return activity;
  });

  app.get('/api/activities/:activityId/series', async (request, reply) => {
    const params = activityParamsSchema.safeParse(request.params);
    const query = activitySeriesQuerySchema.safeParse(request.query);
    if (!params.success || !query.success)
      return reply.code(400).send({ code: 'INVALID_SERIES_QUERY', message: '时序查询参数无效' });
    try {
      const series = dependencies.repository.getActivitySeries(params.data.activityId, query.data);
      if (series === null)
        return reply.code(404).send({ code: 'NOT_FOUND', message: '活动不存在' });
      return series;
    } catch (error) {
      if (error instanceof RepositoryConflictError)
        return reply.code(400).send({ code: error.code, message: error.message });
      throw error;
    }
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

  app.get('/api/dashboard', () =>
    dashboardResponseSchema.parse(dependencies.repository.getDashboard()),
  );

  app.get('/api/trends', async (request, reply) => {
    const query = trendsQuerySchema.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ code: 'INVALID_TRENDS_QUERY', message: '趋势查询参数无效' });
    return trendsResponseSchema.parse(dependencies.repository.getTrends(query.data));
  });

  app.get('/api/calendar', async (request, reply) => {
    const query = calendarQuerySchema.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ code: 'INVALID_CALENDAR_QUERY', message: '日历查询参数无效' });
    return calendarResponseSchema.parse(dependencies.repository.getCalendarRange(query.data));
  });

  app.get('/api/training-summary', async (request, reply) => {
    const query = trainingSummaryQuerySchema.safeParse(request.query);
    if (!query.success)
      return reply
        .code(400)
        .send({ code: 'INVALID_TRAINING_SUMMARY_QUERY', message: '训练汇总查询参数无效' });
    return trainingSummaryResponseSchema.parse(
      dependencies.repository.getTrainingSummary(query.data),
    );
  });

  app.post('/api/planned-workouts', async (request, reply) => {
    const body = plannedWorkoutCreateSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ code: 'INVALID_PLANNED_WORKOUT', message: '计划训练内容无效' });
    return plannedWorkoutSchema.parse(dependencies.repository.createPlannedWorkout(body.data));
  });

  const workoutParamsSchema = z.object({ workoutId: z.string().uuid() });

  app.patch('/api/planned-workouts/:workoutId', async (request, reply) => {
    const params = workoutParamsSchema.safeParse(request.params);
    const body = plannedWorkoutPatchSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ code: 'INVALID_PLANNED_WORKOUT', message: '计划训练修改无效' });
    const updated = dependencies.repository.updatePlannedWorkout(params.data.workoutId, body.data);
    if (updated === null)
      return reply.code(404).send({ code: 'NOT_FOUND', message: '计划训练不存在' });
    return plannedWorkoutSchema.parse(updated);
  });

  app.patch('/api/planned-workouts/:workoutId/completion', async (request, reply) => {
    const params = workoutParamsSchema.safeParse(request.params);
    const body = plannedWorkoutCompletionPatchSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        code: 'INVALID_PLANNED_WORKOUT_COMPLETION',
        message: '计划训练完成状态修改无效',
      });
    }
    try {
      const updated = dependencies.repository.updatePlannedWorkoutCompletion(
        params.data.workoutId,
        body.data,
      );
      if (updated === null)
        return reply.code(404).send({ code: 'NOT_FOUND', message: '计划训练不存在' });
      return plannedWorkoutSchema.parse(updated);
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        const status = error.code === 'ACTIVITY_NOT_FOUND' ? 404 : 409;
        return reply.code(status).send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.delete('/api/planned-workouts/:workoutId', async (request, reply) => {
    const params = workoutParamsSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ code: 'INVALID_PLANNED_WORKOUT', message: '计划训练 ID 无效' });
    const deleted = dependencies.repository.deletePlannedWorkout(params.data.workoutId);
    if (!deleted) return reply.code(404).send({ code: 'NOT_FOUND', message: '计划训练不存在' });
    return reply.code(204).send();
  });

  // Read-only preview of exactly what a review request would send; never
  // calls the provider and works even while the integration is disabled, so
  // a future UI can show the context before any confirm step.
  app.post('/api/ai/context', async (request, reply) => {
    const service = dependencies.aiReview;
    if (service === undefined) {
      return reply.code(503).send({ code: 'AI_DISABLED', message: 'AI 回顾未启用' });
    }
    const body = aiReviewRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .send({ code: 'INVALID_AI_REVIEW_REQUEST', message: 'AI 回顾请求无效' });
    }
    return aiContextPreviewResponseSchema.parse(service.preview(body.data));
  });

  app.post('/api/ai/review', async (request, reply) => {
    const service = dependencies.aiReview;
    if (service === undefined) {
      return reply.code(503).send({ code: 'AI_DISABLED', message: 'AI 回顾未启用' });
    }
    const body = aiReviewRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .send({ code: 'INVALID_AI_REVIEW_REQUEST', message: 'AI 回顾请求无效' });
    }
    try {
      return aiReviewResponseSchema.parse(await service.review(body.data));
    } catch (error) {
      if (error instanceof AiServiceError) {
        const status = aiServiceErrorStatus[error.code] ?? 502;
        return reply.code(status).send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get('/api/settings/athlete', () => dependencies.repository.getAthleteSettings());

  app.patch('/api/settings/athlete', async (request, reply) => {
    const body = athleteSettingsPatchSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ code: 'INVALID_ATHLETE_SETTINGS', message: '运动员设置无效' });
    return dependencies.repository.updateAthleteSettings(body.data);
  });

  const localDateParamsSchema = z.object({ localDate: z.iso.date() });

  app.get('/api/daily-status', async (request, reply) => {
    const query = dailyStatusRangeQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        code: 'INVALID_DAILY_STATUS_QUERY',
        message: '每日状态查询参数无效',
      });
    }
    const items = dependencies.repository.listDailyStatusEntries(query.data.from, query.data.to);
    return dailyStatusRangeResponseSchema.parse({
      from: query.data.from,
      to: query.data.to,
      items,
    });
  });

  app.put('/api/daily-status/:localDate', async (request, reply) => {
    const params = localDateParamsSchema.safeParse(request.params);
    const body = dailyStatusUpsertSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: 'INVALID_DAILY_STATUS', message: '每日状态内容无效' });
    }
    return dailyStatusEntrySchema.parse(
      dependencies.repository.upsertDailyStatusEntry(params.data.localDate, body.data),
    );
  });

  app.delete('/api/daily-status/:localDate', async (request, reply) => {
    const params = localDateParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ code: 'INVALID_DAILY_STATUS', message: '每日状态日期无效' });
    }
    const deleted = dependencies.repository.deleteDailyStatusEntry(params.data.localDate);
    if (!deleted) return reply.code(404).send({ code: 'NOT_FOUND', message: '每日状态不存在' });
    return reply.code(204).send();
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

  app.get('/api/imports/pending', async (request, reply) => {
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ code: 'INVALID_QUERY', message: '分页参数无效' });
    return dependencies.importService.listPending(query.data.limit, query.data.cursor);
  });

  app.get('/api/imports/history', async (request, reply) => {
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ code: 'INVALID_QUERY', message: '分页参数无效' });
    return dependencies.importService.listHistory(query.data.limit, query.data.cursor);
  });

  app.get('/api/imports/items/:itemId', async (request, reply) => {
    const params = itemParamsSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ code: 'INVALID_ITEM_ID', message: '导入项目 ID 无效' });
    const item = dependencies.importService.getImportItem(params.data.itemId);
    if (item === null)
      return reply.code(404).send({ code: 'NOT_FOUND', message: '导入项目不存在' });
    return item;
  });

  app.post('/api/imports/items/:itemId/resolve', async (request, reply) => {
    const params = itemParamsSchema.safeParse(request.params);
    const body = resolveImportSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ code: 'INVALID_RESOLUTION', message: '处理请求无效' });
    }
    try {
      return await dependencies.importService.resolveImport(params.data.itemId, body.data);
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        const status = error.code === 'NOT_FOUND' ? 404 : 409;
        return reply.code(status).send({ code: error.code, message: error.message });
      }
      if (error instanceof Error && error.message === 'IMPORT_ITEM_NOT_FOUND') {
        return reply.code(404).send({ code: 'NOT_FOUND', message: '导入项目不存在' });
      }
      throw error;
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RepositoryConflictError) {
      const status =
        error.code === 'NOT_FOUND' ? 404 : error.code.startsWith('INVALID_') ? 400 : 409;
      void reply.code(status).send({ code: error.code, message: sanitizeErrorMessage(error) });
      return;
    }
    const message = sanitizeErrorMessage(error);
    app.log.error({ error: message }, '请求处理失败');
    void reply.code(500).send({ code: 'INTERNAL_ERROR', message });
  });
  return app;
}
