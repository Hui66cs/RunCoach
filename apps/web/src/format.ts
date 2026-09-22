export const dash = '—';
export function formatDistance(value: number | null | undefined): string {
  return value == null ? dash : `${(value / 1000).toFixed(2)} km`;
}
export function formatDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return dash;
  const seconds = Math.round(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
    : `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
}
export function formatPaceCompact(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return dash;
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${(rounded % 60).toString().padStart(2, '0')}`;
}
export function formatPace(seconds: number | null | undefined): string {
  const compact = formatPaceCompact(seconds);
  return compact === dash ? dash : `${compact} /km`;
}
export function averagePace(
  distance: number | null | undefined,
  duration: number | null | undefined,
): number | null {
  return distance != null && duration != null && distance > 0 ? (duration / distance) * 1000 : null;
}
