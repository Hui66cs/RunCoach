import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GarminFitAdapter } from './fit-adapter.js';

const syntheticFitBase64 =
  'DgLeUjMBAAAuRklU7wNAAAAAAAUAAQIBAoQCAoQEBIYDBIwABP8AAQBntw9FAQAAAEEAABQABf0EhgUEhkkEhgMBAgQBAgFntw9FAAAAADwKAAB4UgFiug9FKA4DADwKAACRUgFevQ9FURwGADwKAACjUgFZwA9FeSoJADwKAACqUgFVww9FoTgMADwKAACWUkIAABMACv0EhgIEhgcEhggEhgkEhg8BAhABAgABAgEBAhkBAgJVww9FZ7cPRVSbLgBUmy4AoTgMAKO/CQEBQwAAEgAN/QSGAgSGBwSGCASGCQSGEAECEQECBQECBgECGQKEGgKEAAECAQECA1XDD0Vntw9FVJsuAFSbLgChOAwAo78BAAAAAQAIAUQAACIABv0EhgAEhgEChAIBAgMBAgQBAgRVww9FVJsuAAEAABoB54E=';

export function syntheticFitBuffer(): Buffer {
  return Buffer.from(syntheticFitBase64, 'base64');
}

describe('GarminFitAdapter', () => {
  it('decodes session, lap, and record messages from a valid FIT file', async () => {
    const buffer = syntheticFitBuffer();
    const activities = await new GarminFitAdapter().decode({
      buffer,
      fileSha256: createHash('sha256').update(buffer).digest('hex').toUpperCase(),
      defaultTimezoneOffsetMinutes: 480,
    });

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      activityType: 'RUN',
      startTimeUtc: '2026-09-18T09:24:55.000Z',
      localDate: '2026-09-18',
      distanceMeters: 8009.29,
      durationSeconds: 3054.42,
    });
    expect(activities[0]?.samples).toHaveLength(5);
    expect(activities[0]?.laps).toHaveLength(1);
    expect(activities[0]?.samples[1]?.heartRateBpm).toBe(145);
  });
});
