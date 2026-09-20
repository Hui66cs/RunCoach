import path from 'node:path';
import {
  GarminFitAdapter,
  SuppliedActivitiesCsvAdapter,
  matchActivity,
  type FitInput,
} from '@runcoach/importers';
import type {
  ImportItemResult,
  ImportReport,
  MatchDecision,
  NormalizedActivity,
} from '@runcoach/shared';
import type { ActivityRepository, MergeHooks } from '../repositories/activity-repository.js';
import type { RawFileStore } from '../storage/raw-file-store.js';

interface ImportFileInput {
  buffer: Buffer;
  originalName: string;
  mediaType: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知导入错误';
}

function itemResult(
  itemId: string,
  outcome: ImportItemResult['outcome'],
  message: string,
  values: {
    activityId?: string | null;
    canonicalActivityIdBefore?: string | null;
    sourceId?: string | null;
    match?: MatchDecision | null;
  } = {},
): ImportItemResult {
  return {
    itemId,
    outcome,
    activityId: values.activityId ?? null,
    canonicalActivityIdBefore: values.canonicalActivityIdBefore ?? null,
    sourceId: values.sourceId ?? null,
    message,
    match: values.match ?? null,
  };
}

export class ImportService {
  private readonly csvAdapter = new SuppliedActivitiesCsvAdapter();
  private readonly fitAdapter = new GarminFitAdapter();

  constructor(
    private readonly repository: ActivityRepository,
    private readonly fileStore: RawFileStore,
    private readonly localOffsetMinutes: number,
  ) {}

  async importCsv(input: ImportFileInput): Promise<ImportReport> {
    if (path.extname(input.originalName).toLowerCase() !== '.csv') {
      throw new Error('CSV 导入只接受 .csv 文件');
    }
    const stored = this.fileStore.save(input.buffer, input.originalName, input.mediaType);
    const rawFileId = this.repository.ensureRawFile(stored);
    const jobId = this.repository.createImportJob('CSV', input.originalName, rawFileId);
    const items: ImportItemResult[] = [];
    let hasErrors = false;

    try {
      const normalizedActivities = await this.csvAdapter.decode({
        text: input.buffer.toString('utf8'),
        fileSha256: stored.sha256,
        timezoneOffsetMinutes: this.localOffsetMinutes,
      });
      for (const [index, normalized] of normalizedActivities.entries()) {
        const itemId = this.repository.createImportItem(jobId, index + 2);
        const existing =
          normalized.sourceExternalId === null || normalized.sourceExternalId === undefined
            ? undefined
            : this.repository.findSourceByExternalIdentity('CSV', normalized.sourceExternalId);
        if (existing !== undefined) {
          this.repository.completeImportItem(itemId, 'DUPLICATE_SKIPPED', {
            activityId: existing.activityId,
            sourceId: existing.id,
          });
          items.push(
            itemResult(itemId, 'DUPLICATE_SKIPPED', 'CSV 行已导入，已跳过', {
              activityId: existing.activityId,
              sourceId: existing.id,
            }),
          );
          continue;
        }
        try {
          const applied = this.repository.createActivityFromSource({
            normalized,
            rawFileId,
            fileSha256: stored.sha256,
            rawPayload: normalized.rawSummary,
            importItemId: itemId,
          });
          this.repository.completeImportItem(itemId, 'CREATED', applied);
          items.push(
            itemResult(itemId, 'CREATED', '已从 CSV 创建活动摘要', {
              activityId: applied.activityId,
              sourceId: applied.sourceId,
            }),
          );
        } catch (error) {
          hasErrors = true;
          this.repository.completeImportItem(itemId, 'FAILED', {
            errorMessage: errorMessage(error),
          });
          items.push(itemResult(itemId, 'FAILED', errorMessage(error)));
        }
      }
    } catch (error) {
      hasErrors = true;
      const itemId = this.repository.createImportItem(jobId);
      this.repository.completeImportItem(itemId, 'FAILED', { errorMessage: errorMessage(error) });
      items.push(itemResult(itemId, 'FAILED', errorMessage(error)));
    }
    this.repository.completeImportJob(jobId, hasErrors);
    return {
      jobId,
      sourceType: 'CSV',
      status: hasErrors ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
      items,
    };
  }

  async importFit(input: ImportFileInput, hooks: MergeHooks = {}): Promise<ImportReport> {
    if (path.extname(input.originalName).toLowerCase() !== '.fit') {
      throw new Error('FIT 导入只接受 .fit 文件');
    }
    const stored = this.fileStore.save(input.buffer, input.originalName, input.mediaType);
    const rawFileId = this.repository.ensureRawFile(stored);
    const jobId = this.repository.createImportJob('FIT', input.originalName, rawFileId);
    const itemId = this.repository.createImportItem(jobId);
    const duplicate = this.repository.findActiveFitByHash(stored.sha256);
    if (duplicate !== undefined) {
      this.repository.completeImportItem(itemId, 'DUPLICATE_SKIPPED', {
        activityId: duplicate.activityId,
        sourceId: duplicate.id,
      });
      this.repository.completeImportJob(jobId, false);
      return {
        jobId,
        sourceType: 'FIT',
        status: 'COMPLETED',
        items: [
          itemResult(itemId, 'DUPLICATE_SKIPPED', '相同 SHA-256 的 FIT 已导入，未重复写入', {
            activityId: duplicate.activityId,
            sourceId: duplicate.id,
          }),
        ],
      };
    }

    try {
      const decoded = await this.fitAdapter.decode({
        buffer: input.buffer,
        fileSha256: stored.sha256,
        defaultTimezoneOffsetMinutes: this.localOffsetMinutes,
      } satisfies FitInput);
      if (decoded.length !== 1) {
        throw new Error(`当前纵向切片要求每个 FIT 恰好包含一个 session，实际为 ${decoded.length}`);
      }
      const normalized = decoded[0];
      if (normalized === undefined) throw new Error('FIT 没有可导入活动');
      const match = matchActivity(normalized, this.repository.getMatchViews()).decision;
      return this.applyFitDecision(
        jobId,
        itemId,
        rawFileId,
        stored.sha256,
        normalized,
        match,
        hooks,
      );
    } catch (error) {
      this.repository.completeImportItem(itemId, 'FAILED', {
        errorMessage: errorMessage(error),
      });
      this.repository.completeImportJob(jobId, true);
      return {
        jobId,
        sourceType: 'FIT',
        status: 'COMPLETED_WITH_ERRORS',
        items: [itemResult(itemId, 'FAILED', errorMessage(error))],
      };
    }
  }

  private applyFitDecision(
    jobId: string,
    itemId: string,
    rawFileId: string,
    fileSha256: string,
    normalized: NormalizedActivity,
    match: MatchDecision,
    hooks: MergeHooks,
  ): ImportReport {
    if (match.kind === 'PENDING_CONFIRMATION') {
      this.repository.completeImportItem(itemId, 'PENDING_CONFIRMATION', {
        matchScore: match.candidates[0]?.score ?? null,
        matchDetails: match,
        normalizedPayload: normalized,
      });
      this.repository.completeImportJob(jobId, false);
      return {
        jobId,
        sourceType: 'FIT',
        status: 'COMPLETED',
        items: [
          itemResult(itemId, 'PENDING_CONFIRMATION', match.reason, {
            match,
          }),
        ],
      };
    }

    const applyInput = {
      normalized,
      rawFileId,
      fileSha256,
      rawPayload: normalized.rawSummary,
      importItemId: itemId,
    };
    const existingActivityId = match.kind === 'AUTO_MERGE' ? match.candidate.activityId : null;
    const applied =
      match.kind === 'AUTO_MERGE'
        ? this.repository.mergeSourceIntoActivity(match.candidate.activityId, applyInput, hooks)
        : this.repository.createActivityFromSource(applyInput);
    const outcome = match.kind === 'AUTO_MERGE' ? 'UPGRADED' : 'CREATED';
    const message =
      match.kind === 'AUTO_MERGE' ? 'FIT 已原地升级匹配活动' : '没有可靠候选，已创建 FIT 活动';
    this.repository.completeImportItem(itemId, outcome, {
      activityId: applied.activityId,
      sourceId: applied.sourceId,
      matchScore: match.kind === 'AUTO_MERGE' ? match.candidate.score : null,
      matchDetails: match,
    });
    this.repository.completeImportJob(jobId, false);
    return {
      jobId,
      sourceType: 'FIT',
      status: 'COMPLETED',
      items: [
        itemResult(itemId, outcome, message, {
          activityId: applied.activityId,
          canonicalActivityIdBefore: existingActivityId,
          sourceId: applied.sourceId,
          match,
        }),
      ],
    };
  }
}
