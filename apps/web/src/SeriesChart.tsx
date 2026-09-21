import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { NormalizedSample } from '@runcoach/shared';

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

interface SeriesChartProps {
  samples: NormalizedSample[];
}

export function SeriesChart({ samples }: SeriesChartProps) {
  const elementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (elementRef.current === null) return;
    const chart = echarts.init(elementRef.current);
    const points =
      samples.length <= 1_000
        ? samples
        : samples.filter((_, index) => index % Math.ceil(samples.length / 1_000) === 0);
    chart.setOption({
      animation: false,
      tooltip: { trigger: 'axis' },
      legend: { data: ['心率', '速度'] },
      grid: { left: 48, right: 48, top: 40, bottom: 40 },
      xAxis: {
        type: 'category',
        data: points.map((sample) => Math.round(sample.elapsedSeconds ?? sample.sequence)),
        name: '秒',
      },
      yAxis: [
        { type: 'value', name: 'bpm' },
        { type: 'value', name: 'm/s' },
      ],
      series: [
        {
          name: '心率',
          type: 'line',
          showSymbol: false,
          data: points.map((sample) => sample.heartRateBpm),
        },
        {
          name: '速度',
          type: 'line',
          yAxisIndex: 1,
          showSymbol: false,
          data: points.map((sample) => sample.speedMetersPerSecond),
        },
      ],
    });
    const resize = () => chart.resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      chart.dispose();
    };
  }, [samples]);

  return <div ref={elementRef} className="h-80 w-full" aria-label="心率与速度曲线" />;
}
