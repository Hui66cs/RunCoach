export function offsetMinutesToSuffix(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60)
    .toString()
    .padStart(2, '0');
  const minutes = (absolute % 60).toString().padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

export function parseLocalDateTime(value: string, offsetMinutes: number): string {
  const normalized = value.trim().replace(' ', 'T');
  const parsed = new Date(`${normalized}${offsetMinutesToSuffix(offsetMinutes)}`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`无法解析日期时间：${value}`);
  }
  return parsed.toISOString();
}

export function localDateAtOffset(isoUtc: string, offsetMinutes: number): string {
  const timestamp = new Date(isoUtc).getTime();
  if (Number.isNaN(timestamp)) {
    throw new Error(`无效 UTC 时间：${isoUtc}`);
  }
  return new Date(timestamp + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function parseDurationSeconds(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parts = value.trim().split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  const [first = 0, second = 0, third = 0] = parts;
  return parts.length === 3 ? first * 3600 + second * 60 + third : first * 60 + second;
}
