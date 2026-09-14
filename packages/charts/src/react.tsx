import { BarChart, HeatmapChart, LineChart } from 'echarts/charts';
import type { EChartsOption, SeriesOption } from 'echarts';
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import type { ChartType, ResultShapeInput } from './index.js';

echarts.use([
  AriaComponent,
  BarChart,
  CanvasRenderer,
  GridComponent,
  HeatmapChart,
  LegendComponent,
  LineChart,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
]);

export interface EChartResult extends ResultShapeInput {
  readonly measures?: readonly {
    readonly alias: string;
    readonly labelKo: string;
    readonly unit: string | null;
  }[];
}

function numericColumns(result: EChartResult): string[] {
  const columns = result.columns ?? Object.keys(result.rows[0] ?? {});
  return columns.filter(
    (column) => column !== 'n' && result.rows.some((row) => typeof row[column] === 'number'),
  );
}

const UI_FONT_FAMILY =
  '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", "Apple SD Gothic Neo", sans-serif';

function optionFor(
  result: EChartResult,
  chart: ChartType,
  sampleSize: number,
  colorTheme: 'light' | 'dark',
): EChartsOption {
  const columns = result.columns ?? Object.keys(result.rows[0] ?? {});
  const values = numericColumns(result);
  const measure = result.measures?.[0];
  const percent = measure?.unit === 'percent';
  const footnote = `표본 ${sampleSize.toLocaleString()} · 관찰된 관계이며 인과를 뜻하지 않습니다.`;
  const dark = colorTheme === 'dark';
  const chartColors = dark
    ? ['#78a99c', '#d19372', '#c2a65e', '#9a829d']
    : ['#35695e', '#a86545', '#9a7b2f', '#725f78'];
  const common: EChartsOption = {
    animationDuration: 350,
    aria: { enabled: true, decal: { show: true } },
    color: chartColors,
    title: { text: measure?.labelKo ?? '분석 결과', subtext: footnote, left: 8 },
    backgroundColor: 'transparent',
    textStyle: { color: dark ? '#dfe8e3' : '#17202a', fontFamily: UI_FONT_FAMILY },
    tooltip: { trigger: 'axis' },
    grid: { left: 48, right: 18, top: 76, bottom: 44, containLabel: true },
  };

  if (chart === 'comparison_bar') {
    const row = result.rows[0] ?? {};
    const measureColumns = values.filter((column) => !column.startsWith('n_'));
    return {
      ...common,
      xAxis: {
        type: 'category',
        data: measureColumns.map((column) => column.replace(`${measure?.alias ?? 'm0'}_`, '')),
        axisLabel: { color: dark ? '#aebbb5' : '#596063' },
        axisLine: { lineStyle: { color: dark ? '#53635c' : '#c9c4b8' } },
      },
      yAxis: {
        type: 'value',
        min: 0,
        ...(percent ? { max: 1 } : {}),
        axisLabel: { color: dark ? '#aebbb5' : '#596063' },
        splitLine: { lineStyle: { color: dark ? '#34423d' : '#e2ddd0' } },
      },
      series: [
        {
          type: 'bar',
          data: measureColumns.map((column) =>
            row[column] === null || row[column] === undefined ? null : Number(row[column]),
          ),
          barMaxWidth: 72,
        },
      ],
    };
  }

  if (chart === 'heatmap') {
    const x = columns.find((column) => /(^x|x_norm)/.test(column)) ?? columns[0];
    const y = columns.find((column) => /(^y|y_norm)/.test(column)) ?? columns[1];
    const weight = values.find((column) => column !== x && column !== y);
    const data = result.rows.map((row) => [
      Number(row[x!] ?? 0),
      Number(row[y!] ?? 0),
      Number(weight ? (row[weight] ?? 0) : 1),
    ]);
    return {
      ...common,
      tooltip: { trigger: 'item' },
      xAxis: { type: 'value', min: 0, max: 1, show: false },
      yAxis: { type: 'value', min: 0, max: 1, show: false },
      visualMap: { min: 0, max: Math.max(1, ...data.map((item) => Number(item[2]))), show: false },
      series: [{ type: 'heatmap', data }],
    };
  }

  const category = columns.find((column) => !values.includes(column) && column !== 'n');
  const seriesColumns = values.filter((column) => !column.startsWith('n'));
  const categoryData = result.rows.map((row, index) =>
    String(category ? row[category] : index + 1),
  );
  return {
    ...common,
    legend: { top: 48, textStyle: { color: dark ? '#aebbb5' : '#596063' } },
    xAxis: {
      type: 'category',
      data: categoryData,
      axisLabel: { color: dark ? '#aebbb5' : '#596063' },
      axisLine: { lineStyle: { color: dark ? '#53635c' : '#c9c4b8' } },
    },
    yAxis: {
      type: 'value',
      min: 0,
      ...(percent ? { max: 1 } : {}),
      axisLabel: { color: dark ? '#aebbb5' : '#596063' },
      splitLine: { lineStyle: { color: dark ? '#34423d' : '#e2ddd0' } },
    },
    series: seriesColumns.map((column): SeriesOption =>
      chart === 'line'
        ? {
            name: column,
            type: 'line',
            data: result.rows.map((row) => Number(row[column] ?? 0)),
          }
        : {
            name: column,
            type: 'bar',
            data: result.rows.map((row) => Number(row[column] ?? 0)),
          },
    ),
  };
}

export function EChart({
  result,
  chart,
  sampleSize,
  colorTheme,
}: {
  result: EChartResult;
  chart: ChartType;
  sampleSize: number;
  colorTheme: 'light' | 'dark';
}) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const current = echarts.init(host.current, colorTheme === 'dark' ? 'dark' : undefined, {
      renderer: 'canvas',
    });
    instance.current = current;
    current.setOption(optionFor(result, chart, sampleSize, colorTheme), { notMerge: true });
    const observer = new ResizeObserver(() => current.resize());
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      current.dispose();
      instance.current = null;
    };
  }, [chart, colorTheme, result, sampleSize]);
  const exportPng = () => {
    const url = instance.current?.getDataURL({
      type: 'png',
      pixelRatio: 2,
      backgroundColor: colorTheme === 'dark' ? '#18221f' : '#fbfaf6',
    });
    if (!url) return;
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = 'leagueofdata-result.png';
    anchor.click();
  };
  return (
    <div className="echart-frame">
      <div ref={host} className="echart-host" role="img" aria-label="분석 결과 차트" />
      <button onClick={exportPng}>PNG 내보내기</button>
    </div>
  );
}

export default EChart;
