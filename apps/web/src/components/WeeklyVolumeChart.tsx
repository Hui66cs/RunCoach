import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { DashboardWeeklyVolume } from '@runcoach/shared';
import { formatDuration } from '../format.js';

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

export function WeeklyVolumeChart({ weeks }: { weeks: DashboardWeeklyVolume[] }) {
  const elementRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (elementRef.current === null) return;
    const chart = echarts.init(elementRef.current);
    const movingByWeek = new Map(
      weeks.map((week) => [week.weekStartLocalDate, week.totalMovingDurationSeconds]),
    );
    chart.setOption({
      animation: false,
      tooltip: {
        trigger: 'axis',
        formatter: (raw: unknown) => {
          if (!Array.isArray(raw) || raw.length === 0) return '';
          const first = raw[0] as { axisValue?: string };
          const weekStart = typeof first?.axisValue === 'string' ? first.axisValue : '';
          const moving = movingByWeek.get(weekStart);
          const lines = [`<strong>${weekStart}</strong>`];
          for (const entry of raw) {
            const item = entry as { seriesName?: string; value?: number | null };
            if (item.seriesName === '跑量 (km)') {
              lines.push(`跑量 ${typeof item.value === 'number' ? item.value.toFixed(2) : '—'} km`);
            } else if (item.seriesName === '次数') {
              lines.push(`次数 ${typeof item.value === 'number' ? item.value : '—'} 次`);
            }
          }
          if (moving !== undefined) lines.push(`移动时长 ${formatDuration(moving)}`);
          return lines.join('<br/>');
        },
      },
      grid: { left: 55, right: 45, top: 35, bottom: 30 },
      xAxis: {
        type: 'category',
        data: weeks.map((week) => week.weekStartLocalDate),
        nameTextStyle: { color: '#94a3b8' },
        axisLabel: { color: '#94a3b8' },
        axisLine: { lineStyle: { color: '#334155' } },
      },
      yAxis: [
        {
          type: 'value',
          name: 'km',
          nameTextStyle: { color: '#94a3b8' },
          axisLabel: { color: '#94a3b8' },
          splitLine: { lineStyle: { color: '#1e293b' } },
        },
        {
          type: 'value',
          name: '次',
          minInterval: 1,
          nameTextStyle: { color: '#94a3b8' },
          axisLabel: { color: '#94a3b8' },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '跑量 (km)',
          type: 'bar',
          itemStyle: { color: '#34d399' },
          data: weeks.map((week) => Number((week.totalDistanceMeters / 1000).toFixed(2))),
        },
        {
          name: '次数',
          type: 'line',
          yAxisIndex: 1,
          itemStyle: { color: '#60a5fa' },
          data: weeks.map((week) => week.runs),
        },
      ],
    });
    const resize = () => chart.resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      chart.dispose();
    };
  }, [weeks]);
  return <div ref={elementRef} className="h-72 w-full" aria-label="每周跑量趋势图表" />;
}
