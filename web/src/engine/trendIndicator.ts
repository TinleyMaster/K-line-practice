/**
 * 自定义指标：趋势结构（Trend Structure）
 *
 * 复现 MT5 指标 "Trend.mq5" 的核心逻辑：
 *   - 趋势 K 线识别（实体大、影线小）
 *   - 中期高低点标记（当前高/低高于/低于前两根）
 *   - 防守位计算（下跌趋势 = 最后一个中期高点；上涨趋势 = 最后一个中期低点）
 *   - EMA 共振验证（21 / 55 / 144）
 *
 * 通过 klinecharts 的 registerIndicator 注册，名字为 'TRENDSTRUCT'，
 * 以便 IndicatorPicker / ChartPanel 的通用装载逻辑能识别它。
 */
import { registerIndicator } from 'klinecharts';

registerIndicator({
  name: 'TRENDSTRUCT',
  shortName: 'TrendStruct',
  series: 'price',
  calcParams: [10, 30, 20, 21, 55, 144],
  precision: 2,
  shouldOhlc: true,
  figures: [
    { key: 'emaFast', title: 'EMA21: ', type: 'line' },
    { key: 'emaMid', title: 'EMA55: ', type: 'line' },
    { key: 'emaSlow', title: 'EMA144: ', type: 'line' },
    { key: 'defense', title: '防守位: ', type: 'line' },
    { key: 'trendBull', title: '多头趋势K: ', type: 'circle' },
    { key: 'trendBear', title: '空头趋势K: ', type: 'circle' },
    { key: 'midHigh', title: '中期高点: ', type: 'circle' },
    { key: 'midLow', title: '中期低点: ', type: 'circle' },
  ],
  calc: (dataList, indicator) => {
    const params = indicator.calcParams as number[];
    const minBody = Number(params?.[0] ?? 10);
    const maxShadow = Number(params?.[1] ?? 30);
    const fastP = Math.max(1, Number(params?.[3] ?? 21));
    const midP = Math.max(1, Number(params?.[4] ?? 55));
    const slowP = Math.max(1, Number(params?.[5] ?? 144));

    let emaFastVal: number | undefined;
    let emaMidVal: number | undefined;
    let emaSlowVal: number | undefined;
    let closeSumFast = 0;
    let closeSumMid = 0;
    let closeSumSlow = 0;

    let lastMidHigh: number | null = null;
    let lastMidLow: number | null = null;

    return dataList.map((k, i) => {
      const range = k.high - k.low;
      const body = Math.abs(k.close - k.open);
      const bodyPct = range > 0 ? (body / range) * 100 : 0;
      const shadowPct = range > 0 ? ((range - body) / range) * 100 : 0;

      let trendBull: number | undefined;
      let trendBear: number | undefined;
      if (k.close > k.open && bodyPct >= minBody && shadowPct <= maxShadow) {
        trendBull = k.close;
      }
      if (k.close < k.open && bodyPct >= minBody && shadowPct <= maxShadow) {
        trendBear = k.close;
      }

      let midHigh: number | undefined;
      let midLow: number | undefined;
      if (i >= 2) {
        const p1 = dataList[i - 1];
        const p2 = dataList[i - 2];
        if (k.high > p1.high && k.high > p2.high) midHigh = k.high;
        if (k.low < p1.low && k.low < p2.low) midLow = k.low;
      }
      if (midHigh !== undefined) lastMidHigh = midHigh;
      if (midLow !== undefined) lastMidLow = midLow;

      let defense: number | undefined;
      if (k.close < k.open && lastMidHigh !== null) defense = lastMidHigh;
      else if (k.close > k.open && lastMidLow !== null) defense = lastMidLow;

      const close = k.close;
      // fast EMA
      if (i < fastP - 1) {
        closeSumFast += close;
      } else if (i === fastP - 1) {
        closeSumFast += close;
        emaFastVal = closeSumFast / fastP;
      } else if (emaFastVal !== undefined) {
        emaFastVal = (2 * close + (fastP - 1) * emaFastVal) / (fastP + 1);
      }
      // mid EMA
      if (i < midP - 1) {
        closeSumMid += close;
      } else if (i === midP - 1) {
        closeSumMid += close;
        emaMidVal = closeSumMid / midP;
      } else if (emaMidVal !== undefined) {
        emaMidVal = (2 * close + (midP - 1) * emaMidVal) / (midP + 1);
      }
      // slow EMA
      if (i < slowP - 1) {
        closeSumSlow += close;
      } else if (i === slowP - 1) {
        closeSumSlow += close;
        emaSlowVal = closeSumSlow / slowP;
      } else if (emaSlowVal !== undefined) {
        emaSlowVal = (2 * close + (slowP - 1) * emaSlowVal) / (slowP + 1);
      }

      return {
        emaFast: i >= fastP - 1 ? emaFastVal : undefined,
        emaMid: i >= midP - 1 ? emaMidVal : undefined,
        emaSlow: i >= slowP - 1 ? emaSlowVal : undefined,
        defense,
        trendBull,
        trendBear,
        midHigh,
        midLow,
      };
    });
  },
  styles: {
    lines: [
      { color: '#F6465D', size: 1.5 },
      { color: '#2962FF', size: 1.5 },
      { color: '#FFFFFF', size: 1.5 },
      { color: '#9C27B0', size: 1.5, style: 'dashed' },
    ],
    circles: [
      { upColor: '#0ECB81', downColor: '#0ECB81', noChangeColor: '#0ECB81' }, // trendBull
      { upColor: '#F6465D', downColor: '#F6465D', noChangeColor: '#F6465D' }, // trendBear
      { upColor: '#F6465D', downColor: '#F6465D', noChangeColor: '#F6465D' }, // midHigh
      { upColor: '#0ECB81', downColor: '#0ECB81', noChangeColor: '#0ECB81' }, // midLow
    ],
  },
});
