import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { TrendsWeeklyPoint } from '@runcoach/shared';
import { formatPaceCompact } from '../format.js';

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

/** Thins out x-axis labels as the range grows so 52 weeks stays readable. */
function labelInterval(categories: string[]): number {
  if (categories.length > 26) return 5;
  if (categories.length > 12) return 2;
  return 0;
}

function useLineChart(
  data: Array<{ weekStartLocalDate: string; value: number | null }>,
  buildOption: (categories: string[], values: Array<number | null>) => Record<string, unknown>,
) {
  const elementRef = useRef<HTMLDivElement>(null);
  const categories = data.map((point) => point.weekStartLocalDate);
  const values = data.map((point) => point.value);
  useEffect(() => {
    if (elementRef.current === null) return;
    const chart = echarts.init(elementRef.current);
    chart.setOption(buildOption(categories, values));
    const resize = () => chart.resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      chart.dispose();
    };
  }, [categories.join(','), values.join(',')]);
  return elementRef;
}

const baseAxisStyles = {
  axisLabel: { color: '#94a3b8' },
  axisLine: { lineStyle: { color: '#334155' } },
};

export function WeeklyPaceChart({
  points,
  weeks,
}: {
  points: TrendsWeeklyPoint[];
  weeks: 12 | 26 | 52;
}) {
  const elementRef = useLineChart(
    points.map((point) => ({
      weekStartLocalDate: point.weekStartLocalDate,
      value: point.averagePaceSecondsPerKilometer,
    })),
    (categories, values) => ({
      animation: false,
      tooltip: {
        trigger: 'axis',
        valueFormatter: (value: number | null) => formatPaceCompact(value),
      },
      grid: { left: 65, right: 25, top: 35, bottom: 30 },
      xAxis: {
        type: 'category',
        data: categories,
        ...baseAxisStyles,
        axisLabel: { color: '#94a3b8', interval: labelInterval(categories) },
      },
      yAxis: {
        type: 'value',
        scale: true,
        inverse: true,
        name: '配速 min/km',
        nameTextStyle: { color: '#94a3b8' },
        axisLabel: { color: '#94a3b8', formatter: (value: number) => formatPaceCompact(value) },
        splitLine: { lineStyle: { color: '#1e293b' } },
      },
      series: [
        {
          name: '周平均配速',
          type: 'line',
          connectNulls: false,
          itemStyle: { color: '#34d399' },
          data: values,
        },
      ],
    }),
  );
  return (
    <div
      ref={elementRef}
      className="h-72 w-full"
      aria-label="周平均配速趋势图表"
      data-weeks={weeks}
    />
  );
}

export function WeeklyHeartRateChart({
  points,
  weeks,
}: {
  points: TrendsWeeklyPoint[];
  weeks: 12 | 26 | 52;
}) {
  const elementRef = useLineChart(
    points.map((point) => ({
      weekStartLocalDate: point.weekStartLocalDate,
      value: point.averageHeartRateBpm,
    })),
    (categories, values) => ({
      animation: false,
      tooltip: {
        trigger: 'axis',
        valueFormatter: (value: number | null) =>
          value == null ? '—' : `${Math.round(value)} bpm`,
      },
      grid: { left: 60, right: 25, top: 35, bottom: 30 },
      xAxis: {
        type: 'category',
        data: categories,
        ...baseAxisStyles,
        axisLabel: { color: '#94a3b8', interval: labelInterval(categories) },
      },
      yAxis: {
        type: 'value',
        scale: true,
        name: 'bpm',
        nameTextStyle: { color: '#94a3b8' },
        axisLabel: { color: '#94a3b8' },
        splitLine: { lineStyle: { color: '#1e293b' } },
      },
      series: [
        {
          name: '周平均心率',
          type: 'line',
          connectNulls: false,
          itemStyle: { color: '#f87171' },
          data: values,
        },
      ],
    }),
  );
  return (
    <div
      ref={elementRef}
      className="h-72 w-full"
      aria-label="周平均心率趋势图表"
      data-weeks={weeks}
    />
  );
}
