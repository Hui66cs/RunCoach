import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import {
  normalizedActivitySchema,
  type ActivityType,
  type NormalizedActivity,
} from '@runcoach/shared';
import { localDateAtOffset, parseDurationSeconds, parseLocalDateTime } from './time.js';
import type { SourceAdapter } from './types.js';

const requiredHeaders = ['活动类型', '日期', '标题', '距离', '时间'] as const;

type CsvRecord = Record<string, string>;

export interface SuppliedCsvInput {
  text: string;
  fileSha256: string;
  timezoneOffsetMinutes: number;
}

function nullableNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value: string | undefined): number | null {
  const parsed = nullableNumber(value);
  return parsed === null ? null : Math.round(parsed);
}

function mapActivityType(value: string): ActivityType {
  if (value === '跑步' || value === '操场跑步') return 'RUN';
  if (value === '力量训练') return 'STRENGTH';
  return 'OTHER';
}

function assertHeaders(records: CsvRecord[]): void {
  const first = records[0];
  if (first === undefined) throw new Error('CSV 没有数据行');
  const missing = requiredHeaders.filter((header) => !(header in first));
  if (missing.length > 0) {
    throw new Error(`CSV 缺少已验证样本所需列：${missing.join('、')}`);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase();
}

function stableRowContent(row: CsvRecord): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(row)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, value.trim()]),
    ),
  );
}

function narrowCsvRecords(value: unknown): CsvRecord[] {
  if (!Array.isArray(value)) throw new Error('CSV 解析结果不是行数组');
  const rows: unknown[] = value;
  return rows.map((row, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`CSV 第 ${index + 2} 行不是键值对象`);
    }
    const record: CsvRecord = {};
    for (const [key, field] of Object.entries(row)) {
      if (typeof field !== 'string') {
        throw new Error(`CSV 第 ${index + 2} 行包含非文本字段`);
      }
      record[key] = field;
    }
    return record;
  });
}

export class SuppliedActivitiesCsvAdapter implements SourceAdapter<SuppliedCsvInput> {
  readonly sourceType = 'CSV' as const;

  decode(input: SuppliedCsvInput): Promise<NormalizedActivity[]> {
    const parsed: unknown = parse(input.text, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: false,
    });
    const records = narrowCsvRecords(parsed);
    assertHeaders(records);

    const normalized = records.map((row, index) => {
      const originalStartTime = row['日期'];
      if (originalStartTime === undefined || originalStartTime === '') {
        throw new Error(`CSV 第 ${index + 2} 行缺少日期`);
      }
      const startTimeUtc = parseLocalDateTime(originalStartTime, input.timezoneOffsetMinutes);
      const distanceKilometres = nullableNumber(row['距离']);
      const activityType = mapActivityType(row['活动类型'] ?? '');
      const identityKey = `csv:v1:${sha256(`csv:v1\0${activityType}\0${startTimeUtc}`)}`;

      return normalizedActivitySchema.parse({
        sourceType: 'CSV',
        sourceExternalId: null,
        sourceIdentityKey: identityKey,
        sourceContentSha256: sha256(stableRowContent(row)),
        activityType,
        startTimeUtc,
        originalStartTime,
        timezoneOffsetMinutes: input.timezoneOffsetMinutes,
        localDate: localDateAtOffset(startTimeUtc, input.timezoneOffsetMinutes),
        name: row['标题']?.trim() || null,
        notes: null,
        distanceMeters: distanceKilometres === null ? null : distanceKilometres * 1000,
        durationSeconds: parseDurationSeconds(row['时间']),
        movingDurationSeconds: parseDurationSeconds(row['移动时间']),
        averageHeartRateBpm: integer(row['平均心率']),
        maxHeartRateBpm: integer(row['最大心率']),
        deviceName: null,
        samples: [],
        laps: [],
        rawSummary: { ...row, rowNumber: index + 2 },
      } satisfies NormalizedActivity);
    });
    return Promise.resolve(normalized);
  }
}
