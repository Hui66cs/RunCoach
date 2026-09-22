import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ActivitySeriesPoint, SeriesMetric } from '@runcoach/shared';
import { formatPace, formatPaceCompact } from './format.js';

echarts.use([
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomComponent,
  CanvasRenderer,
]);
const definitions = {
  heartRate: { name: '心率', field: 'heartRateBpm' },
  speed: { name: '速度', field: 'speedMetersPerSecond' },
  pace: { name: '配速', field: 'paceSecondsPerKilometer' },
  cadence: { name: '步频', field: 'cadenceStepsPerMinute' },
  power: { name: '功率', field: 'powerWatts' },
  altitude: { name: '海拔', field: 'altitudeMeters' },
} satisfies Record<string, { name: string; field: keyof ActivitySeriesPoint }>;

export function SeriesChart({
  points,
  metrics,
  onRangeChange,
}: {
  points: ActivitySeriesPoint[];
  metrics: SeriesMetric[];
  onRangeChange?: (from: number, to: number) => void;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (elementRef.current === null) return;
    const chart = echarts.init(elementRef.current);
    const visible = metrics.filter(
      (metric): metric is keyof typeof definitions =>
        metric in definitions &&
        points.some(
          (point) =>
            typeof point[definitions[metric as keyof typeof definitions].field] === 'number',
        ),
    );
    const showsPace = visible.includes('pace');
    chart.setOption({
      animation: false,
      tooltip: { trigger: 'axis' },
      legend: {
        data: visible.map((metric) => definitions[metric].name),
        textStyle: { color: '#cbd5e1' },
      },
      grid: { left: 58, right: showsPace ? 64 : 25, top: 45, bottom: 65 },
      dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 10 }],
      xAxis: {
        type: 'category',
        data: points.map((point) => Math.round(point.elapsedSeconds ?? point.sequence)),
        name: '秒',
        nameTextStyle: { color: '#94a3b8' },
        axisLabel: { color: '#94a3b8' },
        axisLine: { lineStyle: { color: '#334155' } },
      },
      yAxis: [
        {
          type: 'value',
          scale: true,
          nameTextStyle: { color: '#94a3b8' },
          axisLabel: { color: '#94a3b8' },
          splitLine: { lineStyle: { color: '#1e293b' } },
        },
        ...(showsPace
          ? [
              {
                type: 'value',
                scale: true,
                inverse: true,
                name: '配速 min/km',
                nameTextStyle: { color: '#94a3b8' },
                axisLabel: {
                  color: '#94a3b8',
                  formatter: (value: number) => formatPaceCompact(value),
                },
                splitLine: { show: false },
              },
            ]
          : []),
      ],
      series: visible.map((metric) => ({
        name: definitions[metric].name,
        type: 'line',
        showSymbol: false,
        connectNulls: false,
        yAxisIndex: metric === 'pace' ? 1 : 0,
        ...(metric === 'pace'
          ? { tooltip: { valueFormatter: (value: number | null) => formatPace(value) } }
          : {}),
        data: points.map((point) => point[definitions[metric].field] ?? null),
      })),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    chart.on('datazoom', (event: unknown) => {
      if (!onRangeChange || points.length < 2 || typeof event !== 'object' || event === null)
        return;
      const record = event as Record<string, unknown>;
      const batchValue: unknown = record['batch'];
      const firstBatch: unknown = Array.isArray(batchValue) ? (batchValue as unknown[])[0] : record;
      if (typeof firstBatch !== 'object' || firstBatch === null) return;
      const batch = firstBatch as Record<string, unknown>;
      const start = typeof batch['start'] === 'number' ? batch['start'] : 0;
      const end = typeof batch['end'] === 'number' ? batch['end'] : 100;
      const first = points[Math.floor((start / 100) * (points.length - 1))];
      const last = points[Math.ceil((end / 100) * (points.length - 1))];
      if (
        first?.elapsedSeconds == null ||
        last?.elapsedSeconds == null ||
        last.elapsedSeconds <= first.elapsedSeconds
      )
        return;
      if (timer) clearTimeout(timer);
      const from = first.elapsedSeconds;
      const to = last.elapsedSeconds;
      timer = setTimeout(() => onRangeChange(from, to), 350);
    });
    const resize = () => chart.resize();
    window.addEventListener('resize', resize);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('resize', resize);
      chart.dispose();
    };
  }, [metrics, onRangeChange, points]);
  return <div ref={elementRef} className="h-96 w-full" aria-label="活动时序图表" />;
}
