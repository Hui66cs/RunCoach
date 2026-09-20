import { Decoder, Stream } from '@garmin/fitsdk';
import {
  normalizedActivitySchema,
  type NormalizedActivity,
  type NormalizedLap,
  type NormalizedSample,
} from '@runcoach/shared';
import { localDateAtOffset } from './time.js';
import type { SourceAdapter } from './types.js';

export interface FitInput {
  buffer: Buffer;
  fileSha256: string;
  defaultTimezoneOffsetMinutes: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): UnknownRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

function numberValue(record: UnknownRecord, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function stringValue(record: UnknownRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function dateValue(record: UnknownRecord, ...keys: string[]): Date | null {
  for (const key of keys) {
    const value = record[key];
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  return null;
}

function semicirclesToDegrees(value: number | null): number | null {
  return value === null ? null : (value * 180) / 2 ** 31;
}

function activityType(session: UnknownRecord): 'RUN' | 'STRENGTH' | 'OTHER' {
  const sport = stringValue(session, 'sport')?.toLowerCase();
  if (sport === 'running') return 'RUN';
  if (sport === 'training' || sport === 'fitnessEquipment') return 'STRENGTH';
  return 'OTHER';
}

function normalizeSamples(fitRecords: UnknownRecord[], startTime: Date): NormalizedSample[] {
  return fitRecords.flatMap((record, sequence) => {
    const timestamp = dateValue(record, 'timestamp');
    if (timestamp === null) return [];
    return [
      {
        sequence,
        timestampUtc: timestamp.toISOString(),
        elapsedSeconds: Math.max(0, (timestamp.getTime() - startTime.getTime()) / 1000),
        distanceMeters: numberValue(record, 'distance'),
        speedMetersPerSecond: numberValue(record, 'enhancedSpeed', 'speed'),
        heartRateBpm: numberValue(record, 'heartRate'),
        cadenceStepsPerMinute: numberValue(record, 'cadence'),
        powerWatts: numberValue(record, 'power'),
        altitudeMeters: numberValue(record, 'enhancedAltitude', 'altitude'),
        latitudeDegrees: semicirclesToDegrees(numberValue(record, 'positionLat')),
        longitudeDegrees: semicirclesToDegrees(numberValue(record, 'positionLong')),
      },
    ];
  });
}

function normalizeLaps(fitLaps: UnknownRecord[]): NormalizedLap[] {
  return fitLaps.map((lap, sequence) => ({
    sequence,
    startTimeUtc: dateValue(lap, 'startTime')?.toISOString() ?? null,
    durationSeconds: numberValue(lap, 'totalTimerTime', 'totalElapsedTime'),
    distanceMeters: numberValue(lap, 'totalDistance'),
    averageHeartRateBpm: numberValue(lap, 'avgHeartRate'),
    maxHeartRateBpm: numberValue(lap, 'maxHeartRate'),
    averageSpeedMetersPerSecond: numberValue(lap, 'enhancedAvgSpeed', 'avgSpeed'),
  }));
}

export class GarminFitAdapter implements SourceAdapter<FitInput> {
  readonly sourceType = 'FIT' as const;

  decode(input: FitInput): Promise<NormalizedActivity[]> {
    const stream = Stream.fromBuffer(input.buffer);
    const decoder = new Decoder(stream);
    if (!decoder.isFIT()) throw new Error('文件头不是有效的 FIT 文件');
    if (!decoder.checkIntegrity()) throw new Error('FIT 文件完整性或 CRC 校验失败');

    const decoded: unknown = decoder.read({
      applyScaleAndOffset: true,
      expandSubFields: true,
      expandComponents: true,
      convertTypesToStrings: true,
      convertDateTimesToDates: true,
      includeUnknownData: true,
      mergeHeartRates: true,
    });
    if (!isRecord(decoded) || !isRecord(decoded['messages'])) {
      throw new Error('FIT 解码器没有返回 messages');
    }
    const messages = decoded['messages'];
    const sessions = records(messages['sessionMesgs'] ?? messages['session']);
    if (sessions.length === 0) throw new Error('FIT 文件没有 session 消息');
    const fitRecords = records(messages['recordMesgs'] ?? messages['record']);
    const fitLaps = records(messages['lapMesgs'] ?? messages['lap']);
    const devices = records(messages['deviceInfoMesgs'] ?? messages['deviceInfo']);

    const normalized = sessions.map((session, sessionIndex) => {
      const startTime = dateValue(session, 'startTime');
      if (startTime === null) throw new Error(`FIT session ${sessionIndex + 1} 缺少开始时间`);
      const samples = normalizeSamples(fitRecords, startTime);
      const laps = normalizeLaps(fitLaps);
      const device = devices[0];
      const deviceName =
        device === undefined ? null : stringValue(device, 'productName', 'manufacturer');
      const startTimeUtc = startTime.toISOString();

      return normalizedActivitySchema.parse({
        sourceType: 'FIT',
        sourceExternalId: null,
        activityType: activityType(session),
        startTimeUtc,
        originalStartTime: startTimeUtc,
        timezoneOffsetMinutes: input.defaultTimezoneOffsetMinutes,
        localDate: localDateAtOffset(startTimeUtc, input.defaultTimezoneOffsetMinutes),
        name: null,
        notes: null,
        distanceMeters: numberValue(session, 'totalDistance'),
        durationSeconds: numberValue(session, 'totalElapsedTime'),
        movingDurationSeconds: numberValue(session, 'totalTimerTime'),
        averageHeartRateBpm: numberValue(session, 'avgHeartRate'),
        maxHeartRateBpm: numberValue(session, 'maxHeartRate'),
        deviceName,
        samples,
        laps,
        rawSummary: {
          sessionIndex,
          recordCount: samples.length,
          lapCount: laps.length,
          fileSha256: input.fileSha256,
        },
      } satisfies NormalizedActivity);
    });
    return Promise.resolve(normalized);
  }
}
