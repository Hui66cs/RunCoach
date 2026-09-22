import type { ActivitySeriesPoint } from '@runcoach/shared';
export function RoutePreview({ points }: { points: ActivitySeriesPoint[] }) {
  const valid = points.filter(
    (point) => point.latitudeDegrees != null && point.longitudeDegrees != null,
  );
  const filtered = valid.filter((point, index) => {
    const previous = valid[index - 1];
    return (
      !previous ||
      (Math.abs(point.latitudeDegrees! - previous.latitudeDegrees!) < 0.1 &&
        Math.abs(point.longitudeDegrees! - previous.longitudeDegrees!) < 0.1)
    );
  });
  if (filtered.length < 2) return null;
  const xs = filtered.map((point) => point.longitudeDegrees!);
  const ys = filtered.map((point) => point.latitudeDegrees!);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = Math.max(maxX - minX, 0.000001);
  const height = Math.max(maxY - minY, 0.000001);
  const scale = Math.min(560 / width, 250 / height);
  const path = filtered
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'} ${(point.longitudeDegrees! - minX) * scale + 20} ${(maxY - point.latitudeDegrees!) * scale + 20}`,
    )
    .join(' ');
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="mb-3 text-lg font-semibold">离线轨迹轮廓</h2>
      <svg
        viewBox={`0 0 ${width * scale + 40} ${height * scale + 40}`}
        className="h-64 w-full"
        role="img"
        aria-label="本地轨迹轮廓"
      >
        <path
          d={path}
          fill="none"
          stroke="#34d399"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <p className="mt-2 text-xs text-slate-500">仅在本机绘制，不加载地图瓦片，不上传 GPS。</p>
    </section>
  );
}
